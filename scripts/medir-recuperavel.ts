// Mede quanto o app acharia para recuperar em carteiras públicas reais da Pump.fun. Só leitura, sem frase, sem
// chave, nada enviado: a mesma leitura do app (scanWallets com cleanupScanOptions).
//
//   node scripts/medir-recuperavel.ts [por-grupo=30]
//
// Dois grupos: quem CRIOU moeda há pouco (assinou uma transação com a autoridade de mint da Pump.fun, que só entra
// na criação) e quem NEGOCIOU há pouco (assinou uma transação do programa da Pump.fun). Para cada carteira:
// aluguel das contas vazias (o app fecha sem perguntar), aluguel das contas com memecoin (só se a pessoa queimar:
// teto), creator fees + cashback (o que o app coleta) e o SOL solto (não conta como "esquecido": é saldo de quem
// negocia). Imprime a distribuição por grupo. RPC: SOLANA_RPC_URL (padrão: público). A URL não é impressa.

import { PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { cleanupScanOptions, scanWallets, totalCreatorFeeLamports, type WalletScan } from '../src/core/limpeza/scan.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const per = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 30);
// autoridade de mint das moedas da Pump.fun (PDA "mint-authority"): só aparece na criação
const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

async function signers(account: string, n: number): Promise<string[]> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [account, { limit: Math.min(1000, n * 4) }]);
  const out = new Set<string>();
  for (const s of sigs) {
    if (out.size >= n) break;
    if (s.err) continue;
    const tx = await rpc.call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof payer === 'string') out.add(payer);
  }
  return [...out];
}

type Row = { emptyRent: number; emptyN: number; memeRent: number; memeN: number; fees: bigint; sol: number; unread: boolean };
function row(s: WalletScan): Row {
  const empty = s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length);
  const meme = s.tokens.filter((t) => t.kind === 'fungible' && !t.blockers.length);
  return {
    emptyRent: empty.reduce((a, t) => a + t.rentLamports, 0), emptyN: empty.length,
    memeRent: meme.reduce((a, t) => a + t.rentLamports, 0), memeN: meme.length,
    fees: s.fees ? totalCreatorFeeLamports(s.fees) : 0n, sol: s.lamports, unread: s.errors.length > 0,
  };
}
const SOL = (l: number | bigint) => (Number(l) / 1e9).toFixed(4);
function report(name: string, rows: Row[]) {
  const ok = rows.filter((r) => !r.unread);
  const rec = ok.map((r) => r.emptyRent + Number(r.fees)).sort((a, b) => a - b);
  const top = ok.map((r) => r.emptyRent + r.memeRent + Number(r.fees)).sort((a, b) => a - b);
  const q = (xs: number[], p: number) => xs[Math.floor(p * (xs.length - 1))] ?? 0;
  const share = (xs: number[], min: number) => `${((100 * xs.filter((x) => x >= min).length) / Math.max(1, xs.length)).toFixed(0)}%`;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  console.log(`\n== ${name}: ${rows.length} carteiras (${rows.length - ok.length} com leitura incompleta, fora da conta)`);
  console.log(`contas vazias por carteira: mediana ${q(ok.map((r) => r.emptyN).sort((a, b) => a - b), 0.5)}, máx ${Math.max(0, ...ok.map((r) => r.emptyN))}; contas com memecoin: mediana ${q(ok.map((r) => r.memeN).sort((a, b) => a - b), 0.5)}, máx ${Math.max(0, ...ok.map((r) => r.memeN))}`);
  console.log(`com creator fee ou cashback a coletar: ${ok.filter((r) => r.fees > 0n).length}; soma ${SOL(ok.reduce((a, r) => a + r.fees, 0n))} SOL`);
  console.log(`recuperável sem perguntar (vazias + fees): mediana ${SOL(q(rec, 0.5))}, p90 ${SOL(q(rec, 0.9))}, máx ${SOL(rec.at(-1) ?? 0)}, soma ${SOL(sum(rec))} SOL; ≥0,01 SOL: ${share(rec, 1e7)}; ≥0,05: ${share(rec, 5e7)}`);
  console.log(`teto queimando as memecoins também: mediana ${SOL(q(top, 0.5))}, p90 ${SOL(q(top, 0.9))}, soma ${SOL(sum(top))} SOL; ≥0,01 SOL: ${share(top, 1e7)}`);
}

const rentZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
const rent165 = await rpc.call<number>('getMinimumBalanceForRentExemption', [165]);
console.log(`aluguel hoje: conta de token (165 bytes) = ${rent165} lamports (${SOL(rent165)} SOL); conta sem dados = ${rentZero}`);
const creators = await signers(PUMP_MINT_AUTHORITY, per);
const traders = (await signers(PROGRAMS.pump, per * 2)).filter((a) => !creators.includes(a)).slice(0, per);
for (const [name, list] of [['criadores recentes', creators], ['quem negociou há pouco', traders]] as const) {
  const scans = await scanWallets(rpc, list.map((address, index) => ({ index, address })), cleanupScanOptions(rentZero));
  report(name, scans.map(row));
}
