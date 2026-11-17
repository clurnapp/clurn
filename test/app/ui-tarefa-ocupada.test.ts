// "Não deu para montar o plano" com "Espere a tarefa em andamento terminar" e um "Tentar de novo" que não fazia nada
// (print de 01/11/2026): a página repetia o pedido na hora e recebia a mesma recusa. Agora a recusa 'task-busy'
// faz a página esperar a tarefa acabar e repetir sozinha; quem saiu da tela não recebe pedido nenhum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT, fnSource } from './ui-source.ts';

type Call = { path: string };
function page(answers: Array<(path: string) => unknown>) {
  const calls: Call[] = [];
  const ui: Record<string, any> = { section: 's-preparo', prep: { phase: 'analise', error: null }, dest: 'D', planBusy: false };
  const env = {
    ui,
    calls,
    api: async (path: string) => {
      calls.push({ path });
      const next = answers.shift();
      if (!next) throw new Error(`pedido a mais: ${path}`);
      return next(path);
    },
  };
  const src = `${fnSource('untilIdle')}\nconst TASK_POLL_MS = 0;\n${fnSource('runPlan')}\n${fnSource('requestSimulation')}\nreturn { runPlan, requestSimulation, untilIdle, get state() { return state; } };`;
  const fns = new Function('ui', 'api', `
    let state = null;
    const t = (k) => k;
    const destinationOf = () => ui.dest;
    const decisionsPayload = () => ({ decisoes: {}, queimarConfirmado: [], needWord: 0 });
    const phantomPayload = () => ({});
    const renderPrep = () => {};
    const renderRestart = () => {};
    const renderConfirm = () => {};
    const show = (id) => { ui.section = id; };
    const showError = () => {};
    const planRefusalWaits = () => false;
    const onlyKeptLeft = () => false;
    const decisionOf = () => 'keep';
    const afterPlan = async () => { ui.afterPlan = (ui.afterPlan ?? 0) + 1; };
    ${src}`)(ui, env.api);
  return { ...env, fns };
}
const busy = () => {
  throw Object.assign(new Error('Espere a tarefa em andamento terminar.'), { codigo: 'task-busy', params: {} });
};

test('plano recusado por tarefa no ar: espera a tarefa acabar e monta de novo sozinho', async () => {
  const p = page([busy, () => ({ busy: 'repasse' }), () => ({ busy: 'repasse' }), () => ({ busy: null }), () => ({ plan: true })]);
  await p.fns.runPlan();
  assert.deepEqual(p.calls.map((c) => c.path), ['/api/plano', '/api/estado', '/api/estado', '/api/estado', '/api/plano']);
  assert.equal(p.ui.afterPlan, 1, 'seguiu para a simulação');
  assert.equal(p.ui.prep.phase, 'plano', 'nunca caiu na tela de erro');
  assert.equal(p.ui.prep.error, null);
  assert.equal(p.ui.planBusy, false);
  assert.equal(p.ui.prep.waitingTask, false);
});

test('plano esperando a tarefa: quem volta ao início não recebe o plano depois', async () => {
  const p = page([busy, () => { p.ui.section = 's-frase'; return { busy: 'repasse' }; }]);
  await p.fns.runPlan();
  // a pessoa saiu durante a 1ª consulta: a 2ª volta da espera vê isso e para
  assert.deepEqual(p.calls.map((c) => c.path), ['/api/plano', '/api/estado']);
  assert.equal(p.ui.afterPlan, undefined);
});

test('outro erro do plano continua indo para a tela de erro com o motivo', async () => {
  const p = page([() => { throw Object.assign(new Error('x'), { codigo: 'dest-invalid', params: {} }); }]);
  await p.fns.runPlan();
  assert.equal(p.ui.prep.phase, 'erro');
  assert.equal(p.ui.prep.error.codigo, 'dest-invalid');
});

test('simulação recusada por tarefa no ar: espera e pede de novo', async () => {
  const p = page([busy, () => ({ busy: null }), () => ({})]);
  p.ui.prep.phase = 'simulacao';
  p.ui.sim = { error: null };
  await p.fns.requestSimulation();
  assert.deepEqual(p.calls.map((c) => c.path), ['/api/simular', '/api/estado', '/api/simular']);
  assert.equal(p.ui.sim.error, null);
});

test('página reaberta no meio de "Ler de novo" volta para a leitura, não para o plano', () => {
  assert.match(SCRIPT, /state\.busy === 'analise' \|\| state\.busy === 'reler'\) \{ beginAnalysis/);
});
