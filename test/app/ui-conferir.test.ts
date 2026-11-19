// Tela das chaves coladas e dos avisos de conferência (spec 2026-11-06 §3, pedido do autor): o cartão aceita frase ou
// chaves (o navegador só conta as linhas; o servidor valida), a conferência das carteiras e a Confirmar lembram a
// pessoa de olhar o que vai ser limpo e queimado, a carteira de chave que parece de uso vem protegida, e erro de
// linha nunca mostra o conteúdo da linha. Chaves daqui são geradas na hora (bytes aleatórios), nunca de alguém.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { publicKeyFromPrivate } from '../../src/core/carteiras/derivation.ts';
import { looksLikeKeys } from '../../src/core/carteiras/keys.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';
import { parseFrases } from '../../src/app/frases.ts';
import { ERROR_TEXT_PT, type ErrorParams } from '../../src/core/limpeza/errors.ts';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.pastedKeys = true;

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
type Lang = 'pt' | 'en';
const tr = (lang: Lang, key: string, p?: unknown) => {
  const v = I18N[lang][key];
  assert.ok(v !== undefined, `falta "${key}" em ${lang}`);
  return typeof v === 'function' ? v(p) : v;
};

// textos fixos do plano (Task 6), copiados como o autor aprovou
const CHECK_ALL = {
  pt: 'Confira cada carteira marcada. Tudo o que estiver marcado será limpo: o SOL vai para o seu destino e as moedas sem valor são queimadas. Proteja qualquer carteira que você ainda usa.',
  en: 'Check every selected wallet. Everything selected will be cleaned: SOL goes to your destination and worthless coins are burned. Protect any wallet you still use.',
};
const CHECK_BURN = {
  pt: 'Antes de enviar, confira o que vai ser queimado e o que vai ser enviado. Queimar não tem volta.',
  en: "Before sending, check what will be burned and what will be sent. Burning can't be undone.",
};

// chave nova (64 bytes: semente + pública, base58), só para o teste
function newKey(): string {
  const seed = randomBytes(32);
  const text = encodeBase58(Buffer.concat([seed, publicKeyFromPrivate(seed)]));
  seed.fill(0);
  return text;
}

const ENTRADA = (() => {
  const start = HTML.indexOf('// entrada:inicio');
  const end = HTML.indexOf('// entrada:fim');
  return HTML.slice(start, end);
})();
type Check = { code: string; params: Record<string, unknown> };
const E = new Function(`${ENTRADA}; return { checkPhrase, badgeKind, canAnalyze, submitState, markDuplicates, looksLikeKeys };`)() as {
  checkPhrase: (t: string, w: Map<string, number> | null, d: unknown) => Promise<Check>;
  badgeKind: (c: Check) => string;
  canAnalyze: (c: Check[]) => boolean;
  submitState: (c: Check[]) => { allowed: boolean };
  markDuplicates: (items: { app: string; text: string; check: Check }[]) => Check[];
  looksLikeKeys: (t: string) => boolean;
};

// ---------- elementos falsos: o bastante para desenhar um cartão e ler o texto e as classes ----------
type Node = { tag: string; attrs: Record<string, unknown>; kids: Node[]; text: string };
function el(tag: string, attrs: Record<string, unknown> | null, ...kids: unknown[]): Node {
  const flat = kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false);
  const nodes = flat.map((k) => (typeof k === 'object' ? (k as Node) : { tag: '#text', attrs: {}, kids: [], text: String(k) }));
  return { tag, attrs: attrs ?? {}, kids: nodes, text: '' };
}
const textOf = (n: Node): string => (n.tag === '#text' ? n.text : n.kids.map(textOf).join(''));
const all = (n: Node): Node[] => [n, ...n.kids.flatMap(all)];
const hasClass = (n: Node, c: string) => String(n.attrs.class ?? '').split(' ').includes(c);

