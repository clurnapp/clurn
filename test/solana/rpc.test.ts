import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, isFatalRpcError, PUBLIC_RPC_LIMITS, RpcError, type RpcOptions } from '../../src/core/solana/rpc.ts';

const ok = () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 }), { status: 200 });

// Relógio falso: a espera avança o relógio até o horário pedido, sem esperar de verdade.
// As esperas andam uma de cada vez, e cada uma deixa a chamada anterior terminar antes de avançar.
function fakeClock() {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  let chain: Promise<void> = Promise.resolve();
  return (ms: number) => {
    const target = Date.now() + ms;
    chain = chain.then(async () => {
      await new Promise((r) => setImmediate(r));
      if (Date.now() < target) mock.timers.tick(target - Date.now());
    });
    return chain;
  };
}

// Maior número de chamadas do método em qualquer janela de 1 s.
function maxPerSecond(stamps: number[]): number {
  let max = 0;
  for (const t of stamps) max = Math.max(max, stamps.filter((s) => s >= t && s < t + 1000).length);
  return max;
}

// Maior número de chamadas em qualquer janela de `ms` (os limites do RPC público da Solana são por 10 s).
function maxPerWindow(stamps: number[], ms: number): number {
  let max = 0;
  for (const t of stamps) max = Math.max(max, stamps.filter((s) => s >= t && s < t + ms).length);
  return max;
}

type Plan = (call: (m: string) => Promise<unknown>, calls: { method: string; at: number }[]) => Promise<void>;

async function runWith(options: Omit<RpcOptions, 'url' | 'fetchImpl' | 'sleep'>, plan: Plan) {
  const sleep = fakeClock();
  try {
    const calls: { method: string; at: number }[] = [];
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      calls.push({ method: JSON.parse(init.body).method, at: Date.now() });
      return ok();
    }) as unknown as typeof fetch;
    const rpc = createRpc({ url: 'http://x', ...options, fetchImpl, sleep });
    await plan((m) => rpc.call(m, []), calls);
    return calls;
  } finally {
    mock.timers.reset();
  }
}

const runCalls = (requestsPerSecond: number, methodLimits: Record<string, number> | undefined, plan: Plan) => runWith({ requestsPerSecond, methodLimits }, plan);

async function burst(method: string, n: number, requestsPerSecond: number) {
  const sleep = fakeClock();
  try {
    const calls: { method: string; at: number }[] = [];
    const fetchImpl = (async (_u: unknown, init: { body: string }) => {
      calls.push({ method: JSON.parse(init.body).method, at: Date.now() });
      return ok();
    }) as unknown as typeof fetch;
    const rpc = createRpc({ url: 'http://x', requestsPerSecond, fetchImpl, sleep });
    const start = Date.now();
    await Promise.all(Array.from({ length: n }, () => rpc.call(method, [])));
    return { stamps: calls.map((c) => c.at), elapsed: Date.now() - start };
  } finally {
    mock.timers.reset();
  }
}

test('rpc: getProgramAccounts nunca passa de 4 numa janela de 1 s', async () => {
  const { stamps } = await burst('getProgramAccounts', 20, 50);
  assert.equal(stamps.length, 20);
  assert.ok(maxPerSecond(stamps) <= 4, `máximo ${maxPerSecond(stamps)}`);
});

test('rpc: sendTransaction no máximo 1 por segundo', async () => {
  const { stamps } = await burst('sendTransaction', 5, 50);
  assert.equal(stamps.length, 5);
  assert.ok(maxPerSecond(stamps) <= 1, `máximo ${maxPerSecond(stamps)}`);
});

test('rpc: o limite por método não segura os outros métodos', async () => {
  const { elapsed } = await burst('getBalance', 20, 50);
  assert.ok(elapsed < 1000, `levou ${elapsed} ms`);
});

const perMethod = (calls: { method: string; at: number }[], m: string) => calls.filter((c) => c.method === m).map((c) => c.at);

test('rpc: getBalance logo depois de 20 getProgramAccounts sai em menos de 1 s', async () => {
  let elapsed = -1;
  await runCalls(50, undefined, async (call) => {
    const gpa = Array.from({ length: 20 }, () => call('getProgramAccounts'));
    const t0 = Date.now();
    await call('getBalance');
    elapsed = Date.now() - t0;
    await Promise.all(gpa);
  });
  assert.ok(elapsed >= 0 && elapsed < 1000, `levou ${elapsed} ms`);
});

