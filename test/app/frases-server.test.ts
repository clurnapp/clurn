// Servidor com várias frases: estado por frase, análise em sequência, seeds apagadas, nada de frase saindo.
// RPC, preços e outras redes são falsos (sem rede). As frases saem de entropia fixa: públicas, nunca reais.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import * as sv from '../../src/app/server.ts';
import { addressAt, burnerPath, deriveBurner, deriveMainAddress, derivePrivateKey, mnemonicToSeed, publicKeyFromPrivate, standardPath, trustPath, type WalletApp } from '../../src/core/carteiras/derivation.ts';
import { PROGRAMS, pumpCreatorVault } from '../../src/core/solana/pda.ts';
import { evmAddress } from '../../src/core/evm/evm.ts';
import { FeePayerError } from '../../src/core/limpeza/plan.ts';
import { PUBLIC_RPC_LIMITS, RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { TOKEN_API } from '../../src/core/limpeza/prices.ts';
import { curveAddress } from '../../src/core/limpeza/curve-price.ts';
import { estimateRun, RUN_COSTS } from '../../src/app/eta.ts';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';
import { FUND_TX_FEE_LAMPORTS } from '../../src/core/limpeza/funding.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';
import { GENESIS_HASH } from '../../src/core/solana/rpc-check.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.pastedKeys = true;
FEATURES.trustPath = true;

const ROOT = path.join(import.meta.dirname, '..', '..');
const TOKEN = 'codigo-de-teste-frases';
const DEST = deriveBurner(mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow'), 7, 'solflare').address;

// ---------- frases de teste (entropia fixa) ----------

const WORDS = fs.readFileSync(path.join(ROOT, 'src', 'core', 'carteiras', 'bip39-english.txt'), 'utf8').split('\n').filter(Boolean);
function mnemonicOf(entropy: Buffer): string {
  const cs = createHash('sha256').update(entropy).digest();
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('') + cs[0].toString(2).padStart(8, '0').slice(0, entropy.length / 4);
  return bits.match(/.{11}/g)!.map((b) => WORDS[parseInt(b, 2)]).join(' ');
}
// Palavra que já existe no código (nome de campo, texto em português) apareceria na saída por coincidência:
// as frases de teste usam só palavras de 5+ letras que não estão no código, para a busca não dar falso alarme.
const SOURCE_WORDS = new Set(
  ['app', 'core', 'cli'].flatMap((d) =>
    // recursive: o núcleo fica em subpastas (carteiras, solana, limpeza, evm)
    fs.readdirSync(path.join(ROOT, 'src', d), { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).flatMap((f) => fs.readFileSync(path.join(ROOT, 'src', d, f), 'utf8').toLowerCase().split(/[^a-z]+/)),
  ),
);
const PHRASES: string[] = [];
for (let k = 0; PHRASES.length < 10; k++) {
  const p = mnemonicOf(createHash('sha256').update(`clurn-teste-frase-${k}`).digest().subarray(0, 16));
  if (p.split(' ').every((w) => w.length < 5 || !SOURCE_WORDS.has(w))) PHRASES.push(p);
}
const LONG_WORDS = [...new Set(PHRASES.flatMap((p) => p.split(' ')).filter((w) => w.length >= 5))];
const seedOf = (p: string) => mnemonicToSeed(p);

// ---------- rede falsa ----------

type World = {
  used: Set<string>;
  lamports: Map<string, number>;
  tokens: Map<string, unknown[]>;
  failSigs: Set<string>; // getSignaturesForAddress devolve erro JSON-RPC
  failTokens: Set<string>; // getTokenAccountsByOwner devolve erro JSON-RPC
  gate: { addrs: Set<string>; wait: Promise<void> } | null;
  gate2: { addrs: Set<string>; wait: Promise<void> } | null;
  sigCalls: string[];
  failMethods: Set<string>; // método recusado pelo RPC (erro JSON-RPC)
  failAfter: Map<string, number>; // método que responde N vezes e depois falha
  calls: Map<string, number>;
  simKeys: string[][]; // contas de cada transação simulada
  badStatus: Set<string>; // envio que tira SOL desta carteira: a rede responde erro na confirmação (passo 'falhou')
  badSigs: Set<string>;
  splitFail: Set<string>; // lote de contas de token desta carteira (mais de uma) falha na simulação: o executor refaz conta por conta
  tamper: Set<string>; // passo desta carteira: a simulação mostra 1 lamport a mais no destino (resultado inesperado)
  // ---- pausa por RPC: o RPC "antigo" morre de vez (toda chamada falha), o "novo" segue respondendo ----
  deadKind: 'quota' | 'down' | null; // antigo morto: 429 de créditos esgotados ou 503
  dieOnSig: Set<string>; // getSignaturesForAddress deste endereço mata o antigo (créditos esgotados)
  dieOnTokens: Set<string>; // getTokenAccountsByOwner desta carteira mata o antigo (503)
  dieAfterSend: Set<string>; // envio que tira SOL desta carteira: aceito, e DEPOIS o antigo morre (503); a assinatura some para o novo
  lostSigs: Set<string>; // assinaturas que o RPC novo não acha
  sent: Array<{ from: string[]; signature: string }>; // todo sendTransaction (nos dois RPCs)
  novoCalls: string[]; // métodos chamados no RPC novo
  dieOnSim: Set<string>; // simulateTransaction do passo desta carteira mata o antigo (503)
  novoGate: Promise<void> | null; // o RPC novo segura toda chamada até o teste deixar (checkRpc lento)
  curves: Map<string, Buffer>; // conta BondingCurve da Pump.fun (endereço → conta inteira), lida com dataSlice
  applySends: boolean; // o envio move o saldo (transferências + 5 000 da taxa do pagador), menos o que badStatus recusa
  genesis: string | null; // hash de gênese que o RPC falso devolve (null = o da rede da rodada)
};
const world: World = { used: new Set(), lamports: new Map(), tokens: new Map(), failSigs: new Set(), failTokens: new Set(), gate: null, gate2: null, sigCalls: [], failMethods: new Set(), failAfter: new Map(), calls: new Map(), simKeys: [], tamper: new Set(), badStatus: new Set(), badSigs: new Set(), splitFail: new Set(), deadKind: null, dieOnSig: new Set(), dieOnTokens: new Set(), dieAfterSend: new Set(), lostSigs: new Set(), sent: [], novoCalls: [], dieOnSim: new Set(), novoGate: null, curves: new Map(), applySends: false, genesis: null };
function resetWorld() {
  world.deadKind = null;
  world.genesis = null;
  world.dieOnSig.clear();
  world.dieOnTokens.clear();
  world.dieAfterSend.clear();
  world.lostSigs.clear();
  world.sent.length = 0;
  world.novoCalls.length = 0;
  world.dieOnSim.clear();
  world.novoGate = null;
  nextClient = fakeRpc;
  factoryOpts.length = 0;
  world.used.clear();
  world.lamports.clear();
  world.tokens.clear();
  world.failSigs.clear();
  world.failTokens.clear();
  world.gate = null;
  world.gate2 = null;
  world.sigCalls.length = 0;
  world.failMethods.clear();
  world.failAfter.clear();
  world.calls.clear();
  world.simKeys.length = 0;
  world.tamper.clear();
  world.badStatus.clear();
  world.badSigs.clear();
  world.splitFail.clear();
  world.curves.clear();
  world.applySends = false;
  priceMode = 'empty';
}

// transação legada: contas e transferências de SOL (System Program, instrução 2: u32 LE 2 + u64 LE lamports)
function decodeTx(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  const msg = raw.subarray(1 + 64 * raw[0]);
  const nKeys = msg[3];
  const names = Array.from({ length: nKeys }, (_, i) => encodeBase58(msg.subarray(4 + 32 * i, 36 + 32 * i)));
  let pos = 4 + 32 * nKeys + 32;
  const transfers: Array<{ from: string; to: string; lamports: bigint }> = [];
  let tokenIxs = 0;
  const nIx = msg[pos++];
  for (let i = 0; i < nIx; i++) {
    const program = names[msg[pos++]];
    const accounts = [...msg.subarray(pos + 1, pos + 1 + msg[pos])].map((k) => names[k]);
    pos += 1 + msg[pos];
    const data = Buffer.from(msg.subarray(pos + 1, pos + 1 + msg[pos]));
    pos += 1 + msg[pos];
    if (program === PROGRAMS.system && data.length === 12 && data.readUInt32LE(0) === 2) transfers.push({ from: accounts[0], to: accounts[1], lamports: data.readBigUInt64LE(4) });
    if (program === PROGRAMS.token) tokenIxs++;
  }
  return { names, transfers, tokenIxs, sigs: raw[0], signature: encodeBase58(raw.subarray(1, 65)) };
}

// RPC morto de vez: erro fatal (isFatalRpcError) que o pausável transforma em pausa
const quotaError = (method: string) => new RpcError(`${method}: créditos do RPC esgotados`, 429, undefined, 'quota');
const downError = (method: string) => new RpcError(`${method}: HTTP 503`, 503);
const NEW_BLOCKHASH = encodeBase58(Buffer.alloc(32, 2)); // blockhash diferente no RPC novo: remontar daria OUTRA assinatura

// dois clientes sobre a mesma rede: o "antigo" (da análise) pode morrer; o "novo" entra pelo /api/trocar-rpc
function makeClient(client: 'antigo' | 'novo'): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = await (async (): Promise<unknown> => {
      if (client === 'novo') {
        world.novoCalls.push(method);
        if (world.novoGate) await world.novoGate;
      }
      if (client === 'antigo' && world.deadKind) throw world.deadKind === 'quota' ? quotaError(method) : downError(method);
      const k = (world.calls.get(method) ?? 0) + 1;
      world.calls.set(method, k);
      if (world.failMethods.has(method)) throw new RpcError(`${method}: bloqueado`, -32601);
      if (world.failAfter.has(method) && k > world.failAfter.get(method)!) throw new RpcError(`${method}: falhou`, -32603);
      switch (method) {
        case 'getMinimumBalanceForRentExemption':
          return 890_880;
        case 'getGenesisHash': // trava de rede: o falso é sempre da rede da rodada (world.genesis força outra)
          return world.genesis ?? GENESIS_HASH[sv.sessionForTest().cluster];
        case 'getSignaturesForAddress': {
          const a = params[0] as string;
          world.sigCalls.push(a);
          if (world.gate?.addrs.has(a)) await world.gate.wait;
          if (world.gate2?.addrs.has(a)) await world.gate2.wait;
          if (world.failSigs.has(a)) throw new RpcError('Invalid params', -32602);
          if (client === 'antigo' && world.dieOnSig.has(a)) {
            world.deadKind = 'quota';
            throw quotaError(method);
          }
          return world.used.has(a) ? [{ signature: 'x' }] : [];
        }
        case 'getTokenAccountsByOwner': {
          const [owner, filter] = params as [string, { programId: string }];
          if (world.failTokens.has(owner)) throw new RpcError('Invalid params', -32602);
          if (client === 'antigo' && world.dieOnTokens.has(owner)) {
            world.deadKind = 'down';
            throw downError(method);
          }
          return { value: filter.programId === PROGRAMS.token ? (world.tokens.get(owner) ?? []) : [] };
        }
        case 'getMultipleAccounts': {
          // saldo de quem tem; curvas da Pump.fun pelo trecho pedido; cofres e o resto não existem (null)
          const slice = (params[1] as { dataSlice?: { offset: number; length: number } } | undefined)?.dataSlice;
          return {
            value: (params[0] as string[]).map((k) => {
              const c = world.curves.get(k);
              if (c) return { lamports: 1, data: [(slice ? c.subarray(slice.offset, slice.offset + slice.length) : c).toString('base64'), 'base64'] };
              if (world.lamports.has(k)) return { lamports: world.lamports.get(k) };
              // conta de token que a varredura achou continua existindo (o executor lê o saldo de agora antes de queimar)
              for (const list of world.tokens.values()) {
                const t = (list as Array<{ pubkey: string; account: unknown }>).find((x) => x.pubkey === k);
                if (t) return t.account;
              }
              return null;
            }),
          };
        }
        case 'getProgramAccounts':
          return [];
        // ---- simulação e envio (rede falsa): saldo depois = saldo + transferências da transação ----
        case 'getAccountInfo': {
          const a = params[0] as string;
          return { value: world.lamports.has(a) ? { owner: PROGRAMS.system, lamports: world.lamports.get(a), executable: false } : null };
        }
        case 'getRecentPrioritizationFees':
          return [];
        case 'getLatestBlockhash':
          return { value: { blockhash: client === 'novo' ? NEW_BLOCKHASH : '11111111111111111111111111111111', lastValidBlockHeight: 100 } };
        case 'simulateTransaction': {
          const { names, transfers, tokenIxs, sigs } = decodeTx(params[0] as string);
          world.simKeys.push(names);
          const watched = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          if (client === 'antigo' && world.dieOnSim.has(watched[1])) {
            world.deadKind = 'down';
            throw downError(method);
          }
          if (tokenIxs > 1 && world.splitFail.has(watched[1])) return { value: { err: { InstructionError: [0, 'x'] }, logs: ['Program failed: lote'], accounts: null } };
          const delta = new Map<string, bigint>();
          for (const t of transfers) {
            delta.set(t.from, (delta.get(t.from) ?? 0n) - t.lamports);
            delta.set(t.to, (delta.get(t.to) ?? 0n) + t.lamports);
          }
          // a taxa sai do pagador (primeira conta), 5 000 por assinatura; como na rede de verdade, conta que perde SOL e
          // fica entre 0 e o aluguel de conta vazia é recusada (InsufficientFundsForRent)
          const paid = new Map(delta);
          paid.set(names[0], (paid.get(names[0]) ?? 0n) - 5_000n * BigInt(sigs));
          for (const [a, dl] of paid) {
            const post = BigInt(world.lamports.get(a) ?? 0) + dl;
            if (dl < 0n && post > 0n && post < 890_880n) return { value: { err: { InsufficientFundsForRent: { account_index: names.indexOf(a) } }, logs: ['insufficient funds for rent'], accounts: null } };
          }
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          const tamper = world.tamper.has(addrs[1]); // [destino, carteira do passo, taxa do app]
          const after = addrs.map((a, i) => ({ lamports: Number(BigInt(world.lamports.get(a) ?? 0) + (delta.get(a) ?? 0n)) + (tamper && i === 0 ? 1 : 0) }));
          return { value: { err: null, logs: [], unitsConsumed: 3_000, accounts: after } };
        }
        case 'sendTransaction': {
          const { names, transfers, signature } = decodeTx(params[0] as string);
          world.sent.push({ from: transfers.map((t) => t.from), signature });
          if (transfers.some((t) => world.badStatus.has(t.from))) world.badSigs.add(signature);
          else if (world.applySends) {
            for (const t of transfers) {
              world.lamports.set(t.from, Number(BigInt(world.lamports.get(t.from) ?? 0) - t.lamports));
              world.lamports.set(t.to, Number(BigInt(world.lamports.get(t.to) ?? 0) + t.lamports));
            }
            world.lamports.set(names[0], (world.lamports.get(names[0]) ?? 0) - 5_000); // a taxa, do pagador (primeira conta)
          }
          if (transfers.some((t) => world.dieAfterSend.has(t.from))) {
            // a rede aceitou o envio; a confirmação é que não vem mais (o antigo morre agora)
            world.deadKind = 'down';
            world.lostSigs.add(signature);
          }
          return signature;
        }
        case 'getSignatureStatuses': {
          const sig = (params[0] as string[])[0];
          if (client === 'novo' && world.lostSigs.has(sig)) return { value: [null] }; // o RPC novo não acha
          return { value: [world.badSigs.has(sig) ? { err: { InstructionError: [1, 'x'] } } : { err: null, confirmationStatus: 'confirmed' }] };
        }
        case 'getBlockHeight':
          return client === 'novo' ? 50 : 1000; // no novo, o blockhash ainda vale (50 ≤ 100): não é "expirou"
        default:
          throw new RpcError(`${method}: sem handler no teste`, -32601);
      }
    })();
    return r as T;
    },
  };
}
const fakeRpc = makeClient('antigo');
const newRpc = makeClient('novo');
// o que o servidor pede ao criar um cliente (URL e limite); `nextClient` é o que a fábrica devolve
type OnRetry = ((info: { attempt: number; waitMs: number; code: number | undefined }) => void) | undefined;
const factoryOpts: Array<{ url: string; rps: number | undefined; porMetodo: number | undefined; onRetry: OnRetry; headers?: Record<string, string> }> = [];
const factoryCalls = () => factoryOpts.map((o) => ({ url: o.url, rps: o.rps, porMetodo: o.porMetodo }));
let nextClient: RpcClient | ((url: string) => RpcClient) = fakeRpc;

const HISTORY_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-creditos-')), 'creditos.json');

let priceCalls = 0;
// 'empty': API sem nada; 'priced': todo mint pedido vale US$ 1; 'fail': HTTP 500
let priceMode: 'empty' | 'priced' | 'fail' = 'empty';
const fakeFetch = (async (url: string | URL) => {
  if (String(url).startsWith(TOKEN_API)) priceCalls++;
  if (priceMode === 'fail') return new Response('x', { status: 500 });
  const ids = priceMode === 'priced' ? (new URL(String(url)).searchParams.get('query') ?? '').split(',') : [];
  return new Response(JSON.stringify(ids.map((id) => ({ id, usdPrice: 1 }))), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

let tokenSeq = 0;
function fungible(owner: string, mint: string) {
  tokenSeq++;
  return {
    pubkey: `TokAcc${String(tokenSeq).padStart(38, '1')}`,
    account: { lamports: 2_039_280, data: { parsed: { info: { mint, owner, state: 'initialized', tokenAmount: { amount: '5000000', decimals: 6 } } } } },
  };
}

// carteiras 0..k-1 usadas, com saldo
function useWallets(phrase: string, app: WalletApp, indexes: number[], lamports = 50_000_000) {
  const seed = seedOf(phrase);
  const out = indexes.map((i) => deriveBurner(seed, i, app).address);
  for (const a of out) {
    world.used.add(a);
    world.lamports.set(a, lamports);
  }
  return out;
}
function addressesOf(phrase: string, app: WalletApp, upTo = 40) {
  const seed = seedOf(phrase);
  return Array.from({ length: upTo }, (_, i) => deriveBurner(seed, i, app).address);
}

// ---------- servidor + cliente SSE ----------

let server: http.Server;
let port = 0;
let sse: http.ClientRequest;
const events: Array<{ type: string; data: string }> = [];
const bodies: string[] = []; // todas as respostas HTTP (inclui as recusas)

// envio sem a espera de 1,5 s entre confirmações (só nos testes)
const baseExternal = () => ({ pricesFetch: fakeFetch, pricesSleep: async () => {}, evmCall: async () => '0x0', execSleep: async () => {}, readSleep: async () => {} });

before(async () => {
  sv.setRpcFactoryForTest((o) => {
    factoryOpts.push({ url: o.url, rps: o.requestsPerSecond, porMetodo: o.defaultMethodLimit, onRetry: o.onRetry, headers: o.headers });
    return typeof nextClient === 'function' ? nextClient(o.url) : nextClient;
  });
  sv.setExternalForTest(baseExternal());
  // histórico de créditos num arquivo temporário: os testes nunca escrevem no do computador (%LOCALAPPDATA%\Clurn)
  sv.setCreditsForTest({ historyFile: HISTORY_FILE, heliusFetch: (async () => { throw new Error('sem rede nos testes'); }) as typeof fetch });
  server = sv.createServer(0, TOKEN);
  await new Promise<void>((r) => server.on('listening', () => r()));
  port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => {
    sse = http.get({ host: '127.0.0.1', port, path: `/api/eventos?t=${TOKEN}`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (type && data !== undefined) events.push({ type, data });
        }
      });
      resolve();
    });
  });
});
after(() => {
  sse.destroy();
  server.close();
  sv.setRpcFactoryForTest(null);
  sv.setExternalForTest(null);
  sv.setCreditsForTest(null);
  fs.rmSync(path.dirname(HISTORY_FILE), { recursive: true, force: true });
});

function post(p: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, 'x-token': TOKEN, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        bodies.push(data);
        resolve({ status: res.statusCode ?? 0, body: data });
      });
    });
    r.on('error', reject);
    r.write(JSON.stringify(body));
    r.end();
  });
}

