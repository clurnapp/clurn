// Cliente JSON-RPC mínimo para Solana, com limite de requisições por segundo e novas tentativas.
//
// A URL pode conter chave de API (Helius etc.): ela nunca entra em mensagem de erro nem em log.

export class RpcError extends Error {
  readonly code: number | undefined;
  readonly retryAfterMs: number | undefined;
  // 'quota': créditos do provedor esgotados (429 "max usage reached"); esperar não adianta
  readonly kind: 'quota' | 'other';
  constructor(message: string, code?: number, retryAfterMs?: number, kind: 'quota' | 'other' = 'other') {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
  }
}

// Erro que não é de uma conta só: créditos esgotados, rede/tempo, 429 ou servidor fora do ar.
// Erro JSON-RPC (código negativo que não é -32005) é da chamada, não do RPC.
export function isFatalRpcError(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  if (e.kind === 'quota') return true;
  if (e.code === undefined) return true;
  return e.code === 429 || e.code >= 500 || e.code === -32005; // -32005: limite do nó que sobrou depois das tentativas
}

// Erros JSON-RPC passageiros do nó (a mesma consulta dá certo logo depois): erro interno, nó atrasado em relação ao
// slot pedido, bloco ou status ainda indisponível. Antes não eram repetidos e a carteira entrava pela metade na 1ª
// passada (relato dos amigos do autor, 31/10/2026: a 2ª análise achava o que a 1ª não achou). Repetidos como o 429.
// Erro de parâmetro (-32602) e de método (-32601) continuam sem repetir: são da chamada, não do momento.
export const TRANSIENT_RPC_CODES = new Set([-32603, -32016, -32004, -32014]);

// Limite por método (req/s), além do limite geral.
export const DEFAULT_METHOD_LIMITS: Record<string, number> = { getProgramAccounts: 4, sendTransaction: 1 };

// RPC público da Solana (api.mainnet.solana.com, api.devnet.solana.com), limites por IP da documentação oficial
// (solana.com/docs/references/clusters, conferida em 30/10/2026): 100 requisições por 10 s no total e 40 por 10 s
// de CADA método. Usamos 8/s no total (80 por 10 s) e 3,5/s por método (35 por 10 s): folga para o jitter do
// temporizador e para outra aba no mesmo IP.
// Fora da documentação, SONDADO na mainnet em 30/10/2026 (scratch sondar-429*.ts; docs/aprendizados.md): quatro
// métodos têm corte próprio de 10 por 10 s, "Too many requests for a specific RPC call" com retry-after 10, e as
// recusadas contam (a 1,2/s: 14 de 24 recusadas; a 0,9/s: 36 de 36 OK). getAccountInfo, getMultipleAccounts,
// getLatestBlockhash, getBlockHeight e getRecentPrioritizationFees passaram a 3/s. Cada 429 custa 10 s de espera,
// por isso esses quatro ficam em 0,9/s: a leitura de tokens (2 por carteira) dá o piso de ~2,2 s por carteira.
export const PUBLIC_RPC_LIMITS = {
  requestsPerSecond: 8,
  defaultMethodLimit: 3.5,
  methodLimits: { getTokenAccountsByOwner: 0.9, getProgramAccounts: 0.9, getSignaturesForAddress: 0.9, getSignatureStatuses: 0.9 },
} as const;

export type RpcClient = {
  call<T>(method: string, params: unknown[]): Promise<T>;
};

