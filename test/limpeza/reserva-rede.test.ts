// A reserva da pagadora contra uma rede falsa que COBRA de verdade (pedido do autor, 02/11/2026: "certifique-se que
// vai dar tudo certo, com o mínimo de valor possível"). Cada transação paga taxa por assinatura + prioridade (preço ×
// limite que o executor pôs nela), a ATA criada paga aluguel, transferências e fechamentos movem SOL, e a rede recusa
// saldo negativo e conta entre 0 e o aluguel mínimo. A frase é limpa inteira com a pagadora começando com a reserva
// EXATA (sem a folga de 20%), a rede congestionada (prioridade no teto) e transações grandes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, FeePayerError, rentFor, TOKEN_ACCOUNT_BYTES, type TokenDecision } from '../../src/core/limpeza/plan.ts';
import { execute, type StepResult } from '../../src/core/limpeza/executor.ts';
import { parseTokenAccount, type WalletScan } from '../../src/core/limpeza/scan.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { associatedTokenAddress, PROGRAMS } from '../../src/core/solana/pda.ts';
import { pumpClaimCashbackV2 } from '../../src/core/solana/instructions.ts';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';
import { decodeBase58, encodeBase58 } from '../../src/core/solana/base58.ts';
import type { RpcClient } from '../../src/core/solana/rpc.ts';

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const DEST = deriveMainAddress(seed);
const RENT0 = 650_240; // mainnet, 30/10/2026
const BASE_FEE = 5_000n;
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const CASHBACK_DATA = pumpClaimCashbackV2(burnerSigner(seed, 0).address).data.toString('hex');
// conta Token-2022 de moeda da Pump.fun: 165 + extensão ImmutableOwner (o plano reserva o pior caso, 400)
const T22_ATA_BYTES = 170;

type TokenAcc = { owner: string; mint: string; amount: bigint; program: string };

class Ledger {
  lamports = new Map<string, bigint>();
  tokens = new Map<string, TokenAcc>();
  cashback = new Map<string, bigint>(); // o que a Pump.fun paga a cada carteira (só se ela tiver o aluguel mínimo)
  history = new Map<string, bigint[]>(); // saldo de cada carteira depois de cada transação enviada
  clone(): Ledger {
    const c = new Ledger();
    c.lamports = new Map(this.lamports);
    c.tokens = new Map([...this.tokens].map(([k, v]) => [k, { ...v }]));
    c.cashback = new Map(this.cashback);
    return c;
  }
  bal(a: string) {
    return this.lamports.get(a) ?? 0n;
  }
  add(a: string, l: bigint) {
    this.lamports.set(a, this.bal(a) + l);
  }
}

type Parsed = { sigs: number; keys: string[]; signature: string; ixs: Array<{ program: string; accounts: string[]; data: Buffer }> };
function compact(buf: Uint8Array, pos: number): [number, number] {
  let v = 0;
  for (let s = 0; ; s += 7) {
    const b = buf[pos++];
    v |= (b & 0x7f) << s;
    if (!(b & 0x80)) return [v, pos];
  }
}
function parse(raw: Buffer): Parsed {
  let [nSig, pos] = compact(raw, 0);
  const signature = encodeBase58(raw.subarray(pos, pos + 64));
  pos += 64 * nSig;
  const msg = raw.subarray(pos);
  const sigs = msg[0];
  let [nKeys, p] = compact(msg, 3);
  const keys = Array.from({ length: nKeys }, (_, i) => encodeBase58(msg.subarray(p + 32 * i, p + 32 * i + 32)));
  p += 32 * nKeys + 32;
  let nIx;
  [nIx, p] = compact(msg, p);
  const ixs: Parsed['ixs'] = [];
  for (let i = 0; i < nIx; i++) {
    const program = keys[msg[p++]];
    let nAcc;
    [nAcc, p] = compact(msg, p);
    const accounts = [...msg.subarray(p, p + nAcc)].map((k) => keys[k]);
    p += nAcc;
    let nData;
    [nData, p] = compact(msg, p);
    ixs.push({ program, accounts, data: Buffer.from(msg.subarray(p, p + nData)) });
    p += nData;
  }
  return { sigs, keys, signature, ixs };
}

