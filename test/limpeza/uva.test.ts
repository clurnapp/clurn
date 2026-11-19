// Conta de volume da Pump.fun e do PumpSwap (UserVolumeAccumulator): leitura, regra de fechar e plano.
// Spec docs/superpowers/specs/2026-11-06-chaves-e-caminhos-design.md §4.4; fatos do IDL no plano da fase 1 (Task 2),
// conferidos de novo em 06/11/2026 (pump-public-docs 639b87fb). A execução contra uma rede com estado está em
// test/limpeza/claim-visivel.test.ts ("uva: …").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pumpCloseUserVolumeAccumulator } from '../../src/core/solana/instructions.ts';
import { findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, userVolumeAccumulator, WSOL_MINT, associatedTokenAddress } from '../../src/core/solana/pda.ts';
import { parseUva, parseGlobalVolumeEnd, readUva, scanWallet, scanWallets, unreadParts, uvaStates, type UvaState, type VolumeContext } from '../../src/core/limpeza/scan.ts';
import { buildPlan, rentFor, PRIORITY_BUDGET_LAMPORTS, type Step } from '../../src/core/limpeza/plan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { BASE_FEE_LAMPORTS } from '../../src/core/limpeza/summary.ts';
import { RUN_COSTS } from '../../src/app/eta.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.closeVolumeAccounts = true;

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1, 2].map((n) => burnerSigner(seed, n));
const W = S[1].address;
const DEST = deriveMainAddress(seed);
const RENT0 = 650_240;
const UVA_LEN = 137; // tamanho medido na mainnet em 06/11/2026 (os dois programas; o IDL usa 106 e 90, o resto é folga)
const UVA_RENT = Number(rentFor(UVA_LEN, RENT0)); // 1.346.200, igual ao lido na mainnet
const NOW = 1_800_000_000; // segundos

const uvaAddr = (w: string, v: 'pump' | 'amm') => userVolumeAccumulator(w, v === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm);
const globalAddr = (v: 'pump' | 'amm') => findProgramAddress(['global_volume_accumulator'], v === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm).address;

type UvaOpts = { needsClaim?: number; unclaimedTokens?: bigint; volume?: bigint; cashbackEarned?: bigint; stableEarned?: bigint; stableClaimed?: bigint; len?: number; disc?: string; user?: string };
// buffer no layout do IDL: disc 0, user 8, needs_claim 40, total_unclaimed_tokens 41, total_claimed_tokens 49,
// current_sol_volume 57, last_update_timestamp 65, has_total_claimed_tokens 73, cashback_earned 74,
// total_cashback_claimed 82 e, só na Pump.fun, stable_cashback_earned 90, total_stable_cashback_claimed 98
function uvaBytes(o: UvaOpts = {}): Buffer {
  const b = Buffer.alloc(o.len ?? UVA_LEN);
  Buffer.from(o.disc ?? '56ff700e66359afa', 'hex').copy(b, 0);
  if (b.length >= 40) Buffer.from(new Uint8Array(32).fill(7)).copy(b, 8);
  if (b.length > 40) b[40] = o.needsClaim ?? 0;
  if (b.length >= 49) b.writeBigUInt64LE(o.unclaimedTokens ?? 0n, 41);
  if (b.length >= 65) b.writeBigUInt64LE(o.volume ?? 0n, 57);
  if (b.length >= 82) b.writeBigUInt64LE(o.cashbackEarned ?? 0n, 74);
  if (b.length >= 98) b.writeBigUInt64LE(o.stableEarned ?? 0n, 90);
  if (b.length >= 106) b.writeBigUInt64LE(o.stableClaimed ?? 0n, 98);
  return b;
}
function globalBytes(end: bigint, disc = 'ca2af62b8ebe1eff'): Buffer {
  const b = Buffer.alloc(32);
  Buffer.from(disc, 'hex').copy(b, 0);
  b.writeBigInt64LE(0n, 8);
  b.writeBigInt64LE(end, 16);
  return b;
}

