import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_METHODS, creditsOf, DEFAULTS, handle, limitsOf, secretParts } from '../../proxy/worker.ts';
import { createRpc, isFatalRpcError, RpcError } from '../../src/core/solana/rpc.ts';
import { call, json, makeWorld, rpcRequest, SECRET, UPSTREAM, VERSION } from './helpers.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');

// ---------- o par app × proxy ----------

// Todo método que o app chama (rpc.call('método', …) em src/, inclusive em várias linhas).
function methodsTheAppCalls(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\.call(?:<[^(]*?>)?\(\s*'([A-Za-z0-9]+)'/g)) out.add(m[1]!);
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

test('proxy: a lista de métodos permitidos é exatamente a dos métodos que o app chama (método novo no app derruba este teste)', () => {
  const app = methodsTheAppCalls();
  assert.ok(app.size >= 10, `a busca achou métodos do app: ${[...app]}`);
  assert.deepEqual([...ALLOWED_METHODS].sort(), [...app].sort());
  for (const admin of ['requestAirdrop', 'getBalance', 'getHealth', 'getClusterNodes', 'getVoteAccounts', 'eth_call', 'getProgramAccountsV2', 'getAsset']) {
    assert.equal(ALLOWED_METHODS.has(admin), false, admin);
  }
});

test('proxy: getProgramAccounts conta 10 créditos (tabela do Helius), o resto 1', () => {
  assert.equal(creditsOf('getProgramAccounts'), 10);
  assert.equal(creditsOf('getMultipleAccounts'), 1);
  assert.equal(creditsOf('sendTransaction'), 1);
});

// ---------- repasse ----------

test('proxy: método permitido é repassado reescrito (o mesmo conteúdo, sem espaços nem chave extra), só com content-type, e a resposta volta sem mudança', async () => {
  const reply = '{"jsonrpc":"2.0","id":7,"result":{"context":{"slot":1},"value":[null,{"lamports":5}]}}';
  const w = makeWorld({}, { reply: () => new Response(reply, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'x=1', 'x-helius': 'a' } }) });
  const raw = '{ "params": [["11111111111111111111111111111111"], {"encoding":"base64", "dataSlice": {"offset": 0, "length": 0}}], "id": 7, "extra": "x", "jsonrpc": "2.0", "method": "getMultipleAccounts" }';
  const r = await json(await w.send(rpcRequest(raw)));
  assert.equal(r.status, 200);
  assert.equal(r.text, reply, 'corpo do upstream sem mudança');
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['set-cookie'], undefined, 'cabeçalhos do upstream não vazam');
  assert.equal(w.up.calls.length, 1);
  assert.equal(w.up.calls[0]!.url, UPSTREAM);
  assert.equal(
    w.up.calls[0]!.body,
    '{"jsonrpc":"2.0","id":7,"method":"getMultipleAccounts","params":[["11111111111111111111111111111111"],{"encoding":"base64","dataSlice":{"offset":0,"length":0}}]}',
    'só jsonrpc, id, method e params, nessa ordem; o conteúdo de params intacto',
  );
  assert.deepEqual(Object.keys(w.up.calls[0]!.headers), ['content-type'], 'IP, versão e cabeçalhos do usuário não vão para o upstream');
});

test('proxy: erro do upstream passa como veio (status, corpo, retry-after): o app reconhece a recusa do getProgramAccounts', async () => {
  const cases = [
    { status: 200, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"Too many accounts requested (10000001 pubkeys), Please use getProgramAccountsV2 with pagination"}}' },
    { status: 429, body: '{"jsonrpc":"2.0","id":1,"error":{"code":-32005,"message":"rate limited"}}', retry: '3' },
    { status: 500, body: 'erro interno' },
  ];
  for (const c of cases) {
    const w = makeWorld({}, { reply: () => new Response(c.body, { status: c.status, headers: c.retry ? { 'retry-after': c.retry } : {} }) });
    const r = await json(await w.send(rpcRequest(call('getProgramAccounts', ['x']))));
    assert.equal(r.status, c.status);
    assert.equal(r.text, c.body);
    if (c.retry) assert.equal(r.headers['retry-after'], c.retry);
  }
});

