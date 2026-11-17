// Creator fee da Meteora DBC (Dynamic Bonding Curve: base de Bags, Jupiter Studio, Believe e outros launchpads).
// SÓ LEITURA: acha os pools em que a carteira é `creator` e quanto de fee em SOL dá para coletar. Quem coleta é o
// executor (passo claim-dbc). Fonte: IDL 0.2.2 do SDK oficial e código do programa 0.2.3 (commit d231832, 05/11/2026),
// conferidos em 09/11/2026 (docs/meteora-dbc.md). Se o layout mudar, o pool lido fica fora do formato e a leitura
// daquela carteira vira "não sei" (nunca "vazio").

import { encodeBase58, isAddress } from '../solana/base58.ts';
import { anchorAccountDiscriminator, PROGRAMS, WSOL_MINT } from '../solana/pda.ts';
import type { RpcClient } from '../solana/rpc.ts';

// VirtualPool (bytemuck, repr C): 8 do discriminador + 416 de PoolState = 424 bytes. TransferHookPool tem o mesmo
// tamanho e outro discriminador; a coleta dele exige claim_creator_trading_fee2, que o app não usa (fica fora, com aviso).
export const DBC_POOL_BYTES = 424;
export const DBC_VIRTUAL_POOL_DISC = anchorAccountDiscriminator('VirtualPool'); // [213,224,5,209,98,69,119,92]
export const DBC_TRANSFER_HOOK_POOL_DISC = anchorAccountDiscriminator('TransferHookPool');
export const DBC_CONFIG_DISC = anchorAccountDiscriminator('PoolConfig'); // [26,108,14,123,116,230,129,43]
// offsets com os 8 do discriminador
export const DBC_OFFSETS = { config: 72, creator: 104, baseMint: 136, baseVault: 168, quoteVault: 200, poolType: 304, isMigrated: 305, creatorBaseFee: 352, creatorQuoteFee: 360 } as const;
// PoolConfig: quote_mint logo depois do discriminador
export const DBC_CONFIG_SLICE = { offset: 0, length: 40 };
// 1ª consulta: só as duas fees do criador (16 bytes por pool). Uma carteira-robô tinha 175.991 pools (mainnet,
// 09/11/2026): ler o pool inteiro de todos seria ~100 MB. Só o pool com fee é lido inteiro depois.
export const DBC_FEE_SLICE = { offset: DBC_OFFSETS.creatorBaseFee, length: 16 };
// Pools com fee lidos por carteira (os de maior fee em SOL primeiro). O resto fica fora, contado (`cut`), com aviso.
export const DBC_MAX_FEE_POOLS = 300;

export type DbcPool = {
  pool: string;
  config: string;
  baseMint: string;
  baseVault: string;
  quoteVault: string;
  baseTokenProgram: string; // pool_type 0 = Token, 1 = Token-2022 (o programa confere contra o base_vault)
  migrated: boolean; // a coleta não depende disso (o handler não confere is_migrated): informativo
  quoteFee: bigint; // creator_quote_fee em lamports (WSOL)
};

export type DbcFees = {
  pools: DbcPool[]; // pools em SOL com fee a coletar
  found: number; // pools em que a carteira é creator (com ou sem fee)
  // pools com fee que o app NÃO coleta: fee na moeda (base), quote em outro token, pool com transfer hook
  other: number;
  cut: number; // pools com fee além de DBC_MAX_FEE_POOLS (não lidos)
};

export type ParsedDbcPool = {
  hook: boolean;
  config: string;
  creator: string;
  baseMint: string;
  baseVault: string;
  quoteVault: string;
  poolType: number;
  migrated: boolean;
  baseFee: bigint;
  quoteFee: bigint;
};

const key = (b: Buffer, at: number) => encodeBase58(b.subarray(at, at + 32));

