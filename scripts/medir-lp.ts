// Mede na mainnet (só leitura, sem frase, nada enviado) se carteiras de perfil burner têm posição de liquidez (LP)
// esquecida na Meteora DLMM, no Raydium CLMM ou na Orca (Whirlpools), quanto vale e quanto custa ler.
//
//   node scripts/medir-lp.ts [por-grupo=100]
//   node scripts/medir-lp.ts [por-grupo] --grupos=pump,launchlab,dbc,esquecidas   (padrão: os três primeiros)
//   node scripts/medir-lp.ts --controle   (controle positivo: donos de posições reais têm que aparecer)
//
// Carteiras: três grupos de criadores recentes (perfil das temporárias): quem criou moeda na Pump.fun (pagadora da
// transação com a autoridade de mint, como em medir-recuperavel.ts), e o campo `creator` dos pools do Raydium LaunchLab
// (PoolState, 429 bytes, offset 333) e da Meteora DBC (424 bytes, offset 104) tocados pelas transações recentes de cada
// programa. Grupo opcional `esquecidas`: criadores com creator fee do LaunchLab parada (0,001 a 1 SOL) no cofre, o perfil
// da temporária largada. Só carteiras comuns (na curva ed25519).
//
// Por carteira (layouts e sementes em docs/posicoes-lp.md, conferidos no GitHub oficial de cada protocolo):
// - DLMM: a posição é conta do programa (PositionV2, 8120 bytes ou mais quando estendida) com `owner` no offset 40:
//   1 getProgramAccounts com o discriminador e o dono.
// - Raydium CLMM e Orca: a posição é um NFT na carteira. Das contas de token (Token e Token-2022, as 2 leituras que o
//   app já faz) saem os mints com saldo 1 e 0 casas; o PDA ["position", mint] de cada programa diz se é posição
//   (1 getMultipleAccounts para todos). DAMM v2 da Meteora (mesma semente, programa cp-amm) entra só na contagem,
//   fora do escopo.
// Valor (só o lado em SOL): DLMM lê o par e os bin arrays (parte da posição em cada bin e fee a coletar, fórmula do
// `DynamicPosition::parse` do dlmm-sdk); CLMM e Orca leem o pool (preço atual) e calculam a quantia pela liquidez e pelos
// ticks (ponto flutuante: estimativa), com as fees já contabilizadas na posição (piso: a fee nova desde a última
// atualização precisa dos tick arrays e não entra). Aluguel da conta da posição à parte (volta ao fechar).
//
// RPC: SOLANA_RPC_URL (padrão: RPC público, PUBLIC_RPC_LIMITS). A URL não é impressa. Nada é assinado nem enviado.

import { decodeBase58, encodeBase58 } from '../src/core/solana/base58.ts';
import { associatedTokenAddress, findProgramAddress, isOnCurve, PROGRAMS, WSOL_MINT } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { createRpcMeter } from '../src/core/solana/rpc-meter.ts';
import { LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault } from '../src/core/limpeza/launchlab.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const meter = createRpcMeter();
const rpc = createRpc({ url, timeoutMs: 120_000, fetchImpl: meter.fetchImpl, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const PER = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 100);

const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const DAMM2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const PUMP_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';
// discriminadores (IDL lb_clmm 0.12.0) e tamanhos
const DLMM_POSITION_V2 = Buffer.from([117, 176, 212, 199, 245, 180, 133, 182]);
const DLMM_POSITION_SIZE = 8120;
const DLMM_BIN_DATA_SIZE = 112; // PositionBinData das posições estendidas
const CLMM_POSITION_SIZE = 281;
const ORCA_POSITION_SIZE = 216;

const SOL = (l: number | bigint) => (Number(l) / 1e9).toFixed(6);
type Acc = { data: [string, string]; lamports: number; owner: string; space?: number } | null;

async function multiple(keys: string[]): Promise<Map<string, NonNullable<Acc>>> {
  const out = new Map<string, NonNullable<Acc>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    chunk.forEach((k, j) => r.value[j] && out.set(k, r.value[j]!));
  }
  return out;
}
const bytes = (a: NonNullable<Acc>) => Buffer.from(a.data[0], 'base64');

