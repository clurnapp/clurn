// Código público (github.com/clurnapp/clurn): nenhum arquivo da lista pública pode ter dado pessoal ou segredo.
// Se este teste cair, a publicação também para (scripts/publicar-codigo.ts recusa exportar).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXCLUDED, EXCLUDED_DIRS, FORBIDDEN_FILE, PUBLIC_DIRS, PUBLIC_ROOT_FILES, forbiddenHash, loadForbidden, publicFiles, scanFiles, scanText as scanWith } from '../scripts/publicar-codigo.ts';

// A lista privada só existe no repositório de trabalho; num clone do código público ela não existe.
const PRIVATE_LIST = fs.existsSync(path.join(import.meta.dirname, '..', FORBIDDEN_FILE));

test('público: a lista de palavras proibidas fica fora da publicação e nenhum hash dela aparece nos arquivos públicos', { skip: !PRIVATE_LIST && 'clone do código público (sem a lista privada)' }, () => {
  const list = loadForbidden();
  assert.ok(list.size >= 10, 'a lista privada tem os nomes e as carteiras');
  const files = publicFiles();
  assert.ok(!files.includes(FORBIDDEN_FILE));
  assert.ok(EXCLUDED.includes(FORBIDDEN_FILE));
  for (const f of files) {
    if (/\.(png|ico|jpg|jpeg|gif|webp|woff2?|ttf|exe|zip)$/i.test(f)) continue;
    const text = fs.readFileSync(path.join(import.meta.dirname, '..', f), 'utf8');
    for (const h of list) assert.ok(!text.includes(h), `${f} tem um hash da lista privada`);
  }
});

test('público: o hash de uma palavra proibida também é achado (ele se quebra com uma lista de nomes)', () => {
  const h = forbiddenHash('Fulanildo');
  const r = scanWith('x.ts', `const LIST = ['${h}'];`, new Set([h]));
  assert.deepEqual(r.map((x) => x.kind), ['hash de palavra proibida']);
  assert.deepEqual(scanWith('x.ts', `const LIST = ['${h}'];`, new Set()), [], 'sem lista, nada a achar');
});

test('público: exportar recusa sem a lista privada (não confere às cegas) e copia o commit, não a pasta de trabalho', async () => {
  const { exportTo } = await import('../scripts/publicar-codigo.ts');
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-export-'));
  assert.throws(() => exportTo(empty, 'x@users.noreply.github.com', undefined, new Set()), /proibidas ausente/);
  fs.rmSync(empty, { recursive: true, force: true });
  // repositório de mentira: arquivo commitado limpo, pasta de trabalho com um nome proibido não commitado
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-repo-'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-out-'));
  const { execFileSync } = await import('node:child_process');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9', author: 'anon' }));
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'x');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '9.9.9', author: 'Fulanildo' }));
  const list = new Set([forbiddenHash('Fulanildo')]);
  fs.rmSync(out, { recursive: true, force: true });
  assert.equal(exportTo(out, 'x@users.noreply.github.com', repo, list), 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8')).author, 'anon', 'foi o commit, não a edição local');
  // limpeza da pasta temporária: os objetos do git são somente-leitura no Windows e o Node do Electron não os apaga
  // (EPERM); a sobra fica no temp do sistema, não conta como falha da regra
  for (const d of [repo, out]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // segue
    }
  }
});

test('público: o .gitattributes vai junto e prende o fim de linha da lista BIP39', () => {
  assert.ok(publicFiles().includes('.gitattributes'));
  const attrs = fs.readFileSync(path.join(import.meta.dirname, '..', '.gitattributes'), 'utf8');
  assert.match(attrs, /^src\/core\/carteiras\/bip39-english\.txt\s+-text\s*$/m);
});


test('público: nenhum arquivo da lista pública tem nome proibido, e-mail pessoal ou segredo', () => {
  const files = publicFiles();
  assert.ok(files.length > 150, 'a lista pública tem o app inteiro');
  const found = scanFiles(files);
  assert.deepEqual(found, []);
});

