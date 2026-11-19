import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { MAX_KEYS_PER_CARD, looksLikeKeys, parseKeys, wipeParsedKeys } from '../../src/core/carteiras/keys.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';

// Chaves geradas na hora (nunca uma chave fixa de carteira real): semente de 32 bytes + pública de 32 bytes.
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
  const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  const full = Buffer.concat([seed, pub]);
  return {
    seed,
    pub,
    address: encodeBase58(pub),
    base58: encodeBase58(full),
    json: JSON.stringify([...full]),
    jsonSpaced: `[${[...full].join(', ')}]`,
    hex128: full.toString('hex'),
    hex64: seed.toString('hex'),
  };
}

const FRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('keys: cada formato', () => {
  const k = newKey();
  const forms = [k.base58, k.json, k.jsonSpaced, k.hex128, `0x${k.hex128}`, k.hex128.toUpperCase(), k.hex64, `0x${k.hex64}`];
  for (const form of forms) {
    const r = parseKeys(form);
    assert.ok(r.ok, form.slice(0, 4));
    assert.equal(r.keys.length, 1);
    assert.equal(r.keys[0].address, k.address);
    assert.deepEqual([...r.keys[0].secret], [...k.seed], 'só os 32 bytes da semente');
    assert.equal(r.keys[0].secret.length, 32);
  }
});

test('keys: várias chaves, na ordem, em formatos diferentes', () => {
  const ks = [newKey(), newKey(), newKey()];
  const r = parseKeys([ks[0].base58, ks[1].json, ks[2].hex128].join('\n'));
  assert.ok(r.ok);
  assert.deepEqual(r.keys.map((x) => x.address), ks.map((x) => x.address));
});

// Review Focus 1: do jeito que a área de transferência do Windows entrega
test('keys: lixo em volta da linha é ignorado', () => {
  const ks = [newKey(), newKey(), newKey(), newKey(), newKey()];
  const text = `﻿"${ks[0].base58}",\r\n\r\n  '${ks[1].base58}';\r\n\t${ks[2].hex128} ,\r\n   \r\n${ks[3].json},\r\n"${ks[4].hex64}"\r\n`;
  const r = parseKeys(text);
  assert.ok(r.ok);
  assert.deepEqual(r.keys.map((x) => x.address), ks.map((x) => x.address));
});

test('keys: 64 bytes com pública trocada', () => {
  const a = newKey();
  const b = newKey();
  const swapped = Buffer.concat([a.seed, b.pub]);
  for (const bad of [encodeBase58(swapped), JSON.stringify([...swapped]), swapped.toString('hex')]) {
    const r = parseKeys([b.base58, '', bad, a.base58].join('\n'));
    assert.deepEqual(r, { ok: false, code: 'key-mismatch', params: { line: 3 } });
  }
});

test('keys: endereço público', () => {
  const a = newKey();
  const b = newKey();
  const r = parseKeys([a.base58, b.base58, `"${b.address}",`].join('\r\n'));
  assert.deepEqual(r, { ok: false, code: 'key-looks-address', params: { line: 3 } });
});

// Review Focus 5
test('keys: frase no meio das chaves', () => {
  const a = newKey();
  const b = newKey();
  assert.deepEqual(parseKeys([a.base58, FRASE, b.base58].join('\n')), { ok: false, code: 'key-unknown', params: { line: 2 } });
  assert.deepEqual(parseKeys([FRASE, a.base58].join('\n')), { ok: false, code: 'key-unknown', params: { line: 1 } });
});

test('keys: linha fora de todo formato é desconhecida', () => {
  const a = newKey();
  const full = [...Buffer.concat([a.seed, a.pub])];
  const bads = [
    'abc',
    a.base58.slice(0, -8), // bem cortada: decodifica para outro tamanho
    `${a.base58.slice(0, 10)}0${a.base58.slice(11)}`, // "0" não existe em base58
    JSON.stringify(full.slice(0, 63)), // 63 números
    JSON.stringify([256, ...full.slice(1)]), // número fora de 0 a 255
    JSON.stringify([-1, ...full.slice(1)]),
    a.hex128.slice(0, 126), // hex de outro tamanho
    `${a.hex64}00`,
    `0x${a.hex64.slice(0, 63)}g`,
    a.base58.repeat(50), // linha enorme
  ];
  for (const bad of bads) assert.deepEqual(parseKeys(`${a.base58}\n${bad}`), { ok: false, code: 'key-unknown', params: { line: 2 } }, bad.slice(0, 12));
  // cortada em um caractere: às vezes ainda dá 64 bytes, e aí a pública não confere; nunca é aceita
  const cut = parseKeys(`${a.base58}\n${a.base58.slice(0, -1)}`);
  assert.ok(!cut.ok && ['key-unknown', 'key-mismatch'].includes(cut.code) && cut.params.line === 2);
});

