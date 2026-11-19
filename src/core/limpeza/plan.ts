// Plano de limpeza: decide O QUE fazer em cada temporária, a partir da varredura e das escolhas do usuário.
// Só dados; quem monta e envia as transações é o executor.

import { appFeeFor, type AppFee } from './app-fee.ts';
import { CodedError, type ErrorCode, type ErrorParams } from './errors.ts';
import { BASE_FEE_LAMPORTS, type ValuedToken } from './summary.ts';
import { curveClaimLamports, poolClaimLamports, type CurveSweep, type PoolSweep, type SharedFee, type TokenAccount, type WalletScan } from './scan.ts';
import { tokenValue, type Price } from './prices.ts';
import type { DbcPool } from './dbc.ts';
import { associatedTokenAddress, PROGRAMS, WSOL_MINT } from '../solana/pda.ts';
import { FEATURES } from '../features.ts';

// Aluguel de uma conta de `bytes`, derivado do aluguel de uma conta vazia lido da rede (o preço por byte muda:
// em 30/10/2026 a mainnet cobrava 650.240 por 0 bytes e 1.488.440 por 165, abaixo dos 2.039.280 de antes).
export function rentFor(bytes: number, rentExemptZero: number): bigint {
  return (BigInt(rentExemptZero) * BigInt(128 + bytes)) / 128n;
}
export const TOKEN_ACCOUNT_BYTES = 165;
// Token-2022: a conta do destino nasce com as extensões que o mint exige (ImmutableOwner, TransferFeeAmount,
// ConfidentialTransferFeeAmount, TransferHookAccount, NonTransferableAccount, PausableAccount): até 263 bytes
// pela especificação. 400 dá folga para extensão nova; reserva a mais volta ao destino no fim.
export const TOKEN_2022_ACCOUNT_MAX_BYTES = 400;
export const MAX_ACCOUNTS_PER_TX = 15;
// coleta de fee abaixo disso custa mais em taxa do que rende (2 assinaturas + margem)
export const MIN_CLAIM_LAMPORTS = 20_000;

// Decisão do usuário para cada conta de token com saldo. Sem decisão = manter.
export type TokenDecision = 'keep' | 'transfer' | 'burn';

export type TokenAction = {
  action: 'close' | 'burn-close' | 'transfer-close';
  account: string;
  mint: string;
  program: string;
  amount: bigint;
  decimals: number;
  rentLamports: number;
};

// Fee parada varrida por transação, junto com a coleta. Medido no teste: com 3 varreduras, taxa do app e
// taxa de prioridade, a coleta da curva cabe no limite de 1232 bytes (test/limpeza/plan-exec.test.ts).
export const SWEEPS_PER_TX = 3;
// Quanto a curva ou o pool podem crescer na 1ª varredura (layout antigo ganha os campos novos no fim; o
// `payer` paga a diferença de aluguel). Pelo IDL 639b87fb a curva tem 166 bytes e o pool 287; uma curva com
// só os campos até o `creator` (81) cresce 85. 100 dá folga.
export const FEE_ACCOUNT_GROWTH_BYTES = 100;
// Pools da Meteora DBC por transação de coleta. Cada pool põe 5 contas (pool, cofres, mint, conta da moeda) e até 3
// instruções; medido no teste, a pior transação (Token-2022, conta da moeda criada em todos, pagadora ≠ temporária,
// taxa do app, prioridade) cabe em 1232 bytes com 2 e não com 3 (test/limpeza/dbc.test.ts). O executor ainda divide o
// passo ao meio se não couber.
export const DBC_POOLS_PER_TX = 2;

