// Proxy de RPC do Clurn (Cloudflare Workers): esconde a chave do Helius pago e só repassa o que o app usa.
//
// O que ele NUNCA recebe: frase, chave privada ou qualquer segredo do usuário. O app assina as transações no próprio
// computador; aqui passam só consultas JSON-RPC de leitura e transações JÁ assinadas (sendTransaction,
// simulateTransaction). Mesmo assim o corpo tem endereços e transações das temporárias: nada dele vai para log
// (nenhuma linha de log neste arquivo, e o wrangler.toml desliga os logs do Workers).
//
// Por pedido, na ordem:
//   1. só POST em "/", com content-type application/json e o cabeçalho x-clurn-versao (o app se identifica; não é
//      segredo nem trava contra quem copia o cabeçalho, só tira do caminho robô genérico);
//   2. corpo de no máximo MAX_CORPO bytes, JSON válido, objeto ou lote de até MAX_LOTE itens;
//   3. todo método na lista ALLOWED_METHODS (o lote inteiro é recusado se um item não estiver);
//   4. cotas no Durable Object Cotas (cotas.ts): por IP por segundo, por IP por dia, teto global por hora e por dia;
//   5. repassa ao upstream (secret do Workers, com a chave), com prazo, o pedido REESCRITO a partir do que foi
//      conferido (forwardItem: só jsonrpc, id, method e params), nunca o texto original. Com várias chaves
//      (UPSTREAM_URLS, 16/11/2026), usa a primeira que não está pausada; a que responde "sem crédito" fica pausada
//      por PAUSA_CHAVE_MIN e o MESMO pedido segue na seguinte, sem o app perceber (rodízio mais abaixo);
//   6. devolve status e corpo do upstream como vieram. Única exceção: se o corpo trouxer a URL ou a chave do
//      upstream (algum provedor ecoar), elas viram "[rpc]".
//
// Erros saem no formato JSON-RPC, com os códigos que o app já trata (src/core/solana/rpc.ts):
//   - limite por segundo: HTTP 429 + Retry-After 1 + -32005 → o app espera e repete;
//   - cota do dia (IP ou global): HTTP 429 + -32005 com "max usage reached" → o app NÃO repete (kind 'quota') e cai
//     na hora para o próximo RPC da lista (rpc-padrao.ts), como faz com a chave do Helius esgotada;
//   - upstream fora do ar ou lento: HTTP 502/504 → o app repete algumas vezes e depois cai para o próximo;
//   - método fora da lista: HTTP 200 + -32601 → a conferência do começo (rpc-check.ts) recusa o proxy e o app usa o
//     próximo.
//
// TypeScript direto: o wrangler compila .ts sozinho (esbuild), e o Node 24 roda o mesmo arquivo nos testes (só
// sintaxe apagável, imports com .ts). Sem dependência. A entrada do Workers é entrada.ts (liga o Durable Object).

import { clientKey, type CheckRequest, type CheckResult as CheckQuota, type ConsumeRequest, type ConsumeResult, type EventKind } from './cotas.ts';
import { CHECK_CREDITS, CHECK_ORIGINS, checkWallet, validAddress } from './verificar.ts';

// Métodos que o app chama (grep em src/, 09/11/2026). test/proxy/worker.test.ts confere este conjunto contra o
// código do app: método novo no app sem entrar aqui derruba o teste.
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBlockHeight',
  'getGenesisHash',
  'getLatestBlockhash',
  'getMinimumBalanceForRentExemption',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getTokenAccountsByOwner',
  'sendTransaction',
  'simulateTransaction',
]);

// Créditos do Helius por método (helius.dev/docs/billing/credits, conferido em 09/11/2026): getProgramAccounts 10,
// o resto 1. As cotas por dia contam créditos, não requisições, para o teto acompanhar a fatura.
export const CREDITS: Readonly<Record<string, number>> = { getProgramAccounts: 10 };
export const creditsOf = (method: string): number => CREDITS[method] ?? 1;

