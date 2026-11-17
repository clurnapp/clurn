import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { MAX_FRASES, parseFrases } from '../../src/app/frases.ts';
import { derivePrivateKey, mnemonicToSeed, standardPath, trustPath } from '../../src/core/carteiras/derivation.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';
import { CodedError } from '../../src/core/limpeza/errors.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.pastedKeys = true;
FEATURES.trustPath = true;

// vetores oficiais do BIP39 (entropia fixa 0x00, 0x7f e 0x80): públicos, nunca frases reais
const A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const B = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const item = (texto: string, carteira: 'solflare' | 'phantom' = 'solflare') => ({ texto, carteira });

test('frases: duplicata com espaços e maiúsculas diferentes é marcada na segunda', () => {
  const r = parseFrases([item(A), item(B), item(`  ${A.toUpperCase().replace(/ /g, '   ')}\n`)]);
  assert.equal(r[0].error, null);
  assert.ok(r[0].seed && r[0].seed.length === 64);
  assert.equal(r[1].error, null);
  assert.equal(r[2].seed, null);
  assert.deepEqual(r[2].error, { code: 'seed-duplicate', params: { of: 1 } });
  assert.deepEqual(r.map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(r.map((x) => x.app), ['solflare', 'solflare', 'solflare']);
});

// Ruling 9: Solflare usa só o ramo 10000+ e a Phantom nunca assina a Conta 1, então a mesma frase nas duas
// não tem carteira em comum: não é repetida. Repetida é a mesma frase no MESMO app.
test('frases: a mesma frase como Solflare e como Phantom não é repetida; duas vezes Phantom é', () => {
  const r = parseFrases([item(A), item(A.toUpperCase(), 'phantom'), item(`  ${A}  `, 'phantom'), item(B, 'phantom')]);
  assert.equal(r[0].error, null);
  assert.equal(r[1].error, null, 'Phantom depois de Solflare, mesma frase: aceita');
  assert.ok(r[1].seed && r[0].seed && r[1].seed.equals(r[0].seed), 'mesma seed (a frase é a mesma)');
  assert.deepEqual(r[2].error, { code: 'seed-duplicate', params: { of: 2 } });
  assert.equal(r[2].seed, null);
  assert.equal(r[3].error, null);
});

// 'auto' lê os dois apps: a mesma frase de novo, em qualquer app, é repetida
test("frases: 'auto' é aceito e repete a mesma frase em qualquer app", () => {
  const auto = (texto: string) => ({ texto, carteira: 'auto' });
  const r = parseFrases([auto(A), item(A), item(A, 'phantom'), auto(` ${A.toUpperCase()} `), auto(B)]);
  assert.deepEqual(r.map((x) => x.app), ['auto', 'solflare', 'phantom', 'auto', 'auto']);
  assert.equal(r[0].error, null);
  assert.deepEqual(r.slice(1, 4).map((x) => x.error), Array(3).fill({ code: 'seed-duplicate', params: { of: 1 } }));
  assert.ok(r.slice(1, 4).every((x) => x.seed === null));
  assert.ok(r[4].seed && r[4].error === null);
  const r2 = parseFrases([item(A, 'phantom'), auto(A)]);
  assert.deepEqual(r2[1].error, { code: 'seed-duplicate', params: { of: 1 } }, 'explícito antes de auto também');
});

test('frases: uma inválida não derruba as outras', () => {
  const r = parseFrases([item(A), item('abandon abandon xyzzy'), item(B)]);
  assert.ok(r[0].seed && r[0].error === null);
  assert.equal(r[1].seed, null);
  assert.equal(r[1].error?.code, 'seed-words');
  assert.ok(r[2].seed && r[2].error === null);
  const r2 = parseFrases([item(A), item('abandon abandon abandon abandon abandon abandon xyzzy abandon abandon abandon abandon about'), item(B)]);
  assert.equal(r2[1].error?.code, 'seed-unknown-word');
  assert.deepEqual(r2[1].error?.params, { position: 7 });
  assert.ok(r2[0].seed && r2[2].seed);
});

test('frases: item de formato estranho (nulo, sem texto, carteira desconhecida) vira erro do item', () => {
  const r = parseFrases([null, { texto: 42, carteira: 'solflare' }, { texto: A, carteira: 'metamask' }, item(C)]);
  assert.equal(r[0].error?.code, 'seed-words');
  assert.equal(r[1].error?.code, 'seed-words');
  assert.equal(r[2].error?.code, 'unknown');
  assert.equal(r[2].seed, null);
  assert.ok(r[3].seed);
});

test('frases: 11 frases → too-many-frases; lista vazia ou que não é lista também recusa', () => {
  assert.equal(MAX_FRASES, 10);
  const onze = Array.from({ length: 11 }, () => item(A));
  assert.throws(() => parseFrases(onze), (e: unknown) => e instanceof CodedError && e.code === 'too-many-frases');
  assert.equal(parseFrases(onze.slice(0, 10)).length, 10);
  for (const vazio of [[], null, undefined, 'x', {}]) {
    assert.throws(() => parseFrases(vazio), (e: unknown) => e instanceof CodedError && e.code === 'seed-words' && e.params.words === 0);
  }
});

test('frases: o texto não fica em nenhum campo do resultado nem na mensagem de erro', () => {
  const ruim = 'legal winner thank year wave sausage worth useful legal winner thank qwertyuiop';
  const r = parseFrases([item(A), item(B), item(A), item(ruim), item(C)]);
  const json = JSON.stringify(r);
  for (const w of new Set([...A.split(' '), ...B.split(' '), ...C.split(' '), 'qwertyuiop'])) {
    assert.doesNotMatch(json, new RegExp(`\\b${w}\\b`), `a palavra "${w}" apareceu no resultado`);
  }
  assert.doesNotMatch(json, /qwertyuiop/);
});

// ---------- cartão de chaves privadas (fase 1 multirredes, Task 5) ----------
// Chaves geradas na hora (nunca de carteira real). A principal de uma frase sai do vetor público A.

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32));
  const pub = Buffer.from(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address: encodeBase58(pub), base58: encodeBase58(Buffer.concat([seed, pub])), hex64: seed.toString('hex') };
}
const auto = (texto: string) => ({ texto, carteira: 'auto' });
// chave (semente em hex) da conta de um caminho da frase: a principal da Phantom/Solflare e a da Trust
const keyAt = (frase: string, path: string) => derivePrivateKey(mnemonicToSeed(frase), path).toString('hex');