// aplica a transação ao livro; erro = nada muda (a taxa sai mesmo assim, como na rede)
function apply(l: Ledger, tx: Parsed): { err: unknown } {
  let limit = 200_000;
  let price = 0n;
  for (const ix of tx.ixs) {
    if (ix.program !== COMPUTE_BUDGET) continue;
    if (ix.data[0] === 2) limit = ix.data.readUInt32LE(1);
    if (ix.data[0] === 3) price = ix.data.readBigUInt64LE(1);
  }
  const fee = BigInt(tx.sigs) * BASE_FEE + (price * BigInt(limit) + 999_999n) / 1_000_000n;
  const payer = tx.keys[0];
  if (l.bal(payer) < fee) return { err: 'InsufficientFundsForFee' };
  const w = l.clone();
  w.add(payer, -fee);
  const touched = new Set<string>([payer]);
  for (const [i, ix] of tx.ixs.entries()) {
    const fail = (why: string) => ({ err: { InstructionError: [i, why] } });
    if (ix.program === COMPUTE_BUDGET) continue;
    if (ix.program === PROGRAMS.system && ix.data.readUInt32LE(0) === 2) {
      const [from, to] = ix.accounts;
      const v = ix.data.readBigUInt64LE(4);
      if (w.bal(from) < v) return fail('insufficient lamports');
      w.add(from, -v);
      w.add(to, v);
      touched.add(from).add(to);
    } else if (ix.program === PROGRAMS.associatedToken) {
      const [p, ata, owner, mint, , program] = ix.accounts;
      if (w.tokens.has(ata)) continue; // idempotent
      const rent = rentFor(program === PROGRAMS.token2022 ? T22_ATA_BYTES : TOKEN_ACCOUNT_BYTES, RENT0);
      if (w.bal(p) < rent) return fail('insufficient lamports');
      w.add(p, -rent);
      w.add(ata, rent);
      w.tokens.set(ata, { owner, mint, amount: 0n, program });
      touched.add(p);
    } else if (ix.program === PROGRAMS.token || ix.program === PROGRAMS.token2022) {
      const op = ix.data[0];
      if (op === 8) {
        const t = w.tokens.get(ix.accounts[0]);
        const v = ix.data.readBigUInt64LE(1);
        if (!t || t.amount < v) return fail('burn');
        t.amount -= v;
      } else if (op === 12) {
        const [src, , dst] = ix.accounts;
        const a = w.tokens.get(src);
        const b = w.tokens.get(dst);
        const v = ix.data.readBigUInt64LE(1);
        if (!a || !b || a.amount < v) return fail('transfer');
        a.amount -= v;
        b.amount += v;
      } else if (op === 9) {
        const [acc, dst] = ix.accounts;
        const t = w.tokens.get(acc);
        if (!t || t.amount !== 0n) return fail('0xb: conta com saldo não fecha');
        w.add(dst, w.bal(acc));
        w.lamports.delete(acc);
        w.tokens.delete(acc);
        touched.add(dst);
      } else return fail(`token op ${op}`);
    } else if (ix.program === PROGRAMS.pump && ix.data.toString('hex') === CASHBACK_DATA) {
      const user = ix.accounts[0];
      // a Pump.fun não paga a carteira sem o aluguel mínimo (aprendido na mainnet: a coleta roda e não move nada)
      if (w.bal(user) >= BigInt(RENT0)) {
        w.add(user, w.cashback.get(user) ?? 0n);
        w.cashback.set(user, 0n);
      }
      touched.add(user);
    } else return fail(`programa não previsto: ${ix.program}`);
  }
  for (const a of touched) {
    const b = w.bal(a);
    if (b < 0n) return { err: 'negativo' };
    if (!w.tokens.has(a) && b > 0n && b < BigInt(RENT0)) return { err: { InsufficientFundsForRent: a } };
  }
  l.lamports = w.lamports;
  l.tokens = w.tokens;
  l.cashback = w.cashback;
  return { err: null };
}

