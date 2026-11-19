// Executor do plano. Para cada passo: monta a transação, SIMULA, confere o efeito no destino e só então envia.
//
// Falha segura:
// - simulação de lote de tokens falhou: refaz conta por conta, a que falhar fica no relatório;
// - coleta da Pump.fun falhou: cancela as próximas coletas (não insiste) e segue a limpeza;
// - coleta da Meteora DBC falhou: cancela as próximas coletas da Meteora (não insiste) e segue a limpeza;
// - coleta do Raydium LaunchLab falhou: cancela as próximas coletas do LaunchLab (não insiste) e segue a limpeza;
// - efeito diferente do esperado no destino: PARA TUDO.

import { appFeeLamports } from './app-fee.ts';
import { isAddress } from '../solana/base58.ts';
import { CodedError, explainError, type ErrorCode, type ErrorParams, type Explained } from './errors.ts';
import { imitatedWallet, imitationMessage, type KnownWallet } from './destination.ts';
import {
  ataCreateIdempotent,
  computeUnitLimit,
  dbcClaimCreatorTradingFee,
  launchlabClaimCreatorFee,
  computeUnitPrice,
  pumpAmmClaimToSol,
  pumpAmmSweepCreatorFee,
  pumpAmmTransferCreatorFeesToPumpV2,
  pumpDistributeCreatorFeesV2,
  pumpAmmClaimCashback,
  pumpAmmCollectCoinCreatorFee,
  pumpClaimCashbackV2,
  pumpCloseUserVolumeAccumulator,
  pumpCollectCreatorFeeV2,
  pumpSweepCreatorFee,
  systemTransfer,
  tokenBurn,
  tokenCloseAccount,
  tokenTransferChecked,
} from '../solana/instructions.ts';
import { associatedTokenAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, WSOL_MINT } from '../solana/pda.ts';
import { describeStep, PRIORITY_BUDGET_LAMPORTS, rentFor, TOKEN_ACCOUNT_BYTES, type Plan, type Step, type TokenAction } from './plan.ts';
import { RpcError, type RpcClient } from '../solana/rpc.ts';
import { lamportsOrNull, parseSharingConfig, readUva, SHARING_SLICE, type VolumeContext } from './scan.ts';
import { BASE_FEE_LAMPORTS } from './summary.ts';
import { dbcBaseTokenProgram, readDbcPools } from './dbc.ts';
import { LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault, readLaunchlabVault } from './launchlab.ts';
import { buildTransaction, MAX_TX_BYTES, transactionSize, type Instruction, type Signer } from '../solana/tx.ts';

// Parada de segurança: carrega o código do erro para o catálogo (src/core/limpeza/errors.ts); o texto da mensagem não muda.
export class ExecutionAborted extends CodedError {
  constructor(message: string, code: ErrorCode = 'unexpected-effect', params?: ErrorParams) {
    super(message, code, params);
    this.name = 'ExecutionAborted';
  }
}

// destino recusado por imitar uma conta da frase; accountIndex: 0 = Conta 1 (usado pelo catálogo de erros)
export class DestinationLookalike extends ExecutionAborted {
  readonly accountIndex: number;
  constructor(message: string, accountIndex: number) {
    super(message, 'dest-lookalike', { index: accountIndex });
    this.accountIndex = accountIndex;
  }
}

export type StepResult = {
  step: Step;
  description: string;
  status: 'simulado' | 'enviado' | 'falhou' | 'cancelado' | 'nada a fazer' | 'desconhecido';
  signature?: string;
  destinationDelta?: bigint;
  appFeeDelta?: bigint; // o que a carteira da taxa do app recebe neste passo
  // passo só de varrer: fee que ele libera no cofre e que a coleta seguinte leva ao destino. Na simulação cada passo
  // roda sobre a rede de agora, e a coleta simulada não vê o que os passos anteriores varreram: o recibo soma daqui
  pendingClaimLamports?: bigint;
  // coleta do PumpSwap: aluguel (e WSOL esquecido) da ATA WSOL que já era da temporária e que a coleta fechou;
  // vai junto ao destino, mas é conta fechada, não creator fee (o recibo separa)
  closedRentLamports?: bigint;
  // coleta do PumpSwap que não rodou (fee sharing, sem fee, fee pequena) e só fechou a ATA WSOL da temporária
  skippedClaim?: boolean;
  // simulação: o que a pagadora gasta neste passo (taxa de rede, aluguel de conta que fica criada). Sai do envio
  // final dela, cuja simulação roda sobre o saldo de antes da rodada; o recibo desconta de lá
  payerCostLamports?: bigint;
  detail?: string;
  error?: Explained; // erro explicado (código + parâmetros); `detail` segue igual
};

export type ExecOptions = {
  rpc: RpcClient;
  plan: Plan;
  signers: Map<number, Signer>; // índice da temporária -> signatário
  mode: 'simulate' | 'execute';
  onResult?: (r: StepResult) => void;
  // avisa o início de cada passo da fila (index de 0; total = já iniciados + os que ainda faltam)
  onStepStart?: (step: Step, index: number, total: number) => void;
  sleep?: (ms: number) => Promise<void>;
  confirmTimeoutMs?: number;
  // só para teste de simulação sem chaves (assinaturas falsas); nunca usado com envio
  skipSignatureCheck?: boolean;
  priority?: 'auto' | 'off'; // taxa de prioridade (padrão: auto, com teto)
  maxPriorityMicroLamports?: bigint;
  onPriority?: (microLamportsPerUnit: bigint) => void;
  label?: (index: number) => string; // nome da carteira nas mensagens (Phantom: "Conta N")
  // slot do último passo confirmado, dividido entre execuções da mesma rodada (cada frase é uma execução). Sem ele, a
  // frase seguinte começava em 0 e lia o destino num nó que ainda não tinha o último envio da anterior: o destino
  // parecia receber a mais e o app parava tudo (print de um tester, 01/11/2026, frase 4 de 4 sem rodar)
  slot?: { last: number };
  now?: () => number; // relógio (só para teste do reaproveitamento do blockhash)
};

// Blockhash reaproveitado entre passos: na rede ele vale ~60 s (150 blocos); dentro deste prazo a transação
// ainda nasce com mais de 30 s de validade, e cada passo poupa 1 consulta (2 nas coletas da Pump.fun). No RPC
// público da Solana (3,5 consultas/s por método) isso é tempo de verdade. "Expirou" descarta o guardado.
export const BLOCKHASH_REUSE_MS = 20_000;

// expectedFeeDelta: o que a carteira da taxa do app tem que receber (0 = nada); a simulação confere o valor exato
// payer: quem paga a taxa DESTA transação quando não é a pagadora do plano (só o passo 'gather': a remetente paga a própria)
// pending: cofre que o passo só de varrer enche; o que passa de `floor` (aluguel do cofre) é fee a coletar
// minWalletDelta: o mínimo que a carteira do passo pode variar na simulação real (coleta na pagadora)
// onRefuse: passo que entra no lugar deste se a rede recusar a transação (simulação ou envio): a conta de volume da
// Pump.fun que não fecha ainda tem o cashback coletado à parte
type Built = { instructions: Instruction[]; signers: Signer[]; payer?: Signer; expectedDestinationDelta: bigint | null; expectedFeeDelta?: bigint; minWalletDelta?: bigint; fixedComputeLimit?: number; pending?: { account: string; floor: bigint }; closedRent?: bigint; skippedClaim?: string; onRefuse?: Step };
// o passo não entra como está, mas outro entra no lugar (conta de volume que não fecha: só o cashback dela).
// refused: a rede recusou (falha, aviso no recibo); senão é só "nada a fazer" com o motivo
type Instead = { instead: Step; why: string; refused: boolean };
const CASHBACK_APART = 'o cashback dela é coletado num passo à parte';

// ---------- taxa de prioridade ----------
// Rede congestionada: quem paga um pouco a mais passa na frente. Preço em microlamports por unidade
// de processamento, com TETO: no máximo ~0,000005 SOL a mais numa transação de 100.000 unidades.
export const MAX_PRIORITY_MICROLAMPORTS = 50_000n;
export const SWEEP_COMPUTE_LIMIT = 1_000; // envio simples de SOL + instruções de taxa (~450 unidades)

export function priorityFeeLamports(microLamportsPerUnit: bigint, computeLimit: number): bigint {
  return (microLamportsPerUnit * BigInt(computeLimit) + 999_999n) / 1_000_000n; // arredonda para cima
}

// Preço por unidade que cabe na taxa de prioridade que a reserva da pagadora paga por transação
// (PRIORITY_BUDGET_LAMPORTS, plan.ts): transação grande (coleta, fee dividida) paga menos por unidade, e a reserva
// nunca fica curta no meio da rodada com a rede congestionada (02/11/2026).
export function budgetedPriorityPrice(microLamportsPerUnit: bigint, computeLimit: number): bigint {
  const cap = (PRIORITY_BUDGET_LAMPORTS * 1_000_000n) / BigInt(Math.max(1, computeLimit));
  return microLamportsPerUnit < cap ? microLamportsPerUnit : cap;
}

// 75% das taxas recentes da rede, com teto; rede calma (tudo zero) ou RPC sem resposta → 0
export function choosePriorityPrice(recent: unknown, max: bigint = MAX_PRIORITY_MICROLAMPORTS): bigint {
  if (!Array.isArray(recent) || !recent.length) return 0n;
  const fees = recent
    .map((r) => (r && typeof (r as { prioritizationFee?: unknown }).prioritizationFee === 'number' ? (r as { prioritizationFee: number }).prioritizationFee : null))
    .filter((f): f is number => f !== null && Number.isFinite(f) && f >= 0)
    .sort((a, b) => a - b);
  if (!fees.length) return 0n;
  const p75 = BigInt(Math.ceil(fees[Math.floor((fees.length - 1) * 0.75)]));
  return p75 > max ? max : p75;
}
type Skip = { skip: string };
// passo de tokens com contas que mudaram desde a varredura: elas saem com motivo e o resto (keep) volta à fila
type Changed = { changed: Array<{ action: TokenAction; now: bigint }>; gone: TokenAction[]; keep: Step | null };
class ProbeFailed extends Error {}
// medida que falhou numa coleta que não diz nada das outras (uma fee dividida, um cashback): só ela fica de fora
// (não cancela as outras coletas)
class SharedProbeFailed extends Error {}
// medida da coleta da Meteora DBC que falhou: o programa pode ter mudado (falha segura). Só este passo falha, e as
// próximas coletas da Meteora desta execução são canceladas (não insiste); a limpeza segue.
class DbcProbeFailed extends Error {}
// idem para o Raydium LaunchLab: só este passo falha e as próximas coletas do LaunchLab são canceladas
class LaunchlabProbeFailed extends Error {}
export const U64_MAX = 0xffffffffffffffffn;