async function until(cond: () => boolean, what: string, ms = 15_000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`esperou demais: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const S = () => sv.sessionForTest();
const item = (texto: string, carteira: WalletApp = 'solflare') => ({ texto, carteira });

// fim de tarefa = evento 'pronto' ou 'erro' chegou pelo SSE (os eventos chegam depois do busy voltar a null)
const ends = () => events.filter((e) => e.type === 'pronto' || e.type === 'erro').length;
async function waitTask(before: number) {
  await until(() => S().busy === null && ends() > before, 'tarefa terminar');
}

async function analyse(frases: Array<{ texto: string; carteira: string }>, rede: 'devnet' | 'mainnet' = 'devnet') {
  const n = ends();
  const r = await post('/api/analisar', { frases, rede, folga: 3 });
  assert.equal(r.status, 202, r.body);
  await waitTask(n);
}

async function reset() {
  resetWorld();
  const r = await post('/api/nova-limpeza', {});
  assert.equal(r.status, 200, r.body);
}

// plano de teste de uma frase, para um destino de fora (sem passar pelo /api/plano)
function trialPlanOf(f: sv.FraseState) {
  return sv.planForWait({ scans: f.scans, decisions: new Map(), destino: DEST, app: f.app, prices: new Map(), rentExemptZero: 890_880 });
}

// ---------- testes ----------

test('frases/servidor: duas frases com a mesma N=3 → signers diferentes por frase, e o plano de cada uma usa só as chaves dela', async () => {
  await reset();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1, 2, 3]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1, 2, 3]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  const [f1, f2] = S().frases;
  assert.deepEqual([f1.status, f2.status], ['pronta', 'pronta']);
  assert.notEqual(f1.signers, f2.signers, 'um mapa de chaves por frase');
  assert.equal(f1.signers.get(3)?.address, a[3]);
  assert.equal(f2.signers.get(3)?.address, b[3]);
  assert.notEqual(f1.signers.get(3)?.address, f2.signers.get(3)?.address);
  for (const [f, mine, other] of [[f1, a, b], [f2, b, a]] as const) {
    const plan = trialPlanOf(f);
    assert.ok(plan.steps.length > 0);
    for (const s of plan.steps) {
      assert.equal(f.signers.get(s.walletIndex)?.address, s.wallet, `frase ${f.n}, passo da N=${s.walletIndex} assinado pela chave da própria frase`);
      assert.ok(mine.includes(s.wallet) && !other.includes(s.wallet));
    }
    assert.equal(f.signers.get(plan.feePayerIndex)?.address, plan.feePayer);
  }
  // progresso: formato do evento e o total geral fechando no fim
  const prog = events.filter((e) => e.type === 'progresso').map((e) => JSON.parse(e.data));
  const leitura = prog.filter((p) => p.fase === 'leitura');
  assert.ok(leitura.length > 0);
  for (const p of prog) assert.deepEqual(Object.keys(p).sort(), ['carteira', 'etaMs', 'fase', 'feitos', 'frase', 'geral', 'total']);
  // "Agora:" diz qual carteira: rótulo da carteira lida da própria frase, nunca o endereço
  const lidas = leitura.filter((p) => p.feitos > 0);
  assert.equal(lidas.length, 8, 'um aviso por carteira lida');
  for (const p of lidas) assert.match(p.carteira, /^N=[0-3]$/);
  for (const fr of [1, 2]) assert.deepEqual(lidas.filter((p) => p.frase === fr).map((p) => p.carteira).sort(), ['N=0', 'N=1', 'N=2', 'N=3'], `frase ${fr}`);
  assert.ok(!prog.some((p) => p.carteira && [...a, ...b].includes(p.carteira)), 'nunca o endereço');
  assert.ok(prog.filter((p) => p.fase !== 'leitura' || p.feitos === 0).every((p) => p.carteira === null), 'sem carteira lida, sem rótulo');
  const last = leitura.at(-1);
  assert.equal(last.frase, 2);
  assert.deepEqual(last.geral, { feitos: 8, total: 8 });
});

test('frases/servidor: principal de cada frase fora de discovery.wallets usadas no plano', async () => {
  await reset();
  useWallets(PHRASES[2], 'solflare', [0, 1, 2]);
  const ph = useWallets(PHRASES[3], 'phantom', [0, 1, 2]); // Conta 1 (índice 0) = principal, com saldo
  await analyse([item(PHRASES[2]), item(PHRASES[3], 'phantom')]);
  const [sol, pha] = S().frases;
  assert.deepEqual([sol.status, pha.status], ['pronta', 'pronta']);

  // Solflare: a principal está fora do ramo 10000+
  assert.equal(sol.main, deriveMainAddress(seedOf(PHRASES[2])));
  assert.ok(!sol.discovery!.wallets.some((w) => w.address === sol.main));
  assert.ok(![...sol.signers.values()].some((s) => s.address === sol.main));
  const p1 = trialPlanOf(sol);
  assert.ok(!p1.steps.some((s) => s.wallet === sol.main) && p1.feePayer !== sol.main);

  // Phantom: a Conta 1 é usada (aparece na busca e na revisão) mas nunca ganha chave nem entra no plano
  assert.equal(pha.main, ph[0]);
  assert.equal(pha.signers.has(0), false, 'Conta 1 sem chave');
  assert.ok(pha.signers.has(1) && pha.signers.has(2));
  assert.ok(!pha.scans.some((s) => s.index === 0));
  assert.ok(pha.review?.accounts.some((a) => a.index === 0 && a.isMain));
  const p2 = trialPlanOf(pha);
  assert.ok(!p2.steps.some((s) => s.walletIndex === 0 || s.wallet === pha.main));
  assert.notEqual(p2.feePayerIndex, 0);
});

test("frases/servidor: frase 2 com RPC falhando (erro JSON-RPC) fica 'erro' e as frases 1 e 3 ficam 'pronta'", async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0, 1]);
  useWallets(PHRASES[2], 'phantom', [1, 2]);
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2], 'phantom')]);
  const [f1, f2, f3] = S().frases;
  assert.deepEqual([f1.status, f2.status, f3.status], ['pronta', 'erro', 'pronta']);
  assert.ok(f2.error && typeof f2.error.code === 'string');
  assert.equal(f2.signers.size, 0);
  assert.equal(f2.seed, null);
  assert.equal(f2.nothingToClean, false, 'erro não vira "nada a limpar"');
  assert.ok(f1.scans.length === 2 && f3.scans.length === 2);
});

test("frases/servidor: frase sem nenhuma usada fica 'pronta' com nothingToClean, não 'erro'", async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  // frase 3: carteira usada, mas a leitura das contas de token falha → leitura incompleta, NÃO "nada a limpar"
  const [bad] = useWallets(PHRASES[5], 'solflare', [0], 0);
  world.failTokens.add(bad);
  await analyse([item(PHRASES[0]), item(PHRASES[4]), item(PHRASES[5])]);
  const [f1, f2, f3] = S().frases;
  assert.equal(f2.status, 'pronta');
  assert.equal(f2.error, null);
  assert.equal(f2.discovery?.wallets.length, 0);
  assert.equal(f2.nothingToClean, true);
  assert.equal(f1.nothingToClean, false);
  assert.equal(f3.status, 'pronta');
  assert.ok(f3.scans[0].errors.length > 0);
  assert.equal(f3.nothingToClean, false, 'carteira não lida não é "nada a recuperar"');
});

test('exatidão: carteira que a rede não respondeu por inteiro vai marcada para a página (unread) e "Ler de novo" lê só ela, sem a frase', async () => {
  await reset();
  const [ok, bad] = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.tokens.set(bad, [fungible(bad, `Mint${'7'.repeat(39)}`)]);
  world.failTokens.add(bad); // erro de parâmetro: o cliente não repete, e as rodadas de releitura também falham
  await analyse([item(PHRASES[0])]);
  const wallets = () => (sv.viewForTest().frases[0].wallets as Array<{ address: string; unread: string[] }>);
  assert.deepEqual(wallets().find((w) => w.address === ok)?.unread, []);
  assert.match(wallets().find((w) => w.address === bad)?.unread.join() ?? '', /contas de token/);
  assert.equal(S().frases[0].holdings.length, 0, 'a moeda da carteira não lida ainda não aparece');
  // a rede volta: "Ler de novo" pela rota, sem colar a frase (a seed já foi apagada)
  world.failTokens.clear();
  const calls0 = world.sigCalls.length;
  const n = ends();
  const r = await post('/api/reler', {});
  assert.equal(r.status, 202, r.body);
  await waitTask(n);
  assert.equal(world.sigCalls.length, calls0, 'nada de busca de novo: só a leitura das incompletas');
  assert.deepEqual(wallets().map((w) => w.unread), [[], []]);
  assert.equal(S().frases[0].holdings.length, 1, 'a moeda lida agora entra nas escolhas');
  assert.equal(S().frases[0].seed, null);
  // nada incompleto: a rota não faz nada (e não derruba nada)
  const n2 = ends();
  assert.equal((await post('/api/reler', {})).status, 202);
  await waitTask(n2);
  assert.equal(S().frases[0].holdings.length, 1);
});

test('frases/servidor: nenhum texto de frase sai do servidor', async () => {
  await reset();
  const out: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  const firstEvent = events.length;
  try {
    const apps: WalletApp[] = ['solflare', 'phantom'];
    PHRASES.forEach((p, i) => {
      const app = apps[i % 2];
      useWallets(p, app, [1, 2]);
      world.tokens.set(deriveBurner(seedOf(p), 1, app).address, [fungible(deriveBurner(seedOf(p), 1, app).address, `Mint${String(i).padStart(39, '1')}`)]);
    });
    for (const a of addressesOf(PHRASES[6], 'solflare')) world.failSigs.add(a); // uma com erro de RPC
    await analyse(PHRASES.map((p, i) => item(p, apps[i % 2])), 'mainnet');
    assert.equal(S().frases.filter((f) => f.status === 'pronta').length, 9);
    // recusas: palavra fora da lista, frase repetida, 11 frases, formato velho
    const broken = PHRASES[7].split(' ');
    broken[3] = 'zzzzzqqq';
    bodies.length = 0;
    assert.equal((await post('/api/analisar-frase', { n: 7, texto: broken.join(' '), carteira: 'solflare' })).status, 400);
    assert.equal((await post('/api/analisar-frase', { n: 7, texto: PHRASES[0], carteira: 'solflare' })).status, 400);
    assert.equal((await post('/api/analisar', { frases: [...PHRASES, PHRASES[0]].map((p) => item(p)) })).status, 400);
    assert.equal((await post('/api/analisar', { frase: PHRASES[1] })).status, 400);
    // a frase 7 corrigida de verdade (o RPC voltou) também não deixa rastro
    world.failSigs.clear();
    const n0 = ends();
    assert.equal((await post('/api/analisar-frase', { n: 7, texto: PHRASES[6], carteira: 'solflare' })).status, 202);
    await waitTask(n0);
    assert.equal(S().frases[6].status, 'pronta');

    const state = JSON.stringify((await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/estado', headers: { host: `127.0.0.1:${port}`, 'x-token': TOKEN } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      });
    })));
    const haystacks: Array<[string, string]> = [
      ['estado', state],
      ['eventos', events.slice(firstEvent).map((e) => `${e.type} ${e.data}`).join('\n')],
      ['respostas', bodies.join('\n')],
      ['console', out.join('\n')],
      ['erros das frases', JSON.stringify(S().frases.map((f) => f.error))],
    ];
    assert.ok(events.slice(firstEvent).length > 10, 'eventos capturados');
    assert.ok(bodies.some((b) => /seed-unknown-word/.test(b)) && bodies.some((b) => /seed-duplicate/.test(b)) && bodies.some((b) => /too-many-frases/.test(b)));
    for (const [where, text] of haystacks) {
      for (const p of PHRASES) assert.ok(!text.includes(p), `frase inteira apareceu em ${where}`);
      for (const w of [...LONG_WORDS, 'zzzzzqqq']) assert.doesNotMatch(text, new RegExp(`\\b${w}\\b`, 'i'), `a palavra "${w}" apareceu em ${where}`);
    }
    for (const f of S().frases) assert.equal(f.seed, null);
  } finally {
    Object.assign(console, orig);
  }
});

test('frases/servidor: seed zerada depois da busca', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  useWallets(PHRASES[1], 'phantom', [1]);
  let open1!: () => void;
  let open!: () => void;
  // trava a busca da frase 1 (para pegar as 3 seeds ainda cheias) e depois a da frase 2
  world.gate = { addrs: new Set(addressesOf(PHRASES[0], 'solflare', 10)), wait: new Promise<void>((r) => (open1 = r)) };
  world.gate2 = { addrs: new Set(addressesOf(PHRASES[1], 'phantom', 10)), wait: new Promise<void>((r) => (open = r)) };
  const n0 = ends();
  // asserção que falhe aqui dentro não pode deixar a análise travada (derrubaria os testes seguintes)
  try {
    const r = await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1], 'phantom'), item(PHRASES[2])], rede: 'devnet', folga: 3 });
    assert.equal(r.status, 202);
    await until(() => S().frases[0]?.status === 'busca', 'frase 1 na busca');
    const seeds = S().frases.map((f) => f.seed);
    assert.ok(seeds.every((x) => x instanceof Buffer && x.length === 64 && x.some((b) => b !== 0)));
    open1();
    // frase 2 travada na busca: a frase 1 já terminou a dela, a 3 ainda está na fila
    await until(() => S().frases[1]?.status === 'busca', 'frase 2 na busca');
    assert.equal(S().frases[2].status, 'fila');
    assert.ok(seeds[0]!.every((b) => b === 0), 'frase 1 terminou a busca: bytes zerados JÁ (não só no fim da rodada)');
    assert.equal(S().frases[0].seed, null);
    assert.ok(seeds[2]!.some((b) => b !== 0), 'frase 3 na fila: a seed ainda está na memória até a vez dela');
    open();
    await waitTask(n0);
    for (const [i, x] of seeds.entries()) {
      assert.ok(x!.every((b) => b === 0), `bytes da seed da frase ${i + 1} zerados`);
      assert.equal(S().frases[i].seed, null);
    }
  } finally {
    open1();
    open();
    await until(() => S().busy === null, 'análise terminar (limpeza do teste)').catch(() => {});
  }
});

test('frases/servidor: nova limpeza zera seeds pendentes, apaga chaves, cancela esperas e para o RPC', async () => {
  await reset();
  const pending = Buffer.alloc(64, 7);
  let stopped = 0;
  const s = S();
  const f1 = sv.newFrase(1, 'solflare');
  f1.signers.set(3, { address: 'x' } as never);
  const f2 = sv.newFrase(2, 'phantom', pending);
  s.frases = [f1, f2];
  s.rpc = { call: async () => null, stop: () => void stopped++ } as never;
  const w1 = sv.armFundingAbort(f1);
  const r = await post('/api/nova-limpeza', {});
  assert.equal(r.status, 200);
  assert.ok(pending.every((b) => b === 0), 'seed pendente zerada');
  assert.equal(f2.seed, null);
  assert.equal(f1.signers.size, 0);
  assert.equal(w1.signal.aborted, true);
  assert.equal(stopped, 1, 'RPC da rodada parado');
  assert.deepEqual(JSON.parse(r.body).frases, []);
});

test('frases/servidor: encerrar no meio da análise zera as seeds na fila', async () => {
  await reset();
  let open!: () => void;
  world.gate = { addrs: new Set(addressesOf(PHRASES[0], 'solflare', 10)), wait: new Promise<void>((r) => (open = r)) };
  assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'devnet', folga: 3 })).status, 202);
  await until(() => S().frases[0]?.status === 'busca', 'frase 1 na busca');
  const frases = S().frases;
  const seeds = frases.map((f) => f.seed!);
  const exit = process.exit;
  let exited = 0;
  process.exit = (() => void exited++) as never;
  try {
    assert.equal((await post('/api/encerrar', {})).status, 200);
    assert.ok(seeds.every((s) => s.every((b) => b === 0)), 'seeds zeradas ao encerrar');
    assert.ok(frases.every((f) => f.seed === null && f.signers.size === 0));
    open();
    await until(() => S().busy === null, 'análise largada');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(exited, 1);
  } finally {
    process.exit = exit;
  }
});

test('frases/servidor: analisar-frase refaz só a frase n e apaga os planos', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0, 1]);
  useWallets(PHRASES[2], 'solflare', [0]);
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  const [f1, f2, f3] = S().frases;
  assert.equal(f2.status, 'erro');
  const f1scans = f1.scans;
  f1.plan = trialPlanOf(f1);

  // depois de simular, não
  S().simResults = [{} as never];
  assert.equal((await post('/api/analisar-frase', { n: 2, texto: PHRASES[1], carteira: 'solflare' })).status, 400);
  S().simResults = [];
  // frase igual a outra da rodada (mesmo app), não
  const dup = await post('/api/analisar-frase', { n: 2, texto: PHRASES[0], carteira: 'solflare' });
  assert.equal(dup.status, 400);
  assert.deepEqual([JSON.parse(dup.body).codigo, JSON.parse(dup.body).params.of], ['seed-duplicate', 1]);
  assert.equal(S().frases[1], f2, 'recusa não mexe na frase');

  world.failSigs.clear();
  world.sigCalls.length = 0;
  const n0 = ends();
  assert.equal((await post('/api/analisar-frase', { n: 2, texto: PHRASES[1], carteira: 'solflare' })).status, 202);
  await waitTask(n0);
  const [g1, g2, g3] = S().frases;
  assert.equal(g2.status, 'pronta');
  assert.equal(g2.n, 2);
  assert.equal(g2.scans.length, 2);
  assert.ok(g1 === f1 && g3 === f3 && g1.scans === f1scans, 'as outras frases não foram refeitas');
  const others = new Set([...addressesOf(PHRASES[0], 'solflare'), ...addressesOf(PHRASES[2], 'solflare')]);
  assert.ok(world.sigCalls.length > 0 && !world.sigCalls.some((a) => others.has(a)), 'só a frase 2 foi consultada');
  assert.equal(g1.plan, null, 'planos apagados');
  assert.deepEqual(S().simResults, []);
  assert.equal(g2.seed, null);
  const ids = S().frases.flatMap((f) => f.holdings.map((h) => h.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('frases/servidor: preços consultados uma vez por rodada', async () => {
  await reset();
  for (const [i, p] of PHRASES.slice(0, 3).entries()) {
    const [w] = useWallets(p, 'solflare', [0]);
    world.tokens.set(w, [fungible(w, `PMint${String(i).padStart(38, '1')}`)]);
  }
  priceCalls = 0;
  await analyse(PHRASES.slice(0, 3).map((p) => item(p)), 'mainnet');
  assert.ok(S().frases.every((f) => f.status === 'pronta'));
  assert.equal(priceCalls, 1, 'uma consulta de preços para as 3 frases');
  assert.equal(S().prices?.info.size, 4, '3 mints + SOL');
  const hs = S().frases.flatMap((f) => f.holdings);
  assert.deepEqual(hs.map((h) => h.frase), [1, 2, 3]);
  assert.deepEqual(hs.map((h) => h.id), [1, 2, 3], 'id único na rodada');

  // a vista: uma entrada por frase, e o global soma
  const v = await new Promise<Record<string, unknown>>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/estado', headers: { host: `127.0.0.1:${port}`, 'x-token': TOKEN } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });
  const fv = v.frases as Array<Record<string, unknown>>;
  assert.equal(fv.length, 3);
  for (const k of ['n', 'app', 'main', 'discovery', 'wallets', 'holdings', 'review', 'evm', 'totals', 'feeWarning', 'feeWait', 'nothingToClean', 'status', 'error', 'tempoMs']) assert.ok(k in fv[0], k);
  assert.ok(!('seed' in fv[0]) && !('signers' in fv[0]));
  assert.equal((v.holdings as unknown[]).length, 3);
  const sum = fv.reduce((a, f) => a + (f.totals as { solLamports: number }).solLamports, 0);
  assert.equal((v.totals as { solLamports: number }).solLamports, sum);
  assert.ok('progress' in v && 'pause' in v);
});

// Caso real (tester, 31/10/2026, print do "Nada para limpar"): temporárias com 0 SOL e só uma memecoin com saldo em
// cada. O plano de teste da análise era montado SEM as escolhas de token (toda moeda = manter), não achava nada a
// fazer e a frase virava "Nada para limpar", com a moeda que a tela recomendaria queimar em todas as carteiras.
test('frases/servidor: carteiras só com memecoin para queimar (0 SOL) nunca são "Nada para limpar": pedem o depósito', async () => {
  const MEME = '2gTbp2gwH46rqExzabSyrdR3294SLwCp2rSqWDS6Sim1';
  const curve = Buffer.alloc(166);
  curve.writeBigUInt64LE(1_000_000_000_000_000n, 8);
  curve.writeBigUInt64LE(30_000_000_000n, 16);
  await reset();
  const ws = useWallets(PHRASES[0], 'solflare', [0, 1], 0);
  for (const w of ws) world.tokens.set(w, [fungible(w, MEME)]);
  world.curves.set(curveAddress(MEME), curve);
  priceMode = 'empty';
  await analyse([item(PHRASES[0])], 'mainnet');
  const f = S().frases[0];
  assert.equal(f.status, 'pronta');
  assert.deepEqual(f.holdings.map((h) => h.recommendation), ['burn', 'burn'], 'a tela recomenda queimar nas duas');
  assert.equal(f.nothingToClean, false, 'não é "Nada para limpar"');
  assert.ok(f.feeWait && f.feeNeed, 'pede o SOL das taxas para queimar e fechar');
  // moeda sem preço (fica em "manter" até a pessoa decidir): também não some atrás de "Nada para limpar"
  await reset();
  const [u] = useWallets(PHRASES[1], 'solflare', [0], 0);
  world.tokens.set(u, [fungible(u, `NoPr${'1'.repeat(40)}`)]);
  priceMode = 'empty';
  await analyse([item(PHRASES[1])], 'mainnet');
  const g = S().frases[0];
  assert.equal(g.holdings[0].recommendation, 'keep');
  assert.equal(g.nothingToClean, false, 'moeda à espera da decisão da pessoa: não é "Nada para limpar"');
});

// Caso real (carteira de um amigo, moedas de nov/2025): moedas da Pump.fun sem o sufixo "pump" e fora da API de
// preços caíam em "origem e valor incertos: manter". A conta BondingCurve na rede identifica a moeda e dá o preço.
test('frases/servidor: moeda da Pump.fun sem sufixo e fora da API é reconhecida pela curva, com preço em SOL', async () => {
  const SEMSUFIXO = '2gTbp2gwH46rqExzabSyrdR3294SLwCp2rSqWDS6Sim1'; // moeda real da Pump.fun sem sufixo (31/10/2026)
  const curve = Buffer.alloc(166); // BondingCurve: reservas virtuais 8 e 16, complete 48, quote_mint 83 (zero = SOL)
  curve.writeBigUInt64LE(1_000_000_000_000_000n, 8); // 1 bilhão de tokens (6 decimais)
  curve.writeBigUInt64LE(30_000_000_000n, 16); // 30 SOL
  const holding = async (withCurve: boolean) => {
    await reset();
    const [w] = useWallets(PHRASES[0], 'solflare', [0]);
    world.tokens.set(w, [fungible(w, SEMSUFIXO)]); // 5 tokens
    if (withCurve) world.curves.set(curveAddress(SEMSUFIXO), curve);
    priceMode = 'empty'; // a Jupiter não conhece a moeda nem devolve o preço do SOL
    await analyse([item(PHRASES[0])], 'mainnet');
    assert.equal(S().frases[0].status, 'pronta');
    return S().frases[0].holdings[0];
  };
  const before = await holding(false); // como era: sem curva, a moeda é "desconhecido" e fica em "Manter"
  assert.equal(before.category, 'desconhecido');
  assert.equal(before.whyCode, 'no-price');
  assert.equal(before.recommendation, 'keep');

  const after = await holding(true);
  assert.equal(after.category, 'memecoin Pump.fun');
  assert.equal(after.usdValue, null, 'sem o preço do SOL não há dólar');
  assert.ok(after.solValue !== null && Math.abs(after.solValue - 5 * 3e-8) < 1e-15, `5 tokens × 3e-8 SOL (${after.solValue})`);
  assert.equal(after.whyCode, 'cheap-memecoin');
  assert.equal(after.recommendation, 'burn');
  assert.equal(after.burnNeedsConfirmation, false);
  assert.equal(after.inBurnAll, true);
});

test('frases/servidor: estimativa antes de começar', async () => {
  const r = await post('/api/estimativa', { frases: 3, rpcProprio: true, etapa: 'analise' });
  assert.equal(r.status, 200, r.body);
  assert.deepEqual(JSON.parse(r.body), estimateRun({ frases: 3, customRpc: true, stage: 'analysis' }));
  const r2 = JSON.parse((await post('/api/estimativa', { frases: 2, rpcProprio: false, carteiras: 150, etapa: 'execucao' })).body);
  assert.deepEqual(r2, estimateRun({ frases: 2, wallets: 150, customRpc: false, stage: 'execute' }));
  for (const bad of [{ frases: 11, etapa: 'analise' }, { frases: 0, etapa: 'analise' }, { frases: 2, etapa: 'outra' }, { frases: 2, etapa: 'analise', carteiras: -1 }]) {
    assert.equal((await post('/api/estimativa', bad)).status, 400, JSON.stringify(bad));
  }
});

// ---------- rodada 1 de correções (revisão) ----------

function emptyAccount(owner: string) {
  tokenSeq++;
  return {
    // o contador vira dígitos do endereço: '0' não existe no base58 (achado em 31/10/2026: a 20ª conta quebrava o teste seguinte)
    pubkey: `EmpAcc${String(tokenSeq).replace(/0/g, 'z').padStart(38, '1')}`,
    account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'EMint111111111111111111111111111111111111111', owner, state: 'initialized', tokenAmount: { amount: '0', decimals: 6 } } } } },
  };
}

async function redo(n: number, texto: string, carteira: WalletApp = 'solflare') {
  const n0 = ends();
  const r = await post('/api/analisar-frase', { n, texto, carteira });
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
}

function getState(): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/estado', headers: { host: `127.0.0.1:${port}`, 'x-token': TOKEN } }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
    });
  });
}

test('frases/analisar-frase: os preços das outras frases ficam, e o aviso de falha de preço não se repete', async () => {
  await reset();
  const mint = (i: number) => `QMint${String(i).padStart(38, '1')}`;
  for (const i of [0, 1, 2]) {
    const [w] = useWallets(PHRASES[i], 'solflare', [0]);
    world.tokens.set(w, [fungible(w, mint(i))]);
  }
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  priceMode = 'priced';
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])], 'mainnet');
  assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'erro', 'pronta']);
  assert.ok(S().prices!.prices.has(mint(0)) && S().prices!.prices.has(mint(2)));
  assert.deepEqual(S().prices!.errors, []);

  world.failSigs.clear();
  priceMode = 'fail'; // a consulta da frase 2 falha
  await redo(2, PHRASES[1]);
  assert.equal(S().frases[1].status, 'pronta');
  assert.ok(S().prices!.prices.has(mint(0)) && S().prices!.prices.has(mint(2)), 'preços das frases 1 e 3 continuam');
  assert.ok(S().prices!.info.has(mint(0)) && S().prices!.info.has(mint(1)) && S().prices!.info.has(mint(2)));
  assert.equal(S().prices!.errors.length, 1);
  await redo(2, PHRASES[1]);
  assert.equal(S().prices!.errors.length, 1, 'refazer de novo não repete o aviso');
});

test('frases/servidor: consulta de preços falhada deixa o token como valor desconhecido, e ele queima com a palavra (sem trava)', async () => {
  await reset();
  const mint = (i: number) => `LMint${String(i).padStart(38, '1')}`;
  for (const i of [0, 1]) {
    const [w] = useWallets(PHRASES[i], 'solflare', [0]);
    world.tokens.set(w, [fungible(w, mint(i))]);
  }
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  priceMode = 'empty'; // a Jupiter responde mas não conhece as moedas: "sem preço" de verdade, pode queimar com confirmação
  await analyse([item(PHRASES[0]), item(PHRASES[1])], 'mainnet');
  const h0 = S().frases[0].holdings[0];
  assert.deepEqual([h0.whyCode, h0.priceLookupFailed, h0.inBurnAll], ['no-price', false, true]);

  world.failSigs.clear();
  priceMode = 'fail'; // a consulta da frase 2 falha (limite da API ou API fora)
  await redo(2, PHRASES[1]);
  const h1 = S().frases[1].holdings[0];
  // como um tester queimou na carteira avulsa: sem preço, "Manter" por padrão, queimar com a palavra; nada de trava
  assert.deepEqual([h1.whyCode, h1.recommendation, h1.priceLookupFailed, h1.inBurnAll, h1.burnNeedsConfirmation], ['no-price', 'keep', true, true, true]);
  assert.equal(S().frases[0].holdings[0].priceLookupFailed, false, 'a frase 1 não é afetada');
  assert.ok(S().prices!.unresolved.has(mint(1)) && !S().prices!.unresolved.has(mint(0)));
  world.lamports.set(DEST, 50_000_000); // destino existente
  const burns = (n: number) => S().frases[n].plan!.steps.flatMap((st) => (st.kind === 'tokens' ? st.actions : [])).filter((a) => a.action === 'burn-close').length;
  const sem = await plano({ decisoes: { [h0.account]: 'burn', [h1.account]: 'burn' }, queimarConfirmado: [] });
  assert.equal(sem.status, 200, sem.body);
  assert.deepEqual([burns(0), burns(1)], [0, 0], 'sem a palavra, nenhum dos dois queima (ficam em Manter)');
  const com = await plano({ decisoes: { [h0.account]: 'burn', [h1.account]: 'burn' }, queimarConfirmado: [h0.account, h1.account] });
  assert.equal(com.status, 200, com.body);
  assert.deepEqual([burns(0), burns(1)], [1, 1], 'com a palavra, os dois queimam, inclusive o da consulta falhada');
  assert.equal(JSON.parse((await getState()).body).pricesMissing, 1, 'a página recebe a contagem para um aviso só');

  priceMode = 'empty';
  await redo(2, PHRASES[1]);
  assert.equal(S().frases[1].holdings[0].priceLookupFailed, false, 'refazer a frase com a consulta passando traz a consulta');
  assert.equal(S().prices!.unresolved.size, 0);
});

// dois testers (01/11/2026): a leitura das curvas falhava em silêncio, a memecoin ficava "sem preço" e sumia do
// total sem nenhum aviso. Agora o que a rede não respondeu vira "consulta falhou", com a contagem para o aviso.
test('frases/servidor: curva da Pump.fun que a rede não respondeu vira "consulta falhou", nunca "sem preço" calado', async () => {
  await reset();
  const m = `CMint${'2'.repeat(38)}`;
  const [w] = useWallets(PHRASES[0], 'solflare', [0]);
  world.tokens.set(w, [fungible(w, m)]);
  // outras redes rodam logo antes dos preços: daqui em diante, toda leitura de contas em lote falha
  sv.setExternalForTest({ ...baseExternal(), evmScan: async () => { world.failAfter.set('getMultipleAccounts', 0); return { holdings: [], usedAccounts: [], errors: [] }; } });
  try {
    await analyse([item(PHRASES[0])]);
    const h = S().frases[0].holdings[0];
    assert.deepEqual([h.whyCode, h.priceLookupFailed, h.inBurnAll], ['no-price', true, true]);
    assert.ok(S().prices!.unresolved.has(m));
    assert.equal(JSON.parse((await getState()).body).pricesMissing, 1);
    assert.equal(h.rentLamports, 2_039_280, 'o aluguel vai para a Confirmar mostrar o que fica em "manter"');
  } finally {
    world.failAfter.clear();
    sv.setExternalForTest(baseExternal());
  }
});

test('frases/analisar-frase: espera de plano de outra frase vira espera da análise (depósito depois não monta o plano apagado)', async () => {
  await reset();
  const [w1] = useWallets(PHRASES[0], 'solflare', [0], 100); // conta vazia para fechar, sem SOL para a taxa
  world.tokens.set(w1, [emptyAccount(w1)]);
  useWallets(PHRASES[1], 'solflare', [0]);
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  const f1 = S().frases[0];
  assert.ok(f1.feeWarning, 'frase 1 sem SOL para a taxa');
  const ctx = { scans: f1.scans, decisions: new Map(), destino: DEST, app: 'solflare' as const, prices: new Map(), rentExemptZero: 890_880 };
  let first: FeePayerError | null = null;
  try {
    sv.planForWait(ctx);
  } catch (e) {
    if (!(e instanceof FeePayerError)) throw e;
    first = e;
  }
  assert.ok(first);
  let poll!: () => void;
  const nextPoll = new Promise<void>((r) => (poll = r));
  // espera do /api/plano (decisões e destino de antes); a 2ª leitura só sai quando o teste deixar
  const planWait = sv.startPlanWait(f1, first, ctx, { rpc: fakeRpc, emit: () => {}, sleep: () => nextPoll });
  const planCtl = f1.fundingAbort!;
  assert.ok(planCtl);

  world.failSigs.clear();
  await redo(2, PHRASES[1]);
  assert.equal(planCtl.signal.aborted, true, 'espera de plano da frase 1 cancelada');
  assert.ok(f1.fundingAbort && f1.fundingAbort !== planCtl, 'virou a espera da análise');
  assert.ok(f1.feeWarning);
  world.lamports.set(w1, 50_000_000); // o depósito chega
  poll();
  await planWait;
  assert.equal(f1.plan, null, 'depósito depois não monta o plano apagado');
  sv.cancelFundingWait(f1);
});

test('frases/analisar-frase: rodada com RPC recusado não deixa refazer uma frase sozinha', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  world.failMethods.add('getProgramAccounts');
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.deepEqual(S().frases.map((f) => [f.status, f.error?.code]), [['erro', 'rpc-blocked'], ['erro', 'rpc-blocked']]);
  assert.equal(S().rentExemptZero, 0);
  world.failMethods.clear();
  const r = await post('/api/analisar-frase', { n: 1, texto: PHRASES[0], carteira: 'solflare' });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).erro, /Analise as frases de novo/);
  assert.equal(S().frases[0].status, 'erro');
});

test('frases/servidor: rodada que cai depois de conferir o RPC marca as frases que faltavam como erro', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  world.failAfter.set('getMinimumBalanceForRentExemption', 1); // a do checkRpc passa, a da análise falha
  const n0 = events.length;
  await analyse([item(PHRASES[0]), item(PHRASES[1], 'phantom')]);
  assert.deepEqual(S().frases.map((f) => [f.status, f.error?.code]), [['erro', 'unknown'], ['erro', 'unknown']], 'nenhuma fica "na fila" para sempre');
  assert.ok(S().frases.every((f) => f.seed === null && f.signers.size === 0));
  assert.equal(events.slice(n0).filter((e) => e.type === 'erro' || e.type === 'pronto').at(-1)?.type, 'erro');
  // o RPC conferido não basta: sem o aluguel lido, refazer uma frase sozinha continua recusado
  world.failAfter.clear();
  const r = await post('/api/analisar-frase', { n: 1, texto: PHRASES[0], carteira: 'solflare' });
  assert.equal(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).erro, /Analise as frases de novo/);
});

test('frases/servidor: tarefa que cai com erro sem código manda só o nome para a página e o stack para o stderr', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  // erro cru (não é RpcError nem CodedError) depois do checkRpc: o que a página mostra como "Falha na tarefa (Error)"
  let rent = 0;
  nextClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getMinimumBalanceForRentExemption' && ++rent > 1) throw new Error('aluguel fora do formato (teste)');
      return fakeRpc.call<T>(method, params);
    },
  };
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.map(String).join(' '));
  try {
    const n0 = events.length;
    await analyse([item(PHRASES[0])]);
    const erro = events.slice(n0).filter((e) => e.type === 'erro' || e.type === 'pronto').at(-1)!;
    assert.equal(erro.type, 'erro');
    const d = JSON.parse(erro.data);
    assert.equal(d.mensagem, 'Falha na tarefa (Error). Tente de novo.');
    assert.equal(d.codigo, 'unknown');
    assert.ok(!erro.data.includes('aluguel fora do formato'), 'o texto bruto do erro não vai para a página');
    const line = errs.find((l) => l.startsWith('[tarefa analise]'));
    assert.ok(line, `stderr sem a linha da tarefa: ${JSON.stringify(errs)}`);
    assert.match(line!, /Error: aluguel fora do formato \(teste\)/, 'nome e mensagem do erro');
    assert.match(line!, /\n\s+at /, 'stack com a origem');
    for (const w of LONG_WORDS) assert.ok(!line!.includes(w), `palavra da frase no stderr: ${w}`);
  } finally {
    console.error = origError;
    nextClient = fakeRpc;
  }
});

test('frases/servidor: endereço das outras redes que não dá para calcular vira aviso da frase, a análise segue', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  // o que acontecia no app de desktop (30/10/2026): node:crypto sem secp256k1 lançava dentro de deriveIdentity
  sv.setExternalForTest({ ...baseExternal(), evmAddressOf: () => { throw new Error('Failed to create key using named curve'); } });
  try {
    const n0 = events.length;
    await analyse([item(PHRASES[0])]);
    const [f] = S().frases;
    assert.equal(f.status, 'pronta');
    assert.deepEqual(f.evmAddresses, []);
    assert.ok(f.evm && f.evm.errors.some((e) => /outras redes/.test(e)), `aviso no cartão: ${JSON.stringify(f.evm)}`);
    assert.equal(events.slice(n0).filter((e) => e.type === 'erro' || e.type === 'pronto').at(-1)?.type, 'pronto');
  } finally {
    sv.setExternalForTest(baseExternal());
  }
});

test('frases/servidor: dado fora do formato numa frase marca só ela; outras redes que falham viram aviso da frase', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  const [, w2] = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.lamports.set(pumpCreatorVault(w2), Infinity); // JSON "1e400" chega como Infinity: a leitura (scan.ts) marca a carteira
  const [w3] = useWallets(PHRASES[2], 'solflare', [0]);
  world.tokens.set(w3, [fungible(w3, `XMint${'1'.repeat(38)}`)]);
  const bad = evmAddress(seedOf(PHRASES[0]), 0);
  const evm2 = evmAddress(seedOf(PHRASES[1]), 0);
  let readOk: boolean | null = null;
  sv.setExternalForTest({
    pricesFetch: fakeFetch,
    readSleep: async () => {},
    evmCall: async () => '0x0',
    evmScan: async (a) => {
      if (a[0] === bad) throw new Error('outras redes fora do ar');
      if (a[0] === evm2) {
        // a leitura da frase 2 absorveu o cofre sujo; para provar a última defesa do servidor, um dado sujo que
        // escapasse da leitura é posto aqui (depois da leitura, antes de tokens e plano): BigInt(Infinity) lança
        const f2 = S().frases[1];
        const dirty = f2.scans.find((x) => x.address === w2);
        readOk = f2.status === 'pronta' && dirty?.fees === null && /cofre da curva fora do formato/.test(dirty.errors.join());
        f2.scans.find((x) => x.address !== w2)!.lamports = Infinity; // a carteira lida sem erro, que entraria no plano
      }
      return { holdings: [], usedAccounts: [], errors: [] };
    },
  });
  try {
    const n0 = events.length;
    await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
    const [f1, f2, f3] = S().frases;
    assert.equal(readOk, true, 'cofre com Infinity: a leitura marca a carteira e a frase fica pronta');
    assert.equal(f2.status, 'erro');
    assert.equal(f2.signers.size, 0);
    assert.deepEqual(f2.scans, []);
    assert.equal(f1.status, 'pronta');
    assert.ok(f1.evm && f1.evm.errors.length > 0, 'falha das outras redes vira aviso, a frase segue pronta');
    assert.equal(f3.status, 'pronta');
    assert.equal(f3.holdings.length, 1, 'a frase 3 terminou (tokens montados)');
    assert.equal(events.slice(n0).filter((e) => e.type === 'erro' || e.type === 'pronto').at(-1)?.type, 'pronto');
    assert.equal((await getState()).status, 200);
  } finally {
    sv.setExternalForTest(baseExternal());
  }
});

// a página só espera e repete sozinha se a recusa vier com o código (print de 01/11/2026: "Tentar de novo" morto)
test('frases/servidor: pedido com outra tarefa no ar é recusado com o código task-busy', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await analyse([item(PHRASES[0])]);
  S().busy = 'repasse';
  try {
    for (const [path, body] of [['/api/plano', { destino: DEST, decisoes: {}, queimarConfirmado: [], porFrase: {} }], ['/api/simular', {}], ['/api/reler', {}]] as const) {
      const r = await post(path, body);
      assert.equal(r.status, 400, `${path}: ${r.body}`);
      assert.equal(JSON.parse(r.body).codigo, 'task-busy', path);
    }
  } finally {
    S().busy = null;
  }
});

// cada consulta de outras redes só responde quando as 3 frases já pediram: em série, a 1ª ficaria esperando para sempre
test('frases/servidor: outras redes de todas as frases ao mesmo tempo, não uma depois da outra', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  useWallets(PHRASES[1], 'solflare', [0]);
  useWallets(PHRASES[2], 'solflare', [0]);
  let asked = 0;
  let allAsked!: () => void;
  const gate = new Promise<void>((r) => (allAsked = r));
  sv.setExternalForTest({
    ...baseExternal(),
    evmScan: async () => {
      if (++asked === 3) allAsked();
      const ok = await Promise.race([gate.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000))]);
      return { holdings: [], usedAccounts: [], errors: ok ? [] : ['em série'] };
    },
  });
  try {
    await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
    assert.equal(asked, 3);
    assert.deepEqual(S().frases.map((f) => f.evm?.errors), [[], [], []]);
  } finally {
    sv.setExternalForTest(baseExternal());
  }
});

// ---------- Tarefa 9: plano, simulação e execução de várias frases ----------

// destino e carteira da taxa do app existem na rede falsa (carteiras comuns com saldo)
function chain() {
  world.lamports.set(DEST, 50_000_000);
  world.lamports.set(APP_FEE_WALLET, 1_000_000);
}
const plano = (body: Record<string, unknown> = {}) => post('/api/plano', { destino: DEST, destino2: DEST, decisoes: {}, queimarConfirmado: [], porFrase: {}, ...body });
async function task(p: string, body: unknown = {}) {
  const n0 = ends();
  const r = await post(p, body);
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
}
const typedCode = () => ''; // a confirmação digitada saiu em 31/10/2026 (destino colado 2× na entrada); o servidor ignora o campo
const sumBig = (xs: Array<bigint | undefined>) => xs.reduce<bigint>((a, x) => a + (x ?? 0n), 0n);
// frase sem SOL para a taxa: uma conta vazia para fechar e 100 lamports
function noSol(phrase: string) {
  const [w] = useWallets(phrase, 'solflare', [0], 100);
  world.tokens.set(w, [emptyAccount(w)]);
  return w;
}

test('frases/plano: destino = temporária da frase 2 → recusado', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  useWallets(PHRASES[2], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  for (const dest of [b[1], b[0]]) {
    const r = await post('/api/plano', { destino: dest, destino2: dest, porFrase: {} });
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).erro, /uma das burners/);
  }
  assert.ok(S().frases.every((f) => f.plan === null), 'nenhum plano montado');
});

// o destino é colado UMA vez (decisão do autor, 31/10/2026): o que segura o erro de endereço é a conferência do
// servidor (válido, carteira que já existe, não é burner nem imita conta comum), não uma segunda colagem
test('frases/plano: destino colado uma vez basta; inválido ou inexistente na rede → recusado', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0]);
  await analyse([item(PHRASES[0])]);
  const typo = DEST.slice(0, -1) + (DEST.endsWith('1') ? '2' : '1'); // um caractere trocado: endereço válido, carteira que não existe
  for (const bad of ['', 'abc', typo]) {
    const r = await post('/api/plano', { destino: bad, porFrase: {} });
    assert.equal(r.status, 400, `${bad}: ${r.body}`);
  }
  assert.ok(S().frases.every((f) => f.plan === null), 'nenhum plano montado');
  const ok = await post('/api/plano', { destino: ` ${DEST} `, porFrase: {} });
  assert.equal(ok.status, 200, ok.body);
  assert.ok(S().frases[0].plan, 'uma colagem só; espaços nas pontas não contam');
  // o campo antigo (segunda colagem) não muda nada: diferente não recusa mais
  assert.equal((await post('/api/plano', { destino: DEST, destino2: typo, porFrase: {} })).status, 200);
});

test('frases/plano: destino que imita conta comum da frase 3 → recusado (dest-lookalike)', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0]);
  useWallets(PHRASES[1], 'solflare', [0]);
  useWallets(PHRASES[2], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  const real = S().frases[2].known[1].address; // Conta 2 (comum) da frase 3
  const fake = real.slice(0, 4) + '1'.repeat(real.length - 8) + real.slice(-4);
  world.lamports.set(fake, 50_000_000); // existe na rede: só a imitação recusa
  const r = await post('/api/plano', { destino: fake, destino2: fake, porFrase: {} });
  assert.equal(r.status, 400, r.body);
  const j = JSON.parse(r.body);
  assert.deepEqual([j.codigo, j.params.index], ['dest-lookalike', 1]);
  assert.ok(S().frases.every((f) => f.plan === null));
});

test('frases/plano: frase 2 sem SOL para a taxa → frases 1 e 3 com plano, frase 2 esperando', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  noSol(PHRASES[1]);
  const c = useWallets(PHRASES[2], 'phantom', [1, 2]);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2], 'phantom')]);
  const [f1, f2, f3] = S().frases;
  assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta', 'pronta']);
  assert.ok(f2.feeWarning);

  // a confirmação do número de contas é POR FRASE: a da frase 1 não vale para a Phantom da frase 3
  const wrong = await plano({ porFrase: { 1: { protegidas: [], contasConfirmadas: 2 } } });
  assert.equal(wrong.status, 400);
  assert.match(JSON.parse(wrong.body).erro, /Frase 3: Confirme quantas contas/);
  assert.ok(S().frases.every((f) => f.plan === null));

  const r = await plano({ porFrase: { 3: { protegidas: [], contasConfirmadas: 2 } } });
  assert.equal(r.status, 200, r.body);
  assert.ok(f1.plan && f3.plan);
  assert.equal(f2.plan, null);
  assert.ok(f2.feeWait?.waiting && f2.fundingAbort, 'frase 2 espera o depósito no próprio cartão');
  const v = JSON.parse(r.body);
  assert.deepEqual(v.plan.frases.map((p: { frase: number }) => p.frase), [1, 3]);
  assert.equal(v.plan.destination, DEST);
  assert.equal(v.confirm, undefined, "sem trecho sorteado na vista (31/10/2026)");
  // cada passo é assinado pela chave da própria frase; nenhuma principal entra (nem como pagadora)
  const mains = S().frases.map((f) => f.main);
  for (const [f, mine] of [[f1, a], [f3, c]] as const) {
    for (const st of f.plan!.steps) {
      assert.equal(f.signers.get(st.walletIndex)?.address, st.wallet, `frase ${f.n}, N=${st.walletIndex}`);
      assert.ok(mine.includes(st.wallet));
      assert.ok(!mains.includes(st.wallet));
    }
    assert.equal(f.signers.get(f.plan!.feePayerIndex)?.address, f.plan!.feePayer);
    assert.ok(!mains.includes(f.plan!.feePayer));
  }
  assert.ok(!f3.plan!.steps.some((st) => st.walletIndex === 0), 'Conta 1 da Phantom fora');
});

// ---------- empréstimo das taxas entre frases (/api/financiar) ----------

// a frase que espera (feeWait) e a temporária sugerida (N=0 da noSol)
const waiting = (n: number) => S().frases.find((f) => f.n === n)!;
const fr = async (n: number) => (JSON.parse((await getState()).body).frases as Array<{ n: number; fundingOffer: unknown; funding: unknown }>).find((f) => f.n === n)!;

test('depósito único: duas frases sem SOL viram UM pedido (uma carteira, um valor); o depósito chega, o repasse sai sozinho, e o repassado fica isento', async () => {
  await reset();
  chain();
  world.applySends = true;
  sv.setExternalForTest({ ...baseExternal(), fundingSleep: () => new Promise<void>((r) => setTimeout(r, 15)) });
  try {
    const b = noSol(PHRASES[1]); // 100 lamports e uma conta vazia
    const c = noSol(PHRASES[2]);
    await analyse([item(PHRASES[1]), item(PHRASES[2])]);
    const single = () => sv.viewForTest().single!;
    const [n1, n2] = [S().frases[0].feeNeed!, S().frases[1].feeNeed!];
    assert.ok(n1 && n2, 'as duas esperam');
    assert.equal(single().hub, b, 'a central é a pagadora sugerida da 1ª frase que espera');
    assert.deepEqual(single().frases, [1, 2]);
    assert.equal(single().lamports, n1.sendLamports + n2.sendLamports + FUND_TX_FEE_LAMPORTS, 'a central + o repasse + a taxa do repasse');
    assert.deepEqual(single().forwards.map((fw) => [fw.toFrase, fw.to, fw.lamports]), [[2, c, n2.sendLamports]]);
    assert.equal(single().status, 'esperando');
    // depósito pela metade: nada é repassado, e a central não monta o plano antes
    const sent0 = world.sent.length;
    world.lamports.set(b, 100 + Number(n1.sendLamports));
    await until(() => single().received === n1.sendLamports, 'chegou a metade');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(world.sent.length, sent0, 'nada enviado com o valor pela metade');
    assert.ok(S().frases[0].feeWait, 'a central segura o plano até repassar');
    // o resto chega: o repasse sai sozinho, da central para a pagadora da frase 2, com o valor exato
    world.lamports.set(b, 100 + Number(single().lamports));
    await until(() => single().status === 'pronto', 'repasse feito');
    assert.equal(world.sent.length, sent0 + 1);
    assert.deepEqual(world.sent.at(-1)!.from, [b]);
    assert.equal(world.lamports.get(c), 100 + Number(n2.sendLamports), 'chegou exato na frase 2');
    assert.equal(single().forwards[0].status, 'enviado');
    assert.equal(S().forwards.length, 1, 'repasse no relatório');
    await until(() => S().frases.every((f) => !f.feeWait), 'as duas saem da espera');
    // plano: o que chegou é depósito da pessoa nas duas (isento da taxa do app), nunca SOL esquecido
    const r = await plano();
    assert.equal(r.status, 200, r.body);
    const [p1, p2] = S().frases.map((f) => f.plan!);
    assert.equal(p2.payerExemptLamports, n2.sendLamports, 'o repassado chega isento na frase 2');
    assert.ok(p1.payerExemptLamports! > 0n && p1.payerExemptLamports! <= n1.sendLamports + FUND_TX_FEE_LAMPORTS, 'a central fica isenta só do que sobrou nela');
    // pedido concluído e uma frase volta a esperar (ex.: refeita): o pedido é refeito, nunca fica o cartão velho
    const g = S().frases[1];
    g.feeWait = { code: 'no-fee-sol', params: {}, waiting: true } as never;
    g.feeNeed = n2;
    sv.syncSingleDeposit();
    assert.equal(single().status, 'esperando');
    assert.deepEqual([single().hub, single().frases], [c, [2]], 'novo pedido só com a frase que espera');
    S().single!.abort.abort();
  } finally {
    sv.setExternalForTest(baseExternal());
  }
});

test('depósito único: resolver uma frase por empréstimo desfaz o pedido; ele volta só com quem ainda espera', () => {
  const need = (w: string, l: bigint) => new FeePayerError(l, 0, w);
  const a = sv.singleDepositFor([{ n: 3, need: need('C', 7n) }, { n: 2, need: need('B', 5n) }])!;
  assert.equal(a.hubFrase, 2, 'central = a de menor número');
  assert.equal(a.lamports, 5n + 7n + FUND_TX_FEE_LAMPORTS);
  const one = sv.singleDepositFor([{ n: 3, need: need('C', 7n) }])!;
  assert.deepEqual([one.hub, one.lamports, one.forwards.length], ['C', 7n, 0], 'uma frase só: o depósito dela, sem repasse');
  assert.equal(sv.singleDepositFor([]), null);
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'app', 'server.ts'), 'utf8'), /if \(result\.status === 'enviado'\) dropSingle\(\);/);
});

test('frases/financiar: frase sem SOL ganha a oferta da frase rica; o envio vai da pagadora dela para a N=0 e a espera segue sozinha', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]); // 0,05 SOL em cada: sobra
  const b = noSol(PHRASES[1]); // 100 lamports e uma conta vazia
  useWallets(PHRASES[2], 'solflare', [0], 100); // pobre também: não empresta
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  const f2 = waiting(2);
  assert.ok(f2.feeWait?.waiting && f2.feeNeed, 'frase 2 espera o depósito');
  const offer = (await fr(2)).fundingOffer as { fromFrase: number; fromName: string; from: string; toName: string; to: string; lamports: string };
  assert.ok(offer, 'oferta no estado da frase 2');
  assert.equal(offer.fromFrase, 1);
  assert.ok(a.includes(offer.from), 'a emprestadora é uma temporária da frase 1');
  assert.equal(offer.to, b);
  assert.equal(offer.toName, 'N=0');
  // reserva da frase 2: 2 transações (fechar a conta, enviar o SOL) × 15 000 + aluguel mínimo 890 880 = 920 880; pedido
  // = reserva + 20% (1 105 056) menos os 100 lamports que a N=0 já tem, para cima em 0,000001 SOL
  assert.equal(BigInt(offer.lamports), 1_105_000n, 'o mesmo valor que se pediria à pessoa: só o que falta, com folga');
  assert.equal(BigInt(offer.lamports), f2.feeNeed!.sendLamports);
  assert.equal((await fr(1)).fundingOffer, null, 'quem não espera não tem oferta');
  assert.ok((await fr(3)).fundingOffer, 'a frase 3 também espera e também recebe oferta da frase 1');

  // o envio: uma transação, da pagadora da frase 1 para a N=0 da frase 2, com o valor exato; simulada antes
  const sent0 = world.sent.length;
  const r = await post('/api/financiar', { frase: 2 });
  assert.equal(r.status, 200, r.body);
  assert.equal(world.sent.length, sent0 + 1);
  const tx = world.sent.at(-1)!;
  assert.deepEqual(tx.from, [offer.from]);
  const simKeys = world.simKeys.at(-1)!;
  assert.ok(simKeys.includes(offer.from) && simKeys.includes(b), 'simulada com as duas temporárias');
  assert.equal(S().busy, null);
  const v = (await fr(2)).funding as { fromFrase: number; status: string; link: string | null; lamports: string; toName: string };
  assert.equal(v.fromFrase, 1);
  assert.equal(v.status, 'enviado');
  assert.ok(v.link?.includes(tx.signature), 'link da transação no cartão');
  assert.equal(BigInt(v.lamports), 1_105_000n);
  assert.equal((await fr(2)).fundingOffer, null, 'depois de enviado, a oferta some');
  assert.equal(S().fundings.length, 1);
  // nenhuma principal assina nem recebe
  const mains = S().frases.map((f) => f.main);
  assert.ok(!mains.includes(offer.from) && !mains.includes(offer.to));

  // o SOL "chega" (a rede falsa não move saldo sozinha): a espera vê e a frase 2 sai da espera, como num depósito
  world.lamports.set(b, 100 + 1_105_000);
  const before = events.length;
  const rr = await post('/api/conferir-saldo', { n: 2 });
  assert.equal(rr.status, 200, rr.body);
  await until(() => events.slice(before).some((e) => e.type === 'fundos'), 'evento fundos');
  assert.equal(f2.feeWait, null);
  assert.equal(f2.feeWarning, null);
  // de novo: recusado (não está mais esperando)
  const again = await post('/api/financiar', { frase: 2 });
  assert.equal(again.status, 400);
});

test('frases/financiar: sem frase rica não há oferta e o pedido é recusado; frase inexistente ou sem espera → 400', async () => {
  await reset();
  chain();
  noSol(PHRASES[0]);
  useWallets(PHRASES[1], 'solflare', [0], 2_000_000); // 0,002 SOL: paga a própria limpeza, mas não sobra o dobro da reserva
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.ok(waiting(1).feeWait);
  assert.equal((await fr(1)).fundingOffer, null);
  for (const frase of [1, 2, 9, 'x']) {
    const r = await post('/api/financiar', { frase });
    assert.equal(r.status, 400, String(frase));
  }
  assert.equal(world.sent.length, 0, 'nada enviado');
});

test('frases/financiar: depois do /api/plano a oferta usa o plano real da emprestadora, e a simulação que não bate para tudo sem enviar', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = noSol(PHRASES[1]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  const r = await plano();
  assert.equal(r.status, 200, r.body);
  const f1 = waiting(1);
  assert.ok(f1.plan && waiting(2).feeWait);
  const offer = (await fr(2)).fundingOffer as { from: string; to: string };
  assert.equal(offer.from, f1.plan!.feePayer);
  assert.ok(a.includes(offer.from) && offer.to === b);
  // a rede falsa entrega 1 lamport a mais no destino: resultado inesperado → parado antes de enviar
  world.tamper.add(offer.from);
  const bad = await post('/api/financiar', { frase: 2 });
  assert.equal(bad.status, 400, bad.body);
  assert.match(JSON.parse(bad.body).erro, /inesperado/);
  assert.equal(world.sent.length, 0);
  assert.equal(waiting(2).funding, null);
  assert.ok(waiting(2).feeWait, 'continua esperando');
  world.tamper.clear();
  // ocupado: recusado
  S().busy = 'simulacao';
  const busy = await post('/api/financiar', { frase: 2 });
  assert.equal(busy.status, 400);
  S().busy = null;
});

// ---------- juntar o SOL da própria frase na pagadora (src/core/limpeza/gather.ts) ----------
// Valores de verdade: toda temporária com SOL tem pelo menos o aluguel de conta vazia (890 880 na rede falsa, como na
// devnet), e a rede falsa recusa conta que perde SOL e fica entre 0 e o aluguel (InsufficientFundsForRent).

type GatherView = {
  gatherOffer: { toIndex: number; toName: string; to: string; lamports: string; from: number; transfers: Array<{ fromIndex: number; fromName: string; from: string; lamports: string; all: boolean }> } | null;
  gathering: { toName: string; to: string; lamports: string; sentLamports: string; sent: number; total: number; status: string; results: Array<{ status: string; link: string | null; detail: string | null; walletIndex: number }> } | null;
  fundingOffer: unknown;
};
const gv = async (n: number) => (await fr(n)) as unknown as GatherView;

test('frases/juntar: SOL espalhado ganha a oferta; a remetente sem mais nada a limpar manda tudo (fica com 0) e paga a própria taxa; a espera segue sozinha', async () => {
  await reset();
  chain();
  // 4 temporárias com 900 000: todas acima do aluguel, nenhuma cobre a reserva (4 × 15 000 + 890 880 = 950 880)
  const w = useWallets(PHRASES[0], 'solflare', [0, 1, 2, 3], 900_000);
  await analyse([item(PHRASES[0])]);
  const f1 = waiting(1);
  assert.ok(f1.feeWait?.waiting && f1.feeNeed, 'frase 1 espera o depósito');
  // a N=0 já tem 900 000: o pedido é só o que falta nela (até a reserva exata, 50 880; com a folga, 241 056 → 242 000)
  assert.deepEqual([f1.feeNeed.haveLamports, f1.feeNeed.reserveLamports, f1.feeNeed.sendLamports], [900_000n, 50_880n, 242_000n]);
  const offer = (await gv(1)).gatherOffer!;
  assert.ok(offer, 'oferta de juntar no estado da frase');
  assert.equal(offer.to, w[0], 'empate de saldo: a N=0 recebe');
  assert.equal(offer.toName, 'N=0');
  // faltam 50 880; o excedente da N=1 acima do aluguel não dá (900 000 − 50 000 − 890 880 < 0): ela manda tudo
  assert.deepEqual(offer.transfers.map((t) => [t.from, t.fromName, BigInt(t.lamports), t.all]), [[w[1], 'N=1', 850_000n, true]]);
  assert.equal(offer.from, 1);
  assert.equal((await gv(1)).fundingOffer, null, 'uma frase só: ninguém empresta');

  const sent0 = world.sent.length;
  const r = await post('/api/juntar', { frase: 1 });
  assert.equal(r.status, 200, r.body);
  assert.equal(world.sent.length, sent0 + 1);
  const tx = world.sent.at(-1)!;
  assert.deepEqual(tx.from, [w[1]]);
  assert.equal(world.simKeys.at(-1)![0], w[1], 'a remetente é a primeira conta da transação: ela paga a taxa');
  const g = (await gv(1)).gathering!;
  assert.equal(g.status, 'enviado');
  assert.deepEqual([g.sent, g.total], [1, 1]);
  assert.equal(BigInt(g.sentLamports), 895_000n, 'tudo: 900 000 − 5 000 de taxa, calculado na hora do envio');
  assert.ok(g.results[0].link?.includes(tx.signature), 'link da transação no cartão');
  assert.equal(S().gatherings.length, 1);
  assert.ok(!tx.from.includes(f1.main!) && offer.to !== f1.main, 'a principal nunca entra');

  // o SOL "chega": a espera vê e a frase sai da espera, como num depósito
  world.lamports.set(w[0], 900_000 + 895_000);
  world.lamports.set(w[1], 0);
  const before = events.length;
  assert.equal((await post('/api/conferir-saldo', { n: 1 })).status, 200);
  await until(() => events.slice(before).some((e) => e.type === 'fundos'), 'evento fundos');
  assert.equal(waiting(1).feeWait, null);
  assert.equal((await gv(1)).gatherOffer, null, 'sem espera, sem oferta');
  assert.ok((await gv(1)).gathering, 'o que foi juntado continua no cartão');
});

test('frases/juntar: alvo cheio com 3 remetentes; uma falha não para as outras (parcial, 200); as leituras ficam com os saldos novos e a oferta seguinte pede só o que falta, do excedente', async () => {
  await reset();
  chain();
  // N=0 com 5 500 000 e 771 contas vazias: reserva = (771 + 4 envios) × 15 000 + 890 880 = 12 515 880; o pedido
  // (+20%, para cima em 0,000001 SOL) deixa a pagadora com 15 020 000: faltam 9 520 000. As outras (5, 4,5 e 1 milhão)
  // mandam tudo, da mais rica para a mais pobre: 4 950 000 + 4 450 000 + 950 000 (estimativas: saldo − 50 000 de folga)
  const w = useWallets(PHRASES[0], 'solflare', [0, 1, 2, 3], 1_000_000);
  world.lamports.set(w[0], 5_500_000);
  world.lamports.set(w[1], 5_000_000);
  world.lamports.set(w[2], 4_500_000);
  // endereços de largura fixa (o emptyAccount repete endereço depois de algumas centenas: '1' e '11' completados com '1')
  const code = (i: number) => i.toString(9).replace(/[0-8]/g, (d) => String(Number(d) + 1)).padStart(4, '1');
  world.tokens.set(w[0], Array.from({ length: 771 }, (_, i) => ({ ...emptyAccount(w[0]), pubkey: `EmpBig${'A'.repeat(34)}${code(i)}` })));
  await analyse([item(PHRASES[0])]);
  assert.equal(waiting(1).feeNeed!.sendLamports, 9_520_000n);
  const offer = (await gv(1)).gatherOffer!;
  assert.equal(offer.to, w[0]);
  assert.deepEqual(offer.transfers.map((t) => [t.fromIndex, BigInt(t.lamports), t.all]), [[1, 4_950_000n, true], [2, 4_450_000n, true], [3, 950_000n, true]]);
  world.badStatus.add(w[2]); // o envio da N=2 é aceito e a rede responde erro na confirmação
  world.applySends = true; // os outros envios movem o saldo (e a taxa) na rede falsa
  const sent0 = world.sent.length;
  const r = await post('/api/juntar', { frase: 1 });
  assert.equal(r.status, 200, r.body);
  assert.equal(world.sent.length, sent0 + 3, 'a falha de uma não para as outras');
  const g = (await gv(1)).gathering!;
  assert.equal(g.status, 'parcial');
  assert.deepEqual([g.sent, g.total], [2, 3]);
  assert.equal(BigInt(g.sentLamports), 4_995_000n + 995_000n);
  assert.deepEqual(g.results.map((x) => [x.walletIndex, x.status]), [[1, 'enviado'], [2, 'falhou'], [3, 'enviado']]);
  assert.ok(g.results[1].detail, 'o motivo da falha fica no cartão');
  // nenhuma remetente ficou entre 0 e o aluguel: as que mandaram tudo têm 0, a que falhou continua com o dela
  assert.deepEqual(w.slice(1).map((a) => world.lamports.get(a)), [0, 4_500_000, 0]);
  // o servidor leu os saldos novos logo depois de enviar
  assert.equal(waiting(1).scans.find((x) => x.index === 0)!.lamports, 5_500_000 + 4_995_000 + 995_000);
  assert.equal(waiting(1).scans.find((x) => x.index === 2)!.lamports, 4_500_000);
  // a N=0 tem 11 490 000 (abaixo da reserva: continua esperando) e faltam 3 530 000 para o alvo; o excedente da N=2
  // acima do aluguel (3 559 120) basta, sem mandar tudo
  assert.ok(waiting(1).feeWait, 'continua esperando');
  const again = (await gv(1)).gatherOffer!;
  assert.deepEqual(again.transfers.map((t) => [t.from, BigInt(t.lamports), t.all]), [[w[2], 3_530_000n, false]]);
  world.badStatus.clear();
});

test('frases/juntar: Phantom nunca recebe a oferta (contas protegidas); Phantom sem o plano de verdade não empresta', async () => {
  await reset();
  chain();
  // Phantom com 4 contas de 900 000 (Conta 1 = principal, fora das leituras): juntando daria, mas a oferta não aparece
  useWallets(PHRASES[3], 'phantom', [0, 1, 2, 3, 4], 900_000);
  await analyse([item(PHRASES[3], 'phantom')]);
  assert.ok(waiting(1).feeWait, 'Phantom esperando o depósito');
  assert.equal((await gv(1)).gatherOffer, null, 'nenhuma oferta de juntar na Phantom');
  assert.equal((await post('/api/juntar', { frase: 1 })).status, 400);
  // Phantom rica antes do /api/plano: o plano de teste vê as contas protegidas, então ela não empresta
  await reset();
  chain();
  useWallets(PHRASES[3], 'phantom', [0, 1, 2]);
  noSol(PHRASES[1]);
  await analyse([item(PHRASES[3], 'phantom'), item(PHRASES[1])]);
  assert.ok(waiting(2).feeWait);
  assert.equal((await gv(2)).fundingOffer, null, 'sem o plano de verdade da Phantom, ninguém empresta');
});

test('frases/juntar: sem SOL suficiente na frase não há oferta e o pedido é recusado; frase sem espera → 400; simulação que não bate para tudo sem enviar; ocupado → 400', async () => {
  await reset();
  chain();
  const w = useWallets(PHRASES[0], 'solflare', [0, 1, 2, 3], 900_000); // juntas cobrem
  useWallets(PHRASES[1], 'solflare', [0, 1], 100); // juntas, 200 lamports: não cobrem
  useWallets(PHRASES[2], 'solflare', [0]); // rica: não espera
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  assert.ok(waiting(2).feeWait);
  assert.equal((await gv(2)).gatherOffer, null, 'juntando tudo não chega na reserva');
  assert.ok((await gv(2)).fundingOffer, 'mas a frase 3 pode emprestar');
  const no = await post('/api/juntar', { frase: 2 });
  assert.equal(no.status, 400, no.body);
  assert.match(JSON.parse(no.body).erro, /não têm SOL para as taxas/);
  const none = await post('/api/juntar', { frase: 3 });
  assert.equal(none.status, 400);
  assert.match(JSON.parse(none.body).erro, /não está esperando/);
  assert.equal((await post('/api/juntar', { frase: 9 })).status, 400);
  // a rede falsa entrega 1 lamport a mais na pagadora: resultado inesperado → parado antes de enviar
  world.tamper.add(w[1]);
  const sent0 = world.sent.length;
  const bad = await post('/api/juntar', { frase: 1 });
  assert.equal(bad.status, 400, bad.body);
  assert.match(JSON.parse(bad.body).erro, /inesperado/);
  assert.equal(world.sent.length, sent0);
  assert.equal((await gv(1)).gathering, null);
  assert.ok(waiting(1).feeWait, 'continua esperando');
  assert.ok((await gv(1)).gatherOffer, 'a oferta continua');
  world.tamper.clear();
  // a oferta existe SÓ enquanto a frase espera
  assert.ok(sv.gatherOfferFor(waiting(1)), 'esperando: oferta');
  assert.equal(sv.gatherOfferFor({ ...waiting(1), feeWait: null }), null, 'sem espera: sem oferta, mesmo com feeNeed');
  assert.equal(sv.gatherOfferFor({ ...waiting(1), feeNeed: null }), null);
  S().busy = 'simulacao';
  const busy = await post('/api/juntar', { frase: 1 });
  assert.equal(busy.status, 400);
  S().busy = null;
  assert.equal(S().gatherings.length, 0);
});

test('frases/plano: nenhuma frase com plano → 400 com o código do primeiro erro (e a espera começa)', async () => {
  await reset();
  chain();
  noSol(PHRASES[0]);
  await analyse([item(PHRASES[0]), item(PHRASES[4])]); // a frase 2 não tem nenhuma usada
  const r = await plano();
  assert.equal(r.status, 400, r.body);
  assert.equal(JSON.parse(r.body).codigo, 'no-fee-sol');
  assert.ok(S().frases[0].feeWait?.waiting);
});

test('frases/recibo: sem nenhuma frase simulada o recibo é null (e o estado responde)', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  const r = await plano();
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).receipt, null);
  const st = await getState();
  assert.equal(st.status, 200);
  assert.equal(JSON.parse(st.body).receipt, null);
});

// Taxa do app (autor, 31/10/2026): pelo /api/plano de verdade, o depósito que chega na espera vira o isento da
// pagadora; o SOL que ela já tinha na análise (esquecido) não. Prende a ligação montarPlano → depositsOf → buildPlan.
test('frases/plano: depósito que chega na espera vira o isento da pagadora; o SOL da análise não', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const w2 = noSol(PHRASES[1]); // 100 lamports na análise
  const sleeps: Array<() => void> = [];
  sv.setExternalForTest({ ...baseExternal(), fundingSleep: () => new Promise<void>((r) => sleeps.push(r)) });
  try {
    await analyse([item(PHRASES[0]), item(PHRASES[1])]);
    const [f1, f2] = S().frases;
    assert.equal((await plano()).status, 200);
    assert.ok(f1.plan && !f2.plan && f2.feeWait);
    assert.equal(f1.plan!.payerExemptLamports, 0n, 'frase 1: só SOL esquecido, nada isento');
    world.lamports.set(w2, 30_000_000); // o depósito chega
    for (let i = 0; i < 20 && !f2.plan; i++) {
      for (const wake of sleeps.splice(0)) wake();
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(f2.plan, 'o plano da frase 2 entrou depois do depósito');
    assert.equal(f2.plan!.feePayer, w2);
    assert.equal(f2.plan!.payerExemptLamports, 30_000_000n - 100n, 'isento = só o que chegou depois da análise');
  } finally {
    sv.setExternalForTest(baseExternal());
    for (const f of S().frases) sv.cancelFundingWait(f);
  }
});

test('frases/plano: depósito da frase 2 chega depois de simular → não entra no plano, simulação continua válida', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const w2 = noSol(PHRASES[1]);
  // a espera dorme até o teste deixar (sem relógio)
  const sleeps: Array<() => void> = [];
  sv.setExternalForTest({ ...baseExternal(), fundingSleep: () => new Promise<void>((r) => sleeps.push(r)) });
  try {
    await analyse([item(PHRASES[0]), item(PHRASES[1])]);
    const [f1, f2] = S().frases;
    assert.equal((await plano()).status, 200);
    const ctl = f2.fundingAbort!;
    assert.ok(ctl && f1.plan && !f2.plan);
    await task('/api/simular');
    assert.equal(S().aborted, null);
    assert.ok(S().simResults.length > 0 && S().simResults.every((x) => x.frase === 1));
    assert.equal(ctl.signal.aborted, true, 'simular cancela a espera da frase 2');
    assert.equal(f2.fundingAbort, null);
    assert.equal(f2.feeWait, null);
    const sims = S().simResults;

    world.lamports.set(w2, 50_000_000); // o depósito chega
    for (const wake of sleeps.splice(0)) wake();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f2.plan, null, 'depósito tardio não entra no plano');
    assert.equal(S().simResults, sims, 'simulação continua valendo');

    // trava extra: frase com plano e sem simulação (se um plano entrasse depois de simular) não deixa executar
    f2.plan = sv.planForWait({ scans: f2.scans.map((x) => ({ ...x, lamports: 50_000_000 })), decisions: new Map(), destino: DEST, app: 'solflare', prices: new Map(), rentExemptZero: 890_880 });
    const unsimulated = await post('/api/executar', { confirmacao: typedCode() });
    assert.equal(unsimulated.status, 400);
    assert.match(JSON.parse(unsimulated.body).erro, /Simule antes/);
    assert.equal(S().execResults.length, 0);
    f2.plan = null;

    await task('/api/executar', { confirmacao: typedCode() });
    assert.equal(S().aborted, null);
    assert.ok(S().execResults.length > 0 && S().execResults.every((x) => x.frase === 1 && x.status === 'enviado'));
  } finally {
    for (const wake of sleeps.splice(0)) wake();
    sv.setExternalForTest(baseExternal());
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('frases/simular: abort na frase 1 não roda a frase 2', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.lamports.set(a[0], 60_000_000); // a N=0 é a pagadora: o passo dela é o último da frase 1
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  assert.equal(S().frases[0].plan!.steps.at(-1)!.wallet, a[0]);
  world.tamper.add(a[0]); // a simulação do último passo da frase 1 mostra valor inesperado no destino
  const n0 = events.length;
  await task('/api/simular');
  assert.match(S().aborted ?? '', /Resultado inesperado/);
  assert.equal(JSON.parse((await getState()).body).abortedFrase, 1);
  assert.ok(S().simResults.length > 0 && S().simResults.every((x) => x.frase === 1), 'a frase 1 rodou até parar');
  assert.ok(!world.simKeys.some((keys) => keys.some((k) => b.includes(k))), 'nenhuma transação da frase 2 simulada');
  const prog = events.slice(n0).filter((e) => e.type === 'progresso').map((e) => JSON.parse(e.data));
  assert.ok(prog.length > 0 && prog.every((p) => p.fase === 'simulacao' && p.frase === 1));
  assert.equal(S().progress, null);
  const r = await post('/api/executar', { confirmacao: typedCode() });
  assert.equal(r.status, 400);
  assert.match(JSON.parse(r.body).erro, /parou por segurança/);
});

test('frases/executar: segunda execução recusada (uma por rodada)', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  await task('/api/executar', { confirmacao: typedCode() });
  try {
    assert.ok(S().executed);
    assert.deepEqual([...new Set(S().execResults.map((x) => x.frase))], [1, 2]);
    const again = await post('/api/executar', { confirmacao: typedCode() });
    assert.equal(again.status, 400);
    assert.match(JSON.parse(again.body).erro, /já foi executado/);
    const replan = await plano();
    assert.equal(replan.status, 400, 'plano novo depois de executar também não');
    assert.match(JSON.parse(replan.body).erro, /já foi executado/);
    assert.equal((await post('/api/simular', {})).status, 400);
    assert.ok(S().executed);
  } finally {
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('exatidão: depois do envio o app confere as carteiras; o que sobrou vira uma rodada nova, sem colar a frase', async () => {
  await reset();
  chain();
  world.applySends = true;
  const [w0, w1] = useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  world.badStatus.add(w1); // o envio da N=1 da frase 1 falha na rede: o SOL dela fica lá
  try {
    assert.equal((await post('/api/conferir', {})).status, 400, 'conferência só depois do envio');
    await task('/api/executar', { confirmacao: typedCode() });
    assert.equal(sv.viewForTest().leftover, null, 'ainda não conferiu');
    assert.equal((await post('/api/sobras', {})).status, 400, 'limpar a sobra só depois de conferir');
    await task('/api/conferir');
    const lo = sv.viewForTest().leftover!;
    assert.equal(lo.clean, false);
    assert.equal(lo.wallets, 1, 'só a N=1 da frase 1');
    assert.equal(lo.lamports, BigInt(world.lamports.get(w1)!));
    assert.equal(world.lamports.get(w0), 0, 'a outra foi esvaziada');
    assert.ok(S().executed, 'conferir não muda a rodada');
    // "Limpar o que sobrou": rodada nova com as mesmas chaves, sem a frase (a seed já foi apagada)
    world.badStatus.clear();
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
    const calls0 = world.sigCalls.length;
    await task('/api/sobras');
    assert.equal(world.sigCalls.length, calls0, 'nada de busca: usa a leitura da conferência');
    assert.equal(S().executed, false);
    assert.deepEqual([S().simResults.length, S().execResults.length], [0, 0]);
    assert.equal(sv.viewForTest().leftover, null);
    assert.ok(S().frases.every((f) => f.seed === null && f.signers.size > 0));
    assert.equal((await plano()).status, 200);
    await task('/api/simular');
    await task('/api/executar', { confirmacao: typedCode() });
    assert.ok(S().execResults.length > 0 && S().execResults.every((r) => r.status === 'enviado'));
    assert.equal(world.lamports.get(w1), 0, 'a sobra chegou ao destino');
    await task('/api/conferir');
    assert.equal(sv.viewForTest().leftover!.clean, true);
  } finally {
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('exatidão: sobra = SOL que paga o próprio envio, contas para fechar, creator fees e leitura incompleta; moedas e poeira não', () => {
  const scan = (over: Record<string, unknown>) => ({ index: 0, address: 'x', lamports: 0, tokens: [], fees: null, errors: [], ...over }) as never;
  const token = (kind: string, blockers: string[] = []) => ({ account: 'a', mint: 'm', program: 'token', amount: 0n, decimals: 0, rentLamports: 2_039_280, kind, blockers });
  assert.deepEqual(sv.leftoverOf([scan({ lamports: sv.LEFTOVER_MIN_LAMPORTS - 1 }), scan({ tokens: [token('fungible'), token('nft'), token('empty', ['congelada'])] })]), { lamports: 0n, closable: 0, creatorFees: 0n, unread: 0, wallets: 0, clean: true });
  const fees = { bondingVaultLamports: 300, ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptError: null };
  const lo = sv.leftoverOf([scan({ lamports: sv.LEFTOVER_MIN_LAMPORTS }), scan({ tokens: [token('empty'), token('wsol')] }), scan({ fees }), scan({ errors: ['contas de token: x'] })]);
  assert.deepEqual(lo, { lamports: BigInt(sv.LEFTOVER_MIN_LAMPORTS), closable: 2, creatorFees: 300n, unread: 1, wallets: 4, clean: false });
});

test('frases/relatório: uma seção por frase; recibo agregado; "já chegou" soma o líquido do destino', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'phantom', [1, 2]);
  const c = useWallets(PHRASES[2], 'solflare', [0, 1, 2]);
  await analyse([item(PHRASES[0]), item(PHRASES[1], 'phantom'), item(PHRASES[2])]);
  assert.equal((await plano({ porFrase: { 2: { protegidas: [], contasConfirmadas: 2 } } })).status, 200);
  const n0 = events.length;
  await task('/api/simular');
  assert.equal(S().aborted, null);
  // progresso da simulação: frases em ordem, rótulo da carteira da frase, porcentagem nunca volta
  const prog = events.slice(n0).filter((e) => e.type === 'progresso').map((e) => JSON.parse(e.data));
  assert.deepEqual([...new Set(prog.map((p) => p.frase))], [1, 2, 3]);
  assert.ok(prog.every((p) => p.fase === 'simulacao'));
  assert.ok(prog.filter((p) => p.frase === 2).every((p) => /^Conta \d+$/.test(p.carteira)));
  assert.ok(prog.filter((p) => p.frase === 1).every((p) => /^N=\d+$/.test(p.carteira)));
  for (let i = 1; i < prog.length; i++) assert.ok(prog[i].geral.feitos / prog[i].geral.total >= prog[i - 1].geral.feitos / prog[i - 1].geral.total);
  assert.equal(prog.at(-1).geral.total, S().frases.reduce((k, f) => k + f.plan!.steps.length, 0));
  // tempo restante em TODO aviso, desde o 1º passo (prévia da etapa, antes de haver medição)
  assert.ok(prog.length > 0 && prog.every((p) => Number.isFinite(p.etaMs) && p.etaMs >= 0), `etaMs: ${JSON.stringify(prog.map((p) => p.etaMs))}`);
  // recibo agregado: um por frase, somas
  const v = JSON.parse((await getState()).body);
  assert.deepEqual(v.receipt.frases.map((x: { frase: number }) => x.frase), [1, 2, 3]);
  const sims = S().simResults.filter((x) => x.status === 'simulado');
  assert.equal(BigInt(v.receipt.totalLamports), sumBig(sims.map((x) => x.destinationDelta)));
  assert.equal(BigInt(v.receipt.appFeeLamports), sumBig(sims.map((x) => x.appFeeDelta)));
  assert.ok(BigInt(v.receipt.appFeeLamports) > 0n, 'a taxa do app aparece no recibo agregado');
  assert.equal(v.arrived, '0');

  await task('/api/executar', { confirmacao: typedCode() });
  const file = S().reportFile!;
  try {
    assert.equal(S().aborted, null);
    const sent = S().execResults.filter((x) => x.status === 'enviado');
    const st = JSON.parse((await getState()).body);
    assert.equal(BigInt(st.arrived), sumBig(sent.map((x) => x.destinationDelta)), 'já chegou = líquido no destino');
    assert.equal(BigInt(st.arrivedAppFee), sumBig(sent.map((x) => x.appFeeDelta)));
    assert.ok(BigInt(st.arrived) > 0n);
    // tela final: recibo do que foi enviado, por frase, com total = o que chegou (achado de um tester, 31/10/2026)
    assert.deepEqual(st.execReceipt.frases.map((x: { frase: number }) => x.frase), [1, 2, 3]);
    assert.equal(BigInt(st.execReceipt.totalLamports), BigInt(st.arrived), 'tela final: total = já chegou');
    assert.equal(st.receipt.frases.length, 3, 'o recibo da Confirmar continua lá');
    // ...e vem da execução, não da simulação: um passo a menos enviado muda a tela final e não muda a Confirmar
    const all = S().execResults.slice();
    const gone = all.findIndex((x) => x.status === 'enviado' && (x.destinationDelta ?? 0n) > 0n);
    S().execResults.splice(gone, 1);
    const st2 = JSON.parse((await getState()).body);
    S().execResults.splice(0, S().execResults.length, ...all);
    assert.equal(BigInt(st2.execReceipt.totalLamports), BigInt(st.arrived) - all[gone].destinationDelta!, 'tela final segue o que foi enviado');
    assert.equal(st2.receipt.totalLamports, st.receipt.totalLamports, 'Confirmar não muda');
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rep.destination, DEST);
    assert.equal(rep.cluster, 'devnet');
    assert.equal(rep.aborted, null);
    assert.deepEqual(rep.frases.map((x: { n: number; app: string }) => [x.n, x.app]), [[1, 'solflare'], [2, 'phantom'], [3, 'solflare']]);
    for (const [i, sec] of (rep.frases as Array<{ n: number; plan: { destination: string }; results: Array<{ frase: number; step: { wallet: string } }> }>).entries()) {
      const mine = [a, b, c][i];
      assert.equal(sec.plan.destination, DEST);
      assert.ok(sec.results.length > 0);
      assert.ok(sec.results.every((x) => x.frase === sec.n && mine.includes(x.step.wallet)), `seção da frase ${sec.n} só com as carteiras dela`);
    }
    const text = fs.readFileSync(file, 'utf8');
    for (const w of LONG_WORDS) assert.doesNotMatch(text, new RegExp(`\\b${w}\\b`, 'i'), 'nenhuma palavra de frase no relatório');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('frases/progresso: o tempo da análise existe desde o 1º aviso (prévia) e conta a busca das carteiras usadas', () => {
  const f1 = sv.newFrase(1, 'solflare', Buffer.alloc(64));
  const f2 = sv.newFrase(2, 'phantom', Buffer.alloc(64));
  const f3 = sv.newFrase(3, 'solflare'); // frase errada, sem seed: fora da conta
  const tr = sv.makeTracker([f1, f2, f3], false);
  const P = () => S().progress!;
  // busca = discoveryReqPerFrase requisições, em "carteiras lidas" de analysisReqPerWallet cada (~39)
  assert.ok(Math.abs(sv.DISCOVERY_WORK - RUN_COSTS.discoveryReqPerFrase / RUN_COSTS.analysisReqPerWallet) < 1e-9);
  const D = sv.DISCOVERY_WORK;
  // 1º aviso (conferindo o RPC): nada medido ainda, vale a prévia da etapa, a mesma do botão (RPC público, 2 frases)
  tr.report('rpc', null, 0, 0);
  const prior = estimateRun({ frases: 2, customRpc: false, stage: 'analysis' }).seconds * 1000;
  assert.ok(Math.abs(P().etaMs! - prior) < 1e-6, `${P().etaMs} vs ${prior}`); // conta em ponto flutuante
  assert.deepEqual(P().geral, { feitos: 0, total: 200 });
  // busca da frase 1 pela metade: a tela não conta carteira lida, mas o tempo anda (metade de D feita)
  f1.status = 'busca';
  tr.report('busca', f1, 60, 120);
  assert.deepEqual(P().geral, { feitos: 0, total: 200 });
  const work0 = 2 * (100 + D);
  const meio = (prior * (work0 - D / 2)) / work0;
  assert.ok(Math.abs(P().etaMs! - meio) < 1, `${P().etaMs} vs ${meio}`);
  assert.ok(P().etaMs! < prior);
  // busca achou 37 (não 100): total da tela e tempo caem na hora; a busca inteira conta como feita
  f1.discovery = { wallets: Array.from({ length: 37 }, (_, index) => ({ index })) } as never;
  f1.status = 'leitura';
  tr.report('leitura', f1, 0, 37);
  assert.deepEqual(P().geral, { feitos: 0, total: 137 });
  const work1 = 137 + 2 * D;
  const lendo = (prior / work0) * (work1 - D);
  assert.ok(Math.abs(P().etaMs! - lendo) < 1, `${P().etaMs} vs ${lendo}`);
  tr.report('leitura', f1, 10, 37, 'N=12');
  assert.deepEqual(P().geral, { feitos: 10, total: 137 });
  assert.equal(P().carteira, 'N=12');
  assert.ok(Math.abs(P().etaMs! - (prior / work0) * (work1 - D - 10)) < 1);
  // frase que caiu antes da busca não entra em nada (nem na tela nem no tempo)
  f2.status = 'erro';
  tr.report('leitura', f1, 37, 37);
  assert.deepEqual(P().geral, { feitos: 37, total: 37 });
  assert.ok(Math.abs(P().etaMs! - 0) < 1e-6, `${P().etaMs}`);
});

test('frases/progresso: a porcentagem nunca volta quando o total cresce (lote dividido)', () => {
  let p = sv.monotonicProgress(null, { feitos: 5, total: 10 });
  assert.deepEqual(p, { feitos: 5, total: 10 });
  // o lote dividido aumenta o total: 6 de 14 seria 43% < 50%
  const next = sv.monotonicProgress(p, { feitos: 6, total: 14 });
  assert.equal(next.total, 14);
  assert.ok(next.feitos / next.total >= p.feitos / p.total);
  assert.ok(next.feitos <= next.total);
  p = next;
  assert.ok(sv.monotonicProgress(p, { feitos: 3, total: 14 }).feitos >= p.feitos, 'feitos nunca diminui');
  assert.equal(sv.monotonicProgress(p, { feitos: 13, total: 14 }).feitos, 13);
  // um passo está começando: nunca "12 de 12" com passo pela frente (no máximo total - 1)
  assert.deepEqual(sv.monotonicProgress({ feitos: 9, total: 10 }, { feitos: 9, total: 11 }), { feitos: 10, total: 11 });
  assert.deepEqual(sv.monotonicProgress({ feitos: 11, total: 12 }, { feitos: 12, total: 12 }), { feitos: 11, total: 12 }, 'nunca mostra o total com passo pela frente');
});

test('frases/plano: erro inesperado ao montar o plano de uma frase recusa o pedido inteiro, sem plano pela metade', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0, 1]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  const [f1, f2] = S().frases;
  const before = { p1: f1.plan, p2: f2.plan };
  f2.scans[0].lamports = Infinity; // dado sujo que escapasse da leitura: BigInt(Infinity) lança no plano
  const r = await plano();
  assert.equal(r.status, 500);
  assert.ok(f1.plan === before.p1 && f2.plan === before.p2, 'nada mudou');
  assert.equal(S().busy, null);
});

// ---------- rodada de correções 1 (revisão da Tarefa 9) ----------

test('frases/executar: parada na frase 2 → frase 1 enviada, 2 e 3 não rodam; relatório com as 3 seções; rodada encerrada', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.lamports.set(b[0], 60_000_000); // pagadora da frase 2 (último passo); o 1º passo é a N=1
  const c = useWallets(PHRASES[2], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  assert.equal(S().aborted, null);
  world.simKeys.length = 0; // daqui em diante, só as simulações da execução
  world.tamper.add(b[1]); // na execução, o 1º passo da frase 2 simula valor inesperado no destino
  await task('/api/executar', { confirmacao: typedCode() });
  const st = JSON.parse((await getState()).body);
  const file = path.join(ROOT, st.reportFile);
  try {
    assert.match(S().aborted ?? '', /Resultado inesperado/);
    assert.equal(st.abortedFrase, 2);
    const ex = S().execResults;
    assert.ok(ex.length > 0 && ex.every((x) => x.frase === 1 && x.status === 'enviado' && a.includes(x.step.wallet)), 'só a frase 1, toda enviada');
    assert.ok(!world.simKeys.some((keys) => keys.some((k) => c.includes(k))), 'frase 3 nunca simulada');
    assert.equal(S().executed, true);
    for (const [p, body] of [['/api/plano', null], ['/api/simular', {}], ['/api/executar', { confirmacao: typedCode() }]] as const) {
      const r = p === '/api/plano' ? await plano() : await post(p, body);
      assert.equal(r.status, 400, `${p} depois da execução parada`);
    }
    const rep = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(rep.aborted, /Resultado inesperado/);
    assert.deepEqual(rep.frases.map((x: { n: number }) => x.n), [1, 2, 3], 'uma seção por frase, inclusive as que não rodaram');
    assert.ok(rep.frases[0].results.length > 0);
    assert.deepEqual([rep.frases[1].results, rep.frases[2].results], [[], []]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('frases/executar: "já chegou" conta só os passos enviados (falhou/desconhecido ficam fora)', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.lamports.set(a[0], 60_000_000); // pagadora; a N=1 é o 1º passo
  useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  const simDelta = S().simResults.find((x) => x.step.wallet === a[1])!.destinationDelta!;
  assert.ok(simDelta > 0n);
  world.badStatus.add(a[1]); // a rede recusa a transação da N=1 depois do envio
  await task('/api/executar', { confirmacao: typedCode() });
  try {
    const ex = S().execResults;
    const bad = ex.find((x) => x.step.wallet === a[1])!;
    assert.equal(bad.status, 'falhou');
    const sent = ex.filter((x) => x.status === 'enviado');
    assert.ok(sent.length >= 2);
    const want = sumBig(sent.map((x) => x.destinationDelta));
    assert.equal(BigInt(JSON.parse((await getState()).body).arrived), want);
    // resultado que não foi enviado, mesmo com valor, nunca soma no "já chegou"
    ex.push({ ...bad, status: 'desconhecido', destinationDelta: simDelta, appFeeDelta: 5n });
    const v = JSON.parse((await getState()).body);
    assert.equal(BigInt(v.arrived), want);
    assert.equal(BigInt(v.arrivedAppFee), sumBig(sent.map((x) => x.appFeeDelta)));
  } finally {
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('frases/plano: Phantom com todas as contas protegidas fica fora com aviso no cartão; as outras seguem', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'phantom', [1, 2]); // Conta 2 e Conta 3
  await analyse([item(PHRASES[0]), item(PHRASES[1], 'phantom')]);
  const [f1, f2] = S().frases;
  // sem a confirmação do número de contas (e sem proteger tudo), continua recusado
  assert.equal((await plano()).status, 400);
  const r = await plano({ porFrase: { 2: { protegidas: [2, 3] } } });
  assert.equal(r.status, 200, r.body);
  assert.ok(f1.plan);
  assert.equal(f2.plan, null);
  const v = JSON.parse(r.body);
  assert.deepEqual(v.frases[1].planNotice, { code: 'phantom-all-protected', params: { frase: 2 } });
  assert.equal(v.frases[0].planNotice, null);
  assert.deepEqual(v.plan.frases.map((x: { frase: number }) => x.frase), [1]);
  // a pessoa muda de ideia: o aviso some e a frase entra
  const r2 = await plano({ porFrase: { 2: { protegidas: [], contasConfirmadas: 2 } } });
  assert.equal(r2.status, 200, r2.body);
  assert.ok(f2.plan);
  assert.equal(f2.planNotice, null);
});

test('frases/simular: lote dividido no meio (total cresce) → porcentagem geral nunca volta e nunca mostra o total com passo pela frente', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1, 2]); // 3 passos
  const [w] = useWallets(PHRASES[1], 'solflare', [0]);
  world.tokens.set(w, Array.from({ length: 6 }, () => emptyAccount(w))); // 1 lote de 6 contas + o envio da pagadora
  world.splitFail.add(w);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  const planned = S().frases.reduce((k, f) => k + f.plan!.steps.length, 0);
  const n0 = events.length;
  await task('/api/simular');
  assert.equal(S().aborted, null);
  const prog = events.slice(n0).filter((e) => e.type === 'progresso').map((e) => JSON.parse(e.data));
  assert.ok(prog.at(-1).geral.total > planned, 'o lote foi dividido (total cresceu)');
  for (let i = 0; i < prog.length; i++) {
    assert.ok(prog[i].geral.feitos < prog[i].geral.total && prog[i].feitos < prog[i].total, `evento ${i}: passo pela frente, nunca o total`);
    if (i) assert.ok(prog[i].geral.feitos / prog[i].geral.total >= prog[i - 1].geral.feitos / prog[i - 1].geral.total, `evento ${i}: porcentagem não volta`);
  }
});

// ---------- Tarefa 10: pausa por RPC (trocar de RPC ou parar) ----------

const pausaEvents = (from: number) => events.slice(from).filter((e) => e.type === 'pausa').map((e) => JSON.parse(e.data));
const KEY = 'SEGREDO123'; // chave de API na URL do RPC novo: nunca pode sair do servidor
const NEW_URL = `https://novo.exemplo/?api-key=${KEY}`;

test('pausa: créditos esgotados na busca da frase 2 → pausa; trocar RPC continua a mesma frase, e a seed segue na memória até terminar', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]); // a primeira consulta da busca da frase 2 responde "max usage reached"
  const n0 = ends();
  const e0 = events.length;
  assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'devnet', folga: 3 })).status, 202);
  try {
    await until(() => S().pause !== null, 'pausa');
    const [f1, f2] = S().frases;
    assert.equal(S().pause, 'rpc-quota');
    assert.equal(S().busy, 'analise', 'a tarefa continua "em andamento" (parada, não terminada)');
    assert.equal(f1.status, 'pronta');
    assert.equal(f2.status, 'busca');
    const seed2 = f2.seed!;
    assert.ok(seed2 instanceof Buffer && seed2.some((x) => x !== 0), 'a seed da frase pausada continua na memória (a busca vai continuar)');
    await until(() => pausaEvents(e0).length >= 1, 'evento pausa');
    assert.deepEqual(pausaEvents(e0), [{ motivo: 'rpc-quota' }]);
    assert.equal(JSON.parse((await getState()).body).pause, 'rpc-quota');
    const f1scans = f1.scans;

    nextClient = newRpc;
    factoryOpts.length = 0;
    const r = await post('/api/trocar-rpc', { rpc: 'publico' });
    assert.equal(r.status, 200, r.body);
    // RPC público da Solana: 8/s no total E 3,5/s por método (40 por 10 s de cada método é o limite oficial)
    assert.deepEqual(factoryCalls(), [{ url: 'https://api.devnet.solana.com', rps: PUBLIC_RPC_LIMITS.requestsPerSecond, porMetodo: PUBLIC_RPC_LIMITS.defaultMethodLimit }], 'cliente novo com os limites do público');
    assert.equal(S().pause, null);
    assert.match(S().rpcLabel, /^api\.devnet\.solana\.com \(público, mais lento\)$/);
    assert.deepEqual(JSON.parse(r.body).pause, null);
    await until(() => pausaEvents(e0).length >= 2, 'evento de retomada');
    assert.deepEqual(pausaEvents(e0).at(-1), { motivo: null, rpc: S().rpcLabel }, 'evento para a página sair do cartão de pausa');

    await waitTask(n0);
    assert.equal(f2.status, 'pronta', 'a MESMA frase continuou no RPC novo');
    assert.equal(f2.scans.length, 2);
    assert.equal(f2.seed, null);
    assert.ok(seed2.every((x) => x === 0), 'seed zerada só quando a busca terminou');
    assert.ok(f2.signers.has(0) && f2.signers.has(1));
    assert.ok(f1.status === 'pronta' && f1.scans === f1scans, 'a frase 1 não foi refeita');
    assert.ok(world.novoCalls.includes('getSignaturesForAddress'), 'a busca seguiu no RPC novo');
    assert.ok(world.sigCalls.filter((a) => a === b[0]).length >= 2, 'a consulta que falhou foi repetida (não pulada)');
    assert.equal(events.slice(e0).filter((e) => e.type === 'erro').length, 0);
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'análise terminar (limpeza do teste)').catch(() => {});
  }
});

