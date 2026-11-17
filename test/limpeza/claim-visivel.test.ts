// "O modo simulação mostra exatamente o que será feito" (CLAUDE.md §8), com creator fees.
//
// Achado de 31/10/2026 (rodada de um tester): o app coletou creator fees que a tela Confirmar não mostrou. A tela
// soma o que cada passo SIMULADO leva ao destino, e cada passo é simulado sobre a rede de agora (sem os passos
// anteriores). A coleta do PumpSwap e a coleta na pagadora deixavam a fee na temporária: o passo simulado levava 0
// ao destino, e o "enviar todo o SOL" simulado lia o saldo sem a fee. Na execução, o envio lia o saldo novo e
// levava a fee junto. Os testes do executor não pegavam porque cada um roteiriza a resposta da simulação.
//
// Aqui a rede falsa TEM ESTADO e executa as instruções que o app monta (transferência, criar ATA, fechar conta,
// coletar e varrer da curva e do PumpSwap), com as regras da rede que mudam o resultado: taxa por assinatura, aluguel
// mínimo de conta comum e a Pump.fun que não paga a carteira com saldo zero (docs/aprendizados.md, 30/10/2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, rentFor, TOKEN_ACCOUNT_BYTES, type Step } from '../../src/core/limpeza/plan.ts';
import { execute, type StepResult } from '../../src/core/limpeza/executor.ts';
import { buildReceipt } from '../../src/app/receipt.ts';
import { parseTokenAccount, readUva, type UvaState, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { createHash } from 'node:crypto';
import { burnerSigner, deriveMainAddress, mnemonicToSeed, publicKeyFromPrivate } from '../../src/core/carteiras/derivation.ts';
import { keySigners, parseKeys, wipeParsedKeys } from '../../src/core/carteiras/keys.ts';
import { RpcError, type RpcClient } from '../../src/core/solana/rpc.ts';
import { decodeBase58, encodeBase58 } from '../../src/core/solana/base58.ts';
import { associatedTokenAddress, findProgramAddress, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault, sharingConfigAddress, userVolumeAccumulator, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { APP_FEE_WALLET, appFeeFor, appFeeLamports } from '../../src/core/limpeza/app-fee.ts';
import { BASE_FEE_LAMPORTS } from '../../src/core/limpeza/summary.ts';
import { FEATURES } from '../../src/core/features.ts';

// suíte de recurso congelado na 1.0 (src/core/features.ts): liga o interruptor só neste processo de teste
FEATURES.closeVolumeAccounts = true;
FEATURES.pastedKeys = true;

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const S = [0, 1, 2, 3].map((n) => burnerSigner(seed, n));
const DEST = deriveMainAddress(seed);
const signers = new Map(S.map((s) => [s.index, s]));
const RENT0 = 650_240;
const RENT_TOKEN = Number(rentFor(TOKEN_ACCOUNT_BYTES, RENT0));
const ataWsol = (owner: string) => associatedTokenAddress(owner, WSOL_MINT, PROGRAMS.token);
const curveOf = (mint: string) => findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address;
const MINTS = Array.from({ length: 4 }, (_, i) => burnerSigner(seed, 200 + i).address);
const POOLS = Array.from({ length: 4 }, (_, i) => burnerSigner(seed, 300 + i).address);

const hex = (b: Buffer) => b.toString('hex');
const PUMP_COLLECT = 'cf118af204221338';
const AMM_COLLECT = 'a039592ab58b2b42';
const SWEEP = '20f6bf3408c949ba';

type Chain = {
  lamports: Map<string, number>;
  tokenAccounts: Set<string>; // contas de token (não são conta comum: sem a regra do aluguel mínimo)
  parked: Map<string, number>; // fee parada por curva ou pool
  feesPaid: number;
  // dados de conta que o app lê (o sharing config) e os participantes de cada divisão, na ordem
  data?: Map<string, Buffer>;
  sharing?: Map<string, Array<{ address: string; bps: number }>>;
  refuseClose?: Set<string>; // contas de volume cujo fechamento o programa recusa (teste de falha)
};
const DISTRIBUTE = 'ffcb134ff444089f';
const CASHBACK_PUMP = '7af3cc415e741d37';
const CASHBACK_AMM = '253a237ebe35e4c5';
const TO_PUMP = '01214eb921432c5c';
const CLOSE_UVA = 'f945a4da9667548a';
// participante de fora (de outra pessoa): carteira comum, entra na regra do aluguel mínimo
const OTHER = burnerSigner(seed, 500).address;

// Cartão de chaves coladas (fase 1 multirredes, Task 5): chaves geradas aqui (semente = hash de um rótulo), lidas pelo
// parser do app e transformadas em assinantes como o servidor faz (keySigners), com os bytes zerados em seguida.
const PASTED = parseKeys([0, 1].map((i) => {
  const seedK = createHash('sha256').update(`clurn-visivel-chave-${i}`).digest();
  return encodeBase58(Buffer.concat([seedK, publicKeyFromPrivate(seedK)]));
}).join('\r\n'));
assert.ok(PASTED.ok);
const KEY_SIGNERS = keySigners(PASTED.keys);
wipeParsedKeys(PASTED.keys);
const K = [...KEY_SIGNERS.values()];

// carteiras comuns: terminam com 0 ou com o aluguel mínimo (a rede recusa o meio)
const SYSTEM_WALLETS = new Set([...S.map((s) => s.address), ...K.map((k) => k.address), DEST, APP_FEE_WALLET, OTHER]);

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
  return { numSigners: msg[0], payer: names[0], ixs };
}

// aplica a transação numa cópia; devolve a cópia ou o erro (como a rede: tudo ou nada)
function apply(c: Chain, b64: string): { chain: Chain } | { err: string } {
  const n: Chain = { lamports: new Map(c.lamports), tokenAccounts: new Set(c.tokenAccounts), parked: new Map(c.parked), feesPaid: c.feesPaid, data: c.data, sharing: c.sharing, refuseClose: c.refuseClose };
  const bal = (a: string) => n.lamports.get(a) ?? 0;
  const add = (a: string, v: number) => n.lamports.set(a, bal(a) + v);
  const move = (from: string, to: string, v: number) => {
    if (v < 0 || bal(from) < v) throw new Error(`insufficient lamports ${bal(from)}, need ${v}`);
    add(from, -v);
    add(to, v);
  };
  const { numSigners, payer, ixs } = decode(b64);
  try {
    const fee = BASE_FEE_LAMPORTS * numSigners;
    if (bal(payer) < fee) throw new Error('payer sem SOL para a taxa');
    add(payer, -fee);
    n.feesPaid += fee;
    for (const x of ixs) {
      if (x.program === 'ComputeBudget111111111111111111111111111111') continue;
      if (x.program === PROGRAMS.system && x.data.readUInt32LE(0) === 2) {
        move(x.accounts[0], x.accounts[1], Number(x.data.readBigUInt64LE(4)));
      } else if (x.program === PROGRAMS.associatedToken) {
        const [p, ata] = x.accounts;
        if (!n.lamports.has(ata)) {
          move(p, ata, RENT_TOKEN);
          n.tokenAccounts.add(ata);
        }
      } else if ((x.program === PROGRAMS.token || x.program === PROGRAMS.token2022) && x.data[0] === 9) {
        const [acc, to] = x.accounts;
        if (!n.lamports.has(acc)) throw new Error(`conta ${acc} não existe (fechar)`);
        move(acc, to, bal(acc));
        n.lamports.delete(acc);
        n.tokenAccounts.delete(acc);
      } else if (x.program === PROGRAMS.pump && hex(x.data) === PUMP_COLLECT) {
        const [creator, , vault] = x.accounts;
        // a Pump.fun não paga a carteira com saldo zero (a coleta roda e não move nada)
        if (bal(creator) > 0) move(vault, creator, Math.max(0, bal(vault) - RENT0));
      } else if (x.program === PROGRAMS.pump && hex(x.data) === SWEEP) {
        const [p, , , , , , , curve, , vault] = x.accounts;
        if (!n.lamports.has(vault)) move(p, vault, RENT0);
        add(vault, n.parked.get(curve) ?? 0);
        n.parked.delete(curve);
      } else if (x.program === PROGRAMS.pumpAmm && hex(x.data) === SWEEP) {
        const [p, , pool, , , , , vaultAta] = x.accounts;
        if (!n.lamports.has(vaultAta)) {
          move(p, vaultAta, RENT_TOKEN);
          n.tokenAccounts.add(vaultAta);
        }
        add(vaultAta, n.parked.get(pool) ?? 0);
        n.parked.delete(pool);
      } else if (x.program === PROGRAMS.pump && hex(x.data.subarray(0, 8)) === DISTRIBUTE) {
        // paga o cofre do sharing config (acima do aluguel) a cada participante, na ordem do config
        const [, , , config, vault] = x.accounts;
        const holders = n.sharing?.get(config) ?? [];
        const given = x.accounts.slice(12);
        if (given.join() !== holders.map((h) => h.address).join()) throw new Error('6054: participantes fora da ordem do config');
        const avail = Math.max(0, bal(vault) - RENT0);
        for (const h of holders) move(vault, h.address, Math.floor((avail * h.bps) / 10_000));
      } else if (x.program === PROGRAMS.pump && hex(x.data) === CASHBACK_PUMP) {
        // cashback da Pump.fun: o acumulador paga o que tem acima do aluguel (sem dados no teste antigo: aluguel RENT0;
        // com dados, o aluguel pelo tamanho, como na mainnet em 06/11/2026)
        const [user, uva] = x.accounts;
        const len = n.data?.get(uva)?.length;
        move(uva, user, Math.max(0, bal(uva) - (len === undefined ? RENT0 : Number(rentFor(len, RENT0)))));
      } else if ((x.program === PROGRAMS.pump || x.program === PROGRAMS.pumpAmm) && hex(x.data) === CLOSE_UVA) {
        // fecha a conta de volume: todos os lamports dela vão para o user (simulado na mainnet em 06/11/2026)
        const [user, uva] = x.accounts;
        if (!n.lamports.has(uva)) throw new Error('Error Number: 3012. AccountNotInitialized (user_volume_accumulator)');
        if (n.refuseClose?.has(uva)) throw new Error('Error Number: 6000. o programa recusou o fechamento');
        move(uva, user, bal(uva));
        n.lamports.delete(uva);
        n.data = new Map(n.data);
        n.data.delete(uva);
      } else if (x.program === PROGRAMS.pumpAmm && hex(x.data) === CASHBACK_AMM) {
        // cashback do PumpSwap: WSOL da ATA do acumulador para a ATA WSOL do usuário (que tem que existir)
        const [, uvaAmm, , , uvaAta, userAta] = x.accounts;
        if (!n.lamports.has(uvaAmm)) throw new Error('Error Number: 3012. AccountNotInitialized (user_volume_accumulator)');
        if (!n.lamports.has(userAta)) throw new Error('ATA WSOL do usuário não existe');
        move(uvaAta, userAta, Math.max(0, bal(uvaAta) - RENT_TOKEN));
      } else if (x.program === PROGRAMS.pumpAmm && hex(x.data) === TO_PUMP) {
        // cofre do PumpSwap (WSOL) do sharing config → cofre da curva dele
        const [p, , , , , , , vaultAta, pumpVault] = x.accounts;
        if (!n.lamports.has(vaultAta)) throw new Error('cofre do PumpSwap não existe');
        if (!n.lamports.has(pumpVault)) move(p, pumpVault, RENT0);
        move(vaultAta, pumpVault, Math.max(0, bal(vaultAta) - RENT_TOKEN));
      } else if (x.program === PROGRAMS.pumpAmm && hex(x.data) === AMM_COLLECT) {
        const vaultAta = x.accounts[4];
        const creatorAta = x.accounts[5];
        if (!n.lamports.has(creatorAta)) throw new Error('ATA WSOL do criador não existe');
        move(vaultAta, creatorAta, Math.max(0, bal(vaultAta) - RENT_TOKEN));
      } else {
        throw new Error(`instrução não prevista no teste: ${x.program} ${hex(x.data)}`);
      }
    }
    for (const a of SYSTEM_WALLETS) {
      const l = bal(a);
      if (l > 0 && l < RENT0) throw new Error(`InsufficientFundsForRent ${a}`);
    }
    for (const [a, l] of n.lamports) if (l === 0 && !n.tokenAccounts.has(a)) n.lamports.delete(a);
    return { chain: n };
  } catch (e) {
    return { err: (e as Error).message };
  }
}

function chainRpc(state: { chain: Chain }): RpcClient {
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const c = state.chain;
      switch (method) {
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'getMultipleAccounts':
          return { value: (params[0] as string[]).map((a) => (c.lamports.has(a) ? { lamports: c.lamports.get(a), ...(c.data?.has(a) ? { data: [c.data.get(a)!.toString('base64'), 'base64'] } : {}) } : null)) } as T;
        case 'getAccountInfo': {
          const a = params[0] as string;
          return { value: c.lamports.has(a) ? { owner: PROGRAMS.system, lamports: c.lamports.get(a), executable: false } : null } as T;
        }
        case 'getMinimumBalanceForRentExemption':
          return RENT0 as T;
        case 'getTokenAccountsByOwner': {
          // só a ATA WSOL de cada dono existe nesta rede
          const [owner, { programId }] = params as [string, { programId: string }];
          const ata = associatedTokenAddress(owner, WSOL_MINT, programId);
          return { value: c.tokenAccounts.has(ata) ? [{ pubkey: ata, account: { lamports: c.lamports.get(ata), data: { parsed: { info: { mint: WSOL_MINT, isNative: true } } } } }] : [] } as T;
        }
        case 'simulateTransaction': {
          const r = apply(c, params[0] as string);
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          if ('err' in r) return { value: { err: { InstructionError: [0, 'Custom'] }, logs: [`Program log: Error: ${r.err}`], accounts: null } } as T;
          return { value: { err: null, logs: [], unitsConsumed: 50_000, accounts: addrs.map((a) => (r.chain.lamports.has(a) ? { lamports: r.chain.lamports.get(a) } : null)) } } as T;
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

type Setup = {
  wallets: number[]; // lamports de S0..S3 (S0 é a pagadora: a mais rica)
  curveVault?: Record<number, number>; // fee no cofre da curva, acima do aluguel
  ammVault?: Record<number, number>; // WSOL no cofre do PumpSwap
  curveParked?: Record<number, number>; // fee parada numa curva desta carteira
  poolParked?: Record<number, number>; // fee parada num pool desta carteira
  wsolAta?: Record<number, number>; // a temporária já tem a ATA WSOL (vazia), com este aluguel
};

function setup(o: Setup, who: Array<{ address: string }> = S) {
  const lamports = new Map<string, number>([[DEST, 50_000_000], [APP_FEE_WALLET, 100_000_000]]);
  const tokenAccounts = new Set<string>();
  const parked = new Map<string, number>();
  o.wallets.forEach((l, i) => l > 0 && lamports.set(who[i].address, l));
  const scans: WalletScan[] = o.wallets.map((l, i) => {
    const w = who[i].address;
    const curve = o.curveVault?.[i] ?? 0;
    const amm = o.ammVault?.[i] ?? 0;
    if (curve) lamports.set(pumpCreatorVault(w), RENT0 + curve);
    if (amm) {
      lamports.set(pumpAmmCreatorVaultAta(w), RENT_TOKEN + amm);
      tokenAccounts.add(pumpAmmCreatorVaultAta(w));
    }
    const curveSweeps = o.curveParked?.[i] ? [{ curve: curveOf(MINTS[i]), mint: MINTS[i], lamports: BigInt(o.curveParked[i]) }] : [];
    const poolSweeps = o.poolParked?.[i] ? [{ pool: POOLS[i], quoteAccount: burnerSigner(seed, 400 + i).address, lamports: BigInt(o.poolParked[i]) }] : [];
    for (const c of curveSweeps) parked.set(c.curve, Number(c.lamports));
    for (const p of poolSweeps) parked.set(p.pool, Number(p.lamports));
    const tokens = [];
    if (o.wsolAta?.[i]) {
      const ata = ataWsol(w);
      lamports.set(ata, o.wsolAta[i]);
      tokenAccounts.add(ata);
      tokens.push(parseTokenAccount({ pubkey: ata, account: { lamports: o.wsolAta[i], data: { parsed: { info: { mint: WSOL_MINT, isNative: true, state: 'initialized', tokenAmount: { amount: '0', decimals: 9 } } } } } }, w, 'token'));
    }
    const fees = curve || amm || curveSweeps.length || poolSweeps.length
      ? { bondingVault: pumpCreatorVault(w), bondingVaultLamports: curve, ammVaultAta: pumpAmmCreatorVaultAta(w), ammVaultLamports: amm, curveSweeps, poolSweeps, unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: curveSweeps.length, pools: poolSweeps.length, detailed: true, unsweptError: null }
      : null;
    return { index: i, address: w, lamports: l, tokens, fees, errors: [] };
  });
  return { state: { chain: { lamports, tokenAccounts, parked, feesPaid: 0 } as Chain }, scans };
}

const claimTotal = (o: Setup) =>
  [o.curveVault, o.ammVault, o.curveParked, o.poolParked].reduce((a, m) => a + Object.values(m ?? {}).reduce((x, y) => x + y, 0), 0);

// simula (o que a tela Confirmar mostra), executa na mesma rede e compara com o que chegou de verdade
async function roundTrip(o: Setup, withAppFee = true) {
  const { state, scans } = setup(o);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = withAppFee ? appFeeFor(DEST) : null;
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = { dest: state.chain.lamports.get(DEST)!, fee: state.chain.lamports.get(APP_FEE_WALLET)! };
  const done: StepResult[] = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before.dest);
  const feeArrived = BigInt(state.chain.lamports.get(APP_FEE_WALLET)! - before.fee);
  return { plan, sims, receipt, done, arrived, feeArrived, chain: state.chain };
}

// o que a tela mostra é o que chega, a menos do arredondamento dos 11% (1 lamport por divisão); a fee coletada
// nunca chega escondida, e nada aparece duas vezes
function assertShownMatchesArrived(r: Awaited<ReturnType<typeof roundTrip>>) {
  const diff = r.receipt.totalLamports - r.arrived;
  const slack = BigInt(r.done.length + 1);
  assert.ok(diff >= -slack, `chegou ${-diff} lamports a mais do que a tela mostrou (fee escondida)`);
  assert.ok(diff <= slack, `a tela mostrou ${diff} a mais do que chegou (taxas de rede pagas: ${r.chain.feesPaid})`);
  assert.ok(r.done.every((x) => x.status === 'enviado' || x.status === 'nada a fazer'), r.done.map((x) => `${x.status}: ${x.detail ?? ''}`).join(' | '));
  // as linhas da Confirmar (categorias em bruto − taxa do app) somam o total
  const d = r.receipt.toDestination;
  assert.equal(d.looseSolLamports + d.closedRentLamports + d.claimLamports - r.receipt.appFeeLamports, r.receipt.totalLamports, 'solto + aluguel + creator fees − taxa do app = total');
  // tela final (recibo do que foi ENVIADO): total = o que chegou, ao lamport; creator fees coletadas = as da Confirmar
  // (caso de um tester, 31/10/2026: a coleta chegou e a tela final não dizia)
  const x = buildReceipt({ plan: r.plan, simResults: r.done, holdings: [], main: DEST, executed: true });
  const xd = x.toDestination;
  assert.equal(x.totalLamports, r.arrived, 'tela final: total = chegou');
  assert.equal(xd.looseSolLamports + xd.closedRentLamports + xd.claimLamports - x.appFeeLamports, x.totalLamports, 'tela final: linhas somam o total');
  assert.equal(xd.claims, d.claims, 'tela final: mesmas coletas');
  assert.ok(xd.claimLamports >= d.claimLamports, `tela final: creator fees ${xd.claimLamports} (Confirmar ${d.claimLamports})`);
  assert.ok(xd.claimLamports - d.claimLamports <= BigInt(r.done.length), 'e não conta a varredura duas vezes');
}

test('fee do PumpSwap numa temporária vazia aparece na Confirmar e chega ao destino nela mesma', async () => {
  const o: Setup = { wallets: [50_000_000, 0], ammVault: { 1: 3_000_000 } };
  const r = await roundTrip(o);
  assertShownMatchesArrived(r);
  const claim = BigInt(claimTotal(o));
  assert.equal(r.receipt.toDestination.claims, 1);
  assert.equal(r.receipt.toDestination.claimLamports, claim, 'Creator fees na Confirmar = o coletado (bruto; os 11% saem na linha da taxa)');
  assert.equal(r.chain.lamports.get(S[1].address) ?? 0, 0, 'a temporária termina vazia');
});

test('fee parada no pool + cofre do PumpSwap, com a ATA WSOL da temporária já aberta: tudo mostrado, nenhuma falha', async () => {
  const o: Setup = { wallets: [50_000_000, 0], ammVault: { 1: 1_000_000 }, poolParked: { 1: 2_000_000 }, wsolAta: { 1: 2_039_280 } };
  const r = await roundTrip(o);
  assertShownMatchesArrived(r);
  assert.equal(r.receipt.failed.length, 0, 'a ATA WSOL que a coleta fecha não pode ser fechada de novo no passo das contas');
  const claim = BigInt(claimTotal(o));
  assert.equal(r.receipt.toDestination.claimLamports, claim);
});

test('coleta na PAGADORA (curva e PumpSwap) aparece na Confirmar', async () => {
  const o: Setup = { wallets: [50_000_000, 2_000_000], curveVault: { 0: 4_000_000 }, ammVault: { 0: 1_500_000 } };
  const r = await roundTrip(o);
  assertShownMatchesArrived(r);
  const claim = BigInt(claimTotal(o));
  assert.equal(r.receipt.toDestination.claims, 2);
  // cada coleta paga 11% separada: o arredondamento para baixo pode dar 1 lamport por coleta
  assert.equal(r.receipt.toDestination.claimLamports, claim, 'bruto: o coletado');
});

test('pagadora com coleta e destino = carteira da taxa (sem os 11%): a fee aparece inteira', async () => {
  const o: Setup = { wallets: [50_000_000], curveVault: { 0: 4_000_000 }, ammVault: { 0: 1_500_000 } };
  const r = await roundTrip(o, false);
  assertShownMatchesArrived(r);
  assert.equal(r.receipt.toDestination.claimLamports, BigInt(claimTotal(o)));
  assert.equal(r.feeArrived, 0n);
});

test('rodada com tudo junto: curva e pool, parada e no cofre, pagadora e temporárias vazias', async () => {
  const o: Setup = {
    wallets: [80_000_000, 0, 1_000_000, 0],
    curveVault: { 0: 700_000, 1: 2_000_000, 3: 900_000 },
    ammVault: { 0: 300_000, 1: 3_000_000, 2: 500_000 },
    curveParked: { 1: 1_000_000, 2: 400_000 },
    poolParked: { 1: 600_000, 3: 800_000 },
    wsolAta: { 2: 2_039_280 },
  };
  const r = await roundTrip(o);
  assertShownMatchesArrived(r);
  assert.equal(r.receipt.failed.length, 0);
  const shownClaims = r.receipt.toDestination.claimLamports;
  const claim = BigInt(claimTotal(o));
  // 11% por coleta, arredondado para baixo em cada uma
  assert.equal(shownClaims, claim, 'creator fees mostradas (bruto) = o coletado');
  for (const s of S.slice(1)) assert.equal(r.chain.lamports.get(s.address) ?? 0, 0, 'temporárias vazias');
  // a taxa do app mostrada é a que chega (a da pagadora sai um pouco menor: as taxas de rede saem antes dos 11%)
  assert.ok(r.receipt.appFeeLamports >= r.feeArrived && r.receipt.appFeeLamports - r.feeArrived <= BigInt(r.chain.feesPaid), `taxa mostrada ${r.receipt.appFeeLamports}, chegou ${r.feeArrived}`);
});

test('mais moedas com fee parada do que cabe numa transação (passos só de varrer): tudo aparece na Confirmar', async () => {
  // 5 moedas paradas na curva da N=1 e 5 pools: 2 passos só de varrer + a coleta, em cada um
  const { state, scans } = setup({ wallets: [80_000_000, 0], curveVault: { 1: 500_000 }, ammVault: { 1: 400_000 } });
  const parkedCurves = MINTS.concat(burnerSigner(seed, 210).address).map((mint, k) => ({ curve: curveOf(mint), mint, lamports: BigInt(300_000 + k * 1_000) }));
  const parkedPools = POOLS.concat(burnerSigner(seed, 310).address).map((pool, k) => ({ pool, quoteAccount: burnerSigner(seed, 400 + k).address, lamports: BigInt(200_000 + k * 1_000) }));
  for (const c of parkedCurves) state.chain.parked.set(c.curve, Number(c.lamports));
  for (const p of parkedPools) state.chain.parked.set(p.pool, Number(p.lamports));
  scans[1].fees = { ...scans[1].fees!, curveSweeps: parkedCurves, poolSweeps: parkedPools, coinsOnCurve: 5, pools: 5 };
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  assert.ok(plan.steps.some((s) => (s.kind === 'claim-curve' || s.kind === 'claim-amm') && s.sweepOnly), 'o caso tem passos só de varrer');
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = state.chain.lamports.get(DEST)!;
  const done = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before);
  assertShownMatchesArrived({ plan, receipt, arrived, chain: state.chain, done } as Awaited<ReturnType<typeof roundTrip>>);
  const claim = 900_000n + [...parkedCurves, ...parkedPools].reduce((a, x) => a + x.lamports, 0n);
  const shown = receipt.toDestination.claimLamports;
  assert.equal(shown, claim, 'creator fees mostradas (bruto) = o coletado, varreduras incluídas');
  assert.equal(receipt.toDestination.claims, 2, 'duas coletas (curva e PumpSwap); varrer não é coleta');
});

test('passo de coleta: o plano não fecha à parte a ATA WSOL que a coleta do PumpSwap já fecha', () => {
  const { scans } = setup({ wallets: [50_000_000, 0], ammVault: { 1: 1_000_000 }, wsolAta: { 1: 2_039_280 } });
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  const closes = plan.steps.flatMap((s: Step) => (s.kind === 'tokens' ? s.actions.map((a) => a.account) : []));
  assert.ok(!closes.includes(ataWsol(S[1].address)));
  // sem coleta do PumpSwap, a ATA WSOL vazia continua sendo fechada (aluguel recuperado)
  const sem = setup({ wallets: [50_000_000, 0], wsolAta: { 1: 2_039_280 } });
  const p2 = buildPlan({ scans: sem.scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(p2.steps.some((s) => s.kind === 'tokens' && s.actions.some((a) => a.account === ataWsol(S[1].address))));
});

// ---------- revisão independente de 31/10/2026 (autoclarn-40) ----------

test('revisão: coleta do PumpSwap que não roda (fee sumiu) fecha mesmo assim a ATA WSOL que o plano tirou do passo das contas', async () => {
  const o: Setup = { wallets: [50_000_000, 0], ammVault: { 1: 1_000_000 }, wsolAta: { 1: 2_039_280 } };
  const { state, scans } = setup(o);
  state.chain.lamports.delete(pumpAmmCreatorVaultAta(S[1].address)); // alguém coletou entre a análise e a limpeza
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = state.chain.lamports.get(DEST)!;
  const done = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before);
  assertShownMatchesArrived({ plan, receipt, arrived, chain: state.chain, done } as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(state.chain.lamports.has(ataWsol(S[1].address)), false, 'a ATA foi fechada');
  assert.equal(receipt.toDestination.claims, 0, 'não é coleta');
  assert.equal(receipt.toDestination.closedAccounts, 1, 'é conta fechada');
  assert.equal(receipt.toDestination.claimLamports, 0n);
});

// a fee some entre a medida e a transação real (alguém coletou no meio): a temporária não pode pagar a "fee"
async function feeVanishes(kind: 'curve' | 'amm') {
  const o: Setup = kind === 'curve' ? { wallets: [50_000_000, 5_000_000], curveVault: { 1: 1_000_000 } } : { wallets: [50_000_000, 5_000_000], ammVault: { 1: 1_000_000 } };
  const { state, scans } = setup(o);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  plan.steps = plan.steps.filter((s) => s.kind === 'claim-curve' || s.kind === 'claim-amm');
  const base = chainRpc(state);
  let sims = 0;
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const r = await base.call<T>(method, params);
      // depois da medida (1ª simulação), o cofre é esvaziado por outro
      if (method === 'simulateTransaction' && ++sims === 1) {
        const vault = kind === 'curve' ? pumpCreatorVault(S[1].address) : pumpAmmCreatorVaultAta(S[1].address);
        state.chain.lamports.set(vault, kind === 'curve' ? RENT0 : RENT_TOKEN);
      }
      return r;
    },
  };
  return execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
}

test('revisão: coleta da curva numa temporária com SOL, fee some antes do envio → PARA TUDO (não sai do saldo dela)', async () => {
  await assert.rejects(feeVanishes('curve'), (e: Error) => /perderia/.test(e.message));
});

test('revisão: coleta do PumpSwap numa temporária com SOL, fee some antes do envio → PARA TUDO', async () => {
  await assert.rejects(feeVanishes('amm'), (e: Error) => /perderia/.test(e.message));
});

test('revisão 0.1.7: coleta final que a simulação vê "sem fee" (a fee veio só das varreduras anteriores) aparece e chega', async () => {
  // 5 pools com fee na análise; na hora, só os 2 primeiros (que vão no passo só de varrer) ainda têm. Cofre vazio.
  const { state, scans } = setup({ wallets: [80_000_000, 0] });
  const pools = POOLS.concat(burnerSigner(seed, 310).address).map((pool, k) => ({ pool, quoteAccount: burnerSigner(seed, 400 + k).address, lamports: 300_000n }));
  pools.slice(0, 2).forEach((p) => state.chain.parked.set(p.pool, 300_000));
  scans[1].fees = { bondingVault: pumpCreatorVault(S[1].address), bondingVaultLamports: 0, ammVaultAta: pumpAmmCreatorVaultAta(S[1].address), ammVaultLamports: 0, curveSweeps: [], poolSweeps: pools, unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 5, detailed: true, unsweptError: null };
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  assert.ok(sims.some((x) => x.step.kind === 'claim-amm' && !x.step.sweepOnly && (x.status === 'nada a fazer' || x.skippedClaim)), 'a simulação da coleta final não vê fee');
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = state.chain.lamports.get(DEST)!;
  const done = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before);
  assertShownMatchesArrived({ plan, receipt, arrived, chain: state.chain, done } as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(receipt.toDestination.claimLamports, 600_000n, 'as duas fees varridas');
  assert.equal(receipt.toDestination.claims, 1);
});

// ---------- creator fee dividida (fee sharing, 0.1.8) ----------
// A moeda passa a ter como criador o sharing config; a distribuição paga cada participante na proporção dele. A
// parte da temporária vai ao destino na mesma transação; a dos outros vai para eles (é deles).

type Holder = { address: string; bps: number };
function sharingData(mint: string, holders: Holder[], active = true): Buffer {
  const b = Buffer.alloc(80 + 34 * holders.length);
  Buffer.from('d84a0900388c5d4b', 'hex').copy(b, 0);
  b[9] = 2;
  b[10] = active ? 1 : 0;
  Buffer.from(decodeBase58(mint)).copy(b, 11);
  Buffer.from(decodeBase58(holders[0].address)).copy(b, 43); // admin
  b.writeUInt32LE(holders.length, 76);
  holders.forEach((h, i) => {
    Buffer.from(decodeBase58(h.address)).copy(b, 80 + 34 * i);
    b.writeUInt16LE(h.bps, 112 + 34 * i);
  });
  return b;
}

// põe na rede uma divisão da moeda MINTS[k] e devolve o SharedFee que a análise teria lido para `wallet`
function addSharing(chain: Chain, k: number, wallet: string, holders: Holder[], amounts: { vault?: number; curve?: number; amm?: number; pool?: number }) {
  const mint = MINTS[k];
  const config = sharingConfigAddress(mint);
  chain.data ??= new Map();
  chain.sharing ??= new Map();
  chain.data.set(config, sharingData(mint, holders));
  chain.lamports.set(config, 10_000_000);
  chain.sharing.set(config, holders);
  chain.lamports.set(pumpCreatorVault(config), RENT0 + (amounts.vault ?? 0));
  if (amounts.curve) chain.parked.set(curveOf(mint), amounts.curve);
  if (amounts.amm !== undefined) {
    chain.lamports.set(pumpAmmCreatorVaultAta(config), RENT_TOKEN + amounts.amm);
    chain.tokenAccounts.add(pumpAmmCreatorVaultAta(config));
  }
  const pool = amounts.pool ? { pool: POOLS[k], quoteAccount: burnerSigner(seed, 450 + k).address, lamports: BigInt(amounts.pool) } : null;
  if (pool) chain.parked.set(pool.pool, amounts.pool!);
  const total = BigInt((amounts.vault ?? 0) + (amounts.curve ?? 0) + (amounts.amm ?? 0) + (amounts.pool ?? 0));
  const bps = holders.find((h) => h.address === wallet)!.bps;
  return { config, mint, bps, curveFee: BigInt(amounts.curve ?? 0), poolSweep: pool, ammVault: amounts.amm !== undefined, totalLamports: total, shareLamports: (total * BigInt(bps)) / 10_000n };
}

async function sharedRound(state: { chain: Chain }, scans: WalletScan[], sg: Map<number, { address: string; sign: (m: Buffer) => Buffer }> = signers) {
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const rpc = chainRpc(state);
  const sims = await execute({ rpc, plan, signers: sg, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = { dest: state.chain.lamports.get(DEST)!, other: state.chain.lamports.get(OTHER) ?? 0 };
  const done = await execute({ rpc, plan, signers: sg, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before.dest);
  return { plan, sims, receipt, done, arrived, chain: state.chain, otherGot: (state.chain.lamports.get(OTHER) ?? 0) - before.other };
}
const feesOnly = (shared: ReturnType<typeof addSharing>[]) =>
  ({ bondingVault: 'x', bondingVaultLamports: 0, ammVaultAta: 'y', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, shared, sharedOther: 0, sharedError: null }) as NonNullable<WalletScan['fees']>;

test('fee dividida: temporária vazia com 60%, outra pessoa com 40%; a parte dela aparece e chega, a do outro vai para ele', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  state.chain.lamports.set(OTHER, 5_000_000);
  const sf = addSharing(state.chain, 0, S[1].address, [{ address: S[1].address, bps: 6000 }, { address: OTHER, bps: 4000 }], { vault: 1_000_000, curve: 500_000 });
  scans[1].fees = feesOnly([sf]);
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(r.receipt.toDestination.claims, 1);
  assert.equal(r.receipt.toDestination.claimLamports, 900_000n, '60% de 1.500.000 (bruto)');
  assert.equal(r.otherGot, 600_000, 'o outro participante recebe os 40% dele');
  assert.equal(r.chain.lamports.get(S[1].address) ?? 0, 0, 'a temporária termina vazia');
});

test('fee dividida de moeda migrada (cofre do PumpSwap + fee parada no pool) com a PAGADORA participando', async () => {
  const { state, scans } = setup({ wallets: [50_000_000] });
  state.chain.lamports.set(OTHER, 5_000_000);
  const sf = addSharing(state.chain, 1, S[0].address, [{ address: OTHER, bps: 5000 }, { address: S[0].address, bps: 5000 }], { amm: 800_000, pool: 200_000 });
  scans[0].fees = feesOnly([sf]);
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(r.receipt.toDestination.claimLamports, 500_000n, '50% de 1.000.000');
  assert.equal(r.otherGot, 500_000);
});

test('fee dividida que a rede recusa (outro participante vazio não pode receber menos que o aluguel): só ela falha, as outras coletas seguem', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0, 0], curveVault: { 2: 1_000_000 } });
  // OTHER não existe (0 SOL) e receberia 300.000 < aluguel mínimo
  const sf = addSharing(state.chain, 2, S[1].address, [{ address: S[1].address, bps: 7000 }, { address: OTHER, bps: 3000 }], { vault: 1_000_000 });
  scans[1].fees = feesOnly([sf]);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  // a coleta da curva da N=2 vem DEPOIS da fee dividida da N=1 (que falha): não pode ser cancelada
  plan.steps.sort((a, b) => Number(a.kind !== 'claim-shared') - Number(b.kind !== 'claim-shared'));
  const sims = await execute({ rpc: chainRpc(state), plan, signers, mode: 'simulate', priority: 'off' });
  const shared = sims.find((x) => x.step.kind === 'claim-shared')!;
  assert.equal(shared.status, 'falhou');
  assert.match(shared.detail ?? '', /InsufficientFundsForRent/);
  const curve = sims.find((x) => x.step.kind === 'claim-curve')!;
  assert.equal(curve.status, 'simulado', 'a coleta da curva de outra carteira não é cancelada');
});

