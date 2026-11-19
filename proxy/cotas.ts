// Cotas do proxy (Durable Object "Cotas", uma instância só, chamada "global").
//
// Por que um Durable Object e não o Rate Limiting binding ou o KV (comparação no proxy/README.md):
//   - o Rate Limiting binding só conta janelas de 10 ou 60 s e é aproximado, por local da Cloudflare: não faz o
//     "por dia" nem o teto global, que é o que protege a fatura;
//   - o KV grátis aceita 1.000 escritas por dia: não dá para contar requisição por requisição;
//   - o Durable Object é um contador só, exato e com armazenamento, e entra no plano grátis (com SQLite).
//
// Os contadores vivem na memória do objeto e vão para o armazenamento no máximo a cada FLUSH_MS (alarme): poucas
// escritas e quase nada perdido se o objeto reiniciar (no pior caso, os últimos FLUSH_MS de contagem do dia).
// Guarda só a chave do cliente (IP, ou o prefixo /48 no IPv6) e números. Nada do pedido.
//
// Quatro limites (revisão de segurança de 09/11/2026: com a cota por IP grande, 5 IPs gastavam o dia de todos):
//   - por IP por segundo (rajada de um cliente);
//   - por IP por dia, bem abaixo do teto (são precisos ~25 IPs para gastar o dia);
//   - teto global por HORA (TETO_DIA/8): uma rajada de muitos IPs leva no máximo 1/8 do dia, não o dia inteiro;
//   - teto global por dia (a fatura).

export type ConsumeRequest = {
  key: string; // clientKey(ip)
  requests: number; // itens do pedido (lote conta cada um)
  credits: number; // créditos estimados do Helius
  now: number; // ms (relógio do Worker)
  perSecond: number;
  perIpDay: number;
  globalHour: number;
  globalDay: number;
  // para as estatísticas do painel (16/11/2026): quantos itens de cada método e a versão do app. Opcionais: pedido
  // sem eles conta só no total.
  methods?: Record<string, number>;
  version?: string;
};
export type RefusalReason = 'segundo' | 'dia-ip' | 'teto' | 'teto-hora';
// Verificador do site (19/11/2026, proxy/verificar.ts): uma verificação = CHECK_CREDITS consultas fixas. Limite por IP
// e teto do dia próprios, e os créditos entram no total do dia (o teto global protege as chaves do app também).
export type CheckRequest = { key: string; credits: number; now: number; perIpDay: number; globalDay: number; appGlobalDay: number; appGlobalHour: number };
export type CheckResult = { ok: true; paused?: string[] } | { ok: false; reason: 'verif-ip' | 'verif-teto' | 'teto' | 'teto-hora' };
// paused: chaves do upstream (upstreamId de worker.ts) sem crédito agora; o worker pula essas no rodízio
export type ConsumeResult = { ok: true; paused?: string[] } | { ok: false; reason: RefusalReason };
export type PauseRequest = { id: string; until: number };

// Quantas chaves pausadas o contador guarda no máximo (o proxy tem poucas; o limite só impede pedido falso de
// encher a memória).
export const MAX_PAUSED = 32;
const PAUSE_PREFIX = 'pausa:';

export const FLUSH_MS = 2_000;

// ---------- estatísticas do painel (16/11/2026) ----------
// Só números por dia UTC: pedidos, créditos, quantos IPs distintos (o tamanho do mapa que as cotas já guardam; o IP
// em si nunca sai daqui), itens por método (sendTransaction = transações enviadas), versões do app, recusas por
// motivo e eventos raros do upstream. Nada do pedido (endereço, transação) entra. Lidas pelo GET /stats do worker,
// protegido por token.
export const EVENTS = ['upstream-fora', 'upstream-lento', 'sem-chave', 'chave-pausada'] as const;
export type EventKind = (typeof EVENTS)[number];
export type DayStats = {
  dia: string;
  pedidos: number;
  creditos: number;
  ips: number;
  metodos: Record<string, number>;
  versoes: Record<string, number>;
  recusas: Record<RefusalReason, number> & Partial<Record<'verif-ip' | 'verif-teto', number>>;
  eventos: Record<string, number>;
  // funil (18/11/2026): quantos IPs distintos do dia chegaram a cada etapa. Só o número, como `ips`.
  analisaram: number; // pediram contas de token (a varredura de uma frase)
  executaram: number; // mandaram ao menos uma transação
  verificacoes: number; // verificações feitas no site (19/11/2026)
};

