// Entrada e saída do terminal, comum aos comandos. A frase nunca é ecoada nem registrada.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const PUBLIC_TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

export class UserError extends Error {}

export function isInsideRepo(file: string, root = REPO_ROOT): boolean {
  const rel = path.relative(root.toLowerCase(), path.resolve(file).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Uma interface só para a sessão inteira (funciona também com respostas vindas por pipe).
let rl: readline.Interface | null = null;
let muted = false;
const pending: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let closed = false;

function ensure() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  const original = r._writeToOutput.bind(rl);
  r._writeToOutput = (s: string) => {
    if (!muted) original(s);
  };
  rl.on('line', (line) => {
    const w = waiting.shift();
    if (w) w(line);
    else pending.push(line);
  });
  rl.on('close', () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
}

// fresh: descarta o que foi digitado ANTES da pergunta (aprendido no teste real: o usuário digitou um
// comando enquanto o app simulava, e o texto ficou guardado como resposta da próxima pergunta).
// Só vale no terminal interativo; com respostas por pipe (testes) elas já vêm de antemão.
export function ask(question: string, opts: { hidden?: boolean; fresh?: boolean } = {}): Promise<string> {
  ensure();
  if (opts.fresh && process.stdin.isTTY) pending.length = 0;
  process.stdout.write(question);
  muted = Boolean(opts.hidden);
  return new Promise((resolve, reject) => {
    const done = (line: string | null) => {
      muted = false;
      if (opts.hidden) process.stdout.write('\n');
      if (line === null) reject(new UserError('Entrada encerrada antes da resposta.'));
      else resolve(line);
    };
    const p = pending.shift();
    if (p !== undefined) done(p);
    else if (closed) done(null);
    else waiting.push(done);
  });
}

export function closeInput() {
  rl?.close();
  rl = null;
}

export async function readMnemonic(opts: { seedFile?: string; publicTest: boolean }): Promise<string> {
  if (opts.publicTest) return PUBLIC_TEST_MNEMONIC;
  if (opts.seedFile) {
    if (isInsideRepo(opts.seedFile)) {
      throw new UserError('O arquivo da frase está dentro da pasta do projeto. Mova para fora do repositório e rode de novo.');
    }
    try {
      return fs.readFileSync(opts.seedFile, 'utf8');
    } catch {
      throw new UserError('Não consegui ler o arquivo da frase. Confira o caminho.');
    }
  }
  // achado da revisão: sem terminal interativo (ex.: Git Bash/mintty) a digitação pode aparecer na tela
  if (!process.stdin.isTTY) {
    throw new UserError('Este terminal não consegue esconder a frase. Abra o PowerShell (ou Prompt de Comando) e rode de novo, ou use --seed-file com um arquivo fora do repositório.');
  }
  return ask('Cole a frase de recuperação (não aparece na tela) e tecle Enter: ', { hidden: true });
}

export function short(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

// sol: valor pela curva da Pump.fun, usado quando não há como converter para dólar (preço do SOL desconhecido)
export function usd(v: number | null, sol: number | null = null): string {
  if (v === null) return sol === null ? 'valor desconhecido' : `≈ ${sol.toLocaleString('pt-BR', { maximumFractionDigits: 6 })} SOL pela curva da Pump.fun`;
  if (v < 0.01) return '< US$ 0,01';
  return `≈ US$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function writeReport(prefix: string, data: unknown): string {
  const dir = path.join(REPO_ROOT, 'relatorios'); // pasta no .gitignore
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  return file;
}

export const line = (c = '─') => console.log(c.repeat(72));
