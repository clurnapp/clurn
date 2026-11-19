import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockerCode, CodedError, ERROR_CODES, ERROR_TEXT_PT, explainError, formatErrorPt, LOST_PT } from '../../src/core/limpeza/errors.ts';
import { FeePayerError } from '../../src/core/limpeza/plan.ts';
import { RpcError } from '../../src/core/solana/rpc.ts';

const FRASE_TESTE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ACC = '11111111111111111111111111111112';

test('erros: casos reais viram o código certo', () => {
  assert.equal(explainError('Transfer: insufficient lamports 0, need 240640').code, 'sim-insufficient');
  assert.equal(explainError(new RpcError('HTTP 429', 429, 2000)).code, 'network-down');
  assert.equal(explainError('Program log: Error: Account is frozen').code, 'token-frozen');
  assert.equal(explainError('Transaction results in an account (1) with insufficient funds for rent').code, 'rent-range');
  assert.equal(explainError(new RpcError('Method not found', -32601)).code, 'rpc-blocked');
  assert.equal(explainError({ InstructionError: [0, 'Custom'] }, { stepKind: 'claim-curve' }).code, 'pump-claim-failed');
  assert.equal(explainError(new RpcError('forbidden', 403)).code, 'rpc-blocked');
  assert.equal(explainError(new RpcError('unauthorized', 401)).code, 'rpc-blocked');
  assert.equal(explainError('TransferFeeAmount extension').code, 'token-2022-blocked');
});

test('erros: CodedError mantém código e parâmetros', () => {
  const e = explainError(new CodedError('x', 'dest-lookalike', { index: 4 }));
  assert.equal(e.code, 'dest-lookalike');
  assert.deepEqual(e.params, { index: 4 });
});

test('erros: FeePayerError vira no-fee-sol com temporária e valor (Solflare e Phantom)', () => {
  const e = explainError(new FeePayerError(10_000_000n, 3, ACC));
  assert.equal(e.code, 'no-fee-sol');
  assert.deepEqual(e.params, { walletIndex: 3, wallet: ACC, sendSol: 0.01, walletName: 'temporária N=3', appName: 'Solflare' });
  const you = ERROR_TEXT_PT['no-fee-sol'].you(e.params);
  assert.ok(you.includes('0.01 SOL') && you.includes('Solflare') && you.includes('volta para o destino'));
  // sem walletName/appName nos parâmetros: cai no texto padrão do Solflare, sem "N="
  const old = ERROR_TEXT_PT['no-fee-sol'].you({ walletIndex: 3, wallet: ACC, sendSol: 0.01 });
  assert.ok(old.includes('Solflare') && old.includes('temporária nº 3') && !old.includes('N='));
  const ph = explainError(new FeePayerError(10_000_000n, 3, ACC, 'Conta 4', 'Phantom'));
  const youPh = ERROR_TEXT_PT['no-fee-sol'].you(ph.params);
  assert.ok(youPh.includes('Phantom') && youPh.includes('Conta 4') && !youPh.includes('Solflare') && !youPh.includes('N='));
});

test('erros: a ordem das regras e o tipo do passo', () => {
  // string com os dois textos: "rent" ganha de "insufficient lamports" (é isto que prende a ordem)
  assert.equal(explainError('Transfer: insufficient lamports 5 | InsufficientFundsForRent { account_index: 1 }').code, 'rent-range');
  assert.equal(explainError('qualquer coisa', { stepKind: 'claim-amm' }).code, 'pump-claim-failed');
  // texto específico ganha do tipo do passo
  assert.equal(explainError('Program log: Error: Account is frozen', { stepKind: 'claim-curve' }).code, 'token-frozen');
});

test('erros: entrada estranha não lança e vira unknown', () => {
  for (const raw of [undefined, null, 42, {}, 'xyz']) {
    const e = explainError(raw);
    assert.equal(e.code, 'unknown');
    assert.equal(typeof e.technical, 'string');
  }
});

test('erros: texto técnico cortado em 500', () => {
  assert.equal(explainError('x'.repeat(2000)).technical.length, 500);
});

test('erros: beforeSend falso aparece no resultado', () => {
  assert.equal(explainError('xyz').beforeSend, true);
  assert.equal(explainError('xyz', { beforeSend: false }).beforeSend, false);
});

