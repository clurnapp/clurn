// Moeda da Pump.fun identificada pela própria rede: toda moeda criada lá tem a conta BondingCurve no PDA
// ["bonding-curve", mint]. Não depende do sufixo "pump" (nem toda moeda tem) nem da API de preços (que pode
// não indexar a moeda, estar fora do ar ou no limite). Enquanto a moeda não migra, as reservas virtuais da
// curva dão o preço em SOL; depois que migra para o PumpSwap, as reservas do pool canônico. Só leitura.

import { decodeBase58, encodeBase58, isAddress } from '../solana/base58.ts';
import { PROGRAMS, WSOL_MINT, findProgramAddress } from '../solana/pda.ts';
import type { RpcClient } from '../solana/rpc.ts';

// BondingCurve (IDL 639b87fb): virtual_token_reserves 8, virtual_quote_reserves 16, complete 48, quote_mint 83.
// Lido do 8 ao 115.
export const QUOTE_SLICE = { offset: 8, length: 107 };
export const CURVES_PER_CALL = 100; // limite do getMultipleAccounts

export type CurveQuote = {
  complete: boolean; // migrou para o PumpSwap: a curva não dá mais o preço
  solQuoted: boolean; // moeda em SOL (quote_mint zero = layout antigo, ou wSOL); em outro token a curva não dá preço em SOL
  virtualTokens: bigint;
  virtualSol: bigint; // lamports
  // só para moeda migrada em SOL, com o pool canônico lido e conferido: reservas do pool (unidades do token, lamports)
  poolTokens?: bigint;
  poolSol?: bigint;
};

const WSOL_BYTES = decodeBase58(WSOL_MINT);
const ZERO_KEY = new Uint8Array(32);
const sameKey = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

export const curveAddress = (mint: string) => findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address;

// Pool canônico do PumpSwap (para onde a moeda migra): PDA ["pool", índice 0 em u16, pool-authority da moeda, mint,
// quote] no programa do PumpSwap; pool-authority = PDA ["pool-authority", mint] no programa da Pump.fun. Conferido
// contra o graduatedPool da Jupiter em 31/10/2026 (3 moedas: o endereço bate quando o quote é o da curva).
export function poolAddress(mint: string, quote = WSOL_MINT): string {
  const authority = findProgramAddress(['pool-authority', decodeBase58(mint)], PROGRAMS.pump).address;
  return findProgramAddress(['pool', new Uint8Array(2), decodeBase58(authority), decodeBase58(mint), decodeBase58(quote)], PROGRAMS.pumpAmm).address;
}
// Pool (IDL do PumpSwap): base_mint 43, quote_mint 75, pool_base_token_account 139, pool_quote_token_account 171.
export const POOL_SLICE = { offset: 43, length: 160 };
// Conta de token (SPL e Token-2022, mesmo começo): mint 0, amount 64.
export const TOKEN_ACC_SLICE = { offset: 0, length: 72 };

// `b` começa no byte 8 da conta. Campo que a conta não tem (layout antigo, mais curto) vale 0, como manda a doc.
export function parseCurveQuote(b: Buffer): CurveQuote {
  const at = (o: number) => o - QUOTE_SLICE.offset;
  const u64 = (o: number) => (b.length >= at(o) + 8 ? b.readBigUInt64LE(at(o)) : 0n);
  const quote = b.length >= at(83) + 32 ? b.subarray(at(83), at(83) + 32) : ZERO_KEY;
  return {
    complete: b[at(48)] === 1,
    solQuoted: sameKey(quote, ZERO_KEY) || sameKey(quote, WSOL_BYTES),
    virtualTokens: u64(8),
    virtualSol: u64(16),
  };
}

type Acc = { data?: unknown } | null;

// Lote que falha é lido de novo (RPC no limite passa em segundos). Antes ele era pulado em silêncio: as memecoins
// dele ficavam sem preço, iam para "manter" e o aluguel delas sumia do total, mudando de uma rodada para outra
// (dois testers, 01/11/2026: 390 carteiras, só 128 contas no total). Depois das tentativas, os mints do lote
// vão para `failed`: quem chama marca "consulta falhou", nunca "sem curva".
export const CURVE_READ_WAITS_MS = [2_000, 5_000, 10_000];
export type CurveReadOptions = { sleep?: (ms: number) => Promise<void>; failed?: Set<string> };
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function retried<T>(fn: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= CURVE_READ_WAITS_MS.length || (e as { code?: unknown } | null)?.code === 'stopped-by-user') throw e;
      await sleep(CURVE_READ_WAITS_MS[i]);
    }
  }
}

