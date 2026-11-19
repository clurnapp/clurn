// Confirmar sem o mapa do dinheiro (pedido do autor, 08/11/2026): antes do envio a pessoa vê o total, de onde vem
// por tipo e a lista das carteiras, mas não quanto há em cada carteira nem o valor de cada passo. Com o valor por
// carteira dava para coletar as creator fees à mão (55% da taxa do app, medido em 08/11) e fugir dos 11%.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

const block = (name: string) => {
  const start = HTML.indexOf(`// ${name}:inicio`);
  const end = HTML.indexOf(`// ${name}:fim`);
  assert.ok(start > 0 && end > start, `marcadores de ${name}`);
  return HTML.slice(start, end);
};
type Group = { key: string; tx: number; wallets: number; accounts: number };
type Summary = { frases: { n: number; groups: Group[] }[]; apart: Record<string, unknown>[] };
const { stepsSummary } = new Function(`${block('preparo')}; return { stepsSummary };`)() as { stepsSummary: (items: unknown) => Summary };
type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = new Function(`${block('i18n')}; return I18N;`)();
const tx = (lang: 'pt' | 'en', key: string, arg?: unknown) => {
  const v = I18N[lang][key];
  return typeof v === 'function' ? v(arg) : v;
};

const sim = (frase: number, kind: string, walletIndex: number, over: Record<string, unknown> = {}) => ({
  frase, status: 'simulado', walletIndex, destinationDelta: '123456789',
  step: { kind, walletIndex, estimateLamports: '987654321', close: 0, burnClose: 0, transferClose: 0, ...over },
});

test('sem mapa: passos agrupados por frase e tipo, com transações, carteiras e contas, sem valor', () => {
  const v = stepsSummary([
    sim(1, 'claim-curve', 3), sim(1, 'claim-amm', 3), sim(1, 'claim-cashback', 7), sim(1, 'close-uva', 7), sim(1, 'claim-shared', 9),
    sim(1, 'tokens', 3, { close: 2, burnClose: 1 }), sim(1, 'tokens', 7, { transferClose: 1 }), sim(1, 'tokens', 7, { close: 4 }),
    sim(1, 'sweep-sol', 3), sim(1, 'sweep-sol', 7),
    sim(2, 'gather', 1), sim(2, 'fund', 2), sim(2, 'sweep-sol', 0),
  ]);
  assert.deepEqual(v.frases.map((f) => f.n), [1, 2], 'frases em ordem');
  assert.deepEqual(v.frases[0].groups, [
    { key: 'claims', tx: 5, wallets: 3, accounts: 0 },
    { key: 'tokens', tx: 3, wallets: 2, accounts: 8 },
    { key: 'sol', tx: 2, wallets: 2, accounts: 0 },
  ]);
  assert.deepEqual(v.frases[1].groups, [{ key: 'sol', tx: 1, wallets: 1, accounts: 0 }, { key: 'move', tx: 2, wallets: 2, accounts: 0 }]);
  assert.deepEqual(v.apart, []);
  // nenhum valor nem carteira sai do resumo: só contagens
  const flat = JSON.stringify(v);
  assert.doesNotMatch(flat, /123456789|987654321|walletIndex|lamports/i, 'sem valor e sem índice de carteira');
});

test('sem mapa: o que não vai ser enviado sai um a um (com o motivo), fora das contagens', () => {
  const failed = { ...sim(1, 'claim-curve', 4), status: 'falhou', error: { code: 'pump-claim-failed' } };
  const cancelled = { ...sim(1, 'claim-amm', 4), status: 'cancelado' };
  const nothing = { ...sim(1, 'tokens', 5, { close: 3 }), status: 'nada a fazer' };
  const unknown = { ...sim(1, 'sweep-sol', 6), status: 'desconhecido' };
  const v = stepsSummary([sim(1, 'tokens', 1, { close: 1 }), failed, cancelled, nothing, unknown]);
  assert.deepEqual(v.apart, [failed, cancelled, nothing, unknown], 'na ordem em que chegaram (a tela põe o mais recente em cima)');
  assert.deepEqual(v.frases, [{ n: 1, groups: [{ key: 'tokens', tx: 1, wallets: 1, accounts: 1 }] }], 'só o simulado conta');
});

test('sem mapa: dado sujo não derruba a tela nem vira número errado', () => {
  assert.deepEqual(stepsSummary(null), { frases: [], apart: [] });
  assert.deepEqual(stepsSummary('lixo'), { frases: [], apart: [] });
  assert.deepEqual(stepsSummary([]), { frases: [], apart: [] });
  const v = stepsSummary([
    null, 7, 'x', undefined,
    { status: 'simulado' }, // sem passo, sem frase
    { status: 'simulado', frase: 'um', step: { kind: 'tokens', walletIndex: 'dois', close: '3', burnClose: -2, transferClose: 1.5 } },
    { status: 'simulado', frase: 1, step: { kind: 'toString', walletIndex: 2 } }, // tipo que é nome de propriedade
    { status: 'simulado', frase: 1, step: { kind: 'tokens', walletIndex: 2, close: 2 } },
    { status: 'simulado', frase: 1, step: { kind: 'tokens', walletIndex: 2, close: 2 } }, // repetido: mesma carteira conta 1 vez
    { status: 'simulado', frase: 1, walletIndex: 5, step: { kind: 'sweep-sol' } }, // índice só fora do passo
  ]);
  assert.deepEqual(v.frases, [
    { n: 0, groups: [{ key: 'tokens', tx: 1, wallets: 0, accounts: 0 }, { key: 'other', tx: 1, wallets: 0, accounts: 0 }] },
    { n: 1, groups: [{ key: 'tokens', tx: 2, wallets: 1, accounts: 4 }, { key: 'sol', tx: 1, wallets: 1, accounts: 0 }, { key: 'other', tx: 1, wallets: 1, accounts: 0 }] },
  ]);
  assert.deepEqual(v.apart, [], 'item sem status "simulado" válido só entra se for objeto');
});

