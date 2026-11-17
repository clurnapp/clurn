import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, mergeReceipts, type FraseReceipt } from '../../src/app/receipt.ts';
import type { Plan, Step, TokenAction, KeptToken } from '../../src/core/limpeza/plan.ts';
import type { StepResult } from '../../src/core/limpeza/executor.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1].map((n) => burnerSigner(seed, n));
const DEST = deriveMainAddress(seed);
const ACC = Array.from({ length: 160 }, (_, i) => burnerSigner(seed, 100 + i).address);
const MINT = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function act(action: TokenAction['action'], i: number): TokenAction {
  return { action, account: ACC[i], mint: MINT, program: 'Tokenkeg', amount: action === 'close' ? 0n : 1_000n, decimals: 6, rentLamports: 2_039_280 };
}
function plan(steps: Step[], kept: KeptToken[] = []): Plan {
  return { destination: DEST, feePayerIndex: 0, feePayer: S[0].address, payerOutsideSelection: false, steps, kept, skipped: [], reserveNeededLamports: 0n };
}
function keptTok(i: number, kind: 'nft' | 'fungible', reason: string): KeptToken {
  return { account: ACC[i], mint: MINT, program: 'token', kind, amount: 1n, decimals: 0, rentLamports: 2_039_280, blockers: [], wallet: S[0].address, walletIndex: 0, usd: null, reason } as unknown as KeptToken;
}
const res = (step: Step, status: StepResult['status'], delta?: bigint, detail?: string): StepResult => ({ step, description: 'x', status, destinationDelta: delta, detail });

const tokensStep: Step = { kind: 'tokens', walletIndex: 0, wallet: S[0].address, actions: [act('close', 0), act('close', 1), act('burn-close', 2), act('transfer-close', 3)] };
const curve: Step = { kind: 'claim-curve', walletIndex: 0, wallet: S[0].address, estimateLamports: 240_640n };
const amm: Step = { kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 50_000n };
const sweep: Step = { kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true };

test('recibo: agrupa fechar, coletar, enviar, queimar, manter e falha', () => {
  const p = plan([tokensStep, curve, amm, sweep], [keptTok(10, 'nft', 'NFT: fica na carteira (nunca é queimado)'), keptTok(11, 'fungible', 'conta congelada pelo emissor')]);
  const r = buildReceipt({
    plan: p,
    simResults: [res(tokensStep, 'simulado', 8_000_000n), res(curve, 'simulado', 240_640n), res(sweep, 'simulado', 5_000n), res(amm, 'falhou', undefined, 'boom')],
    holdings: [],
    main: DEST,
  });
  assert.equal(r.toDestination.closedAccounts, 4);
  assert.equal(r.toDestination.claims, 1);
  assert.equal(r.toDestination.claimLamports, 240_640n);
  assert.equal(r.toDestination.tokens.length, 1);
  assert.equal(r.burned.length, 1);
  assert.deepEqual(r.kept.map((k) => k.reasonCode), ['nft', 'token-frozen']);
  assert.equal(r.failed.length, 1);
  assert.equal(r.toDestination.looseSolLamports, 5_000n);
});

test('recibo: passo que só libera a fee parada não conta como coleta (a coleta é o passo seguinte)', () => {
  const sweepOnly: Step = { kind: 'claim-curve', walletIndex: 0, wallet: S[0].address, estimateLamports: 30_000n, sweeps: [], sweepOnly: true };
  const r = buildReceipt({ plan: plan([sweepOnly, curve]), simResults: [res(sweepOnly, 'simulado', 0n), res(curve, 'simulado', 270_640n)], holdings: [], main: DEST });
  assert.equal(r.toDestination.claims, 1);
  assert.equal(r.toDestination.claimLamports, 270_640n);
});

test('recibo: total ignora passo que falhou', () => {
  const p = plan([curve, amm, sweep]);
  const r = buildReceipt({ plan: p, simResults: [res(curve, 'simulado', 100n), res(amm, 'falhou', 7_000n, 'x'), res(sweep, 'simulado', 20n)], holdings: [], main: null });
  assert.equal(r.totalLamports, 120n);
  assert.equal(r.feeEstimateLamports, 2n * 2n * 5_000n);
});