test('fee dividida que mudou depois da análise (a carteira saiu da divisão, ou ela foi pausada): nada a fazer, sem enviar', async () => {
  for (const change of ['saiu', 'pausada'] as const) {
    const { state, scans } = setup({ wallets: [50_000_000, 0] });
    state.chain.lamports.set(OTHER, 5_000_000);
    const sf = addSharing(state.chain, 0, S[1].address, [{ address: S[1].address, bps: 5000 }, { address: OTHER, bps: 5000 }], { vault: 1_000_000 });
    scans[1].fees = feesOnly([sf]);
    const now = change === 'saiu' ? [{ address: OTHER, bps: 10_000 }] : [{ address: S[1].address, bps: 5000 }, { address: OTHER, bps: 5000 }];
    state.chain.data!.set(sf.config, sharingData(sf.mint, now, change !== 'pausada'));
    state.chain.sharing!.set(sf.config, now);
    const r = await sharedRound(state, scans);
    const step = r.done.find((x) => x.step.kind === 'claim-shared')!;
    assert.equal(step.status, 'nada a fazer', change);
    assert.equal(r.otherGot, 0, `${change}: nada foi distribuído`);
  }
});

test('fee dividida: os participantes vão na ordem de AGORA do sharing config (relido na hora), não a da análise', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  state.chain.lamports.set(OTHER, 5_000_000);
  const sf = addSharing(state.chain, 0, S[1].address, [{ address: S[1].address, bps: 5000 }, { address: OTHER, bps: 5000 }], { vault: 2_000_000 });
  scans[1].fees = feesOnly([sf]);
  const now = [{ address: OTHER, bps: 2000 }, { address: S[1].address, bps: 8000 }];
  state.chain.data!.set(sf.config, sharingData(sf.mint, now));
  state.chain.sharing!.set(sf.config, now);
  const r = await sharedRound(state, scans);
  const step = r.done.find((x) => x.step.kind === 'claim-shared')!;
  assert.equal(step.status, 'enviado', step.detail);
  assert.equal(r.otherGot, 400_000);
});

