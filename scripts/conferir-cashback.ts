// Confere na mainnet, SEM enviar nada e sem frase, a coleta do cashback de quem negociou: acha carteiras públicas que
// negociaram na Pump.fun e no PumpSwap e têm cashback, e SIMULA as instruções do app (sem permissão; o usuário não
// assina), conferindo que o usuário recebe o cashback.
//
//   node scripts/conferir-cashback.ts [transacoes=50] [--app]
//
// --app: roda o app inteiro (leitura cashbackOf, plano, executor em simulação com assinaturas falsas, recibo) em cada
// carteira com cashback e compara o que a Confirmar mostraria com o lido. Destino: a carteira da taxa do app (existe).
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa.

import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { ataCreateIdempotent, pumpAmmClaimCashback, pumpClaimCashbackV2, systemTransfer } from '../src/core/solana/instructions.ts';
import { associatedTokenAddress, PROGRAMS, userVolumeAccumulator, WSOL_MINT } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { compileMessage, type Instruction, type Signer } from '../src/core/solana/tx.ts';
import { cashbackOf, type WalletScan } from '../src/core/limpeza/scan.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { buildReceipt } from '../src/app/receipt.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const N = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 50);
const PAYER = APP_FEE_WALLET; // só pagadora da simulação; nada é enviado
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
type Acc = { data?: [string, string]; lamports?: number } | null;

async function many(keys: string[]): Promise<Acc[]> {
  const out: Acc[] = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: 'base64' }])).value);
  return out;
}
async function simulate(ixs: Instruction[], watch: string[]) {
  const msg = compileMessage(PAYER, ixs, '11111111111111111111111111111111');
  const bytes = Uint8Array.from([msg.numSigners, ...new Array(64 * msg.numSigners).fill(0), ...msg.bytes]);
  return (await rpc.call<{ value: { err: unknown; logs?: string[]; accounts?: Array<{ lamports: number; data: [string, string] } | null> } }>('simulateTransaction', [
    Buffer.from(bytes).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } },
  ])).value;
}

const wallets = new Set<string>();
for (const program of [PROGRAMS.pump, PROGRAMS.pumpAmm]) {
  const sigs = await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [program, { limit: N }]);
  for (const s of sigs) {
    const tx = await rpc.call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]).catch(() => null);
    const k = tx?.transaction?.message?.accountKeys?.[0];
    if (k) wallets.add(k);
  }
}
const list = [...wallets];
const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
const accs = await many(list.flatMap((w) => [w, userVolumeAccumulator(w, PROGRAMS.pump), associatedTokenAddress(userVolumeAccumulator(w, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token)]));
if (process.argv.includes('--app')) {
  const fake = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });
  const rich = list.filter((_, i) => (accs[3 * i]?.lamports ?? 0) > 200_000_000);
  let n = 0;
  let good = 0;
  for (const w of list) {
    const cb = await cashbackOf(rpc, w, rent0);
    if (cb.pump + cb.amm <= 20_000n) continue;
    const payer = rich.find((r) => r !== w);
    if (!payer) break;
    n++;
    const [pb, wb] = await many([payer, w]);
    const fees = { bondingVault: '', bondingVaultLamports: 0, ammVaultAta: '', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, cashback: cb };
    const scans: WalletScan[] = [
      { index: 0, address: payer, lamports: pb?.lamports ?? 0, tokens: [], fees: null, errors: [] },
      { index: 1, address: w, lamports: wb?.lamports ?? 0, tokens: [], fees, errors: [] },
    ];
    const plan = buildPlan({ scans, prices: new Map(), destination: PAYER, rentExemptZero: rent0 });
    plan.steps = plan.steps.filter((st) => st.kind === 'claim-cashback');
    plan.appFee = appFeeFor(PAYER);
    try {
      const sims = await execute({ rpc, plan, signers: new Map([fake(payer, 0), fake(w, 1)].map((x) => [x.index, x])), mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
      const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
      if (sims.every((x) => x.status === 'simulado')) good++;
      console.log(`  ${w} lido Pump.fun ${sol(cb.pump)} + PumpSwap ${sol(cb.amm)} | Confirmar ${sol(r.toDestination.claimLamports)} | ${sims.map((x) => `${(x.step as { venue?: string }).venue}=${x.status}${x.detail ? ` (${x.detail.slice(0, 90)})` : ''}`).join(', ')}`);
    } catch (e) {
      console.log(`  ${w} PAROU: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`
${good} de ${n} carteiras com o cashback simulado pelo app. Nada foi enviado: só simulações.`);
  process.exit(0);
}
let tried = 0;
let ok = 0;
for (let i = 0; i < list.length; i++) {
  const w = list[i];
  const [wa, uva, ammAta] = [accs[3 * i], accs[3 * i + 1], accs[3 * i + 2]];
  const ammAmount = ammAta?.data ? Buffer.from(ammAta.data[0], 'base64').readBigUInt64LE(64) : 0n;
  if (uva) {
    tried++;
    // carteira vazia não recebe menos que o aluguel: empréstimo, como no executor
    const lend = (wa?.lamports ?? 0) < rent0 ? [systemTransfer(PAYER, w, BigInt(rent0))] : [];
    const v = await simulate([...lend, pumpClaimCashbackV2(w)], [w]);
    const got = v.err ? null : BigInt(v.accounts?.[0]?.lamports ?? 0) - BigInt(wa?.lamports ?? 0) - BigInt(lend.length ? rent0 : 0);
    if (!v.err) ok++;
    console.log(`  ${w} Pump.fun: ${v.err ? `ERRO ${JSON.stringify(v.err)} ${(v.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)}` : `recebe ${sol(got!)} SOL`}`);
  }
  if (ammAmount > 0n) {
    tried++;
    const ata = associatedTokenAddress(w, WSOL_MINT, PROGRAMS.token);
    const v = await simulate([ataCreateIdempotent(PAYER, w, WSOL_MINT, PROGRAMS.token), pumpAmmClaimCashback(w)], [ata]);
    const after = v.accounts?.[0]?.data ? Buffer.from(v.accounts[0].data[0], 'base64').readBigUInt64LE(64) : 0n;
    if (!v.err) ok++;
    console.log(`  ${w} PumpSwap: cashback ${sol(ammAmount)} | ${v.err ? `ERRO ${JSON.stringify(v.err)} ${(v.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)}` : `ATA WSOL do usuário fica com ${sol(after)}`}`);
  }
}
console.log(`\n${ok} de ${tried} simulações sem erro, em ${list.length} carteiras. Nada foi enviado: só simulações.`);