const acc = (index: number, label: string, extra: Record<string, unknown> = {}) => ({ index, label, address: `Addr${index}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`, hasHistory: true, lamports: 0, isMain: false, warnings: [] as string[], ...extra });
const FRASES = {
  phantom: { n: 1, app: 'phantom', status: 'pronta', wallets: [{ index: 1 }], review: { accounts: [acc(0, 'Conta 1', { isMain: true }), acc(1, 'Conta 2'), acc(2, 'Conta 3')], warnings: [] } },
  trust: { n: 2, app: 'trust', status: 'pronta', wallets: [{ index: 1 }], review: { accounts: [acc(0, 'Conta 1', { isMain: true }), acc(1, 'Conta 2')], warnings: [] } },
  chaves: { n: 3, app: 'chaves', status: 'pronta', main: null, wallets: [{ index: 0 }], review: { accounts: [acc(0, 'Chave 1'), acc(1, 'Chave 2', { warnings: ['tem 0,0800 SOL solto: parece carteira de uso, não burner'] }), acc(2, 'Chave 3')], warnings: [] } },
};
type Frase = (typeof FRASES)[keyof typeof FRASES];

// o cartão de conferência desenhado de verdade (reviewCard da página), com peças falsas no lugar do DOM
function drawReview(f: Frase | Record<string, unknown>, lang: Lang): Node {
  const fakes = {
    LANG: lang,
    I18N,
    el,
    state: { frases: Object.values(FRASES) },
    ui: { protect: new Map(), reviewTyped: new Map(), cardErrors: {} },
    fraseTag: () => '',
    short: (a: string) => a.slice(0, 4),
    accBalance: () => '0 SOL',
    toggleProtect: () => {},
    confirmReview: () => {},
    syncReviews: () => new Set(),
  };
  const src = [
    fnSource('t'),
    SCRIPT.match(/const fraseOf = .*/)![0],
    SCRIPT.match(/const isPhantom = .*/)![0],
    fnSource('walletName'),
    SCRIPT.match(/const defaultProtect = .*/)![0],
    SCRIPT.match(/const reviewKey = .*/)?.[0] ?? '',
    SCRIPT.match(/const LPS = .*/)![0],
    SCRIPT.match(/const loc = .*/)![0],
    SCRIPT.match(/const dec = .*/)![0],
    fnSource('sol'),
    SCRIPT.match(/const alertTexts = .*/)![0],
    fnSource('reviewCard'),
  ].join('\n');
  return new Function(...Object.keys(fakes), `${src}\nreturn reviewCard;`)(...Object.values(fakes))(f) as Node;
}

test('ui: aviso de conferência nas duas telas e nos dois idiomas', () => {
  for (const lang of ['pt', 'en'] as const) {
    assert.equal(tr(lang, 'rev.checkAll'), CHECK_ALL[lang], `rev.checkAll ${lang}`);
    assert.equal(tr(lang, 'conf.checkBurn'), CHECK_BURN[lang], `conf.checkBurn ${lang}`);
  }
  assert.match(fnSource('reviewCard'), /t\('rev\.checkAll'\)/);

  // conferência das carteiras (Phantom, Trust e chaves): aviso amarelo, visível (fora de "detalhes"), no topo do cartão
  // e acima do campo da contagem
  for (const f of Object.values(FRASES)) {
    for (const lang of ['pt', 'en'] as const) {
      const card = drawReview(f, lang);
      const nodes = all(card);
      const notice = nodes.find((n) => hasClass(n, 'notice') && textOf(n) === CHECK_ALL[lang]);
      assert.ok(notice, `${f.app} ${lang}: aviso no cartão`);
      assert.ok(!hasClass(notice!, 'danger'), 'amarelo, não vermelho');
      assert.ok(!nodes.some((n) => (n.tag === 'details' || n.tag === 'summary') && all(n).includes(notice!)), 'nunca dentro de "detalhes"');
      const order = nodes.filter((n) => n === notice || hasClass(n, 'rev-confirm') || n.tag === 'label');
      assert.equal(order[0], notice, `${f.app} ${lang}: aviso acima da contagem`);
      assert.ok(card.kids.indexOf(notice!) >= 0 && card.kids.indexOf(notice!) <= 1, 'no topo do cartão (logo depois do título)');
    }
  }

  // Confirmar: em #c-box, acima do botão de enviar, para toda frase (texto fixo da página, sem condição de app)
  const box = HTML.slice(HTML.indexOf('id="c-box"'), HTML.indexOf('id="b-executar"'));
  assert.match(box, /<div class="notice" id="c-checkburn"><p data-i18n="conf\.checkBurn">Antes de enviar, confira o que vai ser queimado e o que vai ser enviado\. Queimar não tem volta\.<\/p><\/div>/);
  assert.doesNotMatch(box, /<details/, 'fora de "detalhes"');
  assert.doesNotMatch(SCRIPT, /c-checkburn/, 'nenhum código esconde o aviso (vale para Solflare, Phantom, Trust e chaves)');
  // o mesmo desenho e a mesma regra de tradução das outras frases fixas da página
  assert.match(SCRIPT, /for \(const e of document\.querySelectorAll\('\[data-i18n\]'\)\) e\.textContent = t\(e\.dataset\.i18n\);/);
});