test('proxy: lote com todos os métodos permitidos passa inteiro, numa chamada só', async () => {
  const w = makeWorld({}, { reply: () => new Response('[{"jsonrpc":"2.0","id":1,"result":1},{"jsonrpc":"2.0","id":2,"result":2}]') });
  const r = await json(await w.send(rpcRequest([call('getGenesisHash', [], 1), call('getBlockHeight', [], 2)])));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((x: { result: number }) => x.result), [1, 2]);
  assert.equal(w.up.calls.length, 1);
});

// ---------- recusas (nada vai para o upstream) ----------

test('proxy: método fora da lista → -32601, sem chamar o upstream', async () => {
  for (const m of ['requestAirdrop', 'getBalance', 'getHealth', 'eth_call', '__proto__', 'constructor']) {
    const w = makeWorld();
    const r = await json(await w.send(rpcRequest(call(m, [], 9))));
    assert.equal(r.status, 200, m);
    assert.equal(r.body.error.code, -32601, m);
    assert.equal(r.body.id, 9);
    assert.equal(w.up.calls.length, 0, m);
  }
  // nome que não tem cara de método não é repetido na resposta
  const w = makeWorld();
  const r = await json(await w.send(rpcRequest(call('<script>alert(1)</script>'))));
  assert.equal(r.body.error.code, -32601);
  assert.ok(!r.text.includes('<script>'), r.text);
});

test('proxy: lote com UM método proibido é recusado inteiro, sem chamar o upstream', async () => {
  const w = makeWorld();
  const r = await json(await w.send(rpcRequest([call('getGenesisHash', [], 1), call('requestAirdrop', ['x', 1], 2), call('getBlockHeight', [], 3)])));
  assert.equal(r.body.error.code, -32601);
  assert.match(r.body.error.message, /requestAirdrop/);
  assert.equal(w.up.calls.length, 0);
});

test('proxy: corpo grande (pelo content-length ou sem ele) e lote grande → 413, sem chamar o upstream', async () => {
  const w = makeWorld({ MAX_CORPO: '1000' });
  const big = JSON.stringify(call('getMultipleAccounts', [Array(100).fill('1'.repeat(44))]));
  assert.ok(big.length > 1000);
  assert.equal((await w.send(rpcRequest(big))).status, 413, 'com content-length');
  // content-length grande: recusa sem ler o corpo (um corpo que estoura ao ser lido prova que nem começou)
  const unread = new ReadableStream({
    pull() {
      throw new Error('leu o corpo');
    },
  });
  const declared = new Request('https://x.workers.dev/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clurn-versao': VERSION, 'content-length': '999999' }, body: unread, duplex: 'half' } as RequestInit);
  assert.equal((await w.send(declared)).status, 413, 'pelo content-length, antes de ler');
  // corpo em pedaços, sem content-length (o tamanho só aparece lendo)
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode(' '.repeat(100)));
      c.close();
    },
  });
  const chunked = new Request('https://x.workers.dev/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clurn-versao': VERSION }, body: stream, duplex: 'half' } as RequestInit);
  assert.equal(chunked.headers.get('content-length'), null);
  assert.equal((await w.send(chunked)).status, 413, 'sem content-length');
  // no limite passa
  const fits = JSON.stringify(call('getGenesisHash'));
  assert.equal((await w.send(rpcRequest(fits))).status, 200);
  // lote acima de MAX_LOTE
  const w2 = makeWorld();
  const lot = Array.from({ length: DEFAULTS.MAX_LOTE + 1 }, (_, i) => call('getGenesisHash', [], i));
  assert.equal((await w2.send(rpcRequest(lot))).status, 413);
  assert.equal((await w2.send(rpcRequest(lot.slice(0, DEFAULTS.MAX_LOTE)))).status, 200, 'lote no limite passa');
  assert.equal(w.up.calls.length, 1);
  assert.equal(w2.up.calls.length, 1);
});

