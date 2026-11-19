// Tela de resumo (total + cartão por frase), simulação e execução por frase: as regras puras da página, sem DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

const block = (name: string) => {
  const start = HTML.indexOf(`// ${name}:inicio`);
  const end = HTML.indexOf(`// ${name}:fim`);
  assert.ok(start > 0 && end > start, `marcadores de ${name}`);
  return HTML.slice(start, end);
};
type Obj = Record<string, unknown>;
type R = {
  plannable: (f: Obj) => boolean;
  canPlan: (s: Obj) => boolean;
  waitingFrases: (s: Obj) => number[];
  summaryView: (s: Obj | null) => Obj & { totalLamports: bigint; usd: number | null };
  fraseCardView: (f: Obj, hs: Obj[]) => Obj & { kind: string; sub: { key: string }[]; valueLamports: bigint | null; err: Obj | null };
  leftOut: (s: Obj) => { n: number; why: string }[];
  rpcIsCustom: (l: unknown) => boolean;
  planStepCount: (s: Obj) => number;
  runRowsView: (s: Obj, items: Obj[], p: Obj | null, done: boolean) => (Obj & { kind: string; n: number; sentLamports: bigint; failed: number; head: { key: string; params: Obj } })[];
};
const R: R = new Function(`${block('regras')}\n${block('analise')}\n${block('resumo')}; return { plannable, canPlan, waitingFrases, summaryView, fraseCardView, leftOut, rpcIsCustom, planStepCount, runRowsView };`)();
type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = new Function(`${block('i18n')}; return I18N;`)();

