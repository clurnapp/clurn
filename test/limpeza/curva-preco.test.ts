import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCurves, fetchPrices, PRICE_ATTEMPTS, PRICE_WINDOW_MS, tokenValue, windowWait, type Price, type PriceResult, type TokenCategory } from '../../src/core/limpeza/prices.ts';
import { CURVE_READ_WAITS_MS, CURVES_PER_CALL, parseCurveQuote, poolAddress, QUOTE_SLICE, readCurves, type CurveQuote } from '../../src/core/limpeza/curve-price.ts';
import { burnNeedsExtraConfirmation, priceLookupFailed, inBurnAll, recommend, VALUABLE_SOL } from '../../src/core/limpeza/recommend.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';
import { findProgramAddress, PROGRAMS, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';

// Moedas da Pump.fun identificadas pela própria rede (conta BondingCurve), não pelo sufixo "pump" nem pela Jupiter.
// Caso real (nov/2025, carteira de um amigo): moedas da Pump.fun ficaram em "Manter" como "origem e valor incertos".

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SEMSUFIXO = '2gTbp2gwH46rqExzabSyrdR3294SLwCp2rSqWDS6Sim1'; // moeda real da Pump.fun sem o sufixo "pump" (31/10/2026)
const COMSUFIXO = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const OUTRA = 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5';
const curveOf = (mint: string) => findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address;

// conta BondingCurve inteira (166 bytes, IDL 639b87fb): reservas virtuais 8 e 16, complete 48, quote_mint 83
function curveAccount(o: { vt: bigint; vq: bigint; complete?: boolean; quote?: string; length?: number }): Buffer {
  const b = Buffer.alloc(o.length ?? 166);
  if (b.length >= 24) {
    b.writeBigUInt64LE(o.vt, 8);
    b.writeBigUInt64LE(o.vq, 16);
  }
  if (b.length > 48) b[48] = o.complete ? 1 : 0;
  if (o.quote && b.length >= 115) Buffer.from(decodeBase58(o.quote)).copy(b, 83);
  return b;
}

type Acc = { data?: unknown; lamports?: number } | null;
function curveRpc(accounts: Record<string, Buffer | Acc>, opts: { failBatch?: number } = {}) {
  const calls: unknown[][] = [];
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      assert.equal(method, 'getMultipleAccounts');
      calls.push(params);
      if (opts.failBatch === calls.length) throw new RpcError('nó fora do ar');
      const [keys, cfg] = params as [string[], { encoding: string; dataSlice: { offset: number; length: number } }];
      assert.equal(cfg.encoding, 'base64');
      return {
        value: keys.map((k) => {
          const a = accounts[k];
          if (a === undefined) return null;
          if (!Buffer.isBuffer(a)) return a;
          return { lamports: 1, data: [a.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length).toString('base64'), 'base64'] };
        }),
      } as T;
    },
  };
  return { rpc, calls };
}

test('curva: lê a BondingCurve de cada mint em lotes, pelo PDA; conta ausente ou sem dados não é moeda da Pump.fun', async () => {
  const curva = curveAccount({ vt: 1_000_000_000_000_000n, vq: 30_000_000_000n });
  const migrada = curveAccount({ vt: 0n, vq: 0n, complete: true });
  const { rpc, calls } = curveRpc({
    [curveOf(SEMSUFIXO)]: curva,
    [curveOf(COMSUFIXO)]: migrada,
    [curveOf(OUTRA)]: { lamports: 5 }, // como os RPCs falsos do app devolvem: sem `data`
  });
  const many = Array.from({ length: CURVES_PER_CALL + 1 }, (_, i) => findProgramAddress([`M${i}`], PROGRAMS.pump).address);
  const r = await readCurves(rpc, [SEMSUFIXO, COMSUFIXO, OUTRA, USDC, SEMSUFIXO, ...many]);
  const curveCalls = calls.filter((c) => JSON.stringify((c[1] as { dataSlice: unknown }).dataSlice) === JSON.stringify(QUOTE_SLICE));
  assert.equal(curveCalls.length, 2, 'lotes de CURVES_PER_CALL, sem repetir mint');
  assert.equal((calls[0][0] as string[]).length, CURVES_PER_CALL);
  assert.equal((calls[0][0] as string[])[0], curveOf(SEMSUFIXO), 'pede o PDA da curva, não o mint');
  assert.deepEqual(r.get(SEMSUFIXO), { complete: false, solQuoted: true, virtualTokens: 1_000_000_000_000_000n, virtualSol: 30_000_000_000n });
  assert.equal(r.get(COMSUFIXO)?.complete, true);
  assert.equal(r.has(OUTRA), false);
  assert.equal(r.has(USDC), false);
});

