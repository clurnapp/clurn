import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMnemonic } from '../../src/core/carteiras/bip39.ts';

const rep = (w: string, n: number) => Array(n).fill(w).join(' ');

test('bip39: frase válida de 12 e de 24 palavras passa', () => {
  // vetores oficiais do BIP39 (públicos)
  assert.deepEqual(validateMnemonic(`${rep('abandon', 11)} about`), { ok: true });
  assert.deepEqual(validateMnemonic(`${rep('zoo', 11)} wrong`), { ok: true });
  assert.deepEqual(validateMnemonic(`${rep('abandon', 23)} art`), { ok: true });
  assert.deepEqual(validateMnemonic(`${rep('zoo', 23)} vote`), { ok: true });
  // mesma normalização do resto do app: maiúsculas e espaços sobrando
  assert.deepEqual(validateMnemonic(`  ${rep('ABANDON', 11)}   About \n`), { ok: true });
});

test('bip39: palavra fora da lista dá a posição, sem a palavra', () => {
  const words = [...Array(11).fill('abandon'), 'about'];
  words[6] = 'xyz';
  const r = validateMnemonic(words.join(' '));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'seed-unknown-word');
  assert.equal(r.params.position, 7);
  assert.doesNotMatch(JSON.stringify(r), /xyz/);
});

test('bip39: checksum errado', () => {
  const r = validateMnemonic(`${rep('abandon', 12)}`);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'seed-checksum');
  const r24 = validateMnemonic(`${rep('abandon', 23)} zoo`);
  assert.equal(r24.ok, false);
  if (!r24.ok) assert.equal(r24.code, 'seed-checksum');
});

test('bip39: quantidade de palavras errada (inclui vazio) dá seed-words com a contagem', () => {
  for (const [text, n] of [['', 0], ['abandon abandon', 2], [`${rep('abandon', 13)}`, 13]] as const) {
    const r = validateMnemonic(text);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'seed-words');
      assert.deepEqual(r.params, { words: n });
    }
  }
});

test('bip39: 15, 18 e 21 palavras também valem (checksum por tamanho)', () => {
  // vetores oficiais do BIP39 (entropia de zeros)
  assert.deepEqual(validateMnemonic(`${rep('abandon', 14)} address`), { ok: true });
  assert.deepEqual(validateMnemonic(`${rep('abandon', 17)} agent`), { ok: true });
  assert.deepEqual(validateMnemonic(`${rep('abandon', 20)} admit`), { ok: true });
});

test('bip39: lista com fim de linha \\r\\n (clone do Windows com autocrlf) dá as mesmas 2048 palavras', async () => {
  const { readFileSync } = await import('node:fs');
  const { parseWordList } = await import('../../src/core/carteiras/bip39.ts');
  const lf = readFileSync(new URL('../../src/core/carteiras/bip39-english.txt', import.meta.url), 'utf8');
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.deepEqual([...parseWordList(crlf)], [...parseWordList(lf)]);
  assert.equal(parseWordList(crlf).get('abandon'), 0);
  assert.equal(parseWordList(crlf).get('zoo'), 2047);
  assert.throws(() => parseWordList(lf.split('\n').slice(0, 100).join('\n')), /corrompida/);
});

test('bip39: o arquivo da lista é o oficial (SHA-256 conferido) e a conferência usa as 2048 palavras', async () => {
  const { createHash } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(new URL('../../src/core/carteiras/bip39-english.txt', import.meta.url));
  assert.equal(createHash('sha256').update(buf).digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
});
