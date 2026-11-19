import { test } from 'node:test';
import assert from 'node:assert/strict';
import { challengeText, checkChallenge, makeChallenge, markChallenge } from '../../src/core/limpeza/confirm.ts';

const DEST = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN';
// endereço "parecido" de golpe: mesmo começo e mesmo fim, meio diferente
const POISON = '5aLz6u2Xabcdefghijkmnpqrstuvwxyz3ZXKM4UN';

test('confirmação: trecho sorteado fica sempre longe do começo e do fim', () => {
  for (let i = 0; i < 500; i++) {
    const c = makeChallenge(DEST);
    assert.ok(c.start >= 8, `começo ${c.start}`);
    assert.ok(c.end <= DEST.length - 8, `fim ${c.end}`);
    assert.equal(c.end - c.start, 4);
  }
});

test('confirmação: a posição muda entre planos', () => {
  const starts = new Set(Array.from({ length: 200 }, () => makeChallenge(DEST).start));
  assert.ok(starts.size > 5);
});

test('confirmação: aceita o trecho certo em maiúscula ou minúscula; recusa os últimos 4 e o resto', () => {
  const c = makeChallenge(DEST, () => 14);
  assert.equal(challengeText(DEST, c), 'JguU');
  assert.equal(markChallenge(DEST, c), '5aLz6u2X5vu4ft[JguU]vJt1pwjf7DftGosLAA3ZXKM4UN');
  assert.ok(checkChallenge('JguU', DEST, c));
  assert.ok(checkChallenge(' jguu ', DEST, c));
  assert.ok(!checkChallenge('M4UN', DEST, c), 'os 4 últimos não servem mais');
  assert.ok(!checkChallenge('', DEST, c));
  assert.ok(!checkChallenge('npm run limpar', DEST, c));
});

// Limite conhecido: isto só vale quando a pessoa digita o meio do endereço CERTO (lido em outro lugar).
// Se ela colou o endereço falso, a tela mostra o meio do falso e passa. Ver confirm.ts.
test('confirmação: o meio do endereço certo não confirma um endereço de golpe com mesmo começo e fim', () => {
  for (let start = 8; start <= DEST.length - 12; start++) {
    const c = { start, end: start + 4 };
    assert.ok(!checkChallenge(challengeText(DEST, c), POISON, c), `posição ${start}`);
  }
});