test('curva: lote que falha ou item fora do formato não derruba os outros nem marca ninguém como Pump.fun', async () => {
  const curva = curveAccount({ vt: 10n, vq: 10n });
  const { rpc } = curveRpc({ [curveOf(SEMSUFIXO)]: curva, [curveOf(COMSUFIXO)]: { data: 'não é lista' }, [curveOf(OUTRA)]: { data: ['%%%', 'base64'] } }, { failBatch: 2 });
  const second = Array.from({ length: CURVES_PER_CALL }, (_, i) => findProgramAddress([`N${i}`], PROGRAMS.pump).address);
  const r = await readCurves(rpc, [SEMSUFIXO, COMSUFIXO, OUTRA, ...second], { sleep: async () => {} });
  assert.deepEqual([...r.keys()], [SEMSUFIXO]);
});

// dois testers (01/11/2026): lote pulado em silêncio deixava as memecoins sem preço, em "manter", fora do total
test('curva: lote que falha uma vez é lido de novo e as moedas dele têm preço', async () => {
  const curva = curveAccount({ vt: 10n, vq: 10n });
  const first = Array.from({ length: CURVES_PER_CALL }, (_, i) => findProgramAddress([`P${i}`], PROGRAMS.pump).address);
  const { rpc, calls } = curveRpc({ [curveOf(SEMSUFIXO)]: curva }, { failBatch: 2 });
  const waits: number[] = [];
  const failed = new Set<string>();
  const r = await readCurves(rpc, [...first, SEMSUFIXO], { sleep: async (ms) => { waits.push(ms); }, failed });
  assert.equal(r.has(SEMSUFIXO), true, 'a moeda do lote que falhou foi lida na nova tentativa');
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [CURVE_READ_WAITS_MS[0]]);
  assert.equal(failed.size, 0);
});

test('curva: lote que falha em todas as tentativas devolve os mints em failed (nunca "sem curva" calado)', async () => {
  const calls: number[] = [];
  const rpc: RpcClient = {
    async call<T>(): Promise<T> {
      calls.push(1);
      throw new RpcError('HTTP 429');
    },
  } as RpcClient;
  const failed = new Set<string>();
  const r = await readCurves(rpc, [SEMSUFIXO, COMSUFIXO, USDC], { sleep: async () => {}, failed });
  assert.equal(r.size, 0);
  assert.equal(calls.length, CURVE_READ_WAITS_MS.length + 1);
  assert.deepEqual([...failed].sort(), [SEMSUFIXO, COMSUFIXO, USDC].sort());
});

test('curva: resposta com a lista cortada é falha do lote (lida de novo), não "nenhuma curva"', async () => {
  const curva = curveAccount({ vt: 10n, vq: 10n });
  let n = 0;
  const { rpc: good } = curveRpc({ [curveOf(SEMSUFIXO)]: curva });
  const rpc: RpcClient = { async call<T>(m: string, p: unknown[]): Promise<T> { if (++n === 1) return { value: [] } as T; return good.call<T>(m, p); } } as RpcClient;
  const r = await readCurves(rpc, [SEMSUFIXO], { sleep: async () => {} });
  assert.equal(r.has(SEMSUFIXO), true);
});

