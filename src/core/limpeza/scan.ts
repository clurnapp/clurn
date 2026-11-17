// Varredura SÓ LEITURA das carteiras temporárias. Nada aqui assina ou envia transação.

import { decodeBase58, encodeBase58, isAddress } from '../solana/base58.ts';
import { deriveBurner, type DerivedWallet, type WalletApp } from '../carteiras/derivation.ts';
import {
  PROGRAMS,
  WSOL_MINT,
  anchorAccountDiscriminator,
  findProgramAddress,
  pumpAmmCreatorVaultAta,
  pumpCreatorVault,
  sharingConfigAddress,
  associatedTokenAddress,
  userVolumeAccumulator,
  pumpAmmCreatorVaultAuthority,
} from '../solana/pda.ts';
import type { RpcClient } from '../solana/rpc.ts';
import { curveAddress, poolAddress } from './curve-price.ts';
import { dbcClaimLamports, dbcFees, type DbcFees } from './dbc.ts';
import { launchlabClaimLamports, launchlabFees, type LaunchlabFees } from './launchlab.ts';
import { FEATURES } from '../features.ts';

// ---------- descoberta ----------

export type DiscoveredWallet = DerivedWallet & { hasHistory: boolean };

export type Discovery = {
  wallets: DiscoveredWallet[]; // de N=0 até a última com histórico
  checked: number;
  reachedMax: boolean; // parou no limite sem achar a folga: pode haver mais
};

// Busca automática (pedido do autor, 30/10): para sozinha depois de SEARCH_GAP endereços vazios seguidos;
// o teto só existe contra laço infinito. Teto alto não gasta crédito: cada endereço conferido custa 1 consulta
// e a busca para na folga. Folga 20 é mais segura que a do Solflare (para no 1º grupo de 10 vazios).
export const SEARCH_MAX = 2000;
export const SEARCH_GAP = 20;

export type DiscoveryOptions = {
  app?: WalletApp;
  max?: number;
  gap?: number;
  batch?: number;
  onProgress?: (checked: number, found: number) => void;
  sleep?: (ms: number) => Promise<void>; // testes: sem esperar de verdade
};

// Resposta que não é lista NÃO é "sem histórico": seria uma carteira usada contada como vazia, e a busca pararia
// antes da hora (deixando as temporárias seguintes para trás). Vira erro, e o lote é conferido de novo.
export async function hasHistory(rpc: RpcClient, address: string): Promise<boolean> {
  const sigs = await rpc.call<unknown[]>('getSignaturesForAddress', [address, { limit: 1 }]);
  if (!Array.isArray(sigs)) throw new Error('getSignaturesForAddress: resposta fora do formato');
  return sigs.length > 0;
}

// ---------- exatidão: "não sei" nunca vira "vazio" ----------

// Esperas entre as novas leituras do que falhou (pedido do autor, 31/10/2026: "por mais tempo que demore, tudo tem
// que ser analisado, nada passa"). O cliente RPC já repete cada chamada; estas rodadas cobrem o que sobra (nó que
// devolve dado fora do formato, erro que passa depois de alguns segundos). ~67 s no pior caso.
export const REREAD_WAITS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// "Parar" da pessoa (StopRequested, src/app/pausable-rpc.ts) encerra na hora, sem novas tentativas
const isStop = (e: unknown) => (e as { code?: unknown } | null)?.code === 'stopped-by-user';

// repete fn até dar certo, esperando REREAD_WAITS_MS entre as tentativas; depois disso, lança o último erro
export async function untilRead<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= REREAD_WAITS_MS.length || isStop(e)) throw e;
      await sleep(REREAD_WAITS_MS[i]);
    }
  }
}

// Varre N = 0, 1, 2... e para depois de `gap` endereços seguidos sem histórico.
// Recebe a seed só para derivar endereços; não guarda referência a ela.
export async function discoverBurners(seed: Uint8Array, rpc: RpcClient, opts: DiscoveryOptions = {}): Promise<Discovery> {
  const { max = SEARCH_MAX, gap = SEARCH_GAP, batch = 10 } = opts;
  const found: DiscoveredWallet[] = [];
  let lastUsed = -1;
  let n = 0;
  while (n < max && n - lastUsed <= gap) {
    const size = Math.min(batch, max - n);
    const derived = Array.from({ length: size }, (_, k) => deriveBurner(seed, n + k, opts.app ?? 'solflare'));
    // o lote inteiro é conferido de novo se um endereço falhar: nenhum endereço fica sem resposta
    const flags = await untilRead(() => Promise.all(derived.map((w) => hasHistory(rpc, w.address))), opts.sleep);
    derived.forEach((w, k) => {
      found.push({ ...w, hasHistory: flags[k] });
      if (flags[k]) lastUsed = w.index;
    });
    n += size;
    opts.onProgress?.(n, lastUsed + 1);
  }
  return {
    wallets: found.slice(0, lastUsed + 1),
    checked: n,
    reachedMax: n >= max && n - lastUsed <= gap,
  };
}

// ---------- contas de token ----------

export type TokenKind = 'empty' | 'nft' | 'fungible' | 'wsol' | 'invalid';

export type TokenAccount = {
  account: string;
  mint: string;
  program: 'token' | 'token-2022';
  amount: bigint;
  decimals: number;
  rentLamports: number;
  kind: TokenKind;
  // motivos que impedem fechar/queimar com a chave da burner
  blockers: string[];
};

type ParsedTokenAccount = {
  pubkey?: unknown;
  account?: {
    lamports?: unknown;
    data?: { parsed?: { info?: Record<string, unknown> } };
  };
};

// lamports vindos do RPC: só inteiro finito e não negativo. "1e400" chega como Infinity (JSON.parse), e BigInt()
// lança com Infinity, NaN ou 1.5: esse dado vira null aqui, e quem chama decide (erro da carteira ou zero).
export function lamportsOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function toBigInt(v: unknown): bigint | undefined {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return undefined;
  return BigInt(v);
}