test('pausa: parar na análise zera as seeds pendentes e marca as frases restantes', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  useWallets(PHRASES[2], 'solflare', [0]);
  world.dieOnTokens.add(b[1]); // a rede cai na LEITURA da frase 2 (a leitura engole erro por carteira)
  // a tarefa fica segurada nas outras redes: as seeds têm que estar zeradas ANTES do fim da análise
  let openEvm!: () => void;
  const evmGate = new Promise<void>((r) => (openEvm = r));
  sv.setExternalForTest({ ...baseExternal(), evmScan: async () => { await evmGate; return { holdings: [], usedAccounts: [], errors: [] }; } });
  const n0 = ends();
  const e0 = events.length;
  try {
    assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1]), item(PHRASES[2])], rede: 'devnet', folga: 3 })).status, 202);
    await until(() => S().pause !== null, 'pausa');
    assert.equal(S().pause, 'network-down');
    const [f1, f2, f3] = S().frases;
    assert.equal(f2.status, 'leitura');
    assert.equal(f3.status, 'fila');
    const seed3 = f3.seed!;
    assert.ok(seed3.some((x) => x !== 0));

    const r = await post('/api/parar', {});
    assert.equal(r.status, 200, r.body);
    // já na resposta: a frase da fila está marcada e a seed dela zerada (sem esperar a análise terminar)
    const v = JSON.parse(r.body);
    assert.equal(v.pause, null);
    assert.deepEqual([v.frases[2].status, v.frases[2].error.code], ['erro', 'stopped-by-user']);
    assert.ok(seed3.every((x) => x === 0), 'seed da frase na fila zerada ao parar');
    assert.equal(f3.seed, null);
    assert.equal(f3.signers.size, 0);
    await until(() => pausaEvents(e0).length >= 2, 'evento de parada');
    assert.deepEqual(pausaEvents(e0).at(-1), { motivo: null, parado: true });

    // a frase que estava no ar não fica "pronta pela metade": vira erro, sem chaves nem leituras
    await until(() => f2.status === 'erro', 'frase 2 marcada');
    assert.equal(f2.error?.code, 'stopped-by-user');
    assert.deepEqual([f2.scans, f2.signers.size, f2.seed], [[], 0, null]);
    assert.equal(f1.status, 'pronta', 'a frase pronta fica pronta');
    assert.equal(S().busy, 'analise', 'ainda segurada nas outras redes');

    openEvm();
    await waitTask(n0);
    assert.equal(f1.status, 'pronta');
    assert.equal(f1.scans.length, 1);
    assert.ok(S().frases.every((f) => f.seed === null));
    assert.equal(S().pause, null);
    assert.equal(S().rpc!.stopped(), true);
    assert.equal(events.slice(e0).filter((e) => e.type === 'pronto' || e.type === 'erro').at(-1)?.type, 'pronto');

    // rodada parada: nada mais roda nela (RPC parado), só uma nova análise
    for (const [p, body] of [['/api/plano', null], ['/api/analisar-frase', { n: 2, texto: PHRASES[1], carteira: 'solflare' }], ['/api/parar', {}], ['/api/trocar-rpc', { rpc: 'publico' }]] as const) {
      const x = p === '/api/plano' ? await plano() : await post(p, body);
      assert.equal(x.status, 400, `${p} depois de parar`);
    }
    assert.match(JSON.parse((await plano()).body).erro, /parada/);
    assert.equal(S().frases[1].status, 'erro', 'a recusa não mexe nas frases');
  } finally {
    openEvm();
    sv.setExternalForTest(baseExternal());
    await until(() => S().busy === null, 'análise terminar (limpeza do teste)').catch(() => {});
  }
});

