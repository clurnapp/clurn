// Creator fee da Meteora DBC (09/11/2026): leitura com dado sujo, plano, executor numa rede falsa COM ESTADO (o que a
// Confirmar mostra é o que chega, 89/11 exatos), falha segura e o tamanho da transação.
//
// A rede falsa executa as instruções que o app monta (transferência, criar ATA, fechar conta de token e a
// claim_creator_trading_fee da DBC) com as regras do programa que mudam o resultado (código 0.2.3, docs/meteora-dbc.md):
// quem assina tem que ser o creator do pool (6053), token_a e token_b não podem ser a mesma conta (2040, visto na mainnet),
// cofres e mint têm que bater com o pool, pool com transfer hook exige a v2 (6076), e só move a fee em quote até o máximo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, DBC_POOLS_PER_TX, MIN_CLAIM_LAMPORTS, rentFor, TOKEN_ACCOUNT_BYTES, type Plan, type Step } from '../../src/core/limpeza/plan.ts';
import { execute, type StepResult } from '../../src/core/limpeza/executor.ts';
import { buildReceipt } from '../../src/app/receipt.ts';
import { DBC_CONFIG_DISC, DBC_MAX_FEE_POOLS, DBC_OFFSETS, DBC_POOL_BYTES, DBC_TRANSFER_HOOK_POOL_DISC, DBC_VIRTUAL_POOL_DISC, dbcFees, type DbcPool } from '../../src/core/limpeza/dbc.ts';
import { parseTokenAccount, scanWallet, totalCreatorFeeLamports, unreadParts, type CreatorFees, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { decodeBase58, encodeBase58 } from '../../src/core/solana/base58.ts';
import { associatedTokenAddress, findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { DBC_CLAIM_CREATOR_TRADING_FEE_DISC, DBC_POOL_AUTHORITY, dbcClaimCreatorTradingFee } from '../../src/core/solana/instructions.ts';
import { MAX_TX_BYTES } from '../../src/core/solana/tx.ts';
import { APP_FEE_WALLET, appFeeFor, appFeeLamports } from '../../src/core/limpeza/app-fee.ts';
import { explainError } from '../../src/core/limpeza/errors.ts';
import { BASE_FEE_LAMPORTS } from '../../src/core/limpeza/summary.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1, 2, 3].map((n) => burnerSigner(seed, n));
const DEST = deriveMainAddress(seed);
const signers = new Map(S.map((s) => [s.index, s]));
const RENT0 = 650_240;
const RENT_TOKEN = Number(rentFor(TOKEN_ACCOUNT_BYTES, RENT0));
const RENT_T22 = Number(rentFor(170, RENT0)); // conta Token-2022 com ImmutableOwner
const addr = (n: number) => burnerSigner(seed, 1000 + n).address; // endereços quaisquer, válidos
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CFG_SOL = addr(1);
const CFG_USDC = addr(2);
const EVENT_AUTHORITY = findProgramAddress(['__event_authority'], PROGRAMS.meteoraDbc).address;
const ataOf = (owner: string, mint: string, program: string = PROGRAMS.token) => associatedTokenAddress(owner, mint, program);

// ---------- dados das contas ----------

type PoolOpts = { creator: string; config?: string; baseMint?: string; quoteFee?: bigint; baseFee?: bigint; poolType?: number; migrated?: boolean; hook?: boolean; n?: number };
function poolBytes(o: PoolOpts): Buffer {
  const b = Buffer.alloc(DBC_POOL_BYTES);
  (o.hook ? DBC_TRANSFER_HOOK_POOL_DISC : DBC_VIRTUAL_POOL_DISC).copy(b, 0);
  const n = o.n ?? 0;
  const put = (at: number, a: string) => Buffer.from(decodeBase58(a)).copy(b, at);
  put(DBC_OFFSETS.config, o.config ?? CFG_SOL);
  put(DBC_OFFSETS.creator, o.creator);
  put(DBC_OFFSETS.baseMint, o.baseMint ?? addr(100 + n));
  put(DBC_OFFSETS.baseVault, addr(200 + n));
  put(DBC_OFFSETS.quoteVault, addr(300 + n));
  b[DBC_OFFSETS.poolType] = o.poolType ?? 0;
  b[DBC_OFFSETS.isMigrated] = o.migrated ? 1 : 0;
  b.writeBigUInt64LE(o.baseFee ?? 0n, DBC_OFFSETS.creatorBaseFee);
  b.writeBigUInt64LE(o.quoteFee ?? 0n, DBC_OFFSETS.creatorQuoteFee);
  return b;
}
function configBytes(quote: string, disc = DBC_CONFIG_DISC): Buffer {
  const b = Buffer.alloc(1048);
  disc.copy(b, 0);
  Buffer.from(decodeBase58(quote)).copy(b, 8);
  return b;
}
const poolAddr = (n: number) => addr(500 + n);
const dbcPool = (n: number, quoteFee: bigint, over: Partial<DbcPool> = {}): DbcPool => ({
  pool: poolAddr(n), config: CFG_SOL, baseMint: addr(100 + n), baseVault: addr(200 + n), quoteVault: addr(300 + n), baseTokenProgram: PROGRAMS.token, migrated: false, quoteFee, ...over,
});

// ---------- instrução ----------

test('dbc: instrução claim_creator_trading_fee no formato do IDL 0.2.2 (13 contas, max_base e max_quote em u64)', () => {
  const ix = dbcClaimCreatorTradingFee(
    { pool: 'P1111111111111111111111111111111111111111', creator: S[1].address, tokenA: addr(10), tokenB: addr(11), baseVault: addr(12), quoteVault: addr(13), baseMint: addr(14), quoteMint: WSOL_MINT, baseTokenProgram: PROGRAMS.token2022, quoteTokenProgram: PROGRAMS.token },
    0n,
    0xffffffffffffffffn,
  );
  assert.equal(ix.programId, 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN');
  assert.deepEqual([...ix.data.subarray(0, 8)], [82, 220, 250, 189, 3, 85, 107, 45]);
  assert.deepEqual([...DBC_CLAIM_CREATOR_TRADING_FEE_DISC], [82, 220, 250, 189, 3, 85, 107, 45]);
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(8), 0n, 'max_base_amount = 0: a fee na moeda fica');
  assert.equal(Buffer.from(ix.data).readBigUInt64LE(16), 0xffffffffffffffffn, 'max_quote_amount = u64::MAX');
  assert.equal(ix.data.length, 24);
  assert.equal(DBC_POOL_AUTHORITY, 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM');
  assert.equal(findProgramAddress(['pool_authority'], PROGRAMS.meteoraDbc).address, DBC_POOL_AUTHORITY, 'endereço fixo do IDL = PDA do programa');
  const flags = ix.keys.map((k) => `${k.isWritable ? 'W' : '-'}${k.isSigner ? 'S' : '-'}`);
  assert.deepEqual(ix.keys.map((k) => k.pubkey), [DBC_POOL_AUTHORITY, 'P1111111111111111111111111111111111111111', addr(10), addr(11), addr(12), addr(13), addr(14), WSOL_MINT, S[1].address, PROGRAMS.token2022, PROGRAMS.token, EVENT_AUTHORITY, PROGRAMS.meteoraDbc]);
  assert.deepEqual(flags, ['--', 'W-', 'W-', 'W-', 'W-', 'W-', '--', '--', '-S', '--', '--', '--', '--']);
});

// ---------- leitura ----------

type Item = { pubkey: unknown; data: Buffer | string; owner?: string; full?: Buffer | null; fullOwner?: string };
function readRpc(items: Item[], opts: { configs?: Record<string, Buffer | null>; gpa?: unknown; failMulti?: boolean } = {}) {
  const calls: string[] = [];
  const full = new Map(items.map((i) => [i.pubkey as string, i]));
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      if (method === 'getProgramAccounts') {
        const [program, cfg] = params as [string, { dataSlice: { offset: number; length: number }; filters: unknown[] }];
        if (program !== PROGRAMS.meteoraDbc) return [] as T;
        assert.deepEqual(cfg.dataSlice, { offset: 352, length: 16 }, 'só as duas fees na busca');
        assert.deepEqual((cfg.filters[0] as { dataSize: number }).dataSize, 424);
        if (opts.gpa !== undefined) return opts.gpa as T;
        return items.map((i) => {
          const d = typeof i.data === 'string' ? i.data : i.data.subarray(352, 368).toString('base64');
          return { pubkey: i.pubkey, account: { data: [d, 'base64'], ...(i.owner ? { owner: i.owner } : {}) } };
        }) as T;
      }
      if (method === 'getMultipleAccounts') {
        if (opts.failMulti) return { value: [] } as T;
        const [keys, cfg] = params as [string[], { dataSlice?: { offset: number; length: number } }];
        return {
          value: keys.map((k) => {
            if (opts.configs && k in opts.configs) {
              const c = opts.configs[k];
              return c ? { owner: PROGRAMS.meteoraDbc, lamports: 1, data: [c.subarray(cfg.dataSlice?.offset ?? 0, (cfg.dataSlice?.offset ?? 0) + (cfg.dataSlice?.length ?? c.length)).toString('base64'), 'base64'] } : null;
            }
            const i = full.get(k);
            if (!i || i.full === null) return null;
            const b = i.full ?? (i.data as Buffer);
            return { owner: i.fullOwner ?? PROGRAMS.meteoraDbc, lamports: 1, data: [b.toString('base64'), 'base64'] };
          }),
        } as T;
      }
      throw new RpcError(`${method}: não previsto`);
    },
  };
  return { rpc, calls };
}
const W = S[1].address;
const CONFIGS = { [CFG_SOL]: configBytes(WSOL_MINT), [CFG_USDC]: configBytes(USDC) };

test('dbc leitura: só fee em SOL entra; outra moeda, fee na moeda e transfer hook contam à parte; dado sujo não vira fee', async () => {
  const items: Item[] = [
    { pubkey: poolAddr(1), data: poolBytes({ creator: W, quoteFee: 5_000_000n, n: 1 }) },
    { pubkey: poolAddr(2), data: poolBytes({ creator: W, quoteFee: 7_000_000n, config: CFG_USDC, n: 2 }) }, // USDC: fora
    { pubkey: poolAddr(3), data: poolBytes({ creator: W, n: 3 }) }, // fee 0: nem é lido inteiro
    { pubkey: poolAddr(4), data: poolBytes({ creator: W, quoteFee: 1_000_000n, migrated: true, poolType: 1, n: 4 }) }, // migrado: coleta
    { pubkey: poolAddr(5), data: poolBytes({ creator: W, quoteFee: 2_000_000n, hook: true, n: 5 }) }, // transfer hook: fora
    { pubkey: poolAddr(7), data: poolBytes({ creator: W, quoteFee: 4_000_000n, n: 7 }), full: poolBytes({ creator: S[2].address, quoteFee: 4_000_000n, n: 7 }) }, // creator de outro
    { pubkey: poolAddr(8), data: poolBytes({ creator: W, quoteFee: 9_000_000n, n: 8 }), owner: PROGRAMS.token }, // conta de outro programa
    { pubkey: poolAddr(9), data: poolBytes({ creator: W, baseFee: 50n, n: 9 }) }, // só fee na moeda: fora
    { pubkey: poolAddr(12), data: poolBytes({ creator: W, quoteFee: 2_500_000n, n: 12 }), full: null }, // sumiu entre as consultas
  ];
  // o RPC repetiu o pool 1: conta uma vez
  const { rpc, calls } = readRpc([...items, items[0]], { configs: CONFIGS });
  const d = await dbcFees(rpc, W);
  assert.deepEqual(d.pools.map((p) => p.pool), [poolAddr(1), poolAddr(4)]);
  assert.deepEqual(d.pools.map((p) => p.quoteFee), [5_000_000n, 1_000_000n]);
  assert.equal(d.pools[1].migrated, true, 'pool migrado também coleta (o handler não confere is_migrated)');
  assert.equal(d.pools[1].baseTokenProgram, PROGRAMS.token2022, 'pool_type 1 = Token-2022');
  assert.equal(d.pools[0].baseTokenProgram, PROGRAMS.token);
  assert.equal(d.other, 3, 'USDC, transfer hook e fee na moeda');
  assert.equal(d.found, 8, 'pools da carteira achados (sem repetir, sem o de outro programa)');
  assert.equal(d.cut, 0);
  assert.deepEqual(calls, ['getProgramAccounts', 'getMultipleAccounts', 'getMultipleAccounts'], '1 busca, 1 leitura dos pools com fee, 1 das configs');
});

test('dbc leitura: resposta fora do formato é "não sei" (lança), nunca "nenhum pool"', async () => {
  const ok: Item = { pubkey: poolAddr(1), data: poolBytes({ creator: W, quoteFee: 5_000_000n, n: 1 }) };
  const bad = async (o: Parameters<typeof readRpc>[1], list: Item[] = [ok]) => assert.rejects(dbcFees(readRpc(list, { configs: CONFIGS, ...o }).rpc, W));
  // pool com fee que existe mas, relido, está fora do formato: "não lida", não some calado (revisão de 09/11/2026)
  const odd = (n: number, extra: Partial<Item>): Item => ({ pubkey: poolAddr(n), data: poolBytes({ creator: W, quoteFee: 3_000_000n, n }), ...extra });
  const flipped = poolBytes({ creator: W, quoteFee: 3_000_000n, n: 6 });
  flipped[0] ^= 1;
  const newType = poolBytes({ creator: W, quoteFee: 3_000_000n, n: 13 });
  newType[304] = 2;
  await bad({}, [ok, odd(6, { full: flipped })]); // discriminador desconhecido
  await bad({}, [ok, odd(10, { full: Buffer.alloc(300) })]); // tamanho errado
  await bad({}, [ok, odd(11, { fullOwner: PROGRAMS.token })]); // dono errado na releitura
  await bad({}, [ok, odd(13, { full: newType })]); // pool_type novo
  await bad({ gpa: null });
  await bad({ gpa: { value: [] } });
  await bad({}, [{ pubkey: 'não é endereço', data: poolBytes({ creator: W, n: 1 }) }]);
  await bad({}, [{ pubkey: poolAddr(1), data: Buffer.alloc(4).toString('base64') }]); // fatia com outro tamanho
  await bad({ configs: { [CFG_SOL]: null } }); // config sumiu: não dá para saber a moeda
  await bad({ configs: { [CFG_SOL]: configBytes(WSOL_MINT, Buffer.alloc(8)) } }); // config com outro discriminador
  await bad({ failMulti: true }); // lista do tamanho errado
  // sem pool nenhum: vazio de verdade, sem leitura a mais
  const none = readRpc([], { configs: CONFIGS });
  assert.deepEqual(await dbcFees(none.rpc, W), { pools: [], found: 0, other: 0, cut: 0 });
  assert.deepEqual(none.calls, ['getProgramAccounts']);
});

test('dbc leitura: carteira com pools demais lê só os de maior fee e conta o resto (não trava a análise)', async () => {
  const items: Item[] = Array.from({ length: DBC_MAX_FEE_POOLS + 5 }, (_, i) => ({ pubkey: poolAddr(i), data: poolBytes({ creator: W, quoteFee: BigInt(1_000 + i), n: i }) }));
  const { rpc, calls } = readRpc(items, { configs: CONFIGS });
  const d = await dbcFees(rpc, W);
  assert.equal(d.pools.length, DBC_MAX_FEE_POOLS);
  assert.equal(d.cut, 5);
  assert.equal(d.found, DBC_MAX_FEE_POOLS + 5);
  assert.ok(d.pools.every((p) => p.quoteFee >= 1_005n), 'os 5 menores ficam de fora');
  assert.equal(calls.filter((c) => c === 'getMultipleAccounts').length, Math.ceil(DBC_MAX_FEE_POOLS / 100) + 1);
});

// carteira inteira pelo scanWallet: a fee da Meteora entra no total; a falha dela não derruba o resto
function walletRpc(dbc: 'ok' | 'fail') {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getTokenAccountsByOwner') return { value: [] } as T;
      if (method === 'getProgramAccounts') {
        if ((params[0] as string) !== PROGRAMS.meteoraDbc) return [] as T;
        if (dbc === 'fail') throw new RpcError('getProgramAccounts: HTTP 429', 429);
        return [{ pubkey: poolAddr(1), account: { data: [poolBytes({ creator: W, quoteFee: 4_000_000n, n: 1 }).subarray(352, 368).toString('base64'), 'base64'] } }] as T;
      }
      if (method === 'getMultipleAccounts') {
        const keys = params[0] as string[];
        if (keys[1] === pumpCreatorVault(keys[0])) return { value: [{ lamports: 10_000_000 }, { lamports: RENT0 + 300_000 }, null] } as T;
        return { value: keys.map((k) => (k === poolAddr(1) ? { owner: PROGRAMS.meteoraDbc, data: [poolBytes({ creator: W, quoteFee: 4_000_000n, n: 1 }).toString('base64'), 'base64'] } : k === CFG_SOL ? { owner: PROGRAMS.meteoraDbc, data: [configBytes(WSOL_MINT).subarray(0, 40).toString('base64'), 'base64'] } : null)) } as T;
      }
      throw new RpcError(`${method}: não previsto`);
    },
  } as RpcClient;
}

