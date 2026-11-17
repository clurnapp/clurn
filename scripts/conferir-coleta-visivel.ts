// Confere na mainnet, SEM enviar nada e sem frase, que a creator fee lida na análise é a que a tela Confirmar mostra.
// Achado de 31/10/2026: a coleta do PumpSwap e a coleta na pagadora deixavam a fee na carteira, a simulação contava
// 0 e a execução levava a fee junto do SOL (test/limpeza/claim-visivel.test.ts prende na rede falsa). Aqui são as
// transações novas do app contra os programas de verdade: criadores públicos com fee na curva e no PumpSwap, a
// mesma varredura, plano, executor (simulação, assinaturas falsas: a rede não confere) e recibo do app.
//
//   node scripts/conferir-coleta-visivel.ts [transacoes=60] [criadores=6] [--destino=<endereço>] [--pequenas] [--carteiras=a,b]
//
// --destino: carteira que já existe na rede, como no app (padrão: endereço novo, que só recebe a partir do aluguel
// mínimo). Com a carteira da taxa do app como destino, não há os 11% (regra do app). --pequenas: inclui cofres com
// menos de 0,001 SOL (o caso em que o endereço novo recusa). --carteiras: confere estes criadores em vez de procurar.
// A fee é lida de novo DEPOIS da simulação: mostrado acima da 1ª leitura e igual à 2ª = moeda negociando; acima das
// duas = contado a mais (defeito).
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa. Nada é assinado nem enviado.

import { buildReceipt } from '../src/app/receipt.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { cleanupScanOptions, CURVE_SLICE, parseCurve, parsePool, POOL_SLICE, scanWallets, totalCreatorFeeLamports, type WalletScan } from '../src/core/limpeza/scan.ts';
import { randomBytes } from 'node:crypto';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { anchorAccountDiscriminator, PROGRAMS, pumpAmmCreatorVaultAta, pumpCreatorVault } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import type { Signer } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const TXS = nums[0] ?? 60;
const WANT = nums[1] ?? 6;
const DEST_ARG = process.argv.find((a) => a.startsWith('--destino='))?.slice('--destino='.length);
const SMALL = process.argv.includes('--pequenas');
const GIVEN = process.argv.find((a) => a.startsWith('--carteiras='))?.slice('--carteiras='.length).split(',').filter(Boolean);
const CURVE_DISC = anchorAccountDiscriminator('BondingCurve');
const POOL_DISC = anchorAccountDiscriminator('Pool');
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
// assinatura falsa: só a simulação com sigVerify desligado aceita
const fakeSigner = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });

type Acc = { data?: [string, string]; lamports?: number; owner?: string } | null;

async function keysOfRecent(program: string): Promise<{ keys: string[]; payers: string[] }> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [program, { limit: TXS }]);
  const keys = new Set<string>();
  const payers = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await rpc
      .call<{ transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }])
      .catch(() => null);
    const k = [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
    k.forEach((x) => keys.add(x));
    if (k[0]) payers.add(k[0]);
  }
  return { keys: [...keys], payers: [...payers] };
}

async function accounts(keys: string[]): Promise<Map<string, NonNullable<Acc>>> {
  const out = new Map<string, NonNullable<Acc>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    chunk.forEach((k, j) => r.value[j] && out.set(k, r.value[j]!));
  }
  return out;
}