// revisão de segurança (31/10/2026)
test('fee dividida com parte mínima desta carteira (qualquer um cria uma divisão assim): não coleta e não paga a distribuição dos outros', async () => {
  for (const payerShares of [false, true]) {
    const { state, scans } = setup({ wallets: [50_000_000, 0] });
    state.chain.lamports.set(OTHER, 5_000_000);
    const who = payerShares ? S[0].address : S[1].address;
    // a parte (1/10000 de 300 milhões = 30.000) passa do mínimo fixo, mas varrer o pool cria o cofre do PumpSwap
    // do sharing config e a pagadora paga o aluguel dele (1.488.440): não compensa
    const sf = addSharing(state.chain, 0, who, [{ address: who, bps: 1 }, { address: OTHER, bps: 9999 }], { pool: 300_000_000 });
    scans[payerShares ? 0 : 1].fees = feesOnly([sf]);
    const r = await sharedRound(state, scans);
    const step = r.done.find((x) => x.step.kind === 'claim-shared')!;
    assert.equal(step.status, 'nada a fazer', `${payerShares ? 'pagadora' : 'temporária'}: ${step.detail}`);
    assert.match(step.detail ?? '', /não paga a taxa/);
    assert.equal(r.otherGot, 0, 'a distribuição dos outros não foi paga pelo app');
  }
});

