// Cartão da espera do depósito com "juntar o SOL desta frase": o bloco da oferta (botão), o do que já foi enviado
// (um resultado por temporária, com link) e o clique que chama /api/juntar. A página é avaliada por função, sem DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, fnSource } from './ui-source.ts';

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

// elemento falso: guarda tag, atributos e filhos; text() junta o texto como a página mostraria.
// Achata UM nível, como o el() da página: o que não é elemento nem texto vira String(k) (uma lista dentro de lista vira
// "[object …]", o defeito que este teste deixou passar antes por achatar tudo)
type Fake = { tag: string; attrs: Record<string, unknown>; kids: Array<Fake | string>; text: () => string; find: (tag: string) => Fake[] };
const isFake = (k: unknown): k is Fake => typeof k === 'object' && k !== null && 'tag' in k;
function fakeEl(tag: string, attrs: Record<string, unknown>, ...kids: unknown[]): Fake {
  const flat = kids.flat().filter((k) => k !== null && k !== undefined && k !== false).map((k) => (isFake(k) ? k : String(k))) as Array<Fake | string>;
  const e: Fake = {
    tag,
    attrs: attrs ?? {},
    kids: flat,
    text: () => flat.map((k) => (typeof k === 'string' ? k : k.text())).join(''),
    find: (t) => flat.flatMap((k) => (typeof k === 'string' ? [] : [...(k.tag === t ? [k] : []), ...k.find(t)])),
  };
  return e;
}

function blockFor(lang: 'pt' | 'en', f: unknown, clicks: unknown[] = []) {
  const fakes = {
    el: fakeEl,
    t: (k: string, p?: unknown) => tr(lang, k, p),
    solShort: (l: unknown) => String(Number(l) / 1e9),
    describeStep: (s: { kind: string; walletIndex: number }, n: number) => `${n}/N=${s.walletIndex}:${s.kind}`,
    gatherFrase: (n: number, ev: unknown) => clicks.push([n, ev]),
  };
  const gatherBlock = new Function(...Object.keys(fakes), `${fnSource('gatherBlock')}\nreturn gatherBlock;`)(...Object.values(fakes)) as (f: unknown) => Fake | null;
  const block = gatherBlock(f);
  if (block === null) return null;
  assert.ok(isFake(block) && block.tag === 'div', 'um elemento só (o cartão o põe numa lista de filhos)');
  return block.kids.filter(isFake);
}

