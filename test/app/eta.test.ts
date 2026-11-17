import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ETA_CLIP, ETA_PRIOR_FADE, ETA_WINDOW, RUN_COSTS, createEta, estimateRun } from '../../src/app/eta.ts';

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

test('eta: antes da base devolve null', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  c.advance(1000);
  eta.tick(1);
  assert.equal(eta.remainingMs(), null);
});

test('eta: com velocidade constante o restante só cai', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  let prev = Infinity;
  for (let done = 1; done <= 100; done++) {
    c.advance(500);
    eta.tick(done);
    const r = eta.remainingMs();
    if (r !== null) {
      assert.ok(r <= prev, `item ${done}: ${r} > ${prev}`);
      prev = r;
    }
    if (done === 50) {
      assert.ok(r !== null && r >= 20_000 && r <= 30_000, `item 50: ${r}`);
    }
  }
});

test('eta: setTotal maior (busca achou mais) aumenta o restante', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  for (let done = 1; done <= 10; done++) {
    c.advance(500);
    eta.tick(done);
  }
  const antes = eta.remainingMs();
  assert.ok(antes !== null);
  eta.setTotal(200);
  const depois = eta.remainingMs();
  assert.ok(depois !== null && Number.isFinite(depois));
  assert.ok(depois > antes);
});

test('eta: estimateRun', () => {
  const a = estimateRun({ frases: 10, customRpc: true, stage: 'analysis' });
  assert.equal(a.wallets, 1000);
  assert.equal(a.credits, 1000 * RUN_COSTS.analysisCreditsPerWallet);
  // público: a análise é presa pela leitura de tokens (0,9/s por método no RPC oficial), ~1 req/s efetiva
  const p = estimateRun({ frases: 10, customRpc: false, stage: 'analysis' });
  assert.equal(p.seconds, (1000 * RUN_COSTS.analysisReqPerWallet + 10 * RUN_COSTS.discoveryReqPerFrase) / RUN_COSTS.rpsPublicAnalysis);
  // RPC próprio: o piso são as buscas por programa pelo público (0,9/s): curvas, fee dividida e Meteora, 3 por carteira
  assert.equal(RUN_COSTS.gpaPerWallet, 3, 'o cofre do LaunchLab é PDA: não soma busca por programa');
  // leitura por carteira: 3,05 medidos + Meteora (1 getProgramAccounts) + LaunchLab (1 getMultipleAccounts, contado em
  // test/limpeza/launchlab.test.ts); créditos: + 1 do LaunchLab
  assert.equal(RUN_COSTS.analysisReqPerWallet, 5.05);
  assert.equal(RUN_COSTS.analysisCreditsPerWallet, 5.9);
  assert.equal(a.seconds, (1000 * RUN_COSTS.gpaPerWallet) / RUN_COSTS.gpaRpsPublic);
  assert.ok(a.seconds < p.seconds, 'mesmo com o piso, o Helius é mais rápido que o público');
  assert.equal(RUN_COSTS.rpsPublicAnalysis, 1);
  const w = estimateRun({ frases: 3, wallets: 25, customRpc: true, stage: 'execute' });
  assert.equal(w.wallets, 25);
  assert.equal(w.seconds, 25 * RUN_COSTS.execSecPerWallet);
  assert.equal(w.credits, 25 * RUN_COSTS.execReqPerWallet);
  const s = estimateRun({ frases: 1, customRpc: true, stage: 'simulate' });
  assert.equal(s.credits, 100 * RUN_COSTS.simReqPerWallet);
});

test('eta: abaixo de 3 s devolve null mesmo com 10 itens', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  for (let d = 1; d <= 10; d++) { c.advance(100); eta.tick(d); }
  assert.equal(eta.remainingMs(), null);
});

test('eta: abaixo de 3 itens devolve null mesmo após 5 s', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  c.advance(2500); eta.tick(1);
  c.advance(2500); eta.tick(2);
  assert.equal(eta.remainingMs(), null);
});

test('eta: passado 3 s e 3 itens devolve número', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  for (let d = 1; d <= 3; d++) { c.advance(1500); eta.tick(d); }
  const r = eta.remainingMs();
  assert.ok(r !== null && Number.isFinite(r));
});