test('fee dividida em que o DESTINO (ou a carteira da taxa do app) também participa: a parte dele entra no esperado, sem parar a rodada', async () => {
  for (const other of [DEST, APP_FEE_WALLET]) {
    const { state, scans } = setup({ wallets: [50_000_000, 0] });
    const sf = addSharing(state.chain, 0, S[1].address, [{ address: S[1].address, bps: 7000 }, { address: other, bps: 3000 }], { vault: 1_000_000 });
    scans[1].fees = feesOnly([sf]);
    const r = await sharedRound(state, scans);
    const step = r.done.find((x) => x.step.kind === 'claim-shared')!;
    assert.equal(step.status, 'enviado', `${other === DEST ? 'destino' : 'taxa do app'}: ${step.detail}`);
    assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  }
});

test('fee dividida: saldo do destino que muda no meio por outro motivo (ele NÃO está na divisão) não entra no esperado', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  state.chain.lamports.set(OTHER, 5_000_000);
  const sf = addSharing(state.chain, 0, S[1].address, [{ address: S[1].address, bps: 6000 }, { address: OTHER, bps: 4000 }], { vault: 1_000_000 });
  scans[1].fees = feesOnly([sf]);
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const base = chainRpc(state);
  let probes = 0;
  // na 1ª simulação (a medida), o destino recebe 224.320 de outro lugar (medido na mainnet: a taxa de outra limpeza)
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'simulateTransaction' && ++probes === 1) state.chain.lamports.set(DEST, state.chain.lamports.get(DEST)! + 224_320);
      return base.call<T>(method, params);
    },
  };
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const step = sims.find((x) => x.step.kind === 'claim-shared')!;
  assert.equal(step.status, 'simulado', step.detail);
  assert.equal(step.destinationDelta, 600_000n - appFeeLamports(600_000n, plan.appFee), '60% de 1.000.000, sem a entrada de fora');
});