test('curva: quote_mint zero (layout antigo) ou wSOL é moeda em SOL; outro quote não tem preço pela curva', () => {
  const slice = (b: Buffer) => b.subarray(QUOTE_SLICE.offset, QUOTE_SLICE.offset + QUOTE_SLICE.length);
  assert.equal(parseCurveQuote(slice(curveAccount({ vt: 1n, vq: 1n }))).solQuoted, true, 'zero');
  assert.equal(parseCurveQuote(slice(curveAccount({ vt: 1n, vq: 1n, quote: WSOL_MINT }))).solQuoted, true, 'wSOL');
  assert.equal(parseCurveQuote(slice(curveAccount({ vt: 1n, vq: 1n, quote: USDC }))).solQuoted, false, 'USDC');
  assert.equal(parseCurveQuote(slice(curveAccount({ vt: 1n, vq: 1n, length: 81 }))).solQuoted, true, 'curva curta, antes do campo quote_mint');
  assert.equal(parseCurveQuote(slice(curveAccount({ vt: 1n, vq: 1n, length: 20 }))).virtualSol, 0n, 'buffer curto não lança');
});

const result = (over: Partial<PriceResult> = {}): PriceResult => ({ prices: new Map(), info: new Map(), solUsd: 100, errors: [], unresolved: new Set(), ...over });
const info = (mint: string, category: TokenCategory, usd: number | null = null) => ({ mint, symbol: null, name: null, price: usd === null ? null : { usd, liquidityUsd: null }, category });
const onCurve: CurveQuote = { complete: false, solQuoted: true, virtualTokens: 1_000_000_000_000_000n, virtualSol: 30_000_000_000n }; // 0,03 SOL por 1 milhão de tokens
const tokens = [
  { mint: SEMSUFIXO, decimals: 6 },
  { mint: COMSUFIXO, decimals: 6 },
  { mint: OUTRA, decimals: 6 },
];

test('curva: moeda com curva é "memecoin Pump.fun" mesmo sem sufixo e sem a Jupiter; conhecida nunca muda', () => {
  const r = result({ info: new Map([[SEMSUFIXO, info(SEMSUFIXO, 'desconhecido')], [USDC, info(USDC, 'estável', 1)]]) });
  applyCurves(r, new Map([[SEMSUFIXO, onCurve], [USDC, onCurve]]), tokens);
  assert.equal(r.info.get(SEMSUFIXO)?.category, 'memecoin Pump.fun');
  assert.equal(r.info.get(USDC)?.category, 'estável', 'lista local vale mais que a rede');
});

test('curva: preço em SOL vem da curva (não migrada, em SOL) e vale mais que o da Jupiter; migrada fica com a Jupiter', () => {
  const r = result({
    prices: new Map([[SEMSUFIXO, { usd: 999, liquidityUsd: null }], [COMSUFIXO, { usd: 0.5, liquidityUsd: 1 }]]),
    info: new Map([[SEMSUFIXO, info(SEMSUFIXO, 'memecoin Pump.fun', 999)], [COMSUFIXO, info(COMSUFIXO, 'memecoin Pump.fun', 0.5)], [OUTRA, info(OUTRA, 'desconhecido')]]),
  });
  applyCurves(r, new Map([[SEMSUFIXO, onCurve], [COMSUFIXO, { ...onCurve, complete: true }], [OUTRA, { ...onCurve, solQuoted: false }]]), tokens);
  const p = r.prices.get(SEMSUFIXO)!;
  assert.ok(Math.abs(p.solPerToken! - 0.00000003) < 1e-15, `0,03 SOL ÷ 1 milhão = 3e-8 SOL por token (${p.solPerToken})`);
  assert.ok(Math.abs(p.usd! - 0.000003) < 1e-12, 'em dólar com o preço do SOL');
  assert.equal(r.prices.get(COMSUFIXO)?.usd, 0.5, 'migrada: Jupiter');
  assert.equal(r.prices.get(COMSUFIXO)?.solPerToken, undefined);
  assert.equal(r.prices.has(OUTRA), false, 'pareada em outro token: sem preço pela curva');
  assert.equal(r.info.get(OUTRA)?.category, 'memecoin Pump.fun', 'mas é da Pump.fun');
});

