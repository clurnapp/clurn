import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appVersion, embeddedFromEnv, embeddedRpcFileContent, EMBEDDED_RPC_NAME, hasCustomDefault, PROXY_ENV, PUBLIC_RPC, readEmbeddedRpcs, rpcCandidates, rpcHeaders, VERSION_HEADER } from '../../src/app/rpc-padrao.ts';

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=CHAVE-DE-TESTE';
const HELIUS2 = 'https://mainnet.helius-rpc.com/?api-key=CHAVE-DOIS';
const MINE = 'https://meu.rpc/?api-key=OUTRA';
const PROJECT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const PROJECT2 = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';

test('rpc padrão: ordem variável → embutidos (na ordem) → público, sem repetidos', () => {
  assert.deepEqual(rpcCandidates('mainnet', { env: MINE, embedded: [HELIUS] }), [MINE, HELIUS, PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', { embedded: [HELIUS] }), [HELIUS, PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', { embedded: [HELIUS, HELIUS2] }), [HELIUS, HELIUS2, PUBLIC_RPC.mainnet], 'chave 1, chave 2, público');
  assert.deepEqual(rpcCandidates('mainnet', { env: MINE, embedded: [HELIUS, HELIUS2] }), [MINE, HELIUS, HELIUS2, PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', {}), [PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', { env: '  ', embedded: null }), [PUBLIC_RPC.mainnet], 'variável em branco não conta');
  assert.deepEqual(rpcCandidates('mainnet', { env: HELIUS, embedded: [HELIUS, HELIUS2] }), [HELIUS, HELIUS2, PUBLIC_RPC.mainnet]);
});

test('rpc padrão: os embutidos são da mainnet e não entram na devnet', () => {
  assert.deepEqual(rpcCandidates('devnet', { embedded: [HELIUS, HELIUS2] }), [PUBLIC_RPC.devnet]);
  assert.equal(hasCustomDefault('devnet', { embedded: [HELIUS] }), false);
  assert.equal(hasCustomDefault('mainnet', { embedded: [HELIUS] }), true);
  assert.equal(hasCustomDefault('mainnet', {}), false);
});

test('rpc padrão: RPC escolhido pela API é o único (sem cair para outro)', () => {
  assert.deepEqual(rpcCandidates('mainnet', { chosen: MINE, env: HELIUS, embedded: [HELIUS, HELIUS2] }), [MINE]);
});

test('rpc embutido: arquivo ausente, quebrado, sem url ou com url que não é https → sem embutido, sem lançar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-rpc-'));
  try {
    const f = path.join(dir, EMBEDDED_RPC_NAME);
    assert.deepEqual(readEmbeddedRpcs(f), [], 'ausente');
    for (const bad of ['{', '[]', 'null', '{"url":42}', '{"url":"http://inseguro/?api-key=x"}', '{"url":"https://com espaço"}', '{}', '{"rpcs":[]}', '{"rpcs":[null,1,"x"]}']) {
      fs.writeFileSync(f, bad);
      assert.deepEqual(readEmbeddedRpcs(f), [], bad);
    }
    fs.writeFileSync(f, embeddedRpcFileContent([{ url: `  ${HELIUS}\n` }]));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: HELIUS, heliusProject: null }], 'o que o empacotamento grava é lido de volta');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc embutido: várias chaves, na ordem; item ruim é pulado sozinho; o formato antigo (0.2.3) continua lido', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-rpc-'));
  try {
    const f = path.join(dir, EMBEDDED_RPC_NAME);
    fs.writeFileSync(f, embeddedRpcFileContent([{ url: HELIUS, heliusProject: PROJECT }, { url: HELIUS2, heliusProject: ` ${PROJECT2} ` }]));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: HELIUS, heliusProject: PROJECT }, { url: HELIUS2, heliusProject: PROJECT2 }]);
    // dado sujo: url ruim, repetida, projeto fora do formato, item nulo
    fs.writeFileSync(f, JSON.stringify({ rpcs: [null, { url: 'http://x' }, { url: HELIUS, heliusProject: 'meu-projeto' }, { url: HELIUS, heliusProject: PROJECT }, { url: HELIUS2 }] }));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: HELIUS, heliusProject: null }, { url: HELIUS2, heliusProject: null }], 'o ruim sai, o repetido entra uma vez, os bons ficam');
    fs.writeFileSync(f, JSON.stringify({ url: HELIUS, heliusProject: PROJECT }));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: HELIUS, heliusProject: PROJECT }], 'formato antigo, de uma chave');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rpc embutido: o empacotamento recusa URL que não é https, dizendo qual variável e sem repetir a URL no erro', () => {
  for (const bad of ['http://x/?api-key=SEGREDO', 'SEGREDO', '', 'https://a b/?api-key=SEGREDO']) {
    assert.throws(() => embeddedRpcFileContent([{ url: bad }]), (e: Error) => /CLURN_RPC_URL /.test(e.message) && !e.message.includes('SEGREDO'));
    assert.throws(() => embeddedRpcFileContent([{ url: HELIUS }, { url: bad }]), (e: Error) => /CLURN_RPC_URL_2 /.test(e.message) && !e.message.includes('SEGREDO'));
  }
  assert.throws(() => embeddedRpcFileContent([{ url: HELIUS, heliusProject: 'meu-projeto' }]), /CLURN_HELIUS_PROJECT /);
  assert.throws(() => embeddedRpcFileContent([{ url: HELIUS }, { url: HELIUS2, heliusProject: 'x' }]), /CLURN_HELIUS_PROJECT_2 /);
});