test('eta: a velocidade é a média dos últimos 20 itens (rede 2× mais lenta: o número acompanha em 20 itens)', () => {
  assert.equal(ETA_WINDOW, 20);
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  let d = 0;
  for (let i = 0; i < 10; i++) { c.advance(500); eta.tick(++d); }
  for (let i = 0; i < 10; i++) { c.advance(1000); eta.tick(++d); }
  // janela com 10 a 500 e 10 a 1000: 750 por item, 80 restantes
  assert.equal(eta.remainingMs(), 80 * 750);
  for (let i = 0; i < 10; i++) { c.advance(1000); eta.tick(++d); }
  // janela só com itens a 1000: a velocidade antiga não pesa mais
  assert.equal(eta.remainingMs(), 70 * 1000);
});

test('eta: um item lento no meio não faz o número pular (amostra limitada a 3× a média, 1/20 da janela)', () => {
  assert.equal(ETA_CLIP, 3);
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  for (let d = 1; d <= 50; d++) { c.advance(500); eta.tick(d); }
  const antes = eta.remainingMs()!;
  assert.equal(antes, 50 * 500);
  c.advance(5000); // uma carteira de 5 s (nova tentativa, confirmação demorada)
  eta.tick(51);
  const depois = eta.remainingMs()!;
  // 49 restantes: sem a regra daria 49 × (19×500 + 5000)/20 = 35 525 (+45%); com o limite 3×: 49 × 550 = 26 950 (+10%)
  assert.equal(depois, 49 * 550);
  assert.ok(depois <= antes * 1.1, `depois=${depois} antes=${antes}`);
});

test('eta: ruído item a item (300/700 alternados) some na janela', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100);
  let prev: number | null = null;
  let maxJump = 0;
  for (let d = 1; d <= 90; d++) {
    c.advance(d % 2 ? 300 : 700);
    eta.tick(d);
    const r = eta.remainingMs();
    if (r !== null && prev !== null && d > 25) maxJump = Math.max(maxJump, Math.abs(r - prev) / prev);
    prev = r;
  }
  // a cada item a estimativa muda no máximo ~10% (entra 300 ou 700 no lugar de um item da janela, mais o item concluído)
  assert.ok(maxJump < 0.1, `salto máximo ${(maxJump * 100).toFixed(1)}%`);
});

test('eta: com prévia há número desde o segundo 0, e ele cai antes de qualquer medição', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(100, 60_000); // prévia: 60 s para 100 itens
  assert.equal(eta.remainingMs(), 60_000);
  c.advance(1000);
  eta.tick(1); // menos de 3 s e de 3 itens: sem medição, só a prévia
  assert.equal(eta.remainingMs(), 99 * 600);
  // sem prévia continua null no mesmo ponto (comportamento antigo)
  const semPrevia = createEta(c.now);
  semPrevia.start(100);
  c.advance(1000);
  semPrevia.tick(1);
  assert.equal(semPrevia.remainingMs(), null);
  // prévia inválida ou total 0: ignorada, sem NaN
  const ruim = createEta(c.now);
  ruim.start(100, NaN);
  assert.equal(ruim.remainingMs(), null);
  const zero = createEta(c.now);
  zero.start(0, 60_000);
  assert.equal(zero.remainingMs(), null);
});

test('eta: a prévia errada some conforme a medição entra (toda a partir de 20 itens)', () => {
  assert.equal(ETA_PRIOR_FADE, 0.2);
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(1000, 1000 * 1000); // prévia: 1000 ms por item; a rede real faz 500
  const ratio = (d: number) => eta.remainingMs()! / ((1000 - d) * 500);
  for (let d = 1; d <= 10; d++) { c.advance(500); eta.tick(d); }
  // 10 itens: metade do caminho (fade = min(20, 20% de 1000) = 20) → 750 por item
  assert.ok(Math.abs(ratio(10) - 1.5) < 0.01, `10 itens: ${ratio(10)}`);
  for (let d = 11; d <= 20; d++) { c.advance(500); eta.tick(d); }
  assert.ok(Math.abs(ratio(20) - 1) < 0.01, `20 itens: ${ratio(20)}`);
  // total pequeno (10 passos): a prévia some em 20% de 10 = 2 → já no 3º item (mínimo da medição)
  const small = createEta(c.now);
  small.start(10, 10 * 1000);
  for (let d = 1; d <= 3; d++) { c.advance(1500); small.tick(d); }
  assert.equal(small.remainingMs(), 7 * 1500);
});

