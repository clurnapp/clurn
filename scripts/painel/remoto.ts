// Painel privado (admin.clurn.app), no navegador: transforma o pacote BRUTO do Worker (admin/worker.ts) no mesmo
// objeto que o painel local monta no servidor, com as mesmas contas (montar.ts). Sem import do Node.
// Dado de fora pode vir quebrado: cada parte fora do formato vira "sem dados", nunca derruba a página.
import { decodeSeen, decodeTxs } from './compacto.ts';
import { buildData } from './montar.ts';
import { LAMPORTS, parsePrice, parseProxyStats, releaseSummary, type FeeTx, type Price, type Seen } from './metricas.ts';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// SOL em dólar (Jupiter) × dólar em real (Frankfurter). Qualquer parte fora do formato: sem preço, nunca um chute.
export function priceFrom(jup: unknown, fx: unknown): Price | null {
  const usd = (jup as any)?.[SOL_MINT]?.usdPrice;
  const rate = (fx as any)?.rates?.BRL;
  if (typeof usd !== 'number' || typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 100) return null;
  return parsePrice({ solana: { usd, brl: usd * rate } });
}

// Créditos do Helius (admin/worker.ts, heliusCredits): uma linha por chave e as contas de quanto ainda dá para limpar.
// - Carteiras: créditos restantes das chaves do APP (a do painel não serve ao app) ÷ custo por carteira do fluxo completo
//   (RUN_COSTS.fullCreditsPerWallet, src/app/eta.ts), mais a descoberta de cada frase de 100 (RUN_COSTS.discoveryReqPerFrase).
// - Transações: a proporção da primeira limpeza real, 83 transações para 92 carteiras (docs/aprendizados.md, 30/10/2026).
// É estimativa: frase com muita moeda ou fee gasta mais; o número oficial de cada chave é o do Helius.
export const TX_PER_WALLET = 83 / 92;
export type HeliusRow = { nome: string; app: boolean; ok: boolean; restantes: number | null; limite: number | null; usados: number | null; renovaEm: string | null; motivo: string | null };
export function heliusSummary(list: unknown, custo: unknown) {
  const rows: HeliusRow[] = [];
  for (const r of Array.isArray(list) ? list.slice(0, 10) : []) {
    if (!r || typeof r.nome !== 'string') continue;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
    const ok = r.status === 'ok' && n(r.restantes) !== null;
    rows.push({
      nome: r.nome.slice(0, 30),
      app: r.app === true,
      ok,
      restantes: ok ? n(r.restantes) : null,
      limite: ok ? n(r.limite) : null,
      usados: ok ? n(r.usados) : null,
      renovaEm: ok && typeof r.renovaEm === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.renovaEm) ? r.renovaEm : null,
      motivo: ok ? null : typeof r.motivo === 'string' ? r.motivo : typeof r.status === 'string' ? r.status : 'erro',
    });
  }
  const perWallet = typeof (custo as any)?.carteira === 'number' && (custo as any).carteira > 0 ? (custo as any).carteira : null;
  const perFrase = typeof (custo as any)?.frase === 'number' && (custo as any).frase >= 0 ? (custo as any).frase : 0;
  const app = rows.filter((r) => r.app && r.ok);
  const restantes = app.reduce((a, r) => a + (r.restantes ?? 0), 0);
  const limite = app.reduce((a, r) => a + (r.limite ?? 0), 0);
  // uma frase de 100 temporárias custa a descoberta + 100 carteiras; as carteiras saem da mesma conta
  const porFrase = perWallet ? perFrase + 100 * perWallet : null;
  const carteiras = perWallet && porFrase ? Math.floor((restantes / porFrase) * 100) : null;
  return {
    chaves: rows,
    restantes: app.length ? restantes : null,
    limite: app.length ? limite : null,
    carteiras,
    frases: porFrase ? Math.floor(restantes / porFrase) : null,
    transacoes: carteiras === null ? null : Math.floor(carteiras * TX_PER_WALLET),
    porCarteira: perWallet,
    semDados: rows.length === 0,
  };
}

const parse = (s: unknown): unknown => {
  if (typeof s !== 'string') return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);

type Chain = { lidas?: unknown; listadas?: unknown; pendentes?: unknown; listando?: unknown; tx?: unknown; seen?: unknown };

export function montar(b: any, now = Date.now()) {
  const carteiras: Array<{ endereco: string; desde: number }> = (Array.isArray(b?.carteiras) ? b.carteiras : []).filter((c: any) => typeof c?.endereco === 'string' && Number.isFinite(c?.desde));
  const chain: Chain[] | null = Array.isArray(b?.chain) ? b.chain : null;
  const txs: FeeTx[] = [];
  const seen: Seen[] = [];
  const failed: Array<{ t: number; w: number }> = [];
  const faltam: number[] = [];
  let lidas = 0;
  let total = 0;
  let lendo = false;
  for (const [w, c] of carteiras.entries()) {
    const x = chain?.[w];
    if (!x || typeof x !== 'object') {
      faltam.push(0);
      continue;
    }
    for (const t of decodeTxs(typeof x.tx === 'string' ? x.tx : '', w)) if (t.t >= c.desde) txs.push(t);
    for (const s of decodeSeen(typeof x.seen === 'string' ? x.seen : '', w)) {
      if (s.t < c.desde) continue;
      seen.push(s);
      if (!s.ok) failed.push({ t: s.t, w });
    }
    faltam.push(num(x.pendentes));
    lidas += num(x.lidas);
    total += num(x.listadas);
    if (num(x.pendentes) > 0 || x.listando === true) lendo = true;
  }
  const saldosRaw: unknown[] = Array.isArray(b?.saldos) ? b.saldos : [];
  const saldos = carteiras.map((_, i) => {
    const v = saldosRaw[i];
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v / LAMPORTS : null;
  });
  const known = saldos.filter((s): s is number => s !== null);
  const rel = parse(b?.releases);
  const saude = b?.saude && typeof b.saude === 'object' ? b.saude : null;
  const data = buildData({
    now,
    versaoPainel: 'privado',
    carteiraTaxa: carteiras[0]?.endereco ?? '',
    txs: chain ? txs : null,
    failed,
    seen,
    faltam,
    carteiras: carteiras.map((c, i) => ({ ...c, saldo: saldos[i] })),
    taxaErro: chain ? null : 'o leitor do histórico não respondeu',
    proxy: parseProxyStats(parse(b?.proxy)),
    proxyErro: typeof b?.proxyErro === 'string' ? b.proxyErro : b?.proxy ? null : 'sem dados do proxy',
    releases: rel ? releaseSummary(rel) : null,
    saude: {
      proxy: saude?.proxy === 'ok' ? 'ok' : 'erro',
      site: saude?.site === 'ok' ? 'ok' : 'erro',
      atualizacao: saude?.atualizacao && typeof saude.atualizacao.kind === 'string' ? saude.atualizacao : { kind: 'error', reason: 'sem resposta' },
      proxyMs: typeof saude?.proxyMs === 'number' ? saude.proxyMs : null,
    },
    preco: priceFrom(parse(b?.preco), parse(b?.cambio)),
    saldo: known.length ? known.reduce((a, s) => a + s, 0) : null,
    demo: false,
  });
  return { ...data, leitura: { lendo, carteira: '', lidas, total }, helius: heliusSummary(b?.helius, b?.custo) };
}
