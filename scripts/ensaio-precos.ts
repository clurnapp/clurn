// Ensaio dos preços como na rodada de um tester (31/10/2026: 5 frases, 470 tokens), sem frase nenhuma: moedas reais
// da Pump.fun pela busca pública da Jupiter, passadas pela mesma cadeia do app (fetchPrices → readCurves com curva e
// pool do PumpSwap → applyCurves → tokenValue → recommend → priceLookupFailed / inBurnAll / palavra).
// Cenário A: Jupiter de verdade. Cenário B: Jupiter fora do ar (fetch que sempre responde 500).
// Só leitura: API pública da Jupiter e RPC (público por padrão). Nada é assinado nem enviado.
// Uso: node scripts/ensaio-precos.ts [quantidade=470] [url-do-rpc]
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { readCurves } from '../src/core/limpeza/curve-price.ts';
import { applyCurves, fetchPrices, tokenValue, type PriceResult } from '../src/core/limpeza/prices.ts';
import { burnNeedsExtraConfirmation, inBurnAll, priceLookupFailed, recommend } from '../src/core/limpeza/recommend.ts';

const want = Number(process.argv[2] ?? 470);
const rpcUrl = process.argv[3] ?? 'https://api.mainnet-beta.solana.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// moedas da Pump.fun pela busca pública (o mesmo tipo de moeda que fica nas burners)
const words = 'cat dog pepe trump ai moon frog baby elon meme bonk wif sol pump inu shib doge chad wojak based gm king queen life love money rich gold cash coin token pixel game super mega'.split(' ');
const mints = new Set<string>();
for (const w of words) {
  if (mints.size >= want) break;
  const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${w}`);
  if (r.ok) for (const t of (await r.json()) as Array<{ id: string; launchpad?: string }>) if (t.launchpad === 'pump.fun' || t.id.endsWith('pump')) mints.add(t.id);
  await sleep(2_200); // 5 consultas por 10 s por IP (medido em 31/10/2026)
}
const list = [...mints].slice(0, want);
await sleep(11_000); // janela limpa antes do ensaio
const rpc = createRpc({ url: rpcUrl, ...PUBLIC_RPC_LIMITS });
const tokens = list.map((mint) => ({ mint, decimals: 6, amount: 1_000_000_000n, kind: 'fungible' as const })); // 1000 de cada

const down = (async () => new Response('x', { status: 500 })) as typeof fetch;
for (const [name, f, fakeSleep] of [['A: Jupiter de verdade', fetch, undefined], ['B: Jupiter fora do ar', down, async () => {}]] as const) {
  const t0 = Date.now();
  const r: PriceResult = await fetchPrices(list, f, fakeSleep);
  const curves = await readCurves(rpc, list);
  applyCurves(r, curves, tokens);
  const n = { pump: 0, priced: 0, burnable: 0, burnAll: 0, word: 0, failed: 0, onCurve: 0, migrated: 0, poolPriced: 0 };
  const codes: Record<string, number> = {};
  for (const t of tokens) {
    const info = r.info.get(t.mint);
    const v = tokenValue(r.prices, t);
    const rec = recommend('fungible', info?.category ?? 'desconhecido', v.usd, v.sol);
    codes[rec.code] = (codes[rec.code] ?? 0) + 1;
    if (info?.category === 'memecoin Pump.fun') n.pump++;
    if (v.usd !== null || v.sol !== null) n.priced++;
    n.burnable++; // a tela oferece queimar para todo token que não é NFT (burnOkFor)
    if (inBurnAll(rec.code)) n.burnAll++;
    if (burnNeedsExtraConfirmation(info?.category ?? 'desconhecido', v.usd, v.sol)) n.word++;
    if (priceLookupFailed(r, t.mint)) n.failed++;
    const c = curves.get(t.mint);
    if (c && !c.complete) n.onCurve++;
    if (c?.complete) n.migrated++;
    if (c?.complete && c.poolSol !== undefined) n.poolPriced++;
  }
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${list.length} moedas, avisos de lote ${r.errors.length}`);
  console.log(`  rede: ${n.onCurve} na curva + ${n.migrated} migradas (${n.poolPriced} com pool do PumpSwap lido); identificadas como Pump.fun ${n.pump}`);
  console.log(`  com preço ${n.priced}; consulta falhada ${n.failed}; com opção de queimar ${n.burnable}; no "Queimar todos" ${n.burnAll}; pedem a palavra ${n.word}`);
  console.log(`  recomendações ${JSON.stringify(codes)}`);
}