test('ui: cartão de conferência com título e explicação de cada app (Phantom, Trust, chaves), sem "Conta 1" nas chaves', () => {
  const title = (f: Frase, lang: Lang) => textOf(drawReview(f, lang).kids[0]);
  assert.equal(title(FRASES.phantom, 'pt'), 'Confira as contas da Phantom', 'roteiros de tela antigos procuram este título');
  assert.equal(title(FRASES.phantom, 'en'), 'Review your Phantom accounts');
  assert.equal(title(FRASES.trust, 'pt'), 'Confira as contas da Trust ou da Phantom antiga');
  assert.equal(title(FRASES.trust, 'en'), 'Review your Trust or older Phantom accounts');
  assert.equal(title(FRASES.chaves, 'pt'), 'Confira as carteiras das chaves');
  assert.equal(title(FRASES.chaves, 'en'), 'Review the wallets of your keys');
  for (const lang of ['pt', 'en'] as const) {
    const keys = textOf(drawReview(FRASES.chaves, lang));
    assert.doesNotMatch(keys, /Conta 1|Account 1|Principal|Main\b|Phantom/, `chaves ${lang}: sem principal e sem Phantom`);
    assert.match(keys, lang === 'pt' ? /Chave 1.*Chave 2.*Chave 3/ : /Key 1.*Key 2.*Key 3/);
    assert.match(keys, lang === 'pt' ? /carteiras serão limpas/ : /wallets will be cleaned/);
    assert.doesNotMatch(textOf(drawReview(FRASES.trust, lang)), lang === 'pt' ? /contas da Phantom/ : /your Phantom accounts/);
  }
  // contagem do cartão e "Não bate" falam em carteiras nas chaves
  assert.equal(tr('pt', 'rev.countKeys', 2), 'carteiras serão limpas');
  assert.equal(tr('pt', 'rev.countKeys', 1), 'carteira será limpa');
  assert.equal(tr('en', 'rev.countKeys', 0), 'No wallet will be cleaned: all are protected.');
  assert.equal(tr('pt', 'rev.wrongCountKeys', 2), 'Não bate: serão limpas 2 carteiras. Digite 2 para confirmar, ou mude as carteiras protegidas.');
  assert.match(fnSource('confirmReview'), /reviewKey\('rev\.wrongCount', f\.app\)/);
  assert.match(fnSource('renderReviewCount'), /t\(f\?\.app === 'chaves' \? 'rev\.countKeys' : 'rev\.count', targets\.length\)/);
  // Confirmar e detalhes: o nome de cada app, não "Phantom" para todos
  assert.equal(tr('pt', 'conf.phantomTrust'), 'Contas da Trust ou da Phantom antiga:');
  assert.equal(tr('en', 'conf.phantomKeys'), 'Wallets of your keys:');
  assert.match(fnSource('renderConfirm'), /t\(reviewKey\('conf\.phantom', f\.app\)\)/);
  assert.match(fnSource('renderConfirm'), /t\(needsReview\(f\.app\) \? reviewKey\('w\.titlePhantom', f\.app\) : 'w\.title'\)/);
  assert.match(fnSource('renderConfirm'), /t\(needsReview\(f\.app\) \? reviewKey\('w\.ledePhantom', f\.app\) : 'w\.lede'\)/);
  const reviewKey = new Function(`${SCRIPT.match(/const reviewKey = .*/)![0]}\nreturn reviewKey;`)() as (k: string, a: string) => string;
  // Trust troca só o que diz "Phantom" (título, Confirmar, detalhes); chaves trocam tudo o que fala em "contas" e "Conta 1"
  const own = { trust: ['rev.title', 'conf.phantom', 'w.ledePhantom'], chaves: ['rev.title', 'rev.lede', 'rev.type', 'rev.wrongCount', 'conf.phantom', 'w.titlePhantom', 'w.ledePhantom'] };
  for (const base of own.chaves) {
    assert.equal(reviewKey(base, 'phantom'), base);
    for (const app of ['trust', 'chaves'] as const) {
      const k = reviewKey(base, app);
      if (!own[app].includes(base)) { assert.equal(k, base, `${app} usa o texto da Phantom em ${base}`); continue; }
      assert.ok(k in I18N.pt && k in I18N.en, `${k} em pt e en`);
      for (const lang of ['pt', 'en'] as const) assert.notEqual(tr(lang, k, 2), tr(lang, base, 2), `${k} ${lang} não repete o texto da Phantom`);
    }
  }
});

