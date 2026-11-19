// Tela de análise (lista por frase): tempo restante sem número congelado, "Agora: …" traduzido, uma linha por frase
// e o cartão da pausa por RPC (trocar, usar o público, parar), com o endereço do RPC fora da página depois de trocar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

type D = { key: string; params: Record<string, unknown> };
type Row = { n: number; app: string; main: string | null; kind: string; head: D; sub: (D & { err?: string }) | { err: string; params: Record<string, unknown> } | null; chip: D; mini: number | null };
type Clock = { eventAt: number; eta: number | null; etaAt: number };
type P = { fase: string; frase: number | null; carteira: string | null; feitos: number; total: number; etaMs: number | null; geral: { feitos: number; total: number } };
type F = { n: number; app: string; status: string; error?: { code: string; params: Record<string, unknown> } | null; main?: string | null; discovery?: { found: number } | null; tempoMs?: number | null };
type Analise = {
  STALL_MS: number;
  durationParts: (ms: number) => { min: number; h: number; m: number };
  tookParts: (ms: number) => { min: number; s: number };
  trackProgress: (c: Clock | null, p: Partial<P> | null, now: number) => Clock;
  etaView: (p: Partial<P> | null, c: Clock | null, now: number, paused: boolean) => D;
  overallView: (p: Partial<P> | null, frases: F[], prev?: number) => { feitos: number; total: number; approx: boolean; pct: number };
  NOW_FASES: string[];
  nowView: (p: Partial<P> | null) => D;
  fraseRowView: (f: F, p: Partial<P> | null, opts?: { etaMs?: number | null; remaining?: number; paused?: boolean }) => Row;
  pauseFromEvent: (d: unknown) => { pause: { motivo: string } | null; note: { kind: string; rpc?: string } | null };
  PAUSE_REASONS: string[];
  pauseReason: (m: unknown) => string;
  pauseContext: (s: string) => string;
  newAnalysis: (n?: number) => Record<string, unknown>;
};
const BLOCK = (() => {
  const start = HTML.indexOf('// analise:inicio');
  const end = HTML.indexOf('// analise:fim');
  assert.ok(start > 0 && end > start, 'marcadores da análise');
  return HTML.slice(start, end);
})();
const A: Analise = new Function(`${BLOCK}; return { STALL_MS, durationParts, tookParts, trackProgress, etaView, overallView, NOW_FASES, nowView, fraseRowView, pauseFromEvent, PAUSE_REASONS, pauseReason, pauseContext, newAnalysis };`)();

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
const both = (key: string) => assert.ok(key in I18N.pt && key in I18N.en, `falta "${key}"`);

const prog = (o: Partial<P> = {}): P => ({ fase: 'leitura', frase: 1, carteira: null, feitos: 0, total: 0, etaMs: null, geral: { feitos: 0, total: 0 }, ...o });

test('análise: tempo restante desce sozinho entre avisos e nunca some — "aguardando a rede…" vai ao lado do número sem aviso há 20 s', () => {
  assert.equal(A.STALL_MS, 20000);
  // sem aviso nenhum ainda, ou com etaMs null (servidor sem base): calculando
  assert.equal(A.etaView(null, null, 0, false).key, 'prog.eta.calc');
  let c = A.trackProgress(null, prog({ etaMs: null }), 1000);
  assert.equal(A.etaView(prog({ etaMs: null }), c, 1500, false).key, 'prog.eta.calc');
  // sem tempo E sem aviso há 20 s: aguardando a rede (sem número, não há o que mostrar)
  assert.equal(A.etaView(prog({ etaMs: null }), c, 1000 + 20_000, false).key, 'prog.eta.stalled');
  // com tempo: número, descontando o que passou desde o aviso (180 s no aviso, 0,5 s depois: 179,5 s)
  const p = prog({ etaMs: 180_000 });
  c = A.trackProgress(c, p, 2000);
  assert.deepEqual(A.etaView(p, c, 2500, false), { key: 'prog.eta.left', params: { min: 3, h: 0, m: 3, stalled: false }, ms: 179_500 });
  // o número desce sem aviso novo: 70 s depois faltam 110 s (~2 min)
  assert.deepEqual(A.etaView(p, c, 2000 + 70_000, false), { key: 'prog.eta.left', params: { min: 2, h: 0, m: 2, stalled: true }, ms: 110_000 });
  // nenhum aviso por 20 s (rede lenta, novas tentativas, confirmação demorada): o número fica, com "aguardando a rede…" ao lado
  assert.equal(A.etaView(p, c, 2000 + 19_999, false).params.stalled, false);
  assert.equal(A.etaView(p, c, 2000 + 20_000, false).params.stalled, true);
  assert.equal(A.etaView(p, c, 2000 + 20_000, false).key, 'prog.eta.left');
  // passou do tempo e nada de aviso: nunca negativo
  assert.equal(A.etaView(p, c, 2000 + 400_000, false).ms, 0);
  assert.equal(A.etaView(p, c, 2000 + 400_000, false).params.min, 0);
  // avisos chegando com o mesmo tempo (busca lenta): número, nunca "calculando"
  let t = 2000;
  for (let i = 0; i < 25; i++) c = A.trackProgress(c, prog({ fase: 'busca', etaMs: 180_000 }), (t += 1000));
  assert.deepEqual(A.etaView(prog({ etaMs: 180_000 }), c, t, false), { key: 'prog.eta.left', params: { min: 3, h: 0, m: 3, stalled: false }, ms: 180_000 });
  // pausado ganha de tudo; dado sujo vira "calculando"
  assert.equal(A.etaView(p, c, t, true).key, 'prog.eta.paused');
  for (const bad of [NaN, -5, Infinity]) assert.equal(A.etaView(prog({ etaMs: bad }), A.trackProgress(null, prog({ etaMs: bad }), 0), 0, false).key, 'prog.eta.calc', String(bad));
  // textos
  assert.equal(tr('pt', 'prog.eta.left', A.durationParts(180_000)), '~3 min restantes');
  assert.equal(tr('pt', 'prog.eta.left', A.durationParts(20_000)), 'menos de 1 min restante');
  assert.equal(tr('pt', 'prog.eta.left', A.durationParts(95 * 60_000)), '~1 h 35 min restantes');
  assert.equal(tr('pt', 'prog.eta.left', { ...A.durationParts(180_000), stalled: true }), '~3 min restantes · aguardando a rede…');
  assert.equal(tr('en', 'prog.eta.left', A.durationParts(180_000)), '~3 min left');
  assert.equal(tr('en', 'prog.eta.left', { ...A.durationParts(180_000), stalled: true }), '~3 min left · waiting for the network…');
  assert.equal(tr('pt', 'prog.eta.calc'), 'calculando…');
  assert.equal(tr('pt', 'prog.eta.stalled'), 'aguardando a rede…');
  assert.equal(tr('en', 'prog.eta.stalled'), 'waiting for the network…');
});