type Net = {
  accounts: Map<string, { lamports: number; data: Buffer }>;
  tokenOwners?: Map<string, { token?: number; token2022?: number }>; // contas de token de cada dono
  fail?: (method: string, params: unknown[]) => boolean;
  dirtyTokenList?: boolean;
  calls: Array<{ method: string; params: unknown[] }>;
};
function netRpc(net: Net): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      net.calls.push({ method, params });
      if (net.fail?.(method, params)) throw new RpcError(`${method}: HTTP 503`, 503);
      switch (method) {
        case 'getMultipleAccounts':
          return {
            value: (params[0] as string[]).map((k) => {
              const a = net.accounts.get(k);
              return a ? { lamports: a.lamports, data: [a.data.toString('base64'), 'base64'] } : null;
            }),
          } as T;
        case 'getTokenAccountsByOwner': {
          if (net.dirtyTokenList) return { value: null } as T;
          const [owner, filter] = params as [string, { programId: string }];
          const n = net.tokenOwners?.get(owner)?.[filter.programId === PROGRAMS.token2022 ? 'token2022' : 'token'] ?? 0;
          return { value: Array.from({ length: n }, (_, i) => ({ pubkey: `${owner.slice(0, 8)}${i}`, account: { lamports: 2_039_280, data: { parsed: { info: { mint: WSOL_MINT, isNative: true, state: 'initialized', tokenAmount: { amount: '0', decimals: 9 } } } } } })) } as T;
        }
        case 'getProgramAccounts':
          return [] as T;
        default:
          throw new RpcError(`${method}: não previsto no teste`);
      }
    },
  };
}
function net(over: Partial<Net> = {}): Net {
  return { accounts: new Map(), calls: [], ...over };
}
const ctx = (end: { pump?: bigint; amm?: bigint } = {}): VolumeContext => ({ now: () => NOW, ...(end.pump !== undefined || end.amm !== undefined ? { ends: Promise.resolve({ pump: end.pump ?? 0n, amm: end.amm ?? 0n }) } : {}) });
const setUva = (n: Net, w: string, v: 'pump' | 'amm', o: UvaOpts = {}, lamports = UVA_RENT) => n.accounts.set(uvaAddr(w, v), { lamports, data: uvaBytes(o) });
async function statesOf(n: Net, c: VolumeContext = ctx({})): Promise<UvaState[]> {
  const rpc = netRpc(n);
  const accs = [n.accounts.get(uvaAddr(W, 'pump')) ?? null, n.accounts.get(uvaAddr(W, 'amm')) ?? null];
  return uvaStates(rpc, W, accs, c, RENT0);
}

// ---------- instrução ----------

test('uva: instrução de fechar', () => {
  for (const program of [PROGRAMS.pump, PROGRAMS.pumpAmm]) {
    const ix = pumpCloseUserVolumeAccumulator(W, program);
    assert.equal(ix.programId, program);
    assert.equal(Buffer.from(ix.data).toString('hex'), 'f945a4da9667548a', 'discriminador do IDL, sem argumentos');
    assert.equal(ix.keys.length, 4);
    assert.deepEqual(ix.keys[0], { pubkey: W, isSigner: true, isWritable: true }, 'user assina e é gravável (recebe o aluguel)');
    assert.deepEqual(ix.keys[1], { pubkey: userVolumeAccumulator(W, program), isSigner: false, isWritable: true });
    assert.deepEqual(ix.keys[2], { pubkey: findProgramAddress(['__event_authority'], program).address, isSigner: false, isWritable: false });
    assert.deepEqual(ix.keys[3], { pubkey: program, isSigner: false, isWritable: false });
  }
  assert.throws(() => pumpCloseUserVolumeAccumulator(W, PROGRAMS.token), /programa/);
});

// ---------- decodificação ----------

