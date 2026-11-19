// Creator fee do Raydium LaunchLab (09/11/2026): leitura do cofre com dado sujo, plano, executor numa rede falsa COM
// ESTADO (o que a Confirmar mostra é o que chega, 89/11 exatos), falha segura e o tamanho da transação.
//
// A rede falsa executa as instruções que o app monta (transferência, criar ATA, fechar conta de token e a
// claim_creator_fee do LaunchLab) com as regras do contexto ClaimCreatorFee (crate CPI 115df27, IDL 0.2.0,
// docs/launchlab.md): o criador assina; a authority e o cofre têm que ser os PDAs certos (o cofre sai da chave do
// criador: 2006 ConstraintSeeds); a conta que recebe tem que ser a ATA do criador na moeda (init_if_needed com o criador
// pagando, se faltar); o programa de token é o Token; e todo o saldo do cofre vai para a ATA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, MIN_CLAIM_LAMPORTS, rentFor, TOKEN_ACCOUNT_BYTES, type Plan, type Step } from '../../src/core/limpeza/plan.ts';
import { execute, type StepResult } from '../../src/core/limpeza/executor.ts';
import { buildReceipt } from '../../src/app/receipt.ts';
import { LAUNCHLAB_FEE_VAULT_AUTH, LAUNCHLAB_OTHER_QUOTES, launchlabCreatorFeeVault, launchlabFees, parseLaunchlabVault } from '../../src/core/limpeza/launchlab.ts';
import { parseTokenAccount, scanWallet, totalCreatorFeeLamports, unreadParts, type CreatorFees, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { decodeBase58, encodeBase58 } from '../../src/core/solana/base58.ts';
import { associatedTokenAddress, findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { LAUNCHLAB_CLAIM_CREATOR_FEE_DISC, launchlabClaimCreatorFee } from '../../src/core/solana/instructions.ts';
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
const LL = PROGRAMS.raydiumLaunchlab;
const USD1 = LAUNCHLAB_OTHER_QUOTES[0];
const ataOf = (owner: string, mint: string, program: string = PROGRAMS.token) => associatedTokenAddress(owner, mint, program);

// conta de token do cofre (165 bytes): mint, authority, amount, estado
function vaultBytes(o: { mint?: string; authority?: string; amount?: bigint; state?: number; size?: number } = {}): Buffer {
  const b = Buffer.alloc(o.size ?? 165);
  Buffer.from(decodeBase58(o.mint ?? WSOL_MINT)).copy(b, 0);
  Buffer.from(decodeBase58(o.authority ?? LAUNCHLAB_FEE_VAULT_AUTH)).copy(b, 32);
  b.writeBigUInt64LE(o.amount ?? 0n, 64);
  b[108] = o.state ?? 1;
  return b;
}
const acc = (data: Buffer, owner: string = PROGRAMS.token) => ({ owner, lamports: RENT_TOKEN, data: [data.toString('base64'), 'base64'] });

// ---------- instrução e endereços ----------

test('launchlab: instrução claim_creator_fee no formato do IDL 0.2.0 (8 contas, sem argumentos); PDAs da authority e do cofre', () => {
  const W = S[1].address;
  const vault = launchlabCreatorFeeVault(W);
  const ix = launchlabClaimCreatorFee(W, LAUNCHLAB_FEE_VAULT_AUTH, vault);
  assert.equal(ix.programId, 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj');
  assert.deepEqual([...ix.data], [26, 97, 138, 203, 132, 171, 141, 252]);
  assert.deepEqual([...LAUNCHLAB_CLAIM_CREATOR_FEE_DISC], [26, 97, 138, 203, 132, 171, 141, 252]);
  assert.equal(LAUNCHLAB_FEE_VAULT_AUTH, findProgramAddress(['creator_fee_vault_auth_seed'], LL).address, 'endereço fixo = PDA do programa');
  assert.equal(LAUNCHLAB_FEE_VAULT_AUTH, '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan');
  assert.equal(vault, findProgramAddress([decodeBase58(W), decodeBase58(WSOL_MINT)], LL).address, 'cofre = PDA [criador, WSOL]');
  assert.notEqual(launchlabCreatorFeeVault(W, USD1), vault, 'um cofre por moeda');
  assert.deepEqual(ix.keys.map((k) => k.pubkey), [W, LAUNCHLAB_FEE_VAULT_AUTH, vault, ataOf(W, WSOL_MINT), WSOL_MINT, PROGRAMS.token, PROGRAMS.system, PROGRAMS.associatedToken]);
  assert.deepEqual(ix.keys.map((k) => `${k.isWritable ? 'W' : '-'}${k.isSigner ? 'S' : '-'}`), ['WS', '--', 'W-', 'W-', '--', '--', '--', '--']);
});

// ---------- leitura ----------

function readRpc(values: Record<string, unknown>, opts: { raw?: unknown; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method !== 'getMultipleAccounts') throw new RpcError(`${method}: não previsto`);
      const keys = params[0] as string[];
      calls.push(keys);
      if (opts.fail) throw new RpcError('getMultipleAccounts: HTTP 429', 429);
      if (opts.raw !== undefined) return opts.raw as T;
      return { value: keys.map((k) => (k in values ? values[k] : null)) } as T;
    },
  };
  return { rpc, calls };
}
const W = S[1].address;
const VAULT = launchlabCreatorFeeVault(W);

test('launchlab leitura: 1 consulta (cofre em WSOL + USD1, USDC, USDT); sem cofre é zero de verdade; fee em outra moeda só conta', async () => {
  const none = readRpc({});
  assert.deepEqual(await launchlabFees(none.rpc, W), { vault: VAULT, lamports: 0n, other: 0 });
  assert.equal(none.calls.length, 1, 'uma consulta por carteira');
  assert.deepEqual(none.calls[0], [VAULT, ...LAUNCHLAB_OTHER_QUOTES.map((q) => launchlabCreatorFeeVault(W, q))]);
  const some = readRpc({
    [VAULT]: acc(vaultBytes({ amount: 7_654_321n })),
    [launchlabCreatorFeeVault(W, USD1)]: acc(vaultBytes({ mint: USD1, amount: 5n })),
    [launchlabCreatorFeeVault(W, LAUNCHLAB_OTHER_QUOTES[1])]: acc(vaultBytes({ mint: LAUNCHLAB_OTHER_QUOTES[1], amount: 0n })), // vazio: não conta
    [launchlabCreatorFeeVault(W, LAUNCHLAB_OTHER_QUOTES[2])]: acc(vaultBytes({ mint: LAUNCHLAB_OTHER_QUOTES[2], amount: 9n, size: 182 }), PROGRAMS.token2022), // Token-2022 com extensão
  });
  assert.deepEqual(await launchlabFees(some.rpc, W), { vault: VAULT, lamports: 7_654_321n, other: 2 });
  const empty = readRpc({ [VAULT]: acc(vaultBytes({ amount: 0n })) });
  assert.equal((await launchlabFees(empty.rpc, W)).lamports, 0n, 'cofre que existe e está vazio');
});

test('launchlab leitura: dado fora do formato é "não sei" (lança), nunca "sem fee"', async () => {
  const bad = async (v: unknown, raw?: unknown) => assert.rejects(launchlabFees(readRpc({ [VAULT]: v }, raw === undefined ? {} : { raw }).rpc, W));
  await bad(acc(vaultBytes({ amount: 5n })), { value: [] }); // lista do tamanho errado
  await bad(acc(vaultBytes({ amount: 5n })), null); // sem resposta
  await bad(acc(vaultBytes({ amount: 5n })), { value: 'x' });
  await bad(acc(vaultBytes({ amount: 5n }), PROGRAMS.system)); // dono que não é o programa de token
  await bad(acc(vaultBytes({ amount: 5n }), PROGRAMS.token2022)); // WSOL é do Token, não do Token-2022
  await bad(acc(vaultBytes({ amount: 5n, size: 100 }))); // tamanho errado
  await bad(acc(vaultBytes({ amount: 5n, size: 182 }))); // Token com tamanho de Token-2022
  await bad(acc(vaultBytes({ amount: 5n, mint: USD1 }))); // outra moeda no endereço do cofre de WSOL
  await bad(acc(vaultBytes({ amount: 5n, authority: S[2].address }))); // outra authority
  await bad(acc(vaultBytes({ amount: 5n, state: 2 }))); // congelado
  await bad(acc(vaultBytes({ amount: 5n, state: 0 }))); // não inicializado
  await bad({ owner: PROGRAMS.token, data: [123, 'base64'] }); // dado que não é texto
  await bad({ data: [vaultBytes({ amount: 5n }).toString('base64'), 'base64'] }); // sem dono
  // dado sujo no cofre de outra moeda também é "não sei" (a contagem do aviso ficaria errada)
  await assert.rejects(launchlabFees(readRpc({ [launchlabCreatorFeeVault(W, USD1)]: acc(vaultBytes({ mint: WSOL_MINT, amount: 5n })) }).rpc, W));
  assert.equal(parseLaunchlabVault(null, WSOL_MINT), null);
  await assert.rejects(launchlabFees(readRpc({}, { fail: true }).rpc, W), /429/);
});

// carteira inteira pelo scanWallet: a fee do LaunchLab entra no total; a falha dela não derruba o resto
function walletRpc(mode: 'ok' | 'fail' | 'dirty') {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'getTokenAccountsByOwner') return { value: [] } as T;
      if (method === 'getProgramAccounts') return [] as T;
      if (method === 'getMultipleAccounts') {
        const keys = params[0] as string[];
        if (keys[1] === pumpCreatorVault(keys[0])) return { value: [{ lamports: 10_000_000 }, { lamports: RENT0 + 300_000 }, null] } as T;
        if (keys[0] === VAULT) {
          if (mode === 'fail') throw new RpcError('getMultipleAccounts: HTTP 429', 429);
          return { value: keys.map((k) => (k === VAULT ? acc(vaultBytes({ amount: 4_000_000n, state: mode === 'dirty' ? 2 : 1 })) : null)) } as T;
        }
        return { value: keys.map(() => null) } as T;
      }
      throw new RpcError(`${method}: não previsto`);
    },
  } as RpcClient;
}