test('ui: lista de chaves não vira erro de frase', async () => {
  const keys = [newKey(), newKey(), newKey()];
  const typed = [
    keys.join('\n'),
    keys.map((k) => ` "${k}",\r`).join('\n'), // do jeito que a área de transferência do Windows entrega
    `${keys[0]}\n\n${keys[1]}\n\n${keys[2]}\n`, // linha vazia entre as chaves
  ];
  for (const text of typed) {
    const c = await E.checkPhrase(text, null, null);
    assert.deepEqual(c, { code: 'keys', params: { count: 3 } });
    assert.equal(E.badgeKind(c), 'neutral', 'o navegador só conta: quem valida é o app');
    assert.equal(E.canAnalyze([c]), true);
    assert.equal(E.submitState([c]).allowed, true);
  }
  // uma chave só, e a mistura (o app aponta a linha ruim depois, sem eco)
  assert.deepEqual(await E.checkPhrase(keys[0], null, null), { code: 'keys', params: { count: 1 } });
  assert.deepEqual(await E.checkPhrase(`${keys[0]}\nlegal winner thank year wave sausage worth useful legal winner thank yellow`, null, null), { code: 'keys', params: { count: 2 } });
  // frase continua frase: numa linha, ou uma palavra por linha
  const phrase = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  assert.equal((await E.checkPhrase(phrase, null, null)).code, 'unchecked');
  assert.equal((await E.checkPhrase(phrase.replace(/ /g, '\n'), null, null)).code, 'unchecked');
  // a mesma regra do app (src/core/carteiras/keys.ts looksLikeKeys): página e servidor decidem igual
  const samples = [...typed, phrase, phrase.replace(/ /g, '\n'), '', '   ', '[1, 2, 3]', 'abc', `x ${keys[0]}`, '0x' + 'ab'.repeat(32), '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN'];
  for (const s of samples) assert.equal(E.looksLikeKeys(s), looksLikeKeys(s), JSON.stringify(s.slice(0, 20)));
  // selo e textos nos dois idiomas
  assert.equal(tr('pt', 'in.st.keys', { count: 3 }), '3 chaves');
  assert.equal(tr('en', 'in.st.keys', { count: 3 }), '3 keys');
  assert.equal(tr('pt', 'in.st.keys', { count: 1 }), '1 chave');
  assert.equal(tr('en', 'in.st.keys', { count: 1 }), '1 key');
  // repetida entre cartões é com o app (key-duplicate com "of"): o navegador não compara chaves
  const dup = E.markDuplicates([{ app: 'auto', text: keys[0], check: { code: 'keys', params: { count: 1 } } }, { app: 'auto', text: keys[0], check: { code: 'keys', params: { count: 1 } } }]);
  assert.deepEqual(dup.map((c) => c.code), ['keys', 'keys']);
  // rótulo do campo: na 1.0 as chaves coladas estão desligadas e o rótulo só fala de frases (ui-i18n.test.ts, "tela 1.0")
});