test('uva: decodifica pump e amm', () => {
  const pump = parseUva(uvaBytes({ needsClaim: 1, unclaimedTokens: 5n, volume: 7n, stableEarned: 9n, stableClaimed: 4n }), 'pump');
  assert.deepEqual(pump, { needsClaim: true, unclaimedTokens: 5n, solVolume: 7n, stableEarned: 9n, stableClaimed: 4n });
  // o PumpSwap não tem os campos do cashback em stable: 90 bytes bastam
  const amm = parseUva(uvaBytes({ len: 90, volume: 3n }), 'amm');
  assert.deepEqual(amm, { needsClaim: false, unclaimedTokens: 0n, solVolume: 3n, stableEarned: 0n, stableClaimed: 0n });
  // a Pump.fun precisa dos 106 do IDL
  assert.equal(parseUva(uvaBytes({ len: 105 }), 'pump'), null);
  assert.equal(parseGlobalVolumeEnd(globalBytes(123n)), 123n);
});

// ---------- regra ----------

test('uva: cada impedimento deixa aberta', async () => {
  const one = async (setup: (n: Net) => void, c: VolumeContext = ctx({})) => {
    const n = net();
    setup(n);
    return (await statesOf(n, c))[0];
  };
  // a conta que não guarda nada: fecha
  const ok = await one((n) => setUva(n, W, 'pump'));
  assert.deepEqual(ok, { program: 'pump', address: uvaAddr(W, 'pump'), lamports: BigInt(UVA_RENT), rentLamports: BigInt(UVA_RENT), closable: true });
  // incentivo em token PUMP a coletar
  assert.equal((await one((n) => setUva(n, W, 'pump', { needsClaim: 1 }))).why, 'incentive');
  assert.equal((await one((n) => setUva(n, W, 'pump', { unclaimedTokens: 1n }))).why, 'incentive');
  // incentivo ativo e volume de hoje: o volume ainda vira token
  assert.equal((await one((n) => setUva(n, W, 'amm', { volume: 1n }), ctx({ amm: BigInt(NOW + 60) }))).why, 'incentive');
  // cashback em stable (só na Pump.fun) ainda não coletado
  assert.equal((await one((n) => setUva(n, W, 'pump', { stableEarned: 10n, stableClaimed: 9n }))).why, 'stable-cashback');
  // conta de token da conta de volume (a ATA WSOL do PumpSwap, ou qualquer outra, nos dois programas de token)
  for (const key of ['token', 'token2022'] as const) {
    const st = await one((n) => {
      setUva(n, W, 'amm');
      n.tokenOwners = new Map([[uvaAddr(W, 'amm'), { [key]: 1 }]]);
    });
    assert.deepEqual([st.closable, st.why], [false, 'token-account'], key);
  }
  // leitura que falha
  const failed = await one((n) => {
    setUva(n, W, 'pump');
    n.fail = (m) => m === 'getTokenAccountsByOwner';
  });
  assert.deepEqual([failed.closable, failed.why], [false, 'read-failed']);
  // nenhum impedimento deixa a conta fechável sem querer: todos os casos acima com closable false
});

test('uva: cashback em SOL não impede (o executor coleta antes, na mesma transação)', async () => {
  const n = net();
  setUva(n, W, 'pump', { cashbackEarned: 400_000n }, UVA_RENT + 400_000);
  const [st] = await statesOf(n);
  assert.equal(st.closable, true);
  assert.equal(st.lamports, BigInt(UVA_RENT + 400_000));
  assert.equal(st.rentLamports, BigInt(UVA_RENT), 'o que passa do aluguel é cashback');
});

