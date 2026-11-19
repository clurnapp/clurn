// Mede, contra um RPC FALSO (nenhuma rede, nenhuma frase real), como o cliente RPC compartilhado se comporta
// quando várias frases são lidas ao mesmo tempo: descoberta + leitura de cada carteira.
//
//   node scripts/medir-limites-rpc.ts <frases=1> <carteiras-por-frase=20> [--publico]
//
// Usa o createRpc, o discoverBurners e o scanWallets(..., cleanupScanOptions) reais. Limites do falso:
// - padrão, "Helius grátis" (conferido em 30/10/2026): 10 req/s no total, 5 getProgramAccounts/s, 1 sendTransaction/s;
// - --publico, RPC público da Solana: 100 req por 10 s no total e 40 req por 10 s de cada método (doc oficial,
//   30/10/2026) e, SONDADO na mainnet no mesmo dia, 10 por 10 s para getTokenAccountsByOwner, getProgramAccounts,
//   getSignaturesForAddress e getSignatureStatuses, com as recusadas contando; cliente no perfil PUBLIC_RPC_LIMITS.
// HTTP 429 acima disso. As frases são derivadas da frase pública de teste do BIP39 (nunca uma frase real),
// cada uma com uma senha diferente para dar endereços diferentes.

import { deriveBurner, mnemonicToSeed } from '../src/core/carteiras/derivation.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { cleanupScanOptions, discoverBurners, scanWallets } from '../src/core/limpeza/scan.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const args = process.argv.slice(2);
const publico = args.includes('--publico');
const nums = args.filter((a) => /^\d+$/.test(a));
const frases = Number(nums[0] ?? 1);
const perFrase = Number(nums[1] ?? 20);
if (!Number.isInteger(frases) || frases < 1 || frases > 10 || !Number.isInteger(perFrase) || perFrase < 1) {
  console.error('uso: node scripts/medir-limites-rpc.ts <frases 1-10> <carteiras-por-frase> [--publico]');
  process.exit(1);
}

// windowMs: janela do limite; perMethod: limite de cada método (ou `all` para qualquer um)
const LIMITS = publico
  ? { windowMs: 10_000, total: 100, all: 40, perMethod: { getTokenAccountsByOwner: 10, getProgramAccounts: 10, getSignaturesForAddress: 10, getSignatureStatuses: 10 } as Record<string, number>, rejectedCount: true }
  : { windowMs: 1000, total: 10, all: Infinity, perMethod: { getProgramAccounts: 5, sendTransaction: 1 } as Record<string, number>, rejectedCount: false };
const LATENCY_MS = 80;
const log: Array<{ t: number; m: string }> = []; // aceitas
const hits: Array<{ t: number; m: string }> = []; // o que conta para o limite (no público, as recusadas também)
let r429 = 0;
const r429ByMethod: Record<string, number> = {};

const seeds = Array.from({ length: frases }, (_, f) => mnemonicToSeed(MNEMONIC, `medir-${f}`));
const used = new Set<string>(); // endereços com histórico: os primeiros `perFrase` de cada frase
for (const s of seeds) for (let n = 0; n < perFrase; n++) used.add(deriveBurner(s, n).address);

const fake: typeof fetch = async (_u, init) => {
  const body = JSON.parse(String(init!.body)) as { method: string; params: unknown[] };
  const m = body.method;
  const t = Date.now();
  const win = hits.filter((x) => t - x.t < LIMITS.windowMs);
  const over = win.length >= LIMITS.total || win.filter((x) => x.m === m).length >= (LIMITS.perMethod[m] ?? LIMITS.all);
  if (over) {
    r429++;
    r429ByMethod[m] = (r429ByMethod[m] ?? 0) + 1;
    if (LIMITS.rejectedCount) hits.push({ t, m });
    return new Response('', { status: 429, headers: { 'retry-after': '10' } });
  }
  log.push({ t, m });
  hits.push({ t, m });
  await new Promise((r) => setTimeout(r, LATENCY_MS));
  let result: unknown;
  if (m === 'getSignaturesForAddress') result = used.has(String(body.params[0])) ? [{ signature: 'x', err: null }] : [];
  else if (m === 'getMultipleAccounts') result = { value: (body.params[0] as string[]).map(() => null) };
  else if (m === 'getTokenAccountsByOwner') result = { value: [] };
  else if (m === 'getMinimumBalanceForRentExemption') result = 890880;
  else if (m === 'getProgramAccounts') result = [];
  else result = { value: [] };
  return Response.json({ jsonrpc: '2.0', id: 1, result });
};

const rpc = createRpc({ url: publico ? 'https://fake.publico' : 'https://fake.helius', ...(publico ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }), fetchImpl: fake });
const t0 = Date.now();
const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
const perSeed = await Promise.all(
  seeds.map(async (seed) => {
    const d = await discoverBurners(seed, rpc);
    const scans = await scanWallets(rpc, d.wallets, cleanupScanOptions(rent0));
    return { found: d.wallets.length, checked: d.checked, scans };
  }),
);
const secs = (Date.now() - t0) / 1000;
for (const s of seeds) s.fill(0);

const wallets = perSeed.reduce((a, p) => a + p.found, 0);
const sigs = log.filter((x) => x.m === 'getSignaturesForAddress').length;
const scanReqs = log.length - sigs - 1; // tira a descoberta e a consulta do aluguel
// picos na janela do limite: total e por método (quantas chamadas aceitas em qualquer janela de windowMs)
let peak = 0;
const perMethodPeak: Record<string, number> = {};
for (const x of log) {
  const w = log.filter((y) => y.t <= x.t && x.t - y.t < LIMITS.windowMs);
  peak = Math.max(peak, w.length);
  const c = w.filter((y) => y.m === x.m).length;
  perMethodPeak[x.m] = Math.max(perMethodPeak[x.m] ?? 0, c);
}
const byMethod: Record<string, number> = {};
for (const x of log) byMethod[x.m] = (byMethod[x.m] ?? 0) + 1;

console.log(
  JSON.stringify({
    perfil: publico ? 'publico (100/10 s, 40/10 s por método)' : 'helius (10/s, gPA 5/s, envio 1/s)',
    frases,
    carteirasPorFrase: perFrase,
    carteirasAchadas: wallets,
    segundos: +secs.toFixed(1),
    segundosPorCarteira: +(secs / wallets).toFixed(2),
    reqAceitas: log.length,
    reqPorMetodo: byMethod,
    descobertaReqPorFrase: +(sigs / frases).toFixed(1),
    leituraReqPorCarteira: +(scanReqs / wallets).toFixed(2),
    http429: r429,
    http429PorMetodo: r429ByMethod,
    janelaMs: LIMITS.windowMs,
    picoReqNaJanela: peak,
    picoPorMetodoNaJanela: perMethodPeak,
    carteirasComErro: perSeed.reduce((a, p) => a + p.scans.filter((s) => s.errors.length).length, 0),
  }),
);
