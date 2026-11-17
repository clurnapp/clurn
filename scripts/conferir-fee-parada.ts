// Confere na mainnet, SEM enviar nada e sem frase, que a varredura + coleta da fee parada funciona nos
// programas no ar. Acha, em transações públicas recentes da Pump.fun e do PumpSwap, curvas e pools com fee do
// criador parada (BondingCurve.creator_fee / Pool.creator_fees > 0) e SIMULA as instruções do app (todas
// permissionless; a simulação não confere assinatura). Compara com a coleta sem varrer.
//
//   node scripts/conferir-fee-parada.ts [transacoes=80] [simulacoes=4]
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa. Nada é assinado nem enviado.

import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { ataCreateIdempotent, pumpAmmCollectCoinCreatorFee, pumpAmmSweepCreatorFee, pumpCollectCreatorFeeV2, pumpSweepCreatorFee, systemTransfer } from '../src/core/solana/instructions.ts';
import { anchorAccountDiscriminator, associatedTokenAddress, findProgramAddress, PROGRAMS, pumpCreatorVault, WSOL_MINT } from '../src/core/solana/pda.ts';
import { decodeBase58 } from '../src/core/solana/base58.ts';
import { createRpc } from '../src/core/solana/rpc.ts';
import { CURVE_SLICE, parseCurve, parsePool, POOL_SLICE } from '../src/core/limpeza/scan.ts';
import { compileMessage, type Instruction } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, requestsPerSecond: url === PUBLIC ? 2 : 8 });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const TXS = nums[0] ?? 80;
const SIMS = nums[1] ?? 4;
// pagador só da simulação: carteira comum que existe e tem SOL (a da taxa do app, pública). Nada é enviado.
const PAYER = APP_FEE_WALLET;

const CURVE_DISC = anchorAccountDiscriminator('BondingCurve');
const POOL_DISC = anchorAccountDiscriminator('Pool');
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

type Acc = { data?: [string, string]; owner?: string; lamports?: number } | null;

async function recentKeys(program: string): Promise<string[][]> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [program, { limit: TXS }]);
  const out: string[][] = [];
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc
      .call<{ transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
      .catch(() => null);
    const keys = [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
    if (keys.length) out.push(keys);
  }
  return out;
}

async function accounts(keys: string[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    chunk.forEach((k, j) => {
      const a = r.value[j];
      if (a?.data?.[0]) out.set(k, Buffer.from(a.data[0], 'base64'));
    });
  }
  return out;
}

async function simulate(instructions: Instruction[], watch: string[]) {
  const msg = compileMessage(PAYER, instructions, '11111111111111111111111111111111');
  const bytes = Uint8Array.from([msg.numSigners, ...new Array(64 * msg.numSigners).fill(0), ...msg.bytes]);
  const r = await rpc.call<{ value: { err: unknown; logs?: string[]; accounts?: Array<{ lamports: number; data: [string, string] } | null> } }>('simulateTransaction', [
    Buffer.from(bytes).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } },
  ]);
  return r.value;
}