test('curva: sem preço do SOL (Jupiter fora) o valor em SOL continua conhecido e o em dólar não', () => {
  const r = result({ solUsd: null, info: new Map([[SEMSUFIXO, info(SEMSUFIXO, 'memecoin Pump.fun')]]) });
  applyCurves(r, new Map([[SEMSUFIXO, onCurve]]), tokens);
  const v = tokenValue(r.prices, { mint: SEMSUFIXO, amount: 1_000_000_000_000n, decimals: 6, kind: 'fungible' }); // 1 milhão de tokens
  assert.equal(v.usd, null);
  assert.ok(Math.abs(v.sol! - 0.03) < 1e-12, `${v.sol}`);
});

test('curva: mint sem decimais conhecidas fica só com a categoria', () => {
  const r = result({ info: new Map([[SEMSUFIXO, info(SEMSUFIXO, 'desconhecido')]]) });
  applyCurves(r, new Map([[SEMSUFIXO, onCurve]]), []);
  assert.equal(r.info.get(SEMSUFIXO)?.category, 'memecoin Pump.fun');
  assert.equal(r.prices.has(SEMSUFIXO), false);
});

test('valor do token: uma regra para todos os leitores; NFT e sem preço ficam desconhecidos', () => {
  const prices = new Map<string, Price>([
    ['A', { usd: 2, liquidityUsd: null }],
    ['B', { usd: null, liquidityUsd: null, solPerToken: 0.001 }],
  ]);
  assert.deepEqual(tokenValue(prices, { mint: 'A', amount: 1_500_000n, decimals: 6, kind: 'fungible' }), { usd: 3, sol: null });
  assert.deepEqual(tokenValue(prices, { mint: 'B', amount: 20n, decimals: 0, kind: 'fungible' }), { usd: null, sol: 0.02 });
  assert.deepEqual(tokenValue(prices, { mint: 'A', amount: 1n, decimals: 0, kind: 'nft' }), { usd: null, sol: null });
  assert.deepEqual(tokenValue(prices, { mint: 'Z', amount: 1n, decimals: 0, kind: 'fungible' }), { usd: null, sol: null });
});

test('recomendação: valor só em SOL (pela curva) também decide; sem nenhum valor continua "manter"', () => {
  assert.equal(recommend('fungible', 'memecoin Pump.fun', null, 0.0001).code, 'cheap-memecoin');
  assert.equal(recommend('fungible', 'memecoin Pump.fun', null, VALUABLE_SOL).code, 'valuable');
  assert.equal(recommend('fungible', 'memecoin Pump.fun', null, null).code, 'no-price');
  assert.equal(recommend('fungible', 'outro', null, 0.0001).code, 'uncertain');
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', null, 0.0001), false);
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', null, VALUABLE_SOL), true);
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', null, null), true);
  assert.equal(inBurnAll(recommend('fungible', 'memecoin Pump.fun', null, 0.0001).code), true);
  assert.equal(inBurnAll(recommend('fungible', 'memecoin Pump.fun', null, 1).code), false);
});

