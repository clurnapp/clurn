// Confere na mainnet, SEM enviar nada e sem frase, o fechamento da conta de volume (UserVolumeAccumulator) da Pump.fun
// e do PumpSwap: acha contas de volume públicas, aplica a regra do app (scan.ts readUva: só fecha a que não guarda
// mais nada) e, nas fecháveis, roda o app inteiro (plano, executor em simulação com assinaturas falsas e
// sigVerify desligado, recibo): [coleta do cashback, se houver] + fechar, e o ganho vai ao destino (89/11).
//
//   node scripts/conferir-fechar-uva.ts [contas=10] [transacoes=30]
//
// Esperado: as fecháveis simulam sem erro, e o que a Confirmar mostra (aluguel + cashback, bruto) = os lamports da
// conta lidos antes. Se o programa recusar algum fechamento, o roteiro diz qual e por quê (o app para nesse passo).
// Busca: getProgramAccounts no discriminador da conta (56ff700e66359afa) + 2 bytes sorteados do `user` (offset 8),
// para não baixar milhões de contas. RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa.

import { randomBytes } from 'node:crypto';
import { buildReceipt } from '../src/app/receipt.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { cashbackOf, readUva, type UvaState, type UvaVenue, type VolumeContext, type WalletScan } from '../src/core/limpeza/scan.ts';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import type { Signer } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const WANT = nums[0] ?? 10;
const TXS = nums[1] ?? 30;
const UVA_DISC = encodeBase58(Buffer.from('56ff700e66359afa', 'hex'));
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
const fakeSigner = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });
type Acc = { data?: [string, string]; lamports?: number; owner?: string } | null;

async function accounts(keys: string[]): Promise<Map<string, NonNullable<Acc>>> {
  const out = new Map<string, NonNullable<Acc>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' }]);
    chunk.forEach((k, j) => r.value[j] && out.set(k, r.value[j]!));
  }
  return out;
}

// pagadora da simulação: carteira comum com SOL que assinou transações recentes da Pump.fun (nada é enviado)
async function richPayer(exclude: Set<string>): Promise<string> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [PROGRAMS.pump, { limit: TXS }]);
  const payers = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc.call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
    const k = tx?.transaction?.message?.accountKeys?.[0];
    if (k && !exclude.has(k)) payers.add(k);
  }
  const info = await accounts([...payers]);
  const rich = [...info].filter(([, a]) => a.owner === PROGRAMS.system && (a.lamports ?? 0) > 200_000_000).sort((x, y) => (y[1].lamports ?? 0) - (x[1].lamports ?? 0));
  if (!rich.length) throw new Error('sem carteira com SOL para pagadora');
  return rich[0][0];
}

// contas de volume públicas: [venue, user, lamports], metade de cada programa; com cashback em SOL primeiro
async function findUvas(): Promise<Array<{ venue: UvaVenue; user: string; lamports: number }>> {
  const found: Array<{ venue: UvaVenue; user: string; lamports: number; dataLen: number }> = [];
  for (const venue of ['pump', 'amm'] as const) {
    const program = venue === 'pump' ? PROGRAMS.pump : PROGRAMS.pumpAmm;
    const mine: typeof found = [];
    for (let tries = 0; mine.length < 4 * WANT && tries < 4; tries++) {
      const res = await rpc.call<Array<{ pubkey: string; account: { lamports: number; data: [string, string] } }>>('getProgramAccounts', [
        program,
        { encoding: 'base64', filters: [{ memcmp: { offset: 0, bytes: UVA_DISC } }, { memcmp: { offset: 8, bytes: encodeBase58(randomBytes(2)) } }] },
      ]);
      for (const a of res) {
        const d = Buffer.from(a.account.data[0], 'base64');
        if (d.length >= 40) mine.push({ venue, user: encodeBase58(d.subarray(8, 40)), lamports: a.account.lamports, dataLen: d.length });
      }
    }
    // as que têm mais que o aluguel primeiro (cashback em SOL: coleta + fecha)
    mine.sort((x, y) => y.lamports - x.lamports);
    found.push(...mine);
  }
  // só carteira comum como user (conta de programa não é uma temporária)
  const owners = await accounts([...new Set(found.map((f) => f.user))]);
  const ordinary = found.filter((f) => !owners.has(f.user) || owners.get(f.user)!.owner === PROGRAMS.system);
  return ordinary;
}