// ---------- cashback de quem negociou (0.1.8) ----------

const uvaOf = (w: string, program: string) => userVolumeAccumulator(w, program);
function addCashback(chain: Chain, w: string, amounts: { pump?: number; amm?: number }) {
  if (amounts.pump) chain.lamports.set(uvaOf(w, PROGRAMS.pump), RENT0 + amounts.pump);
  if (amounts.amm) {
    chain.lamports.set(uvaOf(w, PROGRAMS.pumpAmm), RENT0);
    const ata = associatedTokenAddress(uvaOf(w, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token);
    chain.lamports.set(ata, RENT_TOKEN + amounts.amm);
    chain.tokenAccounts.add(ata);
  }
  return { pump: BigInt(amounts.pump ?? 0), amm: BigInt(amounts.amm ?? 0) };
}

test('cashback da Pump.fun e do PumpSwap numa temporária vazia: aparece na Confirmar e chega; a temporária termina vazia', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  scans[1].fees = { ...feesOnly([]), cashback: addCashback(state.chain, S[1].address, { pump: 400_000, amm: 300_000 }) };
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.deepEqual(r.plan.steps.filter((x) => x.kind === 'claim-cashback').map((x) => (x as Extract<Step, { kind: 'claim-cashback' }>).venue), ['pump', 'amm']);
  assert.equal(r.receipt.toDestination.claims, 2);
  assert.equal(r.receipt.toDestination.claimLamports, 700_000n);
  assert.equal(r.chain.lamports.get(S[1].address) ?? 0, 0);
});

test('cashback na PAGADORA: aparece e chega', async () => {
  const { state, scans } = setup({ wallets: [50_000_000] });
  scans[0].fees = { ...feesOnly([]), cashback: addCashback(state.chain, S[0].address, { pump: 400_000, amm: 300_000 }) };
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(r.receipt.toDestination.claimLamports, 700_000n);
});

test('cashback do PumpSwap com coleta do PumpSwap na mesma carteira e ATA WSOL antiga: vai junto na coleta, sem contar a ATA duas vezes', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0], ammVault: { 1: 1_000_000 }, wsolAta: { 1: 2_039_280 } });
  scans[1].fees = { ...scans[1].fees!, cashback: addCashback(state.chain, S[1].address, { amm: 300_000 }) };
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(r.plan.steps.filter((x) => x.kind === 'claim-cashback').length, 0, 'sem passo próprio');
  assert.ok(r.plan.steps.some((x) => x.kind === 'claim-amm' && x.cashback), 'vai na coleta do PumpSwap');
  assert.equal(r.receipt.toDestination.claimLamports, 1_300_000n);
  assert.equal(r.receipt.toDestination.closedAccounts, 1, 'a ATA antiga conta uma vez');
  assert.equal(r.receipt.failed.length, 0);
});

