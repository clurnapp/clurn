// Confere na mainnet, SEM enviar nada e sem frase, a distribuição da creator fee dividida (fee sharing): acha
// configurações reais com fee no cofre e SIMULA as instruções do app (varrer a curva, levar a fee do PumpSwap para a
// curva, distribuir), conferindo que cada participante recebe a parte dele. Tudo sem permissão; nada é assinado.
//
//   node scripts/conferir-fee-sharing.ts [configs=400] [simulacoes=6] [--app]
//
// --app: em vez das instruções soltas, roda o app inteiro para cada participante real (leitura sharedFees, plano,
// executor em simulação com assinaturas falsas, recibo) e compara a parte que a Confirmar mostraria com a lida.
// Destino: a carteira da taxa do app (existe e fica parada; com ela de destino não há os 11%, regra do app).
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa.

import { encodeBase58 } from '../src/core/solana/base58.ts';
import { pumpAmmTransferCreatorFeesToPumpV2, pumpDistributeCreatorFeesV2, pumpSweepCreatorFee } from '../src/core/solana/instructions.ts';
import { PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { compileMessage, type Instruction } from '../src/core/solana/tx.ts';
import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { CURVE_SLICE, parseCurve } from '../src/core/limpeza/scan.ts';
import { curveAddress } from '../src/core/limpeza/curve-price.ts';
import { sharedFees, type WalletScan } from '../src/core/limpeza/scan.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { buildReceipt } from '../src/app/receipt.ts';
import type { Signer } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const CONFIGS = nums[0] ?? 400;
const SIMS = nums[1] ?? 6;
const PAYER = APP_FEE_WALLET; // só pagadora da simulação (existe e tem SOL); nada é enviado
const DISC = encodeBase58(Buffer.from('d84a0900388c5d4b', 'hex'));
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
type Acc = { data?: [string, string]; lamports?: number } | null;

async function many(keys: string[]): Promise<Acc[]> {
  const out: Acc[] = [];
  for (let i = 0; i < keys.length; i += 100) out.push(...(await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [keys.slice(i, i + 100), { encoding: 'base64', commitment: 'confirmed' }])).value);
  return out;
}

async function simulate(ixs: Instruction[], watch: string[]) {
  const msg = compileMessage(PAYER, ixs, '11111111111111111111111111111111');
  const bytes = Uint8Array.from([msg.numSigners, ...new Array(64 * msg.numSigners).fill(0), ...msg.bytes]);
  return (await rpc.call<{ value: { err: unknown; logs?: string[]; accounts?: Array<{ lamports: number } | null> } }>('simulateTransaction', [
    Buffer.from(bytes).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } },
  ])).value;
}

// configurações com 2 participantes (amostra pequena e variada)
const list = await rpc.call<Array<{ pubkey: string; account: { data: [string, string] } }>>('getProgramAccounts', [
  PROGRAMS.pumpFees,
  { encoding: 'base64', dataSlice: { offset: 0, length: 420 }, filters: [{ memcmp: { offset: 0, bytes: DISC } }, { memcmp: { offset: 76, bytes: encodeBase58(Buffer.from([2, 0, 0, 0])) } }] },
]);
const configs = list.slice(0, CONFIGS).map((a) => {
  const d = Buffer.from(a.account.data[0], 'base64');
  const n = d.readUInt32LE(76);
  return { config: a.pubkey, status: d[10], mint: encodeBase58(d.subarray(11, 43)), holders: Array.from({ length: n }, (_, i) => ({ address: encodeBase58(d.subarray(80 + 34 * i, 112 + 34 * i)), bps: d.readUInt16LE(112 + 34 * i) })) };
}).filter((c) => c.status === 1);
const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
const vaults = await many(configs.map((c) => pumpCreatorVault(c.config)));
const curves = await many(configs.map((c) => curveAddress(c.mint)));
const ammVaults = await many(configs.map((c) => pumpAmmCreatorVaultAta(c.config)));
const withFee = configs
  .map((c, i) => {
    const cb = curves[i]?.data?.[0] ? Buffer.from(curves[i]!.data![0], 'base64') : null;
    const curve = cb && cb.length >= 133 ? parseCurve(cb.subarray(CURVE_SLICE.offset, CURVE_SLICE.offset + CURVE_SLICE.length)) : null;
    const creatorIsConfig = cb ? encodeBase58(cb.subarray(49, 81)) === c.config : false;
    const amm = ammVaults[i]?.data?.[0] ? Buffer.from(ammVaults[i]!.data![0], 'base64').readBigUInt64LE(64) : 0n;
    return { ...c, vault: BigInt(Math.max(0, (vaults[i]?.lamports ?? 0) - rent0)), parked: curve?.fee ?? 0n, amm, ammExists: Boolean(ammVaults[i]), creatorIsConfig, complete: curve?.complete ?? false };
  })
  .filter((c) => c.creatorIsConfig && c.vault + c.parked + c.amm > 2_000_000n)
  // primeiro as que exercitam mais instruções: fee no PumpSwap (moeda migrada), depois fee parada na curva
  .sort((x, y) => Number(y.amm > 0n) - Number(x.amm > 0n) || Number(y.parked > 0n) - Number(x.parked > 0n));