test('launchlab leitura: entra no total de creator fees; falha ou dado sujo vira "não lida" sem pular a carteira nem zerar a Pump.fun', async () => {
  const inner = walletRpc('ok');
  const seen: string[] = [];
  const counting: RpcClient = { call: (m, p) => (seen.push(m === 'getMultipleAccounts' && (p[0] as string[])[0] === VAULT ? 'launchlab' : m), inner.call(m, p)) };
  const ok = await scanWallet(counting, { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true });
  assert.equal(seen.filter((m) => m === 'launchlab').length, 1, 'custo: 1 getMultipleAccounts por carteira (RUN_COSTS.analysisReqPerWallet)');
  assert.equal(ok.fees?.launchlabError, null);
  assert.equal(ok.fees?.launchlab?.lamports, 4_000_000n);
  assert.equal(totalCreatorFeeLamports(ok.fees!), 300_000n + 4_000_000n, 'cofre da curva + LaunchLab');
  assert.deepEqual(unreadParts(ok), []);
  for (const mode of ['fail', 'dirty'] as const) {
    const bad = await scanWallet(walletRpc(mode), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true });
    assert.deepEqual(bad.errors, [], 'a carteira não fica como leitura incompleta no plano (o resto dela é limpo)');
    assert.ok(bad.fees!.launchlabError, mode);
    assert.equal(totalCreatorFeeLamports(bad.fees!), 300_000n, 'a fee da curva continua valendo; o LaunchLab não entra');
    assert.deepEqual(unreadParts(bad).filter((u) => /LaunchLab/.test(u)).length, 1, '"não sei": a análise relê e a tela avisa');
  }
  const quick = await scanWallet(walletRpc('ok'), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: false });
  assert.equal(quick.fees?.launchlab, undefined, 'sem detalhe (só cofres da Pump.fun), nada do LaunchLab');
});