type Tx = { transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null;
async function tx(sig: string): Promise<Tx> {
  return rpc.call<Tx>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
}
async function recentSigs(account: string, n: number): Promise<string[]> {
  const out: string[] = [];
  let before: string | undefined;
  while (out.length < n) {
    const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [account, { limit: 1000, ...(before ? { before } : {}) }]);
    if (!sigs.length) break;
    out.push(...sigs.filter((s) => !s.err).map((s) => s.signature));
    before = sigs.at(-1)!.signature;
    process.stderr.write(`  ${account.slice(0, 6)}…: ${out.length} assinaturas\n`);
  }
  return out.slice(0, n);
}
const isWallet = (k: string) => isOnCurve(decodeBase58(k));

async function pumpCreators(n: number): Promise<string[]> {
  const out = new Set<string>();
  for (const s of await recentSigs(PUMP_MINT_AUTHORITY, n * 3)) {
    if (out.size >= n) break;
    const payer = (await tx(s))?.transaction?.message?.accountKeys?.[0];
    if (typeof payer === 'string' && isWallet(payer) && !out.has(payer)) {
      out.add(payer);
      if (out.size % 20 === 0) process.stderr.write(`  Pump.fun: ${out.size} criadores\n`);
    }
  }
  return [...out];
}

// criadores dos pools tocados pelas transações recentes de um programa de curva (amostra espalhada nas 5.000 transações mais recentes:
// os robôs repetem os mesmos pools nas mais recentes)
const SIG_WINDOW = 5_000;
async function poolCreators(program: string, size: number, offset: number, n: number): Promise<string[]> {
  const sigs = await recentSigs(program, SIG_WINDOW);
  const seenPools = new Set<string>();
  const out = new Set<string>();
  const step = Math.max(1, Math.floor(sigs.length / (n * 4)));
  for (let i = 0; i < sigs.length && out.size < n; i += step) {
    const t = await tx(sigs[i]);
    const keys = [...new Set([...(t?.transaction?.message?.accountKeys ?? []), ...(t?.meta?.loadedAddresses?.writable ?? []), ...(t?.meta?.loadedAddresses?.readonly ?? [])])].filter((k) => !seenPools.has(k));
    if (!keys.length) continue;
    const accs = await multiple(keys.slice(0, 100));
    for (const [k, a] of accs) {
      if (a.owner !== program) continue;
      const d = bytes(a);
      if (d.length !== size) continue;
      seenPools.add(k);
      const c = encodeBase58(d.subarray(offset, offset + 32));
      if (isWallet(c)) out.add(c);
    }
    if (i % (step * 25) === 0) process.stderr.write(`  ${program.slice(0, 6)}…: ${out.size} criadores\n`);
  }
  return [...out].slice(0, n);
}

// criadores com creator fee do LaunchLab esquecida (cofre em WSOL com 0,001 a 1 SOL parado, espalhados pela faixa): o
// perfil da temporária largada, inclusive antiga. Mesma busca de scripts/medir-launchlab.ts (criador pelo pool da
// transação mais recente do cofre; o PDA [criador, WSOL] tem que dar o cofre).
async function forgottenCreators(n: number): Promise<string[]> {
  const r = await rpc.call<{ value: Array<{ pubkey: string; account: { data: [string, string] } }> }>('getTokenAccountsByOwner', [
    LAUNCHLAB_FEE_VAULT_AUTH, { mint: WSOL_MINT }, { encoding: 'base64', dataSlice: { offset: 64, length: 8 }, commitment: 'confirmed' },
  ]);
  const vaults = r.value.map((x) => ({ v: x.pubkey, amt: Buffer.from(x.account.data[0], 'base64').readBigUInt64LE(0) })).filter((x) => x.amt > 1_000_000n && x.amt <= 1_000_000_000n);
  const out = new Set<string>();
  const tries = Math.min(vaults.length, n * 2);
  for (let i = 0; i < tries && out.size < n; i++) {
    const vault = vaults[Math.floor((i * vaults.length) / tries)].v;
    const sigs = await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [vault, { limit: 2 }]).catch(() => []);
    for (const s of sigs) {
      const t = await tx(s.signature);
      const keys = [...(t?.transaction?.message?.accountKeys ?? []), ...(t?.meta?.loadedAddresses?.writable ?? []), ...(t?.meta?.loadedAddresses?.readonly ?? [])];
      const cands = new Set(keys);
      for (const [, a] of await multiple(keys.slice(0, 100))) if (a.owner === PROGRAMS.raydiumLaunchlab && bytes(a).length === 429) cands.add(encodeBase58(bytes(a).subarray(333, 365)));
      const c = [...cands].find((k) => launchlabCreatorFeeVault(k) === vault);
      if (c) { if (isWallet(c)) out.add(c); break; }
    }
    if (i % 20 === 0) process.stderr.write(`  fee esquecida: ${out.size} criadores\n`);
  }
  return [...out];
}

