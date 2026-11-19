// Tela de entrada (cartões de frase): a conferência no navegador é a mesma do app, a repetida é a mesma do servidor,
// o rodapé só pede números, e o texto das frases não fica na página depois do 202.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateMnemonic } from '../../src/core/carteiras/bip39.ts';
import { parseFrases } from '../../src/app/frases.ts';
import { estimativa } from '../../src/app/server.ts';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const WORD_TEXT = fs.readFileSync(path.join(ROOT, 'src', 'core', 'carteiras', 'bip39-english.txt'), 'utf8');
const WORDS = WORD_TEXT.split('\n').filter(Boolean);

type Check = { code: string; params: Record<string, unknown> };
type Why = { key: string; params: Record<string, unknown> } | null;
type Entrada = {
  MAX_FRASES: number;
  PHRASE_FIELD_ATTRS: Record<string, unknown>;
  normalizePhrase: (t: string) => string;
  parseWordList: (t: string) => Map<string, number> | null;
  checkPhrase: (t: string, w: Map<string, number> | null, d: ((b: Uint8Array) => Promise<ArrayBuffer>) | null) => Promise<Check>;
  markDuplicates: (items: { app: string; text: string; check: Check }[]) => Check[];
  badgeKind: (c: Check) => 'ok' | 'neutral' | 'bad';
  canAnalyze: (c: Check[]) => boolean;
  submitState: (c: Check[], o?: { sending?: boolean; pending?: boolean }) => { allowed: boolean; why: Why };
  estimateBody: (n: number) => Record<string, unknown>;
  estimateMinutes: (s: number) => number;
  validEstimate: (r: unknown) => boolean;
  FILE_MAX_BYTES: number;
  extractPhrases: (text: string) => string[];
  planFileFill: (found: number, emptyIdx: number[], cards: number, max?: number) => { fits: true; reuse: number[]; create: number } | { fits: false; found: number; room: number };
};
const ENTRADA_BLOCK = (() => {
  const start = HTML.indexOf('// entrada:inicio');
  const end = HTML.indexOf('// entrada:fim');
  assert.ok(start > 0 && end > start, 'marcadores da entrada');
  return HTML.slice(start, end);
})();
const E: Entrada = new Function(`${ENTRADA_BLOCK}; return { MAX_FRASES, PHRASE_FIELD_ATTRS, normalizePhrase, parseWordList, checkPhrase, markDuplicates, badgeKind, canAnalyze, submitState, estimateBody, estimateMinutes, validEstimate, FILE_MAX_BYTES, extractPhrases, planFileFill };`)();
type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
const tr = (lang: 'pt' | 'en', key: string, p?: unknown) => (I18N[lang][key] as (p?: unknown) => string)(p);

const DIGEST = (b: Uint8Array) => crypto.subtle.digest('SHA-256', b);
const INDEX = E.parseWordList(WORD_TEXT)!;

function mnemonicOf(entropy: Buffer): string {
  const cs = createHash('sha256').update(entropy).digest();
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('') + cs[0].toString(2).padStart(8, '0').slice(0, entropy.length / 4);
  return bits.match(/.{11}/g)!.map((b) => WORDS[parseInt(b, 2)]).join(' ');
}
const bytes = (label: string, n: number) => createHash('sha256').update(label).digest().subarray(0, n);
const A = mnemonicOf(bytes('entrada-a', 16));
const B = mnemonicOf(bytes('entrada-b', 32));
const OK: Check = { code: 'ok', params: { words: 12 } };

test('entrada: lista BIP39 da página tem as 2048 palavras (LF ou CRLF); lista cortada não vale', () => {
  assert.equal(INDEX.size, 2048);
  assert.equal(E.parseWordList(WORD_TEXT.replace(/\n/g, '\r\n'))?.size, 2048);
  assert.equal(E.parseWordList(WORDS.slice(1).join('\n')), null, '2047 palavras');
  assert.equal(E.parseWordList('<!doctype html>'), null, 'resposta que não é a lista');
});

test('entrada: conferência no navegador igual à do app (validateMnemonic), com código e posição, nunca a palavra', async () => {
  const cases: string[] = [
    A, B, `  ${A.toUpperCase().split(' ').join('\n\t ')}  `,
    A.split(' ').slice(0, 11).join(' '), // falta 1
    `${A} ${A.split(' ')[0]}`, // 13
    `${B} abandon`, // 25
    'abandon',
    A.replace(/^(\S+ \S+ \S+ \S+) \S+/, '$1 zzzzz'), // palavra nº 5 fora da lista
    A.split(' ').slice(0, 11).concat(A.split(' ')[0] === 'zoo' ? 'abandon' : 'zoo').join(' '), // checksum
  ];
  // e mais 300 frases de entropia fixa (12 a 24 palavras), metade com uma palavra trocada por outra da lista
  for (let k = 0; k < 300; k++) {
    const size = [16, 20, 24, 28, 32][k % 5];
    const m = mnemonicOf(bytes(`entrada-${k}`, size)).split(' ');
    if (k % 2) m[k % m.length] = WORDS[(INDEX.get(m[k % m.length])! + 1 + k) % 2048];
    cases.push(m.join(' '));
  }
  const seen = new Set<string>();
  for (const text of cases) {
    const page = await E.checkPhrase(text, INDEX, DIGEST);
    const core = validateMnemonic(text);
    seen.add(page.code);
    if (core.ok) assert.deepEqual(page, { code: 'ok', params: { words: text.trim().split(/\s+/).length } });
    else assert.deepEqual(page, { code: core.code, params: core.params }, `mesmo código e params (${core.code})`);
    for (const v of Object.values(page.params)) assert.equal(typeof v, 'number', 'params só com número (contagem ou posição), nunca a palavra');
  }
  assert.deepEqual([...seen].sort(), ['ok', 'seed-checksum', 'seed-unknown-word', 'seed-words'], 'todos os casos cobertos');
  // vazia: o cartão espera (o app recusaria com seed-words {words: 0}, mas o botão nem liga)
  assert.deepEqual(await E.checkPhrase('  \n ', INDEX, DIGEST), { code: 'empty', params: {} });
  // sem lista ou sem SHA-256: não inventa "certa"; o app confere ao analisar
  assert.deepEqual(await E.checkPhrase(A, null, DIGEST), { code: 'unchecked', params: { words: 12 } });
  assert.deepEqual(await E.checkPhrase(A, INDEX, null), { code: 'unchecked', params: { words: 12 } });
  assert.deepEqual(await E.checkPhrase(A, INDEX, () => Promise.reject(new Error('x'))), { code: 'unchecked', params: { words: 12 } });
  assert.equal((await E.checkPhrase(A.split(' ').slice(0, 11).join(' '), null, null)).code, 'seed-words', 'contagem errada sai mesmo sem lista');
});