async function main() {
  console.log(`Lendo ${TXS} transações recentes da Pump.fun e do PumpSwap…`);
  const [pump, amm] = [await keysOfRecent(PROGRAMS.pump), await keysOfRecent(PROGRAMS.pumpAmm)];
  const data = await accounts([...new Set([...pump.keys, ...amm.keys])]);
  // criadores (BondingCurve.creator @49, Pool.coin_creator @211) com fee parada ou no cofre
  const creators = new Set<string>();
  for (const [, a] of data) {
    const b = Buffer.from(a.data?.[0] ?? '', 'base64');
    if (b.length >= 133 && b.subarray(0, 8).equals(CURVE_DISC) && parseCurve(b.subarray(CURVE_SLICE.offset, CURVE_SLICE.offset + CURVE_SLICE.length)).collectable) creators.add(encodeBase58(b.subarray(49, 81)));
    if (b.length >= 287 && b.subarray(0, 8).equals(POOL_DISC) && parsePool(b.subarray(POOL_SLICE.offset, POOL_SLICE.offset + POOL_SLICE.length)).collectable) creators.add(encodeBase58(b.subarray(211, 243)));
  }
  // só carteira comum (PDA de fee sharing ou de holders não é carteira que o app limpa)
  const owners = await accounts([...creators]);
  const wallets = [...creators].filter((c) => !owners.has(c) || owners.get(c)!.owner === PROGRAMS.system);
  // com algo nos cofres (dá para ver a fee na tela) — os dois cofres, lidos de uma vez
  const vaults = await accounts(wallets.flatMap((w) => [pumpCreatorVault(w), pumpAmmCreatorVaultAta(w)]));
  const withFee = GIVEN ?? wallets.filter((w) => vaults.has(pumpAmmCreatorVaultAta(w)) || (vaults.get(pumpCreatorVault(w))?.lamports ?? 0) > (SMALL ? 650_240 : 1_000_000)).slice(0, WANT);
  console.log(`${creators.size} criadores, ${wallets.length} carteiras comuns, ${withFee.length} com cofre para conferir.`);
  // pagadora: carteira comum com SOL que assinou transações (nada é enviado). Destino: endereço novo, sem movimento
  // (uma carteira que negocia muda de saldo entre a leitura e a simulação, e o app PARA, como deve; o destino de
  // verdade é a carteira parada da pessoa). Endereço novo só recebe a partir do aluguel mínimo: fee menor falha.
  const payerInfo = await accounts(pump.payers.slice(0, 60));
  const rich = [...payerInfo].filter(([k, a]) => a.owner === PROGRAMS.system && (a.lamports ?? 0) > 200_000_000 && !withFee.includes(k)).map(([k, a]) => ({ k, l: a.lamports! })).sort((x, y) => y.l - x.l);
  if (!rich.length) throw new Error('sem carteira com SOL para pagadora');
  const payer = rich[0].k;
  const dest = DEST_ARG ?? encodeBase58(randomBytes(32));
  console.log(`Destino: ${DEST_ARG ? 'informado (já existe na rede)' : 'endereço novo'}.`);
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);

  let ok = 0;
  for (const creator of withFee) {
    const scans: WalletScan[] = await scanWallets(rpc, [{ index: 0, address: payer }, { index: 1, address: creator }], cleanupScanOptions(rent0));
    const s = scans.find((x) => x.address === creator)!;
    if (s.errors.length || !s.fees) {
      console.log(`  ${creator} leitura com erro: ${s.errors.join(' | ')}`);
      continue;
    }
    const read = totalCreatorFeeLamports(s.fees);
    // só as coletas: o resto da carteira do criador não é assunto aqui
    scans[1] = { ...s, tokens: [] };
    const plan = buildPlan({ scans, prices: new Map(), destination: dest, rentExemptZero: rent0 });
    plan.steps = plan.steps.filter((st) => st.kind === 'claim-curve' || st.kind === 'claim-amm');
    plan.appFee = appFeeFor(dest);
    if (!plan.steps.length) {
      console.log(`  ${creator} fee lida ${sol(read)} SOL abaixo do mínimo de coleta: sem passo`);
      continue;
    }
    const signers = new Map([fakeSigner(payer, 0), fakeSigner(creator, 1)].map((x) => [x.index, x]));
    try {
      const sims = await execute({ rpc, plan, signers, mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
      const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
      const shown = r.toDestination.claimLamports; // linha "Creator fees" da Confirmar: bruto (os 11% saem na linha da taxa)
      const st = sims.map((x) => `${x.step.kind}${x.step.kind !== 'tokens' && x.step.kind !== 'sweep-sol' && 'sweepOnly' in x.step && x.step.sweepOnly ? '(varrer)' : ''}=${x.status}${x.detail ? ` (${x.detail.slice(0, 80)})` : ''}`).join(', ');
      const after = (await scanWallets(rpc, [{ index: 1, address: creator }], cleanupScanOptions(rent0)))[0];
      const reread = after.fees ? totalCreatorFeeLamports(after.fees) : null;
      const verdict = shown <= read + 1000n ? 'igual' : reread !== null && shown <= reread + 1000n ? 'cresceu (moeda negociando)' : 'A MAIS QUE AS DUAS LEITURAS';
      if (sims.every((x) => x.status === 'simulado')) ok++;
      console.log(`  ${creator} lida ${sol(read)}, depois ${reread === null ? '?' : sol(reread)} | Confirmar (creator fees) ${sol(shown)}, taxa ${sol(r.appFeeLamports)} → ${verdict} | ${st}`);
      for (const x of sims.filter((y) => y.status === 'falhou')) console.log(`      falhou: ${x.detail}`);
    } catch (e) {
      console.log(`  ${creator} PAROU: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${ok} de ${withFee.length} com todas as coletas simuladas. Nada foi enviado: só simulações.`);
}

await main();
