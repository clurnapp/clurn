// Depósito único na tela (pedido do autor, 31/10/2026): um cartão só, com UMA carteira e UM valor, o que o app faz
// quando o SOL chegar, e o andamento (chegou parte, repassando, repassado, repasse que falhou com "Tentar de novo").
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

type Fake = { tag: string; attrs: Record<string, unknown>; kids: Array<Fake | string>; text: () => string };
const isFake = (k: unknown): k is Fake => typeof k === 'object' && k !== null && 'tag' in k;
function fakeEl(tag: string, attrs: Record<string, unknown>, ...kids: unknown[]): Fake {
  const flat = kids.flat().filter((k) => k !== null && k !== undefined && k !== false).map((k) => (isFake(k) ? k : String(k))) as Array<Fake | string>;
  return { tag, attrs: attrs ?? {}, kids: flat, text: () => flat.map((k) => (typeof k === 'string' ? k : k.text())).join(' ') };
}

function card(sd: unknown, lang: 'pt' | 'en' = 'pt') {
  const fakes = {
    el: fakeEl,
    t: (k: string, p?: unknown) => tr(lang, k, p),
    // como o sol() da tela: corta em 6 casas, sem arredondar
    sol: (l: bigint) => `${l / 1_000_000_000n},${(l % 1_000_000_000n).toString().padStart(9, '0').slice(0, 6)}`,
    lamportsOf: (v: unknown) => BigInt((v as string) ?? 0),
    copyButton: () => fakeEl('button', {}, 'Copiar'),
    fraseOf: () => ({ app: 'solflare' }),
    multi: () => true,
    walletText: (label: string) => `temporária ${label}`,
    retryForward: () => {},
  };
  return new Function(...Object.keys(fakes), `${fnSource('solUp')}\n${fnSource('singleWho')}\n${fnSource('singleCard')}\nreturn singleCard;`)(...Object.values(fakes))(sd) as Fake;
}

test('depósito único: valor quebrado aparece arredondado para CIMA (mandando o que aparece, chega o suficiente)', () => {
  // 816 288 lamports cortados em 6 casas seriam 0,000816 (816 000): chegariam 288 a menos e a espera não terminaria
  const odd = { ...base, lamports: '816288', forwards: [] as unknown[], frases: [1] };
  assert.match(card(odd).text(), /Mande exatamente 0,000817 SOL/);
  // chegou parte: o que falta (316 288) também para cima
  assert.match(card({ ...odd, received: '500000' }).text(), /Chegou 0,000500 de 0,000817 SOL\. Falta 0,000317 SOL\./);
});

const base = {
  hubFrase: 1,
  hubName: 'N=0',
  hub: 'HubAddr1111111111111111111111111111111111111',
  lamports: '20050000',
  received: '0',
  status: 'esperando',
  frases: [1, 2],
  forwards: [{ toFrase: 2, toName: 'N=3', to: 'ToAddr', lamports: '10000000', status: null }],
};

test('depósito único: uma carteira, um valor exato, e o que o app faz depois, em ordem', () => {
  const c = card(base);
  const txt = c.text();
  assert.match(txt, /Falta SOL para as taxas de rede em 2 frases: um depósito só resolve todas/);
  assert.match(txt, /Mande exatamente 0,020050 SOL da sua carteira para esta, Frase 1 · temporária N=0:/);
  assert.ok(txt.includes(base.hub), 'o endereço da central, com Copiar');
  assert.match(txt, /repassa sozinho 0,010000 SOL para Frase 2 · temporária N=3/);
  assert.ok(txt.indexOf('repassa sozinho') < txt.indexOf('monta e testa a limpeza das 2 frases') && txt.indexOf('monta e testa') < txt.indexOf('só envia depois da sua confirmação'));
  assert.match(txt, /volta inteiro ao destino no fim, sem a taxa do app/);
  assert.match(txt, /Mandar o SOL já é a sua confirmação para os repasses/);
  assert.match(txt, /Esperando o depósito…/);
  // uma frase só: sem repasse e sem o aviso dos repasses
  const one = card({ ...base, frases: [1], forwards: [], lamports: '10000000' }).text();
  assert.match(one, /^Falta SOL para as taxas de rede /);
  assert.doesNotMatch(one, /repassa|repasses/);
});

test('depósito único: andamento (parte, repassando, pronto) e repasse que falhou com "Tentar de novo"', () => {
  assert.match(card({ ...base, received: '5000000' }).text(), /Chegou 0,005000 de 0,020050 SOL\. Falta 0,015050 SOL\./);
  assert.match(card({ ...base, received: '20050000', status: 'repassando' }).text(), /Repassando para as outras frases/);
  assert.match(card({ ...base, status: 'pronto', forwards: [{ ...base.forwards[0], status: 'enviado', link: 'https://solscan.io/tx/x' }] }).text(), /Depósito recebido e repassado/);
  const bad = card({ ...base, status: 'falhou', forwards: [{ ...base.forwards[0], status: 'falhou', detail: 'saldo insuficiente' }] });
  assert.match(bad.text(), /O repasse para Frase 2 · temporária N=3 não foi enviado\. saldo insuficiente/);
  assert.match(bad.text(), /Tentar o repasse de novo/);
});

test('depósito único: textos nos dois idiomas, a tela usa o cartão único na espera e o evento do andamento', () => {
  const keys = Object.keys(I18N.pt).filter((k) => k.startsWith('dep.'));
  assert.ok(keys.length >= 15);
  for (const k of keys) assert.ok(k in I18N.en, `falta "${k}" em inglês`);
  assert.doesNotMatch(SCRIPT, /fund\.tip/, 'a dica de "um depósito por frase" saiu');
  const prep = fnSource('renderPrep');
  assert.match(prep, /if \(state\?\.single\) \{[\s\S]*cards\.push\(singleCard\(state\.single, canSkip \?/);
  assert.match(SCRIPT, /events\.addEventListener\('deposito', /);
  assert.match(fnSource('retryForward'), /api\('\/api\/repassar'/);
  // juntar e empréstimo continuam, fechados em "Não quer depositar?"
  assert.match(fnSource('otherOptions'), /gatherBlock\(f\), fundingBlock\(f\)/);
});
