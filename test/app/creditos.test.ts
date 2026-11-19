import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendHistory, createUsageMeter, fetchHeliusBalance, HELIUS_ADMIN, heliusTarget, HISTORY_MAX, historySummary, readHistory, usageDelta, type HistoryEntry,
} from '../../src/app/creditos.ts';
import type { RpcClient } from '../../src/core/solana/rpc.ts';

const echo: RpcClient = { call: async <T>(m: string) => m as T };
const PROJECT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
const KEY = 'CHAVE-DE-TESTE-123';
const HELIUS = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

test('créditos: o medidor soma por método (getProgramAccounts vale 10) e por etapa da hora da consulta', async () => {
  const m = createUsageMeter();
  let stage = 'analise';
  const c = m.wrap(echo, () => stage);
  assert.equal(await c.call('getBalance', []), 'getBalance', 'a consulta passa adiante sem mudar nada');
  await c.call('getProgramAccounts', []);
  stage = 'execucao';
  await c.call('sendTransaction', []);
  m.retry('execucao'); // nova tentativa: mais uma requisição cobrada
  assert.deepEqual(m.snapshot(), { requests: 4, credits: 13, byStage: { analise: 11, execucao: 2 } });
  const before = m.snapshot();
  await c.call('getBalance', []);
  assert.deepEqual(usageDelta(m.snapshot(), before), { requests: 1, credits: 1, byStage: { execucao: 1 } });
  before.byStage.analise = 999; // a leitura é cópia: mexer nela não muda o medidor
  assert.equal(m.snapshot().byStage.analise, 11);
});

test('créditos: consulta que falha também conta (o Helius cobra a requisição) e o erro passa adiante', async () => {
  const m = createUsageMeter();
  const c = m.wrap({ call: () => Promise.reject(new Error('caiu')) }, () => 'analise');
  await assert.rejects(c.call('getBalance', []), /caiu/);
  assert.equal(m.snapshot().credits, 1);
});

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-hist-'));
  return { file: path.join(dir, 'sub', 'creditos.json'), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const entry = (quando: string, creditos: number): HistoryEntry => ({ quando, etapa: 'analise', creditos, consultas: creditos, rpc: 'mainnet.helius-rpc.com' });

test('histórico: arquivo ausente ou quebrado vira lista vazia; item fora do formato sai sozinho', () => {
  const t = tmpFile();
  try {
    assert.deepEqual(readHistory(t.file), []);
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    for (const bad of ['{', '{}', 'null', '"x"']) {
      fs.writeFileSync(t.file, bad);
      assert.deepEqual(readHistory(t.file), [], bad);
    }
    const good = entry('2026-10-31T12:00:00.000Z', 5);
    fs.writeFileSync(t.file, JSON.stringify([good, null, { ...good, creditos: 'muitos' }, { ...good, creditos: -1 }, { ...good, quando: 'ontem' }, { ...good, consultas: null }, good]));
    assert.deepEqual(readHistory(t.file), [good, good], 'repetido é mantido (são duas gravações); só o fora do formato sai');
  } finally {
    t.done();
  }
});

test('histórico: gravar cria a pasta, acrescenta no fim, não deixa temporário e guarda no máximo HISTORY_MAX', () => {
  const t = tmpFile();
  try {
    assert.equal(appendHistory(t.file, entry('2026-10-31T12:00:00.000Z', 1)), true);
    assert.equal(appendHistory(t.file, entry('2026-10-31T13:00:00.000Z', 2)), true);
    assert.deepEqual(readHistory(t.file).map((e) => e.creditos), [1, 2]);
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['creditos.json'], 'sem .tmp sobrando');
    fs.writeFileSync(t.file, JSON.stringify(Array.from({ length: HISTORY_MAX }, (_, i) => entry('2026-10-01T00:00:00.000Z', i))));
    appendHistory(t.file, entry('2026-10-31T14:00:00.000Z', 7));
    const list = readHistory(t.file);
    assert.equal(list.length, HISTORY_MAX);
    assert.equal(list[0]!.creditos, 1, 'o mais antigo saiu');
    assert.equal(list.at(-1)!.creditos, 7);
  } finally {
    t.done();
  }
});

test('histórico: falha ao gravar (pasta é um arquivo) devolve false, sem lançar', () => {
  const t = tmpFile();
  try {
    fs.writeFileSync(path.dirname(path.dirname(t.file)) + '/sub', 'não sou pasta');
    assert.equal(appendHistory(t.file, entry('2026-10-31T12:00:00.000Z', 1)), false);
  } finally {
    t.done();
  }
});