test('tokens: limite da Jupiter (429) é tentado de novo antes de virar "valor desconhecido"', async () => {
  let n = 0;
  const waits: number[] = [];
  const flaky = (async () => (++n < 3 ? new Response('{"code":429}', { status: 429 }) : new Response(JSON.stringify([{ id: 'MintA', usdPrice: 2 }])))) as typeof fetch;
  const r = await fetchPrices(['MintA'], flaky, async (ms) => {
    waits.push(ms);
  });
  assert.equal(r.prices.get('MintA')?.usd, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(waits.length, 2);
  let m = 0;
  const always = (async () => (m++, new Response('x', { status: 429 }))) as typeof fetch;
  const r2 = await fetchPrices(['MintA'], always, async () => {});
  assert.equal(m, 2 * PRICE_ATTEMPTS, 'desiste depois das tentativas e da 2ª passada');
  assert.equal(r2.errors.length, 1);
  assert.match(r2.errors[0], /429/);
});

// Limite medido em 31/10/2026 (sonda com mints públicos): 5 consultas por janela de 10 s por IP; a resposta traz
// x-ratelimit-remaining e x-ratelimit-reset (época em segundos). Antes: 10 lotes seguidos, espera de 1,5 s/3 s
// dentro da mesma janela, lotes 6 a 10 morriam e queimar ficava desligado para todos os tokens.
test('tokens: no 429 espera até o x-ratelimit-reset (sem cabeçalho, a janela inteira)', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 7); // espera de 6,5 a 7,5 s (floor: o teste não depende do milissegundo)
  let n = 0;
  const waits: number[] = [];
  const f = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'x-ratelimit-reset': reset } }) : new Response('[]'))) as typeof fetch;
  await fetchPrices(['MintA'], f, async (ms) => {
    waits.push(ms);
  });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 5_000 && waits[0] <= 7_600, `espera até o reset (${waits[0]} ms)`);

  let m = 0;
  const semCabecalho = (async () => (++m === 1 ? new Response('', { status: 429 }) : new Response('[]'))) as typeof fetch;
  const w2: number[] = [];
  await fetchPrices(['MintA'], semCabecalho, async (ms) => {
    w2.push(ms);
  });
  assert.equal(w2.length, 1);
  assert.ok(w2[0] > PRICE_WINDOW_MS - 100 && w2[0] <= PRICE_WINDOW_MS, `a janela inteira (${w2[0]})`);
});

test('tokens: com a janela esgotada (remaining 0) espera o reset antes do próximo lote, sem levar 429', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3); // espera de 2,5 a 3,5 s
  const urls: string[] = [];
  const waits: number[] = [];
  const f = (async (u: string) => (urls.push(u), new Response('[]', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }))) as typeof fetch;
  const r = await fetchPrices(Array.from({ length: 120 }, (_, i) => `M${i}`), f, async (ms) => {
    waits.push(ms);
  });
  assert.equal(urls.length, 3);
  assert.deepEqual(r.errors, []);
  assert.equal(waits.length, 2, 'espera entre os lotes, não depois do último');
  assert.ok(waits.every((w) => w >= 1_000 && w <= 3_600), `esperas ${waits.join(',')}`);
  assert.ok(urls[0].includes(WSOL_MINT), 'o preço do SOL vai no primeiro lote, que é o que mais passa');
});

test('tokens: espera da janela pelo cabeçalho, com o relógio fixo', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  assert.equal(windowWait(h({ 'x-ratelimit-reset': '1000' }), 993_200), 7_300, 'até o reset + 0,5 s');
  assert.equal(windowWait(h({ 'retry-after': '4' }), 0), 4_000);
  assert.equal(windowWait(h({}), 0), PRICE_WINDOW_MS, 'sem cabeçalho: a janela inteira');
  assert.equal(windowWait(h({ 'x-ratelimit-reset': '1000' }), 1_200_000), PRICE_WINDOW_MS, 'reset já passou');
  assert.equal(windowWait(h({ 'x-ratelimit-reset': '99999999999' }), 0), PRICE_WINDOW_MS, 'reset absurdo não trava a análise');
  assert.equal(windowWait(h({ 'x-ratelimit-reset': 'abc', 'retry-after': '-1' }), 0), PRICE_WINDOW_MS, 'cabeçalho fora do formato');
});

