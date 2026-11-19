import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGpaRefusal, withGpaFallback } from '../../src/core/solana/gpa-fallback.ts';
import { GENESIS_HASH, networkGuarded } from '../../src/core/solana/rpc-check.ts';
import { isFatalRpcError, RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';

// a recusa do Helius, como veio na mainnet em 31/10/2026
const HELIUS_REFUSAL = 'getProgramAccounts: Too many accounts requested (10000001 pubkeys), Please use getProgramAccountsV2 with pagination to handle large datasets.';

function spy(answer: (m: string) => unknown) {
  const calls: string[] = [];
  const client: RpcClient = {
    async call<T>(m: string): Promise<T> {
      calls.push(m);
      const r = answer(m);
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { client, calls };
}

test('desvio do gPA: o resto vai sempre ao RPC próprio; gPA aceito pelo próprio não cria o público', async () => {
  const own = spy((m) => (m === 'getProgramAccounts' ? ['meu'] : m));
  let created = 0;
  const rpc = withGpaFallback(own.client, () => { created++; return spy(() => ['publico']).client; });
  assert.equal(await rpc.call('getBalance', []), 'getBalance');
  assert.deepEqual(await rpc.call('getProgramAccounts', []), ['meu']);
  assert.equal(created, 0);
  assert.deepEqual(own.calls, ['getBalance', 'getProgramAccounts']);
});

test('desvio do gPA: recusa do Helius → público atende, e daí em diante o gPA vai direto ao público', async () => {
  const own = spy((m) => (m === 'getProgramAccounts' ? new RpcError(HELIUS_REFUSAL, -32600) : m));
  const pub = spy(() => ['do público']);
  let created = 0;
  let switched = 0;
  const rpc = withGpaFallback(own.client, () => { created++; return pub.client; }, () => switched++);
  assert.deepEqual(await rpc.call('getProgramAccounts', []), ['do público']);
  assert.deepEqual(await rpc.call('getProgramAccounts', []), ['do público']);
  assert.equal(await rpc.call('sendTransaction', []), 'sendTransaction', 'envio continua no próprio');
  assert.deepEqual(own.calls, ['getProgramAccounts', 'sendTransaction'], 'o próprio só viu a 1ª busca (recusada)');
  assert.deepEqual(pub.calls, ['getProgramAccounts', 'getProgramAccounts']);
  assert.deepEqual([created, switched], [1, 1]);
});

test('desvio do gPA: outro erro do próprio no gPA passa adiante, sem desviar', async () => {
  const own = spy(() => new RpcError('getProgramAccounts: Invalid param', -32602));
  let created = 0;
  const rpc = withGpaFallback(own.client, () => { created++; return spy(() => []).client; });
  await assert.rejects(rpc.call('getProgramAccounts', []), /Invalid param/);
  assert.equal(created, 0);
  assert.equal(isGpaRefusal(new Error(HELIUS_REFUSAL)), true);
  assert.equal(isGpaRefusal(new Error('getProgramAccounts: 503')), false);
  assert.equal(isGpaRefusal('texto'), false);
});

test('desvio do gPA: falha "fatal" do público (cota, 503, rede) chega como erro comum: não pausa nem troca a rodada', async () => {
  for (const bad of [new RpcError('getProgramAccounts: créditos do RPC esgotados', 429, undefined, 'quota'), new RpcError('getProgramAccounts: 503', 503), new RpcError('fetch failed'), new TypeError('rede')]) {
    const own = spy(() => new RpcError(HELIUS_REFUSAL, -32600));
    const rpc = withGpaFallback(own.client, () => spy(() => bad).client);
    const e = await rpc.call('getProgramAccounts', []).then(() => null, (x: unknown) => x);
    assert.ok(e instanceof RpcError, String(e));
    assert.equal(isFatalRpcError(e), false, `${bad.message}: não pode pausar a rodada`);
    assert.match((e as Error).message, /^getProgramAccounts pelo RPC público: /);
  }
});

test('trava de rede do cliente público: confere uma vez; rede errada recusa tudo sem consultar; falha de rede confere de novo', async () => {
  const right = spy((m) => (m === 'getGenesisHash' ? GENESIS_HASH.mainnet : 'ok'));
  const g = networkGuarded(right.client, 'mainnet');
  assert.equal(await g.call('getProgramAccounts', []), 'ok');
  assert.equal(await g.call('getProgramAccounts', []), 'ok');
  assert.deepEqual(right.calls, ['getGenesisHash', 'getProgramAccounts', 'getProgramAccounts'], 'confere a rede uma vez só');

  const wrong = spy((m) => (m === 'getGenesisHash' ? GENESIS_HASH.devnet : 'nunca'));
  const w = networkGuarded(wrong.client, 'mainnet');
  await assert.rejects(w.call('getProgramAccounts', []), /este RPC é da devnet/);
  await assert.rejects(w.call('getProgramAccounts', []), /este RPC é da devnet/);
  assert.deepEqual(wrong.calls, ['getGenesisHash'], 'rede errada: nenhuma busca, e não confere de novo');

  let down = true;
  const flaky = spy((m) => (m === 'getGenesisHash' ? (down ? new RpcError('fetch failed') : GENESIS_HASH.mainnet) : 'ok'));
  const f = networkGuarded(flaky.client, 'mainnet');
  await assert.rejects(f.call('getProgramAccounts', []), /fetch failed/);
  down = false;
  assert.equal(await f.call('getProgramAccounts', []), 'ok', 'a rede voltou: confere de novo e segue');
});
