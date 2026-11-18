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
//   4. a saúde: proxy, site e o arquivo de versão assinado do último Release (o mesmo que o app confere);
//   5. o preço do SOL (CoinGecko, consulta pública sem nada nosso) para mostrar em US$ e R$, e o saldo da carteira.
//
// Visão de dono (17/11/2026): período 7/30/90 dias ou tudo com comparação ao período anterior, meta do mês com
// projeção, coortes semanais, horários de uso em Brasília, tamanho das limpezas, concentração, atividade recente,
// conversão aproximada (pagantes ÷ pessoas no proxy) e créditos contra o teto.
//
//   npm run admin -- --demo   números fictícios (scripts/painel/demo.ts), sem nenhuma consulta à rede
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
import {
  LAMPORTS,
  parsePrice,
  parseProxyStats,
  releaseSummary,
  BETA_START,
  parseWalletList,
  type OldWallet,
  type FeeTx,
  type Health,
  type Price,
  type ProxyStats,
} from './painel/metricas.ts';
import { parseFeeTx } from './painel/ler-tx.ts';
import { buildData as build } from './painel/montar.ts';
import { demoFailed, demoProxy, demoReleases, demoTxs } from './painel/demo.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP_VERSION: string = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const PROXY = process.env.CLURN_PROXY_URL?.trim() || 'https://rpc.clurn.app/';
const RPC = process.env.SOLANA_RPC_URL?.trim() || 'https://api.mainnet-beta.solana.com';
const SITE = 'https://clurn.app/';
// CLURN_ADMIN_DIR só para os testes (uma pasta temporária no lugar do cache de verdade)
export const CACHE_DIR = process.env.CLURN_ADMIN_DIR?.trim() || path.join(os.homedir(), '.clurn-admin');
const CACHE_FILE = path.join(CACHE_DIR, 'taxa.json');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- blockchain: carteira da taxa ----------
// Ritmo único para todos os pedidos: o RPC público aceita ~4 por segundo por método (medido em 17/11/2026: com
// 1 a cada 1,5 s não houve recusa; com 4 leituras em paralelo sem pausa, 429 por minutos). Começa em ~3,5/s,
// dobra o intervalo a cada recusa (até 4 s) e volta devagar quando o RPC aceita.
const MIN_GAP_MS = process.env.SOLANA_RPC_URL ? 110 : 285;
export const pace = { gap: MIN_GAP_MS, next: 0 };
async function waitTurn() {
  const now = Date.now();
  const at = Math.max(now, pace.next);
  pace.next = at + pace.gap;
  if (at > now) await sleep(at - now);
}
async function rpc(method: string, params: unknown[]): Promise<any> {
  for (let i = 0; i < 8; i++) {
    await waitTurn();
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) {
      if (res?.status === 429) pace.gap = Math.min(4000, pace.gap * 2);
      await sleep(1500 * (i + 1));
      continue;
    }
    pace.gap = Math.max(MIN_GAP_MS, Math.round(pace.gap * 0.97));
    const j = (await res.json().catch(() => null)) as any;
    if (!j || j.error) throw new Error(`${method}: o RPC recusou`);
    return j.result;
  }
  throw new Error(`${method}: o RPC não respondeu`);
}

// Cache por carteira: a atual em taxa.json (o mesmo de antes), cada antiga em taxa-<8 primeiros>.json.
// failed = transações com erro que tocaram a carteira, com a hora (para a taxa de sucesso por dia).
// pending = assinaturas já listadas e ainda não lidas (a leitura continua de onde parou, mesmo depois de fechar).
// completo = a lista já foi até o início (`since`) e não falta nada: daí em diante basta buscar as mais novas.
// seen = [hora, 1 = deu certo / 0 = erro] de TODA assinatura desde `since` (só da lista, sem baixar a transação):
// a atividade e a taxa de sucesso aparecem na hora, antes de ler o valor de cada uma. seenFull = a lista está inteira.
type Cache = { wallet: string; txs: FeeTx[]; skipped: string[]; failed: Array<{ sig: string; t: number }>; pending: string[]; completo: boolean; seen: Array<[number, number]>; seenFull: boolean; since?: number };
const cacheFile = (wallet: string) => (wallet === APP_FEE_WALLET ? CACHE_FILE : path.join(CACHE_DIR, `taxa-${wallet.slice(0, 8)}.json`));
const emptyCache = (wallet: string): Cache => ({ wallet, txs: [], skipped: [], failed: [], pending: [], completo: false, seen: [], seenFull: false });
const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
export function readCache(wallet: string): Cache {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(wallet), 'utf8'));
    if (c?.wallet === wallet && Array.isArray(c.txs)) {
      return {
        wallet,
        txs: c.txs,
        skipped: strings(c.skipped),
        failed: Array.isArray(c.failed) ? c.failed.filter((f: any) => typeof f?.sig === 'string' && Number.isFinite(f?.t)) : [],
        pending: strings(c.pending),
        completo: c.completo === true, // cache de antes deste campo: lista tudo de novo uma vez (barato) para achar o que falta
        seen: Array.isArray(c.seen) ? c.seen.filter((x: any) => Array.isArray(x) && Number.isFinite(x[0]) && (x[1] === 0 || x[1] === 1)) : [],
        seenFull: c.seenFull === true,
        since: c.since,
      };
    }
  } catch {
    // primeiro uso ou cache quebrado: começa do zero
  }
  return emptyCache(wallet);
}