test("pausa: na execução, passo com assinatura que o RPC novo não acha fica 'desconhecido' e nada é montado de novo", async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1, 2]);
  world.lamports.set(a[0], 60_000_000); // pagadora (último passo); os passos são N=1, N=2, N=0
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  // prazo curto para o passo sem confirmação (em produção, 180 s); espera real entre as conferências
  sv.setExternalForTest({ ...baseExternal(), execSleep: () => new Promise<void>((r) => setTimeout(r, 20)), confirmTimeoutMs: 4_000 });
  const e0 = events.length;
  try {
    await analyse([item(PHRASES[0]), item(PHRASES[1])]);
    assert.equal((await plano()).status, 200);
    await task('/api/simular');
    assert.equal(S().aborted, null);
    world.dieAfterSend.add(a[1]); // o 1º passo é enviado; a rede cai antes de confirmar
    const n0 = ends();
    assert.equal((await post('/api/executar', { confirmacao: typedCode() })).status, 202);
    await until(() => S().pause !== null, 'pausa na execução');
    assert.equal(S().pause, 'network-down');
    assert.equal(S().busy, 'execucao');
    assert.equal(S().execResults.length, 0, 'o passo no ar ainda não tem resultado');
    const [lost] = [...world.lostSigs];
    assert.ok(lost);

    nextClient = newRpc;
    factoryOpts.length = 0;
    const r = await post('/api/trocar-rpc', { rpc: NEW_URL });
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(factoryCalls(), [{ url: NEW_URL, rps: RUN_COSTS.rpsCustom, porMetodo: undefined }], 'cliente novo com o limite do RPC próprio (sem limite por método: o Helius só limita gPA e envio)');
    assert.equal(S().rpcLabel, 'novo.exemplo', 'só o host, nunca a chave');
    assert.equal(S().pause, null);

    await waitTask(n0);
    const ex = S().execResults;
    const stuck = ex.find((x) => x.step.wallet === a[1])!;
    assert.equal(stuck.status, 'desconhecido');
    assert.equal(stuck.signature, lost, 'o passo guarda a assinatura que já tinha sido enviada');
    assert.equal(stuck.error?.code, 'send-unknown');
    assert.ok(world.novoCalls.includes('getSignatureStatuses'), 'a assinatura foi conferida no RPC novo');
    const rest = ex.filter((x) => x !== stuck);
    assert.ok(rest.length >= 3 && rest.every((x) => x.status === 'enviado'), 'os passos seguintes e a frase 2 seguem no RPC novo');
    assert.ok(rest.some((x) => x.frase === 2 && b.includes(x.step.wallet)));
    assert.equal(S().aborted, null);
    assert.equal(S().executed, true);
    // nada montado de novo: o passo da N=1 tem UMA assinatura (reenviar a mesma pode; outra, nunca)
    const sigs = new Set(world.sent.filter((s) => s.from.includes(a[1])).map((s) => s.signature));
    assert.deepEqual([...sigs], [lost]);
    // a chave da URL não sai em resposta, evento nem relatório
    const everything = bodies.join('\n') + events.slice(e0).map((e) => e.data).join('\n') + fs.readFileSync(S().reportFile!, 'utf8');
    assert.ok(!everything.includes(KEY), 'a chave do RPC nunca sai do servidor');
    assert.ok(!everything.includes('novo.exemplo/'), 'nem a URL');
  } finally {
    sv.setExternalForTest(baseExternal());
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'execução terminar (limpeza do teste)').catch(() => {});
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('pausa: parar na execução grava relatório parcial', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1, 2]);
  world.lamports.set(a[0], 60_000_000); // pagadora (último passo); passos N=1, N=2, N=0
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  assert.equal(S().aborted, null);
  world.dieAfterSend.add(a[2]); // 2º passo enviado, sem confirmação: pausa; o 1º (N=1) já foi confirmado
  world.simKeys.length = 0;
  const n0 = ends();
  const e0 = events.length;
  try {
    assert.equal((await post('/api/executar', { confirmacao: typedCode() })).status, 202);
    await until(() => S().pause !== null, 'pausa na execução');
    const ex = S().execResults;
    assert.equal(ex.length, 1);
    assert.deepEqual([ex[0].step.wallet, ex[0].status], [a[1], 'enviado']);
    const sentBefore = world.sent.length;

    const r = await post('/api/parar', {});
    assert.equal(r.status, 200, r.body);
    assert.equal(S().pause, null);
    await waitTask(n0);
    assert.equal(S().aborted, 'parado pelo usuário');
    assert.equal(S().abortedError?.code, 'stopped-by-user');
    assert.equal(S().abortedFrase, 1);
    assert.equal(S().executed, true, 'uma execução por rodada, mesmo parada');
    assert.equal(S().execResults, ex, 'os resultados já recebidos ficam');
    // o passo que estava no ar já tinha sido enviado: entra como 'desconhecido' com a assinatura (Ruling 15); nada além dele
    assert.equal(ex.length, 2, 'o passo no ar entra no relatório; nada além dele');
    const [lost] = [...world.lostSigs];
    assert.deepEqual([ex[1].step.wallet, ex[1].status, ex[1].signature, ex[1].error?.code], [a[2], 'desconhecido', lost, 'send-unknown']);
    assert.match(ex[1].detail ?? '', /não reenvio/);
    assert.equal(world.sent.length, sentBefore, 'nenhum envio depois de parar');
    assert.ok(world.sent.every((s) => !s.from.includes(a[0]) && !s.from.includes(b[0])), 'pagadora e frase 2 nunca enviadas');
    assert.ok(!world.simKeys.some((keys) => keys.some((k) => b.includes(k))), 'frase 2 nunca simulada');
    await until(() => pausaEvents(e0).length >= 2, 'eventos de pausa e parada');
    assert.deepEqual(pausaEvents(e0), [{ motivo: 'network-down' }, { motivo: null, parado: true }]);
    const st = JSON.parse((await getState()).body);
    assert.equal(typeof st.reportFile, 'string');
    const rep = JSON.parse(fs.readFileSync(path.join(ROOT, st.reportFile), 'utf8'));
    assert.equal(rep.aborted, 'parado pelo usuário');
    assert.deepEqual(rep.frases.map((x: { n: number }) => x.n), [1, 2]);
    assert.equal(rep.frases[0].results.length, 2);
    assert.deepEqual([rep.frases[0].results[1].status, rep.frases[0].results[1].signature], ['desconhecido', lost], 'a transação enviada está no relatório');
    assert.deepEqual(rep.frases[1].results, []);
    for (const [p, body] of [['/api/plano', null], ['/api/simular', {}], ['/api/executar', { confirmacao: typedCode() }]] as const) {
      const x = p === '/api/plano' ? await plano() : await post(p, body);
      assert.equal(x.status, 400, `${p} depois de parar a execução`);
    }
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'execução terminar (limpeza do teste)').catch(() => {});
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('pausa: canShutdown verdadeiro quando pausado', async () => {
  assert.equal(sv.canShutdown('execucao', false), false);
  assert.equal(sv.canShutdown('execucao', true), true, 'pausado: nada está no ar, pode fechar');
  assert.equal(sv.canShutdown(null, false), true);
  const closed = { everConnected: true, connected: 0, idleMs: sv.IDLE_GRACE_MS, busy: 'execucao' };
  assert.equal(sv.shouldCloseIdle({ ...closed, paused: false }), false);
  assert.equal(sv.shouldCloseIdle({ ...closed, paused: true }), true);

  // encerrar durante a pausa na execução: chaves apagadas, RPC parado, relatório parcial, app fecha
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.lamports.set(a[0], 60_000_000);
  await analyse([item(PHRASES[0])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  world.dieAfterSend.add(a[1]);
  const n0 = ends();
  const exit = process.exit;
  let exited = 0;
  process.exit = (() => void exited++) as never;
  try {
    assert.equal((await post('/api/executar', { confirmacao: typedCode() })).status, 202);
    await until(() => S().pause !== null, 'pausa na execução');
    const old = S();
    const signers = old.frases[0].signers;
    assert.ok(signers.size > 0);
    const r = await post('/api/encerrar', {});
    assert.equal(r.status, 200, r.body);
    assert.equal(signers.size, 0, 'chaves apagadas');
    assert.equal(old.rpc!.stopped(), true);
    assert.notEqual(S(), old, 'sessão nova');
    await until(() => ends() > n0, 'a execução largada terminar');
    assert.equal(old.executed, true);
    assert.equal(old.aborted, 'parado pelo usuário');
    assert.ok(old.reportFile, 'relatório parcial gravado na sessão antiga');
    assert.equal(S().reportFile, null, 'a sessão nova não herda nada');
    assert.equal(S().busy, null);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(exited, 1);
    fs.rmSync(old.reportFile!, { force: true });
  } finally {
    process.exit = exit;
  }
});

test('pausa: trocar RPC com https inválido ou fora de pausa → 400', async () => {
  await reset();
  assert.equal((await post('/api/trocar-rpc', { rpc: 'publico' })).status, 400, 'fora de pausa');
  assert.equal((await post('/api/parar', {})).status, 400, 'parar fora de pausa');
  useWallets(PHRASES[0], 'solflare', [0]);
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  world.dieOnSig.add(b[0]);
  const n0 = ends();
  assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'devnet', folga: 3 })).status, 202);
  try {
    await until(() => S().pause !== null, 'pausa');
    const label = S().rpcLabel;
    for (const bad of ['http://x.exemplo', 'ftp://x', '', 42, null, 'novo.exemplo']) {
      const r = await post('/api/trocar-rpc', { rpc: bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
      assert.match(JSON.parse(r.body).erro, /https/);
      assert.equal(S().pause, 'rpc-quota', 'continua pausado');
    }
    // RPC novo que não serve para o app (checkRpc recusa): 400, continua pausado, a chave não sai
    world.failMethods.add('getProgramAccounts');
    nextClient = newRpc;
    const refused = await post('/api/trocar-rpc', { rpc: NEW_URL });
    assert.equal(refused.status, 400, refused.body);
    assert.equal(JSON.parse(refused.body).codigo, 'rpc-blocked');
    assert.ok(!refused.body.includes(KEY) && !refused.body.includes('novo.exemplo'));
    assert.equal(S().pause, 'rpc-quota');
    assert.equal(S().rpcLabel, label, 'o RPC da rodada não mudou');
    assert.equal(S().busy, 'analise');
    world.failMethods.clear();
    // agora serve
    const ok = await post('/api/trocar-rpc', { rpc: NEW_URL });
    assert.equal(ok.status, 200, ok.body);
    assert.equal(S().rpcLabel, 'novo.exemplo');
    assert.ok(!ok.body.includes(KEY));
    await waitTask(n0);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
    assert.ok(!bodies.join('\n').includes(KEY) && !events.map((e) => e.data).join('\n').includes(KEY));
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'análise terminar (limpeza do teste)').catch(() => {});
  }
});

