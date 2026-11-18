// Painel do autor, visão de dono (17/11/2026): períodos com comparação, série diária completa, coortes, horários em
// Brasília, meta do mês, atividade recente, uso × clientes, preço do SOL e o modo demonstração.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  alerts,
  feeDaily,
  FEE_SHARE,
  LAMPORTS,
  monthPace,
  parsePrice,
  parseProxyStats,
  periodSummary,
  recentCleanups,
  usageSummary,
  weeklyCohorts,
  BETA_START,
  failuresByDay,
  activityByDay,
  activityTotals,
  historyBuckets,
  parseWalletList,
  records,
  type FeeTx,
  type Health,
} from '../../scripts/painel/metricas.ts';
import { demoProxy, demoReleases, demoTxs } from '../../scripts/painel/demo.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 17, 15); // terça, 17/11/2026, 15h UTC = 12h em Brasília
const L = LAMPORTS;
const healthy: Health = { proxy: 'ok', site: 'ok', atualizacao: { kind: 'ok', versao: '1.0.1' } };

// A: entrou há 20 dias e voltou hoje; B: entrou há 3 dias; C: só hoje. Mais um saque e um depósito (não são receita).
const txs: FeeTx[] = [
  { sig: 'a1', t: NOW - 20 * DAY, fee: 1 * L, dest: 'A' },
  { sig: 'b1', t: NOW - 3 * DAY, fee: 0.5 * L, dest: 'B' },
  { sig: 'a2', t: NOW - 60_000, fee: 0.25 * L, dest: 'A' },
  { sig: 'c1', t: NOW - 30_000, fee: 0.011 * L, dest: 'C' },
  { sig: 'saque', t: NOW - 2 * DAY, fee: -1 * L, dest: null },
  { sig: 'dep', t: NOW - 25 * DAY, fee: 0.1 * L, dest: null },
];

test('visão de dono: período atual × anterior, volume pela taxa de 11%, novos e que voltaram', () => {
  const p = periodSummary(txs, NOW, 7);
  assert.equal(p.limpezas, 3);
  assert.equal(p.receita, 0.761);
  assert.ok(Math.abs(p.volume - 0.761 / FEE_SHARE) < 1e-9, 'volume = taxa ÷ 0,11');
  assert.equal(p.clientes, 3);
  assert.equal(p.novos, 2, 'B e C entraram na janela; A já era cliente');
  assert.equal(p.retornaram, 1);
  assert.ok(Math.abs(p.ticket - 0.761 / 3) < 1e-12);
  // janela anterior (7 a 14 dias atrás): nada; a 30 dias pega a 1ª limpeza do A
  assert.equal(p.anterior!.limpezas, 0);
  assert.equal(periodSummary(txs, NOW, 30).limpezas, 4);
  assert.equal(periodSummary(txs, NOW, 30).novos, 3);
  const p14 = periodSummary(txs, NOW, 14);
  assert.equal(p14.anterior!.receita, 1, 'a limpeza de 20 dias atrás cai na janela anterior de 14 dias');
  // "tudo": sem janela anterior; saque e depósito nunca contam
  const all = periodSummary(txs, NOW, null);
  assert.equal(all.anterior, null);
  assert.equal(all.receita, 1.761);
  assert.equal(all.limpezas, 4);
});

test('visão de dono: horários em Brasília (UTC−3), faixas de tamanho e concentração nos 5 maiores', () => {
  const p = periodSummary(txs, NOW, 7);
  // NOW = terça 15h UTC = terça 12h em Brasília (a1 fica fora da janela de 7 dias)
  assert.equal(p.horas[2]![11]! + p.horas[2]![12]!, 2, 'as duas de hoje entre 11h e 12h59 de Brasília, numa terça');
  assert.equal(p.horas.flat().reduce((a, b) => a + b, 0), 3);
  // virada do dia: 02h UTC de quarta = 23h de terça em Brasília
  const late = periodSummary([{ sig: 'x', t: Date.UTC(2026, 10, 18, 2), fee: 1000, dest: 'Z' }], Date.UTC(2026, 10, 18, 3), 1);
  assert.equal(late.horas[2]![23], 1);
  // faixas pelo volume recuperado (taxa ÷ 0,11): 0,011 → 0,1 SOL (2ª faixa: 0,1 não é "até 0,1"), 0,25 → 2,27, 0,5 → 4,5
  assert.deepEqual(p.tamanhos.map((b) => b.limpezas), [0, 1, 0, 2, 0]);
  assert.equal(p.tamanhos.reduce((a, b) => a + b.limpezas, 0), p.limpezas, 'toda limpeza cai em uma faixa');
  assert.ok(Math.abs(p.maiorLimpeza - 0.5 / FEE_SHARE) < 1e-9);
  assert.equal(p.top5, 1, 'com 3 clientes, os 5 maiores são todos');
  const many: FeeTx[] = Array.from({ length: 10 }, (_, i) => ({ sig: `m${i}`, t: NOW - 1000, fee: (i < 5 ? 9 : 1) * L, dest: `D${i}` }));
  assert.equal(periodSummary(many, NOW, 7).top5, 0.9);
  assert.equal(periodSummary([], NOW, 7).top5, 0);
});