test('tokens: lote que falhou marca os mints como sem consulta; a curva destrava quem ela precifica', async () => {
  const always = (async () => new Response('x', { status: 429 })) as typeof fetch;
  const r = await fetchPrices(['MintA', 'MintB'], always, async () => {});
  assert.deepEqual([...r.unresolved].filter((m) => m !== WSOL_MINT).sort(), ['MintA', 'MintB']);
  assert.equal(priceLookupFailed(r, 'MintA'), true);
  const curves = new Map([['MintA', { virtualTokens: 1_000_000_000_000_000n, virtualSol: 30_000_000_000n, complete: false, solQuoted: true }]]);
  applyCurves(r, curves, [{ mint: 'MintA', decimals: 6 }]);
  assert.equal(priceLookupFailed(r, 'MintA'), false, 'preço pela curva: dá para saber o que vale');
  assert.equal(priceLookupFailed(r, 'MintB'), true);
  const ok = (async () => new Response('[]')) as typeof fetch;
  assert.equal(priceLookupFailed(await fetchPrices(['MintC'], ok), 'MintC'), false, 'consulta feita e sem preço: desconhecido de verdade');
});

// Rodada do mesmo tester de novo (1/11/2026): nenhum lote pode virar "valor desconhecido" por um tropeço da API.
test('tokens: queda de rede e erro 5xx são tentados de novo (2 s, 5 s) antes de desistir', async () => {
  let n = 0;
  const waits: number[] = [];
  const f = (async () => {
    n++;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return new Response('x', { status: 503 });
    return new Response(JSON.stringify([{ id: 'MintA', usdPrice: 3 }]));
  }) as typeof fetch;
  const r = await fetchPrices(['MintA'], f, async (ms) => {
    waits.push(ms);
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.prices.get('MintA')?.usd, 3);
  assert.deepEqual(waits, [2_000, 5_000]);
});

test('tokens: lote que falhou em tudo tem 2ª passada depois de uma janela, e ela pode salvar o lote', async () => {
  let n = 0;
  const waits: number[] = [];
  const f = (async () => (++n <= 3 ? new Response('x', { status: 500 }) : new Response(JSON.stringify([{ id: 'MintA', usdPrice: 4 }])))) as typeof fetch;
  const r = await fetchPrices(['MintA'], f, async (ms) => {
    waits.push(ms);
  });
  assert.deepEqual(r.errors, [], '2ª passada salvou');
  assert.equal(r.prices.get('MintA')?.usd, 4);
  assert.equal(r.unresolved.size, 0);
  assert.ok(waits.some((w) => w > PRICE_WINDOW_MS - 100), `esperou uma janela antes da 2ª passada (${waits.join(',')})`);

  let m = 0;
  const down = (async () => (m++, new Response('x', { status: 500 }))) as typeof fetch;
  const r2 = await fetchPrices(['MintA'], down, async () => {});
  assert.equal(m, 6, '3 tentativas + 3 na 2ª passada');
  assert.equal(r2.errors.length, 1, 'um aviso por lote, não um por passada');
  assert.ok(r2.unresolved.has('MintA'));
});

test('tokens: resposta 4xx que não é 429 não insiste (pedido errado não melhora com nova tentativa)', async () => {
  let n = 0;
  const f = (async () => (n++, new Response('x', { status: 400 }))) as typeof fetch;
  const r = await fetchPrices(['MintA'], f, async () => {});
  assert.equal(n, 2, '1 + 1 na 2ª passada');
  assert.match(r.errors.join(), /HTTP 400/);
});

test('tokens: duas consultas ao mesmo tempo vão em fila e dividem a janela (duas análises seguidas não levam 429)', async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 3);
  const order: string[] = [];
  const waits: number[] = [];
  const f = (async (u: string) => {
    const ids = new URL(u).searchParams.get('query')!.split(',');
    order.push(ids.includes('B0') ? 'B' : 'A');
    return new Response('[]', { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } });
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  const A = Array.from({ length: 60 }, (_, i) => `A${i}`);
  await Promise.all([fetchPrices(A, f, sleep), fetchPrices(['B0'], f, sleep)]);
  assert.deepEqual(order, ['A', 'A', 'B'], 'a 2ª consulta só começa quando a 1ª termina');
  assert.equal(waits.length, 2, 'espera entre os lotes da 1ª e antes da 2ª (janela esgotada)');
});

