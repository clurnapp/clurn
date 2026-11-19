import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, FeePayerError, rentFor, roundUpToMicroSol, TOKEN_2022_ACCOUNT_MAX_BYTES, TOKEN_ACCOUNT_BYTES, type TokenDecision } from '../../src/core/limpeza/plan.ts';
import { parseTokenAccount, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { BASE_FEE_LAMPORTS } from '../../src/core/limpeza/summary.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1].map((n) => burnerSigner(seed, n));
const DEST = deriveMainAddress(seed);
const RENT0 = 650_240; // mainnet, 30/10/2026 (getMinimumBalanceForRentExemption(0))
const ACC = Array.from({ length: 40 }, (_, i) => burnerSigner(seed, 200 + i).address);
const PER_TX = BigInt(BASE_FEE_LAMPORTS) * 3n;

function tok(account: string, program: 'token' | 'token-2022', amount = '0') {
  return parseTokenAccount(
    { pubkey: account, account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', state: 'initialized', tokenAmount: { amount, decimals: 6 } } } } } },
    S[0].address,
    program,
  );
}
function scan(over: Partial<WalletScan>): WalletScan {
  return { index: 0, address: S[0].address, lamports: 1_000_000_000, tokens: [], fees: null, errors: [], ...over };
}
const plan = (scans: WalletScan[], decisions?: Map<string, TokenDecision>) => buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0, decisions });

test('aluguel sai do valor da rede: bate com o que a mainnet cobrava em 30/10/2026', () => {
  assert.equal(rentFor(0, RENT0), 650_240n);
  assert.equal(rentFor(TOKEN_ACCOUNT_BYTES, RENT0), 1_488_440n, 'getMinimumBalanceForRentExemption(165)');
  assert.equal(rentFor(400, RENT0), 2_682_240n, 'getMinimumBalanceForRentExemption(400)');
  assert.equal(rentFor(TOKEN_ACCOUNT_BYTES, 890_880), 2_039_280n, 'preço antigo: o mesmo 2.039.280 de antes');
  assert.ok(TOKEN_2022_ACCOUNT_MAX_BYTES >= 263, 'cobre todas as extensões que o mint exige na conta');
});

test('reserva: lote que falha vira uma transação por conta; a reserva paga todas', () => {
  // 15 contas vazias = 1 lote; no pior caso, 15 transações + o envio do SOL
  const p = plan([scan({ tokens: ACC.slice(0, 15).map((a) => tok(a, 'token')) })]);
  assert.equal(p.steps.filter((s) => s.kind === 'tokens').length, 1, 'continua um lote só no plano');
  assert.equal(p.reserveNeededLamports, 16n * PER_TX + BigInt(RENT0));
});

test('reserva: enviar token Token-2022 ao destino reserva o aluguel da conta maior', () => {
  const transfer = (program: 'token' | 'token-2022') => {
    const t = tok(ACC[20], program, '5000000');
    return plan([scan({ tokens: [t] })], new Map([[t.account, 'transfer' as const]])).reserveNeededLamports;
  };
  const base = 2n * PER_TX + BigInt(RENT0); // 1 conta + envio do SOL
  assert.equal(transfer('token'), base + rentFor(TOKEN_ACCOUNT_BYTES, RENT0));
  assert.equal(transfer('token-2022'), base + rentFor(TOKEN_2022_ACCOUNT_MAX_BYTES, RENT0));
});

test('reserva: pagadora com 1 lamport a menos que o pior caso pede depósito; com o pior caso, segue', () => {
  const tokens = ACC.slice(0, 15).map((a) => tok(a, 'token'));
  const need = plan([scan({ tokens })]).reserveNeededLamports;
  assert.throws(() => plan([scan({ tokens, lamports: Number(need) - 1 })]), FeePayerError);
  assert.equal(plan([scan({ tokens, lamports: Number(need) })]).reserveNeededLamports, need);
});

// ---------- reserva = pico do saldo da pagadora (pedido do autor, 02/11/2026) ----------
// Caso real: 0,13 a 0,39 SOL pedidos por frase (prints de 01 e 02/11/2026). O aluguel que a pagadora EMPRESTA e
// recebe de volta na mesma transação (cashback, coleta, fee dividida) era somado carteira por carteira; a ATA do
// destino era contada uma vez por conta, mesmo quando várias temporárias mandam a mesma moeda (o app cria a ATA uma
// vez só, "idempotent"); e o pedido era o dobro da reserva.

