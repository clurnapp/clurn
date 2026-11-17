import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify, createPublicKey } from 'node:crypto';
import { buildTransaction, compactU16, compileMessage, transactionSize } from '../../src/core/solana/tx.ts';
import { burnerSigner, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { systemTransfer, tokenCloseAccount } from '../../src/core/solana/instructions.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';
import { PROGRAMS } from '../../src/core/solana/pda.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const A = burnerSigner(seed, 0);
const B = burnerSigner(seed, 1);
const BH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';

test('compact-u16: valores de referência do formato Solana', () => {
  assert.deepEqual(compactU16(0), [0]);
  assert.deepEqual(compactU16(127), [0x7f]);
  assert.deepEqual(compactU16(128), [0x80, 0x01]);
  assert.deepEqual(compactU16(16383), [0xff, 0x7f]);
  assert.deepEqual(compactU16(16384), [0x80, 0x80, 0x01]);
  assert.throws(() => compactU16(70000));
});

test('mensagem: pagador primeiro, ordem dos grupos e cabeçalho', () => {
  const ix = tokenCloseAccount(PROGRAMS.token, B.address, A.address, B.address); // B dono assina, A recebe
  const msg = compileMessage(A.address, [ix], BH);
  // A: pagador (signatário gravável); B: signatário só leitura; conta = B mesmo (gravável, já assinante)
  assert.equal(msg.accountKeys[0], A.address);
  assert.equal(msg.numSigners, 2);
  assert.equal(msg.bytes[0], 2); // assinaturas
  assert.equal(msg.bytes[2], 1); // só leitura sem assinatura: o programa
  assert.equal(msg.accountKeys.at(-1), PROGRAMS.token);
});

test('assinatura: cada assinatura confere com a chave pública e a ordem das contas', () => {
  const tx = buildTransaction(A.address, [systemTransfer(B.address, A.address, 5n)], BH, [B, A]);
  const raw = Buffer.from(tx.bytes);
  assert.equal(raw[0], 2);
  const msg = raw.subarray(1 + 128);
  const keys = [A.address, B.address];
  keys.forEach((k, i) => {
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeBase58(k)]), format: 'der', type: 'spki' });
    assert.ok(verify(null, msg, pub, raw.subarray(1 + 64 * i, 65 + 64 * i)), `assinatura ${i}`);
  });
});

test('falta de assinatura e endereço inválido são recusados', () => {
  assert.throws(() => buildTransaction(A.address, [systemTransfer(B.address, A.address, 5n)], BH, [A]), /falta a assinatura/);
  assert.throws(() => compileMessage(A.address, [systemTransfer(A.address, '1111', 1n)], BH), /inválido/);
});

test('tamanho: conta bytes de assinatura + mensagem', () => {
  const ixs = [systemTransfer(A.address, B.address, 1n)];
  const tx = buildTransaction(A.address, ixs, BH, [A]);
  assert.equal(transactionSize(A.address, ixs), tx.bytes.length);
});
