import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProtectedAccounts, phantomBurnerIndexes, reviewPhantomAccounts } from '../../src/core/carteiras/accounts.ts';
import { burnerSigner, deriveBurner, mnemonicToSeed, walletLabel, walletPath } from '../../src/core/carteiras/derivation.ts';
import { discoverBurners, parseTokenAccount, type WalletScan } from '../../src/core/limpeza/scan.ts';
import type { RpcClient } from '../../src/core/solana/rpc.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');

test('Phantom: contas comuns m/44\'/501\'/N\'/0\'; Conta 1 = a principal que a Phantom/Solflare mostram', () => {
  assert.equal(walletPath('phantom', 0), "m/44'/501'/0'/0'");
  assert.equal(deriveBurner(seed, 0, 'phantom').address, 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  assert.equal(walletLabel('phantom', 2), 'Conta 3');
  assert.equal(walletLabel('solflare', 2), 'N=2');
  assert.equal(walletPath('solflare', 0), "m/44'/501'/10000'/0'/0'", 'Solflare continua no ramo das temporárias');
});

test('Phantom: o app se recusa a criar chave para a Conta 1', () => {
  assert.throws(() => burnerSigner(seed, 0, 'phantom'), /Conta 1 é a principal/);
  assert.equal(burnerSigner(seed, 1, 'phantom').address, deriveBurner(seed, 1, 'phantom').address);
  assert.doesNotThrow(() => burnerSigner(seed, 0, 'solflare'), 'na Solflare o N=0 é uma temporária');
});

test('Phantom: descoberta varre as contas comuns', async () => {
  const used = new Set([0, 1, 2].map((n) => deriveBurner(seed, n, 'phantom').address));
  const rpc: RpcClient = { call: async <T>(_m: string, p: unknown[]) => (used.has(p[0] as string) ? [{ signature: 'x' }] : []) as T };
  const d = await discoverBurners(seed, rpc, { app: 'phantom', gap: 5 });
  assert.deepEqual(d.wallets.map((w) => w.address), [...used]);
});

test('Phantom: só limpa contas encontradas menos a Conta 1 e as protegidas', () => {
  const found = [0, 1, 2, 3, 4].map((index) => ({ index }));
  assert.deepEqual(phantomBurnerIndexes(found, new Set()), [1, 2, 3, 4]);
  assert.deepEqual(phantomBurnerIndexes(found, new Set([3])), [1, 2, 4]);
  assert.deepEqual(phantomBurnerIndexes(found, new Set([0])), [1, 2, 3, 4]);
});

test('Phantom: contas a proteger digitadas como na Phantom (1, 2, 3…)', () => {
  const existing = new Set([0, 1, 2, 3]);
  assert.deepEqual([...parseProtectedAccounts('3, 4', existing)], [2, 3]);
  assert.deepEqual([...parseProtectedAccounts('', existing)], []);
  assert.throws(() => parseProtectedAccounts('9', existing), /Conta 9 não está na lista/);
  assert.throws(() => parseProtectedAccounts('dois', existing), /não é um número/);
});

const scan = (index: number, over: Partial<WalletScan> = {}): WalletScan => ({ index, address: `A${index}`, lamports: 0, tokens: [], fees: null, errors: [], ...over });

test('Phantom: diferenças viram alerta (Conta 1 sem uso; conta com valor relevante)', () => {
  const usdc = parseTokenAccount({ pubkey: 'T1', account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'USDCmint', state: 'initialized', tokenAmount: { amount: '5000000', decimals: 6 } } } } } }, 'A2', 'token');
  const r = reviewPhantomAccounts(
    [{ index: 0, address: 'A0', hasHistory: false }, { index: 1, address: 'A1', hasHistory: true }, { index: 2, address: 'A2', hasHistory: true }, { index: 3, address: 'A3', hasHistory: true }],
    [scan(0), scan(1, { lamports: 2_000_000 }), scan(2, { tokens: [usdc] }), scan(3, { lamports: 80_000_000 })],
    new Map(),
    new Map([['USDCmint', { mint: 'USDCmint', symbol: 'USDC', name: null, price: null, category: 'estável' }]]),
  );
  assert.match(r.warnings.join(), /Conta 1 nunca foi usada/);
  assert.deepEqual(r.accounts[1].warnings, [], 'burner típica: sem alerta');
  assert.match(r.accounts[2].warnings.join(), /token\(s\) de valor/);
  assert.match(r.accounts[3].warnings.join(), /0,0800|0\.0800 SOL solto/);
  assert.equal(r.accounts[0].isMain, true);
});