const fees = (over: Partial<NonNullable<WalletScan['fees']>> = {}) =>
  ({ bondingVault: 'x', bondingVaultLamports: 0, ammVaultAta: 'y', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, ...over }) as NonNullable<WalletScan['fees']>;
const wallets = (n: number, over: (i: number) => Partial<WalletScan>) => Array.from({ length: n }, (_, i) => scan({ index: i, address: burnerSigner(seed, i).address, lamports: 0, ...over(i) }));
const need = (scans: WalletScan[], decisions?: Map<string, TokenDecision>) => {
  try {
    plan(scans, decisions);
  } catch (e) {
    if (e instanceof FeePayerError) return e;
  }
  throw new Error('esperava pedido de depósito');
};
const tokenRent = rentFor(TOKEN_ACCOUNT_BYTES, RENT0);

test('reserva: empréstimo de aluguel que volta na mesma transação conta uma vez (o maior), não por carteira', () => {
  // 100 temporárias com cashback na Pump.fun e no PumpSwap: a pagadora empresta o aluguel a cada uma e recebe de volta
  const scans = wallets(100, () => ({ fees: fees({ cashback: { pump: 1_000_000n, amm: 1_000_000n } }) }));
  const e = need(scans);
  // por carteira: 2 coletas + envio do SOL = 3 transações
  assert.equal(e.reserveLamports, 300n * PER_TX + tokenRent + BigInt(RENT0), 'taxas de todas + o maior empréstimo (ATA WSOL) + o mínimo da pagadora');
});

test('reserva: várias temporárias mandando a mesma moeda ao destino criam a ATA dele uma vez só', () => {
  const MINT2 = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const scans = wallets(10, (i) => {
    const t = tok(ACC[i], 'token-2022', '5000000');
    return { tokens: [i < 5 ? t : { ...t, mint: MINT2 }] };
  });
  const decisions = new Map(scans.map((s) => [s.tokens[0].account, 'transfer' as const]));
  const e = need(scans, decisions);
  // 10 carteiras × (1 conta + envio do SOL) = 20 transações; 2 moedas = 2 ATAs no destino
  assert.equal(e.reserveLamports, 20n * PER_TX + 2n * rentFor(TOKEN_2022_ACCOUNT_MAX_BYTES, RENT0) + BigInt(RENT0));
});

test('reserva: fee dividida cria o cofre da divisão uma vez por moeda; o empréstimo à temporária volta', () => {
  const growth = rentFor(100, RENT0) - BigInt(RENT0);
  const sf = (k: number) => ({ config: ACC[30 + k], mint: ACC[35 + k], bps: 5000, curveFee: 0n, poolSweep: null, ammVault: false, totalLamports: 2_000_000n, shareLamports: 1_000_000n });
  // 6 temporárias na mesma divisão (moeda 0) e 2 delas também na moeda 1
  const scans = wallets(6, (i) => ({ fees: fees({ shared: i < 2 ? [sf(0), sf(1)] : [sf(0)] }) }));
  const e = need(scans);
  const perConfig = BigInt(RENT0) + tokenRent + growth * 2n;
  assert.equal(e.reserveLamports, (8n + 6n) * PER_TX + 2n * perConfig + BigInt(RENT0) + BigInt(RENT0), '8 coletas + 6 envios; 2 cofres; empréstimo de 1 aluguel; mínimo da pagadora');
});

test('pedido de depósito: a reserva com 20% de folga, sem mínimo fixo (nem o dobro, nem 0,01 SOL)', () => {
  // 10 moedas diferentes para o destino: 10 ATAs Token-2022
  const big = wallets(10, (i) => ({ tokens: [{ ...tok(ACC[i], 'token-2022', '5000000'), mint: ACC[20 + i] }] }));
  const e = need(big, new Map(big.map((s) => [s.tokens[0].account, 'transfer' as const])));
  assert.equal(e.sendLamports, roundUpToMicroSol((e.reserveLamports * 12n) / 10n));
  assert.equal(e.sendLamports % 1_000n, 0n, 'em 0,000001 SOL inteiros: a tela mostra exatamente o que tem que chegar');
  // frase pequena: 1 conta vazia (fechar + enviar o SOL) = 2 × 15 000 + 650 240 = 680 240; pedido 816 288 → 0,000817 SOL
  const small = need(wallets(1, () => ({ tokens: [tok(ACC[0], 'token')] })));
  assert.deepEqual([small.reserveLamports, small.sendLamports], [680_240n, 817_000n]);
  assert.ok(small.sendLamports >= BigInt(RENT0), 'o depósito numa conta vazia cobre o aluguel mínimo (senão a rede recusa)');
});
