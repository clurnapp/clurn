import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, FEE_ACCOUNT_GROWTH_BYTES, FeePayerError, PlanError, roundUpToMicroSol, rentFor, SWEEPS_PER_TX, TOKEN_ACCOUNT_BYTES, type Plan, type Step } from '../../src/core/limpeza/plan.ts';
import { PUMP_AMM_GLOBAL_CONFIG } from '../../src/core/solana/instructions.ts';
import { resolveOnly } from '../../src/cli/limpar.ts';
import { BLOCKHASH_REUSE_MS, execute, ExecutionAborted, PUMP_FEE_SHARING_ERROR, validateDestination } from '../../src/core/limpeza/executor.ts';
import { recommend, priceLookupFailed, burnNeedsExtraConfirmation, inBurnAll, VALUABLE_USD } from '../../src/core/limpeza/recommend.ts';
import { parseTokenAccount, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { compileMessage, MAX_TX_BYTES } from '../../src/core/solana/tx.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { decodeBase58 } from '../../src/core/solana/base58.ts';
import { associatedTokenAddress, findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpAmmCreatorVaultAuthority, pumpCreatorVault, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { analysisNotice } from '../../src/app/server.ts';
import { APP_FEE_WALLET, appFeeFor, appFeeLamports } from '../../src/core/limpeza/app-fee.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1, 2].map((n) => burnerSigner(seed, n));
const MAIN = deriveMainAddress(seed);
const DEST = MAIN;
const RENT0 = 890_880;

function tok(account: string, over: Record<string, unknown> = {}, owner = S[0].address) {
  return parseTokenAccount(
    { pubkey: account, account: { lamports: 2_039_280, data: { parsed: { info: { mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', state: 'initialized', tokenAmount: { amount: '0', decimals: 6 }, ...over } } } } },
    owner,
    'token',
  );
}
// endereços de conta de token válidos (32 bytes) para a transação montar
const ACC = Array.from({ length: 40 }, (_, i) => burnerSigner(seed, 100 + i).address);

function scan(i: number, over: Partial<WalletScan> = {}): WalletScan {
  return { index: i, address: S[i].address, lamports: 0, tokens: [], fees: null, errors: [], ...over };
}

// ---------- recomendação ----------

test('recomendação: estável e conhecida vão para o destino, memecoin sem valor queima, incerto fica, NFT fica', () => {
  assert.equal(recommend('fungible', 'estável', 0.5).decision, 'transfer');
  assert.equal(recommend('fungible', 'cripto conhecida', null).decision, 'transfer');
  assert.equal(recommend('fungible', 'memecoin Pump.fun', 0.2).decision, 'burn');
  assert.equal(recommend('fungible', 'memecoin Pump.fun', null).decision, 'keep', 'sem preço = desconhecido, nunca queimar por padrão');
  assert.equal(recommend('fungible', 'memecoin Pump.fun', 5).decision, 'transfer');
  assert.equal(recommend('fungible', 'outro', null).decision, 'keep');
  assert.equal(recommend('fungible', 'desconhecido', 0.1).decision, 'keep');
  assert.equal(recommend('nft', 'estável', 100).decision, 'keep');
});

test('queimar algo que não é memecoin sem valor pede confirmação extra', () => {
  assert.equal(burnNeedsExtraConfirmation('estável', 0.5), true);
  assert.equal(burnNeedsExtraConfirmation('outro', null), true);
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', 3), true);
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', 0.3), false);
  assert.equal(burnNeedsExtraConfirmation('memecoin Pump.fun', null), true, 'sem preço: queimar exige QUEIMAR');
  assert.equal(priceLookupFailed({ unresolved: new Set() }, 'MintA'), false);
  assert.equal(priceLookupFailed({ unresolved: new Set(['MintA']) }, 'MintA'), true, 'lote que falhou: só o token sem consulta');
  assert.equal(priceLookupFailed({ unresolved: new Set(['MintA']) }, 'MintB'), false);
  assert.equal(recommend('fungible', 'memecoin Pump.fun', null).code, 'no-price', 'consulta falhada = sem preço: Manter, queimar só com a palavra');
  assert.equal(inBurnAll('no-price'), true, 'entra no "Queimar todos" (com a palavra)');
});

test('"Queimar todos": só entra token sem valor conhecido; NFT e token com valor nunca', () => {
  const inAll = (kind: 'fungible' | 'nft', c: Parameters<typeof recommend>[1], usd: number | null) => inBurnAll(recommend(kind, c, usd).code);
  assert.equal(inAll('fungible', 'outro', null), true, 'sem preço (ex.: moeda da bonk.fun)');
  assert.equal(inAll('fungible', 'memecoin Pump.fun', null), true);
  assert.equal(inAll('fungible', 'memecoin Pump.fun', 0.2), true, 'memecoin barata');
  assert.equal(inAll('fungible', 'desconhecido', 0.1), true, 'origem incerta, preço baixo');
  assert.equal(inAll('nft', 'outro', null), false, 'NFT nunca');
  assert.equal(inAll('fungible', 'estável', 0.5), false, 'estável nunca');
  assert.equal(inAll('fungible', 'cripto conhecida', null), false, 'cripto conhecida nunca, nem sem preço');
  assert.equal(inAll('fungible', 'memecoin Pump.fun', 5), false, 'vale US$ 1 ou mais');
  assert.equal(inAll('fungible', 'outro', VALUABLE_USD), false, 'exatamente US$ 1');
});

// ---------- plano ----------

test('plano: pagador é a temporária com mais SOL e é esvaziada por último', () => {
  const plan = buildPlan({
    scans: [scan(0, { lamports: 1_000_000_000 }), scan(1, { lamports: 5_000_000, tokens: [tok(ACC[0])] })],
    prices: new Map(),
    destination: DEST,
    rentExemptZero: RENT0,
  });
  assert.equal(plan.feePayerIndex, 0);
  assert.deepEqual(plan.steps.map((s) => `${s.kind}:${s.walletIndex}`), ['tokens:1', 'sweep-sol:1', 'sweep-sol:0']);
  assert.equal((plan.steps.at(-1) as Extract<Step, { kind: 'sweep-sol' }>).isFeePayer, true);
});

test('plano: sem decisão, token com saldo e NFT ficam; decisão queimar/enviar vira ação; NFT nunca queima', () => {
  const fung = tok(ACC[1], { tokenAmount: { amount: '500', decimals: 2 } });
  const nft = tok(ACC[2], { tokenAmount: { amount: '1', decimals: 0 } });
  const fung2 = tok(ACC[3], { tokenAmount: { amount: '7', decimals: 0 } });
  const base = { scans: [scan(0, { lamports: 1_000_000_000, tokens: [fung, nft, fung2] })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 };
  const p1 = buildPlan(base);
  assert.equal(p1.kept.length, 3);
  assert.ok(!p1.steps.some((s) => s.kind === 'tokens'));

  const p2 = buildPlan({ ...base, decisions: new Map([[ACC[1], 'burn'], [ACC[2], 'burn'], [ACC[3], 'transfer']]) });
  const actions = p2.steps.flatMap((s) => (s.kind === 'tokens' ? s.actions.map((a) => `${a.account === ACC[1] ? 'fung' : 'fung2'}:${a.action}`) : []));
  assert.deepEqual(actions, ['fung:burn-close', 'fung2:transfer-close']);
  assert.equal(p2.kept.length, 1);
  assert.match(p2.kept[0].reason, /NFT/);
});

test('plano: conta bloqueada fica, carteira com leitura incompleta fica de fora', () => {
  const plan = buildPlan({
    scans: [scan(0, { lamports: 1_000_000_000, tokens: [tok(ACC[4], { state: 'frozen' })] }), scan(1, { lamports: 9_000_000, errors: ['contas de token: HTTP 503'] })],
    prices: new Map(),
    destination: DEST,
    rentExemptZero: RENT0,
  });
  assert.equal(plan.kept.length, 1);
  assert.match(plan.kept[0].reason, /congelada/);
  assert.deepEqual(plan.skipped.map((s) => s.walletIndex), [1]);
  assert.ok(!plan.steps.some((s) => s.walletIndex === 1));
});

test('plano: destino não pode ser temporária; sem SOL para taxas dá erro claro', () => {
  assert.throws(() => buildPlan({ scans: [scan(0, { lamports: 1e9 })], prices: new Map(), destination: S[0].address, rentExemptZero: RENT0 }), PlanError);
  assert.throws(
    () => buildPlan({ scans: [scan(0, { lamports: 1000, tokens: [tok(ACC[5])] })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 }),
    (e: Error) => e instanceof PlanError && /Mande/.test(e.message),
  );
});

test('resumo: burners vazias dão "nada para limpar", não "falta SOL"; falta de SOL continua falta de SOL', () => {
  const noticeOf = (scans: WalletScan[]) => {
    try {
      buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
    } catch (e) {
      return analysisNotice(e, scans.length > 0);
    }
    return null;
  };
  // caso da devnet em 30/10/2026: Contas 2 e 3 já limpas (0 SOL, sem contas de token)
  assert.deepEqual(noticeOf([scan(1), scan(2)]), { feeWarning: null, nothingToClean: true });
  const fee = noticeOf([scan(0, { lamports: 1000, tokens: [tok(ACC[5])] })]);
  assert.equal(fee?.nothingToClean, false);
  assert.match(fee?.feeWarning ?? '', /Mande/);
  assert.deepEqual(analysisNotice(new PlanError('x'), false), { feeWarning: null, nothingToClean: false }, 'sem burners não há o que avisar');
  assert.throws(() => analysisNotice(new TypeError('bug'), true), TypeError, 'erro que não é do plano não vira aviso');
});

test('sem SOL para taxas (caso real da 1ª varredura na mainnet): todas em 0, sugere a temporária com mais trabalho e pede a reserva + 20%', () => {
  const scans = [
    scan(0, { tokens: [tok(ACC[6])] }),
    scan(1, { tokens: [tok(ACC[7], {}, S[1].address), tok(ACC[8], {}, S[1].address)], fees: { bondingVault: 'x', bondingVaultLamports: 240_000, ammVaultAta: 'y', ammVaultLamports: 0, unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 1, pools: 0, detailed: true } }),
  ];
  // 6 transações (N=0: 1 conta + envio; N=1: coleta + 2 contas + envio) × 15 000 + empréstimo do aluguel à N=1 na
  // coleta + aluguel mínimo da pagadora
  const reserve = 6n * 15_000n + BigInt(RENT0) + BigInt(RENT0);
  assert.throws(
    () => buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 }),
    (e: Error) => e instanceof FeePayerError && e.walletIndex === 1 && e.wallet === S[1].address && e.reserveLamports === reserve && e.sendLamports === roundUpToMicroSol((reserve * 12n) / 10n) && e.haveLamports === 0n && e.message.includes(S[1].address),
  );
});

test('sem SOL para taxas, com SOL numa temporária: ela é a sugerida e o pedido é só o que falta nela', () => {
  // a N=0 tem 500 000 (um depósito anterior, ou SOL esquecido); a N=1 tem mais trabalho, mas pedir lá desperdiçaria
  // o SOL da N=0 (a pagadora é sempre a mais rica)
  const scans = [
    scan(0, { lamports: 500_000, tokens: [tok(ACC[6])] }),
    scan(1, { tokens: [tok(ACC[7], {}, S[1].address), tok(ACC[8], {}, S[1].address)] }),
  ];
  const reserve = 5n * 15_000n + BigInt(RENT0);
  assert.throws(
    () => buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 }),
    (e: Error) => e instanceof FeePayerError && e.walletIndex === 0 && e.haveLamports === 500_000n && e.reserveLamports === reserve - 500_000n && e.sendLamports === roundUpToMicroSol((reserve * 12n) / 10n - 500_000n),
  );
  // depositado o pedido, o plano monta com a N=0 de pagadora
  const after = (reserve * 12n) / 10n;
  const plan = buildPlan({ scans: [{ ...scans[0], lamports: Number(after) }, scans[1]], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.equal(plan.feePayerIndex, 0);
});

test('pagadora fora do --somente: o plano avisa e não a esvazia', () => {
  const plan = buildPlan({
    scans: [scan(0, { lamports: 10_000_000 }), scan(1, { tokens: [tok(ACC[9], {}, S[1].address)] })],
    prices: new Map(),
    destination: DEST,
    rentExemptZero: RENT0,
    only: new Set([1]),
  });
  assert.equal(plan.feePayerIndex, 0);
  assert.equal(plan.payerOutsideSelection, true);
  assert.ok(!plan.steps.some((s) => s.walletIndex === 0));
  const all = buildPlan({ scans: [scan(0, { lamports: 10_000_000 }), scan(1, { tokens: [tok(ACC[9], {}, S[1].address)] })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.equal(all.payerOutsideSelection, false);
});

test('--somente aceita número N ou endereço e recusa o que não é temporária usada', () => {
  const wallets = [{ index: 2, address: S[2].address }, { index: 5, address: S[0].address }];
  assert.deepEqual([...resolveOnly(['5'], wallets)], [5]);
  assert.deepEqual([...resolveOnly([S[2].address, '5'], wallets)], [2, 5]);
  assert.throws(() => resolveOnly(['3'], wallets), /não é uma temporária usada/);
  assert.throws(() => resolveOnly([S[1].address], wallets), /não é uma temporária usada/);
});

test('plano: lotes de no máximo 15 contas; --somente restringe', () => {
  const tokens = ACC.slice(0, 32).map((a) => tok(a));
  const plan = buildPlan({ scans: [scan(0, { lamports: 1e9, tokens }), scan(1, { lamports: 1e6, tokens: [tok(ACC[39], {}, S[1].address)] })], prices: new Map(), destination: DEST, rentExemptZero: RENT0, only: new Set([0]) });
  const sizes = plan.steps.filter((s) => s.kind === 'tokens').map((s) => (s as Extract<Step, { kind: 'tokens' }>).actions.length);
  assert.deepEqual(sizes, [15, 15, 2]);
  assert.ok(plan.steps.every((s) => s.walletIndex === 0));
});

test('plano: creator fees viram passos de coleta antes da limpeza', () => {
  const fees = { bondingVault: 'x', bondingVaultLamports: 240_640, ammVaultAta: 'y', ammVaultLamports: 31_000_000, unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 1, pools: 1, detailed: true };
  const plan = buildPlan({ scans: [scan(0, { lamports: 1e9, fees })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['claim-curve', 'claim-amm', 'sweep-sol']);
  // fee menor que a taxa não vira passo (achado da revisão: coletar custaria mais do que rende)
  const tiny = buildPlan({ scans: [scan(0, { lamports: 1e9, fees: { ...fees, bondingVaultLamports: 4_000, ammVaultLamports: 19_999 } })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(tiny.steps.map((s) => s.kind), ['sweep-sol']);
});

// ---------- executor ----------

// accounts: saldo depois da simulação por endereço (vence dest/fee/wallet); serve para o cofre e a pagadora nas coletas
type Sim = { err?: unknown; dest?: number; wallet?: number; fee?: number; logs?: string[]; accounts?: Record<string, number> };
type Transfer = { from: string; to: string; lamports: bigint };
type Ix = { program: string; accounts: string[]; data: Buffer };

// RPC falso: saldos fixos; simulateTransaction responde pela função `sim` (recebe as chaves da transação,
// os programas na ordem e as transferências de SOL decodificadas: de, para e quanto).
function execRpc(opts: { balances: Record<string, number>; sim: (keys: string[], n: number, programs: string[], transfers: Transfer[], ixs: Ix[], bytes: number) => Sim; status?: (sig: string, n: number) => unknown; rent0?: number; priorityFees?: unknown; tokenData?: Record<string, unknown> }) {
  const calls: string[] = [];
  let simN = 0;
  let stN = 0;
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      const bal = (a: string) => opts.balances[a] ?? 0;
      switch (method) {
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'getMultipleAccounts':
          // tokenData: conta de token como a rede devolve em jsonParsed (null = conta não existe mais)
          return { value: (params[0] as string[]).map((a) => (opts.tokenData && a in opts.tokenData ? (opts.tokenData[a] === null ? null : { lamports: bal(a), data: opts.tokenData[a] }) : { lamports: bal(a) })) } as T;
        case 'simulateTransaction': {
          const raw = Buffer.from(params[0] as string, 'base64');
          const numSigs = raw[0];
          const msg = raw.subarray(1 + 64 * numSigs);
          const nKeys = msg[3];
          const keys = Array.from({ length: nKeys }, (_, i) => msg.subarray(4 + 32 * i, 36 + 32 * i));
          const { encodeBase58 } = await import('../../src/core/solana/base58.ts');
          const names = keys.map((k) => encodeBase58(k));
          // ordem dos programas das instruções (contagens < 128 nos testes: 1 byte cada)
          let pos = 4 + 32 * nKeys + 32;
          const programs: string[] = [];
          const ixs: Ix[] = [];
          const nIx = msg[pos++];
          for (let i = 0; i < nIx; i++) {
            const program = names[msg[pos++]];
            const accounts = [...msg.subarray(pos + 1, pos + 1 + msg[pos])].map((k) => names[k]);
            pos += 1 + msg[pos];
            const data = Buffer.from(msg.subarray(pos + 1, pos + 1 + msg[pos]));
            pos += 1 + msg[pos];
            programs.push(program);
            ixs.push({ program, accounts, data });
          }
          // System Program, instrução 2 = transferência: u32 LE 2 + u64 LE lamports
          const transfers = ixs
            .filter((x) => x.program === PROGRAMS.system && x.data.length === 12 && x.data.readUInt32LE(0) === 2)
            .map((x) => ({ from: x.accounts[0], to: x.accounts[1], lamports: x.data.readBigUInt64LE(4) }));
          const r = opts.sim(names, simN++, programs, transfers, ixs, raw.length);
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          const after = (a: string) => (r.accounts && a in r.accounts ? r.accounts[a] : a === DEST ? (r.dest ?? bal(a)) : a === APP_FEE_WALLET ? (r.fee ?? bal(a)) : (r.wallet ?? bal(a)));
          return { value: { err: r.err ?? null, logs: r.logs ?? [], unitsConsumed: 3_000, accounts: addrs.map((a) => ({ lamports: after(a) })) } } as T;
        }
        case 'getAccountInfo': {
          const a = params[0] as string;
          return { value: a in opts.balances ? { owner: PROGRAMS.system, lamports: bal(a), executable: false } : null } as T;
        }
        case 'sendTransaction':
          return 'sig' as T;
        case 'getSignatureStatuses':
          return { value: [opts.status ? opts.status((params[0] as string[])[0], stN++) : { err: null, confirmationStatus: 'confirmed' }] } as T;
        case 'getRecentPrioritizationFees':
          if (opts.priorityFees === undefined) throw new RpcError('getRecentPrioritizationFees: não previsto');
          return opts.priorityFees as T;
        case 'getMinimumBalanceForRentExemption':
          return (opts.rent0 ?? RENT0) as T;
        case 'getBlockHeight':
          return 1000 as T;
        default:
          throw new RpcError(`${method}: não previsto no teste`);
      }
    },
  };
  return { rpc, calls };
}

function tokensPlan(n: number, extra: Step[] = []): Plan {
  return {
    destination: DEST,
    feePayerIndex: 0,
    feePayer: S[0].address,
    steps: [
      { kind: 'tokens', walletIndex: 1, wallet: S[1].address, actions: ACC.slice(0, n).map((a) => ({ action: 'close' as const, account: a, mint: ACC[39], program: PROGRAMS.token, amount: 0n, decimals: 0, rentLamports: 2_039_280 })) },
      ...extra,
    ],
    kept: [],
    skipped: [],
    payerOutsideSelection: false,
    reserveNeededLamports: 0n,
  };
}

const signers = new Map(S.map((s) => [s.index, s]));
const balances = Object.fromEntries([[DEST, 50_000_000], [S[0].address, 1e9], [S[1].address, 3_000_000], ...ACC.map((a) => [a, 2_039_280])]);

test('executor: simulação confere o valor exato no destino e nunca envia', async () => {
  const { rpc, calls } = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 3 * 2_039_280 }) });
  const res = await execute({ rpc, plan: tokensPlan(3), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['simulado']);
  assert.equal(res[0].destinationDelta, 3n * 2_039_280n);
  assert.ok(!calls.includes('sendTransaction'));
});

test('executor: destino recebendo valor diferente do esperado PARA TUDO', async () => {
  const { rpc, calls } = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 1 }) });
  await assert.rejects(execute({ rpc, plan: tokensPlan(2), signers, mode: 'execute' }), (e: Error) => e instanceof ExecutionAborted && (e as ExecutionAborted).code === 'unexpected-effect');
  assert.ok(!calls.includes('sendTransaction'));
});

test('executor: lote que falha é refeito conta por conta; só a ruim fica de fora', async () => {
  const bad = ACC[1];
  const { rpc } = execRpc({
    balances,
    sim: (keys) => (keys.includes(bad) ? { err: { InstructionError: [0, 'x'] }, logs: ['Program log: Error: Account is frozen'] } : { dest: 50_000_000 + 2_039_280 * (keys.filter((k) => ACC.includes(k)).length - 0) }),
  });
  const res = await execute({ rpc, plan: tokensPlan(3), signers, mode: 'execute', sleep: async () => {} });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'enviado', 'falhou', 'enviado']);
  assert.match(res[0].detail!, /conta por conta/);
  assert.match(res[2].detail!, /frozen/);
});

test('executor: coleta da Pump.fun que falha cancela as próximas e a limpeza segue', async () => {
  const claim = (i: number): Step => ({ kind: 'claim-curve', walletIndex: i, wallet: S[i].address, estimateLamports: 1n });
  const plan = tokensPlan(1);
  plan.steps = [claim(1), claim(2), ...plan.steps];
  const { rpc } = execRpc({
    balances,
    sim: (keys) => (keys.includes(PROGRAMS.pump) ? { err: { InstructionError: [0, { Custom: 6000 }] } } : { dest: 50_000_000 + 2_039_280 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {} });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'cancelado', 'enviado']);
});

test('executor: coleta na pagadora em que a Pump.fun não paga na real (alguém coletou no meio) PARA TUDO', async () => {
  // a medição viu 500.000 saindo do cofre para a pagadora; na real, a fee não vem e os 500.000 enviados ao destino
  // sairiam do saldo dela
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 0, wallet: S[0].address, estimateLamports: 500_000n }];
  const vault = pumpCreatorVault(S[0].address);
  const { rpc, calls } = execRpc({
    balances: { ...balances, [vault]: RENT0 + 500_000 },
    sim: (_k, n) => (n === 0 ? { accounts: { [vault]: RENT0, [S[0].address]: 1e9 + 500_000 - 5_000 } } : { dest: 50_000_000 + 500_000, accounts: { [S[0].address]: 1e9 - 5_000 - 500_000 } }),
  });
  await assert.rejects(execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {} }), (e: Error) => e instanceof ExecutionAborted && /perderia/.test(e.message));
  assert.ok(!calls.includes('sendTransaction'));
});

