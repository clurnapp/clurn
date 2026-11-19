// Cálculos do painel do autor (scripts/painel-admin.ts e admin/). Funções puras: recebem o que veio da rede e devolvem números.
// Sem import do Node: roda também no navegador (o painel privado em admin.clurn.app faz as contas na página).
// Dado de fora (blockchain, GitHub, proxy) pode vir quebrado: item fora do formato é pulado, nunca derruba o resto.
//
// Privacidade: o painel conta clientes pelo DESTINO de cada limpeza (a carteira que recebeu os 89%), mas guarda e
// mostra só um hash curto dele, nunca o endereço. O cache em disco fica fora do repositório (~/.clurn-admin).

export const LAMPORTS = 1_000_000_000;
const DAY = 86_400_000;
// Dias no horário de Brasília (18/11/2026): em UTC o "hoje" do painel virava às 21h. UTC−3 fixo, sem horário de
// verão desde 2019. O nome utcDay ficou por compatibilidade: devolve a data AAAA-MM-DD do dia de Brasília.
const BRT_OFFSET = -3 * 3_600_000;
export const utcDay = (ms: number) => new Date(ms + BRT_OFFSET).toISOString().slice(0, 10);
// meia-noite de Brasília do dia AAAA-MM-DD, em ms reais
export const dayStart = (dia: string) => Date.parse(dia) - BRT_OFFSET;

// Poeira (18/11/2026): entrada abaixo disto não é taxa de limpeza. Transação de envenenamento de endereço manda 1
// lamport à carteira da taxa e a outra conta, e virava "cliente". A menor fatia real medida foi 2.327 lamports.
export const DUST_LAMPORTS = 1_000;

// Uma limpeza = as transações pagas seguidas do mesmo destino, sem intervalo maior que SESSION_GAP. Cada limpeza
// manda dezenas de transações (mediana de 56 na carteira antiga, medido em 18/11/2026); contar transação como
// limpeza inflava "limpezas", "taxa média", "maior limpeza" e "tamanho das limpezas" em até 200 vezes.
export const SESSION_GAP = 30 * 60_000;
export type Session = { dest: string; t0: number; t1: number; fee: number; n: number; sig: string; w: number };
export function sessionsOf(paid: Array<FeeTx & { dest: string }>): Session[] {
  const open = new Map<string, Session>();
  const out: Session[] = [];
  for (const x of [...paid].sort((a, b) => a.t - b.t)) {
    const s = open.get(x.dest);
    if (s && x.t - s.t1 <= SESSION_GAP) {
      s.t1 = x.t;
      s.fee += x.fee;
      s.n++;
      s.sig = x.sig;
    } else {
      const ns = { dest: x.dest, t0: x.t, t1: x.t, fee: x.fee, n: 1, sig: x.sig, w: x.w ?? 0 };
      open.set(x.dest, ns);
      out.push(ns);
    }
  }
  return out;
}

// Uma transação da carteira da taxa: quando, quanto a carteira recebeu (negativo = saída) e o hash do destino.
// w = qual carteira da taxa (0 = a atual; 1, 2… = as antigas, na ordem de ~/.clurn-admin/carteiras-antigas.txt).
export type FeeTx = { sig: string; t: number; fee: number; dest: string | null; w?: number };

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
  const paid = paidOf(txs);
  const sess = sessionsOf(paid);
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
    porDia.push({ dia, sol: sum(list), limpezas: sess.filter((s) => utcDay(s.t0) === dia).length, novos: [...firstSeen.values()].filter((t) => utcDay(t) === dia).length });
  }
  return {
    receitaTotal: sum(paid),
    receitaHoje: sum(paid.filter((x) => utcDay(x.t) === today)),
    receita7d: sum(paid.filter((x) => x.t >= since(7))),
    receita30d: sum(paid.filter((x) => x.t >= since(30))),
    limpezasTotal: sess.length,
    limpezas7d: sess.filter((s) => s.t0 >= since(7)).length,
    clientesTotal: firstSeen.size,
    clientesNovos7d: [...firstSeen.values()].filter((t) => t >= since(7)).length,
    clientesRecorrentes: [...daysOf.values()].filter((s) => s.size >= 2).length,
    saidas: -txs.filter((x) => x.fee < 0).reduce((a, x) => a + x.fee, 0) / LAMPORTS,
    depositos: txs.filter((x) => x.fee > 0 && (!x.dest || x.fee < DUST_LAMPORTS)).reduce((a, x) => a + x.fee, 0) / LAMPORTS,
    primeira: paid[0]?.t ?? null,
    ultima: paid.at(-1)?.t ?? null,
    porDia,
  };
}