test('dbc leitura: entra no total de creator fees; falha vira "não lida" sem pular a carteira nem zerar a Pump.fun', async () => {
  const ok = await scanWallet(walletRpc('ok'), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true });
  assert.equal(ok.fees?.dbcError, null);
  assert.equal(totalCreatorFeeLamports(ok.fees!), 300_000n + 4_000_000n, 'cofre da curva + Meteora');
  assert.deepEqual(unreadParts(ok), []);
  const bad = await scanWallet(walletRpc('fail'), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true });
  assert.deepEqual(bad.errors, [], 'a carteira não fica como leitura incompleta no plano (o resto dela é limpo)');
  assert.match(bad.fees!.dbcError!, /429/);
  assert.equal(totalCreatorFeeLamports(bad.fees!), 300_000n, 'a fee da curva continua valendo');
  assert.deepEqual(unreadParts(bad).filter((u) => /Meteora/.test(u)).length, 1, '"não sei": a análise relê e a tela avisa');
  // sem detalhe (só cofres), nada da Meteora
  const quick = await scanWallet(walletRpc('ok'), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: false });
  assert.equal(quick.fees?.dbc, undefined);
});

// ---------- rede falsa com estado ----------

type Tok = { mint: string; owner: string; program: string; amount: bigint };
type Chain = { lamports: Map<string, number>; tokens: Map<string, Tok>; data: Map<string, { owner: string; data: Buffer }>; feesPaid: number; refuse?: boolean | number; dirtyPools?: boolean };
const SYSTEM_WALLETS = new Set([...S.map((s) => s.address), DEST, APP_FEE_WALLET]);