test('cashback do PumpSwap sozinho com ATA WSOL antiga: o passo do cashback fecha a ATA, o das contas não fecha de novo', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0], wsolAta: { 1: 2_039_280 } });
  scans[1].fees = { ...feesOnly([]), cashback: addCashback(state.chain, S[1].address, { amm: 300_000 }) };
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.ok(!r.plan.steps.some((x) => x.kind === 'tokens' && x.actions.some((a) => a.account === ataWsol(S[1].address))));
  assert.equal(r.receipt.failed.length, 0);
  assert.equal(r.receipt.toDestination.closedAccounts, 1);
});

test('cashback do PumpSwap que falha (acumulador fechado depois da análise): só ele fica de fora, a coleta seguinte segue', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0, 0], curveVault: { 2: 1_000_000 } });
  scans[1].fees = { ...feesOnly([]), cashback: addCashback(state.chain, S[1].address, { amm: 300_000 }) };
  state.chain.lamports.delete(uvaOf(S[1].address, PROGRAMS.pumpAmm));
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  plan.steps.sort((a, b) => Number(a.kind !== 'claim-cashback') - Number(b.kind !== 'claim-cashback'));
  const sims = await execute({ rpc: chainRpc(state), plan, signers, mode: 'simulate', priority: 'off' });
  assert.equal(sims.find((x) => x.step.kind === 'claim-cashback')!.status, 'falhou');
  assert.equal(sims.find((x) => x.step.kind === 'claim-curve')!.status, 'simulado', 'não cancelada');
});

// ---------- conta de volume (fase 1 multirredes, Task 2, 06/11/2026) ----------
// Fecha a conta de volume que não guarda mais nada, depois do cashback; o destino recebe cashback + aluguel menos 11%
// e a tela mostra o mesmo, ao lamport (spec docs/superpowers/specs/2026-11-06-chaves-e-caminhos-design.md §4.4).

const UVA_LEN = 137; // medido na mainnet em 06/11/2026
const UVA_RENT = Number(rentFor(UVA_LEN, RENT0)); // 1.346.200
function addUva(chain: Chain, w: string, venue: 'pump' | 'amm', o: { cashback?: number; ataCashback?: number } = {}) {
  const uva = uvaOf(w, venue === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm);
  const data = Buffer.alloc(UVA_LEN);
  Buffer.from('56ff700e66359afa', 'hex').copy(data, 0);
  chain.data = new Map(chain.data ?? []);
  chain.data.set(uva, data);
  chain.lamports.set(uva, UVA_RENT + (o.cashback ?? 0));
  if (o.ataCashback !== undefined) {
    const ata = associatedTokenAddress(uva, WSOL_MINT, PROGRAMS.token);
    chain.lamports.set(ata, RENT_TOKEN + o.ataCashback);
    chain.tokenAccounts.add(ata);
  }
}
// lê as contas de volume pela função do app, sobre a rede com estado
async function uvaFees(state: { chain: Chain }, w: string, cashback: { pump: bigint; amm: bigint }) {
  const rpc = chainRpc(state);
  const uva = (await Promise.all((['pump', 'amm'] as const).map((v) => readUva(rpc, w, v, {}, RENT0)))).filter((u): u is UvaState => u !== null);
  return { ...feesOnly([]), cashback, uva };
}
const closes = (r: { done: StepResult[] }) => r.done.filter((x) => x.step.kind === 'close-uva');

