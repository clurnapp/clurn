// Painel de créditos do Helius na página: o que ele mostra a partir de /api/creditos, quando some e quando atualiza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
const tr = (lang: 'pt' | 'en', key: string, p?: unknown) => {
  const v = I18N[lang][key];
  assert.ok(v !== undefined, `falta "${key}" em ${lang}`);
  return typeof v === 'function' ? v(p) : v;
};

type Lines = { saldo: string; pct: number | null; mes: string } | null;
const CREDIT_ERRORS = /const CREDIT_ERRORS = (\[[^\]]*\]);/.exec(SCRIPT)![1]!;
function lines(lang: 'pt' | 'en', c: unknown): Lines {
  const t = (k: string, p?: unknown) => tr(lang, k, p);
  const loc = () => (lang === 'pt' ? 'pt-BR' : 'en-US');
  return new Function('t', 'loc', `const CREDIT_ERRORS = ${CREDIT_ERRORS};\n${fnSource('creditsLines')}\nreturn creditsLines;`)(t, loc)(c) as Lines;
}
const OK = { status: 'ok', restantes: 912345, limite: 1000000, usados: 87655, renovaEm: '2026-11-01', plano: 'free' };

test('painel: saldo da chave com limite, data de renovação, barra e o gasto deste computador no mês', () => {
  const l = lines('pt', { own: true, helius: OK, history: { creditosMes: 4870 } })!;
  assert.equal(l.saldo, '912.345 de 1.000.000 créditos restantes na chave · renova em 01/11/2026');
  assert.ok(Math.abs(l.pct! - 91.2345) < 1e-9);
  assert.equal(l.mes, 'Este computador gastou 4.870 créditos neste mês (estimativa do app). Todos que usam o app dividem esta chave.');
  const en = lines('en', { own: true, helius: OK, history: { creditosMes: 4870 } })!;
  assert.equal(en.saldo, '912,345 of 1,000,000 credits left on the key · renews on 11/1/2026');
});

test('painel: sem RPC próprio some; sem limite não tem barra; recusa, motivo desconhecido e dado sujo viram texto certo', () => {
  assert.equal(lines('pt', { own: false, helius: OK }), null, 'só RPC público: não gasta crédito, o painel some');
  assert.equal(lines('pt', null), null);
  const semLimite = lines('pt', { own: true, helius: { ...OK, limite: null, renovaEm: null }, history: { creditosMes: 0 } })!;
  assert.deepEqual([semLimite.saldo, semLimite.pct], ['912.345 créditos restantes na chave', null]);
  for (const [helius, key] of [
    [{ status: 'erro', motivo: 'admin-desligada' }, 'cr.err.admin-desligada'],
    [{ status: 'erro', motivo: 'chave-ou-projeto' }, 'cr.err.chave-ou-projeto'],
    [{ status: 'erro', motivo: 'indisponivel' }, 'cr.err.indisponivel'],
    [{ status: 'erro', motivo: 'motivo-novo' }, 'cr.err.indisponivel'],
    [{ status: 'sem-projeto' }, 'cr.err.sem-projeto'],
    [undefined, 'cr.err.sem-projeto'],
  ] as const) {
    const l = lines('pt', { own: true, helius, history: undefined })!;
    assert.equal(l.saldo, tr('pt', key), JSON.stringify(helius));
    assert.equal(l.pct, null);
    assert.match(l.mes, /gastou 0 créditos/, 'histórico ausente conta 0, sem quebrar');
  }
  // restantes acima do limite (crédito pré-pago) não estoura a barra
  assert.equal(lines('pt', { own: true, helius: { ...OK, restantes: 2_000_000 }, history: {} })!.pct, 100);
});

test('painel: todos os textos existem nos dois idiomas', () => {
  const keys = ['cr.title', 'cr.refresh', 'cr.left', 'cr.leftNoLimit', 'cr.renew', 'cr.month', 'cr.shared', 'cr.round',
    'cr.err.admin-desligada', 'cr.err.chave-ou-projeto', 'cr.err.indisponivel', 'cr.err.sem-projeto'];
  for (const k of keys) for (const lang of ['pt', 'en'] as const) tr(lang, k, { left: '1', limit: '2', date: 'x', n: '3' });
});

