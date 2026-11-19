// Informação dos tokens (nome, símbolo, preço, tipo) pela API pública da Jupiter, sem chave, completada pela
// própria rede para as moedas da Pump.fun (`applyCurves`). Sem preço = "valor desconhecido", nunca zero.

import { WSOL_MINT } from '../solana/pda.ts';
import type { CurveQuote } from './curve-price.ts';

const LAMPORTS_PER_SOL = 1_000_000_000;

export const TOKEN_API = 'https://lite-api.jup.ag/tokens/v2/search';
// Tentativas por lote, em cada passada. 429: cada uma espera a janela abrir (custa tempo, não erro). Rede caída,
// tempo esgotado ou 5xx: 2 s e 5 s. Lote que falhou em tudo ganha uma 2ª passada depois de uma janela inteira.
export const PRICE_ATTEMPTS = 6;
const NET_BACKOFF_MS = [2_000, 5_000];
// Limite medido em 31/10/2026 (sonda com mints públicos): 5 consultas por janela de 10 s por IP. A resposta traz
// x-ratelimit-remaining e x-ratelimit-reset (época, em segundos): com a janela esgotada, espera o reset antes do
// próximo lote; no 429 idem. Sem cabeçalho, espera a janela inteira. Antes: 10 lotes seguidos com espera de
// 1,5 s/3 s, dentro da mesma janela, e os lotes 6 a 10 morriam (rodada de 487 carteiras, 31/10/2026).
export const PRICE_WINDOW_MS = 10_000;
const PRICE_BATCH = 50;

export type TokenCategory = 'estável' | 'cripto conhecida' | 'memecoin Pump.fun' | 'outro' | 'desconhecido';

// usd: por token, pela Jupiter ou pela curva (com o preço do SOL); solPerToken: por token, só pela curva da Pump.fun
export type Price = { usd: number | null; liquidityUsd: number | null; solPerToken?: number | null };

// Valor de uma conta de token. UMA regra para todos os leitores (resumo, plano, revisão da Phantom, app, terminal).
export type TokenValue = { usd: number | null; sol: number | null };
export function tokenValue(prices: Map<string, Price>, t: { mint: string; amount: bigint; decimals: number; kind: string }): TokenValue {
  const p = t.kind === 'fungible' ? prices.get(t.mint) : undefined;
  if (!p) return { usd: null, sol: null };
  const units = Number(t.amount) / 10 ** t.decimals;
  return {
    usd: typeof p.usd === 'number' && Number.isFinite(p.usd) ? units * p.usd : null,
    sol: typeof p.solPerToken === 'number' && Number.isFinite(p.solPerToken) ? units * p.solPerToken : null,
  };
}

export type TokenInfo = {
  mint: string;
  symbol: string | null;
  name: string | null;
  price: Price | null;
  category: TokenCategory;
};

export type PriceResult = {
  prices: Map<string, Price>;
  info: Map<string, TokenInfo>;
  solUsd: number | null;
  errors: string[];
  // mints cujo lote falhou (limite ou API fora) e que a curva não precificou: "sem consulta", não "sem preço".
  // Valem como "valor desconhecido" (priceLookupFailed): queimar só com a palavra de confirmação, como sem preço.
  unresolved: Set<string>;
};

// Lista local: vale mesmo com a API fora do ar, para nunca tratar USDC & cia. como lixo.
// Endereços conferidos na API da Jupiter em 30/10/2026.
export const KNOWN_TOKENS: Record<string, { symbol: string; category: TokenCategory }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', category: 'estável' },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', category: 'estável' },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', category: 'estável' },
  So11111111111111111111111111111111111111112: { symbol: 'wSOL', category: 'cripto conhecida' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', category: 'cripto conhecida' },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: 'BONK', category: 'cripto conhecida' },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: 'WIF', category: 'cripto conhecida' },
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: { symbol: 'mSOL', category: 'cripto conhecida' },
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: { symbol: 'JitoSOL', category: 'cripto conhecida' },
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': { symbol: 'ETH', category: 'cripto conhecida' },
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: { symbol: 'cbBTC', category: 'cripto conhecida' },
};

type ApiToken = {
  id?: unknown;
  name?: unknown;
  symbol?: unknown;
  usdPrice?: unknown;
  liquidity?: unknown;
  launchpad?: unknown;
  isVerified?: unknown;
  tags?: unknown;
};