test('visão de dono: série diária completa (desde a 1ª limpeza, mínimo 90 dias) com novos e retornos por dia', () => {
  const s = feeDaily(txs, NOW);
  assert.equal(s.length, 90);
  assert.equal(s.at(-1)!.dia, '2026-11-17');
  const today = s.at(-1)!;
  assert.deepEqual([today.limpezas, today.clientes, today.novos, today.retornos], [2, 2, 1, 1]);
  assert.equal(today.receita, 0.261);
  assert.equal(s.reduce((a, d) => a + d.limpezas, 0), 4, 'saque e depósito fora');
  assert.equal(s.reduce((a, d) => a + d.novos, 0), 3);
  // histórico mais longo que 90 dias: a série começa no dia da 1ª limpeza
  const old = feeDaily([{ sig: 'o', t: NOW - 200 * DAY, fee: 5, dest: 'O' }], NOW);
  assert.equal(old.length, 201);
  assert.equal(old[0]!.limpezas, 1);
  // dado sujo não derruba: tempo inválido e destino ausente ficam de fora
  const dirty = feeDaily([{ sig: 'n', t: Number.NaN, fee: 5, dest: 'X' }, { sig: 'd', t: NOW, fee: 5, dest: null }, ...txs], NOW);
  assert.equal(dirty.reduce((a, d) => a + d.limpezas, 0), 4);
});

test('visão de dono: coortes semanais (semana de entrada e retorno nas semanas seguintes)', () => {
  const co = weeklyCohorts(txs, NOW);
  // semanas começam na segunda: 16/11 (B? não: B entrou em 14/11, sábado → semana de 09/11)
  assert.deepEqual(co.map((c) => [c.semana, c.tamanho]), [['2026-10-26', 1], ['2026-11-09', 1], ['2026-11-16', 1]]);
  const a = co[0]!;
  assert.equal(a.retencao[0], 1);
  assert.equal(a.retencao.length, 4, '26/10, 02/11, 09/11, 16/11');
  assert.deepEqual(a.retencao, [1, 0, 0, 1], 'A voltou na semana de 16/11');
  assert.deepEqual(co[1]!.retencao, [1, 0]);
  assert.deepEqual(weeklyCohorts([], NOW), []);
});

test('visão de dono: ritmo do mês (projeção pela média por dia decorrido) e mês anterior', () => {
  const m = monthPace(txs, NOW);
  assert.equal(m.mes, '2026-11');
  assert.equal(m.diasNoMes, 30);
  assert.ok(Math.abs(m.diasPassados - 16.625) < 1e-9, '17/11 às 15h = 16 dias e 15 horas');
  assert.equal(m.receita, 0.761);
  assert.ok(Math.abs(m.projecao - (0.761 / 16.625) * 30) < 1e-9);
  assert.equal(m.mesAnterior, 1, 'a limpeza de 28/10');
  // antes de completar 1 dia, a projeção é a própria receita (não multiplica poucas horas)
  const early = monthPace([{ sig: 'e', t: Date.UTC(2026, 11, 1, 2), fee: L, dest: 'E' }], Date.UTC(2026, 11, 1, 6));
  assert.equal(early.projecao, 1);
  assert.equal(early.diasNoMes, 31);
});