export function parseTokenAccount(raw: ParsedTokenAccount, owner: string, program: TokenAccount['program']): TokenAccount {
  const account = typeof raw?.pubkey === 'string' ? raw.pubkey : '?';
  const info = raw?.account?.data?.parsed?.info ?? {};
  const lamports = lamportsOrNull(raw?.account?.lamports) ?? 0;
  const mint = typeof info.mint === 'string' ? info.mint : '?';
  const ta = (info.tokenAmount ?? {}) as Record<string, unknown>;
  const amount = toBigInt(ta.amount);
  const decimals = typeof ta.decimals === 'number' && Number.isInteger(ta.decimals) && ta.decimals <= 255 ? ta.decimals : -1; // u8 na rede

  const base = { account, mint, program, rentLamports: lamports };
  if (account === '?' || mint === '?' || amount === undefined || decimals < 0) {
    return { ...base, amount: 0n, decimals: 0, kind: 'invalid', blockers: ['dados da conta fora do formato esperado'] };
  }

  const blockers: string[] = [];
  if (info.state === 'frozen') blockers.push('conta congelada pelo emissor');
  if (typeof info.closeAuthority === 'string' && info.closeAuthority !== owner) blockers.push('outra carteira tem a autoridade de fechamento');
  if (Array.isArray(info.extensions)) {
    for (const ext of info.extensions as Array<Record<string, unknown>>) {
      const state = (ext?.state ?? {}) as Record<string, unknown>;
      if (ext?.extension === 'transferFeeAmount' && Number(state.withheldAmount ?? 0) > 0) {
        blockers.push('taxa de transferência retida (Token-2022) impede fechar');
      }
      // vazia pode ser fechada; com saldo não dá para transferir (achado da revisão: aluguel ficava preso)
      if (ext?.extension === 'nonTransferableAccount' && amount !== 0n) blockers.push('token não transferível');
    }
  }

  let kind: TokenKind;
  if (info.isNative === true) kind = 'wsol';
  else if (amount === 0n) kind = 'empty';
  else if (decimals === 0 && amount === 1n) kind = 'nft';
  else kind = 'fungible';

  return { ...base, amount, decimals, kind, blockers };
}