export function classify(mint: string, api: ApiToken | null): TokenCategory {
  const known = KNOWN_TOKENS[mint];
  if (known) return known.category;
  const tags = Array.isArray(api?.tags) ? api.tags : [];
  if (tags.includes('stable')) return 'estável';
  if (api?.launchpad === 'pump.fun' || mint.endsWith('pump')) return 'memecoin Pump.fun';
  if (api?.isVerified === true) return 'cripto conhecida';
  return api ? 'outro' : 'desconhecido';
}

// Nome e símbolo vêm de quem criou o token: tira caracteres de controle e de direção do texto,
// que poderiam reescrever o terminal ou disfarçar o nome.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;

export function sanitizeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const clean = v.replace(UNSAFE_CHARS, '').trim().slice(0, 40);
  return clean || null;
}

const str = sanitizeText;

// Token que usa o símbolo de um conhecido (ex.: "USDC") mas com outro endereço.
export function looksLikeImpostor(mint: string, symbol: string | null): boolean {
  if (!symbol || KNOWN_TOKENS[mint]) return false;
  const s = symbol.toUpperCase().replace(/^\$/, '');
  return Object.values(KNOWN_TOKENS).some((k) => k.symbol.toUpperCase() === s);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// quanto esperar até a janela da API abrir: pelo x-ratelimit-reset (época em s), senão retry-after, senão a janela
export function windowWait(headers: Headers, now = Date.now()): number {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    const ms = reset * 1000 - now + 500;
    if (ms > 0 && ms <= 6 * PRICE_WINDOW_MS) return ms;
  }
  const retry = Number(headers.get('retry-after'));
  if (Number.isFinite(retry) && retry > 0 && retry <= 60) return retry * 1000;
  return PRICE_WINDOW_MS;
}

// Uma fila por função de fetch (a global, no app): duas consultas seguidas (análise + "analisar de novo") não
// disputam a mesma janela, e a espera que uma deixou vale para a próxima.
type Gate = { chain: Promise<unknown>; opensAt: number };
const gates = new WeakMap<object, Gate>();
function gateOf(f: object): Gate {
  let g = gates.get(f);
  if (!g) gates.set(f, (g = { chain: Promise.resolve(), opensAt: 0 }));
  return g;
}

export function fetchPrices(mints: string[], fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = defaultSleep): Promise<PriceResult> {
  const g = gateOf(fetchImpl);
  const run = g.chain.then(() => fetchPricesNow(mints, fetchImpl, sleep, g));
  g.chain = run.catch(() => {});
  return run;
}

async function fetchPricesNow(mints: string[], fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>, g: Gate): Promise<PriceResult> {
  const unique = [...new Set([WSOL_MINT, ...mints])]; // o preço do SOL no primeiro lote, o que mais passa
  const prices = new Map<string, Price>();
  const info = new Map<string, TokenInfo>();
  const errors: string[] = [];
  const unresolved = new Set<string>();
  const fromApi = new Map<string, ApiToken>();
  const closeWindow = (h: Headers) => {
    g.opensAt = Math.max(g.opensAt, Date.now() + windowWait(h));
  };

  // um lote: null = deu certo; texto = motivo da falha depois das tentativas
  async function batch(ids: string[]): Promise<string | null> {
    let limited = 0;
    let other = 0;
    for (;;) {
      const wait = g.opensAt - Date.now();
      if (wait > 0) await sleep(wait);
      let res: Response;
      try {
        res = await fetchImpl(`${TOKEN_API}?query=${ids.join(',')}`, { signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        if (other < NET_BACKOFF_MS.length) {
          await sleep(NET_BACKOFF_MS[other++]);
          continue;
        }
        return e instanceof Error ? e.message : 'erro';
      }
      if (res.status === 429) {
        closeWindow(res.headers);
        if (++limited < PRICE_ATTEMPTS) continue;
        return 'HTTP 429';
      }
      if (res.status >= 500 && other < NET_BACKOFF_MS.length) {
        await sleep(NET_BACKOFF_MS[other++]);
        continue;
      }
      if (!res.ok) return `HTTP ${res.status}`;
      if (res.headers.get('x-ratelimit-remaining') === '0') closeWindow(res.headers); // janela esgotada: o próximo espera o reset
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return 'resposta fora do formato';
      }
      for (const t of Array.isArray(body) ? (body as ApiToken[]) : []) {
        if (t && typeof t.id === 'string' && ids.includes(t.id) && !fromApi.has(t.id)) fromApi.set(t.id, t);
      }
      return null;
    }
  }

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += PRICE_BATCH) batches.push(unique.slice(i, i + PRICE_BATCH));
  let failed: Array<{ n: number; ids: string[] }> = [];
  for (const [k, ids] of batches.entries()) {
    if ((await batch(ids)) !== null) failed.push({ n: k + 1, ids });
  }
  if (failed.length) {
    // 2ª passada: depois de uma janela inteira (limite de outra consulta no mesmo IP, tropeço da API)
    g.opensAt = Math.max(g.opensAt, Date.now() + PRICE_WINDOW_MS);
    const again = failed;
    failed = [];
    for (const f of again) {
      const why = await batch(f.ids);
      if (why === null) continue;
      errors.push(`informação de tokens (lote ${f.n}): ${why}; esses tokens ficam com valor desconhecido`);
      for (const id of f.ids) unresolved.add(id);
    }
  }

  for (const mint of unique) {
    const t = fromApi.get(mint) ?? null;
    let price: Price | null = null;
    if (t && typeof t.usdPrice === 'number' && Number.isFinite(t.usdPrice) && t.usdPrice >= 0) {
      price = { usd: t.usdPrice, liquidityUsd: typeof t.liquidity === 'number' ? t.liquidity : null };
      prices.set(mint, price);
    }
    info.set(mint, {
      mint,
      symbol: str(t?.symbol) ?? KNOWN_TOKENS[mint]?.symbol ?? null,
      name: str(t?.name),
      price,
      category: classify(mint, t),
    });
  }
  return { prices, info, solUsd: prices.get(WSOL_MINT)?.usd ?? null, errors, unresolved };
}

