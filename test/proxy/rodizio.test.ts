// Rodízio das chaves do Helius no proxy (16/11/2026): várias URLs em UPSTREAM_URLS, a primeira que não está pausada
// atende; a sem crédito fica pausada e o mesmo pedido segue na seguinte, sem o app perceber.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cotas, MAX_PAUSED } from '../../proxy/cotas.ts';
import { DEFAULTS, keyUnusable, PROBE_BODY, upstreamId, upstreamsOf, type Env } from '../../proxy/worker.ts';
import { createRpc, isFatalRpcError, RpcError } from '../../src/core/solana/rpc.ts';
import { call, json, makeWorld, memStorage, rpcRequest } from './helpers.ts';

const K = ['CHAVE-UM-0000000001', 'CHAVE-DOIS-00000002', 'CHAVE-TRES-00000003'];
const URLS = K.map((k) => `https://mainnet.helius-rpc.com/?api-key=${k}`);
const OK = (n: number) => new Response(`{"jsonrpc":"2.0","id":1,"result":${n}}`, { status: 200, headers: { 'content-type': 'application/json' } });
const SEM_CREDITO = () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32429,"message":"max usage reached"}}', { status: 429 });

// Mundo com 3 chaves; `reply[i]` responde pela chave i. Guarda a ordem das chaves chamadas.
function world(reply: Array<(body: string) => Response | Promise<Response>>, over: Partial<Env> = {}) {
  const w = makeWorld({ UPSTREAM_URL: undefined, UPSTREAM_URLS: URLS.join('\n'), ...over });
  const hits: number[] = [];
  const probes: number[] = [];
  w.deps.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const i = URLS.indexOf(String(url));
    const body = String(init?.body ?? '');
    (body === PROBE_BODY ? probes : hits).push(i);
    return reply[i]!(body);
  }) as typeof fetch;
  const ask = async () => json(await w.send(rpcRequest(call('getLatestBlockhash'))));
  return { ...w, hits, probes, ask };
}

test('rodízio: UPSTREAM_URLS por linha, espaço ou vírgula, na ordem; UPSTREAM_URL entra no fim; repetida e não https ficam de fora', () => {
  assert.deepEqual(upstreamsOf({ UPSTREAM_URLS: `${URLS[0]}\r\n  ${URLS[1]} ,${URLS[0]}\nhttp://inseguro.exemplo\nlixo`, UPSTREAM_URL: URLS[2] }), URLS);
  assert.deepEqual(upstreamsOf({ UPSTREAM_URL: URLS[0] }), [URLS[0]]);
  assert.deepEqual(upstreamsOf({}), []);
});

test('rodízio: o nome da chave no contador é um hash curto (não revela a chave e não depende da posição)', async () => {
  const id = await upstreamId(URLS[0]!);
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(id, await upstreamId(URLS[0]!));
  assert.notEqual(id, await upstreamId(URLS[1]!));
  assert.ok(!K[0]!.toLowerCase().includes(id));
});

test('rodízio: "sem crédito" é 429 com "max usage" ou chave recusada (401/403); 429 comum e erro 500 não são', () => {
  assert.equal(keyUnusable(429, '{"error":{"message":"max usage reached"}}'), true);
  assert.equal(keyUnusable(401, ''), true);
  assert.equal(keyUnusable(403, 'forbidden'), true);
  assert.equal(keyUnusable(429, '{"error":{"message":"rate limited"}}'), false);
  assert.equal(keyUnusable(500, 'max usage'), false);
  assert.equal(keyUnusable(200, '{"error":{"message":"max usage reached"}}'), false);
});

test('rodízio: com a 1ª chave boa, só ela é usada', async () => {
  const w = world([() => OK(1), () => OK(2), () => OK(3)]);
  for (let i = 0; i < 3; i++) assert.equal((await w.ask()).body.result, 1);
  assert.deepEqual(w.hits, [0, 0, 0]);
});

test('rodízio: 1ª chave sem crédito → o MESMO pedido sai pela 2ª; a 1ª fica pausada (não é tentada) e volta depois da pausa', async () => {
  let umTemCredito = false;
  const w = world([() => (umTemCredito ? OK(1) : SEM_CREDITO()), () => OK(2), () => OK(3)]);
  const r = await w.ask();
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 2);
  assert.deepEqual(w.hits, [0, 1]);
  await w.ask();
  assert.deepEqual(w.hits, [0, 1, 1], 'pausada: nem é tentada');
  w.advance(DEFAULTS.PAUSA_CHAVE_MIN * 60_000 - 1000);
  await w.ask();
  assert.deepEqual(w.hits, [0, 1, 1, 1], 'ainda dentro da pausa');
  umTemCredito = true; // renovou
  w.advance(2000);
  assert.equal((await w.ask()).body.result, 1);
  assert.deepEqual(w.hits, [0, 1, 1, 1, 0], 'pausa vencida: volta a ser a 1ª');
});

