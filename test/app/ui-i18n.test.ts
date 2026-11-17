import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { recommend, VALUABLE_USD, type RecommendationCode } from '../../src/core/limpeza/recommend.ts';
import type { TokenCategory } from '../../src/core/limpeza/prices.ts';
import type { StepResult } from '../../src/core/limpeza/executor.ts';
import type { Step } from '../../src/core/limpeza/plan.ts';
import { ASSETS, ICON_SIZES, searchLimits, stepView } from '../../src/app/server.ts';
import { ERROR_CODES, ERROR_TEXT_PT, LOST_PT, type ErrorParams } from '../../src/core/limpeza/errors.ts';

import { HTML, SCRIPT, closingBrace, fnSource } from './ui-source.ts';
import { FEATURES } from '../../src/core/features.ts';

// o dicionário é um objeto literal entre dois marcadores: avaliado sozinho, sem o resto da página
type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  assert.ok(start > 0 && end > start, 'marcadores do dicionário');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();

const CATEGORIES: TokenCategory[] = ['estável', 'cripto conhecida', 'memecoin Pump.fun', 'outro', 'desconhecido'];
const STATUSES: StepResult['status'][] = ['simulado', 'enviado', 'falhou', 'cancelado', 'nada a fazer', 'desconhecido'];
const STEP_KINDS: Step['kind'][] = ['claim-curve', 'claim-amm', 'claim-shared', 'claim-cashback', 'claim-dbc', 'claim-launchlab', 'tokens', 'sweep-sol', 'fund', 'gather'];

test('idioma: português e inglês têm as mesmas chaves, do mesmo tipo', () => {
  assert.deepEqual(Object.keys(I18N.en).sort(), Object.keys(I18N.pt).sort());
  for (const k of Object.keys(I18N.pt)) assert.equal(typeof I18N.en[k], typeof I18N.pt[k], k);
});

// num objeto literal a última chave repetida vence em silêncio: a primeira some (caso conf.tokensTitle, 0.1.7)
test('idioma: nenhuma chave repetida no dicionário (pt e en)', () => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  const src = HTML.slice(start, end);
  const enAt = src.search(/\n\s*en: \{/);
  assert.ok(enAt > 0, 'bloco en');
  for (const [lang, part] of [['pt', src.slice(0, enAt)], ['en', src.slice(enAt)]] as const) {
    const keys = [...part.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
    assert.ok(keys.length > 100, `${lang}: achou só ${keys.length} chaves`);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dup, [], `${lang}: chave repetida`);
  }
});

// taxa do app: 11% uma vez sobre todo SOL recuperado; isento só o depósito (c91e728). O SOL juntado e o emprestado
// são SOL esquecido das frases: o texto não pode prometer "sem taxa" (o cartão do Juntar prometia, achado na 0.1.7)
test('idioma: Juntar e empréstimo dizem que o valor paga a taxa do app uma vez, nunca "sem taxa"', () => {
  const p = { sol: '0,01', from: 2, fromFrase: 1, fromName: 'Temporária 1', toName: 'Temporária 2' };
  for (const k of ['gather.text', 'fund.text']) {
    const pt = (I18N.pt[k] as (x: unknown) => string)(p);
    const en = (I18N.en[k] as (x: unknown) => string)(p);
    assert.match(pt, /paga a taxa do app uma vez/, `${k} pt`);
    assert.match(en, /pays the app fee once/, `${k} en`);
    assert.doesNotMatch(pt, /sem taxa do app/, `${k} pt`);
    assert.doesNotMatch(en, /no app fee/, `${k} en`);
  }
});