test('uva: incentivo encerrado há mais que a folga ignora o volume do dia; encerrado há pouco, segura', async () => {
  const n = net();
  setUva(n, W, 'pump', { volume: 5_000_000n });
  const H = 3600;
  // revisão independente de 08/11/2026: o volume do último dia ainda pode virar token logo depois do fim
  assert.equal((await statesOf(n, ctx({ pump: BigInt(NOW - 1) })))[0].why, 'incentive', 'acabou agora: segura');
  assert.equal((await statesOf(n, ctx({ pump: BigInt(NOW - 47 * H) })))[0].why, 'incentive', 'acabou há 47 h: segura (folga de 48 h sem o seconds_in_a_day)');
  assert.equal((await statesOf(n, ctx({ pump: BigInt(NOW - 48 * H - 1) })))[0].closable, true, 'acabou há mais de 48 h: o volume não vira mais nada');
  assert.equal((await statesOf(n, ctx({ pump: 0n })))[0].closable, true, 'nunca configurado (medido na mainnet em 06/11/2026: 0 e 0)');
  assert.equal((await statesOf(n, ctx({ pump: BigInt(NOW + 1) })))[0].why, 'incentive', 'ainda ativo');
  // a janela de cada programa é a dele
  assert.equal((await statesOf(n, ctx({ pump: 0n, amm: BigInt(NOW + 1) })))[0].closable, true);
  // "dia" de 3 dias: a folga é 2 dias do programa (6 dias); "dia" curto nunca baixa de 48 h
  const withDay = (end: number, day: bigint): VolumeContext => ({ now: () => NOW, ends: Promise.resolve({ pump: BigInt(end), amm: 0n, day: { pump: day } }) });
  assert.equal((await statesOf(n, withDay(NOW - 5 * 24 * H, 3n * 24n * 3600n)))[0].why, 'incentive');
  assert.equal((await statesOf(n, withDay(NOW - 6 * 24 * H - 1, 3n * 24n * 3600n)))[0].closable, true);
  assert.equal((await statesOf(n, withDay(NOW - 47 * H, 60n)))[0].why, 'incentive', 'seconds_in_a_day pequeno não encurta a folga');
  assert.equal((await statesOf(n, withDay(NOW - 47 * H, -5n)))[0].why, 'incentive', 'fora do formato: 48 h');
  // sem volume: nada a segurar, mesmo logo depois do fim
  const vazio = net();
  setUva(vazio, W, 'pump');
  assert.equal((await statesOf(vazio, ctx({ pump: BigInt(NOW - 1) })))[0].closable, true);
});

test('uva: seconds_in_a_day lido da rede com a janela (offset 24 do IDL)', async () => {
  const n = net();
  const g = globalBytes(BigInt(NOW - 5 * 24 * 3600));
  g.writeBigInt64LE(3n * 24n * 3600n, 24);
  n.accounts.set(globalAddr('pump'), { lamports: 1, data: g });
  setUva(n, W, 'pump', { volume: 1n });
  const [st] = await statesOf(n, { now: () => NOW });
  assert.equal(st.why, 'incentive', 'fim há 5 dias, "dia" de 3 dias: ainda na folga');
  // sem o campo (conta curta): 48 h
  const short = net();
  short.accounts.set(globalAddr('pump'), { lamports: 1, data: globalBytes(BigInt(NOW - 49 * 3600)).subarray(0, 24) });
  setUva(short, W, 'pump', { volume: 1n });
  assert.equal((await statesOf(short, { now: () => NOW }))[0].closable, true);
});

test('uva: a janela do incentivo é lida da rede, uma vez por rodada', async () => {
  const n = net();
  n.accounts.set(globalAddr('pump'), { lamports: 1, data: globalBytes(BigInt(NOW + 100)) });
  n.accounts.set(globalAddr('amm'), { lamports: 1, data: globalBytes(0n) });
  for (const s of S) {
    setUva(n, s.address, 'pump', { volume: 1n });
    setUva(n, s.address, 'amm', { volume: 1n });
  }
  const scans = await scanWallets(netRpc(n), S.map((s) => ({ index: s.index, address: s.address })), { rentExemptZero: RENT0, detailedFees: true, volume: { now: () => NOW } });
  for (const s of scans) {
    assert.deepEqual(s.fees?.uva?.map((u) => [u.program, u.closable, u.why]), [['pump', false, 'incentive'], ['amm', true, undefined]]);
  }
  const globalReads = n.calls.filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[]).includes(globalAddr('pump')));
  assert.equal(globalReads.length, RUN_COSTS.uvaReqPerRound, 'uma leitura da global para as 3 carteiras');
  // custo (RUN_COSTS): só a conta que passa nas outras condições (a do PumpSwap) lê as contas de token dela
  assert.equal(n.calls.filter((c) => c.method === 'getTokenAccountsByOwner').length, 3 * 2 + 3 * RUN_COSTS.uvaReqPerAccount);
  // carteira sem conta de volume não lê nada a mais (nem a global)
  const vazia = net();
  await scanWallets(netRpc(vazia), [{ index: 0, address: W }], { rentExemptZero: RENT0, detailedFees: true });
  assert.equal(vazia.calls.filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[]).includes(globalAddr('pump'))).length, 0);
  assert.equal(vazia.calls.filter((c) => c.method === 'getTokenAccountsByOwner').length, 2, 'só as 2 da própria carteira');
});