test('rpc embutido: chaves do terminal na ordem CLURN_RPC_URL, _2, _3…; em branco é pulada', () => {
  assert.deepEqual(embeddedFromEnv({}), []);
  assert.deepEqual(embeddedFromEnv({ CLURN_RPC_URL: HELIUS, CLURN_HELIUS_PROJECT: PROJECT }), [{ url: HELIUS, heliusProject: PROJECT }]);
  assert.deepEqual(
    embeddedFromEnv({ CLURN_RPC_URL: HELIUS, CLURN_RPC_URL_2: ` ${HELIUS2} `, CLURN_HELIUS_PROJECT_2: PROJECT2 }),
    [{ url: HELIUS }, { url: HELIUS2, heliusProject: PROJECT2 }],
  );
  assert.deepEqual(embeddedFromEnv({ CLURN_RPC_URL: '  ', CLURN_RPC_URL_2: HELIUS2 }), [{ url: HELIUS2 }], 'a 1ª em branco não apaga a 2ª');
});

// ---------- proxy do Clurn (09/11/2026, proxy/): o primeiro embutido, antes das chaves ----------

const PROXY = 'https://clurn-rpc.exemplo.workers.dev/';

test('proxy: CLURN_PROXY_URL entra antes das chaves; vazio por padrão; em branco é pulado', () => {
  assert.equal(PROXY_ENV, 'CLURN_PROXY_URL');
  assert.deepEqual(embeddedFromEnv({}), [], 'sem variável, sem proxy (nenhuma URL inventada no código)');
  assert.deepEqual(embeddedFromEnv({ CLURN_PROXY_URL: ` ${PROXY} ` }), [{ url: PROXY, proxy: true }]);
  assert.deepEqual(
    embeddedFromEnv({ CLURN_RPC_URL: HELIUS, CLURN_HELIUS_PROJECT: PROJECT, CLURN_PROXY_URL: PROXY, CLURN_RPC_URL_2: HELIUS2 }),
    [{ url: PROXY, proxy: true }, { url: HELIUS, heliusProject: PROJECT }, { url: HELIUS2 }],
    'proxy, chave 1, chave 2',
  );
  assert.deepEqual(embeddedFromEnv({ CLURN_PROXY_URL: '  ', CLURN_RPC_URL: HELIUS }), [{ url: HELIUS }]);
});