export type Step =
  // sweeps: fee parada que entra no cofre antes da coleta, na mesma transação.
  // sweepOnly: só varre (mais de SWEEPS_PER_TX moedas); a coleta vem no último passo da curva desta carteira.
  | { kind: 'claim-curve'; walletIndex: number; wallet: string; estimateLamports: bigint; sweeps?: CurveSweep[]; sweepOnly?: boolean }
  // cashback: coleta também o cashback do PumpSwap da carteira na mesma transação (mesma ATA WSOL)
  | { kind: 'claim-amm'; walletIndex: number; wallet: string; estimateLamports: bigint; sweeps?: PoolSweep[]; sweepOnly?: boolean; cashback?: boolean }
  // fee dividida (fee sharing): varre, leva a fee do PumpSwap para a curva e distribui a todos os participantes; a
  // parte desta carteira vai ao destino na mesma transação. Uma moeda por passo.
  | { kind: 'claim-shared'; walletIndex: number; wallet: string; estimateLamports: bigint; shared: SharedFee }
  // cashback de quem negociou: na Pump.fun (SOL) ou no PumpSwap (WSOL, recebido na ATA WSOL da temporária, que o
  // passo fecha); vai ao destino na mesma transação
  | { kind: 'claim-cashback'; walletIndex: number; wallet: string; estimateLamports: bigint; venue: 'pump' | 'amm' }
  // fecha a conta de volume (cashback/incentivo) da Pump.fun ou do PumpSwap que não guarda mais nada; na Pump.fun
  // coleta antes o cashback em SOL dela, na mesma transação. Tudo vai ao destino (89/11). Depois das coletas.
  // cashbackLamports (Pump.fun): o cashback em SOL lido na análise, que o passo coleta antes de fechar; se o fechamento
  // não entrar na hora, o executor coleta só o cashback num passo próprio (claim-cashback) e esta é a estimativa dele
  | { kind: 'close-uva'; walletIndex: number; wallet: string; venue: 'pump' | 'amm'; estimateLamports: bigint; cashbackLamports?: bigint }
  // creator fee da Meteora DBC (src/core/limpeza/dbc.ts): coleta a fee em SOL de até DBC_POOLS_PER_TX pools em que esta
  // carteira é o creator. Recebe em WSOL na ATA WSOL da temporária, que o passo cria se faltar e fecha; vai ao destino na
  // mesma transação (89/11). wsolClosedBefore: um passo anterior desta carteira já fecha a ATA WSOL (coleta do PumpSwap,
  // cashback do PumpSwap, outro lote da Meteora): o que a ATA já tinha não é contado de novo aqui
  | { kind: 'claim-dbc'; walletIndex: number; wallet: string; estimateLamports: bigint; pools: DbcPool[]; wsolClosedBefore?: boolean }
  // creator fee do Raydium LaunchLab (src/core/limpeza/launchlab.ts): coleta todo o cofre [creator, WSOL] desta carteira.
  // Recebe na ATA WSOL da temporária (o programa exige a ATA), que o passo cria se faltar e fecha; vai ao destino na mesma
  // transação (89/11). wsolClosedBefore: como na Meteora
  | { kind: 'claim-launchlab'; walletIndex: number; wallet: string; estimateLamports: bigint; wsolClosedBefore?: boolean }
  | { kind: 'tokens'; walletIndex: number; wallet: string; actions: TokenAction[] }
  | { kind: 'sweep-sol'; walletIndex: number; wallet: string; isFeePayer: boolean }
  // empréstimo das taxas: a pagadora desta frase manda `lamports` para a temporária `to` da frase `toFrase`
  // (src/core/limpeza/funding.ts); nunca aparece num plano de limpeza, só no plano de um passo do financiamento
  | { kind: 'fund'; walletIndex: number; wallet: string; to: string; toFrase: number; lamports: bigint }
  // juntar o SOL da própria frase: esta temporária manda `lamports` para a pagadora `to` da MESMA frase e paga a
  // própria taxa (src/core/limpeza/gather.ts); nunca aparece num plano de limpeza, só no plano de juntar
  // all: manda tudo (fica com 0); lamports é a estimativa e o valor exato sai na hora do envio
  | { kind: 'gather'; walletIndex: number; wallet: string; to: string; lamports: bigint; all?: boolean };

export type KeptToken = ValuedToken & { reason: string };