// ---------- falha e dado sujo ----------

test('uva: leitura que falha não fecha e não derruba', async () => {
  // contas de token da conta de volume não respondem
  const n = net({ fail: (m, p) => m === 'getTokenAccountsByOwner' && p[0] === uvaAddr(W, 'pump') });
  setUva(n, W, 'pump', {}, UVA_RENT + 400_000);
  setUva(n, W, 'amm');
  const s = await scanWallet(netRpc(n), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true, volume: ctx({}) });
  assert.deepEqual(s.errors, [], 'nada vira erro da carteira');
  assert.deepEqual(unreadParts(s), [], 'nem parte sem ler (a análise não relê por causa dela)');
  assert.equal(s.fees?.cashback?.pump, 400_000n, 'o cashback lido continua valendo');
  assert.deepEqual(s.fees?.uva?.map((u) => [u.program, u.closable, u.why]), [['pump', false, 'read-failed'], ['amm', true, undefined]], 'só a que falhou fica aberta');
  // a janela do incentivo não responde: nenhuma fecha
  const g = net({ fail: (m, p) => m === 'getMultipleAccounts' && (p[0] as string[]).includes(globalAddr('pump')) });
  setUva(g, W, 'pump');
  const sg = await scanWallet(netRpc(g), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true, volume: { now: () => NOW } });
  assert.deepEqual([sg.errors, sg.fees?.uva?.[0]?.why], [[], 'read-failed']);
  // a leitura das próprias contas de volume não responde: o cashback marca a carteira (como antes), e nada fecha
  const v = net({ fail: (m, p) => m === 'getMultipleAccounts' && (p[0] as string[]).includes(uvaAddr(W, 'pump')) });
  setUva(v, W, 'pump');
  const sv = await scanWallet(netRpc(v), { index: 1, address: W }, { rentExemptZero: RENT0, detailedFees: true, volume: ctx({}) });
  assert.ok(sv.fees?.uva?.every((u) => !u.closable && u.why === 'read-failed'));
  // o plano não fecha nenhuma conta que não deu para ler, e o resto da carteira segue
  const p = buildPlan({ scans: [{ ...s, lamports: 50_000_000 }], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(p.steps.filter((x) => x.kind === 'close-uva').map((x) => (x as Extract<Step, { kind: 'close-uva' }>).venue), ['amm']);
  assert.ok(p.steps.some((x) => x.kind === 'claim-cashback'), 'o cashback da que não fecha é coletado como antes');
});