// ---------- rede falsa com estado ----------

type Tok = { mint: string; owner: string; program: string; amount: bigint };
type Chain = { lamports: Map<string, number>; tokens: Map<string, Tok>; data: Map<string, { owner: string; data: Buffer }>; feesPaid: number; refuse?: boolean; refuseFinal?: boolean; refuseSend?: boolean; dirtyVault?: boolean; noListVault?: boolean };
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

class Custom extends Error {
  code: number;
  constructor(code: number, m: string) {
    super(`Error Number: ${code}. ${m}`);
    this.code = code;
  }
}

function apply(c: Chain, b64: string): { chain: Chain } | { err: string; code?: number } {
  const n: Chain = { ...c, lamports: new Map(c.lamports), tokens: new Map([...c.tokens].map(([k, v]) => [k, { ...v }])), data: new Map([...c.data].map(([k, v]) => [k, { ...v, data: Buffer.from(v.data) }])) };
  const bal = (a: string) => n.lamports.get(a) ?? 0;
  const add = (a: string, v: number) => n.lamports.set(a, bal(a) + v);
  const move = (from: string, to: string, v: number) => {
    if (v < 0 || bal(from) < v) throw new Error(`insufficient lamports ${bal(from)}, need ${v}`);
    add(from, -v);
    add(to, v);
  };
  const createAta = (payer: string, owner: string, mint: string, program: string) => {
    const ata = ataOf(owner, mint, program);
    if (!n.tokens.has(ata)) {
      move(payer, ata, RENT_TOKEN);
      n.tokens.set(ata, { mint, owner, program, amount: 0n });
    }
    return ata;
  };
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
        createAta(p, owner, mint, program);
      } else if ((x.program === PROGRAMS.token || x.program === PROGRAMS.token2022) && x.data[0] === 9) {
        const [account, to, owner] = x.accounts;
        const t = n.tokens.get(account);
        if (!t) throw new Error(`conta ${account} não existe (fechar)`);
        if (t.owner !== owner || !signers.includes(owner)) throw new Error('OwnerMismatch');
        if (t.mint !== WSOL_MINT && t.amount !== 0n) throw new Error('custom program error: 0xb NonNativeHasBalance');
        move(account, to, bal(account));
        n.lamports.delete(account);
        n.tokens.delete(account);
      } else if (x.program === LL) {
        if (!x.data.equals(LAUNCHLAB_CLAIM_CREATOR_FEE_DISC)) throw new Error('instrução do LaunchLab não prevista');
        const [creator, auth, vault, recipient, quoteMint, tokenProgram, system, ataProgram] = x.accounts;
        if (!signers.includes(creator)) throw new Custom(3010, 'AccountNotSigner');
        if (auth !== findProgramAddress(['creator_fee_vault_auth_seed'], LL).address) throw new Custom(2006, 'ConstraintSeeds (authority)');
        if (vault !== findProgramAddress([decodeBase58(creator), decodeBase58(quoteMint)], LL).address) throw new Custom(2006, 'ConstraintSeeds (cofre)');
        if (tokenProgram !== PROGRAMS.token || system !== PROGRAMS.system || ataProgram !== PROGRAMS.associatedToken) throw new Custom(3008, 'InvalidProgramId');
        const v = n.data.get(vault);
        if (!v || v.owner !== PROGRAMS.token) throw new Custom(3012, 'AccountNotInitialized');
        if (encodeBase58(v.data.subarray(0, 32)) !== quoteMint) throw new Custom(2014, 'ConstraintTokenMint');
        if (recipient !== ataOf(creator, quoteMint, tokenProgram)) throw new Custom(2009, 'ConstraintAssociated');
        createAta(creator, creator, quoteMint, tokenProgram); // init_if_needed: o criador paga
        if (n.refuse) throw new Custom(6099, 'o programa mudou');
        // só a transação final (a que fecha a ATA): a medida passa e a simulação do passo é recusada
        if (n.refuseFinal && ixs.some((y) => y.program === PROGRAMS.token && y.data[0] === 9)) throw new Custom(6098, 'recusada na transação final');
        const amount = v.data.readBigUInt64LE(64);
        move(vault, recipient, Number(amount)); // WSOL: o saldo é lamport
        v.data.writeBigUInt64LE(0n, 64);
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
  const refused = new Set<string>();
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const c = state.chain;
      switch (method) {
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'getRecentPrioritizationFees':
          return [{ prioritizationFee: priority }] as T;
        case 'getMultipleAccounts': {
          const [keys, cfg] = params as [string[], { encoding?: string }];
          if (c.noListVault && keys.length === 1 && c.data.has(keys[0])) return { value: [] } as T; // releitura do cofre sem a lista
          return {
            value: keys.map((a) => {
              const d = c.data.get(a);
              if (d) return c.dirtyVault ? { owner: d.owner, lamports: 1, data: ['', 'base64'] } : { lamports: c.lamports.get(a) ?? 1, owner: d.owner, data: [d.data.toString('base64'), 'base64'] };
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
          return { value: { err: null, logs: [], unitsConsumed: 40_000, accounts: addrs.map((a) => (r.chain.lamports.has(a) ? { lamports: r.chain.lamports.get(a) } : null)) } } as T;
        }
        case 'sendTransaction': {
          // a rede aceita o envio e a transação cai com erro (sem pré-simulação): o status diz o erro
          if (c.refuseSend && decode(params[0] as string).ixs.some((x) => x.program === LL)) {
            refused.add(encodeBase58(Buffer.from(params[0] as string, 'base64').subarray(1, 65)));
            return 'sig' as T;
          }
          const r = apply(c, params[0] as string);
          if ('err' in r) throw new RpcError(`sendTransaction: ${r.err}`, -32002);
          state.chain = r.chain;
          return 'sig' as T;
        }
        case 'getSignatureStatuses':
          if (refused.has((params[0] as string[])[0])) return { value: [{ err: { InstructionError: [2, { Custom: 6000 }] }, confirmationStatus: 'confirmed' }] } as T;
          return { value: [{ err: null, confirmationStatus: 'confirmed' }] } as T;
        case 'getBlockHeight':
          return 10 as T;
        default:
          throw new RpcError(`${method}: não previsto no teste`);
      }
    },
  };
}

const fees = (w: string, lamports: bigint, extra: Partial<CreatorFees> = {}): CreatorFees => ({
  bondingVault: pumpCreatorVault(w), bondingVaultLamports: 0, ammVaultAta: pumpAmmCreatorVaultAta(w), ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null,
  launchlab: { vault: launchlabCreatorFeeVault(w), lamports, other: 0 }, launchlabError: null, ...extra,
});

type Setup = {
  wallets: number[]; // lamports de S0..S3 (S0 = a pagadora, a mais rica)
  vaults: Record<number, { fee: bigint; feeNow?: bigint | null }>; // feeNow null = o cofre sumiu
  wsolAta?: Record<number, number>; // a temporária já tem a ATA WSOL, com estes lamports
};

function setup(o: Setup) {
  const lamports = new Map<string, number>([[DEST, 50_000_000], [APP_FEE_WALLET, 100_000_000]]);
  const tokens = new Map<string, Tok>();
  const data = new Map<string, { owner: string; data: Buffer }>();
  o.wallets.forEach((l, i) => l > 0 && lamports.set(S[i].address, l));
  const scans: WalletScan[] = o.wallets.map((l, i) => {
    const w = S[i].address;
    const v = o.vaults[i];
    if (v && v.feeNow !== null) {
      const now = v.feeNow ?? v.fee;
      data.set(launchlabCreatorFeeVault(w), { owner: PROGRAMS.token, data: vaultBytes({ amount: now }) });
      lamports.set(launchlabCreatorFeeVault(w), RENT_TOKEN + Number(now));
    }
    const scanTokens = [];
    if (o.wsolAta?.[i]) {
      const a = ataOf(w, WSOL_MINT);
      lamports.set(a, o.wsolAta[i]);
      tokens.set(a, { mint: WSOL_MINT, owner: w, program: PROGRAMS.token, amount: 0n });
      scanTokens.push(parseTokenAccount({ pubkey: a, account: { lamports: o.wsolAta[i], data: { parsed: { info: { mint: WSOL_MINT, isNative: true, state: 'initialized', tokenAmount: { amount: '0', decimals: 9 } } } } } }, w, 'token'));
    }
    return { index: i, address: w, lamports: l, tokens: scanTokens, fees: v ? fees(w, v.fee) : null, errors: [] };
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

const llResults = (rs: StepResult[]) => rs.filter((x) => x.step.kind === 'claim-launchlab');
const vaultAmount = (c: Chain, i: number) => c.data.get(launchlabCreatorFeeVault(S[i].address))!.data.readBigUInt64LE(64);

test('launchlab: temporária vazia, sem ATA WSOL: a fee aparece na Confirmar e chega (89/11); nada fica para trás', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0], vaults: { 1: { fee: 3_000_000n } } });
  assertShownMatchesArrived(r);
  assert.deepEqual(r.plan.steps.map((s) => s.kind), ['claim-launchlab', 'sweep-sol', 'sweep-sol']);
  const [sim] = llResults(r.sims);
  assert.equal(sim.status, 'simulado', sim.detail);
  const fee = appFeeLamports(3_000_000n, appFeeFor(DEST));
  assert.equal(sim.destinationDelta, 3_000_000n - fee, '89% ao destino na mesma transação');
  assert.equal(sim.appFeeDelta, fee, '11% à carteira da taxa');
  assert.equal(llResults(r.done)[0].appFeeDelta, fee, 'no envio, a carteira da taxa recebeu exatamente os 11% da coleta');
  assert.equal(llResults(r.done)[0].destinationDelta, 3_000_000n - fee);
  assert.equal(r.receipt.toDestination.claims, 1);
  assert.equal(r.receipt.toDestination.claimLamports, 3_000_000n, 'linha "Creator fees e cashback": bruto');
  const w = S[1].address;
  assert.equal(r.chain.lamports.get(w) ?? 0, 0, 'a temporária termina vazia');
  assert.ok(!r.chain.tokens.has(ataOf(w, WSOL_MINT)), 'a ATA WSOL criada foi fechada');
  assert.equal(vaultAmount(r.chain, 1), 0n, 'o cofre foi esvaziado');
  assert.deepEqual(llResults(r.done).map((x) => x.status), ['enviado']);
});