async function main() {
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  const ctx: VolumeContext = {};
  console.log(`Procurando contas de volume públicas (Pump.fun e PumpSwap)…`);
  const candidates = await findUvas();
  console.log(`${candidates.length} contas de volume de carteiras comuns achadas.`);
  // --regra=N: só aplica a regra a N contas sorteadas de cada programa e conta os motivos (nada é simulado)
  const sample = Number(process.argv.find((a) => a.startsWith('--regra='))?.slice('--regra='.length) ?? 0);
  if (sample > 0) {
    for (const venue of ['pump', 'amm'] as const) {
      const list = candidates.filter((x) => x.venue === venue).sort(() => Math.random() - 0.5).slice(0, sample);
      const count = new Map<string, number>();
      for (const c of list) {
        const st = await readUva(rpc, c.user, venue, ctx, rent0);
        const k = !st ? 'sumiu' : st.closable ? 'fecha' : st.why!;
        count.set(k, (count.get(k) ?? 0) + 1);
      }
      console.log(`  ${venue}: ${list.length} contas → ${[...count].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    return;
  }
  // regra do app em cada uma, até juntar WANT fecháveis (metade de cada programa, se der)
  const why = new Map<string, number>();
  const closable: Array<{ venue: UvaVenue; user: string; st: UvaState }> = [];
  for (const venue of ['pump', 'amm'] as const) {
    for (const c of candidates.filter((x) => x.venue === venue)) {
      if (closable.filter((x) => x.venue === venue).length >= Math.ceil(WANT / 2)) break;
      const st = await readUva(rpc, c.user, venue, ctx, rent0);
      if (!st) continue;
      if (!st.closable) {
        why.set(`${venue}:${st.why}`, (why.get(`${venue}:${st.why}`) ?? 0) + 1);
        continue;
      }
      closable.push({ venue, user: c.user, st });
    }
  }
  const ends = await ctx.ends;
  console.log(`Janela do incentivo (end_time): Pump.fun ${ends?.pump}, PumpSwap ${ends?.amm}.`);
  console.log(`Abertas pela regra (não fecham): ${[...why].map(([k, v]) => `${k}=${v}`).join(', ') || 'nenhuma'}`);
  const payer = await richPayer(new Set(closable.map((c) => c.user)));
  const dest = encodeBase58(randomBytes(32)); // endereço novo: recebe a partir do aluguel mínimo (89% de ~0,00135 SOL passa)
  let ok = 0;
  let exact = 0;
  for (const c of closable) {
    const [wb] = [...(await accounts([c.user])).values()];
    const cashback = c.venue === 'pump' ? (await cashbackOf(rpc, c.user, rent0)) : { pump: 0n, amm: 0n };
    const fees = { bondingVault: '', bondingVaultLamports: 0, ammVaultAta: '', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null, cashback, uva: [c.st] };
    const pb = (await accounts([payer])).get(payer);
    const scans: WalletScan[] = [
      { index: 0, address: payer, lamports: pb?.lamports ?? 0, tokens: [], fees: null, errors: [] },
      { index: 1, address: c.user, lamports: wb?.lamports ?? 0, tokens: [], fees, errors: [] },
    ];
    const plan = buildPlan({ scans, prices: new Map(), destination: dest, rentExemptZero: rent0 });
    plan.steps = plan.steps.filter((s) => s.kind === 'close-uva');
    plan.appFee = appFeeFor(dest);
    try {
      const sims = await execute({ rpc, plan, signers: new Map([fakeSigner(payer, 0), fakeSigner(c.user, 1)].map((x) => [x.index, x])), mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
      const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
      const shown = r.toDestination.closedRentLamports + r.toDestination.claimLamports; // bruto: aluguel + cashback
      const fine = sims.every((x) => x.status === 'simulado');
      if (fine) ok++;
      if (fine && shown === c.st.lamports) exact++;
      console.log(
        `  ${c.venue.padEnd(4)} ${c.user} conta ${sol(c.st.lamports)} (aluguel ${sol(c.st.rentLamports)}) | Confirmar: aluguel ${sol(r.toDestination.closedRentLamports)} + cashback ${sol(r.toDestination.claimLamports)}, destino ${sol(r.totalLamports)}, taxa ${sol(r.appFeeLamports)} | ${sims.map((x) => `${x.status}${x.detail ? ` (${x.detail.slice(0, 120)})` : ''}`).join(', ')}`,
      );
    } catch (e) {
      console.log(`  ${c.venue} ${c.user} PAROU: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${ok} de ${closable.length} fechamentos simulados sem erro; ${exact} com o mostrado (aluguel + cashback) = lamports da conta. Nada foi enviado: só simulações.`);
}

await main();