test('visão de dono: atividade recente (mais recente primeiro, "novo" só na 1ª do cliente, sem endereço)', () => {
  const r = recentCleanups(txs, 3);
  assert.deepEqual(r.map((x) => x.sig), ['c1', 'a2', 'b1']);
  assert.deepEqual(r.map((x) => x.novo), [true, false, true]);
  assert.equal(r[1]!.cliente, 'A');
  assert.ok(Math.abs(r[0]!.volume - 0.1) < 1e-9);
  const hashed = recentCleanups([{ sig: 's', t: NOW, fee: 1, dest: '0123456789abcdef' }]);
  assert.equal(hashed[0]!.cliente, '012345', 'só os 6 primeiros caracteres do hash');
});

test('visão de dono: uso do proxy × clientes pagantes, conversão só nos dias que o proxy registrou', () => {
  // um cliente pagou em 16/11, dia que o proxy não registrou (ex.: usou o RPC público): fica fora da conversão
  const daily = feeDaily([...txs, { sig: 'sem-proxy', t: NOW - DAY, fee: L, dest: 'Q' }], NOW);
  const p = parseProxyStats({
    hoje: { dia: '2026-11-17', pedidos: 100, creditos: 140, ips: 4, metodos: { sendTransaction: 9 }, versoes: {}, recusas: {}, eventos: {} },
    historico: [{ dia: '2026-11-14', pedidos: 10, creditos: 14, ips: 6, metodos: { sendTransaction: 1 }, versoes: {}, recusas: {}, eventos: {} }],
    chaves: [],
    limites: {},
  })!;
  const u = usageSummary(p, daily, 7);
  assert.equal(u.serie.length, 7);
  assert.equal(u.diasComProxy, 2);
  assert.equal(u.pessoasMedia, 5);
  assert.equal(u.envios, 10);
  assert.equal(u.conversao, 3 / 10, '(2 clientes hoje + 1 em 14/11) ÷ (4 + 6 pessoas)');
  const none = usageSummary(null, daily, 7);
  assert.equal(none.conversao, null);
  assert.equal(none.pessoasMedia, 0);
});

test('visão de dono: preço do SOL conferido (fora de faixa ou fora do formato = sem preço)', () => {
  assert.deepEqual(parsePrice({ solana: { usd: 182.4, brl: 1043.9 } }), { usd: 182.4, brl: 1043.9 });
  for (const bad of [null, {}, { solana: {} }, { solana: { usd: '182', brl: 1000 } }, { solana: { usd: 0, brl: 1 } }, { solana: { usd: 1e9, brl: 1 } }, { solana: { usd: Number.NaN, brl: 1 } }, { status: { error_code: 429 } }]) {
    assert.equal(parsePrice(bad), null, JSON.stringify(bad));
  }
});

test('visão de dono: alerta quando a receita da semana cai pela metade', () => {
  const weekNow: FeeTx[] = [
    { sig: '1', t: NOW - 10 * DAY, fee: 1 * L, dest: 'A' },
    { sig: '2', t: NOW - DAY, fee: 0.3 * L, dest: 'B' },
  ];
  const semana = periodSummary(weekNow, NOW, 7);
  const txt = alerts({ now: NOW, proxy: null, proxyErro: null, health: healthy, releases: null, fee: null, semana }).map((a) => a.texto).join('\n');
  assert.match(txt, /receita dos últimos 7 dias caiu 70%/);
  const steady = periodSummary([...weekNow, { sig: '3', t: NOW - 2 * DAY, fee: 0.5 * L, dest: 'C' }], NOW, 7);
  assert.doesNotMatch(alerts({ now: NOW, proxy: null, proxyErro: null, health: healthy, releases: null, fee: null, semana: steady }).map((a) => a.texto).join('\n'), /caiu/);
  // base pequena demais (poeira) não alerta
  const tiny = periodSummary([{ sig: 't', t: NOW - 10 * DAY, fee: 0.01 * L, dest: 'T' }], NOW, 7);
  assert.equal(alerts({ now: NOW, proxy: null, proxyErro: null, health: healthy, releases: null, fee: null, semana: tiny }).length, 0);
});