// Etapas do funil, pelo método pedido. Uma frase analisada sempre pede as contas de token das carteiras; uma limpeza
// executada sempre manda transação. Abrir o app (conferência da rede) não pede nenhum dos dois.
export const STAGE_SCAN = 1;
export const STAGE_SEND = 2;
const SCAN_METHODS = new Set(['getTokenAccountsByOwner', 'getProgramAccounts']);
export function stageOf(methods: Record<string, number> | undefined): number {
  let st = 0;
  for (const [m, n] of Object.entries(methods ?? {})) {
    if (!(typeof n === 'number' && n > 0)) continue;
    if (SCAN_METHODS.has(m)) st |= STAGE_SCAN;
    if (m === 'sendTransaction') st |= STAGE_SEND;
  }
  return st;
}
const STAGE_PREFIX = 'st:';
const CHECK_PREFIX = 'vf:';
export const HISTORY_DAYS = 90;
// limites contra pedido falso enchendo a memória (o worker já filtra; o objeto confere de novo)
export const MAX_METHODS = 32;
export const MAX_VERSIONS = 64;
const METHOD_NAME = /^[A-Za-z]{1,48}$/;
const VERSION_NAME = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const STATS_KEY = 'stats';
const HIST_PREFIX = 'hist:';

export const emptyStats = (dia: string): DayStats => ({ dia, pedidos: 0, creditos: 0, ips: 0, metodos: {}, versoes: {}, recusas: { segundo: 0, 'dia-ip': 0, teto: 0, 'teto-hora': 0 }, eventos: {}, analisaram: 0, executaram: 0, verificacoes: 0 });

// Soma num mapa limitado: nome novo além do limite vai para "outro" (não cresce sem fim).
function bump(map: Record<string, number>, name: string, n: number, max: number): void {
  const k = Object.hasOwn(map, name) || Object.keys(map).length < max ? name : 'outro';
  map[k] = (map[k] ?? 0) + n;
}

const isCountValue = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const countMap = (x: unknown, name: RegExp): Record<string, number> => {
  const out: Record<string, number> = {};
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return out;
  for (const [k, v] of Object.entries(x)) if ((name.test(k) || k === 'outro') && isCountValue(v)) out[k] = v;
  return out;
};
// Lê um DayStats gravado; fora do formato: null (ignorado sem derrubar o resto).
export function parseStats(x: unknown): DayStats | null {
  const o = x as Partial<DayStats> | null;
  if (typeof o !== 'object' || o === null || typeof o.dia !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.dia)) return null;
  const s = emptyStats(o.dia);
  for (const k of ['pedidos', 'creditos', 'ips', 'analisaram', 'executaram', 'verificacoes'] as const) if (isCountValue(o[k])) s[k] = o[k];
  s.metodos = countMap(o.metodos, METHOD_NAME);
  s.versoes = countMap(o.versoes, VERSION_NAME);
  const r = countMap(o.recusas, /^(segundo|dia-ip|teto|teto-hora|verif-ip|verif-teto)$/);
  s.recusas = { ...s.recusas, ...r };
  s.eventos = countMap(o.eventos, /^[a-z-]{1,32}$/);
  return s;
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcHour = (ms: number): number => Math.floor(ms / 3_600_000);

