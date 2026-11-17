import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  burnerPath,
  burnerSigner,
  deriveBurner,
  deriveMainAddress,
  derivePrivateKey,
  hasMainAccount,
  mainAddresses,
  mnemonicToSeed,
  mnemonicWordCount,
  normalizeMnemonic,
  needsReview,
  publicKeyFromPrivate,
  standardPath,
  TRUST_MAIN_INDEX,
  trustPath,
  walletLabel,
  walletPath,
} from '../../src/core/carteiras/derivation.ts';
import { decodeBase58, encodeBase58, isAddress } from '../../src/core/solana/base58.ts';

// Frase PÚBLICA de teste do BIP39. Não é de ninguém.
const PUBLIC_TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('BIP39: vetor oficial da Trezor', () => {
  const seed = mnemonicToSeed(PUBLIC_TEST_MNEMONIC, 'TREZOR');
  assert.equal(
    seed.toString('hex'),
    'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',
  );
});

test('SLIP-0010 ed25519: vetor oficial 1', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(derivePrivateKey(seed, 'm').toString('hex'), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(
    publicKeyFromPrivate(derivePrivateKey(seed, 'm')).toString('hex'),
    'a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed',
  );
  assert.equal(derivePrivateKey(seed, "m/0'").toString('hex'), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(derivePrivateKey(seed, "m/0'/1'").toString('hex'), 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2');
});

test('caminho não hardened é recusado', () => {
  assert.throws(() => derivePrivateKey(Buffer.alloc(64), "m/44'/501'/0"));
});

test('carteira principal da frase pública = a que o Solflare mostra', () => {
  assert.equal(deriveMainAddress(mnemonicToSeed(PUBLIC_TEST_MNEMONIC)), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
});

test('temporárias da frase pública = as que o Solflare 2.41.1 criou (docs/derivacao-solflare.md)', () => {
  const seed = mnemonicToSeed(PUBLIC_TEST_MNEMONIC);
  const expected = [
    '9Jpe1mHmpRktDwJ6ridosdnkrbRPkuQsvCxLn71F2sFV',
    'JoaN8oYmp6Z9yTrmuQ6HmDie5pX67pTibNXMSLRBn71',
    'CjYWZBK3hvJmGRfoj6gfMrAakKJYzxc6GNpeBsXBWmpN',
    'BaxAiBqCpTJucnJy4uQ4MseUYYvzEJKBnAjjrj8drvgL',
  ];
  expected.forEach((address, n) => {
    assert.deepEqual(deriveBurner(seed, n), { index: n, path: burnerPath(n), address });
  });
  assert.equal(burnerPath(0), "m/44'/501'/10000'/0'/0'");
});

test('temporária nunca coincide com a principal', () => {
  const seed = mnemonicToSeed(PUBLIC_TEST_MNEMONIC);
  const main = deriveMainAddress(seed);
  for (let n = 0; n < 50; n++) assert.notEqual(deriveBurner(seed, n).address, main);
});

test('normalização da frase igual ao Solflare', () => {
  assert.equal(normalizeMnemonic('  Abandon   ABOUT \n'), 'abandon about');
  assert.equal(mnemonicWordCount(' a b  c '), 3);
  assert.equal(mnemonicWordCount('   '), 0);
  const a = mnemonicToSeed(PUBLIC_TEST_MNEMONIC);
  const b = mnemonicToSeed('  ' + PUBLIC_TEST_MNEMONIC.toUpperCase().replaceAll(' ', '   ') + '\n');
  assert.deepEqual(a, b);
});

test('base58: ida e volta, zeros à esquerda e validação de endereço', () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
  assert.deepEqual(decodeBase58(encodeBase58(bytes)), bytes);
  assert.equal(encodeBase58(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.ok(isAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'));
  assert.ok(!isAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpq0'));
  assert.ok(!isAddress('abc'));
});

// Caminho m/44'/501'/i' (Trust Wallet e Phantom antiga), 06/11/2026. Vetor PÚBLICO: `gMnemonic` de
// trustwallet/wallet-core, tests/common/Keystore/StoredKeyTests.cpp. Não é de ninguém.
const TRUST_TEST_MNEMONIC = 'team engine square letter hero song dizzy scrub tornado fabric divert saddle';

test('derivation: vetor da Trust', () => {
  const seed = mnemonicToSeed(TRUST_TEST_MNEMONIC);
  assert.equal(trustPath(0), "m/44'/501'/0'");
  assert.equal(trustPath(7), "m/44'/501'/7'");
  assert.equal(deriveBurner(seed, 0, 'trust').address, 'HiipoCKL8hX2RVmJTz3vaLy34hS2zLhWWMkUWtw85TmZ');
  assert.equal(deriveBurner(seed, 0, 'phantom').address, 'CgWJeEWkiYqosy1ba7a3wn9HAQuHyK48xs3LM4SSDc1C');
  assert.equal(deriveBurner(seed, 0, 'phantom').path, standardPath(0));
  assert.equal(walletPath('trust', 3), trustPath(3));
  assert.equal(walletLabel('trust', 0), 'Conta 1');
  assert.equal(walletLabel('trust', 4), 'Conta 5');
  // as duas principais da frase: Conta 1 da Phantom/Solflare e conta 0 da Trust
  assert.deepEqual(mainAddresses(seed), ['CgWJeEWkiYqosy1ba7a3wn9HAQuHyK48xs3LM4SSDc1C', 'HiipoCKL8hX2RVmJTz3vaLy34hS2zLhWWMkUWtw85TmZ']);
  // três caminhos, três endereços diferentes para o mesmo número
  const n1 = (['solflare', 'phantom', 'trust'] as const).map((app) => deriveBurner(seed, 1, app).address);
  assert.equal(new Set(n1).size, 3);
});

test('derivation: conta 0 da Trust nunca assina', () => {
  const seed = mnemonicToSeed(TRUST_TEST_MNEMONIC);
  assert.equal(TRUST_MAIN_INDEX, 0);
  assert.throws(() => burnerSigner(seed, TRUST_MAIN_INDEX, 'trust'), /principal/);
  assert.equal(burnerSigner(seed, 1, 'trust').address, deriveBurner(seed, 1, 'trust').address);
  // quem tem principal no próprio caminho e quem passa pela conferência
  assert.deepEqual((['solflare', 'phantom', 'trust', 'chaves'] as const).map(hasMainAccount), [false, true, true, false]);
  assert.deepEqual((['solflare', 'phantom', 'trust', 'chaves'] as const).map(needsReview), [false, true, true, true]);
});