// ---------- Tarefa 10, rodada de correções 1 ----------

const avisos = (from: number) => events.slice(from).filter((e) => e.type === 'aviso').length;
const pauseAnalysisOn = async (frases: Array<{ texto: string; carteira: WalletApp }>) => {
  assert.equal((await post('/api/analisar', { frases, rede: 'devnet', folga: 3 })).status, 202);
  await until(() => S().pause !== null, 'pausa');
};

test('pausa: analisar-frase: parar na leitura da frase refeita marca erro e apaga as chaves de todas', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  for (const a of addressesOf(PHRASES[1], 'solflare')) world.failSigs.add(a);
  await analyse([item(PHRASES[0]), item(PHRASES[1])]);
  const [f1] = S().frases;
  assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'erro']);
  assert.ok(f1.signers.size === 2);
  world.failSigs.clear();
  world.dieOnTokens.add(b[1]); // a rede cai na LEITURA da frase refeita
  const n0 = ends();
  try {
    assert.equal((await post('/api/analisar-frase', { n: 2, texto: PHRASES[1], carteira: 'solflare' })).status, 202);
    await until(() => S().pause !== null, 'pausa');
    const f2 = S().frases[1];
    assert.equal(f2.status, 'leitura');
    assert.ok(f2.signers.size > 0, 'chaves já derivadas (a busca terminou)');
    assert.equal((await post('/api/parar', {})).status, 200);
    await waitTask(n0);
    assert.equal(f2.status, 'erro', 'não fica "pronta pela metade"');
    assert.equal(f2.error?.code, 'stopped-by-user');
    assert.deepEqual([f2.scans, f2.signers.size, f2.seed], [[], 0, null]);
    assert.equal(f1.status, 'pronta');
    assert.equal(f1.signers.size, 0, 'rodada parada: as chaves de TODAS as frases somem (nunca mais executa)');
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'tarefa terminar (limpeza do teste)').catch(() => {});
  }
});

test('pausa: parar não arma espera de depósito no RPC morto nem deixa chaves; conferir-saldo recusado', async () => {
  await reset();
  noSol(PHRASES[0]); // frase 1 sem SOL para a taxa: a análise armaria a espera do depósito
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnTokens.add(b[1]);
  const n0 = ends();
  try {
    await pauseAnalysisOn([item(PHRASES[0]), item(PHRASES[1])]);
    const [f1, f2] = S().frases;
    assert.equal(f1.status, 'pronta');
    assert.equal((await post('/api/parar', {})).status, 200);
    assert.equal(f1.signers.size, 0, 'chaves da frase pronta apagadas já ao parar');
    await waitTask(n0);
    assert.ok(f1.feeWarning, 'o aviso de falta de SOL fica');
    assert.equal(f1.feeWait, null, 'nenhuma espera armada no RPC parado');
    assert.equal(f1.fundingAbort, null);
    assert.equal(sv.fundingWaitActive(f1), false);
    assert.equal(f2.status, 'erro');
    assert.ok(S().frases.every((f) => f.signers.size === 0 && f.seed === null));
    const r = await post('/api/conferir-saldo', { n: 1 });
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).erro, /parada/);
    assert.equal(f1.fundingAbort, null, 'a recusa não arma nada');
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'tarefa terminar (limpeza do teste)').catch(() => {});
  }
});

test('pausa: fechar a janela pausado espera a execução gravar o relatório parcial antes de sair', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1, 2]);
  world.lamports.set(a[0], 60_000_000);
  await analyse([item(PHRASES[0])]);
  assert.equal((await plano()).status, 200);
  await task('/api/simular');
  world.dieAfterSend.add(a[2]); // 2º passo no ar quando a rede cai
  const n0 = ends();
  assert.equal((await post('/api/executar', { confirmacao: typedCode() })).status, 202);
  await until(() => S().pause !== null, 'pausa na execução');
  const old = S();
  const signers = old.frases[0].signers;
  let exited = 0;
  let reportAtExit: string | null = null;
  let busyAtExit: string | null = 'x';
  await sv.closeIdle(() => {
    exited++;
    reportAtExit = old.reportFile;
    busyAtExit = old.busy;
  });
  try {
    assert.equal(exited, 1);
    assert.ok(reportAtExit, 'o relatório parcial já estava gravado quando o app saiu');
    assert.equal(busyAtExit, null, 'a execução tinha terminado');
    assert.equal(signers.size, 0);
    assert.equal(old.aborted, 'parado pelo usuário');
    assert.equal(old.executed, true);
    const ex = old.execResults;
    assert.deepEqual(ex.map((x) => x.status), ['enviado', 'desconhecido'], 'o passo no ar entrou no relatório');
    assert.notEqual(S(), old, 'sessão zerada');
    assert.deepEqual(S().frases, []);
    await until(() => ends() > n0, 'a execução largada terminar');
    const rep = JSON.parse(fs.readFileSync(old.reportFile!, 'utf8'));
    assert.equal(rep.frases[0].results.length, 2);
  } finally {
    if (old.reportFile) fs.rmSync(old.reportFile, { force: true });
  }
});

test('pausa: parar enquanto o RPC novo é conferido → troca recusada; dois pedidos ao mesmo tempo → um 400', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  world.dieOnSig.add(b[0]);
  const n0 = ends();
  let openGate!: () => void;
  world.novoGate = new Promise<void>((r) => (openGate = r)); // o checkRpc do candidato fica preso
  try {
    await pauseAnalysisOn([item(PHRASES[0]), item(PHRASES[1])]);
    const label = S().rpcLabel;
    // o 2º pedido ('publico') cai no RPC antigo, morto: sem a trava ele seria conferido e recusado como rpc-blocked
    nextClient = (url) => (url === NEW_URL ? newRpc : fakeRpc);
    const first = post('/api/trocar-rpc', { rpc: NEW_URL });
    await until(() => world.novoCalls.length >= 1, 'checkRpc do candidato começou');
    const second = await post('/api/trocar-rpc', { rpc: 'publico' });
    assert.equal(second.status, 400);
    assert.match(JSON.parse(second.body).erro, /conferindo/);
    assert.equal(S().pause, 'rpc-quota', 'continua pausado');
    assert.equal((await post('/api/parar', {})).status, 200, 'parar vale mesmo com a conferência no ar');
    openGate();
    const r = await first;
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).erro, /não está pausado/);
    assert.equal(S().rpcLabel, label, 'nada trocado');
    assert.equal(S().rpc!.stopped(), true);
    await waitTask(n0);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'erro']);
    const calls = world.novoCalls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(world.novoCalls.length, calls, 'a rodada não continuou no candidato');
  } finally {
    openGate();
    world.novoGate = null;
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'tarefa terminar (limpeza do teste)').catch(() => {});
  }
});

test("pausa: na simulação, parar → simular e executar recusados com 'rodada parada'", async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.lamports.set(a[0], 60_000_000);
  await analyse([item(PHRASES[0])]);
  assert.equal((await plano()).status, 200);
  world.dieOnSim.add(a[1]); // a rede cai na simulação do 1º passo
  const n0 = ends();
  try {
    assert.equal((await post('/api/simular', {})).status, 202);
    await until(() => S().pause !== null, 'pausa na simulação');
    assert.equal(S().busy, 'simulacao');
    assert.equal((await post('/api/parar', {})).status, 200);
    await waitTask(n0);
    assert.equal(S().aborted, 'parado pelo usuário');
    assert.equal(S().executed, false, 'simulação parada não conta como execução');
    assert.equal(world.sent.length, 0);
    for (const [p, body] of [['/api/simular', {}], ['/api/executar', { confirmacao: typedCode() }]] as const) {
      const r = await post(p, body);
      assert.equal(r.status, 400, p);
      assert.match(JSON.parse(r.body).erro, /parada/, `${p}: recusa pela rodada parada, antes de qualquer outra trava`);
    }
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'tarefa terminar (limpeza do teste)').catch(() => {});
  }
});

test('pausa: espera de depósito com o RPC morto pausa (sem tarefa); parar cancela a espera', async () => {
  await reset();
  noSol(PHRASES[0]);
  const sleeps: Array<() => void> = [];
  sv.setExternalForTest({ ...baseExternal(), fundingSleep: () => new Promise<void>((r) => sleeps.push(r)) });
  try {
    await analyse([item(PHRASES[0])]);
    const f1 = S().frases[0];
    assert.ok(f1.feeWarning && f1.fundingAbort, 'espera da análise armada');
    await until(() => sleeps.length > 0, 'primeira leitura da espera');
    world.deadKind = 'down'; // o RPC morre entre uma leitura e outra
    for (const wake of sleeps.splice(0)) wake();
    await until(() => S().pause !== null, 'pausa pela espera');
    assert.equal(S().pause, 'network-down');
    assert.equal(S().busy, null, 'pausa sem tarefa em andamento');
    const ctl = f1.fundingAbort!;
    assert.equal((await post('/api/parar', {})).status, 200);
    assert.equal(ctl.signal.aborted, true, 'a espera foi cancelada');
    assert.equal(f1.fundingAbort, null);
    assert.equal(f1.feeWait, null);
    assert.equal(sv.fundingWaitActive(f1), false);
    assert.equal(S().pause, null);
  } finally {
    for (const wake of sleeps.splice(0)) wake();
    sv.setExternalForTest(baseExternal());
  }
});

test("pausa: provedor que ecoa a URL na recusa → mensagem sem a URL; candidato não avisa 'rede lenta' até entrar em uso", async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  world.dieOnSig.add(b[0]);
  const n0 = ends();
  const e0 = events.length;
  try {
    await pauseAnalysisOn([item(PHRASES[0]), item(PHRASES[1])]);
    // candidato cujo erro ecoa a URL inteira (há provedores que fazem isso)
    nextClient = (url) => ({
      call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'getProgramAccounts') return Promise.reject(new RpcError(`${method}: ${url} recusou (${new URL(url).host}${new URL(url).search})`, -32601));
        return newRpc.call<T>(method, params);
      },
    });
    const refused = await post('/api/trocar-rpc', { rpc: NEW_URL });
    assert.equal(refused.status, 400, refused.body);
    assert.equal(JSON.parse(refused.body).codigo, 'rpc-blocked');
    assert.ok(!refused.body.includes(KEY) && !refused.body.includes('novo.exemplo'), 'nem chave nem host na recusa');
    assert.ok(refused.body.includes('[rpc]'), 'a URL ecoada virou [rpc]');
    assert.equal(S().pause, 'rpc-quota');
    // o candidato recusado tentando de novo não vira aviso "rede lenta" na página
    const candidate = factoryOpts.at(-1)!;
    assert.equal(candidate.url, NEW_URL);
    candidate.onRetry?.({ attempt: 0, waitMs: 1000, code: 429 });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(avisos(e0), 0, 'candidato não avisa');
    // aceito e em uso: o aviso passa a valer
    nextClient = newRpc;
    assert.equal((await post('/api/trocar-rpc', { rpc: NEW_URL })).status, 200);
    const live = factoryOpts.at(-1)!;
    live.onRetry?.({ attempt: 0, waitMs: 1000, code: 429 });
    await until(() => avisos(e0) === 1, 'aviso do RPC em uso');
    await waitTask(n0);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
    assert.ok(!bodies.join('\n').includes(KEY) && !events.map((e) => e.data).join('\n').includes(KEY));
  } finally {
    if (S().pause) await post('/api/parar', {});
    await until(() => S().busy === null, 'tarefa terminar (limpeza do teste)').catch(() => {});
  }
});