test('launchlab: ATA WSOL que já existia: o aluguel dela vai em "contas fechadas" uma vez, e ela sai do passo das contas', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0], vaults: { 1: { fee: 2_000_000n } }, wsolAta: { 1: RENT_TOKEN } });
  assertShownMatchesArrived(r);
  assert.ok(!r.plan.steps.some((s) => s.kind === 'tokens'), 'a coleta fecha a ATA WSOL: fechar de novo falharia');
  assert.equal(r.receipt.toDestination.claimLamports, 2_000_000n);
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(RENT_TOKEN));
  assert.ok(!r.chain.tokens.has(ataOf(S[1].address, WSOL_MINT)));
  assert.equal(r.chain.lamports.get(S[1].address) ?? 0, 0);
});

test('launchlab: o criador é a pagadora (coleta nela mesma), mostrado = chegado', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 1_000_000], vaults: { 0: { fee: 5_000_000n }, 1: { fee: 800_000n } } });
  assertShownMatchesArrived(r);
  assert.deepEqual(llResults(r.done).map((x) => x.status), ['enviado', 'enviado']);
  assert.equal(r.receipt.toDestination.claimLamports, 5_800_000n);
  assert.equal(r.chain.lamports.get(S[0].address) ?? 0, 0, 'a pagadora se esvazia no fim');
  assert.equal(vaultAmount(r.chain, 0), 0n);
});

