// Leitura da creator fee dividida (fee sharing): achar as divisões em que a carteira participa e quanto é dela.
// Layout do SharingConfig conferido no IDL 639b87fb e em contas da mainnet (docs/pumpfun-creator-fees.md, 31/10/2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CURVE_SLICE, parseSharingConfig, POOL_SLICE, SHARING_SLICE, sharedFees } from '../../src/core/limpeza/scan.ts';
import { curveAddress, poolAddress } from '../../src/core/limpeza/curve-price.ts';
import { burnerSigner, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';
import { PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, sharingConfigAddress, WSOL_MINT } from '../../src/core/solana/pda.ts';
import type { RpcClient } from '../../src/core/solana/rpc.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const A = Array.from({ length: 12 }, (_, i) => burnerSigner(seed, 700 + i).address);
const W = A[0];
const OTHER = A[1];
const RENT0 = 650_240;

function sharing(mint: string, holders: Array<[string, number]>, opts: { active?: boolean; disc?: string } = {}): Buffer {
  const b = Buffer.alloc(80 + 34 * holders.length);
  Buffer.from(opts.disc ?? 'd84a0900388c5d4b', 'hex').copy(b, 0);
  b[9] = 2;
  b[10] = opts.active === false ? 0 : 1;
  Buffer.from(decodeBase58(mint)).copy(b, 11);
  b.writeUInt32LE(holders.length, 76);
  holders.forEach(([a, bps], i) => {
    Buffer.from(decodeBase58(a)).copy(b, 80 + 34 * i);
    b.writeUInt16LE(bps, 112 + 34 * i);
  });
  return b;
}
// curva (inteira): complete 48, creator 49, cashback 82, quote 83 (zero = SOL), holders 124, creator_fee 125
function curve(creator: string, fee: bigint, opts: { complete?: boolean; quote?: string } = {}): Buffer {
  const b = Buffer.alloc(133);
  b[48] = opts.complete ? 1 : 0;
  Buffer.from(decodeBase58(creator)).copy(b, 49);
  if (opts.quote) Buffer.from(decodeBase58(opts.quote)).copy(b, 83);
  b.writeBigUInt64LE(fee, 125);
  return b;
}
// pool (inteiro): quote 75, conta do quote 171, coin_creator 211, creator_fees 279
function pool(creator: string, fee: bigint): Buffer {
  const b = Buffer.alloc(287);
  Buffer.from(decodeBase58(WSOL_MINT)).copy(b, 75);
  Buffer.from(decodeBase58(A[11])).copy(b, 171);
  Buffer.from(decodeBase58(creator)).copy(b, 211);
  b.writeBigUInt64LE(fee, 279);
  return b;
}
function tokenAcc(amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

type Acc = { lamports: number; data: Buffer };
function chainRpc(accounts: Map<string, Acc>, gpa: Array<{ pubkey: string; data: Buffer }>) {
  const calls: string[] = [];
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      const slice = (d: Buffer, sl?: { offset: number; length: number }) => (sl ? d.subarray(sl.offset, sl.offset + sl.length) : d).toString('base64');
      if (method === 'getProgramAccounts') {
        const [program, cfg] = params as [string, { filters: Array<{ memcmp: { offset: number; bytes: string } }>; dataSlice: { offset: number; length: number } }];
        assert.equal(program, PROGRAMS.pumpFees);
        const want = cfg.filters[1].memcmp;
        return gpa.filter((g) => Buffer.from(decodeBase58(want.bytes)).equals(g.data.subarray(want.offset, want.offset + 32))).map((g) => ({ pubkey: g.pubkey, account: { data: [slice(g.data, cfg.dataSlice), 'base64'] } })) as T;
      }
      if (method === 'getMultipleAccounts') {
        const [keys, cfg] = params as [string[], { dataSlice?: { offset: number; length: number } }];
        return { value: keys.map((k) => (accounts.has(k) ? { lamports: accounts.get(k)!.lamports, data: [slice(accounts.get(k)!.data, cfg.dataSlice), 'base64'] } : null)) } as T;
      }
      throw new Error(`não previsto: ${method}`);
    },
  };
  return { rpc, calls };
}