test('ui: chaves suspeitas vêm protegidas', () => {
  const lineOf = (name: string) => SCRIPT.match(new RegExp(`const ${name} = .*`))![0];
  const ui = { protect: new Map<number, Set<number>>(), reviewTyped: new Map<number, string>(), reviewed: new Set<number>(), reviewFp: new Map<number, string | null>() };
  const f = FRASES.chaves;
  const fns = new Function('ui', 'state', `${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('defaultProtect')}\n${fnSource('forgetReview')}\n${fnSource('syncReviews')}\n${fnSource('phantomPayload')}\nreturn { defaultProtect, phantomPayload };`)(ui, { frases: [f] }) as {
    defaultProtect: (f: unknown) => Set<number>;
    phantomPayload: () => Record<number, { protegidas: number[]; contasConfirmadas: number }>;
  };
  assert.deepEqual([...fns.defaultProtect(f)], [1], 'a Chave 2 (alerta de carteira de uso) já vem protegida; as outras, marcadas');
  fns.phantomPayload(); // a página guarda a impressão da lista ao desenhar o cartão
  ui.reviewTyped.set(3, '2');
  assert.deepEqual(fns.phantomPayload(), { 3: { protegidas: [2], contasConfirmadas: 2 } }, 'sem a pessoa tocar, a suspeita vai em "protegidas" (número como na tela)');
  // sem alerta: todas marcadas para limpar
  const clean = { ...f, review: { ...f.review, accounts: f.review.accounts.map((a) => ({ ...a, warnings: [] })) } };
  assert.deepEqual([...fns.defaultProtect(clean)], []);
  // a pessoa desmarca: a escolha dela vale
  ui.protect.set(3, new Set());
  assert.deepEqual(fns.phantomPayload()[3].protegidas, []);
  // e o cartão desenhado mostra a suspeita como "Protegida" desde o começo
  const card = drawReview(f, 'pt');
  const rows = all(card).filter((n) => n.tag === 'li');
  assert.deepEqual(rows.map((r) => hasClass(r, 'kept')), [false, true, false]);
  assert.deepEqual(rows.map((r) => all(r).find((n) => n.tag === 'input')?.attrs.checked), [false, true, false]);
});

// revisão independente de 08/11/2026: proteção, "conferido" e contagem eram guardados pelo número do cartão e só zerados
// em "voltar" e "limpar outra frase". Cartão refeito, ou irmã que reaproveita o número com outro app, usava a
// conferência da lista antiga (podia pular a conferência ou mandar a proteção e a contagem velhas).
test('ui: lista nova no mesmo número zera a conferência e volta a proteção padrão', () => {
  const lineOf = (name: string) => SCRIPT.match(new RegExp(`const ${name} = .*`))![0];
  const ui = { protect: new Map<number, Set<number>>(), reviewTyped: new Map<number, string>(), reviewed: new Set<number>(), reviewFp: new Map<number, string | null>() };
  const fns = new Function('ui', `let state = null;\n${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('defaultProtect')}\n${fnSource('forgetReview')}\n${fnSource('syncReviews')}\n${fnSource('phantomPayload')}\nreturn { setState: (s) => { state = s; }, syncReviews, forgetReview, phantomPayload };`)(ui) as {
    setState: (s: unknown) => void;
    syncReviews: (s: unknown) => Set<number>;
    forgetReview: (n: number) => void;
    phantomPayload: () => Record<number, { protegidas: number[]; contasConfirmadas: number; conferida?: string }>;
  };
  const keys = { ...FRASES.chaves, reviewFp: 'lista-A' };
  fns.setState({ frases: [keys] });
  assert.deepEqual([...fns.syncReviews({ frases: [keys] })], [], 'primeira vez: só guarda a impressão');
  // a pessoa desprotege a suspeita, digita 3 e confirma
  ui.protect.set(3, new Set());
  ui.reviewTyped.set(3, '3');
  ui.reviewed.add(3);
  assert.deepEqual(fns.phantomPayload(), { 3: { protegidas: [], contasConfirmadas: 3, conferida: 'lista-A' } }, 'a impressão da lista conferida vai junto');
  // mesma lista de novo (outro evento de estado): nada muda
  assert.deepEqual([...fns.syncReviews({ frases: [keys] })], []);
  assert.ok(ui.reviewed.has(3));
  // cartão refeito com outras chaves (impressão nova): tudo do número 3 volta ao começo, com a suspeita protegida
  const redone = { ...keys, reviewFp: 'lista-B' };
  fns.setState({ frases: [redone] });
  assert.deepEqual(fns.phantomPayload(), { 3: { protegidas: [2], contasConfirmadas: 0 } }, 'proteção padrão, sem contagem nem impressão');
  assert.ok(!ui.reviewed.has(3), 'a conferência tem que ser feita de novo');
  assert.equal(ui.reviewFp.get(3), 'lista-B');
  // irmã que reaproveita o número com outro app (Phantom no lugar das chaves): idem
  ui.protect.set(3, new Set());
  ui.reviewed.add(3);
  ui.reviewTyped.set(3, '3');
  const sister = { ...FRASES.phantom, n: 3, reviewFp: 'lista-C' };
  assert.deepEqual([...fns.syncReviews({ frases: [sister] })], [3]);
  assert.deepEqual([ui.protect.has(3), ui.reviewed.has(3), ui.reviewTyped.has(3)], [false, false, false]);
  // cartão em análise de novo (sem lista): esquecido
  ui.reviewed.add(3);
  assert.deepEqual([...fns.syncReviews({ frases: [{ ...sister, review: null, reviewFp: null }] })], [3]);
  assert.ok(!ui.reviewed.has(3) && !ui.reviewFp.has(3));
  // quem chama: refazer o cartão esquece já; desenhar, confirmar, proteger, a análise e o pedido do plano sincronizam
  assert.match(fnSource('sendFix'), /forgetReview\(f\.n\);/);
  for (const name of ['reviewCard', 'confirmReview', 'toggleProtect', 'afterAnalysis', 'phantomPayload']) assert.match(fnSource(name), /syncReviews\(state\)/, name);
  // o app recusou por lista mudada: o cartão volta para a conferência (sem montar o plano de novo sozinho)
  assert.match(fnSource('runPlan'), /e\.codigo === 'review-changed'[\s\S]*?forgetReview\(Number\(e\.params\?\.frase\)\);[\s\S]*?afterAnalysis\(\);/);
  for (const lang of ['pt', 'en'] as const) for (const part of ['what', 'app', 'you']) assert.ok(tr(lang, `err.review-changed.${part}`, { frase: 2 }).length > 0);
  assert.equal(tr('pt', 'err.review-changed.what', { frase: 2 }), ERROR_TEXT_PT['review-changed'].what({ frase: 2 }), 'página e catálogo dizem o mesmo');
});