// As carteiras antigas da taxa: arquivo do autor fora do repositório (ver parseWalletList).
export const OLD_WALLETS_FILE = path.join(CACHE_DIR, 'carteiras-antigas.txt');
export function oldWallets(file = OLD_WALLETS_FILE): OldWallet[] {
  try {
    return parseWalletList(fs.readFileSync(file, 'utf8'), APP_FEE_WALLET);
  } catch {
    return [];
  }
}

// Lê só as transações novas desde a última vez (as antigas não mudam na blockchain), até a data `since`:
// o que a carteira fez antes disso não é do app e nem é baixado.
export async function syncWallet(wallet: string, since: number, log: (s: string) => void, label: string): Promise<Cache> {
  let cache = readCache(wallet);
  if (cache.since !== undefined && cache.since !== since) cache = emptyCache(wallet); // data mudou: relê
  const known = new Set([...cache.txs.map((x) => x.sig), ...cache.skipped, ...cache.failed.map((f) => f.sig), ...cache.pending]);
  const fresh: string[] = [];
  let reachedStart = false;
  // sem a lista inteira de atividade, esta passada a refaz do zero (e não para na 1ª conhecida)
  const fullPass = !(cache.completo && cache.seenFull);
  const seen: Array<[number, number]> = fullPass ? [] : cache.seen;
  const newSeen: Array<[number, number]> = [];
  for (let before: string | undefined; ;) {
    const page: any[] = await rpc('getSignaturesForAddress', [wallet, { limit: 1000, ...(before ? { before } : {}) }]);
    const list = Array.isArray(page) ? page : [];
    let stop = false;
    for (const s of list) {
      if (typeof s?.signature !== 'string') continue;
      const t = typeof s.blockTime === 'number' ? s.blockTime * 1000 : null;
      if (t !== null && t < since) {
        stop = reachedStart = true; // a lista vem da mais nova para a mais velha: daqui para trás é antes do app
        break;
      }
      if (known.has(s.signature)) {
        // com o cache completo, daqui para trás já foi tudo lido e contado; sem ele, conta e continua
        if (!fullPass) {
          stop = true;
          break;
        }
        if (t !== null) newSeen.push([t, s.err ? 0 : 1]);
        continue;
      }
      if (t !== null) newSeen.push([t, s.err ? 0 : 1]);
      if (s.err) {
        if (t !== null) cache.failed.push({ sig: s.signature, t });
        else cache.skipped.push(s.signature);
      } else fresh.push(s.signature);
    }
    if (list.length < 1000) reachedStart = true;
    if (stop || list.length < 1000) break;
    before = list.at(-1).signature;
    if ((fresh.length || 1) % 5000 < 1000) log(`  ${label}: ${fresh.length} assinaturas novas até agora…`);
  }
  // as novas entram na frente da fila; a fila guarda o que falta mesmo se fechar no meio
  cache.pending = [...fresh, ...cache.pending];
  if (cache.completo || reachedStart) cache.completo = true;
  cache.seen = [...newSeen, ...seen];
  if (fullPass) cache.seenFull = reachedStart;
  writeCache(cache, since);
  const todo = cache.pending.length;
  if (todo) log(`  ${label}: lendo ${todo} transações`);
  progress.carteira = label;
  progress.total += todo;
  // várias leituras ao mesmo tempo, num ritmo que o RPC aguenta (o público: ~4 por segundo por método)
  const queue = [...cache.pending];
  const retry: string[] = [];
  const done = new Set<string>();
  let n = 0;
  const save = () => {
    cache.pending = [...queue, ...retry].filter((s) => !done.has(s));
    writeCache(cache, since);
  };
  const worker = async () => {
    for (let sig = queue.shift(); sig !== undefined; sig = queue.shift()) {
      const tx = await rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, encoding: 'json', commitment: 'confirmed' }]).catch(() => null);
      if (tx) {
        const parsed = parseFeeTx(sig, tx, wallet);
        if (parsed) cache.txs.push(parsed);
        else cache.skipped.push(sig);
        done.add(sig);
      } else retry.push(sig); // o RPC não deu: fica na fila para a próxima leitura
      progress.lidas++;
      if (++n % 100 === 0) {
        log(`  ${label}: ${n}/${todo} transações lidas`);
        save(); // salva no caminho: se cair, não começa do zero
      }
      await sleep(READ_PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: READ_WORKERS }, worker));
  save();
  return cache;
}
// leituras em paralelo; quem segura o ritmo é o waitTurn do rpc()
const READ_WORKERS = process.env.SOLANA_RPC_URL ? 10 : 4;
const READ_PAUSE_MS = 0;