function decode(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  const numSigs = raw[0];
  const msg = raw.subarray(1 + 64 * numSigs);
  const nKeys = msg[3];
  const names = Array.from({ length: nKeys }, (_, i) => encodeBase58(msg.subarray(4 + 32 * i, 36 + 32 * i)));
  let pos = 4 + 32 * nKeys + 32;
  const ixs: Array<{ program: string; accounts: string[]; data: Buffer }> = [];
  const nIx = msg[pos++];
  for (let i = 0; i < nIx; i++) {
    const program = names[msg[pos++]];
    const accounts = [...msg.subarray(pos + 1, pos + 1 + msg[pos])].map((k) => names[k]);
    pos += 1 + msg[pos];
    const data = Buffer.from(msg.subarray(pos + 1, pos + 1 + msg[pos]));
    pos += 1 + msg[pos];
    ixs.push({ program, accounts, data });
  }
  return { signers: names.slice(0, msg[0]), payer: names[0], ixs, bytes: raw.length };
}

function apply(c: Chain, b64: string): { chain: Chain } | { err: string; code?: number } {
  const n: Chain = { lamports: new Map(c.lamports), tokens: new Map([...c.tokens].map(([k, v]) => [k, { ...v }])), data: new Map(c.data), feesPaid: c.feesPaid, refuse: c.refuse, dirtyPools: c.dirtyPools };
  const bal = (a: string) => n.lamports.get(a) ?? 0;
  const add = (a: string, v: number) => n.lamports.set(a, bal(a) + v);
  const move = (from: string, to: string, v: number) => {
    if (v < 0 || bal(from) < v) throw new Error(`insufficient lamports ${bal(from)}, need ${v}`);
    add(from, -v);
    add(to, v);
  };
  class Custom extends Error {
    code: number;
    constructor(code: number, m: string) {
      super(`Error Number: ${code}. ${m}`);
      this.code = code;
    }
  }
  const { signers, payer, ixs } = decode(b64);
  try {
    const fee = BASE_FEE_LAMPORTS * signers.length;
    if (bal(payer) < fee) throw new Error('payer sem SOL para a taxa');
    add(payer, -fee);
    n.feesPaid += fee;
    for (const x of ixs) {
      if (x.program === 'ComputeBudget111111111111111111111111111111') continue;
      if (x.program === PROGRAMS.system && x.data.readUInt32LE(0) === 2) {
        move(x.accounts[0], x.accounts[1], Number(x.data.readBigUInt64LE(4)));
      } else if (x.program === PROGRAMS.associatedToken) {
        const [p, ata, owner, mint, , program] = x.accounts;
        assert.equal(ata, ataOf(owner, mint, program), 'ATA no endereço certo');
        if (!n.tokens.has(ata)) {
          move(p, ata, program === PROGRAMS.token2022 ? RENT_T22 : RENT_TOKEN);
          n.tokens.set(ata, { mint, owner, program, amount: 0n });
        }
      } else if ((x.program === PROGRAMS.token || x.program === PROGRAMS.token2022) && x.data[0] === 9) {
        const [acc, to, owner] = x.accounts;
        const t = n.tokens.get(acc);
        if (!t) throw new Error(`conta ${acc} não existe (fechar)`);
        if (t.owner !== owner || !signers.includes(owner)) throw new Error('OwnerMismatch');
        if (t.mint !== WSOL_MINT && t.amount !== 0n) throw new Error('custom program error: 0xb NonNativeHasBalance');
        move(acc, to, bal(acc));
        n.lamports.delete(acc);
        n.tokens.delete(acc);
      } else if (x.program === PROGRAMS.meteoraDbc) {
        if (!x.data.subarray(0, 8).equals(DBC_CLAIM_CREATOR_TRADING_FEE_DISC)) throw new Error('instrução da DBC não prevista');
        const [auth, pool, tokenA, tokenB, baseVault, quoteVault, baseMint, quoteMint, creator, , , ev, prog] = x.accounts;
        assert.equal(auth, DBC_POOL_AUTHORITY);
        assert.equal(ev, EVENT_AUTHORITY);
        assert.equal(prog, PROGRAMS.meteoraDbc);
        if (tokenA === tokenB) throw new Custom(2040, 'ConstraintDuplicateMutableAccount');
        if (!n.tokens.has(tokenA) || !n.tokens.has(tokenB)) throw new Custom(3012, 'AccountNotInitialized');
        const acc = n.data.get(pool);
        if (!acc || acc.owner !== PROGRAMS.meteoraDbc) throw new Custom(6075, 'InvalidPoolAccount');
        const b = Buffer.from(acc.data);
        const k = (o: number) => encodeBase58(b.subarray(o, o + 32));
        if (k(DBC_OFFSETS.creator) !== creator || !signers.includes(creator)) throw new Custom(6053, 'Unauthorized');
        if (b.subarray(0, 8).equals(DBC_TRANSFER_HOOK_POOL_DISC)) throw new Custom(6076, 'PoolTypeMismatch');
        if (k(DBC_OFFSETS.baseVault) !== baseVault || k(DBC_OFFSETS.quoteVault) !== quoteVault || k(DBC_OFFSETS.baseMint) !== baseMint) throw new Custom(2001, 'ConstraintHasOne');
        if (n.tokens.get(tokenB)!.mint !== quoteMint || quoteMint !== WSOL_MINT) throw new Custom(2014, 'ConstraintTokenMint');
        if (n.refuse) throw new Custom(typeof n.refuse === 'number' ? n.refuse : 6099, 'o programa mudou');
        const maxBase = x.data.readBigUInt64LE(8);
        const maxQuote = x.data.readBigUInt64LE(16);
        const baseFee = b.readBigUInt64LE(DBC_OFFSETS.creatorBaseFee);
        const quoteFee = b.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee);
        const base = baseFee < maxBase ? baseFee : maxBase;
        const quote = quoteFee < maxQuote ? quoteFee : maxQuote;
        b.writeBigUInt64LE(quoteFee - quote, DBC_OFFSETS.creatorQuoteFee);
        b.writeBigUInt64LE(baseFee - base, DBC_OFFSETS.creatorBaseFee);
        n.data.set(pool, { ...acc, data: b });
        if (base > 0n) n.tokens.get(tokenA)!.amount += base;
        if (quote > 0n) add(tokenB, Number(quote)); // WSOL: o saldo é lamport
      } else {
        throw new Error(`instrução não prevista no teste: ${x.program}`);
      }
    }
    for (const a of SYSTEM_WALLETS) {
      const l = bal(a);
      if (l > 0 && l < RENT0) throw new Error(`InsufficientFundsForRent ${a}`);
    }
    for (const [a, l] of n.lamports) if (l === 0) n.lamports.delete(a);
    return { chain: n };
  } catch (e) {
    return { err: (e as Error).message, code: (e as { code?: number }).code };
  }
}

