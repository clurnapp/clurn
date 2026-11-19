// Chave de assinatura das atualizações (src/app/atualizacao.ts). Quem roda é o autor, no computador dele.
//
//   node scripts/chave-atualizacao.ts gerar <pasta fora do repositório>
//     Cria um par Ed25519: a chave PRIVADA vai para <pasta>/clurn-atualizacao-<id>.pem e a PÚBLICA é mostrada na tela,
//     para colar em UPDATE_KEYS (src/app/atualizacao.ts). Rode duas vezes, em pastas diferentes: a principal e a
//     reserva (guardadas em lugares diferentes, por exemplo dois pen drives). Perder as duas = ninguém atualiza mais.
//
//   node scripts/chave-atualizacao.ts assinar <Clurn-Setup-X.Y.Z.exe> <chave.pem>
//     Escreve clurn-versao.json ao lado do instalador. Os dois vão para o GitHub Release da versão (tag vX.Y.Z).
//
// A chave privada nunca entra no repositório, em log ou em mensagem: o script recusa pasta dentro do repositório e
// não mostra a chave.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST_FILE, parseManifest, signedText, UPDATE_KEYS, verifyManifest, type Manifest } from '../src/app/atualizacao.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const inside = (dir: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function generateKey(dir: string, repoRoot = REPO_ROOT): { file: string; publicKey: string } {
  if (inside(dir, repoRoot)) throw new Error('A pasta da chave privada não pode ficar dentro do repositório. Use um pen drive ou outra pasta fora dele.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('A pasta não existe.');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const id = crypto.createHash('sha256').update(pub).digest('hex').slice(0, 8);
  const file = path.join(dir, `clurn-atualizacao-${id}.pem`);
  // 'wx': nunca sobrescreve uma chave que já existe
  fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
  return { file, publicKey: pub };
}

export function signInstaller(installer: string, keyFile: string, keys: string[] = UPDATE_KEYS): Manifest {
  const name = path.basename(installer);
  const m = /^Clurn-Setup-(\d{1,4}\.\d{1,4}\.\d{1,4})\.exe$/.exec(name);
  if (!m) throw new Error('O instalador precisa se chamar Clurn-Setup-X.Y.Z.exe (saída do npm run empacotar).');
  const bytes = fs.readFileSync(installer);
  const fields = { versao: m[1], arquivo: name, tamanho: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('A chave não é Ed25519 (gere com: node scripts/chave-atualizacao.ts gerar <pasta>).');
  const manifest: Manifest = { ...fields, assinatura: crypto.sign(null, Buffer.from(signedText(fields)), key).toString('base64') };
  // a assinatura precisa conferir com uma chave embutida no app, senão ninguém aceitaria esta versão
  if (!verifyManifest(manifest, keys)) throw new Error('Esta chave não é nenhuma das chaves públicas do app (UPDATE_KEYS). Nada foi escrito.');
  return manifest;
}

// Variável do terminal com o CAMINHO da chave privada (nunca o conteúdo): com ela, o npm run empacotar já sai com o
// clurn-versao.json pronto ao lado do instalador (16/11/2026: sem esse arquivo no Release, ninguém recebe a versão).
export const KEY_ENV = 'CLURN_CHAVE_ATUALIZACAO';

// Assina o instalador recém-gerado e grava o clurn-versao.json ao lado. Confere o que gravou relendo do disco
// (formato, assinatura nas chaves do app, tamanho e SHA-256 do instalador), do mesmo jeito que o app vai conferir.
// Sem a variável: apaga um clurn-versao.json velho da pasta (de outra versão, que alguém poderia subir por engano)
// e devolve o aviso. Devolve o texto para o terminal; erro de chave lança (o empacotamento para com a mensagem).
export function signRelease(installer: string, env: NodeJS.ProcessEnv, keys: string[] = UPDATE_KEYS, repoRoot = REPO_ROOT): string {
  const out = path.join(path.dirname(installer), MANIFEST_FILE);
  if (!/\.exe$/i.test(installer)) {
    fs.rmSync(out, { force: true });
    return 'Atualização: sem instalador (.zip), sem clurn-versao.json. O app não se atualiza a partir de um .zip.';
  }
  const keyFile = env[KEY_ENV]?.trim();
  if (!keyFile) {
    fs.rmSync(out, { force: true });
    return [
      `ATENÇÃO: ${KEY_ENV} vazia, saiu SEM o ${MANIFEST_FILE}. Sem ele no Release, o app de ninguém se atualiza.`,
      `  Assine agora: node scripts/chave-atualizacao.ts assinar "${installer}" <chave.pem>`,
      `  Ou, da próxima vez: $env:${KEY_ENV} = '<caminho da chave .pem no pen drive>'; npm run empacotar`,
    ].join('\n');
  }
  if (inside(keyFile, repoRoot)) throw new Error('A chave privada não pode ficar dentro do repositório. Nada foi assinado.');
  if (!fs.existsSync(keyFile)) throw new Error(`${KEY_ENV} aponta para um arquivo que não existe (o pen drive está conectado?). Nada foi assinado.`);
  const manifest = signInstaller(installer, keyFile, keys);
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  // relê do disco e confere como o app
  const back = parseManifest(JSON.parse(fs.readFileSync(out, 'utf8')));
  const bytes = fs.readFileSync(installer);
  if (typeof back === 'string' || !verifyManifest(back, keys) || back.tamanho !== bytes.length || back.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) {
    fs.rmSync(out, { force: true });
    throw new Error(`O ${MANIFEST_FILE} gravado não passou na conferência. Foi apagado; nada para subir.`);
  }
  return [
    `Atualização: ${MANIFEST_FILE} assinado e conferido (versão ${manifest.versao}).`,
    `  Suba os DOIS no GitHub Release v${manifest.versao}: ${manifest.arquivo} e ${MANIFEST_FILE} (${out}).`,
  ].join('\n');
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'gerar' && a) {
      const r = generateKey(a);
      console.log(`Chave privada gravada em: ${r.file}`);
      console.log('Guarde esse arquivo fora do computador de trabalho e não mande para ninguém.');
      console.log(`Chave pública (cole em UPDATE_KEYS, src/app/atualizacao.ts):\n${r.publicKey}`);
    } else if (cmd === 'assinar' && a && b) {
      const manifest = signInstaller(a, b);
      const out = path.join(path.dirname(a), MANIFEST_FILE);
      fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`Assinado: ${manifest.arquivo} (versão ${manifest.versao}, ${manifest.tamanho} bytes)`);
      console.log(`SHA-256: ${manifest.sha256}`);
      console.log(`Suba os dois no GitHub Release v${manifest.versao}: ${manifest.arquivo} e ${MANIFEST_FILE} (${out}).`);
    } else {
      console.log('Uso:\n  node scripts/chave-atualizacao.ts gerar <pasta fora do repositório>\n  node scripts/chave-atualizacao.ts assinar <Clurn-Setup-X.Y.Z.exe> <chave.pem>');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'erro desconhecido');
    process.exitCode = 1;
  }
}
