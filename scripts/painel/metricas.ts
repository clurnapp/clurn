// Cálculos do painel do autor (scripts/painel-admin.ts). Funções puras: recebem o que veio da rede e devolvem números.
// Dado de fora (blockchain, GitHub, proxy) pode vir quebrado: item fora do formato é pulado, nunca derruba o resto.
//
// Privacidade: o painel conta clientes pelo DESTINO de cada limpeza (a carteira que recebeu os 89%), mas guarda e
// mostra só um hash curto dele, nunca o endereço. O cache em disco fica fora do repositório (~/.clurn-admin).
import crypto from 'node:crypto';

export const LAMPORTS = 1_000_000_000;
const DAY = 86_400_000;
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Uma transação da carteira da taxa: quando, quanto a carteira recebeu (negativo = saída) e o hash do destino.
export type FeeTx = { sig: string; t: number; fee: number; dest: string | null };

// Lê uma transação do getTransaction (encoding json). null se não for da carteira, tiver erro ou vier fora do formato.
export function parseFeeTx(sig: string, tx: unknown, feeWallet: string): FeeTx | null {
  try {
    const t = tx as any;
    if (!t?.meta || t.meta.err || typeof t.blockTime !== 'number') return null;
    const msgKeys: unknown[] = t.transaction?.message?.accountKeys ?? [];
    const keys = [...msgKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])].map((k) => (typeof k === 'string' ? k : (k as any)?.pubkey));
    const pre: unknown[] = t.meta.preBalances;
    const post: unknown[] = t.meta.postBalances;
    if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length) return null;
    const at = keys.indexOf(feeWallet);
    if (at < 0 || typeof pre[at] !== 'number' || typeof post[at] !== 'number') return null;
    const fee = (post[at] as number) - (pre[at] as number);
    // destino: a conta (fora a da taxa) que mais recebeu SOL nesta transação
    let best = -1;
    let gain = 0;
    for (let i = 0; i < keys.length && i < pre.length; i++) {
      const d = (post[i] as number) - (pre[i] as number);
      if (i !== at && typeof keys[i] === 'string' && Number.isFinite(d) && d > gain) {
        gain = d;
        best = i;
      }
    }
    return { sig, t: t.blockTime * 1000, fee, dest: fee > 0 && best >= 0 ? shortHash(keys[best] as string) : null };
  } catch {
    return null;
  }
}

export type DaySeries = { dia: string; sol: number; limpezas: number; novos: number };
export type FeeSummary = {
  receitaTotal: number;
  receitaHoje: number;
  receita7d: number;
  receita30d: number;
  limpezasTotal: number;
  limpezas7d: number;
  clientesTotal: number;
  clientesNovos7d: number;
  clientesRecorrentes: number; // destinos com limpezas em 2 dias ou mais
  saidas: number; // SOL que saiu da carteira da taxa (saques do autor)
  depositos: number; // SOL que entrou sem limpeza (ninguém mais recebeu na transação: depósito na carteira)
  primeira: number | null;
  ultima: number | null;
  porDia: DaySeries[]; // últimos `days` dias, com zeros
};