test('proxy: chave "method" repetida não fura a lista: nas duas ordens, o upstream só vê o método conferido', async () => {
  // a última chave é a que o JSON.parse guarda: proibida por último → recusado
  const w1 = makeWorld();
  const r1 = await json(await w1.send(rpcRequest('{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","method":"requestAirdrop"}')));
  assert.equal(r1.body.error.code, -32601);
  assert.equal(w1.up.calls.length, 0);
  // permitida por último → passa, e a proibida NÃO chega ao upstream (um upstream que lesse a 1ª chave a executaria)
  const w2 = makeWorld();
  const r2 = await json(await w2.send(rpcRequest('{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","method":"getLatestBlockhash","params":["x",1],"params":[]}')));
  assert.equal(r2.status, 200);
  assert.equal(w2.up.calls.length, 1);
  assert.equal(w2.up.calls[0]!.body, '{"jsonrpc":"2.0","id":1,"method":"getLatestBlockhash","params":[]}');
  assert.ok(!w2.up.calls[0]!.body.includes('requestAirdrop'));
  // no lote também
  const w3 = makeWorld();
  await w3.send(rpcRequest('[{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"},{"jsonrpc":"2.0","id":2,"method":"sendTransaction","method":"getBlockHeight","jsonrpc":"2.0"}]'));
  assert.deepEqual(JSON.parse(w3.up.calls[0]!.body), [{ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }, { jsonrpc: '2.0', id: 2, method: 'getBlockHeight' }]);
  assert.ok(!w3.up.calls[0]!.body.includes('sendTransaction'));
});

test('proxy: chave extra estranha no item não chega ao upstream', async () => {
  const w = makeWorld();
  await w.send(rpcRequest('{"jsonrpc":"2.0","id":"a","method":"getGenesisHash","__proto__":{"method":"requestAirdrop"},"constructor":1,"method2":"requestAirdrop"}'));
  assert.equal(w.up.calls[0]!.body, '{"jsonrpc":"2.0","id":"a","method":"getGenesisHash"}');
});

test('proxy: número que não sobrevive à reescrita (inteiro acima de 2^53, 1e400) é recusado, não repassado diferente', async () => {
  const w = makeWorld();
  for (const n of ['9007199254740993', '1e400', '-1e400', '18446744073709551615']) {
    const r = await json(await w.send(rpcRequest('{"jsonrpc":"2.0","id":1,"method":"getBlockHeight","params":[{"minContextSlot":' + n + '}]}')));
    assert.equal(r.status, 400, n);
    assert.equal(r.body.error.code, -32600, n);
  }
  assert.equal(w.up.calls.length, 0);
  // os números do app passam exatos (slot, decimal, o maior inteiro exato)
  const ok = '{"jsonrpc":"2.0","id":1,"method":"getBlockHeight","params":[{"minContextSlot":381234567,"x":0.25,"y":9007199254740991}]}';
  await w.send(rpcRequest(ok));
  assert.equal(w.up.calls[0]!.body, ok);
});

test('proxy: JSON inválido → -32700; fora do formato JSON-RPC → -32600; nada vai para o upstream', async () => {
  const w = makeWorld();
  for (const bad of ['{', 'nada', '', '{"jsonrpc":"2.0","method":"getGenesisHash"']) {
    const r = await json(await w.send(rpcRequest(bad)));
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, -32700, bad);
  }
  for (const bad of ['[]', 'null', '42', '"getGenesisHash"', '{"method":"getGenesisHash"}', '{"jsonrpc":"1.0","method":"getGenesisHash"}', '{"jsonrpc":"2.0","method":7}', '{"jsonrpc":"2.0","method":"getGenesisHash","params":"x"}', '{"jsonrpc":"2.0","method":"getGenesisHash","params":7}', '{"jsonrpc":"2.0","method":"getGenesisHash","params":true}', '{"jsonrpc":"2.0","method":"getGenesisHash","params":null}', '{"jsonrpc":"2.0","method":"getGenesisHash","params":{"a":1}}', '{"jsonrpc":"2.0","method":"getGenesisHash","id":"' + 'i'.repeat(65) + '"}', '{"jsonrpc":"2.0","method":"getGenesisHash","id":{}}', '[{"jsonrpc":"2.0","method":"getGenesisHash"},null]']) {
    const r = await json(await w.send(rpcRequest(bad)));
    assert.equal(r.status, 400, bad);
    assert.equal(r.body.error.code, -32600, bad);
  }
  assert.equal(w.up.calls.length, 0);
});

