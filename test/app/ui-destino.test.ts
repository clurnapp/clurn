// Destino que nunca recebeu SOL (não existe na rede): o servidor recusa com 'dest-missing', e a página dizia "Falta o
// endereço de destino" — o autor colava o endereço e achava que o campo não funcionava (0.1.4, 31/10/2026).
// O texto tem que dizer o que houve e o caminho: mandar um pouco de SOL para a carteira nova e "Tentar de novo".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_TEXT_PT } from '../../src/core/limpeza/errors.ts';
import { HTML } from './ui-source.ts';

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
const txt = (d: Dict, k: string) => (d[k] as () => string)();

test('destino inexistente: o texto diz que a carteira nunca recebeu SOL e como seguir (pt)', () => {
  const t = ERROR_TEXT_PT['dest-missing'];
  assert.match(t.what({}), /nunca recebeu SOL/);
  assert.doesNotMatch(t.what({}), /Falta o endereço/);
  assert.match(t.you({}), /mande um pouco de SOL/);
  assert.match(t.you({}), new RegExp(`"${I18N.pt['err.retry']}"`), 'nomeia o botão que existe no cartão');
});

test('destino inexistente: página em pt igual ao catálogo do servidor, e em inglês com o mesmo sentido', () => {
  for (const part of ['what', 'app', 'you'] as const) assert.equal(txt(I18N.pt, `err.dest-missing.${part}`), ERROR_TEXT_PT['dest-missing'][part]({}), part);
  assert.match(txt(I18N.en, 'err.dest-missing.what'), /never received SOL/);
  assert.match(txt(I18N.en, 'err.dest-missing.you'), /send it a little SOL/);
  assert.match(txt(I18N.en, 'err.dest-missing.you'), /"Try again"/);
});
