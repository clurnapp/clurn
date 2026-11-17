// Espera pelo depósito de SOL das taxas: só leitura (saldos), nunca assina nem envia.
import { balancesOnly } from '../core/limpeza/scan.ts';
import type { RpcClient } from '../core/solana/rpc.ts';

// dorme até o tempo acabar ou até o sinal abortar (o timer não segura o processo vivo)
function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

// devolve o mapa índice→lamports quando `passes` aceita; null se foi cancelada
export async function waitForFunding(opts: {
  rpc: RpcClient;
  wallets: Array<{ index: number; address: string }>;
  passes: (balances: Map<number, number>) => boolean;
  signal: AbortSignal;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Map<number, number> | null> {
  const { rpc, wallets, passes, signal } = opts;
  const interval = opts.intervalMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => sleepUntilAbort(ms, signal));
  while (true) {
    if (signal.aborted) return null;
    try {
      const scans = await balancesOnly(rpc, wallets);
      if (signal.aborted) return null;
      const balances = new Map<number, number>();
      for (const s of scans) if (!s.errors.length) balances.set(s.index, s.lamports); // leitura com erro não vale como saldo
      if (balances.size && passes(balances)) return signal.aborted ? null : balances;
    } catch {
      // erro de rede numa volta: tenta de novo na próxima
    }
    if (signal.aborted) return null;
    await sleep(interval);
    if (signal.aborted) return null;
  }
}
