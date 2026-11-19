// Dados FICTÍCIOS para `npm run admin -- --demo`: ver o painel cheio antes de haver uso de verdade e tirar print nos
// testes de tela. Sorteio com semente fixa (o mesmo resultado sempre), nenhuma rede, nenhum endereço real: os
// "clientes" são hashes de nomes inventados. A página mostra a faixa "demonstração" o tempo todo.
import { shortHash } from './ler-tx.ts';
import { LAMPORTS, type FeeTx, type ProxyDay, type ProxyStats, type ReleaseSummary } from './metricas.ts';

const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ~45 dias de uso crescendo, com clientes que voltam, horários mais à noite (Brasília) e limpezas de tamanhos variados.
export function demoTxs(now: number): FeeTx[] {
  const r = rng(20261117);
  const txs: FeeTx[] = [];
  const clients: string[] = [];
  let n = 0;
  for (let d = 44; d >= 0; d--) {
    const growth = 1 + (44 - d) / 9;
    const count = Math.round(growth * (2 + r() * 4));
    for (let i = 0; i < count; i++) {
      const returning = clients.length > 3 && r() < 0.32;
      let dest: string;
      if (returning) dest = clients[Math.floor(r() * clients.length)]!;
      else clients.push((dest = shortHash(`cliente-demo-${clients.length}`)));
      const hourBrt = Math.min(23, Math.max(0, Math.round(20 + (r() + r() + r() - 1.5) * 8)));
      const t = Date.parse(new Date(now - d * DAY).toISOString().slice(0, 10)) + (hourBrt + 3) * 3_600_000 + Math.floor(r() * 3_600_000);
      if (t > now) continue;
      const volume = Math.exp(Math.log(0.04) + r() * r() * Math.log(400)); // de 0,04 a ~16 SOL, a maioria pequena
      // até 9 dias atrás a taxa ia para a "carteira antiga" (w = 1), como na troca de verdade
      txs.push({ sig: `demo${++n}`, t, fee: Math.round(volume * 0.11 * LAMPORTS), dest, w: d > 8 ? 1 : 0 });
    }
  }
  txs.push({ sig: 'demo-deposito', t: now - 44 * DAY, fee: 0.1 * LAMPORTS, dest: null });
  txs.push({ sig: 'demo-saque', t: now - 12 * DAY, fee: -3 * LAMPORTS, dest: null });
  return txs;
}

// Transações com erro (umas 3% das tentativas), espalhadas nos mesmos dias.
export function demoFailed(now: number): Array<{ t: number; w: number }> {
  const r = rng(99);
  const out: Array<{ t: number; w: number }> = [];
  for (let d = 44; d >= 0; d--) for (let i = 0; i < Math.round(r() * 2.2 * (1 + (44 - d) / 30)); i++) out.push({ t: now - d * DAY - Math.floor(r() * 20) * 3_600_000, w: d > 8 ? 1 : 0 });
  return out.filter((f) => f.t <= now);
}

export function demoProxy(now: number): ProxyStats {
  const r = rng(7);
  const days: ProxyDay[] = [];
  for (let d = 0; d < 30; d++) {
    const growth = 1 + (29 - d) / 6;
    const ips = Math.round(growth * (6 + r() * 6));
    const pedidos = ips * Math.round(900 + r() * 500);
    days.push({
      dia: new Date(now - d * DAY).toISOString().slice(0, 10),
      pedidos,
      creditos: Math.round(pedidos * 1.4),
      ips,
      analisaram: Math.round(ips * (0.45 + r() * 0.15)),
      executaram: Math.round(ips * (0.18 + r() * 0.08)),
      verificacoes: Math.round(ips * (1.5 + r())),
      metodos: { sendTransaction: Math.round(ips * (20 + r() * 30)) },
      versoes: d < 3 ? { '1.0.1': Math.round(pedidos * 0.7), '1.0.0': Math.round(pedidos * 0.3) } : { '1.0.0': pedidos },
      recusas: { segundo: Math.round(r() * 4), 'dia-ip': 0, 'teto-hora': 0, teto: 0 },
      eventos: d === 5 ? { 'upstream-lento': 2 } : {},
    });
  }
  return {
    hoje: days[0]!,
    historico: days.slice(1),
    chaves: [{ posicao: 1, pausadaAte: null }, { posicao: 2, pausadaAte: null }, { posicao: 3, pausadaAte: now + 5 * 3_600_000 }],
    limites: { porIpDia: 6000, tetoHora: 15000, tetoDia: 300000 },
    versaoMinima: null,
  };
}

export const demoReleases = (): ReleaseSummary => {
  const porVersao = [
    { versao: '1.0.1', data: '2026-11-17', downloads: 214 },
    { versao: '1.0.0', data: '2026-11-16', downloads: 389 },
  ];
  return { ultima: porVersao[0]!, porVersao, total: 603, aberturas: 1480 };
};