// Moeda que migrou para o PumpSwap: a curva fica "complete" e o preço sai do pool canônico, na rede, sem a Jupiter.
// Pool canônico = PDA ["pool", índice 0 (u16), pool-authority da moeda, mint, quote] no PumpSwap; conferido contra o
// graduatedPool da Jupiter em 31/10/2026 (moeda Eg2ymQ…2agu, cotada em SOL). Moedas de 2026 cotadas em outro token
// (ex.: PUMP) ficam sem preço por aqui.
const ACC_A = findProgramAddress(['conta-base'], PROGRAMS.pump).address;
const ACC_B = findProgramAddress(['conta-quote'], PROGRAMS.pump).address;
function poolAccount(o: { base: string; quote?: string; baseAcc?: string; quoteAcc?: string }): Buffer {
  const b = Buffer.alloc(301);
  Buffer.from(decodeBase58(o.base)).copy(b, 43);
  Buffer.from(decodeBase58(o.quote ?? WSOL_MINT)).copy(b, 75);
  Buffer.from(decodeBase58(o.baseAcc ?? ACC_A)).copy(b, 139);
  Buffer.from(decodeBase58(o.quoteAcc ?? ACC_B)).copy(b, 171);
  return b;
}
function tokenAccount(mint: string, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  Buffer.from(decodeBase58(mint)).copy(b, 0);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

test('pool: endereço do pool canônico confere com o da Jupiter (moeda real migrada, cotada em SOL)', () => {
  assert.equal(poolAddress('Eg2ymQ2aQqjMcibnmTt8erC6Tvk9PVpJZCxvVPJz2agu'), 'FKfRK3WdaGXokysR1fPGgCDEeGkV1b1YYnX9ykVpG3JG');
});

test('pool: moeda migrada em SOL ganha preço pelas reservas do pool, sem a Jupiter, e destrava queimar', async () => {
  const migrada = curveAccount({ vt: 0n, vq: 0n, complete: true });
  const { rpc } = curveRpc({
    [curveOf(SEMSUFIXO)]: migrada,
    [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO }),
    [ACC_A]: tokenAccount(SEMSUFIXO, 200_000_000_000_000n), // 200 milhões de tokens (6 decimais)
    [ACC_B]: tokenAccount(WSOL_MINT, 80_000_000_000n), // 80 SOL
  });
  const curves = await readCurves(rpc, [SEMSUFIXO]);
  assert.deepEqual([curves.get(SEMSUFIXO)?.poolTokens, curves.get(SEMSUFIXO)?.poolSol], [200_000_000_000_000n, 80_000_000_000n]);
  const r = result({ solUsd: 100, unresolved: new Set([SEMSUFIXO]) }); // a Jupiter falhou para ela
  applyCurves(r, curves, [{ mint: SEMSUFIXO, decimals: 6 }]);
  assert.ok(Math.abs(r.prices.get(SEMSUFIXO)!.solPerToken! - 4e-7) < 1e-15, '80 SOL / 200 milhões = 4e-7 SOL por token');
  assert.equal(r.info.get(SEMSUFIXO)?.category, 'memecoin Pump.fun');
  assert.equal(priceLookupFailed(r, SEMSUFIXO), false, 'a rede disse o que vale');
});