test('rodízio: recusa só do PEDIDO (a chave responde a consulta fixa) não pausa ninguém: a resposta volta ao app como veio', async () => {
  // um pedido montado para o Helius recusar (403) não pode tirar as chaves de todo mundo do ar
  const so403NoPedido = (n: number) => (body: string) => (body === PROBE_BODY ? OK(n) : new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32403,"message":"forbidden for this request"}}', { status: 403 }));
  const w = world([so403NoPedido(1), so403NoPedido(2), so403NoPedido(3)]);
  const r = await w.ask();
  assert.equal(r.status, 403);
  assert.match(r.text, /forbidden for this request/);
  assert.deepEqual(w.hits, [0], 'não espalha o pedido pelas outras chaves');
  assert.deepEqual(w.probes, [0]);
  await w.ask();
  assert.deepEqual(w.hits, [0, 0], 'a 1ª continua no rodízio');
  assert.equal(w.cotas.counter.paused.size, 0);
});

test('rodízio: "sem crédito" no pedido com a consulta fixa sem resposta → segue na seguinte, sem pausar', async () => {
  const w = world([(b) => (b === PROBE_BODY ? Promise.reject(new TypeError('fetch failed')) : SEM_CREDITO()), () => OK(2), () => OK(3)]);
  assert.equal((await w.ask()).body.result, 2);
  assert.equal(w.cotas.counter.paused.size, 0);
  await w.ask();
  assert.deepEqual(w.hits, [0, 1, 0, 1], 'sem confirmação, a 1ª é tentada de novo');
});

test('rodízio: a chave só é pausada depois de recusar também a consulta fixa', async () => {
  const w = world([SEM_CREDITO, () => OK(2), () => OK(3)]);
  await w.ask();
  assert.deepEqual(w.probes, [0]);
  assert.equal(w.cotas.counter.paused.size, 1);
});

test('rodízio: PAUSA_CHAVE_MIN muda o tempo da pausa', async () => {
  const w = world([SEM_CREDITO, () => OK(2), () => OK(3)], { PAUSA_CHAVE_MIN: '5' });
  await w.ask();
  w.advance(5 * 60_000 + 1);
  await w.ask();
  assert.deepEqual(w.hits, [0, 1, 0, 1]);
});

test('rodízio: chave recusada (401/403) também pausa e passa para a seguinte', async () => {
  for (const status of [401, 403]) {
    const w = world([() => new Response('unauthorized', { status }), () => OK(2), () => OK(3)]);
    assert.equal((await w.ask()).body.result, 2);
    await w.ask();
    assert.deepEqual(w.hits, [0, 1, 1]);
  }
});

test('rodízio: 429 comum (limite por segundo de uma conta) passa à seguinte sem pausar; se nenhuma serve, volta o 429 para o app esperar', async () => {
  const limite = () => new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '1' } });
  const w = world([limite, () => OK(2), () => OK(3)]);
  assert.equal((await w.ask()).body.result, 2);
  await w.ask();
  assert.deepEqual(w.hits, [0, 1, 0, 1], 'sem pausa: a 1ª é tentada de novo');
  const todas = world([limite, limite, limite]);
  const r = await todas.ask();
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '1');
  assert.doesNotMatch(r.text, /max usage/);
});

test('rodízio: todas sem crédito → 429 "max usage reached" (o app cai para o RPC público); com todas pausadas, nem chama o Helius', async () => {
  const w = world([SEM_CREDITO, SEM_CREDITO, SEM_CREDITO]);
  const r = await w.ask();
  assert.equal(r.status, 429);
  assert.match(r.body.error.message, /max usage reached/);
  assert.equal(r.headers['retry-after'], String(DEFAULTS.PAUSA_CHAVE_MIN * 60));
  assert.deepEqual(w.hits, [0, 1, 2]);
  const again = await w.ask();
  assert.equal(again.status, 429);
  assert.deepEqual(w.hits, [0, 1, 2], 'todas pausadas: nenhuma chamada');
});

test('app × rodízio: todas sem crédito vira "créditos esgotados" no app (kind quota, fatal: passa para o próximo RPC)', async () => {
  const w = world([SEM_CREDITO, SEM_CREDITO, SEM_CREDITO]);
  const waits: number[] = [];
  const rpc = createRpc({
    url: 'https://rpc.clurn.app/',
    headers: { 'x-clurn-versao': '1.0.0' },
    requestsPerSecond: 1000,
    fetchImpl: ((url: string, init?: RequestInit) => w.send(new Request(url, init))) as typeof fetch,
    onRetry: (info) => waits.push(info.waitMs),
    sleep: async (ms) => w.advance(ms),
    retries: 3,
  });
  const err = await rpc.call('getLatestBlockhash', []).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof RpcError);
  assert.equal(err.kind, 'quota');
  assert.equal(isFatalRpcError(err), true);
  assert.deepEqual(waits, [], 'sem nova tentativa: passa direto para o RPC público');
});