// ---- valor ----
const Q64 = 2 ** 64;
const u128 = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const tickSqrt = (t: number) => Math.pow(1.0001, t / 2);
// quantias de uma posição de liquidez concentrada (Uniswap v3), em unidades da moeda
function clAmounts(liq: bigint, sqrtCur: number, lower: number, upper: number): [number, number] {
  const L = Number(liq);
  const a = tickSqrt(lower);
  const b = tickSqrt(upper);
  const s = Math.min(Math.max(sqrtCur, a), b);
  return [L * (1 / s - 1 / b), L * (s - a)];
}

type Found = { protocol: 'dlmm' | 'clmm' | 'orca'; position: string; pool: string; solSide: number; solFees: number; otherSide: boolean; rent: number; liquidity: boolean; note?: string };

async function valueDlmm(position: string, d: Buffer, lamports: number): Promise<Found> {
  const pair = encodeBase58(d.subarray(8, 40));
  const lower = d.readInt32LE(7912);
  const upper = d.readInt32LE(7916);
  const width = upper - lower + 1;
  const pairAcc = (await multiple([pair])).get(pair);
  const base: Found = { protocol: 'dlmm', position, pool: pair, solSide: 0, solFees: 0, otherSide: false, rent: lamports, liquidity: false };
  if (!pairAcc || pairAcc.owner !== DLMM || bytes(pairAcc).length !== 904) return { ...base, note: 'par fora do formato' };
  const p = bytes(pairAcc);
  const mintX = encodeBase58(p.subarray(88, 120));
  const mintY = encodeBase58(p.subarray(120, 152));
  const solIsX = mintX === WSOL_MINT;
  const solIsY = mintY === WSOL_MINT;
  // bins da posição: 70 na base, o resto (estendida) depois dos 8120 bytes
  const share = (i: number) => (i < 70 ? u128(d, 72 + 16 * i) : u128(d, DLMM_POSITION_SIZE + DLMM_BIN_DATA_SIZE * (i - 70)));
  const fee = (i: number) => (i < 70 ? 4552 + 48 * i : DLMM_POSITION_SIZE + DLMM_BIN_DATA_SIZE * (i - 70) + 64);
  if (width < 1 || width > 1400 || (width > 70 && d.length < DLMM_POSITION_SIZE + DLMM_BIN_DATA_SIZE * (width - 70))) return { ...base, note: 'faixa fora do formato' };
  const arrIdx = (bin: number) => Math.floor(bin / 70);
  const idxs = [...new Set(Array.from({ length: width }, (_, i) => arrIdx(lower + i)))];
  const arrKeys = idxs.map((ix) => {
    const le = Buffer.alloc(8);
    le.writeBigInt64LE(BigInt(ix));
    return findProgramAddress(['bin_array', decodeBase58(pair), le], DLMM).address;
  });
  const arrs = await multiple(arrKeys);
  let x = 0n, y = 0n, fx = 0n, fy = 0n;
  let any = false;
  for (let i = 0; i < width; i++) {
    const bin = lower + i;
    const sh = share(i);
    if (sh > 0n) any = true;
    const fo = fee(i);
    const pendX = d.readBigUInt64LE(fo + 32);
    const pendY = d.readBigUInt64LE(fo + 40);
    const ix = arrIdx(bin);
    const a = arrs.get(arrKeys[idxs.indexOf(ix)]);
    if (!a || bytes(a).length !== 10136) { fx += pendX; fy += pendY; continue; }
    const b = bytes(a);
    const bo = 56 + 144 * (bin - ix * 70);
    const amtX = b.readBigUInt64LE(bo), amtY = b.readBigUInt64LE(bo + 8);
    const supply = u128(b, bo + 32);
    if (sh > 0n && supply > 0n) { x += (sh * amtX) / supply; y += (sh * amtY) / supply; }
    const scaled = sh >> 64n;
    const dX = u128(b, bo + 80) - u128(d, fo);
    const dY = u128(b, bo + 96) - u128(d, fo + 16);
    fx += pendX + (sh > 0n && dX > 0n ? (scaled * dX) >> 64n : 0n);
    fy += pendY + (sh > 0n && dY > 0n ? (scaled * dY) >> 64n : 0n);
  }
  return { ...base, liquidity: any, solSide: Number(solIsX ? x : solIsY ? y : 0n), solFees: Number(solIsX ? fx : solIsY ? fy : 0n), otherSide: !(solIsX || solIsY) };
}