test('histórico: resumo do mês corrente (horário local) e total', () => {
  const now = new Date(2026, 9, 31, 15, 0, 0); // 31/10/2026, horário local
  const list = [entry(new Date(2026, 9, 1, 0, 30).toISOString(), 10), entry(new Date(2026, 9, 31, 14).toISOString(), 5), entry(new Date(2026, 8, 30, 23, 59).toISOString(), 100)];
  assert.deepEqual(historySummary(list, now), { mes: '2026-10', creditosMes: 15, consultasMes: 15, creditosTotal: 115 });
  assert.deepEqual(historySummary([], now), { mes: '2026-10', creditosMes: 0, consultasMes: 0, creditosTotal: 0 });
});

test('saldo: só RPC do Helius com chave na URL e id de projeto UUID', () => {
  assert.deepEqual(heliusTarget(HELIUS, ` ${PROJECT} `), { key: KEY, project: PROJECT });
  assert.deepEqual(heliusTarget('https://devnet.helius-rpc.com/?api-key=K', PROJECT), { key: 'K', project: PROJECT });
  for (const [url, project] of [
    [HELIUS, null], [HELIUS, 'meu-projeto'], [null, PROJECT], ['https://api.mainnet-beta.solana.com', PROJECT],
    ['https://mainnet.helius-rpc.com/', PROJECT], ['http://mainnet.helius-rpc.com/?api-key=K', PROJECT],
    ['https://helius-rpc.com.golpe.io/?api-key=K', PROJECT], ['não é url', PROJECT],
  ] as const) assert.equal(heliusTarget(url, project), null, `${url} ${project}`);
});

const reply = (status: number, body: unknown) => (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as typeof fetch;
const USAGE = {
  creditsRemaining: 986100, creditsUsed: 13900, prepaidCreditsRemaining: 0, prepaidCreditsUsed: 0,
  creditCycle: { start: '2026-10-01', end: '2026-11-01' },
  subscriptionDetails: { billingCycle: null, creditsLimit: 1000000, plan: 'free' },
};

test('saldo: lê o que resta, o limite, o usado e quando renova; a chave vai só no cabeçalho', async () => {
  const seen: Array<{ url: string; headers: unknown }> = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify(USAGE), { status: 200 });
  }) as unknown as typeof fetch;
  const r = await fetchHeliusBalance({ key: KEY, project: PROJECT }, f);
  assert.deepEqual(r, { status: 'ok', restantes: 986100, limite: 1000000, usados: 13900, renovaEm: '2026-11-01', plano: 'free' });
  assert.equal(seen[0]!.url, `${HELIUS_ADMIN}/${PROJECT}/usage`);
  assert.ok(!seen[0]!.url.includes(KEY), 'a chave não vai na URL');
  assert.deepEqual(seen[0]!.headers, { 'X-Api-Key': KEY });
});

test('saldo: recusa, falha e dado fora do formato viram motivo curto, sem a chave e sem lançar', async () => {
  const t = { key: KEY, project: PROJECT };
  assert.deepEqual(await fetchHeliusBalance(null, reply(200, USAGE)), { status: 'sem-projeto' });
  assert.deepEqual(await fetchHeliusBalance(t, reply(403, { error: 'Admin API not enabled for this project' })), { status: 'erro', motivo: 'admin-desligada' });
  for (const s of [400, 401, 404]) assert.deepEqual(await fetchHeliusBalance(t, reply(s, {})), { status: 'erro', motivo: 'chave-ou-projeto' }, String(s));
  for (const f of [reply(500, {}), reply(429, {}), reply(200, '{quebrado'), reply(200, { creditsRemaining: 'muitos' }), reply(200, { creditsRemaining: -5 }), reply(200, null),
    (async () => { throw new Error(`falhou ${KEY}`); }) as typeof fetch])
    assert.deepEqual(await fetchHeliusBalance(t, f), { status: 'erro', motivo: 'indisponivel' });
  // campos opcionais estranhos não derrubam o que veio certo
  const r = await fetchHeliusBalance(t, reply(200, { creditsRemaining: 5, creditCycle: { end: 'amanhã' }, subscriptionDetails: { creditsLimit: '1M', plan: 42 } }));
  assert.deepEqual(r, { status: 'ok', restantes: 5, limite: null, usados: null, renovaEm: null, plano: null });
});

test('saldo: Helius que não responde falha no prazo', { timeout: 10_000 }, async () => {
  const hang = ((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('abortado'))))) as unknown as typeof fetch;
  assert.deepEqual(await fetchHeliusBalance({ key: KEY, project: PROJECT }, hang, 50), { status: 'erro', motivo: 'indisponivel' });
});
