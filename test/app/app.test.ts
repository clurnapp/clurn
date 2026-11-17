import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { abortedErrorOf, BadRequest, codeOf, createServer, makeRetryNotice, resultView } from '../../src/app/server.ts';
import { explainError } from '../../src/core/limpeza/errors.ts';
import { ExecutionAborted } from '../../src/core/limpeza/executor.ts';

const TOKEN = 'codigo-de-teste-123';
let server: http.Server;
let port = 0;

before(async () => {
  server = createServer(0, TOKEN);
  await new Promise<void>((r) => server.on('listening', () => r()));
  port = (server.address() as AddressInfo).port;
});
after(() => server.close());

function req(path: string, opts: { method?: string; token?: string | null; host?: string; origin?: string; body?: unknown } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}`, 'content-type': 'application/json' };
    if (opts.token !== null) headers['x-token'] = opts.token ?? TOKEN;
    if (opts.origin) headers.origin = opts.origin;
    const r = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(JSON.stringify(opts.body));
    r.end();
  });
}

test('app: escuta só em 127.0.0.1', () => {
  assert.equal((server.address() as AddressInfo).address, '127.0.0.1');
});

test('app: página abre sem código, mas a API exige o código certo', async () => {
  const page = await req('/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['referrer-policy'], 'no-referrer', 'o código de acesso fica no #, mas nada de referrer');
  assert.match(page.headers['permissions-policy'] as string, /camera=\(\).*microphone=\(\)/);
  assert.doesNotMatch(page.headers['permissions-policy'] as string, /clipboard/, '"Copiar" precisa da área de transferência');
  const api = await req('/api/estado');
  assert.equal(api.headers['x-content-type-options'], 'nosniff');
  assert.equal(api.headers['cache-control'], 'no-store', 'estado com endereços nunca fica em cache');
  assert.equal(api.headers['access-control-allow-origin'], undefined, 'sem CORS');
  assert.equal((await req('/api/estado', { token: null })).status, 401);
  assert.equal((await req('/api/estado', { token: 'errado' })).status, 401);
  assert.equal((await req('/api/estado')).status, 200);
  assert.equal((await req('/api/eventos?t=errado', { token: null })).status, 401);
});

test('app: logo e fontes saem só da lista fixa, com o tipo certo', async () => {
  const svg = await req('/assets/clurn.svg', { token: null });
  assert.equal(svg.status, 200);
  assert.equal(svg.headers['content-type'], 'image/svg+xml');
  assert.equal(svg.headers['x-content-type-options'], 'nosniff');
  assert.equal((await req('/assets/inter.woff2', { token: null })).headers['content-type'], 'font/woff2');
  for (const p of ['/assets/../server.ts', '/assets/%2e%2e%2fserver.ts', '/assets/..%5cserver.ts', '/assets/index.html', '/assets/OFL-inter.txt', '/assets/', '/assets/clurn.svg/']) {
    assert.equal((await req(p, { token: null })).status, 404, p);
  }
  assert.equal((await req('/assets/clurn.svg', { token: null, host: `evil.com:${port}` })).status, 403);
});

test('página: só busca arquivos do próprio app, e todos existem na lista do servidor', async () => {
  const html = (await req('/', { token: null })).body;
  assert.doesNotMatch(html, /(?:src|href)="https?:|url\(\s*['"]?https?:/i, 'nada de fora (a CSP bloquearia)');
  const refs = [...html.matchAll(/\/assets\/([\w.-]+)/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5, `achou só ${refs.length} referências a /assets/`);
  for (const name of new Set(refs)) assert.equal((await req(`/assets/${name}`, { token: null })).status, 200, name);
});

test('app: recusa outro Host (DNS rebinding) e outra origem (outro site no navegador)', async () => {
  assert.equal((await req('/api/estado', { host: `evil.com:${port}` })).status, 403);
  assert.equal((await req('/', { host: 'localhost' })).status, 403);
  assert.equal((await req('/api/estado', { origin: 'https://evil.com' })).status, 403);
  assert.equal((await req('/api/estado', { origin: `http://127.0.0.1:${port}` })).status, 200);
});

test('app: frase com número errado de palavras é recusada na hora, sem ecoar a frase', async () => {
  const r = await req('/api/analisar', { body: { frases: [{ texto: 'segredo um dois tres', carteira: 'solflare' }], rede: 'devnet' } });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.equal(j.codigo, 'seed-words');
  assert.equal(j.params.words, 4);
  assert.ok(!r.body.includes('segredo'));
  // formato antigo (uma frase só) não é mais aceito, e também não ecoa
  const old = await req('/api/analisar', { body: { frase: 'segredo um dois tres', rede: 'devnet' } });
  assert.equal(old.status, 400);
  assert.ok(!old.body.includes('segredo'));
});