test('recibo: token sem preço fica null, nunca 0', () => {
  const p = plan([{ kind: 'tokens', walletIndex: 0, wallet: S[0].address, actions: [act('burn-close', 0), act('burn-close', 1)] }]);
  const step = p.steps[0];
  const r = buildReceipt({ plan: p, simResults: [res(step, 'simulado', 0n)], holdings: [{ account: ACC[0], symbol: 'AAA', usdValue: null }], main: null });
  assert.equal(r.burned[0].usdValue, null);
  assert.equal(r.burned[0].symbol, 'AAA');
  assert.equal(r.burned[1].symbol, null);
  assert.equal(r.burned[1].usdValue, null);
});

test('recibo: selo de principal só quando o destino é a principal', () => {
  const p = plan([sweep]);
  const sim = [res(sweep, 'simulado', 1n)];
  assert.equal(buildReceipt({ plan: p, simResults: sim, holdings: [], main: DEST }).destinationIsMain, true);
  assert.equal(buildReceipt({ plan: p, simResults: sim, holdings: [], main: S[1].address }).destinationIsMain, false);
  assert.equal(buildReceipt({ plan: p, simResults: sim, holdings: [], main: null }).destinationIsMain, false);
});

test('recibo: plano grande', () => {
  const steps: Step[] = Array.from({ length: 10 }, (_, s) => ({ kind: 'tokens', walletIndex: 0, wallet: S[0].address, actions: Array.from({ length: 15 }, (_, i) => act('burn-close', s * 15 + i)) }));
  const r = buildReceipt({ plan: plan(steps), simResults: steps.map((s) => res(s, 'simulado', 0n)), holdings: [], main: null });
  assert.equal(r.burned.length, 150);
  assert.equal(r.toDestination.closedAccounts, 150);
});

test('recibo: soma a taxa do app (11%) dos passos simulados e mostra a carteira; sem taxa, nada', () => {
  const FEE = 'Fee1111111111111111111111111111111111111111';
  const p: Plan = { ...plan([tokensStep, sweep]), appFee: { wallet: FEE, bps: 1_100n } };
  const withFee = (step: Step, dest: bigint, fee: bigint): StepResult => ({ ...res(step, 'simulado', dest), appFeeDelta: fee });
  const r = buildReceipt({ plan: p, simResults: [withFee(tokensStep, 7_120_000n, 880_000n), withFee(sweep, 5_000n, 0n), { ...res(curve, 'falhou', undefined, 'boom'), appFeeDelta: 99n }], holdings: [], main: DEST });
  assert.equal(r.appFeeLamports, 880_000n, 'passo que falhou não conta');
  assert.equal(r.appFeeWallet, FEE);
  assert.equal(r.totalLamports, 7_125_000n, 'total ao destino já sem a taxa');
  const semTaxa = buildReceipt({ plan: { ...plan([sweep]), appFee: null }, simResults: [res(sweep, 'simulado', 5_000n)], holdings: [], main: DEST });
  assert.deepEqual([semTaxa.appFeeLamports, semTaxa.appFeeWallet], [0n, null]);
});
// ---- várias frases ----
const fr = (frase: number, app: 'solflare' | 'phantom', r: ReturnType<typeof buildReceipt>): FraseReceipt => ({ frase, app, receipt: r });
const withFee = (r: ReturnType<typeof buildReceipt>, fee: bigint) => ({ ...r, appFeeLamports: fee });

test('recibo: soma total, taxa de rede e taxa do app de duas frases', () => {
  const a = withFee(buildReceipt({ plan: plan([tokensStep, curve]), simResults: [res(tokensStep, 'simulado', 8_000_000n), res(curve, 'simulado', 240_640n)], holdings: [], main: DEST }), 1_000n);
  const b = withFee(buildReceipt({ plan: plan([sweep, amm], [keptTok(10, 'nft', 'NFT')]), simResults: [res(sweep, 'simulado', 5_000n), res(amm, 'falhou', undefined, 'boom')], holdings: [], main: DEST }), 250n);
  const m = mergeReceipts([fr(1, 'solflare', a), fr(2, 'phantom', b)]);
  assert.equal(m.totalLamports, a.totalLamports + b.totalLamports);
  assert.equal(m.feeEstimateLamports, a.feeEstimateLamports + b.feeEstimateLamports);
  assert.equal(m.appFeeLamports, 1_250n);
  assert.equal(m.destination, DEST);
  assert.equal(m.failedCount, 1);
  assert.equal(m.burnedCount, 1);
  assert.equal(m.keptCount, 1);
  assert.equal(m.frases.length, 2);
});

test('recibo: destinos diferentes → erro', () => {
  const a = buildReceipt({ plan: plan([sweep]), simResults: [res(sweep, 'simulado', 5_000n)], holdings: [], main: DEST });
  const b = { ...a, destination: S[1].address };
  assert.throws(() => mergeReceipts([fr(1, 'solflare', a), fr(2, 'solflare', b)]), /destino/i);
});