test('uva: fecha depois do cashback e mostrado = chegado', async () => {
  // 1) temporária vazia com cashback na Pump.fun e as duas contas fecháveis; a pagadora também tem uma
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  addUva(state.chain, S[1].address, 'pump', { cashback: 400_000 });
  addUva(state.chain, S[1].address, 'amm');
  addUva(state.chain, S[0].address, 'pump');
  scans[1].fees = await uvaFees(state, S[1].address, { pump: 400_000n, amm: 0n });
  scans[0].fees = await uvaFees(state, S[0].address, { pump: 0n, amm: 0n });
  assert.ok(scans[1].fees.uva!.every((u) => u.closable));
  const r = await sharedRound(state, scans);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.deepEqual(r.plan.steps.filter((x) => x.walletIndex === 1).map((x) => x.kind), ['close-uva', 'close-uva', 'sweep-sol'], 'o cashback da Pump.fun vai no passo que fecha');
  const gross = [UVA_RENT + 400_000, UVA_RENT, UVA_RENT];
  const net = gross.reduce((a, g) => a + BigInt(g) - appFeeLamports(BigInt(g), appFeeFor(DEST)), 0n);
  assert.equal(closes(r).reduce((a, x) => a + (x.destinationDelta ?? 0n), 0n), net, 'destino: cashback + aluguel menos 11%');
  assert.equal(r.receipt.toDestination.claimLamports, 400_000n, 'o cashback na linha das coletas');
  assert.equal(r.receipt.toDestination.claims, 1);
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(3 * UVA_RENT), 'o aluguel das 3 em "contas fechadas"');
  assert.equal(r.receipt.toDestination.closedAccounts, 3);
  for (const w of [S[0], S[1]]) for (const p of [PROGRAMS.pump, PROGRAMS.pumpAmm]) assert.ok(!r.chain.lamports.has(uvaOf(w.address, p)), 'fechada');
  assert.equal(r.chain.lamports.get(S[1].address) ?? 0, 0, 'a temporária termina vazia');

  // 2) cashback pequeno demais para uma coleta sozinho (o plano pularia): vai junto com o fechamento
  const small = setup({ wallets: [50_000_000, 0] });
  addUva(small.state.chain, S[1].address, 'pump', { cashback: 10_000 });
  const fees = await uvaFees(small.state, S[1].address, { pump: 10_000n, amm: 0n });
  const alone = buildPlan({ scans: [small.scans[0], { ...small.scans[1], fees: { ...fees, uva: fees.uva.map((u) => ({ ...u, closable: false, why: 'token-account' as const })) } }], prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.ok(!alone.steps.some((x) => x.kind === 'claim-cashback'), 'sozinho, não compensa coletar');
  small.scans[1].fees = fees;
  const rs = await sharedRound(small.state, small.scans);
  assertShownMatchesArrived(rs as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.equal(rs.receipt.toDestination.claimLamports, 10_000n);
  assert.equal(rs.receipt.toDestination.closedRentLamports, BigInt(UVA_RENT));
  assert.ok(!rs.chain.lamports.has(uvaOf(S[1].address, PROGRAMS.pump)));

  // 3) conta de volume com conta de token (a ATA WSOL do cashback do PumpSwap): não fecha, e nada some
  const kept = setup({ wallets: [50_000_000, 0] });
  addUva(kept.state.chain, S[1].address, 'amm', { ataCashback: 300_000 });
  kept.scans[1].fees = await uvaFees(kept.state, S[1].address, { pump: 0n, amm: 300_000n });
  assert.deepEqual(kept.scans[1].fees.uva.map((u) => [u.closable, u.why]), [[false, 'token-account']]);
  const rk = await sharedRound(kept.state, kept.scans);
  assertShownMatchesArrived(rk as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.ok(!rk.plan.steps.some((x) => x.kind === 'close-uva'));
  assert.equal(rk.chain.lamports.get(uvaOf(S[1].address, PROGRAMS.pumpAmm)), UVA_RENT, 'a conta de volume continua com o aluguel dela');
  assert.equal(rk.chain.lamports.get(associatedTokenAddress(uvaOf(S[1].address, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token)), RENT_TOKEN, 'a ATA dela fica (o cashback saiu pela coleta)');
  assert.equal(rk.receipt.toDestination.claimLamports, 300_000n);
});

test('uva: conta que mudou depois da análise não fecha (relida na hora); recusa do programa só deixa ela aberta', async () => {
  // ganhou uma conta de token entre a análise e a execução
  const a = setup({ wallets: [50_000_000, 0] });
  addUva(a.state.chain, S[1].address, 'amm');
  a.scans[1].fees = await uvaFees(a.state, S[1].address, { pump: 0n, amm: 0n });
  a.state.chain.tokenAccounts.add(associatedTokenAddress(uvaOf(S[1].address, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token));
  a.state.chain.lamports.set(associatedTokenAddress(uvaOf(S[1].address, PROGRAMS.pumpAmm), WSOL_MINT, PROGRAMS.token), RENT_TOKEN);
  const ra = await sharedRound(a.state, a.scans);
  assert.equal(closes(ra)[0].status, 'nada a fazer');
  assert.ok(ra.chain.lamports.has(uvaOf(S[1].address, PROGRAMS.pumpAmm)), 'fica aberta');
  // o programa recusa o fechamento: só este passo falha (aviso no recibo); a coleta de outra carteira segue
  const b = setup({ wallets: [50_000_000, 0, 0], curveVault: { 2: 1_000_000 } });
  addUva(b.state.chain, S[1].address, 'pump', { cashback: 400_000 });
  b.scans[1].fees = await uvaFees(b.state, S[1].address, { pump: 400_000n, amm: 0n });
  b.state.chain.refuseClose = new Set([uvaOf(S[1].address, PROGRAMS.pump)]);
  const plan = buildPlan({ scans: b.scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  plan.steps.sort((x, y) => Number(x.kind !== 'close-uva') - Number(y.kind !== 'close-uva'));
  const sims = await execute({ rpc: chainRpc(b.state), plan, signers, mode: 'simulate', priority: 'off' });
  assert.equal(sims.find((x) => x.step.kind === 'close-uva')!.status, 'falhou');
  assert.equal(sims.find((x) => x.step.kind === 'claim-curve')!.status, 'simulado', 'não cancelada');
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  assert.equal(receipt.failed.length, 1, 'aviso no recibo');
});

// Revisão independente de 08/11/2026: o plano não monta passo de cashback para a conta de volume da Pump.fun que fecha
// (vai junto no fechamento). Se o fechamento não entra na hora, o cashback tem que sair mesmo assim, num passo próprio,
// na simulação e na execução, e contado uma vez só (spec §4.4: falha ao fechar não derruba a coleta).
type UvaTwist = 'read-failed' | 'holds-now' | 'refused' | 'refused-on-sim' | 'refused-on-send';
async function cashbackStuck(twist: UvaTwist, who: 0 | 1) {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  const w = S[who].address;
  const uva = uvaOf(w, PROGRAMS.pump);
  addUva(state.chain, w, 'pump', { cashback: 400_000 });
  scans[who].fees = await uvaFees(state, w, { pump: 400_000n, amm: 0n });
  assert.ok(scans[who].fees!.uva!.every((u) => u.closable), 'na análise: fechável');
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  assert.deepEqual(plan.steps.filter((x) => x.walletIndex === who && x.kind !== 'sweep-sol').map((x) => x.kind), ['close-uva'], 'sem passo de cashback à parte');
  plan.appFee = appFeeFor(DEST);
  // depois da análise
  const data = Buffer.from(state.chain.data!.get(uva)!);
  if (twist === 'read-failed') data.write('0000000000000000', 0, 'hex'); // dado fora do formato: "não sei" nunca fecha
  if (twist === 'holds-now') data[40] = 1; // needs_claim: ganhou incentivo a coletar
  state.chain.data = new Map(state.chain.data).set(uva, data);
  if (twist === 'refused') state.chain.refuseClose = new Set([uva]);
  let rpc = chainRpc(state);
  if (twist === 'refused-on-sim') {
    // a medida passa e a simulação da transação final (a que leva ao destino) é recusada
    const inner = rpc;
    rpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'simulateTransaction') {
          const { ixs } = decode(params[0] as string);
          if (ixs.some((x) => hex(x.data) === CLOSE_UVA) && ixs.some((x) => x.program === PROGRAMS.system && x.accounts[1] === DEST)) {
            return { value: { err: { InstructionError: [1, { Custom: 6000 }] }, logs: ['Program log: Error: recusado'], accounts: null } } as T;
          }
        }
        return inner.call<T>(method, params);
      },
    };
  }
  if (twist === 'refused-on-send') {
    // a simulação passa e a rede recusa a transação enviada (nada muda): o cashback ainda vai à parte
    const inner = rpc;
    let refusedOnce = false;
    let lastRefused = false;
    rpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === 'sendTransaction') {
          lastRefused = !refusedOnce && decode(params[0] as string).ixs.some((x) => hex(x.data) === CLOSE_UVA);
          if (lastRefused) {
            refusedOnce = true;
            return 'sig' as T;
          }
        }
        if (method === 'getSignatureStatuses' && lastRefused) return { value: [{ err: { InstructionError: [1, { Custom: 6000 }] }, confirmationStatus: 'confirmed' }] } as T;
        return inner.call<T>(method, params);
      },
    };
  }
  const sims = await execute({ rpc, plan, signers, mode: 'simulate', priority: 'off' });
  const receipt = buildReceipt({ plan, simResults: sims, holdings: [], main: DEST });
  const before = state.chain.lamports.get(DEST)!;
  const done = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  const arrived = BigInt(state.chain.lamports.get(DEST)! - before);
  return { sims, receipt, done, arrived, chain: state.chain, uva, plan };
}

for (const twist of ['read-failed', 'holds-now', 'refused', 'refused-on-sim', 'refused-on-send'] as const) {
  for (const who of [1, 0] as const) {
    test(`uva: fechamento que não entra (${twist}, ${who ? 'temporária vazia' : 'pagadora'}) não prende o cashback: chega ao destino, contado uma vez`, async () => {
      const r = await cashbackStuck(twist, who);
      const net = 400_000n - appFeeLamports(400_000n, appFeeFor(DEST));
      const runs = twist === 'refused-on-send' ? [r.done] : [r.sims, r.done];
      for (const res of runs) {
        const mine = res.filter((x) => x.step.walletIndex === who && x.step.kind !== 'sweep-sol');
        assert.deepEqual(mine.map((x) => x.step.kind), ['close-uva', 'claim-cashback'], mine.map((x) => `${x.status}: ${x.detail}`).join(' | '));
        assert.equal(mine[0].status, twist === 'read-failed' || twist === 'holds-now' ? 'nada a fazer' : 'falhou');
        assert.match(mine[0].detail ?? '', /cashback dela é coletado num passo à parte/);
        assert.ok(['simulado', 'enviado'].includes(mine[1].status), `${mine[1].status}: ${mine[1].detail}`);
        assert.equal(mine[1].destinationDelta, net, 'o cashback desta carteira (menos 11%) ao destino');
        assert.equal(mine[0].destinationDelta ?? 0n, 0n, 'o passo que não fechou não leva nada');
      }
      // a conta de volume fica aberta só com o aluguel: o cashback saiu
      assert.equal(r.chain.lamports.get(r.uva), UVA_RENT);
      if (twist !== 'refused-on-send') {
        // Confirmar = chegou; o cashback numa linha só (sem contar duas vezes) e o aluguel não entra em "contas fechadas"
        const slack = BigInt(r.done.length + 1);
        const diff = r.receipt.totalLamports - r.arrived;
        assert.ok(diff >= -slack && diff <= slack, `mostrou ${r.receipt.totalLamports}, chegou ${r.arrived}`);
        assert.equal(r.receipt.toDestination.claimLamports, 400_000n);
        assert.equal(r.receipt.toDestination.claims, 1);
        assert.equal(r.receipt.toDestination.closedAccounts, 0);
      }
      const x = buildReceipt({ plan: r.plan, simResults: r.done, holdings: [], main: DEST, executed: true });
      assert.equal(x.totalLamports, r.arrived, 'tela final: total = chegou');
      assert.equal(x.toDestination.claimLamports, 400_000n);
      assert.equal(x.failed.length, twist === 'read-failed' || twist === 'holds-now' ? 0 : 1, 'recusa vira aviso no recibo');
    });
  }
}

test('uva: conta de volume sem cashback que não fecha não monta passo de cashback', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  const uva = uvaOf(S[1].address, PROGRAMS.pump);
  addUva(state.chain, S[1].address, 'pump');
  scans[1].fees = await uvaFees(state, S[1].address, { pump: 0n, amm: 0n });
  const data = Buffer.from(state.chain.data!.get(uva)!);
  data[40] = 1;
  state.chain.data = new Map(state.chain.data).set(uva, data);
  const r = await sharedRound(state, scans);
  assert.deepEqual(r.done.filter((x) => x.step.walletIndex === 1).map((x) => [x.step.kind, x.status]), [['close-uva', 'nada a fazer'], ['sweep-sol', 'nada a fazer']]);
});

test('uva: conta que devolve menos que a taxa da rede não é fechada (temporária e pagadora)', async () => {
  // artificial (uma conta de volume tem pelo menos o aluguel), mas a regra vale: ganho ≤ 2 × taxa base = pular
  const { state, scans } = setup({ wallets: [50_000_000, 0] });
  for (const w of [S[0].address, S[1].address]) addUva(state.chain, w, 'amm');
  for (const w of [S[0].address, S[1].address]) state.chain.lamports.set(uvaOf(w, PROGRAMS.pumpAmm), 2 * BASE_FEE_LAMPORTS);
  scans[0].fees = await uvaFees(state, S[0].address, { pump: 0n, amm: 0n });
  scans[1].fees = await uvaFees(state, S[1].address, { pump: 0n, amm: 0n });
  const r = await sharedRound(state, scans);
  assert.deepEqual(closes(r).map((x) => x.status), ['nada a fazer', 'nada a fazer']);
  assert.match(closes(r)[0].detail ?? '', /não compensa/);
  for (const w of [S[0].address, S[1].address]) assert.equal(r.chain.lamports.get(uvaOf(w, PROGRAMS.pumpAmm)), 2 * BASE_FEE_LAMPORTS, 'fica aberta');
});