test('proxy: ordem de queda variável → proxy → chave 1 → chave 2 → público; na devnet nenhum embutido', () => {
  assert.deepEqual(rpcCandidates('mainnet', { embedded: [PROXY, HELIUS, HELIUS2] }), [PROXY, HELIUS, HELIUS2, PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', { env: MINE, embedded: [PROXY, HELIUS] }), [MINE, PROXY, HELIUS, PUBLIC_RPC.mainnet]);
  assert.deepEqual(rpcCandidates('mainnet', { embedded: [PROXY] }), [PROXY, PUBLIC_RPC.mainnet], 'só o proxy: o público fica de reserva');
  assert.deepEqual(rpcCandidates('devnet', { embedded: [PROXY, HELIUS] }), [PUBLIC_RPC.devnet]);
  assert.equal(hasCustomDefault('mainnet', { embedded: [PROXY] }), true);
});

test('proxy: o arquivo do empacotamento grava e lê o proxy marcado; o erro diz CLURN_PROXY_URL e as chaves contam sem ele', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-rpc-'));
  try {
    const f = path.join(dir, EMBEDDED_RPC_NAME);
    fs.writeFileSync(f, embeddedRpcFileContent(embeddedFromEnv({ CLURN_PROXY_URL: PROXY, CLURN_RPC_URL: HELIUS, CLURN_HELIUS_PROJECT: PROJECT })));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: PROXY, heliusProject: null, proxy: true }, { url: HELIUS, heliusProject: PROJECT }]);
    // dado sujo: proxy como texto não vale; proxy com projeto ignora o projeto; repetido entra uma vez
    fs.writeFileSync(f, JSON.stringify({ rpcs: [{ url: PROXY, proxy: 'true' }, { url: HELIUS2, proxy: true, heliusProject: PROJECT }, { url: HELIUS2 }] }));
    assert.deepEqual(readEmbeddedRpcs(f), [{ url: PROXY, heliusProject: null }, { url: HELIUS2, heliusProject: null, proxy: true }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => embeddedRpcFileContent([{ url: 'http://proxy', proxy: true }]), (e: Error) => /^CLURN_PROXY_URL /.test(e.message));
  assert.throws(() => embeddedRpcFileContent([{ url: PROXY, proxy: true }, { url: HELIUS }, { url: 'http://x/?api-key=SEGREDO' }]), (e: Error) => /^CLURN_RPC_URL_2 /.test(e.message) && !e.message.includes('SEGREDO'));
  assert.throws(() => embeddedRpcFileContent([{ url: PROXY, proxy: true }, { url: HELIUS, heliusProject: 'x' }]), /^Error: CLURN_HELIUS_PROJECT /);
});

test('proxy: só o proxy embutido recebe o cabeçalho com a versão do app; Helius, público e variável não recebem nada', () => {
  const embedded = readEmbeddedRpcsFrom([{ url: PROXY, proxy: true }, { url: HELIUS }]);
  assert.deepEqual(rpcHeaders(PROXY, embedded, '0.2.4'), { [VERSION_HEADER]: '0.2.4' });
  assert.equal(VERSION_HEADER, 'x-clurn-versao');
  for (const u of [HELIUS, PUBLIC_RPC.mainnet, MINE]) assert.equal(rpcHeaders(u, embedded, '0.2.4'), undefined, u);
  assert.equal(rpcHeaders(PROXY, [], '0.2.4'), undefined, 'a mesma URL sem estar marcada como proxy');
});

test('proxy: a versão vem do package.json (formato a.b.c); arquivo ausente ou fora do formato → 0.0.0', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
  assert.equal(appVersion(), pkg.version);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-ver-'));
  try {
    const f = path.join(dir, 'package.json');
    assert.equal(appVersion(f), '0.0.0');
    for (const bad of ['{', '{"version":7}', '{"version":"1.0"}', '{"version":"1.0.0\nX: y"}']) {
      fs.writeFileSync(f, bad);
      assert.equal(appVersion(f), '0.0.0', bad);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function readEmbeddedRpcsFrom(rpcs: unknown[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-rpc-'));
  try {
    const f = path.join(dir, EMBEDDED_RPC_NAME);
    fs.writeFileSync(f, JSON.stringify({ rpcs }));
    return readEmbeddedRpcs(f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
