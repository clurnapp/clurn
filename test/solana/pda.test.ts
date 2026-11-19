import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  PROGRAMS,
  anchorAccountDiscriminator,
  associatedTokenAddress,
  findProgramAddress,
  isOnCurve,
  pumpAmmCreatorVaultAuthority,
  pumpAmmCreatorVaultAta,
  pumpCreatorVault,
  WSOL_MINT,
} from '../../src/core/solana/pda.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';

// Vetores conferidos na mainnet em 29/10/2026 (contas existentes, dono certo).
const PUMP_CREATOR = 'AVBhCSDEC9MTHt1JgzEncJNDdWZWYwYj4unAXmEcgKDW';

test('PDA global da Pump.fun', () => {
  assert.equal(findProgramAddress(['global'], PROGRAMS.pump).address, '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
});

test('cofre de creator fee da curva (System Program, 650240 lamports na mainnet)', () => {
  assert.equal(pumpCreatorVault(PUMP_CREATOR), '4ELgqDtZKh814jyv18ZwuQGKA8UZxoUkYU1RK9JpYgAN');
});

test('cofre de creator fee do PumpSwap = ATA WSOL da autoridade (conta do Token program na mainnet)', () => {
  assert.equal(pumpAmmCreatorVaultAta(PUMP_CREATOR), '5iQhYWEtqTH66fwLhmtt7cDBP7ieUFbMShnJsuw4NE2X');
  assert.equal(
    associatedTokenAddress(pumpAmmCreatorVaultAuthority(PUMP_CREATOR), WSOL_MINT),
    '5iQhYWEtqTH66fwLhmtt7cDBP7ieUFbMShnJsuw4NE2X',
  );
});

test('ATA muda com o programa de token', () => {
  const owner = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
  assert.notEqual(associatedTokenAddress(owner, WSOL_MINT, PROGRAMS.token), associatedTokenAddress(owner, WSOL_MINT, PROGRAMS.token2022));
});

test('discriminadores Anchor batem com o IDL da Pump.fun', () => {
  assert.equal(anchorAccountDiscriminator('BondingCurve').toString('hex'), '17b7f83760d8ac60');
  assert.equal(anchorAccountDiscriminator('Pool').toString('hex'), 'f19a6d0411b16dbc');
});

test('isOnCurve: chave pública real está na curva, PDA não está', () => {
  assert.ok(isOnCurve(decodeBase58('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')));
  assert.ok(!isOnCurve(decodeBase58('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf')));
  assert.ok(!isOnCurve(new Uint8Array(31)));
});

test('findProgramAddress pula bumps que caem na curva', () => {
  // Para este caso, o bump 255 cai na curva; o resultado precisa ser outro.
  const program = decodeBase58(PROGRAMS.pump);
  let seed = '';
  for (let i = 0; i < 500; i++) {
    const h = createHash('sha256').update(`s${i}`).update(Uint8Array.of(255)).update(program).update('ProgramDerivedAddress').digest();
    if (isOnCurve(h)) {
      seed = `s${i}`;
      break;
    }
  }
  assert.ok(seed, 'achou semente cujo bump 255 cai na curva');
  const { bump, address } = findProgramAddress([seed], PROGRAMS.pump);
  assert.ok(bump < 255);
  assert.ok(!isOnCurve(decodeBase58(address)));
});