test('visão de dono: modo demonstração monta tudo sem rede, sem endereço real e sem número quebrado', async () => {
  const { buildData } = await import('../../scripts/painel-admin.ts');
  const data = buildData({
    now: NOW,
    txs: demoTxs(NOW),
    taxaErro: null,
    proxy: demoProxy(NOW),
    proxyErro: null,
    releases: demoReleases(),
    saude: { ...healthy, proxyMs: 100 },
    preco: { usd: 180, brl: 1000 },
    saldo: 1,
    demo: true,
  });
  const json = JSON.stringify(data);
  assert.ok(!/NaN|Infinity|null,"volume"/.test(json));
  assert.deepEqual(Object.keys(data.periodos!), ['7', '30', '90', 'tudo']);
  assert.ok(data.periodos!['30']!.limpezas > 50 && data.periodos!['30']!.anterior !== null);
  assert.ok(data.serie.length >= 90 && data.coortes.length > 0 && data.recentes.length === 30);
  // determinístico (semente fixa): a mesma demonstração sempre
  assert.equal(JSON.stringify(demoTxs(NOW)), JSON.stringify(demoTxs(NOW)));
  // o demo.ts não faz consulta à rede
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'painel', 'demo.ts'), 'utf8');
  assert.ok(!/fetch\(|https?:\/\//.test(src));
});

test('histórico: lista de carteiras antigas (fora do repositório) com data de início; linha ruim é pulada', () => {
  const CUR = 'Atua1111111111111111111111111111111111111111';
  const OLD = 'Antg1111111111111111111111111111111111111111';
  const list = parseWalletList(['# comentário', '', `${OLD} 2026-10-30`, 'nao-e-endereco', `${CUR}`, `${OLD}`, 'Nova1111111111111111111111111111111111111111 ontem', '  Mais1111111111111111111111111111111111111111   # sem data'].join('\r\n'), CUR);
  assert.deepEqual(list.map((w) => w.endereco), [OLD, 'Nova1111111111111111111111111111111111111111', 'Mais1111111111111111111111111111111111111111']);
  assert.equal(list[0]!.desde, Date.UTC(2026, 9, 30));
  assert.equal(list[1]!.desde, BETA_START, 'data inválida: desde o início da beta');
  assert.equal(list[2]!.desde, BETA_START);
  assert.deepEqual(parseWalletList('', CUR), []);
});

