// Saldos nas redes compatíveis com Ethereum, SÓ LEITURA. O app mostra o que existe e onde;
// para mover, o usuário usa a carteira dessa rede (MetaMask, Trust...).
import { FEATURES } from '../features.ts';

export type EvmToken = { symbol: string; address: string; decimals: number };
export type EvmChain = { id: string; name: string; rpc: string; native: string; explorer: string; tokens: EvmToken[] };

// Contratos conferidos na própria rede (symbol/decimals) em 30/10/2026 — test/evm/evm-scan.test.ts fixa a lista.
// BSC pelo RPC oficial da BNB Chain: o da publicnode levava 7 a 15 s por pedido e estourava o prazo (01/11/2026).
export const EVM_CHAINS: EvmChain[] = [
  {
    id: 'ethereum', name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', native: 'ETH', explorer: 'https://etherscan.io/address/',
    tokens: [
      { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    ],
  },
  {
    id: 'base', name: 'Base', rpc: 'https://base-rpc.publicnode.com', native: 'ETH', explorer: 'https://basescan.org/address/',
    tokens: [{ symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 }],
  },
  {
    id: 'bsc', name: 'BNB Smart Chain', rpc: 'https://bsc-dataseed.bnbchain.org', native: 'BNB', explorer: 'https://bscscan.com/address/',
    tokens: [
      { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    ],
  },
  {
    id: 'arbitrum', name: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com', native: 'ETH', explorer: 'https://arbiscan.io/address/',
    tokens: [
      { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
      { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
    ],
  },
  {
    id: 'polygon', name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', native: 'POL', explorer: 'https://polygonscan.com/address/',
    tokens: [
      { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
      { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
    ],
  },
  // Monad e HyperEVM: RPC público oficial, chainId (0x8f e 0x3e7) e USDC (symbol/decimals) conferidos por eth_call
  // em 06/11/2026; os dois aceitam lote JSON-RPC. Explorer da Monad no monadscan: o monadvision pede verificação
  // de navegador e não abriu no teste; monadscan e hyperevmscan abriram com o endereço do USDC.
  {
    id: 'monad', name: 'Monad', rpc: 'https://rpc.monad.xyz', native: 'MON', explorer: 'https://monadscan.com/address/',
    tokens: [{ symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6 }],
  },
  {
    id: 'hyperevm', name: 'HyperEVM', rpc: 'https://rpc.hyperliquid.xyz/evm', native: 'HYPE', explorer: 'https://hyperevmscan.io/address/',
    tokens: [{ symbol: 'USDC', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 }],
  },
];

export type EvmCall = (rpc: string, method: string, params: unknown[]) => Promise<unknown>;
export type EvmRequest = { method: string; params: unknown[] };
// Um pedido por rede com todas as consultas da frase (lote JSON-RPC). Cada item volta como o resultado ou um Error;
// o lote inteiro que falha lança. Antes, ~15 consultas em série por rede: a BSC pública fica mais lenta a cada uma
// (490 → 2576 ms, e às vezes 20 s sem resposta) e cada frase levava ~2 min (medido em 01/11/2026; o lote, 280 ms).
export type EvmBatch = (rpc: string, calls: EvmRequest[]) => Promise<unknown[]>;

const EVM_TIMEOUT_MS = 15_000;
const EVM_ATTEMPTS = 2; // o lote que falha inteiro (rede, HTTP, formato) tenta mais uma vez

export const defaultEvmBatch: EvmBatch = async (rpc, calls) => {
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(EVM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return matchById(await res.json(), calls.length);
};

// resposta do lote → um item por consulta, pela id (a ordem não é garantida). Id repetida vale a primeira; id que
// falta, fora da faixa ou item sem resultado vira Error só daquele item.
export function matchById(body: unknown, n: number): unknown[] {
  if (!Array.isArray(body)) throw new Error('resposta fora do formato');
  const out: unknown[] = Array.from({ length: n }, () => new Error('resposta fora do formato'));
  const seen = new Set<number>();
  for (const it of body as Array<{ id?: unknown; result?: unknown; error?: { message?: unknown } } | null>) {
    const id = it?.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id >= n || seen.has(id)) continue;
    seen.add(id);
    if (it!.error) out[id] = new Error(typeof it!.error.message === 'string' ? it!.error.message : 'erro do RPC');
    else if ('result' in it!) out[id] = it!.result;
  }
  return out;
}

// consulta por consulta (testes do servidor injetam uma função assim): mesmas regras do lote
export function batchOf(call: EvmCall): EvmBatch {
  return (rpc, calls) => Promise.all(calls.map((c) => call(rpc, c.method, c.params).catch((e: unknown) => (e instanceof Error ? e : new Error('erro')))));
}

export function parseQuantity(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) return null;
  return v === '0x' ? 0n : BigInt(v);
}

export function balanceOfData(owner: string): string {
  return '0x70a08231' + owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export type EvmHolding = { chain: string; chainName: string; account: number; address: string; asset: string; amount: bigint; decimals: number; explorer: string };
export type EvmScan = { holdings: EvmHolding[]; usedAccounts: Array<{ chain: string; account: number; address: string; txCount: number }>; errors: string[] };

// Para cada endereço e rede: moeda principal, USDC/USDT e quantas transações já fez, num lote só por rede.
// Falha numa rede vira aviso, nunca derruba as outras; item ruim marca só a conta dele.
// Monad e HyperEVM ficam de fora enquanto o interruptor da 1.0 estiver desligado (src/core/features.ts)
export const EXTRA_EVM_CHAINS = ['monad', 'hyperevm'];
export const activeEvmChains = (): EvmChain[] => EVM_CHAINS.filter((c) => FEATURES.extraEvmNetworks || !EXTRA_EVM_CHAINS.includes(c.id));

export async function scanEvm(addresses: string[], batch: EvmBatch = defaultEvmBatch, chains: EvmChain[] = activeEvmChains()): Promise<EvmScan> {
  const out: EvmScan = { holdings: [], usedAccounts: [], errors: [] };
  await Promise.all(
    chains.map(async (c) => {
      const perAccount = 2 + c.tokens.length;
      const calls = addresses.flatMap((address): EvmRequest[] => [
        { method: 'eth_getBalance', params: [address, 'latest'] },
        { method: 'eth_getTransactionCount', params: [address, 'latest'] },
        ...c.tokens.map((t) => ({ method: 'eth_call', params: [{ to: t.address, data: balanceOfData(address) }, 'latest'] })),
      ]);
      let results: unknown[] = [];
      let failure: unknown = null;
      for (let k = 0; k < EVM_ATTEMPTS; k++) {
        try {
          results = await batch(c.rpc, calls);
          if (results.length !== calls.length) throw new Error('resposta fora do formato');
          failure = null;
          break;
        } catch (e) {
          failure = e;
        }
      }
      for (const [account, address] of addresses.entries()) {
        try {
          if (failure) throw failure;
          const r = results.slice(account * perAccount, (account + 1) * perAccount);
          const bad = r.find((x) => x instanceof Error);
          if (bad) throw bad;
          const b = parseQuantity(r[0]);
          const n = parseQuantity(r[1]);
          if (b === null || n === null) throw new Error('resposta fora do formato');
          const tokens = c.tokens.map((t, i) => {
            const v = parseQuantity(r[2 + i]);
            if (v === null) throw new Error(`${t.symbol}: resposta fora do formato`);
            return v;
          });
          if (n > 0n) out.usedAccounts.push({ chain: c.name, account, address, txCount: Number(n) });
          if (b > 0n) out.holdings.push({ chain: c.id, chainName: c.name, account, address, asset: c.native, amount: b, decimals: 18, explorer: c.explorer + address });
          c.tokens.forEach((t, i) => {
            if (tokens[i] > 0n) out.holdings.push({ chain: c.id, chainName: c.name, account, address, asset: t.symbol, amount: tokens[i], decimals: t.decimals, explorer: c.explorer + address });
          });
        } catch (e) {
          out.errors.push(`${c.name}, conta ${account + 1}: ${e instanceof Error ? e.message : 'erro'}`);
        }
      }
    }),
  );
  out.holdings.sort((a, b) => a.chain.localeCompare(b.chain) || a.account - b.account);
  return out;
}
