// Atualização pelo próprio app (a partir da 1.0, decisão de 16/11/2026).
//
// O que acontece, nesta ordem:
// 1. Na abertura do app instalado, uma consulta só de leitura ao GitHub Releases do repositório público pega o
//    arquivo clurn-versao.json da última versão. Nada do usuário vai junto (nem frase, nem endereço).
// 2. O app só mostra "versão nova" se o arquivo estiver assinado por uma das chaves públicas abaixo (Ed25519).
//    A chave privada fica com o autor, fora do repositório e fora do computador de trabalho: quem invadir a conta
//    do GitHub e publicar outro instalador não consegue assinar, e o app recusa.
// 3. Só com o clique da pessoa: baixa o instalador, confere o tamanho, o SHA-256 e a assinatura de novo, e roda o
//    instalador em modo silencioso. O app fecha e o instalador o abre de novo já atualizado.
// Qualquer coisa fora do esperado (rede, formato, assinatura, tamanho, hash) para e não instala nada.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Repositório público com o código e as versões (conta do projeto, sem ligação com a conta pessoal do autor)
export const UPDATE_REPO = 'clurnapp/clurn';
// Chaves públicas Ed25519 (SPKI DER em base64): a principal e a reserva, geradas pelo autor com
// `node scripts/chave-atualizacao.ts gerar <pasta fora do repositório>`. Vazio = atualização desligada.
export const UPDATE_KEYS: string[] = [
  'MCowBQYDK2VwAyEARlx4O9xA7mxZ/7N52FcWZMnGOaAs2KdGuW2jSuAWv+4=', // principal (edd53906), 16/11/2026
  'MCowBQYDK2VwAyEAdhXe/3wZrwM7MifT/rT9c1pHGhwbADxVHZq4wPVvkeo=', // reserva (1ff7c207), 16/11/2026
];

export const MANIFEST_FILE = 'clurn-versao.json';
export const MANIFEST_URL = `https://github.com/${UPDATE_REPO}/releases/latest/download/${MANIFEST_FILE}`;
export const installerUrl = (m: Manifest) => `https://github.com/${UPDATE_REPO}/releases/download/v${m.versao}/${m.arquivo}`;
// o GitHub responde com redirecionamento para o armazenamento dele; outro destino é recusado
export const ALLOWED_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_INSTALLER_BYTES = 400 * 1024 * 1024;
// argumentos do Inno Setup: sem janelas, fecha o Clurn aberto, não reinicia o Windows
export const INSTALLER_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'];
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export type Manifest = { versao: string; arquivo: string; tamanho: number; sha256: string; assinatura: string };
export type FetchFn = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

// O texto assinado: tudo o que decide o que é instalado. Mudar qualquer campo invalida a assinatura.
export const signedText = (m: Omit<Manifest, 'assinatura'>) => `clurn-atualizacao-v1\n${m.versao}\n${m.arquivo}\n${m.tamanho}\n${m.sha256}`;

// Lê o clurn-versao.json. Devolve o manifesto, ou o motivo da recusa (sem eco do conteúdo).
export function parseManifest(x: unknown): Manifest | string {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return 'não é um objeto';
  const o = x as Record<string, unknown>;
  if (typeof o.versao !== 'string' || !VERSION.test(o.versao)) return 'versão fora do formato';
  if (o.arquivo !== `Clurn-Setup-${o.versao}.exe`) return 'nome do instalador fora do formato';
  if (typeof o.tamanho !== 'number' || !Number.isSafeInteger(o.tamanho) || o.tamanho <= 0 || o.tamanho > MAX_INSTALLER_BYTES) return 'tamanho fora do formato';
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return 'SHA-256 fora do formato';
  if (typeof o.assinatura !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(o.assinatura)) return 'assinatura fora do formato';
  return { versao: o.versao, arquivo: o.arquivo, tamanho: o.tamanho, sha256: o.sha256, assinatura: o.assinatura };
}

// a > b, comparando os três números (versão inválida nunca é mais nova)
export function isNewer(a: string, b: string): boolean {
  if (!VERSION.test(a) || !VERSION.test(b)) return false;
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// assinatura válida por alguma das chaves públicas (chave que não se lê é ignorada; nenhuma chave = recusa)
export function verifyManifest(m: Manifest, keys: string[] = UPDATE_KEYS): boolean {
  const sig = Buffer.from(m.assinatura, 'base64');
  for (const k of keys) {
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(signedText(m)), key, sig)) return true;
    } catch {
      // chave mal escrita não aprova nada
    }
  }
  return false;
}