// moeda k com divisão: devolve as contas da rede
function coin(k: number, holders: Array<[string, number]>, amounts: { vault?: number; curve?: bigint; amm?: bigint; pool?: bigint }, opts: { active?: boolean; quote?: string; curveCreator?: string } = {}) {
  const mint = A[4 + k];
  const config = sharingConfigAddress(mint);
  const acc = new Map<string, Acc>();
  acc.set(config, { lamports: 1, data: sharing(mint, holders, opts) });
  acc.set(curveAddress(mint), { lamports: 1, data: curve(opts.curveCreator ?? config, amounts.curve ?? 0n, { complete: amounts.pool !== undefined, quote: opts.quote }) });
  acc.set(pumpCreatorVault(config), { lamports: RENT0 + (amounts.vault ?? 0), data: Buffer.alloc(0) });
  if (amounts.amm !== undefined) acc.set(pumpAmmCreatorVaultAta(config), { lamports: 2_039_280, data: tokenAcc(amounts.amm) });
  if (amounts.pool !== undefined) acc.set(poolAddress(mint), { lamports: 1, data: pool(config, amounts.pool) });
  return { mint, config, acc };
}
const merge = (...cs: Array<{ acc: Map<string, Acc> }>) => new Map(cs.flatMap((c) => [...c.acc]));

test('parseSharingConfig: lê participantes e partes; dado fora do formato vira null (nunca lança)', () => {
  const ok = parseSharingConfig(sharing(A[4], [[W, 6000], [OTHER, 4000]]));
  assert.deepEqual(ok, { active: true, mint: A[4], shareholders: [{ address: W, bps: 6000 }, { address: OTHER, bps: 4000 }] });
  assert.equal(parseSharingConfig(sharing(A[4], [[W, 6000], [OTHER, 3000]])), null, 'partes que não somam 100%');
  assert.equal(parseSharingConfig(sharing(A[4], [[W, 10_000]], { disc: '0000000000000000' })), null, 'outro tipo de conta');
  assert.equal(parseSharingConfig(Buffer.alloc(10)), null, 'curta demais');
  const many = sharing(A[4], [[W, 10_000]]);
  many.writeUInt32LE(11, 76);
  assert.equal(parseSharingConfig(many), null, 'mais de 10 participantes');
  assert.equal(parseSharingConfig(sharing(A[4], [[W, 10_000]], { active: false }))?.active, false, 'pausada');
  assert.equal(SHARING_SLICE.length, 80 + 340);
});

test('fee dividida: acha pela 1ª posição (busca) e por qualquer posição (moeda das contas de token); soma cofre, curva, pool e PumpSwap', async () => {
  const first = coin(0, [[W, 6000], [OTHER, 4000]], { vault: 1_000_000, curve: 500_000n });
  const second = coin(1, [[OTHER, 7500], [W, 2500]], { amm: 800_000n, pool: 200_000n });
  const { rpc, calls } = chainRpc(merge(first, second), [{ pubkey: first.config, data: first.acc.get(first.config)!.data }]);
  const r = await sharedFees(rpc, W, [second.mint, second.mint, 'nao-e-endereco'], RENT0);
  assert.equal(calls.filter((c) => c === 'getProgramAccounts').length, 1, '1 busca por carteira');
  const by = new Map(r.shared.map((x) => [x.config, x]));
  assert.equal(by.get(first.config)?.totalLamports, 1_500_000n);
  assert.equal(by.get(first.config)?.shareLamports, 900_000n);
  assert.equal(by.get(first.config)?.curveFee, 500_000n);
  assert.equal(by.get(second.config)?.totalLamports, 1_000_000n, 'PumpSwap + pool');
  assert.equal(by.get(second.config)?.shareLamports, 250_000n);
  assert.deepEqual(by.get(second.config)?.poolSweep, { pool: poolAddress(second.mint), quoteAccount: A[11], lamports: 200_000n });
  assert.equal(by.get(second.config)?.ammVault, true);
  assert.equal(r.other, 0);
});

test('fee dividida: fora da coleta, com contagem: pausada, moeda em outro token, curva que não aponta para a divisão; carteira de fora não conta', async () => {
  const paused = coin(0, [[W, 10_000]], { vault: 1_000_000 }, { active: false });
  const usdc = coin(1, [[W, 10_000]], { vault: 1_000_000 }, { quote: A[10] });
  const notHere = coin(2, [[W, 10_000]], { vault: 1_000_000 }, { curveCreator: OTHER });
  const notMine = coin(3, [[OTHER, 10_000]], { vault: 1_000_000 });
  const { rpc } = chainRpc(merge(paused, usdc, notHere, notMine), []);
  const r = await sharedFees(rpc, W, [paused.mint, usdc.mint, notHere.mint, notMine.mint], RENT0);
  assert.deepEqual(r.shared, []);
  assert.equal(r.other, 3, 'pausada, outro token e curva de outro criador; a de outra carteira nem entra');
});

test('fee dividida: sem divisão nenhuma, só a busca (sem leituras a mais)', async () => {
  const { rpc, calls } = chainRpc(new Map(), []);
  const r = await sharedFees(rpc, W, [], RENT0);
  assert.deepEqual(r, { shared: [], other: 0 });
  assert.deepEqual(calls, ['getProgramAccounts']);
});