export type Plan = {
  destination: string;
  feePayerIndex: number;
  feePayer: string;
  payerOutsideSelection: boolean; // pagadora fora do --somente: não é esvaziada nesta execução
  steps: Step[];
  kept: KeptToken[]; // tokens e NFTs que ficam onde estão
  skipped: Array<{ walletIndex: number; reason: string }>;
  reserveNeededLamports: bigint; // o que o pagador precisa ter para as taxas e contas temporárias
  appFee?: AppFee | null; // taxa do app (11%); null = sem taxa (destino = carteira da taxa)
  // SOL da pagadora isento da taxa: só o que o cliente DEPOSITOU para as taxas depois da análise. Todo o resto
  // (SOL esquecido, juntado de outras temporárias, emprestado por outra frase, fee coletada nela) paga 11% uma vez,
  // no envio final dela. Sem a informação (terminal, roteiros), 0: tudo paga.
  payerExemptLamports?: bigint;
};

export class PlanError extends CodedError {
  constructor(message: string, code: ErrorCode = 'unknown', params?: ErrorParams) {
    super(message, code, params);
    this.name = 'PlanError';
  }
}

export const MIN_FUNDING_LAMPORTS = 10_000_000n; // 0,01 SOL: era o pedido mínimo até 02/11/2026 (hoje só o juntar e o empréstimo de testes)
export const FUNDING_MARGIN_PERCENT = 120n; // o pedido é a reserva + 20% (era o dobro até 02/11/2026)
// Taxa de prioridade por transação que a reserva paga. O executor nunca passa disso (baixa o preço por unidade
// numa transação grande): a reserva é exata nas taxas, e a rede congestionada não faz faltar SOL no meio.
export const PRIORITY_BUDGET_LAMPORTS = BigInt(BASE_FEE_LAMPORTS);
// O pedido sai em 0,000001 SOL inteiros, arredondado para cima: a tela mostra 6 casas e a pessoa manda exatamente o
// que vê. Com o valor quebrado (816 288 lamports aparecendo como 0,000816), chegariam 288 a menos e a espera do
// depósito nunca terminaria (02/11/2026).
export const roundUpToMicroSol = (l: bigint) => ((l + 999n) / 1_000n) * 1_000n;

// Nenhuma temporária tem SOL para as taxas. Diz quanto mandar e para qual: a que já tem mais SOL (vira a pagadora),
// ou, com todas em 0, a com mais trabalho.
// sendLamports = o que se pede à pessoa (o que FALTA até a reserva + folga, descontado o que ela já tem);
// reserveLamports = o mínimo que resolve (o que falta até a reserva exata); haveLamports = o saldo dela na conta
// (quem precisa do alvo como saldo, o juntar, soma os dois).
export class FeePayerError extends PlanError {
  readonly sendLamports: bigint;
  readonly reserveLamports: bigint;
  readonly haveLamports: bigint;
  readonly walletIndex: number;
  readonly wallet: string;
  // walletName/appName: Solflare "temporária N=3"/"Solflare"; Phantom "Conta 4"/"Phantom" (modo Phantom)
  constructor(sendLamports: bigint, walletIndex: number, wallet: string, walletName = `temporária N=${walletIndex}`, appName = 'Solflare', reserveLamports: bigint = sendLamports, haveLamports = 0n) {
    super(
      `Nenhuma burner tem SOL para pagar as taxas de rede. Mande ${Number(sendLamports) / 1e9} SOL da sua carteira (${appName}) para a ${walletName}: ${wallet} . ` +
        'Esse valor volta para o destino no final da limpeza.',
      'no-fee-sol',
      { walletIndex, wallet, sendSol: Number(sendLamports) / 1e9, walletName, appName },
    );
    this.sendLamports = sendLamports;
    this.reserveLamports = reserveLamports > 0n && reserveLamports <= sendLamports ? reserveLamports : sendLamports;
    this.haveLamports = haveLamports > 0n ? haveLamports : 0n;
    this.walletIndex = walletIndex;
    this.wallet = wallet;
  }
}

