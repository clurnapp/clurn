// Atualização pelo próprio app, do lado do servidor: consulta, recusa no meio de uma tarefa, download que falha,
// instalador que não abre e o caminho feliz (apaga a sessão e fecha). Rede, download e instalador são falsos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetUpdateForTest, startUpdateCheck, updateDeps, updateRefusal, updateView } from '../../src/app/server.ts';
import { UpdateFailed, type Manifest, type UpdateCheck } from '../../src/app/atualizacao.ts';

const M: Manifest = { versao: '1.0.1', arquivo: 'Clurn-Setup-1.0.1.exe', tamanho: 10, sha256: 'a'.repeat(64), assinatura: 'A'.repeat(86) + '==' };
const real = { ...updateDeps };
const fake = (check: UpdateCheck) => {
  resetUpdateForTest();
  Object.assign(updateDeps, real, { check: async () => check });
};

test('servidor/atualização: sem versão nova, desligada ou com erro, nada aparece e o botão é recusado', async () => {
  for (const c of [{ kind: 'none' }, { kind: 'disabled' }, { kind: 'error', reason: 'assinatura não confere' }] as UpdateCheck[]) {
    fake(c);
    await startUpdateCheck('1.0.0');
    assert.equal(updateView().status, 'nada', c.kind);
    assert.ok(updateRefusal(null, false), 'nada para instalar');
  }
});

test('servidor/atualização: versão nova aparece; o botão é recusado no meio de qualquer tarefa ou pausa', async () => {
  fake({ kind: 'available', manifest: M });
  await startUpdateCheck('1.0.0');
  assert.deepEqual(updateView(), { status: 'disponivel', versao: '1.0.1', progresso: null, erro: null });
  assert.equal(updateRefusal(null, false), null);
  for (const busy of ['analise', 'execucao', 'simulacao', 'atualizacao']) assert.ok(updateRefusal(busy, false), busy);
  assert.ok(updateRefusal(null, true), 'pausa');
});

test('servidor/atualização: download que falha ou instalador que não abre → erro, app não fecha, dá para tentar de novo', async () => {
  for (const [why, err] of [['conferencia', new UpdateFailed('conferencia', 'o SHA-256 do instalador não confere')], ['rede', new UpdateFailed('rede', 'HTTP 503')]] as const) {
    fake({ kind: 'available', manifest: M });
    let exited = false;
    Object.assign(updateDeps, { download: async () => { throw err; }, exit: () => (exited = true) });
    await startUpdateCheck('1.0.0');
    const r = await fetchInstall();
    assert.equal(r, 'erro');
    assert.deepEqual(updateView(), { status: 'erro', versao: '1.0.1', progresso: null, erro: why });
    assert.ok(!exited);
    assert.equal(updateRefusal(null, false), null, 'pode tentar de novo');
  }
  fake({ kind: 'available', manifest: M });
  let exited = false;
  Object.assign(updateDeps, { download: async () => 'C:\tmp\Clurn-Setup-1.0.1.exe', launch: async () => { throw new Error('spawn ENOENT'); }, exit: () => (exited = true) });
  await startUpdateCheck('1.0.0');
  assert.equal(await fetchInstall(), 'erro');
  assert.equal(updateView().erro, 'instalador');
  assert.ok(!exited, 'instalador que não abre não fecha o app');
});

test('servidor/atualização: instalador abriu → progresso, sessão apagada e o app fecha com código 0', async () => {
  fake({ kind: 'available', manifest: M });
  const launched: string[] = [];
  let exitCode: number | null = null;
  Object.assign(updateDeps, {
    download: async (_m: Manifest, o: { onProgress?: (d: number, t: number) => void }) => {
      o.onProgress?.(5, 10);
      o.onProgress?.(10, 10);
      return 'C:\tmp\Clurn-Setup-1.0.1.exe';
    },
    launch: async (f: string) => { launched.push(f); },
    exit: (c: number) => (exitCode = c),
  });
  await startUpdateCheck('1.0.0');
  assert.equal(await fetchInstall(), 'instalando');
  assert.deepEqual(launched, ['C:\tmp\Clurn-Setup-1.0.1.exe']);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(exitCode, 0);
  Object.assign(updateDeps, real);
});

// chama a rota pelo servidor de verdade (porta livre, token da página)
import http from 'node:http';
import { createServer } from '../../src/app/server.ts';
const TOKEN = 'teste-atualizacao';
async function fetchInstall(): Promise<string> {
  const server = createServer(0, TOKEN);
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as { port: number }).port;
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/atualizar', method: 'POST', headers: { 'content-type': 'application/json', 'x-token': TOKEN, host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end('{}');
  });
  assert.equal(status, 202);
  for (let i = 0; i < 50 && (updateView().status === 'baixando' || updateView().status === 'disponivel'); i++) await new Promise((r) => setTimeout(r, 10));
  server.close();
  return updateView().status;
}

test('servidor/atualização: só o app instalado (--empacotado) consulta; o npm start e os testes não', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../src/app/server.ts', import.meta.url), 'utf8');
  const calls = src.match(/startUpdateCheck\(\)/g) ?? [];
  assert.equal(calls.length, 1, 'uma chamada só');
  assert.match(src, /if \(process\.argv\.includes\('--empacotado'\)\) void startUpdateCheck\(\);/);
});
