// Confere, ANTES da análise, se o RPC escolhido permite tudo o que o app usa.
// Aprendido na auditoria real: cada provedor bloqueia coisas diferentes (o publicnode aceita só 10
// endereços por consulta e bloqueia a leitura de contas de token). Melhor parar no começo, com uma
// mensagem clara, do que falhar no meio da análise.

import { createHash } from 'node:crypto';
import { encodeBase58 } from './base58.ts';
import { anchorAccountDiscriminator, PROGRAMS } from './pda.ts';
import type { RpcClient } from './rpc.ts';

// 100 endereços válidos (só para medir o limite por consulta; ninguém é dono deles)
function sampleAddresses(n: number): string[] {
  return Array.from({ length: n }, (_, i) => encodeBase58(createHash('sha256').update(`autoclarn-rpc-check-${i}`).digest()));
}

// Endereço sem nada para as consultas de teste. Não usar o 1111…1 (System Program): na devnet ele é
// "dono" de milhares de contas de token e a consulta levava 22 s e estourava (30/10/2026).
export const PROBE_ADDRESS = encodeBase58(createHash('sha256').update('autoclarn-rpc-check-probe').digest());

// Cada consulta de teste tem prazo próprio: RPC lento falha em segundos, não em minutos.
export const CHECK_TIMEOUT_MS = 20_000;

type Check = { what: string; run: (rpc: RpcClient) => Promise<unknown> };

// Hash do bloco de gênese de cada rede: é o que prova de qual rede o RPC é. Conferido com getGenesisHash nos
// RPCs públicos da Solana em 31/10/2026. Sem esta trava, um endereço da mainnet com "Devnet (teste)" marcado
// rodaria com dinheiro real enquanto a tela diz que é teste.
export const GENESIS_HASH = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const;
export type Cluster = keyof typeof GENESIS_HASH;

export function clusterCheck(cluster: Cluster): Check {
  return {
    what: `rede do RPC (precisa ser ${cluster})`,
    run: async (rpc) => {
      const hash = await rpc.call<unknown>('getGenesisHash', []);
      if (hash === GENESIS_HASH[cluster]) return hash;
      const other = (Object.keys(GENESIS_HASH) as Cluster[]).find((c) => GENESIS_HASH[c] === hash);
      throw new Error(other ? `este RPC é da ${other}` : 'este RPC é de uma rede desconhecida');
    },
  };
}

export const RPC_CHECKS: Check[] = [
  { what: 'consulta básica', run: (rpc) => rpc.call('getMinimumBalanceForRentExemption', [0]) },
  { what: 'histórico de endereço (getSignaturesForAddress)', run: (rpc) => rpc.call('getSignaturesForAddress', [PROBE_ADDRESS, { limit: 1 }]) },
  { what: 'leitura de contas de token (getTokenAccountsByOwner)', run: (rpc) => rpc.call('getTokenAccountsByOwner', [PROBE_ADDRESS, { programId: PROGRAMS.token }, { encoding: 'jsonParsed' }]) },
  { what: 'leitura de 100 contas por consulta (getMultipleAccounts)', run: (rpc) => rpc.call('getMultipleAccounts', [sampleAddresses(100), { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]) },
  {
    what: 'busca das moedas criadas na Pump.fun (getProgramAccounts)',
    run: (rpc) =>
      rpc.call('getProgramAccounts', [
        PROGRAMS.pump,
        {
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
          filters: [{ memcmp: { offset: 0, bytes: encodeBase58(anchorAccountDiscriminator('BondingCurve')) } }, { memcmp: { offset: 49, bytes: PROBE_ADDRESS } }],
        },
      ]),
  },
];

export type RpcCheckResult = { ok: boolean; problems: string[] };

// Roda uma consulta de teste com prazo próprio; devolve o problema (ou null se passou).
async function runCheck(rpc: RpcClient, c: Check, timeoutMs: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`não respondeu em ${String(timeoutMs / 1000).replace('.', ',')} s`)), timeoutMs);
  });
  try {
    const r = await Promise.race([c.run(rpc), deadline]);
    return r === undefined || r === null ? `${c.what}: resposta vazia` : null;
  } catch (e) {
    return `${c.what}: ${e instanceof Error ? e.message : 'erro'}`;
  } finally {
    clearTimeout(timer);
  }
}

// Cliente que confere a rede (hash de gênese) antes da primeira consulta; de outra rede, recusa todas. Usado no RPC
// público que atende só o getProgramAccounts recusado pelo RPC próprio (gpa-fallback.ts). Falha de rede na conferência
// não fica guardada: a próxima consulta confere de novo.
export function networkGuarded(client: RpcClient, cluster: Cluster): RpcClient {
  let verified: Promise<unknown> | null = null;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      verified ??= clusterCheck(cluster).run(client).catch((e) => {
        if (!/este RPC é d/.test(e instanceof Error ? e.message : '')) verified = null;
        throw e;
      });
      await verified;
      return client.call<T>(method, params);
    },
  };
}

// `cluster` liga a trava de rede: ela roda primeiro e, se o RPC for de outra rede, nada mais é consultado.
export async function checkRpc(rpc: RpcClient, checks: Check[] = RPC_CHECKS, timeoutMs = CHECK_TIMEOUT_MS, cluster?: Cluster): Promise<RpcCheckResult> {
  if (cluster) {
    const wrongNetwork = await runCheck(rpc, clusterCheck(cluster), timeoutMs);
    if (wrongNetwork) return { ok: false, problems: [wrongNetwork] };
  }
  const problems: string[] = [];
  for (const c of checks) {
    const p = await runCheck(rpc, c, timeoutMs);
    if (p) problems.push(p);
  }
  return { ok: problems.length === 0, problems };
}

export function rpcProblemMessage(problems: string[]): string {
  return (
    'Este RPC não serve para o app. O que ele recusou:\n' +
    problems.map((p) => `  - ${p}`).join('\n') +
    '\nNada foi analisado nem executado.'
  );
}