// Progresso da leitura da blockchain (a página mostra enquanto lê).
export const progress = { lendo: false, carteira: '', lidas: 0, total: 0 };
function writeCache(cache: Cache, since: number) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile(cache.wallet), JSON.stringify({ ...cache, since }), { mode: 0o600 });
}

// Todas as carteiras da taxa juntas; cada transação marcada com a carteira (w: 0 = atual, 1… = antigas).
// Uma carteira que falhar na leitura não derruba as outras: vira aviso.
// A leitura roda em segundo plano; a página usa o que já está no cache e mostra o progresso.
let syncing: Promise<void> | null = null;
let syncErrors: string[] = [];
function startSync(log: (s: string) => void) {
  syncing ??= (async () => {
    const wallets = [{ endereco: APP_FEE_WALLET, desde: BETA_START }, ...oldWallets()];
    Object.assign(progress, { lendo: true, carteira: '', lidas: 0, total: 0 });
    const erros: string[] = [];
    for (const [w, c] of wallets.entries()) {
      const label = w === 0 ? 'carteira da taxa' : `carteira antiga ${w}`;
      try {
        await syncWallet(c.endereco, c.desde, log, label);
      } catch (e) {
        erros.push(`${label}: ${e instanceof Error ? e.message : 'erro'}`);
      }
    }
    syncErrors = erros;
    if (progress.total) log(`  leitura concluída: ${progress.lidas} transações`);
  })().finally(() => {
    progress.lendo = false;
    syncing = null;
  });
  return syncing;
}

// O que já está no disco, de todas as carteiras, marcado com a carteira (w: 0 = atual, 1… = antigas).
function fromCaches() {
  const wallets = [{ endereco: APP_FEE_WALLET, desde: BETA_START }, ...oldWallets()];
  const txs: FeeTx[] = [];
  const failed: Array<{ t: number; w: number }> = [];
  const seen: Array<{ t: number; ok: boolean; w: number }> = [];
  const faltam: number[] = [];
  for (const [w, c] of wallets.entries()) {
    const cache = readCache(c.endereco);
    for (const x of cache.txs) if (x.t >= c.desde) txs.push({ ...x, w });
    for (const f of cache.failed) if (f.t >= c.desde) failed.push({ t: f.t, w });
    for (const [t, ok] of cache.seen) if (t >= c.desde) seen.push({ t, ok: ok === 1, w });
    faltam.push(cache.pending.length);
  }
  return { txs, failed, seen, faltam, wallets };
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

// Preço do SOL em dólar e real, só para converter os números da tela (nada é enviado: é uma consulta pública).
async function solPrice(): Promise<Price | null> {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,brl', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? parsePrice(await res.json()) : null;
  } catch {
    return null;
  }
}

// Saldo atual de uma carteira da taxa (o "caixa"), em SOL.
async function walletBalance(wallet: string): Promise<number | null> {
  try {
    const r = await rpc('getBalance', [wallet, { commitment: 'confirmed' }]);
    const v = r?.value;
    return Number.isSafeInteger(v) && v >= 0 ? v / LAMPORTS : null;
  } catch {
    return null;
  }
}

// ---------- tudo junto ----------
// buildData mora em painel/montar.ts (o painel privado usa o mesmo no navegador); aqui entram a versão e a carteira.
export { PERIODS } from './painel/montar.ts';
export const buildData = (src: Omit<Parameters<typeof build>[0], 'versaoPainel' | 'carteiraTaxa'>) => build({ ...src, versaoPainel: APP_VERSION, carteiraTaxa: APP_FEE_WALLET });