export type ReleaseRow = { versao: string; data: string; downloads: number };
// aberturas: downloads do clurn-versao.json. O app baixa esse arquivo do último Release toda vez que abre, para ver se
// há versão nova (src/app/atualizacao.ts), e o GitHub conta. É a contagem de aberturas sem telemetria no app.
export type ReleaseSummary = { ultima: ReleaseRow | null; porVersao: ReleaseRow[]; total: number; aberturas: number };

// Releases do GitHub (api.github.com/repos/<repo>/releases): downloads do instalador por versão.
export function releaseSummary(json: unknown): ReleaseSummary {
  const rows: ReleaseRow[] = [];
  let aberturas = 0;
  for (const r of Array.isArray(json) ? json : []) {
    const tag = typeof r?.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '';
    if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(tag) || r?.draft === true) continue;
    const assets: unknown[] = Array.isArray(r.assets) ? r.assets : [];
    const downloads = assets.reduce((a: number, x: any) => a + (typeof x?.name === 'string' && /\.exe$/i.test(x.name) && Number.isSafeInteger(x.download_count) && x.download_count >= 0 ? x.download_count : 0), 0);
    aberturas += assets.reduce((a: number, x: any) => a + (x?.name === 'clurn-versao.json' && Number.isSafeInteger(x.download_count) && x.download_count >= 0 ? x.download_count : 0), 0);
    rows.push({ versao: tag, data: typeof r.published_at === 'string' ? r.published_at.slice(0, 10) : '', downloads });
  }
  const byVersion = (a: ReleaseRow, b: ReleaseRow) => {
    const [x, y] = [a.versao, b.versao].map((v) => v.split('.').map(Number));
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  };
  rows.sort(byVersion);
  return { ultima: rows[0] ?? null, porVersao: rows, total: rows.reduce((a, r) => a + r.downloads, 0), aberturas };
}

// O que o /stats do proxy devolve (proxy/worker.ts, statsResponse), conferido campo a campo.
export type ProxyDay = { dia: string; pedidos: number; creditos: number; ips: number; analisaram: number; executaram: number; verificacoes: number; metodos: Record<string, number>; versoes: Record<string, number>; recusas: Record<string, number>; eventos: Record<string, number> };
export type ProxyStats = { hoje: ProxyDay; historico: ProxyDay[]; chaves: Array<{ posicao: number; pausadaAte: number | null }>; limites: { porIpDia: number; tetoHora: number; tetoDia: number }; versaoMinima: string | null };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const counts = (x: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (x && typeof x === 'object' && !Array.isArray(x)) for (const [k, v] of Object.entries(x)) if (/^[A-Za-z0-9.\-]{1,48}$/.test(k)) out[k] = num(v);
  return out;
};
const day = (x: any): ProxyDay | null =>
  typeof x?.dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.dia)
    ? { dia: x.dia, pedidos: num(x.pedidos), creditos: num(x.creditos), ips: num(x.ips), analisaram: num(x.analisaram), executaram: num(x.executaram), verificacoes: num(x.verificacoes), metodos: counts(x.metodos), versoes: counts(x.versoes), recusas: counts(x.recusas), eventos: counts(x.eventos) }
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
export function alerts(a: { now: number; proxy: ProxyStats | null; proxyErro: string | null; health: Health; releases: ReleaseSummary | null; fee: FeeSummary | null; semana?: PeriodSummary | null }): Alert[] {
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
  const w = a.semana;
  if (w?.anterior && w.anterior.receita >= 0.05 && w.receita < 0.5 * w.anterior.receita) {
    warn(`A receita dos últimos 7 dias caiu ${Math.round(100 - (100 * w.receita) / w.anterior.receita)}% em relação aos 7 anteriores.`);
  }
  return out;
}