test('eta: com prévia, nunca null depois do start; tudo feito dá 0', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(50, 25_000);
  for (let d = 1; d <= 50; d++) {
    c.advance(d === 7 ? 9000 : 400);
    eta.tick(d);
    const r = eta.remainingMs();
    assert.ok(r !== null && Number.isFinite(r) && r >= 0, `item ${d}: ${r}`);
  }
  assert.equal(eta.remainingMs(), 0);
});

test('eta: tick que pula itens (frase pronta de uma vez) pesa pelos itens pulados', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.start(200);
  for (let d = 1; d <= 10; d++) { c.advance(500); eta.tick(d); }
  c.advance(50_000); // 100 itens de uma vez em 50 s: 500 por item
  eta.tick(110);
  assert.equal(eta.remainingMs(), 90 * 500);
});

test('eta: entradas inválidas e tick antes do start são ignorados', () => {
  const c = fakeClock();
  const eta = createEta(c.now);
  eta.tick(5);
  c.advance(10_000);
  assert.equal(eta.remainingMs(), null);
  eta.start(100);
  for (let d = 1; d <= 5; d++) { c.advance(1000); eta.tick(d); }
  const antes = eta.remainingMs();
  assert.ok(antes !== null);
  eta.tick(NaN); eta.tick(-3); eta.tick(Infinity);
  eta.setTotal(NaN); eta.setTotal(Infinity); eta.setTotal(-1);
  assert.equal(eta.remainingMs(), antes);
});

test('estimateRun: simulação e envio no RPC público', () => {
  const s = estimateRun({ frases: 1, customRpc: true, stage: 'simulate' });
  assert.equal(s.seconds, (100 * RUN_COSTS.simReqPerWallet) / RUN_COSTS.rpsCustom);
  // público: envio a ~5 s por carteira (limpeza real de 30/10/2026: 83 transações em ~7 min), rpsPublic = 4
  const e = estimateRun({ frases: 1, wallets: 10, customRpc: false, stage: 'execute' });
  assert.equal(e.seconds, 5 * 10);
  assert.equal(RUN_COSTS.rpsPublic, 4);
});

test('estimateRun: com wallets explícito a análise não soma a descoberta', () => {
  const a = estimateRun({ frases: 5, wallets: 50, customRpc: true, stage: 'analysis' });
  assert.equal(a.seconds, Math.max((50 * RUN_COSTS.analysisReqPerWallet) / RUN_COSTS.rpsCustom, (50 * RUN_COSTS.gpaPerWallet) / RUN_COSTS.gpaRpsPublic));
  const pub = estimateRun({ frases: 5, wallets: 50, customRpc: false, stage: 'analysis' });
  assert.equal(pub.seconds, (50 * RUN_COSTS.analysisReqPerWallet) / RUN_COSTS.rpsPublicAnalysis);
});

// a busca de uma frase 'auto' passa nos três caminhos (Solflare, Phantom, Trust: 06/11/2026). Contado no laço:
// 100 temporárias usadas = 120 consultas; cada caminho só com a principal (ou vazio) = 30
test('eta: busca da frase conta os três caminhos (120 + 30 + 30)', async () => {
  const { discoverBurners } = await import('../../src/core/limpeza/scan.ts');
  const { mnemonicToSeed } = await import('../../src/core/carteiras/derivation.ts');
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const count = async (app: 'solflare' | 'phantom' | 'trust', used: number) => {
    let calls = 0;
    const rpc = { call: async <T>(_m: string, p: unknown[]) => { calls++; return (p[0] && usedSet.has(p[0] as string) ? [{ signature: 'x' }] : []) as T; } };
    const { deriveBurner } = await import('../../src/core/carteiras/derivation.ts');
    const usedSet = new Set(Array.from({ length: used }, (_, i) => deriveBurner(seed, i, app).address));
    await discoverBurners(seed, rpc, { app });
    return calls;
  };
  const total = (await count('solflare', 100)) + (await count('phantom', 1)) + (await count('trust', 1));
  assert.equal(total, 180);
  assert.equal(RUN_COSTS.discoveryReqPerFrase, total);
});