console.log(`${list.length} configs com 2 participantes; ${configs.length} ativas lidas; ${withFee.length} com mais de 0,002 SOL a distribuir.`);
if (process.argv.includes('--app')) {
  // pagadora: carteira comum com SOL que não participa de nenhuma das divisões testadas (nada é enviado)
  const sigs = await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [PROGRAMS.pump, { limit: 20 }]);
  const txs = await Promise.all(sigs.slice(0, 10).map((x) => rpc.call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]).catch(() => null)));
  const cand = [...new Set(txs.map((t) => t?.transaction?.message?.accountKeys?.[0]).filter((k): k is string => typeof k === 'string'))];
  const bal = await many(cand);
  const payer = cand.filter((k, i) => (bal[i]?.lamports ?? 0) > 200_000_000)[0];
  if (!payer) throw new Error('sem pagadora com SOL');
  const fake = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });
  let ok = 0;
  let n = 0;
  for (const c of withFee.slice(0, SIMS)) {
    for (const h of c.holders) {
      if (h.address === payer || h.address === PAYER) continue;
      n++;
      const read = await sharedFees(rpc, h.address, [c.mint], rent0);
      const sf = read.shared.find((x) => x.config === c.config);
      if (!sf) {
        console.log(`  ${h.address} (${h.bps / 100}%) leitura não achou a divisão ${c.config}`);
        continue;
      }
      const [pb, wb] = await many([payer, h.address]);
      const scans: WalletScan[] = [
        { index: 0, address: payer, lamports: pb?.lamports ?? 0, tokens: [], fees: null, errors: [] },
        { index: 1, address: h.address, lamports: wb?.lamports ?? 0, tokens: [], fees: { bondingVault: '', bondingVaultLamports: 0, ammVaultAta: '', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, shared: [sf], sharedOther: 0, sharedError: null }, errors: [] },
      ];
      const plan = buildPlan({ scans, prices: new Map(), destination: PAYER, rentExemptZero: rent0 });
      plan.steps = plan.steps.filter((st) => st.kind === 'claim-shared');
      plan.appFee = appFeeFor(PAYER);
      if (!plan.steps.length) {
        console.log(`  ${h.address} (${h.bps / 100}%) parte lida ${sol(sf.shareLamports)} abaixo do mínimo de coleta`);
        continue;
      }
      try {
        const sims = await execute({ rpc, plan, signers: new Map([fake(payer, 0), fake(h.address, 1)].map((x) => [x.index, x])), mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
        const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
        const st = sims[0];
        if (st.status === 'simulado') ok++;
        console.log(`  ${h.address} (${h.bps / 100}%) lida ${sol(sf.shareLamports)} | Confirmar ${sol(r.toDestination.claimLamports)} | ${st.status}${st.detail ? ` (${st.detail.slice(0, 120)})` : ''}`);
      } catch (e) {
        console.log(`  ${h.address} PAROU: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log(`
${ok} de ${n} participantes com a coleta simulada. Nada foi enviado: só simulações.`);
  process.exit(0);
}
let ok = 0;
for (const c of withFee.slice(0, SIMS)) {
  const ixs: Instruction[] = [];
  if (c.parked > 0n) ixs.push(pumpSweepCreatorFee(PAYER, c.config, c.mint));
  if (c.ammExists && c.amm > 0n) ixs.push(pumpAmmTransferCreatorFeesToPumpV2(PAYER, c.config));
  ixs.push(pumpDistributeCreatorFeesV2(PAYER, c.mint, c.config, c.holders.map((h) => h.address)));
  const watch = c.holders.map((h) => h.address);
  const before = await many(watch);
  const v = await simulate(ixs, watch);
  if (v.err) {
    console.log(`  ${c.config} ERRO ${JSON.stringify(v.err)} ${(v.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)}`);
    continue;
  }
  const got = c.holders.map((h, i) => BigInt(v.accounts?.[i]?.lamports ?? 0) - BigInt(before[i]?.lamports ?? 0));
  const total = got.reduce((a, x) => a + x, 0n);
  const expectedTotal = c.vault + c.parked + c.amm;
  const shares = c.holders.map((h, i) => `${h.bps / 100}% → ${sol(got[i])} (esperado ~${sol((expectedTotal * BigInt(h.bps)) / 10_000n)})`).join('; ');
  ok++;
  console.log(`  ${c.config} cofre ${sol(c.vault)} + parada ${sol(c.parked)} + PumpSwap ${sol(c.amm)} = ${sol(expectedTotal)} | distribuído ${sol(total)} | ${shares}`);
}
console.log(`\n${ok} de ${Math.min(SIMS, withFee.length)} simuladas sem erro. Nada foi enviado: só simulações.`);