// Completa o resultado da API com o que a rede diz (curvas lidas por `readCurves`):
// - mint com curva é "memecoin Pump.fun", tenha ou não o sufixo "pump", esteja ou não na Jupiter;
// - moeda ainda na curva e em SOL tem preço pelas reservas virtuais (o que a curva paga hoje), que vale mais
//   que o da Jupiter (pode estar parado); em dólar só com o preço do SOL;
// - moeda migrada em SOL sem preço da Jupiter (fora do ar, no limite ou sem a moeda) tem preço pelas reservas do
//   pool canônico do PumpSwap; com preço da Jupiter, fica o dela;
// - moeda pareada em outro token fica com o preço da Jupiter (ou sem preço).
// As decimais vêm das contas de token lidas; mint sem decimais conhecidas fica só com a categoria.
export function applyCurves(r: PriceResult, curves: Map<string, CurveQuote>, tokens: Array<{ mint: string; decimals: number }>): void {
  const decimals = new Map(tokens.map((t) => [t.mint, t.decimals]));
  for (const [mint, c] of curves) {
    const cur = r.info.get(mint);
    if (!KNOWN_TOKENS[mint]) r.info.set(mint, { ...(cur ?? { mint, symbol: null, name: null, price: null }), category: 'memecoin Pump.fun' });
    const dec = decimals.get(mint);
    // na curva: reservas virtuais; migrada: reservas do pool canônico do PumpSwap (readCurves já conferiu o pool)
    const [tokens, sol] = !c.complete ? [c.virtualTokens, c.virtualSol] : [c.poolTokens ?? 0n, c.poolSol ?? 0n];
    if (!c.solQuoted || tokens <= 0n || dec === undefined) continue;
    // migrada com preço da Jupiter: fica o da Jupiter. Pool pequeno sai mais barato (31/10/2026: pool ÷ Jupiter com
    // mediana 0,89 e mínimo 0,05 em pools de ~1 SOL), e preço baixo demais empurraria para queimar o que vale.
    if (c.complete && r.prices.get(mint)?.usd != null) continue;
    // preço marginal: (SOL ÷ tokens) por token inteiro
    const solPerToken = (Number(sol) / LAMPORTS_PER_SOL / Number(tokens)) * 10 ** dec;
    if (!Number.isFinite(solPerToken)) continue;
    const price: Price = { usd: r.solUsd === null ? null : solPerToken * r.solUsd, liquidityUsd: null, solPerToken };
    r.prices.set(mint, price);
    r.unresolved.delete(mint); // a rede disse o que vale: não depende mais da consulta que falhou
    const i = r.info.get(mint);
    if (i) i.price = price;
  }
}