test('proxy: só POST em "/" com application/json e a versão do app; sem CORS (o app chama do Node, não do navegador)', async () => {
  const w = makeWorld();
  const base = { 'content-type': 'application/json', 'x-clurn-versao': VERSION };
  const body = JSON.stringify(call('getGenesisHash'));
  const all: Response[] = [];
  const go = async (r: Request) => {
    const res = await w.send(r);
    all.push(res.clone());
    return res.status;
  };
  assert.equal(await go(new Request('https://x.workers.dev/', { method: 'OPTIONS', headers: { origin: 'https://golpe.exemplo', 'access-control-request-method': 'POST' } })), 405, 'pré-voo do navegador recusado');
  assert.equal(await go(new Request('https://x.workers.dev/', { method: 'GET' })), 405);
  assert.equal(await go(new Request('https://x.workers.dev/outro', { method: 'POST', headers: base, body })), 404);
  assert.equal(await go(new Request('https://x.workers.dev/', { method: 'POST', headers: { ...base, 'content-type': 'text/plain' }, body })), 415, 'pedido "simples" de navegador (text/plain) não passa');
  assert.equal(await go(new Request('https://x.workers.dev/', { method: 'POST', headers: { 'content-type': 'application/json' }, body })), 403, 'sem a versão');
  assert.equal(await go(new Request('https://x.workers.dev/', { method: 'POST', headers: { ...base, 'x-clurn-versao': 'clurn' }, body })), 403);
  assert.equal(await go(rpcRequest(call('getGenesisHash'), { origin: 'https://golpe.exemplo' })), 200);
  for (const r of all) for (const k of r.headers.keys()) assert.ok(!k.startsWith('access-control-'), `sem CORS: ${k}`);
  for (const r of all) assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `nosniff no ${r.status}`);
  assert.equal(w.up.calls.length, 1, 'só o pedido certo chegou ao upstream');
});

test('proxy: VERSAO_MINIMA recusa app mais velho (426) e deixa passar o igual ou mais novo', async () => {
  const w = makeWorld({ VERSAO_MINIMA: '0.3.0' });
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'x-clurn-versao': '0.2.9' }))).status, 426);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'x-clurn-versao': '0.3.0' }))).status, 200);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'x-clurn-versao': '0.10.0' }))).status, 200, 'compara número, não texto');
  assert.equal(w.up.calls.length, 2);
});

test('proxy: sem UPSTREAM_URL, sem o contador ou com o contador fora do ar → 503, sem chamar o upstream (falha fechada)', async () => {
  for (const [over, opts] of [[{ UPSTREAM_URL: undefined }, {}], [{ UPSTREAM_URL: 'http://inseguro' }, {}], [{ COTAS: undefined }, {}], [{}, { cotasFail: true }]] as const) {
    const w = makeWorld(over, opts);
    const r = await json(await w.send(rpcRequest(call('getGenesisHash'))));
    assert.equal(r.status, 503, JSON.stringify(over));
    assert.equal(r.body.error.code, -32603);
    assert.equal(w.up.calls.length, 0);
  }
});

// ---------- cotas ----------

test('proxy: limite por segundo por IP → 429 + Retry-After 1 + -32005 (sem "max usage": o app espera e repete); no segundo seguinte passa', async () => {
  const w = makeWorld({ LIMITE_IP_SEGUNDO: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 200);
  const r = await json(await w.send(rpcRequest(call('getGenesisHash'))));
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '1');
  assert.equal(r.body.error.code, -32005);
  assert.doesNotMatch(r.body.error.message, /max usage/i);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.1' }))).status, 200, 'outro IP tem o seu');
  // lote conta cada item
  assert.equal((await w.send(rpcRequest([call('getGenesisHash', [], 1), call('getGenesisHash', [], 2)], { 'cf-connecting-ip': '198.51.100.1' }))).status, 200);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.1' }))).status, 429, '1 + 2 itens = 3: o 4º estoura');
  w.advance(1000);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 200);
  assert.equal(w.up.calls.length, 3 + 1 + 1 + 1);
});

test('proxy: cota diária por IP (em créditos) → 429 "max usage reached"; outro IP continua; zera no dia seguinte (UTC)', async () => {
  const w = makeWorld({ LIMITE_IP_DIA: '25', LIMITE_IP_SEGUNDO: '1000' });
  assert.equal((await w.send(rpcRequest(call('getProgramAccounts', ['x'])))).status, 200, '10');
  assert.equal((await w.send(rpcRequest(call('getProgramAccounts', ['x'])))).status, 200, '20');
  const r = await json(await w.send(rpcRequest(call('getProgramAccounts', ['x']))));
  assert.equal(r.status, 429, 'o 3º getProgramAccounts passaria de 25 créditos');
  assert.match(r.body.error.message, /max usage reached/);
  assert.match(r.body.error.message, /deste IP/);
  assert.ok(Number(r.headers['retry-after']) > 0);
  for (let i = 0; i < 5; i++) assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 200, 'consultas de 1 crédito ainda cabem (21 a 25)');
  assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 429);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.1' }))).status, 200, 'outro IP');
  w.setClock(Date.UTC(2026, 10, 10, 0, 0, 1));
  assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 200, 'dia novo');
});