test('executor: temporária com 0 SOL coleta a fee MEDIDA e envia tudo ao destino na mesma transação', async () => {
  const RENT_MAINNET = 650_240;
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 531_000n }];
  const seen: string[][] = [];
  const order: string[][] = [];
  const { rpc } = execRpc({
    balances: { ...balances, [S[1].address]: 0 },
    rent0: RENT_MAINNET,
    // 1ª simulação = medição (pagadora completa o aluguel): a temporária fica com aluguel + fee liberada
    // 2ª simulação = transação real: coleta + envia tudo
    sim: (keys, n, programs) => (seen.push(keys), order.push(programs), n === 0 ? { wallet: RENT_MAINNET + 531_000 } : { dest: 50_000_000 + 531_000, wallet: 0 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 531_000n);
  assert.ok(!seen[0].slice(0, 1).includes(S[1].address) && seen[0][0] === S[0].address, 'na medição só a pagadora assina');
  assert.ok(seen[1].includes(PROGRAMS.pump) && seen[1].includes(PROGRAMS.system), 'empréstimo, coleta e transferências na mesma transação');
  assert.ok(seen[1].slice(0, 2).includes(S[1].address), 'a temporária assina a transferência');
  // medido na mainnet: a Pump.fun só paga se a carteira já tiver o aluguel ANTES da coleta
  const SYS = PROGRAMS.system, PUMP = PROGRAMS.pump;
  assert.deepEqual(order[0], [SYS, PUMP], 'medição: empréstimo antes da coleta');
  assert.deepEqual(order[1], [SYS, PUMP, SYS, SYS], 'real: empréstimo, coleta, devolve empréstimo, envia ao destino');
});

test('executor: cofre sem fee a liberar não gera transação', async () => {
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 240_640n }];
  let sims = 0;
  const { rpc, calls } = execRpc({ balances: { ...balances, [S[1].address]: 0 }, rent0: 650_240, sim: () => (sims++, { wallet: 650_240 }) });
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {} });
  assert.equal(res[0].status, 'nada a fazer');
  assert.match(res[0].detail!, /não tem fee para liberar/);
  assert.equal(sims, 1, 'só a medição');
  assert.ok(!calls.includes('sendTransaction'));
});