test('idioma: todo texto usado na página existe no dicionário', () => {
  const used = new Set<string>();
  for (const m of HTML.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) used.add(m[1]);
  for (const m of SCRIPT.matchAll(/\bt\('([^']+)'/g)) used.add(m[1]);
  for (const d of ['transfer', 'burn', 'keep']) used.add(`dec.${d}`);
  for (const s of STATUSES) used.add(`st.${s}`);
  for (const k of STEP_KINDS) used.add(`stepd.${k}`);
  assert.ok(used.size > 100, `achou só ${used.size} usos: o padrão de busca quebrou?`);
  for (const k of used) assert.ok(k in I18N.pt && k in I18N.en, `falta "${k}"`);
});

test('idioma: motivos em português são os mesmos de recommend.ts (uma regra, dois lugares)', () => {
  const cases: [Parameters<typeof recommend>[0], TokenCategory, number | null][] = [
    ['nft', 'estável', 100],
    ['fungible', 'estável', 0.5],
    ['fungible', 'cripto conhecida', null],
    ['fungible', 'outro', 5],
    ['fungible', 'memecoin Pump.fun', null],
    ['fungible', 'memecoin Pump.fun', 0.2],
    ['fungible', 'desconhecido', 0.1],
  ];
  const seen = new Set<RecommendationCode>();
  for (const [kind, category, usd] of cases) {
    const rec = recommend(kind, category, usd);
    seen.add(rec.code);
    const pt = I18N.pt[`why.${rec.code}`] as (c: string) => string;
    assert.equal(pt(category), rec.why, `${kind}/${category}/${usd}`);
    assert.equal(typeof I18N.en[`why.${rec.code}`], 'function');
  }
  assert.deepEqual([...seen].sort(), Object.keys(I18N.pt).filter((k) => k.startsWith('why.')).map((k) => k.slice(4)).sort(), 'todo motivo coberto');
  assert.match((I18N.en['why.valuable'] as () => string)(), new RegExp(`US\\$ ${VALUABLE_USD} `));
});

test('idioma: toda categoria de token tem nome em inglês', () => {
  const cat = I18N.en.cat as (c: string) => string;
  for (const c of CATEGORIES) assert.notEqual(cat(c), c, c);
});

test('idioma: passo descrito em inglês com as contagens do plano', () => {
  const v = stepView({
    kind: 'tokens',
    walletIndex: 7,
    wallet: 'W',
    actions: [
      { action: 'close', account: 'a', mint: 'm', program: 'p', amount: 0n, decimals: 0, rentLamports: 1 },
      { action: 'close', account: 'b', mint: 'm', program: 'p', amount: 0n, decimals: 0, rentLamports: 1 },
      { action: 'burn-close', account: 'c', mint: 'm', program: 'p', amount: 5n, decimals: 0, rentLamports: 1 },
    ],
  });
  assert.deepEqual(v, { kind: 'tokens', walletIndex: 7, estimateLamports: null, bps: null, venue: null, close: 2, burnClose: 1, transferClose: 0, isFeePayer: false, lamports: null, all: false, toFrase: null, sweepOnly: false, sweeps: 0, pools: 0 });
  const describe = I18N.en['stepd.tokens'] as (p: unknown) => string;
  assert.equal(describe({ n: v.walletIndex, close: v.close, burnClose: v.burnClose, transferClose: v.transferClose }), 'N=7: token accounts: close 2, burn and close 1');

  assert.equal(stepView({ kind: 'claim-curve', walletIndex: 1, wallet: 'W', estimateLamports: 240_640n }).estimateLamports, 240_640n);
  assert.equal(stepView({ kind: 'sweep-sol', walletIndex: 2, wallet: 'W', isFeePayer: true }).isFeePayer, true);

  // passo que só libera a fee parada: a página diz "liberar … a coleta vem no passo seguinte", nunca "coletar"
  const sweep = stepView({ kind: 'claim-curve', walletIndex: 4, wallet: 'W', estimateLamports: 1_000_000n, sweepOnly: true, sweeps: [{ mint: 'M', lamports: 1n }, { mint: 'N', lamports: 1n }, { mint: 'O', lamports: 1n }] } as Step);
  assert.equal(sweep.sweepOnly, true);
  assert.equal(sweep.sweeps, 3);
  for (const lang of ['pt', 'en'] as const) {
    const d = I18N[lang]['stepd.claim-curve'] as (p: unknown) => string;
    const a = I18N[lang]['stepd.claim-amm'] as (p: unknown) => string;
    assert.match(d({ who: 'N=4', sol: '0,001', sweepOnly: true, sweeps: 3 }), lang === 'pt' ? /liberar creator fees paradas em 3 moedas/ : /release creator fees stuck in 3/);
    assert.match(a({ who: 'N=4', sol: '0,001', sweepOnly: true, sweeps: 2 }), lang === 'pt' ? /liberar creator fees paradas em 2 pools/ : /release creator fees stuck in 2/);
    assert.match(d({ who: 'N=4', sol: '0,001', sweepOnly: false, sweeps: 1 }), lang === 'pt' ? /coletar/ : /collect/);
  }
});

test('página: texto de fora nunca vira HTML (sem innerHTML, outerHTML, insertAdjacentHTML)', () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

// 30/10: o título deixou de ser fixo; acompanha a etapa (teste "título da janela acompanha a etapa", no fim)
test('barra da janela sem repetir o nome, antes e depois do script; a página mantém logo e nome', () => {
  assert.equal(/<title>([^<]*)<\/title>/.exec(HTML)?.[1], 'Recover SOL from your burner wallets', 'antes do script carregar');
  for (const lang of ['pt', 'en'] as const) assert.doesNotMatch((I18N[lang]['title.step'] as (p: unknown) => string)({ n: 1, total: 5, name: 'x' }), /clurn/i, lang);
  assert.match(HTML, /<p class="logo"><img src="\/assets\/clurn\.svg"[^>]*>clurn<\/p>/);
  assert.doesNotMatch(HTML, /\.logo \{[^}]*display: none/);
});

test('busca automática: a página não pergunta limites e o servidor usa o padrão', () => {
  assert.doesNotMatch(HTML, /id="(max|folga)"/, 'sem campos de limite na tela');
  const call = /api\('\/api\/analisar', \{([\s\S]*?)\}\);/.exec(SCRIPT)?.[1] ?? '';
  assert.ok(call.includes('frase'), 'achou a chamada da análise');
  assert.doesNotMatch(call, /\bmax\b|\bfolga\b/, 'a análise não manda limites');
  assert.deepEqual(searchLimits({}), { max: 2000, gap: 20 });
  assert.deepEqual(searchLimits({ max: 500, folga: 30 }), { max: 500, gap: 30 }, 'terminal e testes ainda podem informar');
  assert.throws(() => searchLimits({ max: 5000 }), /Limites inválidos/);
});

test('palavra de queimar: maiúscula ou minúscula, nos dois idiomas; ao acertar, a tela diz o próximo passo', () => {
  const start = SCRIPT.indexOf('const BURN_WORDS');
  const end = SCRIPT.indexOf('\n', SCRIPT.indexOf('const burnWordOk', start));
  assert.ok(start > 0 && end > start, 'regra da palavra');
  // quebra de linha antes do return: a linha cortada termina num comentário (com LF, "; return" ficava dentro dele)
  const burnWordOk = new Function(`${SCRIPT.slice(start, end)}\nreturn burnWordOk;`)() as (v: unknown) => boolean;
  for (const ok of ['BURN', 'burn', ' Burn ', 'QUEIMAR', 'queimar']) assert.equal(burnWordOk(ok), true, ok);
  for (const no of ['BURNN', 'queima', '', null, undefined]) assert.equal(burnWordOk(no), false, String(no));
  assert.equal((SCRIPT.match(/BURN_WORDS\.includes/g) ?? []).length, 1, 'as duas caixas usam a mesma regra (burnWordOk)');
  // uma caixa só (a palavra vale para todos os marcados sem valor conhecido), lida pela regra ao montar o pedido
  assert.ok((SCRIPT.match(/burnWordOk\(ui\.burnWord\)/g) ?? []).length >= 1, 'o pedido do plano confere pela regra');
  assert.match(fnSource('tokensBlock'), /id: 'bci-all'/, 'caixa única da palavra na lista de tokens');
});

test('ícone da janela: PNG em todos os tamanhos, servidos e existentes; sem SVG (o Edge esticava de 16 px)', () => {
  const links = [...HTML.matchAll(/<link rel="icon"[^>]*>/g)].map((m) => m[0]);
  assert.ok(links.every((l) => /type="image\/png"/.test(l)), 'só PNG');
  const sizes = links.map((l) => Number(/sizes="(\d+)x\1"/.exec(l)?.[1]));
  assert.deepEqual(sizes, [...ICON_SIZES]);
  for (const s of ICON_SIZES) {
    const name = `clurn-icone-${s}.png`;
    assert.ok(links.some((l) => l.includes(`href="/assets/${name}"`)), `${name} na página`);
    assert.equal(ASSETS[name], 'image/png', `${name} servido`);
    const png = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'app', 'ui', 'assets', name));
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [s, s], `${name} tem ${s}x${s}`);
  }
});

