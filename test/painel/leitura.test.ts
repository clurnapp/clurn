// Leitura do histórico da carteira da taxa (scripts/painel-admin.ts, syncWallet) contra uma blockchain falsa local:
// retoma uma leitura pela metade (achado de 17/11/2026: com 100 das 39.932 lidas, a 2ª abertura achava que não havia
// nada novo), para no início da beta, guarda falhas com a hora e deixa na fila o que o RPC não respondeu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const WALLET = 'Carteira11111111111111111111111111111111111';
const DEST = 'Destino111111111111111111111111111111111111';
const SINCE = Date.UTC(2026, 9, 30);
const T0 = Date.UTC(2026, 10, 10) / 1000;

// assinaturas da mais nova para a mais velha; "antes" é anterior ao início da beta e nunca pode ser lida
type Sig = { signature: string; blockTime: number; err: unknown };
let sigs: Sig[] = [];
const failOnce = new Set<string>();
const txCalls: string[] = [];
function txOf(sig: string) {
  return { blockTime: T0, transaction: { message: { accountKeys: ['Temporaria1111111111111111111111111111111111', DEST, WALLET] } }, meta: { err: null, preBalances: [1_000_000_000, 0, 0], postBalances: [0, 890_000_000, 110_000_000] }, sig };
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    const reply = (x: object) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id, ...x })); };
    if (method === 'getSignaturesForAddress') {
      const before = params[1]?.before;
      const start = before ? sigs.findIndex((s) => s.signature === before) + 1 : 0;
      return reply({ result: sigs.slice(start, start + (params[1]?.limit ?? 1000)) });
    }
    if (method === 'getTransaction') {
      txCalls.push(params[0]);
      if (failOnce.delete(params[0])) return reply({ error: { code: -32000, message: 'instável' } });
      return reply({ result: txOf(params[0]) });
    }
    reply({ error: { code: -32601, message: 'método' } });
  });
});

test('leitura: retoma pela metade, para no início da beta, guarda falhas e o que o RPC não respondeu', async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-admin-'));
  process.env.SOLANA_RPC_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  process.env.CLURN_ADMIN_DIR = dir;
  try {
    const { syncWallet, readCache } = await import('../../scripts/painel-admin.ts');
    const s = (name: string, dt: number, err: unknown = null): Sig => ({ signature: name, blockTime: T0 + dt, err });
    sigs = [s('s1', 50), s('s2', 40), s('erro', 35, { InstructionError: [0, 'x'] }), s('s3', 30), s('s4', 20), s('antes', (SINCE / 1000) - T0 - 60)];
    // cache como o da leitura interrompida: só a mais nova lida, sem "completo" (formato de antes da fila)
    fs.writeFileSync(path.join(dir, `taxa-${WALLET.slice(0, 8)}.json`), JSON.stringify({ wallet: WALLET, txs: [{ sig: 's1', t: (T0 + 50) * 1000, fee: 110_000_000, dest: 'h' }], skipped: [], since: SINCE }));
    failOnce.add('s3');
    const quiet = () => {};
    const c1 = await syncWallet(WALLET, SINCE, quiet, 'teste');
    assert.deepEqual(c1.txs.map((x) => x.sig).sort(), ['s1', 's2', 's4'], 'leu o que faltava depois da que já estava salva');
    assert.ok(!txCalls.includes('antes'), 'nada antes do início da beta é baixado');
    assert.ok(!txCalls.includes('s1'), 'a já lida não é baixada de novo');
    assert.deepEqual(c1.failed.map((f) => f.sig), ['erro'], 'transação com erro guardada com a hora');
    assert.equal(c1.failed[0]!.t, (T0 + 35) * 1000);
    assert.deepEqual(readCache(WALLET).pending, ['s3'], 'a que o RPC não respondeu fica na fila salva');
    assert.equal(readCache(WALLET).completo, true);
    // atividade: toda assinatura desde o início da beta, inclusive a que já estava lida (s1) e a com erro
    assert.deepEqual(readCache(WALLET).seen.map(([t, ok]) => [t / 1000 - T0, ok]), [[50, 1], [40, 1], [35, 0], [30, 1], [20, 1]]);
    assert.equal(readCache(WALLET).seenFull, true);
    // 2ª abertura: uma nova no topo; lê a nova e a da fila, e para na 1ª já conhecida (não relista tudo)
    sigs = [s('s0', 60), ...sigs];
    txCalls.length = 0;
    const c2 = await syncWallet(WALLET, SINCE, quiet, 'teste');
    assert.deepEqual(txCalls.sort(), ['s0', 's3']);
    assert.deepEqual(c2.txs.map((x) => x.sig).sort(), ['s0', 's1', 's2', 's3', 's4']);
    assert.deepEqual(readCache(WALLET).pending, []);
    assert.equal(readCache(WALLET).seen.length, 6, 'a nova entra na atividade sem duplicar as antigas');
    // lista de atividade interrompida no meio (seenFull falso): a próxima refaz do zero, sem contar em dobro
    const file = path.join(dir, `taxa-${WALLET.slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), seenFull: false }));
    await syncWallet(WALLET, SINCE, quiet, 'teste');
    assert.equal(readCache(WALLET).seen.length, 6);
    assert.equal(readCache(WALLET).seenFull, true);
    // destino guardado só como hash, nunca o endereço
    assert.ok(!fs.readFileSync(path.join(dir, `taxa-${WALLET.slice(0, 8)}.json`), 'utf8').includes(DEST));
  } finally {
    server.close();
    delete process.env.SOLANA_RPC_URL;
    delete process.env.CLURN_ADMIN_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
