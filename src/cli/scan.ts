// Varredura SÓ LEITURA das carteiras temporárias de uma frase de recuperação.
// Não assina, não envia, não mexe em nada. Mostra o que daria para recuperar.
//
// Uso:
//   npm run scan                                   (pede a frase com digitação oculta)
//   npm run scan -- --seed-file C:\fora\do\repo\frase.txt
//   npm run scan -- --frase-publica-teste          (frase pública "abandon ... about", para testar)
//
// Opções: --max 2000  --folga 20  --relatorio  --debug
// Lê como o app e o limpar (cleanupScanOptions), com a fee "não varrida" dentro das moedas.
// RPC: variável de ambiente SOLANA_RPC_URL (padrão: RPC público da Solana).

import path from 'node:path';
import { parseArgs } from 'node:util';
import { closeInput, readMnemonic, REPO_ROOT, short, usd, UserError, writeReport } from './io.ts';
import { deriveMainAddress, mnemonicToSeed, mnemonicWordCount, PHANTOM_MAIN_INDEX, walletLabel, type WalletApp } from '../core/carteiras/derivation.ts';
import { reviewPhantomAccounts } from '../core/carteiras/accounts.ts';
import { createRpc, describeRpc, PUBLIC_RPC_LIMITS, RpcError } from '../core/solana/rpc.ts';
import { checkRpc, networkGuarded, rpcProblemMessage } from '../core/solana/rpc-check.ts';
import { withGpaFallback } from '../core/solana/gpa-fallback.ts';
import { cleanupScanOptions, discoverBurners, scanWallets, SEARCH_GAP, SEARCH_MAX } from '../core/limpeza/scan.ts';
import { applyCurves, fetchPrices } from '../core/limpeza/prices.ts';
import { readCurves } from '../core/limpeza/curve-price.ts';
import { formatSol, formatTokenAmount, summarize, type Summary } from '../core/limpeza/summary.ts';
import { explainError, formatErrorPt } from '../core/limpeza/errors.ts';
import { buildPlan, FeePayerError, PlanError } from '../core/limpeza/plan.ts';
import { evmAddress } from '../core/evm/evm.ts';
import { scanEvm } from '../core/evm/evm-scan.ts';
import { EVM_ACCOUNTS, printEvm } from './outras-redes.ts';


const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