test('recibo: uma frase sem nada simulado entra com zero, sem quebrar', () => {
  const a = withFee(buildReceipt({ plan: plan([sweep]), simResults: [res(sweep, 'simulado', 5_000n)], holdings: [], main: DEST }), 10n);
  const vazio = buildReceipt({ plan: plan([]), simResults: [], holdings: [], main: DEST });
  const m = mergeReceipts([fr(1, 'solflare', a), fr(2, 'phantom', vazio)]);
  assert.equal(m.totalLamports, 5_000n);
  assert.equal(m.appFeeLamports, 10n);
  assert.equal(m.frases.length, 2);
  assert.equal(m.failedCount, 0);
});

test('recibo: coleta pulada por fee sharing entra na lista (a tela avisa); outro "nada a fazer" não', async () => {
  const { FEE_SHARING_SKIP } = await import('../../src/core/limpeza/executor.ts');
  const r = buildReceipt({
    plan: plan([curve, amm, sweep]),
    simResults: [res(curve, 'nada a fazer', undefined, FEE_SHARING_SKIP), res(amm, 'nada a fazer', undefined, 'o PumpSwap não tem fee para liberar'), res(sweep, 'simulado', 5_000n)],
    holdings: [],
    main: DEST,
  });
  assert.deepEqual(r.feeSharing, [0]);
  assert.equal(r.toDestination.claims, 0);
});

test('recibo: passo só de varrer soma a fee que libera (com os 11%), e a ATA WSOL fechada na coleta conta como aluguel', async () => {
  const { appFeeFor } = await import('../../src/core/limpeza/app-fee.ts');
  const sweepOnly: Step = { kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 100_000n, sweeps: [], sweepOnly: true };
  const p = { ...plan([sweepOnly, amm]), appFee: appFeeFor(DEST) };
  const r = buildReceipt({
    plan: p,
    simResults: [{ ...res(sweepOnly, 'simulado', 0n), pendingClaimLamports: 100_000n }, { ...res(amm, 'simulado', 1_000_000n), closedRentLamports: 200_000n }],
    holdings: [],
    main: DEST,
  });
  assert.equal(r.toDestination.claims, 1);
  assert.equal(r.toDestination.claimLamports, 100_000n + 1_000_000n - 200_000n, 'bruto: fee liberada + coleta − a ATA fechada');
  assert.equal(r.toDestination.closedRentLamports, 200_000n);
  assert.equal(r.toDestination.closedAccounts, 1);
  assert.equal(r.totalLamports, 1_089_000n);
  assert.equal(r.appFeeLamports, 11_000n);
});

test('recibo: o envio final da pagadora desconta o que os passos anteriores gastaram dela', async () => {
  const { appFeeFor } = await import('../../src/core/limpeza/app-fee.ts');
  const other: Step = { kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false };
  const p = { ...plan([other, sweep]), appFee: appFeeFor(DEST) };
  const r = buildReceipt({
    plan: p,
    simResults: [{ ...res(other, 'simulado', 890_000n), appFeeDelta: 110_000n, payerCostLamports: 1_000_000n }, { ...res(sweep, 'simulado', 8_900_000n), appFeeDelta: 1_100_000n }],
    holdings: [],
    main: DEST,
  });
  assert.equal(r.totalLamports, 890_000n + 8_900_000n - 890_000n, 'a pagadora manda 1.000.000 a menos: 890.000 a menos ao destino');
  assert.equal(r.appFeeLamports, 110_000n + 1_100_000n - 110_000n);
  assert.equal(r.feeEstimateLamports, 1_000_000n, 'taxa de rede medida');
  // com o depósito isento cobrindo tudo, o gasto sai inteiro do destino
  const isento = buildReceipt({ plan: { ...p, payerExemptLamports: 20_000_000n }, simResults: [{ ...res(other, 'simulado', 890_000n), appFeeDelta: 110_000n, payerCostLamports: 1_000_000n }, { ...res(sweep, 'simulado', 10_000_000n), appFeeDelta: 0n }], holdings: [], main: DEST });
  assert.equal(isento.totalLamports, 890_000n + 10_000_000n - 1_000_000n);
});