test('launchlab: fee que caiu abaixo da taxa da rede e cofre que sumiu: pula com o motivo; a ATA WSOL antiga ainda é fechada', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 0, 0], vaults: { 1: { fee: 30_000n, feeNow: 9_000n }, 2: { fee: 2_000_000n, feeNow: null } }, wsolAta: { 1: RENT_TOKEN } });
  assertShownMatchesArrived(r);
  const [small, gone] = llResults(r.sims);
  assert.equal(small.status, 'simulado', 'só fecha a ATA WSOL que já existia');
  assert.equal(small.skippedClaim, true);
  assert.match(small.detail!, /menor que a taxa da rede/);
  assert.equal(gone.status, 'nada a fazer');
  assert.match(gone.detail!, /não tem fee/);
  assert.equal(r.receipt.toDestination.claims, 0, 'nenhuma coleta contada');
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(RENT_TOKEN));
  assert.equal(vaultAmount(r.chain, 1), 9_000n, 'a fee pequena fica no cofre');
});

test('launchlab: o programa recusa (mudou): esta coleta falha, as próximas do LaunchLab são canceladas e o resto da limpeza segue', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 2_000_000, 3_000_000], vaults: { 1: { fee: 2_000_000n }, 2: { fee: 2_000_000n } } }, (_p, state) => {
    state.chain.refuse = true;
  });
  for (const rs of [r.sims, r.done]) {
    const [first, second] = llResults(rs);
    assert.equal(first.status, 'falhou');
    assert.equal(first.error?.code, 'launchlab-claim-failed');
    assert.equal(second.status, 'cancelado', 'não insiste');
    assert.equal(second.error?.code, 'launchlab-claim-failed');
    assert.deepEqual(rs.filter((x) => x.step.kind === 'sweep-sol').map((x) => x.status), rs === r.sims ? ['simulado', 'simulado', 'simulado'] : ['enviado', 'enviado', 'enviado'], 'o SOL das carteiras ainda vai');
  }
  assert.equal(r.receipt.failed.length, 2);
  assert.equal(r.receipt.totalLamports, r.arrived, 'nada de fee contada');
  assert.equal(vaultAmount(r.chain, 1), 2_000_000n, 'a fee continua no cofre');
  assert.equal(explainError('qualquer', { stepKind: 'claim-launchlab' }).code, 'launchlab-claim-failed');
});