test('rpc: mistura de métodos respeita o total e cada limite, pelo horário real de envio', async () => {
  const calls = await runCalls(8, undefined, async (call) => {
    await Promise.all([
      ...Array.from({ length: 20 }, () => call('getProgramAccounts')),
      ...Array.from({ length: 20 }, () => call('getBalance')),
      ...Array.from({ length: 4 }, () => call('sendTransaction')),
    ]);
  });
  assert.equal(calls.length, 44);
  assert.ok(maxPerSecond(calls.map((c) => c.at)) <= 8, 'total');
  assert.ok(maxPerSecond(perMethod(calls, 'getProgramAccounts')) <= 4, 'gPA');
  assert.ok(maxPerSecond(perMethod(calls, 'sendTransaction')) <= 1, 'envio');
});

test('rpc: methodLimits se soma aos padrões', async () => {
  const calls = await runCalls(50, { getBalance: 5 }, async (call) => {
    await Promise.all([...Array.from({ length: 10 }, () => call('getProgramAccounts')), ...Array.from({ length: 10 }, () => call('getBalance'))]);
  });
  assert.ok(maxPerSecond(perMethod(calls, 'getProgramAccounts')) <= 4, 'gPA continua em 4');
  assert.ok(maxPerSecond(perMethod(calls, 'getBalance')) <= 5, 'getBalance em 5');
});

// ---------- RPC público da Solana: 100 req/10 s no total e 40 req/10 s por método, por IP ----------

test('rpc: defaultMethodLimit vale para qualquer método sem limite próprio', async () => {
  const calls = await runWith({ requestsPerSecond: 50, defaultMethodLimit: 3.5 }, async (call) => {
    await Promise.all(Array.from({ length: 40 }, () => call('getTokenAccountsByOwner')));
  });
  assert.equal(calls.length, 40);
  const stamps = calls.map((c) => c.at);
  assert.ok(maxPerSecond(stamps) <= 4, `máximo ${maxPerSecond(stamps)} em 1 s`);
  assert.ok(maxPerWindow(stamps, 10_000) <= 35, `máximo ${maxPerWindow(stamps, 10_000)} em 10 s`);
});

test('rpc: defaultMethodLimit segura cada método separado, não o conjunto', async () => {
  let elapsed = -1;
  await runWith({ requestsPerSecond: 50, defaultMethodLimit: 3.5 }, async (call) => {
    const slow = Array.from({ length: 20 }, () => call('getTokenAccountsByOwner'));
    const t0 = Date.now();
    await call('getMultipleAccounts');
    elapsed = Date.now() - t0;
    await Promise.all(slow);
  });
  assert.ok(elapsed >= 0 && elapsed < 1000, `getMultipleAccounts levou ${elapsed} ms atrás de 20 leituras de token`);
});

test('rpc: methodLimits explícito vence o defaultMethodLimit', async () => {
  const calls = await runWith({ requestsPerSecond: 50, defaultMethodLimit: 3.5, methodLimits: { getBalance: 10 } }, async (call) => {
    await Promise.all(Array.from({ length: 20 }, () => call('getBalance')));
  });
  const stamps = calls.map((c) => c.at);
  assert.ok(maxPerSecond(stamps) > 4 && maxPerSecond(stamps) <= 10, `máximo ${maxPerSecond(stamps)}`);
});

test('rpc: perfil do RPC público fica dentro dos limites oficiais com folga (80/10 s no total, 35/10 s por método, 1 envio/s)', async () => {
  const calls = await runWith(PUBLIC_RPC_LIMITS, async (call) => {
    await Promise.all([
      ...Array.from({ length: 60 }, () => call('getTokenAccountsByOwner')),
      ...Array.from({ length: 40 }, () => call('getProgramAccounts')),
      ...Array.from({ length: 40 }, () => call('getMultipleAccounts')),
      ...Array.from({ length: 30 }, () => call('simulateTransaction')),
      ...Array.from({ length: 5 }, () => call('sendTransaction')),
    ]);
  });
  assert.equal(calls.length, 175);
  const all = calls.map((c) => c.at);
  assert.ok(maxPerWindow(all, 10_000) <= 80, `total em 10 s: ${maxPerWindow(all, 10_000)}`);
  assert.ok(maxPerSecond(all) <= 8, `total em 1 s: ${maxPerSecond(all)}`);
  for (const m of ['getTokenAccountsByOwner', 'getProgramAccounts', 'getMultipleAccounts', 'simulateTransaction']) {
    assert.ok(maxPerWindow(perMethod(calls, m), 10_000) <= 35, `${m} em 10 s: ${maxPerWindow(perMethod(calls, m), 10_000)}`);
  }
  assert.ok(maxPerSecond(perMethod(calls, 'sendTransaction')) <= 1, 'envio');
});