// ---------- visão de dono (17/11/2026): períodos, série completa, coortes, horários, meta do mês ----------
// Tudo a partir das mesmas transações da carteira da taxa. "Volume recuperado" é estimado pela taxa: a taxa é 11%
// de todo SOL entregue ao destino (o destino recebe 89%), então volume = taxa ÷ 0,11.
export const FEE_SHARE = 0.11;
type Paid = FeeTx & { dest: string };
function paidOf(txs: FeeTx[]): Paid[] {
  return txs.filter((x): x is Paid => x.fee >= DUST_LAMPORTS && typeof x.dest === 'string' && Number.isFinite(x.t)).sort((a, b) => a.t - b.t);
}
const solOf = (list: FeeTx[]) => list.reduce((a, x) => a + x.fee, 0) / LAMPORTS;
const firstSeenOf = (paid: Paid[]) => {
  const m = new Map<string, number>();
  for (const x of paid) if (!m.has(x.dest)) m.set(x.dest, x.t);
  return m;
};

export type DayPoint = { dia: string; receita: number; limpezas: number; transacoes: number; clientes: number; novos: number; retornos: number };

// Um ponto por dia (UTC), do primeiro dia com limpeza paga até hoje, com no mínimo `minDays` dias (zeros onde não houve
// nada). novos = clientes cuja 1ª limpeza foi nesse dia; retornos = clientes do dia que já tinham limpado antes.
export function feeDaily(txs: FeeTx[], now: number, minDays = 90): DayPoint[] {
  const paid = paidOf(txs);
  const first = firstSeenOf(paid);
  const sessByDay = new Map<string, number>();
  for (const s of sessionsOf(paid)) sessByDay.set(utcDay(s.t0), (sessByDay.get(utcDay(s.t0)) ?? 0) + 1);
  const byDay = new Map<string, Paid[]>();
  for (const x of paid) {
    const k = utcDay(x.t);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(x);
  }
  const today = dayStart(utcDay(now));
  const start = Math.min(today - (minDays - 1) * DAY, paid.length ? dayStart(utcDay(paid[0]!.t)) : today);
  const out: DayPoint[] = [];
  for (let t = start; t <= today; t += DAY) {
    const dia = utcDay(t);
    const list = byDay.get(dia) ?? [];
    const clients = new Set(list.map((x) => x.dest));
    let novos = 0;
    for (const c of clients) if (utcDay(first.get(c)!) === dia) novos++;
    out.push({ dia, receita: solOf(list), limpezas: sessByDay.get(dia) ?? 0, transacoes: list.length, clientes: clients.size, novos, retornos: clients.size - novos });
  }
  return out;
}

export type WindowNumbers = { receita: number; volume: number; limpezas: number; transacoes: number; clientes: number; novos: number; retornaram: number; ticket: number };
export type PeriodSummary = WindowNumbers & {
  dias: number | null; // null = desde o início
  anterior: WindowNumbers | null; // a janela do mesmo tamanho logo antes (null em "tudo")
  horas: number[][]; // [dia da semana 0=domingo][hora 0..23], horário de Brasília: limpezas pagas
  tamanhos: Array<{ faixa: string; limpezas: number; receita: number }>; // por volume recuperado na limpeza
  top5: number; // fração da receita que veio dos 5 maiores clientes (0..1)
  maiorLimpeza: number; // maior volume recuperado numa limpeza (SOL)
};

export const SIZE_EDGES = [0.1, 0.5, 1, 5]; // SOL recuperado (volume), não a taxa
const SIZE_LABELS = ['até 0,1 SOL', '0,1 a 0,5', '0,5 a 1', '1 a 5', 'mais de 5'];

function windowNumbers(paid: Paid[], first: Map<string, number>, from: number, to: number, sess: Session[] = sessionsOf(paid)): WindowNumbers {
  const list = paid.filter((x) => x.t >= from && x.t < to);
  const limpezas = sess.filter((s) => s.t0 >= from && s.t0 < to).length;
  const clients = new Set(list.map((x) => x.dest));
  let novos = 0;
  for (const c of clients) if (first.get(c)! >= from) novos++;
  const receita = solOf(list);
  return { receita, volume: receita / FEE_SHARE, limpezas, transacoes: list.length, clientes: clients.size, novos, retornaram: clients.size - novos, ticket: limpezas ? receita / limpezas : 0 };
}

