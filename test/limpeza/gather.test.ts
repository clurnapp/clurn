// Juntar o SOL das temporárias de uma frase na pagadora (src/core/limpeza/gather.ts): quem recebe, quem manda,
// quanto, o plano e o passo 'gather' no executor (a remetente paga a própria taxa).
// Regra do aluguel (devnet, 31/10/2026): uma conta fica com 0 SOL ou com pelo menos o aluguel de conta vazia; a rede
// falsa daqui recusa o meio do caminho como a de verdade (InsufficientFundsForRent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATHER_TX_FEE_LAMPORTS, gatherOffer, gatherPlan } from '../../src/core/limpeza/gather.ts';
import { describeStep, FeePayerError, MIN_FUNDING_LAMPORTS } from '../../src/core/limpeza/plan.ts';
import { execute } from '../../src/core/limpeza/executor.ts';
import { burnerSigner, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';
import { PROGRAMS } from '../../src/core/solana/pda.ts';
import type { CreatorFees, WalletScan } from '../../src/core/limpeza/scan.ts';
import type { RpcClient } from '../../src/core/solana/rpc.ts';

const RENT = 890_880; // aluguel de conta vazia (a devnet cobrava 890 880 até 31/10/2026; hoje 650 240, como a mainnet)
const FEE = Number(GATHER_TX_FEE_LAMPORTS); // 50 000: folga da taxa que cada remetente guarda
const ACC = { account: 'T', mint: 'M', program: 'token', amount: 0n, decimals: 0, rentLamports: 2_039_280, kind: 'empty', blockers: [] };
const scan = (index: number, lamports: number, over: Partial<WalletScan> = {}): WalletScan => ({ index, address: `W${index}`, lamports, tokens: [], fees: null, errors: [], ...over });
const withToken = (index: number, lamports: number) => scan(index, lamports, { tokens: [ACC as unknown as WalletScan['tokens'][number]] });
const fees: CreatorFees = { bondingVault: 'V', bondingVaultLamports: 300_000, ammVaultAta: 'A', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 1, pools: 0, detailed: true, unsweptError: null };
const need = (reserve: bigint) => new FeePayerError(MIN_FUNDING_LAMPORTS, 0, 'W0', 'temporária N=0', 'Solflare', reserve);

test('juntar: a mais rica recebe; quem tem excedente acima do aluguel manda só ele; quem não tem mais nada a limpar manda tudo', () => {
  assert.equal(GATHER_TX_FEE_LAMPORTS, 50_000n);
  // N=1 (2 000 000) recebe. Ordem das remetentes: N=0 (1 500 000, com conta de token: só o excedente),
  // N=2 (1 200 000, limpa), N=3 (900 000, limpa). Reserva 3 000 000: faltam 1 000 000.
  const o = gatherOffer([withToken(0, 1_500_000), scan(1, 2_000_000), scan(2, 1_200_000), scan(3, 900_000)], need(3_000_000n), RENT);
  assert.ok(o);
  assert.equal(o.toIndex, 1, 'a mais rica recebe, não a sugerida pelo erro');
  // N=0: excedente 1 500 000 − 50 000 − 890 880 = 559 120 (fica com o aluguel e a conta de token);
  // N=2: excedente 259 120 não basta para os 440 880 que faltam → manda tudo (estimativa 1 150 000) e fica com 0
  assert.deepEqual(o.transfers, [
    { fromIndex: 0, from: 'W0', lamports: 559_120n, all: false },
    { fromIndex: 2, from: 'W2', lamports: 1_150_000n, all: true },
  ]);
  assert.equal(o.lamports, 1_709_120n, 'soma das transferências (a de "tudo" pela estimativa)');
  // o excedente da N=0 sozinho cobre 300 000: manda só o que falta e ninguém mais entra
  const o2 = gatherOffer([withToken(0, 1_500_000), scan(1, 2_000_000), scan(2, 1_200_000)], need(2_300_000n), RENT);
  assert.deepEqual(o2?.transfers, [{ fromIndex: 0, from: 'W0', lamports: 300_000n, all: false }]);
  // com conta de token e sem excedente acima do aluguel: não manda nada (ficaria abaixo do aluguel ou com 0 e a conta aberta)
  assert.equal(gatherOffer([withToken(0, 900_000), scan(1, 950_000)], need(1_000_000n), RENT), null);
  // creator fee para coletar também conta como "ainda tem o que limpar": só o excedente (259 120); a N=2 completa
  // os 140 880 do excedente dela (159 120), sem precisar mandar tudo
  const o3 = gatherOffer([scan(0, 1_200_000, { fees }), scan(1, 2_000_000), scan(2, 1_100_000)], need(2_400_000n), RENT);
  assert.deepEqual(o3?.transfers, [
    { fromIndex: 0, from: 'W0', lamports: 259_120n, all: false },
    { fromIndex: 2, from: 'W2', lamports: 140_880n, all: false },
  ]);
  // a mesma N=0 sem a creator fee e sem excedente que baste mandaria tudo
  const o5 = gatherOffer([scan(0, 1_000_000), scan(1, 2_000_000)], need(2_900_000n), RENT);
  assert.deepEqual(o5?.transfers, [{ fromIndex: 0, from: 'W0', lamports: 950_000n, all: true }]);
  assert.equal(gatherOffer([scan(0, 1_000_000, { fees }), scan(1, 2_000_000)], need(2_900_000n), RENT), null, 'com creator fee: só o excedente, que não basta');
});

test('juntar: nenhuma remetente fica com saldo entre 0 e o aluguel (a rede recusaria)', () => {
  // varredura de casos: o que sobra em cada remetente é 0 (manda tudo) ou cobre o aluguel e a taxa
  const balances = [890_880, 900_000, 940_880, 941_000, 1_000_000, 1_500_000, 2_500_000];
  for (const a of balances) for (const b of balances) for (const reserve of [1_000_000n, 2_000_000n, 3_000_000n, 5_000_000n]) {
    const scans = [scan(0, 2_600_000), scan(1, a), withToken(2, b)];
    const o = gatherOffer(scans, need(reserve), RENT);
    for (const t of o?.transfers ?? []) {
      const before = BigInt(scans.find((s) => s.index === t.fromIndex)!.lamports);
      if (t.all) assert.ok(t.fromIndex !== 2, 'quem tem conta de token nunca manda tudo');
      else assert.ok(before - t.lamports - GATHER_TX_FEE_LAMPORTS >= BigInt(RENT), `N=${t.fromIndex} ficaria com ${before - t.lamports - GATHER_TX_FEE_LAMPORTS}`);
    }
  }
});

test('juntar: com SOL de sobra o alvo é o pedido cheio (0,01 SOL); a mais rica que já cobre ou SOL que não chega → nada', () => {
  // 12 temporárias limpas de 1 000 000: a N=0 recebe, 10 mandam tudo (9 500 000 estimado ≥ 9 000 000 que faltam)
  const many = Array.from({ length: 12 }, (_, i) => scan(i, 1_000_000));
  const o = gatherOffer(many, need(1_070_880n), RENT);
  assert.equal(o?.toIndex, 0);
  assert.equal(o?.transfers.length, 10);
  assert.ok(o?.transfers.every((t) => t.all && t.lamports === 950_000n));
  assert.equal(o?.lamports, 9_500_000n);
  // a mais rica já cobre a reserva: o plano monta sem juntar
  assert.equal(gatherOffer([scan(0, 100), scan(5, 3_500_000)], need(3_000_000n), RENT), null);
  // juntando tudo não chega na reserva: fica o depósito
  assert.equal(gatherOffer([scan(0, 900_000), scan(1, 900_000)], need(3_000_000n), RENT), null);
  assert.equal(gatherOffer([], need(1_000_000n), RENT), null);
  assert.equal(gatherOffer([scan(0, 0), scan(1, 0)], need(1_000_000n), RENT), null);
});

test('juntar: leitura com erro, dado fora do formato e a principal (exclude) não recebem nem mandam', () => {
  const o = gatherOffer([scan(0, 1_500_000), scan(1, 2_000_000), scan(3, 9_000_000, { errors: ['leitura falhou'] }), scan(4, 2_100_000)], need(2_300_000n), RENT);
  assert.equal(o?.toIndex, 4, 'a de 9 000 000 tem erro de leitura: não recebe');
  assert.deepEqual(o?.transfers, [{ fromIndex: 1, from: 'W1', lamports: 200_000n, all: false }]);
  // saldo NaN, Infinity, negativo ou texto conta como 0
  const dirty = [scan(1, 2_000_000), scan(5, Number.NaN), scan(6, Number.POSITIVE_INFINITY), scan(7, -5), { ...scan(8, 0), lamports: '9000000' as unknown as number }, scan(4, 2_100_000)];
  assert.deepEqual(gatherOffer(dirty, need(2_300_000n), RENT)?.transfers, [{ fromIndex: 1, from: 'W1', lamports: 200_000n, all: false }]);
  // a principal nunca entra, nem como a mais rica
  const o2 = gatherOffer([scan(0, 1_500_000), scan(1, 2_000_000), scan(9, 5_000_000, { address: 'MAIN' })], need(2_300_000n), RENT, ['MAIN']);
  assert.equal(o2?.toIndex, 1);
  assert.ok(o2?.transfers.every((t) => t.from !== 'MAIN'));
});

test('juntar: plano só de juntar, destino = a pagadora, sem taxa do app; descrição diz valor ou "todo o SOL"', () => {
  const o = gatherOffer([withToken(0, 1_500_000), scan(1, 2_000_000), scan(2, 1_200_000), scan(3, 900_000)], need(3_000_000n), RENT)!;
  const p = gatherPlan(o);
  assert.equal(p.destination, 'W1');
  assert.equal(p.feePayer, 'W1');
  assert.equal(p.feePayerIndex, 1);
  assert.equal(p.appFee, null);
  assert.equal(p.reserveNeededLamports, 0n);
  assert.equal(p.steps.length, 2);
  const [a, b] = p.steps;
  if (a?.kind !== 'gather' || b?.kind !== 'gather') throw new Error('kind');
  assert.deepEqual([a.walletIndex, a.wallet, a.to, a.lamports, a.all], [0, 'W0', 'W1', 559_120n, false]);
  assert.deepEqual([b.walletIndex, b.lamports, b.all], [2, 1_150_000n, true]);
  assert.equal(describeStep(a), 'N=0: juntar 0.00055912 SOL na pagadora desta frase para as taxas (volta ao destino no fim)');
  assert.equal(describeStep(b), 'N=2: juntar todo o SOL (~0.00115 SOL) na pagadora desta frase para as taxas (volta ao destino no fim)');
});

// ---------- executor ----------

const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const SG = [0, 1, 2, 3].map((n) => burnerSigner(seed, n));
const signers = new Map(SG.map((s, i) => [i, s]));

// transação legada: o primeiro endereço é quem paga a taxa; transferências do System Program (instrução 2)
function decodeTx(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  const msg = raw.subarray(1 + 64 * raw[0]);
  const nKeys = msg[3];
  const names = Array.from({ length: nKeys }, (_, i) => encodeBase58(msg.subarray(4 + 32 * i, 36 + 32 * i)));
  let pos = 4 + 32 * nKeys + 32;
  const transfers: Array<{ from: string; to: string; lamports: bigint }> = [];
  const nIx = msg[pos++];
  for (let i = 0; i < nIx; i++) {
    const program = names[msg[pos++]];
    const accounts = [...msg.subarray(pos + 1, pos + 1 + msg[pos])].map((k) => names[k]);
    pos += 1 + msg[pos];
    const data = Buffer.from(msg.subarray(pos + 1, pos + 1 + msg[pos]));
    pos += 1 + msg[pos];
    if (program === PROGRAMS.system && data.length === 12 && data.readUInt32LE(0) === 2) transfers.push({ from: accounts[0], to: accounts[1], lamports: data.readBigUInt64LE(4) });
  }
  return { signatures: raw[0], payer: names[0], names, transfers };
}

// rede falsa: saldos fixos; a simulação aplica as transferências e a taxa (5 000 por assinatura, do pagador) e, como
// a de verdade, recusa conta que perde SOL e fica entre 0 e o aluguel
function fakeRpc(lamports: Map<string, number>, log: Array<ReturnType<typeof decodeTx>>, tamper = 0n): RpcClient {
  return {
    call: async <T>(method: string, params: unknown[]): Promise<T> => {
      switch (method) {
        case 'getMultipleAccounts':
          return { value: (params[0] as string[]).map((a) => (lamports.has(a) ? { lamports: lamports.get(a) } : null)) } as T;
        case 'getMinimumBalanceForRentExemption':
          return RENT as T;
        case 'getLatestBlockhash':
          return { value: { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 } } as T;
        case 'simulateTransaction': {
          const d = decodeTx(params[0] as string);
          log.push(d);
          const delta = new Map<string, bigint>();
          for (const t of d.transfers) {
            delta.set(t.from, (delta.get(t.from) ?? 0n) - t.lamports);
            delta.set(t.to, (delta.get(t.to) ?? 0n) + t.lamports);
          }
          delta.set(d.payer, (delta.get(d.payer) ?? 0n) - 5_000n * BigInt(d.signatures));
          for (const [a, dl] of delta) {
            const post = BigInt(lamports.get(a) ?? 0) + dl;
            if (dl < 0n && (post < 0n || (post > 0n && post < BigInt(RENT)))) return { value: { err: { InsufficientFundsForRent: { account_index: d.names.indexOf(a) } }, logs: ['insufficient funds for rent'], accounts: null } } as T;
          }
          const watched = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
          const accounts = watched.map((a, i) => ({ lamports: Number(BigInt(lamports.get(a) ?? 0) + (delta.get(a) ?? 0n) + (a === d.payer ? 5_000n * BigInt(d.signatures) : 0n) + (i === 0 ? tamper : 0n)) }));
          return { value: { err: null, logs: [], unitsConsumed: 300, accounts } } as T;
        }
        default:
          throw new Error(`${method}: sem handler no teste`);
      }
    },
  };
}

const realScans = (balances: number[], tokenAt: number[] = []): WalletScan[] =>
  balances.map((l, i) => ({ index: i, address: SG[i].address, lamports: l, tokens: tokenAt.includes(i) ? [ACC as unknown as WalletScan['tokens'][number]] : [], fees: null, errors: [] }));
const balancesOf = (b: number[]) => new Map(SG.map((s, i) => [s.address, b[i] ?? 0]));

test('juntar no executor: excedente — a remetente assina, paga a taxa e fica com o aluguel; o valor exato chega na pagadora', async () => {
  // N=1 recebe; N=0 (com conta de token) manda 300 000 do excedente e fica com 1 195 000
  const b = [1_500_000, 2_000_000, 0, 0];
  const o = gatherOffer(realScans(b, [0]), need(2_300_000n), RENT)!;
  assert.deepEqual(o.transfers.map((t) => [t.fromIndex, t.lamports, t.all]), [[0, 300_000n, false]]);
  const log: Array<ReturnType<typeof decodeTx>> = [];
  const r = await execute({ rpc: fakeRpc(balancesOf(b), log), plan: gatherPlan(o), signers, mode: 'simulate', priority: 'off' });
  assert.equal(r.length, 1);
  assert.equal(r[0].status, 'simulado');
  assert.equal(r[0].destinationDelta, 300_000n);
  assert.equal(log[0].payer, SG[0].address, 'a remetente paga a taxa, não a pagadora do plano');
  assert.equal(log[0].signatures, 1, 'só a remetente assina');
  assert.deepEqual(log[0].transfers, [{ from: SG[0].address, to: SG[1].address, lamports: 300_000n }]);
});

test('juntar no executor: "tudo" — o valor sai na hora (saldo − taxa real) e a remetente fica com 0', async () => {
  const b = [900_000, 2_000_000, 1_200_000, 0];
  const o = gatherOffer(realScans(b), need(3_000_000n), RENT)!;
  assert.deepEqual(o.transfers.map((t) => [t.fromIndex, t.lamports, t.all]), [[2, 1_150_000n, true]]);
  const log: Array<ReturnType<typeof decodeTx>> = [];
  const r = await execute({ rpc: fakeRpc(balancesOf(b), log), plan: gatherPlan(o), signers, mode: 'simulate', priority: 'off' });
  assert.equal(r[0].status, 'simulado', r[0].detail);
  assert.equal(r[0].destinationDelta, 1_195_000n, '1 200 000 − 5 000 de taxa: mais que a estimativa');
  assert.deepEqual(log[0].transfers, [{ from: SG[2].address, to: SG[1].address, lamports: 1_195_000n }]);
});

test('juntar no executor: saldo que mudou — abaixo do aluguel ou sem o SOL é "nada a fazer" (nunca uma transação que a rede recusa)', async () => {
  const o = gatherOffer(realScans([1_500_000, 2_000_000, 0, 0], [0]), need(2_300_000n), RENT)!;
  // a N=0 caiu para 1 190 000: mandando 300 000 ficaria com 885 000, abaixo do aluguel
  const r = await execute({ rpc: fakeRpc(balancesOf([1_190_000, 2_000_000]), []), plan: gatherPlan(o), signers, mode: 'simulate', priority: 'off' });
  assert.equal(r[0].status, 'nada a fazer');
  assert.match(r[0].detail ?? '', /abaixo do aluguel mínimo/);
  const r2 = await execute({ rpc: fakeRpc(balancesOf([200_000, 2_000_000]), []), plan: gatherPlan(o), signers, mode: 'simulate', priority: 'off' });
  assert.match(r2[0].detail ?? '', /não tem mais esse SOL/);
  // "tudo" sem saldo que pague a taxa
  const all = gatherOffer(realScans([900_000, 2_000_000, 1_200_000]), need(3_000_000n), RENT)!;
  const r3 = await execute({ rpc: fakeRpc(balancesOf([900_000, 2_000_000, 4_000]), []), plan: gatherPlan(all), signers, mode: 'simulate', priority: 'off' });
  assert.match(r3[0].detail ?? '', /não tem mais SOL/);
  // a rede entrega 1 lamport a mais na pagadora: resultado inesperado → parado
  await assert.rejects(execute({ rpc: fakeRpc(balancesOf([1_500_000, 2_000_000]), [], 1n), plan: gatherPlan(o), signers, mode: 'simulate', priority: 'off' }), /inesperado/);
});

// um plano montado à mão com o passo torto é recusado antes de qualquer leitura da rede
test('juntar no executor: recusa passo gather cujo destino não é o do plano ou que manda para si mesma', async () => {
  const rpc = { call: async () => { throw new Error('a rede não deveria ser consultada'); } };
  const good = gatherPlan(gatherOffer(realScans([1_500_000, 2_000_000], [0]), need(2_300_000n), RENT)!);
  const wrongTo = { ...good, destination: SG[3].address, feePayerIndex: 3, feePayer: SG[3].address };
  await assert.rejects(execute({ rpc, plan: wrongTo, signers, mode: 'simulate', priority: 'off' }), /destino da junção não confere/);
  const self = { ...good, steps: [{ ...good.steps[0]!, walletIndex: 1, wallet: SG[1].address }] };
  await assert.rejects(execute({ rpc, plan: self as typeof good, signers, mode: 'simulate', priority: 'off' }), /não junta SOL nela mesma/);
});

// o terminal não junta (é o app de desktop que tem o botão): diz quanto, de quem e para quem; Phantom nunca
test('juntar: dica do terminal diz valor, remetentes e pagadora com os nomes da carteira; sem oferta ou na Phantom, nada', async () => {
  const { gatherHint } = await import('../../src/cli/limpar.ts');
  const L = (i: number) => `Conta ${i + 1}`;
  const scans = [withToken(0, 1_500_000), scan(1, 2_000_000), scan(2, 1_200_000), scan(3, 900_000)];
  const lines = gatherHint(scans, need(3_000_000n), RENT, L);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /0,001709 SOL de 2 temporárias \(Conta 1, Conta 3\) cobririam a Conta 2/);
  assert.match(lines[1], /app de desktop/);
  assert.deepEqual(gatherHint([scan(0, 100), scan(1, 100)], need(3_000_000n), RENT, L), []);
  assert.deepEqual(gatherHint(scans, need(3_000_000n), RENT, L, 'phantom'), [], 'Phantom: as contas protegidas ficariam no meio');
});