test('entrada: repetida marcada na segunda, com a mesma chave do servidor (app|frase normalizada)', async () => {
  const items = [
    { app: 'solflare', text: A },
    { app: 'phantom', text: A }, // mesma frase na Phantom: não é repetida
    { app: 'solflare', text: `  ${A.toUpperCase()} ` }, // repete a 1
    { app: 'solflare', text: B },
    { app: 'solflare', text: A.split(' ').slice(0, 11).join(' ') }, // inválida: não entra na conta
    { app: 'phantom', text: A.split('  ').join(' ').replace(/ /g, '\n') }, // repete a 2
    { app: 'phantom', text: B },
    { app: 'solflare', text: A.split(' ').slice(0, 11).join(' ') }, // a mesma inválida de novo: continua "palavras", não "repetida"
  ];
  const checks = await Promise.all(items.map((it) => E.checkPhrase(it.text, INDEX, DIGEST)));
  const page = E.markDuplicates(items.map((it, i) => ({ ...it, check: checks[i] })));
  const server = parseFrases(items.map((it) => ({ texto: it.text, carteira: it.app })));
  for (const f of server) f.seed?.fill(0);
  assert.deepEqual(page.map((c) => c.code), server.map((f) => (f.error ? f.error.code : 'ok')), 'mesmos códigos do servidor');
  assert.deepEqual(page.map((c) => (c.code === 'seed-duplicate' ? c.params.of : null)), [null, null, 1, null, null, 2, null, null]);
  assert.deepEqual(page.map((c) => (c.code === 'seed-duplicate' ? c.params.of : null)), server.map((f) => (f.error?.code === 'seed-duplicate' ? f.error.params.of : null)));
  // sem lista no navegador ('unchecked') também é comparada: segurar a repetida é o lado seguro
  const unchecked = E.markDuplicates([{ app: 'solflare', text: A, check: { code: 'unchecked', params: {} } }, { app: 'solflare', text: A, check: { code: 'unchecked', params: {} } }]);
  assert.equal(unchecked[1].code, 'seed-duplicate');
});

test('entrada: "Analisar" só com 1 a 10 frases, todas conferidas; selo vermelho para todo erro', () => {
  const un = { code: 'unchecked', params: { words: 12 } };
  assert.equal(E.canAnalyze([OK]), true);
  assert.equal(E.canAnalyze([OK, un]), true, 'sem lista: o app confere');
  assert.equal(E.canAnalyze([]), false);
  assert.equal(E.canAnalyze(Array(10).fill(OK)), true);
  assert.equal(E.canAnalyze(Array(11).fill(OK)), false, 'máximo de 10');
  for (const code of ['empty', 'checking', 'seed-words', 'seed-unknown-word', 'seed-checksum', 'seed-duplicate']) assert.equal(E.canAnalyze([OK, { code, params: {} }]), false, code);
  assert.equal(E.MAX_FRASES, 10);
  assert.equal(E.badgeKind(OK), 'ok');
  for (const code of ['unchecked', 'empty', 'checking']) assert.equal(E.badgeKind({ code, params: {} }), 'neutral', code);
  for (const code of ['seed-words', 'seed-unknown-word', 'seed-checksum', 'seed-duplicate']) {
    assert.equal(E.badgeKind({ code, params: {} }), 'bad', code);
    // o cartão mostra o selo curto e, embaixo, o texto do catálogo (err.seed-*)
    for (const lang of ['pt', 'en'] as const) assert.equal(typeof I18N[lang][`err.${code}.what`], 'function', `${lang} err.${code}.what`);
  }
  for (const code of ['empty', 'checking', 'ok', 'unchecked', 'seed-words', 'seed-unknown-word', 'seed-checksum', 'seed-duplicate']) {
    for (const lang of ['pt', 'en'] as const) assert.equal(typeof I18N[lang][`in.st.${code}`], 'function', `${lang} in.st.${code}`);
  }
  assert.equal(tr('pt', 'in.st.seed-words', { words: 11 }), '11 palavras: falta 1');
  assert.equal(tr('pt', 'in.st.seed-words', { words: 26 }), '26 palavras: sobram 2');
});

test('entrada: botão desligado diz por quê (Ruling 17): conferindo, quais corrigir ou remover, quais estão vazias', () => {
  const bad = (code: string) => ({ code, params: {} });
  const empty = bad('empty');
  assert.deepEqual(E.submitState([OK, OK]), { allowed: true, why: null });
  assert.deepEqual(E.submitState([OK], { sending: true }), { allowed: false, why: null }, 'enviando: só desliga');
  assert.deepEqual(E.submitState([OK], { pending: true }), { allowed: false, why: { key: 'in.why.checking', params: {} } }, 'a pessoa mexeu e a conferência não terminou');
  assert.deepEqual(E.submitState([OK, bad('checking')]).why?.key, 'in.why.checking');
  assert.deepEqual(E.submitState([OK, OK, bad('seed-checksum')]), { allowed: false, why: { key: 'in.why.fix', params: { ns: [3] } } });
  assert.deepEqual(E.submitState([bad('seed-words'), empty, bad('seed-duplicate')]).why, { key: 'in.why.fix', params: { ns: [1, 3] } }, 'erro antes de vazia');
  assert.deepEqual(E.submitState([OK, empty]), { allowed: false, why: { key: 'in.why.empty', params: { ns: [2] } } });
  assert.equal(tr('pt', 'in.why.fix', { ns: [3] }), 'Corrija ou remova a frase 3.');
  assert.equal(tr('pt', 'in.why.fix', { ns: [1, 3, 4] }), 'Corrija ou remova as frases 1, 3 e 4.');
  assert.equal(tr('en', 'in.why.fix', { ns: [1, 3] }), 'Fix or remove phrases 1 and 3.');
  assert.equal(tr('pt', 'in.why.empty', { ns: [2] }), 'Cole a frase 2 ou remova o cartão.');
  assert.equal(tr('en', 'in.why.checking'), 'Checking the phrases…');
  // a página mostra o motivo embaixo do botão, ligado a ele
  assert.match(HTML, /id="b-analisar" aria-describedby="b-analisar-why"/);
  assert.match(fnSource('renderEntry'), /setText\(\$\('b-analisar-why'\), st\.why \? t\(st\.why\.key, st\.why\.params\) : ''\);/);
  assert.match(fnSource('entryState'), /pending: entry\.checkedGen !== entry\.gen/);
});