const PROGRAM_IDS = { token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'token-2022': 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } as const;

function decideToken(t: TokenAccount, decision: TokenDecision | undefined): { action: TokenAction['action'] | null; reason: string } {
  if (t.kind === 'empty' || t.kind === 'wsol') return { action: 'close', reason: '' };
  if (t.kind !== 'fungible' && t.kind !== 'nft') return { action: null, reason: 'dados fora do formato' };
  if (decision === 'transfer') return { action: 'transfer-close', reason: '' };
  if (decision === 'burn' && t.kind === 'fungible') return { action: 'burn-close', reason: '' };
  if (t.kind === 'nft') return { action: null, reason: 'NFT: fica na carteira (nunca é queimado)' };
  return { action: null, reason: 'você escolheu manter' };
}

// Coleta de uma carteira: as varreduras que não cabem na transação da coleta vão antes, em passos só de varrer
// (SWEEPS_PER_TX cada); a coleta leva as últimas. A estimativa de cada passo é o que ele mesmo traz.
function claimSteps<K extends 'claim-curve' | 'claim-amm', T extends CurveSweep | PoolSweep>(kind: K, s: WalletScan, vault: number, sweeps: T[]): Step[] {
  const sum = (list: T[]) => list.reduce((a, x) => a + x.lamports, 0n);
  const split = Math.max(0, sweeps.length - SWEEPS_PER_TX);
  const out: Step[] = [];
  for (let i = 0; i < split; i += SWEEPS_PER_TX) {
    const chunk = sweeps.slice(i, Math.min(i + SWEEPS_PER_TX, split));
    out.push({ kind, walletIndex: s.index, wallet: s.address, estimateLamports: sum(chunk), sweeps: chunk, sweepOnly: true } as Step);
  }
  const last = sweeps.slice(split);
  out.push({ kind, walletIndex: s.index, wallet: s.address, estimateLamports: BigInt(vault) + sum(last), ...(last.length ? { sweeps: last } : {}) } as Step);
  return out;
}

export type PlanInput = {
  scans: WalletScan[];
  prices: Map<string, Price>;
  destination: string;
  decisions?: Map<string, TokenDecision>; // chave: endereço da conta de token
  rentExemptZero: number;
  only?: Set<number>; // limitar a algumas temporárias (teste com uma de pouco valor)
  walletName?: (index: number) => string; // como a carteira aparece nas mensagens (Phantom: "Conta 4")
  appName?: string;
  // por temporária: SOL que o cliente depositou para as taxas depois da análise (isento da taxa do app)
  deposits?: Map<number, bigint>;
};