test('launchlab: recusa na simulação final ou no envio também cancela as próximas do LaunchLab (não insiste)', async () => {
  const final = await roundTrip({ wallets: [50_000_000, 2_000_000, 3_000_000], vaults: { 1: { fee: 2_000_000n }, 2: { fee: 2_000_000n } } }, (_p, state) => {
    state.chain.refuseFinal = true;
  });
  for (const rs of [final.sims, final.done]) {
    assert.deepEqual(llResults(rs).map((x) => x.status), ['falhou', 'cancelado']);
    assert.equal(llResults(rs)[0].error?.code, 'launchlab-claim-failed');
  }
  const send = await roundTrip({ wallets: [50_000_000, 2_000_000, 3_000_000], vaults: { 1: { fee: 2_000_000n }, 2: { fee: 2_000_000n } } }, (_p, state) => {
    state.chain.refuseSend = true;
  });
  assert.deepEqual(llResults(send.sims).map((x) => x.status), ['simulado', 'simulado'], 'na simulação tudo passa');
  assert.deepEqual(llResults(send.done).map((x) => x.status), ['falhou', 'cancelado'], 'a rede recusou o envio: a próxima não é tentada');
  assert.equal(vaultAmount(send.chain, 2), 2_000_000n, 'a fee da 2ª continua no cofre');
  assert.deepEqual(send.done.filter((x) => x.step.kind === 'sweep-sol').map((x) => x.status), ['enviado', 'enviado', 'enviado']);
});