test('recibo: linha do gasto da rodada só com RPC próprio e gasto maior que zero', () => {
  const run = (st: unknown) => new Function('t', 'loc', `${fnSource('roundCreditsText')}\nreturn roundCreditsText;`)((k: string, p?: unknown) => tr('pt', k, p), () => 'pt-BR')(st) as string;
  assert.equal(run({ credits: { own: true, round: { credits: 4870.4 } } }), 'Esta rodada gastou cerca de 4.870 créditos do Helius.');
  assert.equal(run({ credits: { own: false, round: { credits: 50 } } }), '');
  assert.equal(run({ credits: { own: true, round: { credits: 0 } } }), '');
  assert.equal(run({}), '');
  assert.equal(run(null), '');
  assert.match(fnSource('renderExecFim'), /roundCreditsText\(state\)/, 'aparece no recibo do fim da execução');
});

// prazo: sem a guarda de um pedido por vez, o segundo pedido fica esperando para sempre (o teste cai em vez de travar)
test('painel: pede ao abrir, ao fim de cada tarefa (forçando) e no botão; um pedido por vez; falha não quebra', { timeout: 5_000 }, async () => {
  assert.match(fnSource('init'), /fetchCredits\(false\);/, 'ao abrir (usa o guardado de até 1 minuto)');
  assert.match(SCRIPT, /events\.addEventListener\('pronto', [\s\S]*?fetchCredits\(true\);[^\n]*\r?\n\s*endTask\(tarefa\);/, 'ao fim de cada tarefa');
  assert.match(SCRIPT, /\$\('b-creditos'\)\.addEventListener\('click', \(\) => fetchCredits\(true\)\);/);
  assert.match(fnSource('rerender'), /renderCredits\(\);/, 'trocar o idioma redesenha o painel');
  const sent: unknown[] = [];
  let renders = 0;
  let release: (v: unknown) => void = () => {};
  const ui: Record<string, unknown> = { credits: 'velho', creditsBusy: false };
  const fetchCredits = new Function('ui', 'api', 'renderCredits', `${fnSource('fetchCredits')}\nreturn fetchCredits;`)(
    ui, (p: string, b: unknown) => { sent.push([p, b]); return new Promise((r) => { release = r; }); }, () => { renders++; },
  ) as (f?: boolean) => Promise<void>;
  const first = fetchCredits(true);
  await fetchCredits(false);
  assert.deepEqual(sent, [['/api/creditos', { atualizar: true }]], 'um pedido por vez');
  release({ own: true });
  await first;
  assert.deepEqual([ui.credits, ui.creditsBusy], [{ own: true }, false]);
  const failing = new Function('ui', 'api', 'renderCredits', `${fnSource('fetchCredits')}\nreturn fetchCredits;`)(
    ui, () => Promise.reject(new Error('rede')), () => { renders++; },
  ) as (f?: boolean) => Promise<void>;
  await failing(false);
  assert.deepEqual([ui.credits, ui.creditsBusy], [{ own: true }, false], 'falhou: o painel fica como estava');
  assert.ok(renders >= 4);
});

test('painel: cartão na entrada, escondido até ter RPC próprio, sem campo nem URL', () => {
  const card = HTML.slice(HTML.indexOf('id="creditos"') - 60, HTML.indexOf('</section>', HTML.indexOf('id="creditos"')));
  assert.match(card, /class="sheet creditos hidden"/);
  assert.doesNotMatch(card, /<input|helius-rpc\.com|api-key/);
  for (const id of ['cr-saldo', 'cr-bar-wrap', 'cr-bar', 'cr-mes', 'b-creditos']) assert.ok(card.includes(`id="${id}"`), id);
  const entry = HTML.slice(HTML.indexOf('<section id="s-frase">'), HTML.indexOf('<section id="s-', HTML.indexOf('<section id="s-frase">') + 10));
  assert.ok(entry.includes('id="creditos"'), 'na tela de entrada');
  assert.match(HTML, /@media \(prefers-reduced-motion: reduce\) \{ \.cr-bar > span \{ transition: none; \} \}/);
});