// Pump.fun 6050 (UnableToDistributeCreatorVaultMigratedToSharingConfig, IDL 639b87fb): o cofre desta carteira
// passou para a divisão de fee entre criadores (fee sharing). A coleta direta nunca vai funcionar para ela; o
// resto da Pump.fun continua normal. Por isso não cancela as próximas coletas (visto na mainnet em 30/10/2026,
// scripts/conferir-fee-parada.ts). Qualquer outro erro da Pump.fun continua cancelando.
export const PUMP_FEE_SHARING_ERROR = 6050;
export const FEE_SHARING_SKIP = 'a creator fee desta carteira é dividida entre criadores (fee sharing): o app não coleta; use o site da Pump.fun. As outras coletas seguem.';
function isFeeSharing(err: unknown): boolean {
  const ie = (err as { InstructionError?: unknown[] } | null)?.InstructionError;
  return Array.isArray(ie) && (ie[1] as { Custom?: unknown } | null)?.Custom === PUMP_FEE_SHARING_ERROR;
}

function isStaleBlockhash(err: unknown): boolean {
  try {
    return /BlockhashNotFound/.test(typeof err === 'string' ? err : JSON.stringify(err));
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function validateDestination(rpc: RpcClient, destination: string, rentExemptZero: number, known: KnownWallet[] = []): Promise<{ lamports: number }> {
  if (!isAddress(destination)) throw new ExecutionAborted('Endereço de destino inválido.', 'dest-invalid');
  const imitated = imitatedWallet(destination, known);
  if (imitated) throw new DestinationLookalike(imitationMessage(destination, imitated), imitated.index);
  const info = await rpc.call<{ value: { owner?: string; lamports?: number; executable?: boolean } | null }>('getAccountInfo', [
    destination,
    { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
  ]);
  const v = info?.value;
  if (!v) throw new ExecutionAborted('O destino ainda não existe na blockchain. Use uma carteira que já recebeu SOL (por exemplo a sua principal no Solflare).', 'dest-missing');
  if (v.executable || v.owner !== PROGRAMS.system) throw new ExecutionAborted(`O destino não é uma carteira comum: ela pertence ao programa ${v.owner}. Pode ser conta de token, de programa, ou uma carteira cujo controle foi tomado. Não envio para lá. Use o endereço da sua carteira como aparece no Solflare.`, 'dest-not-ordinary', { owner: String(v.owner) });
  if (typeof v.lamports === 'number' && lamportsOrNull(v.lamports) === null) throw new ExecutionAborted(DIRTY_BALANCE);
  if (typeof v.lamports !== 'number' || v.lamports < rentExemptZero) throw new ExecutionAborted('O destino tem saldo baixo demais para receber com segurança. Mande um pouco de SOL para ele antes.', 'dest-low-balance');
  return { lamports: v.lamports };
}

function signerFor(signers: Map<number, Signer>, index: number): Signer {
  const s = signers.get(index);
  if (!s) throw new ExecutionAborted(`Sem chave para a temporária N=${index}.`);
  return s;
}

// closeTo: para onde vai o aluguel da conta fechada (destino; com taxa do app, a própria burner, que divide 89/11)
function tokenInstructions(a: TokenAction, wallet: string, destination: string, feePayer: string, closeTo = destination): Instruction[] {
  const close = tokenCloseAccount(a.program, a.account, closeTo, wallet);
  if (a.action === 'close') return [close];
  if (a.action === 'burn-close') return [tokenBurn(a.program, a.account, a.mint, wallet, a.amount), close];
  const destAta = associatedTokenAddress(destination, a.mint, a.program);
  return [ataCreateIdempotent(feePayer, destination, a.mint, a.program), tokenTransferChecked(a.program, a.account, a.mint, destAta, wallet, a.amount, a.decimals), close];
}

// saldo que a rede devolveu: conta inexistente ou sem o campo = 0 (como antes); número que não é inteiro finito
// (1e400 vira Infinity, NaN, 1.5) PARA TUDO antes de qualquer envio: BigInt() lançaria no meio da conta
const DIRTY_BALANCE = 'A rede devolveu um saldo fora do formato (não é um número inteiro de lamports). Nada foi enviado neste passo; parei tudo.';
function cleanLamports(v: unknown, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  const l = lamportsOrNull(v);
  if (l === null) throw new ExecutionAborted(DIRTY_BALANCE);
  return l;
}

// Conta de token como está agora: null = não existe mais (já fechada); amount null = a rede não devolveu o saldo
// no formato (não bloqueia: a simulação ainda confere). Conta nativa (WSOL) fecha com saldo: não é conferida.
type TokenNow = { lamports: number; amount: bigint | null; native: boolean };
async function tokenAccountsNow(rpc: RpcClient, addresses: string[]): Promise<Array<TokenNow | null>> {
  const r = await rpc.call<{ value: Array<{ lamports?: unknown; data?: unknown } | null> }>('getMultipleAccounts', [addresses, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return addresses.map((_, i) => {
    const v = r?.value?.[i];
    if (v === null) return null;
    const info = (v?.data as { parsed?: { info?: { tokenAmount?: { amount?: unknown }; isNative?: unknown } } } | undefined)?.parsed?.info;
    const raw = info?.tokenAmount?.amount;
    return { lamports: cleanLamports(v?.lamports, 0), amount: typeof raw === 'string' && /^\d+$/.test(raw) ? BigInt(raw) : null, native: info?.isNative === true };
  });
}

function balanceChanged(a: TokenAction, now: TokenNow | null): boolean {
  return now !== null && !now.native && now.amount !== null && now.amount !== a.amount;
}

async function lamportsOf(rpc: RpcClient, addresses: string[]): Promise<number[]> {
  const r = await rpc.call<{ value: Array<{ lamports?: unknown } | null> }>('getMultipleAccounts', [addresses, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
  return addresses.map((_, i) => cleanLamports(r?.value?.[i]?.lamports, 0));
}

// Leituras e simulações nunca de um ponto da rede ANTES do último passo confirmado (minContextSlot). Achado de 01/11/2026
// (print do autor, parada falsa repetida nas mesmas carteiras): o saldo da carteira da taxa era lido num nó que ainda
// não tinha o passo anterior, e simulado em outro que já tinha; a taxa daquele passo (224 320 lamports, o fechamento de
// uma conta) aparecia como "a mais" no passo seguinte, e o app parava tudo. O nó atrasado responde -32016, que o
// cliente RPC repete (TRANSIENT_RPC_CODES) até ele alcançar.
const SLOT_BOUND = new Set(['getMultipleAccounts', 'simulateTransaction', 'getAccountInfo', 'getBalance', 'getTokenAccountsByOwner']);
export function withMinSlot(rpc: RpcClient, minSlot: () => number): RpcClient {
  return {
    call<T>(method: string, params: unknown[]): Promise<T> {
      const slot = minSlot();
      if (slot <= 0 || !SLOT_BOUND.has(method)) return rpc.call<T>(method, params);
      const last = params.at(-1);
      const cfg = last && typeof last === 'object' && !Array.isArray(last) ? { ...(last as object), minContextSlot: slot } : null;
      return rpc.call<T>(method, cfg ? [...params.slice(0, -1), cfg] : [...params, { minContextSlot: slot }]);
    },
  };
}

// Conferência da simulação: se o destino ou a taxa não baterem, lê e simula de novo, com espera crescente, antes de
// parar tudo. Uma entrada de fora no meio (outra limpeza pagando a mesma carteira da taxa) some na releitura; um
// resultado errado de verdade se repete em todas.
export const SIM_CHECK_WAITS_MS = [0, 1_000, 2_000, 4_000, 8_000];

export async function execute(opts: ExecOptions): Promise<StepResult[]> {
  const slot = opts.slot ?? { last: 0 }; // slot do último passo confirmado (desta execução ou da rodada)
  const rpc = withMinSlot(opts.rpc, () => slot.last);
  const { plan, signers, mode } = opts;
  if (opts.skipSignatureCheck && mode !== 'simulate') throw new ExecutionAborted('skipSignatureCheck só vale para simulação.');
  const sleep = opts.sleep ?? defaultSleep;
  const feePayer = signerFor(signers, plan.feePayerIndex);
  if (feePayer.address !== plan.feePayer) throw new ExecutionAborted('Chave do pagador não confere com o plano.');
  const destination = plan.destination;
  const results: StepResult[] = [];
  const queue: Step[] = [...plan.steps];
  let pumpDisabled = false;
  let dbcDisabled = false; // uma coleta da Meteora falhou: as próximas desta execução não são tentadas
  let launchlabDisabled = false; // idem, LaunchLab
  let priorityPrice = 0n;
  if ((opts.priority ?? 'auto') === 'auto') {
    try {
      priorityPrice = choosePriorityPrice(await rpc.call('getRecentPrioritizationFees', [[]]), opts.maxPriorityMicroLamports);
    } catch {
      priorityPrice = 0n; // sem a informação, segue sem taxa extra
    }
  }
  opts.onPriority?.(priorityPrice);
  // janela do incentivo da Pump.fun, lida uma vez nesta execução (releitura das contas de volume, passo close-uva)
  const uvaRound: VolumeContext = {};
  let rent0Cache: number | null = null;
  const rentExemptZero = async () => (rent0Cache ??= await rpc.call<number>('getMinimumBalanceForRentExemption', [0]));
  const now = opts.now ?? Date.now;
  type Blockhash = { blockhash: string; lastValidBlockHeight: number };
  let blockhashCache: { value: Blockhash; at: number } | null = null;
  const latestBlockhash = async (): Promise<Blockhash> => {
    if (blockhashCache && now() - blockhashCache.at < BLOCKHASH_REUSE_MS) return blockhashCache.value;
    const { value } = await rpc.call<{ value: Blockhash }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    blockhashCache = { value, at: now() };
    return value;
  };

  // Taxa do app: a carteira dela tem que existir e ser carteira comum com o aluguel mínimo. Senão a rede
  // recusaria cada envio pequeno (11% de um aluguel). Confere ANTES de simular qualquer passo.
  const appFee = plan.appFee ?? null;
  if (appFee) {
    try {
      await validateDestination(rpc, appFee.wallet, await rentExemptZero());
    } catch (e) {
      if (!(e instanceof ExecutionAborted)) throw e;
      throw new ExecutionAborted(`A carteira da taxa do app (${appFee.wallet}) não está pronta: ${e.message} Nada foi feito.`, 'app-fee-wallet');
    }
  }
  // divide um valor em destino (89%) e taxa (11%); sem taxa, tudo ao destino
  const split = (amount: bigint, from: string): { toDest: bigint; fee: bigint; instructions: Instruction[] } => {
    const fee = appFeeLamports(amount, appFee);
    const instructions = [systemTransfer(from, destination, amount - fee)];
    if (fee > 0n) instructions.push(systemTransfer(from, appFee!.wallet, fee));
    return { toDest: amount - fee, fee, instructions };
  };

  // envio final da pagadora: o depósito (até o que sobrou) vai inteiro; o resto paga 11%. Uma transferência ao
  // destino (depósito + 89% do resto) e uma à carteira da taxa
  const payerSplit = (amount: bigint, from: string): { toDest: bigint; fee: bigint; instructions: Instruction[] } => {
    const exempt = plan.payerExemptLamports && plan.payerExemptLamports > 0n ? (plan.payerExemptLamports < amount ? plan.payerExemptLamports : amount) : 0n;
    const fee = appFeeLamports(amount - exempt, appFee);
    const instructions = [systemTransfer(from, destination, amount - fee)];
    if (fee > 0n) instructions.push(systemTransfer(from, appFee!.wallet, fee));
    return { toDest: amount - fee, fee, instructions };
  };

  // Passo só de varrer (mais moedas com fee parada do que cabe na coleta): a fee vai para o cofre da carteira,
  // que a coleta seguinte esvazia. Só a pagadora assina; a temporária e o destino não mudam (a simulação confere
  // o destino em 0). A pagadora pode pagar reforço de aluguel, por isso sem a conferência de perda da temporária.
  // O cofre é observado: o que ele ganha acima do aluguel é fee que a coleta leva (pendingClaimLamports).
  const sweepOnly = (instructions: Instruction[], vault: string, floor: bigint): Built => ({ instructions, signers: [feePayer], expectedDestinationDelta: 0n, pending: { account: vault, floor } });

  // Simula só a coleta (sem enviar) e devolve o saldo das contas observadas depois dela. Erro de fee sharing vira
  // "nada a fazer"; outro erro para as coletas (ProbeFailed).
  // Simulação de medida (coletas). Nó do RPC atrás do blockhash guardado (BlockhashNotFound): blockhash novo e
  // simula de novo UMA vez, como no passo; senão a medida falhava e cancelava todas as coletas seguintes da rodada
  // (revisão da autoclarn-40, 31/10/2026).
  type ProbeValue = { err: unknown; logs?: string[]; accounts?: Array<{ lamports: number } | null> };
  async function simulateProbe(instructions: Instruction[], watch: string[], payerSigner: Signer[]): Promise<ProbeValue> {
    for (let attempt = 0; ; attempt++) {
      const pbh = await latestBlockhash();
      const tx = buildTransaction(feePayer.address, instructions, pbh.blockhash, payerSigner);
      const { value } = await rpc.call<{ value: ProbeValue }>('simulateTransaction', [
        Buffer.from(tx.bytes).toString('base64'),
        { encoding: 'base64', sigVerify: !opts.skipSignatureCheck, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } },
      ]);
      if (attempt === 0 && value.err && isStaleBlockhash(value.err)) {
        blockhashCache = null;
        continue;
      }
      return value;
    }
  }

  // pump: false = o erro 6050 não é o da fee sharing da Pump.fun (outro programa, outro catálogo de erros)
  async function probeClaim(instructions: Instruction[], watch: string[], payerSigner: Signer[], pump = true): Promise<bigint[] | Skip> {
    const ps = { value: await simulateProbe(instructions, watch, payerSigner) };
    if (pump && ps.value.err && isFeeSharing(ps.value.err)) return { skip: FEE_SHARING_SKIP };
    if (ps.value.err) throw new ProbeFailed((ps.value.logs ?? []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ') || JSON.stringify(ps.value.err));
    return watch.map((_, i) => {
      const a = ps.value.accounts?.[i];
      if (a === null) return 0n; // conta que não existe depois da coleta
      const l = lamportsOrNull(a?.lamports);
      if (l === null) throw new ProbeFailed('simulação sem o saldo de uma conta observada');
      return BigInt(l);
    });
  }
  const uniqueSigners = (list: Signer[]) => list.filter((s, i) => list.findIndex((x) => x.address === s.address) === i);

  const record = (r: StepResult) => {
    results.push(r);
    opts.onResult?.(r);
  };

  async function build(step: Step): Promise<Built | Skip | Changed | Instead | null> {
    const owner = signerFor(signers, step.walletIndex);
    if (owner.address !== step.wallet) throw new ExecutionAborted(`Chave da temporária N=${step.walletIndex} não confere com o endereço.`);
    switch (step.kind) {
      case 'claim-curve': {
        // fee parada na curva (trocas buy_v3/sell_v3): varrer para o cofre ANTES da coleta, na mesma transação,
        // e a simulação de medida abaixo já conta com ela. A pagadora paga os reforços de aluguel.
        const sweeps = (step.sweeps ?? []).map((x) => pumpSweepCreatorFee(feePayer.address, step.wallet, x.mint));
        if (step.sweepOnly) return sweepOnly(sweeps, pumpCreatorVault(step.wallet), BigInt(await rentExemptZero()));
        const collect = [...sweeps, pumpCollectCreatorFeeV2(step.wallet)];
        if (step.wallet === feePayer.address) {
          // A pagadora já tem SOL acima do aluguel: a coleta cai nela. A fee vai ao destino NA MESMA transação
          // (89% destino, 11% taxa), como nas outras temporárias; o saldo dela continua pagando as taxas.
          // Antes a fee ficava na pagadora e só saía no envio final: a simulação desse envio não a via, e a tela
          // Confirmar não mostrava a coleta (achado de 31/10/2026, test/limpeza/claim-visivel.test.ts).
          // Mede pelo cofre: o que sai dele na coleta é a fee (o saldo da pagadora mistura a taxa de rede e os
          // aluguéis que ela paga ao varrer). Com fee parada, simula antes só a varredura para saber o cofre cheio.
          const vault = pumpCreatorVault(step.wallet);
          let full = BigInt((await lamportsOf(rpc, [vault]))[0]);
          if (sweeps.length) {
            const swept = await probeClaim(sweeps, [vault], [feePayer]);
            if (!Array.isArray(swept)) return swept;
            full = swept[0];
          }
          const [payerBefore] = await lamportsOf(rpc, [feePayer.address]);
          const measured = await probeClaim(collect, [vault, feePayer.address], [feePayer]);
          if (!Array.isArray(measured)) return measured;
          const claim = full - measured[0];
          if (claim <= 0n) return { skip: 'a Pump.fun não tem fee para liberar (o cofre só guarda o aluguel)' };
          if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return { skip: `fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar` };
          const out = split(claim, step.wallet);
          // na transação real ela manda a fee adiante: perde o mesmo que na medida, menos a fee (e a prioridade).
          // Se a Pump.fun não pagar (alguém coletou no meio), a fee sairia do saldo dela: a simulação PARA TUDO
          const minPayerDelta = measured[1] - BigInt(payerBefore) - claim;
          return { instructions: [...collect, ...out.instructions], signers: [feePayer], expectedDestinationDelta: out.toDest, expectedFeeDelta: out.fee, minWalletDelta: minPayerDelta };
        }
        // Aprendido nos testes reais na mainnet (docs/aprendizados.md):
        // 1) a Pump.fun NÃO paga a fee a uma carteira com saldo zero (a coleta roda, mas não move nada);
        //    paga se a carteira já tiver o aluguel mínimo ANTES da coleta;
        // 2) a carteira não pode terminar com saldo entre 0 e o aluguel mínimo.
        // Então, numa transação só: a pagadora EMPRESTA o aluguel → coleta → a temporária DEVOLVE o
        // empréstimo → manda a fee ao destino e termina com o saldo que tinha. Antes, MEDE a fee por simulação.
        // Só a fee: o saldo da temporária sai no "enviar todo o SOL". Cada passo move só o que é dele, porque a
        // simulação roda cada passo sobre a rede de agora; se a coleta levasse o saldo junto, a simulação do envio
        // contaria o mesmo saldo outra vez e a tela Confirmar mostraria a mais (achado de 31/10/2026).
        const rent0 = await rentExemptZero();
        const [wallet] = await lamportsOf(rpc, [step.wallet]);
        const lend = systemTransfer(feePayer.address, step.wallet, BigInt(rent0));
        const ps = { value: await simulateProbe([lend, ...collect], [step.wallet], [feePayer]) };
        if (ps.value.err && isFeeSharing(ps.value.err)) return { skip: FEE_SHARING_SKIP };
        if (ps.value.err) throw new ProbeFailed((ps.value.logs ?? []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ') || JSON.stringify(ps.value.err));
        const after = ps.value.accounts?.[0]?.lamports;
        if (lamportsOrNull(after) === null) throw new ProbeFailed('simulação sem o saldo da temporária');
        const claim = BigInt(after) - BigInt(wallet) - BigInt(rent0);
        if (claim <= 0n) return { skip: 'a Pump.fun não tem fee para liberar (o cofre só guarda o aluguel)' };
        if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return { skip: `fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar` };
        const out = split(claim, step.wallet); // destino (89%) + taxa do app (11%); a burner volta ao saldo de antes
        return {
          instructions: [
            lend,
            ...collect,
            systemTransfer(step.wallet, feePayer.address, BigInt(rent0)), // devolve o empréstimo
            ...out.instructions,
          ],
          signers: [feePayer, owner],
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          // a temporária termina com o saldo de antes; se a fee sumir entre a medida e o envio, a transferência
          // sairia do saldo dela com o rótulo de creator fee: a simulação PARA TUDO (revisão de 31/10/2026)
          minWalletDelta: 0n,
        };
      }
      case 'claim-shared': {
        // Fee dividida (fee sharing, IDL 639b87fb): varre a curva e o pool do sharing config, leva a fee do PumpSwap
        // para a curva e distribui a TODOS os participantes (sem permissão; a pagadora paga a taxa de rede, inclusive
        // pela parte dos outros). A parte desta carteira vai ao destino na mesma transação (89% / 11%).
        const sf = step.shared;
        // participantes de agora: a ordem das contas tem que bater com o sharing config (relido, não o da análise)
        const cfgRaw = await rpc.call<{ value?: Array<{ data?: unknown[] } | null> }>('getMultipleAccounts', [[sf.config], { encoding: 'base64', dataSlice: SHARING_SLICE, commitment: 'confirmed' }]);
        const raw = cfgRaw?.value?.[0]?.data?.[0];
        const cfg = typeof raw === 'string' ? parseSharingConfig(Buffer.from(raw, 'base64')) : null;
        if (!cfg || !cfg.active || cfg.mint !== sf.mint) return { skip: 'a divisão da creator fee desta moeda está pausada ou mudou' };
        if (!cfg.shareholders.some((h) => h.address === step.wallet)) return { skip: 'esta carteira não participa mais da divisão desta moeda' };
        const prep: Instruction[] = [];
        if (sf.curveFee > 0n) prep.push(pumpSweepCreatorFee(feePayer.address, sf.config, sf.mint));
        if (sf.poolSweep) prep.push(pumpAmmSweepCreatorFee(feePayer.address, sf.config, sf.poolSweep.pool, sf.poolSweep.quoteAccount));
        // o cofre do PumpSwap precisa existir (a varredura do pool o cria se faltar)
        if (sf.ammVault || sf.poolSweep) prep.push(pumpAmmTransferCreatorFeesToPumpV2(feePayer.address, sf.config));
        const distribute = pumpDistributeCreatorFeesV2(feePayer.address, sf.mint, sf.config, cfg.shareholders.map((h) => h.address));
        // falha da medida desta divisão não para as outras coletas (a divisão pode falhar por causa de OUTRO
        // participante, por exemplo uma carteira vazia que não pode receber menos que o aluguel): vira falha só dela
        const measure = async (ixs: Instruction[], watch: string[]) => {
          try {
            return await probeClaim(ixs, watch, [feePayer]);
          } catch (e) {
            if (e instanceof ProbeFailed) throw new SharedProbeFailed(e.message);
            throw e;
          }
        };
        // Outras carteiras da rodada também podem estar na divisão (o destino, a carteira da taxa do app): a parte
        // delas chega na mesma transação e entra no valor esperado (senão a conferência exata pararia a rodada).
        const others = [destination, ...(appFee ? [appFee.wallet] : [])];
        // só para quem está na divisão: o saldo de uma carteira de fora pode mudar no meio por outro motivo (medido na
        // mainnet em 31/10/2026: a carteira da taxa recebeu a taxa de outra limpeza entre a leitura e a medida)
        const inSplit = (a: string) => cfg.shareholders.some((h) => h.address === a);
        const extraOf = (after: bigint[], before: bigint[], at: number) => others.map((a, i) => (inSplit(a) ? after[at + i] - before[at + i] : 0n));
        // Custo: o que a pagadora gasta na distribuição (taxa de rede, aluguéis da varredura), inclusive pela parte dos
        // outros participantes. Divisão em que a parte desta carteira não paga esse custo com folga não é coletada
        // (revisão de segurança, 31/10/2026: qualquer um cria uma divisão com esta carteira e uma parte mínima).
        const worthIt = (share: bigint, cost: bigint): Skip | null =>
          share <= cost + BigInt(BASE_FEE_LAMPORTS * 2)
            ? { skip: share > 0n ? `a parte desta carteira (${share} lamports) não paga a taxa da distribuição (${cost} lamports): não compensa coletar` : 'a divisão desta moeda não tem fee para esta carteira agora' }
            : null;
        if (step.wallet === feePayer.address) {
          // a pagadora participa: a parte dela = saldo depois de distribuir − saldo depois só das preparações (os
          // custos das duas medidas são iguais: 1 assinatura e os mesmos aluguéis)
          const watch = [feePayer.address, ...others];
          const before = (await lamportsOf(rpc, watch)).map(BigInt);
          let p1 = before[0] - BigInt(BASE_FEE_LAMPORTS);
          if (prep.length) {
            const m1 = await measure(prep, [feePayer.address]);
            if (!Array.isArray(m1)) return m1;
            p1 = m1[0];
          }
          const m2 = await measure([...prep, distribute], watch);
          if (!Array.isArray(m2)) return m2;
          const share = m2[0] - p1;
          const no = worthIt(share, before[0] - p1);
          if (no) return no;
          const out = split(share, step.wallet);
          const [destExtra, feeExtra = 0n] = extraOf(m2, before, 1);
          // na real ela perde o mesmo que só nas preparações; mais que isso = a parte não veio (PARA TUDO)
          return { instructions: [...prep, distribute, ...out.instructions], signers: [feePayer], expectedDestinationDelta: out.toDest + destExtra, expectedFeeDelta: out.fee + feeExtra, minWalletDelta: p1 - before[0] };
        }
        // temporária: como na coleta da curva, a pagadora empresta o aluguel (carteira vazia não pode receber menos
        // que ele), a temporária devolve e manda só a parte dela; termina com o saldo de antes
        const rent0 = BigInt(await rentExemptZero());
        const watch = [step.wallet, feePayer.address, ...others];
        const before = (await lamportsOf(rpc, watch)).map(BigInt);
        const lend = systemTransfer(feePayer.address, step.wallet, rent0);
        const m = await measure([lend, ...prep, distribute], watch);
        if (!Array.isArray(m)) return m;
        const share = m[0] - before[0] - rent0;
        // a pagadora: o empréstimo volta; a transação real tem mais uma assinatura (a da temporária)
        const no = worthIt(share, before[1] - m[1] - rent0 + BigInt(BASE_FEE_LAMPORTS));
        if (no) return no;
        const out = split(share, step.wallet);
        const [destExtra, feeExtra = 0n] = extraOf(m, before, 2);
        return {
          instructions: [lend, ...prep, distribute, systemTransfer(step.wallet, feePayer.address, rent0), ...out.instructions],
          signers: [feePayer, owner],
          expectedDestinationDelta: out.toDest + destExtra,
          expectedFeeDelta: out.fee + feeExtra,
          minWalletDelta: 0n,
        };
      }
      case 'close-uva': {
        // Conta de volume da Pump.fun ou do PumpSwap (close_user_volume_accumulator, IDL 639b87fb, relido em
        // 06/11/2026): só a que não guarda mais nada (scan.ts uvaVerdict), relida AGORA, não a da análise. Todos os
        // lamports dela vão para a temporária (que assina), e dali ao destino na mesma transação (89% / 11%).
        // Na Pump.fun, o cashback em SOL dela é coletado antes, na mesma transação (o plano não monta outro passo).
        const program = step.venue === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm;
        const now = await readUva(rpc, step.wallet, step.venue, uvaRound, await rentExemptZero());
        if (!now) return { skip: 'a conta de cashback já foi fechada' };
        // Pump.fun: o plano não monta passo de cashback para a conta que fecha (vai junto no fechamento). Se o fechamento
        // não entra (releitura que falhou, conta que passou a guardar algo, programa que recusa), o cashback em SOL dela
        // vai num passo claim-cashback, com a regra dele de "compensa coletar": falha ao fechar não prende o cashback
        // (spec §4.4; revisão independente de 08/11/2026). Na simulação e na execução, pelo mesmo caminho.
        const unknown = now.why === 'read-failed';
        const cashbackStep: Step | null =
          step.venue === 'pump' && (unknown || now.lamports > now.rentLamports)
            ? { kind: 'claim-cashback', walletIndex: step.walletIndex, wallet: step.wallet, venue: 'pump', estimateLamports: now.lamports > now.rentLamports ? now.lamports - now.rentLamports : (step.cashbackLamports ?? 0n) }
            : null;
        if (!now.closable) {
          const why = unknown ? 'não deu para conferir a conta de cashback agora: fica aberta' : 'a conta de cashback guarda algo agora: fica aberta';
          return cashbackStep ? { instead: cashbackStep, why, refused: false } : { skip: why };
        }
        const cashback = step.venue === 'pump' && now.lamports > now.rentLamports ? [pumpClaimCashbackV2(step.wallet)] : [];
        const ixs = [...cashback, pumpCloseUserVolumeAccumulator(step.wallet, program)];
        const signersNow = uniqueSigners([feePayer, owner]);
        // falha da medida não diz nada das coletas: só esta conta fica aberta (vira aviso no recibo). Com cashback, o
        // programa que recusa [coleta, fechar] não leva a coleta junto: ela vai sozinha no passo seguinte
        const isolated = async (list: Instruction[], watch: string[]): Promise<bigint[] | Skip | Instead> => {
          try {
            return await probeClaim(list, watch, signersNow);
          } catch (e) {
            if (!(e instanceof ProbeFailed)) throw e;
            if (cashback.length && cashbackStep) return { instead: cashbackStep, why: `a rede recusou fechar a conta de cashback (${e.message}): fica aberta`, refused: true };
            throw new SharedProbeFailed(e.message);
          }
        };
        const onRefuse = cashback.length && cashbackStep ? { onRefuse: cashbackStep } : {};
        // Pump.fun: o que a conta tinha acima do aluguel é cashback (a coleta paga isso); o aluguel vai em "contas
        // fechadas" (recibo). PumpSwap: o cashback dele é WSOL na ATA da conta (que impede fechar); o que passa do
        // aluguel de hoje é aluguel pago a mais quando ele era mais caro (1.844.400 em contas antigas, mainnet
        // 06/11/2026): tudo é conta fechada
        const parts = (gain: bigint) => (cashback.length && gain > now.rentLamports ? now.rentLamports : gain);
        const small = (gain: bigint): Skip => ({ skip: `a conta de cashback devolve ${gain} lamports, menos que a taxa da rede: não compensa fechar` });
        if (step.wallet === feePayer.address) {
          const [before] = await lamportsOf(rpc, [feePayer.address]);
          const m = await isolated(ixs, [feePayer.address]);
          if (!Array.isArray(m)) return m;
          const gain = m[0] - BigInt(before) + BigInt(BASE_FEE_LAMPORTS); // a medida tem 1 assinatura
          if (gain <= BigInt(BASE_FEE_LAMPORTS * 2)) return small(gain);
          const out = split(gain, step.wallet);
          return { instructions: [...ixs, ...out.instructions], signers: signersNow, expectedDestinationDelta: out.toDest, expectedFeeDelta: out.fee, minWalletDelta: -BigInt(BASE_FEE_LAMPORTS), closedRent: parts(gain), ...onRefuse };
        }
        // temporária (talvez vazia): a pagadora empresta o aluguel antes, como no cashback, e recebe de volta
        const rent0 = BigInt(await rentExemptZero());
        const [wallet] = await lamportsOf(rpc, [step.wallet]);
        const lend = systemTransfer(feePayer.address, step.wallet, rent0);
        const m = await isolated([lend, ...ixs], [step.wallet]);
        if (!Array.isArray(m)) return m;
        const gain = m[0] - BigInt(wallet) - rent0;
        if (gain <= BigInt(BASE_FEE_LAMPORTS * 2)) return small(gain);
        const out = split(gain, step.wallet);
        return {
          instructions: [lend, ...ixs, systemTransfer(step.wallet, feePayer.address, rent0), ...out.instructions],
          signers: signersNow,
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          // termina com o saldo de antes: se a conta não pagar, o envio sairia do saldo dela (PARA TUDO)
          minWalletDelta: 0n,
          closedRent: parts(gain),
          ...onRefuse,
        };
      }
      case 'claim-cashback':
        if (step.venue === 'pump') {
          // Cashback da Pump.fun (IDL 639b87fb, claim_cashback_v2, sem permissão): o SOL acima do aluguel do acumulador
          // vai para a temporária, e dali ao destino na mesma transação (89% / 11%), como a coleta da curva
          const claimIx = pumpClaimCashbackV2(step.wallet);
          const isolated = async (ixs: Instruction[], watch: string[]) => {
            try {
              return await probeClaim(ixs, watch, [feePayer]);
            } catch (e) {
              if (e instanceof ProbeFailed) throw new SharedProbeFailed(e.message);
              throw e;
            }
          };
          if (step.wallet === feePayer.address) {
            const [before] = await lamportsOf(rpc, [feePayer.address]);
            const m = await isolated([claimIx], [feePayer.address]);
            if (!Array.isArray(m)) return m;
            const gain = m[0] - BigInt(before) + BigInt(BASE_FEE_LAMPORTS);
            if (gain <= BigInt(BASE_FEE_LAMPORTS * 2)) return { skip: gain > 0n ? `cashback de ${gain} lamports é menor que a taxa da rede: não compensa coletar` : 'a Pump.fun não tem cashback para esta carteira agora' };
            const out = split(gain, step.wallet);
            return { instructions: [claimIx, ...out.instructions], signers: [feePayer], expectedDestinationDelta: out.toDest, expectedFeeDelta: out.fee, minWalletDelta: -BigInt(BASE_FEE_LAMPORTS) };
          }
          const rent0 = BigInt(await rentExemptZero());
          const [wallet] = await lamportsOf(rpc, [step.wallet]);
          const lend = systemTransfer(feePayer.address, step.wallet, rent0);
          const m = await isolated([lend, claimIx], [step.wallet]);
          if (!Array.isArray(m)) return m;
          const gain = m[0] - BigInt(wallet) - rent0;
          if (gain <= BigInt(BASE_FEE_LAMPORTS * 2)) return { skip: gain > 0n ? `cashback de ${gain} lamports é menor que a taxa da rede: não compensa coletar` : 'a Pump.fun não tem cashback para esta carteira agora' };
          const out = split(gain, step.wallet);
          return {
            instructions: [lend, claimIx, systemTransfer(step.wallet, feePayer.address, rent0), ...out.instructions],
            signers: [feePayer, owner],
            expectedDestinationDelta: out.toDest,
            expectedFeeDelta: out.fee,
            minWalletDelta: 0n,
          };
        }
      // falls through: o cashback do PumpSwap chega em WSOL na ATA da temporária, como a coleta do PumpSwap; mesma lógica
      case 'claim-amm': {
        // fee parada no pool (trocas buy_v2/sell_v2 do PumpSwap): varre para o cofre antes de coletar
        const sweeps = step.kind === 'claim-amm' ? (step.sweeps ?? []).map((x) => pumpAmmSweepCreatorFee(feePayer.address, step.wallet, x.pool, x.quoteAccount)) : [];
        const tokenRent = rentFor(TOKEN_ACCOUNT_BYTES, await rentExemptZero());
        if (step.kind === 'claim-amm' && step.sweepOnly) return sweepOnly(sweeps, pumpAmmCreatorVaultAta(step.wallet), tokenRent);
        // A coleta paga em WSOL na ATA da temporária, que a transação fecha (vira SOL na temporária). Antes a fee
        // ficava ali e só saía no "enviar todo o SOL": a simulação desse envio não a via, e a tela Confirmar não
        // mostrava a coleta, mas a execução levava (achado de 31/10/2026, test/limpeza/claim-visivel.test.ts).
        // Agora vai ao destino NA MESMA transação, como a coleta da curva (89% destino, 11% taxa).
        // Mede pela ATA: o que entra nela na coleta é a fee. Se a pagadora cria a ATA, a temporária devolve o aluguel.
        const ata = associatedTokenAddress(step.wallet, WSOL_MINT, PROGRAMS.token);
        const [ataBefore] = (await lamportsOf(rpc, [ata])).map(BigInt);
        // cria a ATA, varre, coleta (e o cashback do PumpSwap, se a carteira tiver: cai na mesma ATA), fecha
        const collect =
          step.kind === 'claim-amm' ? [...sweeps, pumpAmmCollectCoinCreatorFee(step.wallet), ...(step.cashback ? [pumpAmmClaimCashback(step.wallet)] : [])] : [pumpAmmClaimCashback(step.wallet)];
        const instructions = [ataCreateIdempotent(feePayer.address, step.wallet, WSOL_MINT, PROGRAMS.token), ...collect, tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet)];
        const [payerBefore] = await lamportsOf(rpc, [feePayer.address]);
        const created = ataBefore === 0n;
        const isPayer = step.wallet === feePayer.address;
        // O plano tira esta ATA do passo das contas (a coleta a fecha). Se a coleta não roda (fee sharing, sem fee,
        // fee menor que a taxa), o passo fecha a ATA mesmo assim: senão o aluguel (e o WSOL esquecido) ficaria na
        // temporária sem aviso (revisão de 31/10/2026). Não conta como coleta (skippedClaim).
        const closeOnly = (why: string): Built | Skip => {
          if (created) return { skip: why };
          const out = split(ataBefore, step.wallet);
          return {
            instructions: [tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...out.instructions],
            signers: uniqueSigners([feePayer, owner]),
            expectedDestinationDelta: out.toDest,
            expectedFeeDelta: out.fee,
            minWalletDelta: isPayer ? -BigInt(BASE_FEE_LAMPORTS) : 0n,
            closedRent: ataBefore,
            skippedClaim: why,
          };
        };
        let measured: bigint[] | Skip;
        try {
          measured = await probeClaim(instructions.slice(0, -1), [ata, feePayer.address], [feePayer]);
        } catch (e) {
          // cashback que falha não diz nada das coletas de creator fee: só ele fica de fora
          if (e instanceof ProbeFailed && step.kind === 'claim-cashback') throw new SharedProbeFailed(e.message);
          throw e;
        }
        if (!Array.isArray(measured)) return closeOnly(measured.skip);
        const claim = measured[0] - (created ? tokenRent : ataBefore);
        if (claim <= 0n) return closeOnly('o PumpSwap não tem fee para liberar');
        if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return closeOnly(`fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar`);
        // a ATA que já existia é da temporária: o aluguel e algum WSOL esquecido vão junto (closedRent; o recibo põe
        // em "contas fechadas", como o passo das contas faz com a conta de WSOL). O plano não a fecha à parte.
        const recovered = claim + (created ? 0n : ataBefore);
        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];
        // só o recuperado: o saldo da temporária sai no "enviar todo o SOL" (ver a coleta da curva)
        const out = split(recovered, step.wallet);
        // pagadora: na real ela recebe a ATA fechada (aluguel que pagou + o recuperado) e manda o recuperado adiante;
        // perder mais que na medida = a coleta não pagou e o envio sairia do saldo dela (PARA TUDO)
        // temporária: termina com o saldo de antes (não pode perder: ver a coleta da curva)
        const minWalletDelta = isPayer ? measured[1] - BigInt(payerBefore) + (created ? tokenRent : 0n) : 0n;
        return {
          instructions: [...instructions, ...refund, ...out.instructions],
          signers: uniqueSigners([feePayer, owner]),
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          minWalletDelta,
          ...(created ? {} : { closedRent: ataBefore }),
        };
      }
      case 'claim-dbc': {
        // Meteora DBC (claim_creator_trading_fee v1; IDL 0.2.2 e código do programa 0.2.3 conferidos em 09/11/2026,
        // docs/meteora-dbc.md). O programa confere que quem assina é o creator do pool (access_control is_pool_creator,
        // 6053 Unauthorized). max_base_amount = 0: a fee na moeda (base) fica (é memecoin; o app só coleta SOL);
        // max_quote_amount = u64::MAX: toda a fee em SOL, que chega em WSOL na ATA WSOL da temporária (token_b).
        // token_a tem que ser uma conta de token válida e DIFERENTE da token_b (as duas são mut: a mesma conta nas duas dá
        // 2040 ConstraintDuplicateMutableAccount, simulado na mainnet em 09/11/2026). O app usa a conta da moeda (ATA do
        // base mint) da temporária: se não existe, a pagadora cria e o aluguel volta a ela na mesma transação; se já existe,
        // só é passada (nada entra nem sai dela). Mede pela ATA WSOL, como a coleta do PumpSwap.
        const rent0 = await rentExemptZero();
        const tokenRent = rentFor(TOKEN_ACCOUNT_BYTES, rent0);
        const ata = associatedTokenAddress(step.wallet, WSOL_MINT, PROGRAMS.token);
        const isPayer = step.wallet === feePayer.address;
        // pools relidos AGORA (não os da análise): o que mudou de creator, de cofre ou de moeda, ou passou a ter transfer
        // hook, fica de fora; o resto segue
        // releitura fora do formato = "não sei": só este passo falha (e as próximas da Meteora), sem parar a limpeza
        let now: Awaited<ReturnType<typeof readDbcPools>>;
        try {
          now = await readDbcPools(rpc, step.pools.map((p) => p.pool));
        } catch (e) {
          if (e instanceof RpcError || e instanceof CodedError) throw e;
          throw new DbcProbeFailed(`releitura dos pools: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
        }
        const same = step.pools.map((p, i) => {
          const n = now[i];
          return n !== null && !n.hook && n.creator === step.wallet && n.baseMint === p.baseMint && n.baseVault === p.baseVault && n.quoteVault === p.quoteVault && dbcBaseTokenProgram(n.poolType) === p.baseTokenProgram;
        });
        const live = step.pools.filter((_, i) => same[i] && now[i]!.quoteFee > 0n);
        const baseAtas = live.map((p) => associatedTokenAddress(step.wallet, p.baseMint, p.baseTokenProgram));
        const [ataBefore, ...baseBefore] = (await lamportsOf(rpc, [ata, ...baseAtas])).map(BigInt);
        const created = ataBefore === 0n;
        // a ATA WSOL que já era da temporária vai junto ao destino (contas fechadas), a menos que um passo anterior desta
        // carteira já a feche (a simulação de cada passo roda sobre a rede de agora: contaria duas vezes)
        const counts = !created && !step.wsolClosedBefore;
        const signersNow = uniqueSigners([feePayer, owner]);
        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como no PumpSwap).
        const closeOnly = (why: string): Built | Skip => {
          if (!counts) return { skip: why };
          const out = split(ataBefore, step.wallet);
          return {
            instructions: [tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...out.instructions],
            signers: signersNow,
            expectedDestinationDelta: out.toDest,
            expectedFeeDelta: out.fee,
            minWalletDelta: isPayer ? -BigInt(BASE_FEE_LAMPORTS) : 0n,
            closedRent: ataBefore,
            skippedClaim: why,
          };
        };
        if (!live.length) return closeOnly(same.every(Boolean) ? 'a Meteora não tem fee para coletar agora' : 'o pool da Meteora mudou (criador, cofre ou tipo) desde a análise: não coleto');
        const createBase = live.map((_, i) => baseBefore[i] === 0n);
        const prep = [
          ataCreateIdempotent(feePayer.address, step.wallet, WSOL_MINT, PROGRAMS.token),
          ...live.flatMap((p, i) => (createBase[i] ? [ataCreateIdempotent(feePayer.address, step.wallet, p.baseMint, p.baseTokenProgram)] : [])),
        ];
        const claims = live.map((p, i) =>
          dbcClaimCreatorTradingFee(
            { pool: p.pool, creator: step.wallet, tokenA: baseAtas[i], tokenB: ata, baseVault: p.baseVault, quoteVault: p.quoteVault, baseMint: p.baseMint, quoteMint: WSOL_MINT, baseTokenProgram: p.baseTokenProgram, quoteTokenProgram: PROGRAMS.token },
            0n,
            U64_MAX,
          ),
        );
        const createdBase = baseAtas.filter((_, i) => createBase[i]);
        const [payerBefore] = await lamportsOf(rpc, [feePayer.address]);
        let m: bigint[] | Skip;
        try {
          m = await probeClaim([...prep, ...claims], [ata, feePayer.address, ...createdBase], signersNow, false);
        } catch (e) {
          if (e instanceof ProbeFailed) throw new DbcProbeFailed(e.message);
          throw e;
        }
        if (!Array.isArray(m)) return closeOnly(m.skip);
        const claim = m[0] - (created ? tokenRent : ataBefore);
        if (claim <= 0n) return closeOnly('a Meteora não tem fee para coletar agora');
        if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return closeOnly(`fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar`);
        // aluguel das contas da moeda que a pagadora criou: volta a ela no fechamento, na mesma transação
        const baseRents = m.slice(2).reduce((a, x) => a + x, 0n);
        const closes = [
          ...live.flatMap((p, i) => (createBase[i] ? [tokenCloseAccount(p.baseTokenProgram, baseAtas[i], feePayer.address, step.wallet)] : [])),
          tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet),
        ];
        const recovered = claim + (counts ? ataBefore : 0n);
        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];
        const out = split(recovered, step.wallet);
        // pagadora: perde o que perdeu na medida, menos os aluguéis que voltam; mais que isso = a fee não veio e o envio
        // sairia do saldo dela (PARA TUDO). Temporária: termina com o saldo de antes (ou mais, se a ATA não conta aqui)
        const minWalletDelta = isPayer ? m[1] - BigInt(payerBefore) + (created ? tokenRent : 0n) + baseRents : 0n;
        return {
          instructions: [...prep, ...claims, ...closes, ...refund, ...out.instructions],
          signers: signersNow,
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          minWalletDelta,
          ...(counts ? { closedRent: ataBefore } : {}),
        };
      }
      case 'claim-launchlab': {
        // Raydium LaunchLab (claim_creator_fee; IDL 0.2.0, crate CPI 115df27 e SDK V2 1cf5bb1 conferidos em 09/11/2026,
        // docs/launchlab.md). O cofre é o PDA [creator, WSOL]: só o próprio criador assina (o endereço do cofre sai da
        // chave dele). A fee chega em WSOL na ATA WSOL da temporária (o programa exige a ATA: init_if_needed com o creator
        // como payer). A pagadora cria a ATA antes (idempotente), então a temporária vazia não paga nada; a transação
        // fecha a ATA (vira SOL na temporária) e manda ao destino, 89/11. Mede pela ATA WSOL, como a coleta da Meteora.
        const rent0 = await rentExemptZero();
        const tokenRent = rentFor(TOKEN_ACCOUNT_BYTES, rent0);
        const ata = associatedTokenAddress(step.wallet, WSOL_MINT, PROGRAMS.token);
        const isPayer = step.wallet === feePayer.address;
        // cofre relido AGORA: fora do formato = "não sei" (só este passo falha, e as próximas do LaunchLab)
        let vaultNow: bigint | null;
        try {
          vaultNow = await readLaunchlabVault(rpc, step.wallet);
        } catch (e) {
          if (e instanceof RpcError || e instanceof CodedError) throw e;
          throw new LaunchlabProbeFailed(`releitura do cofre: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
        }
        const [ataBefore] = (await lamportsOf(rpc, [ata])).map(BigInt);
        const created = ataBefore === 0n;
        const counts = !created && !step.wsolClosedBefore;
        const signersNow = uniqueSigners([feePayer, owner]);
        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como na Meteora).
        const closeOnly = (why: string): Built | Skip => {
          if (!counts) return { skip: why };
          const out = split(ataBefore, step.wallet);
          return {
            instructions: [tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...out.instructions],
            signers: signersNow,
            expectedDestinationDelta: out.toDest,
            expectedFeeDelta: out.fee,
            minWalletDelta: isPayer ? -BigInt(BASE_FEE_LAMPORTS) : 0n,
            closedRent: ataBefore,
            skippedClaim: why,
          };
        };
        if (!vaultNow) return closeOnly('o LaunchLab não tem fee para coletar agora');
        const claimIx = launchlabClaimCreatorFee(step.wallet, LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault(step.wallet));
        const prep = ataCreateIdempotent(feePayer.address, step.wallet, WSOL_MINT, PROGRAMS.token);
        const [payerBefore] = await lamportsOf(rpc, [feePayer.address]);
        let m: bigint[] | Skip;
        try {
          m = await probeClaim([prep, claimIx], [ata, feePayer.address], signersNow, false);
        } catch (e) {
          if (e instanceof ProbeFailed) throw new LaunchlabProbeFailed(e.message);
          throw e;
        }
        if (!Array.isArray(m)) return closeOnly(m.skip);
        const claim = m[0] - (created ? tokenRent : ataBefore);
        if (claim <= 0n) return closeOnly('o LaunchLab não tem fee para coletar agora');
        if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return closeOnly(`fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar`);
        const recovered = claim + (counts ? ataBefore : 0n);
        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];
        const out = split(recovered, step.wallet);
        // pagadora: perde o que perdeu na medida, menos a ATA que volta; mais que isso = a fee não veio e o envio sairia do
        // saldo dela (PARA TUDO). Temporária: termina com o saldo de antes
        const minWalletDelta = isPayer ? m[1] - BigInt(payerBefore) + (created ? tokenRent : 0n) : 0n;
        return {
          instructions: [prep, claimIx, tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...refund, ...out.instructions],
          signers: signersNow,
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          minWalletDelta,
          ...(counts ? { closedRent: ataBefore } : {}),
        };
      }
      case 'tokens': {
        // estado de agora de cada conta: a que mudou desde a varredura sai do passo com motivo, antes de simular
        // (queimar o valor analisado falharia: 0x1 se saiu token, 0xb se chegou e a conta não fecha com saldo)
        const now = await tokenAccountsNow(rpc, step.actions.map((a) => a.account));
        const changed = step.actions.filter((a, i) => balanceChanged(a, now[i]));
        const gone = step.actions.filter((_, i) => now[i] === null);
        if (changed.length || gone.length) {
          const keep = step.actions.filter((a) => !changed.includes(a) && !gone.includes(a));
          return { changed: changed.map((a) => ({ action: a, now: now[step.actions.indexOf(a)]!.amount! })), gone, keep: keep.length ? { ...step, actions: keep } : null };
        }
        const rent = BigInt(now.reduce((x, y) => x + y!.lamports, 0));
        if (!appFee) {
          const instructions = step.actions.flatMap((a) => tokenInstructions(a, step.wallet, destination, feePayer.address));
          return { instructions, signers: [feePayer, owner], expectedDestinationDelta: rent };
        }
        // com taxa: o aluguel cai na burner e sai dela na mesma transação (89% destino, 11% taxa);
        // a burner termina com o saldo que já tinha
        const out = split(rent, step.wallet);
        const instructions = [...step.actions.flatMap((a) => tokenInstructions(a, step.wallet, destination, feePayer.address, step.wallet)), ...out.instructions];
        return { instructions, signers: [feePayer, owner], expectedDestinationDelta: out.toDest, expectedFeeDelta: out.fee };
      }
      case 'sweep-sol': {
        const [balance] = await lamportsOf(rpc, [step.wallet]);
        // a pagadora se esvazia por último: deixa só a taxa base + a de prioridade (limite fixo e conhecido)
        const fee = step.isFeePayer ? BigInt(BASE_FEE_LAMPORTS) + priorityFeeLamports(budgetedPriorityPrice(priorityPrice, SWEEP_COMPUTE_LIMIT), SWEEP_COMPUTE_LIMIT) : 0n;
        const amount = BigInt(balance) - fee;
        if (amount <= 0n) return null;
        // pagadora: só o depósito do cliente para as taxas é isento (plan.payerExemptLamports); o que as taxas de
        // rede já gastaram sai da parte esquecida. Todo o resto paga 11% uma vez, aqui.
        const out = step.isFeePayer ? payerSplit(amount, step.wallet) : split(amount, step.wallet);
        return {
          instructions: out.instructions,
          signers: [feePayer, owner],
          expectedDestinationDelta: out.toDest,
          expectedFeeDelta: out.fee,
          fixedComputeLimit: SWEEP_COMPUTE_LIMIT,
        };
      }
      case 'fund': {
        // empréstimo das taxas para outra frase (funding.ts): a pagadora (= a dona do passo) manda o valor exato
        // para a temporária da outra frase, que é o "destino" deste plano de um passo; a simulação confere o valor
        if (step.to !== destination) throw new ExecutionAborted('O destino do empréstimo não confere com o plano.');
        if (owner.address !== feePayer.address) throw new ExecutionAborted('Só a pagadora empresta.');
        if (step.lamports <= 0n) return null;
        const [balance] = await lamportsOf(rpc, [step.wallet]);
        if (BigInt(balance) < step.lamports + BigInt(BASE_FEE_LAMPORTS) + priorityFeeLamports(budgetedPriorityPrice(priorityPrice, SWEEP_COMPUTE_LIMIT), SWEEP_COMPUTE_LIMIT)) return { skip: 'a emprestadora não tem mais o SOL de sobra' };
        return {
          instructions: [systemTransfer(step.wallet, step.to, step.lamports)],
          signers: [feePayer],
          expectedDestinationDelta: step.lamports,
          expectedFeeDelta: 0n,
          fixedComputeLimit: SWEEP_COMPUTE_LIMIT,
        };
      }
      case 'gather': {
        // juntar o SOL da própria frase (gather.ts): esta temporária manda o valor exato para a pagadora, que é o
        // "destino" deste plano (a simulação confere o valor). Ela mesma paga a taxa: a pagadora ainda não tem SOL.
        if (step.to !== destination) throw new ExecutionAborted('O destino da junção não confere com o plano.');
        if (step.wallet === step.to) throw new ExecutionAborted('A pagadora não junta SOL nela mesma.');
        if (step.lamports <= 0n) return null;
        const [balance] = await lamportsOf(rpc, [step.wallet]);
        const fee = BigInt(BASE_FEE_LAMPORTS) + priorityFeeLamports(budgetedPriorityPrice(priorityPrice, SWEEP_COMPUTE_LIMIT), SWEEP_COMPUTE_LIMIT);
        // a rede só aceita a conta com 0 SOL ou com pelo menos o aluguel de conta vazia (InsufficientFundsForRent):
        // "tudo" deixa 0 (valor exato agora, com a taxa real); senão o que sobra tem que cobrir o aluguel
        let amount = step.lamports;
        if (step.all) {
          amount = BigInt(balance) - fee;
          if (amount <= 0n) return { skip: 'a temporária não tem mais SOL' };
        } else {
          const left = BigInt(balance) - amount - fee;
          if (left < 0n) return { skip: 'a temporária não tem mais esse SOL' };
          if (left > 0n && left < BigInt(await rentExemptZero())) return { skip: 'a temporária ficaria abaixo do aluguel mínimo da rede' };
        }
        return {
          instructions: [systemTransfer(step.wallet, step.to, amount)],
          signers: [owner],
          payer: owner,
          expectedDestinationDelta: amount,
          expectedFeeDelta: 0n,
          fixedComputeLimit: SWEEP_COMPUTE_LIMIT,
        };
      }
    }
  }

  // 'expirou' só quando a REDE confirma que o blockhash venceu (achado da revisão: prazo de relógio
  // podia refazer o envio com a primeira transação ainda válida). Sem confirmação de nada até o
  // limite → 'desconhecido' (não refaz; o usuário confere pelo link).
  async function send(bytes: Uint8Array, signature: string, lastValidBlockHeight: number): Promise<'confirmado' | 'expirou' | 'desconhecido' | string> {
    const b64 = Buffer.from(bytes).toString('base64');
    const deadline = now() + (opts.confirmTimeoutMs ?? 180_000);
    for (let i = 0; now() < deadline; i++) {
      if (i % 4 === 0) await rpc.call('sendTransaction', [b64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {});
      await sleep(1500);
      try {
        const st = await rpc.call<{ value: Array<{ err: unknown; confirmationStatus?: string; slot?: number } | null> }>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]);
        const s = st?.value?.[0];
        if (s?.err) return `erro na rede: ${JSON.stringify(s.err)}`;
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          if (typeof s.slot === 'number' && Number.isSafeInteger(s.slot)) slot.last = Math.max(slot.last, s.slot);
          return 'confirmado';
        }
        if (i % 4 === 3) {
          const h = await rpc.call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
          if (h > lastValidBlockHeight) return 'expirou';
        }
      } catch (e) {
        if (!(e instanceof RpcError)) throw e; // rede instável: continua tentando até o limite
      }
    }
    return 'desconhecido';
  }

  let started = 0;
  while (queue.length) {
    const step = queue.shift()!;
    try {
      opts.onStepStart?.(step, started, started + 1 + queue.length);
    } catch {
      // aviso de tela nunca derruba a execução
    }
    started++;
    const description = describeStep(step, opts.label);
    if (pumpDisabled && (step.kind === 'claim-curve' || step.kind === 'claim-amm')) {
      record({ step, description, status: 'cancelado', detail: 'uma coleta da Pump.fun falhou antes; não insisto', error: { code: 'pump-claim-failed', params: {}, technical: 'coleta cancelada: uma coleta anterior da Pump.fun falhou', beforeSend: true } });
      continue;
    }
    if (launchlabDisabled && step.kind === 'claim-launchlab') {
      record({ step, description, status: 'cancelado', detail: 'uma coleta do LaunchLab falhou antes; não insisto', error: { code: 'launchlab-claim-failed', params: {}, technical: 'coleta cancelada: uma coleta anterior do LaunchLab falhou', beforeSend: true } });
      continue;
    }
    if (dbcDisabled && step.kind === 'claim-dbc') {
      record({ step, description, status: 'cancelado', detail: 'uma coleta da Meteora falhou antes; não insisto', error: { code: 'dbc-claim-failed', params: {}, technical: 'coleta cancelada: uma coleta anterior da Meteora falhou', beforeSend: true } });
      continue;
    }
    // Erro de rede no meio de um passo não derruba a execução nem some com o relatório
    // (achado da revisão): registra 'desconhecido' com o link, se algo já foi enviado.
    let sent: string | null = null;
    try {
      await runStep(step, description, (sig) => (sent = sig));
    } catch (e) {
      if (!(e instanceof RpcError)) {
        // parada (StopRequested) ou outro erro que encerra a execução DEPOIS de um envio: a transação já está
        // na rede e tem que aparecer no relatório, com o link; não reenvio. O erro continua subindo.
        if (sent) record({ step, description, status: 'desconhecido', signature: sent, detail: 'parado antes da confirmação; confira pelo link se caiu (não reenvio)', error: { code: 'send-unknown', params: {}, technical: '', beforeSend: false } });
        throw e;
      }
      if (step.kind === 'claim-curve' || step.kind === 'claim-amm') pumpDisabled = true;
      if (step.kind === 'claim-dbc') dbcDisabled = true;
      if (step.kind === 'claim-launchlab') launchlabDisabled = true;
      record(
        sent
          ? { step, description, status: 'desconhecido', signature: sent, detail: `a rede parou de responder depois do envio (${e.message}); confira pelo link se caiu`, error: { ...explainError(e, { beforeSend: false }), code: 'send-unknown', params: {} } }
          : { step, description, status: 'falhou', detail: `a rede não respondeu, nada foi enviado neste passo (${e.message})`, error: explainError(e, { beforeSend: true }) },
      );
    }
  }
  return results;

  async function runStep(step: Step, description: string, onSent: (sig: string) => void) {
    let previous: string | null = null;
    let previousDeltas: { destinationDelta: bigint; appFeeDelta: bigint } | null = null; // da tentativa que expirou
    for (let attempt = 0; attempt < 2; attempt++) {
      if (previous) {
        // a tentativa anterior expirou: confere se ela caiu mesmo assim antes de refazer
        const st = await rpc.call<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[previous], { searchTransactionHistory: true }]);
        const s0 = st?.value?.[0];
        if (s0 && !s0.err) {
          // foi a transação simulada daquela tentativa que caiu: o que ela levou ao destino e à taxa conta igual
          record({ step, description, status: 'enviado', signature: previous, detail: 'confirmada com atraso', ...previousDeltas });
          break;
        }
      }
      let built: Built | Skip | Changed | Instead | null;
      try {
        built = await build(step); // remonta a cada tentativa: saldos atualizados
      } catch (e) {
        if (!(e instanceof ProbeFailed) && !(e instanceof SharedProbeFailed) && !(e instanceof DbcProbeFailed) && !(e instanceof LaunchlabProbeFailed)) throw e;
        if (e instanceof ProbeFailed) pumpDisabled = true;
        if (e instanceof DbcProbeFailed) dbcDisabled = true;
        if (e instanceof LaunchlabProbeFailed) launchlabDisabled = true;
        record({ step, description, status: 'falhou', detail: `simulação da coleta falhou, nada enviado: ${e.message}`, error: explainError(e, { stepKind: step.kind, beforeSend: true }) });
        break;
      }
      if (built && 'changed' in built) {
        // uma linha por conta, com o motivo; as outras contas do lote seguem (voltam à fila sem esta)
        for (const { action, now } of built.changed) {
          const one: Step = { ...step, actions: [action] } as Step;
          record({ step: one, description: describeStep(one, opts.label), status: 'falhou', detail: `o saldo desta moeda mudou desde a análise (${action.amount} → ${now}); nada enviado`, error: { code: 'token-balance-changed', params: {}, technical: `mint ${action.mint}: analisado ${action.amount}, agora ${now}`, beforeSend: true } });
        }
        for (const action of built.gone) {
          const one: Step = { ...step, actions: [action] } as Step;
          record({ step: one, description: describeStep(one, opts.label), status: 'nada a fazer', detail: 'a conta já foi fechada' });
        }
        if (built.keep) queue.unshift(built.keep);
        break;
      }
      if (built && 'instead' in built) {
        // a conta de volume fica aberta; o cashback dela entra logo em seguida, num passo próprio
        const detail = `${built.why}; ${CASHBACK_APART}`;
        record(built.refused ? { step, description, status: 'falhou', detail, error: explainError(built.why, { beforeSend: true }) } : { step, description, status: 'nada a fazer', detail });
        queue.unshift(built.instead);
        break;
      }
      if (!built || 'skip' in built) {
        record({ step, description, status: 'nada a fazer', detail: built?.skip ?? 'sem SOL para enviar' });
        break;
      }
      const budget = priorityPrice > 0n ? [computeUnitLimit(1), computeUnitPrice(1n)] : [];
      const txPayer = built.payer ?? feePayer;
      if (transactionSize(txPayer.address, [...budget, ...built.instructions]) > MAX_TX_BYTES && step.kind === 'tokens' && step.actions.length > 1) {
        const half = Math.ceil(step.actions.length / 2);
        queue.unshift({ ...step, actions: step.actions.slice(0, half) }, { ...step, actions: step.actions.slice(half) });
        break;
      }
      if (transactionSize(txPayer.address, [...budget, ...built.instructions]) > MAX_TX_BYTES && step.kind === 'claim-dbc' && step.pools.length > 1) {
        // não coube (moeda com conta maior do que o medido): metade e metade; a 2ª metade não conta de novo a ATA WSOL
        const half = Math.ceil(step.pools.length / 2);
        const part = (pools: typeof step.pools) => ({ ...step, pools, estimateLamports: pools.reduce((a, p) => a + p.quoteFee, 0n) });
        queue.unshift(part(step.pools.slice(0, half)), { ...part(step.pools.slice(half)), wsolClosedBefore: true });
        break;
      }
      let bh = await latestBlockhash();
      type SimValue = { err: unknown; logs?: string[]; unitsConsumed?: number; accounts?: Array<{ lamports: number } | null> };
      // lê + simula; se o destino ou a taxa não baterem, lê e simula de novo (SIM_CHECK_WAITS_MS) antes de parar tudo
      // (achado da revisão: RPC público pode responder de nós em slots diferentes)
      // com taxa do app, a carteira da taxa também é observada: o valor que ela recebe é conferido exato
      // passo só de varrer: o cofre também é observado, para medir a fee que ele libera. A pagadora também: o que
      // ela gasta no passo (taxa de rede, aluguel de conta que fica criada) sai do envio final dela, que a
      // simulação desse envio não vê (payerCostLamports; o recibo desconta)
      const payerOwnSweep = step.kind === 'sweep-sol' && step.wallet === feePayer.address;
      const watched = [destination, step.wallet];
      const at = (a: string | undefined) => (a === undefined ? -1 : watched.includes(a) ? watched.indexOf(a) : watched.push(a) - 1);
      const feeAt = at(appFee?.wallet);
      const pendingAt = at(built.pending?.account);
      const payerAt = payerOwnSweep ? -1 : at(feePayer.address);
      const expectedFee = built.expectedFeeDelta ?? 0n;
      const simulateAndCheck = async (instructions: Instruction[]) => {
        const tx = buildTransaction(txPayer.address, instructions, bh.blockhash, built.signers);
        let v!: SimValue;
        let destDelta = 0n;
        let walletDelta = 0n;
        let feeDelta = 0n;
        let pending = 0n;
        let payerCost = 0n;
        for (let check = 0; check < SIM_CHECK_WAITS_MS.length; check++) {
          if (SIM_CHECK_WAITS_MS[check]) await sleep(SIM_CHECK_WAITS_MS[check]);
          const before = await lamportsOf(rpc, watched);
          const [destBefore, walletBefore] = before;
          const after = (i: number) => BigInt(cleanLamports(v.accounts?.[i]?.lamports, before[i]));
          const sim = await rpc.call<{ value: SimValue }>('simulateTransaction', [
            Buffer.from(tx.bytes).toString('base64'),
            { encoding: 'base64', sigVerify: !opts.skipSignatureCheck, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watched } },
          ]);
          v = sim.value;
          if (v.err) break;
          destDelta = BigInt(cleanLamports(v.accounts?.[0]?.lamports, destBefore)) - BigInt(destBefore);
          walletDelta = BigInt(cleanLamports(v.accounts?.[1]?.lamports, walletBefore)) - BigInt(walletBefore);
          feeDelta = feeAt >= 0 ? after(feeAt) - BigInt(before[feeAt]) : 0n;
          if (built.pending) {
            // fee a coletar = o que o cofre tem acima do aluguel, depois menos antes
            const floor = built.pending.floor;
            const above = (l: bigint) => (l > floor ? l - floor : 0n);
            pending = above(after(pendingAt)) - above(BigInt(before[pendingAt]));
          }
          if (payerAt >= 0) payerCost = BigInt(before[payerAt]) - after(payerAt);
          if ((built.expectedDestinationDelta === null || destDelta === built.expectedDestinationDelta) && feeDelta === expectedFee) break;
        }
        return { tx, v, destDelta, walletDelta, feeDelta, pending, payerCost };
      };
      let priorityLamports = 0n;
      const withPriority = (limit: number) => {
        const price = budgetedPriorityPrice(priorityPrice, limit);
        priorityLamports = priorityFeeLamports(price, limit);
        return [computeUnitLimit(limit), computeUnitPrice(price), ...built.instructions];
      };
      // Limite fixo (enviar todo o SOL, juntar tudo, empréstimo): a transação já desconta a prioridade do valor e deixa a
      // carteira em 0. Simulada sem ela, sobrariam os lamports da prioridade, entre 0 e o aluguel, e a rede recusaria
      // (InsufficientFundsForRent): com a rede congestionada, o SOL da pagadora ficava nela (achado na rede que cobra de
      // verdade, test/limpeza/reserva-rede.test.ts, 02/11/2026). Por isso já simula com a prioridade.
      const first = built.fixedComputeLimit !== undefined && priorityPrice > 0n ? withPriority(built.fixedComputeLimit) : built.instructions;
      let { tx, v, destDelta, walletDelta, feeDelta, pending, payerCost } = await simulateAndCheck(first);
      if (v.err && isStaleBlockhash(v.err)) {
        // o nó que simulou está atrás do que deu o blockhash (RPC com vários nós): blockhash novo, simula de novo UMA vez
        blockhashCache = null;
        bh = await latestBlockhash();
        ({ tx, v, destDelta, walletDelta, feeDelta, pending, payerCost } = await simulateAndCheck(first));
      }
      if (!v.err && priorityPrice > 0n && built.fixedComputeLimit === undefined) {
        // taxa de prioridade: reserva só o processamento medido (+20%) e simula DE NOVO a versão final
        const limit = Math.min(1_400_000, Math.ceil((v.unitsConsumed ?? 200_000) * 1.2) + 1_000);
        ({ tx, v, destDelta, walletDelta, feeDelta, pending, payerCost } = await simulateAndCheck(withPriority(limit)));
      }
      if (v.err) {
        const why = (v.logs ?? []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-2).join(' | ') || JSON.stringify(v.err);
        if (step.kind === 'tokens' && step.actions.length > 1) {
          queue.unshift(...step.actions.map((a) => ({ ...step, actions: [a] })));
          record({ step, description, status: 'falhou', detail: `lote falhou na simulação, refazendo conta por conta (${why})`, error: explainError(why, { stepKind: step.kind, beforeSend: true }) });
        } else if (step.kind === 'claim-curve' && isFeeSharing(v.err)) {
          record({ step, description, status: 'nada a fazer', detail: FEE_SHARING_SKIP });
        } else {
          if (step.kind === 'claim-curve' || step.kind === 'claim-amm') pumpDisabled = true;
          if (step.kind === 'claim-dbc') dbcDisabled = true;
          if (step.kind === 'claim-launchlab') launchlabDisabled = true;
          record({ step, description, status: 'falhou', detail: `simulação falhou, nada enviado: ${why}${built.onRefuse ? `; ${CASHBACK_APART}` : ''}`, error: explainError(why, { stepKind: step.kind, beforeSend: true }) });
          if (built.onRefuse) queue.unshift(built.onRefuse);
        }
        break;
      }
      if (built.expectedDestinationDelta !== null && destDelta !== built.expectedDestinationDelta) {
        throw new ExecutionAborted(
          `Resultado inesperado na simulação (${description}): o destino receberia ${destDelta} lamports, o esperado era ${built.expectedDestinationDelta}. Nada foi enviado neste passo; parei tudo.`,
        );
      }
      if (feeDelta !== expectedFee) {
        throw new ExecutionAborted(
          `Resultado inesperado na simulação (${description}): a taxa do app receberia ${feeDelta} lamports, o esperado era ${expectedFee}. Nada foi enviado neste passo; parei tudo.`,
        );
      }
      // coleta na pagadora: ela perde o que perdeu na medida (taxa, aluguéis da varredura) e a prioridade; mais que
      // isso = a fee não veio e o envio ao destino sairia do saldo dela
      if (built.minWalletDelta !== undefined && walletDelta < built.minWalletDelta - priorityLamports) {
        throw new ExecutionAborted(`Resultado inesperado na simulação (${description}): a temporária perderia ${-walletDelta} lamports. Parei tudo.`);
      }
      if (mode === 'simulate') {
        record({ step, description, status: 'simulado', destinationDelta: destDelta, appFeeDelta: feeDelta, ...(built.pending ? { pendingClaimLamports: pending } : {}), ...(built.closedRent ? { closedRentLamports: built.closedRent } : {}), ...(built.skippedClaim ? { skippedClaim: true, detail: built.skippedClaim } : {}), ...(payerAt >= 0 && txPayer === feePayer && step.kind !== 'fund' && step.kind !== 'gather' ? { payerCostLamports: payerCost > 0n ? payerCost : 0n } : {}) });
        break;
      }
      onSent(tx.signature);
      const outcome = await send(tx.bytes, tx.signature, bh.lastValidBlockHeight);
      if (outcome === 'confirmado') {
        record({ step, description, status: 'enviado', signature: tx.signature, destinationDelta: destDelta, appFeeDelta: feeDelta, ...(built.pending ? { pendingClaimLamports: pending } : {}), ...(built.closedRent ? { closedRentLamports: built.closedRent } : {}), ...(built.skippedClaim ? { skippedClaim: true, detail: built.skippedClaim } : {}) });
        break;
      }
      if (outcome === 'expirou' && attempt === 0) {
        previous = tx.signature;
        previousDeltas = { destinationDelta: destDelta, appFeeDelta: feeDelta };
        blockhashCache = null; // o guardado venceu junto
        continue; // a rede confirmou que venceu: tenta de novo com blockhash novo (simula de novo antes)
      }
      if (step.kind === 'claim-curve' || step.kind === 'claim-amm') pumpDisabled = true;
      if (step.kind === 'claim-dbc') dbcDisabled = true;
      if (step.kind === 'claim-launchlab') launchlabDisabled = true;
      if (outcome === 'desconhecido') {
        record({ step, description, status: 'desconhecido', signature: tx.signature, detail: 'sem confirmação da rede a tempo; confira pelo link se caiu (não reenvio para não duplicar)', error: { code: 'send-unknown', params: {}, technical: 'sem confirmação da rede a tempo', beforeSend: false } });
      } else {
        // a rede recusou a transação inteira (nada mudou): o cashback da conta que não fechou ainda vai à parte
        record({ step, description, status: 'falhou', signature: tx.signature, detail: built.onRefuse ? `${outcome}; ${CASHBACK_APART}` : outcome, error: explainError(outcome, { stepKind: step.kind, beforeSend: false }) });
        if (built.onRefuse) queue.unshift(built.onRefuse);
      }
      break;
    }
  }
}

export function explorerLink(signature: string, cluster: 'mainnet' | 'devnet'): string {
  return `https://solscan.io/tx/${signature}${cluster === 'devnet' ? '?cluster=devnet' : ''}`;
}