test('histórico: semanas e meses desde a 1ª limpeza, receita por carteira e falhas no período', () => {
  const h: FeeTx[] = [
    { sig: '1', t: Date.UTC(2026, 9, 30, 12), fee: 1 * L, dest: 'A', w: 1 }, // sexta 30/10 → semana de 26/10
    { sig: '2', t: Date.UTC(2026, 10, 2, 12), fee: 0.5 * L, dest: 'A', w: 1 }, // segunda 02/11
    { sig: '3', t: Date.UTC(2026, 10, 10, 12), fee: 0.25 * L, dest: 'B', w: 0 },
    { sig: '4', t: Date.UTC(2026, 10, 11, 12), fee: 0.25 * L, dest: 'C', w: 1 },
    { sig: 'saque', t: Date.UTC(2026, 10, 3), fee: -1 * L, dest: null, w: 1 },
  ];
  const failed = [{ t: Date.UTC(2026, 10, 10, 1) }, { t: Date.UTC(2026, 10, 10, 2) }];
  const w = historyBuckets(h, NOW, 'semana', failed);
  assert.deepEqual(w.map((r) => r.inicio), ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  assert.deepEqual(w.map((r) => r.receita), [1, 0.5, 0.5, 0]);
  assert.deepEqual(w.map((r) => r.novos), [1, 0, 2, 0], 'A entrou em 26/10; voltou em 02/11 sem contar como novo');
  assert.deepEqual(w[2]!.porCarteira, [0.25, 0.25]);
  assert.deepEqual(w[0]!.porCarteira, [0, 1]);
  assert.deepEqual(w.map((r) => r.falhas), [0, 0, 2, 0]);
  assert.equal(w[3]!.fim, '2026-11-17', 'a semana corrente termina hoje');
  const m = historyBuckets(h, NOW, 'mes');
  assert.deepEqual(m.map((r) => [r.inicio, r.receita, r.limpezas]), [['2026-10-01', 1, 1], ['2026-11-01', 1, 3]]);
  assert.equal(m[1]!.fim, '2026-11-17');
  assert.deepEqual(historyBuckets([], NOW, 'mes'), []);
  // transação sem carteira marcada conta como a atual
  assert.deepEqual(historyBuckets([{ sig: 'x', t: NOW, fee: L, dest: 'X' }], NOW, 'semana')[0]!.porCarteira, [1]);
});

test('histórico: recordes (melhor dia e semana, maior limpeza, taxa de sucesso) e falhas por dia', () => {
  const h: FeeTx[] = [
    { sig: '1', t: Date.UTC(2026, 10, 2, 12), fee: 0.2 * L, dest: 'A' },
    { sig: '2', t: Date.UTC(2026, 10, 2, 13), fee: 0.2 * L, dest: 'B' },
    { sig: '3', t: Date.UTC(2026, 10, 10, 12), fee: 0.33 * L, dest: 'A' },
  ];
  const failed = [{ t: Date.UTC(2026, 10, 2, 1) }];
  const r = records(h, NOW, failed);
  assert.equal(r.melhorDia!.dia, '2026-11-02');
  assert.ok(Math.abs(r.melhorDia!.receita - 0.4) < 1e-12);
  assert.equal(r.maisLimpezasDia!.limpezas, 2);
  assert.equal(r.melhorSemana!.inicio, '2026-11-02');
  assert.ok(Math.abs(r.maiorLimpeza!.volume - 3) < 1e-9, '0,33 ÷ 0,11');
  assert.equal(r.diasComLimpeza, 2);
  assert.equal(r.clientesTotal, 2);
  assert.equal(r.sucesso, 3 / 4);
  assert.equal(records([], NOW).sucesso, null);
  assert.equal(records([], NOW).melhorDia, null);
  const daily = feeDaily(h, NOW);
  const f = failuresByDay([...failed, { t: Number.NaN }], daily);
  assert.equal(f.length, daily.length);
  assert.equal(f[daily.findIndex((d) => d.dia === '2026-11-02')], 1);
  assert.equal(f.reduce((a, b) => a + b, 0), 1, 'hora inválida não conta');
});

test('histórico: atividade pela lista de assinaturas (sem erro × com erro, por dia e por carteira)', () => {
  const day = (d: number, h = 12) => Date.UTC(2026, 10, d, h);
  const seen = [
    { t: day(16), ok: true, w: 1 },
    { t: day(16, 13), ok: true, w: 1 },
    { t: day(16, 14), ok: false, w: 1 },
    { t: day(17), ok: true }, // sem carteira = a atual
    { t: Number.NaN, ok: true, w: 1 }, // hora inválida não conta
  ];
  const daily = feeDaily([], NOW, 3);
  const a = activityByDay(seen, daily);
  assert.deepEqual(daily.map((d) => d.dia), ['2026-11-15', '2026-11-16', '2026-11-17']);
  assert.deepEqual(a.ok, [0, 2, 1]);
  assert.deepEqual(a.erro, [0, 1, 0]);
  const t = activityTotals(seen);
  assert.deepEqual([t.total, t.ok, t.erro], [4, 3, 1]);
  assert.equal(t.sucesso, 0.75);
  assert.deepEqual(t.porCarteira, [{ total: 1, ok: 1 }, { total: 3, ok: 2 }]);
  assert.equal(activityTotals([]).sucesso, null);
});

test('histórico: a carteira antiga fica no arquivo do autor, fora do código', () => {
  // o endereço (e qualquer hash dele) está na lista privada de scripts/publicar-proibidos.txt: test/publico.test.ts
  // derruba a publicação se ele aparecer em qualquer arquivo público. Aqui, só que o painel lê do arquivo do autor.
  const root = path.join(import.meta.dirname, '..', '..');
  const src = fs.readFileSync(path.join(root, 'scripts', 'painel-admin.ts'), 'utf8');
  assert.match(src, /OLD_WALLETS_FILE = path\.join\(CACHE_DIR, 'carteiras-antigas\.txt'\)/);
});

test('visão de dono: página com período, moeda, meta e a faixa de demonstração; texto de fora só por textContent', () => {
  const page = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'painel', 'painel.html'), 'utf8');
  for (const v of ['7', '30', '90', 'tudo']) assert.ok(page.includes(`name="periodo" value="${v}"`), `período ${v}`);
  for (const v of ['SOL', 'USD', 'BRL']) assert.ok(page.includes(`name="moeda" value="${v}"`), `moeda ${v}`);
  assert.ok(page.includes('id="goal"') && page.includes('id="demo" hidden'));
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/.test(page));
  assert.ok(!/\sstyle="/.test(page), 'sem atributo style no HTML (a CSP só deixa CSSOM)');
  // a meta, o período e a moeda ficam só neste navegador, sempre dentro de try
  assert.match(page, /get\(k\) \{ try \{ return localStorage\.getItem\(k\); \} catch/);
});