function chainRpc(state: { chain: Chain }, sizes: number[] = [], priority = 0): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const c = state.chain;
      switch (method) {
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'getRecentPrioritizationFees':
          return [{ prioritizationFee: priority }] as T;
        case 'getMultipleAccounts': {
          const [keys, cfg] = params as [string[], { encoding?: string; dataSlice?: { offset: number; length: number } }];
          return {
            value: keys.map((a) => {
              const d = c.data.get(a);
              if (d) {
                const s = cfg.dataSlice ? d.data.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) : d.data;
                return c.dirtyPools ? { lamports: 1, data: 'lixo' } : { lamports: c.lamports.get(a) ?? 1, owner: d.owner, data: [s.toString('base64'), 'base64'] };
              }
              const t = c.tokens.get(a);
              if (t) return cfg.encoding === 'jsonParsed' ? { lamports: c.lamports.get(a), owner: t.program, data: { parsed: { info: { mint: t.mint, owner: t.owner, isNative: t.mint === WSOL_MINT, tokenAmount: { amount: String(t.amount) } } } } } : { lamports: c.lamports.get(a), owner: t.program, data: ['', 'base64'] };
              return c.lamports.has(a) ? { lamports: c.lamports.get(a), owner: PROGRAMS.system, data: ['', 'base64'] } : null;
            }),
          } as T;
        }
        case 'getAccountInfo': {
          const a = params[0] as string;
          return { value: c.lamports.has(a) ? { owner: PROGRAMS.system, lamports: c.lamports.get(a), executable: false } : null } as T;
        }
        case 'getMinimumBalanceForRentExemption':
          return RENT0 as T;
        case 'simulateTransaction': {
          sizes.push(decode(params[0] as string).bytes);
          const r = apply(c, params[0] as string);
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          if ('err' in r) return { value: { err: { InstructionError: [0, r.code !== undefined ? { Custom: r.code } : 'Custom'] }, logs: [`Program log: Error: ${r.err}`], accounts: null } } as T;
          return { value: { err: null, logs: [], unitsConsumed: 60_000, accounts: addrs.map((a) => (r.chain.lamports.has(a) ? { lamports: r.chain.lamports.get(a) } : null)) } } as T;
        }
        case 'sendTransaction': {
          const r = apply(c, params[0] as string);
          if ('err' in r) throw new RpcError(`sendTransaction: ${r.err}`, -32002);
          state.chain = r.chain;
          return 'sig' as T;
        }
        case 'getSignatureStatuses':
          return { value: [{ err: null, confirmationStatus: 'confirmed' }] } as T;
        case 'getBlockHeight':
          return 10 as T;
        default:
          throw new RpcError(`${method}: não previsto no teste`);
      }
    },
  };
}

