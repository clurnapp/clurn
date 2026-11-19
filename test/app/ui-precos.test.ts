// Consulta de preços falhada na tela: um aviso só, com a contagem, e o token continua com a opção de queimar
// (com a palavra, como qualquer token sem preço). Até a 0.1.3 a falha tirava "Queimar" de todos os tokens da
// rodada, e um tester (31/10/2026, 470 tokens) ficou sem opção nenhuma.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML } from './ui-source.ts';

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();

test('preços: o aviso de consulta falhada tem a contagem e diz que dá para queimar com a palavra (pt e en)', () => {
  const pt = I18N.pt['warn.pricesMissing'] as (n: number) => string;
  const en = I18N.en['warn.pricesMissing'] as (n: number) => string;
  assert.match(pt(1), /1 token\b.*ele fica/);
  assert.match(pt(148), /148 tokens.*eles ficam.*queimar confirmando com a palavra/);
  assert.match(en(148), /148 tokens.*burn by confirming with the word/);
  assert.equal(I18N.pt['warn.noBurn'], undefined, 'o aviso de "queimar desligado" saiu');
});

test('preços: queimar vale para todo token que não é NFT, sem olhar a consulta de preço', () => {
  const m = /const burnOkFor = \(h\) => [^\r\n]+/.exec(HTML);
  assert.ok(m, 'burnOkFor na página');
  const burnOkFor = new Function(`${m[0]}; return burnOkFor;`)() as (h: Record<string, unknown>) => boolean;
  assert.equal(burnOkFor({ kind: 'fungible', priceLookupFailed: true, whyCode: 'no-price' }), true, 'consulta falhada: queima (com a palavra)');
  assert.equal(burnOkFor({ kind: 'fungible', burnAllowed: false }), true, 'campo antigo não trava');
  assert.equal(burnOkFor({ kind: 'nft' }), false);
  assert.doesNotMatch(HTML, /state\.burnAllowed|h\.burnAllowed|s\.burnLocked/, 'nenhuma trava de queimar na página');
});

test('preços: a página mostra um aviso só (a contagem), não um por lote da API', () => {
  const at = HTML.indexOf("t('warn.pricesMissing', s.pricesMissing)");
  assert.ok(at > 0);
  assert.doesNotMatch(HTML, /for \(const e of s\.priceErrors/);
});