test('app: sem análise não monta plano, não simula, não executa', async () => {
  assert.match((await req('/api/plano', { body: { destino: 'x', destino2: 'x' } })).body, /Analise as carteiras primeiro/);
  assert.match((await req('/api/simular', { body: {} })).body, /Monte o plano primeiro/);
  assert.match((await req('/api/executar', { body: { confirmacao: 'abcd' } })).body, /Monte o plano primeiro/);
});

test('app: estado nunca contém frase nem chave', async () => {
  const r = await req('/api/estado');
  // "frases" agora é campo (a lista por frase, sem texto); o que não pode aparecer é texto, seed ou chave
  assert.doesNotMatch(r.body, /mnemonic|secret|privat|"seed"|"texto"|"signers"/i);
});

test('app: pedido grande demais ou JSON quebrado é recusado', async () => {
  const big = await req('/api/plano', { body: { lixo: 'x'.repeat(70 * 1024) } });
  assert.equal(big.status, 400);
  const broken = await new Promise<number>((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/api/plano', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-token': TOKEN } }, (res) => resolve(res.statusCode ?? 0));
    r.end('{quebrado');
  });
  assert.equal(broken, 400);
});

test('app (revisão): não executa sem simular, após simulação parada, nem duas vezes; não encerra no meio da execução', async () => {
  const { executeBlockedReason, canShutdown } = await import('../../src/app/server.ts');
  assert.match(executeBlockedReason({ simulated: false, aborted: null, executed: false })!, /Simule/);
  assert.match(executeBlockedReason({ simulated: true, aborted: 'destino diferente', executed: false })!, /parou por segurança/);
  assert.match(executeBlockedReason({ simulated: true, aborted: null, executed: true })!, /já foi executado/);
  assert.equal(executeBlockedReason({ simulated: true, aborted: null, executed: false }), null);
  assert.equal(canShutdown('execucao'), false);
  assert.equal(canShutdown(null), true);
  assert.equal(canShutdown('analise'), true);
});

test('app: "Limpar outra frase" apaga as chaves e zera a sessão sem fechar o app; no meio de uma tarefa, não', async () => {
  const { sessionForTest, armFundingAbort, canStartOver, newFrase } = await import('../../src/app/server.ts');
  const old = sessionForTest();
  const f1 = newFrase(1);
  f1.signers.set(1, { address: 'x' } as never);
  f1.main = 'principal-da-frase-anterior';
  const pending = Buffer.alloc(64, 5);
  const f2 = newFrase(2, 'phantom', pending); // ainda na fila: seed (bytes) na memória
  f2.signers.set(2, { address: 'y' } as never);
  old.frases = [f1, f2];
  old.executed = true;
  const wait1 = armFundingAbort(f1);
  const wait2 = armFundingAbort(f2);
  const r = await req('/api/nova-limpeza', { body: {} });
  assert.equal(r.status, 200);
  assert.equal(f1.signers.size + f2.signers.size, 0, 'chaves de todas as frases apagadas');
  assert.ok(pending.every((b) => b === 0), 'seed pendente zerada');
  assert.equal(f2.seed, null);
  assert.equal(wait1.signal.aborted && wait2.signal.aborted, true, 'esperas de depósito de todas as frases canceladas');
  const now = sessionForTest();
  assert.notEqual(now, old);
  assert.deepEqual(now.frases, []);
  assert.equal(now.executed, false);
  const st = JSON.parse(r.body);
  assert.deepEqual(st.frases, []);
  assert.equal(st.plan, null);
  assert.equal((await req('/api/estado')).status, 200, 'o app continua aberto');

  for (const busy of ['analise', 'simulacao', 'execucao']) assert.equal(canStartOver(busy), false, busy);
  assert.equal(canStartOver(null), true);
  now.busy = 'execucao';
  try {
    const blocked = await req('/api/nova-limpeza', { body: {} });
    assert.equal(blocked.status, 400);
    assert.equal(sessionForTest(), now, 'sessão em execução não é trocada');
  } finally {
    now.busy = null;
  }
});

test('app: fechar a janela encerra sozinho, mas não antes de abrir, não no F5 e não no meio da execução', async () => {
  const { shouldCloseIdle, IDLE_GRACE_MS } = await import('../../src/app/server.ts');
  const closed = { everConnected: true, connected: 0, idleMs: IDLE_GRACE_MS, busy: null };
  assert.equal(shouldCloseIdle(closed), true);
  assert.equal(shouldCloseIdle({ ...closed, busy: 'analise' }), true, 'análise só lê, pode parar');
  assert.equal(shouldCloseIdle({ ...closed, everConnected: false }), false, 'janela ainda abrindo');
  assert.equal(shouldCloseIdle({ ...closed, connected: 1 }), false, 'janela aberta');
  assert.equal(shouldCloseIdle({ ...closed, idleMs: IDLE_GRACE_MS - 1 }), false, 'F5 reconecta antes do prazo');
  assert.equal(shouldCloseIdle({ ...closed, busy: 'execucao' }), false, 'execução termina e grava o relatório antes');
});