export function periodSummary(txs: FeeTx[], now: number, days: number | null): PeriodSummary {
  const paid = paidOf(txs);
  const first = firstSeenOf(paid);
  const from = days === null ? -Infinity : now - days * DAY;
  const to = now + 1;
  const sess = sessionsOf(paid);
  const cur = windowNumbers(paid, first, from, to, sess);
  const anterior = days === null ? null : windowNumbers(paid, first, now - 2 * days * DAY, from, sess);
  const list = paid.filter((x) => x.t >= from && x.t < to);
  const sessList = sess.filter((s) => s.t0 >= from && s.t0 < to);
  const horas = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const tamanhos = SIZE_LABELS.map((faixa) => ({ faixa, limpezas: 0, receita: 0 }));
  const perClient = new Map<string, number>();
  let maiorLimpeza = 0;
  for (const x of list) perClient.set(x.dest, (perClient.get(x.dest) ?? 0) + x.fee);
  for (const x of sessList) {
    const d = new Date(x.t0 + BRT_OFFSET);
    horas[d.getUTCDay()]![d.getUTCHours()]!++;
    const vol = x.fee / LAMPORTS / FEE_SHARE;
    maiorLimpeza = Math.max(maiorLimpeza, vol);
    // tolerância de ponto flutuante: 0,011 ÷ 0,11 dá 0,0999…, e essa limpeza é de 0,1 SOL (2ª faixa)
    let i = SIZE_EDGES.findIndex((e) => vol < e * (1 - 1e-9));
    if (i < 0) i = SIZE_EDGES.length;
    tamanhos[i]!.limpezas++;
    tamanhos[i]!.receita += x.fee / LAMPORTS;
  }
  const ranked = [...perClient.values()].sort((a, b) => b - a);
  const total = ranked.reduce((a, b) => a + b, 0);
  const top5 = total ? ranked.slice(0, 5).reduce((a, b) => a + b, 0) / total : 0;
  return { ...cur, dias: days, anterior, horas, tamanhos, top5, maiorLimpeza };
}

export type Cohort = { semana: string; tamanho: number; retencao: number[] };
// Coortes semanais (semana começa na segunda, UTC): clientes pela semana da 1ª limpeza e a fração deles que limpou em
// cada semana seguinte. retencao[0] = 1 (a própria semana); só entram as semanas que já começaram.
export function weeklyCohorts(txs: FeeTx[], now: number, weeks = 8): Cohort[] {
  const paid = paidOf(txs);
  const first = firstSeenOf(paid);
  const weekStart = (t: number) => {
    const d = dayStart(utcDay(t));
    return d - ((new Date(d + BRT_OFFSET).getUTCDay() + 6) % 7) * DAY;
  };
  const nowWeek = weekStart(now);
  const active = new Map<string, Set<number>>();
  for (const x of paid) (active.get(x.dest) ?? active.set(x.dest, new Set()).get(x.dest)!).add(weekStart(x.t));
  const out: Cohort[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const w = nowWeek - k * 7 * DAY;
    const members = [...first].filter(([, t]) => weekStart(t) === w).map(([c]) => c);
    if (!members.length) continue;
    const retencao: number[] = [];
    for (let j = 0; w + j * 7 * DAY <= nowWeek; j++) retencao.push(members.filter((c) => active.get(c)!.has(w + j * 7 * DAY)).length / members.length);
    out.push({ semana: utcDay(w), tamanho: members.length, retencao });
  }
  return out;
}

export type MonthPace = { mes: string; receita: number; diasPassados: number; diasNoMes: number; projecao: number; mesAnterior: number };
// Mês corrente (UTC): receita até agora e o ritmo projetado para o mês inteiro (média por dia decorrido × dias do mês).
// Antes de completar 1 dia, a projeção é a própria receita (média de poucas horas engana).
export function monthPace(txs: FeeTx[], now: number): MonthPace {
  const d = new Date(now + BRT_OFFSET);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = Date.UTC(y, m, 1) - BRT_OFFSET;
  const prevStart = Date.UTC(y, m - 1, 1) - BRT_OFFSET;
  const diasNoMes = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const diasPassados = (now - start) / DAY;
  const paid = paidOf(txs);
  const receita = solOf(paid.filter((x) => x.t >= start && x.t <= now));
  return {
    mes: utcDay(start).slice(0, 7),
    receita,
    diasPassados,
    diasNoMes,
    projecao: diasPassados >= 1 ? (receita / diasPassados) * diasNoMes : receita,
    mesAnterior: solOf(paid.filter((x) => x.t >= prevStart && x.t < start)),
  };
}