// failBatches: todo lote com mais de uma conta falha na simulação (uma conta problemática), e o executor refaz conta a
// conta: o pior caso de transações, o que a reserva conta
function ledgerRpc(l: Ledger, unitsConsumed: number, failBatches = false) {
  const done = new Map<string, unknown>();
  const rpc: RpcClient = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      switch (method) {
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'getMultipleAccounts': {
          const parsed = (params[1] as { encoding?: string })?.encoding === 'jsonParsed';
          return {
            value: (params[0] as string[]).map((a) => {
              const t = l.tokens.get(a);
              if (parsed) return t ? { lamports: Number(l.bal(a)), data: { parsed: { info: { tokenAmount: { amount: String(t.amount) } } } } } : null;
              return l.lamports.has(a) ? { lamports: Number(l.bal(a)) } : null;
            }),
          } as T;
        }
        case 'simulateTransaction': {
          const tx = parse(Buffer.from(params[0] as string, 'base64'));
          const sim = l.clone();
          const batch = tx.ixs.filter((ix) => (ix.program === PROGRAMS.token || ix.program === PROGRAMS.token2022) && ix.data[0] === 9).length > 1;
          const { err } = failBatches && batch ? { err: { InstructionError: [0, { Custom: 17 }] } } : apply(sim, tx);
          const addrs = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          return { value: { err, logs: err ? [`Program failed: ${JSON.stringify(err)}`] : [], unitsConsumed, accounts: addrs.map((a) => ({ lamports: Number(sim.bal(a)) })) } } as T;
        }
        case 'sendTransaction': {
          const tx = parse(Buffer.from(params[0] as string, 'base64'));
          if (!done.has(tx.signature)) {
            done.set(tx.signature, apply(l, tx).err);
            for (const [a, b] of l.lamports) l.history.set(a, [...(l.history.get(a) ?? []), b]);
          }
          return tx.signature as T;
        }
        case 'getSignatureStatuses': {
          const sig = (params[0] as string[])[0];
          return { value: [done.has(sig) ? { err: done.get(sig), confirmationStatus: 'confirmed', slot: 1 } : null] } as T;
        }
        case 'getAccountInfo': {
          const a = params[0] as string;
          return { value: l.lamports.has(a) ? { owner: PROGRAMS.system, lamports: Number(l.bal(a)), executable: false } : null } as T;
        }
        case 'getRecentPrioritizationFees':
          return [{ slot: 1, prioritizationFee: 10_000_000 }] as T; // rede congestionada: o executor usa o teto
        case 'getMinimumBalanceForRentExemption':
          return RENT0 as T;
        case 'getBlockHeight':
          return 1 as T;
      }
      throw new Error(`rpc não previsto: ${method}`);
    },
  };
  return rpc;
}

// Frase de 30 temporárias, todas com 0 SOL, como as dos prints: cashback da Pump.fun em todas, 3 contas vazias, 1
// moeda sem valor para queimar, e moedas com valor para enviar ao destino (a mesma Token-2022 em 10 carteiras, 3
// moedas do programa Token só numa carteira cada).
const N = 30;
const MINT_T22 = burnerSigner(seed, 900).address;
const MINT_JUNK = burnerSigner(seed, 901).address;
const MINTS_T = [902, 903, 904].map((i) => burnerSigner(seed, i).address);
const EMPTY_MINT = burnerSigner(seed, 905).address;
let accSeq = 0;
const accAddr = () => burnerSigner(seed, 2_000 + accSeq++).address;