test('keys: repetida no mesmo texto', () => {
  const a = newKey();
  const b = newKey();
  assert.deepEqual(parseKeys([a.base58, b.base58, a.base58].join('\n')), { ok: false, code: 'key-duplicate', params: { line: 3 } });
  // a mesma chave em outro formato também é repetida
  assert.deepEqual(parseKeys([a.base58, b.base58, a.hex64].join('\n')), { ok: false, code: 'key-duplicate', params: { line: 3 } });
});

test('keys: 201 linhas', () => {
  assert.equal(MAX_KEYS_PER_CARD, 200);
  const ks = Array.from({ length: MAX_KEYS_PER_CARD + 1 }, () => newKey());
  const ok = parseKeys(ks.slice(0, MAX_KEYS_PER_CARD).map((k) => k.base58).join('\n\n'));
  assert.ok(ok.ok, '200 chaves cabem, linhas vazias não contam');
  assert.equal(ok.keys.length, MAX_KEYS_PER_CARD);
  assert.deepEqual(parseKeys(ks.map((k) => k.base58).join('\n')), { ok: false, code: 'too-many-keys', params: { max: MAX_KEYS_PER_CARD } });
});

test('keys: nenhum erro contém o texto', () => {
  const a = newKey();
  const b = newKey();
  const swapped = Buffer.concat([a.seed, b.pub]);
  const many = Array.from({ length: MAX_KEYS_PER_CARD + 1 }, () => newKey().hex128);
  const cases = [
    [a.base58, encodeBase58(swapped)],
    [a.hex128, swapped.toString('hex')],
    [a.json, JSON.stringify([...swapped])],
    [a.base58, b.address],
    [a.base58, FRASE, b.base58],
    [a.base58, a.base58.slice(0, -1)],
    [a.base58, `${a.hex64}00`],
    [a.base58, b.json, a.hex64],
    many,
  ];
  for (const lines of cases) {
    const r = parseKeys(lines.join('\r\n'));
    assert.equal(r.ok, false);
    const out = JSON.stringify(r);
    for (const line of lines) {
      const s = line.trim();
      for (let i = 0; i + 8 <= s.length; i++) assert.ok(!out.includes(s.slice(i, i + 8)), `trecho da entrada no erro ${out}`);
    }
  }
});

test('keys: wipe zera os bytes', () => {
  const r = parseKeys([newKey().base58, newKey().hex64].join('\n'));
  assert.ok(r.ok);
  const secrets = r.keys.map((k) => k.secret);
  assert.ok(secrets.every((s) => s.some((x) => x !== 0)));
  wipeParsedKeys(r.keys);
  assert.ok(secrets.every((s) => s.length === 32 && s.every((x) => x === 0)));
});

test('keys: quando o texto parece chaves', () => {
  const a = newKey();
  const b = newKey();
  assert.equal(looksLikeKeys(a.base58), true);
  assert.equal(looksLikeKeys(`"${a.base58}",\r\n\r\n${b.hex128}\r\n`), true);
  assert.equal(looksLikeKeys(a.jsonSpaced), true, 'array com espaço depois da vírgula');
  assert.equal(looksLikeKeys(b.address), true, 'endereço vai para o parser, que o recusa pela linha');
  assert.equal(looksLikeKeys([a.base58, FRASE].join('\n')), true, 'mistura: o parser aponta a linha da frase');
  assert.equal(looksLikeKeys(FRASE), false);
  assert.equal(looksLikeKeys(FRASE.split(' ').join('\r\n')), false, 'frase com uma palavra por linha continua frase');
  assert.equal(looksLikeKeys(` ${FRASE} \n\n`), false);
  assert.equal(looksLikeKeys(''), false);
  assert.equal(looksLikeKeys('  \n '), false);
});
