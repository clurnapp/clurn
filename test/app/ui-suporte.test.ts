// Suporte no Telegram (16/11/2026): botão no cartão de erro que manda falar com o suporte, com o aviso contra golpe,
// e atalho no topo. Só o endereço oficial. A página é avaliada por função, sem DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
const tr = (lang: 'pt' | 'en', k: string, p?: unknown) => {
  const v = I18N[lang][k];
  if (v === undefined) throw new Error(`texto ${k} não existe`);
  return typeof v === 'function' ? v(p) : v;
};

type Fake = { tag: string; attrs: Record<string, unknown>; kids: Array<Fake | string>; text: () => string; find: (tag: string) => Fake[] };
const isFake = (k: unknown): k is Fake => typeof k === 'object' && k !== null && 'tag' in k;
function fakeEl(tag: string, attrs: Record<string, unknown>, ...kids: unknown[]): Fake {
  const flat = kids.flat().filter((k) => k !== null && k !== undefined && k !== false).map((k) => (isFake(k) ? k : String(k))) as Array<Fake | string>;
  return {
    tag,
    attrs: attrs ?? {},
    kids: flat,
    text: () => flat.map((k) => (typeof k === 'string' ? k : k.text())).join(''),
    find: (t) => flat.flatMap((k) => (typeof k === 'string' ? [] : [...(k.tag === t ? [k] : []), ...k.find(t)])),
  };
}

const constOf = (name: string) => {
  const m = new RegExp(`const ${name} = ([^\\n]+);`).exec(SCRIPT);
  if (!m) throw new Error(`${name} não achado`);
  return new Function(`return ${m[1]};`)();
};
const SUPPORT_URL: string = constOf('SUPPORT_URL');
const SUPPORT_CODES: Set<string> = constOf('SUPPORT_CODES');

function card(lang: 'pt' | 'en', err: Record<string, unknown>, opts: Record<string, unknown> = {}): Fake {
  const t = (k: string, p?: unknown) => tr(lang, k, p);
  const base = { el: fakeEl, t, SUPPORT_URL, tgIcon: () => fakeEl('span', { class: 'tg-ico' }) };
  const supportLink = new Function(...Object.keys(base), `${fnSource('supportLink')}\nreturn supportLink;`)(...Object.values(base));
  const withLink = { ...base, supportLink };
  const supportBlock = new Function(...Object.keys(withLink), `${fnSource('supportBlock')}\nreturn supportBlock;`)(...Object.values(withLink));
  const fakes = { el: fakeEl, t, I18N, SUPPORT_CODES, supportBlock };
  const errorCard = new Function(...Object.keys(fakes), `${fnSource('errorCard')}\nreturn errorCard;`)(...Object.values(fakes));
  return errorCard(err, opts);
}
const links = (c: Fake) => c.find('a');

test('suporte: o endereço é o oficial', () => {
  assert.equal(SUPPORT_URL, 'https://t.me/clurnapp');
});

test('suporte: erro que manda falar com o suporte traz o botão do Telegram e o aviso de que o suporte nunca pede a frase (PT e EN)', () => {
  for (const lang of ['pt', 'en'] as const) {
    for (const code of SUPPORT_CODES) {
      const c = card(lang, { code, params: {}, technical: 'detalhe' });
      const a = links(c);
      assert.equal(a.length, 1, `${lang}/${code}`);
      assert.equal(a[0]!.attrs.href, SUPPORT_URL);
      assert.equal(a[0]!.attrs.target, '_blank');
      assert.match(String(a[0]!.attrs.rel), /noopener/);
      assert.equal(a[0]!.text(), tr(lang, 'support.cta'));
      assert.ok(c.text().includes(tr(lang, 'support.safe')), 'aviso contra golpe junto do botão');
      assert.ok(!c.text().includes('[object'), 'nada de lista virando texto');
    }
  }
  assert.match(tr('pt', 'support.safe'), /nunca pede sua frase/);
  assert.match(tr('en', 'support.safe'), /never asks for your phrase/);
  // no cartão compacto (linha da lista de passos) o botão fica dentro dos detalhes
  assert.equal(links(card('pt', { code: 'unknown', params: {} }, { compact: true })).length, 1);
});

test('suporte: erro que a própria pessoa resolve (frase, depósito) não empurra para o suporte', () => {
  for (const code of ['seed-words', 'seed-checksum', 'no-fee-sol']) {
    if (!I18N.pt[`err.${code}.what`]) continue;
    assert.equal(links(card('pt', { code, params: { words: 11, wallet: 'x' } })).length, 0, code);
  }
});

test('suporte: todo erro cujo texto manda falar com o suporte tem o botão (a classe, não o caso)', () => {
  for (const [k, v] of Object.entries(I18N.pt)) {
    const m = /^err\.(.+)\.you$/.exec(k);
    if (!m) continue;
    const text = typeof v === 'function' ? v({}) : v;
    if (/suporte/i.test(text)) assert.ok(SUPPORT_CODES.has(m[1]!), `err.${m[1]} fala do suporte e não tem o botão`);
  }
  for (const code of SUPPORT_CODES) assert.ok(I18N.pt[`err.${code}.what`] && I18N.en[`err.${code}.what`], `código ${code} existe nos dois idiomas`);
});

test('suporte: atalho no topo, com nome acessível nos dois idiomas, endereço vindo da mesma constante', () => {
  const top = /<a class="fx-toggle support-top" id="support-top"([^>]*)>/.exec(HTML);
  assert.ok(top, 'atalho no topo');
  assert.match(top![1]!, /target="_blank"/);
  assert.match(top![1]!, /rel="noopener noreferrer"/);
  assert.match(top![1]!, /data-i18n-title="support.title"/);
  assert.ok(!/href=/.test(top![1]!), 'o href vem do script (uma fonte só)');
  assert.ok(SCRIPT.includes("document.getElementById('support-top')?.setAttribute('href', SUPPORT_URL);"));
  for (const lang of ['pt', 'en'] as const) for (const k of ['support.cta', 'support.title', 'support.safe']) assert.ok(tr(lang, k).length > 5, `${lang} ${k}`);
});
