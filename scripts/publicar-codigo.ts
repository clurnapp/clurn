// Código público do Clurn (github.com/clurnapp/clurn): cada versão publicada vira um commit novo lá, sem o histórico
// do repositório de trabalho.
//
//   node scripts/publicar-codigo.ts conferir
//     Procura dado pessoal ou segredo nos arquivos que seriam publicados. Mostra só arquivo, linha e tipo (nunca o
//     trecho achado). Também roda como teste (test/publico.test.ts): se algo aparecer, a suíte cai.
//
//   node scripts/publicar-codigo.ts exportar <pasta fora do repositório> <e-mail do autor no GitHub>
//     Copia só a lista de arquivos públicos para a pasta, confere de novo e faz um commit com o autor "0xkley" (data
//     em UTC). Quem envia para o GitHub (git push) é o autor, com a conta do projeto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

// O que é publicado: o app, os testes, as ferramentas de teste e de empacotar, o proxy e os textos públicos.
// Fica de fora: docs/ (notas internas), o site, os vídeos, as instruções de trabalho e a configuração local.
export const PUBLIC_DIRS = ['src/', 'desktop/', 'test/', 'scripts/', 'proxy/'];
// .gitattributes: sem ele, o git do Windows (autocrlf) troca o fim de linha da lista BIP39 no clone (achado de
// 16/11/2026 no clone público da 1.0.0: o hash oficial não batia).
export const PUBLIC_ROOT_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', '.gitattributes', 'LICENCA.md', 'README.md', 'README.pt-BR.md', 'SECURITY.md'];
// Lista privada das palavras proibidas: só no repositório de trabalho, nunca publicada.
export const FORBIDDEN_FILE = 'scripts/publicar-proibidos.txt';
export const EXCLUDED = ['scripts/servir-site.mjs', FORBIDDEN_FILE];

export function publicFiles(root = ROOT): string[] {
  const all = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  return all.filter((f) => !EXCLUDED.includes(f) && (PUBLIC_ROOT_FILES.includes(f) || PUBLIC_DIRS.some((d) => f.startsWith(d))));
}

// Palavras proibidas guardadas só como hash (16 primeiros dígitos do SHA-256): nomes e endereços que ligariam o
// projeto a pessoas. Comparação por palavra inteira, com e sem maiúsculas.
// A lista fica em FORBIDDEN_FILE, fora do código público: hash de palavra curta (nome, sobrenome) se descobre testando
// uma lista de nomes. Em 16/11/2026 ela estava aqui, e 4 das 8 saíram com 18 tentativas no commit público 42a0503.
export const forbiddenHash = (t: string) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);
const hash = forbiddenHash;

// Lê a lista privada (uma por linha, # comenta). Sem o arquivo (clone do código público): lista vazia.
export function loadForbidden(root = ROOT): Set<string> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, FORBIDDEN_FILE), 'utf8');
  } catch {
    return new Set();
  }
  return new Set(text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[0-9a-f]{16}$/.test(l)));
}
let defaultForbidden: Set<string> | null = null;
const FORBIDDEN = () => (defaultForbidden ??= loadForbidden());

// também dentro de palavras maiores ("nomea", "nomesobrenome"): confere todo pedaço de 4 letras ou mais, em minúsculas
const hasForbidden = (word: string, list: Set<string>) => {
  if (!list.size) return false;
  const w = word.toLowerCase();
  if (list.has(hash(word))) return true;
  for (let i = 0; i < w.length; i++) for (let j = i + 4; j <= w.length; j++) if (list.has(hash(w.slice(i, j)))) return true;
  return false;
};

// segredos pelo formato (vale para qualquer pessoa, não só para as palavras acima)
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['chave privada PEM', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*[\r\n]+[A-Za-z0-9+/=]{40,}/],
  ['chave do Helius', /api-key=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['par de chaves Solana (64 números)', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ['e-mail pessoal', /[A-Za-z0-9._%+-]+@(?:gmail|hotmail|outlook|yahoo|icloud|proton(?:mail)?)\.[a-z.]+/i],
  ['pasta de usuário do Windows', /[A-Za-z]:[\\/]+Users[\\/]+(?!pessoa[\\/]|Public[\\/])[A-Za-z0-9._-]+[\\/]/i],
];

export type Finding = { file: string; line: number; kind: string };

export function scanText(file: string, text: string, forbidden: Set<string> = FORBIDDEN()): Finding[] {
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.split(/[^A-Za-z0-9]+/).some((w) => hasForbidden(w, forbidden))) out.push({ file, line: i + 1, kind: 'nome ou endereço proibido' });
    // o próprio hash de uma palavra proibida também não pode ir para o público (ele se quebra com uma lista de nomes)
    else if (forbidden.size && (line.match(/[0-9a-f]{16}/g) ?? []).some((h) => forbidden.has(h))) out.push({ file, line: i + 1, kind: 'hash de palavra proibida' });
  });
  for (const [kind, re] of SECRET_PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      // chave de mentira dos testes (só algarismos, como 11111111-2222-…): não é segredo
      if (kind === 'chave do Helius' && /^api-key=[\d-]+$/i.test(m[0])) continue;
      out.push({ file, line: text.slice(0, m.index).split('\n').length, kind });
    }
  }
  return out;
}