test('erros: motivos de bloqueio da varredura', () => {
  assert.equal(blockerCode('conta congelada pelo emissor'), 'token-frozen');
  assert.equal(blockerCode('outra carteira tem a autoridade de fechamento'), 'close-authority');
  assert.equal(blockerCode('taxa de transferência retida (Token-2022) impede fechar'), 'token-2022-blocked');
  assert.equal(blockerCode('token não transferível'), 'token-2022-blocked');
  assert.equal(blockerCode('qualquer outra coisa'), 'unknown');
});

test('erros: todo código tem what/app/you em português', () => {
  const p = { walletIndex: 3, wallet: ACC, sendSol: 0.01, index: 2 };
  for (const code of ERROR_CODES) {
    const t = ERROR_TEXT_PT[code];
    assert.ok(t.what(p).length > 0, `${code}: what`);
    assert.ok(t.app(p).length > 0, `${code}: app`);
    assert.equal(typeof t.you(p), 'string', `${code}: you`);
  }
  assert.ok(!ERROR_TEXT_PT['sim-insufficient'].you(p).includes('Mande'));
  assert.equal(LOST_PT.before, 'Não. Nada saiu neste passo.');
  assert.equal(LOST_PT.after, 'Ainda não sabemos. Confira pelo link.');
});

test('erros: o terminal nunca imprime o texto técnico', () => {
  const out = formatErrorPt({ code: 'unknown', params: {}, technical: FRASE_TESTE, beforeSend: true });
  assert.ok(!out.includes(FRASE_TESTE));
  assert.ok(!out.includes('abandon'));
});

test('erros: programa de tokens (SPL e Token-2022) pelo log da rede', () => {
  const T = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  // "insufficient funds" do token não é "insufficient lamports" (SOL): é o saldo da moeda que mudou
  assert.equal(explainError(`Program log: Error: insufficient funds | Program ${T} failed: custom program error: 0x1`).code, 'token-balance-changed');
  assert.equal(explainError(`Program log: Error: Non-native account can only be closed if its balance is zero | Program ${T} failed: custom program error: 0xb`).code, 'token-balance-changed');
  assert.equal(explainError(`Program ${T22} failed: custom program error: 0xB`).code, 'token-balance-changed');
  assert.equal(explainError(`Program ${T} failed: custom program error: 0x11`).code, 'token-frozen');
  assert.equal(explainError(`Program log: Error: owner does not match | Program ${T} failed: custom program error: 0x4`).code, 'token-rejected');
  assert.equal(explainError(`Program log: Error: An account can only be closed if it has no withheld fee | Program ${T22} failed: custom program error: 0x23`).code, 'token-2022-blocked');
  // outro programa com o mesmo número não é do token
  assert.equal(explainError('Program 11111111111111111111111111111111 failed: custom program error: 0x1').code, 'unknown');
});

test('erros: dado sujo no erro do token não lança nem inventa código', () => {
  const T = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  for (const raw of ['custom program error: 0xZZ', `Program ${T} failed: custom program error: 0x`, `Program ${T} failed: custom program error: 0xffffffffffffffffffffff`, { InstructionError: [1, { Custom: 11 }] }, { InstructionError: [1, { Custom: 'onze' }] }, null]) {
    assert.equal(explainError(raw).code, 'unknown', JSON.stringify(raw));
    // no passo de tokens, o desconhecido ainda diz que a conta não saiu
    assert.equal(explainError(raw, { stepKind: 'tokens' }).code, 'token-rejected', JSON.stringify(raw));
  }
});

test('erros: erro da transação inteira (nó atrasado, pagadora sem SOL)', () => {
  assert.equal(explainError('"BlockhashNotFound"').code, 'rpc-out-of-sync');
  assert.equal(explainError('Transaction simulation failed: Blockhash not found').code, 'rpc-out-of-sync');
  assert.equal(explainError('"InsufficientFundsForFee"', { stepKind: 'tokens' }).code, 'payer-no-sol');
  assert.equal(explainError('"AccountNotFound"').code, 'payer-no-sol');
  assert.equal(explainError('Attempt to debit an account but found no record of a prior credit.').code, 'payer-no-sol');
  // a ordem: "InsufficientFundsForFee" não é "InsufficientFundsForRent"
  assert.equal(explainError('InsufficientFundsForRent { account_index: 2 }').code, 'rent-range');
});