const emptyFees = (w: string, dbcPools: DbcPool[]): CreatorFees => ({
  bondingVault: pumpCreatorVault(w), bondingVaultLamports: 0, ammVaultAta: pumpAmmCreatorVaultAta(w), ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null,
  dbc: { pools: dbcPools, found: dbcPools.length, other: 0, cut: 0 }, dbcError: null,
});

type Setup = {
  wallets: number[]; // lamports de S0..S3 (S0 = a pagadora, a mais rica)
  pools: Array<{ wallet: number; n: number; fee: bigint; poolType?: number; feeNow?: bigint; creatorNow?: number; baseFee?: bigint }>;
  wsolAta?: Record<number, number>; // a temporária já tem a ATA WSOL, com estes lamports
  baseAta?: Record<number, bigint>; // conta da moeda do pool n já existe, com este saldo de token
};

function setup(o: Setup) {
  const lamports = new Map<string, number>([[DEST, 50_000_000], [APP_FEE_WALLET, 100_000_000]]);
  const tokens = new Map<string, Tok>();
  const data = new Map<string, { owner: string; data: Buffer }>();
  o.wallets.forEach((l, i) => l > 0 && lamports.set(S[i].address, l));
  const scans: WalletScan[] = o.wallets.map((l, i) => {
    const w = S[i].address;
    const mine = o.pools.filter((p) => p.wallet === i);
    const dbcPools = mine.map((p) => dbcPool(p.n, p.fee, { baseTokenProgram: p.poolType === 1 ? PROGRAMS.token2022 : PROGRAMS.token }));
    for (const p of mine) {
      data.set(poolAddr(p.n), { owner: PROGRAMS.meteoraDbc, data: poolBytes({ creator: S[p.creatorNow ?? i].address, quoteFee: p.feeNow ?? p.fee, baseFee: p.baseFee, poolType: p.poolType, n: p.n }) });
      lamports.set(poolAddr(p.n), 3_000_000);
      const program = p.poolType === 1 ? PROGRAMS.token2022 : PROGRAMS.token;
      if (o.baseAta?.[p.n] !== undefined) {
        const a = ataOf(w, addr(100 + p.n), program);
        tokens.set(a, { mint: addr(100 + p.n), owner: w, program, amount: o.baseAta[p.n] });
        lamports.set(a, program === PROGRAMS.token2022 ? RENT_T22 : RENT_TOKEN);
      }
    }
    const scanTokens = [];
    if (o.wsolAta?.[i]) {
      const a = ataOf(w, WSOL_MINT);
      lamports.set(a, o.wsolAta[i]);
      tokens.set(a, { mint: WSOL_MINT, owner: w, program: PROGRAMS.token, amount: 0n });
      scanTokens.push(parseTokenAccount({ pubkey: a, account: { lamports: o.wsolAta[i], data: { parsed: { info: { mint: WSOL_MINT, isNative: true, state: 'initialized', tokenAmount: { amount: '0', decimals: 9 } } } } } }, w, 'token'));
    }
    return { index: i, address: w, lamports: l, tokens: scanTokens, fees: mine.length ? emptyFees(w, dbcPools) : null, errors: [] };
  });
  return { state: { chain: { lamports, tokens, data, feesPaid: 0 } as Chain }, scans };
}