test('executor: medição da coleta que falha conta como falha da Pump.fun e cancela as próximas', async () => {
  const plan = tokensPlan(0);
  const claim = (i: number): Step => ({ kind: 'claim-curve', walletIndex: i, wallet: S[i].address, estimateLamports: 1n });
  plan.steps = [claim(1), claim(2)];
  const { rpc } = execRpc({ balances, rent0: 650_240, sim: () => ({ err: { InstructionError: [0, { Custom: 6000 }] } }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'cancelado']);
});

test('executor: envio de SOL — pagador deixa a taxa, as outras vão a zero', async () => {
  const plan = tokensPlan(0);
  plan.steps = [
    { kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false },
    { kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true },
  ];
  const expected = [3_000_000, 1e9 - 5000];
  const { rpc } = execRpc({ balances, sim: (_, n) => ({ dest: 50_000_000 + expected[n] }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.destinationDelta), [3_000_000n, BigInt(1e9 - 5000)]);
});

// ---------- blockhash reaproveitado entre passos (menos consultas no RPC público) ----------

// 3 passos: fechar 1 conta (S1), esvaziar S1, esvaziar a pagadora S0
function threeStepsPlan() {
  const plan = tokensPlan(1);
  plan.steps.push({ kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false }, { kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true });
  const expected = [2_039_280, 3_000_000, 1e9 - 5000];
  return { plan, sim: (_: string[], n: number) => ({ dest: 50_000_000 + expected[n] }) };
}

test('executor: o blockhash é reaproveitado por até 20 s: 3 passos enviados, 1 getLatestBlockhash', async () => {
  const { plan, sim } = threeStepsPlan();
  const { rpc, calls } = execRpc({ balances, sim });
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {}, now: () => 1_000_000 });
  assert.deepEqual(res.map((r) => r.status), ['enviado', 'enviado', 'enviado']);
  assert.equal(calls.filter((c) => c === 'getLatestBlockhash').length, 1);
});

test('executor: blockhash com mais de 20 s é renovado antes do passo seguinte', async () => {
  const { plan, sim } = threeStepsPlan();
  const { rpc, calls } = execRpc({ balances, sim });
  let t = 1_000_000;
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {}, now: () => t, onStepStart: () => void (t += BLOCKHASH_REUSE_MS + 1) });
  assert.deepEqual(res.map((r) => r.status), ['enviado', 'enviado', 'enviado']);
  assert.equal(calls.filter((c) => c === 'getLatestBlockhash').length, 3);
});

test('executor: depois de "expirou", a nova tentativa busca blockhash novo mesmo dentro dos 20 s', async () => {
  // nunca confirma e a altura da rede (1000) já passou do lastValidBlockHeight (100): expira, confere que não caiu, refaz
  const { rpc, calls } = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }), status: () => null });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 60_000, now: () => 1_000_000 });
  assert.equal(res.length, 1);
  assert.ok(res[0].status !== 'enviado');
  assert.equal(calls.filter((c) => c === 'simulateTransaction').length, 2, 'duas tentativas');
  assert.equal(calls.filter((c) => c === 'getLatestBlockhash').length, 2, 'blockhash novo na segunda');
});

test('executor: lote grande demais é dividido antes de simular', async () => {
  let maxAccounts = 0;
  const { rpc } = execRpc({
    balances,
    sim: (keys) => {
      const n = keys.filter((k) => ACC.includes(k)).length;
      maxAccounts = Math.max(maxAccounts, n);
      return { dest: 50_000_000 + 2_039_280 * n };
    },
  });
  const res = await execute({ rpc, plan: tokensPlan(30), signers, mode: 'simulate' });
  assert.ok(res.length >= 2);
  assert.ok(maxAccounts < 30);
  assert.equal(res.reduce((a, r) => a + (r.destinationDelta ?? 0n), 0n), 30n * 2_039_280n);
});

test('executor: transação que expira mas caiu depois é reconhecida (não repete)', async () => {
  const { rpc, calls } = execRpc({
    balances,
    sim: () => ({ dest: 50_000_000 + 2_039_280 }),
    status: (_, n) => (n < 4 ? null : { err: null, confirmationStatus: 'finalized' }), // 4 consultas vazias -> expira; depois aparece
  });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 60_000 });
  assert.equal(res[0].status, 'enviado');
  assert.equal(res[0].detail, 'confirmada com atraso');
  assert.equal(calls.filter((c) => c === 'simulateTransaction').length, 1);
  // a transação que caiu é a simulada naquela tentativa: o valor dela conta no "já chegou"
  assert.equal(res[0].destinationDelta, 2_039_280n);
  assert.equal(res[0].appFeeDelta, 0n);
});