async function lamports(keys: string[]): Promise<number[]> {
  const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [keys, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
  return r.value.map((a) => a?.lamports ?? 0);
}

async function curves() {
  const keysByTx = await recentKeys(PROGRAMS.pump);
  const all = [...new Set(keysByTx.flat())];
  const data = await accounts(all);
  const found: Array<{ curve: string; mint: string; creator: string; fee: bigint }> = [];
  let parked = 0;
  for (const [k, b] of data) {
    if (b.length < 133 || !b.subarray(0, 8).equals(CURVE_DISC)) continue;
    const p = parseCurve(b.subarray(CURVE_SLICE.offset, CURVE_SLICE.offset + CURVE_SLICE.length));
    if (p.fee === 0n) continue;
    parked++;
    const mint = all.find((m) => findProgramAddress(['bonding-curve', decodeBase58(m)], PROGRAMS.pump).address === k);
    if (p.collectable && mint) found.push({ curve: k, mint, creator: encodeBase58(b.subarray(49, 81)), fee: p.fee });
  }
  const curvesSeen = [...data.values()].filter((b) => b.length >= 8 && b.subarray(0, 8).equals(CURVE_DISC)).length;
  console.log(`Curva: ${keysByTx.length} transações, ${curvesSeen} curvas, ${parked} com fee parada, ${found.length} coletáveis pelo app (em SOL, do criador).`);
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  for (const c of found.slice(0, SIMS)) {
    const vault = pumpCreatorVault(c.creator);
    const [creatorBefore, vaultBefore] = await lamports([c.creator, vault]);
    // a Pump.fun só paga a carteira que já tem o aluguel: empréstimo, como no executor
    const lend = creatorBefore < rent0 ? [systemTransfer(PAYER, c.creator, BigInt(rent0))] : [];
    const lent = creatorBefore < rent0 ? rent0 : 0;
    const only = await simulate([...lend, pumpCollectCreatorFeeV2(c.creator)], [c.creator]);
    const swept = await simulate([...lend, pumpSweepCreatorFee(PAYER, c.creator, c.mint), pumpCollectCreatorFeeV2(c.creator)], [c.creator, c.curve]);
    const gain = (v: typeof only) => (v.err ? `ERRO ${JSON.stringify(v.err)} ${(v.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)}` : `${sol(v.accounts![0]!.lamports - creatorBefore - lent)} SOL`);
    const after = swept.accounts?.[1]?.data?.[0] ? Buffer.from(swept.accounts[1].data[0], 'base64') : null;
    const left = after ? parseCurve(after.subarray(CURVE_SLICE.offset, CURVE_SLICE.offset + CURVE_SLICE.length)).fee : null;
    console.log(`  curva ${c.curve.slice(0, 6)}… parada ${sol(c.fee)} SOL, cofre ${sol(Math.max(0, vaultBefore - rent0))} SOL | só coletar: ${gain(only)} | varrer + coletar: ${gain(swept)} | parada depois: ${left === null ? '?' : sol(left)} SOL`);
  }
}

async function pools() {
  const keysByTx = await recentKeys(PROGRAMS.pumpAmm);
  const all = [...new Set(keysByTx.flat())];
  const data = await accounts(all);
  const found: Array<{ pool: string; quoteAccount: string; creator: string; fee: bigint }> = [];
  let parked = 0;
  let seen = 0;
  for (const [k, b] of data) {
    if (b.length < 8 || !b.subarray(0, 8).equals(POOL_DISC)) continue;
    seen++;
    const p = parsePool(b.subarray(POOL_SLICE.offset, POOL_SLICE.offset + POOL_SLICE.length));
    if (p.fee === 0n) continue;
    parked++;
    if (p.collectable) found.push({ pool: k, quoteAccount: p.quoteAccount, creator: encodeBase58(b.subarray(211, 243)), fee: p.fee });
  }
  console.log(`Pool: ${keysByTx.length} transações, ${seen} pools, ${parked} com fee parada, ${found.length} coletáveis pelo app (em SOL).`);
  for (const p of found.slice(0, SIMS)) {
    const ata = associatedTokenAddress(p.creator, WSOL_MINT, PROGRAMS.token);
    const create = ataCreateIdempotent(PAYER, p.creator, WSOL_MINT, PROGRAMS.token);
    const only = await simulate([create, pumpAmmCollectCoinCreatorFee(p.creator)], [ata]);
    const swept = await simulate([create, pumpAmmSweepCreatorFee(PAYER, p.creator, p.pool, p.quoteAccount), pumpAmmCollectCoinCreatorFee(p.creator)], [ata]);
    // conta de token: quantidade (u64) no byte 64
    const got = (v: typeof only) => (v.err ? `ERRO ${JSON.stringify(v.err)} ${(v.logs ?? []).filter((l) => /error|failed/i.test(l)).slice(-1)}` : `${sol(Buffer.from(v.accounts![0]!.data[0], 'base64').readBigUInt64LE(64))} SOL`);
    console.log(`  pool ${p.pool.slice(0, 6)}… parada ${sol(p.fee)} SOL | só coletar: ${got(only)} | varrer + coletar: ${got(swept)}`);
  }
}

await curves();
await pools();
console.log('\nNada foi enviado: só simulações.');