export type RpcOptions = {
  url: string;
  requestsPerSecond?: number;
  methodLimits?: Record<string, number>;
  // limite (req/s) de qualquer método sem entrada em methodLimits; sem ele, só o limite geral
  defaultMethodLimit?: number;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
  // cabeçalhos extras em toda requisição (só o proxy do Clurn recebe: a versão do app, nunca segredo)
  headers?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  // chamado antes de cada espera de nova tentativa (rede lenta ou limite do nó)
  onRetry?: (info: { attempt: number; waitMs: number; code: number | undefined }) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Pedaços da URL do RPC que podem ser a chave (consulta, valores, segmentos longos do caminho, usuário e senha).
// Mesma ideia do proxy (proxy/worker.ts, secretParts), repetida aqui para o núcleo não depender do proxy.
export function urlSecretParts(url: string): string[] {
  const parts = new Set<string>([url]);
  try {
    const u = new URL(url);
    for (const s of [u.host + u.pathname + u.search, u.pathname + u.search, u.search, u.search.slice(1)]) if (s.length >= 8) parts.add(s);
    for (const v of u.searchParams.values()) if (v.length >= 8) parts.add(v);
    for (const seg of u.pathname.split('/')) if (seg.length >= 16) parts.add(seg);
    if (u.username.length >= 4) parts.add(u.username);
    if (u.password.length >= 4) parts.add(u.password);
  } catch {
    // URL inválida: fica só ela inteira
  }
  return [...parts].sort((a, b) => b.length - a.length); // o maior primeiro: não sobra pedaço de um maior
}

// A mensagem de erro que o nó devolve vai para a tela, o relatório e o terminal: um nó que ecoe a URL (com a chave)
// não pode levar a chave junto. Troca cada pedaço secreto por "***" e corta um texto absurdo (o código do erro da
// simulação, que errors.ts procura, vem no começo).
export function scrubRpcMessage(message: string, secrets: string[]): string {
  let out = message.slice(0, 2000);
  for (const s of secrets) if (s) out = out.split(s).join('***');
  return out;
}

export function createRpc(options: RpcOptions): RpcClient {
  const { url, requestsPerSecond = 8, timeoutMs = 30_000, retries = 6 } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const secrets = urlSecretParts(url);
  const interval = 1000 / requestsPerSecond;
  const methodLimits = { ...DEFAULT_METHOD_LIMITS, ...options.methodLimits };
  const methodNext = new Map<string, number>(); // próximo horário livre de cada método (do envio real)
  const methodQueue = new Map<string, Promise<void>>(); // fila de cada método, em ordem de chegada
  let nextSlot = 0;
  let id = 0;
  // Janela deslizante sobre os envios REAIS: nunca mais que requestsPerSecond envios em qualquer 1000 ms.
  // Os horários da fila (nextSlot) espaçam os envios, mas o temporizador atrasa ou junta esperas (jitter) e
  // chegaria a 9-10 num segundo; o Helius grátis corta em 10/s. Aqui o limite vale pelo horário em que saiu.
  const maxPerWindow = Math.max(1, Math.floor(requestsPerSecond));
  const sentAt: number[] = [];
  async function windowGate(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (sentAt.length > 0 && sentAt[0] <= now - 1000) sentAt.shift();
      if (sentAt.length < maxPerWindow) {
        sentAt.push(now); // confere e registra sem await no meio
        return;
      }
      await sleep(Math.max(1, sentAt[0] + 1000 - now));
    }
  }

  // Pega o horário de envio na fila geral e já marca o próximo do método, tudo de uma vez (sem await no meio).
  function claim(method: string, limit: number | undefined): number {
    const slot = Math.max(Date.now(), nextSlot);
    nextSlot = slot + interval;
    if (limit) methodNext.set(method, slot + 1000 / limit);
    return slot;
  }

  // Espera a vez do método e só depois pega a vez na fila geral: um método lento
  // (ex.: getProgramAccounts) não ocupa horários da fila geral que outros métodos poderiam usar.
  async function claimWhenMethodFree(method: string, limit: number): Promise<number> {
    for (;;) {
      const wait = (methodNext.get(method) ?? 0) - Date.now();
      if (wait <= 0) return claim(method, limit);
      await sleep(wait);
    }
  }

  async function waitTurn(method: string) {
    const limit = methodLimits[method] ?? options.defaultMethodLimit;
    if (!limit) {
      const wait = claim(method, undefined) - Date.now();
      if (wait > 0) await sleep(wait);
      await windowGate();
      return;
    }
    // a fila do método só anda quando o envio anterior saiu de verdade; o próximo horário
    // do método conta a partir do envio real (se a espera atrasou, o próximo atrasa junto)
    const turn = (methodQueue.get(method) ?? Promise.resolve()).then(async () => {
      const wait = (await claimWhenMethodFree(method, limit)) - Date.now();
      if (wait > 0) await sleep(wait);
      await windowGate();
      methodNext.set(method, Math.max(methodNext.get(method) ?? 0, Date.now() + 1000 / limit));
    });
    methodQueue.set(method, turn.catch(() => {}));
    await turn;
  }

  async function once<T>(method: string, params: unknown[]): Promise<T> {
    await waitTurn(method);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RpcError(`${method}: falha de rede ou tempo esgotado`);
    }
    if (!res.ok) {
      if (res.status === 429) {
        // o corpo só é lido para achar o aviso de créditos; nunca vai para a mensagem (pode ecoar a URL)
        let text = '';
        try {
          text = (await res.text()).slice(0, 2048);
        } catch {
          // corpo ilegível: trata como 429 comum
        }
        if (/max usage/i.test(text)) throw new RpcError(`${method}: créditos do RPC esgotados`, 429, undefined, 'quota');
      }
      const after = Number(res.headers.get('retry-after'));
      throw new RpcError(`${method}: HTTP ${res.status}`, res.status, after > 0 ? Math.min(after, 60) * 1000 : undefined);
    }
    let body: { result?: T; error?: { code?: number; message?: string } };
    try {
      body = await res.json();
    } catch {
      throw new RpcError(`${method}: resposta não é JSON`);
    }
    if (body.error) {
      const raw = typeof body.error.message === 'string' && body.error.message ? body.error.message : 'erro do RPC';
      throw new RpcError(`${method}: ${scrubRpcMessage(raw, secrets)}`, body.error.code);
    }
    if (!('result' in body)) throw new RpcError(`${method}: resposta sem result`);
    return body.result as T;
  }

  function retryable(e: unknown): boolean {
    if (!(e instanceof RpcError)) return false;
    if (e.kind === 'quota') return false; // esgotou os créditos: tentar de novo só gasta tempo
    if (e.code === undefined) return true; // rede, tempo, JSON quebrado
    return e.code === 429 || e.code >= 500 || e.code === -32005 /* limite do nó */ || TRANSIENT_RPC_CODES.has(e.code);
  }

  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once<T>(method, params);
        } catch (e) {
          if (attempt >= retries || !retryable(e)) throw e;
          // espera o que o servidor pediu, ou 1s, 2s, 4s… (no máximo 30s)
          const backoff = Math.min(1000 * 2 ** attempt, 30_000);
          const waitMs = Math.max(backoff, (e as RpcError).retryAfterMs ?? 0);
          // só números: a URL (que pode ter chave) nunca vai para quem escuta
          options.onRetry?.({ attempt, waitMs, code: (e as RpcError).code });
          await sleep(waitMs);
        }
      }
    },
  };
}

// Descrição segura do RPC para mostrar ao usuário (sem caminho nem chave).
export function describeRpc(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'RPC personalizado';
  }
}
