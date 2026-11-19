import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey, Cotas, Counter, FLUSH_MS, type ConsumeRequest } from '../../proxy/cotas.ts';
import { memStorage } from './helpers.ts';

const NOON = Date.UTC(2026, 10, 9, 12, 0, 0);
const req = (over: Partial<ConsumeRequest> = {}): ConsumeRequest => ({ key: '203.0.113.7', requests: 1, credits: 1, now: NOON, perSecond: 100, perIpDay: 100, globalHour: 10_000, globalDay: 1000, ...over });
const consume = async (c: Cotas, r: ConsumeRequest) => (await c.fetch(new Request('https://cotas/consumir', { method: 'POST', body: JSON.stringify(r) }))).json();

test('cotas: chave do cliente — IPv4 como veio, IPv6 pelo /48, IPv4 escrito como IPv6, sem IP ou lixo → "sem-ip"', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  const k = clientKey('2001:db8:1:2:3:4:5:6');
  assert.equal(k, '2001:db8:1::/48');
  assert.equal(clientKey('2001:0db8:0001:0002::9'), k);
  assert.equal(clientKey('2001:DB8:1:ffff::'), k, 'outro /64 do mesmo /48: mesma cota');
  assert.equal(clientKey('2001:db8:1::'), k);
  assert.equal(clientKey('2001:db8:2:2::1'), '2001:db8:2::/48', 'outro /48');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0::/48');
  assert.equal(clientKey('::1'), '0:0:0::/48');
  for (const bad of [null, undefined, '', 'localhost', '1.2.3', '<script>', 'x'.repeat(100)]) assert.equal(clientKey(bad), 'sem-ip', String(bad));
});

test('cotas: ordem das recusas (segundo → dia do IP → teto) e recusa não conta', () => {
  const c = new Counter();
  assert.deepEqual(c.consume(req({ requests: 3, perSecond: 3 })), { ok: true });
  assert.deepEqual(c.consume(req({ perSecond: 3 })), { ok: false, reason: 'segundo' });
  assert.deepEqual(c.consume(req({ now: NOON + 1000, credits: 100 })), { ok: false, reason: 'dia-ip' }, '1 + 100 > 100');
  assert.deepEqual(c.consume(req({ now: NOON + 1000, key: 'outro', credits: 1000, perIpDay: 5000 })), { ok: false, reason: 'teto' }, '1 + 1000 > 1000');
  assert.equal(c.total, 1, 'as recusas não somaram');
  assert.equal(c.perIp.get('outro'), undefined);
  assert.equal(c.consume(req({ now: NOON + 1000, requests: 3, perSecond: 3 })).ok, true, 'segundo seguinte: janela nova');
});

test('cotas: teto por hora (UTC) recusa antes do teto do dia acabar e zera na hora seguinte', () => {
  const c = new Counter();
  const lim = { perIpDay: 10_000, globalHour: 100, globalDay: 1000 };
  assert.equal(c.consume(req({ ...lim, key: 'a', credits: 60 })).ok, true);
  assert.equal(c.consume(req({ ...lim, key: 'b', credits: 40 })).ok, true, 'exatamente no limite da hora passa');
  assert.deepEqual(c.consume(req({ ...lim, key: 'c', credits: 1 })), { ok: false, reason: 'teto-hora' }, 'outro IP também: o teto é global');
  assert.equal(c.total, 100, 'a recusa não somou');
  const next = NOON + 3_600_000;
  assert.equal(c.consume(req({ ...lim, key: 'c', credits: 100, now: next })).ok, true, 'hora nova');
  assert.equal(c.hourTotal, 100);
  assert.equal(c.total, 200, 'o dia continua somando');
  assert.deepEqual(c.consume(req({ ...lim, key: 'c', credits: 1, now: next + 1000, globalDay: 200 })), { ok: false, reason: 'teto' }, 'dia acabado diz "teto", não "teto-hora"');
});

test('cotas: soma créditos por IP e no total; dia novo (UTC) zera', () => {
  const c = new Counter();
  assert.equal(c.consume(req({ credits: 60 })).ok, true);
  assert.deepEqual(c.consume(req({ credits: 41 })), { ok: false, reason: 'dia-ip' });
  assert.equal(c.consume(req({ credits: 40 })).ok, true, 'exatamente no limite passa');
  assert.equal(c.perIp.get('203.0.113.7'), 100);
  assert.equal(c.consume(req({ key: 'b', credits: 900, perIpDay: 1000 })).ok, true);
  assert.deepEqual(c.consume(req({ key: 'c', credits: 1 })), { ok: false, reason: 'teto' }, '100 + 900 = 1000');
  const midnight = Date.UTC(2026, 10, 10, 0, 0, 0);
  assert.equal(c.consume(req({ key: 'c', credits: 1, now: midnight })).ok, true);
  assert.equal(c.total, 1);
  assert.equal(c.perIp.get('203.0.113.7'), undefined);
});