test('análise: "feitos de ~total · %" — "~" enquanto há frase sem busca, porcentagem nunca volta e fica em 99% até acabar', () => {
  const fila: F[] = [{ n: 1, app: 'solflare', status: 'leitura' }, { n: 2, app: 'solflare', status: 'fila' }];
  const a = A.overallView(prog({ geral: { feitos: 142, total: 310 } }), fila, 0);
  assert.deepEqual(a, { feitos: 142, total: 310, approx: true, pct: 45 });
  assert.equal(tr('pt', 'prog.count', a), '142 de ~310 carteiras · 45%');
  assert.equal(tr('en', 'prog.count', a), '142 of ~310 wallets · 45%');
  // a busca achou mais de 100: o total cresce, a porcentagem não volta
  const b = A.overallView(prog({ geral: { feitos: 150, total: 420 } }), fila, a.pct);
  assert.equal(b.pct, 45);
  // todas buscadas: sem "~"
  const done: F[] = [{ n: 1, app: 'solflare', status: 'pronta' }, { n: 2, app: 'phantom', status: 'leitura' }];
  assert.equal(A.overallView(prog({ geral: { feitos: 10, total: 20 } }), done, 0).approx, false);
  assert.equal(tr('pt', 'prog.count', A.overallView(prog({ geral: { feitos: 10, total: 20 } }), done, 0)), '10 de 20 carteiras · 50%');
  // tudo lido mas a tarefa segue (outras redes, preços): 99%
  assert.equal(A.overallView(prog({ fase: 'precos', geral: { feitos: 20, total: 20 } }), done, 0).pct, 99);
  // dado fora do formato: nunca NaN na tela
  for (const g of [{ feitos: NaN, total: 10 }, { feitos: 5, total: -1 }, { feitos: '3', total: null }, undefined]) {
    const v = A.overallView({ geral: g as never }, done, 0);
    assert.ok(Object.values(v).every((x) => typeof x === 'boolean' || Number.isFinite(x)), JSON.stringify(g));
    assert.ok(v.feitos <= v.total);
  }
  assert.equal(A.overallView(null, [], 0).approx, true, 'antes do 1º estado: total aproximado');
});

test('análise: "Agora: …" traduz cada fase do servidor, com a frase e a carteira; fase desconhecida = "começando…"', () => {
  assert.deepEqual(A.NOW_FASES, ['rpc', 'busca', 'leitura', 'releitura', 'outras-redes', 'precos']);
  for (const f of A.NOW_FASES) both(`prog.now.${f}`);
  for (const k of ['prog.now.start', 'prog.nowLabel', 'prog.pausedLabel', 'prog.wallet.solflare']) both(k);
  assert.equal(A.nowView(null).key, 'prog.now.start');
  assert.equal(A.nowView(prog({ fase: 'simulacao' })).key, 'prog.now.start');
  const r = A.nowView(prog({ fase: 'leitura', frase: 2, carteira: 'N=37', feitos: 55, total: 102 }));
  assert.deepEqual(r, { key: 'prog.now.leitura', params: { frase: 2, carteira: 'N=37', feitos: 55, total: 102 } });
  assert.equal(tr('pt', r.key, { ...r.params, carteira: tr('pt', 'prog.wallet.solflare', { label: 'N=37' }) }), 'lendo saldos, tokens e creator fees da frase 2 · temporária N=37');
  assert.equal(tr('en', r.key, { ...r.params, carteira: 'Account 4' }), 'reading balances, tokens and creator fees of phrase 2 · Account 4');
  assert.equal(tr('pt', r.key, { ...r.params, carteira: null }), 'lendo saldos, tokens e creator fees da frase 2', 'sem rótulo, sem "· null"');
  const b = A.nowView(prog({ fase: 'busca', frase: 3, carteira: 'N=9', feitos: 40, total: 60 }));
  assert.equal(b.params.carteira, null, 'busca não diz carteira');
  assert.equal(tr('pt', b.key, b.params), 'procurando as carteiras usadas da frase 3 · 40 endereços conferidos');
  assert.equal(tr('pt', 'prog.now.precos'), 'consultando nome e preço dos tokens');
  // releitura das carteiras incompletas: quantas e qual tentativa, nunca "carregando" sem dizer o quê
  const rr = A.nowView(prog({ fase: 'releitura', frase: 2, feitos: 3, total: 4 }));
  assert.equal(tr('pt', rr.key, rr.params), 'lendo de novo 4 carteiras da frase 2 que a rede não respondeu por inteiro (tentativa 3)');
  assert.equal(tr('pt', rr.key, { ...rr.params, total: 1 }), 'lendo de novo 1 carteira da frase 2 que a rede não respondeu por inteiro (tentativa 3)');
  // rótulo da carteira no idioma da tela (Phantom "Conta N" vira "Account N")
  const walletText = (lang: 'pt' | 'en') => new Function('LANG', 't', `${fnSource('walletText')}\nreturn walletText;`)(lang, (k: string, p: unknown) => tr(lang, k, p)) as (l: unknown, a?: string) => string | null;
  assert.equal(walletText('pt')('N=37', 'solflare'), 'temporária N=37');
  assert.equal(walletText('en')('N=37', 'solflare'), 'temporary N=37');
  assert.equal(walletText('en')('Conta 4', 'phantom'), 'Account 4');
  assert.equal(walletText('pt')('Conta 4', undefined), 'Conta 4');
  assert.equal(walletText('pt')(null, 'solflare'), null);
});

test('análise: uma linha por frase — fila, busca, leitura (mini barra e tempo), pronta (tempo que levou) e erro (motivo)', () => {
  const fila = A.fraseRowView({ n: 4, app: 'solflare', status: 'fila' }, prog({ frase: 2 }));
  assert.equal(fila.kind, 'wait');
  assert.deepEqual([fila.sub?.key, fila.chip.key], ['prog.row.queued', 'prog.chip.queued']);
  assert.equal(tr('pt', fila.chip.key), 'Na fila');

  // o /api/estado ainda diz "fila", o aviso mais novo diz que a frase 2 está na busca
  const busca = A.fraseRowView({ n: 2, app: 'phantom', status: 'fila' }, prog({ fase: 'busca', frase: 2, feitos: 30 }));
  assert.equal(busca.kind, 'run');
  assert.deepEqual([busca.head.key, busca.chip.key, busca.sub?.params], ['prog.row.searching', 'prog.chip.searching', { checked: 30 }]);

  // leitura: mini barra e tempo da frase = parte do tempo geral (proporcional às carteiras que faltam)
  const p = prog({ fase: 'leitura', frase: 2, feitos: 55, total: 102, etaMs: 300_000, geral: { feitos: 142, total: 310 } });
  const lendo = A.fraseRowView({ n: 2, app: 'phantom', status: 'busca' }, p, { etaMs: 300_000, remaining: 168 });
  assert.equal(lendo.mini, 53);
  assert.deepEqual(lendo.head, { key: 'prog.row.reading', params: { feitos: 55, total: 102 } });
  assert.deepEqual(lendo.chip, { key: 'prog.chip.eta', params: A.durationParts((300_000 * 47) / 168) });
  assert.equal(tr('pt', lendo.chip.key, lendo.chip.params), '~1 min');
  assert.equal(tr('pt', lendo.head.key, { ...lendo.head.params, app: 'Phantom' }), 'Phantom · lendo 55 de 102');
  // sem tempo no topo (calculando), a linha não inventa número; pausado diz "Pausada"
  assert.equal(A.fraseRowView({ n: 2, app: 'phantom', status: 'leitura' }, p, { etaMs: null, remaining: 168 }).chip.key, 'prog.chip.reading');
  assert.equal(A.fraseRowView({ n: 2, app: 'phantom', status: 'leitura' }, p, { etaMs: 300_000, remaining: 168, paused: true }).chip.key, 'prog.chip.paused');
  assert.equal(A.fraseRowView({ n: 2, app: 'phantom', status: 'leitura' }, prog({ fase: 'busca', frase: 2 }), { paused: true }).chip.key, 'prog.chip.paused');

  // pronta: número de carteiras, tempo que levou; pronta é final (aviso velho da mesma frase não volta para "lendo")
  const pronta = A.fraseRowView({ n: 1, app: 'solflare', status: 'pronta', discovery: { found: 87 }, tempoMs: 72_400, main: 'MAIN1111111111111111111111111111' }, prog({ fase: 'leitura', frase: 1, feitos: 86, total: 87 }));
  assert.equal(pronta.kind, 'ok');
  assert.equal(pronta.main, 'MAIN1111111111111111111111111111');
  assert.equal(tr('pt', pronta.head.key, { ...pronta.head.params, app: 'Solflare', phantom: false }), 'Solflare · 87 temporárias');
  assert.equal(tr('pt', pronta.sub!.key as string, (pronta.sub as D).params), 'pronta em 1 min 12 s');
  assert.equal(tr('pt', pronta.chip.key), 'Pronta ✓');
  assert.equal(tr('pt', 'prog.row.ready', { found: 12, app: 'Phantom', phantom: true }), 'Phantom · 12 contas');
  assert.equal(tr('pt', 'prog.row.ready', { found: 0, app: 'Solflare', phantom: false }), 'Solflare · nenhuma usada');
  assert.equal(tr('en', 'prog.row.ready', { found: 1, app: 'Phantom', phantom: true }), 'Phantom · 1 account');
  assert.equal(tr('pt', 'prog.row.took', A.tookParts(9_600)), 'pronta em 10 s');

  // erro: o motivo pelo código (cartão de erro da página), "Pulada"; parada pela pessoa: "Parada"
  const erro = A.fraseRowView({ n: 3, app: 'solflare', status: 'erro', error: { code: 'seed-unknown-word', params: { position: 7 } } }, prog({ frase: 3 }));
  assert.equal(erro.kind, 'bad');
  assert.deepEqual(erro.sub, { err: 'seed-unknown-word', params: { position: 7 } });
  assert.equal(tr('pt', 'err.seed-unknown-word.what', { position: 7 }), 'Uma palavra da frase não está na lista oficial (palavra nº 7).');
  assert.equal(tr('pt', erro.chip.key), 'Pulada');
  const parada = A.fraseRowView({ n: 3, app: 'solflare', status: 'erro', error: { code: 'stopped-by-user', params: {} } }, null);
  assert.equal(tr('pt', parada.chip.key), 'Parada');
  assert.equal((A.fraseRowView({ n: 3, app: 'x', status: 'erro', error: null }, null).sub as { err: string }).err, 'unknown');

  // todas as chaves que as linhas usam existem nos dois idiomas
  for (const k of ['prog.row.app', 'prog.row.ready', 'prog.row.reading', 'prog.row.searching', 'prog.row.checked', 'prog.row.took', 'prog.row.queued', 'prog.row.main',
    'prog.chip.ready', 'prog.chip.skipped', 'prog.chip.stopped', 'prog.chip.queued', 'prog.chip.searching', 'prog.chip.reading', 'prog.chip.paused', 'prog.chip.eta', 'prog.titleN']) both(k);
  assert.equal(tr('pt', 'prog.titleN', { n: 4 }), 'Analisando 4 frases');
  assert.equal(tr('en', 'prog.titleN', { n: 1 }), 'Analyzing 1 phrase');
});