// Resumo das transações da carteira da taxa. Limpeza paga: a carteira recebe E outra conta (o destino, 89%) também
// recebe na mesma transação. Entrada sem destino é depósito (ex.: o depósito que criou a carteira em 09/11/2026);
// fee < 0 é saída. Nenhum dos dois é receita.
export function feeSummary(txs: FeeTx[], now: number, days = 30): FeeSummary {
  const today = utcDay(now);
  const since = (n: number) => now - n * DAY;
  const paid = txs.filter((x) => x.fee > 0 && x.dest).sort((a, b) => a.t - b.t);
  const firstSeen = new Map<string, number>();
  const daysOf = new Map<string, Set<string>>();
  for (const x of paid) {
    if (!x.dest) continue;
    if (!firstSeen.has(x.dest)) firstSeen.set(x.dest, x.t);
    (daysOf.get(x.dest) ?? daysOf.set(x.dest, new Set()).get(x.dest)!).add(utcDay(x.t));
  }
  const sum = (list: FeeTx[]) => list.reduce((a, x) => a + x.fee, 0) / LAMPORTS;
  const porDia: DaySeries[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dia = utcDay(now - i * DAY);
    const list = paid.filter((x) => utcDay(x.t) === dia);
    porDia.push({ dia, sol: sum(list), limpezas: list.length, novos: [...firstSeen.values()].filter((t) => utcDay(t) === dia).length });
  }
  return {
    receitaTotal: sum(paid),
    receitaHoje: sum(paid.filter((x) => utcDay(x.t) === today)),
    receita7d: sum(paid.filter((x) => x.t >= since(7))),
    receita30d: sum(paid.filter((x) => x.t >= since(30))),
    limpezasTotal: paid.length,
    limpezas7d: paid.filter((x) => x.t >= since(7)).length,
    clientesTotal: firstSeen.size,
    clientesNovos7d: [...firstSeen.values()].filter((t) => t >= since(7)).length,
    clientesRecorrentes: [...daysOf.values()].filter((s) => s.size >= 2).length,
    saidas: -txs.filter((x) => x.fee < 0).reduce((a, x) => a + x.fee, 0) / LAMPORTS,
    depositos: txs.filter((x) => x.fee > 0 && !x.dest).reduce((a, x) => a + x.fee, 0) / LAMPORTS,
    primeira: paid[0]?.t ?? null,
    ultima: paid.at(-1)?.t ?? null,
    porDia,
  };
}

export type ReleaseRow = { versao: string; data: string; downloads: number };
export type ReleaseSummary = { ultima: ReleaseRow | null; porVersao: ReleaseRow[]; total: number };

// Releases do GitHub (api.github.com/repos/<repo>/releases): downloads do instalador por versão.
export function releaseSummary(json: unknown): ReleaseSummary {
  const rows: ReleaseRow[] = [];
  for (const r of Array.isArray(json) ? json : []) {
    const tag = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(tag) || r?.draft === true) continue;
    const assets: unknown[] = Array.isArray(r.assets) ? r.assets : [];
    const downloads = assets.reduce((a: number, x: any) => a + (typeof x?.name === 'string' && /\.exe$/i.test(x.name) && Number.isSafeInteger(x.download_count) && x.download_count >= 0 ? x.download_count : 0), 0);
    rows.push({ versao: tag, data: typeof r.published_at === 'string' ? r.published_at.slice(0, 10) : '', downloads });
  }
  const byVersion = (a: ReleaseRow, b: ReleaseRow) => {
    const [x, y] = [a.versao, b.versao].map((v) => v.split('.').map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  };
  rows.sort(byVersion);
  return { ultima: rows[0] ?? null, porVersao: rows, total: rows.reduce((a, r) => a + r.downloads, 0) };
}

// O que o /stats do proxy devolve (proxy/worker.ts, statsResponse), conferido campo a campo.
export type ProxyDay = { dia: string; pedidos: number; creditos: number; ips: number; metodos: Record<string, number>; versoes: Record<string, number>; recusas: Record<string, number>; eventos: Record<string, number> };
export type ProxyStats = { hoje: ProxyDay; historico: ProxyDay[]; chaves: Array<{ posicao: number; pausadaAte: number | null }>; limites: { porIpDia: number; tetoHora: number; tetoDia: number }; versaoMinima: string | null };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const counts = (x: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (x && typeof x === 'object' && !Array.isArray(x)) for (const [k, v] of Object.entries(x)) if (/^[A-Za-z0-9.\-]{1,48}$/.test(k)) out[k] = num(v);
  return out;
};
const day = (x: any): ProxyDay | null =>
  typeof x?.dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.dia)
    ? { dia: x.dia, pedidos: num(x.pedidos), creditos: num(x.creditos), ips: num(x.ips), metodos: counts(x.metodos), versoes: counts(x.versoes), recusas: counts(x.recusas), eventos: counts(x.eventos) }
    : null;

export function parseProxyStats(x: unknown): ProxyStats | null {
  const o = x as any;
  const hoje = day(o?.hoje);
  if (!hoje) return null;
  return {
    hoje,
    historico: (Array.isArray(o.historico) ? o.historico : []).map(day).filter((d: ProxyDay | null): d is ProxyDay => d !== null),
    chaves: (Array.isArray(o.chaves) ? o.chaves : []).filter((c: any) => Number.isSafeInteger(c?.posicao)).map((c: any) => ({ posicao: c.posicao, pausadaAte: typeof c.pausadaAte === 'number' ? c.pausadaAte : null })),
    limites: { porIpDia: num(o.limites?.porIpDia), tetoHora: num(o.limites?.tetoHora), tetoDia: num(o.limites?.tetoDia) },
    versaoMinima: typeof o.versaoMinima === 'string' ? o.versaoMinima : null,
  };
}

