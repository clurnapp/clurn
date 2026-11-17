// De onde vem o RPC de cada rodada. A página não pergunta mais (pedido do autor, 31/10/2026): o app usa, em ordem,
//   1. o RPC escolhido pela API (só scripts de teste mandam; a página não tem mais campo),
//   2. a variável SOLANA_RPC_URL (uso do autor no próprio computador),
//   3. os RPCs embutidos no app empacotado, na ordem (só mainnet; as URLs do Helius com a chave),
//   4. o RPC público da Solana.
// Os de 2 a 4 são tentados na ordem: o primeiro que passa na checagem (checkRpc, com a trava de rede) é o usado.
// Assim, chave esgotada, revogada ou de outra rede cai para o público em vez de travar o app sem campo para trocar.
// O escolhido pela API (1) não cai para nada: quem escolheu um RPC quer aquele, ou o erro.
//
// RPC embutido: decisão do autor em 31/10/2026, só para os amigos. A chave fica legível dentro do .exe e qualquer
// um que abrir a pasta do app consegue usá-la (risco conhecido e aceito). Ela NUNCA fica no repositório: o
// `npm run empacotar` lê as URLs das variáveis CLURN_RPC_URL, CLURN_RPC_URL_2… e grava este arquivo só dentro da cópia empacotada.
// A URL nunca vai para log, página, relatório ou mensagem de erro (a página vê só o host, rpcLabel em server.ts).
//
// Proxy (09/11/2026, docs/lancamento-publico.md B1): CLURN_PROXY_URL é o proxy do Clurn na Cloudflare (proxy/), que
// guarda a chave do Helius pago no Worker. Entra como o PRIMEIRO embutido, antes das chaves: proxy → chave 1 → chave 2
// → público. A URL do proxy não é segredo (não leva chave); vazia por padrão, só o empacotamento põe. Só o proxy recebe
// o cabeçalho com a versão do app (x-clurn-versao); Helius e público não recebem nada além da consulta.

import fs from 'node:fs';
import path from 'node:path';
import type { Cluster } from '../core/solana/rpc-check.ts';

export const PUBLIC_RPC: Record<Cluster, string> = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };

export const EMBEDDED_RPC_NAME = 'rpc-embutido.json';
export const EMBEDDED_RPC_FILE = path.join(import.meta.dirname, EMBEDDED_RPC_NAME);

const isHttpsUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/\S+$/.test(u);

// Um RPC embutido: a URL (com a chave) e, opcional, o id do projeto do Helius (para o painel ler o saldo da chave).
// `proxy: true`: o proxy do Clurn (sem chave na URL; o saldo fica no painel do Helius do dono do proxy).
export type EmbeddedRpc = { url: string; heliusProject: string | null; proxy?: true };

// Id do projeto do Helius no formato UUID; fora dele: null.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asProject = (p: unknown): string | null => (typeof p === 'string' && UUID.test(p.trim()) ? p.trim() : null);

// Os RPCs embutidos, na ordem em que o app tenta (pedido do autor, 03/11/2026: acabou a chave 1, segue na 2).
// Lê o formato novo { rpcs: [{ url, heliusProject }, ...] } e o antigo { url, heliusProject } (apps até a 0.2.3).
// Arquivo ausente ou quebrado: lista vazia (o app usa o público). Item fora do formato é pulado sozinho, sem
// derrubar os outros; URL repetida entra uma vez. Nunca lança.
export function readEmbeddedRpcs(file: string = EMBEDDED_RPC_FILE): EmbeddedRpc[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const items: unknown[] = Array.isArray((raw as { rpcs?: unknown })?.rpcs) ? (raw as { rpcs: unknown[] }).rpcs : [raw];
  const out: EmbeddedRpc[] = [];
  for (const it of items) {
    const url = (it as { url?: unknown })?.url;
    if (!isHttpsUrl(url) || out.some((e) => e.url === url)) continue;
    if ((it as { proxy?: unknown }).proxy === true) out.push({ url, heliusProject: null, proxy: true });
    else out.push({ url, heliusProject: asProject((it as { heliusProject?: unknown }).heliusProject) });
  }
  return out;
}