test('público: o painel privado (admin/ e test/admin/) fica fora', () => {
  assert.ok(EXCLUDED_DIRS.includes('test/admin/'));
  assert.ok(!publicFiles().some((f) => f.startsWith('test/admin/') || f.startsWith('admin/')));
});

test('público: a lista leva o app e os testes, e deixa de fora as notas internas, o site e os vídeos', () => {
  const files = publicFiles();
  for (const must of ['src/app/server.ts', 'src/core/features.ts', 'src/app/atualizacao.ts', 'desktop/main.ts', 'test/publico.test.ts', 'package.json', 'LICENCA.md', 'scripts/empacotar.ts']) assert.ok(files.includes(must), must);
  for (const f of files) {
    assert.ok(!/^(docs|site|video|ico)\//.test(f), `fora da lista: ${f}`);
    assert.ok(!['CLAUDE.md', 'wrangler.jsonc'].includes(f), `fora da lista: ${f}`);
    assert.ok(!f.startsWith('admin/') && !f.startsWith('test/admin/'), `painel privado fora da lista: ${f}`);
    assert.ok(!EXCLUDED.includes(f));
    assert.ok(PUBLIC_ROOT_FILES.includes(f) || PUBLIC_DIRS.some((d) => f.startsWith(d)));
  }
});

test('público: o verificador acha o que deve (sem repetir o trecho achado)', () => {
  // nome fictício numa lista própria do teste: nenhum nome de verdade fica escrito (nem codificado) no repositório.
  // Até a 1.0.0 este teste montava o nome real com fromCharCode, que qualquer um decodifica.
  const name = 'Fulanildo';
  const list = new Set([forbiddenHash(name), forbiddenHash(name.toLowerCase())]);
  const scanText = (file: string, text: string) => scanWith(file, text, list);
  const cases: Array<[string, string]> = [
    [`// pedido do ${name}`, 'nome ou endereço proibido'],
    [`const x = '${name.toUpperCase()}';`, 'nome ou endereço proibido'],
    [`// ${name.toLowerCase()}a e ${name}Sobrenome`, 'nome ou endereço proibido'], // dentro de palavra maior
    ['-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(64), 'chave privada PEM'],
    ['https://mainnet.helius-rpc.com/?api-key=' + ['1b2c3d4e', 'aaaa', '4bbb', '8ccc', '1234567890ab'].join('-'), 'chave do Helius'],
    [`[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`, 'par de chaves Solana (64 números)'],
    ['contato: alguem.qualquer@' + 'gmail.com', 'e-mail pessoal'],
    ['C:\\Users\\' + 'fulano\\Desktop\\frase.txt', 'pasta de usuário do Windows'],
  ];
  for (const [text, kind] of cases) {
    const r = scanText('x.ts', text);
    assert.equal(r.length, 1, text.slice(0, 40));
    assert.equal(r[0].kind, kind);
    assert.ok(!JSON.stringify(r).includes(name), 'o resultado não repete o nome');
  }
  // o que não é segredo passa
  for (const ok of ['https://mainnet.helius-rpc.com/?api-key=11111111-2222-3333-4444-555555555555', 'C:/Users/pessoa/segredos/frase.txt', '[1,2,3]', 'noreply@users.noreply.github.com']) {
    assert.deepEqual(scanText('x.ts', ok), [], ok);
  }
});

test('público: exportar recusa pasta dentro do repositório, pasta com coisas e e-mail que não é o privado do GitHub', async () => {
  const { exportTo } = await import('../scripts/publicar-codigo.ts');
  assert.throws(() => exportTo(path.join(import.meta.dirname, '..', 'export'), 'x@users.noreply.github.com'), /fora do repositório/);
  const full = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-export-'));
  fs.writeFileSync(path.join(full, 'a.txt'), 'x');
  assert.throws(() => exportTo(full, 'x@users.noreply.github.com'), /vazia/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-export-'));
  assert.throws(() => exportTo(empty, 'pessoa@' + 'gmail.com'), /noreply/);
  fs.rmSync(full, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});
