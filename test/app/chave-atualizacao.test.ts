import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKey, KEY_ENV, signInstaller, signRelease } from '../../scripts/chave-atualizacao.ts';
import { MANIFEST_FILE, parseManifest, verifyManifest } from '../../src/app/atualizacao.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-teste-chave-'));

test('chave de atualização: a privada nunca fica dentro do repositório nem sobrescreve outra', () => {
  const repo = tmp();
  assert.throws(() => generateKey(repo, repo), /dentro do repositório/);
  fs.mkdirSync(path.join(repo, 'secrets'));
  assert.throws(() => generateKey(path.join(repo, 'secrets'), repo), /dentro do repositório/);
  assert.throws(() => generateKey(path.join(os.tmpdir(), 'nao-existe-clurn-x'), repo), /não existe/);
  const dir = tmp();
  const k = generateKey(dir, repo);
  assert.ok(fs.readFileSync(k.file, 'utf8').startsWith('-----BEGIN PRIVATE KEY-----'));
  assert.ok(!k.publicKey.includes('PRIVATE'));
  // mesmo nome de novo (mesma chave pública) seria sobrescrever: 'wx' recusa
  assert.throws(() => fs.writeFileSync(k.file, 'x', { flag: 'wx' }));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('chave de atualização: assinar gera o manifesto que o app aceita; outra chave ou instalador mudado não', () => {
  const repo = tmp();
  const dir = tmp();
  const main = generateKey(dir, repo);
  const reserve = generateKey(dir, repo);
  const installer = path.join(dir, 'Clurn-Setup-1.0.1.exe');
  fs.writeFileSync(installer, Buffer.from('instalador falso'));
  const m = signInstaller(installer, main.file, [main.publicKey, reserve.publicKey]);
  assert.equal(m.versao, '1.0.1');
  assert.equal(m.tamanho, 16);
  assert.ok(verifyManifest(m, [main.publicKey]));
  // a reserva também assina
  assert.ok(verifyManifest(signInstaller(installer, reserve.file, [main.publicKey, reserve.publicKey]), [reserve.publicKey]));
  // chave que não está no app: recusa antes de escrever qualquer coisa
  assert.throws(() => signInstaller(installer, main.file, [reserve.publicKey]), /nenhuma das chaves públicas/);
  // instalador com outro nome
  const wrong = path.join(dir, 'clurn.exe');
  fs.writeFileSync(wrong, 'x');
  assert.throws(() => signInstaller(wrong, main.file, [main.publicKey]), /Clurn-Setup-X\.Y\.Z\.exe/);
  // o instalador mudou depois de assinado: o manifesto antigo não bate com o arquivo novo
  fs.writeFileSync(installer, Buffer.from('instalador trocado'));
  const again = signInstaller(installer, main.file, [main.publicKey]);
  assert.notEqual(again.sha256, m.sha256);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// 16/11/2026: o npm run empacotar sai com o clurn-versao.json assinado (sem ele no Release, ninguém atualiza)
test('empacotar: com a chave, grava o clurn-versao.json ao lado do instalador, conferido como o app confere', () => {
  const repo = tmp();
  const keys = tmp();
  const out = tmp();
  const k = generateKey(keys, repo);
  const exe = path.join(out, 'Clurn-Setup-1.0.1.exe');
  fs.writeFileSync(exe, Buffer.from('instalador de teste'));
  const msg = signRelease(exe, { [KEY_ENV]: k.file }, [k.publicKey], repo);
  assert.match(msg, /assinado e conferido \(versão 1\.0\.1\)/);
  assert.match(msg, /Suba os DOIS/);
  const m = parseManifest(JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8')));
  assert.ok(typeof m !== 'string');
  assert.equal(m.versao, '1.0.1');
  assert.equal(m.tamanho, 19);
  assert.ok(verifyManifest(m, [k.publicKey]));
  assert.ok(!msg.includes('PRIVATE') && !fs.readFileSync(path.join(out, MANIFEST_FILE), 'utf8').includes('PRIVATE'), 'a chave privada não aparece');
  for (const d of [repo, keys, out]) fs.rmSync(d, { recursive: true, force: true });
});

test('empacotar: sem a chave, avisa alto e apaga um clurn-versao.json velho (não sobe o de outra versão por engano)', () => {
  const out = tmp();
  const exe = path.join(out, 'Clurn-Setup-1.0.1.exe');
  fs.writeFileSync(exe, 'x');
  fs.writeFileSync(path.join(out, MANIFEST_FILE), '{"versao":"1.0.0"}');
  const msg = signRelease(exe, {}, ['x']);
  assert.match(msg, /ATENÇÃO: CLURN_CHAVE_ATUALIZACAO vazia, saiu SEM o clurn-versao\.json/);
  assert.match(msg, /node scripts\/chave-atualizacao\.ts assinar/);
  assert.equal(fs.existsSync(path.join(out, MANIFEST_FILE)), false);
  // .zip (sem Inno Setup): não há atualização a partir dele
  const zip = path.join(out, 'Clurn-win32-x64.zip');
  fs.writeFileSync(zip, 'x');
  assert.match(signRelease(zip, { [KEY_ENV]: 'qualquer' }, ['x']), /sem instalador/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('empacotar: chave dentro do repositório, inexistente ou que não é do app → para sem gravar nada', () => {
  const repo = tmp();
  const out = tmp();
  const keys = tmp();
  const exe = path.join(out, 'Clurn-Setup-1.0.1.exe');
  fs.writeFileSync(exe, 'x');
  assert.throws(() => signRelease(exe, { [KEY_ENV]: path.join(repo, 'chave.pem') }, ['x'], repo), /dentro do repositório/);
  assert.throws(() => signRelease(exe, { [KEY_ENV]: path.join(keys, 'nao-existe.pem') }, ['x'], repo), /não existe/);
  const other = generateKey(keys, repo);
  const appKey = generateKey(tmp(), repo).publicKey;
  assert.throws(() => signRelease(exe, { [KEY_ENV]: other.file }, [appKey], repo), /não é nenhuma das chaves públicas do app/);
  assert.equal(fs.existsSync(path.join(out, MANIFEST_FILE)), false);
  for (const d of [repo, out, keys]) fs.rmSync(d, { recursive: true, force: true });
});
