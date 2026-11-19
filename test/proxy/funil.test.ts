// Funil do painel (18/11/2026): quantos IPs distintos do dia abriram o app, analisaram uma frase e executaram uma
// limpeza, contados pelos métodos que já passam pelo proxy. Só o número sai; o IP nunca.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cotas, Counter, STAGE_SCAN, STAGE_SEND, parseStats, stageOf, type ConsumeRequest } from '../../proxy/cotas.ts';
import { call, json, makeWorld, rpcRequest } from './helpers.ts';

const TOKEN = 'tk_' + 'f9e8d7c6'.repeat(5);
const statsReq = () => new Request('https://rpc.clurn.app/stats', { headers: { authorization: `Bearer ${TOKEN}` } });
const NOON = Date.UTC(2026, 10, 9, 12, 0, 0);
const req = (over: Partial<ConsumeRequest> = {}): ConsumeRequest => ({ key: 'k', requests: 1, credits: 1, now: NOON, perSecond: 1e9, perIpDay: 1e9, globalHour: 1e12, globalDay: 1e12, ...over });

test('funil: a etapa vem do método (varredura = contas de token; execução = sendTransaction)', () => {
  assert.equal(stageOf(undefined), 0);
  assert.equal(stageOf({ getGenesisHash: 1, getLatestBlockhash: 2, getMultipleAccounts: 5 }), 0, 'abrir o app não é analisar');
  assert.equal(stageOf({ getTokenAccountsByOwner: 3 }), STAGE_SCAN);
  assert.equal(stageOf({ getProgramAccounts: 1 }), STAGE_SCAN);
  assert.equal(stageOf({ sendTransaction: 1 }), STAGE_SEND);
  assert.equal(stageOf({ getTokenAccountsByOwner: 1, sendTransaction: 1 }), STAGE_SCAN | STAGE_SEND);
  assert.equal(stageOf({ sendTransaction: 0, getTokenAccountsByOwner: -1 }), 0, 'contagem zero ou negativa não conta');
});

test('funil: cada IP conta uma vez por etapa no dia, e executar sem analisar antes também conta', async () => {
  const w = makeWorld({ STATS_TOKEN: TOKEN });
  const [a, b, c, d] = ['203.0.113.1', '203.0.113.2', '203.0.113.3', '203.0.113.4'];
  await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': a })); // só abriu
  w.advance(1000);
  await w.send(rpcRequest(call('getTokenAccountsByOwner'), { 'cf-connecting-ip': b })); // analisou
  w.advance(1000);
  await w.send(rpcRequest(call('getTokenAccountsByOwner'), { 'cf-connecting-ip': b })); // de novo: não soma
  await w.send(rpcRequest([call('getTokenAccountsByOwner'), call('sendTransaction', ['tx'])], { 'cf-connecting-ip': c })); // analisou e executou
  await w.send(rpcRequest(call('sendTransaction', ['tx']), { 'cf-connecting-ip': d })); // executou (analisou pelo RPC público, por ex.)
  const h = (await json(await w.send(statsReq()))).body.hoje;
  assert.equal(h.ips, 4);
  assert.equal(h.analisaram, 2);
  assert.equal(h.executaram, 2);
});

test('funil: sobrevive ao objeto reiniciar e fecha o dia com os números daquele dia; o IP não fica gravado no dia seguinte', async () => {
  const w = makeWorld({ STATS_TOKEN: TOKEN });
  await w.send(rpcRequest(call('getTokenAccountsByOwner'), { 'cf-connecting-ip': '198.51.100.7' }));
  await w.send(rpcRequest(call('sendTransaction', ['tx']), { 'cf-connecting-ip': '198.51.100.8' }));
  await w.cotas.alarm();
  const again = new Cotas({ storage: w.mem.storage });
  w.env.COTAS = { idFromName: (n: string) => n, get: () => ({ fetch: async (i: Request | string, init?: RequestInit) => again.fetch(new Request(i, init)) }) };
  // reiniciado no mesmo dia: o mesmo IP analisando de novo não soma
  await w.send(rpcRequest(call('getTokenAccountsByOwner'), { 'cf-connecting-ip': '198.51.100.7' }));
  let h = (await json(await w.send(statsReq()))).body.hoje;
  assert.equal(h.analisaram, 1, 'restaurado do armazenamento');
  assert.equal(h.executaram, 1);
  w.advance(24 * 3_600_000);
  await w.send(rpcRequest(call('getGenesisHash'), { 'cf-connecting-ip': '198.51.100.9' }));
  await again.alarm();
  const body = (await json(await w.send(statsReq()))).body;
  h = body.hoje;
  assert.deepEqual([h.ips, h.analisaram, h.executaram], [1, 0, 0], 'dia novo começa vazio');
  assert.deepEqual([body.historico[0].ips, body.historico[0].analisaram, body.historico[0].executaram], [2, 1, 1]);
  assert.ok(![...w.mem.data.keys()].some((k) => k.includes('198.51.100.7') || k.includes('198.51.100.8')), 'IPs do dia anterior saíram');
});

test('funil: dia gravado antes do funil (sem os campos) lê como zero; valor fora do formato é ignorado', () => {
  const old = parseStats({ dia: '2026-11-08', pedidos: 5, ips: 2 });
  assert.equal(old?.analisaram, 0);
  assert.equal(old?.executaram, 0);
  const bad = parseStats({ dia: '2026-11-08', analisaram: 'muitos', executaram: -3 });
  assert.equal(bad?.analisaram, 0);
  assert.equal(bad?.executaram, 0);
  const c = new Counter();
  c.consume(req({ key: 'x', methods: { getProgramAccounts: 1 } }));
  c.consume(req({ key: 'y', methods: { getLatestBlockhash: 1 } }));
  const dirty = c.takeDirty();
  assert.equal(dirty['st:x'], STAGE_SCAN, 'grava a etapa do IP');
  assert.ok(!('st:y' in dirty), 'IP sem etapa não grava nada além da cota');
});
