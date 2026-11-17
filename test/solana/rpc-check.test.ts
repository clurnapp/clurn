import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRpc, PROBE_ADDRESS, rpcProblemMessage } from '../../src/core/solana/rpc-check.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';

const ok: RpcClient = {
  async call<T>(method: string): Promise<T> {
    return (method === 'getMinimumBalanceForRentExemption' ? 890_880 : method === 'getMultipleAccounts' || method === 'getTokenAccountsByOwner' ? { value: [] } : []) as T;
  },
};

test('RPC que permite tudo passa', async () => {
  assert.deepEqual(await checkRpc(ok), { ok: true, problems: [] });
});

test('RPC como o publicnode (10 por consulta, tokens bloqueados) é recusado com o motivo de cada coisa', async () => {
  const publicnodeLike: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getTokenAccountsByOwner') throw new RpcError('getTokenAccountsByOwner: Request blocked', -32602);
      if (method === 'getMultipleAccounts' && (params[0] as string[]).length > 10) throw new RpcError('getMultipleAccounts: A maximum of 10 accounts is allowed', -32602);
      return ok.call<T>(method, params);
    },
  };
  const r = await checkRpc(publicnodeLike);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems.join(), /contas de token.*blocked/);
  assert.match(r.problems.join(), /100 contas.*maximum of 10/);
  assert.match(rpcProblemMessage(r.problems), /Nada foi analisado nem executado/);
});

test('resposta vazia também conta como problema', async () => {
  const empty: RpcClient = { call: async <T>() => null as T };
  const r = await checkRpc(empty);
  assert.equal(r.ok, false);
  assert.ok(r.problems.every((p) => /resposta vazia/.test(p)));
});

test('as consultas de teste usam um endereço sem nada (o 1111…1 tem milhares de contas de token na devnet)', async () => {
  const seen: Array<[string, unknown]> = [];
  const spy: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      seen.push([method, params]);
      return ok.call<T>(method, params);
    },
  };
  await checkRpc(spy);
  const text = JSON.stringify(seen);
  assert.ok(!text.includes('11111111111111111111111111111111'), 'nenhuma consulta de teste pode apontar para o endereço do System Program');
  const owner = (seen.find(([m]) => m === 'getTokenAccountsByOwner')![1] as string[])[0];
  assert.equal(owner, PROBE_ADDRESS);
});

// sem o prazo por consulta, este teste ficaria pendurado para sempre: o timeout do runner o derruba
test('consulta de teste que não responde falha rápido, com motivo claro, e as outras continuam', { timeout: 30_000 }, async () => {
  const hangs: RpcClient = {
    call: <T>(method: string, params: unknown[]) => (method === 'getTokenAccountsByOwner' ? new Promise<T>(() => {}) : ok.call<T>(method, params)),
  };
  const r = await checkRpc(hangs, undefined, 50);
  assert.deepEqual(r.problems, ['leitura de contas de token (getTokenAccountsByOwner): não respondeu em 0,05 s']);
});

// ---------- trava de rede (hash de gênese) ----------

import { clusterCheck, GENESIS_HASH } from '../../src/core/solana/rpc-check.ts';

const onNetwork = (hash: unknown, seen: string[] = []): RpcClient => ({
  async call<T>(method: string, params: unknown[]): Promise<T> {
    seen.push(method);
    return (method === 'getGenesisHash' ? hash : await ok.call<T>(method, params)) as T;
  },
});

test('trava de rede: RPC da rede certa passa e as outras consultas rodam', async () => {
  const seen: string[] = [];
  assert.deepEqual(await checkRpc(onNetwork(GENESIS_HASH.mainnet, seen), undefined, undefined, 'mainnet'), { ok: true, problems: [] });
  assert.equal(seen[0], 'getGenesisHash', 'a trava roda primeiro');
  assert.ok(seen.length > 1);
});

test('trava de rede: RPC da mainnet numa rodada de devnet é recusado e nada mais é consultado', async () => {
  const seen: string[] = [];
  const r = await checkRpc(onNetwork(GENESIS_HASH.mainnet, seen), undefined, undefined, 'devnet');
  assert.deepEqual(r, { ok: false, problems: ['rede do RPC (precisa ser devnet): este RPC é da mainnet'] });
  assert.deepEqual(seen, ['getGenesisHash']);
});

test('trava de rede: hash desconhecido, vazio ou fora do formato também é recusado', async () => {
  for (const hash of ['4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', null, 42, { x: 1 }]) {
    const r = await checkRpc(onNetwork(hash), undefined, undefined, 'mainnet');
    assert.equal(r.ok, false, String(hash));
    assert.match(r.problems[0]!, /^rede do RPC \(precisa ser mainnet\): /);
  }
});

test('trava de rede: sem rede informada, checkRpc não pede o hash (scripts antigos)', async () => {
  const seen: string[] = [];
  await checkRpc(onNetwork(null, seen));
  assert.ok(!seen.includes('getGenesisHash'));
  assert.equal(clusterCheck('devnet').what, 'rede do RPC (precisa ser devnet)');
});
