import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imitatedWallet, imitationMessage, knownWallets } from '../../src/core/limpeza/destination.ts';
import { mnemonicToSeed, standardPath, addressAt } from '../../src/core/carteiras/derivation.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const known = knownWallets(Array.from({ length: 10 }, (_, i) => addressAt(seed, standardPath(i))));
const MAIN = known[0].address; // HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk

test('endereço que imita uma carteira da frase (mesmo começo e fim, meio diferente) é reconhecido', () => {
  const fake = MAIN.slice(0, 4) + 'x'.repeat(MAIN.length - 8) + MAIN.slice(-4);
  assert.deepEqual(imitatedWallet(fake, known), known[0]);
  const fake3 = known[2].address.slice(0, 4) + 'Zz'.repeat(18) + known[2].address.slice(-4);
  assert.equal(imitatedWallet(fake3, known)?.label, 'Conta 3');
  assert.match(imitationMessage(fake, known[0]), /IMITA a sua Conta 1/);
});

test('o endereço certo, ou um endereço qualquer, passa sem atrito', () => {
  assert.equal(imitatedWallet(MAIN, known), null, 'a própria carteira não é imitação');
  assert.equal(imitatedWallet(known[5].address, known), null);
  assert.equal(imitatedWallet('5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN', known), null);
  const onlyStart = MAIN.slice(0, 4) + 'q'.repeat(MAIN.length - 4);
  assert.equal(imitatedWallet(onlyStart, known), null, 'só o começo igual não basta');
});