// ---------- parada falsa na simulação (print do autor, 01/11/2026) ----------
// "A simulação mostrou um resultado diferente do esperado: a taxa do app receberia 279122 lamports, o esperado era
// 54802", duas vezes seguidas nas mesmas carteiras. A diferença (224 320) era a taxa do PASSO ANTERIOR: o saldo da
// carteira da taxa foi lido num nó que ainda não tinha o passo anterior, e a simulação rodou em outro que já tinha.

// rede com um nó atrasado: leitura sem minContextSlot (ou com um slot antigo) responde o estado de ANTES do último envio
function laggyRpc(state: { chain: Chain }, extra: { inflowOnce?: number; alwaysExtraFee?: number } = {}) {
  const inner = chainRpc(state);
  let slot = 0;
  let stale: Chain | null = null;
  let sims = 0;
  const copy = (c: Chain): Chain => ({ ...c, lamports: new Map(c.lamports), tokenAccounts: new Set(c.tokenAccounts), parked: new Map(c.parked) });
  const rpc: RpcClient & { sims: () => number } = {
    sims: () => sims,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method === 'sendTransaction') {
        const before = copy(state.chain);
        const r = await inner.call<T>(method, params);
        stale = before;
        slot++;
        return r;
      }
      if (method === 'getSignatureStatuses') return { value: [{ err: null, confirmationStatus: 'confirmed', slot }] } as T;
      if (method === 'getMultipleAccounts' && stale && ((params[1] as { minContextSlot?: number })?.minContextSlot ?? 0) < slot) {
        const now = state.chain;
        state.chain = stale;
        try {
          return await inner.call<T>(method, params);
        } finally {
          state.chain = now;
        }
      }
      if (method === 'simulateTransaction') {
        sims++;
        // outra limpeza paga a mesma carteira da taxa no meio (uma vez): entra na rede de verdade
        if (extra.inflowOnce && slot > 0) {
          state.chain.lamports.set(APP_FEE_WALLET, state.chain.lamports.get(APP_FEE_WALLET)! + extra.inflowOnce);
          extra.inflowOnce = 0;
        }
        const r = await inner.call<{ value: { accounts?: Array<{ lamports: number } | null> } }>(method, params);
        if (extra.alwaysExtraFee) {
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          const i = addrs.indexOf(APP_FEE_WALLET);
          if (i >= 0 && r.value.accounts?.[i]) r.value.accounts[i]!.lamports += extra.alwaysExtraFee;
        }
        return r as T;
      }
      return inner.call<T>(method, params);
    },
  };
  return rpc;
}

async function executeWith(rpc: RpcClient, state: { chain: Chain }, scans: WalletScan[]) {
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
  plan.appFee = appFeeFor(DEST);
  const before = state.chain.lamports.get(DEST)!;
  const done = await execute({ rpc, plan, signers, mode: 'execute', priority: 'off', sleep: async () => {} });
  return { done, arrived: state.chain.lamports.get(DEST)! - before };
}

test('parada falsa: nó atrasado na leitura não faz o passo seguinte ver a taxa do anterior como "a mais"', async () => {
  // duas temporárias com creator fee: a 1ª coleta paga a taxa do app; a 2ª lia a carteira da taxa de antes da 1ª
  const { state, scans } = setup({ wallets: [50_000_000, 0, 0], curveVault: { 1: 2_039_280, 2: 498_200 } });
  const { done } = await executeWith(laggyRpc(state), state, scans);
  assert.ok(done.every((r) => r.status === 'enviado' || r.status === 'nada a fazer'), done.map((r) => `${r.status} ${r.detail ?? ''}`).join(' | '));
  assert.equal(done.filter((r) => r.step.kind === 'claim-curve' && r.status === 'enviado').length, 2, 'as duas coletas saíram na primeira vez');
});

test('parada falsa: taxa de outra limpeza chegando no meio da conferência não para tudo (relê e segue)', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0, 0], curveVault: { 1: 1_000_000, 2: 1_000_000 } });
  const { done } = await executeWith(laggyRpc(state, { inflowOnce: 224_320 }), state, scans);
  assert.ok(done.every((r) => r.status === 'enviado' || r.status === 'nada a fazer'), done.map((r) => `${r.status} ${r.detail ?? ''}`).join(' | '));
});

test('resultado errado de verdade (a taxa do app recebe a mais em toda simulação): continua parando tudo', async () => {
  const { state, scans } = setup({ wallets: [50_000_000, 0], curveVault: { 1: 1_000_000 } });
  const rpc = laggyRpc(state, { alwaysExtraFee: 1 });
  await assert.rejects(executeWith(rpc, state, scans), /taxa do app receberia/);
  assert.ok(rpc.sims() >= 5, `conferiu ${rpc.sims()} vezes antes de parar`);
});

// Print de um tester (01/11/2026): "Execução interrompida por segurança", frase 4 de 4 sem rodar, "a simulação mostrou um
// resultado diferente do esperado para o seu destino". Cada frase é uma execução; o slot do último envio ficava dentro
// dela, e a frase seguinte lia o destino num nó que ainda não tinha o último envio da anterior.
async function twoFrases(slot?: { last: number }) {
  const { state, scans } = setup({ wallets: [50_000_000, 0, 50_000_000, 0], curveVault: { 1: 2_039_280, 3: 2_039_280 } });
  const rpc = laggyRpc(state);
  const planOf = (idx: number[]) => {
    const p = buildPlan({ scans: scans.filter((s) => idx.includes(s.index)), prices: new Map(), destination: DEST, rentExemptZero: RENT0 });
    p.appFee = appFeeFor(DEST);
    return p;
  };
  const run = (idx: number[]) => execute({ rpc, plan: planOf(idx), signers, mode: 'execute', priority: 'off', sleep: async () => {}, ...(slot ? { slot } : {}) });
  const a = await run([0, 1]);
  const b = await run([2, 3]);
  return [...a, ...b];
}

test('parada falsa entre frases: a frase seguinte lê o destino depois do último envio da anterior (slot da rodada)', async () => {
  const done = await twoFrases({ last: 0 });
  assert.ok(done.every((r) => r.status === 'enviado' || r.status === 'nada a fazer'), done.map((r) => `${r.status} ${r.detail ?? ''}`).join(' | '));
  assert.equal(done.filter((r) => r.step.kind === 'claim-curve' && r.status === 'enviado').length, 2);
});

test('parada falsa entre frases: sem o slot dividido, o nó atrasado faz a 2ª frase parar (o defeito que o slot corrige)', async () => {
  await assert.rejects(twoFrases(), /destino/);
});

test('servidor: todo envio da rodada (frases, empréstimo, repasse, juntar) usa o mesmo slot da rodada', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/app/server.ts', import.meta.url), 'utf8');
  const calls = [...src.matchAll(/await execute\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  assert.equal(calls.length, 4, 'as 4 chamadas conhecidas; uma nova precisa entrar aqui');
  for (const c of calls) assert.match(c, /slot: round\.slot,/);
});

test('chaves: simulação = execução (cashback e conta de volume em carteiras de chave colada, taxa de 11%)', async () => {
  // a pagadora e a temporária são chaves coladas, sem frase: o mesmo plano e o mesmo executor, assinados pelas chaves
  const { state, scans } = setup({ wallets: [50_000_000, 0] }, K);
  addUva(state.chain, K[1].address, 'pump', { cashback: 400_000 });
  addUva(state.chain, K[1].address, 'amm');
  addUva(state.chain, K[0].address, 'pump');
  scans[1].fees = await uvaFees(state, K[1].address, { pump: 400_000n, amm: 0n });
  scans[0].fees = await uvaFees(state, K[0].address, { pump: 0n, amm: 0n });
  const fee0 = state.chain.lamports.get(APP_FEE_WALLET)!;
  const r = await sharedRound(state, scans, KEY_SIGNERS);
  assertShownMatchesArrived(r as unknown as Awaited<ReturnType<typeof roundTrip>>);
  assert.ok(r.plan.steps.every((x) => KEY_SIGNERS.get(x.walletIndex)?.address === x.wallet), 'cada passo assinado pela chave da própria carteira');
  const gross = [UVA_RENT + 400_000, UVA_RENT, UVA_RENT];
  const net = gross.reduce((a, g) => a + BigInt(g) - appFeeLamports(BigInt(g), appFeeFor(DEST)), 0n);
  assert.equal(closes(r).reduce((a, x) => a + (x.destinationDelta ?? 0n), 0n), net, 'destino: cashback + aluguel menos 11%');
  assert.equal(r.receipt.toDestination.claimLamports, 400_000n);
  assert.equal(r.receipt.toDestination.closedRentLamports, BigInt(3 * UVA_RENT));
  // a taxa do app que a Confirmar mostra é a que chegou na carteira da taxa
  assert.equal(BigInt(state.chain.lamports.get(APP_FEE_WALLET)! - fee0), r.receipt.appFeeLamports);
  assert.ok(r.receipt.appFeeLamports > 0n);
  for (const k of K) assert.equal(r.chain.lamports.get(k.address) ?? 0, 0, 'as carteiras das chaves terminam vazias');
});