const hostAllowed = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
};

export type UpdateCheck = { kind: 'disabled' } | { kind: 'none' } | { kind: 'available'; manifest: Manifest } | { kind: 'error'; reason: string };

// Consulta a última versão. Erro de rede ou de formato vira 'error' (a tela não mostra nada): o app segue normal.
export async function checkUpdate(current: string, deps: { fetch?: FetchFn; keys?: string[] } = {}): Promise<UpdateCheck> {
  const keys = deps.keys ?? UPDATE_KEYS;
  if (!keys.length) return { kind: 'disabled' };
  try {
    const res = await (deps.fetch ?? fetch)(MANIFEST_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (res.status === 404) return { kind: 'none' }; // repositório ainda sem versão publicada
    if (!res.ok) return { kind: 'error', reason: `HTTP ${res.status}` };
    if (!hostAllowed(res.url)) return { kind: 'error', reason: 'resposta de um endereço fora do GitHub' };
    const text = await res.text();
    if (text.length > MAX_MANIFEST_BYTES) return { kind: 'error', reason: 'arquivo de versão grande demais' };
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { kind: 'error', reason: 'arquivo de versão não é JSON' };
    }
    const m = parseManifest(json);
    if (typeof m === 'string') return { kind: 'error', reason: m };
    if (!verifyManifest(m, keys)) return { kind: 'error', reason: 'assinatura não confere' };
    return isNewer(m.versao, current) ? { kind: 'available', manifest: m } : { kind: 'none' };
  } catch (e) {
    return { kind: 'error', reason: e instanceof Error ? e.name === 'TimeoutError' ? 'sem resposta do GitHub' : 'sem conexão com o GitHub' : 'erro desconhecido' };
  }
}

export class UpdateFailed extends Error {
  reason: 'rede' | 'conferencia';
  constructor(reason: 'rede' | 'conferencia', message: string) {
    super(message);
    this.reason = reason;
  }
}

// Baixa o instalador numa pasta nova e só devolve o caminho se tamanho, SHA-256 e assinatura conferirem.
// O que não confere é apagado. onProgress(bytes, total).
export async function downloadInstaller(m: Manifest, deps: { fetch?: FetchFn; keys?: string[]; dir?: string; onProgress?: (done: number, total: number) => void } = {}): Promise<string> {
  if (!verifyManifest(m, deps.keys ?? UPDATE_KEYS)) throw new UpdateFailed('conferencia', 'assinatura não confere');
  const dir = deps.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-atualizacao-'));
  const file = path.join(dir, m.arquivo);
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(installerUrl(m), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch {
    throw new UpdateFailed('rede', 'sem conexão com o GitHub');
  }
  if (!res.ok || !res.body) throw new UpdateFailed('rede', `HTTP ${res.status}`);
  if (!hostAllowed(res.url)) throw new UpdateFailed('conferencia', 'download de um endereço fora do GitHub');
  const hash = crypto.createHash('sha256');
  const out = fs.openSync(file, 'w');
  let done = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new UpdateFailed('rede', 'o download parou no meio');
      }
      if (chunk.done) break;
      done += chunk.value.length;
      if (done > m.tamanho) throw new UpdateFailed('conferencia', 'o instalador é maior que o anunciado');
      hash.update(chunk.value);
      fs.writeSync(out, chunk.value);
      deps.onProgress?.(done, m.tamanho);
    }
    if (done !== m.tamanho) throw new UpdateFailed('conferencia', 'o instalador veio com outro tamanho');
    if (hash.digest('hex') !== m.sha256) throw new UpdateFailed('conferencia', 'o SHA-256 do instalador não confere');
  } catch (e) {
    fs.closeSync(out);
    fs.rmSync(file, { force: true });
    throw e;
  }
  fs.closeSync(out);
  return file;
}

// Roda o instalador em segundo plano, separado do app (o app fecha logo depois e o instalador abre a versão nova).
// Resolve quando o Windows abriu o instalador; rejeita se não abriu (arquivo apagado por um antivírus, por exemplo).
// O ambiente vai sem ELECTRON_RUN_AS_NODE: o servidor do app roda com ela (desktop/main.ts) e o instalador reabre o
// Clurn com o ambiente de quem o chamou; com ela, o Clurn reaberto viraria Node puro e fecharia na hora.
export function installerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

export function launchInstaller(file: string, run: typeof spawn = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = run(file, INSTALLER_ARGS, { detached: true, stdio: 'ignore', windowsHide: true, env: installerEnv() });
    } catch (e) {
      return reject(e);
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