test('executor: saldo fora do formato (NaN, Infinity, 1.5) PARA TUDO antes de qualquer envio', async () => {
  for (const bad of [NaN, Infinity, 1.5]) {
    // saldo lido para montar o passo (aluguel da conta de token)
    const a = execRpc({ balances: { ...balances, [ACC[0]]: bad }, sim: () => ({ dest: 50_000_000 + 2_039_280 }) });
    await assert.rejects(execute({ rpc: a.rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {} }), (e: Error) => e instanceof ExecutionAborted && (e as ExecutionAborted).code === 'unexpected-effect', `leitura ${bad}`);
    assert.ok(!a.calls.includes('sendTransaction'), `nada enviado (leitura ${bad})`);
    // saldo do destino devolvido pela simulação
    const b = execRpc({ balances, sim: () => ({ dest: bad }) });
    await assert.rejects(execute({ rpc: b.rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {} }), (e: Error) => e instanceof ExecutionAborted && (e as ExecutionAborted).code === 'unexpected-effect', `simulação ${bad}`);
    assert.ok(!b.calls.includes('sendTransaction'), `nada enviado (simulação ${bad})`);
    // destino com saldo sujo: recusado na conferência do destino
    const mk: RpcClient = { call: async <T>() => ({ value: { owner: PROGRAMS.system, lamports: bad } }) as T };
    await assert.rejects(validateDestination(mk, DEST, RENT0), (e: Error) => e instanceof ExecutionAborted && (e as ExecutionAborted).code === 'unexpected-effect', `destino ${bad}`);
  }
});

test('executor: a carteira principal nunca assina; só temporárias', async () => {
  const signed: string[] = [];
  const { rpc } = execRpc({
    balances,
    sim: (keys) => {
      signed.push(...keys.slice(0, 2));
      return { dest: 50_000_000 + 2_039_280 };
    },
  });
  await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate' });
  assert.ok(!signed.includes(MAIN));
  const msg = compileMessage(S[0].address, [], '11111111111111111111111111111111');
  assert.equal(msg.accountKeys[0], S[0].address);
});

test('executor: sem chave do pagador ou chave trocada aborta', async () => {
  const { rpc } = execRpc({ balances, sim: () => ({}) });
  await assert.rejects(execute({ rpc, plan: tokensPlan(1), signers: new Map([[1, S[1]]]), mode: 'simulate' }), ExecutionAborted);
  await assert.rejects(execute({ rpc, plan: tokensPlan(1), signers: new Map([[0, S[0]], [1, S[2]]]), mode: 'simulate' }), ExecutionAborted);
  const ok = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }) });
  await assert.rejects(execute({ rpc: ok.rpc, plan: tokensPlan(1), signers, mode: 'execute', skipSignatureCheck: true, sleep: async () => {} }), /só vale para simulação/);
  assert.ok(!ok.calls.includes('sendTransaction'));
});

test('destino: precisa existir, ser carteira comum e ter saldo mínimo', async () => {
  const mk = (value: unknown): RpcClient => ({ call: async <T>() => ({ value }) as T });
  await assert.rejects(validateDestination(mk(null), DEST, RENT0), /não existe/);
  await assert.rejects(validateDestination(mk({ owner: PROGRAMS.token, lamports: 1e9 }), DEST, RENT0), /não é uma carteira comum/);
  await assert.rejects(validateDestination(mk({ owner: PROGRAMS.system, lamports: 10 }), DEST, RENT0), /saldo baixo/);
  await assert.rejects(validateDestination(mk({ owner: PROGRAMS.system, lamports: 1e9 }), 'xyz', RENT0), /inválido/);
  assert.deepEqual(await validateDestination(mk({ owner: PROGRAMS.system, lamports: 1e9 }), DEST, RENT0), { lamports: 1e9 });
  assert.equal(decodeBase58(DEST).length, 32);
});



// ---------- achados da revisão independente ----------

test('revisão: pagadora coletando fee pequena paga a taxa da rede sem parar tudo, e a fee vai ao destino', async () => {
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 0, wallet: S[0].address, estimateLamports: 30_000n }];
  const vault = pumpCreatorVault(S[0].address);
  const { rpc } = execRpc({
    balances: { ...balances, [vault]: RENT0 + 30_000 },
    sim: (_k, n) => (n === 0 ? { accounts: { [vault]: RENT0, [S[0].address]: 1e9 + 30_000 - 5_000 } } : { dest: 50_000_000 + 30_000, accounts: { [vault]: RENT0, [S[0].address]: 1e9 - 5_000 } }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 30_000n);
});

test('revisão: fee medida menor que a taxa da rede não é coletada', async () => {
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 30_000n }];
  const { rpc, calls } = execRpc({ balances: { ...balances, [S[1].address]: 0 }, rent0: 650_240, sim: () => ({ wallet: 650_240 + 9_000 }) });
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {} });
  assert.equal(res[0].status, 'nada a fazer');
  assert.match(res[0].detail!, /não compensa/);
  assert.ok(!calls.includes('sendTransaction'));
});

test('revisão: rede cai depois do envio → passo "desconhecido" com o link, e a execução continua', async () => {
  const plan = tokensPlan(1);
  plan.steps.push({ kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false });
  let statusCalls = 0;
  const base = execRpc({ balances, sim: (_, n) => ({ dest: 50_000_000 + (n === 0 ? 2_039_280 : 3_000_000) }) });
  const rpc: RpcClient = {
    call: async (m, p) => {
      if (m === 'getSignatureStatuses' && ++statusCalls === 1) throw new RpcError('getSignatureStatuses: HTTP 429', 429);
      if (m === 'getBlockHeight' && statusCalls < 3) throw new RpcError('getBlockHeight: HTTP 429', 429);
      return base.rpc.call(m, p);
    },
  };
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 60_000 });
  assert.deepEqual(res.map((r) => r.status), ['enviado', 'enviado'], 'erro passageiro de rede não derruba nada');

  const base2 = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }) });
  const dead: RpcClient = { call: async (m, p) => (m === 'getSignatureStatuses' || m === 'getBlockHeight' ? Promise.reject(new RpcError(`${m}: HTTP 503`, 503)) : base2.rpc.call(m, p)) };
  const res2 = await execute({ rpc: dead, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 1 });
  assert.equal(res2[0].status, 'desconhecido');
  assert.ok(res2[0].signature, 'guarda a assinatura para o usuário conferir');
});

test('revisão: sem confirmação mas sem a rede confirmar a expiração, NÃO reenvia (evita duplicar)', async () => {
  const { rpc, calls } = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }), status: () => null });
  const quiet: RpcClient = { call: (m, p) => (m === 'getBlockHeight' ? Promise.resolve(50 as never) : rpc.call(m, p)) }; // altura < lastValid: não venceu
  let t = 0;
  const res = await execute({ rpc: quiet, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => void (t += 1), confirmTimeoutMs: 1 });
  assert.equal(res[0].status, 'desconhecido');
  assert.equal(calls.filter((c) => c === 'simulateTransaction').length, 1, 'não montou nem simulou de novo');
});

test('revisão: diferença no destino que some na releitura não para tudo', async () => {
  const { rpc } = execRpc({ balances, sim: (_, n) => ({ dest: 50_000_000 + (n === 0 ? 1 : 2_039_280) }) });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
});

test('revisão: rede cai antes do envio → passo "falhou, nada enviado" e os próximos seguem', async () => {
  const plan = tokensPlan(1);
  plan.steps.push({ kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false });
  const base = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 3_000_000 }) });
  let first = true;
  const rpc: RpcClient = {
    call: async (m, p) => {
      if (m === 'simulateTransaction' && first) {
        first = false;
        throw new RpcError('simulateTransaction: HTTP 503', 503);
      }
      return base.rpc.call(m, p);
    },
  };
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'simulado']);
  assert.match(res[0].detail!, /nada foi enviado/);
  assert.equal(res[0].signature, undefined);
});


// ---------- taxa de prioridade ----------

test('prioridade: 75% das taxas recentes, com teto; rede calma ou dado sujo → zero', async () => {
  const { choosePriorityPrice, priorityFeeLamports, MAX_PRIORITY_MICROLAMPORTS } = await import('../../src/core/limpeza/executor.ts');
  const fees = (xs: number[]) => xs.map((prioritizationFee, slot) => ({ slot, prioritizationFee }));
  assert.equal(choosePriorityPrice(fees([0, 100, 200, 300, 400])), 300n);
  assert.equal(choosePriorityPrice(fees([0, 0, 0])), 0n);
  assert.equal(choosePriorityPrice(fees([10_000_000, 10_000_000])), MAX_PRIORITY_MICROLAMPORTS, 'teto');
  assert.equal(choosePriorityPrice([]), 0n);
  assert.equal(choosePriorityPrice({ erro: 'x' }), 0n);
  assert.equal(choosePriorityPrice([{ prioritizationFee: 'muito' }, null, { prioritizationFee: -5 }]), 0n);
  assert.equal(priorityFeeLamports(50_000n, 100_000), 5_000n, 'teto ≈ 0,000005 SOL numa transação de 100 mil unidades');
  assert.equal(priorityFeeLamports(1n, 1), 1n, 'arredonda para cima');
});

test('prioridade: transação final leva as 2 instruções de taxa e é simulada DE NOVO antes do envio', async () => {
  const order: string[][] = [];
  const { rpc, calls } = execRpc({
    balances,
    priorityFees: [{ slot: 1, prioritizationFee: 20_000 }],
    sim: (_keys, _n, programs) => (order.push(programs), { dest: 50_000_000 + 2_039_280 }),
  });
  let price = -1n;
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, onPriority: (p) => (price = p) });
  assert.equal(price, 20_000n);
  assert.equal(res[0].status, 'enviado');
  const CB = 'ComputeBudget111111111111111111111111111111';
  assert.notEqual(order[0][0], CB, '1ª simulação mede o processamento sem a taxa');
  assert.deepEqual(order.at(-1)!.slice(0, 2), [CB, CB], 'a versão enviada tem limite + preço');
  assert.ok(calls.filter((c) => c === 'simulateTransaction').length >= 2);
});

