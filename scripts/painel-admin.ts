// Painel do autor: como o Clurn público está indo, sem coletar nada de quem usa o app.
//
//   npm run admin
//
// Abre uma página só neste computador (127.0.0.1, endereço com código sorteado a cada abertura) que junta:
//   1. a carteira da taxa na blockchain (dado público): receita, limpezas pagas, clientes (destinos distintos, só
//      por hash) por dia. Cache incremental em ~/.clurn-admin/taxa.json, fora do repositório;
//   2. as estatísticas do proxy (GET /stats, proxy/worker.ts): pedidos, créditos, IPs distintos (só o número),
//      envios de transação, versões do app em uso, recusas por cota, saúde das chaves do Helius;
//   3. os Releases do GitHub: downloads do instalador por versão;
//   4. a saúde: proxy, site e o arquivo de versão assinado do último Release (o mesmo que o app confere).
//
// Variáveis do terminal (nenhuma vai para arquivo, log ou página):
//   CLURN_STATS_TOKEN  o secret STATS_TOKEN do proxy; sem ela, lê ~/.clurn-admin/stats-token (sem os dois, o proxy fica de fora)
//   CLURN_PROXY_URL    padrão https://rpc.clurn.app/
//   SOLANA_RPC_URL     para ler a blockchain (padrão: RPC público, devagar de propósito)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { checkUpdate, UPDATE_REPO } from '../src/app/atualizacao.ts';
import { alerts, feeSummary, parseFeeTx, parseProxyStats, releaseSummary, versionShare, type FeeTx, type Health, type ProxyStats } from './painel/metricas.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PROXY = process.env.CLURN_PROXY_URL?.trim() || 'https://rpc.clurn.app/';
const RPC = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SITE = 'https://clurn.app/';
export const CACHE_DIR = path.join(os.homedir(), '.clurn-admin');
const CACHE_FILE = path.join(CACHE_DIR, 'taxa.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- blockchain: carteira da taxa ----------
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      await sleep(1500 * (i + 1));
      continue;
    }
    const j = (await res.json().catch(() => null)) as any;
    if (!j || j.error) throw new Error(`${method}: o RPC recusou`);
    return j.result;
  }
  throw new Error(`${method}: o RPC não respondeu`);
}

type Cache = { wallet: string; txs: FeeTx[]; skipped: string[] };
function readCache(): Cache {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c?.wallet === APP_FEE_WALLET && Array.isArray(c.txs)) return { wallet: c.wallet, txs: c.txs, skipped: Array.isArray(c.skipped) ? c.skipped : [] };
  } catch {
    // primeiro uso ou cache quebrado: começa do zero
  }
  return { wallet: APP_FEE_WALLET, txs: [], skipped: [] };
}