// achado da revisão de 30/10 (autoclarn-34): a página não pede a contagem da Phantom de uma frase sem nada a limpar
test('frases/plano: frase Phantom sem nada a limpar fica fora e não trava o plano das outras', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  useWallets(PHRASES[1], 'phantom', [1], 0); // Conta 2 usada e vazia: nada a limpar
  await analyse([item(PHRASES[0]), item(PHRASES[1], 'phantom')]);
  const [f1, f2] = S().frases;
  assert.equal(f1!.nothingToClean, false);
  assert.equal(f2!.nothingToClean, true);
  const r = await plano(); // sem porFrase[2], como a página manda
  assert.equal(r.status, 200, r.body);
  assert.ok(f1!.plan, 'a frase 1 tem plano');
  assert.equal(f2!.plan, null, 'a frase vazia fica fora');
});

test('frases/analisar: RPC recusado na conferência inicial → mensagem sem a URL (pode levar a chave)', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  nextClient = (url) => ({
    call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getProgramAccounts') return Promise.reject(new RpcError(`${method}: ${url} recusou (${new URL(url).host}${new URL(url).search})`, -32601));
      return fakeRpc.call<T>(method, params);
    },
  });
  const e0 = events.length;
  const n0 = ends();
  const r = await post('/api/analisar', { frases: [item(PHRASES[0])], rede: 'mainnet', rpc: NEW_URL });
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
  const erro = events.slice(e0).find((e) => e.type === 'erro');
  assert.ok(erro, 'a análise parou com erro');
  assert.equal(JSON.parse(erro!.data).codigo, 'rpc-blocked');
  assert.ok(!erro!.data.includes(KEY) && !erro!.data.includes('novo.exemplo'), `nem chave nem host no erro: ${erro!.data}`);
});

// ---------- RPC embutido (Helius no .exe) e trava de rede ----------

const EMBEDDED = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PUBLIC_MAINNET = 'https://api.mainnet-beta.solana.com';
const PUBLIC_DEVNET = 'https://api.devnet.solana.com';

// roda `fn` com o RPC embutido falso e sem a variável SOLANA_RPC_URL (que mudaria a ordem dos RPCs)
async function withEmbedded(url: Parameters<typeof sv.setEmbeddedRpcForTest>[0], fn: () => Promise<void>) {
  const env = process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  sv.setEmbeddedRpcForTest(url);
  try {
    await fn();
  } finally {
    sv.setEmbeddedRpcForTest(null);
    if (env !== undefined) process.env.SOLANA_RPC_URL = env;
  }
}
async function analyseAndWait(body: Record<string, unknown>) {
  const e0 = events.length;
  const n0 = ends();
  const r = await post('/api/analisar', body);
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
  return events.slice(e0).find((e) => e.type === 'erro') ?? null;
}

test('rpc embutido: a mainnet usa o Helius embutido quando ele passa na conferência', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(factoryCalls().map((c) => c.url), [EMBEDDED], 'só o embutido, sem tentar o público');
    assert.equal(factoryCalls()[0]!.rps, RUN_COSTS.rpsCustom, 'limites de RPC próprio, não os do público');
    assert.equal(S().rpcLabel, 'mainnet.helius-rpc.com', 'a página vê só o host, nunca a chave');
    assert.equal(S().frases[0]!.status, 'pronta');
  });
});

test('rpc embutido: créditos esgotados na conferência → cai para o público e a análise segue', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? { call: () => Promise.reject(new RpcError('getGenesisHash: créditos do RPC esgotados', 429, undefined, 'quota')) } : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(factoryCalls().map((c) => c.url), [EMBEDDED, PUBLIC_MAINNET]);
    assert.equal(S().rpcLabel, 'api.mainnet-beta.solana.com (público, mais lento)');
    assert.equal(S().frases[0]!.status, 'pronta');
  });
});

test('rpc embutido: chave de outra rede (hash de gênese da devnet) → cai para o público da mainnet', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? { call: <T>(m: string, p: unknown[]) => (m === 'getGenesisHash' ? Promise.resolve(GENESIS_HASH.devnet as T) : fakeRpc.call<T>(m, p)) } : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(factoryCalls().map((c) => c.url), [EMBEDDED, PUBLIC_MAINNET]);
    assert.match(S().rpcLabel, /público/);
  });
});

test('rpc embutido: na devnet o embutido (da mainnet) nem é tentado', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'devnet', folga: 3 }), null);
    assert.deepEqual(factoryCalls().map((c) => c.url), [PUBLIC_DEVNET]);
  });
});

test('trava de rede: RPC da mainnet com "Devnet (teste)" marcado → recusado antes de qualquer outra consulta', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  world.genesis = GENESIS_HASH.mainnet;
  const seen: string[] = [];
  nextClient = { call: <T>(m: string, p: unknown[]) => (seen.push(m), fakeRpc.call<T>(m, p)) };
  await withEmbedded(null, async () => {
    const erro = await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'devnet', folga: 3 });
    assert.ok(erro, 'a análise parou');
    assert.equal(JSON.parse(erro!.data).codigo, 'rpc-blocked');
    assert.match(erro!.data, /precisa ser devnet\)?: este RPC é da mainnet/);
    assert.deepEqual(seen, ['getGenesisHash'], 'nada além da trava foi consultado');
    assert.equal(S().frases[0]!.status, 'erro');
  });
});

test('trava de rede: trocar para um RPC de outra rede durante a pausa é recusado e a pausa continua', async () => {
  await reset();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1]);
  world.dieOnSig.add(a[0]); // a primeira consulta da busca responde "max usage reached": pausa
  await withEmbedded(null, async () => {
    assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0])], rede: 'devnet', folga: 3 })).status, 202);
    await until(() => S().pause !== null, 'pausa');
    nextClient = { call: <T>(m: string, p: unknown[]) => (m === 'getGenesisHash' ? Promise.resolve(GENESIS_HASH.mainnet as T) : fakeRpc.call<T>(m, p)) };
    const r = await post('/api/trocar-rpc', { rpc: NEW_URL });
    assert.equal(r.status, 400);
    assert.match(r.body, /este RPC é da mainnet/);
    assert.ok(!r.body.includes(KEY));
    assert.equal(S().pause, 'rpc-quota', 'continua pausado');
    const n0 = ends();
    await post('/api/parar', {});
    await waitTask(n0);
  });
});

test('rpc embutido: nenhum RPC serve → recusa com o motivo de cada um, sem a chave', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => ({ call: () => Promise.reject(new RpcError(`getGenesisHash: ${url} recusou`, -32601)) });
    const erro = await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' });
    assert.ok(erro);
    assert.equal(JSON.parse(erro!.data).codigo, 'rpc-blocked');
    assert.ok(!erro!.data.includes(KEY), `sem a chave: ${erro!.data}`);
    assert.match(erro!.data, /mainnet\.helius-rpc\.com: /);
    assert.match(erro!.data, /api\.mainnet-beta\.solana\.com \(público, mais lento\): /);
  });
});

test('estimativa: com o Helius embutido, a página (sem campo de RPC) recebe o tempo de RPC próprio', async () => {
  await reset();
  await withEmbedded(EMBEDDED, async () => {
    const r = await post('/api/estimativa', { frases: 2, etapa: 'analise' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), JSON.parse(JSON.stringify(estimateRun({ frases: 2, customRpc: true, stage: 'analysis' }))));
  });
  await withEmbedded(null, async () => {
    const r = await post('/api/estimativa', { frases: 2, etapa: 'analise' });
    assert.deepEqual(JSON.parse(r.body), JSON.parse(JSON.stringify(estimateRun({ frases: 2, customRpc: false, stage: 'analysis' }))));
  });
});

// ---------- painel de créditos do Helius ----------

const PROJECT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const readHist = () => (fs.existsSync(HISTORY_FILE) ? (JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) as Array<{ etapa: string; creditos: number; consultas: number; rpc: string }>) : []);
function withBalance(fetchImpl: typeof fetch) {
  sv.setCreditsForTest({ historyFile: HISTORY_FILE, heliusFetch: fetchImpl });
}
const noNet = (async () => { throw new Error('sem rede nos testes'); }) as typeof fetch;

test('créditos: rodada com RPC próprio grava no histórico deste computador o gasto da análise, sem chave nem endereço', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  withBalance(noNet);
  const used = useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    const round = (JSON.parse((await getState()).body) as { credits: { own: boolean; round: { credits: number; requests: number; byStage: Record<string, number> } } }).credits;
    assert.equal(round.own, true);
    assert.ok(round.round.credits > 0, 'o medidor contou as consultas');
    assert.deepEqual(Object.keys(round.round.byStage), ['analise'], 'tudo na etapa da análise');
    const hist = readHist();
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.etapa, 'analise');
    assert.equal(hist[0]!.creditos, round.round.credits, 'o histórico grava o mesmo número que a página mostra');
    assert.equal(hist[0]!.rpc, 'mainnet.helius-rpc.com');
    const text = fs.readFileSync(HISTORY_FILE, 'utf8');
    assert.ok(!text.includes(KEY), 'sem a chave');
    for (const a of used) assert.ok(!text.includes(a), 'sem endereço');
    assert.ok(!text.includes(PHRASES[0].split(' ')[0] + ' '), 'sem frase');
  });
});

test('créditos: rodada no RPC público não grava nada (não gasta crédito)', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(null, async () => {
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(readHist(), []);
    const st = JSON.parse((await getState()).body) as { credits: { own: boolean; round: { credits: number } } };
    assert.deepEqual([st.credits.own, st.credits.round.credits], [false, 0]);
  });
});

test('créditos: chave esgotada que caiu para o público ainda conta as consultas da conferência', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? { call: () => Promise.reject(new RpcError('getGenesisHash: créditos do RPC esgotados', 429, undefined, 'quota')) } : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(readHist().map((e) => [e.etapa, e.creditos, e.rpc]), [['analise', 1, 'mainnet.helius-rpc.com']], 'só a 1ª consulta da trava, recusada, no host da chave (não no do público)');
  });
});

test('/api/creditos: saldo da chave pelo Helius (com cache de 1 minuto e "atualizar"), mês deste computador e a rodada; nunca a chave', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify([{ quando: new Date().toISOString(), etapa: 'execucao', creditos: 120, consultas: 110, rpc: 'mainnet.helius-rpc.com' }]));
  const asked: string[] = [];
  withBalance((async (url: string, init: RequestInit) => {
    asked.push(`${url}|${JSON.stringify(init.headers)}`);
    return new Response(JSON.stringify({ creditsRemaining: 912345, creditsUsed: 87655, creditCycle: { end: '2026-11-01' }, subscriptionDetails: { creditsLimit: 1000000, plan: 'free' } }), { status: 200 });
  }) as unknown as typeof fetch);
  await withEmbedded(EMBEDDED, async () => {
    sv.setEmbeddedRpcForTest(EMBEDDED, PROJECT);
    const r = await post('/api/creditos', {});
    assert.equal(r.status, 200, r.body);
    const b = JSON.parse(r.body);
    assert.equal(b.own, true);
    assert.deepEqual(b.helius, { status: 'ok', restantes: 912345, limite: 1000000, usados: 87655, renovaEm: '2026-11-01', plano: 'free' });
    assert.equal(b.history.creditosMes, 120);
    assert.equal(b.round.credits, 0);
    assert.ok(!r.body.includes(KEY), 'a chave não vai para a página');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, new RegExp(`/projects/${PROJECT}/usage\|`));
    await post('/api/creditos', {});
    assert.equal(asked.length, 1, 'dentro de 1 minuto usa o guardado');
    await post('/api/creditos', { atualizar: true });
    assert.equal(asked.length, 2, '"atualizar" consulta de novo');
  });
});

test('/api/creditos: sem RPC próprio não consulta o Helius; sem id de projeto diz "sem-projeto"; recusa vira motivo', async () => {
  await reset();
  let asked = 0;
  withBalance((async () => { asked++; return new Response('{}', { status: 403 }); }) as typeof fetch);
  await withEmbedded(null, async () => {
    const b = JSON.parse((await post('/api/creditos', {})).body);
    assert.deepEqual([b.own, b.helius, asked], [false, { status: 'sem-projeto' }, 0]);
  });
  await withEmbedded(EMBEDDED, async () => {
    const b = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.deepEqual([b.own, b.helius, asked], [true, { status: 'sem-projeto' }, 0], 'sem projeto: nem tenta');
    sv.setEmbeddedRpcForTest(EMBEDDED, PROJECT);
    withBalance((async () => { asked++; return new Response('{}', { status: 403 }); }) as typeof fetch);
    const c = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.deepEqual([c.helius, asked], [{ status: 'erro', motivo: 'admin-desligada' }, 1]);
  });
  withBalance(noNet);
});

test('rpc embutido: chave recusada pelo provedor (401/403) → cai para o público, a análise segue e o servidor continua de pé', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(EMBEDDED, async () => {
    for (const code of [401, 403, -32601]) {
      factoryOpts.length = 0;
      nextClient = (url) => (url === EMBEDDED ? { call: () => Promise.reject(new RpcError(`getGenesisHash: recusado (${code})`, code)) } : fakeRpc);
      assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null, `código ${code}`);
      assert.deepEqual(factoryCalls().map((c) => c.url), [EMBEDDED, PUBLIC_MAINNET]);
      assert.equal(S().rpcLabel, 'api.mainnet-beta.solana.com (público, mais lento)');
      assert.equal(S().frases[0]!.status, 'pronta');
    }
    assert.equal((await getState()).status, 200, 'o servidor responde depois das três rodadas');
  });
});

// ---------- RPC próprio que morre no meio da rodada: troca sozinho para o público (31/10/2026) ----------

const autoEvents = (from: number) => pausaEvents(from).filter((p) => p.auto);
const startedPauses = (from: number) => pausaEvents(from).filter((p) => p.motivo);

test('troca automática: o Helius embutido esgota no meio da análise → segue no público do mesmo ponto, sem pausa', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]); // a 1ª consulta da busca da frase 2 responde "max usage reached"
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? fakeRpc : newRpc);
    const e0 = events.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' }), null);
    assert.deepEqual(startedPauses(e0), [], 'nenhuma pausa: o usuário não precisou clicar em nada');
    assert.deepEqual(autoEvents(e0), [{ motivo: null, rpc: 'api.mainnet-beta.solana.com (público, mais lento)', auto: 'troca', helius: true }]);
    assert.equal(S().rpcLabel, 'api.mainnet-beta.solana.com (público, mais lento)');
    assert.equal(S().pause, null);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta'], 'a frase 2 continuou do mesmo ponto no público');
    assert.ok(world.novoCalls.includes('getSignaturesForAddress'), 'a busca da frase 2 foi refeita no público');
    assert.ok(!bodies.join('\n').includes(KEY) && !events.slice(e0).map((e) => e.data).join('\n').includes(KEY), 'a chave não sai do servidor');
  });
});

// ---------- duas chaves do Helius embutidas (03/11/2026): acabou a 1ª, segue na 2ª; só depois o público ----------

const EMBEDDED2 = `https://mainnet.helius-rpc.com/?api-key=${KEY}-DOIS`;
const PROJECT2 = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const TWO_KEYS = [{ url: EMBEDDED, heliusProject: '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b' }, { url: EMBEDDED2, heliusProject: PROJECT2 }];
const quotaClient: RpcClient = { call: (m) => Promise.reject(new RpcError(`${m}: créditos do RPC esgotados`, 429, undefined, 'quota')) };

test('duas chaves: a 1ª já esgotada na conferência → a rodada começa na 2ª, não no público', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(TWO_KEYS, async () => {
    nextClient = (url) => (url === EMBEDDED ? quotaClient : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(factoryCalls().map((c) => c.url), [EMBEDDED, EMBEDDED2]);
    assert.equal(S().rpcLabel, 'mainnet.helius-rpc.com');
    assert.equal(S().rpcUrl, EMBEDDED2);
    assert.equal(S().frases[0]!.status, 'pronta');
  });
});

test('duas chaves: a 1ª esgota no meio da análise → segue na 2ª do mesmo ponto, sem pausa e sem passar pelo público', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]); // a 1ª consulta da busca da frase 2 responde "max usage reached"
  await withEmbedded(TWO_KEYS, async () => {
    nextClient = (url) => (url === EMBEDDED ? fakeRpc : url === EMBEDDED2 ? newRpc : quotaClient);
    const e0 = events.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' }), null);
    assert.deepEqual(startedPauses(e0), [], 'nenhuma pausa');
    assert.deepEqual(autoEvents(e0), [{ motivo: null, rpc: 'mainnet.helius-rpc.com', auto: 'troca', helius: true, proximo: true }]);
    assert.equal(S().rpcUrl, EMBEDDED2);
    assert.equal(S().customRpc, true, 'continua no RPC próprio (a estimativa e os créditos seguem valendo)');
    assert.ok(!factoryCalls().some((c) => c.url === PUBLIC_MAINNET), 'o público não foi usado');
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
    assert.ok(world.novoCalls.includes('getSignaturesForAddress'), 'a busca da frase 2 foi refeita na 2ª chave');
    assert.ok(!bodies.join('\n').includes(KEY) && !events.slice(e0).map((e) => e.data).join('\n').includes(KEY), 'nenhuma chave sai do servidor');
  });
});

test('duas chaves: a 1ª esgota no meio e a 2ª também está esgotada → segue no público', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]);
  await withEmbedded(TWO_KEYS, async () => {
    nextClient = (url) => (url === EMBEDDED ? fakeRpc : url === EMBEDDED2 ? quotaClient : newRpc);
    const e0 = events.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' }), null);
    assert.deepEqual(startedPauses(e0), []);
    assert.deepEqual(autoEvents(e0), [{ motivo: null, rpc: 'api.mainnet-beta.solana.com (público, mais lento)', auto: 'troca', helius: true }]);
    assert.equal(S().rpcUrl, PUBLIC_MAINNET);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
  });
});

// ---------- proxy do Clurn como 1º embutido (09/11/2026, proxy/) ----------

const PROXY_URL = 'https://clurn-rpc.exemplo.workers.dev/';
const PROXY_AND_KEY = [{ url: PROXY_URL, heliusProject: null, proxy: true as const }, { url: EMBEDDED, heliusProject: null }];

test('proxy: é o 1º RPC da rodada e só ele recebe o cabeçalho com a versão do app', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(PROXY_AND_KEY, async () => {
    nextClient = fakeRpc;
    const f0 = factoryOpts.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    const made = factoryOpts.slice(f0);
    assert.equal(made[0]!.url, PROXY_URL);
    assert.match(made[0]!.headers?.['x-clurn-versao'] ?? '', /^\d+\.\d+\.\d+$/);
    assert.equal(S().rpcUrl, PROXY_URL);
    assert.equal(S().rpcLabel, 'clurn-rpc.exemplo.workers.dev');
    assert.equal(S().customRpc, true);
    assert.ok(made.filter((o) => o.url !== PROXY_URL).every((o) => o.headers === undefined), 'nenhum outro RPC recebe o cabeçalho');
  });
});

test('proxy: cota do dia do proxy acabada na conferência → a rodada começa na chave embutida seguinte, não no público', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(PROXY_AND_KEY, async () => {
    nextClient = (url) => (url === PROXY_URL ? quotaClient : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(factoryCalls().slice(-2).map((c) => c.url), [PROXY_URL, EMBEDDED]);
    assert.equal(S().rpcUrl, EMBEDDED);
    assert.equal(S().frases[0]!.status, 'pronta');
  });
});

test('proxy: só o proxy embutido e ele no limite no meio da análise → segue no público do mesmo ponto', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]);
  await withEmbedded([PROXY_AND_KEY[0]!], async () => {
    nextClient = (url) => (url === PROXY_URL ? fakeRpc : newRpc);
    const e0 = events.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' }), null);
    assert.deepEqual(startedPauses(e0), []);
    assert.equal(S().rpcUrl, PUBLIC_MAINNET);
    assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
  });
});

test('proxy (1.0, 16/11/2026): sem chave no app, o painel de créditos some, o Helius não é consultado e nada vai para o histórico', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  let asked = 0;
  withBalance((async () => { asked++; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch);
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded([PROXY_AND_KEY[0]!], async () => {
    const before = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.deepEqual([before.own, before.helius, asked], [false, { status: 'sem-projeto' }, 0], 'antes da rodada: o painel não aparece');
    nextClient = fakeRpc;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.equal(S().rpcUrl, PROXY_URL);
    assert.ok(S().usage.snapshot().credits > 0, 'o medidor contou as consultas (o histórico é que recusa)');
    const st = JSON.parse((await getState()).body) as { credits: { own: boolean } };
    assert.equal(st.credits.own, false, 'o recibo não mostra a linha de créditos');
    const after = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.deepEqual([after.own, asked], [false, 0]);
    assert.deepEqual(readHist(), [], 'o gasto do proxy não entra no histórico deste computador');
  });
  // proxy fora e a rodada na chave seguinte: a chave volta a ter painel (o par proxy + chave segue como antes)
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  await withEmbedded(PROXY_AND_KEY, async () => {
    nextClient = (url) => (url === PROXY_URL ? quotaClient : fakeRpc);
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    const st = JSON.parse((await getState()).body) as { credits: { own: boolean } };
    assert.deepEqual([S().rpcUrl, st.credits.own], [EMBEDDED, true]);
  });
  withBalance(noNet);
});

test('duas chaves: o painel mostra o saldo da chave que ainda tem crédito (a esgotada fica para trás)', async () => {
  await reset();
  const asked: string[] = [];
  withBalance((async (url: string) => {
    asked.push(url);
    const restantes = url.includes(PROJECT2) ? 700000 : 0;
    return new Response(JSON.stringify({ creditsRemaining: restantes, creditsUsed: 1000000 - restantes, subscriptionDetails: { creditsLimit: 1000000, plan: 'free' } }), { status: 200 });
  }) as unknown as typeof fetch);
  await withEmbedded(TWO_KEYS, async () => {
    const b = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.equal(b.helius.status, 'ok');
    assert.equal(b.helius.restantes, 700000, 'a 2ª chave');
    assert.equal(asked.length, 2);
    withBalance((async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ creditsRemaining: 5, creditsUsed: 0 }), { status: 200 });
    }) as unknown as typeof fetch);
    const c = JSON.parse((await post('/api/creditos', { atualizar: true })).body);
    assert.equal(c.helius.restantes, 5);
    assert.equal(asked.length, 3, 'a 1ª com crédito basta: a 2ª nem é consultada');
  });
  withBalance(noNet);
});

test('troca automática: a SOLANA_RPC_URL esgota no meio da EXECUÇÃO → segue no público, passo no ar fica "desconhecido", nada é montado de novo', async () => {
  await reset();
  chain();
  const a = useWallets(PHRASES[0], 'solflare', [0, 1, 2]);
  world.lamports.set(a[0], 60_000_000);
  const b = useWallets(PHRASES[1], 'solflare', [0]);
  const env = process.env.SOLANA_RPC_URL;
  process.env.SOLANA_RPC_URL = NEW_URL; // o RPC próprio do autor (vale também na devnet)
  sv.setEmbeddedRpcForTest(null);
  nextClient = (url) => (url === NEW_URL ? fakeRpc : newRpc);
  sv.setExternalForTest({ ...baseExternal(), execSleep: () => new Promise<void>((r) => setTimeout(r, 20)), confirmTimeoutMs: 4_000 });
  try {
    await analyse([item(PHRASES[0]), item(PHRASES[1])]);
    assert.equal(S().rpcLabel, 'novo.exemplo', 'a rodada começou no RPC próprio');
    assert.equal((await plano()).status, 200);
    await task('/api/simular');
    assert.equal(S().aborted, null);
    world.dieAfterSend.add(a[1]); // o 1º passo é enviado; o RPC próprio cai antes de confirmar
    const e0 = events.length;
    const n0 = ends();
    assert.equal((await post('/api/executar', { confirmacao: typedCode() })).status, 202);
    await waitTask(n0);
    assert.deepEqual(startedPauses(e0), [], 'a execução não parou esperando clique');
    assert.deepEqual(autoEvents(e0).map((p) => [p.auto, p.helius]), [['troca', false]]);
    assert.equal(S().rpcLabel, 'api.devnet.solana.com (público, mais lento)');
    const ex = S().execResults;
    const stuck = ex.find((x) => x.step.wallet === a[1])!;
    assert.equal(stuck.status, 'desconhecido', 'o passo que estava no ar não vira "falhou" nem é refeito');
    assert.equal(stuck.error?.code, 'send-unknown');
    const rest = ex.filter((x) => x !== stuck);
    assert.ok(rest.length >= 3 && rest.every((x) => x.status === 'enviado'), 'os passos seguintes e a frase 2 seguem no público');
    assert.ok(rest.some((x) => x.frase === 2 && b.includes(x.step.wallet)));
    const sigs = new Set(world.sent.filter((s) => s.from.includes(a[1])).map((s) => s.signature));
    assert.equal(sigs.size, 1, 'uma assinatura só para o passo no ar (reenviar a mesma pode; outra, nunca)');
    assert.equal(S().executed, true);
  } finally {
    if (env === undefined) delete process.env.SOLANA_RPC_URL; else process.env.SOLANA_RPC_URL = env;
    sv.setExternalForTest(baseExternal());
    await until(() => S().busy === null, 'execução terminar (limpeza do teste)').catch(() => {});
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('troca automática: o público também falha → pausa; quando o público volta, a rodada segue sozinha, sem clique', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]);
  let publicUp = false;
  const publicDown: RpcClient = { call: () => Promise.reject(new RpcError('getGenesisHash: 503', 503)) };
  sv.setRpcRetryForTest(40);
  try {
    await withEmbedded(EMBEDDED, async () => {
      nextClient = (url) => (url === EMBEDDED ? fakeRpc : publicUp ? newRpc : publicDown);
      const e0 = events.length;
      const n0 = ends();
      assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' })).status, 202);
      await until(() => S().pause !== null, 'pausa (o público também não serviu)');
      assert.equal(S().pause, 'rpc-quota');
      await until(() => startedPauses(e0).length > 0, 'evento da pausa na página');
      assert.deepEqual(startedPauses(e0), [{ motivo: 'rpc-quota' }]);
      const tries = factoryCalls().filter((c) => c.url === 'https://api.mainnet-beta.solana.com').length;
      await until(() => factoryCalls().filter((c) => c.url === 'https://api.mainnet-beta.solana.com').length >= tries + 2, 'novas tentativas sozinhas');
      assert.ok(S().frases[1]!.seed?.some((x) => x !== 0), 'a seed da frase pausada continua na memória (o progresso não se perde)');
      publicUp = true; // o público voltou
      await waitTask(n0);
      assert.equal(S().pause, null);
      await until(() => autoEvents(e0).length > 0, 'evento da volta');
      assert.deepEqual(autoEvents(e0).map((p) => p.auto), ['volta'], 'a página fica sabendo que voltou sozinho');
      assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
    });
  } finally {
    sv.setRpcRetryForTest(null);
  }
});

test('troca automática: na pausa do público, "Parar aqui" para de vez e as novas tentativas acabam', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]);
  const publicDown: RpcClient = { call: () => Promise.reject(new RpcError('getGenesisHash: 503', 503)) };
  sv.setRpcRetryForTest(30);
  try {
    await withEmbedded(EMBEDDED, async () => {
      nextClient = (url) => (url === EMBEDDED ? fakeRpc : publicDown);
      const n0 = ends();
      assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' })).status, 202);
      await until(() => S().pause !== null, 'pausa');
      assert.equal((await post('/api/parar', {})).status, 200);
      await waitTask(n0);
      const after = factoryCalls().length;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(factoryCalls().length, after, 'parado: nenhuma tentativa nova depois');
      assert.equal(S().frases[1]!.status, 'erro');
    });
  } finally {
    sv.setRpcRetryForTest(null);
  }
});