test('prioridade: pagadora se esvazia deixando taxa base + taxa de prioridade exata', async () => {
  const { priorityFeeLamports, SWEEP_COMPUTE_LIMIT } = await import('../../src/core/limpeza/executor.ts');
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true }];
  const expected = BigInt(1e9) - 5_000n - priorityFeeLamports(20_000n, SWEEP_COMPUTE_LIMIT);
  const { rpc } = execRpc({ balances, priorityFees: [{ slot: 1, prioritizationFee: 20_000 }], sim: () => ({ dest: 50_000_000 + Number(expected) }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, expected);
});

test('prioridade: desligada ou RPC sem a informação → sem instruções de taxa', async () => {
  const order: string[][] = [];
  const { rpc } = execRpc({ balances, priorityFees: [{ slot: 1, prioritizationFee: 20_000 }], sim: (_k, _n, p) => (order.push(p), { dest: 50_000_000 + 2_039_280 }) });
  await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate', priority: 'off' });
  assert.ok(order.every((p) => p[0] !== 'ComputeBudget111111111111111111111111111111'));
});

test('destino que imita uma conta da frase é recusado ANTES de consultar a rede, com o número da conta', async () => {
  const { DestinationLookalike } = await import('../../src/core/limpeza/executor.ts');
  const { knownWallets } = await import('../../src/core/limpeza/destination.ts');
  const known = knownWallets([MAIN, S[0].address]);
  const fake = MAIN.slice(0, 4) + '1'.repeat(MAIN.length - 8) + MAIN.slice(-4);
  let called = false;
  const rpc: RpcClient = { call: async <T>() => ((called = true), { value: { owner: PROGRAMS.system, lamports: 1e9 } }) as T };
  await assert.rejects(validateDestination(rpc, fake, RENT0, known), (e: Error) => e instanceof DestinationLookalike && e.accountIndex === 0 && /IMITA a sua Conta 1/.test(e.message) && e.code === 'dest-lookalike' && e.params.index === 0 && e instanceof ExecutionAborted);
  assert.equal(called, false);
  assert.deepEqual(await validateDestination(rpc, MAIN, RENT0, known), { lamports: 1e9 }, 'a própria principal passa');
});

// ---------- erros explicados (código + parâmetros), sem mudar texto nem regra ----------

test('executor: passo que falha na simulação traz erro explicado', async () => {
  const { rpc } = execRpc({ balances, sim: () => ({ err: { InstructionError: [0, 'x'] }, logs: ['Transfer: insufficient lamports 0, need 240640'] }) });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {} });
  assert.equal(res[0].status, 'falhou');
  assert.equal(res[0].error?.code, 'sim-insufficient');
  assert.equal(res[0].error?.beforeSend, true);
  assert.match(res[0].detail!, /insufficient lamports/, 'detail continua igual');
});

test('executor: status desconhecido diz que ainda não sabemos', async () => {
  const base = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }) });
  const rpc: RpcClient = { call: async (m, p) => (m === 'getSignatureStatuses' || m === 'getBlockHeight' ? Promise.reject(new RpcError(`${m}: HTTP 503`, 503)) : base.rpc.call(m, p)) };
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 1 });
  assert.equal(res[0].status, 'desconhecido');
  assert.equal(res[0].error?.code, 'send-unknown');
  assert.equal(res[0].error?.beforeSend, false);
});

test('executor: coleta falha e a seguinte cancelada traz pump-claim-failed', async () => {
  const claim = (i: number): Step => ({ kind: 'claim-curve', walletIndex: i, wallet: S[i].address, estimateLamports: 1n });
  const plan = tokensPlan(1);
  plan.steps = [claim(1), claim(2), ...plan.steps];
  const { rpc } = execRpc({
    balances,
    sim: (keys) => (keys.includes(PROGRAMS.pump) ? { err: { InstructionError: [0, { Custom: 6000 }] } } : { dest: 50_000_000 + 2_039_280 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'execute', sleep: async () => {} });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'cancelado', 'enviado']);
  assert.equal(res[0].error?.code, 'pump-claim-failed');
  assert.equal(res[1].error?.code, 'pump-claim-failed');
  assert.equal(res[1].error?.beforeSend, true);
  assert.equal(res[2].error, undefined, 'passo que deu certo não tem erro');
});

test('executor: rede cai antes do envio traz erro com beforeSend verdadeiro', async () => {
  const base = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }) });
  const rpc: RpcClient = { call: async (m, p) => (m === 'getLatestBlockhash' ? Promise.reject(new RpcError('getLatestBlockhash: HTTP 503', 503)) : base.rpc.call(m, p)) };
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {} });
  assert.equal(res[0].status, 'falhou');
  assert.equal(res[0].error?.code, 'network-down');
  assert.equal(res[0].error?.beforeSend, true);
});

test('plano: FeePayerError carrega código no-fee-sol', () => {
  try {
    buildPlan({ scans: [scan(0, { lamports: 1000, tokens: [tok(ACC[5])] })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
    assert.fail('devia lançar');
  } catch (e) {
    assert.ok(e instanceof FeePayerError);
    assert.equal(e.code, 'no-fee-sol');
    assert.equal(e.params.walletIndex, e.walletIndex);
    assert.equal(e.params.wallet, e.wallet);
    assert.equal(e.params.sendSol, Number(e.sendLamports) / 1e9);
  }
});

test('destino: cada recusa tem código', async () => {
  const mk = (value: unknown): RpcClient => ({ call: async <T>() => ({ value }) as T });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      assert.ok(e instanceof ExecutionAborted);
      return e;
    }
    return assert.fail('devia recusar');
  };
  assert.equal((await code(validateDestination(mk({ owner: PROGRAMS.system, lamports: 1e9 }), 'xyz', RENT0))).code, 'dest-invalid');
  assert.equal((await code(validateDestination(mk(null), DEST, RENT0))).code, 'dest-missing');
  const notOrd = await code(validateDestination(mk({ owner: PROGRAMS.token, lamports: 1e9 }), DEST, RENT0));
  assert.equal(notOrd.code, 'dest-not-ordinary');
  assert.deepEqual(notOrd.params, { owner: PROGRAMS.token });
  assert.equal((await code(validateDestination(mk({ owner: PROGRAMS.system, lamports: 10 }), DEST, RENT0))).code, 'dest-low-balance');
});

test('executor: rede cai fora da espera, depois do envio, diz que ainda não sabemos (send-unknown, beforeSend falso)', async () => {
  // o envio passou e a transação expirou na espera; ao conferir se ela caiu mesmo assim, a rede cai.
  // Esse erro NÃO passa pelo laço de espera (que engole RpcError): sobe até o registro de "desconhecido".
  const base = execRpc({ balances, sim: () => ({ dest: 50_000_000 + 2_039_280 }), status: () => null });
  let statusCalls = 0;
  const rpc: RpcClient = {
    call: async (m, p) => {
      if (m === 'getSignatureStatuses' && ++statusCalls === 5) throw new RpcError('getSignatureStatuses: HTTP 503', 503); // 4 da espera + a conferência
      return base.rpc.call(m, p);
    },
  };
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 60_000 });
  assert.equal(res.length, 1);
  assert.equal(res[0].status, 'desconhecido');
  assert.match(res[0].detail!, /parou de responder depois do envio/);
  assert.ok(res[0].signature, 'guarda a assinatura para conferir');
  assert.equal(res[0].error?.code, 'send-unknown');
  assert.equal(res[0].error?.beforeSend, false);
});

// ---------- taxa do app (11%) ----------

const FEE = APP_FEE_WALLET;
const FEE_BAL = 1_000_000;
const feeBalances = { ...balances, [FEE]: FEE_BAL };
const withFee = (steps: Step[]): Plan => ({ ...tokensPlan(0), steps, appFee: appFeeFor(DEST) });
const fee11 = (n: number) => (BigInt(n) * 11n) / 100n;