test('pool: pool de outra moeda, quote fora de SOL, conta de token trocada ou pool ausente não dão preço', async () => {
  const migrada = curveAccount({ vt: 0n, vq: 0n, complete: true });
  const cases: Array<[string, Record<string, Buffer | Acc>]> = [
    ['pool de outra moeda', { [poolAddress(SEMSUFIXO)]: poolAccount({ base: COMSUFIXO }), [ACC_A]: tokenAccount(SEMSUFIXO, 10n), [ACC_B]: tokenAccount(WSOL_MINT, 10n) }],
    ['quote fora de SOL no pool', { [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO, quote: USDC }), [ACC_A]: tokenAccount(SEMSUFIXO, 10n), [ACC_B]: tokenAccount(USDC, 10n) }],
    ['pool diz que cota em outro token', { [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO, quote: USDC }), [ACC_A]: tokenAccount(SEMSUFIXO, 10n), [ACC_B]: tokenAccount(WSOL_MINT, 10n) }],
    ['conta de reserva de outro mint', { [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO }), [ACC_A]: tokenAccount(COMSUFIXO, 10n), [ACC_B]: tokenAccount(WSOL_MINT, 10n) }],
    ['reserva zero', { [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO }), [ACC_A]: tokenAccount(SEMSUFIXO, 0n), [ACC_B]: tokenAccount(WSOL_MINT, 10n) }],
    ['pool ausente', {}],
  ];
  for (const [why, extra] of cases) {
    const { rpc } = curveRpc({ [curveOf(SEMSUFIXO)]: migrada, ...extra });
    const curves = await readCurves(rpc, [SEMSUFIXO]);
    assert.equal(curves.get(SEMSUFIXO)?.complete, true, why);
    assert.equal(curves.get(SEMSUFIXO)?.poolSol, undefined, why);
    const r = result();
    applyCurves(r, curves, [{ mint: SEMSUFIXO, decimals: 6 }]);
    assert.equal(r.prices.has(SEMSUFIXO), false, why);
    assert.equal(r.info.get(SEMSUFIXO)?.category, 'memecoin Pump.fun', `${why}: continua identificada pela curva`);
  }
  // moeda migrada cotada em outro token: nem procura o pool
  const outra = curveAccount({ vt: 0n, vq: 0n, complete: true, quote: USDC });
  const { rpc, calls } = curveRpc({ [curveOf(SEMSUFIXO)]: outra });
  await readCurves(rpc, [SEMSUFIXO]);
  assert.equal(calls.length, 1);
});

test('pool: leitura do pool que falha não derruba a curva', async () => {
  const migrada = curveAccount({ vt: 0n, vq: 0n, complete: true });
  const { rpc } = curveRpc({ [curveOf(SEMSUFIXO)]: migrada }, { failBatch: 2 });
  const curves = await readCurves(rpc, [SEMSUFIXO]);
  assert.equal(curves.get(SEMSUFIXO)?.complete, true);
  assert.equal(curves.get(SEMSUFIXO)?.poolSol, undefined);
});

test('pool: com preço da Jupiter, a moeda migrada fica com o da Jupiter (pool pequeno sai mais barato e não pode rebaixar)', async () => {
  // medido em 31/10/2026: 39 moedas migradas em SOL, pool ÷ Jupiter com mediana 0,89 e mínimo 0,05 (pools de ~1 SOL)
  const migrada = curveAccount({ vt: 0n, vq: 0n, complete: true });
  const { rpc } = curveRpc({
    [curveOf(SEMSUFIXO)]: migrada,
    [poolAddress(SEMSUFIXO)]: poolAccount({ base: SEMSUFIXO }),
    [ACC_A]: tokenAccount(SEMSUFIXO, 200_000_000_000_000n),
    [ACC_B]: tokenAccount(WSOL_MINT, 1_000_000_000n),
  });
  const curves = await readCurves(rpc, [SEMSUFIXO]);
  const r = result({ solUsd: 100, prices: new Map([[SEMSUFIXO, { usd: 0.002, liquidityUsd: 10_000 }]]) });
  applyCurves(r, curves, [{ mint: SEMSUFIXO, decimals: 6 }]);
  assert.deepEqual(r.prices.get(SEMSUFIXO), { usd: 0.002, liquidityUsd: 10_000 }, 'Jupiter mantida');
});