test('cotas: os contadores vão para o armazenamento no alarme e voltam depois de o objeto reiniciar', async () => {
  const mem = memStorage();
  const a = new Cotas({ storage: mem.storage });
  assert.deepEqual(await consume(a, req({ credits: 70 })), { ok: true });
  assert.deepEqual(await consume(a, req({ key: 'b', credits: 5 })), { ok: true });
  assert.deepEqual(mem.alarms, [NOON + FLUSH_MS], 'um alarme só até ele rodar');
  assert.equal(mem.data.size, 0, 'nada gravado antes do alarme');
  await a.alarm();
  assert.equal(mem.data.get('dia'), '2026-11-09');
  assert.equal(mem.data.get('total'), 75);
  assert.equal(mem.data.get('ip:203.0.113.7'), 70);
  assert.equal(mem.data.get('hora'), Math.floor(NOON / 3_600_000));
  assert.equal(mem.data.get('total-hora'), 75);
  // reiniciou: as cotas do dia e da hora continuam
  const b = new Cotas({ storage: mem.storage });
  assert.deepEqual(await consume(b, req({ key: 'z', credits: 26, perIpDay: 1000, globalHour: 100 })), { ok: false, reason: 'teto-hora' }, '75 + 26 > 100');
  assert.deepEqual(await consume(b, req({ credits: 31 })), { ok: false, reason: 'dia-ip' });
  assert.deepEqual(await consume(b, req({ credits: 30 })), { ok: true });
  assert.equal(mem.alarms.length, 2);
  await b.alarm();
  assert.equal(mem.data.get('ip:203.0.113.7'), 100);
  assert.equal(mem.data.get('ip:b'), 5, 'o que não mudou continua lá');
});

test('cotas: dia novo apaga o anterior do armazenamento; dado gravado fora do formato é ignorado sem derrubar o resto', async () => {
  const mem = memStorage();
  mem.data.set('dia', '2026-11-09');
  mem.data.set('total', 'muito');
  mem.data.set('ip:a', -3);
  mem.data.set('ip:b', 40);
  mem.data.set('ip:c', null);
  mem.data.set('hora', Math.floor(NOON / 3_600_000)); // a hora certa, com o total ilegível
  mem.data.set('total-hora', 'muito');
  const c = new Cotas({ storage: mem.storage });
  assert.deepEqual(await consume(c, req({ key: 'b', credits: 61 })), { ok: false, reason: 'dia-ip' }, 'b tinha 40');
  assert.deepEqual(await consume(c, req({ key: 'a', credits: 100, globalHour: 100 })), { ok: true }, 'contador negativo não vale; hora ilegível recomeça do zero');
  await c.alarm();
  assert.equal(mem.data.get('total'), 100, 'total ilegível recomeça do zero');
  assert.equal(mem.data.get('ip:a'), 100, 'o -3 gravado não entrou na conta');
  assert.equal(mem.data.get('total-hora'), 100, 'total da hora ilegível recomeça do zero');
  const next = Date.UTC(2026, 10, 10, 1, 0, 0);
  assert.deepEqual(await consume(c, req({ key: 'b', credits: 1, now: next })), { ok: true });
  await c.alarm();
  assert.equal(mem.deletes(), 1);
  const { stats, 'hist:2026-11-09': hist, ...rest } = Object.fromEntries(mem.data) as Record<string, any>;
  assert.deepEqual(rest, { dia: '2026-11-10', total: 1, hora: Math.floor(next / 3_600_000), 'total-hora': 1, 'ip:b': 1 }, 'os IPs do dia anterior sumiram');
  // as estatísticas sobrevivem ao apagão do dia: o dia que fechou vira histórico (só números, nenhum IP)
  assert.equal(hist.dia, '2026-11-09');
  assert.equal(hist.ips, 2);
  assert.equal(hist.creditos, 100);
  assert.equal(hist.recusas['dia-ip'], 1);
  assert.equal(stats.dia, '2026-11-10');
  assert.ok(!JSON.stringify([stats, hist]).includes('ip:'), 'nenhuma chave de IP nas estatísticas');
});

test('cotas: muitos IPs num alarme são gravados em partes de até 128 chaves', async () => {
  const mem = memStorage();
  const c = new Cotas({ storage: mem.storage });
  for (let i = 0; i < 300; i++) await consume(c, req({ key: `10.0.${i >> 8}.${i & 255}` }));
  await c.alarm();
  assert.equal(mem.data.get('total'), 300);
  assert.equal([...mem.data.keys()].filter((k) => k.startsWith('ip:')).length, 300);
});

test('cotas: pedido fora do formato → 400, sem contar', async () => {
  const mem = memStorage();
  const c = new Cotas({ storage: mem.storage });
  for (const body of ['{', '{}', JSON.stringify({ ...req(), credits: -1 }), JSON.stringify({ ...req(), key: 'x'.repeat(65) }), JSON.stringify({ ...req(), now: 'agora' })]) {
    assert.equal((await c.fetch(new Request('https://cotas/consumir', { method: 'POST', body }))).status, 400, body);
  }
  assert.equal(c.counter.total, 0);
});