test('ui: erro de linha não mostra conteúdo', () => {
  // o app recusa o cartão e diz só a linha; a tela traduz só com a linha (e "of"/"max")
  const k1 = newKey();
  const bad = 'cavalo azul segredo ' + 'x'.repeat(40);
  const cases: Array<{ text: string; code: string }> = [
    { text: `${k1}\n${bad}`, code: 'key-unknown' },
    { text: `${k1}\n${k1.slice(0, -1)}${k1.endsWith('2') ? '3' : '2'}`, code: 'key-mismatch' },
    { text: `${k1}\n5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN`, code: 'key-looks-address' },
    { text: `${k1}\n${k1}`, code: 'key-duplicate' },
  ];
  for (const c of cases) {
    const [r] = parseFrases([{ texto: c.text, carteira: 'auto' }]);
    assert.equal(r.error?.code, c.code, c.code);
    assert.deepEqual(r.error?.params, { line: 2 });
    for (const lang of ['pt', 'en'] as const) {
      const shown = ['what', 'app', 'you'].map((part) => tr(lang, `err.${c.code}.${part}`, r.error!.params)).join(' ');
      assert.match(shown, lang === 'pt' ? /linha 2/ : /line 2/i);
      for (const line of c.text.split('\n')) for (let i = 0; i + 8 <= line.length; i += 4) assert.ok(!shown.includes(line.slice(i, i + 8)), `${c.code} ${lang}: trecho da linha na tela`);
    }
  }
  // com parâmetros a mais (nunca deveriam vir), a tela usa só line, of e max
  const extra = { line: 3, of: 2, max: 200, texto: 'SEGREDO-NAO-APARECE', key: 'SEGREDO-NAO-APARECE' };
  for (const code of ['key-unknown', 'key-mismatch', 'key-looks-address', 'key-duplicate', 'key-is-main', 'too-many-keys']) {
    for (const lang of ['pt', 'en'] as const) {
      for (const part of ['what', 'app', 'you']) assert.doesNotMatch(tr(lang, `err.${code}.${part}`, extra), /SEGREDO/, `${code}.${part} ${lang}`);
    }
  }
  assert.equal(tr('pt', 'err.key-is-main.what', { line: 3, of: 2 }), 'A chave da linha 3 é da conta principal da frase nº 2.');
  assert.equal(tr('en', 'err.too-many-keys.what', { max: 200 }), 'The card is over the limit of 200 keys.');
  // o cartão da entrada: selo de chaves sem texto de erro; o erro do app aparece pelo código do catálogo
  assert.match(fnSource('paintCard'), /setText\(c\.err, kind === 'bad' \? t\(`err\.\$\{check\.code\}\.what`, check\.params\) :/);
});

test('ui: carteira de chave se chama "Chave N" (inglês "Key N"), sem "temporária" na frente; aviso da chave que já está numa frase', () => {
  const walletText = (lang: Lang) => new Function('LANG', 't', `${fnSource('walletText')}\nreturn walletText;`)(lang, (k: string, p: unknown) => tr(lang, k, p)) as (l: string, a?: string) => string;
  assert.equal(walletText('pt')('Chave 2', 'chaves'), 'Chave 2');
  assert.equal(walletText('en')('Chave 2', 'chaves'), 'Key 2');
  assert.equal(walletText('en')('Conta 4', 'trust'), 'Account 4');
  const labelWho = (lang: Lang) => new Function('LANG', 't', `${SCRIPT.match(/const labelWho = .*/)![0]}\nreturn labelWho;`)(lang, (k: string, p: unknown) => tr(lang, k, p)) as (l: string, a?: string) => string;
  assert.equal(labelWho('pt')('Chave 2', 'chaves'), 'Chave 2');
  assert.equal(labelWho('en')('Chave 2', 'chaves'), 'Key 2');
  assert.equal(labelWho('pt')('N=3', 'solflare'), 'temporária N=3');
  const names = (lang: Lang) => new Function('LANG', 't', 'I18N', 'state', [fnSource('t'), SCRIPT.match(/const fraseOf = .*/)![0], SCRIPT.match(/const isPhantom = .*/)![0], fnSource('walletName'), SCRIPT.match(/const who = .*/)![0], 'return { walletName, who };'].join('\n'))(lang, null, I18N, { frases: [{ n: 3, app: 'chaves', wallets: [] }, { n: 2, app: 'trust', wallets: [] }] }) as { walletName: (i: number, n: number) => string; who: (i: number, n: number) => string };
  assert.equal(names('pt').who(1, 3), 'Chave 2', 'sem rótulo do app, o nome vem da posição');
  assert.equal(names('en').who(1, 3), 'Key 2');
  assert.equal(names('en').who(1, 2), 'Account 2');
  // linha da análise: "Chaves privadas · 3 carteiras"
  const BLOCK = HTML.slice(HTML.indexOf('// analise:inicio'), HTML.indexOf('// analise:fim'));
  const A = new Function(`${BLOCK}; return { fraseRowView, detectionNote };`)() as { fraseRowView: (f: unknown, p: unknown) => { app: string; appName: { key: string; params: unknown }; head: { key: string; params: Record<string, unknown> }; note: { key: string; params: unknown } | null }; detectionNote: (f: unknown) => { key: string; params: unknown } | null };
  const row = A.fraseRowView({ n: 3, app: 'chaves', auto: false, status: 'pronta', discovery: { found: 3 }, keysOverlap: { count: 1, of: 1 } }, null);
  assert.equal(row.app, 'chaves');
  const keysWord = fnSource('fraseRow').match(/keys: ([^,]*),/)![1];
  assert.equal(keysWord, "r.app === 'chaves'");
  const head = (lang: Lang, found = 3) => tr(lang, row.head.key, { ...row.head.params, found, app: tr(lang, row.appName.key, row.appName.params), keys: true, phantom: false });
  assert.equal(head('pt'), 'Chaves privadas · 3 carteiras');
  assert.equal(head('en'), 'Private keys · 3 wallets');
  assert.equal(head('pt', 1), 'Chaves privadas · 1 carteira');
  assert.equal(tr('pt', row.note!.key, row.note!.params), '1 chave já está na frase 1: entra uma vez só, pela frase');
  assert.equal(tr('en', 'app.keysOverlap', { count: 2, of: 1 }), '2 keys are already in phrase 1: they go in once, through the phrase');
  assert.equal(tr('pt', 'app.keysOverlap', { count: 2, of: 4 }), '2 chaves já estão na frase 4: entram uma vez só, pela frase');
  // dado fora do formato não vira texto
  for (const bad of [{ count: 'x', of: 1 }, { count: 0, of: 1 }, { count: 1 }, null]) assert.equal(A.detectionNote({ n: 3, app: 'chaves', keysOverlap: bad }), null, JSON.stringify(bad));
});

test('ui: depósito para as taxas num cartão de chaves fica natural (app manda "qualquer uma")', () => {
  const p: ErrorParams = { walletIndex: 1, wallet: 'W', sendSol: 0.01, walletName: 'Chave 2', appName: 'qualquer uma' };
  const pt = (I18N.pt['err.no-fee-sol.you'] as (p: ErrorParams) => string)(p);
  const en = (I18N.en['err.no-fee-sol.you'] as (p: ErrorParams) => string)(p);
  assert.equal(pt, 'Mande 0.01 SOL de qualquer carteira sua para a Chave 2: W. Esse valor volta para o destino no final da limpeza.');
  assert.equal(pt, ERROR_TEXT_PT['no-fee-sol'].you(p), 'o mesmo texto do núcleo');
  assert.equal(en, 'Send 0.01 SOL from any wallet of yours to Key 2: W. This amount goes back to the destination at the end of the cleanup.');
  // Trust: "Account N" em inglês, como a Phantom
  const trust = (I18N.en['err.no-fee-sol.you'] as (p: ErrorParams) => string)({ walletIndex: 3, wallet: 'W', sendSol: 0.01, walletName: 'Conta 4', appName: 'Trust' });
  assert.match(trust, /from your Trust to Account 4/);
});

// achado do cenário "chaves" do cdp-fluxo (08/11/2026): Confirmar sem token indo junto mostrava "nullnull" embaixo do
// total, porque replaceChildren (diferente de el) escreve null como texto
test('ui: Confirmar sem token indo junto não escreve "null" no recibo', () => {
  const src = fnSource('renderConfirm');
  const at = src.indexOf("$('c-encontrado').replaceChildren(...[");
  assert.ok(at > 0, 'recibo da Confirmar montado numa lista filtrada');
  const end = src.indexOf('].filter(Boolean));', at);
  assert.ok(end > at && src.slice(at, end).includes("tokensSent.length ? el('p'"), 'os itens opcionais (tokens, taxa de rede, taxa do app) ficam dentro do filtro');
});

// Alerta de carteira que parece de uso: o servidor manda código e números (accounts.ts), a página escreve no idioma dela.
// Antes vinha só o texto em português do servidor, também na tela em inglês (pendência da Task 6).
test('ui: alertas da conferência no idioma da página (código do servidor), e o texto antigo quando não há código', async () => {
  const { reviewPhantomAccounts } = await import('../../src/core/carteiras/accounts.ts');
  const scan = (index: number, lamports: number) => ({ index, address: `A${index}`, lamports, tokens: [], fees: null, errors: [] });
  const review = reviewPhantomAccounts(
    [{ index: 0, address: 'A0', hasHistory: false }, { index: 1, address: 'A1', hasHistory: true }],
    [scan(0, 0), scan(1, 80_000_000)], new Map(), new Map(), { mainIndex: 0, label: (i) => `Conta ${i + 1}` });
  assert.deepEqual(review.accounts[1]!.alerts, [{ code: 'loose-sol', params: { lamports: 80_000_000 } }]);
  assert.deepEqual(review.alerts, [{ code: 'main-unused' }]);
  assert.equal(review.accounts[1]!.warnings.length, review.accounts[1]!.alerts.length, 'um código para cada texto do terminal');
  const f = { n: 1, app: 'phantom', status: 'pronta', wallets: [{ index: 1 }], review };
  const pt = textOf(drawReview(f, 'pt'));
  const en = textOf(drawReview(f, 'en'));
  assert.match(pt, /tem 0,0800 SOL solto: parece carteira de uso, não burner/);
  assert.match(pt, /A Conta 1 nunca foi usada/);
  assert.match(en, /has 0\.0800 loose SOL: looks like a wallet in use, not a burner/);
  assert.match(en, /Account 1 was never used, but other accounts were/);
  assert.doesNotMatch(en, /parece carteira de uso|nunca foi usada|SOL solto/, 'nada em português na tela em inglês');
  // o texto em português de cada alerta é o mesmo do terminal (warnings)
  assert.ok(pt.includes(review.accounts[1]!.warnings[0]!) && pt.includes(review.warnings[0]!));
  assert.equal(tr('pt', 'rev.alert.valuable-tokens', { count: 2 }), 'tem 2 token(s) de valor: parece carteira de uso, não burner');
  assert.equal(tr('en', 'rev.alert.valuable-tokens', { count: 2 }), 'has 2 token(s) with value: looks like a wallet in use, not a burner');
  // estado sem código (servidor anterior): mostra o texto que veio
  assert.match(textOf(drawReview(FRASES.chaves, 'en')), /tem 0,0800 SOL solto/);
});