async function roundTrip(o: Setup, edit?: (plan: Plan, state: { chain: Chain }) => void) {
  const { state, scans } = setup(o);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  edit?.(plan, state);
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = { dest: state.chain.lamports.get(DEST)!, fee: state.chain.lamports.get(APP_FEE_WALLET)! };
  const done: StepResult[] = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before.dest);
  const feeArrived = BigInt(state.chain.lamports.get(APP_FEE_WALLET)! - before.fee);
  const executed = buildReceipt({ plan, simResults: done, holdings: [], main: DEST, executed: true });
  return { plan, sims, receipt, done, executed, arrived, feeArrived, chain: state.chain };
}

// mostrado = chegado (a menos de 1 lamport por divisão dos 11%); linhas somam o total; a tela final conta as mesmas coletas
function assertShownMatchesArrived(r: Awaited<ReturnType<typeof roundTrip>>) {
  const diff = r.receipt.totalLamports - r.arrived;
  const slack = BigInt(r.done.length + 1);
  assert.ok(diff >= -slack && diff <= slack, `mostrado ${r.receipt.totalLamports}, chegou ${r.arrived}`);
  const d = r.receipt.toDestination;
  assert.equal(d.looseSolLamports + d.closedRentLamports + d.claimLamports + d.depositLamports - r.receipt.appFeeLamports, r.receipt.totalLamports);
  assert.equal(r.executed.totalLamports, r.arrived, 'tela final: total = chegou');
  assert.equal(r.executed.toDestination.claims, d.claims, 'tela final: mesmas coletas');
  assert.equal(r.executed.toDestination.claimLamports, d.claimLamports, 'creator fees: Confirmar = tela final');
}

const dbcResults = (rs: StepResult[]) => rs.filter((x) => x.step.kind === 'claim-dbc');

test('dbc: temporária vazia, sem ATA WSOL nem conta da moeda: a fee aparece na Confirmar e chega (89/11); nada fica para trás', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0], pools: [{ wallet: 1, n: 1, fee: 3_000_000n }] });
  assertShownMatchesArrived(r);
  assert.deepEqual(r.plan.steps.map((s) => s.kind), ['claim-dbc', 'sweep-sol', 'sweep-sol']);
  const [sim] = dbcResults(r.sims);
  assert.equal(sim.status, 'simulado');
  const fee = appFeeLamports(3_000_000n, appFeeFor(DEST));
  assert.equal(sim.destinationDelta, 3_000_000n - fee, '89% ao destino na mesma transação');
  assert.equal(sim.appFeeDelta, fee, '11% à carteira da taxa');
  assert.equal(r.receipt.toDestination.claims, 1);
  assert.equal(r.receipt.toDestination.claimLamports, 3_000_000n, 'linha "Creator fees e cashback": bruto');
  const w = S[1].address;
  assert.equal(r.chain.lamports.get(w) ?? 0, 0, 'a temporária termina vazia');
  assert.ok(!r.chain.tokens.has(ataOf(w, WSOL_MINT)), 'a ATA WSOL criada foi fechada');
  assert.ok(!r.chain.tokens.has(ataOf(w, addr(101))), 'a conta da moeda criada para o token_a foi fechada');
  assert.equal(r.chain.data.get(poolAddr(1))!.data.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee), 0n, 'a fee saiu do pool');
  assert.equal(r.executed.toDestination.claims, 1);
});

