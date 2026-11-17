// Medidor de uso do RPC: conta cada requisição HTTP (inclusive as novas tentativas) por método
// e estima os créditos do Helius. Só olha o NOME do método; parâmetros e URL (que pode ter chave)
// não são guardados.
//
// Créditos conferidos em https://www.helius.dev/docs/billing/credits em 30/10/2026 (mudam: confira).
// Método fora da tabela = 1 crédito.

export const HELIUS_CREDITS: Record<string, number> = {
  getProgramAccounts: 10,
  getProgramAccountsV2: 1,
};

export function heliusCredits(method: string): number {
  return HELIUS_CREDITS[method] ?? 1;
}

export type RpcMeter = {
  fetchImpl: typeof fetch;
  counts(): Record<string, number>;
  requests(): number;
  credits(): number;
  reset(): void;
};

export function createRpcMeter(inner: typeof fetch = fetch): RpcMeter {
  let byMethod: Record<string, number> = {};
  const fetchImpl: typeof fetch = (input, init) => {
    let method = '?';
    try {
      const body = JSON.parse(String(init?.body ?? ''));
      if (typeof body?.method === 'string') method = body.method;
    } catch {
      // corpo fora do formato: conta como '?'
    }
    byMethod[method] = (byMethod[method] ?? 0) + 1;
    return inner(input, init);
  };
  return {
    fetchImpl,
    counts: () => ({ ...byMethod }),
    requests: () => Object.values(byMethod).reduce((a, b) => a + b, 0),
    credits: () => Object.entries(byMethod).reduce((a, [m, n]) => a + heliusCredits(m) * n, 0),
    reset: () => {
      byMethod = {};
    },
  };
}