export type RecentRow = { t: number; taxa: number; volume: number; cliente: string; novo: boolean; sig: string; transacoes: number };
// As últimas limpezas (sessões), a mais recente primeiro. t = a última transação; sig = a assinatura dela.
// Cliente = 6 primeiros caracteres do hash do destino; novo = 1ª limpeza desse destino.
export function recentCleanups(txs: FeeTx[], n = 20): RecentRow[] {
  const sess = sessionsOf(paidOf(txs));
  const seen = new Set<string>();
  const novo = sess.map((s) => !seen.has(s.dest) && !!seen.add(s.dest));
  return sess
    .map((s, i) => ({ t: s.t1, taxa: s.fee / LAMPORTS, volume: s.fee / LAMPORTS / FEE_SHARE, cliente: s.dest.slice(0, 6), novo: novo[i]!, sig: s.sig, transacoes: s.n }))
    .sort((a, b) => b.t - a.t)
    .slice(0, n);
}

export type UsageDay = { dia: string; pessoas: number; pedidos: number; creditos: number; envios: number; clientes: number };
export type UsageSummary = { serie: UsageDay[]; diasComProxy: number; pessoasMedia: number; envios: number; creditos: number; conversao: number | null };
// Uso pelo proxy nos últimos `days` dias (hoje incluído), cruzado com os clientes pagantes do mesmo dia.
// conversao = Σ clientes pagantes por dia ÷ Σ pessoas (IPs distintos) por dia, só nos dias que o proxy registrou.
// Aproximado: IP não é pessoa, e quem usa o RPC público não passa pelo proxy.
export function usageSummary(p: ProxyStats | null, daily: DayPoint[], days: number): UsageSummary {
  const proxyDays = new Map((p ? [p.hoje, ...p.historico] : []).map((d) => [d.dia, d]));
  const clientsByDay = new Map(daily.map((d) => [d.dia, d.clientes]));
  const serie = daily.slice(-days).map(({ dia }) => {
    const x = proxyDays.get(dia);
    return { dia, pessoas: x?.ips ?? 0, pedidos: x?.pedidos ?? 0, creditos: x?.creditos ?? 0, envios: x?.metodos.sendTransaction ?? 0, clientes: clientsByDay.get(dia) ?? 0 };
  });
  const withProxy = serie.filter((s) => proxyDays.has(s.dia));
  const ips = withProxy.reduce((a, s) => a + s.pessoas, 0);
  return {
    serie,
    diasComProxy: withProxy.length,
    pessoasMedia: withProxy.length ? ips / withProxy.length : 0,
    envios: serie.reduce((a, s) => a + s.envios, 0),
    creditos: serie.reduce((a, s) => a + s.creditos, 0),
    conversao: ips ? withProxy.reduce((a, s) => a + s.clientes, 0) / ips : null,
  };
}

// ---------- histórico (17/11/2026): carteiras antigas da taxa, semanas e meses, recordes, falhas ----------
// As carteiras antigas ficam num arquivo do autor fora do repositório (o código é público e a carteira antiga
// saiu dele de propósito, commit d9ec553). Uma por linha: "<endereço> [desde AAAA-MM-DD]"; # comenta.
// Sem data, conta desde o início da beta: o que a carteira fez antes não é do app.
export const BETA_START = Date.UTC(2026, 9, 30);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export type OldWallet = { endereco: string; desde: number };
export function parseWalletList(text: string, current: string): OldWallet[] {
  const out: OldWallet[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [addr, since] = line.split(/\s+/);
    if (!addr || !BASE58.test(addr) || addr === current || out.some((w) => w.endereco === addr)) continue;
    const t = since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? Date.parse(`${since}T00:00:00Z`) : NaN;
    out.push({ endereco: addr, desde: Number.isFinite(t) ? t : BETA_START });
  }
  return out;
}

