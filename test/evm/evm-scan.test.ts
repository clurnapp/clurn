import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeEvmChains, balanceOfData, batchOf, EVM_CHAINS, matchById, parseQuantity, scanEvm, type EvmBatch, type EvmCall } from '../../src/core/evm/evm-scan.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.extraEvmNetworks = true;

const A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';

test('consulta de saldo de token: seletor balanceOf + endereço em 32 bytes', () => {
  assert.equal(balanceOfData(A), '0x70a08231' + '0'.repeat(24) + '9858effd232b4033e47d90003d41ec34ecaeda94');
});

test('quantidade hexadecimal: válida, vazia e fora do formato', () => {
  assert.equal(parseQuantity('0x0'), 0n);
  assert.equal(parseQuantity('0x'), 0n);
  assert.equal(parseQuantity('0xde0b6b3a7640000'), 10n ** 18n);
  assert.equal(parseQuantity('12'), null);
  assert.equal(parseQuantity(null), null);
  assert.equal(parseQuantity('0xzz'), null);
});

test('outras redes: lista fixada (ids, rpc, moeda, USDC conferido)', () => {
  assert.deepEqual(EVM_CHAINS.map((c) => c.id), ['ethereum', 'base', 'bsc', 'arbitrum', 'polygon', 'monad', 'hyperevm']);
  const by = (id: string) => EVM_CHAINS.find((c) => c.id === id);
  // chainId 0x8f e 0x3e7, symbol e decimals do USDC conferidos por eth_call em 06/11/2026
  assert.deepEqual(by('monad'), {
    id: 'monad', name: 'Monad', rpc: 'https://rpc.monad.xyz', native: 'MON', explorer: 'https://monadscan.com/address/',
    tokens: [{ symbol: 'USDC', address: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', decimals: 6 }],
  });
  assert.deepEqual(by('hyperevm'), {
    id: 'hyperevm', name: 'HyperEVM', rpc: 'https://rpc.hyperliquid.xyz/evm', native: 'HYPE', explorer: 'https://hyperevmscan.io/address/',
    tokens: [{ symbol: 'USDC', address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6 }],
  });
  assert.equal(new Set(EVM_CHAINS.map((c) => c.rpc)).size, EVM_CHAINS.length, 'um RPC por rede (o lote é casado pelo endereço do RPC)');
});

test('outras redes: saldo, USDC, conta usada; falha numa rede não derruba as outras', async () => {
  const usdcEth = EVM_CHAINS[0].tokens[0].address;
  const call: EvmCall = async (rpc, method, params) => {
    if (rpc.includes('bsc')) throw new Error('HTTP 503');
    const p = params as any[];
    if (method === 'eth_getBalance') return rpc.includes('ethereum') && p[0] === A ? '0xde0b6b3a7640000' : '0x0';
    if (method === 'eth_getTransactionCount') return p[0] === A ? '0x3' : '0x0';
    if (method === 'eth_call') return rpc.includes('ethereum') && p[0].to === usdcEth && p[0].data === balanceOfData(B) ? '0x' + (25_500_000).toString(16) : '0x0';
    throw new Error('método inesperado');
  };
  const r = await scanEvm([A, B], batchOf(call));
  assert.deepEqual(r.holdings.map((h) => `${h.chainName}/${h.account}/${h.asset}/${h.amount}`), ['Ethereum/0/ETH/1000000000000000000', 'Ethereum/1/USDC/25500000']);
  assert.equal(r.holdings[1].decimals, 6);
  assert.ok(r.usedAccounts.some((u) => u.chain === 'Ethereum' && u.account === 0 && u.txCount === 3));
  assert.equal(r.errors.length, 2, 'BSC falhou nas 2 contas');
  assert.ok(r.errors.every((e) => e.startsWith('BNB Smart Chain')));
});

test('outras redes: resposta fora do formato vira aviso, nunca saldo', async () => {
  const call: EvmCall = async (_rpc, method) => (method === 'eth_getBalance' ? 'muito' : '0x0');
  const r = await scanEvm([A], batchOf(call), [EVM_CHAINS[1]]);
  assert.equal(r.holdings.length, 0);
  assert.match(r.errors[0], /fora do formato/);
});

test('outras redes: um pedido por rede com as consultas de todas as contas (não uma por vez)', async () => {
  const seen: Array<{ rpc: string; n: number }> = [];
  const batch: EvmBatch = async (rpc, calls) => {
    seen.push({ rpc, n: calls.length });
    return calls.map(() => '0x0');
  };
  const r = await scanEvm([A, B, A, B, A], batch);
  assert.equal(seen.length, EVM_CHAINS.length, 'um lote por rede');
  for (const c of EVM_CHAINS) assert.equal(seen.find((x) => x.rpc === c.rpc)?.n, 5 * (2 + c.tokens.length));
  assert.deepEqual(r.errors, []);
});

test('outras redes: lote que falha inteiro tenta mais uma vez; falhando de novo, vira aviso de cada conta só daquela rede', async () => {
  const tries = new Map<string, number>();
  const batch = (failures: number): EvmBatch => async (rpc, calls) => {
    const k = (tries.get(rpc) ?? 0) + 1;
    tries.set(rpc, k);
    if (rpc.includes('bsc') && k <= failures) throw new Error('The operation was aborted due to timeout');
    return calls.map((c) => (c.method === 'eth_getBalance' ? '0x5' : '0x0'));
  };
  const once = await scanEvm([A, B], batch(1));
  assert.deepEqual(once.errors, [], '1ª falha: a 2ª tentativa resolve');
  assert.equal(once.holdings.filter((h) => h.chain === 'bsc').length, 2);
  tries.clear();
  const twice = await scanEvm([A, B], batch(2));
  assert.deepEqual(twice.errors, ['BNB Smart Chain, conta 1: The operation was aborted due to timeout', 'BNB Smart Chain, conta 2: The operation was aborted due to timeout']);
  assert.equal(twice.holdings.length, 2 * (EVM_CHAINS.length - 1), 'as outras redes seguem');
});

test('outras redes: item ruim no lote marca só a conta dele', async () => {
  // 4 consultas por conta (saldo, nonce, USDC, USDT). Conta 2: erro do RPC no saldo; conta 3: USDT fora do formato
  const batch: EvmBatch = async (_rpc, calls) => calls.map((c, i) => (i === 4 ? new Error('rate limited') : i === 11 ? null : c.method === 'eth_getBalance' ? '0x1' : '0x0'));
  const r = await scanEvm([A, B, A], batch, [EVM_CHAINS[0]]);
  assert.deepEqual(r.errors, ['Ethereum, conta 2: rate limited', 'Ethereum, conta 3: USDT: resposta fora do formato']);
  assert.deepEqual(r.holdings.map((h) => h.account), [0]);
});

test('lote JSON-RPC: resposta casada pela id; repetida, faltando, fora da faixa ou sem resultado viram erro só do item', () => {
  const body = [
    { id: 2, result: '0x2' },
    { id: 0, result: '0x0' },
    { id: 0, result: '0x99' }, // repetida: vale a primeira
    { id: 7, result: '0x7' }, // fora da faixa
    { id: '1', result: '0x1' }, // id não numérica
    { id: 3, error: { message: 'execution reverted' } },
    { id: 4 }, // sem resultado
    null,
  ];
  const r = matchById(body, 6);
  assert.equal(r[0], '0x0');
  assert.equal(r[2], '0x2');
  assert.match(String(r[1]), /fora do formato/);
  assert.match(String(r[3]), /execution reverted/);
  assert.match(String(r[4]), /fora do formato/);
  assert.match(String(r[5]), /fora do formato/);
  assert.throws(() => matchById({ error: { message: 'batch not allowed' } }, 2), /fora do formato/);
});

test('poeira fica à parte e contas usadas são agrupadas por rede', async () => {
  const { isDust, usedByChain } = await import('../../src/cli/outras-redes.ts');
  const h = (amount: bigint, decimals: number) => ({ chain: 'x', chainName: 'Ethereum', account: 0, address: A, asset: 'ETH', amount, decimals, explorer: '' });
  assert.equal(isDust(h(2n, 18)), true);
  assert.equal(isDust(h(10n ** 12n, 18)), false);
  assert.equal(isDust(h(1n, 6)), false, '0,000001 USDC não é poeira pela regra');
  const r = { holdings: [h(2n, 18)], usedAccounts: [{ chain: 'Ethereum', account: 0, address: A, txCount: 1 }, { chain: 'Ethereum', account: 2, address: B, txCount: 1 }, { chain: 'Base', account: 1, address: B, txCount: 9 }], errors: [] };
  assert.deepEqual(usedByChain(r), ['Ethereum: contas 1, 3', 'Base: contas 2']);
});

// ---------- 1.0: Monad e HyperEVM desligadas (src/core/features.ts, congelamento de 16/11/2026) ----------

test('1.0: Monad e HyperEVM desligadas → a leitura padrão consulta só as 5 redes da 0.2.4', async () => {
  FEATURES.extraEvmNetworks = false;
  try {
    assert.deepEqual(activeEvmChains().map((c) => c.id), ['ethereum', 'base', 'bsc', 'arbitrum', 'polygon']);
    const rpcs: string[] = [];
    await scanEvm(['0x0000000000000000000000000000000000000001'], async (rpc, calls) => {
      rpcs.push(rpc);
      return calls.map(() => '0x0');
    });
    assert.deepEqual(rpcs.sort(), EVM_CHAINS.filter((c) => !['monad', 'hyperevm'].includes(c.id)).map((c) => c.rpc).sort());
  } finally {
    FEATURES.extraEvmNetworks = true;
  }
});