async function valueCl(protocol: 'clmm' | 'orca', position: string, d: Buffer, lamports: number): Promise<Found> {
  // CLMM: pool 41, ticks 73/77, liquidez 81, fees devidas 129/137. Orca: pool 8, liquidez 72, ticks 88/92, fees 112/136.
  const isC = protocol === 'clmm';
  const pool = encodeBase58(d.subarray(isC ? 41 : 8, isC ? 73 : 40));
  const liq = u128(d, isC ? 81 : 72);
  const lower = d.readInt32LE(isC ? 73 : 88);
  const upper = d.readInt32LE(isC ? 77 : 92);
  const owed0 = d.readBigUInt64LE(isC ? 129 : 112);
  const owed1 = d.readBigUInt64LE(isC ? 137 : 136);
  const base: Found = { protocol, position, pool, solSide: 0, solFees: 0, otherSide: false, rent: lamports, liquidity: liq > 0n };
  const pa = (await multiple([pool])).get(pool);
  if (!pa || pa.owner !== (isC ? CLMM : ORCA)) return { ...base, note: 'pool não lido' };
  const p = bytes(pa);
  // CLMM PoolState: mint0 73, mint1 105, sqrt_price_x64 253. Whirlpool: sqrt_price 65, mint_a 101, mint_b 181.
  const m0 = encodeBase58(p.subarray(isC ? 73 : 101, isC ? 105 : 133));
  const m1 = encodeBase58(p.subarray(isC ? 105 : 181, isC ? 137 : 213));
  const sqrt = Number(u128(p, isC ? 253 : 65)) / Q64;
  const [a0, a1] = clAmounts(liq, sqrt, lower, upper);
  const sol0 = m0 === WSOL_MINT, sol1 = m1 === WSOL_MINT;
  return { ...base, solSide: sol0 ? a0 : sol1 ? a1 : 0, solFees: Number(sol0 ? owed0 : sol1 ? owed1 : 0n), otherSide: !(sol0 || sol1) };
}

type WalletResult = { wallet: string; group: string; found: Found[]; damm2: number; unread: string[]; reqs: number; ms: number };