test('proxy: IPv6 conta pelo /48 (trocar o fim do endereço ou o /64 dentro do /48 não dá cota nova)', async () => {
  const w = makeWorld({ LIMITE_IP_DIA: '2', LIMITE_IP_SEGUNDO: '1000' });
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '2001:db8:1:2::1' }))).status, 200);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '2001:db8:1:2:aaaa:bbbb:cccc:dddd' }))).status, 200);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '2001:0db8:0001:0002::ffff' }))).status, 429);
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '2001:db8:1:3::1' }))).status, 429, 'outro /64 do mesmo /48');
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '2001:db8:2:2::1' }))).status, 200, 'outro /48');
});

test('proxy: teto diário global → 429 "max usage reached" para todos os IPs', async () => {
  const w = makeWorld({ TETO_DIA: '3', TETO_HORA: '1000', LIMITE_IP_SEGUNDO: '1000' });
  for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': ip }))).status, 200);
  for (const ip of ['198.51.100.1', '198.51.100.9']) {
    const r = await json(await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': ip })));
    assert.equal(r.status, 429);
    assert.match(r.body.error.message, /max usage reached.*do proxy/);
  }
  assert.equal(w.up.calls.length, 3);
});

test('proxy: teto por hora → 429 "max usage reached" para todos os IPs, Retry-After até a hora seguinte; na hora seguinte passa', async () => {
  const w = makeWorld({ TETO_HORA: '2', LIMITE_IP_SEGUNDO: '1000' });
  w.setClock(Date.UTC(2026, 10, 9, 12, 59, 0));
  for (const ip of ['198.51.100.1', '198.51.100.2']) assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': ip }))).status, 200);
  const r = await json(await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.3' })));
  assert.equal(r.status, 429);
  assert.match(r.body.error.message, /max usage reached.*por hora/);
  assert.equal(r.headers['retry-after'], '60', 'faltava 1 min para a hora virar');
  w.setClock(Date.UTC(2026, 10, 9, 13, 0, 0));
  assert.equal((await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.3' }))).status, 200);
});

test('proxy: limites padrão — por IP bem abaixo do teto (≥ 20 IPs para gastar o dia), hora = dia/8, e o wrangler.toml igual ao código', () => {
  assert.ok(DEFAULTS.TETO_DIA / DEFAULTS.LIMITE_IP_DIA >= 20, DEFAULTS.TETO_DIA + ' / ' + DEFAULTS.LIMITE_IP_DIA);
  const lim = limitsOf({});
  assert.equal(lim.globalHour, Math.floor(DEFAULTS.TETO_DIA / 8));
  assert.equal(lim.perIpDay, DEFAULTS.LIMITE_IP_DIA);
  assert.equal(limitsOf({ TETO_DIA: '3' }).globalHour, 1, 'teto pequeno não vira hora zero');
  const toml = fs.readFileSync(path.join(ROOT, 'proxy', 'wrangler.toml'), 'utf8');
  const v = (k: string) => Number(new RegExp('^' + k + ' = "([0-9]+)"', 'm').exec(toml)?.[1]);
  assert.equal(v('LIMITE_IP_DIA'), DEFAULTS.LIMITE_IP_DIA);
  assert.equal(v('TETO_DIA'), DEFAULTS.TETO_DIA);
  assert.equal(v('TETO_HORA'), lim.globalHour);
  assert.equal(v('LIMITE_IP_SEGUNDO'), DEFAULTS.LIMITE_IP_SEGUNDO);
  assert.equal(v('PAUSA_CHAVE_MIN'), DEFAULTS.PAUSA_CHAVE_MIN);
});

test('proxy: só no domínio oficial rpc.clurn.app (o endereço embutido no app nunca muda), sem workers.dev nem prévia', () => {
  const toml = fs.readFileSync(path.join(ROOT, 'proxy', 'wrangler.toml'), 'utf8');
  assert.match(toml, /^workers_dev = false$/m);
  assert.match(toml, /^preview_urls = false$/m);
  assert.match(toml, /^routes = \[\{ pattern = "rpc\.clurn\.app", custom_domain = true \}\]$/m);
});

test('proxy: pedido recusado não gasta cota (método proibido, JSON ruim, limite)', async () => {
  const w = makeWorld({ LIMITE_IP_DIA: '1', LIMITE_IP_SEGUNDO: '1000' });
  await w.send(rpcRequest(call('requestAirdrop')));
  await w.send(rpcRequest('{'));
  assert.equal((await w.send(rpcRequest(call('getGenesisHash')))).status, 200);
});

// ---------- o app (createRpc) conversando com o proxy ----------

// O app de verdade (createRpc) falando com o proxy. `retries` recebe a espera de cada nova tentativa.
function appClient(w: ReturnType<typeof makeWorld>, retries: number[]) {
  return createRpc({
    url: 'https://clurn-rpc.exemplo.workers.dev/',
    headers: { 'x-clurn-versao': VERSION },
    requestsPerSecond: 1000,
    fetchImpl: ((url: string, init?: RequestInit) => w.send(new Request(url, init))) as typeof fetch,
    onRetry: (info) => retries.push(info.waitMs),
    sleep: async (ms) => {
      w.advance(ms);
    },
    retries: 3,
  });
}

test('app × proxy: cota do dia esgotada vira "créditos esgotados" no app (kind quota, sem nova tentativa, fatal: cai para o próximo RPC)', async () => {
  const w = makeWorld({ LIMITE_IP_DIA: '1' });
  const sleeps: number[] = [];
  const rpc = appClient(w, sleeps); // novas tentativas
  assert.equal(await rpc.call('getGenesisHash', []), 1);
  const err = await rpc.call('getGenesisHash', []).then(() => null, (e) => e);
  assert.ok(err instanceof RpcError);
  assert.equal(err.kind, 'quota');
  assert.equal(isFatalRpcError(err), true);
  assert.deepEqual(sleeps, [], 'nenhuma nova tentativa: a cota do dia não volta em segundos');
  assert.ok(!err.message.includes(SECRET));
});

test('app × proxy: limite por segundo é esperado e repetido pelo app (não troca de RPC)', async () => {
  const w = makeWorld({ LIMITE_IP_SEGUNDO: '1' });
  const sleeps: number[] = [];
  const rpc = createRpc({
    url: 'https://clurn-rpc.exemplo.workers.dev/',
    headers: { 'x-clurn-versao': VERSION },
    requestsPerSecond: 1000,
    fetchImpl: ((url: string, init?: RequestInit) => w.send(new Request(url, init))) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      w.advance(ms);
    },
  });
  assert.equal(await rpc.call('getGenesisHash', []), 1);
  assert.equal(await rpc.call('getGenesisHash', []), 1, 'a 2ª no mesmo segundo leva 429, espera e passa');
  assert.ok(sleeps.some((ms) => ms >= 1000), `esperou: ${sleeps}`);
});

test('app × proxy: método proibido é erro da chamada (não fatal), e o app manda a versão no cabeçalho', async () => {
  const w = makeWorld();
  const rpc = appClient(w, []);
  const err = await rpc.call('getBalance', ['x']).then(() => null, (e) => e);
  assert.ok(err instanceof RpcError);
  assert.equal(err.code, -32601);
  assert.equal(isFatalRpcError(err), false);
  // sem o cabeçalho, o proxy recusa: é o createRpc que o põe
  const bare = createRpc({ url: 'https://x.workers.dev/', fetchImpl: ((url: string, init?: RequestInit) => w.send(new Request(url, init))) as typeof fetch, retries: 0 });
  const e2 = await bare.call('getGenesisHash', []).then(() => null, (e) => e);
  assert.equal((e2 as RpcError).code, 403);
});

// ---------- upstream fora do ar ou lento ----------

test('proxy: upstream fora do ar → 502 e lento → 504 (o app repete e depois cai para o próximo); a mensagem nunca traz a URL', async () => {
  const down = makeWorld({}, { reply: () => Promise.reject(new TypeError(`fetch failed: ${UPSTREAM} ECONNREFUSED`)) });
  const r1 = await json(await down.send(rpcRequest(call('getGenesisHash'))));
  assert.equal(r1.status, 502);
  assert.equal(r1.body.error.code, -32603);
  assert.ok(!r1.text.includes(SECRET) && !r1.text.includes('helius'), r1.text);

  const slow = makeWorld({ TEMPO_UPSTREAM_MS: '50' });
  slow.deps.fetch = ((_u: string, init?: RequestInit) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      // sem o prazo do proxy, este upstream desiste sozinho em 2 s, com outro erro (502, não 504): o teste cai em vez de travar
      setTimeout(() => reject(new TypeError('o upstream falso desistiu')), 2_000).unref();
    })) as typeof fetch;
  const t0 = Date.now();
  const r2 = await json(await handle(rpcRequest(call('getGenesisHash')), slow.env, slow.deps));
  assert.equal(r2.status, 504);
  assert.match(r2.body.error.message, /não respondeu/);
  assert.ok(Date.now() - t0 < 5_000, 'respondeu no prazo, sem esperar o upstream');
  assert.ok(!r2.text.includes(SECRET));
  // o app trata os dois como falha do RPC (fatal depois das tentativas)
  assert.equal(isFatalRpcError(new RpcError('x', 502)), true);
  assert.equal(isFatalRpcError(new RpcError('x', 504)), true);
});

// ---------- o segredo nunca sai ----------

test('proxy: a URL e a chave do upstream nunca aparecem em resposta, nem quando o upstream as ecoa', async () => {
  const echo = makeWorld({}, { reply: () => new Response(`{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"bad request to ${UPSTREAM} (key ${SECRET})"}}`, { status: 400 }) });
  const r = await json(await echo.send(rpcRequest(call('getGenesisHash'))));
  assert.equal(r.status, 400);
  assert.ok(!r.text.includes(SECRET), r.text);
  assert.match(r.text, /\[rpc\]/);
  // todos os caminhos de erro do próprio proxy
  const texts: string[] = [r.text];
  const reqs = [rpcRequest('{'), rpcRequest(call('requestAirdrop')), rpcRequest('x'.repeat(DEFAULTS.MAX_CORPO + 1)), new Request('https://x.workers.dev/', { method: 'GET' })];
  const w = makeWorld({ LIMITE_IP_DIA: '1' });
  for (const q of reqs) texts.push((await json(await w.send(q))).text);
  await w.send(rpcRequest(call('getGenesisHash')));
  const quota = await w.send(rpcRequest(call('getGenesisHash')));
  texts.push(await quota.text(), JSON.stringify(Object.fromEntries(quota.headers.entries())));
  for (const t of texts) assert.ok(!t.includes(SECRET) && !t.includes(UPSTREAM), t);
  // as partes secretas da URL incluem a chave e a query; o host sozinho não
  const parts = secretParts(UPSTREAM);
  assert.ok(parts.includes(SECRET) && parts.includes(`api-key=${SECRET}`));
  assert.ok(!parts.includes('mainnet.helius-rpc.com'));
  assert.ok(secretParts(`https://rpc.exemplo/${'k'.repeat(32)}/`).includes('k'.repeat(32)), 'chave no caminho também');
});

test('proxy: o código não tem log e o wrangler.toml desliga os logs e não tem a chave', () => {
  for (const f of ['worker.ts', 'cotas.ts', 'entrada.ts']) {
    const src = fs.readFileSync(path.join(ROOT, 'proxy', f), 'utf8');
    assert.doesNotMatch(src, /console\./, f);
    assert.doesNotMatch(src, /api-key=/, f);
  }
  const toml = fs.readFileSync(path.join(ROOT, 'proxy', 'wrangler.toml'), 'utf8');
  assert.match(toml, /\[observability\]\s*\nenabled = false/);
  assert.doesNotMatch(toml, /UPSTREAM_URLS?\s*=/, 'as URLs com a chave entram só por secret');
  assert.doesNotMatch(toml, /api-key|helius-rpc\.com/);
});

test('app × proxy: a conferência do começo (checkRpc, com a trava de rede) passa inteira pelo proxy', async () => {
  const { checkRpc, GENESIS_HASH } = await import('../../src/core/solana/rpc-check.ts');
  const w = makeWorld({}, {
    reply: (body) => {
      const { id, method } = JSON.parse(body);
      const result = method === 'getGenesisHash' ? GENESIS_HASH.mainnet : method === 'getMinimumBalanceForRentExemption' ? 890880 : method === 'getProgramAccounts' || method === 'getSignaturesForAddress' ? [] : { context: { slot: 1 }, value: [] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
    },
  });
  const r = await checkRpc(appClient(w, []), undefined, 5_000, 'mainnet');
  assert.deepEqual(r, { ok: true, problems: [] });
  assert.equal(w.up.calls.length, 6, 'gênese + 5 consultas de teste');
});
