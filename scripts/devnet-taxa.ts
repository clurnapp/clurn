// Teste real da taxa do app na DEVNET (dinheiro de mentira), com o núcleo do app de verdade:
// descobre as temporárias, lê, monta o plano, EXECUTA e confere na blockchain que o destino recebeu 89% e a
// carteira da taxa 11% de cada passo (na pagadora, menos o depósito do cliente), batendo com o que o executor relatou.
//
//   node scripts/devnet-preparar.ts C:\fora\do\repo\frase-devnet.txt   (cria o cenário e a carteira da taxa)
//   node scripts/devnet-taxa.ts C:\fora\do\repo\frase-devnet.txt
//
// Só devnet: a URL é fixa e o script recusa outra. A frase fica só na memória; nada dela é impresso.

import fs from 'node:fs';
import { APP_FEE_BPS, APP_FEE_WALLET, appFeeLamports } from '../src/core/limpeza/app-fee.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../src/core/carteiras/derivation.ts';
import { execute, explorerLink } from '../src/core/limpeza/executor.ts';
import { buildPlan, describeStep, type TokenDecision } from '../src/core/limpeza/plan.ts';
import { createRpc } from '../src/core/solana/rpc.ts';
import { cleanupScanOptions, discoverBurners, scanWallets } from '../src/core/limpeza/scan.ts';
import { isInsideRepo } from '../src/cli/io.ts';
import type { Signer } from '../src/core/solana/tx.ts';

const DEVNET = 'https://api.devnet.solana.com';
const rpc = createRpc({ url: DEVNET, requestsPerSecond: 3 });
const sol = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

async function lamports(a: string): Promise<number> {
  return (await rpc.call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value;
}

async function main() {
  const file = process.argv[2];
  if (!file || isInsideRepo(file) || !fs.existsSync(file)) throw new Error('informe o arquivo da frase de teste da devnet (fora do repositório), criado por scripts/devnet-preparar.ts');
  const seed = mnemonicToSeed(fs.readFileSync(file, 'utf8'));
  const destination = deriveMainAddress(seed);
  let signers: Map<number, Signer>;
  let discovery;
  try {
    discovery = await discoverBurners(seed, rpc, { max: 40 });
    signers = new Map(discovery.wallets.map((w) => [w.index, burnerSigner(seed, w.index)]));
  } finally {
    seed.fill(0);
  }
  console.log(`${discovery.wallets.length} temporárias na devnet; destino = principal ${destination}`);
  const rent0 = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  const scans = await scanWallets(rpc, discovery.wallets, cleanupScanOptions(rent0));
  // queima o token sem preço do cenário (fungível); NFT e conta congelada ficam, como o app faz
  const decisions = new Map<string, TokenDecision>();
  for (const s of scans) for (const t of s.tokens) if (t.kind === 'fungible' && !t.blockers.length) decisions.set(t.account, 'burn');
  const plan = buildPlan({ scans, prices: new Map(), destination, rentExemptZero: rent0, decisions });
  if (!plan.appFee || plan.appFee.wallet !== APP_FEE_WALLET) throw new Error('plano sem a taxa do app');
  console.log(`Plano: ${plan.steps.length} passos, pagadora N=${plan.feePayerIndex}, taxa ${Number(APP_FEE_BPS) / 100}% para ${APP_FEE_WALLET}`);
  for (const s of plan.steps) console.log(`  - ${describeStep(s)}`);

  const [destBefore, feeBefore] = [await lamports(destination), await lamports(APP_FEE_WALLET)];
  const results = await execute({ rpc, plan, signers, mode: 'execute', onResult: (r) => console.log(`  ${r.status.padEnd(12)} ${r.description}${r.signature ? `  ${explorerLink(r.signature, 'devnet')}` : ''}${r.detail ? `  (${r.detail})` : ''}`) });
  const [destAfter, feeAfter] = [await lamports(destination), await lamports(APP_FEE_WALLET)];

  const sent = results.filter((r) => r.status === 'enviado');
  const reportedDest = sent.reduce((a, r) => a + (r.destinationDelta ?? 0n), 0n);
  const reportedFee = sent.reduce((a, r) => a + (r.appFeeDelta ?? 0n), 0n);
  const chainDest = BigInt(destAfter - destBefore);
  const chainFee = BigInt(feeAfter - feeBefore);
  // por passo: taxa = 11% (arredondado para baixo) do que o passo entregou. Regra de 31/10/2026: a pagadora também
  // paga sobre o SOL esquecido nela; isento só o depósito do cliente para as taxas (plan.payerExemptLamports)
  const exempt = plan.payerExemptLamports ?? 0n;
  const perStep = sent.map((r) => {
    const fee = r.appFeeDelta ?? 0n;
    const total = (r.destinationDelta ?? 0n) + fee;
    const payerSweep = r.step.kind === 'sweep-sol' && r.step.isFeePayer;
    const base = payerSweep ? (total > exempt ? total - exempt : 0n) : total;
    return { ok: fee === appFeeLamports(base, plan.appFee ?? null), r, total, fee };
  });
  console.log('\nConferência na blockchain:');
  console.log(`  destino recebeu        ${sol(chainDest)} SOL (executor relatou ${sol(reportedDest)})`);
  console.log(`  carteira da taxa       ${sol(chainFee)} SOL (executor relatou ${sol(reportedFee)})`);
  for (const p of perStep) console.log(`  ${p.ok ? 'ok  ' : 'ERRO'} ${p.r.description}: entregou ${sol(p.total)}, taxa ${sol(p.fee)}`);
  const failures = results.filter((r) => r.status !== 'enviado' && r.status !== 'nada a fazer');
  const ok = chainDest === reportedDest && chainFee === reportedFee && perStep.every((p) => p.ok) && reportedFee > 0n;
  console.log(`\n${ok ? 'PASSOU' : 'FALHOU'}: ${sent.length} transações, ${failures.length} passo(s) sem envio (esperado: conta congelada e NFT ficam fora do plano, não falham).`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'erro');
  process.exit(1);
});