// Versões em uso: soma de pedidos por versão nos últimos `days` dias do proxy (hoje incluído), em %.
export function versionShare(p: ProxyStats, days = 7): Array<{ versao: string; pedidos: number; pct: number }> {
  const all = [p.hoje, ...p.historico.slice(0, days - 1)];
  const sum = new Map<string, number>();
  for (const d of all) for (const [v, n] of Object.entries(d.versoes)) sum.set(v, (sum.get(v) ?? 0) + n);
  const total = [...sum.values()].reduce((a, b) => a + b, 0) || 1;
  return [...sum].map(([versao, pedidos]) => ({ versao, pedidos, pct: (100 * pedidos) / total })).sort((a, b) => b.pedidos - a.pedidos);
}

export type Alert = { nivel: 'critico' | 'atencao'; texto: string };
export type Health = { proxy: 'ok' | 'erro'; site: 'ok' | 'erro'; atualizacao: { kind: string; versao?: string; reason?: string } };

// O que precisa de atenção agora, do mais grave ao mais leve.
export function alerts(a: { now: number; proxy: ProxyStats | null; proxyErro: string | null; health: Health; releases: ReleaseSummary | null; fee: FeeSummary | null }): Alert[] {
  const out: Alert[] = [];
  const crit = (texto: string) => out.push({ nivel: 'critico', texto });
  const warn = (texto: string) => out.push({ nivel: 'atencao', texto });
  if (a.health.proxy === 'erro') crit('O proxy (rpc.clurn.app) não respondeu: os apps estão usando o RPC público, mais lento.');
  if (a.health.atualizacao.kind === 'error') crit(`O arquivo de versão do último Release não passou na conferência (${a.health.atualizacao.reason ?? 'motivo desconhecido'}): ninguém recebe a atualização.`);
  if (a.health.site === 'erro') crit('O site clurn.app não respondeu.');
  const p = a.proxy;
  if (p) {
    const paused = p.chaves.filter((c) => c.pausadaAte !== null && c.pausadaAte > a.now);
    if (p.chaves.length && paused.length === p.chaves.length) crit('Todas as chaves do Helius estão sem crédito: o proxy recusa tudo e os apps caem para o RPC público.');
    else if (paused.length) warn(`${paused.length} de ${p.chaves.length} chave(s) do Helius sem crédito agora (pausada até voltar).`);
    if (p.hoje.recusas.teto) crit(`O teto do dia do proxy acabou ${p.hoje.recusas.teto} vez(es) hoje: todo mundo caiu para o RPC público.`);
    if (p.hoje.recusas['teto-hora']) warn(`O teto por hora do proxy recusou ${p.hoje.recusas['teto-hora']} pedido(s) hoje (pico de uso ou abuso).`);
    if (p.limites.tetoDia && p.hoje.creditos >= 0.8 * p.limites.tetoDia) warn(`Créditos de hoje em ${Math.round((100 * p.hoje.creditos) / p.limites.tetoDia)}% do teto do dia.`);
    const ev = p.hoje.eventos;
    if (ev['upstream-fora'] || ev['upstream-lento']) warn(`O Helius falhou hoje: ${ev['upstream-fora'] ?? 0} fora do ar, ${ev['upstream-lento'] ?? 0} lento.`);
    const latest = a.releases?.ultima?.versao;
    if (latest) {
      const old = versionShare(p).filter((v) => v.versao !== latest).reduce((s, v) => s + v.pct, 0);
      if (old >= 30) warn(`${Math.round(old)}% dos pedidos dos últimos 7 dias vêm de versões anteriores à ${latest}.`);
    }
  } else if (a.proxyErro) warn(`Estatísticas do proxy indisponíveis: ${a.proxyErro}.`);
  if (a.fee?.ultima && a.now - a.fee.ultima > 2 * DAY) warn('Nenhuma limpeza paga há mais de 2 dias.');
  return out;
}