// Quem é o cliente para as cotas: o IP que a Cloudflare põe em cf-connecting-ip (o usuário não consegue trocar).
// IPv6: o prefixo /48. Um provedor entrega a uma casa de /64 a /48 (RFC 6177), e com /64 quem recebe um /48 teria
// 65 mil cotas só trocando o 4º bloco do endereço.
export function clientKey(ip: string | null | undefined): string {
  const s = ip?.trim() ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s;
  const mapped = /^::ffff:(\d{1,3}(\.\d{1,3}){3})$/i.exec(s); // IPv4 escrito como IPv6
  if (mapped) return mapped[1]!;
  if (s.includes(':') && /^[0-9a-f:.]+$/i.test(s) && s.length <= 45) {
    const [head, tail = ''] = s.toLowerCase().split('::');
    const h = head ? head.split(':') : [];
    const t = s.includes('::') ? (tail ? tail.split(':') : []) : [];
    const groups = s.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
    return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':') + '::/48';
  }
  return 'sem-ip';
}

// O contador puro (sem armazenamento), testado sozinho.
export class Counter {
  day = '';
  total = 0;
  hour = -1; // hora UTC (ms / 3.600.000) do contador da hora
  hourTotal = 0;
  perIp = new Map<string, number>();
  stage = new Map<string, number>(); // etapas do funil por IP, no dia (STAGE_SCAN | STAGE_SEND)
  checks = new Map<string, number>(); // verificações do site por IP, no dia
  seconds = new Map<string, { sec: number; n: number }>();
  dirty = new Set<string>(); // chaves do armazenamento a gravar no próximo flush

  restore(day: string, total: number, perIp: Map<string, number>, hour = -1, hourTotal = 0, stage = new Map<string, number>(), checks = new Map<string, number>()) {
    this.day = day;
    this.stage = stage;
    this.checks = checks;
    this.total = total;
    this.perIp = perIp;
    this.hour = hour;
    this.hourTotal = hourTotal;
  }

  consume(r: ConsumeRequest): ConsumeResult {
    const day = utcDay(r.now);
    this.rollStats(day); // antes de zerar o mapa dos IPs: o dia que fecha leva quantos IPs teve
    if (day !== this.day) {
      this.day = day;
      this.total = 0;
      this.perIp = new Map();
      this.stage = new Map();
      this.checks = new Map();
      this.dirty = new Set(['stats']);
    }
    const hour = utcHour(r.now);
    if (hour !== this.hour) {
      this.hour = hour;
      this.hourTotal = 0;
    }
    const sec = Math.floor(r.now / 1000);
    const w = this.seconds.get(r.key);
    const inWindow = w && w.sec === sec ? w.n : 0;
    if (inWindow + r.requests > r.perSecond) return this.refuse('segundo');
    const used = this.perIp.get(r.key) ?? 0;
    if (used + r.credits > r.perIpDay) return this.refuse('dia-ip');
    if (this.total + r.credits > r.globalDay) return this.refuse('teto');
    if (this.hourTotal + r.credits > r.globalHour) return this.refuse('teto-hora');
    this.seconds.set(r.key, { sec, n: inWindow + r.requests });
    if (this.seconds.size > 5_000) for (const [k, v] of this.seconds) if (v.sec < sec) this.seconds.delete(k);
    this.perIp.set(r.key, used + r.credits);
    this.total += r.credits;
    this.hourTotal += r.credits;
    for (const k of ['total', 'hora', 'total-hora', `ip:${r.key}`]) this.dirty.add(k);
    this.countServed(r);
    const paused = this.pausedAt(r.now);
    return paused.length ? { ok: true, paused } : { ok: true };
  }