// Lê só as transações novas desde a última vez (as antigas não mudam na blockchain).
let syncing: Promise<Cache> | null = null;
function syncFeeWallet(log: (s: string) => void): Promise<Cache> {
  syncing ??= (async () => {
    const cache = readCache();
    const known = new Set([...cache.txs.map((x) => x.sig), ...cache.skipped]);
    const fresh: string[] = [];
    for (let before: string | undefined; ;) {
      const page: any[] = await rpc('getSignaturesForAddress', [APP_FEE_WALLET, { limit: 1000, ...(before ? { before } : {}) }]);
      const list = Array.isArray(page) ? page : [];
      let reachedKnown = false;
      for (const s of list) {
        if (typeof s?.signature !== 'string') continue;
        if (known.has(s.signature)) {
          reachedKnown = true;
          break;
        }
        if (s.err) cache.skipped.push(s.signature);
        else fresh.push(s.signature);
      }
      if (reachedKnown || list.length < 1000) break;
      before = list.at(-1).signature;
    }
    let n = 0;
    for (const sig of fresh) {
      const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }]).catch(() => null);
      const parsed = tx ? parseFeeTx(sig, tx, APP_FEE_WALLET) : null;
      if (parsed) cache.txs.push(parsed);
      else if (tx) cache.skipped.push(sig); // sem tx: tenta de novo na próxima
      if (++n % 50 === 0) log(`  carteira da taxa: ${n}/${fresh.length} transações novas lidas`);
      await sleep(120);
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
    return cache;
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// ---------- proxy, GitHub, saúde ----------
// O token do /stats: a variável do terminal ou o arquivo ~/.clurn-admin/stats-token (fora do repositório, criado
// junto com o secret do proxy). Nunca vai para log nem para a página.
export const TOKEN_FILE = path.join(CACHE_DIR, 'stats-token');
export function statsToken(env: NodeJS.ProcessEnv = process.env, file = TOKEN_FILE): string | null {
  const fromEnv = env.CLURN_STATS_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

async function proxyStats(): Promise<{ stats: ProxyStats | null; erro: string | null }> {
  const token = statsToken();
  if (!token) return { stats: null, erro: `sem o token do proxy (${TOKEN_FILE} ou CLURN_STATS_TOKEN)` };
  try {
    const res = await fetch(new URL('/stats', PROXY), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { stats: null, erro: 'o proxy recusou o token (ou ainda não tem o /stats publicado)' };
    if (!res.ok) return { stats: null, erro: `o proxy respondeu HTTP ${res.status}` };
    const stats = parseProxyStats(await res.json());
    return stats ? { stats, erro: null } : { stats: null, erro: 'resposta do proxy fora do formato' };
  } catch {
    return { stats: null, erro: 'sem conexão com o proxy' };
  }
}

async function releases() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=50`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'clurn-painel' }, signal: AbortSignal.timeout(15_000) });
    return res.ok ? releaseSummary(await res.json()) : null;
  } catch {
    return null;
  }
}

async function health(): Promise<Health & { proxyMs: number | null }> {
  const t0 = Date.now();
  const proxyOk = await fetch(PROXY, { method: 'POST', headers: { 'content-type': 'application/json', 'x-clurn-versao': APP_VERSION }, body: '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}', signal: AbortSignal.timeout(15_000) })
    .then(async (r) => r.ok && (await r.json().catch(() => null))?.result === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    .catch(() => false);
  const proxyMs = proxyOk ? Date.now() - t0 : null;
  const siteOk = await fetch(SITE, { method: 'HEAD', signal: AbortSignal.timeout(15_000) }).then((r) => r.ok).catch(() => false);
  // o mesmo caminho do app: baixa o clurn-versao.json do último Release e confere a assinatura com as chaves do app
  const u = await checkUpdate('0.0.0');
  const atualizacao = u.kind === 'available' ? { kind: 'ok', versao: u.manifest.versao } : u.kind === 'error' ? { kind: 'error', reason: u.reason } : { kind: u.kind };
  return { proxy: proxyOk ? 'ok' : 'erro', site: siteOk ? 'ok' : 'erro', atualizacao, proxyMs };
}

// ---------- tudo junto ----------
let cached: { at: number; data: unknown } | null = null;
async function collect(force: boolean, log: (s: string) => void) {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.data;
  const now = Date.now();
  const [chain, proxy, rel, h] = await Promise.all([
    syncFeeWallet(log).then((c) => ({ fee: feeSummary(c.txs, now), erro: null as string | null })).catch((e) => ({ fee: null, erro: e instanceof Error ? e.message : 'erro' })),
    proxyStats(),
    releases(),
    health(),
  ]);
  const data = {
    agora: now,
    versaoPainel: APP_VERSION,
    carteiraTaxa: APP_FEE_WALLET,
    taxa: chain.fee,
    taxaErro: chain.erro,
    proxy: proxy.stats,
    proxyErro: proxy.erro,
    versoes: proxy.stats ? versionShare(proxy.stats) : [],
    releases: rel,
    saude: h,
    alertas: alerts({ now, proxy: proxy.stats, proxyErro: proxy.erro, health: h, releases: rel, fee: chain.fee }),
  };
  cached = { at: now, data };
  return data;
}

// ---------- servidor local ----------
export function startServer(opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const code = crypto.randomBytes(18).toString('base64url');
  const page = fs.readFileSync(path.join(import.meta.dirname, 'painel', 'painel.html'), 'utf8');
  const server = http.createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', ...extra });
      res.end(body);
    };
    // só este computador, pelo endereço certo (DNS rebinding) e com o código da abertura
    if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET') return send(404, 'text/plain; charset=utf-8', 'não encontrado');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === `/${code}`) {
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(200, 'text/html; charset=utf-8', page.replaceAll('{{NONCE}}', nonce), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    if (url.pathname === `/${code}/dados`) {
      try {
        return send(200, 'application/json', JSON.stringify(await collect(url.searchParams.get('forcar') === '1', log)));
      } catch {
        return send(500, 'application/json', '{"erro":"falha ao juntar os dados"}');
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'não encontrado');
  });
  return { server, code };
}

if (import.meta.main) {
  const { server, code } = startServer();
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    console.log('Painel do Clurn (só neste computador).');
    console.log(statsToken() ? 'Proxy: com token.' : 'Proxy: sem token (~/.clurn-admin/stats-token ou CLURN_STATS_TOKEN), a parte do proxy fica de fora.');
    console.log(`A 1ª abertura lê todas as transações da carteira da taxa (alguns minutos pelo RPC público); depois, só as novas.`);
    console.log(`Abra: http://127.0.0.1:${port}/${code}`);
    console.log('Para fechar: Ctrl + C.');
  });
}
