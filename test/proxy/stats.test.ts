// Estatísticas do proxy para o painel do autor (16/11/2026): GET /stats com token, só números, nada do usuário.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cotas, Counter, HISTORY_DAYS, MAX_VERSIONS, emptyStats, parseStats, type ConsumeRequest } from '../../proxy/cotas.ts';
import { MIN_STATS_TOKEN, PROBE_BODY, type Env } from '../../proxy/worker.ts';
import { call, json, makeWorld, rpcRequest, SECRET, UPSTREAM, VERSION } from './helpers.ts';

const TOKEN = 'tk_' + 'a1b2c3d4'.repeat(5); // 43 caracteres
const statsReq = (token: string | null = TOKEN, init: RequestInit = {}) =>
  new Request('https://rpc.clurn.app/stats', { method: 'GET', headers: token === null ? {} : { authorization: `Bearer ${token}` }, ...init });

async function unknownPath(w: ReturnType<typeof makeWorld>) {
  return json(await w.send(new Request('https://rpc.clurn.app/outro', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clurn-versao': VERSION }, body: '{}' })));
}

test('stats: sem STATS_TOKEN, token curto, token errado, sem token ou POST → o mesmo 404 de caminho desconhecido', async () => {
  const semToken = makeWorld();
  const ref = await unknownPath(semToken);
  assert.equal(ref.status, 404);
  const cases: Array<[Partial<Env>, Request]> = [
    [{}, statsReq()],
    [{ STATS_TOKEN: 'x'.repeat(MIN_STATS_TOKEN - 1) }, statsReq('x'.repeat(MIN_STATS_TOKEN - 1))],
    [{ STATS_TOKEN: TOKEN }, statsReq(TOKEN + 'x')],
    [{ STATS_TOKEN: TOKEN }, statsReq(TOKEN.slice(0, -1))],
    [{ STATS_TOKEN: TOKEN }, statsReq(null)],
    [{ STATS_TOKEN: TOKEN }, statsReq(TOKEN, { method: 'POST', body: '{}' })],
    [{ STATS_TOKEN: TOKEN }, new Request('https://rpc.clurn.app/stats', { headers: { authorization: TOKEN } })], // sem "Bearer"
  ];
  for (const [env, r] of cases) {
    const res = await json(await makeWorld(env).send(r));
    assert.equal(res.status, 404, JSON.stringify(env));
    assert.deepEqual(res.body, ref.body, 'indistinguível de um caminho que não existe');
  }
});

test('stats: com o token, conta pedidos, créditos, métodos, versões, IPs distintos e recusas; nada do usuário na resposta', async () => {
  const w = makeWorld({ STATS_TOKEN: TOKEN, LIMITE_IP_SEGUNDO: '3' });
  const ipA = '203.0.113.7';
  const ipB = '198.51.100.23';
  await w.send(rpcRequest(call('getLatestBlockhash'), { 'cf-connecting-ip': ipA }));
  await w.send(rpcRequest([call('getAccountInfo', ['EnderecoDoUsuario111']), call('sendTransaction', ['TransacaoAssinada=='])], { 'cf-connecting-ip': ipA }));
  await w.send(rpcRequest(call('getProgramAccounts'), { 'cf-connecting-ip': ipB, 'x-clurn-versao': '1.0.0' }));
  // 4º item do IP A no mesmo segundo: recusado pelo limite por segundo (3)
  const refused = await w.send(rpcRequest(call('getLatestBlockhash'), { 'cf-connecting-ip': ipA }));
  assert.equal(refused.status, 429);

  const res = await json(await w.send(statsReq()));
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const h = res.body.hoje;
  assert.equal(h.dia, '2026-11-09');
  assert.equal(h.pedidos, 4, 'itens servidos (o lote conta cada um)');
  assert.equal(h.creditos, 3 + 10, 'getProgramAccounts vale 10');
  assert.equal(h.ips, 2, 'IPs distintos, só o número');
  assert.deepEqual(h.metodos, { getLatestBlockhash: 1, getAccountInfo: 1, sendTransaction: 1, getProgramAccounts: 1 });
  assert.deepEqual(h.versoes, { [VERSION]: 3, '1.0.0': 1 });
  assert.equal(h.recusas.segundo, 1);
  assert.deepEqual(res.body.chaves, [{ posicao: 1, pausadaAte: null }]);
  assert.equal(res.body.limites.porIpSegundo, 3);
  for (const s of [ipA, ipB, '203.0.113', 'EnderecoDoUsuario', 'TransacaoAssinada', SECRET, UPSTREAM, 'helius']) {
    assert.ok(!res.text.includes(s), `a resposta não tem ${s}`);
  }
});

test('stats: chave pausada aparece pela posição (nunca a URL) e os eventos do upstream são contados', async () => {
  const K = ['https://mainnet.helius-rpc.com/?api-key=CHAVE-UM-0000000001', 'https://mainnet.helius-rpc.com/?api-key=CHAVE-DOIS-00000002'];
  let fora = false;
  const w = makeWorld({ STATS_TOKEN: TOKEN, UPSTREAM_URL: undefined, UPSTREAM_URLS: K.join('\n') });
  w.deps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (fora) throw new TypeError('fetch failed');
    const body = String(init?.body ?? '');
    if (String(url) === K[0]) return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32429,"message":"max usage reached"}}', { status: 429 });
    return new Response(body === PROBE_BODY ? '{"result":"x"}' : '{"jsonrpc":"2.0","id":1,"result":2}', { status: 200 });
  }) as typeof fetch;
  assert.equal((await json(await w.send(rpcRequest(call('getLatestBlockhash'))))).body.result, 2, 'a 2ª chave atendeu');
  w.advance(1000);
  fora = true;
  assert.equal((await w.send(rpcRequest(call('getLatestBlockhash')))).status, 502);

  const res = await json(await w.send(statsReq()));
  assert.equal(res.body.chaves[0].posicao, 1);
  assert.equal(typeof res.body.chaves[0].pausadaAte, 'number', 'a 1ª ficou pausada');
  assert.equal(res.body.chaves[1].pausadaAte, null);
  assert.equal(res.body.hoje.eventos['chave-pausada'], 1);
  assert.equal(res.body.hoje.eventos['upstream-fora'], 1);
  for (const k of ['CHAVE-UM', 'CHAVE-DOIS', 'api-key']) assert.ok(!res.text.includes(k));
});