test('uva: dado sujo', async () => {
  const cases: Array<[string, (n: Net) => void]> = [
    ['conta curta demais', (n) => n.accounts.set(uvaAddr(W, 'pump'), { lamports: UVA_RENT, data: uvaBytes({ len: 60 }) })],
    ['discriminador errado', (n) => n.accounts.set(uvaAddr(W, 'pump'), { lamports: UVA_RENT, data: uvaBytes({ disc: '0000000000000000' }) })],
    ['bool fora de 0/1', (n) => setUva(n, W, 'pump', { needsClaim: 2 })],
    [
      'getTokenAccountsByOwner sem lista',
      (n) => {
        setUva(n, W, 'pump');
        n.dirtyTokenList = true;
      },
    ],
  ];
  for (const [name, setup] of cases) {
    const n = net();
    setup(n);
    const [st] = await statesOf(n);
    assert.deepEqual([st.closable, st.why], [false, 'read-failed'], name);
  }
  // janela do incentivo fora do formato
  const g = net();
  g.accounts.set(globalAddr('pump'), { lamports: 1, data: globalBytes(0n, '0000000000000000') });
  setUva(g, W, 'pump');
  assert.equal((await statesOf(g, { now: () => NOW }))[0].why, 'read-failed');
  // janela que não existe na rede = incentivo nunca configurado
  const none = net();
  setUva(none, W, 'pump', { volume: 1n });
  assert.equal((await statesOf(none, { now: () => NOW }))[0].closable, true);
  // releitura do executor: conta que sumiu = null; conta suja = read-failed
  const r = net();
  assert.equal(await readUva(netRpc(r), W, 'pump', ctx({}), RENT0), null);
  r.accounts.set(uvaAddr(W, 'pump'), { lamports: UVA_RENT, data: Buffer.from('xx') });
  assert.equal((await readUva(netRpc(r), W, 'pump', ctx({}), RENT0))?.why, 'read-failed');
});

// ---------- plano ----------

const scanOf = (index: number, address: string, lamports: number, uva: UvaState[], cashback?: { pump: bigint; amm: bigint }) => ({
  index,
  address,
  lamports,
  tokens: [],
  errors: [],
  fees: { bondingVault: pumpCreatorVault(address), bondingVaultLamports: 0, ammVaultAta: pumpAmmCreatorVaultAta(address), ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, uva, ...(cashback ? { cashback } : {}) },
});
const uvaState = (address: string, program: 'pump' | 'amm', over: Partial<UvaState> = {}): UvaState => ({ program, address: uvaAddr(address, program), lamports: BigInt(UVA_RENT), rentLamports: BigInt(UVA_RENT), closable: true, ...over });

