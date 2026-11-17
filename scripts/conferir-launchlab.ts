// Confere na mainnet, SEM enviar nada e sem frase, a coleta da creator fee do Raydium LaunchLab (bonk.fun e outros)
// pelo app inteiro: leitura (scanWallets), plano, executor (simulação, assinaturas falsas: a rede não confere) e recibo.
// Criadores públicos com fee em SOL parada no cofre: achados entre os cofres de creator fee em WSOL (1
// getTokenAccountsByOwner da authority dos cofres, só o saldo), pela transação mais recente de cada cofre (o pool dela
// diz o criador); ou passados em --carteiras.
//
//   node scripts/conferir-launchlab.ts [criadores=6] [--destino=<endereço>] [--carteiras=a,b]
//
// Também simula, crua, a coleta assinada por quem NÃO é o criador (o cofre de outro): tem que ser recusada.
//
// --destino: carteira comum que já existe na rede (padrão: uma das pagadoras de transações recentes, que não é o
// criador nem a pagadora usada aqui). O executor confere, na simulação, que o destino e a carteira da taxa recebem
// exatamente o esperado (89/11); qualquer diferença PARA (e aparece aqui como "PAROU").
// O cofre é lido de novo DEPOIS da simulação: mostrado acima da 1ª leitura e igual à 2ª = moeda negociando no meio.
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa. Nada é assinado nem enviado.

import { buildReceipt } from '../src/app/receipt.ts';
import { appFeeFor } from '../src/core/limpeza/app-fee.ts';
import { execute } from '../src/core/limpeza/executor.ts';
import { LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault } from '../src/core/limpeza/launchlab.ts';
import { buildPlan } from '../src/core/limpeza/plan.ts';
import { cleanupScanOptions, scanWallets, type WalletScan } from '../src/core/limpeza/scan.ts';
import { decodeBase58, encodeBase58 } from '../src/core/solana/base58.ts';
import { launchlabClaimCreatorFee, ataCreateIdempotent } from '../src/core/solana/instructions.ts';
import { isOnCurve, PROGRAMS, WSOL_MINT } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';
import { buildTransaction, type Signer } from '../src/core/solana/tx.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, timeoutMs: 120_000, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
const WANT = nums[0] ?? 6;
const DEST_ARG = process.argv.find((a) => a.startsWith('--destino='))?.slice('--destino='.length);
const GIVEN = process.argv.find((a) => a.startsWith('--carteiras='))?.slice('--carteiras='.length).split(',').filter(Boolean);
const LL = PROGRAMS.raydiumLaunchlab;
const POOL_BYTES = 429;
const POOL_CREATOR = 333; // PoolState.creator (com o discriminador), IDL 0.2.0
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
const fakeSigner = (address: string, index: number): Signer & { index: number } => ({ address, index, sign: () => new Uint8Array(64) });

type Acc = { data?: [string, string]; lamports?: number; owner?: string } | null;
async function accounts(keys: string[]): Promise<Map<string, NonNullable<Acc>>> {
  const out = new Map<string, NonNullable<Acc>>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await rpc.call<{ value: Acc[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }]);
    chunk.forEach((k, j) => r.value[j] && out.set(k, r.value[j]!));
  }
  return out;
}
type Tx = { transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null;
const keysOf = (tx: Tx) => [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
const getTx = (sig: string) => rpc.call<Tx>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);

// criador de um cofre: pela transação mais recente dele (troca com o pool; o pool tem o criador)
async function creatorOf(vault: string): Promise<string | null> {
  const sigs = await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [vault, { limit: 2 }]);
  for (const s of sigs) {
    const keys = keysOf(await getTx(s.signature));
    const cands = new Set(keys);
    for (const [, a] of await accounts(keys.slice(0, 100))) {
      const d = Buffer.from(a.data?.[0] ?? '', 'base64');
      if (a.owner === LL && d.length === POOL_BYTES) cands.add(encodeBase58(d.subarray(POOL_CREATOR, POOL_CREATOR + 32)));
    }
    const c = [...cands].find((k) => launchlabCreatorFeeVault(k) === vault);
    if (c) return c;
  }
  return null;
}

