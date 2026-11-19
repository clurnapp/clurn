// Confere a frase pelo BIP39: quantidade de palavras, palavras da lista oficial e checksum.
// O resultado diz só o código e a POSIÇÃO da palavra ruim: a palavra e a frase nunca saem daqui (nem em erro, nem em log).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeMnemonic } from './derivation.ts';
import type { ErrorParams } from '../limpeza/errors.ts';

export type MnemonicCheck = { ok: true } | { ok: false; code: 'seed-words' | 'seed-unknown-word' | 'seed-checksum'; params: ErrorParams };

const VALID_COUNTS = [12, 15, 18, 21, 24];
let wordIndex: Map<string, number> | null = null;

// Texto da lista → palavra → índice. Aceita fim de linha \r\n: o git do Windows (autocrlf) troca o fim de linha no
// clone, e com split('\n') toda palavra ficava com '\r' no fim e o app recusava toda frase (achado de 16/11/2026 no
// clone público da 1.0.0). Mesma regra da página (parseWordList em ui/index.html).
export function parseWordList(text: string): Map<string, number> {
  const list = text.split(/\r?\n/).filter((w) => w !== '');
  if (list.length !== 2048 || !list.every((w) => /^[a-z]+$/.test(w))) throw new Error('Lista BIP39 corrompida.');
  return new Map(list.map((w, i) => [w, i]));
}

// Lista oficial de 2048 palavras (o arquivo é conferido por SHA-256 na entrega); lida uma vez.
function words(): Map<string, number> {
  wordIndex ??= parseWordList(fs.readFileSync(path.join(import.meta.dirname, 'bip39-english.txt'), 'utf8'));
  return wordIndex;
}

export function validateMnemonic(text: string): MnemonicCheck {
  const norm = normalizeMnemonic(text);
  const list = norm === '' ? [] : norm.split(' ');
  if (!VALID_COUNTS.includes(list.length)) return { ok: false, code: 'seed-words', params: { words: list.length } };

  const index = words();
  let bits = '';
  for (let i = 0; i < list.length; i++) {
    const v = index.get(list[i]);
    if (v === undefined) return { ok: false, code: 'seed-unknown-word', params: { position: i + 1 } };
    bits += v.toString(2).padStart(11, '0');
  }

  // entropia = ENT bits, checksum = primeiros ENT/32 bits do SHA-256 da entropia
  const checksumBits = list.length / 3;
  const entropyBits = bits.length - checksumBits;
  const entropy = Buffer.alloc(entropyBits / 8);
  for (let i = 0; i < entropy.length; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const expected = createHash('sha256').update(entropy).digest()[0].toString(2).padStart(8, '0').slice(0, checksumBits);
  entropy.fill(0);
  if (expected !== bits.slice(entropyBits)) return { ok: false, code: 'seed-checksum', params: {} };
  return { ok: true };
}