test('entrada: estimativa pede só o número de frases (o app sabe sozinho se tem RPC próprio); o servidor aceita o pedido', () => {
  const body = E.estimateBody(3);
  assert.deepEqual(body, { frases: 3, etapa: 'analise' });
  const r = estimativa(JSON.parse(JSON.stringify(body)));
  assert.ok(r.seconds > 0 && r.credits > 0 && r.wallets > 0);
  assert.equal(E.estimateMinutes(59), 0);
  assert.equal(E.estimateMinutes(300), 5);
  // um lugar só chama a estimativa, com o corpo de estimateBody (sem frase nem RPC)
  const calls = [...SCRIPT.matchAll(/api\('\/api\/estimativa', ([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['body', '{ ...body, etapa }']);
  // a do botão "Simular" (resumo) leva só números: frases, carteiras e se o RPC é próprio (nunca o endereço)
  assert.match(fnSource('fetchRunEstimate'), /const body = \{ frases: fs\.length, carteiras: fs\.reduce\(\(a, f\) => a \+ f\.wallets\.length, 0\), rpcProprio: rpcIsCustom\(state\?\.rpc\) \};/);
  assert.match(fnSource('fetchEstimate'), /const body = estimateBody\(entry\.cards\.length\);/);
  // sem campo de RPC na entrada (pedido do autor, 31/10/2026): o app vem com o RPC dele
  assert.doesNotMatch(HTML, /id="rpc"|frase\.rpc|frase\.advanced/);
  assert.doesNotMatch(fnSource('submitFrases'), /rpc:/, 'a análise não manda RPC: o servidor escolhe');
  assert.match(fnSource('scheduleEstimate'), /setTimeout\(fetchEstimate, 300\)/, 'debounce de 300 ms');
});

test('entrada: estimativa que falha mostra texto neutro (não "calculando" para sempre)', async () => {
  const entry = { cards: [{}, {}], est: { seconds: 1 }, estKey: '', estSeq: 0, estFailed: false };
  let rendered = 0;
  const run = new Function('entry', 'estimateBody', '$', 'api', 'renderEstimate', `${fnSource('fetchEstimate')}\nreturn fetchEstimate;`)(
    entry, E.estimateBody, () => ({ value: '' }), () => Promise.reject(new Error('rede')), () => { rendered++; },
  ) as () => Promise<void>;
  await run();
  assert.deepEqual({ est: entry.est, estKey: entry.estKey, estFailed: entry.estFailed, rendered }, { est: null, estKey: '', estFailed: true, rendered: 1 });
  assert.match(fnSource('renderEstimate'), /t\(entry\.estFailed \? 'in\.estNone' : 'in\.estWait'\)/);
  assert.equal(tr('pt', 'in.estNone'), 'estimativa indisponível agora');
});

test('entrada: estimativa fora do formato vira "indisponível", não quebra a tela nem mostra NaN', async () => {
  assert.equal(E.validEstimate({ wallets: 200, seconds: 900, credits: 980 }), true);
  for (const bad of [null, undefined, {}, { ok: true }, { wallets: 200, seconds: 900 }, { wallets: '200', seconds: 900, credits: 1 },
    { wallets: 200, seconds: NaN, credits: 1 }, { wallets: 200, seconds: null, credits: 1 }, { wallets: -1, seconds: 1, credits: 1 }]) {
    assert.equal(E.validEstimate(bad), false, JSON.stringify(bad));
  }
  const entry = { cards: [{}, {}], est: null as unknown, estKey: '', estSeq: 0, estFailed: false };
  let rendered = 0;
  const run = new Function('entry', 'estimateBody', 'validEstimate', '$', 'api', 'renderEstimate', `${fnSource('fetchEstimate')}
return fetchEstimate;`)(
    entry, E.estimateBody, E.validEstimate, () => ({ value: '' }), () => Promise.resolve({ ok: true }), () => { rendered++; },
  ) as () => Promise<void>;
  await run();
  assert.deepEqual({ est: entry.est, estKey: entry.estKey, estFailed: entry.estFailed, rendered }, { est: null, estKey: '', estFailed: true, rendered: 1 });
});

test('entrada: lista BIP39 que não veio não fica guardada; a próxima conferência baixa de novo', async () => {
  const entry: { words: Promise<unknown> | null } = { words: null };
  const answers = [() => Promise.reject(new Error('rede')), () => Promise.resolve({ ok: false }), () => Promise.resolve({ ok: true, text: () => WORD_TEXT })];
  let fetches = 0;
  const loadWords = new Function('entry', 'fetch', 'parseWordList', `${fnSource('loadWords')}\nreturn loadWords;`)(
    entry, () => answers[fetches++](), E.parseWordList,
  ) as () => Promise<Map<string, number> | null>;
  assert.equal(await loadWords(), null);
  assert.equal(await loadWords(), null);
  assert.equal((await loadWords())?.size, 2048);
  assert.equal(fetches, 3, 'tentou de novo depois de cada falha');
  assert.equal((await loadWords())?.size, 2048);
  assert.equal(fetches, 3, 'lista boa: baixada uma vez só');
});

test('entrada: campo da frase escondido, sem autocompletar e ligado ao erro do cartão; é o único campo de frase', () => {
  assert.deepEqual(E.PHRASE_FIELD_ATTRS, { class: 'masked', rows: 2, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', 'data-lpignore': 'true', 'data-1p-ignore': true });
  assert.match(HTML, /\.masked \{ -webkit-text-security: disc;/);
  assert.deepEqual([...SCRIPT.matchAll(/el\('textarea', ([^)]*)\)/g)].map((m) => m[1]), ["{ ...PHRASE_FIELD_ATTRS, 'aria-describedby': `fr-err-${id}` }"]);
  assert.doesNotMatch(HTML.slice(0, HTML.lastIndexOf('<script>')), /<textarea/, 'nenhum textarea fixo (o antigo #frase saiu)');
  // o leitor de tela lê o erro do cartão junto com o campo, e o campo vermelho é "inválido"
  assert.match(fnSource('phraseCard'), /c\.err = el\('p', \{ class: 'fr-err', id: `fr-err-\$\{id\}` \}\);/);
  assert.match(fnSource('addCard'), /phraseCard\(entry\.nextId\+\+, scheduleCheck, removeCard\)/, 'entrada e "corrigir só esta" usam o mesmo cartão');
  assert.match(fnSource('openFix'), /phraseCard\(`fix-\$\{n\}`/);
  assert.match(fnSource('paintCard'), /if \(kind === 'bad'\) c\.ta\.setAttribute\('aria-invalid', 'true'\); else c\.ta\.removeAttribute\('aria-invalid'\);/);
});

test('entrada: texto escrito só quando muda (aria-live não repete a cada tecla)', () => {
  const setText = new Function(`${fnSource('setText')}\nreturn setText;`)() as (n: object, t: string) => void;
  let writes = 0;
  let value = 'conferindo…';
  const node = { get textContent() { return value; }, set textContent(v: string) { writes++; value = v; } };
  setText(node, 'conferindo…');
  setText(node, 'conferindo…');
  assert.equal(writes, 0);
  setText(node, '12 palavras ✓');
  assert.equal(writes, 1);
  const render = fnSource('renderEntry');
  assert.doesNotMatch(render, /\.textContent = /, 'renderEntry escreve texto só por setText');
  assert.match(fnSource('renderEstimate'), /if \(\$\('est'\)\.textContent !== left\.textContent \+ right\.textContent\) \$\('est'\)\.replaceChildren\(left, right\);/);
});

test('entrada: o texto só é lido para conferir e para o POST /api/analisar; nada vai para log', () => {
  assert.doesNotMatch(SCRIPT, /console\./, 'sem console na página');
  const reads = [...SCRIPT.matchAll(/[^\n]*\.ta\.value(?! = '')[^\n]*/g)].map((m) => m[0].trim());
  assert.deepEqual(reads, [
    "for (const c of entry.cards) checks.push(await checkPhrase(c.ta.value, words, DIGEST));",
    "const marked = markDuplicates(entry.cards.map((c, i) => ({ app: appOf(c), text: c.ta.value, check: checks[i] })));",
    // arquivos .txt: qual cartão está vazio (para preencher) e a frase do arquivo entrando no campo
    "const emptyIdx = entry.cards.map((c, i) => (c.ta.value.trim() === '' ? i : -1)).filter((i) => i >= 0);",
    "c.ta.value = phrases[i];",
    "frases: entry.cards.map((c) => ({ texto: c.ta.value, carteira: appOf(c) })),",
    // "corrigir e analisar só esta" (resumo): conferir e o POST /api/analisar-frase
    'const check = await checkPhrase(f.card.ta.value, words, DIGEST);',
    "await api('/api/analisar-frase', { n: f.n, texto: f.card.ta.value, carteira: appOf(f.card) });",
  ]);
  assert.match(SCRIPT, /\$\('f-frase'\)\.addEventListener\('submit', submitFrases\);/);
  // apaga logo depois do 202: a próxima linha depois do pedido é clearFrases()
  assert.match(fnSource('submitFrases'), /await api\('\/api\/analisar', \{[\s\S]*?\r?\n {4}\}\);\s*clearFrases\(\);/);
  assert.match(fnSource('sendFix'), /await api\('\/api\/analisar-frase', [^\n]*\n\s*closeFix\(\);/, 'corrigir só esta: campo apagado logo depois do 202');
  assert.match(fnSource('closeFix'), /f\.card\.ta\.value = '';[^\n]*\n[\s\S]*f\.box\.remove\(\);/, 'apaga antes de tirar da página');
  assert.match(fnSource('resetPage'), /closeFix\(\);/, 'começar de novo apaga a frase sendo corrigida');
  assert.match(fnSource('resetPage'), /resetFrases\(\);/, 'começar de novo apaga as frases');
});

// ---------- funções da página rodadas com peças falsas no lugar do DOM ----------
type FakeCard = {
  ta: { value: string; focused?: boolean; focus: () => void };
  li: { remove: () => void; removed?: boolean; querySelector: (q: string) => { checked: boolean } | null };
  check: Check;
  app: string;
  solflare: { checked: boolean };
};
function card(text: string, app = 'solflare', check: Check = OK): FakeCard {
  const solflare = { checked: app === 'solflare' };
  const c: FakeCard = {
    ta: { value: text, focus: () => { c.ta.focused = true; } },
    li: { remove: () => { c.li.removed = true; }, querySelector: (q) => (q === 'input[value=solflare]' ? solflare : null) },
    check, app, solflare,
  };
  return c;
}

test('entrada: clearFrases apaga todos os campos; resetFrases volta a um cartão vazio', () => {
  const run = (fn: string, cards: FakeCard[]) => {
    const entry = { cards, gen: 0, checkedGen: 0, timer: null };
    const calls: string[] = [];
    new Function('entry', 'renderEntry', 'addCard', 'scheduleEstimate', 'clearTimeout', `${fnSource('clearFrases')}\n${fnSource('resetFrases')}\n${fn}();`)(
      entry, () => calls.push('render'), () => entry.cards.push(card('')), () => calls.push('estimate'), () => {});
    return { entry, calls };
  };
  const { entry, calls } = run('clearFrases', [card(A), card(B), card(A)]);
  assert.deepEqual(entry.cards.map((c) => c.ta.value), ['', '', ''], 'todos os campos vazios');
  assert.deepEqual(entry.cards.map((c) => c.check), Array(3).fill({ code: 'empty', params: {} }), 'selos voltam a "cole a frase"');
  assert.equal(entry.gen, 1, 'conferência em andamento é descartada');
  assert.equal(entry.checkedGen, 1, 'campos vazios: nada pendente');
  assert.ok(calls.includes('render'));
  const three = [card(A, 'phantom'), card(B), card(A)];
  const r = run('resetFrases', [...three]);
  assert.equal(r.entry.cards.length, 1);
  assert.deepEqual(three.map((c) => c.ta.value), ['', '', ''], 'os cartões tirados também ficam vazios');
  assert.deepEqual(three.map((c) => Boolean(c.li.removed)), [false, true, true]);
});

// pedido do autor (31/10/2026): os amigos não sabem dizer se a frase é Solflare ou Phantom; o app descobre pela rede
test('entrada: o cartão não pergunta o app; toda frase vai como "auto" (a análise descobre Solflare ou Phantom)', () => {
  assert.doesNotMatch(fnSource('phraseCard'), /radio|solflare|phantom/i, 'sem escolha de app no cartão');
  assert.match(SCRIPT, /const appOf = \(\) => 'auto';/);
  for (const fn of ['resetFrases', 'importFiles', 'openFix']) assert.doesNotMatch(fnSource(fn), /solflare|phantom/i, `${fn} não escolhe app`);
  assert.match(fnSource('submitFrases'), /carteira: appOf\(c\)/);
});

test('entrada: × apaga o campo antes de tirar o cartão', () => {
  const cards = [card(A), card(B), card(A, 'phantom')];
  const removed = cards[1];
  const entry = { cards: [...cards] };
  let checks = 0;
  const removeCard = new Function('entry', 'scheduleCheck', `${fnSource('removeCard')}\nreturn removeCard;`)(entry, () => { checks++; }) as (c: FakeCard) => void;
  removeCard(removed);
  assert.equal(removed.ta.value, '', 'campo do cartão tirado vazio');
  assert.equal(removed.li.removed, true);
  assert.deepEqual(entry.cards, [cards[0], cards[2]]);
  assert.equal(checks, 1, 'confere de novo (a repetida pode ter mudado)');
  assert.equal(cards[2].ta.focused, true, 'foco no cartão que ocupou o lugar');
  removeCard(cards[0]);
  removeCard(cards[2]);
  assert.equal(entry.cards.length, 1, 'o último cartão não sai');
  assert.equal(cards[2].ta.value, A);
});

test('entrada: conferência velha não pinta selo; a da vez marca o cartão e libera o botão', async () => {
  const make = (bumpDuring: boolean) => {
    const cards = [card(A, 'solflare', { code: 'checking', params: {} }), card(A, 'solflare', { code: 'checking', params: {} })];
    const entry = { cards, gen: 5, checkedGen: 4 };
    let renders = 0;
    const slowDigest = async (b: Uint8Array) => {
      if (bumpDuring) entry.gen++; // a pessoa digitou enquanto conferia
      return DIGEST(b);
    };
    const checkAll = new Function('entry', 'loadWords', 'checkPhrase', 'DIGEST', 'markDuplicates', 'appOf', 'renderEntry', `${fnSource('checkAll')}\nreturn checkAll;`)(
      entry, async () => INDEX, E.checkPhrase, slowDigest, E.markDuplicates, (c: FakeCard) => c.app, () => { renders++; },
    ) as () => Promise<void>;
    return { entry, cards, checkAll, renders: () => renders };
  };
  const stale = make(true);
  await stale.checkAll();
  assert.deepEqual(stale.cards.map((c) => c.check.code), ['checking', 'checking'], 'resultado velho descartado');
  assert.equal(stale.entry.checkedGen, 4, 'continua pendente');
  assert.equal(stale.renders(), 0);
  assert.equal(E.submitState(stale.cards.map((c) => c.check), { pending: stale.entry.checkedGen !== stale.entry.gen }).allowed, false);
  const fresh = make(false);
  await fresh.checkAll();
  assert.deepEqual(fresh.cards.map((c) => c.check), [OK, { code: 'seed-duplicate', params: { of: 1 } }]);
  assert.equal(fresh.entry.checkedGen, 5, 'conferência da vez terminou');
  assert.equal(fresh.renders(), 1);
});

test('entrada: mexer num cartão deixa ele "conferindo…" e o botão desligado até a conferência da vez', () => {
  const entry = { cards: [] as FakeCard[], gen: 3, checkedGen: 3, timer: null as unknown };
  const c = card(A);
  let timer: unknown = null;
  new Function('entry', 'renderEntry', 'scheduleEstimate', 'setTimeout', 'clearTimeout', 'checkAll', `${fnSource('scheduleCheck')}\nscheduleCheck(arguments[6]);`)(
    entry, () => {}, () => {}, (f: unknown, ms: number) => { timer = [f, ms]; return 1; }, () => {}, 'checkAll', c,
  );
  assert.deepEqual(c.check, { code: 'checking', params: {} });
  assert.equal(E.badgeKind(c.check), 'neutral');
  assert.equal(entry.gen, 4);
  assert.deepEqual(timer, ['checkAll', 150]);
  assert.deepEqual(E.submitState([OK], { pending: entry.checkedGen !== entry.gen }).allowed, false);
  assert.equal(tr('pt', 'in.st.checking'), 'conferindo…');
});

test('entrada: envio só com o botão liberado (enviando, conferindo ou frase errada não manda nada)', async () => {
  const runSubmit = async (opts: { cards: FakeCard[]; sending?: boolean; pending?: boolean; fail?: boolean }) => {
    const entry = { cards: opts.cards, sending: Boolean(opts.sending), gen: opts.pending ? 2 : 1, checkedGen: 1 };
    const ui: { dest: unknown; prep: object } = { dest: null, prep: {} };
    const sent: unknown[] = [];
    const calls: string[] = [];
    const fakes = {
      entry,
      showError: (id: string, f: unknown) => calls.push(f ? `erro:${id}` : `limpa:${id}`),
      submitState: E.submitState,
      api: async (p: string, body: unknown) => { sent.push([p, body]); if (opts.fail) throw new Error('recusado'); return { ok: true }; },
      renderEntry: () => calls.push('render'),
      clearFrases: () => { calls.push('clear'); for (const c of entry.cards) c.ta.value = ''; },
      beginAnalysis: (n: number) => calls.push(`begin:${n}`),
      show: (s: string) => calls.push(`show:${s}`),
      document: { querySelector: () => ({ value: 'mainnet' }) },
      $: (id: string) => ({ value: id === 'destino' ? '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN' : '', focus: () => {} }),
      PARAMS: { rede: 'mainnet' },
      isAddrLike: (a: string) => a.length === 44,
      ui,
      renderPrep: () => calls.push('prep'),
      appOf: () => 'auto',
      entryError: () => () => null,
    };
    const fn = new Function(...Object.keys(fakes), `${fnSource('entryState')}\n${fnSource('submitFrases')}\nreturn submitFrases;`)(...Object.values(fakes)) as (ev: object) => Promise<void>;
    let prevented = false;
    await fn({ preventDefault: () => { prevented = true; } });
    assert.ok(prevented);
    return { sent, calls, entry, ui };
  };
  assert.equal((await runSubmit({ cards: [card(A)], sending: true })).sent.length, 0, 'já enviando');
  assert.equal((await runSubmit({ cards: [card(A)], pending: true })).sent.length, 0, 'conferência da vez não terminou');
  assert.equal((await runSubmit({ cards: [card(A), card(B, 'solflare', { code: 'seed-checksum', params: {} })] })).sent.length, 0, 'frase errada');
  assert.equal((await runSubmit({ cards: [card(A), card('', 'solflare', { code: 'empty', params: {} })] })).sent.length, 0, 'frase vazia');
  const ok = await runSubmit({ cards: [card(A), card(B)] });
  assert.deepEqual(ok.sent, [['/api/analisar', { frases: [{ texto: A, carteira: 'auto' }, { texto: B, carteira: 'auto' }], rede: 'mainnet' }]]);
  assert.ok(ok.calls.indexOf('clear') < ok.calls.indexOf('show:s-preparo'), 'apaga antes de trocar de tela');
  assert.deepEqual(ok.ui.dest, { addr: '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN' }, 'o endereço colado fica para o plano, como foi digitado');
  // destino colado 1× (decisão do autor, 31/10/2026): sem segundo campo e sem pré-preenchimento da principal
  assert.doesNotMatch(HTML, /id="destino2"/, 'um campo só');
  assert.doesNotMatch(SCRIPT, /addr2|destino2|in\.why\.dest2/, 'nenhuma segunda colagem, nem na troca da Confirmar');
  assert.doesNotMatch(HTML, /destmode|dest-addr-box/, 'sem escolha "minha principal" e sem campo escondido');
  assert.doesNotMatch(SCRIPT, /useMain|\.main \}; runPlan/, 'a página nunca preenche o destino com a principal calculada');
  assert.match(fnSource('submitFrases'), /if \(!isAddrLike\(dest\.addr\)\) \{ showError\('e-frase', \(\) => t\('in\.why\.dest'\)\)/, 'não parece endereço: não manda');
  assert.match(fnSource('runPlan'), /destino: dest, porFrase/, 'manda o destino como foi colado');
  assert.match(fnSource('destinationOf'), /return dest\?\.addr \|\| null;/, 'o destino é só o colado');
  assert.ok(ok.calls.indexOf('clear') < ok.calls.indexOf('begin:2'), 'tela de análise com as 2 frases, depois de apagar');
  assert.deepEqual(ok.entry.cards.map((c) => c.ta.value), ['', '']);
  assert.equal(ok.entry.sending, false);
  const refused = await runSubmit({ cards: [card(A)], fail: true });
  assert.ok(refused.calls.includes('erro:e-frase') && !refused.calls.includes('clear'), 'recusa: mostra o erro, a frase fica para corrigir');
});

test('entrada: "+ Adicionar frase (n de 10)" some no 10º; textos de pt e en', () => {
  const render = fnSource('renderEntry');
  assert.match(render, /\$\('b-add'\)\.classList\.toggle\('hidden', n >= MAX_FRASES\)/);
  assert.match(fnSource('addCard'), /if \(entry\.cards\.length >= MAX_FRASES\) return null;/);
  assert.equal(tr('pt', 'in.addCount', { n: 3, max: 10 }), '3 de 10');
  assert.equal(tr('en', 'in.submit', { n: 3 }), 'Start with 3 phrases');
  assert.equal(tr('pt', 'in.submit', { n: 1 }), 'Começar');
  // trocar de idioma redesenha os cartões
  assert.match(fnSource('rerender'), /renderEntry\(\);/);
});

// ---------- arquivos .txt (o que a Solflare baixa ao criar a carteira) ----------

test('entrada: arquivo .txt: uma frase por arquivo, várias por linha, uma palavra por linha (numerada ou não), blocos; nada é adivinhado', () => {
  const C = mnemonicOf(bytes('entrada-c', 16));
  const a = A.split(' ');
  const b = B.split(' ');
  assert.deepEqual(E.extractPhrases(A), [A], 'o arquivo da Solflare: as palavras numa linha');
  assert.deepEqual(E.extractPhrases(`\uFEFF${A.toUpperCase()}\r\n`), [A], 'BOM, maiúsculas e CRLF');
  assert.deepEqual(E.extractPhrases(a.join('\n')), [A], 'uma palavra por linha');
  assert.deepEqual(E.extractPhrases(a.map((w, i) => `${i + 1}. ${w}`).join('\n')), [A], 'numerada "1. palavra"');
  assert.deepEqual(E.extractPhrases(b.map((w, i) => `${i + 1}) ${w}`).join('\r\n')), [B], 'numerada "1) palavra", 24 palavras');
  assert.deepEqual(E.extractPhrases(a.map((w, i) => `${i + 1} ${w}`).join('\n')), [A], 'numerada "1 palavra"');
  assert.deepEqual(E.extractPhrases(a.join(', ')), [A], 'vírgulas');
  assert.deepEqual(E.extractPhrases([A, B, C].join('\n')), [A, B, C], 'várias frases, uma por linha, 12 e 24');
  assert.deepEqual(E.extractPhrases(`\n${A}\n\n${B}\n\n\n${C}\n`), [A, B, C], 'linhas em branco entre elas');
  assert.deepEqual(E.extractPhrases(`${a.join('\n')}\n\n${b.join('\n')}`), [A, B], 'blocos de uma palavra por linha');
  const ten = Array.from({ length: 10 }, (_, k) => mnemonicOf(bytes(`arq-${k}`, k % 2 ? 32 : 16)));
  assert.deepEqual(E.extractPhrases(ten.join('\n')), ten, '10 frases num arquivo só, na ordem');
  // nada adivinhado: contagem que não fecha, cabeçalho ou outro formato não viram frase
  assert.deepEqual(E.extractPhrases(''), []);
  assert.deepEqual(E.extractPhrases('   \n\n'), []);
  assert.deepEqual(E.extractPhrases(a.slice(0, 11).join(' ')), [], '11 palavras');
  assert.deepEqual(E.extractPhrases(`${A} ${a[0]}`), [], '13 palavras');
  assert.deepEqual(E.extractPhrases(`Recovery phrase:\n${A}`), [], 'cabeçalho junto');
  assert.deepEqual(E.extractPhrases('{"mnemonic":"x"}'), []);
  assert.deepEqual(E.extractPhrases(`${A}\n${a.slice(0, 11).join(' ')}`), [], 'uma linha certa e outra errada: nenhuma sai');
  for (const p of E.extractPhrases([A, B].join('\n'))) assert.equal(p, E.normalizePhrase(p), 'sai normalizada, como a conferência e o servidor usam');
});

test('entrada: frases do arquivo entram nos cartões vazios primeiro, depois em novos, até 10; não cabendo todas, nenhuma entra', () => {
  assert.deepEqual(E.planFileFill(1, [0], 1), { fits: true, reuse: [0], create: 0 }, 'o 1º cartão, vazio');
  assert.deepEqual(E.planFileFill(3, [1], 2), { fits: true, reuse: [1], create: 2 });
  assert.deepEqual(E.planFileFill(1, [3, 7], 10), { fits: true, reuse: [3], create: 0 }, 'o primeiro vazio, na ordem');
  assert.deepEqual(E.planFileFill(10, [0], 1), { fits: true, reuse: [0], create: 9 }, '10 frases, 1 cartão vazio: 9 novos');
  assert.deepEqual(E.planFileFill(11, [0], 1), { fits: false, found: 11, room: 10 }, '11 não cabem: nada entra');
  assert.deepEqual(E.planFileFill(2, [], 9), { fits: false, found: 2, room: 1 });
  assert.deepEqual(E.planFileFill(1, [], 10), { fits: false, found: 1, room: 0 });
  assert.deepEqual(E.planFileFill(0, [0], 1), { fits: false, found: 0, room: 10 }, 'nenhuma frase: nada entra');
  assert.equal(E.FILE_MAX_BYTES, 64 * 1024);
});

test('entrada: importFiles lê os arquivos na página, preenche e cria cartões e confere; a mensagem leva só contagens e nomes', async () => {
  type FakeFile = { name: string; size: number; text: () => Promise<string> };
  const file = (name: string, content: string, size = content.length): FakeFile => ({ name, size, text: async () => content });
  const run = async (cards: FakeCard[], files: FakeFile[]) => {
    const entry = { cards };
    const msg = { text: '', bad: false };
    const node = { classList: { toggle: (_c: string, on: boolean) => { msg.bad = on; } }, get textContent() { return msg.text; }, set textContent(v: string) { msg.text = v; } };
    const calls: string[] = [];
    const params: unknown[] = [];
    const fakes = {
      entry, MAX_FRASES: E.MAX_FRASES, FILE_MAX_BYTES: E.FILE_MAX_BYTES, extractPhrases: E.extractPhrases, planFileFill: E.planFileFill,
      $: (id: string) => { assert.equal(id, 'arq-msg'); return node; },
      t: (k: string, p: unknown) => { params.push(p); return `${k} ${JSON.stringify(p)}`; },
      setText: (n: { textContent: string }, text: string) => { n.textContent = text; },
      addCard: (...args: unknown[]) => { calls.push(`add:${args.length}`); const c = card(''); entry.cards.push(c); return c; },
      scheduleCheck: () => calls.push('check'),
    };
    const fn = new Function(...Object.keys(fakes), `${fnSource('fileNotice')}\n${fnSource('importFiles')}\nreturn importFiles;`)(...Object.values(fakes)) as (f: FakeFile[]) => Promise<void>;
    await fn(files);
    // nem a mensagem nem os parâmetros dos textos levam uma palavra das frases
    const leaked = JSON.stringify([msg.text, params]);
    for (const w of [...A.split(' '), ...B.split(' ')]) assert.ok(!new RegExp(`\\b${w}\\b`).test(leaked), `palavra "${w}" na mensagem`);
    return { entry, msg, calls };
  };
  const C = mnemonicOf(bytes('entrada-c', 16));
  const ckOf = (c: FakeCard) => c.check.code;

  // 1 arquivo no 1º cartão vazio: "conferindo", e a conferência é agendada
  let r = await run([card('', 'phantom', { code: 'empty', params: {} })], [file('solflare.txt', A)]);
  assert.deepEqual(r.entry.cards.map((c) => c.ta.value), [A]);
  assert.equal(ckOf(r.entry.cards[0]), 'checking');
  assert.deepEqual(r.calls, ['check']);
  assert.equal(r.entry.cards[0].ta.focused, true);
  assert.match(r.msg.text, /^in\.file\.added \{"n":1\}$/);
  assert.equal(r.msg.bad, false);

  // 2 arquivos (um com uma palavra por linha): o vazio é preenchido, o que falta vira cartão novo; o cheio fica
  r = await run([card(C), card('', 'solflare', { code: 'empty', params: {} })], [file('a.txt', A), file('b.txt', B.split(' ').join('\r\n'))]);
  assert.deepEqual(r.entry.cards.map((c) => c.ta.value), [C, A, B]);
  assert.deepEqual(r.calls, ['add:0', 'check']);
  assert.match(r.msg.text, /^in\.file\.added \{"n":2\}$/);

  // um arquivo com 3 frases e outro sem nenhuma: as 3 entram e a mensagem diz qual arquivo não deu (pelo nome)
  r = await run([card('')], [file('tres.txt', [A, B, C].join('\n')), file('vazio.txt', 'nada aqui')]);
  assert.deepEqual(r.entry.cards.map((c) => c.ta.value), [A, B, C]);
  assert.match(r.msg.text, /^in\.file\.none \{"names":\["vazio.txt"\]\}$/);
  assert.equal(r.msg.bad, true);

  // nenhum arquivo com frase (inclusive leitura que falha): nada muda
  r = await run([card('')], [file('x.txt', 'abc'), { name: 'y.txt', size: 10, text: async () => { throw new Error('leitura'); } }]);
  assert.deepEqual(r.entry.cards.map((c) => c.ta.value), ['']);
  assert.deepEqual(r.calls, []);
  assert.match(r.msg.text, /^in\.file\.none \{"names":\["x.txt","y.txt"\]\}$/);

  // mais de 10 arquivos, arquivo grande demais, ou frases que não cabem: nada entra, com o motivo
  r = await run([card('')], Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, A)));
  assert.deepEqual(r.calls, []);
  assert.match(r.msg.text, /^in\.file\.tooManyFiles \{"n":11,"max":10\}$/);
  r = await run([card('')], [file('grande.txt', A, E.FILE_MAX_BYTES + 1)]);
  assert.deepEqual(r.calls, []);
  assert.match(r.msg.text, /^in\.file\.big \{"name":"grande.txt"\}$/);
  const eleven = Array.from({ length: 11 }, (_, k) => mnemonicOf(bytes(`onze-${k}`, 16)));
  r = await run([card(C), card('')], [file('onze.txt', eleven.join('\n'))]);
  assert.deepEqual(r.entry.cards.map((c) => c.ta.value), [C, ''], 'nada entra');
  assert.deepEqual(r.calls, []);
  assert.match(r.msg.text, /^in\.file\.over \{"found":11,"room":9,"max":10\}$/);
  assert.equal(r.msg.bad, true);
  // lista vazia (janela cancelada): nada
  r = await run([card('')], []);
  assert.deepEqual(r.calls, []);
  assert.equal(r.msg.text, '');
});

test('entrada: botão e campo do arquivo na página (.txt, vários), campo zerado depois de ler, sem log; textos pt e en', () => {
  assert.match(HTML, /<input type="file" id="f-arq" accept="\.txt,text\/plain" multiple hidden>/);
  assert.match(HTML, /<button type="button" class="fr-add" id="b-arq" data-i18n="in\.file">/);
  assert.match(SCRIPT, /\$\('b-arq'\)\.addEventListener\('click', \(\) => \$\('f-arq'\)\.click\(\)\);/);
  assert.match(SCRIPT, /try \{ await importFiles\(files\); \} finally \{ entry\.importing = false; ev\.target\.value = ''; \}/, 'o mesmo arquivo pode ser escolhido de novo');
  assert.match(SCRIPT, /if \(entry\.importing\) return;\s+entry\.importing = true;/, 'uma leitura de cada vez');
  assert.match(fnSource('resetPage'), /resetFrases\(\);[^\n]*\n\s*fileNotice\(null\);/, 'começar de novo apaga a mensagem do arquivo');
  const src = fnSource('importFiles') + fnSource('fileNotice') + fnSource('extractPhrases');
  assert.ok(!/console\.|localStorage|fetch\(|api\(/.test(src), 'o conteúdo do arquivo não sai da página: sem log, sem armazenamento, sem rede');
  assert.equal(I18N.pt['in.file'], 'Enviar arquivo .txt');
  assert.equal(I18N.en['in.file'], 'Upload .txt file');
  assert.equal(tr('pt', 'in.file.added', { n: 1 }), '1 frase do arquivo entrou nos cartões: confira o selo.');
  assert.equal(tr('en', 'in.file.added', { n: 3 }), '3 phrases from the files went into the cards: check the badges.');
  assert.equal(tr('pt', 'in.file.none', { names: ['a.txt'] }), 'Nenhuma frase reconhecida em a.txt: o arquivo precisa ter 12 ou 24 palavras por frase.');
  assert.equal(tr('en', 'in.file.none', { names: ['a.txt', 'b.txt'] }), 'No phrase recognized in a.txt, b.txt: each phrase needs 12 or 24 words.');
  assert.equal(tr('pt', 'in.file.tooManyFiles', { n: 12, max: 10 }), 'São 12 arquivos; o máximo é 10 por vez.');
  assert.equal(tr('pt', 'in.file.over', { found: 11, room: 9, max: 10 }), 'Os arquivos têm 11 frases e só cabem mais 9 nesta rodada (máximo de 10). Nada foi adicionado: tire frases dos arquivos ou faça outra rodada.');
  assert.equal(tr('en', 'in.file.big', { name: 'x.txt' }), 'x.txt is too large to be a phrase file.');
  assert.equal(tr('pt', 'in.file.over', { found: 1, room: 0, max: 10 }), 'O arquivo tem 1 frase e só cabem mais 0 nesta rodada (máximo de 10). Nada foi adicionado: tire frases dos arquivos ou faça outra rodada.');
  assert.equal(tr('pt', 'in.file.over', { found: 2, room: 1, max: 10 }), 'Os arquivos têm 2 frases e só cabe mais 1 nesta rodada (máximo de 10). Nada foi adicionado: tire frases dos arquivos ou faça outra rodada.');
  assert.equal(tr('en', 'in.file.over', { found: 1, room: 1, max: 10 }), 'The file holds 1 phrase and only 1 more fits in this run (maximum 10). Nothing was added: remove phrases from the files or do another run.');
});