// Padrões (cada um pode ser trocado por variável no wrangler.toml, sem mexer no código).
export const DEFAULTS = {
  MAX_CORPO: 64 * 1024, // bytes; a maior consulta do app (getMultipleAccounts com 100 endereços) tem ~5 KB
  MAX_LOTE: 10, // itens por lote, abaixo do limite por segundo (senão um lote cheio nunca passaria); o app de hoje manda um por vez
  LIMITE_IP_SEGUNDO: 15, // requisições (itens) por segundo por IP; o app manda no máximo 8/s
  // créditos por IP por dia (UTC): ~1,5 frase de 100 temporárias no fluxo completo (~4.100 créditos cada, conta no
  // proxy/README.md); quem passa disso segue pelo RPC público, sem parar. São precisos 20 IPs para gastar o TETO_DIA.
  LIMITE_IP_DIA: 6_000,
  // créditos por dia no total (16/11/2026): as chaves do Helius, ~3,7 milhões por mês somadas (~123 mil por
  // dia). Um abuso não leva o mês num dia; passou disso, o app usa o RPC público até a virada.
  TETO_DIA: 120_000,
  // créditos por hora no total, quando TETO_HORA não vem: TETO_DIA/8. Uma rajada leva no máximo 1/8 do dia.
  TETO_HORA_FRACAO: 8,
  TEMPO_UPSTREAM_MS: 25_000, // o app desiste em 30 s; o proxy responde antes, com erro claro
  // minutos que uma chave sem crédito fica fora do rodízio. Depois disso um pedido de verdade tenta de novo: se ela
  // renovou (o Helius renova cada conta num dia do mês), volta sozinha; se não, fica mais uma pausa.
  PAUSA_CHAVE_MIN: 60,
  // verificador do site (19/11/2026): verificações por IP por dia e no total do dia. 3.000 × 5 créditos = 15 mil,
  // 1/8 do TETO_DIA no pior caso.
  LIMITE_VERIF_IP: 20,
  TETO_VERIF: 3_000,
} as const;

export type Env = {
  UPSTREAM_URL?: string; // secret (wrangler secret put UPSTREAM_URL): a URL do Helius com a chave
  // secret (wrangler secret put UPSTREAM_URLS): várias URLs, uma por linha, na ordem de uso. Vem antes da UPSTREAM_URL.
  UPSTREAM_URLS?: string;
  PAUSA_CHAVE_MIN?: string;
  COTAS?: CotasNamespace;
  MAX_CORPO?: string;
  MAX_LOTE?: string;
  LIMITE_IP_SEGUNDO?: string;
  LIMITE_IP_DIA?: string;
  TETO_DIA?: string;
  TETO_HORA?: string;
  TEMPO_UPSTREAM_MS?: string;
  LIMITE_VERIF_IP?: string;
  TETO_VERIF?: string;
  VERSAO_MINIMA?: string; // opcional: recusa app mais velho que isso (ex.: versão com defeito conhecido)
  // secret (wrangler secret put STATS_TOKEN): libera o GET /stats do painel do autor (scripts/painel-admin.ts).
  // Sem ele, ou com menos de MIN_STATS_TOKEN caracteres, o /stats responde 404 como qualquer caminho desconhecido.
  STATS_TOKEN?: string;
};

export const MIN_STATS_TOKEN = 32;

// O pedaço da API de Durable Objects que o proxy usa (o mesmo formato do Workers; nos testes, um falso).
export type CotasNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: Request | string, init?: RequestInit): Promise<Response> };
};

export const VERSION_HEADER = 'x-clurn-versao';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

type RpcItem = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: unknown };

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function limitsOf(env: Env) {
  const globalDay = num(env.TETO_DIA, DEFAULTS.TETO_DIA);
  return {
    maxBody: num(env.MAX_CORPO, DEFAULTS.MAX_CORPO),
    maxBatch: num(env.MAX_LOTE, DEFAULTS.MAX_LOTE),
    perSecond: num(env.LIMITE_IP_SEGUNDO, DEFAULTS.LIMITE_IP_SEGUNDO),
    perIpDay: num(env.LIMITE_IP_DIA, DEFAULTS.LIMITE_IP_DIA),
    globalDay,
    globalHour: num(env.TETO_HORA, Math.max(1, Math.floor(globalDay / DEFAULTS.TETO_HORA_FRACAO))),
    upstreamMs: num(env.TEMPO_UPSTREAM_MS, DEFAULTS.TEMPO_UPSTREAM_MS),
    pauseMs: num(env.PAUSA_CHAVE_MIN, DEFAULTS.PAUSA_CHAVE_MIN) * 60_000,
    checkPerIpDay: num(env.LIMITE_VERIF_IP, DEFAULTS.LIMITE_VERIF_IP),
    checkDay: num(env.TETO_VERIF, DEFAULTS.TETO_VERIF),
  };
}