test('recibo (revisão): fee liberada pela varredura só conta se a coleta seguinte da mesma carteira vai acontecer', async () => {
  const { FEE_SHARING_SKIP } = await import('../../src/core/limpeza/executor.ts');
  const sweepOnly: Step = { kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 100_000n, sweeps: [], sweepOnly: true };
  const freed = { ...res(sweepOnly, 'simulado', 0n), pendingClaimLamports: 100_000n };
  for (const last of [res(amm, 'nada a fazer', undefined, FEE_SHARING_SKIP), res(amm, 'falhou', undefined, 'boom'), { ...res(amm, 'simulado', 0n, FEE_SHARING_SKIP), skippedClaim: true }]) {
    const r = buildReceipt({ plan: plan([sweepOnly, amm]), simResults: [freed, last], holdings: [], main: DEST });
    assert.equal(r.toDestination.claimLamports, 0n, `coleta seguinte ${last.status}${last.skippedClaim ? ' (pulada)' : ''}`);
    assert.equal(r.totalLamports, 0n);
    assert.equal(r.toDestination.claims, 0);
  }
  // coleta de OUTRA carteira simulada não vale para esta
  const other: Step = { kind: 'claim-amm', walletIndex: 0, wallet: S[0].address, estimateLamports: 1n };
  const r = buildReceipt({ plan: plan([sweepOnly, other]), simResults: [freed, res(other, 'simulado', 5n)], holdings: [], main: DEST });
  assert.equal(r.toDestination.claimLamports, 5n);
});

test('recibo pós-execução (tela final): conta os passos enviados, sem somar a varredura de novo nem descontar a pagadora', async () => {
  const { appFeeFor } = await import('../../src/core/limpeza/app-fee.ts');
  const sweepOnly: Step = { kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 100_000n, sweeps: [], sweepOnly: true };
  const p = { ...plan([sweepOnly, amm, curve, sweep]), appFee: appFeeFor(DEST) };
  const sent = (step: Step, dest: bigint, fee: bigint, extra: object = {}): StepResult => ({ ...res(step, 'enviado', dest), appFeeDelta: fee, ...extra });
  const results = [
    sent(sweepOnly, 0n, 0n, { pendingClaimLamports: 100_000n, payerCostLamports: 5_000n }),
    sent(amm, 979_000n, 121_000n, { payerCostLamports: 5_000n }), // a coleta real já leva o cofre cheio (1.100.000)
    sent(curve, 445_000n, 55_000n), // coleta na pagadora
    sent(sweep, 8_900_000n, 1_100_000n),
    res(amm, 'simulado', 999n), // simulação não entra
  ];
  const r = buildReceipt({ plan: p, simResults: results, holdings: [], main: DEST, executed: true });
  assert.equal(r.toDestination.claims, 2);
  assert.equal(r.toDestination.claimLamports, 1_100_000n + 500_000n, 'cofre cheio medido na coleta + curva; a varredura não soma de novo');
  assert.equal(r.totalLamports, 979_000n + 445_000n + 8_900_000n, 'total = o que chegou');
  assert.equal(r.toDestination.looseSolLamports, 10_000_000n, 'sem desconto da pagadora: o envio real já leu o saldo');
  const d = r.toDestination;
  assert.equal(d.looseSolLamports + d.closedRentLamports + d.claimLamports - r.appFeeLamports, r.totalLamports);
});

test('recibo (revisão 0.1.7): coleta final que a simulação viu "sem fee" coleta o que a varredura liberou, e conta uma vez', () => {
  const sweepOnly: Step = { kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 100_000n, sweeps: [], sweepOnly: true };
  const freed = { ...res(sweepOnly, 'simulado', 0n), pendingClaimLamports: 100_000n };
  for (const last of [res(amm, 'nada a fazer', undefined, 'o PumpSwap não tem fee para liberar'), { ...res(amm, 'simulado', 0n, 'fee de 900 lamports é menor que a taxa da rede: não compensa coletar'), skippedClaim: true }]) {
    const r = buildReceipt({ plan: plan([sweepOnly, amm]), simResults: [freed, last], holdings: [], main: DEST });
    assert.equal(r.toDestination.claimLamports, 100_000n, `coleta final ${last.status}: a fee liberada chega na execução`);
    assert.equal(r.totalLamports, 100_000n);
    assert.equal(r.toDestination.claims, 1, 'uma coleta');
  }
  // coleta final simulada de verdade: conta uma vez só (não duas)
  const r = buildReceipt({ plan: plan([sweepOnly, amm]), simResults: [freed, res(amm, 'simulado', 50n)], holdings: [], main: DEST });
  assert.equal(r.toDestination.claims, 1);
  assert.equal(r.toDestination.claimLamports, 100_050n);
});