// ---------- funções da página rodadas com peças falsas no lugar do DOM ----------
type Node = { textContent: string; value: string; disabled: boolean; style: Record<string, string>; cls: Set<string>; kids: unknown[]; classList: { toggle: (c: string, on?: boolean) => void; add: (c: string) => void; remove: (c: string) => void }; replaceChildren: (...k: unknown[]) => void; scrollIntoView: () => void; scrolled?: number };
function fakeDom() {
  const nodes = new Map<string, Node>();
  const $ = (id: string): Node => {
    if (!nodes.has(id)) {
      const n: Node = {
        textContent: '', value: '', disabled: false, style: {}, cls: new Set(), kids: [],
        classList: { toggle: (c, on) => { if (on ?? !n.cls.has(c)) n.cls.add(c); else n.cls.delete(c); }, add: (c) => n.cls.add(c), remove: (c) => n.cls.delete(c) },
        replaceChildren: (...k) => { n.kids = k; n.textContent = k.map((x) => JSON.stringify(x)).join(''); },
        scrollIntoView: () => { n.scrolled = (n.scrolled ?? 0) + 1; },
      };
      nodes.set(id, n);
    }
    return nodes.get(id)!;
  };
  return $;
}
const el = (tag: string, attrs: Record<string, unknown>, ...kids: unknown[]) => ({ tag, attrs, kids: kids.flat().filter((k) => k !== null && k !== undefined) });
const setTextSrc = fnSource('setText');

