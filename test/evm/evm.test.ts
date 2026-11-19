import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, getCurves, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bip32Derive, checksumAddress, evmAddress, keccak256 } from '../../src/core/evm/evm.ts';
import { N, secp256k1PublicKey } from '../../src/core/evm/secp256k1.ts';
import { mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';

test('Keccak-256: vetores conhecidos (não é o SHA3 do Node)', () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // entrada maior que um bloco (136 bytes)
  assert.equal(keccak256(Buffer.alloc(200, 0x61)).length, 32);
});

test('BIP32 secp256k1: vetor oficial 1', () => {
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  assert.equal(bip32Derive(seed, 'm').toString('hex'), 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35');
  assert.equal(bip32Derive(seed, "m/0'").toString('hex'), 'edb2e14f9ee77d26dd93b4ecede8d16ed408ce149b6cd80b0715a2d911a0afea');
  assert.equal(bip32Derive(seed, "m/0'/1").toString('hex'), '3c6cb8d0f6a264c91ea8b5030fadaa8e538b020f0a387421a12de9319dc93368');
});

test('EIP-55: endereço com conferência de maiúsculas', () => {
  assert.equal(checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'), '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
});

test('frase pública de teste: mesmos endereços que MetaMask mostra', () => {
  const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  assert.equal(evmAddress(seed, 0), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
  assert.equal(evmAddress(seed, 1), '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
});

// ---------- secp256k1 em TypeScript (o Node do Electron não tem a curva no node:crypto) ----------

const GX = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const GY = '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
const P_MINUS_GY = 'b7c52588d95c3b9aa25b0403f1eef75702e84bb7597aabe663b82f6f04ef2777';
const keyOf = (hex: string) => Buffer.from(hex.padStart(64, '0'), 'hex');

test('secp256k1: pontos conhecidos (G, 2G, (N-1)G) nos dois formatos', () => {
  assert.equal(secp256k1PublicKey(keyOf('01'), false).toString('hex'), '04' + GX + GY);
  assert.equal(secp256k1PublicKey(keyOf('01'), true).toString('hex'), '02' + GX, 'y par → 02');
  assert.equal(
    secp256k1PublicKey(keyOf('02'), false).toString('hex'),
    '04c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee51ae168fea63dc339a3c58419466ceaeef7f632653266d0e1236431a950cfe52a',
  );
  // (N-1)·G = -G: mesmo x, y = p - Gy (ímpar → 03)
  assert.equal(secp256k1PublicKey(keyOf((N - 1n).toString(16)), false).toString('hex'), '04' + GX + P_MINUS_GY);
  assert.equal(secp256k1PublicKey(keyOf((N - 1n).toString(16)), true).toString('hex'), '03' + GX);
});

test('secp256k1: chave fora do intervalo é recusada', () => {
  assert.throws(() => secp256k1PublicKey(keyOf('00'), true), /fora do intervalo/);
  assert.throws(() => secp256k1PublicKey(keyOf(N.toString(16)), true), /fora do intervalo/);
  assert.throws(() => secp256k1PublicKey(Buffer.alloc(31, 1), true), /32 bytes/);
});

test('secp256k1: igual ao node:crypto em chaves aleatórias (onde o OpenSSL tem a curva)', (t) => {
  if (!getCurves().includes('secp256k1')) {
    t.diagnostic('node:crypto sem secp256k1 (Node do Electron): comparação pulada, valem os vetores fixos');
    return;
  }
  for (let i = 0; i < 40; i++) {
    const priv = randomBytes(32);
    if (BigInt('0x' + priv.toString('hex')) >= N) continue;
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(priv);
    assert.equal(secp256k1PublicKey(priv, false).toString('hex'), ecdh.getPublicKey('hex', 'uncompressed'));
    assert.equal(secp256k1PublicKey(priv, true).toString('hex'), ecdh.getPublicKey('hex', 'compressed'));
  }
});

test('o app não usa createECDH (o Node do Electron não tem secp256k1; a análise caía no app de desktop)', () => {
  const src = path.join(import.meta.dirname, '..', '..', 'src');
  const files = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(src, f), 'utf8'), /createECDH/, f);
});
