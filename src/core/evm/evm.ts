// Endereços das redes compatíveis com Ethereum (Ethereum, Base, BSC, Arbitrum, Polygon, Monad, HyperEVM) a partir da
// MESMA frase, como MetaMask/Trust/Exodus fazem: BIP32 secp256k1, caminho m/44'/60'/0'/0/i.
// Só leitura: o app calcula o endereço público e não guarda chave dessas redes.

import { createHmac } from 'node:crypto';
import { secp256k1PublicKey } from './secp256k1.ts';

// ---------- Keccak-256 (o hash do Ethereum; não é o SHA3-256 do Node) ----------

const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROTATIONS = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const MASK = (1n << 64n) - 1n;
const rotl = (x: bigint, n: number) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK);

function keccakF(s: bigint[]) {
  for (const rc of ROUND_CONSTANTS) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[y + x] ^= d;
    }
    const b = new Array<bigint>(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROTATIONS[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & MASK & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= rc;
  }
}

export function keccak256(data: Uint8Array): Buffer {
  const rate = 136;
  const padded = Buffer.alloc(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array<bigint>(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) s[i] ^= padded.readBigUInt64LE(off + i * 8);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

// ---------- BIP32 secp256k1 ----------

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HARDENED = 0x80000000;

const toBig = (b: Uint8Array) => BigInt('0x' + Buffer.from(b).toString('hex'));
const to32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

// secp256k1 em TypeScript (ver secp256k1.ts): o Node do Electron não tem a curva no node:crypto
const publicKey = (priv: Buffer, compressed: boolean): Buffer => secp256k1PublicKey(priv, compressed);

type Node = { key: Buffer; chain: Buffer };

export function bip32Derive(seed: Uint8Array, path: string): Buffer {
  const I = createHmac('sha512', 'Bitcoin seed').update(seed).digest();
  let node: Node = { key: I.subarray(0, 32), chain: I.subarray(32) };
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new Error('caminho inválido');
  for (const p of parts.slice(1)) {
    const hardened = p.endsWith("'");
    const idx = Number(hardened ? p.slice(0, -1) : p) + (hardened ? HARDENED : 0);
    const ib = Buffer.alloc(4);
    ib.writeUInt32BE(idx >>> 0);
    const data = hardened ? Buffer.concat([Buffer.alloc(1), node.key, ib]) : Buffer.concat([publicKey(node.key, true), ib]);
    const J = createHmac('sha512', node.chain).update(data).digest();
    const child = (toBig(J.subarray(0, 32)) + toBig(node.key)) % N;
    if (toBig(J.subarray(0, 32)) >= N || child === 0n) throw new Error('índice de derivação inválido (raríssimo)');
    node = { key: to32(child), chain: J.subarray(32) };
  }
  return node.key;
}

// Endereço com letras maiúsculas/minúsculas de conferência (EIP-55), como as carteiras mostram.
export function checksumAddress(hex40: string): string {
  const lower = hex40.toLowerCase().replace(/^0x/, '');
  const h = keccak256(Buffer.from(lower, 'ascii')).toString('hex');
  return '0x' + [...lower].map((c, i) => (parseInt(h[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
}

export function evmPath(i: number): string {
  return `m/44'/60'/0'/0/${i}`;
}

export function evmAddress(seed: Uint8Array, i: number): string {
  const priv = bip32Derive(seed, evmPath(i));
  try {
    const pub = publicKey(priv, false).subarray(1);
    return checksumAddress(keccak256(pub).subarray(-20).toString('hex'));
  } finally {
    priv.fill(0);
  }
}