// Sondado na mainnet em 30/10/2026: fora da documentação, o RPC público corta getTokenAccountsByOwner,
// getProgramAccounts, getSignaturesForAddress e getSignatureStatuses em 10 por 10 s ("Too many requests for a
// specific RPC call", retry-after 10), e as recusadas contam. A 0,9/s: 36 de 36 OK; a 1,2/s: 14 de 24 recusadas.
test('rpc: perfil público: os 4 métodos com corte escondido ficam em no máximo 9 por 10 s', async () => {
  const slow = ['getTokenAccountsByOwner', 'getProgramAccounts', 'getSignaturesForAddress', 'getSignatureStatuses'];
  const calls = await runWith(PUBLIC_RPC_LIMITS, async (call) => {
    await Promise.all(slow.flatMap((m) => Array.from({ length: 20 }, () => call(m))));
  });
  assert.equal(calls.length, 80);
  for (const m of slow) assert.ok(maxPerWindow(perMethod(calls, m), 10_000) <= 9, `${m} em 10 s: ${maxPerWindow(perMethod(calls, m), 10_000)}`);
});

test('rpc: perfil público: os 4 métodos lentos andam em paralelo entre si e não seguram os rápidos', async () => {
  let fast = -1;
  let slowElapsed = 0;
  await runWith(PUBLIC_RPC_LIMITS, async (call) => {
    const t0 = Date.now();
    const slow = Promise.all(['getTokenAccountsByOwner', 'getProgramAccounts', 'getSignaturesForAddress', 'getSignatureStatuses'].flatMap((m) => Array.from({ length: 9 }, () => call(m))));
    await call('getMultipleAccounts');
    fast = Date.now() - t0;
    await slow;
    slowElapsed = Date.now() - t0;
  });
  assert.ok(fast >= 0 && fast < 1000, `getMultipleAccounts levou ${fast} ms`);
  // 9 de cada um a 0,9/s: ~9 s em paralelo; em fila única seriam ~40 s
  assert.ok(slowElapsed < 12_000, `os 36 lentos levaram ${slowElapsed} ms`);
});

test('rpc: no perfil público, 175 chamadas misturadas levam o tempo da leitura de tokens a 0,9/s (~67 s), não mais', async () => {
  // (Que os lentos não seguram os rápidos está nos dois testes acima. Aqui, com o relógio falso, só o total é
  // confiável: uma espera longa pedida cedo adianta o relógio para as curtas pedidas depois.)
  let elapsed = 0;
  await runWith(PUBLIC_RPC_LIMITS, async (call) => {
    const t0 = Date.now();
    await Promise.all([
      ...Array.from({ length: 60 }, () => call('getTokenAccountsByOwner')),
      ...Array.from({ length: 40 }, () => call('getProgramAccounts')),
      ...Array.from({ length: 40 }, () => call('getMultipleAccounts')),
      ...Array.from({ length: 30 }, () => call('simulateTransaction')),
      ...Array.from({ length: 5 }, () => call('sendTransaction')),
    ]);
    elapsed = Date.now() - t0;
  });
  // 60 leituras de token a 0,9/s = 66 s; em fila única a 0,9/s seriam 194 s, a 3,5/s por método seriam 50 s
  assert.ok(elapsed > 60_000 && elapsed < 75_000, `levou ${elapsed} ms`);
});

