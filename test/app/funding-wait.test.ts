import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForFunding } from '../../src/app/funding-wait.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';

const W = [{ index: 1, address: 'A1' }];
// RPC falso: cada chamada de getMultipleAccounts consome uma resposta da fila (número = saldo, Error = falha)
function fakeRpc(queue: Array<number | Error>) {
  let calls = 0;
  const rpc: RpcClient = {
    call: async <T>(m: string) => {
      assert.equal(m, 'getMultipleAccounts');
      calls++;
      const r = queue.length > 1 ? queue.shift()! : queue[0]!;
      if (r instanceof Error) throw r;
      return { value: [{ lamports: r }] } as T;
    },
  };
  return { rpc, calls: () => calls };
}

test('espera: libera quando o saldo cobre a reserva', async () => {
  const { rpc } = fakeRpc([0, 0, 3_000_000]);
  const sleeps: number[] = [];
  const got = await waitForFunding({ rpc, wallets: W, signal: new AbortController().signal, passes: (b) => b.get(1)! >= 3_000_000, sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(got?.get(1), 3_000_000);
  assert.deepEqual(sleeps, [5000, 5000]);
});

test('espera: abaixo da reserva continua esperando', async () => {
  const { rpc, calls } = fakeRpc([2_999_999]);
  const ctl = new AbortController();
  let rounds = 0;
  const got = await waitForFunding({ rpc, wallets: W, signal: ctl.signal, passes: (b) => b.get(1)! >= 3_000_000, sleep: async () => { if (++rounds === 4) ctl.abort(); } });
  assert.equal(got, null);
  assert.equal(calls(), 4);
});

test('espera: erro de rede numa volta não derruba', async () => {
  const { rpc } = fakeRpc([new RpcError('falha'), 5_000_000]);
  const got = await waitForFunding({ rpc, wallets: W, signal: new AbortController().signal, passes: (b) => b.get(1)! >= 3_000_000, sleep: async () => {} });
  assert.equal(got?.get(1), 5_000_000);
});

test('espera: cancelada não emite nada', async () => {
  const { rpc, calls } = fakeRpc([9_000_000]);
  const ctl = new AbortController();
  ctl.abort();
  assert.equal(await waitForFunding({ rpc, wallets: W, signal: ctl.signal, passes: () => true, sleep: async () => {} }), null);
  assert.equal(calls(), 0);
});

test('espera: o timer padrão acorda com o abort (não segura o processo)', async () => {
  const { rpc } = fakeRpc([0]);
  const ctl = new AbortController();
  const p = waitForFunding({ rpc, wallets: W, signal: ctl.signal, passes: () => false, intervalMs: 60_000 });
  setTimeout(() => ctl.abort(), 20);
  assert.equal(await p, null);
});

test('espera: passes que lança não derruba a espera', async () => {
  const { rpc } = fakeRpc([1]);
  let n = 0;
  const got = await waitForFunding({ rpc, wallets: W, signal: new AbortController().signal, passes: () => { if (++n < 3) throw new Error('x'); return true; }, sleep: async () => {} });
  assert.equal(got?.get(1), 1);
});

// As esperas de depósito são POR FRASE (cada frase paga as próprias taxas, no próprio cartão):
// mesmas regras de antes, agora com a frase como argumento.
test('app: encerrar cancela a espera', async () => {
  const { armFundingAbort, cancelFundingWait, fundingWaitActive, newFrase } = await import('../../src/app/server.ts');
  const f = newFrase(1);
  const ctl = armFundingAbort(f);
  assert.equal(ctl.signal.aborted, false);
  assert.equal(fundingWaitActive(f), true);
  cancelFundingWait(f);
  assert.equal(ctl.signal.aborted, true);
  assert.equal(fundingWaitActive(f), false);
});

test('app: espera cancelada depois de resolver não monta plano nem emite', async () => {
  const { armFundingAbort, cancelFundingWait, completeFunding, newFrase } = await import('../../src/app/server.ts');
  const f = newFrase(1);
  const ctl = armFundingAbort(f);
  cancelFundingWait(f);
  let ready = 0;
  assert.equal(completeFunding(f, ctl, () => void ready++), false);
  assert.equal(ready, 0);
  const ctl2 = armFundingAbort(f);
  assert.equal(completeFunding(f, ctl2, () => void ready++), true);
  assert.equal(ready, 1);
  const ctl3 = armFundingAbort(f); // outra espera assume: a antiga (ctl2, já concluída) não vale mais
  assert.equal(completeFunding(f, ctl2, () => void ready++), false);
  cancelFundingWait(f);
  void ctl3;
});

test('app: a espera de uma frase é só dela (armar ou cancelar a da frase 2 não mexe na da frase 1)', async () => {
  const { armFundingAbort, cancelFundingWait, completeFunding, fundingWaitActive, newFrase } = await import('../../src/app/server.ts');
  const f1 = newFrase(1);
  const f2 = newFrase(2, 'phantom');
  const c1 = armFundingAbort(f1);
  const c2 = armFundingAbort(f2);
  assert.equal(c1.signal.aborted, false, 'armar a da frase 2 não cancela a da frase 1');
  assert.equal(completeFunding(f1, c2, () => assert.fail('controle da frase 2 não conclui a frase 1')), false);
  cancelFundingWait(f2);
  assert.equal(fundingWaitActive(f1), true);
  assert.equal(c1.signal.aborted, false);
  cancelFundingWait(f1);
});

test('app: no Phantom, o plano adiado usa só as contas já selecionadas (nunca a Conta 1 nem as protegidas)', async () => {
  const { scansForPlan, planForWait } = await import('../../src/app/server.ts');
  const { deriveBurner, mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const mk = (i: number) => ({ index: i, address: deriveBurner(seed, i, 'phantom').address, lamports: 5_000_000, tokens: [], fees: null, errors: [] as string[] });
  const all = [mk(0), mk(1), mk(2), mk(3)];
  const dest = deriveBurner(seed, 9, 'phantom').address;
  // Conta 3 (índice 2) protegida; 2 contas a limpar (índices 1 e 3)
  const sel = scansForPlan('phantom', all, all, [3], 2);
  assert.deepEqual(sel.map((s) => s.index), [1, 3]);
  const plan = planForWait({ scans: sel, decisions: new Map(), destino: dest, app: 'phantom', prices: new Map(), rentExemptZero: 890_880 });
  const touched = new Set(plan.steps.map((s) => s.walletIndex));
  assert.equal(touched.has(0), false, 'Conta 1 fora');
  assert.equal(touched.has(2), false, 'protegida fora');
  assert.equal(touched.has(1) && touched.has(3), true);
  assert.equal(plan.destination, dest);
});

// ---- orquestração do servidor, ponta a ponta (RPC falso, sem rede) ----
async function setup(balances: number[]) {
  const sv = await import('../../src/app/server.ts');
  const { deriveBurner, mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const { FeePayerError, MIN_FUNDING_LAMPORTS } = await import('../../src/core/limpeza/plan.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const mk = (i: number) => ({ index: i, address: deriveBurner(seed, i, 'solflare').address, lamports: 100, tokens: [], fees: null, errors: [] as string[] });
  const scans = [mk(1), mk(2)];
  const dest = deriveBurner(seed, 9, 'solflare').address;
  const S = sv.sessionForTest();
  const f = sv.newFrase(1);
  f.status = 'pronta';
  f.scans = scans;
  f.feeWarning = 'aviso';
  f.plan = null;
  S.frases = [f];
  const queue = [...balances];
  const rpc: RpcClient = {
    call: async <T>() => {
      const b = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { value: scans.map((s) => ({ lamports: s.index === 1 ? b : 0 })) } as T;
    },
  };
  const events: Array<[string, unknown]> = [];
  // teto de voltas: se a regra quebrar e a reserva nunca "passar", o teste falha nas asserções em vez de travar
  let rounds = 0;
  const deps = { rpc, emit: (t: string, d: unknown) => void events.push([t, d]), sleep: async () => { if (++rounds > 20) sv.cancelFundingWait(f); } };
  const ctx = { scans, decisions: new Map(), destino: dest, app: 'solflare' as const, prices: new Map(), rentExemptZero: 890_880 };
  let first: InstanceType<typeof FeePayerError>;
  try { sv.planForWait(ctx); assert.fail('devia pedir depósito'); } catch (e) { if (!(e instanceof FeePayerError)) throw e; first = e; }
  return { sv, S, f, scans, deps, ctx, first, events, suggested: MIN_FUNDING_LAMPORTS };
}

// Taxa do app (autor, 31/10/2026): isento só o que o cliente DEPOSITOU; juntado e emprestado são SOL esquecido.
test('taxa: depósito = saldo agora − saldo na análise − o que chegou por juntar ou empréstimo; nunca negativo', async () => {
  const sv = await import('../../src/app/server.ts');
  const scan = (index: number, lamports: number) => ({ index, address: `W${index}`, lamports, tokens: [], fees: null, errors: [] });
  const ok = (destinationDelta: bigint) => ({ status: 'enviado', destinationDelta }) as never;
  const base = { scans: [scan(0, 12_000_000), scan(1, 0), scan(2, 4_000_000)], analysisLamports: new Map([[0, 2_000_000], [1, 0], [2, 9_000_000]]), gathering: null, funding: null };
  // só depósito: 10 milhões na pagadora (0); a 2 perdeu SOL (juntou para outra) e não tem isenção
  assert.deepEqual([...sv.depositsOf(base as never)], [[0, 10_000_000n]]);
  // juntado: 5 milhões vieram de outras temporárias da frase (esquecido): sobra 5 de depósito
  const gathered = { ...base, gathering: { toIndex: 0, results: [ok(3_000_000n), ok(2_000_000n), { status: 'falhou', destinationDelta: 9n }] } };
  assert.deepEqual([...sv.depositsOf(gathered as never)], [[0, 5_000_000n]], 'transferência que falhou não conta');
  // emprestado por outra frase (esquecido de lá) + juntado: nada é depósito
  const lent = { ...gathered, funding: { toIndex: 0, lamports: 5_000_000n, result: ok(5_000_000n) } };
  assert.deepEqual([...sv.depositsOf(lent as never)], []);
  // empréstimo que não foi enviado não conta como entrada
  const failedLoan = { ...base, funding: { toIndex: 0, lamports: 4_000_000n, result: { status: 'falhou' } } };
  assert.deepEqual([...sv.depositsOf(failedLoan as never)], [[0, 10_000_000n]]);
  // sem o saldo da análise (frase antiga, terminal): nada isento
  assert.deepEqual([...sv.depositsOf({ ...base, analysisLamports: new Map() } as never)], []);
});

test('taxa: o plano montado depois do depósito leva o depósito como isento da pagadora', async () => {
  const { sv, f, scans, deps, ctx, first } = await setup([100, 2_000_000]);
  f.analysisLamports = new Map(scans.map((s) => [s.index, s.lamports]));
  await sv.startPlanWait(f, first, { ...ctx, deposits: () => sv.depositsOf(f) }, deps);
  assert.ok(f.plan, 'plano montado');
  assert.equal(f.plan!.feePayerIndex, 1);
  assert.equal(f.plan!.payerExemptLamports, 2_000_000n - 100n, 'o que chegou depois da análise');
  f.plan = null;
});

test('espera/plano: depósito acima da reserva (mas abaixo do sugerido) monta o plano, 1 evento fundos', async () => {
  const { sv, S, f, scans, deps, ctx, first, events, suggested } = await setup([100, 2_000_000]);
  assert.ok(2_000_000n < suggested, 'o depósito é menor que o valor sugerido');
  S.simResults = [{} as never];
  S.execResults = [{} as never];
  S.executed = true;
  await sv.startPlanWait(f, first, ctx, deps);
  assert.equal(scans[0]!.lamports, 2_000_000, 'saldo lido foi para o scan');
  assert.ok(f.plan, 'plano montado na frase');
  assert.deepEqual([S.simResults, S.execResults], [[], []]);
  assert.equal(S.executed, true, 'uma execução por rodada: plano novo não zera o executado (só uma nova análise)');
  assert.equal(f.feeWarning, null);
  assert.equal(f.feeWait, null);
  assert.equal(events.filter((e) => e[0] === 'fundos').length, 1);
  assert.equal(S.busy, null);
  f.plan = null;
  S.executed = false;
});

test('espera/análise: ao cobrir a reserva só limpa o aviso, nunca monta plano', async () => {
  const { sv, S, f, deps, ctx, first, events } = await setup([100, 2_000_000]);
  await sv.startAnalysisWait(f, first, ctx, deps);
  assert.equal(f.plan, null);
  assert.equal(f.feeWarning, null);
  assert.equal(f.feeWait, null);
  assert.equal(events.filter((e) => e[0] === 'fundos').length, 1);
});

// "Analisar de novo" no aviso de falta de SOL: confere o saldo das mesmas burners, sem frase e sem voltar ao início
async function setupRecheck(balances: number[]) {
  const r = await setup(balances);
  r.S.busy = null;
  r.S.rpc = r.deps.rpc as never;
  r.f.main = r.ctx.destino;
  r.f.app = 'solflare';
  r.S.rentExemptZero = r.ctx.rentExemptZero;
  r.S.prices = { prices: new Map(), info: new Map(), solUsd: null, errors: [] };
  return r;
}

test('analisar de novo: SOL já chegou → tira o aviso sozinho, sem montar plano', async () => {
  const { sv, f, scans } = await setupRecheck([2_000_000]);
  assert.equal(sv.fundingWaitActive(f), false);
  await sv.recheckFunding(1);
  assert.equal(scans[0]!.lamports, 2_000_000, 'leu o saldo de agora');
  assert.equal(f.feeWarning, null);
  assert.equal(f.feeWait, null);
  assert.equal(f.plan, null);
});

test('analisar de novo: SOL ainda não chegou → passa a esperar o depósito (não volta ao início)', async () => {
  const { sv, f } = await setupRecheck([100]);
  const wait = sv.recheckFunding(1);
  assert.ok(wait, 'armou a espera');
  assert.equal(sv.fundingWaitActive(f), true);
  assert.ok(f.feeWait?.waiting);
  assert.ok(f.feeWarning, 'o aviso continua até o SOL chegar');
  sv.cancelFundingWait(f);
  await wait;
});

test('analisar de novo: espera já ativa não é trocada; sem aviso, ocupado ou frase que não existe é recusado', async () => {
  const { sv, S, f } = await setupRecheck([100]);
  const ctl = sv.armFundingAbort(f);
  assert.equal(sv.recheckFunding(1), undefined);
  assert.equal(ctl.signal.aborted, false, 'a espera atual continua');
  sv.cancelFundingWait(f);
  assert.throws(() => sv.recheckFunding(2), sv.BadRequest, 'frase 2 não existe');
  assert.throws(() => sv.recheckFunding(undefined), sv.BadRequest);
  S.busy = 'simulacao';
  assert.throws(() => sv.recheckFunding(1), sv.BadRequest);
  S.busy = null;
  f.feeWarning = null;
  assert.throws(() => sv.recheckFunding(1), sv.BadRequest);
});

test('espera: novo FeePayerError atualiza os parâmetros do feeWait e segue esperando', async () => {
  const { sv, f, scans, deps, first } = await setup([100, 100, 2_000_000]);
  const { FeePayerError } = await import('../../src/core/limpeza/plan.ts');
  let n = 0;
  const seen: unknown[] = [];
  const attempt = () => {
    if (n++ === 0) throw new FeePayerError(77_000_000n, 2, scans[1]!.address);
    seen.push(f.feeWait?.params);
    throw n < 3 ? new FeePayerError(77_000_000n, 2, scans[1]!.address) : new Error('x');
  };
  // 1ª volta: erro novo troca os params; depois a espera continua e é cancelada
  const ctlDeps = { ...deps, sleep: async () => { if (n >= 3) sv.cancelFundingWait(f); } };
  await sv.startFundingWait(f, first, scans, attempt as never, () => assert.fail('não devia ficar pronto'), ctlDeps);
  assert.equal((seen[0] as { sendSol: number }).sendSol, 0.077);
  assert.equal(f.feeWait, null, 'cancelada limpa o feeWait');
});

// frase pronta com as leituras dadas, sozinha na rodada
async function oneFrase(app: 'solflare' | 'phantom', scans: unknown[], rpc: unknown) {
  const sv = await import('../../src/app/server.ts');
  const S = sv.sessionForTest();
  const f = sv.newFrase(1, app);
  f.status = 'pronta';
  f.scans = scans as never;
  f.holdings = [];
  f.known = [];
  S.frases = [f];
  S.rpc = rpc as never;
  S.busy = null;
  return { sv, S, f };
}

test('espera: pedido de plano malformado não cancela a espera da análise', async () => {
  const { sv, f } = await oneFrase('solflare', [{ index: 1, address: 'x', lamports: 0, tokens: [], fees: null, errors: [] }], {});
  const ctl = sv.armFundingAbort(f);
  await assert.rejects(sv.montarPlano({ destino: 'lixo' }), sv.BadRequest);
  assert.equal(ctl.signal.aborted, false);
  sv.cancelFundingWait(f);
});

test('espera: Phantom com número de contas errado não cancela a espera da análise', async () => {
  const { deriveBurner, mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const mk = (i: number) => ({ index: i, address: deriveBurner(seed, i, 'phantom').address, lamports: 0, tokens: [], fees: null, errors: [] as string[] });
  const { sv, f } = await oneFrase('phantom', [mk(1), mk(2)], { call: async () => ({ value: { owner: '11111111111111111111111111111111', lamports: 5_000_000 } }) });
  f.discovery = { wallets: [{ index: 0 }, { index: 1 }, { index: 2 }] } as never;
  const ctl = sv.armFundingAbort(f);
  const dest = deriveBurner(seed, 9, 'phantom').address;
  await assert.rejects(sv.montarPlano({ destino: dest, destino2: dest, porFrase: { 1: { contasConfirmadas: 5 } } }), /Confirme quantas contas/);
  assert.equal(ctl.signal.aborted, false, 'a espera da análise continua');
  sv.cancelFundingWait(f);
});

test('espera: destino recusado (não existe na rede) não cancela a espera da análise', async () => {
  const { deriveBurner, mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const { sv, f } = await oneFrase('solflare', [{ index: 1, address: deriveBurner(seed, 1, 'solflare').address, lamports: 0, tokens: [], fees: null, errors: [] }], { call: async () => ({ value: null }) });
  f.discovery = { wallets: [{ index: 1 }] } as never;
  const ctl = sv.armFundingAbort(f);
  const dest = deriveBurner(seed, 9, 'solflare').address;
  await assert.rejects(sv.montarPlano({ destino: dest, destino2: dest }), /ainda não existe/);
  assert.equal(ctl.signal.aborted, false, 'a espera da análise continua');
  sv.cancelFundingWait(f);
});

test('espera: plano novo montado na hora cancela a espera antiga (decisões velhas não voltam depois)', async () => {
  const { deriveBurner, mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const { sv, S, f } = await oneFrase('solflare', [{ index: 1, address: deriveBurner(seed, 1, 'solflare').address, lamports: 50_000_000, tokens: [], fees: null, errors: [] }], {
    call: async () => ({ value: { owner: '11111111111111111111111111111111', lamports: 5_000_000 } }),
  });
  f.discovery = { wallets: [{ index: 1 }] } as never;
  const old = sv.armFundingAbort(f); // espera de um plano anterior, com decisões antigas
  S.prices = { prices: new Map(), errors: [] } as never;
  S.rentExemptZero = 890_880;
  const dest = deriveBurner(seed, 9, 'solflare').address;
  await sv.montarPlano({ destino: dest, destino2: dest });
  assert.ok(f.plan, 'plano novo pronto');
  assert.equal(old.signal.aborted, true, 'a espera antiga parou');
  assert.equal(sv.completeFunding(f, old, () => assert.fail('espera antiga não pode montar plano')), false);
  sv.cancelFundingWait(f);
  f.plan = null;
});