// Pool inteiro (424 bytes, do discriminador em diante). null = não é pool da DBC (tamanho ou discriminador);
// pool_type fora de 0/1 também é null: o app não sabe qual programa de token a moeda usa.
export function parseDbcPool(b: Buffer): ParsedDbcPool | null {
  if (b.length !== DBC_POOL_BYTES) return null;
  const disc = b.subarray(0, 8);
  const hook = disc.equals(DBC_TRANSFER_HOOK_POOL_DISC);
  if (!hook && !disc.equals(DBC_VIRTUAL_POOL_DISC)) return null;
  const poolType = b[DBC_OFFSETS.poolType];
  if (poolType !== 0 && poolType !== 1) return null;
  return {
    hook,
    config: key(b, DBC_OFFSETS.config),
    creator: key(b, DBC_OFFSETS.creator),
    baseMint: key(b, DBC_OFFSETS.baseMint),
    baseVault: key(b, DBC_OFFSETS.baseVault),
    quoteVault: key(b, DBC_OFFSETS.quoteVault),
    poolType,
    migrated: b[DBC_OFFSETS.isMigrated] !== 0,
    baseFee: b.readBigUInt64LE(DBC_OFFSETS.creatorBaseFee),
    quoteFee: b.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee),
  };
}

// PoolConfig (fatia 0..40): quote_mint. null = não é config da DBC.
export function parseDbcConfigQuote(b: Buffer): string | null {
  if (b.length < DBC_CONFIG_SLICE.length || !b.subarray(0, 8).equals(DBC_CONFIG_DISC)) return null;
  return key(b, 8);
}

export const dbcBaseTokenProgram = (poolType: number) => (poolType === 1 ? PROGRAMS.token2022 : PROGRAMS.token);

type RawAcc = { owner?: unknown; data?: unknown[] } | null;

// Contas inteiras com o dono (getMultipleAccounts, 100 por consulta). Resposta sem a lista do tamanho pedido = erro.
async function accountsWithOwner(rpc: RpcClient, keys: string[], slice?: { offset: number; length: number }): Promise<Array<{ owner: string; data: Buffer } | null>> {
  const out: Array<{ owner: string; data: Buffer } | null> = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value?: RawAcc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed', ...(slice ? { dataSlice: slice } : {}) }]);
    if (!Array.isArray(r?.value) || r.value.length !== chunk.length) throw new Error('getMultipleAccounts (Meteora): resposta fora do formato');
    for (const a of r.value) {
      if (a === null) {
        out.push(null);
        continue;
      }
      const raw = a?.data?.[0];
      if (typeof raw !== 'string' || typeof a?.owner !== 'string') throw new Error('getMultipleAccounts (Meteora): conta fora do formato');
      out.push({ owner: a.owner, data: Buffer.from(raw, 'base64') });
    }
  }
  return out;
}

// Releitura dos pools (executor, antes de montar a coleta): pool que sumiu, mudou de dono ou não é mais DBC = null.
export async function readDbcPools(rpc: RpcClient, pools: string[]): Promise<Array<ParsedDbcPool | null>> {
  const accs = await accountsWithOwner(rpc, pools);
  return accs.map((a) => (a && a.owner === PROGRAMS.meteoraDbc ? parseDbcPool(a.data) : null));
}

type Gpa = Array<{ pubkey?: unknown; account?: { data?: unknown[]; owner?: unknown } }>;