export function buildPlan(input: PlanInput): Plan {
  const { scans, prices, destination, rentExemptZero } = input;
  const decisions = input.decisions ?? new Map<string, TokenDecision>();
  const kept: KeptToken[] = [];
  const skipped: Plan['skipped'] = [];

  if (scans.some((s) => s.address === destination)) throw new PlanError('O destino é uma das burners. Escolha outra carteira.');

  const selected = scans.filter((s) => !input.only || input.only.has(s.index));
  const perWallet: Array<{ scan: WalletScan; steps: Step[] }> = [];
  // pior caso de transações: o lote de contas que falha na simulação é refeito conta por conta (executor),
  // então cada conta pode virar uma transação paga (a simulação que falhou não paga nada)
  let worstTxCount = 0n;
  // A reserva é o pico do que a pagadora gasta, não a soma de tudo o que passa por ela (pedido do autor, 02/11/2026:
  // 0,13 a 0,39 SOL pedidos por frase). Dois tipos de aluguel:
  // - spentRent: sai dela de vez (ATA do destino, cofre e crescimento de conta ao varrer). Soma, mas a mesma conta só
  //   nasce uma vez: a ATA do destino por moeda, o cofre da divisão por sharing config.
  // - maxLoan: ela empresta e recebe de volta NA MESMA transação (coleta, cashback, fee dividida). Cada transação
  //   devolve antes da próxima: basta o maior.
  let spentRent = 0n;
  let maxLoan = 0n;
  const loan = (l: bigint) => {
    if (l > maxLoan) maxLoan = l;
  };
  const destAtas = new Set<string>();
  const sharedConfigs = new Set<string>();
  const tokenRent = rentFor(TOKEN_ACCOUNT_BYTES, rentExemptZero);
  const token2022Rent = rentFor(TOKEN_2022_ACCOUNT_MAX_BYTES, rentExemptZero);

  for (const s of selected) {
    if (s.errors.length) {
      // leitura incompleta: não agir às cegas nesta carteira
      skipped.push({ walletIndex: s.index, reason: `leitura incompleta (${s.errors.join(' | ')})` });
      continue;
    }
    const steps: Step[] = [];
    const growth = rentFor(FEE_ACCOUNT_GROWTH_BYTES, rentExemptZero) - BigInt(rentExemptZero);
    const curveSweeps = s.fees?.curveSweeps ?? [];
    const poolSweeps = s.fees?.poolSweeps ?? [];
    if (s.fees && curveClaimLamports(s.fees) > BigInt(MIN_CLAIM_LAMPORTS)) {
      steps.push(...claimSteps('claim-curve', s, s.fees.bondingVaultLamports, curveSweeps));
      // varrer pode criar o cofre da curva (aluguel de conta vazia) e crescer cada curva de layout antigo
      if (curveSweeps.length) spentRent += BigInt(rentExemptZero) + growth * BigInt(curveSweeps.length);
      loan(BigInt(rentExemptZero)); // a temporária vazia recebe o aluguel antes da coleta e devolve
    }
    // a coleta do PumpSwap recebe na ATA WSOL da temporária e a fecha na mesma transação (o aluguel dela vai junto)
    let closedByClaim: string | null = null;
    if (s.fees && poolClaimLamports(s.fees) > BigInt(MIN_CLAIM_LAMPORTS)) {
      steps.push(...claimSteps('claim-amm', s, s.fees.ammVaultLamports, poolSweeps));
      closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);
      loan(tokenRent); // WSOL é do programa Token: 165 bytes; a temporária devolve o aluguel ao fechar a ATA
      // varrer o pool pode criar a ATA WSOL do cofre e crescer cada pool de layout antigo
      if (poolSweeps.length) spentRent += tokenRent + growth * BigInt(poolSweeps.length);
    }

    // fee dividida: um passo por moeda em que a parte desta carteira paga a coleta
    for (const sf of s.fees?.shared ?? []) {
      if (sf.shareLamports <= BigInt(MIN_CLAIM_LAMPORTS)) continue;
      steps.push({ kind: 'claim-shared', walletIndex: s.index, wallet: s.address, estimateLamports: sf.shareLamports, shared: sf });
      // a pagadora empresta o aluguel à temporária (volta na mesma transação); varrer pode criar o cofre do sharing
      // config e a ATA WSOL do cofre do PumpSwap, e crescer a curva e o pool de layout antigo: uma vez por divisão
      // (a 1ª coleta distribui a todos; as outras temporárias da mesma divisão não criam nada)
      loan(BigInt(rentExemptZero));
      if (!sharedConfigs.has(sf.config)) {
        sharedConfigs.add(sf.config);
        spentRent += BigInt(rentExemptZero) + tokenRent + growth * 2n;
      }
    }

    // contas de volume que não guardam mais nada: fecham depois das coletas da carteira (spec §4.4)
    // desligado na 1.0 (src/core/features.ts): o cashback vai pelo claim-cashback, como na 0.2.4, e a conta fica aberta
    const closableUva = FEATURES.closeVolumeAccounts ? (s.fees?.uva ?? []).filter((u) => u.closable) : [];
    // cashback: um passo por programa, se pagar a coleta
    for (const venue of ['pump', 'amm'] as const) {
      const amount = s.fees?.cashback?.[venue] ?? 0n;
      // a conta de volume da Pump.fun que fecha leva o cashback dela no mesmo passo (coleta + fecha). Dois passos
      // contariam o cashback duas vezes na simulação, que roda cada passo sobre a rede de agora; e o cashback pequeno
      // demais para pagar uma coleta sozinho vai junto com o aluguel
      if (venue === 'pump' && closableUva.some((u) => u.program === 'pump')) continue;
      if (amount <= BigInt(MIN_CLAIM_LAMPORTS)) continue;
      // cashback do PumpSwap com coleta do PumpSwap na mesma carteira: vai junto nela (mesma ATA WSOL; dois passos
      // separados contariam o aluguel dela duas vezes na simulação, que roda passo a passo)
      const amm = venue === 'amm' ? (steps.find((st) => st.kind === 'claim-amm' && !st.sweepOnly) as Extract<Step, { kind: 'claim-amm' }> | undefined) : undefined;
      if (amm) {
        amm.cashback = true;
        amm.estimateLamports += amount;
        continue;
      }
      steps.push({ kind: 'claim-cashback', walletIndex: s.index, wallet: s.address, estimateLamports: amount, venue });
      loan(venue === 'pump' ? BigInt(rentExemptZero) : tokenRent); // empréstimo do aluguel / ATA WSOL (voltam)
      if (venue === 'amm') closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);
    }
    // Meteora DBC: lotes de DBC_POOLS_PER_TX pools, se a soma pagar a coleta
    const dbcPools = (s.fees?.dbc?.pools ?? []).filter((p) => p.quoteFee > 0n);
    if (dbcPools.reduce((a, p) => a + p.quoteFee, 0n) > BigInt(MIN_CLAIM_LAMPORTS)) {
      for (let i = 0; i < dbcPools.length; i += DBC_POOLS_PER_TX) {
        const pools = dbcPools.slice(i, i + DBC_POOLS_PER_TX);
        steps.push({ kind: 'claim-dbc', walletIndex: s.index, wallet: s.address, estimateLamports: pools.reduce((a, p) => a + p.quoteFee, 0n), pools, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });
        closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);
        // a pagadora paga a ATA WSOL e a conta da moeda de cada pool (as que faltam) e recebe de volta na mesma transação
        loan(tokenRent + pools.reduce((a, p) => a + (p.baseTokenProgram === PROGRAMS.token2022 ? token2022Rent : tokenRent), 0n));
      }
    }
    // Raydium LaunchLab: um passo por carteira (um cofre em WSOL), se pagar a coleta
    const launchlab = s.fees?.launchlab?.lamports ?? 0n;
    if (launchlab > BigInt(MIN_CLAIM_LAMPORTS)) {
      steps.push({ kind: 'claim-launchlab', walletIndex: s.index, wallet: s.address, estimateLamports: launchlab, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });
      closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);
      loan(tokenRent); // a pagadora paga a ATA WSOL (se faltar) e recebe de volta na mesma transação
    }
    for (const u of closableUva) {
      const cashbackLamports = u.program === 'pump' ? (s.fees?.cashback?.pump ?? 0n) : 0n;
      steps.push({ kind: 'close-uva', walletIndex: s.index, wallet: s.address, venue: u.program, estimateLamports: u.lamports, ...(cashbackLamports > 0n ? { cashbackLamports } : {}) });
      // a temporária vazia recebe o aluguel emprestado antes (como no cashback) e devolve na mesma transação; a
      // transação a mais entra no pior caso abaixo (todo passo que não é de contas de token conta 1)
      loan(BigInt(rentExemptZero));
    }

    const actions: TokenAction[] = [];
    for (const t of s.tokens) {
      if (t.account === closedByClaim) continue; // fechar de novo falharia: a conta já não existe
      const value = tokenValue(prices, t);
      if (t.blockers.length || t.kind === 'invalid') {
        kept.push({ ...t, wallet: s.address, walletIndex: s.index, ...value, reason: t.blockers.join('; ') || 'dados fora do formato' });
        continue;
      }
      const d = decideToken(t, decisions.get(t.account));
      if (!d.action) {
        kept.push({ ...t, wallet: s.address, walletIndex: s.index, ...value, reason: d.reason });
        continue;
      }
      // a ATA do destino nasce uma vez por moeda ("idempotent": a 2ª temporária com a mesma moeda não paga de novo)
      if (d.action === 'transfer-close' && !destAtas.has(`${t.program}:${t.mint}`)) {
        destAtas.add(`${t.program}:${t.mint}`);
        spentRent += t.program === 'token-2022' ? token2022Rent : tokenRent;
      }
      actions.push({ action: d.action, account: t.account, mint: t.mint, program: PROGRAM_IDS[t.program], amount: t.amount, decimals: t.decimals, rentLamports: t.rentLamports });
    }
    for (let i = 0; i < actions.length; i += MAX_ACCOUNTS_PER_TX) {
      steps.push({ kind: 'tokens', walletIndex: s.index, wallet: s.address, actions: actions.slice(i, i + MAX_ACCOUNTS_PER_TX) });
    }
    if (!steps.length && s.lamports === 0) continue; // nada a fazer nesta carteira
    perWallet.push({ scan: s, steps });
    const claims = steps.filter((st) => st.kind !== 'tokens').length;
    worstTxCount += BigInt(claims + actions.length + 1); // + envio do SOL
  }

  if (!perWallet.length) throw new PlanError('Nenhuma burner para limpar.');

  // por transação: até 2 assinaturas (2× taxa base) + a taxa de prioridade que o executor respeita; a pagadora nunca
  // fica abaixo do aluguel mínimo (rentExemptZero)
  const perTx = BigInt(BASE_FEE_LAMPORTS) * 2n + PRIORITY_BUDGET_LAMPORTS;
  const reserveNeeded = worstTxCount * perTx + spentRent + maxLoan + BigInt(rentExemptZero);
  // pagador: a temporária com mais SOL entre TODAS as varridas (pode estar fora do --somente)
  const payer = [...scans].filter((s) => !s.errors.length).sort((a, b) => b.lamports - a.lamports)[0];
  if (!payer || BigInt(payer.lamports) < reserveNeeded) {
    // A que já tem SOL é a pagadora depois do depósito: pede só o que falta nela (pedido do autor, 02/11/2026: um
    // depósito anterior, ou "manter" virando "enviar" na Confirmar, não pede tudo de novo). Todas em 0 (1º teste na
    // mainnet): a com mais trabalho.
    const suggestion = payer && payer.lamports > 0 ? payer : [...perWallet].sort((a, b) => b.steps.length - a.steps.length)[0].scan;
    const have = BigInt(suggestion.lamports);
    // a reserva já é o pior caso (cada lote refeito conta a conta, conta Token-2022 do maior tamanho, prioridade no
    // teto): a folga só cobre a pessoa trocar "manter" por "enviar" na Confirmar sem pedir outro depósito
    const target = (reserveNeeded * FUNDING_MARGIN_PERCENT) / 100n;
    throw new FeePayerError(roundUpToMicroSol(target - have),suggestion.index, suggestion.address, input.walletName?.(suggestion.index), input.appName, reserveNeeded - have, have);
  }

  // o pagador é limpo por último, para continuar pagando as taxas das outras
  const ordered = [...perWallet.filter((p) => p.scan.index !== payer.index), ...perWallet.filter((p) => p.scan.index === payer.index)];
  const steps: Step[] = [];
  for (const { scan, steps: ws } of ordered) {
    steps.push(...ws);
    steps.push({ kind: 'sweep-sol', walletIndex: scan.index, wallet: scan.address, isFeePayer: scan.index === payer.index });
  }

  return {
    destination,
    feePayerIndex: payer.index,
    feePayer: payer.address,
    payerOutsideSelection: !perWallet.some((p) => p.scan.index === payer.index),
    steps,
    kept,
    skipped,
    reserveNeededLamports: reserveNeeded,
    appFee: appFeeFor(destination),
    payerExemptLamports: (() => {
      const d = input.deposits?.get(payer.index) ?? 0n;
      const have = BigInt(payer.lamports);
      return d <= 0n ? 0n : d > have ? have : d;
    })(),
  };
}

