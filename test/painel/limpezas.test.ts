// Correções do painel de 18/11/2026, medidas na carteira antiga da taxa: 10.296 transações pagas eram 51 limpezas
// (mediana de 56 transações por limpeza), poeira de 1 lamport virava cliente, e o "hoje" virava às 21h de Brasília.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DUST_LAMPORTS, LAMPORTS, SESSION_GAP, feeDaily, feeSummary, periodSummary, recentCleanups, records, sessionsOf, utcDay, type FeeTx } from '../../scripts/painel/metricas.ts';
import { MIN_DEST_RATIO, parseFeeTx, shortHash } from '../../scripts/painel/ler-tx.ts';

const L = LAMPORTS;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 18, 15); // 18/11, 12h em Brasília

test('limpeza = transações seguidas do mesmo destino (intervalo até 30 min); outro destino no meio não corta', () => {
  const t0 = NOW - 5 * 3_600_000;
  const txs: FeeTx[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ sig: `a${i}`, t: t0 + i * MIN, fee: 0.001 * L, dest: 'A' })), // 40 tx em 40 min
    { sig: 'b0', t: t0 + 10 * MIN, fee: 0.002 * L, dest: 'B' }, // outro cliente no meio
    { sig: 'a-volta', t: t0 + 39 * MIN + SESSION_GAP + 1, fee: 0.005 * L, dest: 'A' }, // A volta depois de 30 min: 2ª limpeza
  ];
  const s = sessionsOf(txs.filter((x): x is FeeTx & { dest: string } => !!x.dest));
  assert.deepEqual(s.map((x) => [x.dest, x.n]), [['A', 40], ['B', 1], ['A', 1]]);
  const p = periodSummary(txs, NOW, 7);
  assert.equal(p.limpezas, 3, 'não 42');
  assert.equal(p.transacoes, 42);
  assert.ok(Math.abs(p.ticket - p.receita / 3) < 1e-12, 'taxa média por limpeza');
  assert.ok(Math.abs(p.maiorLimpeza - 0.04 / 0.11) < 1e-9, 'a maior limpeza soma as 40 transações');
  assert.equal(p.tamanhos.reduce((a, x) => a + x.limpezas, 0), 3);
  assert.equal(feeSummary(txs, NOW).limpezasTotal, 3);
  assert.equal(feeDaily(txs, NOW).at(-1)!.limpezas, 3);
  assert.equal(feeDaily(txs, NOW).at(-1)!.transacoes, 42);
  assert.equal(records(txs, NOW).limpezasTotal, 3);
  const r = recentCleanups(txs);
  assert.deepEqual(r.map((x) => [x.sig, x.transacoes, x.novo]), [['a-volta', 1, false], ['a39', 40, true], ['b0', 1, true]]);
});

test('poeira (abaixo de 1.000 lamports) não é receita, limpeza nem cliente', () => {
  const txs: FeeTx[] = [
    { sig: 'real', t: NOW - MIN, fee: 2_327, dest: 'R' }, // a menor fatia real medida
    { sig: 'poeira', t: NOW - MIN, fee: 1, dest: 'P' },
    { sig: 'limite', t: NOW - MIN, fee: DUST_LAMPORTS - 1, dest: 'Q' },
  ];
  const f = feeSummary(txs, NOW);
  assert.equal(f.clientesTotal, 1);
  assert.equal(f.limpezasTotal, 1);
  assert.equal(f.receitaTotal, 2_327 / L);
  assert.equal(periodSummary(txs, NOW, null).clientes, 1);
});

test('dias no horário de Brasília: 23h de 17/11 (02h UTC de 18/11) conta em 17/11', () => {
  const late = Date.UTC(2026, 10, 18, 2); // 17/11 23h em Brasília
  assert.equal(utcDay(late), '2026-11-17');
  assert.equal(utcDay(Date.UTC(2026, 10, 18, 3)), '2026-11-18', 'meia-noite de Brasília');
  const d = feeDaily([{ sig: 'x', t: late, fee: 0.01 * L, dest: 'X' }], NOW);
  assert.equal(d.find((p) => p.dia === '2026-11-17')!.limpezas, 1);
  assert.equal(d.at(-1)!.dia, '2026-11-18');
  assert.equal(d.at(-1)!.limpezas, 0);
});