async function tokenAccounts(rpc: RpcClient, owner: string): Promise<TokenAccount[]> {
  const out = new Map<string, TokenAccount>();
  for (const [programId, label] of [[PROGRAMS.token, 'token'], [PROGRAMS.token2022, 'token-2022']] as const) {
    const res = await rpc.call<{ value?: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
      owner,
      { programId },
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    // resposta sem lista NÃO é "nenhuma moeda": vira erro da carteira, e ela é lida de novo
    if (!Array.isArray(res?.value)) throw new Error(`getTokenAccountsByOwner (${label}): resposta fora do formato`);
    // chave = endereço da conta: o RPC repetir a mesma conta não duplica o saldo
    for (const raw of res.value) {
      const t = parseTokenAccount(raw, owner, label);
      out.set(t.account === '?' ? `?${out.size}` : t.account, t);
    }
  }
  return [...out.values()];
}

// ---------- creator fees da Pump.fun ----------


// Fee "não varrida" que o app coleta: varre para o cofre e coleta na mesma transação (docs/pumpfun-creator-fees.md).
export type CurveSweep = { curve: string; mint: string; lamports: bigint };
export type PoolSweep = { pool: string; quoteAccount: string; lamports: bigint };

export type CreatorFees = {
  bondingVault: string;
  bondingVaultLamports: number; // acima do aluguel
  ammVaultAta: string;
  ammVaultLamports: number;
  curveSweeps: CurveSweep[]; // fee parada nas curvas, que o app varre e coleta
  poolSweeps: PoolSweep[]; // idem nos pools do PumpSwap
  // não varrida que o app NÃO coleta: moeda de recompensa a holders ou cashback (a fee não é do criador),
  // moeda pareada em outro token, ou mint não achado. Fica fora do total, com aviso.
  unsweptCurveLamports: bigint;
  unsweptPoolLamports: bigint;
  coinsOnCurve: number;
  pools: number;
  detailed: boolean; // false = não consultou as curvas/pools (só cofres)
  unsweptError: string | null; // a busca da fee parada falhou: os cofres valem, a parte parada ficou sem ler
  // creator fee dividida (fee sharing) em que esta carteira é participante; a coleta paga todos os participantes e a
  // parte desta carteira vai ao destino. Lista ausente = varredura de antes da fee sharing (nada dividido).
  shared?: SharedFee[];
  sharedOther?: number; // divisões em que ela participa e o app não coleta: pausada, moeda pareada em outro token
  sharedError?: string | null; // a busca da fee dividida falhou (o resto vale)
  // cashback de quem negociou moeda com cashback (não é creator fee, mas é dinheiro da carteira na Pump.fun):
  // pump = SOL acima do aluguel do acumulador da Pump.fun; amm = WSOL no acumulador do PumpSwap
  cashback?: { pump: bigint; amm: bigint };
  cashbackError?: string | null;
  // creator fee em moeda pareada em outro token (USDC, moeda da Pump etc.): parada na curva ou no pool, ou já no
  // cofre do criador nesse token. O app não coleta (só SOL); a tela avisa com a contagem.
  otherQuoteFees?: number;
  // contas de volume (cashback/incentivo) da Pump.fun e do PumpSwap que existem: a que não guarda mais nada é fechada
  // e o aluguel volta (docs/superpowers/specs/2026-11-06-chaves-e-caminhos-design.md §4.4). Lista ausente = leitura
  // de antes desta regra (nada fecha). Falha de leitura vira "não fecha" (why 'read-failed'), nunca erro da carteira.
  uva?: UvaState[];
  // creator fee da Meteora DBC (Bags, Jupiter Studio, Believe…): pools em que esta carteira é o creator (src/core/limpeza/dbc.ts).
  // Ausente = leitura de antes desta regra (nada). Falha de leitura vira dbcError ("não sei"), nunca lista vazia.
  dbc?: DbcFees;
  dbcError?: string | null;
  // creator fee do Raydium LaunchLab (bonk.fun e outros): o cofre [creator, WSOL] desta carteira (src/core/limpeza/launchlab.ts).
  // Ausente = leitura de antes desta regra (nada). Falha de leitura vira launchlabError ("não sei"), nunca zero.
  launchlab?: LaunchlabFees;
  launchlabError?: string | null;
};

// Uma moeda em fee sharing (docs/pumpfun-creator-fees.md, 31/10/2026): a fee fica nos cofres e campos do sharing
// config, e a distribuição paga cada participante na proporção dele. Valores da análise; a coleta mede de novo.
export type SharedFee = {
  config: string;
  mint: string;
  bps: number; // parte desta carteira, em centésimos de por cento
  curveFee: bigint; // parada na curva (varrer antes)
  poolSweep: PoolSweep | null; // parada no pool do PumpSwap (varrer antes)
  ammVault: boolean; // cofre do PumpSwap do sharing config existe (levar para a curva antes de distribuir)
  totalLamports: bigint; // tudo o que a distribuição paga (todos os participantes)
  shareLamports: bigint; // a parte desta carteira
};

const BONDING_CURVE_DISC = encodeBase58(anchorAccountDiscriminator('BondingCurve'));
const POOL_DISC = encodeBase58(anchorAccountDiscriminator('Pool'));
const WSOL_BYTES = decodeBase58(WSOL_MINT);
const ZERO_KEY = new Uint8Array(32);

type Gpa = Array<{ pubkey?: unknown; account?: { data?: unknown[] } }>;

async function programAccounts(rpc: RpcClient, program: string, disc: string, creatorOffset: number, creator: string, slice: { offset: number; length: number }) {
  const res = await rpc.call<Gpa>('getProgramAccounts', [
    program,
    { encoding: 'base64', dataSlice: slice, filters: [{ memcmp: { offset: 0, bytes: disc } }, { memcmp: { offset: creatorOffset, bytes: creator } }] },
  ]);
  // chave = endereço da conta: o RPC repetir a mesma conta não soma a fee duas vezes
  // resposta sem lista NÃO é "nenhuma moeda": a fee dessa carteira ficaria sem ler, contada como zero
  if (!Array.isArray(res)) throw new Error('getProgramAccounts: resposta fora do formato');
  const out = new Map<string, Buffer>();
  for (const a of res) {
    const raw = a?.account?.data?.[0];
    // item fora do formato é ignorado, sem derrubar os outros
    if (typeof a?.pubkey === 'string' && isAddress(a.pubkey) && typeof raw === 'string') out.set(a.pubkey, Buffer.from(raw, 'base64'));
  }
  return [...out].map(([pubkey, data]) => ({ pubkey, data }));
}

// Campo que a conta ainda não tem (layout antigo, mais curto) vale 0, como manda a doc.
function u64At(b: Buffer, at: number): bigint {
  return b.length >= at + 8 ? b.readBigUInt64LE(at) : 0n;
}
function keyAt(b: Buffer, at: number): Uint8Array {
  return b.length >= at + 32 ? b.subarray(at, at + 32) : ZERO_KEY;
}
const sameKey = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

// BondingCurve (IDL 639b87fb): complete 48, creator 49, is_cashback_coin 82, quote_mint 83, is_holder_reward 124,
// creator_fee 125. Lido a partir do 48.
export const CURVE_SLICE = { offset: 48, length: 85 };
// quote: mint do par quando não é SOL (null = SOL); a fee dessa moeda é nesse token, não em lamports
export function parseCurve(b: Buffer): { complete: boolean; collectable: boolean; fee: bigint; quote: string | null } {
  const at = (o: number) => o - CURVE_SLICE.offset;
  const quote = keyAt(b, at(83));
  const solPaired = sameKey(quote, ZERO_KEY) || sameKey(quote, WSOL_BYTES); // zero = curva antiga, sempre em SOL
  return {
    complete: b[at(48)] === 1,
    collectable: solPaired && b[at(82)] !== 1 && b[at(124)] !== 1,
    fee: u64At(b, at(125)),
    quote: solPaired ? null : encodeBase58(quote),
  };
}

// Pool (IDL 639b87fb): quote_mint 75, pool_quote_token_account 171, is_cashback_coin 244, is_holder_reward 270,
// creator_fees 279. Lido a partir do 75.
export const POOL_SLICE = { offset: 75, length: 212 };
export function parsePool(b: Buffer): { quoteAccount: string; collectable: boolean; fee: bigint; quote: string | null } {
  const at = (o: number) => o - POOL_SLICE.offset;
  const quoteAccount = keyAt(b, at(171));
  return {
    quote: sameKey(keyAt(b, at(75)), WSOL_BYTES) ? null : encodeBase58(keyAt(b, at(75))),
    quoteAccount: encodeBase58(quoteAccount),
    collectable: sameKey(keyAt(b, at(75)), WSOL_BYTES) && !sameKey(quoteAccount, ZERO_KEY) && b[at(244)] !== 1 && b[at(270)] !== 1,
    fee: u64At(b, at(279)),
  };
}

// A curva não guarda o mint; ela é dona da conta de token da própria moeda. Confere o PDA: conta de token que
// alguém criou para a curva com outro mint não passa.
async function curveMint(rpc: RpcClient, curve: string): Promise<string | null> {
  for (const programId of [PROGRAMS.token2022, PROGRAMS.token]) {
    const res = await rpc.call<{ value?: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [curve, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    // sem lista, o mint ficaria "não achado" e a fee iria para o "fora do total" sem ser coletada: vira erro
    if (!Array.isArray(res?.value)) throw new Error('getTokenAccountsByOwner (mint da curva): resposta fora do formato');
    for (const raw of res.value) {
      const mint = raw?.account?.data?.parsed?.info?.mint;
      if (typeof mint === 'string' && isAddress(mint) && findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address === curve) return mint;
    }
  }
  return null;
}

// Fee abaixo disso não paga a transação extra de achar o mint (2 consultas) nem a varredura.
export const MIN_SWEEP_LAMPORTS = 5_000n;

async function unsweptFees(rpc: RpcClient, wallet: string, fees: CreatorFees): Promise<void> {
  const curves = await programAccounts(rpc, PROGRAMS.pump, BONDING_CURVE_DISC, 49, wallet, CURVE_SLICE);
  fees.coinsOnCurve = curves.length;
  const quotes = new Set<string>(); // tokens de par (não SOL) das moedas desta carteira
  for (const c of curves) {
    const p = parseCurve(c.data);
    if (p.quote) quotes.add(p.quote);
    if (p.fee === 0n) continue;
    // fee em outro token: não é lamport (antes entrava somada no "Fora do total: X SOL"); conta a moeda
    if (p.quote) {
      fees.otherQuoteFees = (fees.otherQuoteFees ?? 0) + 1;
      continue;
    }
    const mint = p.collectable && p.fee >= MIN_SWEEP_LAMPORTS ? await curveMint(rpc, c.pubkey) : null;
    if (mint) fees.curveSweeps.push({ curve: c.pubkey, mint, lamports: p.fee });
    else fees.unsweptCurveLamports += p.fee;
  }
  // Pool só existe para moeda que migrou (curva completa): sem nenhuma, poupa 10 créditos do Helius.
  // Limite conhecido: pool cujo criador foi trocado para esta carteira sem a curva fica de fora.
  if (curves.some((c) => parseCurve(c.data).complete)) {
    const pools = await programAccounts(rpc, PROGRAMS.pumpAmm, POOL_DISC, 211, wallet, POOL_SLICE);
    fees.pools = pools.length;
    for (const pl of pools) {
      const p = parsePool(pl.data);
      if (p.quote) quotes.add(p.quote);
      if (p.fee === 0n) continue;
      if (p.quote) {
        fees.otherQuoteFees = (fees.otherQuoteFees ?? 0) + 1;
        continue;
      }
      if (p.collectable && p.fee >= MIN_SWEEP_LAMPORTS) fees.poolSweeps.push({ pool: pl.pubkey, quoteAccount: p.quoteAccount, lamports: p.fee });
      else fees.unsweptPoolLamports += p.fee;
    }
  }
  // fee em outro token já no cofre do criador (curva e PumpSwap, programa Token ou Token-2022): 1 consulta, e só se
  // alguma moeda desta carteira for pareada em outro token
  if (quotes.size) {
    const owners = [pumpCreatorVault(wallet), pumpAmmCreatorVaultAuthority(wallet)];
    const keys = [...quotes].flatMap((q) => owners.flatMap((o) => [PROGRAMS.token, PROGRAMS.token2022].map((tp) => associatedTokenAddress(o, q, tp))));
    try {
      const accs = await accountsOf(rpc, keys);
      fees.otherQuoteFees = (fees.otherQuoteFees ?? 0) + accs.filter((a) => a && u64At(a.data, 64) > 0n).length;
    } catch {
      // leitura só para o aviso: falhar aqui não apaga a fee parada já lida (fica sem a contagem do cofre)
    }
  }
}

// ---------- saldo e cofres, em lote ----------

// Saldo da carteira + os 2 cofres de creator fee, 33 carteiras por consulta (3 contas cada, limite 100).
// Antes: 1 consulta de saldo + 1 de cofres POR carteira (medido em 30/10/2026).
export const BASICS_PER_CALL = 33;

export type Basics = {
  lamports: number;
  balanceError: string | null;
  vaultLamports: number; // cofre da curva acima do aluguel
  ataAmount: bigint; // cofre do PumpSwap (WSOL)
  vaultsError: string | null;
};

type ParsedAcc = { lamports?: unknown; data?: { parsed?: { info?: { tokenAmount?: { amount?: unknown } } } } } | null;

export async function readBasics(rpc: RpcClient, addresses: string[], rentExemptZero: number): Promise<Map<string, Basics>> {
  const out = new Map<string, Basics>();
  for (let i = 0; i < addresses.length; i += BASICS_PER_CALL) {
    const chunk = addresses.slice(i, i + BASICS_PER_CALL);
    const keys = chunk.flatMap((a) => [a, pumpCreatorVault(a), pumpAmmCreatorVaultAta(a)]);
    let value: unknown;
    try {
      value = (await rpc.call<{ value?: unknown }>('getMultipleAccounts', [keys, { encoding: 'jsonParsed', commitment: 'confirmed' }]))?.value;
    } catch (e) {
      // falha do lote vira erro só das carteiras deste lote
      const msg = e instanceof Error ? e.message : 'erro desconhecido';
      for (const a of chunk) out.set(a, { lamports: 0, balanceError: msg, vaultLamports: 0, ataAmount: 0n, vaultsError: msg });
      continue;
    }
    const list = Array.isArray(value) ? (value as ParsedAcc[]) : [];
    chunk.forEach((a, k) => {
      const [w, vault, ata] = list.length === keys.length ? list.slice(3 * k, 3 * k + 3) : [undefined, null, null];
      // conta inexistente (null) = 0 SOL, como o getBalance; qualquer outra coisa sem número é dado sujo
      const lamports = w === null ? 0 : lamportsOrNull(w?.lamports);
      // cofre da curva: inexistente (null) = sem fee; existe mas o saldo não é inteiro finito = carteira marcada,
      // nunca "0 de fee" (a pessoa veria nada a coletar onde a leitura falhou)
      const vaultRaw = vault === null || vault === undefined ? 0 : lamportsOrNull(vault.lamports);
      out.set(a, {
        lamports: lamports ?? 0,
        balanceError: lamports === null ? 'saldo fora do formato' : null,
        vaultLamports: Math.max(0, (vaultRaw ?? 0) - rentExemptZero),
        ataAmount: toBigInt(ata?.data?.parsed?.info?.tokenAmount?.amount) ?? 0n,
        vaultsError: vaultRaw === null ? 'cofre da curva fora do formato' : null,
      });
    });
  }
  return out;
}

// ---------- creator fee dividida (fee sharing) ----------

const SHARING_DISC_BYTES = Buffer.from('d84a0900388c5d4b', 'hex'); // discriminador da conta SharingConfig (IDL 639b87fb)
const SHARING_DISC = encodeBase58(SHARING_DISC_BYTES);
// version 9, status 10 (1 = ativo), mint 11, admin 43, nº de participantes 76 (u32), participante i em 80 + 34i
// (endereço) e 112 + 34i (parte, u16); até 10 participantes
export const SHARING_SLICE = { offset: 0, length: 80 + 34 * 10 };
export type SharingConfig = { active: boolean; mint: string; shareholders: Array<{ address: string; bps: number }> };

// dado fora do formato = null (nunca lança): uma conta ruim não derruba a lista
export function parseSharingConfig(b: Buffer): SharingConfig | null {
  if (b.length < 80 || !b.subarray(0, 8).equals(SHARING_DISC_BYTES)) return null;
  const n = b.readUInt32LE(76);
  if (n < 1 || n > 10 || b.length < 80 + 34 * n) return null;
  const shareholders = Array.from({ length: n }, (_, i) => ({ address: encodeBase58(b.subarray(80 + 34 * i, 112 + 34 * i)), bps: b.readUInt16LE(112 + 34 * i) }));
  if (shareholders.reduce((a, h) => a + h.bps, 0) !== 10_000) return null;
  return { active: b[10] === 1, mint: encodeBase58(b.subarray(11, 43)), shareholders };
}

type RawAcc = { lamports?: unknown; data?: unknown[] } | null;
async function accountsOf(rpc: RpcClient, keys: string[], slice?: { offset: number; length: number }): Promise<Array<{ lamports: number; data: Buffer } | null>> {
  const out: Array<{ lamports: number; data: Buffer } | null> = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value?: RawAcc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed', ...(slice ? { dataSlice: slice } : {}) }]);
    const list = Array.isArray(r?.value) && r.value.length === chunk.length ? r.value : null;
    if (!list) throw new Error('resposta da rede fora do formato');
    for (const a of list) {
      const raw = a?.data?.[0];
      out.push(a && typeof raw === 'string' ? { lamports: lamportsOrNull(a.lamports) ?? 0, data: Buffer.from(raw, 'base64') } : null);
    }
  }
  return out;
}

// Acha as divisões em que a carteira participa, por dois caminhos (medido em 31/10/2026: a busca por admin achava
// pouco; a Pump.fun põe o criador como 1º participante): (1) busca no programa de fees com a carteira na 1ª posição
// (1 getProgramAccounts por carteira); (2) o sharing config de cada moeda que a carteira tem ou teve conta de token
// (getMultipleAccounts, barato), que pega qualquer posição.
export async function sharedFees(rpc: RpcClient, wallet: string, mints: string[], rentExemptZero: number): Promise<{ shared: SharedFee[]; other: number }> {
  const configs = new Map<string, SharingConfig>();
  const gpa = await rpc.call<Gpa>('getProgramAccounts', [
    PROGRAMS.pumpFees,
    { encoding: 'base64', dataSlice: SHARING_SLICE, filters: [{ memcmp: { offset: 0, bytes: SHARING_DISC } }, { memcmp: { offset: 80, bytes: wallet } }] },
  ]);
  if (!Array.isArray(gpa)) throw new Error('getProgramAccounts (fee dividida): resposta fora do formato');
  for (const a of gpa) {
    const raw = a?.account?.data?.[0];
    const c = typeof a?.pubkey === 'string' && isAddress(a.pubkey) && typeof raw === 'string' ? parseSharingConfig(Buffer.from(raw, 'base64')) : null;
    if (c) configs.set(a.pubkey as string, c);
  }
  const candidates = [...new Set(mints.filter(isAddress).map(sharingConfigAddress))].filter((k) => !configs.has(k));
  const read = await accountsOf(rpc, candidates, SHARING_SLICE);
  candidates.forEach((k, i) => {
    const c = read[i] && parseSharingConfig(read[i]!.data);
    if (c) configs.set(k, c);
  });
  // só as divisões em que esta carteira participa, e do mint certo (o PDA confere)
  const mine = [...configs].filter(([k, c]) => c.shareholders.some((h) => h.address === wallet) && sharingConfigAddress(c.mint) === k);
  if (!mine.length) return { shared: [], other: 0 };
  const curves = await accountsOf(rpc, mine.map(([, c]) => curveAddress(c.mint)), CURVE_SLICE);
  const pools = await accountsOf(rpc, mine.map(([, c]) => poolAddress(c.mint)), POOL_SLICE);
  const vaults = await accountsOf(rpc, mine.flatMap(([k]) => [pumpCreatorVault(k), pumpAmmCreatorVaultAta(k)]));
  const shared: SharedFee[] = [];
  let other = 0;
  mine.forEach(([config, c], i) => {
    const curve = curves[i];
    const bps = c.shareholders.find((h) => h.address === wallet)!.bps;
    const cv = curve ? parseCurve(curve.data) : null;
    // a curva tem que apontar para este sharing config (criador @49) e ser em SOL do próprio criador
    const pointsHere = curve ? encodeBase58(keyAt(curve.data, 49 - CURVE_SLICE.offset)) === config : false;
    if (!c.active || !cv || !pointsHere || !cv.collectable) {
      other++;
      return;
    }
    const pool = pools[i];
    const pp = pool && encodeBase58(keyAt(pool.data, 211 - POOL_SLICE.offset)) === config ? parsePool(pool.data) : null;
    const poolSweep = pp && pp.collectable && pp.fee > 0n ? { pool: poolAddress(c.mint), quoteAccount: pp.quoteAccount, lamports: pp.fee } : null;
    const vault = vaults[2 * i];
    const ata = vaults[2 * i + 1];
    const ammAmount = ata ? u64At(ata.data, 64) : 0n;
    const total = BigInt(Math.max(0, (vault?.lamports ?? 0) - rentExemptZero)) + cv.fee + (poolSweep?.lamports ?? 0n) + ammAmount;
    shared.push({ config, mint: c.mint, bps, curveFee: cv.fee, poolSweep, ammVault: Boolean(ata), totalLamports: total, shareLamports: (total * BigInt(bps)) / 10_000n });
  });
  return { shared, other };
}

// Cashback (IDL 639b87fb, docs/instructions/CLAIM_CASHBACK.md): medido na mainnet em 31/10/2026, 5 de 42 carteiras
// recentes da Pump.fun tinham cashback no PumpSwap e 3 na Pump.fun. 1 getMultipleAccounts por carteira.
type VolumeAccounts = Array<{ lamports: number; data: Buffer } | null>; // conta de volume da Pump.fun, do PumpSwap e a ATA WSOL dela
const volumeAccounts = (rpc: RpcClient, wallet: string): Promise<VolumeAccounts> => {
  const ammUva = userVolumeAccumulator(wallet, PROGRAMS.pumpAmm);
  return accountsOf(rpc, [userVolumeAccumulator(wallet, PROGRAMS.pump), ammUva, associatedTokenAddress(ammUva, WSOL_MINT, PROGRAMS.token)]);
};
// aluguel de uma conta de `bytes`, como plan.ts rentFor (aqui sem importar o plano)
const rentOf = (bytes: number, rentExemptZero: number) => (BigInt(rentExemptZero) * BigInt(128 + bytes)) / 128n;
function cashbackFrom([uva, ammAcc, ata]: VolumeAccounts, rentExemptZero: number): { pump: bigint; amm: bigint } {
  // acima do aluguel da conta, pelo tamanho dela (aluguel por byte, como em plan.ts rentFor)
  const rent = uva ? rentOf(uva.data.length, rentExemptZero) : 0n;
  const pump = uva && BigInt(uva.lamports) > rent ? BigInt(uva.lamports) - rent : 0n;
  // WSOL na conta do acumulador do PumpSwap só sai com o acumulador existindo (medido na mainnet em 31/10/2026: com
  // ele fechado, a coleta falha com 3012, AccountNotInitialized); sem ele, o WSOL fica preso e não é cashback a coletar
  return { pump, amm: ata && ammAcc ? u64At(ata.data, 64) : 0n };
}
export async function cashbackOf(rpc: RpcClient, wallet: string, rentExemptZero: number): Promise<{ pump: bigint; amm: bigint }> {
  return cashbackFrom(await volumeAccounts(rpc, wallet), rentExemptZero);
}

// ---------- conta de volume (UserVolumeAccumulator): fechar a que não guarda mais nada ----------
// IDL 639b87fb (pump-public-docs, relido em 06/11/2026). Layout: disc 0, user 8, needs_claim 40 (bool),
// total_unclaimed_tokens 41, total_claimed_tokens 49, current_sol_volume 57, last_update_timestamp 65,
// has_total_claimed_tokens 73, cashback_earned 74, total_cashback_claimed 82 e, só na Pump.fun,
// stable_cashback_earned 90, total_stable_cashback_claimed 98. Na mainnet as contas têm 137 bytes (06/11/2026).

export type UvaVenue = 'pump' | 'amm';
export type UvaWhy = 'incentive' | 'stable-cashback' | 'token-account' | 'read-failed';
// lamports: tudo o que a conta tem (vai para a temporária ao fechar); rentLamports: o aluguel pelo tamanho dela (o que
// passa disso é cashback em SOL, que o claim_cashback paga antes de fechar: medido na mainnet em 06/11/2026)
export type UvaState = { program: UvaVenue; address: string; lamports: bigint; rentLamports: bigint; closable: boolean; why?: UvaWhy };
export type UvaFields = { needsClaim: boolean; unclaimedTokens: bigint; solVolume: bigint; stableEarned: bigint; stableClaimed: bigint };

const UVA_DISC = Buffer.from('56ff700e66359afa', 'hex');
const GLOBAL_VOLUME_DISC = Buffer.from('ca2af62b8ebe1eff', 'hex');
export const UVA_MIN_BYTES = { pump: 106, amm: 90 } as const;
// GlobalVolumeAccumulator: disc 0, start_time 8, end_time 16, seconds_in_a_day 24 (i64; IDL do pump-public-docs
// conferido em 08/11/2026, igual nos dois programas)
export const GLOBAL_VOLUME_SLICE = { offset: 0, length: 32 };
const volumeProgram = (v: UvaVenue) => (v === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm);
export const globalVolumeAccumulator = (v: UvaVenue) => findProgramAddress(['global_volume_accumulator'], volumeProgram(v)).address;

// dado fora do formato = null (conta curta, discriminador errado, bool que não é 0 nem 1)
export function parseUva(b: Buffer, venue: UvaVenue): UvaFields | null {
  if (b.length < UVA_MIN_BYTES[venue] || !b.subarray(0, 8).equals(UVA_DISC) || b[40] > 1) return null;
  return {
    needsClaim: b[40] === 1,
    unclaimedTokens: b.readBigUInt64LE(41),
    solVolume: b.readBigUInt64LE(57),
    stableEarned: venue === 'pump' ? b.readBigUInt64LE(90) : 0n,
    stableClaimed: venue === 'pump' ? b.readBigUInt64LE(98) : 0n,
  };
}
export function parseGlobalVolumeEnd(b: Buffer): bigint | null {
  return b.length >= 24 && b.subarray(0, 8).equals(GLOBAL_VOLUME_DISC) ? b.readBigInt64LE(16) : null;
}
// duração do "dia" do incentivo; null = campo que falta (conta curta) ou fora do formato
export function parseGlobalVolumeDay(b: Buffer): bigint | null {
  return b.length >= 32 && b.subarray(0, 8).equals(GLOBAL_VOLUME_DISC) ? b.readBigInt64LE(24) : null;
}

// Fim do incentivo em token PUMP de cada programa (0 = nunca configurado: medido na mainnet em 06/11/2026, 0 e 0).
// day: seconds_in_a_day de cada programa, quando a conta tem o campo
export type IncentiveEnds = { pump: bigint; amm: bigint; day?: { pump?: bigint; amm?: bigint } };
// Uma rodada de leitura: a janela do incentivo é lida uma vez (na 1ª conta de volume que aparecer) e dividida entre as
// carteiras. now: segundos (teste).
export type VolumeContext = { ends?: Promise<IncentiveEnds>; now?: () => number };

export async function readIncentiveEnds(rpc: RpcClient): Promise<IncentiveEnds> {
  const [p, a] = await accountsOf(rpc, [globalVolumeAccumulator('pump'), globalVolumeAccumulator('amm')], GLOBAL_VOLUME_SLICE);
  const end = (x: { data: Buffer } | null) => {
    if (!x) return 0n; // conta que não existe: sem incentivo
    const e = parseGlobalVolumeEnd(x.data);
    if (e === null) throw new Error('janela do incentivo fora do formato');
    return e;
  };
  const day = (x: { data: Buffer } | null) => (x ? (parseGlobalVolumeDay(x.data) ?? undefined) : undefined);
  return { pump: end(p), amm: end(a), day: { pump: day(p), amm: day(a) } };
}
function incentiveEnds(rpc: RpcClient, ctx: VolumeContext): Promise<IncentiveEnds> {
  if (!ctx.ends) {
    const p = readIncentiveEnds(rpc);
    ctx.ends = p;
    // falhou: a próxima conta de volume tenta de novo (esta fica "não sei" e não fecha)
    p.catch(() => {
      if (ctx.ends === p) ctx.ends = undefined;
    });
  }
  return ctx.ends;
}

// Folga depois do fim do incentivo (revisão independente de 08/11/2026): o volume do último dia pode ainda virar token
// PUMP logo depois de a janela fechar (o programa fecha o dia na próxima interação). Enquanto não passa a folga, conta
// com volume fica aberta: 2 "dias" do programa (seconds_in_a_day), nunca menos que 48 h (também quando o campo falta).
export const INCENTIVE_GRACE_MIN_SECONDS = 48n * 3600n;
export function incentiveGrace(secondsInDay?: bigint): bigint {
  const two = secondsInDay !== undefined && secondsInDay > 0n ? 2n * secondsInDay : 0n;
  return two > INCENTIVE_GRACE_MIN_SECONDS ? two : INCENTIVE_GRACE_MIN_SECONDS;
}

// Fecha só se a conta não guarda mais nada (spec §4.4): nenhum incentivo a coletar, nenhum volume que ainda vira
// incentivo (janela aberta, ou fechada há menos que a folga), nenhum cashback em stable a coletar (Pump.fun) e nenhuma
// conta de token dela (conferida à parte). Devolve o impedimento, ou null. O cashback em SOL não impede: o executor
// coleta antes, na mesma transação. incentiveEnd 0 (ou menor) = incentivo nunca configurado.
export function uvaVerdict(f: UvaFields, venue: UvaVenue, incentiveEnd: bigint, nowSec: number, secondsInDay?: bigint): UvaWhy | null {
  if (f.needsClaim) return 'incentive';
  if (f.unclaimedTokens > 0n) return 'incentive';
  if (incentiveEnd > 0n && f.solVolume > 0n && BigInt(nowSec) < incentiveEnd + incentiveGrace(secondsInDay)) return 'incentive';
  if (venue === 'pump' && f.stableEarned !== f.stableClaimed) return 'stable-cashback';
  return null;
}

async function uvaState(rpc: RpcClient, wallet: string, venue: UvaVenue, acc: { lamports: number; data: Buffer }, ctx: VolumeContext, rentExemptZero: number): Promise<UvaState> {
  const address = userVolumeAccumulator(wallet, volumeProgram(venue));
  const base = { program: venue, address, lamports: BigInt(acc.lamports), rentLamports: rentOf(acc.data.length, rentExemptZero) };
  const open = (why: UvaWhy): UvaState => ({ ...base, closable: false, why });
  try {
    const f = parseUva(acc.data, venue);
    if (!f) return open('read-failed');
    const ends = await incentiveEnds(rpc, ctx);
    const why = uvaVerdict(f, venue, ends[venue], ctx.now?.() ?? Math.floor(Date.now() / 1000), ends.day?.[venue]);
    if (why) return open(why);
    // a ATA WSOL do acumulador do PumpSwap (cashback), ou qualquer outra conta de token dela, nos dois programas
    for (const programId of [PROGRAMS.token, PROGRAMS.token2022]) {
      const res = await rpc.call<{ value?: unknown }>('getTokenAccountsByOwner', [address, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      if (!Array.isArray(res?.value)) return open('read-failed'); // sem lista não é "nenhuma conta"
      if (res.value.length) return open('token-account');
    }
    return { ...base, closable: true };
  } catch (e) {
    if (isStop(e)) throw e;
    return open('read-failed'); // "não sei" nunca vira "pode fechar"
  }
}

// Estado das contas de volume que existem. accs = [Pump.fun, PumpSwap] já lidas (null = a leitura falhou: as duas
// ficam "não sei", com endereço e sem valor). Nunca lança, a não ser no "Parar".
export async function uvaStates(rpc: RpcClient, wallet: string, accs: Array<{ lamports: number; data: Buffer } | null> | null, ctx: VolumeContext, rentExemptZero: number): Promise<UvaState[]> {
  const venues: UvaVenue[] = ['pump', 'amm'];
  if (!accs) return venues.map((v) => ({ program: v, address: userVolumeAccumulator(wallet, volumeProgram(v)), lamports: 0n, rentLamports: 0n, closable: false, why: 'read-failed' }));
  const out: UvaState[] = [];
  for (const [i, v] of venues.entries()) {
    const acc = accs[i];
    if (acc) out.push(await uvaState(rpc, wallet, v, acc, ctx, rentExemptZero));
  }
  return out;
}

// Releitura de uma conta de volume (executor, antes de montar a transação). null = não existe mais.
export async function readUva(rpc: RpcClient, wallet: string, venue: UvaVenue, ctx: VolumeContext, rentExemptZero: number): Promise<UvaState | null> {
  let acc: { lamports: number; data: Buffer } | null;
  try {
    [acc] = await accountsOf(rpc, [userVolumeAccumulator(wallet, volumeProgram(venue))]);
  } catch (e) {
    if (isStop(e)) throw e;
    return (await uvaStates(rpc, wallet, null, ctx, rentExemptZero)).find((u) => u.program === venue)!;
  }
  return acc ? uvaState(rpc, wallet, venue, acc, ctx, rentExemptZero) : null;
}

export async function creatorFees(rpc: RpcClient, wallet: string, basics: Basics, detailed: boolean, mints: string[] = [], rentExemptZero = 0, volume: VolumeContext = {}): Promise<CreatorFees> {
  if (basics.vaultsError) throw new Error(basics.vaultsError);
  const amm = Number(basics.ataAmount);
  if (!Number.isSafeInteger(amm)) throw new Error('cofre do PumpSwap fora do formato'); // Number() de 400 dígitos = Infinity
  const fees: CreatorFees = {
    bondingVault: pumpCreatorVault(wallet),
    bondingVaultLamports: basics.vaultLamports,
    ammVaultAta: pumpAmmCreatorVaultAta(wallet),
    ammVaultLamports: amm,
    curveSweeps: [],
    poolSweeps: [],
    unsweptCurveLamports: 0n,
    unsweptPoolLamports: 0n,
    coinsOnCurve: 0,
    pools: 0,
    detailed,
    unsweptError: null,
  };
  if (detailed) {
    try {
      await unsweptFees(rpc, wallet, fees);
    } catch (e) {
      // a parte parada é um extra: sem ela, os cofres e o resto da carteira continuam valendo (não pula a carteira)
      Object.assign(fees, { curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n });
      fees.unsweptError = e instanceof Error ? e.message : 'erro desconhecido';
    }
    try {
      const r = await sharedFees(rpc, wallet, mints, rentExemptZero);
      Object.assign(fees, { shared: r.shared, sharedOther: r.other, sharedError: null });
    } catch (e) {
      // como a fee parada: um extra que não pula a carteira; a tela avisa que a leitura falhou
      Object.assign(fees, { shared: [], sharedOther: 0, sharedError: e instanceof Error ? e.message : 'erro desconhecido' });
    }
    let volumeAccs: VolumeAccounts | null = null;
    try {
      volumeAccs = await volumeAccounts(rpc, wallet);
      Object.assign(fees, { cashback: cashbackFrom(volumeAccs, rentExemptZero), cashbackError: null });
    } catch (e) {
      Object.assign(fees, { cashback: { pump: 0n, amm: 0n }, cashbackError: e instanceof Error ? e.message : 'erro desconhecido' });
    }
    try {
      Object.assign(fees, { dbc: await dbcFees(rpc, wallet), dbcError: null });
    } catch (e) {
      // como a fee parada: um extra que não pula a carteira; a tela avisa e a análise relê
      if (isStop(e)) throw e;
      Object.assign(fees, { dbc: { pools: [], found: 0, other: 0, cut: 0 }, dbcError: e instanceof Error ? e.message : 'erro desconhecido' });
    }
    try {
      Object.assign(fees, { launchlab: await launchlabFees(rpc, wallet), launchlabError: null });
    } catch (e) {
      // como a Meteora: um extra que não pula a carteira; a tela avisa e a análise relê
      if (isStop(e)) throw e;
      Object.assign(fees, { launchlab: { vault: '', lamports: 0n, other: 0 }, launchlabError: e instanceof Error ? e.message : 'erro desconhecido' });
    }
    // contas de volume: aproveita a leitura do cashback (só lê mais para a que existe); falha não marca a carteira
    // desligado na 1.0 (src/core/features.ts): nem lê o estado das contas de volume
    fees.uva = FEATURES.closeVolumeAccounts ? await uvaStates(rpc, wallet, volumeAccs ? volumeAccs.slice(0, 2) : null, volume, rentExemptZero) : [];
  }
  return fees;
}

// lista ausente (varredura gravada antes da coleta da fee parada) = nada parado
const sumSweeps = (list: Array<{ lamports: bigint }> | undefined) => (list ?? []).reduce((a, s) => a + s.lamports, 0n);
export const curveClaimLamports = (f: CreatorFees) => BigInt(f.bondingVaultLamports) + sumSweeps(f.curveSweeps);
export const poolClaimLamports = (f: CreatorFees) => BigInt(f.ammVaultLamports) + sumSweeps(f.poolSweeps);

export const sharedClaimLamports = (f: CreatorFees) => (f.shared ?? []).reduce((a, s) => a + s.shareLamports, 0n);
export const cashbackLamports = (f: CreatorFees) => (f.cashback?.pump ?? 0n) + (f.cashback?.amm ?? 0n);

// O que o app coleta: na Pump.fun, cofres + fee parada que ele varre + a parte desta carteira nas divisões + o
// cashback; na Meteora DBC, a fee em SOL dos pools em que ela é creator; no LaunchLab, o cofre em WSOL dela. A parte
// que ele não coleta (unswept*, sharedOther, dbc.other, launchlab.other) fica fora.
export function totalCreatorFeeLamports(f: CreatorFees): bigint {
  return curveClaimLamports(f) + poolClaimLamports(f) + sharedClaimLamports(f) + cashbackLamports(f) + dbcClaimLamports(f.dbc) + launchlabClaimLamports(f.launchlab);
}

// ---------- carteira completa ----------

export type WalletScan = {
  index: number;
  address: string;
  lamports: number;
  tokens: TokenAccount[];
  fees: CreatorFees | null;
  errors: string[]; // falhas parciais: o resto da carteira continua valendo
};

// detailedFees: procurar também a fee "não varrida" dentro de cada moeda. Desde 07/10/2026 as trocas novas
// da Pump.fun (buy_v3/sell_v3) deixam a fee do criador parada na curva, e o cofre não cresce: sem esta busca
// o app perderia a creator fee das moedas negociadas daqui em diante. Custo: 1 getProgramAccounts (10
// créditos do Helius) por carteira, +1 só se alguma moeda migrou para o PumpSwap, +2 por moeda com fee parada.
// volume: a rodada de leitura das contas de volume (a janela do incentivo é lida uma vez por rodada; scanWallets cria)
export type ScanOptions = { rentExemptZero: number; detailedFees: boolean; volume?: VolumeContext };
// a mesma janela do incentivo para todas as carteiras da rodada
const withVolume = (opts: ScanOptions): ScanOptions => (opts.volume ? opts : { ...opts, volume: {} });

// o que o app e o limpar leem (um lugar só)
export function cleanupScanOptions(rentExemptZero: number): ScanOptions {
  return { rentExemptZero, detailedFees: true };
}

export async function scanWallet(rpc: RpcClient, w: { index: number; address: string }, opts: ScanOptions, prefetched?: Basics): Promise<WalletScan> {
  const scan: WalletScan = { index: w.index, address: w.address, lamports: 0, tokens: [], fees: null, errors: [] };
  const basics = prefetched ?? (await readBasics(rpc, [w.address], opts.rentExemptZero)).get(w.address)!;
  const step = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (isStop(e)) throw e; // "Parar": a frase cai inteira (nunca "pronta" pela metade)
      scan.errors.push(`${label}: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
    }
  };
  await step('saldo SOL', async () => {
    if (basics.balanceError) throw new Error(basics.balanceError);
    scan.lamports = basics.lamports;
  });
  await step('contas de token', async () => {
    scan.tokens = await tokenAccounts(rpc, w.address);
  });
  await step('creator fees', async () => {
    // mints das contas de token da carteira: o sharing config de cada um pode ter esta carteira como participante
    scan.fees = await creatorFees(rpc, w.address, basics, opts.detailedFees, scan.tokens.map((t) => t.mint), opts.rentExemptZero, opts.volume ?? {});
  });
  return scan;
}

// Só o saldo de SOL, 100 por consulta. Serve para achar a pagadora sem ler tudo de cada carteira
// (aprendido no 1º teste: com --somente, ler 100 carteiras inteiras para limpar uma era lento).
export async function balancesOnly(rpc: RpcClient, wallets: Array<{ index: number; address: string }>): Promise<WalletScan[]> {
  const out: WalletScan[] = [];
  for (let i = 0; i < wallets.length; i += 100) {
    const chunk = wallets.slice(i, i + 100);
    try {
      const r = await rpc.call<{ value?: Array<{ lamports?: unknown } | null> }>('getMultipleAccounts', [
        chunk.map((w) => w.address),
        { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
      ]);
      chunk.forEach((w, k) => {
        const l = lamportsOrNull(r?.value?.[k]?.lamports);
        out.push({ ...w, lamports: l ?? 0, tokens: [], fees: null, errors: l !== null || r?.value?.[k] === null ? [] : ['saldo fora do formato'] });
      });
    } catch (e) {
      for (const w of chunk) out.push({ ...w, lamports: 0, tokens: [], fees: null, errors: [`saldo SOL: ${e instanceof Error ? e.message : 'erro'}`] });
    }
  }
  return out;
}

// O que ficou sem ler numa carteira (lista vazia = lida inteira). A fee parada, a dividida e o cashback contam:
// sem elas, uma creator fee passaria sem a pessoa saber.
export function unreadParts(s: WalletScan): string[] {
  const f = s.fees;
  const out = [...s.errors];
  if (f?.unsweptError) out.push(`fee parada nas moedas: ${f.unsweptError}`);
  if (f?.sharedError) out.push(`fee dividida: ${f.sharedError}`);
  if (f?.cashbackError) out.push(`cashback: ${f.cashbackError}`);
  if (f?.dbcError) out.push(`fee da Meteora: ${f.dbcError}`);
  if (f?.launchlabError) out.push(`fee do LaunchLab: ${f.launchlabError}`);
  return out;
}

export type RereadOptions = {
  sleep?: (ms: number) => Promise<void>;
  // antes de cada nova rodada: quantas carteiras ainda estão incompletas e qual rodada (1, 2…)
  onReread?: (pending: number, round: number) => void;
};

// Lê de novo, só as incompletas, até todas ficarem completas ou acabarem as esperas de REREAD_WAITS_MS. Fica a
// leitura com menos partes sem ler (nunca troca uma leitura melhor por uma pior). Devolve a lista na mesma ordem.
export async function rereadIncomplete(rpc: RpcClient, scans: WalletScan[], opts: ScanOptions, ro: RereadOptions = {}): Promise<WalletScan[]> {
  opts = withVolume(opts);
  const out = [...scans];
  const sleep = ro.sleep ?? defaultSleep;
  for (let round = 0; round < REREAD_WAITS_MS.length; round++) {
    const pending = out.map((s, i) => [s, i] as const).filter(([s]) => unreadParts(s).length);
    if (!pending.length) break;
    ro.onReread?.(pending.length, round + 1);
    await sleep(REREAD_WAITS_MS[round]);
    for (const [s, i] of pending) {
      const again = await scanWallet(rpc, s, opts);
      if (unreadParts(again).length <= unreadParts(s).length) out[i] = again;
    }
  }
  return out;
}

export async function scanWallets(
  rpc: RpcClient,
  wallets: Array<{ index: number; address: string }>,
  opts: ScanOptions,
  // done = carteiras lidas até agora; wallet = a que acabou de ser lida (a tela mostra o rótulo dela em "Agora:")
  onProgress?: (done: number, total: number, wallet: { index: number; address: string }) => void,
  ro: RereadOptions = {},
): Promise<WalletScan[]> {
  opts = withVolume(opts);
  const results: WalletScan[] = [];
  const basics = await readBasics(rpc, wallets.map((w) => w.address), opts.rentExemptZero);
  const concurrency = 4;
  let next = 0;
  async function worker() {
    while (next < wallets.length) {
      const w = wallets[next++];
      results.push(await scanWallet(rpc, w, opts, basics.get(w.address)));
      onProgress?.(results.length, wallets.length, { index: w.index, address: w.address });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, wallets.length) }, worker));
  // "não sei" nunca vira "vazio": quem ficou pela metade é lido de novo antes de a análise terminar
  return rereadIncomplete(rpc, results.sort((a, b) => a.index - b.index), opts, ro);
}