// Pools da DBC em que `wallet` é o creator, com a fee em SOL a coletar.
// 1) getProgramAccounts (dataSize 424, creator no offset 104), só as duas fees: acha os pools com fee.
// 2) getMultipleAccounts dos pools com fee (inteiros): confere dono, tamanho, discriminador e creator, de novo.
// 3) getMultipleAccounts das configs (quote_mint): só fee em WSOL é coletada; o resto conta em `other`.
// Erro de consulta ou resposta fora do formato lança (o scan marca "fee da Meteora: não lida"). Item da lista com pubkey
// ou dado ruim também lança: sem saber a fee dele, a carteira ficaria contada como sem fee.
export async function dbcFees(rpc: RpcClient, wallet: string): Promise<DbcFees> {
  const gpa = await rpc.call<Gpa>('getProgramAccounts', [
    PROGRAMS.meteoraDbc,
    { encoding: 'base64', dataSlice: DBC_FEE_SLICE, filters: [{ dataSize: DBC_POOL_BYTES }, { memcmp: { offset: DBC_OFFSETS.creator, bytes: wallet } }] },
  ]);
  if (!Array.isArray(gpa)) throw new Error('getProgramAccounts (Meteora): resposta fora do formato');
  // chave = endereço do pool: o RPC repetir o mesmo pool não soma a fee duas vezes
  const withFee = new Map<string, bigint>();
  const all = new Set<string>();
  for (const a of gpa) {
    const raw = a?.account?.data?.[0];
    if (typeof a?.pubkey !== 'string' || !isAddress(a.pubkey) || typeof raw !== 'string') throw new Error('getProgramAccounts (Meteora): pool fora do formato');
    if (typeof a.account?.owner === 'string' && a.account.owner !== PROGRAMS.meteoraDbc) continue; // conta de outro programa: não é pool
    const d = Buffer.from(raw, 'base64');
    if (d.length !== DBC_FEE_SLICE.length) throw new Error('getProgramAccounts (Meteora): fee fora do formato');
    all.add(a.pubkey);
    const base = d.readBigUInt64LE(0);
    const quote = d.readBigUInt64LE(8);
    if (base > 0n || quote > 0n) withFee.set(a.pubkey, quote > 0n ? quote : 0n);
  }
  const ranked = [...withFee].sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([k]) => k);
  const read = ranked.slice(0, DBC_MAX_FEE_POOLS);
  const out: DbcFees = { pools: [], found: all.size, other: 0, cut: ranked.length - read.length };
  if (!read.length) return out;

  const accs = await accountsWithOwner(rpc, read);
  const mine: Array<{ pool: string; p: ParsedDbcPool }> = [];
  accs.forEach((a, i) => {
    if (!a) return; // sumiu entre as consultas: fica de fora
    const p = a.owner === PROGRAMS.meteoraDbc ? parseDbcPool(a.data) : null;
    // existe, mas fora do formato conhecido (dono, tamanho, discriminador ou pool_type novo): "não sei", nunca "sem fee"
    if (!p) throw new Error('pool da Meteora fora do formato');
    if (p.creator !== wallet) return; // o creator é conferido de novo: pool de outra carteira fica de fora
    if (p.hook) {
      if (p.baseFee > 0n || p.quoteFee > 0n) out.other++;
      return;
    }
    mine.push({ pool: read[i], p });
  });
  const configs = [...new Set(mine.map((m) => m.p.config))];
  const cfgAccs = configs.length ? await accountsWithOwner(rpc, configs, DBC_CONFIG_SLICE) : [];
  const quoteOf = new Map<string, string>();
  cfgAccs.forEach((c, i) => {
    const q = c && c.owner === PROGRAMS.meteoraDbc ? parseDbcConfigQuote(c.data) : null;
    // sem a config, não dá para saber em que moeda está a fee: "não sei", não "outra moeda"
    if (!q) throw new Error('config da Meteora fora do formato');
    quoteOf.set(configs[i], q);
  });
  for (const { pool, p } of mine) {
    const sol = quoteOf.get(p.config) === WSOL_MINT;
    // fee na moeda (base) ou em outro token: o app só coleta SOL; conta o pool uma vez
    if (p.baseFee > 0n || (!sol && p.quoteFee > 0n)) out.other++;
    if (sol && p.quoteFee > 0n) {
      out.pools.push({ pool, config: p.config, baseMint: p.baseMint, baseVault: p.baseVault, quoteVault: p.quoteVault, baseTokenProgram: dbcBaseTokenProgram(p.poolType), migrated: p.migrated, quoteFee: p.quoteFee });
    }
  }
  return out;
}

export const dbcClaimLamports = (d: DbcFees | undefined) => (d?.pools ?? []).reduce((a, p) => a + p.quoteFee, 0n);