// t22: a moeda das 10 carteiras é Token-2022 (a reserva conta a conta dela no maior tamanho, 400 bytes; a de verdade
// tem 170). Sem ela, a moeda é do programa Token e a reserva não tem essa folga.
function world(t22 = true) {
  const l = new Ledger();
  l.lamports.set(DEST, 5_000_000n);
  l.lamports.set(APP_FEE_WALLET, 5_000_000n);
  const signers = new Map<number, ReturnType<typeof burnerSigner>>();
  const scans: WalletScan[] = [];
  const decisions = new Map<string, TokenDecision>();
  const tokenRent = Number(rentFor(TOKEN_ACCOUNT_BYTES, RENT0));
  for (let i = 0; i < N; i++) {
    const s = burnerSigner(seed, i);
    signers.set(i, s);
    l.cashback.set(s.address, 1_000_000n);
    const accs: Array<{ mint: string; amount: bigint; program: 'token' | 'token-2022'; decision?: TokenDecision }> = [
      { mint: EMPTY_MINT, amount: 0n, program: 'token' },
      { mint: EMPTY_MINT, amount: 0n, program: 'token' },
      { mint: EMPTY_MINT, amount: 0n, program: 'token' },
      { mint: MINT_JUNK, amount: 7_000n, program: 'token', decision: 'burn' },
    ];
    if (i < 10) accs.push({ mint: MINT_T22, amount: 5_000_000n, program: t22 ? 'token-2022' : 'token', decision: 'transfer' });
    if (i >= 10 && i < 13) accs.push({ mint: MINTS_T[i - 10], amount: 9_000n, program: 'token', decision: 'transfer' });
    const tokens = accs.map((a) => {
      const pid = a.program === 'token' ? PROGRAMS.token : PROGRAMS.token2022;
      const addr = accAddr();
      l.lamports.set(addr, BigInt(tokenRent));
      l.tokens.set(addr, { owner: s.address, mint: a.mint, amount: a.amount, program: pid });
      const t = parseTokenAccount({ pubkey: addr, account: { lamports: tokenRent, data: { parsed: { info: { mint: a.mint, state: 'initialized', tokenAmount: { amount: String(a.amount), decimals: 6 } } } } } }, s.address, a.program);
      if (a.decision) decisions.set(addr, a.decision);
      return t;
    });
    scans.push({ index: i, address: s.address, lamports: 0, tokens, errors: [], fees: { bondingVault: 'x', bondingVaultLamports: 0, ammVaultAta: 'y', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, cashback: { pump: 1_000_000n, amm: 0n } } });
  }
  // a ATA do destino nasce na 1ª transferência de cada moeda (o livro a cria; o endereço é o de verdade)
  for (const m of [MINT_T22, ...MINTS_T]) assert.ok(!l.tokens.has(associatedTokenAddress(DEST, m, m === MINT_T22 ? PROGRAMS.token2022 : PROGRAMS.token)));
  return { l, signers, scans, decisions };
}

async function cleanWithDeposit(deposit: (e: FeePayerError) => bigint, o: { t22?: boolean; failBatches?: boolean } = {}) {
  const { l, signers, scans, decisions } = world(o.t22 ?? true);
  let need: FeePayerError | null = null;
  try {
    buildPlan({ scans, prices: new Map(), destination: DEST, decisions, rentExemptZero: RENT0 });
  } catch (e) {
    if (e instanceof FeePayerError) need = e;
    else throw e;
  }
  assert.ok(need, 'todas em 0: pede depósito');
  const amount = deposit(need);
  l.add(need.wallet, amount); // a pessoa manda o valor
  const payerScan = scans.find((s) => s.address === need.wallet)!;
  payerScan.lamports = Number(l.bal(need.wallet));
  const plan = buildPlan({ scans, prices: new Map(), destination: DEST, decisions, rentExemptZero: RENT0 });
  assert.equal(plan.feePayer, need.wallet);
  const results: StepResult[] = await execute({ rpc: ledgerRpc(l, 200_000, o.failBatches), plan, signers, mode: 'execute', sleep: async () => {}, confirmTimeoutMs: 60_000 });
  return { l, need, plan, results, amount };
}

