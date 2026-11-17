import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBranches, detectWallet } from '../../src/core/carteiras/detect.ts';

// lista como a da busca: do índice 0 até a última usada (as do meio podem estar sem uso)
const found = (used: number[]) => ({ wallets: used.length ? Array.from({ length: Math.max(...used) + 1 }, (_, index) => ({ index, hasHistory: used.includes(index) })) : [] });

test('detecção: temporárias → Solflare; contas além da Conta 1 → Phantom; os dois → ambas', () => {
  assert.equal(detectWallet(found([0, 3]), found([0])), 'solflare', 'Conta 1 usada é a principal do Solflare também');
  assert.equal(detectWallet(found([]), found([0, 1, 2])), 'phantom');
  assert.equal(detectWallet(found([]), found([2])), 'phantom', 'Conta 3 usada sem a Conta 1 (a revisão avisa)');
  assert.equal(detectWallet(found([0]), found([0, 1])), 'ambas');
});

test('detecção: só a Conta 1 → principal (nada para limpar); nada → nenhuma', () => {
  assert.equal(detectWallet(found([]), found([0])), 'principal');
  assert.equal(detectWallet(found([]), found([])), 'nenhuma');
});

test('detecção: carteira listada sem histórico não conta (dado fora do formato não vira burner)', () => {
  const unused = { wallets: [{ index: 0, hasHistory: false }, { index: 1, hasHistory: false }] };
  assert.equal(detectWallet(unused, unused), 'nenhuma');
  assert.equal(detectWallet(unused, { wallets: [{ index: 0, hasHistory: true }, { index: 1, hasHistory: false }] }), 'principal');
});

// terceiro ramo (m/44'/501'/i': Trust e Phantom antiga), 06/11/2026: cada ramo com uso vira um cartão
test('detect: três ramos', () => {
  const none = found([]);
  assert.deepEqual(detectBranches(none, none, found([0, 1, 2])), ['trust'], 'só a Trust');
  assert.deepEqual(detectBranches(none, found([0, 1]), found([0, 2])), ['phantom', 'trust']);
  assert.deepEqual(detectBranches(found([0]), found([0, 1]), found([0, 1])), ['solflare', 'phantom', 'trust'], 'os três, nesta ordem');
  assert.deepEqual(detectBranches(found([3]), none, found([1])), ['solflare', 'trust']);
  // só a principal da Trust (conta 0): nenhum ramo
  assert.deepEqual(detectBranches(none, none, found([0])), []);
  assert.deepEqual(detectBranches(none, found([0]), found([0])), []);
  // conta listada sem histórico não conta
  assert.deepEqual(detectBranches(none, none, { wallets: [{ index: 0, hasHistory: true }, { index: 1, hasHistory: false }] }), []);
  // a resposta de uma palavra continua igual para os testes de antes
  assert.equal(detectWallet(none, none, found([0, 1])), 'trust');
  assert.equal(detectWallet(none, found([0, 1]), found([1])), 'ambas');
  assert.equal(detectWallet(none, none, found([0])), 'principal', 'só a principal da Trust: nada para limpar');
  assert.equal(detectWallet(none, none, none), 'nenhuma');
});