test('troca automática: rodada que já está no público e cai → pausa e volta sozinha (sem troca para "outro público")', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const b = useWallets(PHRASES[1], 'solflare', [0, 1]);
  world.dieOnSig.add(b[0]);
  sv.setRpcRetryForTest(40);
  try {
    await withEmbedded(null, async () => {
      let n = 0;
      nextClient = () => (n++ === 0 ? fakeRpc : newRpc); // 1º cliente: o público da rodada (morre); depois, o público de novo (vivo)
      const e0 = events.length;
      const n0 = ends();
      assert.equal((await post('/api/analisar', { frases: [item(PHRASES[0]), item(PHRASES[1])], rede: 'mainnet' })).status, 202);
      await waitTask(n0);
      await until(() => autoEvents(e0).length > 0, 'evento da volta');
      assert.deepEqual(startedPauses(e0), [{ motivo: 'rpc-quota' }], 'no público não há para onde trocar: pausa');
      assert.deepEqual(autoEvents(e0).map((p) => p.auto), ['volta']);
      assert.deepEqual(S().frases.map((f) => f.status), ['pronta', 'pronta']);
    });
  } finally {
    sv.setRpcRetryForTest(null);
  }
});

// ---------- getProgramAccounts recusado pelo Helius vai pelo público (31/10/2026) ----------

const HELIUS_GPA_REFUSAL = 'getProgramAccounts: Too many accounts requested (10000001 pubkeys), Please use getProgramAccountsV2 with pagination to handle large datasets.';
const heliusLike = (seen: string[]): RpcClient => ({
  call: <T>(m: string, p: unknown[]) => {
    seen.push(m);
    return m === 'getProgramAccounts' ? Promise.reject(new RpcError(HELIUS_GPA_REFUSAL, -32600)) : fakeRpc.call<T>(m, p);
  },
});

test('Helius recusa o getProgramAccounts: a rodada fica no Helius e só essa busca vai pelo público da mainnet', async () => {
  await reset();
  fs.rmSync(HISTORY_FILE, { force: true });
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  const own: string[] = [];
  const pub: string[] = [];
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? heliusLike(own) : { call: <T>(m: string, p: unknown[]) => (pub.push(m), fakeRpc.call<T>(m, p)) });
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.equal(S().rpcLabel, 'mainnet.helius-rpc.com', 'a checagem passou no Helius: a rodada não caiu para o público');
    assert.equal(S().frases[0]!.status, 'pronta');
    assert.equal(own.filter((m) => m === 'getProgramAccounts').length, 1, 'o Helius só viu a 1ª busca (recusada)');
    assert.ok(own.includes('getTokenAccountsByOwner') && own.includes('getGenesisHash'), 'leituras e trava no Helius');
    assert.equal(pub[0], 'getGenesisHash', 'o público confere a rede antes da primeira busca');
    assert.ok(pub.filter((m) => m === 'getProgramAccounts').length >= 2, 'checagem e fee parada pelo público');
    assert.ok(pub.every((m) => m === 'getGenesisHash' || m === 'getProgramAccounts'), `o público só faz a busca: ${[...new Set(pub)].join(',')}`);
    const pubClient = factoryCalls().find((c) => c.url === 'https://api.mainnet-beta.solana.com');
    assert.deepEqual(pubClient && [pubClient.rps, pubClient.porMetodo], [PUBLIC_RPC_LIMITS.requestsPerSecond, PUBLIC_RPC_LIMITS.defaultMethodLimit], 'cliente público com os limites do público');
    const hist = readHist();
    assert.equal(hist[0]!.creditos, own.length - 1 + 10, 'créditos: as consultas do Helius (a busca recusada vale 10), nenhuma do público');
  });
});

test('Helius recusa o getProgramAccounts e o público falha nessa busca: só a fee parada daquela carteira fica sem ler; sem pausa', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  let gpaCalls = 0;
  await withEmbedded(EMBEDDED, async () => {
    nextClient = (url) => (url === EMBEDDED ? heliusLike([]) : {
      call: <T>(m: string, p: unknown[]) => {
        if (m !== 'getProgramAccounts') return fakeRpc.call<T>(m, p);
        gpaCalls++;
        // a checagem (1ª busca) passa; depois o público cai com 503 nas buscas da fee parada
        return gpaCalls === 1 ? fakeRpc.call<T>(m, p) : Promise.reject(new RpcError('getProgramAccounts: 503', 503));
      },
    });
    const e0 = events.length;
    assert.equal(await analyseAndWait({ frases: [item(PHRASES[0])], rede: 'mainnet' }), null);
    assert.deepEqual(startedPauses(e0), [], 'falha do público na busca não pausa a rodada');
    assert.deepEqual(autoEvents(e0), [], 'nem troca a rodada para o público');
    assert.equal(S().rpcLabel, 'mainnet.helius-rpc.com');
    assert.equal(S().frases[0]!.status, 'pronta');
    const wallets = (JSON.parse((await getState()).body) as { frases: Array<{ wallets: Array<{ unsweptError: string | null }> }> }).frases[0]!.wallets;
    assert.ok(wallets.length > 0 && wallets.every((w) => /pelo RPC público: getProgramAccounts: 503/.test(w.unsweptError ?? '')), JSON.stringify(wallets.map((w) => w.unsweptError)));
  });
});

// ---------- o app descobre se a frase é Solflare ou Phantom (pedido do autor, 31/10/2026) ----------

const auto = (texto: string) => ({ texto, carteira: 'auto' });

test("frases/auto: a busca nos dois ramos diz Solflare, Phantom, só a principal ou nenhuma; 'ambas' vira duas frases", async () => {
  await reset();
  const sol = useWallets(PHRASES[0], 'solflare', [0, 1]); // temporárias
  const ph = useWallets(PHRASES[1], 'phantom', [0, 1, 2]); // Conta 1 (principal), Conta 2 e 3
  useWallets(PHRASES[2], 'phantom', [0]); // só a principal
  // PHRASES[3]: nada com uso
  const amb = [...useWallets(PHRASES[4], 'solflare', [0]), ...useWallets(PHRASES[4], 'phantom', [0, 1])];
  await analyse([auto(PHRASES[0]), auto(PHRASES[1]), auto(PHRASES[2]), auto(PHRASES[3]), auto(PHRASES[4])]);
  const fs_ = S().frases;
  assert.deepEqual(fs_.map((f) => [f.n, f.detected, f.app, f.status]), [
    [1, 'solflare', 'solflare', 'pronta'],
    [2, 'phantom', 'phantom', 'pronta'],
    [3, 'principal', 'solflare', 'pronta'],
    [4, 'nenhuma', 'solflare', 'pronta'],
    [5, 'ambas', 'solflare', 'pronta'],
    [6, 'ambas', 'phantom', 'pronta'], // a irmã entra logo depois da frase colada, com o próximo número livre
  ]);
  const [f1, f2, f3, f4, f5, f6] = fs_;
  assert.deepEqual(f1.discovery!.wallets.map((w) => w.address), sol);
  assert.deepEqual([...f1.signers.keys()], [0, 1]);
  // Phantom: a Conta 1 aparece na revisão, mas nunca ganha chave
  assert.deepEqual([...f2.signers.keys()], [1, 2]);
  assert.equal(f2.main, ph[0]);
  assert.ok(f2.review?.accounts.some((a) => a.index === 0 && a.isMain));
  // só a principal / nenhuma: nenhuma carteira, nenhuma chave (a principal nunca entra)
  for (const f of [f3, f4]) {
    assert.deepEqual([f.discovery!.wallets.length, f.signers.size, f.scans.length], [0, 0, 0]);
    assert.equal(f.plan, null);
  }
  // ambas: temporárias na 5, contas comuns na 6 (sem a Conta 1), as duas lidas e apontando uma para a outra
  assert.deepEqual([f5.pair, f5.pairOf, f6.pair, f6.pairOf], [6, null, null, 5]);
  assert.deepEqual(f5.discovery!.wallets.map((w) => w.address), [amb[0]]);
  assert.deepEqual([...f5.signers.keys()], [0]);
  assert.deepEqual([...f6.signers.keys()], [1]);
  assert.ok(![...f6.signers.values()].some((s) => s.address === amb[1]), 'a Conta 1 da irmã nunca ganha chave');
  assert.deepEqual(f6.scans.map((s) => s.address), [amb[2]]);
  assert.equal(f6.main, f5.main);
  assert.equal(f6.seed, null);
  assert.equal(f6.evm, null, 'outras redes ficam só na frase colada');
  const p6 = trialPlanOf(f6);
  assert.ok(!p6.steps.some((s) => s.walletIndex === 0 || s.wallet === f6.main));
  // a página recebe o que a busca achou
  const v = JSON.parse((await getState()).body) as { frases: Array<{ n: number; auto: boolean; detected: string; pair: number | null; pairOf: number | null }> };
  assert.deepEqual(v.frases.map((f) => [f.n, f.auto, f.detected, f.pair, f.pairOf]), [
    [1, true, 'solflare', null, null], [2, true, 'phantom', null, null], [3, true, 'principal', null, null],
    [4, true, 'nenhuma', null, null], [5, true, 'ambas', 6, null], [6, false, 'ambas', null, 5],
  ]);
});

test('frases/auto: Conta 2 da irmã (ambas) não serve de destino: é uma das burners', async () => {
  await reset();
  chain();
  useWallets(PHRASES[4], 'solflare', [0]);
  const c = useWallets(PHRASES[4], 'phantom', [0, 1]);
  await analyse([auto(PHRASES[4])]);
  assert.equal(S().frases.length, 2);
  const r = await post('/api/plano', { destino: c[1], destino2: c[1], porFrase: {} });
  assert.equal(r.status, 400, r.body);
  assert.match(JSON.parse(r.body).erro, /uma das burners/);
});

test('frases/auto: frase com Conta 2 mas sem Conta 1 usada continua Phantom, com o alerta da revisão', async () => {
  await reset();
  useWallets(PHRASES[1], 'phantom', [1]);
  await analyse([auto(PHRASES[1])]);
  const [f] = S().frases;
  assert.equal(f.detected, 'phantom');
  assert.ok(f.review?.warnings.some((w) => /Conta 1 nunca foi usada/.test(w)));
});

test('frases/auto: refazer a irmã refaz a frase colada; a irmã antiga sai e não conta como repetida', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  useWallets(PHRASES[4], 'solflare', [0]);
  useWallets(PHRASES[4], 'phantom', [0, 1]);
  await analyse([auto(PHRASES[0]), auto(PHRASES[4])]);
  assert.deepEqual(S().frases.map((f) => [f.n, f.pairOf]), [[1, null], [2, null], [3, 2]]);
  const n0 = ends();
  const r = await post('/api/analisar-frase', { n: 3, texto: PHRASES[4], carteira: 'auto' });
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
  assert.deepEqual(S().frases.map((f) => [f.n, f.detected, f.app, f.status, f.pair, f.pairOf]), [
    [1, 'solflare', 'solflare', 'pronta', null, null],
    [2, 'ambas', 'solflare', 'pronta', 3, null],
    [3, 'ambas', 'phantom', 'pronta', null, 2],
  ]);
  // a mesma frase da 1 em outro número é repetida (auto lê os dois apps), e a resposta aponta a frase colada
  const dup = await post('/api/analisar-frase', { n: 3, texto: PHRASES[0], carteira: 'auto' });
  assert.equal(dup.status, 400);
  assert.deepEqual([JSON.parse(dup.body).codigo, JSON.parse(dup.body).params.of], ['seed-duplicate', 1]);
});

test('frases/auto: a irmã nascida no meio da análise entra no "carteiras lidas" da tela', () => {
  const f = sv.newFrase(1, 'auto', Buffer.alloc(64));
  const tr = sv.makeTracker([f], false);
  const g = sv.newFrase(2, 'phantom');
  f.pair = 2;
  g.pairOf = 1;
  S().frases = [f, g];
  f.discovery = { wallets: Array.from({ length: 2 }, (_, index) => ({ index })) } as never;
  g.discovery = { wallets: Array.from({ length: 3 }, (_, index) => ({ index: index + 1 })) } as never;
  f.status = 'pronta';
  g.status = 'leitura';
  tr.report('leitura', g, 1, 3, 'Conta 2');
  assert.deepEqual(S().progress!.geral, { feitos: 3, total: 5 }, 'as 2 temporárias lidas + 1 das 3 contas da irmã');
  S().frases = [];
});

// terceiro ramo, m/44'/501'/i' (Trust e Phantom antiga), 06/11/2026: cada ramo com uso vira um cartão irmão
test('frases/auto: Trust vira cartão irmão', async () => {
  await reset();
  chain();
  const tr = useWallets(PHRASES[0], 'trust', [0, 1, 2]); // conta 0 (principal da Trust), 1 e 2
  useWallets(PHRASES[1], 'phantom', [0, 1]);
  const tr1 = useWallets(PHRASES[1], 'trust', [0, 3]);
  useWallets(PHRASES[2], 'solflare', [0]);
  useWallets(PHRASES[2], 'phantom', [0, 2]);
  const tr2 = useWallets(PHRASES[2], 'trust', [1]);
  useWallets(PHRASES[3], 'trust', [0]); // só a principal da Trust: nada para limpar
  await analyse([auto(PHRASES[0]), auto(PHRASES[1]), auto(PHRASES[2]), auto(PHRASES[3])]);
  const fs_ = S().frases;
  assert.deepEqual(fs_.map((f) => [f.n, f.detected, f.app, f.status, f.pair, f.pairOf]), [
    [1, 'trust', 'trust', 'pronta', null, null], // só a Trust: um cartão trust, sem irmã
    [2, 'ambas', 'phantom', 'pronta', 5, null], // Phantom e Trust: dois cartões
    [5, 'ambas', 'trust', 'pronta', null, 2],
    [3, 'ambas', 'solflare', 'pronta', 6, null], // os três ramos: três cartões, na ordem Solflare, Phantom, Trust
    [6, 'ambas', 'phantom', 'pronta', null, 3],
    [7, 'ambas', 'trust', 'pronta', null, 3],
    [4, 'principal', 'solflare', 'pronta', null, null],
  ]);
  const by = (n: number) => fs_.find((f) => f.n === n)!;
  const trustMain = (p: string) => addressAt(seedOf(p), trustPath(0));
  // a conta 0 da Trust nunca ganha chave; a principal do cartão é ela
  assert.deepEqual(by(1).discovery!.wallets.map((w) => w.address), tr);
  assert.deepEqual([...by(1).signers.keys()], [1, 2]);
  assert.ok(![...by(1).signers.values()].some((s) => s.address === tr[0]));
  assert.equal(by(1).main, trustMain(PHRASES[0]));
  assert.equal(tr[0], trustMain(PHRASES[0]));
  assert.ok(by(1).review?.accounts.some((a) => a.index === 0 && a.isMain && a.address === tr[0]), 'conta 0 na conferência, como principal');
  assert.deepEqual(by(1).scans.map((s) => s.address), tr.slice(1), 'conta 0 fora das leituras do plano');
  assert.ok(!trialPlanOf(by(1)).steps.some((s) => s.walletIndex === 0 || s.wallet === tr[0]));
  // Phantom + Trust: a irmã tem as contas da Trust, sem a conta 0
  assert.deepEqual([...by(5).signers.keys()], [1, 2, 3]);
  assert.ok(by(5).discovery!.wallets.some((w) => w.address === tr1[1] && w.hasHistory));
  assert.ok(![...by(5).signers.values()].some((s) => s.address === tr1[0]));
  assert.equal(by(5).main, trustMain(PHRASES[1]));
  assert.equal(by(2).main, deriveMainAddress(seedOf(PHRASES[1])), 'a frase colada segue com a Conta 1 da Phantom');
  // três ramos: a irmã da Trust tem só a conta 1 (a 0 está sem uso e fica de fora mesmo assim)
  assert.deepEqual([...by(7).signers.keys()], [1]);
  assert.deepEqual(by(7).scans.map((s) => s.address), tr2);
  for (const g of [by(5), by(6), by(7)]) assert.equal(g.seed, null);
  // só a principal da Trust: nenhuma carteira, nenhuma chave
  assert.deepEqual([by(4).discovery!.wallets.length, by(4).signers.size, by(4).scans.length], [0, 0, 0]);
  // a página recebe o app e as irmãs
  const v = JSON.parse((await getState()).body) as { frases: Array<{ n: number; app: string; pair: number | null; pairs: Array<{ n: number; app: string }> }> };
  assert.deepEqual(v.frases.find((f) => f.n === 3)!.pairs, [{ n: 6, app: 'phantom' }, { n: 7, app: 'trust' }]);
  assert.deepEqual(v.frases.find((f) => f.n === 1)!.pairs, []);
  assert.equal(v.frases.find((f) => f.n === 7)!.app, 'trust');
  // destino: conta 1 da Trust é burner (recusada); a conta 0 é a principal, que só recebe (como a Conta 1 da Phantom)
  for (const dest of [tr[1], tr2[0], tr1[1]]) {
    const r = await post('/api/plano', { destino: dest, porFrase: {} });
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).erro, /uma das burners/);
  }
  assert.ok(S().frases.every((f) => f.plan === null), 'nenhum plano montado');
  // a Trust passa pela conferência como a Phantom: sem a contagem, recusado
  world.lamports.set(tr[0], 50_000_000);
  const sem = await post('/api/plano', { destino: tr[0], porFrase: {} });
  assert.equal(sem.status, 400, sem.body);
  assert.match(JSON.parse(sem.body).erro, /^Frase 1: Confirme quantas contas/, 'a frase 1 (só Trust) é a que pede a contagem');
  const conf = (n: number) => by(n).review!.accounts.filter((a) => !a.isMain).length;
  const porFrase = Object.fromEntries([1, 2, 5, 6, 7].map((n) => [n, { protegidas: [], contasConfirmadas: conf(n) }]));
  // só a Trust sem a contagem: recusado do mesmo jeito (as outras frases já confirmadas)
  const soTrust = await post('/api/plano', { destino: tr[0], porFrase: { ...porFrase, 1: { protegidas: [] } } });
  assert.equal(soTrust.status, 400, soTrust.body);
  assert.match(JSON.parse(soTrust.body).erro, /^Frase 1: Confirme quantas contas/);
  // conta protegida na Trust fica fora do plano (Conta 2 = índice 1)
  const prot = await post('/api/plano', { destino: tr[0], porFrase: { ...porFrase, 1: { protegidas: [2], contasConfirmadas: 1 } } });
  assert.equal(prot.status, 200, prot.body);
  assert.ok(!by(1).plan!.steps.some((s) => s.wallet === tr[1]), 'Conta 2 protegida não entra');
  assert.ok(by(1).plan!.steps.some((s) => s.wallet === tr[2]), 'Conta 3 entra');
  const ok = await post('/api/plano', { destino: tr[0], porFrase });
  assert.equal(ok.status, 200, ok.body);
  const p1 = by(1).plan!;
  assert.ok(p1, 'conta 0 da Trust serve de destino');
  assert.ok(!p1.steps.some((s) => s.walletIndex === 0 || s.wallet === tr[0]), 'e nunca é limpa');
});

test('frases/auto: a mesma frase só com a Trust em outro número é repetida (a principal do cartão é a conta 0)', async () => {
  await reset();
  useWallets(PHRASES[0], 'trust', [0, 1]);
  useWallets(PHRASES[1], 'solflare', [0]);
  await analyse([auto(PHRASES[0]), auto(PHRASES[1])]);
  assert.deepEqual(S().frases.map((f) => [f.n, f.app]), [[1, 'trust'], [2, 'solflare']]);
  const dup = await post('/api/analisar-frase', { n: 2, texto: PHRASES[0], carteira: 'auto' });
  assert.equal(dup.status, 400, dup.body);
  assert.deepEqual([JSON.parse(dup.body).codigo, JSON.parse(dup.body).params.of], ['seed-duplicate', 1]);
});

test('frases/auto: refazer a frase de três ramos tira as duas irmãs antigas; as irmãs não contam como repetida', async () => {
  await reset();
  useWallets(PHRASES[4], 'solflare', [0]);
  useWallets(PHRASES[4], 'phantom', [0, 1]);
  useWallets(PHRASES[4], 'trust', [0, 1]);
  await analyse([auto(PHRASES[4])]);
  assert.deepEqual(S().frases.map((f) => [f.n, f.app, f.pairOf]), [[1, 'solflare', null], [2, 'phantom', 1], [3, 'trust', 1]]);
  const n0 = ends();
  const r = await post('/api/analisar-frase', { n: 3, texto: PHRASES[4], carteira: 'auto' });
  assert.equal(r.status, 202, r.body);
  await waitTask(n0);
  assert.deepEqual(S().frases.map((f) => [f.n, f.app, f.status, f.pairOf]), [[1, 'solflare', 'pronta', null], [2, 'phantom', 'pronta', 1], [3, 'trust', 'pronta', 1]]);
});

test('frases/auto: as duas irmãs nascidas no meio da análise entram no "carteiras lidas" da tela', () => {
  const f = sv.newFrase(1, 'auto', Buffer.alloc(64));
  const tr = sv.makeTracker([f], false);
  const g = sv.newFrase(2, 'phantom');
  const h = sv.newFrase(3, 'trust');
  f.pair = 2;
  g.pairOf = 1;
  h.pairOf = 1;
  S().frases = [f, g, h];
  f.discovery = { wallets: Array.from({ length: 2 }, (_, index) => ({ index })) } as never;
  g.discovery = { wallets: Array.from({ length: 3 }, (_, index) => ({ index: index + 1 })) } as never;
  h.discovery = { wallets: Array.from({ length: 4 }, (_, index) => ({ index: index + 1 })) } as never;
  f.status = 'pronta';
  g.status = 'pronta';
  h.status = 'leitura';
  tr.report('leitura', h, 1, 4, 'Conta 2');
  assert.deepEqual(S().progress!.geral, { feitos: 6, total: 9 }, '2 temporárias + 3 contas da Phantom + 1 das 4 da Trust');
  S().frases = [];
});

test('frases/plano: destino que imita a conta 0 da Trust → recusado (dest-lookalike)', async () => {
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0]);
  await analyse([auto(PHRASES[0])]);
  const real = addressAt(seedOf(PHRASES[0]), trustPath(0));
  const fake = real.slice(0, 4) + '1'.repeat(real.length - 8) + real.slice(-4);
  world.lamports.set(fake, 50_000_000);
  const r = await post('/api/plano', { destino: fake, porFrase: {} });
  assert.equal(r.status, 400, r.body);
  assert.equal(JSON.parse(r.body).codigo, 'dest-lookalike');
});

// ---------- cartão de chaves privadas coladas (fase 1 multirredes, Task 5) ----------
// Chaves geradas no próprio teste (semente = hash de um rótulo, ou a chave de uma conta das frases de teste): nunca de
// carteira real. Um cartão de chaves é uma "frase sem busca": as carteiras são as chaves, com a conferência da Phantom.

type TestKey = { seed: Buffer; address: string; base58: string; hex: string; json: string };
function testKey(tag: string | Buffer): TestKey {
  const seed = Buffer.isBuffer(tag) ? Buffer.from(tag) : createHash('sha256').update(`clurn-teste-chave-${tag}`).digest();
  const pub = publicKeyFromPrivate(seed);
  const full = Buffer.concat([seed, pub]);
  return { seed, address: encodeBase58(pub), base58: encodeBase58(full), hex: full.toString('hex'), json: JSON.stringify([...full]) };
}
// a chave de uma conta de uma frase de teste (principal, temporária…), como a carteira a exportaria
const phraseKey = (phrase: string, p: string) => testKey(derivePrivateKey(seedOf(phrase), p));
// do jeito que a área de transferência do Windows entrega: \r\n entre as linhas
const keysCard = (ks: TestKey[], form: 'base58' | 'hex' | 'json' = 'base58') => ({ texto: ks.map((k) => k[form]).join('\r\n'), carteira: 'auto' });
function fundKeys(ks: TestKey[], lamports = 20_000_000) {
  for (const k of ks) world.lamports.set(k.address, lamports);
}
// moeda numa carteira de chave, com endereços válidos (entra em transação de queima, ao contrário do `fungible`)
function keyCoin(owner: string, tag: string) {
  const t = fungible(owner, testKey(`mint-${tag}`).address);
  return { ...t, pubkey: testKey(`conta-${tag}`).address };
}
const allConfirmed = (n: number, count: number) => ({ [n]: { protegidas: [], contasConfirmadas: count } });
const cardView = async (n: number) => (JSON.parse((await getState()).body).frases as Array<Record<string, unknown> & { n: number }>).find((f) => f.n === n)!;