// a frase inteira limpa: nenhum passo falhou (fora os lotes que a rede recusou na simulação e foram refeitos conta a
// conta), nada ficou nas temporárias, a pagadora nunca passou do aluguel mínimo para baixo e terminou vazia.
// Devolve a sobra: o quanto a pagadora ainda tinha acima do aluguel no ponto mais baixo (o que a reserva tinha a mais).
function assertCleaned(l: Ledger, plan: { feePayer: string }, results: StepResult[]): bigint {
  const failed = results.filter((r) => r.status !== 'enviado' && r.status !== 'nada a fazer' && !r.detail?.startsWith('lote falhou na simulação'));
  assert.deepEqual(failed.map((r) => `${r.description}: ${r.detail}`), [], 'nenhum passo falhou');
  const left = [...l.tokens.values()].filter((t) => t.owner !== DEST);
  assert.deepEqual(left, [], 'nenhuma conta de token ficou nas temporárias');
  assert.equal([...l.cashback.values()].reduce((a, b) => a + b, 0n), 0n, 'todo o cashback coletado');
  for (let i = 0; i < N; i++) assert.equal(l.bal(burnerSigner(seed, i).address), 0n, `N=${i} vazia no fim`);
  const hist = l.history.get(plan.feePayer)!;
  assert.equal(hist.at(-1), 0n, 'a pagadora termina vazia');
  const low = hist.slice(0, -1).reduce((a, b) => (b < a ? b : a));
  assert.ok(low >= BigInt(RENT0), `menor saldo da pagadora: ${low}`);
  return low - BigInt(RENT0);
}

test('rede que cobra de verdade: 30 temporárias limpas inteiras com a reserva EXATA, rede congestionada e transações grandes', async () => {
  const { l, plan, results } = await cleanWithDeposit((e) => e.reserveLamports);
  assertCleaned(l, plan, results);
});

test('rede que cobra de verdade, pior caso: todo lote falha e é refeito conta a conta; a reserva EXATA ainda paga tudo, e sobra pouco', async () => {
  const { l, need, plan, results } = await cleanWithDeposit((e) => e.reserveLamports, { t22: false, failBatches: true });
  assert.ok(results.some((r) => r.detail?.startsWith('lote falhou na simulação')), 'os lotes foram refeitos conta a conta');
  const spare = assertCleaned(l, plan, results);
  // A sobra no ponto mais baixo da pagadora (antes do envio final dela) é exatamente o que a reserva conta e esta frase
  // não usou ali: o envio do SOL das 29 temporárias que já estavam vazias ("nada a fazer", 29 × 15 000), o empréstimo
  // do aluguel (já devolvido), a 2ª assinatura que as 6 transações da própria pagadora não têm (cashback + 5 contas) e
  // o envio final dela (que vem depois). Nada além disso: a reserva não pede um lamport a mais que o pior caso.
  assert.equal(spare, 29n * 15_000n + BigInt(RENT0) + 6n * 5_000n + 15_000n, `sobra numa reserva de ${need.reserveLamports}`);
});

test('rede que cobra de verdade: com o pedido inteiro (reserva + 20%) a pagadora termina vazia e o depósito volta ao destino', async () => {
  const { l, results, amount } = await cleanWithDeposit((e) => e.sendLamports);
  assert.equal(results.filter((r) => r.status === 'falhou' || r.status === 'desconhecido').length, 0);
  assert.ok(l.bal(DEST) > 5_000_000n + amount / 2n, 'destino recebeu o recuperado e o que sobrou do depósito');
});

test('rede que cobra de verdade: 1 lamport abaixo da reserva o plano nem monta (pede o que falta)', () => {
  const { scans, decisions } = world();
  let need: FeePayerError | null = null;
  try {
    buildPlan({ scans, prices: new Map(), destination: DEST, decisions, rentExemptZero: RENT0 });
  } catch (e) {
    need = e as FeePayerError;
  }
  const s = scans.find((x) => x.address === need!.wallet)!;
  s.lamports = Number(need!.reserveLamports) - 1;
  assert.throws(() => buildPlan({ scans, prices: new Map(), destination: DEST, decisions, rentExemptZero: RENT0 }), (e: Error) => e instanceof FeePayerError && e.reserveLamports === 1n);
});