async function recentPayers(): Promise<string[]> {
  const sigs = await rpc.call<Array<{ signature: string; err: unknown }>>('getSignaturesForAddress', [LL, { limit: 1000 }]);
  const out = new Set<string>();
  for (const s of sigs.filter((x, i) => !x.err && i % 20 === 0)) { // espalhadas: os robôs repetem as mesmas pagadoras
    const k = keysOf(await getTx(s.signature));
    if (k[0]) out.add(k[0]);
  }
  return [...out];
}

async function main() {
  let creators: string[];
  if (GIVEN) creators = GIVEN;
  else {
    const r = await rpc.call<{ value: Array<{ pubkey: string; account: { data: [string, string] } }> }>('getTokenAccountsByOwner', [
      LAUNCHLAB_FEE_VAULT_AUTH,
      { mint: WSOL_MINT },
      { encoding: 'base64', dataSlice: { offset: 64, length: 8 }, commitment: 'confirmed' },
    ]);
    const vaults = r.value.map((x) => ({ v: x.pubkey, amt: Buffer.from(x.account.data[0], 'base64').readBigUInt64LE(0) }));
    // espalhados entre 0,005 e 1 SOL (não só os maiores): caso típico de temporária esquecida
    const mid = vaults.filter((x) => x.amt > 5_000_000n && x.amt < 1_000_000_000n).sort((a, b) => Number(b.amt - a.amt));
    console.log(`${vaults.length} cofres de creator fee em WSOL; ${mid.length} entre 0,005 e 1 SOL.`);
    creators = [];
    for (let i = 0; i < 40 && creators.length < WANT; i++) {
      const x = mid[Math.floor((i * mid.length) / 40)];
      const c = await creatorOf(x.v);
      if (!c || !isOnCurve(decodeBase58(c))) continue;
      const a = (await accounts([c])).get(c);
      if (a && a.owner !== PROGRAMS.system) continue;
      console.log(`  cofre ${x.v} ${sol(x.amt)} SOL, criador ${c} (${a ? 'carteira comum' : 'carteira comum sem saldo'})`);
      creators.push(c);
    }
  }
  const payers = await recentPayers();
  const payerInfo = await accounts(payers);
  const rich = [...payerInfo].filter(([k, a]) => a.owner === PROGRAMS.system && (a.lamports ?? 0) > 100_000_000 && !creators.includes(k)).sort((x, y) => (y[1].lamports ?? 0) - (x[1].lamports ?? 0)).map(([k]) => k);
  if (rich.length < (DEST_ARG ? 1 : 2)) throw new Error('sem carteira com SOL para pagadora e destino');
  const payer = rich[0];
  const dest = DEST_ARG ?? rich[1];
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  console.log(`Destino: ${DEST_ARG ? 'informado' : 'carteira comum de transação recente'} (existe na rede). Taxa do app: ${appFeeFor(dest) ? '11%' : 'nenhuma'}.`);

  // quem não é o criador não coleta o cofre de outro: o endereço do cofre sai da chave de quem assina
  if (creators[0]) {
    const { blockhash } = (await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const ixs = [ataCreateIdempotent(payer, payer, WSOL_MINT, PROGRAMS.token), launchlabClaimCreatorFee(payer, LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault(creators[0]))];
    const tx = buildTransaction(payer, ixs, blockhash, [fakeSigner(payer, 0)]);
    const sim = await rpc.call<{ value: { err: unknown; logs?: string[] } }>('simulateTransaction', [Buffer.from(tx.bytes).toString('base64'), { encoding: 'base64', sigVerify: false, commitment: 'confirmed' }]);
    console.log(`Coleta do cofre de ${creators[0].slice(0, 6)}… assinada por outra carteira: ${sim.value.err ? `recusada (${JSON.stringify(sim.value.err)}; ${(sim.value.logs ?? []).filter((l) => /Error|failed/i.test(l)).slice(-1)[0] ?? ''})` : 'ACEITA (inesperado)'}`);
  }

  let ok = 0;
  let tried = 0;
  for (const creator of creators) {
    const scans: WalletScan[] = await scanWallets(rpc, [{ index: 0, address: payer }, { index: 1, address: creator }], cleanupScanOptions(rent0));
    const s = scans.find((x) => x.address === creator)!;
    if (s.errors.length || !s.fees || s.fees.launchlabError) {
      console.log(`  ${creator} leitura com erro: ${[...s.errors, s.fees?.launchlabError ?? ''].filter(Boolean).join(' | ')}`);
      continue;
    }
    const read = s.fees.launchlab?.lamports ?? 0n;
    // só a coleta do LaunchLab: o resto da carteira do criador não é assunto aqui
    scans[1] = { ...s, tokens: [], fees: { ...s.fees, bondingVaultLamports: 0, ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], shared: [], cashback: { pump: 0n, amm: 0n }, uva: [], dbc: { pools: [], found: 0, other: 0, cut: 0 } } };
    const plan = buildPlan({ scans, prices: new Map(), destination: dest, rentExemptZero: rent0 });
    plan.steps = plan.steps.filter((st) => st.kind === 'claim-launchlab');
    plan.appFee = appFeeFor(dest);
    if (!plan.steps.length) {
      console.log(`  ${creator} fee em SOL lida ${sol(read)} (abaixo do mínimo de coleta ou zero): sem passo; outras moedas ${s.fees.launchlab?.other ?? 0}`);
      continue;
    }
    tried++;
    const signers = new Map([fakeSigner(payer, 0), fakeSigner(creator, 1)].map((x) => [x.index, x]));
    try {
      const sims = await execute({ rpc, plan, signers, mode: 'simulate', skipSignatureCheck: true, priority: 'off' });
      const r = buildReceipt({ plan, simResults: sims, holdings: [], main: null });
      const shown = r.toDestination.claimLamports;
      const dests = sims.reduce((a, x) => a + (x.destinationDelta ?? 0n), 0n);
      const fees = sims.reduce((a, x) => a + (x.appFeeDelta ?? 0n), 0n);
      const after = (await scanWallets(rpc, [{ index: 1, address: creator }], cleanupScanOptions(rent0)))[0];
      const reread = after.fees?.launchlab ? after.fees.launchlab.lamports : null;
      // a ATA WSOL que a temporária já tinha vai junto ao destino, na linha "contas fechadas" da Confirmar (não em creator fees)
      const closed = sims.reduce((a, x) => a + (x.closedRentLamports ?? 0n), 0n);
      const verdict = shown === read ? 'igual à leitura' : reread !== null && shown <= reread && shown >= read ? 'cresceu no meio (moeda negociando)' : shown < read ? `A MENOS (${sol(read - shown)})` : 'A MAIS QUE AS DUAS LEITURAS';
      const sumOk = dests + fees === shown + closed;
      if (sims.every((x) => x.status === 'simulado') && sumOk && shown >= read) ok++;
      const st = sims.map((x) => `${x.step.kind}=${x.status}${x.detail ? ` (${x.detail.slice(0, 90)})` : ''}`).join(', ');
      const empty = s.lamports === 0 ? 'temporária vazia' : 'com saldo';
      const ata = closed > 0n ? ` + ATA WSOL antiga ${sol(closed)} (contas fechadas)` : '';
      console.log(`  ${creator} [${empty}] lida ${sol(read)}, depois ${reread === null ? '?' : sol(reread)} | Confirmar ${sol(shown)}${ata} → destino ${sol(dests)} + taxa ${sol(fees)} (${sumOk ? 'soma = mostrado' : 'SOMA ≠ MOSTRADO'}) → ${verdict} | ${st}`);
      for (const x of sims.filter((y) => y.status === 'falhou')) console.log(`      falhou: ${x.detail}`);
    } catch (e) {
      console.log(`  ${creator} PAROU: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`\n${ok} de ${tried} coletas simuladas aceitas pelo programa (o executor confere destino e taxa exatos). Nada foi enviado: só simulações.`);
}

await main();