// As URLs do upstream na ordem de uso: UPSTREAM_URLS (uma por linha; espaço ou vírgula também separam) e depois
// UPSTREAM_URL. Só https; repetida conta uma vez. Linha que não é https é ignorada (as outras seguem).
export function upstreamsOf(env: Env): string[] {
  const out: string[] = [];
  for (const s of `${env.UPSTREAM_URLS ?? ''}\n${env.UPSTREAM_URL ?? ''}`.split(/[\s,]+/)) {
    if (/^https:\/\/\S+$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// Nome de uma chave no contador: os 16 primeiros hexadecimais do SHA-256 da URL. Não revela a chave e não depende da
// posição na lista (trocar a ordem ou tirar uma chave não confunde as pausas das outras).
export async function upstreamId(url: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  return [...new Uint8Array(hash).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Resposta do upstream que diz "esta chave não serve agora": sem crédito (o Helius responde 429 com "max usage", o
// mesmo que src/core/solana/rpc.ts reconhece) ou chave recusada (401/403: apagada, trocada ou suspensa).
export const keyUnusable = (status: number, body: string): boolean => status === 401 || status === 403 || (status === 429 && /max usage/i.test(body));

// Resposta de erro JSON-RPC. A mensagem é sempre texto fixo deste arquivo (nunca e.message nem nada do upstream).
function rpcError(status: number, code: number, message: string, id: RpcItem['id'] = null, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

// Lê o corpo até `max` bytes; passou disso, para de ler e devolve null (não guarda o resto na memória).
async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

// Um item JSON-RPC 2.0 como o app manda: id número, texto curto ou null; params, se vier, é lista (a Solana não usa
// parâmetro por nome).
const isItem = (x: unknown): x is RpcItem => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const o = x as Record<string, unknown>;
  const idOk = o.id === undefined || o.id === null || (typeof o.id === 'string' && o.id.length <= 64) || typeof o.id === 'number';
  const paramsOk = o.params === undefined || Array.isArray(o.params);
  return o.jsonrpc === '2.0' && typeof o.method === 'string' && idOk && paramsOk;
};

// O que vai ao upstream é reescrito a partir do que foi conferido (revisão de segurança de 09/11/2026): repassar o
// texto original deixava um furo. Em {"method":"requestAirdrop","method":"getLatestBlockhash"} o JSON.parse fica com
// a última chave e passava na lista, e um upstream que lê a primeira executaria o método proibido. Reescrito, só vão
// jsonrpc, id, method e params; chave repetida, chave extra e espaços somem. O conteúdo é o mesmo; os bytes, não.
const forwardItem = (it: RpcItem) => ({
  jsonrpc: '2.0',
  ...(it.id !== undefined ? { id: it.id } : {}),
  method: it.method,
  ...(it.params !== undefined ? { params: it.params } : {}),
});

// Partes da URL do upstream que não podem sair em resposta nenhuma: a URL, a query, o valor de cada parâmetro
// (a chave do Helius vem num parâmetro da query) e trechos longos do caminho (há provedor que põe a chave no caminho).
// O host sozinho não é segredo e fica (trocá-lo mudaria respostas à toa).
export function secretParts(upstream: string): string[] {
  const parts = new Set<string>([upstream]);
  try {
    const u = new URL(upstream);
    for (const s of [u.host + u.pathname + u.search, u.pathname + u.search, u.search, u.search.slice(1)]) if (s.length >= 8) parts.add(s);
    for (const v of u.searchParams.values()) if (v.length >= 8) parts.add(v);
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) parts.add(seg);
    if (u.username.length >= 4) parts.add(u.username);
    if (u.password.length >= 4) parts.add(u.password);
  } catch {
    // URL inválida: fica só o texto inteiro
  }
  return [...parts].sort((a, b) => b.length - a.length);
}

const scrub = (text: string, secrets: string[]): string => secrets.reduce((t, s) => (t.includes(s) ? t.split(s).join('[rpc]') : t), text);

// Versão "a.b.c" menor que "x.y.z"?
function olderThan(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

// Segundos até a meia-noite UTC (quando as cotas do dia zeram), para o Retry-After da cota diária.
const secondsToUtcMidnight = (now: number): number => Math.max(1, Math.ceil((86_400_000 - (now % 86_400_000)) / 1000));
const secondsToNextUtcHour = (now: number): number => Math.max(1, Math.ceil((3_600_000 - (now % 3_600_000)) / 1000));

// Consulta fixa que confirma se a CHAVE está recusada (e não só o pedido): getGenesisHash, 1 crédito, sem nada do
// usuário. Prazo curto: é um teste, não o pedido.
export const PROBE_BODY = '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}';
export const PROBE_MS = 5_000;
export async function probeKey(f: typeof fetch, url: string): Promise<'recusada' | 'boa' | 'sem-resposta'> {
  try {
    const r = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: PROBE_BODY, signal: AbortSignal.timeout(PROBE_MS) });
    const text = await r.text();
    if (keyUnusable(r.status, text)) return 'recusada';
    return r.ok ? 'boa' : 'sem-resposta';
  } catch {
    return 'sem-resposta';
  }
}

// Avisa o contador que a chave ficou sem crédito. Falha aqui não muda a resposta (no pior caso, a chave é tentada
// de novo no próximo pedido e gasta um pedido recusado).
async function pauseKey(env: Env, id: string, until: number): Promise<void> {
  try {
    const stub = env.COTAS!.get(env.COTAS!.idFromName('global'));
    await stub.fetch('https://cotas/pausar', { method: 'POST', body: JSON.stringify({ id, until }) });
  } catch {
    // contador fora do ar: segue
  }
}

// Conta um evento raro do upstream nas estatísticas. Falha aqui não muda a resposta ao app.
async function recordEvent(env: Env, kind: EventKind, now: number): Promise<void> {
  try {
    const stub = env.COTAS!.get(env.COTAS!.idFromName('global'));
    await stub.fetch('https://cotas/evento', { method: 'POST', body: JSON.stringify({ kind, now }) });
  } catch {
    // contador fora do ar: segue
  }
}

// Compara o token sem vazar, pelo tempo, quantos caracteres batem: compara os SHA-256 (mesmo tamanho) byte a byte
// até o fim.
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i++) diff |= u[i]! ^ v[i]!;
  return diff === 0;
}

// GET /stats (painel do autor): só com "Authorization: Bearer <STATS_TOKEN>". Token ausente, curto ou errado → o
// mesmo 404 de caminho desconhecido (quem não tem o token não sabe que o caminho existe). A resposta só tem números
// (estatisticas de cotas.ts), as chaves pela POSIÇÃO na lista (nunca a URL) e os limites em vigor.
async function statsResponse(request: Request, env: Env, now: number): Promise<Response> {
  const notFound = () => rpcError(404, -32600, 'caminho desconhecido');
  const token = env.STATS_TOKEN?.trim() ?? '';
  if (token.length < MIN_STATS_TOKEN || request.method !== 'GET' || !env.COTAS) return notFound();
  const auth = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
  if (!(await sameSecret(auth, token))) return notFound();
  let view: { hoje: unknown; historico: unknown; pausadas: Array<{ id: string; ate: number }> };
  try {
    const stub = env.COTAS.get(env.COTAS.idFromName('global'));
    const res = await stub.fetch(`https://cotas/stats?agora=${now}`);
    if (!res.ok) return rpcError(503, -32603, 'contador de uso indisponível');
    view = await res.json();
  } catch {
    return rpcError(503, -32603, 'contador de uso indisponível');
  }
  const ids = await Promise.all(upstreamsOf(env).map(upstreamId));
  const paused = new Map(view.pausadas.map((p) => [p.id, p.ate]));
  const lim = limitsOf(env);
  const body = {
    agora: now,
    hoje: view.hoje,
    historico: view.historico,
    chaves: ids.map((id, i) => ({ posicao: i + 1, pausadaAte: paused.get(id) ?? null })),
    limites: { porIpSegundo: lim.perSecond, porIpDia: lim.perIpDay, tetoHora: lim.globalHour, tetoDia: lim.globalDay, pausaChaveMin: lim.pauseMs / 60_000 },
    versaoMinima: env.VERSAO_MINIMA?.trim() || null,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

async function consume(env: Env, req: ConsumeRequest): Promise<ConsumeResult | null> {
  if (!env.COTAS) return null;
  try {
    const stub = env.COTAS.get(env.COTAS.idFromName('global'));
    const res = await stub.fetch('https://cotas/consumir', { method: 'POST', body: JSON.stringify(req) });
    if (!res.ok) return null;
    const r = (await res.json()) as ConsumeResult;
    return typeof r?.ok === 'boolean' ? r : null;
  } catch {
    return null;
  }
}

// ---------- verificador do site (19/11/2026) ----------
// GET /verificar?endereco=<carteira>&cofre=<PDA da curva>&ata=<cofre do PumpSwap>: as consultas fixas de proxy/verificar.ts, com cota própria. A resposta só tem
// números e o próprio endereço que veio; o corpo do upstream nunca volta ao navegador. CORS só para clurn.app.
function checkJson(status: number, body: unknown, origin: string | null, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra };
  if (origin && CHECK_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers.vary = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

async function consumeCheck(env: Env, req: CheckRequest): Promise<CheckQuota | null> {
  if (!env.COTAS) return null;
  try {
    const stub = env.COTAS.get(env.COTAS.idFromName('global'));
    const res = await stub.fetch('https://cotas/verificar', { method: 'POST', body: JSON.stringify(req) });
    if (!res.ok) return null;
    const r = (await res.json()) as CheckQuota;
    return typeof r?.ok === 'boolean' ? r : null;
  } catch {
    return null;
  }
}

// Cliente JSON-RPC mínimo para o verificador: a primeira chave não pausada que responder; recusa, 429 ou rede fora
// passam à seguinte (sem pausar: quem pausa é o caminho do app, com a sonda). Erro do RPC vira exceção.
function checkRpc(upstreams: string[], skip: Set<number>, f: typeof fetch, timeoutMs: number) {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
      for (let i = 0; i < upstreams.length; i++) {
        if (skip.has(i)) continue;
        let res: Response;
        try {
          res = await f(upstreams[i]!, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        } catch {
          continue;
        }
        if (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) continue;
        let j: any;
        try {
          j = await res.json();
        } catch {
          continue;
        }
        if (j?.error) throw new Error('rpc');
        return j?.result as T;
      }
      throw new Error('sem upstream');
    },
  };
}

async function checkResponse(request: Request, env: Env, deps: Deps): Promise<Response> {
  const origin = request.headers.get('origin');
  if (request.method !== 'GET') return checkJson(405, { erro: 'só GET' }, origin, { allow: 'GET' });
  const q = new URL(request.url).searchParams;
  const address = validAddress(q.get('endereco'));
  const cofre = validAddress(q.get('cofre'));
  const ata = validAddress(q.get('ata'));
  if (!address || !cofre || !ata) return checkJson(400, { erro: 'endereco' }, origin);
  const upstreams = upstreamsOf(env);
  if (upstreams.length === 0 || !env.COTAS) return checkJson(503, { erro: 'fora' }, origin);
  const lim = limitsOf(env);
  const now = (deps.now ?? Date.now)();
  const quota = await consumeCheck(env, { key: clientKey(request.headers.get('cf-connecting-ip')), credits: CHECK_CREDITS, now, perIpDay: lim.checkPerIpDay, globalDay: lim.checkDay, appGlobalDay: lim.globalDay, appGlobalHour: lim.globalHour });
  if (!quota) return checkJson(503, { erro: 'fora' }, origin);
  if (!quota.ok) return checkJson(429, { erro: quota.reason === 'verif-ip' ? 'limite-ip' : 'limite-dia' }, origin, { 'retry-after': String(secondsToUtcMidnight(now)) });
  const ids = await Promise.all(upstreams.map(upstreamId));
  const paused = new Set(quota.paused ?? []);
  const skip = new Set(ids.flatMap((id, i) => (paused.has(id) ? [i] : [])));
  const result = await checkWallet(checkRpc(upstreams, skip, deps.fetch ?? fetch, lim.upstreamMs), address, cofre, ata);
  if (result.sol === null && result.aluguel === null && result.feePump === null) return checkJson(502, { erro: 'leitura' }, origin);
  return checkJson(200, result, origin);
}

// Relógio e fetch do upstream: os do Workers; nos testes, falsos.
export type Deps = { now?: () => number; fetch?: typeof fetch };

export async function handle(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const now = deps.now ?? Date.now;
  const upstreamFetch = deps.fetch ?? fetch;
  const upstreams = upstreamsOf(env);
  // painel do autor: antes da checagem do upstream (o painel mostra o proxy mesmo sem chave nenhuma)
  if (new URL(request.url).pathname === '/stats') return statsResponse(request, env, now());
  if (new URL(request.url).pathname === '/verificar') return checkResponse(request, env, deps);
  // sem URL do upstream ou sem o contador: fora do ar (falha fechada; o app cai para o próximo RPC)
  if (upstreams.length === 0 || !env.COTAS) return rpcError(503, -32603, 'proxy sem configuração');
  if (request.method !== 'POST') return rpcError(405, -32600, 'só POST', null, { allow: 'POST' });
  if (new URL(request.url).pathname !== '/') return rpcError(404, -32600, 'caminho desconhecido');
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return rpcError(415, -32600, 'content-type precisa ser application/json');
  const version = request.headers.get(VERSION_HEADER)?.trim() ?? '';
  if (!VERSION.test(version)) return rpcError(403, -32600, 'app não identificado');
  const min = env.VERSAO_MINIMA?.trim();
  if (min && VERSION.test(min) && olderThan(version, min)) return rpcError(426, -32600, `versão do app antiga: atualize para a ${min} ou mais nova`);

  const lim = limitsOf(env);
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > lim.maxBody) return rpcError(413, -32600, 'pedido grande demais');
  const text = await readCapped(request, lim.maxBody);
  if (text === null) return rpcError(413, -32600, 'pedido grande demais');

  let parsed: unknown;
  // número que o JSON.parse não guarda exato (inteiro acima de 2^53, ou 1e400 = Infinity) mudaria ao ser reescrito:
  // recusado em vez de repassado diferente do que o cliente mandou
  let inexact = false;
  try {
    parsed = JSON.parse(text, (_k, v) => {
      if (typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))) inexact = true;
      return v;
    });
  } catch {
    return rpcError(400, -32700, 'JSON inválido');
  }
  if (inexact) return rpcError(400, -32600, 'número grande demais para repassar sem mudar');
  const batch = Array.isArray(parsed);
  const items: unknown[] = batch ? (parsed as unknown[]) : [parsed];
  if (items.length === 0) return rpcError(400, -32600, 'lote vazio');
  if (items.length > lim.maxBatch) return rpcError(413, -32600, `lote grande demais (máximo ${lim.maxBatch})`);
  if (!items.every(isItem)) return rpcError(400, -32600, 'pedido fora do formato JSON-RPC 2.0');
  const rpcItems = items as RpcItem[];
  const id = batch ? null : (rpcItems[0]!.id ?? null);
  const forbidden = rpcItems.find((it) => !ALLOWED_METHODS.has(it.method));
  if (forbidden) {
    // o nome volta só se tiver cara de método; qualquer outra coisa não é repetida
    const name = /^[A-Za-z0-9_]{1,64}$/.test(forbidden.method) ? `: ${forbidden.method}` : '';
    return rpcError(200, -32601, `método não permitido no proxy${name}`, id);
  }

  const t = now();
  const credits = rpcItems.reduce((s, it) => s + creditsOf(it.method), 0);
  // para as estatísticas: itens por método (todos já na ALLOWED_METHODS) e a versão (já no formato a.b.c)
  const methods: Record<string, number> = {};
  for (const it of rpcItems) methods[it.method] = (methods[it.method] ?? 0) + 1;
  const quota = await consume(env, {
    methods,
    version,
    key: clientKey(request.headers.get('cf-connecting-ip')),
    requests: rpcItems.length,
    credits,
    now: t,
    perSecond: lim.perSecond,
    perIpDay: lim.perIpDay,
    globalHour: lim.globalHour,
    globalDay: lim.globalDay,
  });
  if (!quota) return rpcError(503, -32603, 'contador de uso indisponível');
  if (!quota.ok) {
    if (quota.reason === 'segundo') return rpcError(429, -32005, 'limite por segundo do proxy; tente de novo em 1 s', id, { 'retry-after': '1' });
    if (quota.reason === 'teto-hora') {
      return rpcError(429, -32005, 'max usage reached: limite por hora do proxy (volta na próxima hora UTC)', id, { 'retry-after': String(secondsToNextUtcHour(t)) });
    }
    const who = quota.reason === 'dia-ip' ? 'deste IP' : 'do proxy';
    return rpcError(429, -32005, `max usage reached: cota diária ${who} acabou (zera às 00:00 UTC)`, id, { 'retry-after': String(secondsToUtcMidnight(t)) });
  }

  // Rodízio das chaves (16/11/2026): a primeira que não está pausada; se ela responde "sem crédito" ou "chave
  // recusada", fica pausada e o MESMO pedido vai à seguinte. 429 comum (limite por segundo de uma conta) também passa
  // à seguinte, sem pausar. Tempo esgotado não passa: o Helius lento vale para todas, e somar prazos travaria o app.
  // Todas pausadas ou sem crédito: 429 "max usage reached", e o app cai para o RPC público até a próxima rodada.
  const ids = await Promise.all(upstreams.map(upstreamId));
  const paused = new Set(quota.paused ?? []);
  const secrets = [...new Set(upstreams.flatMap(secretParts))].sort((x, y) => y.length - x.length);
  // só o pedido conferido (forwardItem) e o content-type: IP, cabeçalhos e versão do usuário não vão para o upstream
  const forward = JSON.stringify(batch ? rpcItems.map(forwardItem) : forwardItem(rpcItems[0]!));
  let fallback: Response | null = null;
  for (let i = 0; i < upstreams.length; i++) {
    if (paused.has(ids[i]!)) continue;
    let res: Response;
    try {
      res = await upstreamFetch(upstreams[i]!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: forward,
        signal: AbortSignal.timeout(lim.upstreamMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      if (timeout) {
        await recordEvent(env, 'upstream-lento', t);
        return rpcError(504, -32603, `o RPC não respondeu em ${Math.round(lim.upstreamMs / 1000)} s`, id);
      }
      if (!fallback) await recordEvent(env, 'upstream-fora', t);
      fallback ??= rpcError(502, -32603, 'o RPC está fora do ar', id);
      continue;
    }
    let body: string;
    try {
      body = await res.text();
    } catch {
      fallback ??= rpcError(502, -32603, 'o RPC cortou a resposta', id);
      continue;
    }
    if (keyUnusable(res.status, body)) {
      // Só pausa se a chave recusar também a consulta fixa: um pedido montado para o Helius recusar (403 de um
      // método ou parâmetro) não pausa as chaves de todo mundo. Confirmada: pausa e segue na seguinte. Sonda sem
      // resposta: segue na seguinte sem pausar. Sonda boa: a recusa era do pedido e volta ao app como veio.
      const probe = await probeKey(upstreamFetch, upstreams[i]!);
      if (probe === 'recusada') {
        await pauseKey(env, ids[i]!, t + lim.pauseMs);
        await recordEvent(env, 'chave-pausada', t);
      }
      if (probe !== 'boa') continue;
    }
    const headers: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' };
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter && /^\d{1,6}$/.test(retryAfter)) headers['retry-after'] = retryAfter;
    headers['x-content-type-options'] = 'nosniff'; // o tipo do upstream pode vir errado: o navegador não adivinha
    const out = new Response(scrub(body, secrets), { status: res.status, headers });
    if (res.status === 429) {
      fallback = out; // limite por segundo desta conta: tenta a seguinte; se nenhuma servir, o app espera e repete
      continue;
    }
    return out;
  }
  if (fallback) return fallback;
  await recordEvent(env, 'sem-chave', t);
  return rpcError(429, -32005, 'max usage reached: as chaves do proxy estão sem crédito agora', id, { 'retry-after': String(Math.ceil(lim.pauseMs / 1000)) });
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