const WAIT = { code: 'no-fee-sol', params: { wallet: 'W' }, waiting: true };
const W = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, errors: [] }));
const ready = (n: number, over: Obj = {}) => ({
  n, app: 'solflare', status: 'pronta', main: `Main${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, discovery: { found: 3, checked: 23, reachedMax: false },
  wallets: W(3), totals: { recoverableLamports: String(n * 1_000_000_000) }, feeWarning: null, feeWait: null, nothingToClean: false, planNotice: null, ...over,
});
const bad = (n: number, code = 'seed-checksum') => ({ n, app: 'solflare', status: 'erro', error: { code, params: {} }, wallets: [], main: null });

test('resumo: total das frases prontas, US$ só com preço do SOL, chips de decisão, NFT, puladas e esperando', () => {
  const s = {
    frases: [ready(1), bad(2), ready(3, { feeWait: WAIT })],
    holdings: [{ frase: 1, kind: 'fungible' }, { frase: 1, kind: 'nft' }, { frase: 3, kind: 'fungible' }],
    totals: { recoverableLamports: '4000000000' },
    solUsd: 150,
  };
  const v = R.summaryView(s);
  assert.equal(v.analysed, 2, 'a frase pulada não conta como analisada');
  assert.equal(v.totalLamports, 4_000_000_000n);
  assert.equal(v.usd, 600);
  assert.equal(v.wallets, 6);
  assert.deepEqual([v.decide, v.nfts, v.skipped, v.waiting, v.plannable], [2, 1, 1, 1, 2]);
  assert.equal(v.allEmpty, false);
  assert.equal(R.summaryView({ ...s, solUsd: null }).usd, null, 'sem preço do SOL: sem US$ (nunca US$ 0)');
  assert.equal(R.summaryView({ ...s, totals: { recoverableLamports: 'lixo' } }).totalLamports, 0n, 'dado fora do formato não derruba a tela');
  assert.equal(R.summaryView(null).analysed, 0);
  // todas vazias: sem destino, só "analisar outras"
  assert.equal(R.summaryView({ frases: [ready(1, { nothingToClean: true }), ready(2, { nothingToClean: true })] }).allEmpty, true);
  assert.equal(R.summaryView({ frases: [ready(1, { nothingToClean: true }), bad(2)] }).allEmpty, false, 'frase pulada pede atenção');
});

test('resumo: destino aparece quando alguma frase pode ser planejada sem esperar SOL da análise', () => {
  assert.equal(R.plannable(ready(1)), true);
  assert.equal(R.plannable(ready(1, { nothingToClean: true })), false);
  assert.equal(R.plannable(ready(1, { wallets: [] })), false, 'frase sem nenhuma usada');
  assert.equal(R.plannable(bad(1)), false);
  assert.equal(R.plannable(ready(1, { planNotice: { code: 'phantom-all-protected' } })), true, 'desmarcar uma conta inclui a frase de novo');
  assert.equal(R.canPlan({ frases: [ready(1, { feeWarning: 'falta', feeWait: WAIT }), ready(2)] }), true, 'a frase 2 vai; a 1 espera no plano');
  assert.equal(R.canPlan({ frases: [ready(1, { feeWarning: 'falta', feeWait: WAIT })] }), false, 'só falta SOL: espera o depósito');
  assert.equal(R.canPlan({ frases: [bad(1), ready(2, { nothingToClean: true })] }), false);
});

test('resumo: cartão da frase — ok, esperando depósito, vazia, Phantom toda protegida e erro com o motivo', () => {
  const ok = R.fraseCardView(ready(1), [{ kind: 'fungible' }, { kind: 'fungible' }, { kind: 'nft' }]);
  assert.equal(ok.kind, 'ok');
  assert.equal(ok.valueLamports, 1_000_000_000n);
  assert.deepEqual(ok.sub.map((x) => x.key), ['res.chip.decide', 'res.chip.nfts']);
  assert.deepEqual(R.fraseCardView(ready(1), []).sub.map((x) => x.key), ['res.card.noDecision']);
  // espera do plano (sem feeWarning): o cartão diz "esperando", não some
  const wait = R.fraseCardView(ready(2, { feeWait: WAIT }), []);
  assert.equal(wait.kind, 'warn');
  assert.equal(wait.sub[0].key, 'res.card.waiting');
  assert.equal(R.fraseCardView(ready(2, { feeWarning: 'falta' }), []).sub[0].key, 'res.card.needSol');
  const empty = R.fraseCardView(ready(3, { nothingToClean: true, wallets: [] }), []);
  assert.equal(empty.kind, 'empty');
  assert.equal(empty.sub[0].key, 'res.card.nothing');
  assert.equal(R.fraseCardView(ready(4, { planNotice: { code: 'phantom-all-protected', params: { frase: 4 } } }), []).sub[0].key, 'res.card.allProtected');
  const e = R.fraseCardView(bad(5), []);
  assert.equal(e.kind, 'bad');
  assert.deepEqual(e.err, { code: 'seed-checksum', params: {} });
  assert.equal(e.valueLamports, null, 'frase pulada não tem valor (—), nunca 0');
  assert.equal(R.fraseCardView({ n: 6, status: 'erro', error: null }, []).err?.code, 'unknown', 'erro sem código');
});

test('resumo: textos novos do cartão e do plano parcial em pt e en, e o aviso da Phantom toda protegida', () => {
  for (const k of ['plan.partialGo', 'plan.waitAll', 'plan.out', 'plan.out.wait', 'plan.out.prot', 'plan.out.empty', 'plan.out.err']) {
    assert.ok(k in I18N.pt && k in I18N.en, k);
  }
  const go = I18N.en['plan.partialGo'] as (p: unknown) => string;
  assert.equal(go({ list: [2] }), 'Simulate now without phrase 2');
  assert.equal((I18N.pt['plan.partialGo'] as (p: unknown) => string)({ list: [2, 4] }), 'Simular agora sem as frases 2, 4');
  // o que trava o plano parcial está no código da tela, não só no texto
  assert.match(fnSource('afterPlan'), /let next = planNext\(state\);/);
  assert.match(fnSource('waitCard'), /onclick: simulateWithout/);
});

test('resumo: estimativa do botão "Simular" sabe se o RPC é próprio pelo rótulo do servidor', () => {
  const server = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'app', 'server.ts'), 'utf8');
  const suffix = /isPublic \? '([^']+)' : ''/.exec(server)?.[1];
  assert.equal(suffix, ' (público, mais lento)', 'o rótulo do RPC público continua o mesmo do servidor');
  assert.equal(R.rpcIsCustom(`api.mainnet-beta.solana.com${suffix}`), false);
  assert.equal(R.rpcIsCustom('mainnet.helius-rpc.com'), true);
  assert.equal(R.rpcIsCustom(''), false);
  assert.equal(R.rpcIsCustom(null), false);
});

const PLAN = { destination: 'D', frases: [{ frase: 1, app: 'solflare', steps: [{}, {}] }, { frase: 2, app: 'phantom', steps: [{}, {}, {}] }, { frase: 4, app: 'solflare', steps: [{}] }] };

test('simulação/execução: uma linha por frase — pronta (enviado e falhas), rodando (passo i de n), na fila, e "não rodou" depois de parar', () => {
  const s = { plan: PLAN };
  assert.equal(R.planStepCount(s), 6);
  assert.equal(R.planStepCount({}), 0);
  const items = [
    { frase: 1, status: 'enviado', destinationDelta: '1500000' },
    { frase: 1, status: 'falhou', destinationDelta: null },
    { frase: 2, status: 'enviado', destinationDelta: '250' },
  ];
  const p = { fase: 'execucao', frase: 2, feitos: 1, total: 3 };
  const rows = R.runRowsView(s, items, p, false);
  assert.deepEqual(rows.map((r) => r.kind), ['ok', 'run', 'wait']);
  assert.equal(rows[0].sentLamports, 1_500_000n);
  assert.equal(rows[0].failed, 1);
  assert.deepEqual(rows[1].head, { key: 'run.row.running', params: { passo: 2, total: 3 } });
  assert.equal(rows[1].mini, 33);
  // parou na frase 2: a 4 não rodou (nunca aparece como pronta)
  const stopped = R.runRowsView(s, items, null, true);
  assert.deepEqual(stopped.map((r) => r.kind), ['ok', 'ok', 'bad']);
  // aviso de progresso da análise não marca frase como rodando
  assert.deepEqual(R.runRowsView(s, [], { fase: 'leitura', frase: 1 }, false).map((r) => r.kind), ['wait', 'wait', 'wait']);
  assert.equal(R.runRowsView(s, [{ frase: 1, status: 'enviado', destinationDelta: 'x' }], null, true)[0].sentLamports, 0n, 'dado fora do formato vira 0');
});

// rodada de um tester (0.1.6): 4 frases, a 4ª sem nada para limpar; a tela do teste mostrava só 1, 2 e 3
test('simulação/execução: frase fora do plano aparece no fim da lista com o motivo, no teste e no envio', () => {
  const frases = [{ n: 1, app: 'solflare', status: 'pronta' }, { n: 2, app: 'phantom', status: 'pronta' }, { n: 3, app: 'solflare', status: 'pronta' },
    { n: 4, app: 'phantom', status: 'pronta', nothingToClean: true }, { n: 5, app: 'solflare', status: 'erro' }];
  const plan = { destination: 'D', frases: [1, 2, 3].map((n) => ({ frase: n, app: n === 2 ? 'phantom' : 'solflare', steps: [{}, {}] })) };
  for (const done of [false, true]) {
    const rows = R.runRowsView({ plan, frases }, [], null, done);
    assert.deepEqual(rows.map((r) => r.n), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows.slice(3).map((r) => [r.kind, r.app, (r.head.params as { why: string }).why]), [['out', 'phantom', 'empty'], ['out', 'solflare', 'err']]);
  }
  for (const lang of ['pt', 'en'] as const) {
    const row = I18N[lang]['run.row.out'] as (p: unknown) => string;
    for (const why of ['empty', 'err', 'wait', 'prot']) assert.doesNotMatch(row({ app: 'Solflare', why }), /undefined|fora desta rodada$|left out of this round$/, `${lang} ${why}`);
    assert.equal(typeof I18N[lang]['run.chip.out'], 'function');
  }
  // o mesmo aviso da confirmação ("Ficam fora desta rodada: …") no teste e no envio
  assert.match(fnSource('renderRun'), /const out = leftOut\(state\);\s+if \(out\.length\) kids\.push\(el\('p', \{ class: 'hint run-out' \}, t\('plan\.out'/);
  assert.match(fnSource('runRow'), /r\.kind === 'out' \? 'run\.chip\.out'/);
});

test('texto do teste e do envio: o app troca sozinho para o RPC público (desde a 0.1.6), não pede outro RPC', () => {
  for (const lang of ['pt', 'en'] as const) {
    const hint = I18N[lang]['run.hint'] as string;
    assert.match(hint, lang === 'pt' ? /troca sozinho para o RPC público/ : /switches to the public RPC/);
    assert.doesNotMatch(hint, lang === 'pt' ? /pede outro RPC/ : /asks for another RPC/);
  }
});

test('simulação: quem fica fora da rodada e por quê (esperando, toda protegida, vazia, pulada)', () => {
  const s = {
    plan: { destination: 'D', frases: [{ frase: 1 }] },
    frases: [ready(1), ready(2, { feeWait: WAIT }), ready(3, { planNotice: { code: 'phantom-all-protected' } }), ready(4, { nothingToClean: true }), bad(5)],
  };
  assert.deepEqual(R.leftOut(s), [{ n: 2, why: 'wait' }, { n: 3, why: 'prot' }, { n: 4, why: 'empty' }, { n: 5, why: 'err' }]);
  for (const why of ['wait', 'prot', 'empty', 'err']) assert.ok(`plan.out.${why}` in I18N.pt && `plan.out.${why}` in I18N.en, why);
});

test('resumo: cada carteira é (frase, índice) — nomes, decisões e passos levam a frase', () => {
  assert.match(fnSource('walletName'), /const f = fraseOf\(n\);/);
  assert.match(fnSource('tokenRow'), /who\(h\.walletIndex, h\.frase\)/);
  assert.match(fnSource('resultItem'), /fraseTag\(r\.frase\) \+ describeStep\(r\.step, r\.frase\)/);
  // a Phantom de cada frase manda as próprias contas protegidas e a própria contagem
  assert.match(SCRIPT, /porFrase\[f\.n\] = \{\s+protegidas:/);
  assert.match(SCRIPT, /\$\(`rev-n-\$\{n\}`\)/);
  // no cartão da frase, a espera do depósito não tem "Voltar ao início" (apagaria as outras frases)
  assert.match(fnSource('waitCard'), /feeWaitCard\(f\.feeWait, \{ back: false, f \}\)/);
});

// ---------- achados da revisão de 30/10 (autoclarn-34) ----------
const WAITING = { frases: [{ n: 1, feeWait: null }, { n: 2, feeWait: WAIT }], plan: { destination: 'D', frases: [{ frase: 1 }] } };
const ALL_IN = { frases: [{ n: 1, feeWait: null }, { n: 2, feeWait: null }], plan: { destination: 'D', frases: [{ frase: 1 }, { frase: 2 }] } };
const planRules = new Function(`${block('regras')}\n${block('analise')}\n${block('resumo')}; return { planNext, fundsNext };`)() as { planNext: unknown; fundsNext: unknown };

test('revisão: o depósito que chega com o plano parcial monta o plano de novo (escolhas da tela), nunca simula o velho', () => {
  const body = /events\.addEventListener\('fundos', \(ev\) => \{([\s\S]*?)\n\}\);/.exec(SCRIPT)?.[1] ?? '';
  assert.match(body, /if \(ui\.planBusy\) return;/, 'pedido do plano no ar: a resposta dele decide');
  assert.match(body, /runPlan\(\);/, 'monta de novo com as escolhas atuais');
  assert.doesNotMatch(body, /startSimulation\(/, 'nunca simula direto o plano montado antes da espera');
});

test('revisão: resposta do plano parcial confere o estado de novo (o depósito pode ter chegado no meio)', async () => {
  const calls: string[] = [];
  const ui = { planWaiting: false, prep: { phase: '' } };
  const run = (first: object, fresh: object) => {
    const env = { state: first as object };
    const fn = new Function('env', 'ui', 'planNext', 'api', 'startSimulation', 'renderPrep', '$',
      `let state = env.state; ${fnSource('afterPlan').replace('async function afterPlan', 'return async function afterPlan')}`)(
      env, ui, planRules.planNext, async (p: string) => { calls.push(p); return fresh; }, async () => { calls.push('simular'); },
      () => calls.push('resumo'), () => ({ scrollIntoView: () => {} })) as () => Promise<void>;
    return fn();
  };
  await run(WAITING, ALL_IN);
  assert.deepEqual(calls, ['/api/estado', 'simular'], 'o depósito já chegou: simula com todas');
  assert.equal(ui.planWaiting, false);
  calls.length = 0;
  await run(WAITING, WAITING);
  assert.deepEqual(calls, ['/api/estado', 'resumo'], 'ainda esperando: fica no resumo com o aviso');
  assert.equal(ui.planWaiting, true);
  calls.length = 0;
  await run(ALL_IN, ALL_IN);
  assert.deepEqual(calls, ['simular'], 'tudo com plano: simula sem pedir o estado');
});

test('revisão: /api/simular recusado mostra o erro na tela da simulação e libera "Começar de novo"', async () => {
  const done: string[] = [];
  const ui: { sim: { error: unknown } | null; prep: { phase: string } } = { sim: null, prep: { phase: '' } };
  const el = { replaceChildren: () => {}, classList: { add: () => {} } };
  const fn = new Function('ui', 'api', 'renderPrep', 'renderRestart', 'show', '$',
    `${fnSource('startSimulation')}\n${fnSource('requestSimulation')}\nreturn startSimulation;`)(
    ui, async () => { const e = new Error('Espere a tarefa em andamento terminar.') as Error & { codigo: string }; e.codigo = 'unknown'; throw e; },
    () => done.push('prep'), () => done.push('restart'), (s: string) => done.push(s), () => el) as () => Promise<void>;
  await fn(); // não lança: o erro fica na tela
  assert.deepEqual(ui.sim?.error, { codigo: 'unknown', params: undefined, mensagem: 'Espere a tarefa em andamento terminar.' });
  assert.equal(ui.prep.phase, 'simulacao');
  assert.ok(done.includes('restart') && done.lastIndexOf('prep') > done.indexOf('s-preparo'), done.join());
});

test('revisão: "corrigir só esta" desliga a espera do plano (o app derrubou os planos de todas)', () => {
  assert.match(fnSource('sendFix'), /ui\.redo = f\.n;\s+ui\.planWaiting = false;/);
});
