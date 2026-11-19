// Chaves privadas coladas (spec 2026-11-06 §4.1 e §4.2): uma chave por linha, em qualquer formato que as carteiras e os
// bots exportam. O TEXTO da chave vive só dentro deste arquivo: sai daqui só o par (endereço, 32 bytes da semente).
// Erro diz só o número da linha (ou o limite) e o motivo, nunca um pedaço da linha. Não importa nada de src/app.
//
// Formatos aceitos:
// - base58 de 64 bytes (Phantom, Privy/Pump.fun, PumpPortal, Photon, Trojan, BullX);
// - lista de 64 números de 0 a 255 entre colchetes (solana-keygen, scripts);
// - hex de 128 caracteres (64 bytes) ou de 64 (só a semente), com ou sem "0x".
// Com 64 bytes, os 32 últimos são a pública: ela tem que ser a derivada dos 32 primeiros (pega chave cortada ou trocada).
// base58 de 32 bytes é recusado: tem a cara de um endereço público, e aceitá-lo como semente daria uma carteira vazia
// sem aviso nenhum (decisão de segurança da spec).
import { publicKeyFromPrivate } from './derivation.ts';
import { decodeBase58, encodeBase58 } from '../solana/base58.ts';
import { signerFromPrivateKey, type Signer } from '../solana/tx.ts';
import type { ErrorCode } from '../limpeza/errors.ts';

export const MAX_KEYS_PER_CARD = 200;

// secret = os 32 bytes da semente (a pública sai dela). Zerar com wipeParsedKeys quando a rodada acabar.
// line = número da linha no texto colado (só o número: é o que os erros entre cartões citam).
export type ParsedKey = { address: string; secret: Buffer; line: number };
export type KeyErrorCode = Extract<ErrorCode, 'key-unknown' | 'key-mismatch' | 'key-looks-address' | 'key-duplicate' | 'too-many-keys'>;
export type KeyParseResult = { ok: true; keys: ParsedKey[] } | { ok: false; code: KeyErrorCode; params: { line?: number; max?: number } };

const BASE58_LINE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_MAX_CHARS = 100; // 64 bytes dão no máximo 88 caracteres; linha maior nem é decodificada
const HEX_LINE = /^(?:0x)?([0-9a-f]{128}|[0-9a-f]{64})$/i;
const JSON_LINE = /^\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){63}\s*\]$/;
const KEY_SHAPED_MIN = 32; // menor chave aceita (hex de 64) e menor endereço; palavra da frase tem no máximo 8 letras

// Lixo que a área de transferência deixa em volta: espaços, \r, aspas, e vírgula ou ponto e vírgula no fim.
function cleanLine(line: string): string {
  return line.replace(/^[\s'"]+/, '').replace(/[\s'",;]+$/, '');
}

const lines = (text: string): string[] => text.split('\n').map(cleanLine);

// O cartão é de chaves quando alguma linha tem forma de chave: 32 caracteres ou mais sem espaço no meio, ou uma lista
// entre colchetes. Frase numa linha só (tem espaço) e frase com uma palavra por linha (palavras curtas) ficam de fora.
// Cartão misturado (chaves e uma frase) vai para parseKeys, que aponta a linha da frase sem ecoar o conteúdo.
export function looksLikeKeys(text: string): boolean {
  return lines(text).some((l) => (l.length >= KEY_SHAPED_MIN && !/\s/.test(l)) || /^\[[\d\s,]*\]$/.test(l));
}

type LineKey = Omit<ParsedKey, 'line'>;
type LineResult = { key: LineKey } | { code: 'key-unknown' | 'key-mismatch' | 'key-looks-address' };

function keyFromSeed(seed: Uint8Array): LineKey {
  const secret = Buffer.alloc(32);
  secret.set(seed);
  return { address: encodeBase58(publicKeyFromPrivate(secret)), secret };
}

// 64 bytes = semente + pública; a pública tem que ser a derivada da semente
function keyFromFull(bytes: Uint8Array): LineResult {
  const key = keyFromSeed(bytes.subarray(0, 32));
  if (key.address !== encodeBase58(bytes.subarray(32, 64))) {
    key.secret.fill(0);
    return { code: 'key-mismatch' };
  }
  return { key };
}

function parseLine(l: string): LineResult {
  let bytes: Uint8Array | null = null;
  try {
    const hex = HEX_LINE.exec(l);
    if (hex) {
      bytes = Buffer.from(hex[1], 'hex');
      return bytes.length === 32 ? { key: keyFromSeed(bytes) } : keyFromFull(bytes);
    }
    if (JSON_LINE.test(l)) {
      const nums = (l.match(/\d+/g) ?? []).map(Number);
      if (nums.length !== 64 || nums.some((n) => n > 255)) return { code: 'key-unknown' };
      bytes = Uint8Array.from(nums);
      nums.fill(0);
      return keyFromFull(bytes);
    }
    if (l.length <= BASE58_MAX_CHARS && BASE58_LINE.test(l)) {
      bytes = decodeBase58(l);
      if (bytes.length === 64) return keyFromFull(bytes);
      if (bytes.length === 32) return { code: 'key-looks-address' };
    }
    return { code: 'key-unknown' };
  } catch {
    // nada de mensagem da exceção: ela poderia carregar um pedaço da linha
    return { code: 'key-unknown' };
  } finally {
    bytes?.fill(0);
  }
}

export function parseKeys(text: string): KeyParseResult {
  const all = lines(text);
  if (all.filter((l) => l !== '').length > MAX_KEYS_PER_CARD) return { ok: false, code: 'too-many-keys', params: { max: MAX_KEYS_PER_CARD } };

  const keys: ParsedKey[] = [];
  const fail = (code: KeyErrorCode, line: number): KeyParseResult => {
    wipeParsedKeys(keys);
    return { ok: false, code, params: { line } };
  };
  const seen = new Set<string>(); // endereços já lidos neste texto: a mesma chave em outro formato também é repetida
  for (let i = 0; i < all.length; i++) {
    if (all[i] === '') continue;
    const r = parseLine(all[i]);
    if ('code' in r) return fail(r.code, i + 1);
    if (seen.has(r.key.address)) {
      r.key.secret.fill(0);
      return fail('key-duplicate', i + 1);
    }
    seen.add(r.key.address);
    keys.push({ ...r.key, line: i + 1 });
  }
  return { ok: true, keys };
}

export function wipeParsedKeys(keys: ParsedKey[]): void {
  for (const k of keys) k.secret.fill(0);
}

// As chaves de assinatura de um cartão de chaves: índice = posição da chave no cartão ("Chave 1" = índice 0). Os bytes
// continuam com quem chamou, que os zera logo depois (wipeParsedKeys): a chave de assinatura guarda a cópia dela.
export function keySigners(keys: ParsedKey[]): Map<number, Signer & { index: number }> {
  return new Map(keys.map((k, index) => [index, { index, ...signerFromPrivateKey(k.address, k.secret) }]));
}