test('chaves: cartão limpo de ponta a ponta', async () => {
  await reset();
  chain();
  world.applySends = true;
  const ks = [testKey('ponta-1'), testKey('ponta-2'), testKey('ponta-3')];
  world.lamports.set(ks[0].address, 20_000_000);
  world.lamports.set(ks[1].address, 3_000_000);
  world.lamports.set(ks[2].address, 5_000_000); // a rede falsa não credita o aluguel da conta fechada: a carteira precisa de saldo
  world.tokens.set(ks[1].address, [keyCoin(ks[1].address, 'ponta')]);
  world.tokens.set(ks[2].address, [emptyAccount(ks[2].address)]);
  // cada linha num formato, com o lixo da área de transferência em volta
  await analyse([{ texto: `"${ks[0].base58}",\r\n\r\n  ${ks[1].hex};\r\n${ks[2].json}\r\n`, carteira: 'auto' }]);
  const [f] = S().frases;
  assert.deepEqual([f.app, f.status, f.auto, f.seed, f.keys, f.main, f.error], ['chaves', 'pronta', false, null, null, null, null]);
  assert.ok(!world.sigCalls.some((a) => ks.some((k) => k.address === a)), 'cartão de chaves não faz busca');
  assert.deepEqual(f.discovery!.wallets.map((w) => w.address), ks.map((k) => k.address));
  assert.deepEqual([...f.signers.entries()].map(([i, s]) => [i, s.address]), ks.map((k, i) => [i, k.address]), 'uma chave de assinatura por chave colada');
  const v = await cardView(1);
  assert.equal(v.app, 'chaves');
  assert.ok(!('keys' in v) && !('keyList' in v) && !('seed' in v), 'nem as chaves nem a lista interna vão para a página');
  assert.equal(v.keysOverlap, null);
  assert.deepEqual((v.wallets as Array<{ label: string }>).map((w) => w.label), ['Chave 1', 'Chave 2', 'Chave 3']);
  assert.deepEqual((v.review as { accounts: Array<{ label: string; isMain: boolean; warnings: string[] }> }).accounts.map((a) => [a.label, a.isMain, a.warnings.length]), [['Chave 1', false, 0], ['Chave 2', false, 0], ['Chave 3', false, 0]]);
  const coin = f.holdings[0];
  assert.equal(coin.walletLabel, 'Chave 2');
  const r = await plano({ decisoes: { [coin.account]: 'burn' }, queimarConfirmado: [coin.account], porFrase: allConfirmed(1, 3) });
  assert.equal(r.status, 200, r.body);
  const plan = f.plan!;
  assert.deepEqual([...new Set(plan.steps.map((s) => s.wallet))].sort(), ks.map((k) => k.address).sort(), 'as três carteiras entram');
  for (const st of plan.steps) assert.equal(f.signers.get(st.walletIndex)?.address, st.wallet);
  const pv = JSON.parse(r.body).plan.frases[0];
  assert.ok(pv.steps.every((s: { label: string }) => /^Chave [1-3]$/.test(s.label)));
  const dest0 = world.lamports.get(DEST)!;
  const fee0 = world.lamports.get(APP_FEE_WALLET)!;
  await task('/api/simular');
  assert.equal(S().aborted, null, `${S().aborted} | ${S().simResults.map((x) => `${x.step.kind} ${x.status} ${x.detail ?? ''}`).join(' | ')}`);
  assert.ok(S().simResults.length > 0 && S().simResults.every((x) => x.status === 'simulado'), S().simResults.map((x) => `${x.status} ${x.detail ?? ''}`).join(' | '));
  await task('/api/executar', { confirmacao: typedCode() });
  try {
    assert.ok(S().execResults.every((x) => x.status === 'enviado'), S().execResults.map((x) => `${x.status} ${x.detail ?? ''}`).join(' | '));
    for (const k of ks) assert.equal(world.lamports.get(k.address) ?? 0, 0, 'a carteira da chave termina vazia');
    const arrived = BigInt(world.lamports.get(DEST)! - dest0);
    assert.ok(arrived > 0n);
    assert.equal(arrived, sv.viewForTest().arrived, '"já chegou" = o que chegou');
    assert.ok(world.lamports.get(APP_FEE_WALLET)! > fee0, 'a taxa de 11% chegou');
  } finally {
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('chaves: conferência obrigatória e suspeitas protegidas', async () => {
  await reset();
  chain();
  const ks = [testKey('conf-1'), testKey('conf-2'), testKey('conf-3')];
  fundKeys(ks);
  world.lamports.set(ks[0].address, 100_000_000); // 0,1 SOL solto: parece carteira de uso
  await analyse([keysCard(ks)]);
  const f = S().frases[0];
  const v = await cardView(1);
  const accounts = (v.review as { accounts: Array<{ index: number; warnings: string[]; isMain: boolean }> }).accounts;
  assert.deepEqual(accounts.map((a) => [a.index, a.isMain, a.warnings.length > 0]), [[0, false, true], [1, false, false], [2, false, false]], 'a página sabe qual tem alerta');
  // sem a contagem digitada: recusado (todas as carteiras de chaves passam pela conferência)
  const sem = await plano();
  assert.equal(sem.status, 400, sem.body);
  assert.match(JSON.parse(sem.body).erro, /^Frase 1: Confirme quantas contas/);
  assert.equal(f.plan, null);
  // sem a pessoa tocar em nada, a suspeita fica fora: a contagem que vale é a das outras duas
  const tres = await plano({ porFrase: { 1: { contasConfirmadas: 3 } } });
  assert.equal(tres.status, 400, 'a suspeita não conta como marcada');
  const ok = await plano({ porFrase: { 1: { contasConfirmadas: 2 } } });
  assert.equal(ok.status, 200, ok.body);
  assert.ok(!f.plan!.steps.some((s) => s.wallet === ks[0].address) && f.plan!.feePayer !== ks[0].address, 'a suspeita não entra nem como pagadora');
  assert.ok(f.plan!.steps.some((s) => s.wallet === ks[1].address) && f.plan!.steps.some((s) => s.wallet === ks[2].address));
  // a pessoa desmarca a proteção dela: entra
  const all = await plano({ porFrase: allConfirmed(1, 3) });
  assert.equal(all.status, 200, all.body);
  assert.ok(f.plan!.steps.some((s) => s.wallet === ks[0].address));
  // protegeu tudo: o cartão fica fora com o aviso (nenhum outro cartão: nenhum plano)
  const none = await plano({ porFrase: { 1: { protegidas: [1, 2, 3] } } });
  assert.equal(none.status, 400);
  assert.deepEqual(f.planNotice, { code: 'phantom-all-protected', params: { frase: 1 } });
  // número que não é carteira do cartão: recusado
  assert.equal((await plano({ porFrase: { 1: { protegidas: [4], contasConfirmadas: 3 } } })).status, 400);
  assert.equal(sv.defaultProtected({ app: 'phantom', review: f.review }).length, 0, 'Phantom e Trust: nenhuma por padrão (a principal já fica fora)');
});

// revisão independente de 08/11/2026: o plano de teste da análise usava todas as leituras, e a suspeita (com SOL) virava
// a pagadora do teste: sem aviso de depósito na análise (o /api/plano, sem ela, pediria depois) ou com o depósito
// pedido nela
test('chaves: plano de teste e depósito sem as carteiras protegidas por padrão', async () => {
  await reset();
  chain();
  const ks = [testKey('prot-teste-1'), testKey('prot-teste-2'), testKey('prot-teste-3')];
  fundKeys(ks, 100);
  world.lamports.set(ks[0].address, 100_000_000); // suspeita: 0,1 SOL solto, sobra para as taxas de todas
  for (const k of ks.slice(1)) world.tokens.set(k.address, [emptyAccount(k.address)]);
  await analyse([keysCard(ks)]);
  const f = S().frases[0];
  assert.deepEqual(sv.defaultProtected(f), [1]);
  assert.ok(f.feeWarning && f.feeNeed, 'sem a suspeita, falta SOL: o depósito é pedido já na análise');
  assert.notEqual(f.feeNeed!.wallet, ks[0].address, 'nunca na suspeita');
  assert.ok(ks.slice(1).some((k) => k.address === f.feeNeed!.wallet));
  assert.notEqual(sv.viewForTest().single?.hub, ks[0].address, 'nem a central do depósito único');
  assert.deepEqual(sv.trialScans(f).map((s) => s.address), ks.slice(1).map((k) => k.address));
  // o /api/plano com a conferência padrão pede o mesmo (espera a mesma carteira)
  const r = await plano({ porFrase: { 1: { contasConfirmadas: 2 } } });
  assert.equal(r.status, 400, r.body);
  assert.equal(JSON.parse(r.body).codigo, 'no-fee-sol');
  assert.notEqual(f.feeNeed!.wallet, ks[0].address);
  await reset(); // a espera do depósito para aqui

  // só a suspeita tem algo: o cartão não vira "nada a limpar" (a pessoa pode desmarcar a proteção)
  chain();
  const solo = [testKey('prot-teste-4'), testKey('prot-teste-5')];
  world.lamports.set(solo[0].address, 100_000_000);
  await analyse([keysCard(solo)]);
  const g = S().frases[0];
  assert.deepEqual([g.nothingToClean, g.feeWarning], [false, null]);
  // tudo protegido por padrão: sem aviso e sem espera
  await reset();
  chain();
  const ricas = [testKey('prot-teste-6'), testKey('prot-teste-7')];
  fundKeys(ricas, 100_000_000);
  await analyse([keysCard(ricas)]);
  const h = S().frases[0];
  assert.equal(sv.defaultProtected(h).length, 2);
  assert.deepEqual([h.nothingToClean, h.feeWarning, h.feeWait], [false, null, null]);
});

// revisão independente de 08/11/2026: a página manda a impressão da lista que a pessoa conferiu; o app recusa a contagem
// e a proteção se a lista do cartão for outra (cartão refeito, irmã com o mesmo número, carteira que saiu)
test('chaves: plano recusado se a conferência foi feita para outra lista (review-changed)', async () => {
  await reset();
  chain();
  const ks = [testKey('impressao-1'), testKey('impressao-2')];
  fundKeys(ks);
  for (const k of ks) world.tokens.set(k.address, [emptyAccount(k.address)]);
  await analyse([keysCard(ks)]);
  const fp = (await cardView(1)).reviewFp as string;
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.equal(fp, sv.reviewFingerprint(S().frases[0]));
  assert.ok(!ks.some((k) => fp.includes(k.base58) || fp.includes(k.hex)), 'só a impressão de endereços públicos');
  const old = await plano({ porFrase: { 1: { protegidas: [], contasConfirmadas: 2, conferida: 'f'.repeat(32) } } });
  assert.equal(old.status, 400, old.body);
  assert.deepEqual([JSON.parse(old.body).codigo, JSON.parse(old.body).params], ['review-changed', { frase: 1 }]);
  assert.equal(S().frases[0].plan, null, 'nenhum plano');
  const ok = await plano({ porFrase: { 1: { protegidas: [], contasConfirmadas: 2, conferida: fp } } });
  assert.equal(ok.status, 200, ok.body);
  // o cartão é refeito com outra chave no lugar: a impressão muda e a conferência antiga não vale mais
  const ks2 = [ks[0], testKey('impressao-3')];
  fundKeys(ks2);
  world.tokens.set(ks2[1].address, [emptyAccount(ks2[1].address)]);
  const n0 = ends();
  assert.equal((await post('/api/analisar-frase', { n: 1, ...keysCard(ks2) })).status, 202);
  await waitTask(n0);
  const fp2 = (await cardView(1)).reviewFp as string;
  assert.notEqual(fp2, fp);
  const stale = await plano({ porFrase: { 1: { protegidas: [], contasConfirmadas: 2, conferida: fp } } });
  assert.equal(stale.status, 400, stale.body);
  assert.equal(JSON.parse(stale.body).codigo, 'review-changed');
  assert.equal((await plano({ porFrase: { 1: { protegidas: [], contasConfirmadas: 2, conferida: fp2 } } })).status, 200);
  // a proteção padrão também entra na impressão: o alerta de uma carteira muda a lista conferida
  const f = S().frases[0];
  const flagged = { app: f.app, review: { ...f.review!, accounts: f.review!.accounts.map((a, i) => (i === 0 ? { ...a, warnings: ['x'] } : a)) } };
  assert.notEqual(sv.reviewFingerprint(flagged), fp2);
  assert.notEqual(sv.reviewFingerprint({ ...f, app: 'phantom' }), fp2, 'outro app com a mesma lista: outra impressão');
  // sem a impressão (cliente antigo, roteiros): segue a regra da contagem como antes
  assert.equal((await plano({ porFrase: allConfirmed(1, 2) })).status, 200);
});

test('chaves: destino igual a uma chave é recusado também na troca', async () => {
  await reset();
  chain();
  const ks = [testKey('dest-1'), testKey('dest-2')];
  const other = testKey('dest-guardado'); // carteira de uso da pessoa: vira destino na 1ª rodada
  fundKeys(ks);
  world.lamports.set(other.address, 50_000_000);
  await analyse([keysCard(ks)]);
  for (const k of ks) {
    const r = await plano({ destino: k.address, porFrase: allConfirmed(1, 2) });
    assert.equal(r.status, 400, r.body);
    assert.match(JSON.parse(r.body).erro, /uma das burners/);
  }
  assert.equal(S().frases[0].plan, null, 'nenhum plano montado');
  assert.equal((await plano({ destino: other.address, porFrase: allConfirmed(1, 2) })).status, 200);
  // troca na Confirmar para uma chave colada: recusada, e o plano de antes (outro destino) fica
  const troca = await plano({ destino: ks[1].address, porFrase: allConfirmed(1, 2) });
  assert.equal(troca.status, 400, troca.body);
  assert.match(JSON.parse(troca.body).erro, /uma das burners/);
  assert.equal(S().frases[0].plan!.destination, other.address);
  // "Limpar outras frases" com o destino guardado: a próxima rodada cola a chave dele → recusado também
  await reset();
  chain();
  const k3 = testKey('dest-3');
  fundKeys([k3, other]);
  await analyse([keysCard([k3, other])]);
  const again = await plano({ destino: other.address, porFrase: allConfirmed(1, 2) });
  assert.equal(again.status, 400, again.body);
  assert.match(JSON.parse(again.body).erro, /uma das burners/);
  assert.equal(S().frases[0].plan, null);
});

test('chaves: chave da principal de uma frase → key-is-main (na análise, na refeita do cartão e na refeita da frase)', async () => {
  await reset();
  useWallets(PHRASES[0], 'solflare', [0]);
  const [k1, k2] = [testKey('main-1'), testKey('main-2')];
  fundKeys([k1, k2]);
  const main0 = phraseKey(PHRASES[0], standardPath(0)); // Conta 1 da Phantom / principal do Solflare
  const trust1 = phraseKey(PHRASES[1], trustPath(0)); // conta 0 da Trust de uma frase que ainda não está na rodada
  await analyse([auto(PHRASES[0]), { texto: `${k1.base58}\n${main0.hex.slice(0, 64)}`, carteira: 'auto' }, keysCard([k2, trust1])]);
  const by = (n: number) => S().frases.find((f) => f.n === n)!;
  assert.equal(by(1).status, 'pronta');
  assert.deepEqual([by(2).status, by(2).error], ['erro', { code: 'key-is-main', params: { line: 2, of: 1 } }]);
  assert.deepEqual([by(2).signers.size, by(2).keys, by(2).discovery], [0, null, null], 'cartão recusado: nenhuma chave, nenhuma carteira');
  assert.equal(by(3).status, 'pronta');
  // refazer o cartão com a mesma principal: recusado com a linha
  const again = await post('/api/analisar-frase', { n: 2, texto: `${k1.base58}\n${main0.base58}`, carteira: 'auto' });
  assert.equal(again.status, 400, again.body);
  assert.deepEqual([JSON.parse(again.body).codigo, JSON.parse(again.body).params], ['key-is-main', { line: 2, of: 1 }]);
  // refazer o cartão com uma chave que já está no cartão 3: repetida entre cartões
  const dup = await post('/api/analisar-frase', { n: 2, texto: `${k1.base58}\n${k2.hex}`, carteira: 'auto' });
  assert.equal(dup.status, 400, dup.body);
  assert.deepEqual([JSON.parse(dup.body).codigo, JSON.parse(dup.body).params], ['key-duplicate', { line: 2, of: 3 }]);
  await redo(2, k1.base58, 'auto' as WalletApp);
  assert.deepEqual([by(2).status, by(2).app, [...by(2).signers.values()].map((s) => s.address)], ['pronta', 'chaves', [k1.address]]);
  // a frase 1 refeita com a frase cuja principal da Trust está no cartão 3: o cartão 3 sai da rodada com o erro
  useWallets(PHRASES[1], 'solflare', [0]);
  await redo(1, PHRASES[1], 'auto' as WalletApp);
  assert.equal(by(1).status, 'pronta');
  assert.deepEqual([by(3).status, by(3).error, by(3).signers.size], ['erro', { code: 'key-is-main', params: { line: 2, of: 1 } }, 0]);
  assert.equal(by(3).scans.length, 0);
});

test('chaves: chave que é burner de uma frase entra uma vez, pela frase', async () => {
  await reset();
  chain();
  const b = useWallets(PHRASES[0], 'solflare', [0, 1]);
  const k1 = testKey('sobrepoe-1');
  const kb = phraseKey(PHRASES[0], burnerPath(1));
  assert.equal(kb.address, b[1]);
  fundKeys([k1]);
  // o cartão de chaves vem ANTES da frase na lista: mesmo assim a frase é buscada primeiro
  await analyse([keysCard([k1, kb]), auto(PHRASES[0])]);
  const [keys, frase] = S().frases;
  assert.deepEqual([keys.app, keys.status, frase.status], ['chaves', 'pronta', 'pronta']);
  assert.deepEqual(keys.discovery!.wallets.map((w) => w.address), [k1.address]);
  assert.deepEqual([...keys.signers.keys()], [0], 'a chave da burner sai do cartão de chaves');
  assert.deepEqual(keys.scans.map((s) => s.address), [k1.address]);
  assert.deepEqual(keys.review!.accounts.map((a) => a.address), [k1.address]);
  assert.ok(frase.discovery!.wallets.some((w) => w.address === b[1]) && [...frase.signers.values()].some((s) => s.address === b[1]), 'e fica na frase');
  const v = await cardView(1);
  assert.deepEqual(v.keysOverlap, { count: 1, of: 2 });
  assert.ok(!('keys' in v));
  const r = await plano({ porFrase: allConfirmed(1, 1) });
  assert.equal(r.status, 200, r.body);
  assert.ok(!keys.plan!.steps.some((s) => s.wallet === b[1]));
  assert.equal(frase.plan!.steps.filter((s) => s.kind === 'sweep-sol' && s.wallet === b[1]).length, 1, 'varrida uma vez, pela frase');
});

test('chaves: Ler de novo e sobras sem reenviar texto', async () => {
  await reset();
  chain();
  world.applySends = true;
  const ks = [testKey('reler-1'), testKey('reler-2')];
  fundKeys(ks);
  world.tokens.set(ks[1].address, [keyCoin(ks[1].address, 'reler')]);
  world.failTokens.add(ks[1].address);
  await analyse([keysCard(ks)]);
  const f = S().frases[0];
  const wallets = () => sv.viewForTest().frases[0].wallets as Array<{ address: string; unread: string[] }>;
  assert.match(wallets().find((w) => w.address === ks[1].address)!.unread.join(), /contas de token/);
  assert.equal(f.keys, null, 'os bytes já foram apagados');
  // "Ler de novo": pela rota, sem texto nenhum
  world.failTokens.clear();
  await task('/api/reler');
  assert.deepEqual(wallets().map((w) => w.unread), [[], []]);
  assert.equal(f.holdings.length, 1, 'a moeda lida agora entra nas escolhas');
  // envio com uma carteira que falha → conferência → "Limpar o que sobrou" com as mesmas chaves
  assert.equal((await plano({ porFrase: allConfirmed(1, 2) })).status, 200);
  await task('/api/simular');
  world.badStatus.add(ks[0].address);
  try {
    await task('/api/executar', { confirmacao: typedCode() });
    await task('/api/conferir');
    assert.equal(sv.viewForTest().leftover!.wallets, 1);
    world.badStatus.clear();
    world.badSigs.clear(); // a mesma transação de antes (mesmo saldo, mesmo blockhash falso) agora passa
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
    await task('/api/sobras');
    assert.equal(f.keys, null, 'nem o texto nem os bytes');
    assert.equal(f.signers.size, 2, 'as chaves de assinatura continuam');
    assert.equal((await plano({ porFrase: allConfirmed(1, 2) })).status, 200);
    await task('/api/simular');
    await task('/api/executar', { confirmacao: typedCode() });
    assert.ok(S().execResults.length > 0 && S().execResults.every((x) => x.status === 'enviado'), S().execResults.map((x) => `${x.step.kind} ${x.status} ${x.detail ?? ''}`).join(' | '));
    assert.equal(world.lamports.get(ks[0].address) ?? 0, 0, 'a sobra chegou ao destino');
    assert.ok(!world.sigCalls.some((a) => ks.some((k) => k.address === a)), 'nunca houve busca');
  } finally {
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('chaves: sem SOL pedem depósito (único, com a chave como central) e aceitam o empréstimo de outra frase', async () => {
  sv.setExternalForTest({ ...baseExternal(), fundingSleep: () => new Promise<void>((r) => setTimeout(r, 15)) });
  try {
    await keysWithoutSol();
  } finally {
    sv.setExternalForTest(baseExternal());
  }
});
async function keysWithoutSol() {
  await reset();
  chain();
  const ks = [testKey('pobre-1'), testKey('pobre-2')];
  fundKeys(ks, 100);
  for (const k of ks) world.tokens.set(k.address, [emptyAccount(k.address)]);
  await analyse([keysCard(ks)]);
  const f = S().frases[0];
  assert.ok(f.feeWarning && f.feeWait?.waiting && f.feeNeed, 'cartão de chaves sem SOL pede o depósito');
  assert.equal(f.nothingToClean, false);
  assert.ok(ks.some((k) => k.address === f.feeNeed!.wallet), 'a carteira sugerida é uma das chaves');
  const single = sv.viewForTest().single!;
  assert.equal(single.hub, f.feeNeed!.wallet);
  assert.match(single.hubName, /^Chave [12]$/);
  assert.equal((await cardView(1)).gatherOffer, null, 'juntar fica de fora, como na Phantom (há carteiras que a pessoa pode proteger)');
  // o depósito chega: "Analisar de novo" do cartão confere o saldo sem pedir as chaves
  world.lamports.set(f.feeNeed!.wallet, 100 + Number(f.feeNeed!.sendLamports));
  const before = events.length;
  const rr = await post('/api/conferir-saldo', { n: 1 });
  assert.equal(rr.status, 200, rr.body);
  await until(() => events.slice(before).some((e) => e.type === 'fundos'), 'evento fundos');
  assert.equal(f.feeWait, null);

  // com uma frase rica na rodada: a oferta de empréstimo vai para a chave sugerida
  await reset();
  chain();
  useWallets(PHRASES[0], 'solflare', [0, 1]);
  fundKeys(ks, 100);
  for (const k of ks) world.tokens.set(k.address, [emptyAccount(k.address)]);
  await analyse([auto(PHRASES[0]), keysCard(ks)]);
  const g = S().frases[1];
  assert.ok(g.feeWait?.waiting);
  const offer = (await fr(2)).fundingOffer as { fromFrase: number; to: string; toName: string };
  assert.equal(offer.fromFrase, 1);
  assert.equal(offer.to, g.feeNeed!.wallet);
  assert.match(offer.toName, /^Chave [12]$/);
  const r = await post('/api/financiar', { frase: 2 });
  assert.equal(r.status, 200, r.body);
  assert.equal(((await fr(2)).funding as { status: string }).status, 'enviado');
  await reset(); // as esperas de depósito desta rodada param aqui
}

test('chaves: nenhuma saída contém a chave', async () => {
  await reset();
  chain();
  world.applySends = true;
  const out: string[] = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  const firstEvent = events.length;
  bodies.length = 0;
  const snapshots: string[] = [];
  const [ka, kb, kc, kd, ke] = ['saida-a', 'saida-b', 'saida-c', 'saida-d', 'saida-e'].map((t) => testKey(t));
  const bad = ke.base58.slice(0, -3); // chave cortada: erro de linha
  const pasted = [ka.base58, kb.hex, kc.json, kd.base58, ke.base58, bad];
  let open!: () => void;
  try {
    useWallets(PHRASES[0], 'solflare', [0]);
    fundKeys([ka, kb, kc, kd, ke]);
    world.tokens.set(ka.address, [keyCoin(ka.address, 'saida')]);
    world.tokens.set(kb.address, [emptyAccount(kb.address)]);
    // a frase segura a análise: o cartão de chaves fica na fila com os bytes na memória, e o estado é lido assim
    world.gate = { addrs: new Set(addressesOf(PHRASES[0], 'solflare', 10)), wait: new Promise<void>((r) => (open = r)) };
    const n0 = ends();
    const r = await post('/api/analisar', { frases: [auto(PHRASES[0]), { texto: `${ka.base58}\n${kb.hex}\n${kc.json}`, carteira: 'auto' }, { texto: `${kd.base58}\n${bad}`, carteira: 'auto' }, keysCard([ka])], rede: 'mainnet', folga: 3 });
    assert.equal(r.status, 202, r.body);
    await until(() => S().frases[0]?.status === 'busca', 'frase 1 na busca');
    assert.ok(S().frases[1].keys!.every((k) => k.secret.some((b) => b !== 0)), 'chaves na fila ainda na memória');
    snapshots.push((await getState()).body);
    open();
    await waitTask(n0);
    assert.deepEqual(S().frases.map((f) => [f.app, f.status, f.error?.code ?? null]), [['solflare', 'pronta', null], ['chaves', 'pronta', null], ['chaves', 'erro', 'key-unknown'], ['chaves', 'erro', 'key-duplicate']]);
    // refeitas com erro e com acerto
    assert.equal((await post('/api/analisar-frase', { n: 3, texto: `${kd.base58}\n${bad}`, carteira: 'auto' })).status, 400);
    assert.equal((await post('/api/analisar-frase', { n: 4, texto: kb.hex, carteira: 'auto' })).status, 400);
    await redo(3, `${kd.base58}\r\n${ke.base58}`, 'auto' as WalletApp);
    assert.equal((await post('/api/analisar-frase', { n: 4, texto: kc.json.replace(/,/g, ', '), carteira: 'auto' })).status, 400, 'repetida do cartão 2');
    assert.equal(S().frases[2].status, 'pronta');
    const coin = S().frases[1].holdings[0];
    const porFrase = { 2: { protegidas: [], contasConfirmadas: 3 }, 3: { protegidas: [], contasConfirmadas: 2 } };
    assert.equal((await plano({ decisoes: { [coin.account]: 'burn' }, queimarConfirmado: [coin.account], porFrase })).status, 200);
    await task('/api/simular');
    assert.equal(S().aborted, null, `${S().aborted} | ${S().simResults.map((x) => `${x.status} ${x.detail ?? ''}`).join(' | ')}`);
    await task('/api/executar', { confirmacao: typedCode() });
    const report = fs.readFileSync(S().reportFile!, 'utf8');
    fs.rmSync(S().reportFile!, { force: true });
    snapshots.push((await getState()).body);
    // pedido inteiro só com cartões ruins: recusado, sem eco
    assert.equal((await post('/api/analisar', { frases: [{ texto: bad, carteira: 'auto' }], rede: 'mainnet' })).status, 400);
    assert.equal((await post('/api/nova-limpeza', {})).status, 200);
    const haystacks: Array<[string, string]> = [
      ['estado', snapshots.join('\n')],
      ['eventos', events.slice(firstEvent).map((e) => `${e.type} ${e.data}`).join('\n')],
      ['respostas', bodies.join('\n')],
      ['console', out.join('\n')],
      ['relatório', report],
    ];
    assert.ok(events.slice(firstEvent).length > 10 && bodies.some((b) => /key-unknown/.test(b)) && bodies.some((b) => /key-duplicate/.test(b)), 'saídas capturadas');
    for (const [where, text] of haystacks) {
      for (const line of pasted) {
        for (let i = 0; i + 8 <= line.length; i++) {
          if (text.includes(line.slice(i, i + 8))) assert.fail(`pedaço de 8 caracteres de uma chave colada apareceu em ${where}`);
        }
      }
    }
  } finally {
    open?.();
    Object.assign(console, orig);
    if (S().reportFile) fs.rmSync(S().reportFile!, { force: true });
  }
});

test('chaves: bytes zerados no fim', async () => {
  await reset();
  const ks = [testKey('zero-1'), testKey('zero-2')];
  fundKeys(ks);
  useWallets(PHRASES[0], 'solflare', [0]);
  let open!: () => void;
  // 1) rodada que termina: os bytes somem logo depois de virarem as chaves de assinatura
  world.gate = { addrs: new Set(addressesOf(PHRASES[0], 'solflare', 10)), wait: new Promise<void>((r) => (open = r)) };
  try {
    const n0 = ends();
    assert.equal((await post('/api/analisar', { frases: [auto(PHRASES[0]), keysCard(ks)], rede: 'devnet', folga: 3 })).status, 202);
    await until(() => S().frases[0]?.status === 'busca', 'frase 1 na busca');
    const secrets = S().frases[1].keys!.map((k) => k.secret);
    assert.deepEqual(secrets.map((x) => x.length), [32, 32]);
    assert.ok(secrets.every((x) => x.some((b) => b !== 0)));
    open();
    await waitTask(n0);
    assert.equal(S().frases[1].status, 'pronta');
    assert.ok(secrets.every((x) => x.every((b) => b === 0)), 'bytes zerados ao fim da análise');
    assert.equal(S().frases[1].keys, null);
    assert.equal(S().frases[1].signers.size, 2);
    assert.equal((await post('/api/nova-limpeza', {})).status, 200);
    assert.ok(secrets.every((x) => x.every((b) => b === 0)));
  } finally {
    open();
  }
  // 2) "Encerrar" com o cartão de chaves ainda na fila: bytes zerados na hora
  world.gate = { addrs: new Set(addressesOf(PHRASES[0], 'solflare', 10)), wait: new Promise<void>((r) => (open = r)) };
  const exit = process.exit;
  let exited = 0;
  process.exit = (() => void exited++) as never;
  try {
    assert.equal((await post('/api/analisar', { frases: [auto(PHRASES[0]), keysCard(ks)], rede: 'devnet', folga: 3 })).status, 202);
    await until(() => S().frases[0]?.status === 'busca', 'frase 1 na busca');
    const card = S().frases[1];
    const secrets = card.keys!.map((k) => k.secret);
    assert.equal((await post('/api/encerrar', {})).status, 200);
    assert.ok(secrets.every((x) => x.every((b) => b === 0)), 'bytes zerados ao encerrar');
    assert.equal(card.keys, null);
    open();
    await until(() => S().busy === null, 'análise largada');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(exited, 1);
  } finally {
    open();
    process.exit = exit;
  }
});

// ---------- 1.0: caminho da Trust desligado (src/core/features.ts, congelamento de 16/11/2026) ----------

test('1.0: Trust desligada → a frase só com contas da Trust não vira cartão; Phantom + Trust fica só com a Phantom', async () => {
  FEATURES.trustPath = false;
  try {
    await reset();
    chain();
    const tr = useWallets(PHRASES[0], 'trust', [0, 1, 2]);
    const ph = useWallets(PHRASES[1], 'phantom', [0, 1]);
    const tr1 = useWallets(PHRASES[1], 'trust', [0, 3]);
    await analyse([auto(PHRASES[0]), auto(PHRASES[1])]);
    const fs_ = S().frases;
    // ligada, seriam 3 cartões (trust; phantom + irmã trust): teste "Trust vira cartão irmão"
    assert.deepEqual(fs_.map((f) => [f.n, f.app, f.status, f.pair, f.pairOf]), [
      [1, 'solflare', 'pronta', null, null],
      [2, 'phantom', 'pronta', null, null],
    ]);
    assert.ok(!fs_.some((f) => f.app === 'trust'), 'nenhum cartão da Trust');
    const seen = fs_.flatMap((f) => f.discovery?.wallets.map((w) => w.address) ?? []);
    for (const a of [...tr, ...tr1]) assert.ok(!seen.includes(a), 'nenhuma conta da Trust na busca');
    assert.ok(seen.includes(ph[1]), 'a Phantom segue igual');
  } finally {
    FEATURES.trustPath = true;
  }
});