test('taxa: a carteira que recebe é a de 09/11/2026, sem histórico', () => {
  assert.equal(APP_FEE_WALLET, 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL');
});

test('taxa: 11% arredondado para baixo; destino = carteira da taxa não paga', () => {
  assert.deepEqual([9n, 100n, 2_039_280n].map((n) => appFeeLamports(n, appFeeFor(DEST))), [0n, 11n, 224_320n]);
  assert.equal(appFeeLamports(1_000n, null), 0n);
  assert.equal(appFeeFor(APP_FEE_WALLET), null);
  const p = (destination: string) => buildPlan({ scans: [scan(0, { lamports: 1e9, tokens: [tok(ACC[0])] })], prices: new Map(), destination, rentExemptZero: RENT0 });
  assert.deepEqual(p(DEST).appFee, { wallet: APP_FEE_WALLET, bps: 1_100n });
  assert.equal(p(APP_FEE_WALLET).appFee, null);
});

test('taxa: fechar contas manda o aluguel para a burner e dela 89% ao destino e 11% à taxa, na mesma transação', async () => {
  const total = 3 * 2_039_280;
  const seen: { transfers: Transfer[]; ixs: Ix[] }[] = [];
  const plan = withFee(tokensPlan(3).steps);
  const { rpc } = execRpc({
    balances: feeBalances,
    sim: (_k, _n, _p, transfers, ixs) => (seen.push({ transfers, ixs }), { dest: 50_000_000 + total - Number(fee11(total)), fee: FEE_BAL + Number(fee11(total)) }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, BigInt(total) - fee11(total));
  assert.equal(res[0].appFeeDelta, fee11(total));
  const { transfers, ixs } = seen.at(-1)!;
  const closes = ixs.filter((x) => x.program === PROGRAMS.token && x.data[0] === 9);
  assert.equal(closes.length, 3);
  assert.ok(closes.every((c) => c.accounts[1] === S[1].address), 'o aluguel vai para a burner, não direto ao destino');
  assert.deepEqual(transfers, [
    { from: S[1].address, to: DEST, lamports: BigInt(total) - fee11(total) },
    { from: S[1].address, to: FEE, lamports: fee11(total) },
  ]);
});

test('taxa: coleta da curva numa burner com 0 SOL manda 89% ao destino e 11% à taxa, depois de devolver o empréstimo', async () => {
  const RENT_MAINNET = 650_240;
  const claim = 531_000;
  const plan = withFee([{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: BigInt(claim) }]);
  let last: Transfer[] = [];
  const { rpc } = execRpc({
    balances: { ...feeBalances, [S[1].address]: 0 },
    rent0: RENT_MAINNET,
    sim: (_k, n, _p, transfers) => {
      last = transfers;
      return n === 0 ? { wallet: RENT_MAINNET + claim } : { dest: 50_000_000 + claim - Number(fee11(claim)), fee: FEE_BAL + Number(fee11(claim)), wallet: 0 };
    },
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, BigInt(claim) - fee11(claim));
  assert.equal(res[0].appFeeDelta, fee11(claim));
  assert.deepEqual(last, [
    { from: S[0].address, to: S[1].address, lamports: BigInt(RENT_MAINNET) },
    { from: S[1].address, to: S[0].address, lamports: BigInt(RENT_MAINNET) },
    { from: S[1].address, to: DEST, lamports: BigInt(claim) - fee11(claim) },
    { from: S[1].address, to: FEE, lamports: fee11(claim) },
  ]);
});

// Regra (autor, 31/10/2026): todo SOL recuperado paga 11% UMA vez; isento só o que o cliente depositou para as taxas.
// Mudou em 31/10/2026: a fee ficava na pagadora e pagava 11% no envio final dela, mas a simulação desse envio não a
// via e a tela Confirmar não mostrava a coleta (test/limpeza/claim-visivel.test.ts). Agora sai ao destino na própria
// coleta, com os 11%, e o envio final não a vê: continua pagando uma vez só.
test('taxa: coleta na pagadora manda a fee ao destino na hora (89% destino, 11% taxa), uma vez só', async () => {
  const claim = 531_000;
  const plan = withFee([{ kind: 'claim-curve', walletIndex: 0, wallet: S[0].address, estimateLamports: BigInt(claim) }]);
  const vault = pumpCreatorVault(S[0].address);
  let last: Transfer[] = [];
  const { rpc } = execRpc({
    balances: { ...feeBalances, [vault]: RENT0 + claim },
    // medição: só a coleta, a pagadora paga 1 assinatura (5.000); na real, a fee segue adiante
    sim: (_k, n, _p, transfers) => (
      (last = transfers),
      n === 0
        ? { accounts: { [vault]: RENT0, [S[0].address]: 1e9 + claim - 5_000 } }
        : { dest: 50_000_000 + claim - Number(fee11(claim)), fee: FEE_BAL + Number(fee11(claim)), accounts: { [vault]: RENT0, [S[0].address]: 1e9 - 5_000 } }
    ),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].appFeeDelta, fee11(claim));
  assert.equal(res[0].destinationDelta, BigInt(claim) - fee11(claim));
  assert.deepEqual(last, [
    { from: S[0].address, to: DEST, lamports: BigInt(claim) - fee11(claim) },
    { from: S[0].address, to: FEE, lamports: fee11(claim) },
  ]);
});

// envio final da pagadora com um depósito isento: o que o executor manda e o que a simulação tem que mostrar
async function payerSweep(exempt: bigint | undefined) {
  const plan = { ...withFee([
    { kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false },
    { kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true },
  ]), payerExemptLamports: exempt };
  const amounts = [3_000_000, 1e9 - 5_000];
  const exemptPart = exempt === undefined ? 0n : exempt < BigInt(amounts[1]) ? exempt : BigInt(amounts[1]);
  const fees = [fee11(amounts[0]), fee11(Number(BigInt(amounts[1]) - exemptPart))];
  const seen: Transfer[][] = [];
  const { rpc } = execRpc({
    balances: feeBalances,
    sim: (_k, n, _p, transfers) => (seen.push(transfers), { dest: 50_000_000 + amounts[n] - Number(fees[n]), fee: FEE_BAL + Number(fees[n]) }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  return { res, seen, amounts, fees };
}

test('taxa: SOL solto de burner paga 11%; pagadora com SOL esquecido (sem depósito) também paga 11% de tudo', async () => {
  const { res, seen, amounts, fees } = await payerSweep(undefined);
  assert.deepEqual(res.map((r) => r.status), ['simulado', 'simulado']);
  assert.deepEqual(res.map((r) => r.appFeeDelta), [fee11(amounts[0]), fee11(amounts[1])]);
  assert.deepEqual(seen[0], [
    { from: S[1].address, to: DEST, lamports: BigInt(amounts[0]) - fee11(amounts[0]) },
    { from: S[1].address, to: FEE, lamports: fee11(amounts[0]) },
  ]);
  assert.deepEqual(seen[1], [
    { from: S[0].address, to: DEST, lamports: BigInt(amounts[1]) - fees[1] },
    { from: S[0].address, to: FEE, lamports: fees[1] },
  ], 'a pagadora é a temporária com mais SOL esquecido: antes saía inteira, sem taxa (achado do e2e de 31/10)');
});

test('taxa: pagadora com depósito do cliente: só o depósito é isento, o resto paga 11%', async () => {
  const deposit = 10_000_000n;
  const { res, seen, amounts } = await payerSweep(deposit);
  const fee = fee11(Number(BigInt(amounts[1]) - deposit));
  assert.equal(res[1].appFeeDelta, fee);
  assert.equal(res[1].destinationDelta, BigInt(amounts[1]) - fee);
  assert.deepEqual(seen[1], [
    { from: S[0].address, to: DEST, lamports: BigInt(amounts[1]) - fee },
    { from: S[0].address, to: FEE, lamports: fee },
  ]);
});

test('taxa: depósito maior que o que sobrou na pagadora (as taxas de rede gastaram): nada paga taxa, sem valor negativo', async () => {
  const { res, seen, amounts } = await payerSweep(BigInt(2e9));
  assert.equal(res[1].appFeeDelta, 0n);
  assert.deepEqual(seen[1], [{ from: S[0].address, to: DEST, lamports: BigInt(amounts[1]) }]);
});

test('taxa: destino = carteira da taxa do autor: nem a pagadora nem as outras pagam', async () => {
  const plan: Plan = { ...tokensPlan(0), steps: [
    { kind: 'sweep-sol', walletIndex: 1, wallet: S[1].address, isFeePayer: false },
    { kind: 'sweep-sol', walletIndex: 0, wallet: S[0].address, isFeePayer: true },
  ], appFee: null, payerExemptLamports: 0n };
  const seen: Transfer[][] = [];
  const amounts = [3_000_000, 1e9 - 5_000];
  const { rpc } = execRpc({ balances, sim: (_k, n, _p, transfers) => (seen.push(transfers), { dest: 50_000_000 + amounts[n] }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.appFeeDelta ?? 0n), [0n, 0n]);
  assert.deepEqual(seen, [[{ from: S[1].address, to: DEST, lamports: BigInt(amounts[0]) }], [{ from: S[0].address, to: DEST, lamports: BigInt(amounts[1]) }]]);
});

test('taxa: o plano guarda como isento só o depósito da PAGADORA, limitado ao saldo dela; sem a informação, nada isento', () => {
  const scans = [scan(0, { lamports: 30_000_000, tokens: [tok(ACC[0])] }), scan(1, { lamports: 50_000_000 })];
  const p = (deposits?: Map<number, bigint>) => buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0, deposits });
  assert.equal(p().feePayerIndex, 1, 'a pagadora é a com mais SOL');
  assert.equal(p().payerExemptLamports, 0n);
  assert.equal(p(new Map([[1, 10_000_000n]])).payerExemptLamports, 10_000_000n);
  assert.equal(p(new Map([[0, 10_000_000n]])).payerExemptLamports, 0n, 'depósito em outra temporária não isenta a pagadora');
  assert.equal(p(new Map([[1, 90_000_000n]])).payerExemptLamports, 50_000_000n, 'nunca mais que o saldo');
  assert.equal(p(new Map([[1, -5n]])).payerExemptLamports, 0n);
});

test('taxa: carteira da taxa inexistente ou que não é carteira comum PARA antes de qualquer simulação', async () => {
  for (const bal of [balances, { ...balances, [FEE]: 0 }]) {
    const { rpc, calls } = execRpc({ balances: bal, sim: () => ({}) });
    await assert.rejects(execute({ rpc, plan: withFee(tokensPlan(1).steps), signers, mode: 'simulate' }), (e: unknown) => e instanceof ExecutionAborted && /taxa do app/.test((e as Error).message));
    assert.ok(!calls.includes('simulateTransaction') && !calls.includes('sendTransaction'));
  }
});

test('taxa: simulação com valor diferente na carteira da taxa PARA TUDO', async () => {
  const total = 2_039_280;
  const { rpc, calls } = execRpc({ balances: feeBalances, sim: () => ({ dest: 50_000_000 + total - Number(fee11(total)), fee: FEE_BAL + Number(fee11(total)) + 1 }) });
  await assert.rejects(execute({ rpc, plan: withFee(tokensPlan(1).steps), signers, mode: 'execute', sleep: async () => {} }), ExecutionAborted);
  assert.ok(!calls.includes('sendTransaction'));
});

test('taxa: plano sem taxa (destino = carteira da taxa) continua igual: fechar direto no destino, sem transferências', async () => {
  const seen: Ix[][] = [];
  const plan: Plan = { ...tokensPlan(2), appFee: null };
  const { rpc } = execRpc({ balances, sim: (_k, _n, _p, _t, ixs) => (seen.push(ixs), { dest: 50_000_000 + 2 * 2_039_280 }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].appFeeDelta ?? 0n, 0n);
  assert.ok(seen[0].filter((x) => x.program === PROGRAMS.token && x.data[0] === 9).every((c) => c.accounts[1] === DEST));
  assert.ok(!seen[0].some((x) => x.program === PROGRAMS.system));
});
test('executor: onStepStart chamado uma vez por passo, em ordem, antes do onResult do passo', async () => {
  const bad = ACC[1];
  const { rpc } = execRpc({
    balances,
    sim: (keys) => (keys.includes(bad) ? { err: { InstructionError: [0, 'x'] }, logs: ['Program log: Error: Account is frozen'] } : { dest: 50_000_000 + 2_039_280 * keys.filter((k) => ACC.includes(k)).length }),
  });
  const events: string[] = [];
  const totals: number[] = [];
  const res = await execute({
    rpc, plan: tokensPlan(3), signers, mode: 'execute', sleep: async () => {},
    onStepStart: (_s, i, t) => { events.push(`start${i}`); totals.push(t); if (i === 0) throw new Error('listener ruim'); },
    onResult: () => events.push('result'),
  });
  // o lote falha e é refeito conta por conta: 1 passo vira 3 (a fila cresce, o total acompanha)
  assert.equal(res.length, 4);
  assert.deepEqual(events.filter((e) => e.startsWith('start')), ['start0', 'start1', 'start2', 'start3']);
  // cada início vem antes do resultado do próprio passo: start, result, start, result...
  assert.deepEqual(events, ['start0', 'result', 'start1', 'result', 'start2', 'result', 'start3', 'result']);
  assert.equal(totals[0], 1);
  assert.equal(totals[3], 4);
});

// ---------- fee parada nas moedas (trocas novas da Pump.fun, desde 07/10/2026) ----------
// Instruções e contas conferidas no IDL do commit 639b87fb (docs/pumpfun-creator-fees.md).

const SWEEP_DISC = '20f6bf3408c949ba';
const curveOf = (mint: string) => findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address;
const parked = (k: number, lamports = 100_000n) => ({ curve: curveOf(ACC[20 + k]), mint: ACC[20 + k], lamports });
function feesWith(over: Record<string, unknown> = {}) {
  return { bondingVault: 'x', bondingVaultLamports: 0, ammVaultAta: 'y', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 1, pools: 0, detailed: true, unsweptError: null, ...over } as NonNullable<WalletScan['fees']>;
}

test('plano: fee parada vira coleta mesmo com o cofre vazio; a varredura vai no passo da coleta', () => {
  const plan = buildPlan({ scans: [scan(0, { lamports: 1e9, fees: feesWith({ curveSweeps: [parked(0)] }) })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ['claim-curve', 'sweep-sol']);
  const claim = plan.steps[0] as Extract<Step, { kind: 'claim-curve' }>;
  assert.deepEqual(claim.sweeps, [parked(0)]);
  assert.equal(claim.estimateLamports, 100_000n);
  assert.ok(!claim.sweepOnly);
  // parte que o app não coleta (recompensa a holders, cashback, outro par) não vira passo
  const other = buildPlan({ scans: [scan(0, { lamports: 1e9, fees: feesWith({ unsweptCurveLamports: 9_000_000n }) })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(other.steps.map((s) => s.kind), ['sweep-sol']);
});

test('plano: mais moedas paradas do que cabe numa transação: passos só de varrer antes, a coleta leva as últimas', () => {
  const sweeps = [0, 1, 2, 3, 4].map((k) => parked(k));
  const plan = buildPlan({ scans: [scan(0, { lamports: 1e9, fees: feesWith({ bondingVaultLamports: 50_000, curveSweeps: sweeps }) })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const claims = plan.steps.filter((s) => s.kind === 'claim-curve') as Array<Extract<Step, { kind: 'claim-curve' }>>;
  assert.equal(SWEEPS_PER_TX, 3);
  assert.deepEqual(claims.map((c) => [c.sweepOnly ?? false, c.sweeps?.length]), [[true, 2], [false, 3]]);
  assert.deepEqual(claims.flatMap((c) => c.sweeps!.map((x) => x.mint)), sweeps.map((x) => x.mint), 'cada moeda uma vez, na ordem');
  assert.equal(claims.reduce((a, c) => a + c.estimateLamports, 0n), 550_000n, 'estimativas somam cofre + fee parada, sem contar duas vezes');
});

test('plano: varrer reserva aluguel do cofre e o crescimento das contas antigas na pagadora', () => {
  const base = (fees: ReturnType<typeof feesWith>) => buildPlan({ scans: [scan(0, { lamports: 1e9, fees })], prices: new Map(), destination: DEST, rentExemptZero: RENT0 }).reserveNeededLamports;
  const semVarrer = base(feesWith({ bondingVaultLamports: 300_000 }));
  const comVarrer = base(feesWith({ bondingVaultLamports: 200_000, curveSweeps: [parked(0)] }));
  assert.ok(comVarrer - semVarrer >= rentFor(FEE_ACCOUNT_GROWTH_BYTES, RENT0), `reserva a mais: ${comVarrer - semVarrer}`);
  const pool = { pool: ACC[30], quoteAccount: ACC[31], lamports: 100_000n };
  const semPool = base(feesWith({ ammVaultLamports: 300_000 }));
  const comPool = base(feesWith({ ammVaultLamports: 200_000, poolSweeps: [pool] }));
  assert.ok(comPool - semPool >= rentFor(TOKEN_ACCOUNT_BYTES, RENT0), 'ATA WSOL do cofre do PumpSwap pode nascer');
});

test('executor: coleta da curva varre a fee parada ANTES de coletar, na medição e na transação real', async () => {
  const RENT = 650_240;
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 1_000_000n, sweeps: [parked(0, 1_000_000n)] }];
  const seen: Ix[][] = [];
  const { rpc } = execRpc({
    balances: { ...balances, [S[1].address]: 0 },
    rent0: RENT,
    sim: (_k, n, _p, _t, ixs) => (seen.push(ixs), n === 0 ? { wallet: RENT + 1_000_000 } : { dest: 50_000_000 + 1_000_000, wallet: 0 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 1_000_000n);
  const kinds = (ixs: Ix[]) => ixs.map((x) => (x.program === PROGRAMS.pump ? x.data.toString('hex') : x.program === PROGRAMS.system ? 'sys' : x.program));
  assert.deepEqual(kinds(seen[0]), ['sys', SWEEP_DISC, 'cf118af204221338'], 'medição: empréstimo, varre, coleta');
  assert.deepEqual(kinds(seen[1]), ['sys', SWEEP_DISC, 'cf118af204221338', 'sys', 'sys'], 'real: empréstimo, varre, coleta, devolve, envia');
  const sweep = seen[1][1];
  assert.equal(sweep.accounts.length, 13, '13 contas, como no IDL');
  assert.equal(sweep.accounts[0], S[0].address, 'payer = pagadora');
  assert.equal(sweep.accounts[1], findProgramAddress(['global'], PROGRAMS.pump).address);
  assert.equal(sweep.accounts[2], ACC[20], 'base_mint');
  assert.equal(sweep.accounts[3], WSOL_MINT);
  assert.equal(sweep.accounts[7], curveOf(ACC[20]), 'bonding_curve do mint');
  assert.equal(sweep.accounts[9], pumpCreatorVault(S[1].address), 'recipient = cofre do criador (a temporária)');
  assert.equal(sweep.accounts[11], findProgramAddress(['__event_authority'], PROGRAMS.pump).address);
  assert.equal(sweep.accounts[12], PROGRAMS.pump);
  assert.equal(sweep.data.length, 8, 'sem argumentos');
});

test('executor: passo só de varrer é assinado só pela pagadora e não mexe no destino nem na temporária', async () => {
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 200_000n, sweeps: [parked(0), parked(1)], sweepOnly: true }];
  const seen: Array<{ keys: string[]; ixs: Ix[] }> = [];
  const { rpc } = execRpc({ balances, sim: (keys, _n, _p, _t, ixs) => (seen.push({ keys, ixs }), {}) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 0n);
  assert.ok(seen.length > 0 && seen.every(({ keys }) => !keys.includes(S[1].address)), 'a temporária nem entra na transação');
  assert.ok(seen.every(({ ixs }) => ixs.every((x) => x.program === PROGRAMS.pump && x.data.toString('hex') === SWEEP_DISC)), 'só varreduras');
});

test('executor: coleta do PumpSwap varre o pool antes de coletar (12 contas, como no IDL)', async () => {
  const plan = tokensPlan(0);
  const pool = { pool: ACC[30], quoteAccount: ACC[31], lamports: 500_000n };
  plan.steps = [{ kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 500_000n, sweeps: [pool] }];
  const seen: Ix[][] = [];
  const ata = associatedTokenAddress(S[1].address, WSOL_MINT, PROGRAMS.token);
  const tokenRent = Number(rentFor(165, RENT0));
  // medição: a ATA nasce (aluguel da pagadora) e recebe a fee; real: fecha a ATA, devolve o aluguel e manda a fee
  const { rpc } = execRpc({ balances, sim: (_k, n, _p, _t, ixs) => (seen.push(ixs), n === 0 ? { accounts: { [ata]: tokenRent + 500_000 } } : { dest: 50_000_000 + 500_000 }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 500_000n, 'a fee do PumpSwap chega ao destino na própria coleta');
  assert.deepEqual(seen[0].map((x) => x.program), [PROGRAMS.associatedToken, PROGRAMS.pumpAmm, PROGRAMS.pumpAmm], 'medição: cria a ATA, varre, coleta');
  assert.deepEqual(seen[1].map((x) => x.program), [PROGRAMS.associatedToken, PROGRAMS.pumpAmm, PROGRAMS.pumpAmm, PROGRAMS.token, PROGRAMS.system, PROGRAMS.system], 'real: + fecha a ATA, devolve o aluguel, envia');
  const sweep = seen[0][1];
  assert.equal(sweep.data.toString('hex'), SWEEP_DISC);
  assert.equal(sweep.accounts.length, 12);
  assert.deepEqual(
    [sweep.accounts[0], sweep.accounts[1], sweep.accounts[2], sweep.accounts[3], sweep.accounts[5], sweep.accounts[6], sweep.accounts[7]],
    [S[0].address, PUMP_AMM_GLOBAL_CONFIG, ACC[30], WSOL_MINT, ACC[31], pumpAmmCreatorVaultAuthority(S[1].address), pumpAmmCreatorVaultAta(S[1].address)],
  );
  assert.equal(seen[0][2].data.toString('hex'), 'a039592ab58b2b42', 'coleta depois da varredura');
  assert.equal(findProgramAddress(['global_config'], PROGRAMS.pumpAmm).address, PUMP_AMM_GLOBAL_CONFIG, 'endereço da doc = PDA');
});

test('executor: coleta com o máximo de varreduras, taxa do app e taxa de prioridade cabe numa transação', async () => {
  const RENT = 650_240;
  const plan = tokensPlan(0);
  plan.appFee = appFeeFor(DEST);
  const sweeps = Array.from({ length: SWEEPS_PER_TX }, (_, k) => parked(k, 1_000_000n));
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 3_000_000n, sweeps }];
  const total = 3_000_000n;
  const fee = appFeeLamports(total, plan.appFee);
  const sizes: number[] = [];
  const { rpc } = execRpc({
    balances: { ...balances, [S[1].address]: 0, [APP_FEE_WALLET]: 100_000_000 },
    rent0: RENT,
    priorityFees: [{ prioritizationFee: 40_000 }],
    sim: (_k, n, _p, _t, _i, bytes) => (sizes.push(bytes), n === 0 ? { wallet: RENT + 3_000_000 } : { dest: 50_000_000 + Number(total - fee), fee: 100_000_000 + Number(fee), wallet: 0 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado', res[0].detail);
  assert.equal(res[0].appFeeDelta, fee);
  assert.ok(sizes.length >= 3 && Math.max(...sizes) <= MAX_TX_BYTES, `maior transação: ${Math.max(...sizes)} bytes`);
});

test('executor: moeda com fee sharing (Pump.fun 6050) pula só aquela coleta; as outras seguem', async () => {
  const RENT = 650_240;
  const claim = (i: number): Step => ({ kind: 'claim-curve', walletIndex: i, wallet: S[i].address, estimateLamports: 500_000n });
  const plan = tokensPlan(0);
  plan.steps = [claim(1), claim(2)];
  const sharing = { err: { InstructionError: [1, { Custom: PUMP_FEE_SHARING_ERROR }] }, logs: ['Program log: AnchorError: UnableToDistributeCreatorVaultMigratedToSharingConfig'] };
  const { rpc } = execRpc({
    balances: { ...balances, [S[1].address]: 0, [S[2].address]: 0 },
    rent0: RENT,
    // N=1 tem fee sharing; N=2 normal: medição devolve aluguel + fee, a real envia ao destino
    sim: (keys, n) => (keys.includes(S[1].address) ? sharing : n === 1 ? { wallet: RENT + 500_000 } : { dest: 50_000_000 + 500_000, wallet: 0 }),
  });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['nada a fazer', 'simulado']);
  assert.match(res[0].detail!, /fee sharing/);
  // na pagadora sem taxa do app não há medição: o erro vem da simulação do passo, e também não cancela
  const p2 = tokensPlan(0);
  p2.steps = [claim(0), claim(2)];
  const { rpc: rpc2 } = execRpc({ balances: { ...balances, [S[2].address]: 0 }, rent0: RENT, sim: (keys, n) => (!keys.includes(S[2].address) ? sharing : n === 1 ? { wallet: RENT + 500_000 } : { dest: 50_000_000 + 500_000, wallet: 0 }) });
  const r2 = await execute({ rpc: rpc2, plan: p2, signers, mode: 'simulate' });
  assert.deepEqual(r2.map((r) => r.status), ['nada a fazer', 'simulado']);
});

// ---------- conta que mudou desde a varredura e nó do RPC atrasado (print do autor, 31/10/2026) ----------

const parsedToken = (amount: unknown, isNative = false) => ({ parsed: { info: { tokenAmount: { amount }, isNative } } });
const destFor = (keys: string[]) => ({ dest: 50_000_000 + 2_039_280 * keys.filter((k) => ACC.includes(k)).length });

test('executor: conta com saldo diferente do analisado sai do lote com motivo, antes de simular; as outras seguem', async () => {
  const simulated: string[][] = [];
  const { rpc } = execRpc({ balances, tokenData: { [ACC[1]]: parsedToken('5') }, sim: (keys) => (simulated.push(keys), destFor(keys)) });
  const res = await execute({ rpc, plan: tokensPlan(3), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['falhou', 'simulado']);
  const bad = res[0].step as Extract<Step, { kind: 'tokens' }>;
  assert.deepEqual(bad.actions.map((a) => a.account), [ACC[1]]);
  assert.equal(res[0].error?.code, 'token-balance-changed');
  assert.equal(res[0].error?.beforeSend, true);
  assert.match(res[0].detail!, /0 → 5/);
  assert.deepEqual((res[1].step as Extract<Step, { kind: 'tokens' }>).actions.map((a) => a.account), [ACC[0], ACC[2]]);
  assert.equal(res[1].destinationDelta, 2n * 2_039_280n);
  assert.ok(simulated.every((k) => !k.includes(ACC[1])), 'a conta que mudou nunca entra numa transação');
});

test('executor: conta que já não existe vira "nada a fazer" e não derruba o lote', async () => {
  const { rpc } = execRpc({ balances, tokenData: { [ACC[0]]: null }, sim: destFor });
  const res = await execute({ rpc, plan: tokensPlan(2), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['nada a fazer', 'simulado']);
  assert.match(res[0].detail!, /já foi fechada/);
  assert.equal(res[0].error, undefined);
});

test('executor: saldo da conta fora do formato ou conta nativa (WSOL) não bloqueia; a simulação decide', async () => {
  const { rpc } = execRpc({
    balances,
    tokenData: { [ACC[0]]: parsedToken(null), [ACC[1]]: parsedToken('12a'), [ACC[2]]: {}, [ACC[3]]: parsedToken('999', true) },
    sim: destFor,
  });
  const res = await execute({ rpc, plan: tokensPlan(4), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['simulado']);
  assert.equal((res[0].step as Extract<Step, { kind: 'tokens' }>).actions.length, 4);
});

test('executor: "BlockhashNotFound" na simulação busca blockhash novo e simula de novo uma vez', async () => {
  const { rpc, calls } = execRpc({ balances, sim: (keys, n) => (n === 0 ? { err: 'BlockhashNotFound' } : destFor(keys)) });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['simulado']);
  assert.equal(calls.filter((c) => c === 'getLatestBlockhash').length, 2);
});

// a nova simulação reatribui também a fee liberada no cofre e o custo da pagadora (revisão da autoclarn-40, 31/10/2026):
// sem isso, pending e payerCost ficavam 0 e a Confirmar mostrava a menos (fee) ou a mais (desconto da pagadora)
test('executor: "BlockhashNotFound" na 1ª simulação de um passo só de varrer ainda mede a fee liberada e o custo da pagadora', async () => {
  const plan = tokensPlan(0);
  plan.steps = [{ kind: 'claim-curve', walletIndex: 1, wallet: S[1].address, estimateLamports: 300_000n, sweeps: [parked(0), parked(1)], sweepOnly: true }];
  const vault = pumpCreatorVault(S[1].address);
  const { rpc } = execRpc({ balances, sim: (_k, n) => (n === 0 ? { err: 'BlockhashNotFound' } : { accounts: { [vault]: RENT0 + 300_000, [S[0].address]: 1e9 - 7_000 } }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].pendingClaimLamports, 300_000n);
  assert.equal(res[0].payerCostLamports, 7_000n);
});

test('executor: "BlockhashNotFound" na medida da coleta busca blockhash novo e mede de novo (não cancela as coletas)', async () => {
  const plan = tokensPlan(0);
  const pool = { pool: ACC[30], quoteAccount: ACC[31], lamports: 500_000n };
  plan.steps = [{ kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 500_000n, sweeps: [pool] }];
  const ata = associatedTokenAddress(S[1].address, WSOL_MINT, PROGRAMS.token);
  const tokenRent = Number(rentFor(165, RENT0));
  const { rpc, calls } = execRpc({ balances, sim: (_k, n) => (n === 0 ? { err: 'BlockhashNotFound' } : n === 1 ? { accounts: { [ata]: tokenRent + 500_000 } } : { dest: 50_000_000 + 500_000 }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.equal(res[0].status, 'simulado');
  assert.equal(res[0].destinationDelta, 500_000n);
  assert.equal(calls.filter((c) => c === 'getLatestBlockhash').length, 2);
});

test('executor: "BlockhashNotFound" de novo na medida da coleta falha a coleta, sem tentar uma terceira vez', async () => {
  const plan = tokensPlan(0);
  const pool = { pool: ACC[30], quoteAccount: ACC[31], lamports: 500_000n };
  plan.steps = [{ kind: 'claim-amm', walletIndex: 1, wallet: S[1].address, estimateLamports: 500_000n, sweeps: [pool] }];
  const { rpc, calls } = execRpc({ balances, sim: () => ({ err: 'BlockhashNotFound' }) });
  const res = await execute({ rpc, plan, signers, mode: 'simulate' });
  assert.notEqual(res[0].status, 'simulado');
  assert.equal(calls.filter((c) => c === 'simulateTransaction').length, 2);
});

test('executor: "BlockhashNotFound" de novo falha só este passo, com rpc-out-of-sync (sem insistir mais)', async () => {
  const { rpc, calls } = execRpc({ balances, sim: () => ({ err: 'BlockhashNotFound' }) });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate' });
  assert.deepEqual(res.map((r) => r.status), ['falhou']);
  assert.equal(res[0].error?.code, 'rpc-out-of-sync');
  assert.equal(calls.filter((c) => c === 'simulateTransaction').length, 2);
});

test('executor: programa de tokens recusando no passo de tokens vira token-rejected, nunca unknown', async () => {
  const logs = ['Program log: Instruction: CloseAccount', 'Program log: Error: owner does not match', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x4'];
  const { rpc } = execRpc({ balances, sim: () => ({ err: { InstructionError: [0, { Custom: 4 }] }, logs }) });
  const res = await execute({ rpc, plan: tokensPlan(1), signers, mode: 'simulate' });
  assert.equal(res[0].status, 'falhou');
  assert.equal(res[0].error?.code, 'token-rejected');
});