const BINARY = /\.(png|ico|jpg|jpeg|gif|webp|woff2?|ttf|exe|zip)$/i;

export function scanFiles(files: string[], root = ROOT, forbidden: Set<string> = FORBIDDEN()): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (BINARY.test(f)) continue;
    out.push(...scanText(f, fs.readFileSync(path.join(root, f), 'utf8'), forbidden));
  }
  return out;
}

// Conteúdo de um arquivo no último commit (o que vai para o público), não o da pasta de trabalho.
const committed = (root: string, f: string): Buffer => execFileSync('git', ['show', `HEAD:${f}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 });

export function exportTo(dir: string, email: string, root = ROOT, forbidden: Set<string> = loadForbidden(root)): number {
  const rel = path.relative(root, path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) throw new Error('A pasta de exportação precisa ficar fora do repositório.');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('A pasta de exportação precisa estar vazia.');
  if (!/^[^@\s]+@users\.noreply\.github\.com$/.test(email)) throw new Error('Use o e-mail privado do GitHub da conta do projeto (…@users.noreply.github.com).');
  // sem a lista privada, o verificador não acha nome nenhum: não exporta às cegas
  if (!forbidden.size) throw new Error(`Lista de palavras proibidas ausente ou vazia (${FORBIDDEN_FILE}): não dá para conferir o que vai ser publicado.`);
  const files = publicFiles(root);
  if (files.includes(FORBIDDEN_FILE)) throw new Error('A lista de palavras proibidas não pode ir para o público.');
  // Copia do último commit, não da pasta de trabalho: edição local não commitada (um author com nome, por exemplo)
  // não vai junto. O que é conferido é exatamente o que é gravado.
  const content = new Map(files.map((f) => [f, committed(root, f)]));
  const found = files.filter((f) => !BINARY.test(f)).flatMap((f) => scanText(f, content.get(f)!.toString('utf8'), forbidden));
  if (found.length) throw new Error(`Dado pessoal ou segredo em ${found.length} lugar(es): rode "conferir" e corrija antes.`);
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content.get(f)!);
  }
  const version = JSON.parse(content.get('package.json')!.toString('utf8')).version;
  const env = { ...process.env, GIT_AUTHOR_NAME: '0xkley', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: '0xkley', GIT_COMMITTER_EMAIL: email, GIT_AUTHOR_DATE: new Date().toISOString().replace(/\.\d+Z$/, '+0000'), GIT_COMMITTER_DATE: new Date().toISOString().replace(/\.\d+Z$/, '+0000') };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Clurn ${version}`);
  return files.length;
}

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'conferir') {
      if (!FORBIDDEN().size) throw new Error(`Lista de palavras proibidas ausente ou vazia (${FORBIDDEN_FILE}).`);
      const files = publicFiles();
      const found = scanFiles(files);
      for (const x of found) console.log(`${x.file}:${x.line}  ${x.kind}`);
      console.log(found.length ? `${found.length} problema(s) em ${files.length} arquivos públicos.` : `Nada encontrado em ${files.length} arquivos públicos.`);
      process.exitCode = found.length ? 1 : 0;
    } else if (cmd === 'exportar' && a && b) {
      const n = exportTo(a, b);
      console.log(`${n} arquivos exportados para ${a}, com um commit de 0xkley. Confira e envie com a conta do projeto.`);
    } else {
      console.log('Uso:\n  node scripts/publicar-codigo.ts conferir\n  node scripts/publicar-codigo.ts exportar <pasta fora do repositório> <e-mail …@users.noreply.github.com>');
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'erro desconhecido');
    process.exitCode = 1;
  }
}
