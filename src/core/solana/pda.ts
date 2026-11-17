// Endereços derivados de programa (PDA) e contas de token associadas (ATA), sem bibliotecas.

import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.ts';

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpAmm: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  // Meteora Dynamic Bonding Curve (base de Bags, Jupiter Studio, Believe): IDL 0.2.2 do SDK, programa 0.2.3 (09/11/2026)
  meteoraDbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  // Raydium LaunchLab (bonk.fun e outros launchpads): IDL 0.2.0 (raydium-idl), CPI e SDK V2 conferidos em 09/11/2026
  raydiumLaunchlab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
} as const;

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const P = 2n ** 255n - 19n;
const D = (-121665n * modInverse(121666n)) % P;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function modInverse(a: bigint): bigint {
  return modPow(a, P - 2n);
}

// Um PDA precisa cair FORA da curva ed25519 (não pode ter chave privada).
// Ponto comprimido: y em little-endian, bit de sinal de x no topo. Está na curva se
// x² = (y² − 1) / (d·y² + 1) tem raiz quadrada módulo p (critério de Euler).
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  const le = Uint8Array.from(bytes);
  le[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(le[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = mod(u * modInverse(v));
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export type Seed = string | Uint8Array;

function seedBytes(seed: Seed): Uint8Array {
  return typeof seed === 'string' ? Buffer.from(seed, 'utf8') : seed;
}

export function findProgramAddress(seeds: Seed[], programId: string): { address: string; bump: number } {
  const program = decodeBase58(programId);
  const raw = seeds.map(seedBytes);
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...raw, Uint8Array.of(bump), program, Buffer.from('ProgramDerivedAddress'));
    if (!isOnCurve(hash)) return { address: encodeBase58(hash), bump };
  }
  throw new Error('nenhum PDA válido');
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram: string = PROGRAMS.token): string {
  return findProgramAddress(
    [decodeBase58(owner), decodeBase58(tokenProgram), decodeBase58(mint)],
    PROGRAMS.associatedToken,
  ).address;
}

// Discriminador de conta Anchor: primeiros 8 bytes de sha256("account:<Nome>").
export function anchorAccountDiscriminator(name: string): Buffer {
  return sha256(Buffer.from(`account:${name}`)).subarray(0, 8);
}

// Cofres de creator fee da Pump.fun (docs/pumpfun-creator-fees.md).
export function pumpCreatorVault(creator: string): string {
  return findProgramAddress(['creator-vault', decodeBase58(creator)], PROGRAMS.pump).address;
}

export function pumpAmmCreatorVaultAuthority(creator: string): string {
  return findProgramAddress(['creator_vault', decodeBase58(creator)], PROGRAMS.pumpAmm).address;
}

export function pumpAmmCreatorVaultAta(creator: string): string {
  return associatedTokenAddress(pumpAmmCreatorVaultAuthority(creator), WSOL_MINT, PROGRAMS.token);
}

// Divisão da creator fee (fee sharing, docs/pumpfun-creator-fees.md): a moeda passa a ter como criador este PDA do
// programa de fees, e os cofres acima passam a ser os dele.
// Cashback de quem negociou (docs/pumpfun-creator-fees.md): acumulador por usuário, um na Pump.fun e um no PumpSwap.
export function userVolumeAccumulator(user: string, program: string = PROGRAMS.pump): string {
  return findProgramAddress(['user_volume_accumulator', decodeBase58(user)], program).address;
}

export function sharingConfigAddress(mint: string): string {
  return findProgramAddress(['sharing-config', decodeBase58(mint)], PROGRAMS.pumpFees).address;
}