async function scanWallet(wallet: string, group: string): Promise<WalletResult> {
  const t0 = Date.now();
  const r0 = meter.requests();
  const found: Found[] = [];
  const unread: string[] = [];
  let damm2 = 0;
  // DLMM
  try {
    const res = await rpc.call<Array<{ pubkey: string; account: NonNullable<Acc> }>>('getProgramAccounts', [DLMM, {
      encoding: 'base64', commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: encodeBase58(DLMM_POSITION_V2) } }, { memcmp: { offset: 40, bytes: wallet } }],
    }]);
    for (const { pubkey, account } of res) {
      const d = bytes(account);
      if (d.length < DLMM_POSITION_SIZE || (d.length - DLMM_POSITION_SIZE) % DLMM_BIN_DATA_SIZE) { unread.push('dlmm:tamanho'); continue; }
      found.push(await valueDlmm(pubkey, d, account.lamports));
    }
  } catch (e) {
    unread.push(`dlmm:${(e as Error).message.slice(0, 60)}`);
  }
  // NFTs → posição do CLMM, da Orca e do DAMM v2
  try {
    const mints: string[] = [];
    for (const programId of [PROGRAMS.token, PROGRAMS.token2022]) {
      const res = await rpc.call<{ value: Array<{ account: { data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } } } }> }>('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      for (const t of res.value) {
        const info = t.account.data.parsed?.info;
        if (info?.mint && info.tokenAmount?.amount === '1' && info.tokenAmount.decimals === 0) mints.push(info.mint);
      }
    }
    if (mints.length) {
      const pdas = mints.flatMap((m) => [CLMM, ORCA, DAMM2].map((prog) => ({ prog, m, k: findProgramAddress(['position', decodeBase58(m)], prog).address })));
      const accs = await multiple(pdas.map((p) => p.k));
      for (const p of pdas) {
        const a = accs.get(p.k);
        if (!a || a.owner !== p.prog) continue;
        const d = bytes(a);
        if (p.prog === DAMM2) { damm2++; continue; }
        if (d.length !== (p.prog === CLMM ? CLMM_POSITION_SIZE : ORCA_POSITION_SIZE)) { unread.push(`${p.prog === CLMM ? 'clmm' : 'orca'}:tamanho`); continue; }
        found.push(await valueCl(p.prog === CLMM ? 'clmm' : 'orca', p.k, d, a.lamports));
      }
    }
  } catch (e) {
    unread.push(`nft:${(e as Error).message.slice(0, 60)}`);
  }
  return { wallet, group, found, damm2, unread, reqs: meter.requests() - r0, ms: Date.now() - t0 };
}