test('launchlab: falha do LaunchLab não cancela a Pump.fun nem a Meteora, e a delas não cancela o LaunchLab', async () => {
  const r = await roundTrip({ wallets: [50_000_000, 2_000_000], vaults: { 1: { fee: 2_000_000n } } }, (plan, state) => {
    state.chain.refuse = true;
    // passo da Meteora depois, que recusaria por outro motivo (pool que não existe): segue sendo tentado
    plan.steps.splice(1, 0, { kind: 'claim-dbc', walletIndex: 1, wallet: S[1].address, estimateLamports: 1_000_000n, pools: [] } as Step);
  });
  const kinds = r.sims.map((x) => `${x.step.kind}:${x.status}`);
  assert.equal(kinds[0], 'claim-launchlab:falhou');
  assert.notEqual(kinds[1], 'claim-dbc:cancelado', 'a Meteora não é cancelada pela falha do LaunchLab');
});

test('launchlab: releitura do cofre fora do formato ou sem a lista: só a coleta falha (não sei, não "sem fee"), o resto da limpeza segue', async () => {
  for (const flag of ['dirtyVault', 'noListVault'] as const) {
    const r = await roundTrip({ wallets: [50_000_000, 2_000_000], vaults: { 1: { fee: 2_000_000n } } }, (_p, state) => {
      state.chain[flag] = true;
    });
    const [x] = llResults(r.done);
    assert.equal(x.status, 'falhou', flag);
    assert.equal(x.error?.code, 'launchlab-claim-failed');
    assert.match(x.detail!, /releitura do cofre/);
    assert.deepEqual(r.done.filter((y) => y.step.kind === 'sweep-sol').map((y) => y.status), ['enviado', 'enviado']);
    assert.equal(r.receipt.totalLamports, r.arrived);
  }
});