test('rodízio: falha de rede numa chave passa à seguinte; tempo esgotado NÃO (o Helius lento vale para todas: somar prazos travaria o app)', async () => {
  const rede = world([() => Promise.reject(new TypeError('fetch failed')), () => OK(2), () => OK(3)]);
  assert.equal((await rede.ask()).body.result, 2);
  assert.deepEqual(rede.hits, [0, 1]);
  const lento = world([() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })), () => OK(2), () => OK(3)]);
  const r = await lento.ask();
  assert.equal(r.status, 504);
  assert.deepEqual(lento.hits, [0]);
  const tudoFora = world([0, 1, 2].map(() => () => Promise.reject(new TypeError('fetch failed'))));
  assert.equal((await tudoFora.ask()).status, 502);
});

test('rodízio: nenhuma das chaves aparece na resposta, nem quando a 2ª ecoa a sua e a da 1ª', async () => {
  const w = world([SEM_CREDITO, () => new Response(`{"jsonrpc":"2.0","id":1,"error":{"message":"bad ${URLS[1]} ${K[0]} ${K[1]}"}}`, { status: 200 }), () => OK(3)]);
  const r = await w.ask();
  for (const k of K) assert.ok(!r.text.includes(k), 'chave na resposta');
});

test('rodízio: a pausa sobrevive ao contador reiniciar e à virada do dia', async () => {
  const mem = memStorage();
  const id = await upstreamId(URLS[0]!);
  const now = Date.UTC(2026, 10, 16, 23, 30);
  const a = new Cotas({ storage: mem.storage });
  const pause = await a.fetch(new Request('https://cotas/pausar', { method: 'POST', body: JSON.stringify({ id, until: now + 3_600_000 }) }));
  assert.equal(pause.status, 200);
  const req = (t: number) => new Request('https://cotas/consumir', { method: 'POST', body: JSON.stringify({ key: '1.2.3.4', requests: 1, credits: 1, now: t, perSecond: 10, perIpDay: 100, globalHour: 100, globalDay: 1000 }) });
  const b = new Cotas({ storage: mem.storage }); // reiniciou
  assert.deepEqual((await (await b.fetch(req(now))).json()).paused, [id]);
  await b.fetch(req(now + 40 * 60_000)); // dia seguinte (UTC)
  await b.alarm(); // o dia novo apaga o armazenamento e regrava
  const c = new Cotas({ storage: mem.storage });
  assert.deepEqual((await (await c.fetch(req(now + 50 * 60_000))).json()).paused, [id]);
  assert.equal((await (await c.fetch(req(now + 61 * 60_000))).json()).paused, undefined, 'vencida: volta ao rodízio');
});

test('rodízio: o contador recusa pausa fora do formato e não guarda mais que MAX_PAUSED chaves', async () => {
  const mem = memStorage();
  const c = new Cotas({ storage: mem.storage });
  const send = (b: unknown) => c.fetch(new Request('https://cotas/pausar', { method: 'POST', body: JSON.stringify(b) }));
  for (const bad of [{ id: 'CHAVE', until: 1 }, { id: 'a'.repeat(16), until: -1 }, { id: 'a'.repeat(16) }, null]) assert.equal((await send(bad)).status, 400);
  for (let i = 0; i < MAX_PAUSED + 5; i++) await send({ id: i.toString(16).padStart(16, '0'), until: 1e15 });
  assert.equal(c.counter.paused.size, MAX_PAUSED);
});

test('rodízio: contador fora do ar na hora de pausar não muda a resposta (o pedido segue na 2ª chave)', async () => {
  const w = world([SEM_CREDITO, () => OK(2), () => OK(3)]);
  const real = w.env.COTAS!;
  w.env.COTAS = {
    idFromName: real.idFromName,
    get: (id) => ({ fetch: (input, init) => (String(input).endsWith('/pausar') ? Promise.reject(new Error('fora')) : real.get(id).fetch(input, init)) }),
  };
  assert.equal((await w.ask()).body.result, 2);
});

test('rodízio: sem nenhuma URL válida → 503 (falha fechada), sem chamar ninguém', async () => {
  const w = world([() => OK(1), () => OK(2), () => OK(3)], { UPSTREAM_URLS: 'http://inseguro\nlixo' });
  assert.equal((await w.ask()).status, 503);
  assert.deepEqual(w.hits, []);
});