test('análise: tela desenhada com o relógio — número que desce sozinho, "aguardando a rede…" ao lado sem aviso, linha da frase com o mesmo desconto', () => {
  const $ = fakeDom();
  let now = 100_000;
  const ui = { analysis: A.newAnalysis(2) as Record<string, unknown>, progress: null as P | null, pause: null as unknown };
  const t = (k: string, p?: unknown) => tr('pt', k, p);
  const fakes = {
    ui, $, t, LANG: 'pt', I18N, el, short: (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`, Date: { now: () => now },
    overallView: A.overallView, etaView: A.etaView, nowView: A.nowView, fraseRowView: A.fraseRowView, trackProgress: A.trackProgress,
    APP_NAME: { solflare: 'Solflare', phantom: 'Phantom' }, tv: (d: D) => t(d.key, d.params),
  };
  const fns = new Function(...Object.keys(fakes), `${setTextSrc}\n${fnSource('walletText')}\n${fnSource('fraseRow')}\n${fnSource('renderProgress')}\n${fnSource('onProgress')}\nreturn { renderProgress, onProgress };`)(...Object.values(fakes)) as { renderProgress: () => void; onProgress: (p: P) => void };
  ui.analysis.frases = [
    { n: 1, app: 'solflare', status: 'pronta', discovery: { found: 87 }, tempoMs: 72_000, main: 'AAAA1111111111111111111111111ZZZZ' },
    { n: 2, app: 'phantom', status: 'busca', main: 'BBBB1111111111111111111111111YYYY' },
  ];
  fns.renderProgress();
  assert.equal($('p-titulo').textContent, 'Analisando 2 frases');
  assert.equal($('p-eta').textContent, 'calculando…', 'sem aviso ainda');
  assert.equal($('p-now').textContent, 'começando…');
  // aviso da leitura da frase 2 com tempo
  fns.onProgress(prog({ fase: 'leitura', frase: 2, carteira: 'Conta 4', feitos: 55, total: 102, etaMs: 180_000, geral: { feitos: 142, total: 189 } }));
  assert.equal($('p-eta').textContent, '~3 min restantes');
  assert.equal($('p-count').textContent, '142 de 189 carteiras · 75%');
  assert.equal($('p-barra').style.width, '75%');
  assert.equal($('p-now-label').textContent, 'Agora:');
  assert.equal($('p-now').textContent, 'lendo saldos, tokens e creator fees da frase 2 · Conta 4');
  const rows = () => $('p-frases').kids as Array<{ attrs: { class: string }; kids: unknown[] }>;
  assert.deepEqual(rows().map((r) => r.attrs.class), ['pf-row ok', 'pf-row run']);
  assert.match(JSON.stringify(rows()[0]), /Solflare · 87 temporárias/);
  assert.match(JSON.stringify(rows()[0]), /pronta em 1 min 12 s · principal AAAA…ZZZZ/);
  assert.match(JSON.stringify(rows()[1]), /Phantom · lendo 55 de 102/);
  assert.match(JSON.stringify(rows()[1]), /"~3 min"/, "tempo da frase 2: as 47 que faltam são as 47 do geral");
  // 70 s sem aviso: o número desce sozinho (180 s → 110 s, ~2 min), com "aguardando a rede…" ao lado; a linha acompanha
  now += 70_000;
  fns.renderProgress();
  assert.equal($('p-eta').textContent, '~2 min restantes · aguardando a rede…');
  assert.match(JSON.stringify(rows()[1]), /"~2 min"/, 'a linha desconta o mesmo tempo');
  // pausado: "Pausado:" e "pausado" no topo
  ui.pause = { motivo: 'rpc-quota' };
  fns.renderProgress();
  assert.equal($('p-now-label').textContent, 'Pausado:');
  assert.equal($('p-eta').textContent, 'pausado');
  assert.ok($('p-now-box').cls.has('paused'));
  // inglês: linhas redesenhadas
  const before = rows();
  const en = new Function(...Object.keys(fakes), `${setTextSrc}\n${fnSource('walletText')}\n${fnSource('fraseRow')}\n${fnSource('renderProgress')}\nreturn renderProgress;`)(...Object.values({ ...fakes, LANG: 'en', t: (k: string, p?: unknown) => tr('en', k, p), tv: (d: D) => tr('en', d.key, d.params) })) as () => void;
  en();
  assert.notEqual(rows(), before);
  assert.match(JSON.stringify(rows()[0]), /Solflare · 87 temporary wallets/);
});

test('análise: estado das frases pedido só quando a fase ou a frase muda; um pedido por vez; resposta velha descartada', async () => {
  const mk = () => {
    const ui = { analysing: true, analysis: A.newAnalysis(3) as Record<string, unknown> & { frases: unknown[]; key: string }, run: { clock: null as unknown } };
    const calls: string[] = [];
    let release: (v: unknown) => void = () => {};
    const api = (path: string) => { calls.push(path); return new Promise((r) => { release = r; }); };
    const fns = new Function('ui', 'api', 'renderProgress', 'renderRun', 'trackProgress', 'Date', `${fnSource('refreshAnalysis')}\n${fnSource('onProgress')}\nreturn { refreshAnalysis, onProgress };`)(
      ui, api, () => {}, () => {}, A.trackProgress, { now: () => 0 }) as { refreshAnalysis: () => Promise<void>; onProgress: (p: P) => void };
    return { ui, calls, fns, release: (v: unknown) => release(v) };
  };
  const m = mk();
  m.fns.onProgress(prog({ fase: 'busca', frase: 1 }));
  m.fns.onProgress(prog({ fase: 'busca', frase: 1, feitos: 10 }));
  m.fns.onProgress(prog({ fase: 'busca', frase: 1, feitos: 20 }));
  assert.deepEqual(m.calls, ['/api/estado'], 'mesma fase e frase: um pedido só');
  m.fns.onProgress(prog({ fase: 'leitura', frase: 1 })); // muda enquanto o 1º está no ar: fica marcado
  assert.equal(m.calls.length, 1, 'um pedido por vez');
  m.release({ frases: [{ n: 1, status: 'busca' }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(m.ui.analysis.frases, [{ n: 1, status: 'busca' }]);
  assert.equal(m.calls.length, 2, 'o pedido marcado sai quando o 1º volta');
  // a análise acabou (ou começou outra) antes da resposta: descartada
  m.ui.analysing = false;
  m.release({ frases: [{ n: 1, status: 'leitura' }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(m.ui.analysis.frases, [{ n: 1, status: 'busca' }]);
  m.fns.onProgress(prog({ fase: 'simulacao', frase: 1 }));
  assert.equal(m.calls.length, 2, 'fora da análise, aviso de progresso não pede estado');
  // com nada no ar, avisos da mesma fase e frase (um por carteira lida) não pedem o estado de novo
  const q = mk();
  q.fns.onProgress(prog({ fase: 'leitura', frase: 2, feitos: 1 }));
  q.release({ frases: [] });
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 2; i < 30; i++) q.fns.onProgress(prog({ fase: 'leitura', frase: 2, feitos: i }));
  assert.equal(q.calls.length, 1, 'um pedido por mudança, não por carteira');
  q.fns.onProgress(prog({ fase: 'busca', frase: 3 }));
  assert.equal(q.calls.length, 2);
  const n = mk();
  n.fns.onProgress(prog({ fase: 'busca', frase: 1 }));
  const old = n.ui.analysis;
  n.ui.analysis = A.newAnalysis(1) as typeof old; // "Começar de novo" + nova análise
  n.release({ frases: [{ n: 9, status: 'pronta' }] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(n.ui.analysis.frases, [], 'resposta da análise anterior não entra na nova');
});

test('preparação: as etapas narradas acompanham cada aviso de progresso da análise', () => {
  assert.match(fnSource('onProgress'), /if \(ui\.section === 's-preparo' && ui\.prep\.phase === 'analise'\) renderStages\(\);/);
  assert.match(fnSource('renderPrep'), /renderStages\(\);/);
});

test('análise: "Começar de novo" segue o servidor (só sem tarefa); pausado, diz para parar no cartão; análise acabada libera', () => {
  const run = (ui: Record<string, unknown>) => new Function('ui', `${fnSource('restartBlock')}\nreturn restartBlock();`)(ui) as string | null;
  const base = { sim: { done: false, error: null }, exec: { done: false, error: null }, pause: null, prep: { phase: 'analise' } };
  assert.equal(run({ ...base, section: 's-preparo', analysing: true }), 'nav.waitAnalysis');
  assert.equal(run({ ...base, section: 's-preparo', analysing: true, pause: { motivo: 'network-down' } }), 'nav.waitPause');
  assert.equal(run({ ...base, section: 's-preparo', analysing: false, prep: { phase: 'pendente' } }), null, 'análise terminou: nunca fica sem saída');
  assert.equal(run({ ...base, section: 's-preparo', prep: { phase: 'simulacao' }, pause: { motivo: 'rpc-quota' } }), 'nav.waitPause');
  assert.equal(run({ ...base, section: 's-preparo', prep: { phase: 'simulacao' } }), 'nav.waitSim', 'simulação rodando na tela da preparação');
  assert.equal(run({ ...base, section: 's-execucao' }), 'nav.waitExec');
  assert.equal(run({ ...base, section: 's-preparo', prep: { phase: 'espera' }, pause: { motivo: 'rpc-quota' } }), null, 'pausa fora de tarefa (espera do depósito): pode começar de novo');
  assert.equal(run({ ...base, section: 's-confirmar', pause: { motivo: 'rpc-quota' } }), null, 'confirmação: pode começar de novo');
  for (const k of ['nav.waitPause', 'nav.waitAnalysis']) both(k);
  // a tarefa acabou ('pronto' ou 'erro'): a análise para de segurar o botão e a pausa some
  const ui = { analysing: true, pause: { motivo: 'x' }, pauseNote: { kind: 'stopped' }, stopArmed: true, stopTimer: 1 };
  const $ = fakeDom();
  const calls: string[] = [];
  new Function('ui', '$', 'renderPause', 'renderRestart', 'clearTimeout', `${fnSource('disarmStop')}\n${fnSource('endTask')}\nendTask('analise');`)(ui, $, () => calls.push('pause'), () => calls.push('restart'), () => {});
  assert.deepEqual([ui.analysing, ui.pause, ui.pauseNote, ui.stopArmed], [false, null, null, false]);
  assert.deepEqual(calls, ['pause', 'restart']);
  assert.match(SCRIPT, /events\.addEventListener\('pronto', [\s\S]*?endTask\(tarefa\);\s*if \(tarefa === 'analise'\)/, '"pronto" solta a análise antes de desenhar o resumo');
  assert.match(SCRIPT, /events\.addEventListener\('erro', [\s\S]*?endTask\(d\.tarefa\);/);
});

// ---------- pausa por RPC ----------
function pauseFns(opts: { fail?: boolean; pause?: unknown; analysing?: boolean } = {}) {
  const $ = fakeDom();
  const ui: Record<string, unknown> = { pause: opts.pause ?? { motivo: 'rpc-quota' }, pauseNote: null, pauseBusy: false, stopArmed: false, analysing: Boolean(opts.analysing), analysis: { frases: [] } };
  const sent: Array<[string, unknown]> = [];
  const shown: string[] = [];
  const timers: Array<() => void> = [];
  const fakes = {
    ui, $,
    api: async (p: string, body: unknown) => {
      sent.push([p, body]);
      if (opts.fail) { const e = new Error('recusado') as Error & { codigo: string }; e.codigo = 'rpc-blocked'; throw e; }
      return { rpc: 'novo.exemplo', frases: [{ n: 2, status: 'erro', error: { code: 'stopped-by-user', params: {} } }] };
    },
    showError: (id: string, f: unknown) => shown.push(f ? `erro:${id}` : `limpa:${id}`),
    errorOf: () => () => null,
    renderPause: () => {}, renderProgress: () => {}, renderRun: () => {}, renderRestart: () => {},
    pauseFromEvent: A.pauseFromEvent,
    setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
  };
  const fns = new Function(...Object.keys(fakes), `${fnSource('disarmStop')}\n${fnSource('swapRpc')}\n${fnSource('stopHere')}\n${fnSource('onPause')}\nreturn { swapRpc, stopHere, onPause };`)(...Object.values(fakes)) as {
    swapRpc: (c: string) => Promise<void>; stopHere: () => Promise<void>; onPause: (d: unknown) => void;
  };
  return { $, ui, sent, shown, timers, ...fns };
}
test('pausa: sem campo de RPC; "Usar o público" manda só a escolha; recusado, a pausa continua', async () => {
  const pub = pauseFns();
  await pub.swapRpc('publico');
  assert.deepEqual(pub.sent, [['/api/trocar-rpc', { rpc: 'publico' }]]);
  assert.equal(pub.ui.pause, null);
  assert.deepEqual(pub.ui.pauseNote, { kind: 'swapped', rpc: 'novo.exemplo' });
  assert.equal(pub.ui.pauseBusy, false);
  // recusado (rpc-blocked): erro no cartão e a pausa continua
  const bad = pauseFns({ fail: true });
  await bad.swapRpc('publico');
  assert.deepEqual(bad.ui.pause, { motivo: 'rpc-quota' });
  assert.ok(bad.shown.includes('erro:e-pausa'));
  assert.equal(bad.ui.pauseBusy, false, 'botões voltam');
  // um pedido por vez (conferir o RPC pode levar um minuto); sem pausa, nada sai
  const twice = pauseFns();
  const first = twice.swapRpc('publico');
  await twice.swapRpc('publico');
  await first;
  assert.equal(twice.sent.length, 1);
  const none = pauseFns({ pause: null });
  none.ui.pause = null;
  await none.swapRpc('publico');
  assert.equal(none.sent.length, 0);
  // o cartão não tem mais campo nem botão de RPC colado (pedido do autor, 31/10/2026): o app vem com o RPC dele
  const card = HTML.slice(HTML.indexOf('id="pausa"'), HTML.indexOf('id="pausa-nota"'));
  assert.doesNotMatch(card, /<input|b-pausa-rpc|pausa-rpc/);
  assert.match(card, /id="b-pausa-publico"/);
  assert.match(card, /id="b-pausa-parar"/);
  assert.doesNotMatch(SCRIPT, /pausa-rpc|b-pausa-rpc/);
  assert.match(SCRIPT, /\$\('b-pausa-publico'\)\.addEventListener\('click', \(\) => swapRpc\('publico'\)\);/);
  assert.match(SCRIPT, /\$\('f-pausa'\)\.addEventListener\('submit', \(ev\) => ev\.preventDefault\(\)\);/, 'Enter no cartão não recarrega a página');
});

test('pausa: "Parar aqui" pede um 2º clique; parado, o cartão some e as frases da análise vêm já paradas', async () => {
  const s = pauseFns({ analysing: true });
  await s.stopHere();
  assert.equal(s.sent.length, 0, '1º clique só arma');
  assert.equal(s.ui.stopArmed, true);
  await s.stopHere();
  assert.deepEqual(s.sent, [['/api/parar', {}]]);
  assert.equal(s.ui.pause, null);
  assert.deepEqual(s.ui.pauseNote, { kind: 'stopped' });
  assert.deepEqual((s.ui.analysis as { frases: unknown[] }).frases, [{ n: 2, status: 'erro', error: { code: 'stopped-by-user', params: {} } }]);
  // armado e esquecido: volta sozinho em 5 s
  const late = pauseFns();
  await late.stopHere();
  late.timers[0]!();
  assert.equal(late.ui.stopArmed, false);
  // trocar desarma o "parar"
  const sw = pauseFns();
  await sw.stopHere();
  await sw.swapRpc('publico');
  assert.equal(sw.ui.stopArmed, false);
  assert.ok(!sw.sent.some(([p]) => p === '/api/parar'));
});

test('pausa: evento do app abre o cartão e, quando acaba (trocado ou parado), fecha; textos por motivo e por tela', () => {
  assert.deepEqual(A.pauseFromEvent({ motivo: 'rpc-quota' }), { pause: { motivo: 'rpc-quota' }, note: null });
  assert.deepEqual(A.pauseFromEvent({ motivo: null, rpc: 'novo.exemplo' }), { pause: null, note: { kind: 'swapped', rpc: 'novo.exemplo' } });
  assert.deepEqual(A.pauseFromEvent({ motivo: null, parado: true }), { pause: null, note: { kind: 'stopped' } });
  assert.deepEqual(A.pauseFromEvent(null), { pause: null, note: null });
  const s = pauseFns({ pause: null });
  s.ui.pause = null;
  s.onPause({ motivo: 'network-down' });
  assert.deepEqual(s.ui.pause, { motivo: 'network-down' });
  assert.equal(s.$('pausa').scrolled, 1, 'o cartão aparece à vista');
  s.onPause({ motivo: null, rpc: 'novo.exemplo' });
  assert.equal(s.ui.pause, null, 'trocado (por este ou outro pedido): o cartão fecha');
  assert.match(SCRIPT, /events\.addEventListener\('pausa', \(ev\) => onPause\(JSON\.parse\(ev\.data\)\)\);/);
  assert.match(fnSource('init'), /ui\.pause = state\.pause \? \{ motivo: state\.pause \} : null;/, 'recarregar a página no meio da pausa mostra o cartão');
  // textos
  assert.deepEqual(A.PAUSE_REASONS, ['rpc-quota', 'network-down']);
  assert.equal(A.pauseReason('qualquer'), 'network-down');
  for (const r of A.PAUSE_REASONS) { both(`pause.title.${r}`); both(`pause.text.${r}`); }
  // a simulação roda na tela da preparação: o que "Parar aqui" faz depende do momento dela
  assert.deepEqual([['s-preparo', 'analise'], ['s-preparo', 'simulacao'], ['s-execucao'], ['s-preparo', 'espera'], ['s-confirmar'], [undefined]].map(([x, p]) => A.pauseContext(x as string, p as string)), ['analise', 'run', 'run', 'idle', 'idle', 'idle']);
  for (const c of ['analise', 'run', 'idle']) { both(`pause.stopHint.${c}`); both(`pause.stopped.${c}`); }
  for (const k of ['pause.what', 'pause.usePublic', 'pause.stop', 'pause.stopArm', 'pause.checking', 'pause.swapped']) both(k);
  assert.equal(tr('pt', 'pause.title.rpc-quota'), 'Os créditos do RPC acabaram');
  assert.equal(tr('en', 'pause.swapped', { rpc: 'novo.exemplo' }), 'RPC switched: the app continues with novo.exemplo.');
  // um cartão só, fora das seções (vale para análise, resumo, simulação e execução)
  const card = HTML.indexOf('id="pausa"');
  assert.ok(card > 0 && card < HTML.indexOf('<section id="s-frase"'), 'no topo, antes de todas as telas');
  assert.match(fnSource('show'), /renderPause\(\);/, 'trocar de tela atualiza o que "Parar aqui" faz');
  assert.match(fnSource('rerender'), /renderPause\(\);/, 'trocar de idioma redesenha o cartão');
});

test('pausa: troca automática e volta sozinha viram aviso embaixo do cartão; a pausa explica que o app tenta sozinho', () => {
  assert.deepEqual(A.pauseFromEvent({ motivo: null, rpc: 'api.mainnet-beta.solana.com (público, mais lento)', auto: 'troca', helius: true }), { pause: null, note: { kind: 'auto', helius: true } });
  assert.deepEqual(A.pauseFromEvent({ motivo: null, rpc: 'x', auto: 'troca' }), { pause: null, note: { kind: 'auto', helius: false } });
  assert.deepEqual(A.pauseFromEvent({ motivo: null, rpc: 'x', auto: 'volta' }), { pause: null, note: { kind: 'back' } });
  const text = (lang: 'pt' | 'en', n: unknown, ctx = 'analise') =>
    new Function('t', `${fnSource('pauseNoteText')}\nreturn pauseNoteText;`)((k: string, p?: unknown) => tr(lang, k, p))(n, ctx) as string;
  assert.equal(text('pt', { kind: 'auto', helius: true }), 'O Helius falhou; continuando no RPC público (mais lento).');
  assert.equal(text('pt', { kind: 'auto', helius: false }), 'O RPC próprio falhou; continuando no RPC público (mais lento).');
  assert.equal(text('pt', { kind: 'back' }), 'A rede voltou; o app continuou sozinho do mesmo ponto.');
  assert.equal(text('pt', { kind: 'swapped', rpc: 'novo.exemplo' }), 'RPC trocado: o app continua com novo.exemplo.');
  assert.equal(text('pt', null), '');
  assert.equal(text('en', { kind: 'auto', helius: true }), 'Helius failed; continuing on the public RPC (slower).');
  // próxima chave do Helius (03/11/2026): o aviso não fala em RPC público
  assert.deepEqual(A.pauseFromEvent({ motivo: null, rpc: 'mainnet.helius-rpc.com', auto: 'troca', helius: true, proximo: true }), { pause: null, note: { kind: 'auto', helius: true, next: true } });
  assert.equal(text('pt', { kind: 'auto', helius: true, next: true }), 'Esta chave do Helius parou (créditos acabaram ou caiu); continuando na próxima chave, do mesmo ponto.');
  assert.equal(text('pt', { kind: 'auto', helius: false, next: true }), 'O RPC próprio falhou; continuando no próximo RPC próprio, do mesmo ponto.');
  for (const k of ['pause.autoHelius', 'pause.autoOwn', 'pause.autoHeliusNext', 'pause.autoOwnNext', 'pause.back']) both(k);
  assert.match(tr('pt', 'pause.what'), /tenta de novo sozinho/);
  assert.equal(tr('pt', 'pause.usePublic'), 'Tentar de novo agora');
  assert.match(fnSource('renderPause'), /const note = pauseNoteText\(n, ctx\);/);
});

test('idioma: trocar o idioma na tela "Nada para limpar" redesenha a confirmação (rodada vazia não tem plano)', () => {
  assert.match(fnSource('rerender'), /else if \(state && ui\.section === 's-confirmar' && summaryView\(state\)\.allEmpty\) renderConfirm\(\);/);
});

// o app descobre se a frase é Solflare ou Phantom (31/10/2026): a linha diz o que a busca achou
test('análise: a linha diz o que a busca achou (Solflare, Phantom, irmã da mesma frase, só a principal, nenhuma)', () => {
  type RowD = Row & { appName: D; note?: D | null };
  const row = (f: Record<string, unknown>) => A.fraseRowView({ n: 1, app: 'solflare', status: 'pronta', auto: true, discovery: { found: 2 }, ...f } as F, null) as RowD;
  const text = (lang: 'pt' | 'en', r: RowD) => tr(lang, r.head.key, { ...r.head.params, app: tr(lang, r.appName.key, r.appName.params), phantom: r.app === 'phantom' }); // como fraseRow
  const busca = A.fraseRowView({ n: 1, app: 'solflare', status: 'busca', auto: true, detected: null } as F, null) as RowD;
  assert.equal(tr('pt', busca.appName.key), 'Solflare ou Phantom?', 'antes da busca terminar, não afirma o app');
  assert.equal(text('pt', row({ detected: 'solflare' })), 'Solflare · 2 temporárias');
  assert.equal(text('pt', row({ app: 'phantom', detected: 'phantom' })), 'Phantom · 2 contas');
  const sol = row({ detected: 'ambas', pair: 6 });
  assert.equal(text('pt', sol), 'Solflare · 2 temporárias');
  assert.equal(tr('pt', sol.note!.key, sol.note!.params), 'a mesma frase também tem contas da Phantom: frase 6');
  const irma = row({ n: 6, app: 'phantom', auto: false, detected: 'ambas', pairOf: 5 });
  assert.equal(text('pt', irma), 'Phantom (mesma frase da 5) · 2 contas');
  assert.equal(text('en', irma), 'Phantom (same phrase as 5) · 2 accounts');
  const principal = row({ detected: 'principal', discovery: { found: 0 } });
  assert.equal(text('pt', principal), 'Só a principal tem uso · nada para limpar');
  assert.equal(principal.note, null);
  const nenhuma = row({ detected: 'nenhuma', discovery: { found: 0 } });
  assert.equal(text('pt', nenhuma), 'Nem Solflare nem Phantom · nada para limpar');
  assert.equal(tr('pt', nenhuma.note!.key), 'frase sem uso, ou de outra carteira; o app não mexe nela');
  assert.equal(text('en', nenhuma), 'Neither Solflare nor Phantom · nothing to clean');
  // frase de antes (app escolhido, sem busca nos dois ramos) segue com o nome do app
  assert.equal(text('pt', row({ app: 'phantom', auto: false })), 'Phantom · 2 contas');
  for (const k of ['app.solflare', 'app.phantom', 'app.detecting', 'app.pair', 'app.principal', 'app.nenhuma', 'app.hasPair', 'app.nenhumaHint', 'prog.row.detected']) both(k);
});

// ---------- exatidão: carteira lida pela metade segura o plano ----------

test('exatidão: carteira que a rede não respondeu por inteiro segura o plano até "Ler de novo" ou "Seguir assim"', () => {
  const lineOf = (name: string) => SCRIPT.match(new RegExp(`const ${name} = .*`))![0];
  const fns = new Function(`${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('incompleteOf')}\n${fnSource('prepNeeds')}\nreturn { prepNeeds, incompleteOf };`)() as {
    prepNeeds: (s: unknown, u: unknown) => { incomplete: unknown[]; errors: number[] };
    incompleteOf: (s: unknown) => Array<{ n: number; w: { label: string } }>;
  };
  const w = (label: string, unread: string[] = []) => ({ label, unread });
  const s = { frases: [
    { n: 1, app: 'solflare', status: 'pronta', wallets: [w('N=0'), w('N=1', ['contas de token: HTTP 500'])] },
    { n: 2, app: 'solflare', status: 'pronta', wallets: [w('N=0', ['cashback: x'])] },
    { n: 3, app: 'solflare', status: 'erro', wallets: [w('N=0', ['y'])] }, // frase com erro tem o próprio cartão
    { n: 4, app: 'solflare', status: 'pronta', wallets: [{ label: 'N=0' }] }, // estado sem o campo (servidor antigo) não trava
  ] };
  const ui = { goOn: false, goOnIncomplete: false, reviewed: new Set() };
  assert.deepEqual(fns.incompleteOf(s).map((i) => [i.n, i.w.label]), [[1, 'N=1'], [2, 'N=0']]);
  assert.equal(fns.prepNeeds(s, ui).incomplete.length, 2, 'o plano espera');
  assert.equal(fns.prepNeeds(s, { ...ui, goOnIncomplete: true }).incomplete.length, 0, '"Seguir assim" libera');
  // afterAnalysis só monta o plano sem nada pendente, inclusive as incompletas
  assert.match(fnSource('afterAnalysis'), /!needs\.incomplete\.length && needs\.plannable\) \{ runPlan\(\)/);
  // o cartão vai no topo, com "Ler de novo" como ação principal; textos nos dois idiomas
  assert.match(fnSource('renderPrep'), /if \(needs\.incomplete\.length\) cards\.unshift\(incompleteCard\(needs\.incomplete\)\)/);
  assert.match(fnSource('incompleteCard'), /class: 'btn', type: 'button', onclick: rereadIncomplete/);
  for (const k of ['inc.title', 'inc.lede', 'inc.reread', 'inc.goOn', 'inc.what', 'inc.failed']) both(k);
  assert.equal(tr('pt', 'inc.title', 1), '1 carteira não foi lida por inteiro');
  // "Ler de novo" vai à rota nova e volta a narrar a leitura; o fim da tarefa decide de novo
  assert.match(fnSource('rereadIncomplete'), /api\('\/api\/reler'/);
  assert.match(SCRIPT, /if \(tarefa === 'reler'\) afterAnalysis\(\);/);
  assert.match(fnSource('endTask'), /tarefa === 'analise' \|\| tarefa === 'reler'/);
});

test('exatidão: depois do envio a tela confere sozinha e diz o que sobrou, sem valor (o valor só na confirmação)', () => {
  const lamportsOf = (v: unknown) => { try { return BigInt((v as string) ?? 0); } catch { return 0n; } };
  const view = new Function('t', 'lamportsOf', `${fnSource('leftoverView')}\nreturn leftoverView;`)((k: string, p?: unknown) => tr('pt', k, p), lamportsOf) as (lo: unknown) => { clean: boolean; wallets: number; list: string[] } | null;
  assert.equal(view(null), null, 'ainda não conferiu');
  assert.deepEqual(view({ lamports: '0', closable: 0, creatorFees: '0', unread: 0, wallets: 0 }), { clean: true, wallets: 0, list: [] });
  const v = view({ lamports: '1500000', closable: 2, creatorFees: '240640', unread: 1, wallets: 3 })!;
  assert.deepEqual(v.list, ['SOL solto', 'contas para fechar', 'creator fees', '1 carteira que a rede não respondeu por inteiro']);
  assert.ok(!v.list.join().match(/\d,\d|0[.,]00/), 'nenhum valor em SOL na lista');
  assert.ok(!/sol\(/.test(fnSource('renderLeftover')), 'a tela final não formata valor da sobra');
  for (const k of ['left.checking', 'left.checkingAt', 'left.clean', 'left.found', 'left.what', 'left.sol', 'left.closable', 'left.fees', 'left.unread', 'left.go', 'left.goHint', 'left.failed', 'left.retry']) both(k);
  // começa sozinha quando o envio acaba; "Limpar o que sobrou" vai à rota e a rodada nova segue para o plano
  assert.match(SCRIPT, /if \(tarefa === 'execucao'\) startLeftoverCheck\(\);/);
  assert.match(fnSource('startLeftoverCheck'), /api\('\/api\/conferir'/);
  assert.match(fnSource('askCleanLeftover'), /api\('\/api\/sobras'/);
  assert.match(fnSource('cleanLeftover'), /afterAnalysis\(\);/);
  assert.match(SCRIPT, /if \(tarefa === 'sobras'\) cleanLeftover\(\);/);
});

test('botões: na linha das etapas (Voltar à esquerda, Recomeçar à direita); "Voltar à preparação" só quando há o que mudar lá; "Recomeçar tudo" sempre', () => {
  // posição (01/11/2026, print do autor: "Recomeçar tudo" solto acima do título, "desalinhado"): dentro do <nav>, na
  // mesma grade das etapas, o mesmo lugar em todas as telas
  const navAt = HTML.indexOf('<nav ');
  const barAt = HTML.indexOf('id="restart"');
  assert.ok(navAt > 0 && barAt > HTML.indexOf('id="steps"') && barAt < HTML.indexOf('</nav>'), 'barra na linha das etapas');
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  assert.match(css, /nav \{[^}]*grid-template-columns: 1fr auto 1fr;/, 'Voltar | etapas | Recomeçar');
  assert.match(css, /#b-voltar \{ grid-column: 1; grid-row: 1; justify-self: start; \}/);
  assert.match(css, /#b-inicio \{ grid-column: -2; grid-row: 1; justify-self: end; \}/);
  assert.match(css, /@media \(max-width: 860px\) \{ #b-voltar, #b-inicio \{ grid-row: 2; \}/, 'celular: etapas em cima, botões embaixo');
  assert.ok(HTML.indexOf('id="b-voltar"') < HTML.indexOf('id="b-inicio"'), 'Voltar à esquerda, Recomeçar à direita');
  for (const k of ['nav.back', 'nav.restart', 'nav.restartArm']) both(k);
  assert.equal(tr('pt', 'nav.restart'), 'Recomeçar tudo');
  const lineOf = (name: string) => SCRIPT.match(new RegExp(`const ${name} = .*`))![0];
  const canGoBack = new Function(`${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('incompleteOf')}\n${lineOf('waitingFrases')}\n${fnSource('canGoBack')}\nreturn canGoBack;`)() as (s: unknown, u: unknown) => boolean;
  const ok = (over: Record<string, unknown> = {}) => ({ n: 1, app: 'solflare', status: 'pronta', wallets: [{ label: 'N=0', unread: [] }], ...over });
  const u = { section: 's-confirmar', goOnIncomplete: false, planBusy: false };
  assert.equal(canGoBack({ frases: [ok()] }, u), false, 'nada pendente: sem "Voltar"');
  assert.equal(canGoBack({ frases: [ok(), ok({ n: 2, status: 'erro' })] }, u), true, 'frase com erro deixada de lado');
  assert.equal(canGoBack({ frases: [ok({ wallets: [{ label: 'N=0', unread: ['x'] }] })] }, { ...u, goOnIncomplete: true }), true, 'seguiu com leitura incompleta');
  assert.equal(canGoBack({ frases: [ok({ app: 'phantom' })] }, u), true, 'contas da Phantom');
  assert.equal(canGoBack({ frases: [ok(), ok({ n: 2, feeWait: { waiting: true } })] }, u), true, 'frase esperando depósito');
  assert.equal(canGoBack({ frases: [ok({ n: 2, status: 'erro' })], execResults: [{}] }, u), false, 'depois de enviar, não');
  assert.equal(canGoBack({ frases: [ok({ n: 2, status: 'erro' })] }, { ...u, section: 's-preparo' }), false, 'só na Confirmar');
  // voltar reabre os cartões (frase com erro, leitura incompleta, revisão da Phantom) sem perder a análise
  assert.match(fnSource('goBack'), /ui\.goOn = false;\s*ui\.goOnIncomplete = false;\s*ui\.reviewed\.clear\(\);\s*afterAnalysis\(\);/);
  assert.match(fnSource('renderRestart'), /\$\('b-voltar'\)\.classList\.toggle\('hidden', !canGoBack\(state, ui\)\)/);
});

test('moedas só em "manter" (achado de um tester): a pessoa escolhe na Confirmar, sem valor e sem botão de enviar, em vez de "Nada para limpar"', () => {
  const only = new Function(`${SCRIPT.match(/const onlyKeptLeft = .*/)![0]}\nreturn onlyKeptLeft;`)() as (s: unknown, d: (h: { r: string }) => string) => boolean;
  const dec = (h: { r: string }) => h.r;
  assert.equal(only({ holdings: [{ r: 'keep' }, { r: 'keep' }], plan: null }, dec), true);
  assert.equal(only({ holdings: [{ r: 'keep' }, { r: 'burn' }], plan: null }, dec), false, 'uma moeda com ação: o erro é outro');
  assert.equal(only({ holdings: [], plan: null }, dec), false, 'sem moeda: é "nada a limpar" de verdade');
  assert.equal(only({ holdings: [{ r: 'keep' }], plan: { frases: [] } }, dec), false);
  assert.match(fnSource('runPlan'), /if \(e\.codigo !== 'no-fee-sol' && onlyKeptLeft\(state, decisionOf\)\) \{ ui\.choosing = true;[^}]*show\('s-confirmar'\); return; \}/);
  const rc = fnSource('renderConfirm');
  const branch = rc.slice(rc.indexOf('if (ui.choosing && !s.plan)'), rc.indexOf('if (sv.allEmpty)'));
  assert.match(branch, /tokensBlock\(v\)/, 'as moedas para escolher');
  assert.match(branch, /\$\('c-box'\)\.classList\.add\('hidden'\)/, 'sem destino nem botão de enviar');
  assert.doesNotMatch(branch, /sol\(/, 'sem valor');
  for (const k of ['conf.chooseLede', 'conf.chooseTitle', 'conf.chooseText']) both(k);
});

test('layout (01/11/2026): botão secundário com fundo sólido, bolinha de "esperando" sem retângulo, cartões com espaço entre si, botões pequenos com área de toque', () => {
  const css = HTML.slice(0, HTML.indexOf('</style>'));
  // corpo da regra CSS que começa a linha com o seletor exato
  const rule = (sel: string) => {
    const at = css.split(/\r?\n/).find((l) => l.startsWith(`${sel} {`));
    return at ?? '';
  };
  assert.doesNotMatch(rule('.btn.quiet'), /background: transparent/, 'transparente, o efeito de fundo aparecia através do botão');
  assert.match(rule('.btn.quiet'), /background: var\(--surface\)/);
  assert.match(rule('.pulse'), /display: inline-block/, 'span sem tamanho virava um retângulo escuro');
  assert.doesNotMatch(fnSource('singleCard'), /class: 'wait-line'[^\n]*class: 'pulse'/, 'o .wait-line já tem a bolinha: sem a segunda');
  assert.match(css, /#p-cards, #c-tokens, #c-phantom, #x-sobras \{ display: grid; gap: 16px; \}/, 'cartões desenhados pela página separados por 16px');
  assert.match(rule('.btn.small'), /min-height: 36px/);
  assert.match(rule('.copy'), /min-height: 34px/);
  // "Simular agora sem…" dentro do cartão do depósito, e nunca no meio do repasse (print de 01/11/2026)
  const prep = fnSource('renderPrep');
  assert.match(prep, /const canSkip = [^\n]*\(state\.single\.status === 'esperando' \|\| state\.single\.status === 'falhou'\)/);
  assert.doesNotMatch(prep, /cards\.push\(el\('div', \{ class: 'row' \}, el\('button', \{ class: 'btn quiet', type: 'button', onclick: simulateWithout/, 'sem o botão solto entre os cartões');
  assert.match(fnSource('singleCard'), /skipButton\) : null\);/);
});

// terceiro ramo (m/44'/501'/i', Trust e Phantom antiga), 06/11/2026: nome no cartão, irmãs, e a conferência da Phantom
test('análise: Trust ou Phantom antiga no cartão, como irmã, e na conferência', async () => {
  type RowD = Row & { appName: D; note?: D | null };
  const row = (f: Record<string, unknown>) => A.fraseRowView({ n: 1, app: 'solflare', status: 'pronta', auto: true, discovery: { found: 2 }, ...f } as F, null) as RowD;
  const phantomWord = fnSource('fraseRow').match(/phantom: ([^}]*) \}\);/)![1];
  assert.equal(phantomWord, "r.app === 'phantom' || r.app === 'trust'", 'Trust conta "contas", como a Phantom');
  const text = (lang: 'pt' | 'en', r: RowD) => tr(lang, r.head.key, { ...r.head.params, app: tr(lang, r.appName.key, r.appName.params), phantom: r.app === 'phantom' || r.app === 'trust' });
  const trust = row({ app: 'trust', detected: 'trust' });
  assert.equal(trust.app, 'trust');
  assert.equal(text('pt', trust), 'Trust ou Phantom antiga · 2 contas');
  assert.equal(text('en', trust), 'Trust or older Phantom · 2 accounts');
  const irma = row({ n: 7, app: 'trust', auto: false, detected: 'ambas', pairOf: 3 });
  assert.equal(text('pt', irma), 'Trust ou Phantom antiga (mesma frase da 3) · 2 contas');
  assert.equal(text('en', irma), 'Trust or older Phantom (same phrase as 3) · 2 accounts');
  // a frase colada aponta as duas irmãs
  const colada = row({ detected: 'ambas', pair: 6, pairs: [{ n: 6, app: 'phantom' }, { n: 7, app: 'trust' }] });
  assert.equal(tr('pt', colada.note!.key, colada.note!.params), 'a mesma frase também tem contas da Phantom: frase 6; contas da Trust ou Phantom antiga: frase 7');
  assert.equal(tr('en', colada.note!.key, colada.note!.params), 'the same phrase also has Phantom accounts: phrase 6; Trust or older Phantom accounts: phrase 7');
  const soTrust = row({ detected: 'ambas', pair: 5, pairs: [{ n: 5, app: 'trust' }] });
  assert.equal(tr('pt', soTrust.note!.key, soTrust.note!.params), 'a mesma frase também tem contas da Trust ou Phantom antiga: frase 5');
  // dado fora do formato não derruba a linha: cai no texto de antes
  const suja = row({ detected: 'ambas', pair: 6, pairs: [null, { n: 'x' }, 7] });
  assert.equal(tr('pt', suja.note!.key, suja.note!.params), 'a mesma frase também tem contas da Phantom: frase 6');
  for (const k of ['app.trust', 'app.pairTrust']) both(k);
  // a mesma regra de src/core/carteiras/derivation.ts (needsReview): página e servidor batem app a app
  const { needsReview } = await import('../../src/core/carteiras/derivation.ts');
  const pageNeeds = new Function(`${SCRIPT.match(/const needsReview = .*/)![0]}\nreturn needsReview;`)() as (a: string) => boolean;
  for (const app of ['solflare', 'phantom', 'trust', 'chaves'] as const) assert.equal(pageNeeds(app), needsReview(app), app);
  // a Trust pede a conferência das contas, manda a seleção no plano e deixa voltar da Confirmar
  const lineOf = (name: string) => SCRIPT.match(new RegExp(`const ${name} = .*`))![0];
  const prepNeeds = new Function(`${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('incompleteOf')}\n${fnSource('prepNeeds')}\nreturn prepNeeds;`)() as (s: unknown, u: unknown) => { review: number[] };
  const fr = (n: number, app: string) => ({ n, app, status: 'pronta', wallets: [{ label: 'Conta 2', unread: [] }] });
  const s = { frases: [fr(1, 'solflare'), fr(2, 'phantom'), fr(3, 'trust')] };
  assert.deepEqual(prepNeeds(s, { goOn: false, goOnIncomplete: false, reviewed: new Set() }).review, [2, 3]);
  assert.match(fnSource('phantomPayload'), /if \(!needsReview\(f\.app\) \|\| !plannable\(f\)\) continue;/);
  const canGoBack = new Function(`${lineOf('needsReview')}\n${lineOf('plannable')}\n${lineOf('incompleteOf')}\n${lineOf('waitingFrases')}\n${fnSource('canGoBack')}\nreturn canGoBack;`)() as (s: unknown, u: unknown) => boolean;
  assert.equal(canGoBack({ frases: [fr(1, 'trust')] }, { section: 's-confirmar', goOnIncomplete: false, planBusy: false }), true);
  assert.match(fnSource('renderConfirm'), /filter\(\(f\) => needsReview\(f\.app\) && plannable\(f\)\)/, 'a Confirmar lista o que será limpo na Trust');
});