// ---- controle positivo (--controle): donos de posições reais, achados nas transações recentes de cada protocolo, têm
// que aparecer na leitura acima com a posição e um valor. Prova que o 0% da amostra não é defeito do leitor.
const quickRpc = createRpc({ url, timeoutMs: 20_000, retries: 0, fetchImpl: meter.fetchImpl, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
async function positionOwners(program: string, n: number): Promise<string[]> {
  const out = new Set<string>();
  const pools = new Set<string>();
  for (const s of await recentSigs(program, 300)) {
    if (out.size >= n) break;
    const t = await tx(s);
    const keys = [...new Set([...(t?.transaction?.message?.accountKeys ?? []), ...(t?.meta?.loadedAddresses?.writable ?? [])])].filter((k) => !pools.has(k));
    for (const [k, a] of await multiple(keys.slice(0, 100))) {
      if (a.owner !== program || out.size >= n) continue;
      const d = bytes(a);
      if (program === DLMM) {
        const owner = d.length >= DLMM_POSITION_SIZE && d.subarray(0, 8).equals(DLMM_POSITION_V2) ? encodeBase58(d.subarray(40, 72)) : null;
        if (owner && isWallet(owner)) out.add(owner);
        continue;
      }
      // CLMM e Orca: as trocas não tocam a posição. Pelo pool em SOL da transação (CLMM 1544 bytes, mints 73/105;
      // Whirlpool 653, mints 101/181), as posições dele (getProgramAccounts, só o mint do NFT) e quem tem o NFT.
      const isC = program === CLMM;
      if (d.length !== (isC ? 1544 : 653) || pools.has(k)) continue;
      const m0 = encodeBase58(d.subarray(isC ? 73 : 101, isC ? 105 : 133));
      const m1 = encodeBase58(d.subarray(isC ? 105 : 181, isC ? 137 : 213));
      if (m0 !== WSOL_MINT && m1 !== WSOL_MINT) continue;
      pools.add(k);
      // pool grande demais (milhares de posições) estoura o prazo: sem nova tentativa, vai para o próximo pool
      const ps = await quickRpc.call<Array<{ account: { data: [string, string] } }>>('getProgramAccounts', [program, {
        encoding: 'base64', dataSlice: { offset: isC ? 9 : 40, length: 32 },
        filters: [{ dataSize: isC ? CLMM_POSITION_SIZE : ORCA_POSITION_SIZE }, { memcmp: { offset: isC ? 41 : 8, bytes: k } }],
      }]).catch(() => []);
      process.stderr.write(`  pool ${k.slice(0, 6)}…: ${ps.length} posições\n`);
      // quem tem o NFT: a pagadora da transação mais recente do mint, se a ATA dela (Token ou Token-2022) tem saldo 1
      // (o getTokenLargestAccounts do RPC público responde 429 de saída)
      for (let i = 0; i < Math.min(8, ps.length) && out.size < n; i++) {
        const mint = encodeBase58(Buffer.from(ps[Math.floor((i * ps.length) / Math.min(8, ps.length))].account.data[0], 'base64'));
        const sig = (await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [mint, { limit: 1 }]).catch(() => []))[0]?.signature;
        const payer = sig ? (await tx(sig))?.transaction?.message?.accountKeys?.[0] : undefined;
        if (!payer || !isWallet(payer)) continue;
        const atas = [PROGRAMS.token, PROGRAMS.token2022].map((tp) => associatedTokenAddress(payer, mint, tp));
        const accs = await multiple(atas);
        if (atas.some((a) => { const x = accs.get(a); return x && bytes(x).length >= 72 && bytes(x).readBigUInt64LE(64) === 1n; })) out.add(payer);
      }
    }
  }
  return [...out];
}
if (process.argv.includes('--controle')) {
  console.log(`${new Date().toISOString()}: controle positivo, RPC ${url === PUBLIC ? 'público' : 'próprio'}`);
  for (const [name, prog, proto] of [['DLMM', DLMM, 'dlmm'], ['Raydium CLMM', CLMM, 'clmm'], ['Orca', ORCA, 'orca']] as const) {
    const owners = await positionOwners(prog, 3);
    for (const w of owners) {
      const r = await scanWallet(w, name);
      const mine = r.found.filter((f) => f.protocol === proto);
      console.log(`controle ${name} ${w.slice(0, 6)}…: ${mine.length ? 'ACHOU' : 'NÃO ACHOU'} ${mine.length} posição(ões); SOL ${SOL(mine.reduce((s, f) => s + f.solSide, 0))} + fee ${SOL(mine.reduce((s, f) => s + f.solFees, 0))}${mine.some((f) => f.otherSide) ? ' (alguma sem lado SOL)' : ''}${mine.some((f) => f.note) ? ` (${mine.map((f) => f.note).filter(Boolean).join(', ')})` : ''}; ${r.reqs} req; ${r.unread.length ? `não lida: ${r.unread.join(', ')}` : 'lida'}`);
    }
  }
  process.exit(0);
}

// ---- execução ----
const started = new Date().toISOString();
const t0 = Date.now();
console.log(`${started}: buscando até ${PER} criadores por grupo`);
const WANT = (process.argv.find((a) => a.startsWith('--grupos='))?.slice('--grupos='.length) ?? 'pump,launchlab,dbc').split(',');
const groups: Array<[string, string[]]> = [];
if (WANT.includes('pump')) groups.push(['Pump.fun', await pumpCreators(PER)]);
if (WANT.includes('launchlab')) groups.push(['LaunchLab', await poolCreators(PROGRAMS.raydiumLaunchlab, 429, 333, PER)]);
if (WANT.includes('dbc')) groups.push(['Meteora DBC', await poolCreators(PROGRAMS.meteoraDbc, 424, 104, PER)]);
if (WANT.includes('esquecidas')) groups.push(['Fee esquecida', await forgottenCreators(PER)]);
const seen = new Set<string>();
const work: Array<[string, string]> = [];
for (const [g, ws] of groups) {
  const own = ws.filter((w) => !seen.has(w));
  own.forEach((w) => seen.add(w));
  console.log(`  ${g}: ${ws.length} criadores (${own.length} novos)`);
  own.forEach((w) => work.push([w, g]));
}
const discoveryReqs = meter.requests();
console.log(`descoberta: ${discoveryReqs} requisições, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
meter.reset();
const t1 = Date.now();
const results: WalletResult[] = [];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < work.length) {
    const [w, g] = work[next++];
    const r = await scanWallet(w, g);
    results.push(r);
    if (r.found.length || r.damm2) console.log(`  ${g} ${w.slice(0, 6)}…: ${r.found.map((f) => `${f.protocol} SOL ${SOL(f.solSide)} + fee ${SOL(f.solFees)} (aluguel ${SOL(f.rent)}${f.liquidity ? '' : ', sem liquidez'}${f.otherSide ? ', sem lado SOL' : ''}${f.note ? `, ${f.note}` : ''})`).join('; ')}${r.damm2 ? ` [DAMM v2: ${r.damm2}]` : ''}`);
  }
}));
const scanMs = Date.now() - t1;
const counts = meter.counts();

console.log(`\n== ${new Date().toISOString()} (início ${started}), ${results.length} carteiras, RPC ${url === PUBLIC ? 'público' : 'próprio'}`);
const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] : 0);
for (const g of [...groups.map(([name]) => name), 'todos']) {
  const rs = results.filter((r) => g === 'todos' || r.group === g);
  const ok = rs.filter((r) => !r.unread.length);
  const line = (proto: Found['protocol']) => {
    const ws = ok.filter((r) => r.found.some((f) => f.protocol === proto));
    const fs = ok.flatMap((r) => r.found.filter((f) => f.protocol === proto));
    const vals = ws.map((r) => r.found.filter((f) => f.protocol === proto).reduce((s, f) => s + f.solSide + f.solFees, 0));
    const live = fs.filter((f) => f.liquidity).length;
    return `${proto}: ${ws.length} carteiras (${((100 * ws.length) / Math.max(1, ok.length)).toFixed(1)}%), ${fs.length} posições (${live} com liquidez), SOL+fee por carteira mediana ${SOL(q(vals, 0.5))} máx ${SOL(Math.max(0, ...vals))}, soma ${SOL(vals.reduce((a, b) => a + b, 0))}; aluguel ${SOL(fs.reduce((s, f) => s + f.rent, 0))}`;
  };
  const any = ok.filter((r) => r.found.length).length;
  console.log(`-- ${g}: ${rs.length} carteiras, ${rs.length - ok.length} com leitura incompleta (fora da conta); com alguma posição: ${any} (${((100 * any) / Math.max(1, ok.length)).toFixed(1)}%); DAMM v2 (fora do escopo): ${ok.filter((r) => r.damm2).length} carteiras`);
  for (const p of ['dlmm', 'clmm', 'orca'] as const) console.log(`   ${line(p)}`);
}
const bad = results.filter((r) => r.unread.length);
if (bad.length) console.log(`leituras incompletas: ${[...new Set(bad.flatMap((r) => r.unread))].join(' | ')}`);
console.log(`custo da leitura (${results.length} carteiras): ${Object.entries(counts).map(([m, n]) => `${m} ${n}`).join(', ')}; ${(meter.requests() / Math.max(1, results.length)).toFixed(2)} req/carteira, ${(meter.credits() / Math.max(1, results.length)).toFixed(1)} créditos Helius/carteira; ${(scanMs / 1000).toFixed(0)} s (${(scanMs / Math.max(1, results.length) / 1000).toFixed(2)} s/carteira, 4 em paralelo); getTokenAccountsByOwner o app já faz`);
console.log(`tempo total ${((Date.now() - t0) / 1000).toFixed(0)} s. Nada foi enviado.`);
