// Empréstimo das taxas entre frases (src/core/limpeza/funding.ts): quem empresta, quanto, e o plano de um passo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUND_TX_FEE_LAMPORTS, fundingOffer, fundingPlan, LENDER_RESERVE_FACTOR, spareLamports, type Lender } from '../../src/core/limpeza/funding.ts';
import { describeStep, FeePayerError, MIN_FUNDING_LAMPORTS, type Plan } from '../../src/core/limpeza/plan.ts';
import type { WalletScan } from '../../src/core/limpeza/scan.ts';

const scan = (index: number, address: string, lamports: number, errors: string[] = []): WalletScan => ({ index, address, lamports, tokens: [], fees: null, errors });
const plan = (feePayerIndex: number, feePayer: string, reserve: bigint): Plan => ({
  destination: 'DEST', feePayerIndex, feePayer, payerOutsideSelection: false, steps: [], kept: [], skipped: [], reserveNeededLamports: reserve, appFee: null,
});
const RESERVE = 1_200_000n; // reserva típica de uma frase (taxas + aluguel temporário + mínimo da pagadora)
const lender = (frase: number, payerLamports: number, reserve = RESERVE, errors: string[] = []): Lender => ({
  frase,
  scans: [scan(0, `A${frase}`, 100), scan(7, `P${frase}`, payerLamports, errors)],
  plan: plan(7, `P${frase}`, reserve),
});
// a frase 4 precisa de 0,01 SOL (pedido à pessoa) ou da reserva exata (o mínimo que resolve), na N=0
const need = new FeePayerError(MIN_FUNDING_LAMPORTS, 0, 'B4', 'temporária N=0', 'Solflare', 600_000n);

test('empréstimo: a sobra da pagadora guarda o dobro da reserva e a taxa do envio; pagadora com erro de leitura não empresta', () => {
  assert.equal(LENDER_RESERVE_FACTOR, 2n);
  assert.equal(spareLamports(lender(1, 50_000_000)), 50_000_000n - RESERVE * 2n - FUND_TX_FEE_LAMPORTS);
  assert.equal(spareLamports(lender(1, Number(RESERVE * 2n + FUND_TX_FEE_LAMPORTS))), 0n, 'exatamente a reserva dobrada: nada sobra');
  assert.equal(spareLamports(lender(1, 100)), 0n);
  assert.equal(spareLamports(lender(1, 50_000_000, RESERVE, ['leitura falhou'])), 0n, 'saldo em dúvida não empresta');
  // pagadora do plano fora das leituras (ou endereço trocado): nada
  const l = lender(1, 50_000_000);
  l.plan = plan(7, 'OUTRA', RESERVE);
  assert.equal(spareLamports(l), 0n);
});

test('empréstimo: quem cobre o valor cheio vem primeiro; só depois quem cobre a reserva; a própria frase nunca', () => {
  // 1 cobre 0,01; 2 cobre só a reserva; 3 nada
  const o = fundingOffer(4, need, [lender(2, Number(RESERVE * 2n + FUND_TX_FEE_LAMPORTS) + 700_000), lender(1, 50_000_000), lender(3, 100)]);
  assert.deepEqual(o, { fromFrase: 1, fromIndex: 7, from: 'P1', toFrase: 4, toIndex: 0, to: 'B4', lamports: MIN_FUNDING_LAMPORTS });
  // sem ninguém com 0,01 de sobra: a reserva exata serve (resolve a frase, com menos folga)
  const o2 = fundingOffer(4, need, [lender(2, Number(RESERVE * 2n + FUND_TX_FEE_LAMPORTS) + 700_000), lender(3, 100)]);
  assert.deepEqual(o2, { fromFrase: 2, fromIndex: 7, from: 'P2', toFrase: 4, toIndex: 0, to: 'B4', lamports: 600_000n });
  // sobra menor que a reserva: não resolve, ninguém empresta
  assert.equal(fundingOffer(4, need, [lender(2, Number(RESERVE * 2n + FUND_TX_FEE_LAMPORTS) + 500_000)]), null);
  assert.equal(fundingOffer(4, need, []), null);
  // a própria frase (mesmo rica) não se empresta
  assert.equal(fundingOffer(4, need, [lender(4, 50_000_000)]), null);
  // empate de sobra: a frase de número menor
  const o3 = fundingOffer(4, need, [lender(3, 50_000_000), lender(1, 50_000_000)]);
  assert.equal(o3?.fromFrase, 1);
  // mais sobra ganha
  const o4 = fundingOffer(4, need, [lender(1, 50_000_000), lender(3, 60_000_000)]);
  assert.equal(o4?.fromFrase, 3);
});