test('sem mapa: os textos do resumo dizem tipo e contagem nos dois idiomas, sem valor', () => {
  const g = (key: string, tx: number, wallets: number, accounts = 0) => ({ key, tx, wallets, accounts });
  assert.equal(tx('pt', 'sum.claims', g('claims', 5, 3)), 'Coletar creator fees e cashback: 5 transações em 3 carteiras');
  assert.equal(tx('pt', 'sum.claims', g('claims', 1, 1)), 'Coletar creator fees e cashback: 1 transação em 1 carteira');
  assert.equal(tx('pt', 'sum.tokens', g('tokens', 3, 2, 8)), 'Fechar contas de token (queimar ou transferir antes, como você escolheu): 8 contas em 2 carteiras');
  assert.equal(tx('pt', 'sum.sol', g('sol', 2, 2)), 'Enviar o SOL ao destino: 2 carteiras');
  assert.equal(tx('pt', 'sum.move', g('move', 1, 1)), 'Juntar ou emprestar SOL para as taxas de rede: 1 transação');
  assert.equal(tx('pt', 'sum.other', g('other', 2, 0)), 'Outros passos: 2 transações');
  assert.equal(tx('en', 'sum.claims', g('claims', 5, 3)), 'Collect creator fees and cashback: 5 transactions in 3 wallets');
  assert.equal(tx('en', 'sum.tokens', g('tokens', 1, 1, 1)), 'Close token accounts (burning or transferring first, as you chose): 1 account in 1 wallet');
  for (const lang of ['pt', 'en'] as const) for (const key of ['sum.claims', 'sum.tokens', 'sum.sol', 'sum.move', 'sum.other']) {
    assert.doesNotMatch(tx(lang, key, g('x', 4, 3, 2)), /\d[.,]\d|~/, `${lang} ${key}: sem valor`);
  }
  assert.equal(tx('pt', 'conf.work', { steps: 214 }), 'À mão seriam 214 transações, uma carteira por vez. O Clurn faz todas agora.');
  assert.equal(tx('en', 'conf.work', { steps: 214 }), "By hand that's 214 transactions, one wallet at a time. Clurn does them all now.");
  assert.match(tx('pt', 'conf.stepsHint'), /tela final/);
  assert.match(tx('en', 'conf.stepsHint'), /final screen/);
  // um grupo novo sem texto quebraria a tela: todo grupo do resumo tem texto nos dois idiomas
  const groups = /const STEP_GROUP_ORDER = \[([^\]]*)\]/.exec(SCRIPT)?.[1].match(/'([a-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  assert.deepEqual(groups, ['claims', 'tokens', 'sol', 'move', 'other']);
  for (const k of groups) for (const lang of ['pt', 'en'] as const) assert.equal(typeof I18N[lang][`sum.${k}`], 'function', `${lang} sum.${k}`);
});

test('sem mapa: a Confirmar não mostra valor por carteira nem por passo antes do envio', () => {
  const table = fnSource('walletsTable');
  assert.doesNotMatch(table, /lamports|closableRent|creatorFees|closable\b|\bsol\(/, 'tabela das carteiras sem SOL, aluguel nem creator fee');
  assert.match(table, /t\('w\.which'\)[\s\S]*t\('w\.address'\)[\s\S]*t\('w\.notes'\)/, 'nome, endereço (lista dos derivados) e observações');
  for (const lang of ['pt', 'en'] as const) for (const k of ['w.sol', 'w.close', 'w.fees']) assert.equal(I18N[lang][k], undefined, `${lang} ${k} saiu`);
  // passos testados: só pelo resumo; o evento ao vivo da simulação também
  const sum = fnSource('renderSimSummary');
  assert.match(sum, /stepsSummary\(ui\.sim\.items\)/);
  assert.match(sum, /t\(`sum\.\$\{g\.key\}`, g\)/);
  assert.doesNotMatch(SCRIPT, /renderResults\('sim-lista'/, 'nenhum caminho redesenha a simulação passo a passo');
  assert.doesNotMatch(SCRIPT, /\$\('sim-lista'\)\.prepend/, 'nem ao vivo');
  const live = /events\.addEventListener\('passo', \(ev\) => \{([\s\S]*?)\n\}\);/.exec(SCRIPT)?.[1] ?? '';
  assert.match(live, /if \(r\.modo === 'simulate'\) renderSimSummary\(\); else \$\('x-lista'\)\.prepend\(resultItem\(r\)\);/);
  // a execução continua com cada passo, o valor e o link (depois da confirmação)
  assert.match(SCRIPT, /renderResults\('x-lista', ui\.exec\.items\)/);
  assert.match(fnSource('resultItem'), /destinationDelta/);
  // o trabalho que a taxa paga aparece na Confirmar, só com mais de um passo
  assert.match(fnSource('renderConfirm'), /v\.steps > 1 \? el\('p', \{ class: 'hint', id: 'c-trabalho' \}, t\('conf\.work', \{ steps: v\.steps \}\)\) : null/);
  // o aviso de que o valor de cada passo vem na tela final fica dentro de "Passos testados"
  const det = HTML.slice(HTML.indexOf('id="c-passos"'), HTML.indexOf('id="sim-lista"'));
  assert.match(det, /data-i18n="conf\.stepsHint"/);
});