test("frases: 'auto' com lista de chaves vira cartão de chaves; texto vazio continua erro de frase", () => {
  const [a, b] = [newKey(), newKey()];
  const r = parseFrases([auto(`${a.base58}\n\n${b.hex64}\n`), auto(A), auto(''), item(a.base58)]);
  assert.equal(r[0].app, 'chaves');
  assert.equal(r[0].error, null);
  assert.equal(r[0].seed, null);
  assert.deepEqual(r[0].keys!.map((k) => [k.address, k.line]), [[a.address, 1], [b.address, 3]]);
  assert.ok(r[1].seed && r[1].keys === null && r[1].app === 'auto');
  assert.equal(r[2].error?.code, 'seed-words', 'vazio: erro de frase vazia, como antes');
  assert.equal(r[3].app, 'solflare');
  assert.equal(r[3].keys, null, "carteira explícita ('solflare') é sempre frase");
  assert.ok(r[3].error);
});

test('frases: chave repetida entre cartões → key-duplicate com a linha e o cartão da primeira', () => {
  const [a, b, c] = [newKey(), newKey(), newKey()];
  const r = parseFrases([auto(`${a.base58}\n${b.base58}`), auto(A), auto(`${c.base58}\n${b.hex64}`)]);
  assert.equal(r[0].error, null);
  assert.deepEqual(r[2].error, { code: 'key-duplicate', params: { line: 2, of: 1 } });
  assert.equal(r[2].keys, null, 'o cartão recusado não leva chave nenhuma');
  assert.equal(r[2].app, 'chaves');
  // a chave do cartão recusado não vale como "primeira" para um terceiro
  const r2 = parseFrases([auto(a.base58), auto(`${a.base58}\n${c.base58}`), auto(c.base58)]);
  assert.deepEqual(r2[1].error, { code: 'key-duplicate', params: { line: 1, of: 1 } });
  assert.equal(r2[2].error, null);
});

test('frases: chave da conta principal de uma frase da lista → key-is-main, antes ou depois da frase', () => {
  const x = newKey();
  const phantomMain = keyAt(A, standardPath(0));
  const trustMain = keyAt(B, trustPath(0));
  const r = parseFrases([auto(`${x.base58}\n${phantomMain}`), auto(A), auto(B), auto(`\n${trustMain}`)]);
  assert.deepEqual(r[0].error, { code: 'key-is-main', params: { line: 2, of: 2 } });
  assert.deepEqual(r[3].error, { code: 'key-is-main', params: { line: 2, of: 3 } });
  assert.ok(r[1].seed && r[2].seed, 'as frases seguem');
  // conta comum (não principal) da frase não é recusada aqui: se for burner, entra pela frase na análise
  const r2 = parseFrases([auto(A), auto(keyAt(A, standardPath(3)))]);
  assert.equal(r2[1].error, null);
  // repetida da frase recusada não conta: a frase que não passou não tem principal
  const r3 = parseFrases([auto(`${A} extra`), auto(phantomMain)]);
  assert.equal(r3[1].error, null);
});

test('frases: nenhum erro de cartão de chaves contém pedaço da chave', () => {
  const [a, b] = [newKey(), newKey()];
  const lines = [a.base58, b.base58.slice(0, -2), keyAt(A, standardPath(0))];
  const r = parseFrases([auto(`${a.base58}\n${b.base58.slice(0, -2)}`), auto(A), auto(lines[2]), auto(`${b.base58}\n${a.base58}`)]);
  assert.deepEqual(r.map((x) => x.error?.code ?? null), ['key-unknown', null, 'key-is-main', null]);
  const errors = JSON.stringify(r.map((x) => x.error));
  for (const l of lines) for (let i = 0; i + 8 <= l.length; i++) assert.ok(!errors.includes(l.slice(i, i + 8)), 'pedaço de chave no erro');
});

// ---------- 1.0: chaves coladas desligadas (src/core/features.ts, congelamento de 16/11/2026) ----------

test('1.0: chaves coladas desligadas → cartão recusado com keys-off, sem ler nenhuma chave e sem eco do texto', () => {
  FEATURES.pastedKeys = false;
  try {
    const k1 = newKey();
    const k2 = newKey();
    const r = parseFrases([{ texto: `${k1.base58}\n${k2.base58}`, carteira: 'auto' }, { texto: 'abandon '.repeat(11) + 'about', carteira: 'auto' }]);
    assert.deepEqual([r[0].app, r[0].keys, r[0].seed, r[0].error?.code], ['chaves', null, null, 'keys-off']);
    assert.ok(!JSON.stringify(r[0]).includes(k1.base58.slice(0, 12)), 'nada da chave no resultado');
    // a frase ao lado segue normal
    assert.equal(r[1].error, null);
    assert.ok(r[1].seed);
  } finally {
    FEATURES.pastedKeys = true;
  }
});