test('rpc: erro JSON-RPC que ecoa a URL não leva a chave para a mensagem (tela, relatório, terminal)', async () => {
  const urls = [
    'https://mainnet.helius-rpc.com/?api-key=11111111-2222-3333-4444-555555555555',
    'https://rpc.exemplo.com/v1/abcdefghijklmnopqrstuvwxyz012345',
    'https://usuario:senhasecreta@rpc.exemplo.com/',
  ];
  for (const url of urls) {
    const secret = url.includes('api-key') ? '11111111-2222-3333-4444-555555555555' : url.includes('/v1/') ? 'abcdefghijklmnopqrstuvwxyz012345' : 'senhasecreta';
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: `invalid request to ${url} (key ${secret})` } }), { status: 200 })) as unknown as typeof fetch;
    const rpc = createRpc({ url, fetchImpl, sleep: async () => {}, retries: 0 });
    await assert.rejects(rpc.call('getAccountInfo', []), (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, -32602, 'o código continua');
      assert.ok(!e.message.includes(secret), `a chave saiu na mensagem: ${e.message}`);
      assert.match(e.message, /^getAccountInfo: invalid request to /);
      return true;
    });
  }
  // mensagem sem segredo passa igual (errors.ts procura o código da simulação no texto)
  const plain = 'Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1772';
  const fetchImpl = (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: plain } }), { status: 200 })) as unknown as typeof fetch;
  const rpc = createRpc({ url: 'https://mainnet.helius-rpc.com/?api-key=11111111-2222-3333-4444-555555555555', fetchImpl, sleep: async () => {}, retries: 0 });
  await assert.rejects(rpc.call('sendTransaction', []), (e: unknown) => e instanceof RpcError && e.message === `sendTransaction: ${plain}`);
});

test('rpc: 429 com "max usage reached" vira kind quota sem nova tentativa', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}', { status: 429 });
  }) as unknown as typeof fetch;
  const rpc = createRpc({ url: 'http://x/?api-key=segredo', fetchImpl, sleep: async () => {} });
  await assert.rejects(rpc.call('getBalance', []), (e: unknown) => {
    assert.ok(e instanceof RpcError);
    assert.equal(e.kind, 'quota');
    assert.ok(!e.message.includes('segredo') && !/max usage/i.test(e.message), 'o corpo não vai para a mensagem');
    return true;
  });
  assert.equal(calls, 1);
});

test('rpc: 429 comum continua tentando', async () => {
  let calls = 0;
  const fetchImpl = (async () => (++calls === 1 ? new Response('slow down', { status: 429 }) : ok())) as unknown as typeof fetch;
  const rpc = createRpc({ url: 'http://x', fetchImpl, sleep: async () => {} });
  assert.equal(await rpc.call('getBalance', []), 1);
  assert.equal(calls, 2);
});

test('rpc: isFatalRpcError', () => {
  const quota = new RpcError('x', 429, undefined, 'quota');
  assert.equal(isFatalRpcError(quota), true);
  assert.equal(isFatalRpcError(new RpcError('rede')), true);
  assert.equal(isFatalRpcError(new RpcError('x', 429)), true);
  assert.equal(isFatalRpcError(new RpcError('x', 503)), true);
  assert.equal(isFatalRpcError(new RpcError('x', -32602)), false);
  assert.equal(isFatalRpcError(new RpcError('x', -32005)), true);
  assert.equal(isFatalRpcError(new Error()), false);
});

test('rpc: com o temporizador adiantando as esperas, nunca passa de requestsPerSecond envios em 1 s', async () => {
  // jitter: cada espera termina 30 ms ANTES do pedido (como esperas juntadas pelo temporizador)
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    let chain: Promise<void> = Promise.resolve();
    const sleep = (ms: number) => {
      const target = Date.now() + (ms > 30 ? ms - 30 : ms); // sempre anda, para o relógio falso não travar
      chain = chain.then(async () => {
        await new Promise((r) => setImmediate(r));
        if (Date.now() < target) mock.timers.tick(target - Date.now());
      });
      return chain;
    };
    const stamps: number[] = [];
    const fetchImpl = (async () => {
      stamps.push(Date.now());
      return ok();
    }) as unknown as typeof fetch;
    const rpc = createRpc({ url: 'http://x', requestsPerSecond: 8, fetchImpl, sleep });
    await Promise.all(Array.from({ length: 60 }, () => rpc.call('getBalance', [])));
    assert.equal(stamps.length, 60);
    assert.ok(maxPerSecond(stamps) <= 8, `máximo ${maxPerSecond(stamps)} num segundo`);
  } finally {
    mock.timers.reset();
  }
});
