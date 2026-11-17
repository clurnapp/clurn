// Peças falsas do Workers para os testes do proxy: armazenamento do Durable Object, o namespace COTAS e o upstream.

import { Cotas, type CotasStorage } from '../../proxy/cotas.ts';
import { handle, type Deps, type Env } from '../../proxy/worker.ts';

export const SECRET = 'CHAVE-SUPER-SECRETA-123';
export const UPSTREAM = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;
export const VERSION = '0.2.4';

export function memStorage() {
  const data = new Map<string, unknown>();
  const alarms: number[] = [];
  let deletes = 0;
  const storage: CotasStorage = {
    get: async (k) => data.get(k),
    list: async () => new Map(data),
    put: async (entries) => {
      if (Object.keys(entries).length > 128) throw new Error('put com mais de 128 chaves');
      for (const [k, v] of Object.entries(entries)) data.set(k, v);
    },
    deleteAll: async () => {
      deletes++;
      data.clear();
    },
    setAlarm: async (t) => {
      alarms.push(t);
    },
  };
  return { storage, data, alarms, deletes: () => deletes };
}

// O namespace COTAS com UM objeto (o "global"), como no Workers.
export function cotasNamespace(cotas: Cotas, fail = false): NonNullable<Env['COTAS']> {
  return {
    idFromName: (n: string) => n,
    get: () => ({
      fetch: async (input: Request | string, init?: RequestInit) => {
        if (fail) throw new Error('objeto fora do ar');
        return cotas.fetch(new Request(input, init));
      },
    }),
  };
}

export type UpCall = { url: string; body: string; headers: Record<string, string> };

// Upstream falso: guarda cada chamada e responde com `reply` (padrão: resultado 1).
export function fakeUpstream(reply: (body: string) => Response | Promise<Response> = () => new Response('{"jsonrpc":"2.0","id":1,"result":1}', { status: 200, headers: { 'content-type': 'application/json' } })) {
  const calls: UpCall[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    calls.push({ url: String(url), body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    return reply(body);
  }) as typeof fetch;
  return { fetch: f, calls };
}

export type World = ReturnType<typeof makeWorld>;

export function makeWorld(over: Partial<Env> = {}, opts: { reply?: Parameters<typeof fakeUpstream>[0]; cotasFail?: boolean } = {}) {
  const mem = memStorage();
  const cotas = new Cotas({ storage: mem.storage });
  const up = fakeUpstream(opts.reply);
  let clock = Date.UTC(2026, 10, 9, 12, 0, 0);
  const env: Env = { UPSTREAM_URL: UPSTREAM, COTAS: cotasNamespace(cotas, opts.cotasFail), ...over };
  const deps: Deps = { now: () => clock, fetch: up.fetch };
  return {
    mem,
    cotas,
    up,
    env,
    deps,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
    send: (r: Request) => handle(r, env, deps),
  };
}

export function rpcRequest(body: unknown, headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request('https://clurn-rpc.exemplo.workers.dev/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-clurn-versao': VERSION, 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

export const call = (method: string, params: unknown[] = [], id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

export async function json(res: Response): Promise<{ status: number; body: any; text: string; headers: Record<string, string> }> {
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    // não é JSON
  }
  return { status: res.status, body, text, headers: Object.fromEntries(res.headers.entries()) };
}