test('Phantom: Conta 1 usada e burners sem valor → nenhum alerta', () => {
  const r = reviewPhantomAccounts([{ index: 0, address: 'A0', hasHistory: true }, { index: 1, address: 'A1', hasHistory: true }], [scan(0, { lamports: 5e9 }), scan(1)], new Map());
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.accounts.flatMap((a) => a.warnings), [], 'saldo da principal não é alerta');
});

test('Phantom: aviso de falta de SOL para taxas fala em "Conta N" e na Phantom', async () => {
  const { buildPlan, FeePayerError } = await import('../../src/core/limpeza/plan.ts');
  const t = parseTokenAccount({ pubkey: 'Acc1111111111111111111111111111111111111111', account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'M', state: 'initialized', tokenAmount: { amount: '0', decimals: 0 } } } } } }, 'A3', 'token');
  assert.throws(
    () => buildPlan({ scans: [scan(3, { tokens: [t] })], prices: new Map(), destination: 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', rentExemptZero: 890_880, walletName: (i) => walletLabel('phantom', i), appName: 'Phantom' }),
    (e: Error) => e instanceof FeePayerError && /sua carteira \(Phantom\) para a Conta 4: A3/.test(e.message),
  );
});

test('Phantom no app: seleção vinda da página (proteger contas + confirmar quantas)', async () => {
  const { phantomSelection } = await import('../../src/core/carteiras/accounts.ts');
  const found = [0, 1, 2, 3].map((index) => ({ index }));
  assert.deepEqual(phantomSelection(found, [], 3), { burners: new Set([1, 2, 3]) });
  assert.deepEqual(phantomSelection(found, [3], 2), { burners: new Set([1, 3]) }, 'protegeu a Conta 3');
  assert.deepEqual(phantomSelection(found, [1], 3), { burners: new Set([1, 2, 3]) }, 'Conta 1 já é protegida sempre');
  assert.match((phantomSelection(found, [], 2) as { error: string }).error, /são 3/, 'confirmação errada');
  assert.match((phantomSelection(found, [9], 3) as { error: string }).error, /Conta 9 não está na lista/);
  assert.match((phantomSelection(found, [2, 3, 4], 0) as { error: string }).error, /todas estão protegidas/);
  assert.match((phantomSelection(found, 'tudo', 3) as { error: string }).error, /inválida/);
  assert.match((phantomSelection(found, [], undefined) as { error: string }).error, /Confirme/);
});

// selectAccounts: a mesma seleção com o índice da principal como parâmetro (Trust: 0; chaves: null)
test('selectAccounts: índice da principal como parâmetro', async () => {
  const { selectAccounts, phantomSelection } = await import('../../src/core/carteiras/accounts.ts');
  const found = [0, 1, 2, 3].map((index) => ({ index }));
  assert.deepEqual(selectAccounts(found, [], 3, 0), { burners: new Set([1, 2, 3]) }, 'principal 0 nunca entra');
  assert.deepEqual(selectAccounts(found, [1], 3, 0), { burners: new Set([1, 2, 3]) }, 'proteger a principal não muda nada');
  assert.deepEqual(selectAccounts(found, [], 4, null), { burners: new Set([0, 1, 2, 3]) }, 'sem principal, todas passam pela conferência');
  assert.deepEqual(selectAccounts(found, [1], 3, null), { burners: new Set([1, 2, 3]) }, 'sem principal, a 1ª se protege como as outras');
  assert.match((selectAccounts(found, [], 3, null) as { error: string }).error, /são 4/);
  assert.deepEqual(phantomSelection(found, [], 3), selectAccounts(found, [], 3, 0));
});