function printSummary(s: Summary, solUsd: number | null, label: (i: number) => string = (i) => `N=${i}`) {
  const t = s.totals;
  console.log('\nPor carteira (só as que têm algo):');
  console.log('  carteira  endereço      SOL solto    contas p/ fechar  aluguel       creator fees  escolha  bloq  erros');
  for (const w of s.wallets) {
    if (!w.solLamports && !w.closable && !w.creatorFeeLamports && !w.pendingChoice && !w.blocked && !w.errors.length) continue;
    console.log(
      `  ${label(w.index).padEnd(9)} ${short(w.address).padEnd(12)}  ${formatSol(w.solLamports).padStart(10)}  ${String(w.closable).padStart(16)}  ${formatSol(w.closableRentLamports).padStart(10)}  ${formatSol(w.creatorFeeLamports).padStart(12)}  ${String(w.pendingChoice).padStart(7)}  ${String(w.blocked).padStart(4)}  ${w.errors.length || ''}`,
    );
  }

  const net = t.recoverableLamports;
  const netUsd = solUsd ? ` (≈ US$ ${((Number(net) / 1e9) * solUsd).toFixed(2).replace('.', ',')})` : '';
  console.log('\nTotal estimado (simulação):');
  console.log(`  SOL solto nas temporárias        ${formatSol(t.solLamports)} SOL`);
  console.log(`  Aluguel de ${String(t.closable).padEnd(4)} contas p/ fechar  ${formatSol(t.closableRentLamports)} SOL`);
  console.log(`  Creator fees da Pump.fun         ${formatSol(t.creatorFeeLamports)} SOL${s.feesDetailed ? '' : ' (só cofres; fee parada nas moedas não consultada)'}`);
  console.log(`  Taxas de rede estimadas         -${formatSol(t.feeEstimateLamports)} SOL`);
  console.log(`  ≈ Recuperável                    ${formatSol(net)} SOL${netUsd}`);

  if (s.tokensWithBalance.length) {
    console.log(`\nTokens com saldo (${s.tokensWithBalance.length}) — você escolhe depois: manter, transferir ou queimar:`);
    for (const tk of s.tokensWithBalance.slice(0, 40)) {
      console.log(`  ${label(tk.walletIndex).padEnd(9)} mint ${short(tk.mint)}  qtd ${formatTokenAmount(tk.amount, tk.decimals).padEnd(22)} ${usd(tk.usd, tk.sol)}`);
    }
    if (s.tokensWithBalance.length > 40) console.log(`  … e mais ${s.tokensWithBalance.length - 40} (veja o relatório com --relatorio)`);
  }
  if (s.nfts.length) {
    console.log(`\nNFTs (${s.nfts.length}) — nunca queimados automaticamente:`);
    for (const n of s.nfts.slice(0, 20)) console.log(`  ${label(n.walletIndex).padEnd(9)} mint ${n.mint}`);
  }
  if (s.blocked.length) {
    console.log(`\nContas que não dá para fechar com a chave da temporária (${s.blocked.length}):`);
    for (const b of s.blocked.slice(0, 20)) console.log(`  ${label(b.walletIndex).padEnd(9)} conta ${short(b.account)}  ${b.blockers.join('; ')}`);
  }
  if (s.walletsWithErrors) {
    console.log(`\nAtenção: ${s.walletsWithErrors} carteira(s) com leitura incompleta (valores delas podem estar abaixo do real):`);
    for (const w of s.wallets.filter((x) => x.errors.length)) console.log(`  ${label(w.index)} ${short(w.address)}: ${w.errors.join(' | ')}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'seed-file': { type: 'string' },
      'frase-publica-teste': { type: 'boolean', default: false },
      carteira: { type: 'string', default: 'solflare' },
      max: { type: 'string', default: String(SEARCH_MAX) },
      folga: { type: 'string', default: String(SEARCH_GAP) },
      relatorio: { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
    },
  });
  const max = Number(values.max);
  const gap = Number(values.folga);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(gap) || gap < 1) throw new UserError('--max e --folga precisam ser inteiros positivos.');
  if (values.carteira !== 'solflare' && values.carteira !== 'phantom') throw new UserError('--carteira deve ser solflare ou phantom.');
  const app: WalletApp = values.carteira;
  const kind = app === 'phantom' ? 'contas' : 'temporárias';

  const rpcUrl = process.env.SOLANA_RPC_URL || DEFAULT_RPC;
  const own = createRpc({ url: rpcUrl, ...(rpcUrl === DEFAULT_RPC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
  // getProgramAccounts recusado pelo RPC próprio (Helius) vai pelo público da mainnet, com a trava de rede (gpa-fallback.ts)
  const rpc = rpcUrl === DEFAULT_RPC ? own : withGpaFallback(own, () => networkGuarded(createRpc({ url: DEFAULT_RPC, ...PUBLIC_RPC_LIMITS }), 'mainnet'));

  console.log('Varredura SÓ LEITURA: nada será assinado nem enviado.');
  console.log(`RPC: ${describeRpc(rpcUrl)}${rpcUrl === DEFAULT_RPC ? ' (público, mais lento)' : ''}\n`);

  // confere o RPC antes de pedir a frase: se ele bloquear algo, para aqui
  process.stdout.write('Conferindo o RPC… ');
  const rpcCheck = await checkRpc(rpc, undefined, undefined, 'mainnet');
  if (!rpcCheck.ok) throw new UserError(rpcProblemMessage(rpcCheck.problems));
  console.log('ok.');
  const mnemonic = await readMnemonic({ seedFile: values['seed-file'], publicTest: values['frase-publica-teste'] });
  const words = mnemonicWordCount(mnemonic);
  if (![12, 15, 18, 21, 24].includes(words)) throw new UserError(`A frase tem ${words} palavras; o esperado é 12 ou 24.`);

  const seed = mnemonicToSeed(mnemonic);
  let discovery;
  const main = deriveMainAddress(seed);
  // outras redes: só os endereços públicos saem daqui
  const evmAddresses = Array.from({ length: EVM_ACCOUNTS }, (_, i) => evmAddress(seed, i));
  try {
    console.log(`Confira: a carteira principal desta frase é ${main}`);
    console.log('Se não for a sua, a frase está errada. A principal NUNCA é tocada.\n');
    process.stdout.write(`Procurando ${kind} usadas (até ${max}, para após ${gap} vazias)…`);
    discovery = await discoverBurners(seed, rpc, {
      app,
      max,
      gap,
      onProgress: (n, k) => process.stdout.write(`\rProcurando ${kind} usadas… conferidos ${n} endereços, ${k} usadas até agora   `),
    });
    process.stdout.write('\n');
  } finally {
    seed.fill(0); // a seed não é mais necessária na varredura
  }
  console.log(`${discovery.wallets.length} ${kind} encontradas (${discovery.checked} endereços conferidos).`);
  if (discovery.reachedMax) console.log(`Atenção: ainda havia temporárias usadas perto do limite. Rode de novo com --max ${max * 2}.`);
  if (!discovery.wallets.length) {
    console.log(app === 'phantom' ? 'Nenhuma conta com histórico nesta frase. Confira a frase.' : 'Nenhuma temporária com histórico. Confira a frase ou se as burners foram criadas como "Carteira Temporária" no Solflare. Se você usa a Phantom, rode com --carteira phantom.');
    return;
  }

  console.log(`\nEndereços derivados (${kind}):`);
  for (const w of discovery.wallets) {
    const tag = app === 'phantom' && w.index === PHANTOM_MAIN_INDEX ? '  ← PRINCIPAL: nunca é limpa (fora do total)' : '';
    console.log(`  ${walletLabel(app, w.index).padEnd(9)} ${w.address}${w.hasHistory ? '' : '  (sem histórico)'}${tag}`);
  }

  const rentExemptZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  process.stdout.write('\nLendo saldos, tokens e creator fees… ');
  const scans = await scanWallets(rpc, discovery.wallets, cleanupScanOptions(rentExemptZero), (d, t) => process.stdout.write(`\rLendo saldos, tokens e creator fees… ${d}/${t}`));
  console.log();

  const tokens = scans.flatMap((s) => s.tokens.filter((t) => t.kind === 'fungible'));
  const mints = tokens.map((t) => t.mint);
  const prices = await fetchPrices(mints);
  // a rede completa a API: moeda com BondingCurve é da Pump.fun e, enquanto não migra, tem preço em SOL pela curva
  const curveFailed = new Set<string>();
  applyCurves(prices, await readCurves(rpc, mints, { failed: curveFailed }), tokens);
  for (const m of curveFailed) if (!prices.prices.has(m)) prices.unresolved.add(m); // rede não respondeu: valor desconhecido, com aviso
  for (const e of prices.errors) console.log(`Aviso: ${e}`);

  // Phantom: a Conta 1 é a principal; aparece na lista com alertas, mas fica fora do total e do plano
  if (app === 'phantom') {
    const review = reviewPhantomAccounts(discovery.wallets, scans, prices.prices, prices.info);
    const flagged = review.accounts.filter((a) => a.warnings.length);
    if (flagged.length || review.warnings.length) console.log('\nDiferenças para conferir antes de limpar:');
    for (const a of flagged) for (const w of a.warnings) console.log(`  ⚠ ${a.label}: ${w}`);
    for (const w of review.warnings) console.log(`  ⚠ ${w}`);
    for (let k = scans.length - 1; k >= 0; k--) if (scans[k].index === PHANTOM_MAIN_INDEX) scans.splice(k, 1);
  }
  const summary = summarize(scans, prices.prices);
  printSummary(summary, prices.solUsd, (i) => walletLabel(app, i));
  printEvm(await scanEvm(evmAddresses));
  try {
    buildPlan({ scans, prices: prices.prices, destination: main, rentExemptZero, walletName: (i) => (app === 'phantom' ? `Conta ${i + 1}` : `temporária N=${i}`), appName: app === 'phantom' ? 'Phantom' : 'Solflare' });
  } catch (e) {
    if (e instanceof FeePayerError) console.log(`\n⚠ Antes de limpar: ${formatErrorPt(explainError(e))}`);
    else if (!(e instanceof PlanError)) throw e;
  }

  if (values.relatorio) {
    const file = writeReport('varredura', { geradoEm: new Date().toISOString(), discovery, scans, summary, solUsd: prices.solUsd });
    console.log(`\nRelatório salvo em ${path.relative(REPO_ROOT, file)} (pasta fora do Git; contém endereços reais).`);
  }
  console.log('\nNada foi executado. Isto é só leitura.');
}

if (import.meta.main) {
  main().finally(closeInput).catch((e) => {
    if (e instanceof UserError || e instanceof RpcError) console.error(`\nErro: ${e.message}`);
    else console.error('\nErro inesperado (detalhe omitido por segurança; rode com --debug para ver).');
    if (process.argv.includes('--debug')) console.error(e);
    process.exit(1);
  });
}
