// Confere na mainnet, SEM enviar nada e sem frase, a coleta da creator fee da Meteora DBC pelo app inteiro: leitura
// (scanWallets), plano, executor (simulação, assinaturas falsas: a rede não confere) e recibo. Criadores públicos com
// fee em SOL parada nos pools: achados nas transações recentes do programa e, se forem poucos, nos outros pools das
// mesmas configs em SOL (1 getProgramAccounts por config, só a fee); ou passados em --carteiras.
//
//   node scripts/conferir-dbc.ts [transacoes=300] [criadores=6] [--destino=<endereço>] [--carteiras=a,b] [--configs=c,d]
//
// --configs: configs em SOL onde procurar pools com fee, antes das achadas nas transações.
//
// --destino: carteira comum que já existe na rede (padrão: uma das pagadoras de transações recentes, que não é o
// criador nem a pagadora usada aqui). O executor confere, na simulação, que o destino e a carteira da taxa recebem
// exatamente o esperado (89/11); qualquer diferença PARA (e aparece aqui como "PAROU").
// A fee é lida de novo DEPOIS da simulação: mostrado acima da 1ª leitura e igual à 2ª = moeda negociando no meio.
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa. Nada é assinado nem enviado.

import { buildReceipt } from '../src/app/receipt.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { dbcClaimLamports, parseDbcConfigQuote, parseDbcPool, DBC_CONFIG_SLICE } from '../src/core/limpeza/dbc.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { cleanupScanOptions, scanWallets, type WalletScan } from '../src/core/limpeza/scan.ts';
import { PROGRAMS, WSOL_MINT } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import type { Signer } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const TXS = nums[0] ?? 300;
const WANT = nums[1] ?? 6;
const DEST_ARG = process.argv.find((a) => a.startsWith('--destino='))?.slice('--destino='.length);
const CONFIGS_ARG = process.argv.find((a) => a.startsWith('--configs='))?.slice('--configs='.length).split(',').filter(Boolean) ?? [];
const CONFIGS_MAX = 4; // configs em SOL a varrer quando as transações trazem poucos pools com fee
const GIVEN = process.argv.find((a) => a.startsWith('--carteiras='))?.slice('--carteiras='.length).split(',').filter(Boolean);
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
// assinatura falsa: só a simulação com sigVerify desligado aceita
const fakeSigner = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });

type Acc = { data?: [string, string]; lamports?: number; owner?: string } | null;

async function accounts(keys: string[], slice?: { offset: number; length: number }): Promise<Map<string, NonNullable<Acc>>> {
  const out = new Map<string, NonNullable<Acc>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed', ...(slice ? { dataSlice: slice } : {}) }]);
    chunk.forEach((k, j) => r.value[j] && out.set(k, r.value[j]!));
  }
  return out;
}

async function recentKeys(): Promise<{ keys: string[]; payers: string[] }> {
  const keys = new Set<string>();
  const payers = new Set<string>();
  let before: string | undefined;
  let left = TXS;
  while (left > 0) {
    const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [PROGRAMS.meteoraDbc, { limit: Math.min(left, 1000), ...(before ? { before } : {}) }]);
    if (!sigs.length) break;
    left -= sigs.length;
    before = sigs.at(-1)!.signature;
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await rpc
        .call<{ transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
        .catch(() => null);
      const k = [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
      k.forEach((x) => keys.add(x));
      if (k[0]) payers.add(k[0]);
    }
  }
  return { keys: [...keys], payers: [...payers] };
}

