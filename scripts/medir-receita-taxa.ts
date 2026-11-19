// Mede de onde vem a taxa do app, pela carteira da taxa na mainnet. Só leitura de dado público: nenhuma frase,
// nenhuma chave, nada enviado.
//
//   node scripts/medir-receita-taxa.ts [amostra=400] [--desde=2026-10-30]
//
// 1. Lista todas as transações da carteira da taxa desde a data (getSignaturesForAddress, de 1000 em 1000).
// 2. Lê uma amostra uniforme (getTransaction) e, em cada uma, quanto a carteira da taxa recebeu e de que tipo é o
//    passo, pelos programas chamados: coleta (Pump.fun, PumpSwap, divisão de fees), contas de token (fechar ou
//    queimar) ou só envio de SOL.
// 3. Imprime transações por dia, a taxa por tipo, a concentração (as 5% maiores) e a taxa total estimada.
//
// Usado em 08/11/2026 para decidir tirar o valor por carteira da Confirmar (docs/aprendizados.md).
// RPC: SOLANA_RPC_URL (padrão: público, devagar de propósito). A URL não é impressa.

import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { PROGRAMS } from '../src/core/solana/pda.ts';

const URL_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet.solana.com';
const args = process.argv.slice(2);
const sample = Number(args.find((a) => /^\d+$/.test(a)) ?? 400);
const since = Date.parse(args.find((a) => a.startsWith('--desde='))?.slice('--desde='.length) ?? '2026-10-30') / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(URL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) { await sleep(2000 * (i + 1)); continue; }
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  throw new Error(`${method}: o RPC não respondeu`);
}

type Kind = 'coleta' | 'contas de token' | 'envio de SOL' | 'outro';
const CLAIM = new Set<string>([PROGRAMS.pump, PROGRAMS.pumpAmm, PROGRAMS.pumpFees, PROGRAMS.meteoraDbc, PROGRAMS.raydiumLaunchlab]); // coletas da Pump.fun, da Meteora DBC e do LaunchLab
const TOKEN = new Set<string>([PROGRAMS.token, PROGRAMS.token2022, PROGRAMS.associatedToken]);
const PLAIN = new Set<string>([PROGRAMS.system, 'ComputeBudget111111111111111111111111111111']);
function kindOf(programs: string[]): Kind {
  if (programs.some((p) => CLAIM.has(p))) return 'coleta';
  if (programs.some((p) => TOKEN.has(p))) return 'contas de token';
  if (programs.every((p) => PLAIN.has(p))) return 'envio de SOL';
  return 'outro';
}

// 1. todas as assinaturas desde a data
const sigs: { signature: string; blockTime: number; err: unknown }[] = [];
for (let before: string | undefined; ;) {
  const page = await call('getSignaturesForAddress', [APP_FEE_WALLET, { limit: 1000, ...(before ? { before } : {}) }]);
  sigs.push(...page);
  if (page.length < 1000 || page.at(-1).blockTime < since) break;
  before = page.at(-1).signature;
}
const ok = sigs.filter((s) => s.blockTime >= since && !s.err);
const perDay: Record<string, number> = {};
for (const s of ok) { const d = new Date(s.blockTime * 1000).toISOString().slice(0, 10); perDay[d] = (perDay[d] ?? 0) + 1; }
console.log(`transações sem erro desde ${new Date(since * 1000).toISOString().slice(0, 10)}: ${ok.length}`);
console.log('por dia (UTC):', JSON.stringify(Object.fromEntries(Object.entries(perDay).sort())));

// 2. amostra uniforme
const n = Math.min(sample, ok.length);
const rows: { fee: number; kind: Kind }[] = [];
for (let i = 0; i < n; i++) {
  const s = ok[Math.floor((i * ok.length) / n)];
  const t = await call('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }]);
  if (!t?.meta) continue;
  const keys: string[] = [...t.transaction.message.accountKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])];
  const at = keys.indexOf(APP_FEE_WALLET);
  const fee = at < 0 ? 0 : t.meta.postBalances[at] - t.meta.preBalances[at];
  const programs = [...new Set<string>(t.transaction.message.instructions.map((ix: { programIdIndex: number }) => keys[ix.programIdIndex]))];
  rows.push({ fee, kind: kindOf(programs) });
  await sleep(150);
}

// 3. resultado
const paid = rows.filter((r) => r.fee > 0);
const sum = paid.reduce((a, r) => a + r.fee, 0);
console.log(`amostra: ${rows.length} transações, ${paid.length} pagaram taxa, ${rows.filter((r) => r.fee < 0).length} saídas da carteira`);
const byKind = new Map<Kind, { n: number; sum: number }>();
for (const r of paid) { const k = byKind.get(r.kind) ?? { n: 0, sum: 0 }; k.n++; k.sum += r.fee; byKind.set(r.kind, k); }
for (const [k, v] of [...byKind].sort((a, b) => b[1].sum - a[1].sum)) {
  console.log(`  ${k.padEnd(16)} ${String(v.n).padStart(4)} txs (${((100 * v.n) / paid.length).toFixed(0)}%)  ${((100 * v.sum) / sum).toFixed(1)}% da taxa  média ${Math.round(v.sum / v.n)} lamports de taxa (~${((v.sum / v.n / 0.11) / 1e9).toFixed(4)} SOL recuperados)`);
}
const fees = paid.map((r) => r.fee).sort((a, b) => a - b);
const q = (p: number) => fees[Math.floor(p * (fees.length - 1))];
const top = fees.slice(-Math.ceil(fees.length * 0.05)).reduce((a, b) => a + b, 0);
console.log(`taxa por transação (lamports): mediana ${q(0.5)}, p90 ${q(0.9)}, p99 ${q(0.99)}, máx ${fees.at(-1)}`);
console.log(`as 5% maiores somam ${((100 * top) / sum).toFixed(1)}% da taxa`);
console.log(`taxa total estimada: ~${((sum / rows.length) * ok.length / 1e9).toFixed(2)} SOL (amostra × ${ok.length} transações)`);