test('dbc: 3 pools em 2 lotes, ATA WSOL que já existia (aluguel conta uma vez), conta da moeda com saldo fica intacta, Token-2022', async () => {
  const r = await roundTrip({
    wallets: [50_000_000, 0],
    pools: [{ wallet: 1, n: 1, fee: 2_000_000n }, { wallet: 1, n: 2, fee: 1_500_000n, poolType: 1 }, { wallet: 1, n: 3, fee: 900_000n }],
    wsolAta: { 1: RENT_TOKEN },
    baseAta: { 1: 777n },
  });
  assertShownMatchesArrived(r);
  const steps = r.plan.steps.filter((s): s is Extract<Step, { kind: 'claim-dbc' }> => s.kind === 'claim-dbc');
  assert.deepEqual(steps.map((s) => s.pools.length), [2, 1], `lotes de ${DBC_POOLS_PER_TX}`);
  assert.deepEqual(steps.map((s) => s.wsolClosedBefore === true), [false, true], 'o 2º lote não conta a ATA WSOL de novo');
  assert.ok(!r.plan.steps.some((s) => s.kind === 'tokens'), 'a ATA WSOL sai do passo das contas (a coleta a fecha)');
  assert.equal(r.receipt.toDestination.claimLamports, 4_400_000n);
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(RENT_TOKEN), 'o aluguel da ATA WSOL antiga uma vez, em "contas fechadas"');
  assert.equal(r.receipt.toDestination.claims, 2);
  const w = S[1].address;
  assert.equal(r.chain.tokens.get(ataOf(w, addr(101)))?.amount, 777n, 'a conta da moeda que já existia fica como estava');
  assert.ok(!r.chain.tokens.has(ataOf(w, addr(102), PROGRAMS.token2022)), 'a conta Token-2022 criada foi fechada');
  assert.equal(r.chain.lamports.get(w) ?? 0, 0);
});

test('dbc: o criador é a pagadora (coleta nela mesma), mostrado = chegado', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 1_000_000], pools: [{ wallet: 0, n: 1, fee: 5_000_000n }, { wallet: 1, n: 2, fee: 800_000n }] });
  assertShownMatchesArrived(r);
  assert.deepEqual(dbcResults(r.done).map((x) => x.status), ['enviado', 'enviado']);
  assert.equal(r.receipt.toDestination.claimLamports, 5_800_000n);
  assert.equal(r.chain.lamports.get(S[0].address) ?? 0, 0, 'a pagadora se esvazia no fim');
});

test('dbc: fee que caiu abaixo da taxa da rede, pool que mudou de criador: pula com o motivo, e a ATA WSOL antiga ainda é fechada', async () => {
  const r = await roundTrip({
    wallets: [50_000_000, 0, 0],
    pools: [{ wallet: 1, n: 1, fee: 30_000n, feeNow: 9_000n }, { wallet: 2, n: 2, fee: 2_000_000n, creatorNow: 3 }],
    wsolAta: { 1: RENT_TOKEN },
  });
  assertShownMatchesArrived(r);
  const [small, moved] = dbcResults(r.sims);
  assert.equal(small.status, 'simulado', 'só fecha a ATA WSOL que já existia');
  assert.equal(small.skippedClaim, true);
  assert.match(small.detail!, /menor que a taxa da rede/);
  assert.equal(moved.status, 'nada a fazer');
  assert.match(moved.detail!, /mudou/);
  assert.equal(r.receipt.toDestination.claims, 0, 'nenhuma coleta contada');
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(RENT_TOKEN));
  assert.equal(r.chain.data.get(poolAddr(1))!.data.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee), 9_000n, 'a fee pequena fica no pool');
  assert.ok(!r.chain.tokens.has(ataOf(S[1].address, WSOL_MINT)));
});

test('dbc: o programa recusa (mudou): esta coleta falha, as próximas da Meteora são canceladas e o resto da limpeza segue', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 2_000_000, 3_000_000], pools: [{ wallet: 1, n: 1, fee: 2_000_000n }, { wallet: 2, n: 2, fee: 2_000_000n }] }, (_p, state) => {
    state.chain.refuse = true;
  });
  for (const rs of [r.sims, r.done]) {
    const [first, second] = dbcResults(rs);
    assert.equal(first.status, 'falhou');
    assert.equal(first.error?.code, 'dbc-claim-failed');
    assert.equal(second.status, 'cancelado', 'não insiste');
    assert.equal(second.error?.code, 'dbc-claim-failed');
    assert.deepEqual(rs.filter((x) => x.step.kind === 'sweep-sol').map((x) => x.status), rs === r.sims ? ['simulado', 'simulado', 'simulado'] : ['enviado', 'enviado', 'enviado'], 'o SOL das carteiras ainda vai');
  }
  assert.equal(r.receipt.failed.length, 2);
  assert.equal(r.receipt.totalLamports, r.arrived, 'nada de fee contada');
  assert.equal(r.chain.data.get(poolAddr(1))!.data.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee), 2_000_000n, 'a fee continua no pool');
  assert.equal(explainError('qualquer', { stepKind: 'claim-dbc' }).code, 'dbc-claim-failed');
});

test('dbc: a fee na moeda (base) fica no pool: só a fee em SOL é coletada, a conta da moeda criada fecha vazia', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0], pools: [{ wallet: 1, n: 1, fee: 2_000_000n, baseFee: 123_456n }] });
  assertShownMatchesArrived(r);
  assert.deepEqual(dbcResults(r.done).map((x) => x.status), ['enviado']);
  const pool = r.chain.data.get(poolAddr(1))!.data;
  assert.equal(pool.readBigUInt64LE(DBC_OFFSETS.creatorBaseFee), 123_456n, 'max_base_amount = 0');
  assert.equal(pool.readBigUInt64LE(DBC_OFFSETS.creatorQuoteFee), 0n);
  assert.ok(!r.chain.tokens.has(ataOf(S[1].address, addr(101))));
});

