import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from '../../src/core/solana/rpc.ts';
import { createRpcMeter, heliusCredits } from '../../src/core/solana/rpc-meter.ts';

test('medidor: conta cada requisição por método, inclusive as novas tentativas', async () => {
  let first = true;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    if (method === 'getBalance' && first) {
      first = false;
      return new Response('', { status: 429 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: method === 'getProgramAccounts' ? [] : { value: 0 } }));
  }) as typeof fetch;
  const meter = createRpcMeter(fake);
  const rpc = createRpc({ url: 'https://exemplo.invalid/?api-key=segredo', requestsPerSecond: 1000, fetchImpl: meter.fetchImpl, sleep: async () => {} });
  await rpc.call('getBalance', ['x']);
  await rpc.call('getProgramAccounts', ['p', {}]);
  await rpc.call('getProgramAccounts', ['p', {}]);
  assert.deepEqual(meter.counts(), { getBalance: 2, getProgramAccounts: 2 });
  assert.equal(meter.requests(), 4);
  assert.equal(meter.credits(), 2 * 1 + 2 * 10);
  assert.ok(!JSON.stringify(meter.counts()).includes('segredo'), 'a URL (com chave) não é guardada');
  meter.reset();
  assert.equal(meter.requests(), 0);
});

test('créditos do Helius: getProgramAccounts 10, V2 1, o resto 1', () => {
  assert.equal(heliusCredits('getProgramAccounts'), 10);
  assert.equal(heliusCredits('getProgramAccountsV2'), 1);
  assert.equal(heliusCredits('sendTransaction'), 1);
});