// Nome da variável do empacotamento de cada chave: CLURN_RPC_URL, CLURN_RPC_URL_2, CLURN_RPC_URL_3…
export const embeddedEnvName = (i: number, kind: 'url' | 'project'): string =>
  (kind === 'url' ? 'CLURN_RPC_URL' : 'CLURN_HELIUS_PROJECT') + (i === 0 ? '' : `_${i + 1}`);
// Variável do empacotamento com a URL do proxy do Clurn (proxy/README.md).
export const PROXY_ENV = 'CLURN_PROXY_URL';

export type EmbeddedEntry = { url: string; heliusProject?: string | null; proxy?: boolean };

// O conteúdo do arquivo que o empacotamento grava, na ordem dada. Recusa o que não for https e id de projeto fora
// do formato UUID; o erro diz qual variável, nunca a URL. As chaves contam sem o proxy (a 1ª chave é CLURN_RPC_URL).
export function embeddedRpcFileContent(entries: EmbeddedEntry[]): string {
  let key = 0;
  const rpcs = entries.map((e) => {
    const url = e.url.trim();
    if (e.proxy) {
      if (!isHttpsUrl(url)) throw new Error(`${PROXY_ENV} precisa ser um endereço https:// sem espaços.`);
      return { url, proxy: true };
    }
    const i = key++;
    if (!isHttpsUrl(url)) throw new Error(`${embeddedEnvName(i, 'url')} precisa ser um endereço https:// sem espaços.`);
    const project = e.heliusProject?.trim();
    if (project && !UUID.test(project)) throw new Error(`${embeddedEnvName(i, 'project')} precisa ser o id do projeto do Helius (formato UUID).`);
    return project ? { url, heliusProject: project } : { url };
  });
  return JSON.stringify({ rpcs }) + '\n';
}

// O que o terminal define para o empacotamento: primeiro o proxy (CLURN_PROXY_URL), depois as chaves CLURN_RPC_URL
// (+ CLURN_HELIUS_PROJECT), _2, _3… até _9. Variável em branco é pulada; as seguintes continuam valendo.
export function embeddedFromEnv(env: Record<string, string | undefined>): Array<{ url: string; heliusProject?: string; proxy?: true }> {
  const out: Array<{ url: string; heliusProject?: string; proxy?: true }> = [];
  const proxy = env[PROXY_ENV]?.trim();
  if (proxy) out.push({ url: proxy, proxy: true });
  for (let i = 0; i < 9; i++) {
    const url = env[embeddedEnvName(i, 'url')]?.trim();
    if (!url) continue;
    const heliusProject = env[embeddedEnvName(i, 'project')]?.trim();
    out.push(heliusProject ? { url, heliusProject } : { url });
  }
  return out;
}

export type RpcSources = { chosen?: string | null; env?: string | null; embedded?: string[] | null };

// Lista dos RPCs a tentar, em ordem, sem repetidos. Termina sempre no público da rede, salvo com RPC escolhido.
export function rpcCandidates(cluster: Cluster, s: RpcSources): string[] {
  const chosen = s.chosen?.trim();
  if (chosen) return [chosen];
  const list = [s.env?.trim(), ...(cluster === 'mainnet' ? (s.embedded ?? []) : []), PUBLIC_RPC[cluster]];
  return [...new Set(list.filter((u): u is string => Boolean(u)))];
}

// Cabeçalho com que o app se identifica ao proxy (proxy/worker.ts). A versão do package.json; não é segredo.
export const VERSION_HEADER = 'x-clurn-versao';
export function appVersion(file: string = path.join(import.meta.dirname, '..', '..', 'package.json')): string {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.version;
    return typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Cabeçalhos extras do cliente RPC desta URL: só o proxy embutido recebe a versão; qualquer outro RPC, nada.
export function rpcHeaders(url: string, embedded: EmbeddedRpc[], version: string): Record<string, string> | undefined {
  return embedded.some((e) => e.proxy && e.url === url) ? { [VERSION_HEADER]: version } : undefined;
}

// Existe um RPC próprio antes do público (para a estimativa de tempo, que muda bastante entre os dois)?
export function hasCustomDefault(cluster: Cluster, s: RpcSources): boolean {
  return rpcCandidates(cluster, s)[0] !== PUBLIC_RPC[cluster];
}