// label: como a carteira aparece para o usuário (Solflare: "N=3"; Phantom: "Conta 4")
export function describeStep(s: Step, label: (index: number) => string = (i) => `N=${i}`): string {
  switch (s.kind) {
    case 'claim-curve':
      if (s.sweepOnly) return `${label(s.walletIndex)}: liberar creator fees paradas em ${s.sweeps?.length} moedas da Pump.fun (~${Number(s.estimateLamports) / 1e9} SOL; a coleta vem no passo seguinte)`;
      return `${label(s.walletIndex)}: coletar creator fees da curva Pump.fun (~${Number(s.estimateLamports) / 1e9} SOL) e enviar ao destino`;
    case 'claim-cashback':
      return `${label(s.walletIndex)}: coletar o cashback de negociação ${s.venue === 'pump' ? 'da Pump.fun' : 'do PumpSwap'} (~${Number(s.estimateLamports) / 1e9} SOL) e enviar ao destino`;
    case 'close-uva':
      return `${label(s.walletIndex)}: fechar a conta de cashback ${s.venue === 'pump' ? 'da Pump.fun' : 'do PumpSwap'} e recuperar o aluguel (~${Number(s.estimateLamports) / 1e9} SOL) para o destino`;
    case 'claim-shared':
      return `${label(s.walletIndex)}: coletar a parte desta carteira (${s.shared.bps / 100}%) da creator fee dividida da moeda ${s.shared.mint.slice(0, 4)}…${s.shared.mint.slice(-4)} (~${Number(s.estimateLamports) / 1e9} SOL) e enviar ao destino`;
    case 'claim-dbc':
      return `${label(s.walletIndex)}: coletar creator fees da Meteora em ${s.pools.length} ${s.pools.length === 1 ? 'pool' : 'pools'} (~${Number(s.estimateLamports) / 1e9} SOL) e enviar ao destino`;
    case 'claim-launchlab':
      return `${label(s.walletIndex)}: coletar creator fees do LaunchLab (bonk.fun e outros) (~${Number(s.estimateLamports) / 1e9} SOL) e enviar ao destino`;
    case 'claim-amm':
      if (s.sweepOnly) return `${label(s.walletIndex)}: liberar creator fees paradas em ${s.sweeps?.length} pools do PumpSwap (~${Number(s.estimateLamports) / 1e9} SOL; a coleta vem no passo seguinte)`;
      return `${label(s.walletIndex)}: coletar creator fees do PumpSwap (~${Number(s.estimateLamports) / 1e9} SOL)`;
    case 'tokens': {
      const c = (a: TokenAction['action']) => s.actions.filter((x) => x.action === a).length;
      const parts = [c('close') && `fechar ${c('close')}`, c('burn-close') && `queimar e fechar ${c('burn-close')}`, c('transfer-close') && `transferir e fechar ${c('transfer-close')}`].filter(Boolean);
      return `${label(s.walletIndex)}: contas de token: ${parts.join(', ')}`;
    }
    case 'sweep-sol':
      return `${label(s.walletIndex)}: enviar todo o SOL para o destino${s.isFeePayer ? ' (pagador das taxas, por último)' : ''}`;
    case 'fund':
      return `${label(s.walletIndex)}: emprestar ${Number(s.lamports) / 1e9} SOL para as taxas da frase ${s.toFrase} (volta ao destino no fim)`;
    case 'gather':
      if (s.all) return `${label(s.walletIndex)}: juntar todo o SOL (~${Number(s.lamports) / 1e9} SOL) na pagadora desta frase para as taxas (volta ao destino no fim)`;
      return `${label(s.walletIndex)}: juntar ${Number(s.lamports) / 1e9} SOL na pagadora desta frase para as taxas (volta ao destino no fim)`;
  }
}
