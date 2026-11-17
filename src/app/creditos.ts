// Controle dos créditos do Helius (pedido do autor, 31/10/2026): quanto cada rodada gasta, quanto este computador
// gastou no mês e quanto a chave ainda tem (somando todos os amigos, que dividem a mesma chave embutida).
//
// - Medidor da rodada: conta cada consulta ao RPC próprio, por etapa (análise, simulação, execução…), com o custo do
//   Helius por método (heliusCredits) e +1 por nova tentativa. É estimativa: o número oficial é o do Helius.
// - Histórico deste computador: um arquivo local com data, etapa, créditos e consultas. Só números e o host do RPC:
//   nenhum endereço, frase, chave ou URL completa.
// - Saldo da chave: a Admin API do Helius (GET /v0/admin/projects/{id}/usage, só leitura, com a chave normal),
//   conferida em https://www.helius.dev/docs/api-reference/admin em 31/10/2026. Precisa do id do projeto. A página
//   não diz se o plano grátis libera essa consulta: recusada, o painel diz que o saldo está indisponível.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { heliusCredits } from '../core/solana/rpc-meter.ts';
import type { RpcClient } from '../core/solana/rpc.ts';

// ---------- medidor da rodada ----------

export type Usage = { requests: number; credits: number; byStage: Record<string, number> };

export type UsageMeter = {
  wrap(client: RpcClient, stageOf: () => string): RpcClient;
  retry(stage: string): void;
  snapshot(): Usage;
};

export function createUsageMeter(): UsageMeter {
  const u: Usage = { requests: 0, credits: 0, byStage: {} };
  const add = (credits: number, stage: string) => {
    u.requests += 1;
    u.credits += credits;
    u.byStage[stage] = (u.byStage[stage] ?? 0) + credits;
  };
  return {
    wrap: (client, stageOf) => ({
      call<T>(method: string, params: unknown[]): Promise<T> {
        add(heliusCredits(method), stageOf());
        return client.call<T>(method, params);
      },
    }),
    retry: (stage) => add(1, stage),
    snapshot: () => ({ requests: u.requests, credits: u.credits, byStage: { ...u.byStage } }),
  };
}

// diferença entre duas leituras do medidor (o que gastou desde a última gravação)
export function usageDelta(now: Usage, before: Usage): Usage {
  const byStage: Record<string, number> = {};
  for (const [k, v] of Object.entries(now.byStage)) {
    const d = v - (before.byStage[k] ?? 0);
    if (d > 0) byStage[k] = d;
  }
  return { requests: now.requests - before.requests, credits: now.credits - before.credits, byStage };
}

// ---------- histórico deste computador ----------

export type HistoryEntry = { quando: string; etapa: string; creditos: number; consultas: number; rpc: string };

// %LOCALAPPDATA%\Clurn\creditos.json no Windows; ~/.clurn/creditos.json fora dele. Fora do repositório.
export function defaultHistoryFile(): string {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Clurn') : path.join(os.homedir(), '.clurn');
  return path.join(base, 'creditos.json');
}

export const HISTORY_MAX = 5000; // um ano de uso folgado; o mais antigo sai primeiro

const isEntry = (e: unknown): e is HistoryEntry => {
  const x = e as HistoryEntry;
  return Boolean(x) && typeof x.quando === 'string' && !Number.isNaN(Date.parse(x.quando)) && typeof x.etapa === 'string' &&
    Number.isFinite(x.creditos) && x.creditos >= 0 && Number.isFinite(x.consultas) && x.consultas >= 0 && typeof x.rpc === 'string';
};

// Arquivo ausente ou quebrado: lista vazia. Item fora do formato é ignorado sozinho (não derruba o resto).
export function readHistory(file: string): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    return [];
  }
}

// Grava por arquivo temporário + rename: o app fechado no meio não deixa o histórico pela metade.
// Falha de disco não derruba a limpeza: devolve false e o painel segue com o que tem.
export function appendHistory(file: string, entry: HistoryEntry): boolean {
  try {
    const list = [...readHistory(file), entry].slice(-HISTORY_MAX);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Total do mês corrente (horário local) e o de todo o histórico.
export function historySummary(list: HistoryEntry[], now = new Date()): { mes: string; creditosMes: number; consultasMes: number; creditosTotal: number } {
  const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let creditosMes = 0;
  let consultasMes = 0;
  let creditosTotal = 0;
  for (const e of list) {
    creditosTotal += e.creditos;
    const d = new Date(e.quando);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) {
      creditosMes += e.creditos;
      consultasMes += e.consultas;
    }
  }
  return { mes, creditosMes, consultasMes, creditosTotal };
}

// ---------- saldo da chave (Admin API do Helius) ----------

export const HELIUS_ADMIN = 'https://admin-api.helius.xyz/v0/admin/projects';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HeliusTarget = { key: string; project: string };

// Só para RPC do Helius (host *.helius-rpc.com) com a chave na URL e id de projeto no formato UUID.
export function heliusTarget(rpcUrl: string | null | undefined, project: string | null | undefined): HeliusTarget | null {
  if (!rpcUrl || !project || !UUID.test(project.trim())) return null;
  try {
    const u = new URL(rpcUrl);
    const key = u.searchParams.get('api-key');
    if (u.protocol !== 'https:' || !/(^|\.)helius-rpc\.com$/.test(u.hostname) || !key) return null;
    return { key, project: project.trim() };
  } catch {
    return null;
  }
}

export type HeliusBalance =
  | { status: 'ok'; restantes: number; limite: number | null; usados: number | null; renovaEm: string | null; plano: string | null }
  | { status: 'sem-projeto' }
  | { status: 'erro'; motivo: 'admin-desligada' | 'chave-ou-projeto' | 'indisponivel' };

export const HELIUS_TIMEOUT_MS = 10_000;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);

// Lê o saldo. Qualquer falha vira um motivo curto; nem a chave nem o corpo da resposta vão para a mensagem.
export async function fetchHeliusBalance(t: HeliusTarget | null, fetchImpl: typeof fetch = fetch, timeoutMs = HELIUS_TIMEOUT_MS): Promise<HeliusBalance> {
  if (!t) return { status: 'sem-projeto' };
  let res: Response;
  try {
    res = await fetchImpl(`${HELIUS_ADMIN}/${encodeURIComponent(t.project)}/usage`, { headers: { 'X-Api-Key': t.key }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: 'erro', motivo: 'indisponivel' };
  }
  if (res.status === 403) return { status: 'erro', motivo: 'admin-desligada' };
  if (res.status === 400 || res.status === 401 || res.status === 404) return { status: 'erro', motivo: 'chave-ou-projeto' };
  if (!res.ok) return { status: 'erro', motivo: 'indisponivel' };
  let body: Record<string, any>;
  try {
    body = (await res.json()) as Record<string, any>;
  } catch {
    return { status: 'erro', motivo: 'indisponivel' };
  }
  const restantes = num(body?.creditsRemaining);
  if (restantes === null) return { status: 'erro', motivo: 'indisponivel' };
  const end = body?.creditCycle?.end;
  return {
    status: 'ok',
    restantes,
    limite: num(body?.subscriptionDetails?.creditsLimit),
    usados: num(body?.creditsUsed),
    renovaEm: typeof end === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : null,
    plano: typeof body?.subscriptionDetails?.plan === 'string' ? String(body.subscriptionDetails.plan).slice(0, 40) : null,
  };
}