async function main() {
  let creators: string[];
  let payers: string[];
  if (GIVEN) {
    creators = GIVEN;
    ({ payers } = await recentKeys());
  } else {
    console.log(`Lendo ${TXS} transações recentes da Meteora DBC…`);
    const r = await recentKeys();
    payers = r.payers;
    const data = await accounts(r.keys);
    const pools = [...data].map(([k, a]) => ({ k, a, p: a.owner === PROGRAMS.meteoraDbc ? parseDbcPool(Buffer.from(a.data?.[0] ?? '', 'base64')) : null })).filter((x) => x.p);
    const cfg = await accounts([...new Set(pools.map((x) => x.p!.config))], DBC_CONFIG_SLICE);
    const solPools = pools.filter((x) => parseDbcConfigQuote(Buffer.from(cfg.get(x.p!.config)?.data?.[0] ?? '', 'base64')) === WSOL_MINT);
    const withFee = solPools.filter((x) => x.p!.quoteFee > 0n && !x.p!.hook);
    const owners = await accounts([...new Set(withFee.map((x) => x.p!.creator))]);
    const common = withFee.filter((x) => owners.get(x.p!.creator)?.owner === PROGRAMS.system);
    console.log(`${pools.length} pools da DBC (${pools.filter((x) => x.p!.hook).length} com transfer hook), ${solPools.length} em SOL, ${withFee.length} com creator fee em SOL, ${common.length} de carteira comum (criador existe e é do System Program).`);
    for (const x of common) console.log(`  pool ${x.k} criador ${x.p!.creator} fee ${sol(x.p!.quoteFee)} SOL${x.p!.migrated ? ' (migrado)' : ''}`);
    creators = [...new Set(common.sort((a, b) => Number(b.p!.quoteFee - a.p!.quoteFee)).map((x) => x.p!.creator))].slice(0, WANT);
    // Poucas transações trazem poucos pools: procura também nas configs em SOL desses pools (todos os pools de cada
    // config, só as fees, 1 getProgramAccounts por config), os de maior fee primeiro
    const configs = [...new Set([...CONFIGS_ARG, ...solPools.map((x) => x.p!.config).slice(0, CONFIGS_MAX)])];
    for (const c of configs) {
      if (creators.length >= WANT) break;
      const list = await rpc.call<Array<{ pubkey: string; account: { data: [string, string] } }>>('getProgramAccounts', [
        PROGRAMS.meteoraDbc,
        { encoding: 'base64', dataSlice: { offset: 360, length: 8 }, filters: [{ dataSize: 424 }, { memcmp: { offset: 72, bytes: c } }] },
      ]);
      const top = list.map((x) => ({ k: x.pubkey, fee: Buffer.from(x.account.data[0], 'base64').readBigUInt64LE(0) })).filter((x) => x.fee > 0n).sort((a, b) => Number(b.fee - a.fee)).slice(0, 40);
      const full = await accounts(top.map((x) => x.k));
      const found = [...full].map(([k, a]) => ({ k, p: a.owner === PROGRAMS.meteoraDbc ? parseDbcPool(Buffer.from(a.data?.[0] ?? '', 'base64')) : null })).filter((x) => x.p && !x.p.hook && x.p.quoteFee > 0n);
      const own = await accounts([...new Set(found.map((x) => x.p!.creator))]);
      const ok = found.filter((x) => own.get(x.p!.creator)?.owner === PROGRAMS.system && !creators.includes(x.p!.creator));
      console.log(`  config ${c}: ${list.length} pools, ${top.length} com fee em SOL lidos, ${ok.length} de carteira comum`);
      for (const x of ok.slice(0, WANT - creators.length)) {
        console.log(`    pool ${x.k} criador ${x.p!.creator} fee ${sol(x.p!.quoteFee)} SOL${x.p!.migrated ? ' (migrado)' : ''}`);
        creators.push(x.p!.creator);
      }
    }
  }
  // pagadora e destino: carteiras comuns com SOL que assinaram transações recentes (nada é enviado)
  const payerInfo = await accounts(payers.slice(0, 80));
  const rich = [...payerInfo].filter(([k, a]) => a.owner === PROGRAMS.system && (a.lamports ?? 0) > 100_000_000 && !creators.includes(k)).sort((x, y) => (y[1].lamports ?? 0) - (x[1].lamports ?? 0)).map(([k]) => k);
  if (rich.length < (DEST_ARG ? 1 : 2)) throw new Error('sem carteira com SOL para pagadora e destino');
  const payer = rich[0];
  const dest = DEST_ARG ?? rich[1];
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  console.log(`Destino: ${DEST_ARG ? 'informado' : 'carteira comum de transação recente'} (existe na rede). Taxa do app: ${appFeeFor(dest) ? '11%' : 'nenhuma'}.`);

  let ok = 0;
  let tried = 0;
  for (const creator of creators) {
    const scans: WalletScan[] = await scanWallets(rpc, [{ index: 0, address: payer }, { index: 1, address: creator }], cleanupScanOptions(rent0));
    const s = scans.find((x) => x.address === creator)!;
    if (s.errors.length || !s.fees || s.fees.dbcError) {
      console.log(`  ${creator} leitura com erro: ${[...s.errors, s.fees?.dbcError ?? ''].filter(Boolean).join(' | ')}`);
      continue;
    }
    const d = s.fees.dbc!;
    const read = dbcClaimLamports(d);
    // só a coleta da Meteora: o resto da carteira do criador não é assunto aqui
    scans[1] = { ...s, tokens: [], fees: { ...s.fees, bondingVaultLamports: 0, ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], shared: [], cashback: { pump: 0n, amm: 0n }, uva: [] } };
    const plan = buildPlan({ scans, prices: new Map(), destination: dest, rentExemptZero: rent0 });
    plan.steps = plan.steps.filter((st) => st.kind === 'claim-dbc');
    plan.appFee = appFeeFor(dest);
    if (!plan.steps.length) {
      console.log(`  ${creator} ${d.found} pools, fee em SOL lida ${sol(read)} (abaixo do mínimo de coleta ou zero): sem passo; fora do total ${d.other}`);
      continue;
    }
    tried++;
    const signers = new Map([fakeSigner(payer, 0), fakeSigner(creator, 1)].map((x) => [x.index, x]));
    const payerRole = plan.feePayer === creator ? 'criador é a pagadora' : 'pagadora separada';
    try {
      const sims = await execute({ rpc, plan, signers, mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
      const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
      const shown = r.toDestination.claimLamports; // linha "Creator fees e cashback" da Confirmar: bruto
      const dests = sims.reduce((a, x) => a + (x.destinationDelta ?? 0n), 0n);
      const fees = sims.reduce((a, x) => a + (x.appFeeDelta ?? 0n), 0n);
      const after = (await scanWallets(rpc, [{ index: 1, address: creator }], cleanupScanOptions(rent0)))[0];
      const reread = after.fees?.dbc ? dbcClaimLamports(after.fees.dbc) : null;
      const verdict = shown === read ? 'igual à leitura' : reread !== null && shown <= reread && shown >= read ? 'cresceu no meio (moeda negociando)' : shown < read ? `A MENOS (${sol(read - shown)})` : 'A MAIS QUE AS DUAS LEITURAS';
      if (sims.every((x) => x.status === 'simulado')) ok++;
      const st = sims.map((x) => `${x.step.kind}(${x.step.kind === 'claim-dbc' ? x.step.pools.length : ''})=${x.status}${x.detail ? ` (${x.detail.slice(0, 90)})` : ''}`).join(', ');
      console.log(`  ${creator} [${payerRole}] ${d.found} pools; lida ${sol(read)}, depois ${reread === null ? '?' : sol(reread)} | Confirmar ${sol(shown)} → destino ${sol(dests)} + taxa ${sol(fees)} (${dests + fees === shown ? 'soma = mostrado' : 'SOMA ≠ MOSTRADO'}) → ${verdict} | ${st}`);
      for (const x of sims.filter((y) => y.status === 'falhou')) console.log(`      falhou: ${x.detail}`);
    } catch (e) {
      console.log(`  ${creator} PAROU: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${ok} de ${tried} coletas simuladas aceitas pelo programa (o executor confere destino e taxa exatos). Nada foi enviado: só simulações.`);
}

await main();