test('fee dividida: a conta que a busca devolve com o PDA de outro mint não entra (o PDA confere)', async () => {
  const real = coin(0, [[W, 10_000]], { vault: 1_000_000 });
  // alguém devolve na busca uma conta com o layout certo mas em outro endereço
  const { rpc } = chainRpc(real.acc, [{ pubkey: A[9], data: real.acc.get(real.config)!.data }]);
  const r = await sharedFees(rpc, W, [], RENT0);
  assert.deepEqual(r, { shared: [], other: 0 }, 'nem coletada nem contada como divisão de verdade');
});

test('curva e pool lidos com os mesmos recortes da fee parada', () => {
  assert.deepEqual(CURVE_SLICE, { offset: 48, length: 85 });
  assert.deepEqual(POOL_SLICE, { offset: 75, length: 212 });
});

test('cashback: Pump.fun = SOL acima do aluguel do acumulador (pelo tamanho dele); PumpSwap = WSOL do acumulador; sem conta = 0', async () => {
  const { cashbackOf } = await import('../../src/core/limpeza/scan.ts');
  const { associatedTokenAddress, userVolumeAccumulator } = await import('../../src/core/solana/pda.ts');
  const uva = userVolumeAccumulator(W, PROGRAMS.pump);
  const ammAta = associatedTokenAddress(userVolumeAccumulator(W, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token);
  const rent = (bytes: number) => Math.floor((RENT0 * (128 + bytes)) / 128);
  const ammUva = userVolumeAccumulator(W, PROGRAMS.pumpAmm);
  const acc = new Map<string, Acc>([[uva, { lamports: rent(100) + 400_000, data: Buffer.alloc(100) }], [ammUva, { lamports: rent(100), data: Buffer.alloc(100) }], [ammAta, { lamports: 2_039_280, data: tokenAcc(300_000n) }]]);
  assert.deepEqual(await cashbackOf(chainRpc(acc, []).rpc, W, RENT0), { pump: 400_000n, amm: 300_000n });
  // acumulador do PumpSwap fechado: o WSOL da conta dele fica preso (a coleta falha com 3012 na mainnet)
  acc.delete(ammUva);
  assert.deepEqual(await cashbackOf(chainRpc(acc, []).rpc, W, RENT0), { pump: 400_000n, amm: 0n });
  assert.deepEqual(await cashbackOf(chainRpc(new Map(), []).rpc, W, RENT0), { pump: 0n, amm: 0n }, 'sem acumulador');
  const poor = new Map<string, Acc>([[uva, { lamports: rent(100) - 1, data: Buffer.alloc(100) }]]);
  assert.deepEqual(await cashbackOf(chainRpc(poor, []).rpc, W, RENT0), { pump: 0n, amm: 0n }, 'abaixo do aluguel não é cashback');
});

test('fee em moeda pareada em outro token: parada na curva ou já no cofre do criador nesse token conta para o aviso (não é lamport)', async () => {
  const { creatorFees } = await import('../../src/core/limpeza/scan.ts');
  const { associatedTokenAddress, pumpAmmCreatorVaultAuthority } = await import('../../src/core/solana/pda.ts');
  const USDC = A[10];
  const withFee = curve(W, 70_000n, { quote: USDC }); // parada na curva, em USDC
  const noFee = curve(W, 0n, { quote: A[3] }); // outra moeda em outro token, sem nada parado
  const vaultAta = associatedTokenAddress(pumpCreatorVault(W), A[3], PROGRAMS.token2022);
  const accounts = new Map<string, Acc>([[vaultAta, { lamports: 2_039_280, data: tokenAcc(5_000n) }]]);
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getProgramAccounts') {
        const [program, cfg] = params as [string, { dataSlice: { offset: number; length: number } }];
        if (program !== PROGRAMS.pump) return [] as T;
        return [withFee, noFee].map((d, i) => ({ pubkey: A[8 + i], account: { data: [d.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length).toString('base64'), 'base64'] } })) as T;
      }
      if (method === 'getMultipleAccounts') return { value: (params[0] as string[]).map((k) => (accounts.has(k) ? { lamports: accounts.get(k)!.lamports, data: [accounts.get(k)!.data.toString('base64'), 'base64'] } : null)) } as T;
      throw new Error(`não previsto: ${method}`);
    },
  };
  const f = await creatorFees(rpc, W, { lamports: 0, balanceError: null, vaultLamports: 0, ataAmount: 0n, vaultsError: null }, true, [], RENT0);
  assert.equal(f.unsweptError, null);
  assert.equal(f.otherQuoteFees, 2, '1 parada na curva (USDC) + 1 no cofre (outro token, Token-2022)');
  assert.equal(f.unsweptCurveLamports, 0n, 'nada disso somado como SOL');
  assert.ok(pumpAmmCreatorVaultAuthority(W));
});