// Mint → curva, só para quem tem a conta. Item fora do formato é pulado: a moeda fica como estava (sem categoria
// pela rede e sem preço), nunca marcada errado. Lote que falha em todas as tentativas: mints em opts.failed.
export async function readCurves(rpc: RpcClient, mints: string[], opts: CurveReadOptions = {}): Promise<Map<string, CurveQuote>> {
  const sleep = opts.sleep ?? defaultSleep;
  const unique = [...new Set(mints.filter(isAddress))];
  const out = new Map<string, CurveQuote>();
  for (let i = 0; i < unique.length; i += CURVES_PER_CALL) {
    const chunk = unique.slice(i, i + CURVES_PER_CALL);
    let list: Acc[];
    try {
      list = await retried(async () => {
        const value = (await rpc.call<{ value?: unknown }>('getMultipleAccounts', [chunk.map(curveAddress), { encoding: 'base64', dataSlice: QUOTE_SLICE, commitment: 'confirmed' }]))?.value;
        // resposta sem a lista inteira também é falha do lote (lida de novo), não "nenhuma curva"
        if (!Array.isArray(value) || value.length !== chunk.length) throw new Error('getMultipleAccounts: resposta fora do formato');
        return value as Acc[];
      }, sleep);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'stopped-by-user') throw e;
      for (const m of chunk) opts.failed?.add(m);
      continue;
    }
    chunk.forEach((mint, k) => {
      const raw = Array.isArray(list[k]?.data) ? (list[k] as { data: unknown[] }).data[0] : null;
      if (typeof raw !== 'string') return;
      const b = Buffer.from(raw, 'base64');
      if (b.length === 0) return;
      out.set(mint, parseCurveQuote(b));
    });
  }
  await readPools(rpc, out, sleep, opts.failed);
  return out;
}

async function sliceOf(rpc: RpcClient, keys: string[], dataSlice: { offset: number; length: number }): Promise<Array<Buffer | null>> {
  const value = (await rpc.call<{ value?: unknown }>('getMultipleAccounts', [keys, { encoding: 'base64', dataSlice, commitment: 'confirmed' }]))?.value;
  const list = Array.isArray(value) ? (value as Acc[]) : [];
  if (list.length !== keys.length) throw new Error('resposta fora do formato');
  return list.map((acc) => {
    const raw = Array.isArray(acc?.data) ? (acc as { data: unknown[] }).data[0] : null;
    if (typeof raw !== 'string') return null;
    const b = Buffer.from(raw, 'base64');
    return b.length >= dataSlice.length ? b : null;
  });
}

// Moeda migrada em SOL: lê o pool canônico e as duas contas de reserva. Confere tudo (o pool é desta moeda e em SOL,
// cada reserva é do mint certo e maior que zero); qualquer coisa fora fica sem preço, nunca com preço errado.
// Lote que falha é lido de novo, como nas curvas; depois das tentativas, os mints dele vão para `failed`.
async function readPools(rpc: RpcClient, curves: Map<string, CurveQuote>, sleep: (ms: number) => Promise<void>, failed?: Set<string>): Promise<void> {
  const mints = [...curves].filter(([, c]) => c.complete && c.solQuoted).map(([m]) => m);
  for (let i = 0; i < mints.length; i += CURVES_PER_CALL / 2) {
    const chunk = mints.slice(i, i + CURVES_PER_CALL / 2); // 2 contas de reserva por pool cabem num getMultipleAccounts
    try {
      const pools = await retried(() => sliceOf(rpc, chunk.map((m) => poolAddress(m)), POOL_SLICE), sleep);
      const key = (b: Buffer, o: number) => encodeBase58(b.subarray(o - POOL_SLICE.offset, o - POOL_SLICE.offset + 32));
      const found: Array<{ mint: string; base: string; quote: string }> = [];
      chunk.forEach((mint, k) => {
        const b = pools[k];
        if (b && key(b, 43) === mint && key(b, 75) === WSOL_MINT) found.push({ mint, base: key(b, 139), quote: key(b, 171) });
      });
      if (!found.length) continue;
      const accs = await retried(() => sliceOf(rpc, found.flatMap((f) => [f.base, f.quote]), TOKEN_ACC_SLICE), sleep);
      found.forEach((f, k) => {
        const [b, q] = [accs[2 * k], accs[2 * k + 1]];
        if (!b || !q || encodeBase58(b.subarray(0, 32)) !== f.mint || encodeBase58(q.subarray(0, 32)) !== WSOL_MINT) return;
        const poolTokens = b.readBigUInt64LE(64);
        const poolSol = q.readBigUInt64LE(64);
        if (poolTokens > 0n && poolSol > 0n) Object.assign(curves.get(f.mint)!, { poolTokens, poolSol });
      });
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code === 'stopped-by-user') throw e;
      for (const m of chunk) failed?.add(m);
    }
  }
}