test('uva: plano fecha depois das coletas, leva o cashback da Pump.fun junto e conta a transação na reserva', () => {
  const payer = scanOf(0, S[0].address, 1_000_000_000, []);
  const w = scanOf(1, W, 0, [uvaState(W, 'pump', { lamports: BigInt(UVA_RENT + 400_000) }), uvaState(W, 'amm')], { pump: 400_000n, amm: 0n });
  const p = buildPlan({ scans: [payer, w], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const mine = p.steps.filter((x) => x.walletIndex === 1).map((x) => (x.kind === 'close-uva' ? `close-uva:${x.venue}:${x.estimateLamports}` : x.kind));
  // o cashback da Pump.fun vai no passo que fecha (simulação = execução: dois passos contariam o cashback duas vezes)
  assert.deepEqual(mine, [`close-uva:pump:${UVA_RENT + 400_000}`, `close-uva:amm:${UVA_RENT}`, 'sweep-sol']);
  // não fechável: o cashback volta a ter o passo próprio, e nada fecha
  const open = scanOf(1, W, 0, [uvaState(W, 'pump', { closable: false, why: 'token-account' })], { pump: 400_000n, amm: 0n });
  const po = buildPlan({ scans: [payer, open], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(po.steps.filter((x) => x.walletIndex === 1).map((x) => x.kind), ['claim-cashback', 'sweep-sol']);
  // depois das coletas da mesma carteira
  const amm = scanOf(1, W, 0, [uvaState(W, 'amm')], { pump: 0n, amm: 300_000n });
  amm.fees.ammVaultLamports = 2_000_000;
  const pa = buildPlan({ scans: [payer, amm], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(pa.steps.filter((x) => x.walletIndex === 1).map((x) => x.kind), ['claim-amm', 'close-uva', 'sweep-sol']);
  // reserva: cada conta de volume é uma transação a mais (2 assinaturas + prioridade) e um empréstimo do aluguel
  const perTx = BigInt(BASE_FEE_LAMPORTS) * 2n + PRIORITY_BUDGET_LAMPORTS;
  const bare = buildPlan({ scans: [payer, scanOf(1, W, 1_000_000, [])], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const one = buildPlan({ scans: [payer, scanOf(1, W, 1_000_000, [uvaState(W, 'amm')])], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.equal(one.reserveNeededLamports - bare.reserveNeededLamports, perTx + BigInt(RENT0));
  // conta de volume da pagadora também fecha (ela mesma assina)
  const pp = buildPlan({ scans: [scanOf(0, S[0].address, 1_000_000_000, [uvaState(S[0].address, 'pump')])], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(pp.steps.map((x) => x.kind), ['close-uva', 'sweep-sol']);
});

test('uva: carteira só com a conta de volume (0 SOL, nada mais) entra no plano', () => {
  const payer = scanOf(0, S[0].address, 1_000_000_000, []);
  const p = buildPlan({ scans: [payer, scanOf(1, W, 0, [uvaState(W, 'amm')])], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(p.steps.some((x) => x.kind === 'close-uva' && x.walletIndex === 1));
  // o ATA WSOL da conta de volume é dela, não da carteira: o plano não tenta fechar
  assert.ok(!p.steps.some((x) => x.kind === 'tokens' && x.actions.some((a) => a.account === associatedTokenAddress(uvaAddr(W, 'amm'), WSOL_MINT, PROGRAMS.token))));
});

// ---------- 1.0: conta de volume desligada (src/core/features.ts, congelamento de 16/11/2026) ----------

// liga/desliga só durante o teste (os testes deste arquivo rodam em sequência)
async function frozen<T>(fn: () => T | Promise<T>): Promise<T> {
  FEATURES.closeVolumeAccounts = false;
  try {
    return await fn();
  } finally {
    FEATURES.closeVolumeAccounts = true;
  }
}

test('1.0: conta de volume desligada → o cashback sai como na 0.2.4 (claim-cashback) e nenhuma conta de volume fecha', async () => {
  await frozen(() => {
    const payer = scanOf(0, S[0].address, 1_000_000_000, []);
    // a mesma carteira que, ligada, fecha as duas contas e leva o cashback junto (teste "plano fecha depois das coletas")
    const w = scanOf(1, W, 0, [uvaState(W, 'pump', { lamports: BigInt(UVA_RENT + 400_000) }), uvaState(W, 'amm')], { pump: 400_000n, amm: 0n });
    const p = buildPlan({ scans: [payer, w], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
    assert.deepEqual(p.steps.filter((x) => x.walletIndex === 1).map((x) => x.kind), ['claim-cashback', 'sweep-sol']);
    assert.ok(!p.steps.some((x) => x.kind === 'close-uva'), 'nenhum close-uva no plano');
    // pagadora com conta de volume e carteira só com a conta de volume: nada fecha
    const pp = buildPlan({ scans: [scanOf(0, S[0].address, 1_000_000_000, [uvaState(S[0].address, 'pump')])], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
    assert.deepEqual(pp.steps.map((x) => x.kind), ['sweep-sol']);
  });
});

test('1.0: conta de volume desligada → a análise nem lê o estado das contas de volume (nem a janela do incentivo)', async () => {
  await frozen(async () => {
    const n = net();
    n.accounts.set(globalAddr('pump'), { lamports: 1, data: globalBytes(0n) });
    n.accounts.set(globalAddr('amm'), { lamports: 1, data: globalBytes(0n) });
    setUva(n, W, 'pump', {}, UVA_RENT + 400_000);
    setUva(n, W, 'amm', {});
    const [s] = await scanWallets(netRpc(n), [{ index: 0, address: W }], { rentExemptZero: RENT0, detailedFees: true, volume: { now: () => NOW } });
    assert.deepEqual(s.fees?.uva, []);
    assert.equal(s.fees?.cashback?.pump, 400_000n, 'o cashback continua sendo lido');
    assert.equal(n.calls.filter((c) => c.method === 'getMultipleAccounts' && (c.params[0] as string[]).includes(globalAddr('pump'))).length, 0, 'a global não é lida');
    assert.equal(n.calls.filter((c) => c.method === 'getTokenAccountsByOwner').length, 2, 'só as 2 da própria carteira');
  });
});