let cached: { at: number; data: unknown } | null = null;
let lastSync = 0;
async function collect(force: boolean, log: (s: string) => void, demo = false) {
  if (!force && cached && Date.now() - cached.at < 60_000 && !progress.lendo) return cached.data;
  const now = Date.now();
  let data;
  if (demo) {
    const d = demoTxs(now);
    data = buildData({
      now,
      txs: d,
      failed: demoFailed(now),
      seen: [...d.map((x) => ({ t: x.t, ok: true, w: x.w ?? 0 })), ...demoFailed(now).map((x) => ({ t: x.t, ok: false, w: x.w }))],
      faltam: [0, 0],
      carteiras: [
        { endereco: 'DemoAtual1111111111111111111111111111111111', desde: BETA_START, saldo: 38.12 },
        { endereco: 'DemoAntiga111111111111111111111111111111111', desde: BETA_START, saldo: 3.15 },
      ],
      taxaErro: null,
      proxy: demoProxy(now),
      proxyErro: null,
      releases: demoReleases(),
      saude: { proxy: 'ok', site: 'ok', atualizacao: { kind: 'ok', versao: '1.0.1' }, proxyMs: 184 },
      preco: { usd: 182.4, brl: 1043.9 },
      saldo: 41.27,
      demo: true,
    });
  } else {
    // a leitura da blockchain segue em segundo plano; aqui entra o que já foi lido
    if (!syncing && (force || !lastSync || Date.now() - lastSync > 5 * 60_000)) {
      lastSync = Date.now();
      void startSync(log);
    }
    const disk = fromCaches();
    const wallets = disk.wallets;
    const chain = { txs: disk.txs as FeeTx[] | null, failed: disk.failed, avisos: syncErrors, erro: null as string | null };
    const [proxy, rel, h, preco, saldos] = await Promise.all([
      proxyStats(),
      releases(),
      health(),
      solPrice(),
      Promise.all(wallets.map((w) => walletBalance(w.endereco))),
    ]);
    const known = saldos.filter((s): s is number => s !== null);
    data = buildData({
      now,
      txs: chain.txs,
      failed: chain.failed,
      seen: disk.seen,
      faltam: disk.faltam,
      carteiras: wallets.map((w, i) => ({ ...w, saldo: saldos[i] ?? null })),
      avisosCarteiras: chain.avisos,
      taxaErro: chain.erro,
      proxy: proxy.stats,
      proxyErro: proxy.erro,
      releases: rel,
      saude: h,
      preco,
      saldo: known.length ? known.reduce((a, b) => a + b, 0) : null,
      demo: false,
    });
    data = { ...data, leitura: { ...progress } };
  }
  cached = { at: now, data };
  return data;
}

// ---------- servidor local ----------
// Os arquivos do tema do app que o painel usa (src/app/ui/assets), com o tipo de cada um.
const UI_ASSETS = path.join(ROOT, 'src', 'app', 'ui', 'assets');
export const PANEL_ASSETS: Record<string, string> = Object.assign(Object.create(null), {
  'inter.woff2': 'font/woff2',
  'chakra-petch-600.woff2': 'font/woff2',
  'chakra-petch-700.woff2': 'font/woff2',
  'jetbrains-mono-500.woff2': 'font/woff2',
  'clurn.svg': 'image/svg+xml',
});
function sendFile(res: http.ServerResponse, file: string, type: string) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('não encontrado');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(data);
  });
}
export function startServer(opts: { log?: (s: string) => void; demo?: boolean } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const demo = opts.demo === true;
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
      return send(200, 'text/html; charset=utf-8', page.replaceAll('{{NONCE}}', nonce).replaceAll('{{CODE}}', code), {
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }
    // fontes e logo do app (o mesmo tema), só os arquivos desta lista: nada de caminho vindo do pedido
    const name = url.pathname.startsWith(`/${code}/assets/`) ? url.pathname.slice(code.length + 9) : '';
    const asset = PANEL_ASSETS[name];
    if (asset) return sendFile(res, path.join(UI_ASSETS, name), asset);
    if (url.pathname === `/${code}/dados`) {
      try {
        return send(200, 'application/json', JSON.stringify(await collect(url.searchParams.get('forcar') === '1', log, demo)));
      } catch {
        return send(500, 'application/json', '{"erro":"falha ao juntar os dados"}');
      }
    }
    return send(404, 'text/plain; charset=utf-8', 'não encontrado');
  });
  return { server, code };
}

if (import.meta.main) {
  const demo = process.argv.includes('--demo');
  const { server, code } = startServer({ demo });
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    console.log('Painel do Clurn (só neste computador).');
    if (demo) console.log('MODO DEMONSTRAÇÃO: números fictícios, nenhuma consulta à rede.');
    console.log(statsToken() ? 'Proxy: com token.' : 'Proxy: sem token (~/.clurn-admin/stats-token ou CLURN_STATS_TOKEN), a parte do proxy fica de fora.');
    console.log(`A 1ª abertura lê todas as transações da carteira da taxa (alguns minutos pelo RPC público); depois, só as novas.`);
    console.log(`Abra: http://127.0.0.1:${port}/${code}`);
    console.log('Para fechar: Ctrl + C.');
  });
}
