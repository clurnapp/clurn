import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { balancesOnly, BASICS_PER_CALL, REREAD_WAITS_MS, unreadParts, cleanupScanOptions, CURVE_SLICE, discoverBurners, MIN_SWEEP_LAMPORTS, parseTokenAccount, POOL_SLICE, scanWallet, scanWallets, SEARCH_GAP, SEARCH_MAX, totalCreatorFeeLamports, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';
import { deriveBurner, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { createRpc, RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { fetchPrices, looksLikeImpostor, sanitizeText } from '../../src/core/limpeza/prices.ts';
import { formatSol, formatTokenAmount, summarize } from '../../src/core/limpeza/summary.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const OWNER = 'JoaN8oYmp6Z9yTrmuQ6HmDie5pX67pTibNXMSLRBn71';

type Handler = (params: unknown[]) => unknown;
function fakeRpc(handlers: Record<string, Handler>): RpcClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      const h = handlers[method];
      if (!h) throw new RpcError(`${method}: sem handler no teste`);
      return h(params) as T;
    },
  };
}

function tokenRaw(over: Record<string, unknown> = {}, pubkey = 'Acc1111111111111111111111111111111111111111') {
  return {
    pubkey,
    account: {
      lamports: 2_039_280,
      data: {
        parsed: {
          info: {
            mint: 'Mint111111111111111111111111111111111111111',
            owner: OWNER,
            state: 'initialized',
            tokenAmount: { amount: '0', decimals: 6 },
            ...over,
          },
        },
      },
    },
  };
}

// ---------- descoberta ----------

test('descoberta: para após a folga e devolve só até a última com histórico', async () => {
  const used = new Set([0, 1, 2, 5].map((n) => deriveBurner(seed, n).address));
  const rpc = fakeRpc({ getSignaturesForAddress: ([addr]) => (used.has(addr as string) ? [{ signature: 'x' }] : []) });
  const d = await discoverBurners(seed, rpc, { max: 100, gap: 7, batch: 3 });
  assert.deepEqual(d.wallets.map((w) => w.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(d.wallets.map((w) => w.hasHistory), [true, true, true, false, false, true]);
  assert.equal(d.reachedMax, false);
  assert.ok(d.checked >= 13 && d.checked <= 15); // 5 + folga de 7, arredondado ao lote
});

test('descoberta automática: sem limites informados, acha 150 temporárias e para na folga (antes cortava em 100)', async () => {
  const used = new Set(Array.from({ length: 150 }, (_, n) => deriveBurner(seed, n).address));
  const rpc = fakeRpc({ getSignaturesForAddress: ([addr]) => (used.has(addr as string) ? [{ signature: 'x' }] : []) });
  const d = await discoverBurners(seed, rpc);
  assert.equal(d.wallets.length, 150);
  assert.equal(d.reachedMax, false);
  assert.ok(d.checked >= 150 + SEARCH_GAP && d.checked <= 150 + SEARCH_GAP + 10, `parou na folga, não no teto (${d.checked})`);
  assert.equal(rpc.calls.length, d.checked, '1 consulta por endereço: o teto alto não gasta crédito');
  assert.equal(SEARCH_MAX, 2000);
});

test('descoberta: avisa quando bate no limite sem achar a folga', async () => {
  const rpc = fakeRpc({ getSignaturesForAddress: () => [{ signature: 'x' }] });
  const d = await discoverBurners(seed, rpc, { max: 12, gap: 5 });
  assert.equal(d.wallets.length, 12);
  assert.equal(d.reachedMax, true);
});

test('descoberta: seed sem temporárias usadas devolve lista vazia', async () => {
  const rpc = fakeRpc({ getSignaturesForAddress: () => [] });
  const d = await discoverBurners(seed, rpc, { max: 100, gap: 20 });
  assert.equal(d.wallets.length, 0);
  assert.equal(d.reachedMax, false);
});

test('descoberta: endereços derivados são os do ramo 10000+, nunca a principal', async () => {
  const seen: string[] = [];
  const rpc = fakeRpc({ getSignaturesForAddress: ([a]) => (seen.push(a as string), []) });
  await discoverBurners(seed, rpc, { gap: 5 });
  assert.equal(seen[0], '9Jpe1mHmpRktDwJ6ridosdnkrbRPkuQsvCxLn71F2sFV');
  assert.ok(!seen.includes('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'));
});

// ---------- contas de token ----------

test('token: classifica vazia, NFT, fungível e WSOL', () => {
  assert.equal(parseTokenAccount(tokenRaw(), OWNER, 'token').kind, 'empty');
  assert.equal(parseTokenAccount(tokenRaw({ tokenAmount: { amount: '1', decimals: 0 } }), OWNER, 'token').kind, 'nft');
  assert.equal(parseTokenAccount(tokenRaw({ tokenAmount: { amount: '5000', decimals: 6 } }), OWNER, 'token').kind, 'fungible');
  assert.equal(parseTokenAccount(tokenRaw({ isNative: true, tokenAmount: { amount: '10', decimals: 9 } }), OWNER, 'token').kind, 'wsol');
});

test('token: dado fora do formato vira "invalid" sem lançar erro', () => {
  for (const bad of [
    tokenRaw({ tokenAmount: { amount: 'abc', decimals: 6 } }),
    tokenRaw({ tokenAmount: { amount: null, decimals: 6 } }),
    tokenRaw({ tokenAmount: { amount: '-5', decimals: 6 } }),
    tokenRaw({ tokenAmount: { amount: '5', decimals: null } }),
    tokenRaw({ mint: null }),
    { pubkey: null },
    {},
    null as never,
  ]) {
    const t = parseTokenAccount(bad, OWNER, 'token');
    assert.equal(t.kind, 'invalid');
    assert.ok(t.blockers.length > 0);
  }
});

test('token: bloqueios de congelada, autoridade alheia, taxa retida e não transferível', () => {
  assert.match(parseTokenAccount(tokenRaw({ state: 'frozen' }), OWNER, 'token').blockers.join(), /congelada/);
  assert.match(parseTokenAccount(tokenRaw({ closeAuthority: 'Outro11111111111111111111111111111111111111' }), OWNER, 'token').blockers.join(), /autoridade/);
  assert.equal(parseTokenAccount(tokenRaw({ closeAuthority: OWNER }), OWNER, 'token').blockers.length, 0);
  const withheld = tokenRaw({ extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: 7 } }] });
  assert.match(parseTokenAccount(withheld, OWNER, 'token-2022').blockers.join(), /retida/);
  const zeroWithheld = tokenRaw({ extensions: [{ extension: 'transferFeeAmount', state: { withheldAmount: 0 } }] });
  assert.equal(parseTokenAccount(zeroWithheld, OWNER, 'token-2022').blockers.length, 0);
  const nt = tokenRaw({ extensions: [{ extension: 'nonTransferableAccount' }], tokenAmount: { amount: '5', decimals: 0 } });
  assert.match(parseTokenAccount(nt, OWNER, 'token-2022').blockers.join(), /não transferível/);
  const ntEmpty = tokenRaw({ extensions: [{ extension: 'nonTransferableAccount' }] });
  assert.equal(parseTokenAccount(ntEmpty, OWNER, 'token-2022').blockers.length, 0, 'vazia pode ser fechada e devolver o aluguel');
});