  // Uma verificação do site. O dia vira junto com o resto (mesmo relógio, mesmo armazenamento).
  consumeCheck(r: CheckRequest): CheckResult {
    const day = utcDay(r.now);
    this.rollStats(day);
    if (day !== this.day) {
      this.day = day;
      this.total = 0;
      this.perIp = new Map();
      this.stage = new Map();
      this.checks = new Map();
      this.dirty = new Set(['stats']);
    }
    // o teto por hora vale para a verificação como para o app (revisão de segurança de 19/11/2026: sem isso, uma
    // rajada de verificações gastava créditos fora do limite por hora)
    const hour = utcHour(r.now);
    if (hour !== this.hour) {
      this.hour = hour;
      this.hourTotal = 0;
    }
    const used = this.checks.get(r.key) ?? 0;
    const refuse = (reason: 'verif-ip' | 'verif-teto' | 'teto' | 'teto-hora'): CheckResult => {
      this.stats.recusas[reason] = (this.stats.recusas[reason] ?? 0) + 1;
      this.dirty.add(STATS_KEY);
      return { ok: false, reason };
    };
    if (used + 1 > r.perIpDay) return refuse('verif-ip');
    if (this.stats.verificacoes + 1 > r.globalDay) return refuse('verif-teto');
    if (this.total + r.credits > r.appGlobalDay) return refuse('teto');
    if (this.hourTotal + r.credits > r.appGlobalHour) return refuse('teto-hora');
    this.checks.set(r.key, used + 1);
    this.total += r.credits;
    this.hourTotal += r.credits;
    this.stats.verificacoes++;
    this.stats.creditos += r.credits;
    for (const k of ['total', 'hora', 'total-hora', CHECK_PREFIX + r.key, STATS_KEY]) this.dirty.add(k);
    const paused = this.pausedAt(r.now);
    return paused.length ? { ok: true, paused } : { ok: true };
  }

  // ---------- estatísticas ----------
  stats: DayStats = emptyStats('');
  history = new Map<string, DayStats>(); // dias fechados, no máximo HISTORY_DAYS

  restoreStats(stats: DayStats | null, history: DayStats[]) {
    if (stats) this.stats = stats;
    for (const h of history) this.history.set(h.dia, h);
  }

  // Dia novo: o de antes vai para o histórico (com quantos IPs distintos teve) e começa um vazio.
  rollStats(day: string): void {
    if (this.stats.dia === day) return;
    if (this.stats.dia) {
      const closed = this.stats.dia === this.day ? { ...this.stats, ...this.funnel() } : this.stats;
      this.history.set(closed.dia, closed);
      this.dirty.add(HIST_PREFIX + closed.dia);
      const days = [...this.history.keys()].sort();
      for (const d of days.slice(0, Math.max(0, days.length - HISTORY_DAYS))) this.history.delete(d);
    }
    this.stats = emptyStats(day);
    this.dirty.add(STATS_KEY);
  }

  // IPs distintos do dia em cada etapa (o IP em si nunca sai daqui)
  funnel(): { ips: number; analisaram: number; executaram: number } {
    let analisaram = 0;
    let executaram = 0;
    for (const st of this.stage.values()) {
      if (st & STAGE_SCAN) analisaram++;
      if (st & STAGE_SEND) executaram++;
    }
    return { ips: this.perIp.size, analisaram, executaram };
  }

  private refuse(reason: RefusalReason): ConsumeResult {
    this.stats.recusas[reason]++;
    this.dirty.add(STATS_KEY);
    return { ok: false, reason };
  }

  private countServed(r: ConsumeRequest): void {
    const s = this.stats;
    s.pedidos += r.requests;
    s.creditos += r.credits;
    for (const [m, n] of Object.entries(r.methods ?? {})) if (METHOD_NAME.test(m) && isCountValue(n)) bump(s.metodos, m, n, MAX_METHODS);
    if (r.version && VERSION_NAME.test(r.version)) bump(s.versoes, r.version, r.requests, MAX_VERSIONS);
    const st = stageOf(r.methods);
    const had = this.stage.get(r.key) ?? 0;
    if ((had | st) !== had) {
      this.stage.set(r.key, had | st);
      this.dirty.add(STAGE_PREFIX + r.key);
    }
    this.dirty.add(STATS_KEY);
  }

  // Evento raro do upstream (fora do ar, lento, chave pausada, todas sem crédito).
  event(kind: EventKind, now: number): void {
    this.rollStats(utcDay(now));
    this.stats.eventos[kind] = (this.stats.eventos[kind] ?? 0) + 1;
    this.dirty.add(STATS_KEY);
  }

