import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  checkUpdate, downloadInstaller, INSTALLER_ARGS, installerEnv, installerUrl, isNewer, launchInstaller, MANIFEST_URL, parseManifest, signedText,
  UPDATE_KEYS, UPDATE_REPO, UpdateFailed, verifyManifest, type FetchFn, type Manifest,
} from '../../src/app/atualizacao.ts';

// par de chaves só deste teste (a privada do autor nunca entra no repositório)
const pair = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), priv: privateKey };
};
const K = pair();
const OTHER = pair();

function signed(fields: Omit<Manifest, 'assinatura'>, priv = K.priv): Manifest {
  return { ...fields, assinatura: crypto.sign(null, Buffer.from(signedText(fields)), priv).toString('base64') };
}
const BYTES = Buffer.from('instalador de teste '.repeat(500));
const SHA = crypto.createHash('sha256').update(BYTES).digest('hex');
const M = signed({ versao: '1.0.1', arquivo: 'Clurn-Setup-1.0.1.exe', tamanho: BYTES.length, sha256: SHA });

// resposta falsa: o fetch de verdade preenche `url` com o endereço final (depois dos redirecionamentos)
function res(body: string | Buffer | null, opts: { status?: number; url?: string; chunks?: Buffer[]; failAt?: number } = {}): Response {
  const status = opts.status ?? 200;
  const chunks = opts.chunks ?? (body === null ? [] : [Buffer.from(body)]);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (opts.failAt !== undefined && i === opts.failAt) return c.error(new Error('conexão caiu'));
      if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++]));
      else c.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, url: opts.url ?? 'https://release-assets.githubusercontent.com/x', body: stream, text: async () => Buffer.concat(chunks).toString('utf8') } as unknown as Response;
}
const fetchOf = (r: Response | (() => Response), seen: string[] = []): FetchFn => async (url) => {
  seen.push(url);
  return typeof r === 'function' ? r() : r;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-teste-atualizacao-'));

test('atualização: endereços fixos no repositório público do projeto', () => {
  assert.equal(UPDATE_REPO, 'clurnapp/clurn');
  assert.equal(MANIFEST_URL, 'https://github.com/clurnapp/clurn/releases/latest/download/clurn-versao.json');
  assert.equal(installerUrl(M), 'https://github.com/clurnapp/clurn/releases/download/v1.0.1/Clurn-Setup-1.0.1.exe');
  assert.deepEqual(INSTALLER_ARGS, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS']);
  // a 1.0 sai com a atualização ligada: duas chaves diferentes (principal e reserva), sempre Ed25519 em SPKI
  assert.equal(UPDATE_KEYS.length, 2);
  assert.equal(new Set(UPDATE_KEYS).size, 2);
  for (const k of UPDATE_KEYS) assert.equal(crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
});

test('atualização: versão nova só se for maior, comparando número a número', () => {
  assert.ok(isNewer('1.0.1', '1.0.0'));
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(isNewer('2.0.0', '1.99.99'));
  assert.ok(!isNewer('1.0.0', '1.0.0'));
  assert.ok(!isNewer('0.9.9', '1.0.0'), 'nunca volta para uma versão mais velha');
  for (const bad of ['1.0', '1.0.0.1', 'v1.0.1', '1.0.1-beta', '', '01.0.1x']) assert.ok(!isNewer(bad, '0.0.1'), bad);
});

test('atualização: arquivo de versão com dado sujo é recusado com o motivo, sem lançar', () => {
  const base = { versao: '1.0.1', arquivo: 'Clurn-Setup-1.0.1.exe', tamanho: 10, sha256: SHA, assinatura: M.assinatura };
  assert.deepEqual(parseManifest(base), base);
  const cases: Array<[unknown, string]> = [
    [null, 'não é um objeto'],
    [[base], 'não é um objeto'],
    ['texto', 'não é um objeto'],
    [{ ...base, versao: '1.0.1-beta' }, 'versão fora do formato'],
    [{ ...base, versao: 101 }, 'versão fora do formato'],
    [{ ...base, arquivo: 'Clurn-Setup-1.0.2.exe' }, 'nome do instalador fora do formato'],
    [{ ...base, arquivo: '..\\..\\Clurn-Setup-1.0.1.exe' }, 'nome do instalador fora do formato'],
    [{ ...base, tamanho: -1 }, 'tamanho fora do formato'],
    [{ ...base, tamanho: '10' }, 'tamanho fora do formato'],
    [{ ...base, tamanho: 1.5 }, 'tamanho fora do formato'],
    [{ ...base, tamanho: 401 * 1024 * 1024 }, 'tamanho fora do formato'],
    [{ ...base, sha256: SHA.toUpperCase() }, 'SHA-256 fora do formato'],
    [{ ...base, sha256: null }, 'SHA-256 fora do formato'],
    [{ ...base, assinatura: 'abc' }, 'assinatura fora do formato'],
    [{ ...base, assinatura: undefined }, 'assinatura fora do formato'],
  ];
  for (const [x, why] of cases) assert.equal(parseManifest(x), why, JSON.stringify(x));
});

test('atualização: assinatura confere só com a chave certa e o texto intacto', () => {
  assert.ok(verifyManifest(M, [K.pub]));
  assert.ok(!verifyManifest(M, [OTHER.pub]), 'outra chave');
  assert.ok(!verifyManifest(M, []), 'nenhuma chave = recusa');
  assert.ok(verifyManifest(M, ['isto não é chave', OTHER.pub, K.pub]), 'chave reserva: qualquer uma das embutidas serve');
  assert.ok(!verifyManifest(M, ['isto não é chave']));
  // cada campo assinado: trocar invalida
  for (const change of [{ versao: '9.9.9', arquivo: 'Clurn-Setup-9.9.9.exe' }, { tamanho: M.tamanho + 1 }, { sha256: 'f'.repeat(64) }]) {
    assert.ok(!verifyManifest({ ...M, ...change }, [K.pub]), JSON.stringify(change));
  }
  // chave que não é Ed25519 não aprova nada
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.ok(!verifyManifest(M, [rsa]));
});

test('atualização: sem chave embutida a consulta nem acontece', async () => {
  const seen: string[] = [];
  assert.deepEqual(await checkUpdate('1.0.0', { fetch: fetchOf(res(JSON.stringify(M)), seen), keys: [] }), { kind: 'disabled' });
  assert.equal(seen.length, 0);
});

test('atualização: versão nova assinada aparece; igual, mais velha ou sem versão publicada não', async () => {
  const seen: string[] = [];
  const r = await checkUpdate('1.0.0', { fetch: fetchOf(res(JSON.stringify(M)), seen), keys: [K.pub] });
  assert.deepEqual(r, { kind: 'available', manifest: M });
  assert.deepEqual(seen, [MANIFEST_URL]);
  assert.deepEqual(await checkUpdate('1.0.1', { fetch: fetchOf(res(JSON.stringify(M))), keys: [K.pub] }), { kind: 'none' });
  assert.deepEqual(await checkUpdate('1.2.0', { fetch: fetchOf(res(JSON.stringify(M))), keys: [K.pub] }), { kind: 'none' });
  assert.deepEqual(await checkUpdate('1.0.0', { fetch: fetchOf(res('Not Found', { status: 404 })), keys: [K.pub] }), { kind: 'none' });
});

test('atualização: falha e dado sujo na consulta viram erro (a tela segue normal), nunca exceção', async () => {
  const check = (r: Response | (() => Response)) => checkUpdate('1.0.0', { fetch: fetchOf(r), keys: [K.pub] });
  assert.deepEqual(await check(res('x', { status: 500 })), { kind: 'error', reason: 'HTTP 500' });
  assert.deepEqual(await check(res('{não é json')), { kind: 'error', reason: 'arquivo de versão não é JSON' });
  assert.deepEqual(await check(res('[]')), { kind: 'error', reason: 'não é um objeto' });
  assert.deepEqual(await check(res('x'.repeat(20_000))), { kind: 'error', reason: 'arquivo de versão grande demais' });
  assert.deepEqual(await check(res(JSON.stringify(signed({ ...M, assinatura: undefined } as never, OTHER.priv)))), { kind: 'error', reason: 'assinatura não confere' });
  assert.deepEqual(await check(res(JSON.stringify(M), { url: 'https://example.com/clurn-versao.json' })), { kind: 'error', reason: 'resposta de um endereço fora do GitHub' });
  assert.deepEqual(await check(res(JSON.stringify(M), { url: 'http://github.com/x' })), { kind: 'error', reason: 'resposta de um endereço fora do GitHub' });
  const offline: FetchFn = async () => {
    throw new TypeError('fetch failed');
  };
  assert.deepEqual(await checkUpdate('1.0.0', { fetch: offline, keys: [K.pub] }), { kind: 'error', reason: 'sem conexão com o GitHub' });
});

test('atualização: download confere tamanho, SHA-256 e assinatura e devolve o instalador', async () => {
  const dir = tmp();
  const progress: number[] = [];
  const seen: string[] = [];
  const chunks = [BYTES.subarray(0, 4000), BYTES.subarray(4000)];
  const file = await downloadInstaller(M, { fetch: fetchOf(res(null, { chunks }), seen), keys: [K.pub], dir, onProgress: (d) => progress.push(d) });
  assert.equal(file, path.join(dir, 'Clurn-Setup-1.0.1.exe'));
  assert.deepEqual(fs.readFileSync(file), BYTES);
  assert.deepEqual(seen, [installerUrl(M)]);
  assert.deepEqual(progress, [4000, BYTES.length]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('atualização: download que não confere é apagado e nada é instalado', async () => {
  const fails = async (m: Manifest, r: Response | (() => Response), reason: 'rede' | 'conferencia', msg: string, keys = [K.pub]) => {
    const dir = tmp();
    await assert.rejects(downloadInstaller(m, { fetch: fetchOf(r), keys, dir }), (e: unknown) => e instanceof UpdateFailed && e.reason === reason && e.message === msg);
    assert.deepEqual(fs.readdirSync(dir), [], 'nenhum arquivo sobra');
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const other = Buffer.from(BYTES);
  other[10] ^= 1;
  await fails(M, () => res(other), 'conferencia', 'o SHA-256 do instalador não confere');
  await fails(M, () => res(Buffer.concat([BYTES, Buffer.from('x')])), 'conferencia', 'o instalador é maior que o anunciado');
  await fails(M, () => res(BYTES.subarray(1)), 'conferencia', 'o instalador veio com outro tamanho');
  await fails(M, () => res(null, { chunks: [BYTES.subarray(0, 100), BYTES.subarray(100)], failAt: 1 }), 'rede', 'o download parou no meio');
  await fails(M, () => res(BYTES, { url: 'https://example.com/Clurn-Setup-1.0.1.exe' }), 'conferencia', 'download de um endereço fora do GitHub');
  await fails(M, () => res('x', { status: 503 }), 'rede', 'HTTP 503');
  // manifesto com assinatura que não confere: nem baixa
  const seen: string[] = [];
  await assert.rejects(downloadInstaller(M, { fetch: fetchOf(res(BYTES), seen), keys: [OTHER.pub], dir: tmp() }), /assinatura não confere/);
  assert.equal(seen.length, 0);
});

test('atualização: o instalador roda separado do app, em modo silencioso; se não abre, avisa', async () => {
  const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown>; unref: boolean }> = [];
  const fakeOf = (event: 'spawn' | 'error') => ((file: string, args: string[], opts: Record<string, unknown>) => {
    const c = { file, args, opts, unref: false };
    calls.push(c);
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => (c.unref = true);
    setImmediate(() => (event === 'spawn' ? child.emit('spawn') : child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))));
    return child;
  }) as never;
  await launchInstaller('C:\\tmp\\Clurn-Setup-1.0.1.exe', fakeOf('spawn'));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, INSTALLER_ARGS);
  assert.equal(calls[0].opts.detached, true);
  assert.equal(calls[0].opts.stdio, 'ignore');
  assert.ok(calls[0].unref);
  // o Clurn reaberto pelo instalador não pode herdar ELECTRON_RUN_AS_NODE do servidor (viraria Node puro e fecharia)
  assert.equal((calls[0].opts.env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(installerEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x' }), { PATH: 'x' });
  // instalador apagado (antivírus) ou bloqueado: a promessa rejeita e o app não fecha
  await assert.rejects(launchInstaller('C:\\tmp\\sumiu.exe', fakeOf('error')), /ENOENT/);
});
