// Mede quantas chamadas (e créditos do Helius) a LEITURA de cada carteira gasta, na mainnet.
// Só leitura, sem frase: usa carteiras públicas que acabaram de mexer na Pump.fun.
//
//   node scripts/medir-custo-rpc.ts [quantidade=20] [--so-cofres]
//
// Sem opção mede o que o app, o limpar e o scan fazem (cleanupScanOptions, com a fee parada nas moedas);
// --so-cofres mede a leitura antiga, só dos cofres, para comparar.
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa.

import { PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { createRpcMeter } from '../src/core/solana/rpc-meter.ts';
import { cleanupScanOptions, hasHistory, scanWallets } from '../src/core/limpeza/scan.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
// como o app: público no perfil PUBLIC_RPC_LIMITS (8/s no total, 3,5/s por método), próprio a 8/s.
// --rps2: o perfil antigo do público (2/s, sem limite por método), para comparar no MESMO conjunto de carteiras
// (--carteiras=a,b,c: usa estes endereços em vez de coletar; o script imprime a lista que coletou).
const rps2 = process.argv.includes('--rps2');
const givenWallets = process.argv.find((a) => a.startsWith('--carteiras='))?.slice('--carteiras='.length).split(',').filter(Boolean);
const limits = rps2 ? { requestsPerSecond: 2 } : url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 };
const rps = limits.requestsPerSecond;
const retries: Record<string, number> = {}; // novas tentativas por código HTTP (429 = limite do RPC)
const onRetry = ({ code }: { code: number | undefined }) => void (retries[String(code ?? 'rede')] = (retries[String(code ?? 'rede')] ?? 0) + 1);
const args = process.argv.slice(2);
const want = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const onlyVaults = args.includes('--so-cofres');

// carteiras de quem assinou transações recentes na Pump.fun (dado público)
async function recentPumpWallets(n: number): Promise<string[]> {
  const rpc = createRpc({ url, ...limits });
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [PROGRAMS.pump, { limit: n * 3 }]);
  const out = new Set<string>();
  for (const s of sigs) {
    if (out.size >= n) break;
    if (s.err) continue;
    const tx = await rpc
      .call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [
        s.signature,
        { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
      ])
      .catch(() => null); // formato de transação que este cliente não lê: pula
    const payer = tx?.transaction?.message?.accountKeys?.[0];
    if (typeof payer === 'string') out.add(payer);
  }
  return [...out];
}

async function main() {
  let addresses: string[];
  if (givenWallets?.length) {
    addresses = givenWallets;
    console.log(`Usando ${addresses.length} carteiras informadas.`);
  } else {
    console.log(`Coletando ${want} carteiras públicas da Pump.fun…`);
    addresses = await recentPumpWallets(want);
    console.log(`Endereços (para --carteiras=): ${addresses.join(',')}`);
  }
  // a coleta também gastou a janela de 10 s do RPC público: espera ela esvaziar antes de medir
  await new Promise((r) => setTimeout(r, 12_000));
  const wallets = addresses.map((address, index) => ({ index, address }));

  const meter = createRpcMeter();
  const rpc = createRpc({ url, ...limits, fetchImpl: meter.fetchImpl, onRetry });
  const t0 = Date.now();
  const rentExemptZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  for (const w of wallets) await hasHistory(rpc, w.address); // descoberta: 1 consulta por endereço
  const scans = await scanWallets(rpc, wallets, onlyVaults ? { rentExemptZero, detailedFees: false } : cleanupScanOptions(rentExemptZero));
  const secs = (Date.now() - t0) / 1000;

  const n = wallets.length;
  const errors = scans.filter((s) => s.errors.length).length;
  const coins = scans.reduce((a, s) => a + (s.fees?.coinsOnCurve ?? 0) + (s.fees?.pools ?? 0), 0);
  const parked = scans.reduce((a, s) => a + (s.fees?.curveSweeps.length ?? 0) + (s.fees?.poolSweeps.length ?? 0), 0);
  const unread = scans.filter((s) => s.fees?.unsweptError).length;
  console.log(`\nCarteiras lidas: ${n} (com erro parcial: ${errors}; ${onlyVaults ? 'só cofres, leitura antiga' : `como o app; moedas/pools achadas: ${coins}, com fee parada a coletar: ${parked}, fee parada sem leitura: ${unread}`})`);
  console.log(`RPC: ${rps2 ? 'público a 2 req/s (perfil antigo)' : url === PUBLIC ? `público a ${rps} req/s (${PUBLIC_RPC_LIMITS.defaultMethodLimit} por método)` : `próprio a ${rps} req/s`}; tempo: ${secs.toFixed(1)} s (${(secs / n).toFixed(2)} s por carteira)`);
  console.log(`Novas tentativas por código: ${Object.keys(retries).length ? JSON.stringify(retries) : 'nenhuma'}`);
  console.log('\nRequisições por método (inclui novas tentativas):');
  for (const [m, c] of Object.entries(meter.counts()).sort((a, b) => b[1] - a[1])) console.log(`  ${m.padEnd(36)} ${c}`);
  console.log(`\nTotal: ${meter.requests()} requisições, ${meter.credits()} créditos do Helius`);
  console.log(`Por carteira: ${(meter.requests() / n).toFixed(2)} requisições, ${(meter.credits() / n).toFixed(2)} créditos`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'erro');
  process.exit(1);
});