test('stats: todas as chaves sem crédito contam "sem-chave"', async () => {
  const w = makeWorld({ STATS_TOKEN: TOKEN }, { reply: () => new Response('{"error":{"message":"max usage reached"}}', { status: 429 }) });
  assert.equal((await w.send(rpcRequest(call('getLatestBlockhash')))).status, 429);
  const res = await json(await w.send(statsReq()));
  assert.equal(res.body.hoje.eventos['sem-chave'], 1);
});

test('stats: sobrevivem ao objeto reiniciar e à virada do dia (o dia fechado vai para o histórico com os IPs daquele dia)', async () => {
  const w = makeWorld({ STATS_TOKEN: TOKEN });
  await w.send(rpcRequest(call('getLatestBlockhash'), { 'cf-connecting-ip': '203.0.113.1' }));
  await w.send(rpcRequest(call('getLatestBlockhash'), { 'cf-connecting-ip': '203.0.113.2' }));
  await w.cotas.alarm();
  // objeto novo com o mesmo armazenamento (reinício)
  const again = new Cotas({ storage: w.mem.storage });
  w.env.COTAS = { idFromName: (n: string) => n, get: () => ({ fetch: async (i: Request | string, init?: RequestInit) => again.fetch(new Request(i, init)) }) };
  w.advance(24 * 3_600_000); // dia seguinte
  await w.send(rpcRequest(call('getLatestBlockhash'), { 'cf-connecting-ip': '203.0.113.9' }));
  await again.alarm();
  const res = await json(await w.send(statsReq()));
  assert.equal(res.body.hoje.dia, '2026-11-10');
  assert.equal(res.body.hoje.pedidos, 1);
  assert.equal(res.body.hoje.ips, 1);
  assert.equal(res.body.historico.length, 1);
  assert.equal(res.body.historico[0].dia, '2026-11-09');
  assert.equal(res.body.historico[0].pedidos, 2);
  assert.equal(res.body.historico[0].ips, 2);
  assert.ok(![...w.mem.data.keys()].some((k) => k.includes('203.0.113.1')), 'os IPs do dia anterior saíram do armazenamento');
});

const NOON = Date.UTC(2026, 10, 9, 12, 0, 0);
const req = (over: Partial<ConsumeRequest> = {}): ConsumeRequest => ({ key: 'k', requests: 1, credits: 1, now: NOON, perSecond: 1e9, perIpDay: 1e9, globalHour: 1e12, globalDay: 1e12, ...over });

test('stats: histórico guarda no máximo HISTORY_DAYS dias (os mais velhos saem)', () => {
  const c = new Counter();
  for (let d = 0; d < HISTORY_DAYS + 10; d++) c.consume(req({ now: NOON + d * 86_400_000 }));
  assert.equal(c.history.size, HISTORY_DAYS);
  const days = [...c.history.keys()].sort();
  // 100 dias: o último é "hoje" (não fechou), 99 fecharam e ficam os 90 mais novos (do dia 9 ao 98)
  assert.equal(days[0], new Date(NOON + 9 * 86_400_000).toISOString().slice(0, 10), 'os 9 mais velhos saíram');
  assert.equal(days.at(-1), new Date(NOON + 98 * 86_400_000).toISOString().slice(0, 10));
});

test('stats: versões e métodos têm limite (pedido falso não enche a memória) e nome fora do formato é ignorado', () => {
  const c = new Counter();
  for (let i = 0; i < MAX_VERSIONS + 20; i++) c.consume(req({ key: `k${i}`, version: `0.${i}.0`, methods: { getLatestBlockhash: 1 } }));
  assert.equal(Object.keys(c.stats.versoes).length, MAX_VERSIONS + 1, 'o resto vai para "outro"');
  assert.equal(c.stats.versoes.outro, 20);
  c.consume(req({ key: 'z', version: '<script>', methods: { 'x y': 5, ['a'.repeat(100)]: 1, getAccountInfo: -1, sendTransaction: 2 } }));
  assert.ok(!Object.keys(c.stats.versoes).includes('<script>'));
  assert.deepEqual(c.stats.metodos, { getLatestBlockhash: MAX_VERSIONS + 20, sendTransaction: 2 });
});

test('stats: dado gravado fora do formato é ignorado sem derrubar o resto', () => {
  assert.equal(parseStats(null), null);
  assert.equal(parseStats({ dia: 'ontem' }), null);
  const s = parseStats({ dia: '2026-11-09', pedidos: 'muitos', creditos: 5, metodos: { getAccountInfo: 3, 'x y': 1, sendTransaction: -2 }, versoes: { '1.0.0': 2, lixo: 1 }, recusas: { segundo: 4, outra: 9 } });
  assert.deepEqual(s, { ...emptyStats('2026-11-09'), creditos: 5, metodos: { getAccountInfo: 3 }, versoes: { '1.0.0': 2 }, recusas: { ...emptyStats('').recusas, segundo: 4 } });
});