test('dbc: erro 6050 da Meteora não é a "fee sharing" da Pump.fun: falha da coleta, não "nada a fazer"', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0], pools: [{ wallet: 1, n: 1, fee: 2_000_000n }] }, (_p, state) => {
    state.chain.refuse = 6050;
  });
  const [x] = dbcResults(r.sims);
  assert.equal(x.status, 'falhou');
  assert.equal(x.error?.code, 'dbc-claim-failed');
  assert.deepEqual(r.receipt.feeSharing, [], 'não vira aviso de fee sharing');
});

test('dbc: releitura do pool fora do formato: só a coleta falha (não sei), o resto da limpeza segue', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 2_000_000], pools: [{ wallet: 1, n: 1, fee: 2_000_000n }] }, (_p, state) => {
    state.chain.dirtyPools = true;
  });
  const [x] = dbcResults(r.done);
  assert.equal(x.status, 'falhou');
  assert.equal(x.error?.code, 'dbc-claim-failed');
  assert.deepEqual(r.done.filter((y) => y.step.kind === 'sweep-sol').map((y) => y.status), ['enviado', 'enviado']);
  assert.equal(r.receipt.totalLamports, r.arrived);
});

test('dbc: na releitura, pool com os mesmos bytes mas de outro programa (fechado e recriado) não é coletado', async () => {
  // a conta tem o formato e o creator certos, só o dono mudou: sem conferir o dono, o executor montaria a coleta
  const r = await roundTrip({ wallets: [50_000_000, 2_000_000], pools: [{ wallet: 1, n: 1, fee: 2_000_000n }] }, (_p, state) => {
    const pool = state.chain.data.get(poolAddr(1))!;
    state.chain.data.set(poolAddr(1), { ...pool, owner: PROGRAMS.system });
  });
  for (const rs of [r.sims, r.done]) {
    const [x] = dbcResults(rs);
    assert.equal(x.status, 'nada a fazer');
    assert.match(x.detail!, /mudou/);
  }
  assert.equal(r.receipt.toDestination.claims, 0, 'nenhuma coleta contada');
  assert.equal(r.receipt.totalLamports, r.arrived);
});

test('dbc: transação de 2 pools cabe no limite no pior caso; 3 pools não cabem e o executor divide', async () => {
  // pior caso: Token-2022, conta da moeda e ATA WSOL criadas, temporária ≠ pagadora, taxa do app, prioridade
  const worst: Setup = { wallets: [50_000_000, 0], pools: [1, 2, 3].map((n) => ({ wallet: 1, n, fee: 1_000_000n, poolType: 1 })) };
  const { state, scans } = setup(worst);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const sizes: number[] = [];
  const sims = await execute({ rpc: chainRpc(state, sizes, 1_000), plan, signers, mode: 'simulate' });
  assert.ok(dbcResults(sims).every((x) => x.status === 'simulado'), dbcResults(sims).map((x) => x.detail).join(' | '));
  const max = Math.max(...sizes);
  assert.ok(max <= MAX_TX_BYTES, `a maior transação tem ${max} bytes`);
  // um passo com 3 pools (plano de antes de DBC_POOLS_PER_TX, ou conta maior que a medida) é dividido, não falha
  const three = { ...plan, steps: [{ kind: 'claim-dbc', walletIndex: 1, wallet: S[1].address, estimateLamports: 3_000_000n, pools: [1, 2, 3].map((n) => dbcPool(n, 1_000_000n, { baseTokenProgram: PROGRAMS.token2022 })) } as Step, ...plan.steps.filter((s) => s.kind === 'sweep-sol')] };
  const s3 = await execute({ rpc: chainRpc(setup(worst).state, [], 1_000), plan: three, signers, mode: 'simulate' });
  assert.deepEqual(dbcResults(s3).map((x) => (x.step as Extract<Step, { kind: 'claim-dbc' }>).pools.length), [2, 1]);
  assert.ok(dbcResults(s3).every((x) => x.status === 'simulado'));
  assert.equal(buildReceipt({ plan: three, simResults: s3, holdings: [], main: DEST }).toDestination.claimLamports, 3_000_000n);
});

// ---------- plano ----------

test('dbc plano: soma abaixo do mínimo não monta passo; reserva conta a transação e o empréstimo das contas', () => {
  const base = setup({ wallets: [50_000_000, 0], pools: [] }).scans;
  const withPools = (fees: bigint[], program = PROGRAMS.token) => base.map((s, i) => (i === 1 ? { ...s, fees: emptyFees(s.address, fees.map((f, n) => dbcPool(n, f, { baseTokenProgram: program }))) } : s));
  const tiny = buildPlan({ scans: withPools([BigInt(MIN_CLAIM_LAMPORTS)]), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!tiny.steps.some((s) => s.kind === 'claim-dbc'), 'fee que não paga a coleta não vira passo');
  const none = buildPlan({ scans: base.map((s, i) => (i === 1 ? { ...s, lamports: 1 } : s)), prices: new Map(), destination: DEST, rentExemptZero: RENT0 }).reserveNeededLamports;
  const one = buildPlan({ scans: withPools([1_000_000n]), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.equal(one.steps.filter((s) => s.kind === 'claim-dbc').length, 1);
  const perTx = BigInt(BASE_FEE_LAMPORTS) * 3n;
  // 1 transação a mais (a coleta) e o maior empréstimo: ATA WSOL + conta da moeda
  assert.equal(one.reserveNeededLamports - none, perTx + 2n * BigInt(RENT_TOKEN));
  const t22 = buildPlan({ scans: withPools([1_000_000n, 1_000_000n], PROGRAMS.token2022), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.equal(t22.reserveNeededLamports - none, perTx + BigInt(RENT_TOKEN) + 2n * rentFor(400, RENT0), 'Token-2022: a conta maior, por pool do lote');
  // dado da análise de antes desta regra (sem dbc): nada muda
  const old = buildPlan({ scans: base.map((s, i) => (i === 1 ? { ...s, fees: { ...emptyFees(s.address, []), dbc: undefined } } : s)), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!old.steps.some((s) => s.kind === 'claim-dbc'));
});
