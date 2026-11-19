// Montagem e assinatura de transação Solana (formato legado), sem bibliotecas.
// Referência do formato: https://solana.com/docs/core/transactions

import { createPrivateKey, sign as edSign, type KeyObject } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.ts';

export const MAX_TX_BYTES = 1232;

export type AccountMeta = { pubkey: string; isSigner: boolean; isWritable: boolean };
export type Instruction = { programId: string; keys: AccountMeta[]; data: Uint8Array };

// Quem assina guarda a chave como KeyObject do Node; os bytes da chave não circulam.
export type Signer = { address: string; sign(message: Uint8Array): Uint8Array };

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function signerFromPrivateKey(address: string, privateKey: Uint8Array): Signer {
  // a cópia em DER é zerada assim que a chave de assinatura existe (ela guarda a própria cópia)
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, privateKey]);
  try {
    const key: KeyObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return { address, sign: (m) => edSign(null, m, key) };
  } finally {
    der.fill(0);
  }
}

export function compactU16(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new Error('compact-u16 fora do intervalo');
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

export type CompiledMessage = {
  bytes: Uint8Array;
  accountKeys: string[];
  numSigners: number;
};

// Ordem exigida: pagador da taxa, signatários graváveis, signatários só leitura,
// não signatários graváveis, não signatários só leitura.
export function compileMessage(feePayer: string, instructions: Instruction[], recentBlockhash: string): CompiledMessage {
  const metas = new Map<string, { isSigner: boolean; isWritable: boolean }>();
  const add = (pubkey: string, isSigner: boolean, isWritable: boolean) => {
    const m = metas.get(pubkey);
    if (m) {
      m.isSigner ||= isSigner;
      m.isWritable ||= isWritable;
    } else metas.set(pubkey, { isSigner, isWritable });
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(ix.programId, false, false);
  }

  // o pagador foi o primeiro a entrar e o sort é estável: continua na frente do seu grupo
  const rank = (pk: string) => {
    const m = metas.get(pk)!;
    return m.isSigner ? (m.isWritable ? 0 : 1) : m.isWritable ? 2 : 3;
  };
  const keys = [...metas.keys()].sort((a, b) => rank(a) - rank(b)); // sort estável: mantém a ordem de chegada dentro do grupo
  const numSigners = keys.filter((k) => metas.get(k)!.isSigner).length;
  const numReadonlySigned = keys.filter((k) => metas.get(k)!.isSigner && !metas.get(k)!.isWritable).length;
  const numReadonlyUnsigned = keys.filter((k) => !metas.get(k)!.isSigner && !metas.get(k)!.isWritable).length;
  const index = new Map(keys.map((k, i) => [k, i]));

  const bytes: number[] = [numSigners, numReadonlySigned, numReadonlyUnsigned];
  bytes.push(...compactU16(keys.length));
  for (const k of keys) {
    const raw = decodeBase58(k);
    if (raw.length !== 32) throw new Error(`endereço inválido na transação: ${k}`);
    bytes.push(...raw);
  }
  const bh = decodeBase58(recentBlockhash);
  if (bh.length !== 32) throw new Error('blockhash inválido');
  bytes.push(...bh);
  bytes.push(...compactU16(instructions.length));
  for (const ix of instructions) {
    bytes.push(index.get(ix.programId)!);
    bytes.push(...compactU16(ix.keys.length));
    for (const k of ix.keys) bytes.push(index.get(k.pubkey)!);
    bytes.push(...compactU16(ix.data.length));
    bytes.push(...ix.data);
  }
  return { bytes: Uint8Array.from(bytes), accountKeys: keys, numSigners };
}

export type SignedTransaction = { bytes: Uint8Array; signature: string };

export function signTransaction(message: CompiledMessage, signers: Signer[]): SignedTransaction {
  const bySigner = new Map(signers.map((s) => [s.address, s]));
  const sigs: Uint8Array[] = [];
  for (const key of message.accountKeys.slice(0, message.numSigners)) {
    const s = bySigner.get(key);
    if (!s) throw new Error(`falta a assinatura de ${key}`);
    const sig = s.sign(message.bytes);
    if (sig.length !== 64) throw new Error('assinatura com tamanho errado');
    sigs.push(sig);
  }
  const bytes = Uint8Array.from([...compactU16(sigs.length), ...sigs.flatMap((s) => [...s]), ...message.bytes]);
  return { bytes, signature: encodeBase58(sigs[0]) };
}

export function buildTransaction(feePayer: string, instructions: Instruction[], recentBlockhash: string, signers: Signer[]): SignedTransaction {
  return signTransaction(compileMessage(feePayer, instructions, recentBlockhash), signers);
}

export function transactionSize(feePayer: string, instructions: Instruction[]): number {
  const msg = compileMessage(feePayer, instructions, '11111111111111111111111111111111');
  return compactU16(msg.numSigners).length + 64 * msg.numSigners + msg.bytes.length;
}
