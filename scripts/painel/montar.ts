// Monta o que a página do painel mostra, a partir do que veio da rede. Função pura, sem import do Node: o painel local
// (scripts/painel-admin.ts) roda no servidor, e o painel privado (admin/) roda no navegador, com o mesmo código.
import {
  activityByDay,
  activityTotals,
  alerts,
  BETA_START,
  failuresByDay,
  feeDaily,
  feeSummary,
  historyBuckets,
  LAMPORTS,
  monthPace,
  periodSummary,
  recentCleanups,
  records,
  usageSummary,
  versionShare,
  weeklyCohorts,
  type FeeTx,
  type Health,
  type Price,
  type ProxyStats,
  type ReleaseSummary,
} from './metricas.ts';

export const PERIODS = [7, 30, 90, null] as const; // null = desde o início
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

// Monta o que a página mostra. Função pura sobre o que veio da rede (ou do modo demonstração).
export function buildData(src: {
  now: number;
  versaoPainel: string;
  carteiraTaxa: string; // a carteira atual da taxa (a de src/core/limpeza/app-fee.ts)
  txs: FeeTx[] | null;
  failed?: Array<{ t: number; w?: number }>;
  seen?: Array<{ t: number; ok: boolean; w?: number }>; // toda assinatura (da lista), com ou sem erro
  faltam?: number[]; // por carteira: transações listadas e ainda não lidas
  carteiras?: Array<{ endereco: string; desde: number; saldo: number | null }>;
  avisosCarteiras?: string[];
  taxaErro: string | null;
  proxy: ProxyStats | null;
  proxyErro: string | null;
  releases: ReleaseSummary | null;
  saude: Health & { proxyMs: number | null };
  preco: Price | null;
  saldo: number | null;
  demo: boolean;
}) {
  const { now, txs } = src;
  const failed = src.failed ?? [];
  const seen = src.seen ?? [];
  const act = activityTotals(seen);
  const fee = txs ? feeSummary(txs, now) : null;
  const serie = txs ? feeDaily(txs, now) : [];
  const periodos = txs ? Object.fromEntries(PERIODS.map((d) => [d === null ? 'tudo' : String(d), periodSummary(txs, now, d)])) : null;
  const uso = Object.fromEntries(PERIODS.map((d) => [d === null ? 'tudo' : String(d), usageSummary(src.proxy, serie, d ?? serie.length)]));
  // por carteira da taxa: receita, limpezas, primeira e última limpeza (a atual primeiro)
  const carteiras = (src.carteiras ?? [{ endereco: src.carteiraTaxa, desde: BETA_START, saldo: src.saldo }]).map((c, w) => {
    const mine = (txs ?? []).filter((x) => (x.w ?? 0) === w && x.fee > 0 && x.dest);
    const ts = mine.map((x) => x.t);
    return {
      rotulo: w === 0 ? 'Carteira atual' : src.carteiras!.length > 2 ? `Carteira antiga ${w}` : 'Carteira antiga',
      curto: short(c.endereco),
      saldo: c.saldo,
      receita: mine.reduce((a, x) => a + x.fee, 0) / LAMPORTS,
      limpezas: mine.length,
      transacoes: act.porCarteira[w] ?? { total: 0, ok: 0 },
      faltamLer: src.faltam?.[w] ?? 0,
      primeira: ts.length ? Math.min(...ts) : null,
      ultima: ts.length ? Math.max(...ts) : null,
    };
  });
  return {
    agora: now,
    demo: src.demo,
    versaoPainel: src.versaoPainel,
    carteiraTaxa: src.carteiraTaxa,
    taxa: fee,
    taxaErro: src.taxaErro,
    avisosCarteiras: src.avisosCarteiras ?? [],
    serie,
    falhasDia: failuresByDay(failed, serie),
    atividade: activityByDay(seen, serie),
    transacoes: act,
    periodos,
    historico: txs ? { semana: historyBuckets(txs, now, 'semana', failed), mes: historyBuckets(txs, now, 'mes', failed) } : null,
    recordes: txs ? records(txs, now, failed) : null,
    carteiras,
    coortes: txs ? weeklyCohorts(txs, now) : [],
    mes: txs ? monthPace(txs, now) : null,
    recentes: txs ? recentCleanups(txs, 30) : [],
    uso,
    preco: src.preco,
    saldo: src.saldo,
    proxy: src.proxy,
    proxyErro: src.proxyErro,
    versoes: src.proxy ? versionShare(src.proxy) : [],
    releases: src.releases,
    saude: src.saude,
    alertas: alerts({ now, proxy: src.proxy, proxyErro: src.proxyErro, health: src.saude, releases: src.releases, fee, semana: periodos?.['7'] ?? null }),
  };
}