// ---------- varredura de carteira ----------

// saldo + cofres vêm em lote: [carteira, cofre da curva, cofre do PumpSwap] por carteira
const WALLET_ACC = { lamports: 1_500_000 };
const VAULT_ACC = { lamports: 650_240 + 1_000_000 };
const ATA_ACC = { lamports: 2_039_280, data: { parsed: { info: { tokenAmount: { amount: '3000000' } } } } };
function basicsHandler(per: (wallet: string) => unknown[] = () => [WALLET_ACC, VAULT_ACC, ATA_ACC]): Handler {
  return ([addrs]) => {
    const keys = addrs as string[];
    const value: unknown[] = [];
    for (let i = 0; i < keys.length; i += 3) {
      assert.equal(keys[i + 1], pumpCreatorVault(keys[i]), 'cofre da curva logo depois da carteira');
      assert.equal(keys[i + 2], pumpAmmCreatorVaultAta(keys[i]), 'cofre do PumpSwap em seguida');
      value.push(...per(keys[i]));
    }
    return { value };
  };
}

// uma moeda criada pela carteira com 400.000 lamports de fee parada na curva (+ uma curva antiga, curta)
const MINT_A = deriveBurner(seed, 40).address; // qualquer endereço válido serve de mint
const CURVE_A = findProgramAddress(['bonding-curve', decodeBase58(MINT_A)], PROGRAMS.pump).address;
const CURVE_OLD = findProgramAddress(['bonding-curve', decodeBase58(deriveBurner(seed, 41).address)], PROGRAMS.pump).address;
function curveSlice(fee: bigint): string {
  const b = Buffer.alloc(CURVE_SLICE.length);
  b.writeBigUInt64LE(fee, 125 - CURVE_SLICE.offset);
  return b.toString('base64');
}

function walletRpc(over: Partial<Record<string, Handler>> = {}) {
  return fakeRpc({
    getTokenAccountsByOwner: ([owner, filter]) => {
      // a curva é dona da conta de token da própria moeda (é assim que o app acha o mint)
      if (owner === CURVE_A) return { value: (filter as { programId: string }).programId === PROGRAMS.token2022 ? [{ pubkey: 'x', account: { data: { parsed: { info: { mint: MINT_A } } } } }] : [] };
      return (filter as { programId: string }).programId === PROGRAMS.token
        ? { value: [tokenRaw(), tokenRaw(), tokenRaw({ tokenAmount: { amount: '42', decimals: 0 } }, 'Acc2222222222222222222222222222222222222222')] }
        : { value: [tokenRaw({}, 'Acc3333333333333333333333333333333333333333')] };
    },
    // saldo + cofres pelo basicsHandler; as outras leituras em lote (cashback, fee dividida) acham contas inexistentes
    getMultipleAccounts: (p) => {
      const keys = p[0] as string[];
      return keys.length % 3 === 0 && keys[1] === pumpCreatorVault(keys[0]) ? basicsHandler()(p) : { value: keys.map(() => null) };
    },
    getProgramAccounts: ([program]) => {
      if (program === PROGRAMS.pump) return [{ pubkey: CURVE_A, account: { data: [curveSlice(400_000n), 'base64'] } }, { pubkey: CURVE_OLD, account: { data: ['', 'base64'] } }];
      return [];
    },
    ...over,
  });
}

test('carteira: soma SOL, tokens (sem repetir conta), cofres e fee parada na curva', async () => {
  const s = await scanWallet(walletRpc(), { index: 1, address: OWNER }, { rentExemptZero: 650_240, detailedFees: true });
  assert.deepEqual(s.errors, []);
  assert.equal(s.lamports, 1_500_000);
  assert.equal(s.tokens.length, 3, 'conta repetida aparece uma vez só');
  assert.equal(s.fees?.bondingVaultLamports, 1_000_000);
  assert.equal(s.fees?.ammVaultLamports, 3_000_000);
  assert.deepEqual(s.fees?.curveSweeps, [{ curve: CURVE_A, mint: MINT_A, lamports: 400_000n }]);
  assert.equal(s.fees?.unsweptCurveLamports, 0n, 'a fee parada desta moeda é coletada');
  assert.equal(s.fees?.coinsOnCurve, 2, 'curva antiga sem o campo conta como moeda e soma 0');
});