// o cartão da espera inteiro, com o el() de um nível: o bloco de juntar aparece como cartão, nunca como "[object …]"
test('tela: o cartão da espera mostra o bloco de juntar de verdade (botão achável, sem "[object")', () => {
  const fakes = {
    el: fakeEl,
    t: (k: string, p?: unknown) => tr('pt', k, p),
    solShort: (l: unknown) => String(Number(l) / 1e9),
    describeStep: () => 'x',
    gatherFrase: () => {},
    fundingBlock: () => null,
    copyButton: () => fakeEl('button', {}, 'Copiar'),
    backToStartButton: () => fakeEl('button', {}, 'Voltar'),
    errorCard: (_e: unknown, opts: { extra: unknown }) => fakeEl('div', { class: 'err' }, opts.extra),
  };
  const feeWaitCard = new Function(...Object.keys(fakes), `${fnSource('gatherBlock')}\n${fnSource('feeWaitCard')}\nreturn feeWaitCard;`)(...Object.values(fakes)) as (fw: unknown, o: unknown) => Fake;
  const card = feeWaitCard({ params: { wallet: 'W0' } }, { back: false, f: { n: 1, gatherOffer: OFFER, gathering: null } });
  assert.doesNotMatch(card.text(), /\[object/);
  assert.match(card.text(), /Ou junte o SOL desta frase/);
  assert.ok(card.find('button').some((b) => /^Juntar /.test(b.text())), 'botão de juntar no cartão');
});

const OFFER = { toIndex: 0, toName: 'N=0', to: 'W0', lamports: '350880', from: 1, transfers: [{ fromIndex: 1, fromName: 'N=1', from: 'W1', lamports: '350880' }] };
const RESULT = (walletIndex: number, status: string, link: string | null, detail: string | null = null) => ({ step: { kind: 'gather', walletIndex }, status, link, detail, walletIndex });

test('tela: oferta de juntar vira um aviso com o texto, o botão "Juntar … SOL de N temporárias" e o clique chama a frase certa', () => {
  const clicks: unknown[] = [];
  const out = blockFor('pt', { n: 3, gatherOffer: OFFER, gathering: null }, clicks)!;
  assert.equal(out.length, 1);
  const text = out[0].text();
  assert.match(text, /Ou junte o SOL desta frase/);
  assert.match(text, /0\.00035088 SOL de 1 temporária para a N=0/);
  const [btn] = out[0].find('button');
  assert.equal(btn.text(), 'Juntar 0.00035088 SOL de 1 temporária');
  (btn.attrs.onclick as (ev: unknown) => void)('ev');
  assert.deepEqual(clicks, [[3, 'ev']]);
  // plural e inglês
  const en = blockFor('en', { n: 3, gatherOffer: { ...OFFER, from: 4 }, gathering: null })!;
  assert.equal(en[0].find('button')[0].text(), 'Gather 0.00035088 SOL from 4 burners');
  // sem oferta nem envio: nada
  assert.equal(blockFor('pt', { n: 3, gatherOffer: null, gathering: null }), null);
});

test('tela: o que já foi juntado aparece com um resultado por temporária e link; parcial em verde com o motivo da falha; nada juntado em vermelho', () => {
  const partial = { toName: 'N=0', to: 'W0', lamports: '665880', sentLamports: '415880', sent: 2, total: 3, status: 'parcial', results: [RESULT(1, 'enviado', 'https://x/1'), RESULT(2, 'falhou', 'https://x/2', 'a rede recusou'), RESULT(3, 'enviado', 'https://x/3')] };
  const out = blockFor('pt', { n: 2, gatherOffer: OFFER, gathering: partial })!;
  assert.equal(out.length, 2, 'o enviado e a oferta nova');
  assert.equal(out[0].attrs.class, 'notice ok');
  assert.match(out[0].text(), /Juntou 0\.00041588 SOL na N=0 \(2 de 3 envios\)/);
  assert.equal(out[0].find('a').length, 3, 'um link por transação');
  assert.match(out[0].text(), /2\/N=2:gather · falhou · a rede recusou/);
  assert.match(out[0].text(), /2\/N=1:gather · enviado · ver transação2\/N=2/, 'enviado: só o link, sem detalhe');
  assert.ok(out[1].find('button').length === 1, 'a oferta nova vem depois');
  const failed = { ...partial, sentLamports: '0', sent: 0, status: 'falhou', results: [RESULT(1, 'falhou', null, 'x')] };
  const bad = blockFor('en', { n: 2, gatherOffer: null, gathering: failed })!;
  assert.equal(bad[0].attrs.class, 'notice danger');
  assert.match(bad[0].text(), /Nothing was gathered in N=0/);
  assert.equal(bad[0].find('a').length, 0);
  const done = { ...partial, sentLamports: '665880', sent: 3, total: 3, status: 'enviado' };
  assert.match(blockFor('pt', { n: 2, gatherOffer: null, gathering: done })![0].text(), /SOL juntado na N=0: 0\.00066588 SOL de 3 temporárias\./);
});

test('tela: o cartão da espera mostra o bloco de juntar antes do de emprestar; o clique de juntar chama /api/juntar e redesenha', () => {
  const card = fnSource('feeWaitCard');
  const g = card.indexOf('gatherBlock(f)');
  const l = card.indexOf('fundingBlock(f)');
  assert.ok(g > 0 && l > g, 'juntar (dentro da frase) vem antes de emprestar (de outra frase)');
  const click = fnSource('gatherFrase');
  assert.match(click, /api\('\/api\/juntar', \{ frase: n \}\)/);
  assert.match(click, /renderPrep\(\)/);
  assert.match(click, /t\('gather\.sending'\)/);
});

test('tela: passo de juntar descrito com o valor ou com "todo o SOL" (a remetente fica com 0), nos dois idiomas', () => {
  assert.equal(tr('pt', 'stepd.gather', { who: 'N=1', sol: '0,00085', all: true }), 'N=1: juntar todo o SOL (~0,00085 SOL) na pagadora desta frase para as taxas (volta ao destino no fim)');
  assert.equal(tr('pt', 'stepd.gather', { who: 'N=1', sol: '0,0003', all: false }), 'N=1: juntar 0,0003 SOL na pagadora desta frase para as taxas (volta ao destino no fim)');
  assert.match(tr('en', 'stepd.gather', { who: 'N=1', sol: '0.00085', all: true }), /gather all the SOL \(~0\.00085 SOL\)/);
  assert.match(fnSource('describeStep'), /all: s\.all/, 'a página passa o "all" do servidor para a descrição');
});