  // O que o painel lê: hoje (com os IPs distintos até agora), os dias fechados (mais recente primeiro) e as chaves
  // pausadas (só o id curto, que não revela a chave).
  view(now: number): { hoje: DayStats; historico: DayStats[]; pausadas: Array<{ id: string; ate: number }> } {
    this.rollStats(utcDay(now));
    const hoje = this.stats.dia === this.day ? { ...this.stats, ...this.funnel() } : { ...this.stats, ips: 0, analisaram: 0, executaram: 0 };
    const historico = [...this.history.values()].sort((a, b) => (a.dia < b.dia ? 1 : -1));
    this.pausedAt(now);
    return { hoje, historico, pausadas: [...this.paused].map(([id, ate]) => ({ id, ate })) };
  }

  // Chaves do upstream sem crédito: id → até quando (ms). Não zera na virada do dia (a pausa tem hora própria).
  paused = new Map<string, number>();

  pause(id: string, until: number): void {
    if (!this.paused.has(id) && this.paused.size >= MAX_PAUSED) return;
    this.paused.set(id, until);
  }

  // As pausadas agora; as vencidas saem (a chave volta ao rodízio e um pedido de verdade a testa).
  pausedAt(now: number): string[] {
    for (const [id, until] of this.paused) if (until <= now) this.paused.delete(id);
    return [...this.paused.keys()];
  }

  // O que gravar agora (e limpa a lista).
  takeDirty(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of this.dirty) {
      if (k === STATS_KEY) out[k] = this.stats;
      else if (k.startsWith(HIST_PREFIX)) {
        const h = this.history.get(k.slice(HIST_PREFIX.length));
        if (h) out[k] = h;
      } else if (k.startsWith(STAGE_PREFIX)) out[k] = this.stage.get(k.slice(STAGE_PREFIX.length)) ?? 0;
      else if (k.startsWith(CHECK_PREFIX)) out[k] = this.checks.get(k.slice(CHECK_PREFIX.length)) ?? 0;
      else out[k] = k === 'total' ? this.total : k === 'hora' ? this.hour : k === 'total-hora' ? this.hourTotal : (this.perIp.get(k.slice(3)) ?? 0);
    }
    this.dirty = new Set();
    return out;
  }
}

// O pedaço do armazenamento de Durable Object que o contador usa (igual ao do Workers; nos testes, um falso).
export type CotasStorage = {
  get(key: string): Promise<unknown>;
  list(): Promise<Map<string, unknown>>;
  put(entries: Record<string, unknown>): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
};
export type CotasState = { storage: CotasStorage };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

const validRequest = (x: unknown): x is ConsumeRequest => {
  const r = x as ConsumeRequest;
  return (
    typeof r?.key === 'string' && r.key.length <= 64 &&
    [r.requests, r.credits, r.now, r.perSecond, r.perIpDay, r.globalHour, r.globalDay].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
  );
};

export class Cotas {
  readonly storage: CotasStorage;
  readonly counter = new Counter();
  private loaded: Promise<void> | null = null;
  private storedDay = '';
  private alarmSet = false;

  constructor(state: CotasState, _env?: unknown) {
    this.storage = state.storage;
  }

