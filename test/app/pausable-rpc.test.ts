import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPausableRpc, StopRequested, type PauseReason } from '../../src/app/pausable-rpc.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';

const quota = () => new RpcError('x: créditos do RPC esgotados', 429, undefined, 'quota');
const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function dead(err: () => Error): RpcClient & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return { calls, async call() { throw err(); } } as never;
}
function good(result: unknown): RpcClient & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return { calls, async call(m: string, p: unknown[]) { calls.push([m, p]); return result as never; } } as never;
}

test('pausável: erro JSON-RPC passa direto, sem pausar', async () => {
  const pauses: PauseReason[] = [];
  const rpc = createPausableRpc(dead(() => new RpcError('x: invalid params', -32602)), (r) => pauses.push(r));
  await assert.rejects(rpc.call('getBalance', []), (e) => e instanceof RpcError && e.code === -32602);
  assert.equal(rpc.paused(), null);
  assert.deepEqual(pauses, []);
});

test('pausável: créditos esgotados pausam; replace repete a MESMA chamada no RPC novo', async () => {
  const pauses: PauseReason[] = [];
  const rpc = createPausableRpc(dead(quota), (r) => pauses.push(r));
  let done = false;
  const p = rpc.call<string>('getBalance', ['abc']).then((v) => { done = true; return v; });
  await tick();
  assert.equal(done, false);
  assert.equal(rpc.paused(), 'rpc-quota');
  const next = good('ok');
  rpc.replace(next);
  assert.equal(await p, 'ok');
  assert.deepEqual(next.calls, [['getBalance', ['abc']]]);
  assert.deepEqual(pauses, ['rpc-quota']);
  assert.equal(rpc.paused(), null);
  // chamadas novas também vão para o RPC novo
  assert.equal(await rpc.call('getSlot', []), 'ok');
  assert.equal(next.calls.length, 2);
});

test('pausável: 4 chamadas ao mesmo tempo esperam a mesma pausa', async () => {
  const pauses: PauseReason[] = [];
  const rpc = createPausableRpc(dead(() => new RpcError('x: falha de rede ou tempo esgotado')), (r) => pauses.push(r));
  let resolved = 0;
  const ps = [1, 2, 3, 4].map((i) => rpc.call<string>('m', [i]).then((v) => { resolved++; return v; }));
  await tick();
  assert.equal(resolved, 0);
  assert.equal(rpc.paused(), 'network-down');
  assert.deepEqual(pauses, ['network-down']);
  rpc.replace(good('ok'));
  assert.deepEqual(await Promise.all(ps), ['ok', 'ok', 'ok', 'ok']);
  assert.deepEqual(pauses, ['network-down']);
});

test('pausável: stop rejeita com StopRequested, e chamadas novas também', async () => {
  const rpc = createPausableRpc(dead(quota), () => {});
  const p = rpc.call('m', []);
  const caught = p.catch((e) => e);
  await tick();
  rpc.stop();
  const e = await caught;
  assert.ok(e instanceof StopRequested);
  assert.ok(!(e instanceof RpcError));
  assert.equal((e as StopRequested).code, 'stopped-by-user');
  await assert.rejects(rpc.call('m', []), (x) => x instanceof StopRequested);
});

test('pausável: onPause que lança não derruba a chamada', async () => {
  const rpc = createPausableRpc(dead(quota), () => { throw new Error('boom'); });
  const p = rpc.call('m', []);
  await tick();
  rpc.replace(good(7));
  assert.equal(await p, 7);
});

// falha em vez de travar a suíte quando a promessa nunca resolve
const guard = <T>(p: Promise<T>, ms = 500) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('travou')), ms))]);

test('pausável: chamada em andamento no RPC antigo que falha depois do replace repete no novo, sem nova pausa', async () => {
  const pauses: PauseReason[] = [];
  const pending: Array<(e: Error) => void> = [];
  let n = 0;
  const old: RpcClient = {
    call() {
      if (++n === 1) return new Promise((_, rej) => pending.push(rej)) as never; // em andamento
      return Promise.reject(quota());
    },
  };
  const rpc = createPausableRpc(old, (r) => pauses.push(r));
  const inFlight = rpc.call('a', [1]); // no ar no cliente antigo
  const trigger = rpc.call('b', [2]); // falha e pausa
  await tick();
  assert.equal(rpc.paused(), 'rpc-quota');
  const next = good('novo');
  rpc.replace(next);
  pending[0](quota()); // a primeira só falha depois do replace
  assert.equal(await guard(inFlight), 'novo');
  assert.equal(await guard(trigger), 'novo');
  assert.deepEqual(pauses, ['rpc-quota']);
  assert.equal(rpc.paused(), null);
  assert.deepEqual(next.calls.map((c) => c[0]).sort(), ['a', 'b']);
});

test('pausável: chamada em andamento que falha DEPOIS do stop rejeita com StopRequested, sem pausar', async () => {
  const pauses: PauseReason[] = [];
  let fail!: (e: Error) => void;
  const inner: RpcClient = { call() { return new Promise((_, rej) => { fail = rej; }) as never; } };
  const rpc = createPausableRpc(inner, (r) => pauses.push(r));
  assert.equal(rpc.stopped(), false);
  const p = rpc.call('m', []);
  const caught = p.catch((e) => e);
  await tick();
  rpc.stop();
  assert.equal(rpc.stopped(), true);
  fail(quota());
  assert.ok((await guard(caught)) instanceof StopRequested);
  assert.deepEqual(pauses, []);
  assert.equal(rpc.paused(), null);
});