export type HistoryRow = { inicio: string; fim: string; receita: number; volume: number; limpezas: number; transacoes: number; clientes: number; novos: number; ticket: number; porCarteira: number[]; falhas: number };
// Semanas (segunda a domingo, UTC) ou meses, da 1ª limpeza paga até hoje, o mais recente por último.
// porCarteira[w] = receita de cada carteira da taxa (0 = atual). falhas = transações com erro que tocaram a carteira.
export function historyBuckets(txs: FeeTx[], now: number, unit: 'semana' | 'mes', failed: Array<{ t: number }> = []): HistoryRow[] {
  const paid = paidOf(txs);
  if (!paid.length) return [];
  const first = firstSeenOf(paid);
  const startOf = (t: number) => {
    const d = new Date(Date.parse(utcDay(t)));
    if (unit === 'mes') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - BRT_OFFSET;
    return d.getTime() - BRT_OFFSET - ((d.getUTCDay() + 6) % 7) * DAY;
  };
  const next = (s: number) => {
    if (unit !== 'mes') return s + 7 * DAY;
    const d = new Date(s + BRT_OFFSET);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - BRT_OFFSET;
  };
  const sess = sessionsOf(paid);
  const walletCount = Math.max(1, ...paid.map((x) => (x.w ?? 0) + 1));
  const out: HistoryRow[] = [];
  for (let s = startOf(paid[0]!.t); s <= now; s = next(s)) {
    const e = next(s);
    const list = paid.filter((x) => x.t >= s && x.t < e);
    const clients = new Set(list.map((x) => x.dest));
    let novos = 0;
    for (const c of clients) if (first.get(c)! >= s) novos++;
    const receita = solOf(list);
    const porCarteira = new Array<number>(walletCount).fill(0);
    for (const x of list) porCarteira[x.w ?? 0]! += x.fee / LAMPORTS;
    const limpezas = sess.filter((x) => x.t0 >= s && x.t0 < e).length;
    out.push({ inicio: utcDay(s), fim: utcDay(Math.min(e, now + DAY) - DAY), receita, volume: receita / FEE_SHARE, limpezas, transacoes: list.length, clientes: clients.size, novos, ticket: limpezas ? receita / limpezas : 0, porCarteira, falhas: failed.filter((f) => f.t >= s && f.t < e).length });
  }
  return out;
}

export type Records = {
  primeira: number | null;
  diasComLimpeza: number;
  melhorDia: { dia: string; receita: number; limpezas: number } | null;
  maisLimpezasDia: { dia: string; limpezas: number } | null;
  melhorSemana: { inicio: string; receita: number } | null;
  maiorLimpeza: { t: number; volume: number } | null;
  receitaTotal: number;
  volumeTotal: number;
  limpezasTotal: number;
  clientesTotal: number;
  sucesso: number | null; // limpezas ÷ (limpezas + transações com erro), desde o início
};
export function records(txs: FeeTx[], now: number, failed: Array<{ t: number }> = []): Records {
  const paid = paidOf(txs);
  const daily = feeDaily(txs, now, 1).filter((d) => d.limpezas > 0);
  const weeks = historyBuckets(txs, now, 'semana');
  const best = <T,>(list: T[], key: (x: T) => number) => list.reduce<T | null>((b, x) => (b === null || key(x) > key(b) ? x : b), null);
  const bd = best(daily, (d) => d.receita);
  const ld = best(daily, (d) => d.limpezas);
  const bw = best(weeks, (w) => w.receita);
  const sess = sessionsOf(paid);
  const big = best(sess, (x) => x.fee);
  const receitaTotal = solOf(paid);
  return {
    primeira: paid[0]?.t ?? null,
    diasComLimpeza: daily.length,
    melhorDia: bd ? { dia: bd.dia, receita: bd.receita, limpezas: bd.limpezas } : null,
    maisLimpezasDia: ld ? { dia: ld.dia, limpezas: ld.limpezas } : null,
    melhorSemana: bw ? { inicio: bw.inicio, receita: bw.receita } : null,
    maiorLimpeza: big ? { t: big.t0, volume: big.fee / LAMPORTS / FEE_SHARE } : null,
    receitaTotal,
    volumeTotal: receitaTotal / FEE_SHARE,
    limpezasTotal: sess.length,
    clientesTotal: firstSeenOf(paid).size,
    sucesso: paid.length + failed.length ? paid.length / (paid.length + failed.length) : null, // por transação
  };
}