test('carteira: falha em uma etapa não derruba as outras', async () => {
  const rpc = walletRpc({
    getTokenAccountsByOwner: () => {
      throw new RpcError('getTokenAccountsByOwner: HTTP 503', 503);
    },
  });
  const s = await scanWallet(rpc, { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.equal(s.lamports, 1_500_000);
  assert.ok(s.fees);
  assert.equal(s.errors.length, 1);
  assert.match(s.errors[0], /contas de token: .*503/);
});

test('carteira: modo sem detalhe não chama getProgramAccounts', async () => {
  const rpc = walletRpc();
  const s = await scanWallet(rpc, { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.equal(s.fees?.detailed, false);
  assert.ok(!rpc.calls.includes('getProgramAccounts'));
});

test('carteira: saldo e cofres fora do formato viram erro parcial ou zero, nunca exceção', async () => {
  const sujo = walletRpc({ getMultipleAccounts: basicsHandler(() => [{ lamports: 'muito' }, { lamports: 'x' }, { data: { parsed: { info: { tokenAmount: { amount: '1e9' } } } } }]) });
  const s = await scanWallet(sujo, { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.match(s.errors.join(), /saldo SOL: saldo fora do formato/);
  // cofre da curva sem número: a carteira fica marcada (creator fees não lidas), nunca "0 de fee"
  assert.match(s.errors.join(), /creator fees: cofre da curva fora do formato/);
  assert.equal(s.fees, null);
  // cofre do PumpSwap sem quantidade (só ele sujo): zero, como antes
  const ata = await scanWallet(walletRpc({ getMultipleAccounts: basicsHandler(() => [WALLET_ACC, VAULT_ACC, { data: { parsed: { info: { tokenAmount: { amount: '1e9' } } } } }]) }), { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.equal(ata.fees?.ammVaultLamports, 0);
  // resposta sem a lista (ou com tamanho errado): saldo vira erro, cofres zero
  const vazio = await scanWallet(walletRpc({ getMultipleAccounts: () => ({ value: null }) }), { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.match(vazio.errors.join(), /saldo SOL/);
  assert.equal(vazio.fees?.bondingVaultLamports, 0);
  // carteira que não existe mais na blockchain (limpa): 0 SOL, sem erro
  const limpa = await scanWallet(walletRpc({ getMultipleAccounts: basicsHandler(() => [null, null, null]) }), { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.deepEqual([limpa.lamports, limpa.errors], [0, []]);
});

// RPC que responde "1e400" chega como Infinity (JSON.parse); 1.5 ou NaN também não são lamports.
// BigInt() lança com qualquer um deles: no núcleo, viram erro "fora do formato" da carteira (ou zero no cofre),
// nunca um número que derruba o resumo, o plano ou o view() depois.
test('carteira: lamports que não são inteiros finitos (Infinity, NaN, 1.5) viram "fora do formato", nunca exceção', async () => {
  for (const bad of [Infinity, -Infinity, NaN, 1.5, -1]) {
    const rpc = walletRpc({ getMultipleAccounts: basicsHandler(() => [{ lamports: bad }, { lamports: bad }, null]) });
    const s = await scanWallet(rpc, { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
    assert.match(s.errors.join(), /saldo SOL: saldo fora do formato/, `saldo ${bad}`);
    assert.equal(s.lamports, 0);
    assert.match(s.errors.join(), /creator fees: cofre da curva fora do formato/, `cofre da curva ${bad} marca a carteira`);
    assert.equal(s.fees, null);
    assert.doesNotThrow(() => summarize([s], new Map()), `resumo com ${bad}`);
  }
  // cofre do PumpSwap com quantidade que Number() vira Infinity (400 dígitos): erro da carteira, não exceção
  const big = '9'.repeat(400);
  const pool = await scanWallet(walletRpc({ getMultipleAccounts: basicsHandler(() => [WALLET_ACC, null, { data: { parsed: { info: { tokenAmount: { amount: big } } } } }]) }), { index: 0, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.match(pool.errors.join(), /creator fees: cofre do PumpSwap fora do formato/);
  assert.equal(pool.lamports, 1_500_000, 'o saldo da carteira continua valendo');
  // só saldo (espera do depósito): mesmo dado sujo vira erro da carteira, as outras seguem
  const ws = [0, 1, 2, 3].map((i) => ({ index: i, address: deriveBurner(seed, i).address }));
  const r = await balancesOnly(fakeRpc({ getMultipleAccounts: () => ({ value: [{ lamports: Infinity }, { lamports: NaN }, { lamports: 2.5 }, { lamports: 7 }] }) }), ws);
  for (const k of [0, 1, 2]) assert.deepEqual([r[k].lamports, r[k].errors], [0, ['saldo fora do formato']], `carteira ${k}`);
  assert.deepEqual([r[3].lamports, r[3].errors], [7, []]);
  // conta de token: aluguel sujo vira 0 (como o aluguel ausente); decimais sujos tornam a conta "invalid"
  const t = tokenRaw();
  (t.account as { lamports: unknown }).lamports = Infinity;
  assert.equal(parseTokenAccount(t, OWNER, 'token').rentLamports, 0);
  for (const decimals of [Infinity, 1.5, 256]) {
    const x = parseTokenAccount(tokenRaw({ tokenAmount: { amount: '5', decimals } }), OWNER, 'token');
    assert.equal(x.kind, 'invalid', `decimais ${decimals}`);
  }
});

test('progresso da leitura: cada aviso diz quantas foram lidas e qual carteira acabou de ser lida (para "Agora:")', async () => {
  const ws = Array.from({ length: 9 }, (_, i) => ({ index: 10 + i, address: deriveBurner(seed, 10 + i).address }));
  const seen: Array<[number, number, { index: number; address: string }]> = [];
  await scanWallets(walletRpc(), ws, { rentExemptZero: 650_240, detailedFees: false }, (d, t, w) => seen.push([d, t, w]));
  assert.deepEqual(seen.map(([d]) => d), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(seen.every(([, t]) => t === 9));
  // cada carteira aparece uma vez, com o endereço dela (o rótulo sai do índice na tela)
  assert.deepEqual(seen.map(([, , w]) => w.index).sort((a, b) => a - b), ws.map((w) => w.index));
  for (const [, , w] of seen) assert.equal(w.address, ws.find((x) => x.index === w.index)!.address);
});

test('várias carteiras: uma quebrada não derruba a lista e a ordem é preservada', async () => {
  const bad = deriveBurner(seed, 5).address; // (a N=1 desta frase é o próprio OWNER)
  const base = walletRpc({ getMultipleAccounts: basicsHandler((w) => (w === bad ? [{ lamports: null }, null, null] : [WALLET_ACC, VAULT_ACC, ATA_ACC])) });
  const rpc: RpcClient = {
    call: (m, p) => (p[0] === bad ? Promise.reject(new RpcError(`${m}: HTTP 500`, 500)) : base.call(m, p)),
  };
  const ws = [0, 1, 2].map((i) => ({ index: i, address: i === 1 ? bad : OWNER }));
  const res = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false }, undefined, { sleep: async () => {} });
  assert.deepEqual(res.map((r) => r.index), [0, 1, 2]);
  assert.equal(res[1].errors.length, 2, 'saldo sujo + contas de token caídas');
  assert.equal(res[0].errors.length, 0);
  assert.equal(res[2].lamports, 1_500_000);
});

test('lote: 70 carteiras = 3 consultas de saldo+cofres (33+33+4), cada valor na carteira certa', async () => {
  const ws = Array.from({ length: 70 }, (_, i) => ({ index: i, address: deriveBurner(seed, i).address }));
  const lam = new Map(ws.map((w) => [w.address, 1_000 + w.index]));
  const rpc = walletRpc({ getMultipleAccounts: basicsHandler((w) => [{ lamports: lam.get(w) }, { lamports: 650_240 + lam.get(w)! }, null]) });
  const res = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false });
  assert.equal(rpc.calls.filter((c) => c === 'getMultipleAccounts').length, Math.ceil(70 / BASICS_PER_CALL));
  assert.equal(BASICS_PER_CALL * 3 <= 100, true, 'cabe no limite de 100 contas por consulta');
  assert.ok(res.every((r) => r.lamports === 1_000 + r.index && r.fees?.bondingVaultLamports === 1_000 + r.index));
  assert.ok(!rpc.calls.includes('getBalance'), 'saldo não é mais 1 consulta por carteira');
  assert.ok(!rpc.calls.includes('getProgramAccounts'), 'sem detalhe, nada de getProgramAccounts');
  assert.equal(rpc.calls.length, Math.ceil(70 / BASICS_PER_CALL) + 70 * 2, 'lote + 2 de tokens por carteira');
});

test('app, limpar e scan: leem a fee parada nas moedas com 1 getProgramAccounts por carteira (pool só se migrou)', async () => {
  const rpc = walletRpc();
  const opts = cleanupScanOptions(650_240);
  assert.equal(opts.detailedFees, true);
  await scanWallets(rpc, [{ index: 1, address: OWNER }], opts);
  // 1 das curvas + 1 da fee dividida (fee sharing, 31/10/2026) + 1 da Meteora DBC (09/11/2026); nenhuma curva completa: não busca pool
  assert.equal(rpc.calls.filter((c) => c === 'getProgramAccounts').length, 3, 'nenhuma curva completa: não busca pool');
  for (const file of ['src/app/server.ts', 'src/cli/limpar.ts', 'src/cli/scan.ts']) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', file), 'utf8');
    const calls = [...src.matchAll(/scanWallets\([^;]*?\)\s*[,;)]/gs)].map((m) => m[0]);
    assert.ok(calls.length > 0 && calls.every((c) => c.includes('cleanupScanOptions(')), `${file} lê com cleanupScanOptions`);
  }
});

test('lote: falha de uma consulta vira erro só das carteiras daquele lote', async () => {
  const ws = Array.from({ length: 40 }, (_, i) => ({ index: i, address: deriveBurner(seed, i).address }));
  let n = 0;
  const ok = basicsHandler();
  const rpc = walletRpc({
    getMultipleAccounts: (p) => {
      if (++n === 2) throw new RpcError('getMultipleAccounts: HTTP 503', 503);
      return ok(p);
    },
  });
  const first = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false }, undefined, { sleep: async () => { throw new Error('para'); } }).catch(() => null);
  assert.equal(first, null, 'com carteira incompleta, a leitura não termina sem reler');
  n = 0;
  const rereads: Array<[number, number]> = [];
  const res = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false }, undefined, { sleep: async () => {}, onReread: (p, r) => rereads.push([p, r]) });
  assert.deepEqual(rereads, [[7, 1]], 'só as 7 do lote que falhou são lidas de novo');
  assert.ok(res.every((r) => r.errors.length === 0 && r.lamports === 1_500_000 && r.tokens.length === 3), 'depois de reler, nenhuma fica pela metade');
});

test('exatidão: a 1ª leitura falha pela metade e a análise só termina com tudo lido; a melhor leitura fica', async () => {
  const ws = Array.from({ length: 5 }, (_, i) => ({ index: i, address: deriveBurner(seed, i).address }));
  const bad = new Set([ws[1].address, ws[3].address]);
  let round = 0;
  const rpc = walletRpc({
    getTokenAccountsByOwner: ([owner]) => {
      // 1ª passada: a rede devolve resposta sem lista (antes virava "nenhuma moeda" em silêncio); na 2ª, responde
      if (bad.has(owner as string) && round === 0) return {};
      return { value: [tokenRaw()] };
    },
  });
  const res = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false }, undefined, { sleep: async () => void round++ });
  assert.equal(round, 1);
  assert.ok(res.every((r) => r.errors.length === 0 && r.tokens.length === 1), 'as 2 que vieram sem lista foram lidas de novo e acharam a moeda');
});

test('exatidão: carteira que nunca responde fica marcada (nunca vira vazia) depois de todas as esperas', async () => {
  const ws = [{ index: 0, address: deriveBurner(seed, 0).address }];
  const waits: number[] = [];
  const rpc = walletRpc({ getTokenAccountsByOwner: () => ({ value: 'quebrado' }) });
  const [s] = await scanWallets(rpc, ws, { rentExemptZero: 650_240, detailedFees: false }, undefined, { sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(waits, REREAD_WAITS_MS);
  assert.deepEqual(unreadParts(s), ['contas de token: getTokenAccountsByOwner (token): resposta fora do formato']);
});

test('exatidão: fee parada, dividida e cashback que falham contam como parte sem ler', () => {
  const s = { index: 0, address: OWNER, lamports: 0, tokens: [], errors: [], fees: { unsweptError: 'a', sharedError: 'b', cashbackError: 'c' } } as unknown as WalletScan;
  assert.deepEqual(unreadParts(s), ['fee parada nas moedas: a', 'fee dividida: b', 'cashback: c']);
  assert.deepEqual(unreadParts({ ...s, fees: null }), []);
});

test('exatidão: resposta sem lista na busca de moedas da carteira, no mint da curva e na fee dividida vira erro, nunca vazio', async () => {
  const noList = walletRpc({ getProgramAccounts: () => ({ nada: true }) });
  const s = await scanWallet(noList, { index: 1, address: OWNER }, { rentExemptZero: 650_240, detailedFees: true });
  assert.match(s.fees?.unsweptError ?? '', /fora do formato/);
  assert.match(s.fees?.sharedError ?? '', /fora do formato/);
  const noMint = walletRpc({
    getTokenAccountsByOwner: ([owner]) => (owner === CURVE_A ? {} : { value: [] }),
  });
  const m = await scanWallet(noMint, { index: 1, address: OWNER }, { rentExemptZero: 650_240, detailedFees: true });
  assert.match(m.fees?.unsweptError ?? '', /mint da curva/, 'sem o mint, a fee iria para o fora do total sem ser coletada');
  assert.equal(m.fees?.unsweptCurveLamports, 0n);
});

test('exatidão: na busca, resposta sem lista não é "sem histórico"; o lote é conferido de novo e nenhuma temporária fica para trás', async () => {
  const used = new Set([0, 1, 2, 3, 4, 5, 6].map((n) => deriveBurner(seed, n).address));
  let broken = 3; // as 3 primeiras respostas vêm quebradas
  const rpc = fakeRpc({ getSignaturesForAddress: ([addr]) => (broken-- > 0 ? { erro: 1 } : used.has(addr as string) ? [{ signature: 'x' }] : []) });
  const waits: number[] = [];
  const d = await discoverBurners(seed, rpc, { gap: 5, batch: 5, sleep: async (ms) => void waits.push(ms) });
  assert.equal(d.wallets.length, 7, 'achou as 7 (antes, a 1ª resposta quebrada contava como vazia)');
  assert.equal(waits.length, 1);
  const dead = fakeRpc({ getSignaturesForAddress: () => null });
  await assert.rejects(discoverBurners(seed, dead, { sleep: async () => {} }), /fora do formato/, 'sem resposta, a busca falha (a frase mostra o erro), nunca para como se acabasse');
});

// ---------- resumo ----------

test('resumo: totais, estimativa de taxa e token sem preço como desconhecido', async () => {
  const s = await scanWallet(walletRpc(), { index: 1, address: OWNER }, { rentExemptZero: 650_240, detailedFees: true });
  const sum = summarize([s], new Map());
  const w = sum.wallets[0];
  assert.equal(w.closable, 2);
  assert.equal(w.closableRentLamports, 2 * 2_039_280);
  assert.equal(w.creatorFeeLamports, 4_400_000n, 'cofres + os 400.000 parados na curva, que o app varre e coleta');
  assert.equal(w.pendingChoice, 1);
  assert.equal(w.txEstimate, 3); // 1 lote de fechamento + 1 claim + 1 envio final
  assert.equal(sum.totals.feeEstimateLamports, 15_000);
  assert.equal(sum.totals.recoverableLamports, BigInt(1_500_000 + 2 * 2_039_280) + 4_400_000n - 15_000n);
  assert.equal(sum.tokensWithBalance[0].usd, null, 'sem preço = desconhecido, não zero');
  assert.equal(sum.feesDetailed, true);
});

test('resumo: token bloqueado não conta como recuperável', () => {
  const scan: WalletScan = {
    index: 0,
    address: OWNER,
    lamports: 0,
    tokens: [parseTokenAccount(tokenRaw({ state: 'frozen' }), OWNER, 'token')],
    fees: null,
    errors: [],
  };
  const sum = summarize([scan], new Map());
  assert.equal(sum.totals.closable, 0);
  assert.equal(sum.blocked.length, 1);
  assert.equal(sum.totals.recoverableLamports, 0n);
  assert.equal(sum.feesDetailed, false);
});

test('resumo: valor em USD usa decimais do token e ordena desconhecido por último', () => {
  const t1 = parseTokenAccount(tokenRaw({ mint: 'MintA', tokenAmount: { amount: '2500000', decimals: 6 } }, 'A1'), OWNER, 'token');
  const t2 = parseTokenAccount(tokenRaw({ mint: 'MintB', tokenAmount: { amount: '10', decimals: 0 } }, 'A2'), OWNER, 'token');
  const t3 = parseTokenAccount(tokenRaw({ mint: 'MintC', tokenAmount: { amount: '7', decimals: 0 } }, 'A3'), OWNER, 'token');
  const sum = summarize([{ index: 0, address: OWNER, lamports: 0, tokens: [t3, t1, t2], fees: null, errors: [] }], new Map([
    ['MintA', { usd: 2, liquidityUsd: 1000 }],
    ['MintB', { usd: 0.01, liquidityUsd: 10 }],
  ]));
  assert.deepEqual(sum.tokensWithBalance.map((t) => t.mint), ['MintA', 'MintB', 'MintC']);
  assert.equal(sum.tokensWithBalance[0].usd, 5);
  assert.equal(sum.tokensWithBalance[2].usd, null);
});

test('formatação de SOL e de quantidade de token', () => {
  assert.equal(formatSol(1_234_567_891), '1,234567');
  assert.equal(formatSol(5_000n), '0,000005');
  assert.equal(formatTokenAmount(2_500_000n, 6), '2,5');
  assert.equal(formatTokenAmount(7n, 0), '7');
  assert.equal(formatTokenAmount(5n, 3), '0,005');
});

// ---------- preços ----------

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('tokens: preço, símbolo e tipo vindos da API; mint ausente fica desconhecido', async () => {
  const api = [
    { id: 'MintApump', symbol: 'FR', name: 'France', usdPrice: 1.5, liquidity: 10, launchpad: 'pump.fun', tags: ['unknown'] },
    { id: USDC, symbol: 'USDC', usdPrice: 1, tags: ['stable', 'verified'], isVerified: true },
    { id: 'MintV', symbol: 'XYZ', usdPrice: 2, isVerified: true },
    { id: 'MintO', symbol: 'OUT', usdPrice: 3 },
    { id: 'So11111111111111111111111111111111111111112', usdPrice: 100 },
    { id: 'NaoPedido', usdPrice: 9 },
  ];
  const ok = (async () => new Response(JSON.stringify(api))) as typeof fetch;
  const r = await fetchPrices(['MintApump', USDC, 'MintV', 'MintO', 'MintSumido', 'MintApump'], ok);
  assert.equal(r.prices.get('MintApump')?.usd, 1.5);
  assert.equal(r.info.get('MintApump')?.category, 'memecoin Pump.fun');
  assert.equal(r.info.get(USDC)?.category, 'estável');
  assert.equal(r.info.get('MintV')?.category, 'cripto conhecida');
  assert.equal(r.info.get('MintO')?.category, 'outro');
  assert.equal(r.info.get('MintSumido')?.category, 'desconhecido');
  assert.equal(r.prices.has('MintSumido'), false);
  assert.equal(r.prices.has('NaoPedido'), false, 'ignora item que não foi pedido');
  assert.equal(r.solUsd, 100);
  assert.deepEqual(r.errors, []);
});

test('tokens: dado sujo da API não vira preço nem derruba a lista', async () => {
  const sujo = (async () => new Response(JSON.stringify([{ id: 'MintA', usdPrice: 'caro' }, null, { id: 'MintC', usdPrice: -1 }, { usdPrice: 5 }, 42]))) as typeof fetch;
  const r = await fetchPrices(['MintA', 'MintB', 'MintC'], sujo);
  assert.equal(r.prices.size, 0);
  const objeto = (async () => new Response(JSON.stringify({ erro: 'formato novo' }))) as typeof fetch;
  assert.equal((await fetchPrices(['MintA'], objeto)).prices.size, 0);
});

test('tokens: API fora do ar vira aviso e estáveis conhecidos continuam estáveis', async () => {
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch;
  const r = await fetchPrices([USDC, 'Lixopump'], down, async () => {});
  assert.equal(r.prices.size, 0);
  assert.equal(r.errors.length, 1);
  assert.equal(r.info.get(USDC)?.category, 'estável');
  assert.equal(r.info.get(USDC)?.symbol, 'USDC');
  assert.equal(r.info.get('Lixopump')?.category, 'memecoin Pump.fun', 'sufixo pump identifica sem a API');
});

test('tokens: nome/símbolo sem caracteres de controle do terminal; imitação de símbolo conhecido é detectada', async () => {
  assert.equal(sanitizeText('US\u001b[2K\rDC‮'), 'US[2KDC');
  assert.equal(sanitizeText('​\u0007'), null);
  assert.equal(sanitizeText(42), null);
  assert.equal(sanitizeText('x'.repeat(100))?.length, 40);
  const api = [{ id: 'Fakepump', symbol: '\u001b[32mUSDC\u001b[0m', name: 'USD\u0000 Coin', usdPrice: 1 }];
  const r = await fetchPrices(['Fakepump'], (async () => new Response(JSON.stringify(api))) as typeof fetch);
  const info = r.info.get('Fakepump')!;
  assert.ok(!/[\u0000-\u001f]/.test(info.symbol! + info.name!));
  assert.equal(info.category, 'memecoin Pump.fun', 'nome USDC não vira estável');
  assert.equal(looksLikeImpostor('Fakepump', info.symbol), false, 'símbolo com resto de código não bate exato');
  assert.equal(looksLikeImpostor('Fakepump', 'usdc'), true);
  assert.equal(looksLikeImpostor('Fakepump', '$WIF'), true);
  assert.equal(looksLikeImpostor(USDC, 'USDC'), false);
  assert.equal(looksLikeImpostor('Outro', 'PEPE'), false);
});

test('tokens: lotes de 50 ids', async () => {
  const urls: string[] = [];
  const f = (async (u: string) => (urls.push(u), new Response('[]'))) as typeof fetch;
  await fetchPrices(Array.from({ length: 120 }, (_, i) => `M${i}`), f);
  assert.equal(urls.length, 3); // 121 ids com o wSOL
});

// ---------- RPC ----------

test('RPC: repete em 429 e em falha de rede, não repete erro do método, nunca expõe a URL', async () => {
  const secretUrl = 'https://rpc.exemplo.com/?api-key=SEGREDO123';
  let n = 0;
  const flaky = (async () => {
    n++;
    if (n === 1) return new Response('', { status: 429 });
    if (n === 2) throw new TypeError(`fetch failed ${secretUrl}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 7 }));
  }) as typeof fetch;
  const rpc = createRpc({ url: secretUrl, fetchImpl: flaky, sleep: async () => {}, requestsPerSecond: 1000 });
  assert.equal(await rpc.call('getBalance', []), 7);
  assert.equal(n, 3);

  let m = 0;
  const methodError = (async () => (m++, new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } })))) as typeof fetch;
  const rpc2 = createRpc({ url: secretUrl, fetchImpl: methodError, sleep: async () => {}, requestsPerSecond: 1000 });
  await assert.rejects(rpc2.call('getBalance', []), (e: Error) => !e.message.includes('SEGREDO') && /Invalid param/.test(e.message));
  assert.equal(m, 1);

  const dead = (async () => {
    throw new TypeError(`fetch failed ${secretUrl}`);
  }) as typeof fetch;
  const rpc3 = createRpc({ url: secretUrl, fetchImpl: dead, sleep: async () => {}, requestsPerSecond: 1000, retries: 2 });
  await assert.rejects(rpc3.call('getBalance', []), (e: Error) => !e.message.includes('SEGREDO') && !e.message.includes('rpc.exemplo'));
});

test('RPC: erro passageiro do nó (interno, slot atrasado, bloco indisponível) é repetido; erro de parâmetro não', async () => {
  for (const code of [-32603, -32016, -32004, -32014]) {
    let n = 0;
    const f = (async () => (++n < 3 ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code, message: 'nó ocupado' } })) : new Response(JSON.stringify({ result: 9 })))) as typeof fetch;
    const rpc = createRpc({ url: 'https://x', fetchImpl: f, sleep: async () => {}, requestsPerSecond: 1000 });
    assert.equal(await rpc.call('getTokenAccountsByOwner', []), 9, `código ${code}`);
    assert.equal(n, 3);
  }
  let m = 0;
  const f = (async () => (m++, new Response(JSON.stringify({ error: { code: -32601, message: 'Method not found' } })))) as typeof fetch;
  await assert.rejects(createRpc({ url: 'https://x', fetchImpl: f, sleep: async () => {}, requestsPerSecond: 1000 }).call('x', []));
  assert.equal(m, 1);
});

test('RPC: em 429 espera o Retry-After do servidor quando ele é maior que o backoff', async () => {
  const waits: number[] = [];
  let n = 0;
  const f = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : new Response(JSON.stringify({ result: 1 })))) as typeof fetch;
  const rpc = createRpc({ url: 'https://x', fetchImpl: f, sleep: async (ms) => void waits.push(ms), requestsPerSecond: 1000 });
  await rpc.call('getBalance', []);
  assert.ok(waits.includes(7000), `esperas: ${waits}`);
});

test('rpc: avisa a cada nova tentativa', async () => {
  const secretUrl = 'https://rpc.exemplo.com/?api-key=SEGREDO123';
  const infos: unknown[] = [];
  let n = 0;
  const f = (async () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : new Response(JSON.stringify({ result: 5 })))) as typeof fetch;
  const rpc = createRpc({ url: secretUrl, fetchImpl: f, sleep: async () => {}, requestsPerSecond: 1000, onRetry: (i) => infos.push(i) });
  assert.equal(await rpc.call('getBalance', []), 5);
  assert.deepEqual(infos, [{ attempt: 0, waitMs: 2000, code: 429 }]);
  assert.ok(!JSON.stringify(infos).includes('SEGREDO'));
});

test('descoberta: informa progresso a cada lote (conferidos, usadas)', async () => {
  const used = new Set([0, 1, 4].map((n) => deriveBurner(seed, n).address));
  const rpc = fakeRpc({ getSignaturesForAddress: ([a]) => (used.has(a as string) ? [{ signature: 'x' }] : []) });
  const seen: Array<[number, number]> = [];
  await discoverBurners(seed, rpc, { gap: 5, batch: 3, onProgress: (n, k) => seen.push([n, k]) });
  assert.deepEqual(seen, [[3, 2], [6, 5], [9, 5], [12, 5]]);
});

test('só saldo: 100 por consulta, conta inexistente = 0, falha de lote vira erro só daquele lote', async () => {
  const ws = Array.from({ length: 150 }, (_, i) => ({ index: i, address: deriveBurner(seed, i).address }));
  let calls = 0;
  const rpc = fakeRpc({
    getMultipleAccounts: ([addrs]) => {
      calls++;
      if (calls === 2) throw new RpcError('getMultipleAccounts: HTTP 503', 503);
      return { value: (addrs as string[]).map((_, k) => (k === 0 ? null : k === 1 ? { lamports: 'x' } : { lamports: 7 })) };
    },
  });
  const r = await balancesOnly(rpc, ws);
  assert.equal(calls, 2);
  assert.equal(r.length, 150);
  assert.deepEqual([r[0].lamports, r[0].errors], [0, []]);
  assert.match(r[1].errors.join(), /fora do formato/);
  assert.equal(r[2].lamports, 7);
  assert.ok(r.slice(100).every((x) => x.errors.length === 1 && x.lamports === 0));
  assert.ok(r.every((x) => x.tokens.length === 0 && x.fees === null));
});

test('cofre com 890.880 e aluguel atual 650.240: a diferença É fee (medido na mainnet)', async () => {
  const rpc = walletRpc({ getMultipleAccounts: basicsHandler(() => [null, { lamports: 890_880 }, null]) });
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, { rentExemptZero: 650_240, detailedFees: false });
  assert.equal(s.fees?.bondingVaultLamports, 240_640);
});

// ---------- fee parada nas moedas: leitura ----------

type CurveOpts = { fee: bigint; complete?: boolean; cashback?: boolean; holder?: boolean; quote?: string };
function curveBytes(o: CurveOpts): string {
  const b = Buffer.alloc(CURVE_SLICE.length);
  const at = (x: number) => x - CURVE_SLICE.offset;
  if (o.complete) b[at(48)] = 1;
  if (o.cashback) b[at(82)] = 1;
  if (o.quote) Buffer.from(decodeBase58(o.quote)).copy(b, at(83));
  if (o.holder) b[at(124)] = 1;
  b.writeBigUInt64LE(o.fee, at(125));
  return b.toString('base64');
}
type PoolOpts = { fee: bigint; quote?: string; quoteAccount?: string; holder?: boolean };
function poolBytes(o: PoolOpts): string {
  const b = Buffer.alloc(POOL_SLICE.length);
  const at = (x: number) => x - POOL_SLICE.offset;
  Buffer.from(decodeBase58(o.quote ?? WSOL_MINT)).copy(b, at(75));
  Buffer.from(decodeBase58(o.quoteAccount ?? deriveBurner(seed, 60).address)).copy(b, at(171));
  if (o.holder) b[at(270)] = 1;
  b.writeBigUInt64LE(o.fee, at(279));
  return b.toString('base64');
}
const mintN = (k: number) => deriveBurner(seed, 50 + k).address;
const curveN = (k: number) => findProgramAddress(['bonding-curve', decodeBase58(mintN(k))], PROGRAMS.pump).address;
// RPC falso só da parte parada: curvas e pools pedidos, e quem é dono de qual conta de token
function parkedRpc(curves: Array<{ pubkey: unknown; data: unknown }>, pools: Array<{ pubkey: unknown; data: unknown }> = [], owners: Record<string, string[]> = {}) {
  return walletRpc({
    getProgramAccounts: ([program]) => (program === PROGRAMS.pump ? curves : pools).map((c) => ({ pubkey: c.pubkey, account: { data: [c.data, 'base64'] } })),
    getTokenAccountsByOwner: ([owner, filter]) => {
      const mints = owners[owner as string];
      if (mints) return { value: (filter as { programId: string }).programId === PROGRAMS.token2022 ? mints.map((m) => ({ pubkey: 'x', account: { data: { parsed: { info: { mint: m } } } } })) : [] };
      return { value: [] };
    },
  });
}

test('fee parada: só coleta moeda em SOL do próprio criador; holders, cashback e outro par ficam fora do total', async () => {
  const curves = [
    { pubkey: curveN(0), data: curveBytes({ fee: 100_000n }) }, // antiga (quote zerado) = SOL
    { pubkey: curveN(1), data: curveBytes({ fee: 200_000n, quote: WSOL_MINT }) },
    { pubkey: curveN(2), data: curveBytes({ fee: 300_000n, holder: true }) },
    { pubkey: curveN(3), data: curveBytes({ fee: 400_000n, cashback: true }) },
    { pubkey: curveN(4), data: curveBytes({ fee: 500_000n, quote: USDC }) },
  ];
  const owners = Object.fromEntries([0, 1, 2, 3, 4].map((k) => [curveN(k), [mintN(k)]]));
  const rpc = parkedRpc(curves, [], owners);
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.fees?.curveSweeps.map((x) => [x.mint, x.lamports]), [[mintN(0), 100_000n], [mintN(1), 200_000n]]);
  assert.equal(s.fees?.unsweptCurveLamports, 700_000n, 'holders + cashback: mostrados, não coletados');
  // USDC não é lamport (antes entrava somado no "Fora do total: X SOL"): conta como moeda em outro token
  assert.equal(s.fees?.otherQuoteFees, 1);
  assert.equal(totalCreatorFeeLamports(s.fees!), 1_000_000n + 3_000_000n + 300_000n, 'total = cofres + o que o app coleta');
  // só procura o mint das moedas coletáveis: 1 consulta cada quando é Token-2022 (moedas novas), 2 da carteira
  assert.equal(rpc.calls.filter((c) => c === 'getTokenAccountsByOwner').length, 2 + 2);
});

test('fee parada: conta de token da curva com outro mint (qualquer um cria) não vira mint; sem mint, não coleta', async () => {
  const spam = deriveBurner(seed, 70).address;
  const rpc = parkedRpc([{ pubkey: curveN(0), data: curveBytes({ fee: 100_000n }) }], [], { [curveN(0)]: [spam, 'nao-e-endereco'] });
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual(s.fees?.curveSweeps, []);
  assert.equal(s.fees?.unsweptCurveLamports, 100_000n);
});

test('fee parada: valor abaixo do mínimo não gasta consulta de mint e fica fora do total', async () => {
  const rpc = parkedRpc([{ pubkey: curveN(0), data: curveBytes({ fee: MIN_SWEEP_LAMPORTS - 1n }) }], [], { [curveN(0)]: [mintN(0)] });
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual(s.fees?.curveSweeps, []);
  assert.equal(rpc.calls.filter((c) => c === 'getTokenAccountsByOwner').length, 2, 'só as 2 da própria carteira');
});

test('fee parada: pool só é buscado quando alguma moeda migrou; pool em SOL é coletado, outro par não', async () => {
  const QA = deriveBurner(seed, 61).address;
  const pools = [
    { pubkey: deriveBurner(seed, 62).address, data: poolBytes({ fee: 700_000n, quoteAccount: QA }) },
    { pubkey: deriveBurner(seed, 63).address, data: poolBytes({ fee: 800_000n, quote: USDC }) },
    { pubkey: deriveBurner(seed, 64).address, data: poolBytes({ fee: 900_000n, holder: true }) },
  ];
  const migrated = parkedRpc([{ pubkey: curveN(0), data: curveBytes({ fee: 0n, complete: true }) }], pools);
  const s = await scanWallet(migrated, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.equal(migrated.calls.filter((c) => c === 'getProgramAccounts').length, 4, 'curvas, pools, fee dividida e Meteora');
  assert.deepEqual(s.fees?.poolSweeps, [{ pool: pools[0].pubkey, quoteAccount: QA, lamports: 700_000n }]);
  assert.equal(s.fees?.unsweptPoolLamports, 900_000n, 'holders; o pool em USDC conta à parte');
  assert.equal(s.fees?.otherQuoteFees, 1);
  assert.equal(s.fees?.pools, 3);
  const notMigrated = parkedRpc([{ pubkey: curveN(0), data: curveBytes({ fee: 0n }) }], pools);
  const n = await scanWallet(notMigrated, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.equal(notMigrated.calls.filter((c) => c === 'getProgramAccounts').length, 3, 'sem curva completa: 10 créditos a menos (curvas, fee dividida e Meteora)');
  assert.deepEqual(n.fees?.poolSweeps, []);
});

test('fee parada: item fora do formato é ignorado sem derrubar a lista', async () => {
  const rpc = parkedRpc(
    [
      { pubkey: 42, data: curveBytes({ fee: 100_000n }) },
      { pubkey: 'nao-e-endereco', data: curveBytes({ fee: 100_000n }) },
      { pubkey: curveN(1), data: 12345 },
      { pubkey: curveN(2), data: Buffer.alloc(10).toString('base64') }, // curta: campos ausentes valem 0
      { pubkey: curveN(0), data: curveBytes({ fee: 100_000n }) },
      { pubkey: curveN(0), data: curveBytes({ fee: 100_000n }) }, // repetida pelo RPC
    ],
    [],
    { [curveN(0)]: [mintN(0)] },
  );
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.fees?.curveSweeps.map((x) => x.mint), [mintN(0)], 'curva repetida conta uma vez');
});

test('fee parada: falha da busca não pula a carteira; os cofres valem e o motivo fica registrado', async () => {
  const rpc = walletRpc({
    getProgramAccounts: () => {
      throw new RpcError('getProgramAccounts: HTTP 410', 410);
    },
  });
  const s = await scanWallet(rpc, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual(s.errors, [], 'não vira "leitura incompleta" (o plano pularia a carteira inteira)');
  assert.equal(s.fees?.bondingVaultLamports, 1_000_000);
  assert.match(s.fees?.unsweptError ?? '', /410/);
  assert.deepEqual([s.fees?.curveSweeps, s.fees?.unsweptCurveLamports], [[], 0n]);
  // falha no meio (curvas lidas, mint caiu): nada da parte parada fica pela metade
  const half = walletRpc({
    getTokenAccountsByOwner: ([owner]) => {
      if (owner === CURVE_A) throw new RpcError('getTokenAccountsByOwner: HTTP 503', 503);
      return { value: [] };
    },
  });
  const h = await scanWallet(half, { index: 1, address: OWNER }, cleanupScanOptions(650_240));
  assert.deepEqual([h.fees?.curveSweeps, h.fees?.coinsOnCurve !== undefined, h.errors], [[], true, []]);
  assert.match(h.fees?.unsweptError ?? '', /503/);
});