  // Lê o que foi gravado (uma vez por vida do objeto). Dado fora do formato é ignorado, sem derrubar o resto.
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      const all = await this.storage.list();
      for (const [k, v] of all) if (k.startsWith(PAUSE_PREFIX) && isCount(v)) this.counter.pause(k.slice(PAUSE_PREFIX.length), v);
      const history: DayStats[] = [];
      for (const [k, v] of all) {
        if (!k.startsWith(HIST_PREFIX)) continue;
        const h = parseStats(v);
        if (h && h.dia === k.slice(HIST_PREFIX.length)) history.push(h);
      }
      this.counter.restoreStats(parseStats(all.get(STATS_KEY)), history);
      const day = all.get('dia');
      if (typeof day !== 'string') return;
      this.storedDay = day;
      const perIp = new Map<string, number>();
      for (const [k, v] of all) if (k.startsWith('ip:') && isCount(v)) perIp.set(k.slice(3), v);
      const stage = new Map<string, number>();
      for (const [k, v] of all) if (k.startsWith(STAGE_PREFIX) && isCount(v) && v <= (STAGE_SCAN | STAGE_SEND)) stage.set(k.slice(STAGE_PREFIX.length), v);
      const checks = new Map<string, number>();
      for (const [k, v] of all) if (k.startsWith(CHECK_PREFIX) && isCount(v)) checks.set(k.slice(CHECK_PREFIX.length), v);
      const total = all.get('total');
      const hour = all.get('hora');
      const hourTotal = all.get('total-hora');
      const hourOk = isCount(hour) && isCount(hourTotal);
      this.counter.restore(day, isCount(total) ? total : 0, perIp, hourOk ? hour : -1, hourOk ? hourTotal : 0, stage, checks);
    })();
    return this.loaded;
  }

  private async scheduleFlush(now: number): Promise<void> {
    if (this.alarmSet) return;
    this.alarmSet = true;
    await this.storage.setAlarm(now + FLUSH_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    // estatísticas para o GET /stats do worker (o token é conferido lá; o objeto só é alcançável pelo worker)
    if (pathname === '/stats') {
      const now = Number(new URL(request.url).searchParams.get('agora'));
      if (!isCount(now)) return new Response('{}', { status: 400 });
      await this.load();
      return Response.json(this.counter.view(now));
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response('{}', { status: 400 });
    }
    if (pathname === '/evento') {
      const e = body as { kind?: unknown; now?: unknown };
      if (!EVENTS.includes(e?.kind as EventKind) || !isCount(e.now)) return new Response('{}', { status: 400 });
      await this.load();
      this.counter.event(e.kind as EventKind, e.now);
      await this.scheduleFlush(e.now);
      return Response.json({ ok: true });
    }
    if (pathname === '/pausar') {
      const p = body as PauseRequest;
      if (typeof p?.id !== 'string' || !/^[0-9a-f]{16}$/.test(p.id) || !isCount(p.until)) return new Response('{}', { status: 400 });
      await this.load();
      this.counter.pause(p.id, p.until);
      // grava na hora (é raro): o objeto reiniciado continua pulando a chave sem crédito
      await this.storage.put({ [PAUSE_PREFIX + p.id]: p.until });
      return Response.json({ ok: true });
    }
    if (pathname === '/verificar') {
      const c = body as CheckRequest;
      const ok = typeof c?.key === 'string' && c.key.length <= 64 && [c.credits, c.now, c.perIpDay, c.globalDay, c.appGlobalDay, c.appGlobalHour].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
      if (!ok) return new Response('{}', { status: 400 });
      await this.load();
      const result = this.counter.consumeCheck(c);
      await this.scheduleFlush(c.now);
      return Response.json(result);
    }
    if (!validRequest(body)) return new Response('{}', { status: 400 });
    await this.load();
    const result = this.counter.consume(body);
    // a recusa também grava (as estatísticas contam recusas), no mesmo ritmo de no máximo um alarme a cada FLUSH_MS
    await this.scheduleFlush(body.now);
    return Response.json(result);
  }

  // Grava os contadores mudados. Dia novo: apaga o dia anterior inteiro antes.
  async alarm(): Promise<void> {
    this.alarmSet = false;
    await this.load();
    const entries = this.counter.takeDirty();
    if (this.counter.day !== this.storedDay) {
      await this.storage.deleteAll();
      this.storedDay = this.counter.day;
      Object.assign(entries, { total: this.counter.total, hora: this.counter.hour, 'total-hora': this.counter.hourTotal });
      // o deleteAll levou as pausas junto: as que ainda valem voltam ao armazenamento
      for (const [id, until] of this.counter.paused) entries[PAUSE_PREFIX + id] = until;
      // e as estatísticas também: o dia de hoje e o histórico (só os IPs do dia anterior precisavam sumir)
      entries[STATS_KEY] = this.counter.stats;
      for (const [d, h] of this.counter.history) entries[HIST_PREFIX + d] = h;
    }
    const all: Record<string, unknown> = { dia: this.counter.day, ...entries };
    // put aceita até 128 chaves por chamada
    const list = Object.entries(all);
    for (let i = 0; i < list.length; i += 128) await this.storage.put(Object.fromEntries(list.slice(i, i + 128)));
  }
}
