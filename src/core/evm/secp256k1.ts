// Chave pública secp256k1 (a curva do Ethereum/Bitcoin) a partir da chave privada, em TypeScript puro.
// Por que não o ECDH de secp256k1 do node:crypto: o Node embutido no Electron usa BoringSSL, que
// não tem essa curva (só prime256v1, secp224r1, secp384r1, secp521r1). O app de desktop caía na análise
// com "Failed to create key using named curve" (30/10/2026). O terminal (Node com OpenSSL) tinha a curva.
//
// Só o que a derivação BIP32 e o endereço EVM precisam: multiplicação do ponto gerador por um escalar.
// Coordenadas jacobianas (uma inversão modular por chave). Não é em tempo constante: aqui só calcula
// endereços para leitura, num app local; nada desta curva assina nem envia.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a: bigint) => ((a % P) + P) % P;

function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

const inverse = (a: bigint) => modPow(a, P - 2n); // P é primo (Fermat)

// ponto em coordenadas jacobianas (x = X/Z², y = Y/Z³); null = ponto no infinito
type Point = { x: bigint; y: bigint; z: bigint } | null;

function double(p: Point): Point {
  if (!p || p.y === 0n) return null;
  const y2 = (p.y * p.y) % P;
  const s = (4n * p.x * y2) % P;
  const m = (3n * p.x * p.x) % P; // a = 0 na secp256k1
  const x = mod(m * m - 2n * s);
  const y = mod(m * (s - x) - 8n * y2 * y2);
  const z = (2n * p.y * p.z) % P;
  return { x, y, z };
}

function add(p: Point, q: Point): Point {
  if (!p) return q;
  if (!q) return p;
  const z1z1 = (p.z * p.z) % P;
  const z2z2 = (q.z * q.z) % P;
  const u1 = (p.x * z2z2) % P;
  const u2 = (q.x * z1z1) % P;
  const s1 = (p.y * z2z2 * q.z) % P;
  const s2 = (q.y * z1z1 * p.z) % P;
  if (u1 === u2) return s1 === s2 ? double(p) : null;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = (h * h) % P;
  const hhh = (hh * h) % P;
  const v = (u1 * hh) % P;
  const x = mod(r * r - hhh - 2n * v);
  const y = mod(r * (v - x) - s1 * hhh);
  const z = (h * p.z * q.z) % P;
  return { x, y, z };
}

function multiplyG(k: bigint): { x: bigint; y: bigint } {
  const g: Point = { x: GX, y: GY, z: 1n };
  let acc: Point = null;
  for (let i = k.toString(2).length - 1; i >= 0; i--) {
    acc = double(acc);
    if ((k >> BigInt(i)) & 1n) acc = add(acc, g);
  }
  if (!acc) throw new Error('chave privada inválida (ponto no infinito)');
  const zi = inverse(acc.z);
  const zi2 = (zi * zi) % P;
  return { x: (acc.x * zi2) % P, y: (acc.y * zi2 * zi) % P };
}

const to32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

// 33 bytes (02/03 + x) ou 65 bytes (04 + x + y), igual ao getPublicKey do node:crypto
export function secp256k1PublicKey(priv: Uint8Array, compressed: boolean): Buffer {
  if (priv.length !== 32) throw new Error('chave privada precisa ter 32 bytes');
  const d = BigInt('0x' + Buffer.from(priv).toString('hex'));
  if (d === 0n || d >= N) throw new Error('chave privada fora do intervalo da curva');
  const { x, y } = multiplyG(d);
  if (compressed) return Buffer.concat([Buffer.from([y & 1n ? 0x03 : 0x02]), to32(x)]);
  return Buffer.concat([Buffer.from([0x04]), to32(x), to32(y)]);
}
