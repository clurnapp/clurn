// Mede a exatidão da leitura na mainnet: lê as MESMAS carteiras duas vezes seguidas e compara (0.2, pedido do
// autor em 31/10/2026: "nada passa"). Só leitura, sem frase: carteiras públicas que acabaram de mexer na Pump.fun.
//
//   node scripts/medir-exatidao.ts [quantidade=20] [--carteiras=a,b,c]
//
// Para cada passada imprime: quantas carteiras ficaram pela metade na 1ª leitura e foram lidas de novo (o que o código
// de antes da 0.2 teria contado como vazio ou incompleto), quantas continuaram sem ler depois de todas as tentativas,
// e o que cada passada achou (SOL, contas de token, creator fees). Diferença entre as passadas = carteira que mudou na
// rede entre uma e outra (essas carteiras negociam) OU leitura que falhou: a coluna "motivo" separa os dois.
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa.

import { PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { cleanupScanOptions, scanWallets, totalCreatorFeeLamports, unreadParts, type WalletScan } from '../src/core/limpeza/scan.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const limits = url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 };
const args = process.argv.slice(2);
const want = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const given = args.find((a) => a.startsWith('--carteiras='))?.slice('--carteiras='.length).split(',').filter(Boolean);
let retries = 0;
const rpc = createRpc({ url, ...limits, onRetry: () => void retries++ });

async function recentPumpWallets(n: number): Promise<string[]> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [PROGRAMS.pump, { limit: n * 3 }]);
  const out = new Set<string>();
  for (const s of sigs) {
    if (out.size >= n) break;
    if (s.err) continue;
    const tx = await rpc
      .call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }])
      .catch(() => null);
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof payer === 'string') out.add(payer);
  }
  return [...out];
}

type Pass = { scans: WalletScan[]; reread: number; rounds: number; seconds: number };
async function pass(wallets: Array<{ index: number; address: string }>): Promise<Pass> {
  let reread = 0;
  let rounds = 0;
  const t0 = Date.now();
  const scans = await scanWallets(rpc, wallets, cleanupScanOptions(rentZero), undefined, {
    onReread: (pending, round) => {
      if (round === 1) reread = pending; // ficaram pela metade na 1ª leitura
      rounds = round;
    },
  });
  return { scans, reread, rounds, seconds: (Date.now() - t0) / 1000 };
}

const fmt = (s: WalletScan) => {
  const closable = s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length).length;
  return { sol: s.lamports, tokens: s.tokens.length, closable, fees: s.fees ? totalCreatorFeeLamports(s.fees) : 0n, unread: unreadParts(s).length };
};

let rentZero = 0;
async function main() {
  const addresses = given?.length ? given : await recentPumpWallets(want);
  console.log(`${addresses.length} carteiras públicas da Pump.fun (para --carteiras=): ${addresses.join(',')}`);
  rentZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  const wallets = addresses.map((address, index) => ({ index, address }));
  const a = await pass(wallets);
  const b = await pass(wallets);
  for (const [name, p] of [['1ª passada', a], ['2ª passada', b]] as const) {
    const left = p.scans.filter((s) => unreadParts(s).length).length;
    console.log(`${name}: ${p.seconds.toFixed(1)} s · ${p.reread} pela metade na 1ª leitura (lidas de novo, ${p.rounds} rodada(s)) · ${left} sem ler depois de todas as tentativas`);
  }
  let diffs = 0;
  for (let i = 0; i < wallets.length; i++) {
    const x = fmt(a.scans[i]);
    const y = fmt(b.scans[i]);
    if (JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? String(v) : v)) === JSON.stringify(y, (_, v) => (typeof v === 'bigint' ? String(v) : v))) continue;
    diffs++;
    const motivo = x.unread || y.unread ? 'leitura incompleta' : 'carteira mudou na rede entre as passadas';
    console.log(`  difere ${wallets[i].address.slice(0, 6)}…: SOL ${x.sol}→${y.sol}, tokens ${x.tokens}→${y.tokens}, fecháveis ${x.closable}→${y.closable}, fees ${x.fees}→${y.fees} (${motivo})`);
  }
  console.log(`Carteiras iguais nas duas passadas: ${wallets.length - diffs} de ${wallets.length}. Novas tentativas do cliente RPC (429, 5xx, erro passageiro do nó): ${retries}.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'erro');
  process.exit(1);
});