// Transações com erro por dia (para a série de desempenho), alinhadas aos dias de `daily`.
export function failuresByDay(failed: Array<{ t: number }>, daily: DayPoint[]): number[] {
  const m = new Map<string, number>();
  for (const f of failed) if (Number.isFinite(f.t)) m.set(utcDay(f.t), (m.get(utcDay(f.t)) ?? 0) + 1);
  return daily.map((d) => m.get(d.dia) ?? 0);
}

// Atividade a partir só da lista de assinaturas (sem baixar cada transação): toda transação que tocou a carteira da
// taxa, com ou sem erro. Inclui o que ainda não foi lido e também poeira mandada por terceiros (pouca perto do uso).
export type Seen = { t: number; ok: boolean; w?: number };
export function activityByDay(seen: Seen[], daily: DayPoint[]): { ok: number[]; erro: number[] } {
  const ok = new Map<string, number>();
  const erro = new Map<string, number>();
  for (const s of seen) {
    if (!Number.isFinite(s.t)) continue;
    const m = s.ok ? ok : erro;
    m.set(utcDay(s.t), (m.get(utcDay(s.t)) ?? 0) + 1);
  }
  return { ok: daily.map((d) => ok.get(d.dia) ?? 0), erro: daily.map((d) => erro.get(d.dia) ?? 0) };
}
export type ActivityTotals = { total: number; ok: number; erro: number; sucesso: number | null; porCarteira: Array<{ total: number; ok: number }> };
export function activityTotals(seen: Seen[]): ActivityTotals {
  const valid = seen.filter((s) => Number.isFinite(s.t));
  const ok = valid.filter((s) => s.ok).length;
  const porCarteira: Array<{ total: number; ok: number }> = [];
  for (const s of valid) {
    const w = s.w ?? 0;
    porCarteira[w] ??= { total: 0, ok: 0 };
    porCarteira[w]!.total++;
    if (s.ok) porCarteira[w]!.ok++;
  }
  for (let i = 0; i < porCarteira.length; i++) porCarteira[i] ??= { total: 0, ok: 0 };
  return { total: valid.length, ok, erro: valid.length - ok, sucesso: valid.length ? ok / valid.length : null, porCarteira };
}

export type Price = { usd: number; brl: number };
// Preço do SOL (api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,brl). Fora de faixa = sem preço.
export function parsePrice(json: unknown): Price | null {
  const s = (json as any)?.solana;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0.01 && v < 1e6;
  return ok(s?.usd) && ok(s?.brl) ? { usd: s.usd, brl: s.brl } : null;
}

// ---------- funil (18/11/2026): onde as pessoas param entre baixar e pagar ----------
// baixaram e abriram vêm do GitHub e valem desde a publicação (o GitHub não dá por dia). As etapas do proxy são
// pessoas-dia: IPs distintos de cada dia, somados no período (quem volta em outro dia conta de novo). pagaram =
// destinos distintos que pagaram taxa no período. Quem usa o RPC público não passa pelo proxy e não aparece.
export type Funnel = { verificaram: number | null; baixaram: number | null; abriram: number | null; noApp: number | null; analisaram: number | null; executaram: number | null; pagaram: number | null; diasProxy: number };
export function funnel(p: ProxyStats | null, releases: ReleaseSummary | null, pagaram: number | null, now: number, days: number | null): Funnel {
  const from = days === null ? '' : new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
  const list = p ? [p.hoje, ...p.historico].filter((d) => d.dia >= from) : [];
  const sum = (k: 'ips' | 'analisaram' | 'executaram' | 'verificacoes') => (p ? list.reduce((a, d) => a + d[k], 0) : null);
  return { verificaram: sum('verificacoes'), baixaram: releases ? releases.total : null, abriram: releases ? releases.aberturas : null, noApp: sum('ips'), analisaram: sum('analisaram'), executaram: sum('executaram'), pagaram, diasProxy: list.length };
}