test('app: recusa traz código além do texto', async () => {
  const r = await req('/api/analisar', { body: { frases: [{ texto: 'segredo um dois tres', carteira: 'solflare' }], rede: 'devnet' } });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.equal(j.codigo, 'seed-words');
  assert.equal(j.params.words, 4);
  assert.equal(j.params.frase, 1);
  assert.match(j.erro, /frase 1/);
  assert.ok(!r.body.includes('segredo'));
  // recusa comum também leva código ('unknown' quando não há um específico)
  const s = JSON.parse((await req('/api/simular', { body: {} })).body);
  assert.equal(s.codigo, 'unknown');
  assert.deepEqual(s.params, {});
});

test('app: estado inicial sem recibo nem espera', async () => {
  const j = JSON.parse((await req('/api/estado')).body);
  assert.equal(j.receipt, null);
  assert.deepEqual(j.frases, [], 'sem frase, sem espera de depósito (a espera é por frase)');
  assert.equal(j.abortedError, null);
  assert.equal(j.progress, null);
  assert.equal(j.pause, null);
});

test('app: resultView leva o erro explicado do passo', () => {
  const step = { kind: 'sweep-sol', walletIndex: 3, isFeePayer: false } as never;
  const v = resultView({ step, description: 'x', status: 'falhou', error: explainError('insufficient lamports') });
  assert.equal(v.error?.code, 'sim-insufficient');
  assert.equal(resultView({ step, description: 'x', status: 'simulado' }).error, null);
});

test('app: aviso de rede lenta sai uma vez por tarefa, mesmo com várias tentativas', () => {
  const sent: Array<[string, unknown]> = [];
  const n = makeRetryNotice((t, d) => sent.push([t, d]));
  n.reset();
  const info = { attempt: 1, waitMs: 500, code: 429 };
  n.onRetry(info);
  n.onRetry(info);
  n.onRetry({ ...info, attempt: 2 });
  assert.deepEqual(sent, [['aviso', { codigo: 'rpc-busy' }]]);
  n.reset();
  n.onRetry(info);
  assert.equal(sent.length, 2);
  // listener nunca derruba a chamada de RPC, mesmo se o envio do evento falhar
  const bad = makeRetryNotice(() => { throw new Error('boom'); });
  bad.reset();
  assert.doesNotThrow(() => bad.onRetry(info));
});

test('app: erro sem código nunca leva texto cru para a página (codeOf)', () => {
  const r = codeOf(new Error('frase secreta abandon abandon'));
  assert.deepEqual(r, { codigo: 'unknown', params: {} });
  assert.ok(!JSON.stringify(r).includes('frase secreta'));
  const c = codeOf(new BadRequest('x', 'seed-words', { words: 4 }));
  assert.equal(c.codigo, 'seed-words');
  assert.equal(c.params.words, 4);
});

test('app: parada que não é ExecutionAborted vira unknown sem texto cru (abortedErrorOf)', () => {
  const r = abortedErrorOf(new Error('raw secret'));
  assert.equal(r.code, 'unknown');
  assert.deepEqual(r.params, {});
  assert.equal(r.technical, '');
  assert.equal(r.beforeSend, false);
  assert.ok(!JSON.stringify(r).includes('raw secret'));
  assert.equal(abortedErrorOf(new ExecutionAborted('sem destino', 'dest-missing')).code, 'dest-missing');
});

test('app: a lista BIP39 sai como texto, com as 2048 palavras, e segue protegida pelo Host', async () => {
  const r = await req('/assets/bip39-english.txt', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
  const lines = r.body.split('\n').filter((l) => l !== '');
  assert.equal(lines.length, 2048);
  assert.equal(lines[0], 'abandon');
  assert.equal(lines[2047], 'zoo');
  assert.equal((await req('/assets/bip39-english.txt', { token: null, host: `evil.com:${port}` })).status, 403);
});

test('resultView: leva para a tela final o valor, a taxa do app, a coleta pulada e a ATA antiga fechada na coleta', () => {
  const step = { kind: 'claim-amm' as const, walletIndex: 1, wallet: '11111111111111111111111111111112', estimateLamports: 1n };
  const v = resultView({ step, description: 'x', status: 'enviado', destinationDelta: 2_814_960n, appFeeDelta: 224_320n, closedRentLamports: 2_039_280n, skippedClaim: true });
  assert.deepEqual([v.destinationDelta, v.appFeeDelta, v.closedRentLamports, v.skippedClaim], [2_814_960n, 224_320n, 2_039_280n, true]);
  const w = resultView({ step, description: 'x', status: 'enviado' });
  assert.deepEqual([w.appFeeDelta, w.closedRentLamports, w.skippedClaim], [null, null, false]);
});