test('empréstimo: FeePayerError guarda a reserva (nunca acima do pedido; sem ela, igual ao pedido)', () => {
  assert.equal(new FeePayerError(10_000_000n, 0, 'W').reserveLamports, 10_000_000n);
  assert.equal(new FeePayerError(10_000_000n, 0, 'W', 'x', 'Solflare', 600_000n).reserveLamports, 600_000n);
  assert.equal(new FeePayerError(10_000_000n, 0, 'W', 'x', 'Solflare', 20_000_000n).reserveLamports, 10_000_000n, 'reserva acima do pedido não faz sentido: vale o pedido');
  assert.equal(new FeePayerError(10_000_000n, 0, 'W', 'x', 'Solflare', 0n).reserveLamports, 10_000_000n);
});

test('empréstimo: plano de um passo, destino = a temporária que recebe, sem taxa do app; descrição diz frase e valor', () => {
  const o = fundingOffer(4, need, [lender(1, 50_000_000)])!;
  const p = fundingPlan(o);
  assert.equal(p.destination, 'B4');
  assert.equal(p.feePayer, 'P1');
  assert.equal(p.feePayerIndex, 7);
  assert.equal(p.appFee, null);
  assert.equal(p.steps.length, 1);
  const s = p.steps[0]!;
  assert.equal(s.kind, 'fund');
  if (s.kind !== 'fund') throw new Error('kind');
  assert.deepEqual([s.walletIndex, s.wallet, s.to, s.toFrase, s.lamports], [7, 'P1', 'B4', 4, MIN_FUNDING_LAMPORTS]);
  assert.equal(describeStep(s), 'N=7: emprestar 0.01 SOL para as taxas da frase 4 (volta ao destino no fim)');
  assert.equal(describeStep(s, (i) => `Conta ${i + 1}`), 'Conta 8: emprestar 0.01 SOL para as taxas da frase 4 (volta ao destino no fim)');
});

// o executor nunca empresta a partir de outra carteira que não a pagadora do plano, nem para outro destino:
// um plano montado à mão com o passo torto é recusado antes de qualquer leitura da rede
test('empréstimo: executor recusa passo fund cuja carteira não é a pagadora ou cujo destino não é o do plano', async () => {
  const { execute } = await import('../../src/core/limpeza/executor.ts');
  const fake = (address: string) => ({ address, sign: () => new Uint8Array(64) });
  const rpc = { call: async () => { throw new Error('a rede não deveria ser consultada'); } };
  const o = fundingOffer(4, need, [lender(1, 50_000_000)])!;
  const good = fundingPlan(o);
  const signers = new Map([[7, fake('P1')], [3, fake('X3')]]);
  // dona do passo (N=3) diferente da pagadora (N=7)
  const wrongOwner = { ...good, steps: [{ ...good.steps[0]!, walletIndex: 3, wallet: 'X3' }] };
  await assert.rejects(execute({ rpc, plan: wrongOwner as typeof good, signers, mode: 'simulate', priority: 'off' }), /Só a pagadora empresta/);
  // destino do passo diferente do destino do plano
  const wrongTo = { ...good, destination: 'OUTRO' };
  await assert.rejects(execute({ rpc, plan: wrongTo, signers, mode: 'simulate', priority: 'off' }), /destino do empréstimo não confere/);
});