// transação no formato do getTransaction: contas e saldos antes/depois
const FEE = 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL';
const tx = (keys: string[], pre: number[], post: number[]) => ({ blockTime: NOW / 1000, transaction: { message: { accountKeys: keys } }, meta: { err: null, preBalances: pre, postBalances: post } });

test('leitura: limpeza paga tem destino; poeira de envenenamento e depósito com troco não', () => {
  // limpeza: a temporária manda 1 SOL, 89% ao destino e 11% à taxa
  const paga = parseFeeTx('s1', tx(['Temp', 'Destino', FEE], [1e9, 0, 0], [0, 0.89e9, 0.11e9]), FEE);
  assert.equal(paga?.dest, shortHash('Destino'));
  // depósito do cliente devolvido junto (isento): o destino recebe mais que 8,09× — continua limpeza
  const comDeposito = parseFeeTx('s2', tx(['Temp', 'Destino', FEE], [2e9, 0, 0], [0, 1.89e9, 0.11e9]), FEE);
  assert.equal(comDeposito?.dest, shortHash('Destino'));
  // envenenamento: 1 lamport para a taxa e 1 para outra conta
  const poeira = parseFeeTx('s3', tx(['Golpista', 'Vitima', FEE], [1e6, 0, 0], [999_998, 1, 1]), FEE);
  assert.equal(poeira?.dest, null);
  assert.equal(poeira?.fee, 1);
  // depósito na carteira da taxa com troco para quem mandou: não é limpeza
  const troco = parseFeeTx('s4', tx(['Quem', 'Troco', FEE], [1e9, 0, 0], [0, 0.1e9, 0.9e9]), FEE);
  assert.equal(troco?.dest, null);
  // no limite
  assert.equal(parseFeeTx('s5', tx(['T', 'D', FEE], [8e6, 0, 0], [0, MIN_DEST_RATIO * 1e6, 1e6]), FEE)?.dest, shortHash('D'));
  assert.equal(parseFeeTx('s6', tx(['T', 'D', FEE], [8e6, 0, 0], [0, MIN_DEST_RATIO * 1e6 - 1, 1e6]), FEE)?.dest, null);
});

test('funil: aberturas = downloads do clurn-versao.json (o app confere a versão ao abrir); proxy em pessoas-dia no período', async () => {
  const { releaseSummary, funnel, parseProxyStats } = await import('../../scripts/painel/metricas.ts');
  const rel = releaseSummary([
    { tag_name: 'v1.0.2', published_at: '2026-11-18T15:20:24Z', assets: [{ name: 'Clurn-Setup-1.0.2.exe', download_count: 4 }, { name: 'clurn-versao.json', download_count: 5 }] },
    { tag_name: 'v1.0.1', published_at: '2026-11-17T00:00:00Z', assets: [{ name: 'Clurn-Setup-1.0.1.exe', download_count: 9 }, { name: 'clurn-versao.json', download_count: 'x' }] },
  ]);
  assert.equal(rel.total, 13);
  assert.equal(rel.aberturas, 5, 'contagem fora do formato é pulada');
  const day = (dia: string, ips: number, analisaram: number, executaram: number, verificacoes = 0) => ({ dia, pedidos: 1, creditos: 1, ips, analisaram, executaram, verificacoes, metodos: {}, versoes: {}, recusas: {}, eventos: {} });
  const p = parseProxyStats({ hoje: day('2026-11-18', 3, 2, 1, 9), historico: [day('2026-11-17', 4, 1, 0, 'x' as any), day('2026-11-01', 50, 40, 30, 100)], chaves: [], limites: {} })!;
  const f7 = funnel(p, rel, 1, NOW, 7);
  assert.deepEqual([f7.baixaram, f7.abriram, f7.noApp, f7.analisaram, f7.executaram, f7.pagaram, f7.diasProxy], [13, 5, 7, 3, 1, 1, 2]);
  assert.equal(funnel(p, rel, 1, NOW, null).noApp, 57, '"tudo" soma todos os dias');
  assert.equal(f7.verificaram, 9, 'verificações do site no período; valor fora do formato conta zero');
  assert.equal(funnel(p, rel, 1, NOW, null).verificaram, 109);
  const sem = funnel(null, null, null, NOW, 7);
  assert.deepEqual([sem.baixaram, sem.noApp, sem.pagaram], [null, null, null], 'sem fonte: vazio, nunca zero');
});