test('página: preferências guardadas no navegador são só tema, idioma e efeito de fundo', () => {
  const keys = [...HTML.matchAll(/(?:setPref|getPref|localStorage\.(?:getItem|setItem))\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(), ['autoclarn-efeito', 'autoclarn-idioma', 'autoclarn-tema']);
});

test('idioma: todo código de erro tem what/app/you em PT e EN', () => {
  for (const code of ERROR_CODES) {
    for (const part of ['what', 'app', 'you']) {
      const k = `err.${code}.${part}`;
      assert.equal(typeof I18N.pt[k], 'function', `pt ${k}`);
      assert.equal(typeof I18N.en[k], 'function', `en ${k}`);
    }
  }
});

test('idioma: textos de erro em português iguais aos do núcleo (uma regra, dois lugares)', () => {
  const samples: ErrorParams[] = [
    { walletIndex: 3, wallet: 'W', sendSol: 0.01, owner: 'P', words: 4, index: 2 },
    { walletIndex: 3, wallet: 'W', sendSol: 0.01, walletName: 'Conta 4', appName: 'Phantom' },
    { walletIndex: 1, wallet: 'W', sendSol: 0.01, walletName: 'Chave 2', appName: 'qualquer uma' }, // cartão de chaves
  ];
  for (const code of ERROR_CODES) {
    for (const p of samples) {
      for (const part of ['what', 'app', 'you'] as const) {
        const page = I18N.pt[`err.${code}.${part}`] as (p: ErrorParams) => string;
        assert.equal(page(p), ERROR_TEXT_PT[code][part](p), `err.${code}.${part}`);
      }
    }
  }
  assert.equal(I18N.pt['lost.before'], LOST_PT.before);
  assert.equal(I18N.pt['lost.after'], LOST_PT.after);
});

test('idioma: erro em inglês não carrega texto em português do servidor (nome da burner traduzido)', () => {
  const p = { walletIndex: 3, wallet: 'W', sendSol: 0.01, walletName: 'Conta 4', appName: 'Phantom' };
  const you = (I18N.en['err.no-fee-sol.you'] as (p: ErrorParams) => string)(p);
  assert.match(you, /Account 4/);
  assert.doesNotMatch(you, /Conta|temporária/);
  const sf = (I18N.en['err.no-fee-sol.you'] as (p: ErrorParams) => string)({ walletIndex: 3, wallet: 'W', sendSol: 0.01, walletName: 'temporária N=3', appName: 'Solflare' });
  assert.match(sf, /N=3/);
  assert.doesNotMatch(sf, /temporária/);
});

test('página: botão de enviar exige segurar 2 s', () => {
  assert.match(SCRIPT, /const HOLD_MS = 2000;/);
  assert.doesNotMatch(SCRIPT, /addEventListener\('click'[^;]*api\/executar/);
  // o envio só sai do fim do segurar (setTimeout de HOLD_MS)
  const calls = [...SCRIPT.matchAll(/api\('\/api\/executar'/g)];
  assert.equal(calls.length, 1, 'um único lugar chama /api/executar');
  assert.match(SCRIPT, /setTimeout\([^;]*HOLD_MS\)/);
});

// regras da tela: bloco entre marcadores, avaliado sozinho (sem DOM)
type Rules = {
  feeNoticeKind: (s: object) => string | null;
  planNext: (s: object) => string;
  fundsNext: (planWaiting: boolean, s: object) => string | null;
  planRefusalWaits: (e: object, s: object) => boolean;
  holdAllowed: (s: object | null, simDone: boolean) => boolean;
  newestFirst: <T>(items: T[]) => T[];
  tokensSent: (results: object[] | null | undefined) => boolean;
};
// regras + análise + resumo: o resumo usa feeNoticeKind (regras) e countOf (análise)
const block = (name: string) => {
  const start = HTML.indexOf(`// ${name}:inicio`);
  const end = HTML.indexOf(`// ${name}:fim`);
  assert.ok(start > 0 && end > start, `marcadores de ${name}`);
  return HTML.slice(start, end);
};
const RULES: Rules = new Function(`${block('regras')}\n${block('analise')}\n${block('resumo')}; return { feeNoticeKind, planNext, fundsNext, planRefusalWaits, holdAllowed, newestFirst, tokensSent };`)();
const WAIT = { code: 'no-fee-sol', params: { wallet: 'W' }, waiting: true };

test('tela: falta SOL com espera ativa mostra "esperando", nunca "analisar de novo" (bug do autor), também na espera do plano', () => {
  assert.equal(RULES.feeNoticeKind({ feeWarning: 'x', feeWait: WAIT }), 'wait');
  assert.equal(RULES.feeNoticeKind({ feeWarning: 'x', feeWait: null }), 'reanalyze');
  assert.equal(RULES.feeNoticeKind({ feeWarning: null, feeWait: null }), null);
  // a espera do /api/plano vem sem feeWarning: o cartão ainda diz "esperando o depósito" (achado da 7b)
  assert.equal(RULES.feeNoticeKind({ feeWarning: null, feeWait: WAIT }), 'wait');
});

test('tela: plano parcial fica no resumo; sem plano espera; o evento fundos segue para a simulação só sem ninguém esperando', () => {
  const fr = (n: number, feeWait: object | null = null) => ({ n, status: 'pronta', feeWait, feeWarning: null });
  const PLAN = { destination: 'D', frases: [{ frase: 1, steps: [] }] };
  assert.equal(RULES.planNext({ plan: PLAN, frases: [fr(1), fr(3)] }), 'simulate');
  // frase 2 esperando o depósito: simular agora deixaria ela de fora sem avisar (achado da 7b) → fica no resumo
  assert.equal(RULES.planNext({ plan: PLAN, frases: [fr(1), fr(2, WAIT), fr(3)] }), 'partial');
  assert.equal(RULES.planNext({ plan: null, frases: [fr(1, WAIT)] }), 'wait');
  assert.equal(RULES.planNext({ plan: null, frases: [fr(1)] }), 'result');
  assert.equal(RULES.fundsNext(true, { plan: PLAN, frases: [fr(1), fr(2)] }), 'simulate', 'o depósito chegou e ninguém mais espera');
  assert.equal(RULES.fundsNext(true, { plan: PLAN, frases: [fr(1), fr(2), fr(3, WAIT)] }), 'partial', 'outra frase ainda espera');
  assert.equal(RULES.fundsNext(false, { plan: null, frases: [fr(1)] }), 'result', 'espera da análise só redesenha');
  assert.equal(RULES.fundsNext(true, { plan: null, frases: [fr(1)] }), 'result', 'sem plano não simula');
  assert.equal(RULES.fundsNext(false, { plan: null, frases: [] }), null);
  // 400 no-fee-sol com frases esperando = "esperando o depósito"; com a rodada parada (sem espera) é erro de verdade
  assert.equal(RULES.planRefusalWaits({ codigo: 'no-fee-sol' }, { frases: [fr(1, WAIT)] }), true);
  assert.equal(RULES.planRefusalWaits({ codigo: 'no-fee-sol' }, { frases: [fr(1)] }), false);
  assert.equal(RULES.planRefusalWaits({ codigo: 'dest-lookalike' }, { frases: [fr(1, WAIT)] }), false);
});

test('tela: listas de passos põem o mais recente em cima, ao vivo e ao redesenhar', () => {
  const items = [1, 2, 3];
  assert.deepEqual(RULES.newestFirst(items), [3, 2, 1]);
  assert.deepEqual(items, [1, 2, 3], 'não mexe na lista guardada');
  assert.match(SCRIPT, /\.prepend\(resultItem\(r\)\)/, "evento 'passo' entra no topo");
  assert.doesNotMatch(SCRIPT, /\.append\(resultItem\(/, 'nenhum passo entra no fim');
  assert.doesNotMatch(SCRIPT, /\$\('x-lista'\)\.replaceChildren\(\.\.\./, 'redesenho da execução passa por renderResults');
  // simulação: resumo sem o mapa (renderSimSummary), com o que não vai ser enviado em cima, o mais recente primeiro
  const sum = fnSource('renderSimSummary');
  assert.match(sum, /newestFirst\(v\.apart\)/, 'o que não vai ser enviado: mais recente em cima');
  assert.equal([...SCRIPT.matchAll(/\$\('sim-lista'\)\.replaceChildren\(\.\.\./g)].length, 1, 'a lista da simulação só é redesenhada pelo resumo');
});

test('tela: botão de enviar só liga com simulação pronta, sem parada e sem execução (sem confirmação digitada: o destino foi colado 2× na entrada)', () => {
  const destination = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN';
  const s = { plan: { steps: [], destination }, aborted: null, execResults: [] };
  assert.equal(RULES.holdAllowed(s, true), true);
  assert.equal(RULES.holdAllowed(s, false), false, 'simulação rodando');
  assert.equal(RULES.holdAllowed({ ...s, aborted: 'parou' }, true), false, 'simulação parada');
  assert.equal(RULES.holdAllowed({ ...s, execResults: [{}] }, true), false, 'já executou');
  assert.equal(RULES.holdAllowed({ ...s, plan: null }, true), false, 'sem plano');
  assert.equal(RULES.holdAllowed(null, true), false);
  assert.doesNotMatch(HTML, /id="confirmacao"/, 'sem campo de confirmação digitada');
  assert.match(SCRIPT, /api\('\/api\/executar', \{\}\)/, 'executar não manda confirmação');
});

test('tela: fim da execução tem "Limpar outra frase" acima da lista; volta ao início sem frase nem destino antigos', () => {
  assert.ok(HTML.indexOf('id="b-nova"') > 0, 'botão existe');
  assert.ok(HTML.indexOf('id="x-fim"') < HTML.indexOf('id="x-lista"'), 'botões acima da lista de passos');
  // um caminho só para o começo: "Limpar outra frase", "Começar de novo", "Nada para limpar" e "Voltar ao início" da espera
  const start = /async function startOver\(\) \{([\s\S]*?)\n\}/.exec(SCRIPT)?.[1] ?? '';
  assert.match(start, /api\('\/api\/nova-limpeza'/, 'pede ao app para apagar as chaves');
  assert.doesNotMatch(start, /encerrar/, 'não fecha o app');
  assert.match(start, /resetPage\(\);\s*show\('s-frase'\)/);
  const click = /\$\('b-nova'\)\.addEventListener\('click', async \(ev\) => \{([\s\S]*?)\n\}\);/.exec(SCRIPT)?.[1] ?? '';
  assert.match(click, /startOver\(\)/, '"Limpar outra frase" usa o mesmo caminho');
  assert.match(/\$\('b-inicio'\)\.addEventListener\('click', async \(\) => \{([\s\S]*?)\n\}\);/.exec(SCRIPT)?.[1] ?? '', /await startOver\(\)/, '"Começar de novo" usa o mesmo caminho');
  assert.match(SCRIPT, /const backToStartButton = [^\n]*onclick: startOver/, '"Voltar ao início" da espera apaga as chaves');
  const reset = /function resetPage\(\) \{([\s\S]*?)\n\}/.exec(SCRIPT)?.[1] ?? '';
  assert.match(reset, /resetFrases\(\);/, 'apaga o texto de todas as frases (cartões)');
  // o destino fica guardado na sessão (colado uma vez): "Começar de novo" e "Limpar outras frases" não o apagam
  assert.doesNotMatch(reset, /'destino'|dest: \{/, 'não apaga o destino nem o campo dele');
  assert.match(reset, /decisions: new Map\(\)/, 'escolhas de token da rodada anterior não voltam');
  for (const id of ['x-lista', 'sim-lista', 'x-resumo']) assert.ok(reset.includes(`'${id}'`), `esvazia #${id}`);
});

test('tela: confirmação acima da lista de passos; listas longas rolam por dentro; chaves do topo deslizam', () => {
  const fim = HTML.indexOf('id="c-box"');
  assert.ok(fim > 0 && fim < HTML.indexOf('id="sim-lista"'), 'confirmação antes da lista dos passos testados');
  for (const sel of ['.results', '.wallets-wrap', '.accounts']) {
    const at = HTML.indexOf(`\n${sel} {`);
    const rule = at < 0 ? '' : HTML.slice(at, HTML.indexOf('}', at));
    assert.ok(rule.includes('max-height: var(--list-max)') && /overflow(-y)?: auto/.test(rule), `${sel} rola por dentro`);
  }
  assert.match(HTML, /\.wallets-wrap th \{[^}]*position: sticky/, 'cabeçalho da tabela fixo');
  assert.match(HTML, /\.ui-ready \.switch::before \{ transition: transform/, 'pílula desliza');
  assert.match(HTML, /prefers-reduced-motion: reduce\) \{ \*, ::before, ::after \{/, 'menos movimento também para a pílula');
  assert.match(SCRIPT, /requestAnimationFrame\(\(\) => setTimeout\(rerender, 0\)\)/, 'idioma: redesenho depois de a pílula sair');
  assert.match(SCRIPT, /requestAnimationFrame\(\(\) => setTimeout\(\(\) => applyTheme\(r\.value\), 0\)\)/, 'tema: cores depois de a pílula sair');
});

test('título da janela acompanha a etapa, no idioma escolhido; muda ao trocar de etapa e de idioma', () => {
  const start = SCRIPT.indexOf('const STEP_ORDER');
  const end = closingBrace(SCRIPT.indexOf('function renderTitle'))?.end ?? -1;
  assert.ok(start > 0 && end > start, 'bloco do título');
  for (const lang of ['pt', 'en'] as const) {
    const dict = I18N[lang];
    const tr = (k: string, a?: unknown) => { const v = dict[k]; return typeof v === 'function' ? v(a) : String(v); };
    const doc = { title: '' };
    const ui: { section?: string } = {};
    const render = new Function('ui', 't', 'document', `${SCRIPT.slice(start, end)}\nreturn renderTitle;`)(ui, tr, doc) as () => void;
    const expected = lang === 'pt'
      ? ['Etapa 1 de 4 · Frases e destino', 'Etapa 2 de 4 · Preparando', 'Etapa 3 de 4 · Confirmar', 'Etapa 4 de 4 · Enviando']
      : ['Step 1 of 4 · Phrases and destination', 'Step 2 of 4 · Preparing', 'Step 3 of 4 · Confirm', 'Step 4 of 4 · Sending'];
    render();
    assert.equal(doc.title, expected[0], `${lang}: antes de qualquer etapa`);
    ['s-frase', 's-preparo', 's-confirmar', 's-execucao'].forEach((s, i) => { ui.section = s; render(); assert.equal(doc.title, expected[i], `${lang}: ${s}`); });
  }
  const body = (name: string) => SCRIPT.slice(SCRIPT.indexOf(`function ${name}(`), closingBrace(SCRIPT.indexOf(`function ${name}(`))?.at);
  assert.match(body('show'), /ui\.section = section;\s+renderTitle\(\);/, 'trocar de etapa atualiza o título');
  assert.match(body('rerender'), /renderTitle\(\);/, 'trocar de idioma atualiza o título');
});

// Ruling da 0.1.7 (coordenação, 31/10/2026): com a página em inglês, a contagem das contas da Phantom aparecia em
// português no roteiro de tela. A contagem é refeita pelo rerender → renderPrep → renderReviewCount, com t() e walletName()
// no idioma da hora; este teste roda a contagem de verdade nos dois idiomas e prende a cadeia do redesenho.
test('idioma: a contagem das contas da Phantom troca de idioma (texto e "Conta N" → "Account N")', () => {
  const acc = (index: number, isMain = false) => ({ index, label: `Conta ${index + 1}`, isMain });
  const many = (k: number) => Array.from({ length: k }, (_, i) => acc(i, i === 0));
  const run = (lang: 'pt' | 'en', accounts = [acc(0, true), acc(1), acc(2), acc(3), acc(4)], protect = [1, 3]) => {
    const frase = { n: 1, app: 'phantom', wallets: [], review: { accounts } };
    const box = { parts: [] as unknown[], replaceChildren(...p: unknown[]) { this.parts = p; } };
    const fakes = {
      LANG: lang,
      I18N,
      state: { frases: [frase] },
      ui: { protect: new Map([[1, new Set(protect)]]) },
      defaultProtect: () => new Set<number>(),
      $: (id: string) => (id === 'rev-resumo-1' ? box : null),
      el: (_tag: string, _attrs: unknown, ...kids: unknown[]) => kids.filter((k) => k !== null).join(' '),
    };
    const src = [fnSource('t'), 'const fraseOf = (n) => state?.frases?.find((f) => f.n === n) ?? null;', "const isPhantom = (n) => fraseOf(n)?.app === 'phantom';", fnSource('walletName'),
      SCRIPT.slice(SCRIPT.indexOf('const reviewTargets = (f) =>'), SCRIPT.indexOf('};', SCRIPT.indexOf('const reviewTargets = (f) =>')) + 2),
      SCRIPT.slice(SCRIPT.indexOf('const REV_KEPT_SHOWN'), SCRIPT.indexOf(';', SCRIPT.indexOf('const REV_KEPT_SHOWN')) + 1), fnSource('renderReviewCount')].join('\n');
    new Function(...Object.keys(fakes), `${src}\nrenderReviewCount(1);`)(...Object.values(fakes));
    return box.parts.filter((p) => p !== null).join(' ');
  };
  // o resumo (03/11/2026): o número, e o que fica DE FORA (a principal e as protegidas), não a lista das que serão limpas
  assert.equal(run('pt'), '2 contas serão limpas Ficam de fora: Conta 1 (principal), Conta 2, Conta 4');
  assert.equal(run('en'), '2 accounts will be cleaned Left out: Account 1 (main), Account 2, Account 4');
  // 61 contas, 9 protegidas: as 6 primeiras de fora pelo nome, o resto contado; 1 conta e nenhuma
  assert.equal(run('pt', many(61), [3, 4, 5, 6, 7, 8, 9, 10, 39]), '51 contas serão limpas Ficam de fora: Conta 1 (principal), Conta 4, Conta 5, Conta 6, Conta 7, Conta 8 e mais 4');
  assert.equal(run('pt', many(3), [2]), '1 conta será limpa Ficam de fora: Conta 1 (principal), Conta 3');
  assert.equal(run('pt', many(3), [1, 2]), 'Nenhuma conta será limpa: todas estão protegidas. Ficam de fora: Conta 1 (principal), Conta 2, Conta 3');
  // trocar o idioma redesenha a preparação, e a preparação refaz a contagem de cada cartão de revisão
  assert.match(fnSource('rerender'), /if \(state\?\.frases\?\.length \|\| ui\.analysing\) renderPrep\(\);/);
  assert.match(fnSource('renderPrep'), /for \(const c of cards\) if \(c\.dataset\?\.frase && \$\(`rev-resumo-\$\{c\.dataset\.frase\}`\)\) renderReviewCount\(Number\(c\.dataset\.frase\)\);/);
});

// devnet de 08/11/2026 (cartão de chaves): as moedas foram queimadas e a tela final dizia "mais os tokens enviados"
test('tela final: "mais os tokens enviados" só quando algum token foi mesmo para o destino', () => {
  const r = (status: string, step: object) => ({ status, step });
  const burn = { kind: 'tokens', close: 0, burnClose: 1, transferClose: 0 };
  const send = { kind: 'tokens', close: 0, burnClose: 0, transferClose: 2 };
  const sol = { kind: 'sweep-sol', close: 0, burnClose: 0, transferClose: 0 };
  assert.equal(RULES.tokensSent([r('enviado', burn), r('enviado', sol)]), false, 'só queimou e fechou');
  assert.equal(RULES.tokensSent([r('enviado', send)]), true);
  assert.equal(RULES.tokensSent([r('falhou', send), r('enviado', burn)]), false, 'o envio do token falhou: não foi');
  assert.equal(RULES.tokensSent([r('simulado', send)]), false, 'simulado não é enviado');
  assert.equal(RULES.tokensSent([{ status: 'enviado', step: null }, { status: 'enviado' }]), false, 'passo sem detalhe não quebra');
  assert.equal(RULES.tokensSent(null), false);
  // o par com o servidor: o passo que a página recebe (stepView) conta o token enviado em transferClose
  const act = (action: string) => ({ action, account: 'A', mint: 'M', program: 'P', amount: 1n, decimals: 0 });
  const real = (actions: object[]) => stepView({ kind: 'tokens', walletIndex: 1, wallet: 'W', actions } as unknown as Step);
  assert.equal(RULES.tokensSent([r('enviado', real([act('burn-close'), act('close')]))]), false);
  assert.equal(RULES.tokensSent([r('enviado', real([act('close'), act('transfer-close')]))]), true);
  assert.match(fnSource('renderExecFim'), /tokensSent\(rs\) \? el\('p', \{ class: 'receipt-usd' \}, t\('exec\.plusTokens'\)\) : null/);
});

// fase 1 multirredes (Task 7): os textos gerais da página falam também em Trust e em chaves privadas, nos dois idiomas,
// e o texto fixo do HTML (antes da tradução) é o mesmo do português
// 1.0 (congelamento de 16/11/2026, src/core/features.ts): com a Trust, as chaves coladas e a Monad/HyperEVM
// desligadas, a tela não promete nenhum dos três. Quem religar um interruptor precisa voltar o texto (e este teste).
test('tela 1.0: textos gerais citam só frases do Solflare e da Phantom (Trust, chaves e Monad/HyperEVM desligados)', () => {
  const s = (lang: 'pt' | 'en', k: string) => (typeof I18N[lang][k] === 'function' ? (I18N[lang][k] as () => string)() : (I18N[lang][k] as string));
  assert.deepEqual({ ...FEATURES }, { closeVolumeAccounts: false, trustPath: false, pastedKeys: false, extraEvmNetworks: false });
  assert.match(s('pt', 'brand.sub'), /Solflare.*Phantom/);
  assert.match(s('en', 'brand.sub'), /Solflare.*Phantom/);
  for (const lang of ['pt', 'en'] as const) {
    for (const k of ['brand.sub', 'frase.title', 'frase.lede', 'frase.label', 'frase.appHint', 'safety.2']) {
      assert.doesNotMatch(s(lang, k), /Trust/, `${lang} ${k}: Trust desligada`);
      assert.doesNotMatch(s(lang, k), /chaves? privadas?|private keys?/i, `${lang} ${k}: chaves coladas desligadas`);
    }
    for (const k of ['prog.now.outras-redes', 'evm.lede']) assert.doesNotMatch(s(lang, k), /Monad|HyperEVM/, `${lang} ${k}: Monad/HyperEVM desligadas`);
  }
  assert.match(s('pt', 'safety.1'), /frase e as chaves/);
  assert.match(s('en', 'safety.1'), /phrase and the keys/);
  for (const lang of ['pt', 'en'] as const) {
    for (const k of ['safety.2', 'conf.loose', 'prep.stage.busca']) assert.doesNotMatch(s(lang, k), /temporár|temporary/, `${lang} ${k}`);
    // o destino é colado uma vez (31/10/2026): nenhum texto pede duas colagens
    for (const k of ['frase.lede', 'dest.lede', 'prep.noDest']) assert.doesNotMatch(s(lang, k), /duas vezes|dois campos|twice|both fields/i, `${lang} ${k}`);
  }
  for (const k of ['brand.sub', 'frase.title', 'frase.lede', 'frase.label', 'frase.appHint', 'dest.lede', 'safety.1', 'safety.2']) {
    const m = new RegExp(`data-i18n="${k.replace('.', '\.')}">([^<]*)<`).exec(HTML);
    assert.ok(m, `${k} no HTML`);
    assert.equal(m![1], s('pt', k), `texto fixo de ${k} igual ao português`);
  }
});