test('launchlab: a transação de coleta cabe no limite no pior caso (ATA criada, temporária ≠ pagadora, taxa, prioridade)', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0], vaults: { 1: { fee: 1_000_000n } } });
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const sizes: number[] = [];
  const sims = await execute({ rpc: chainRpc(state, sizes, 1_000), plan, signers, mode: 'simulate' });
  assert.ok(llResults(sims).every((x) => x.status === 'simulado'), llResults(sims).map((x) => x.detail).join(' | '));
  assert.ok(Math.max(...sizes) <= MAX_TX_BYTES, `a maior transação tem ${Math.max(...sizes)} bytes`);
});

// ---------- plano ----------

test('launchlab plano: soma abaixo do mínimo não monta passo; reserva conta a transação e o empréstimo da ATA WSOL', () => {
  const base = setup({ wallets: [50_000_000, 0], vaults: {} }).scans;
  const withFee = (l: bigint, extra: Partial<CreatorFees> = {}) => base.map((s, i) => (i === 1 ? { ...s, fees: fees(s.address, l, extra) } : s));
  const tiny = buildPlan({ scans: withFee(BigInt(MIN_CLAIM_LAMPORTS)), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!tiny.steps.some((s) => s.kind === 'claim-launchlab'), 'fee que não paga a coleta não vira passo');
  const none = buildPlan({ scans: base.map((s, i) => (i === 1 ? { ...s, lamports: 1 } : s)), prices: new Map(), destination: DEST, rentExemptZero: RENT0 }).reserveNeededLamports;
  const one = buildPlan({ scans: withFee(1_000_000n), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const steps = one.steps.filter((s) => s.kind === 'claim-launchlab');
  assert.equal(steps.length, 1);
  assert.equal(steps[0].kind === 'claim-launchlab' && steps[0].estimateLamports, 1_000_000n);
  assert.equal(one.reserveNeededLamports - none, BigInt(BASE_FEE_LAMPORTS) * 3n + BigInt(RENT_TOKEN), '1 transação a mais e o empréstimo da ATA WSOL');
  // um passo anterior da mesma carteira que fecha a ATA WSOL (Meteora): o LaunchLab não conta o que ela tinha de novo
  const dbcPool = { pool: S[3].address, config: S[3].address, baseMint: S[2].address, baseVault: S[2].address, quoteVault: S[2].address, baseTokenProgram: PROGRAMS.token, migrated: false, quoteFee: 1_000_000n };
  const both = buildPlan({ scans: withFee(1_000_000n, { dbc: { pools: [dbcPool], found: 1, other: 0, cut: 0 }, dbcError: null }), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const ll = both.steps.find((s) => s.kind === 'claim-launchlab');
  assert.equal(ll?.kind === 'claim-launchlab' && ll.wsolClosedBefore, true);
  assert.equal(one.steps.find((s) => s.kind === 'claim-launchlab')?.kind === 'claim-launchlab' && (steps[0] as Extract<Step, { kind: 'claim-launchlab' }>).wsolClosedBefore, undefined);
  // dado da análise de antes desta regra (sem launchlab) ou leitura que falhou: nada muda
  const old = buildPlan({ scans: withFee(0n, { launchlab: undefined }), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!old.steps.some((s) => s.kind === 'claim-launchlab'));
  const failed = buildPlan({ scans: withFee(0n, { launchlabError: 'HTTP 429' }), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!failed.steps.some((s) => s.kind === 'claim-launchlab'));
});
