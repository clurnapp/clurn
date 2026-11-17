// Assistente de limpeza das carteiras temporárias.
//
//   npm run limpar                         (mainnet; pede a frase com digitação oculta)
//   npm run limpar -- --seed-file C:\fora\do\repo\frase.txt
//   npm run limpar -- --devnet --seed-file ...   (rede de testes)
//
// Opções: --carteira solflare|phantom (padrão solflare)  --somente 3,7 ou --somente <endereço>  --max 2000  --folga 20  --debug
// (a busca para sozinha depois de 20 vazias seguidas; --max e --folga só para casos raros)
// RPC: variável SOLANA_RPC_URL (padrão: RPC público da rede escolhida).
//
// Passos: frase -> conferência da principal -> varredura -> o que achou em cada carteira ->
// suas decisões -> destino (digitado duas vezes) -> plano -> SIMULAÇÃO -> confirmação -> execução -> relatório.

import { parseArgs } from 'node:util';
import path from 'node:path';
import { ask, closeInput, line, readMnemonic, REPO_ROOT, short, usd, UserError, writeReport } from './io.ts';
import { isAddress } from '../core/solana/base58.ts';
import { addressAt, burnerSigner, deriveMainAddress, mnemonicToSeed, mnemonicWordCount, PHANTOM_MAIN_INDEX, standardPath, walletLabel, type WalletApp } from '../core/carteiras/derivation.ts';
import { parseProtectedAccounts, phantomBurnerIndexes, reviewPhantomAccounts } from '../core/carteiras/accounts.ts';
import { execute, ExecutionAborted, explorerLink, validateDestination, type StepResult } from '../core/limpeza/executor.ts';
import { buildPlan, describeStep, FeePayerError, PlanError, type TokenDecision } from '../core/limpeza/plan.ts';
import { GATHER_ENABLED, gatherOffer } from '../core/limpeza/gather.ts';
import { applyCurves, fetchPrices, looksLikeImpostor, tokenValue, type TokenInfo } from '../core/limpeza/prices.ts';
import { readCurves } from '../core/limpeza/curve-price.ts';
import { burnNeedsExtraConfirmation, priceLookupFailed, recommend } from '../core/limpeza/recommend.ts';
import { checkChallenge, makeChallenge, markChallenge } from '../core/limpeza/confirm.ts';
import { imitatedWallet, imitationMessage, KNOWN_ACCOUNTS, knownWallets, type KnownWallet } from '../core/limpeza/destination.ts';
import { explainError, formatErrorPt } from '../core/limpeza/errors.ts';
import { createRpc, describeRpc, PUBLIC_RPC_LIMITS, RpcError } from '../core/solana/rpc.ts';
import { checkRpc, networkGuarded, rpcProblemMessage } from '../core/solana/rpc-check.ts';
import { withGpaFallback } from '../core/solana/gpa-fallback.ts';
import { createRpcMeter } from '../core/solana/rpc-meter.ts';
import { balancesOnly, cleanupScanOptions, discoverBurners, scanWallets, SEARCH_GAP, SEARCH_MAX, totalCreatorFeeLamports, type TokenAccount, type WalletScan } from '../core/limpeza/scan.ts';
import { formatSol, formatTokenAmount, summarize } from '../core/limpeza/summary.ts';
import type { Signer } from '../core/solana/tx.ts';
import { evmAddress } from '../core/evm/evm.ts';
import { scanEvm } from '../core/evm/evm-scan.ts';
import { EVM_ACCOUNTS, printEvm } from './outras-redes.ts';


const RPC = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const DECISION_LABEL: Record<TokenDecision, string> = { keep: 'MANTER', transfer: 'ENVIAR AO DESTINO', burn: 'QUEIMAR' };

// app das burners desta execução; muda os nomes (Solflare "N=3" / Phantom "Conta 4") e os textos
let APP: WalletApp = 'solflare';
const L = (i: number) => walletLabel(APP, i);
const WALLET_NAME = (i: number) => (APP === 'phantom' ? `Conta ${i + 1}` : `temporária N=${i}`);
const APP_NAME = () => (APP === 'phantom' ? 'Phantom' : 'Solflare');
const KIND = () => (APP === 'phantom' ? 'contas' : 'temporárias');

type Holding = { id: number; scan: WalletScan; token: TokenAccount; info: TokenInfo | undefined; usdValue: number | null; solValue: number | null };

function tokenLabel(h: Holding): string {
  const sym = h.info?.symbol ?? 'sem nome';
  const fake = looksLikeImpostor(h.token.mint, h.info?.symbol ?? null) ? ' ⚠ IMITAÇÃO: mesmo nome de um token conhecido, endereço diferente' : '';
  return `${sym} (${h.info?.category ?? 'desconhecido'}) mint ${short(h.token.mint)}${fake}`;
}

function printWallet(s: WalletScan, holdings: Holding[]) {
  line('━');
  if (APP === 'phantom') {
    console.log(`Conta ${s.index + 1}   ${s.address}`);
    console.log(`  (na Phantom: a ${s.index + 1}ª conta desta frase)`);
  } else {
    console.log(`Temporária N=${s.index}   ${s.address}`);
    console.log(`  (no Solflare: "Reativar carteira temporária" mostra esta como "Used burner ${s.index}")`);
  }
  console.log(`  SOL solto: ${formatSol(s.lamports)} SOL`);
  const empties = s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length);
  if (empties.length) console.log(`  Contas de token vazias: ${empties.length} → fechar devolve ${formatSol(empties.reduce((a, t) => a + t.rentLamports, 0))} SOL de aluguel`);
  if (s.fees) {
    const fee = totalCreatorFeeLamports(s.fees);
    if (fee > 0n || s.fees.coinsOnCurve || s.fees.pools) {
      console.log(`  Creator fees Pump.fun: ${formatSol(fee)} SOL (moedas criadas: ${s.fees.coinsOnCurve} na curva, ${s.fees.pools} no PumpSwap)`);
      const swept = (s.fees.curveSweeps ?? []).length + (s.fees.poolSweeps ?? []).length;
      if (swept) console.log(`    inclui fee parada em ${swept} moeda(s): o app libera e coleta na mesma transação`);
      const unswept = s.fees.unsweptCurveLamports + s.fees.unsweptPoolLamports;
      if (unswept > 0n) console.log(`    fora do total: ${formatSol(unswept)} SOL parados em moeda que o app não coleta (recompensa a holders, cashback ou pareada em outro token)`);
      if (s.fees.unsweptError) console.log(`    não deu para ler a fee parada nas moedas (${s.fees.unsweptError}); os cofres valem`);
    }
  }
  const mine = holdings.filter((h) => h.scan === s);
  for (const h of mine) {
    console.log(`  [${h.id}] ${tokenLabel(h)}  qtd ${formatTokenAmount(h.token.amount, h.token.decimals)}  ${usd(h.usdValue, h.solValue)}  ← PRECISA DA SUA DECISÃO`);
  }
  for (const t of s.tokens.filter((t) => t.blockers.length || t.kind === 'invalid')) {
    console.log(`  Conta ${short(t.account)} (mint ${short(t.mint)}) não pode ser mexida: ${t.blockers.join('; ') || 'dados fora do formato'}`);
  }
  for (const e of s.errors) console.log(`  ⚠ leitura incompleta: ${e} (esta carteira fica de fora da limpeza)`);
}

async function decide(holdings: Holding[]): Promise<Map<string, TokenDecision>> {
  const decisions = new Map<string, TokenDecision>();
  if (!holdings.length) return decisions;
  line('━');
  console.log(`PRECISA DA SUA DECISÃO: tokens com saldo encontrados nas ${KIND()}\n`);
  const recs = holdings.map((h) => ({ h, rec: recommend(h.token.kind, h.info?.category ?? 'desconhecido', h.usdValue, h.solValue) }));
  for (const { h, rec } of recs) {
    console.log(`  [${h.id}] ${L(h.scan.index)}  ${tokenLabel(h)}  ${usd(h.usdValue, h.solValue)}`);
    console.log(`       recomendação: ${DECISION_LABEL[rec.decision]} — ${rec.why}`);
  }
  console.log('\n  ENVIAR AO DESTINO = transfere o token para a carteira de destino e fecha a conta.');
  console.log('  QUEIMAR = destrói o token (sem volta) e fecha a conta, recuperando o aluguel.');
  console.log(APP === 'phantom' ? '  MANTER = não mexe; você pode movimentar depois pela Phantom (mesma conta).\n' : '  MANTER = não mexe; você pode movimentar depois pelo Solflare (veja "Used burner N").\n');

  const mode = (await ask('Aceitar todas as recomendações? [s] sim  [u] escolher uma por uma  [m] manter todos: ', { fresh: true })).trim().toLowerCase();
  for (const { h, rec } of recs) {
    let d: TokenDecision = mode === 'm' ? 'keep' : rec.decision;
    if (mode === 'u') {
      const opts = h.token.kind === 'nft' ? '[e] enviar  [m] manter' : '[e] enviar  [q] queimar  [m] manter';
      const a = (await ask(`  [${h.id}] ${tokenLabel(h)} ${usd(h.usdValue, h.solValue)} — ${opts} (Enter = ${DECISION_LABEL[rec.decision]}): `)).trim().toLowerCase();
      if (a === 'e') d = 'transfer';
      else if (a === 'q' && h.token.kind !== 'nft') d = 'burn';
      else if (a === 'm') d = 'keep';
    }
    if (d === 'burn' && burnNeedsExtraConfirmation(h.info?.category ?? 'desconhecido', h.usdValue, h.solValue)) {
      const c = await ask(`  ⚠ [${h.id}] ${tokenLabel(h)} ${usd(h.usdValue, h.solValue)} não parece lixo. Para QUEIMAR mesmo assim digite QUEIMAR (Enter = manter): `, { fresh: true });
      if (c.trim() !== 'QUEIMAR') d = 'keep';
    }
    decisions.set(h.token.account, d);
  }
  console.log('\nSuas decisões:');
  for (const h of holdings) console.log(`  [${h.id}] ${tokenLabel(h)} → ${DECISION_LABEL[decisions.get(h.token.account)!]}`);
  return decisions;
}

async function askDestination(burners: Set<string>, main: string, known: KnownWallet[]): Promise<string> {
  line('━');
  console.log('CARTEIRA DE DESTINO: para onde vai TODO o SOL recuperado e os tokens que você mandou enviar.');
  console.log(`Tecle Enter sem colar nada para usar a sua carteira PRINCIPAL desta frase: ${main}`);
  console.log('(o app calcula esse endereço da frase: não há o que colar errado). Ou cole outro endereço seu.\n');
  for (;;) {
    const a = (await ask('Endereço de destino (Enter = principal): ', { fresh: true })).trim();
    if (a === '') {
      console.log(`  Destino: a sua carteira principal ${main} (ela só RECEBE, nunca assina nem perde nada)`);
      return main;
    }
    const imitated = imitatedWallet(a, known);
    if (imitated) {
      console.log(`  ⛔ ${imitationMessage(a, imitated)}`);
      continue;
    }
    if (!isAddress(a)) {
      console.log('  Isso não é um endereço Solana válido. Tente de novo.');
      continue;
    }
    if (burners.has(a)) {
      console.log('  Esse endereço é uma das temporárias que serão esvaziadas. Escolha outra carteira.');
      continue;
    }
    const b = (await ask('Cole o endereço de destino de novo, para conferir: ')).trim();
    if (a !== b) {
      console.log('  Os dois endereços não são iguais. Vamos recomeçar.');
      continue;
    }
    if (a === main) console.log('  (o destino é a carteira principal desta frase: ela só RECEBE, nunca assina nem perde nada)');
    else {
      console.log('  ⚠ O destino NÃO é a carteira principal desta frase. Confira o endereço INTEIRO, bloco por bloco:');
      console.log(`    ${a.match(/.{1,4}/g)!.join(' ')}`);
      console.log('    Golpes de endereço parecido copiam só o começo e o fim. Endereço de corretora pode não creditar tokens.');
    }
    return a;
  }
}

// Linha de um resultado. Com erro explicado, mostra o que houve e o que fazer (nunca o texto técnico;
// ele continua em `detail`, que vai para o relatório).
export function resultLine(r: StepResult, delta: string, extra: string): string {
  const why = r.error ? `\n      ${formatErrorPt(r.error).split('\n').join('\n      ')}` : r.detail ? ` — ${r.detail}` : '';
  return `  [${r.status}] ${r.description}${delta}${why}${extra}`;
}

function printResults(results: StepResult[], cluster: 'mainnet' | 'devnet') {
  for (const r of results) {
    const extra = r.signature ? `  ${explorerLink(r.signature, cluster)}` : '';
    const delta = r.destinationDelta && r.destinationDelta > 0n ? `  (+${formatSol(r.destinationDelta)} SOL no destino)` : '';
    console.log(resultLine(r, delta, extra));
  }
}

// Falta SOL para as taxas, mas a frase tem SOL espalhado: o app de desktop junta na pagadora com um clique
// (src/core/limpeza/gather.ts); no terminal, a dica diz quanto e de onde. Devolve as linhas a imprimir.
export function gatherHint(scans: WalletScan[], e: FeePayerError, rentExemptZero: number, label: (i: number) => string, app: WalletApp = 'solflare'): string[] {
  if (!GATHER_ENABLED) return []; // desligado: sem a dica
  if (app !== 'solflare') return []; // Phantom: as contas protegidas ficariam no meio (o app de desktop também não oferece)
  const o = gatherOffer(scans, e, rentExemptZero);
  if (!o) return [];
  const n = o.transfers.length;
  return [
    `Esta frase tem SOL para as taxas, só que espalhado: ${formatSol(o.lamports)} SOL de ${n} ${n === 1 ? 'temporária' : 'temporárias'} (${o.transfers.map((t) => label(t.fromIndex)).join(', ')}) cobririam a ${label(o.toIndex)}.`,
    'O app de desktop (npm run desktop) junta isso com um clique, "Ou junte o SOL desta frase", em vez do depósito.',
  ];
}
// --somente aceita número N ou endereço da temporária (aprendido no 1º teste na mainnet: é fácil errar o número)
export function resolveOnly(raw: string[], wallets: Array<{ index: number; address: string }>, app: WalletApp = 'solflare'): Set<number> {
  const out = new Set<number>();
  for (const x of raw) {
    const idx = app === 'phantom' ? Number(x) - 1 : Number(x); // Phantom: "--somente 3" = Conta 3
    const w = /^\d+$/.test(x) ? wallets.find((w) => w.index === idx) : wallets.find((w) => w.address === x);
    if (!w) throw new UserError(`--somente: ${x} não é uma temporária usada desta frase. Confira a lista "Endereços derivados" do scan.`);
    out.add(w.index);
  }
  return out;
}

async function main() {
  const { values } = parseArgs({
    options: {
      'seed-file': { type: 'string' },
      'frase-publica-teste': { type: 'boolean', default: false },
      devnet: { type: 'boolean', default: false },
      somente: { type: 'string' },
      carteira: { type: 'string', default: 'solflare' },
      max: { type: 'string', default: String(SEARCH_MAX) },
      folga: { type: 'string', default: String(SEARCH_GAP) },
      debug: { type: 'boolean', default: false },
    },
  });
  const cluster = values.devnet ? 'devnet' : 'mainnet';
  if (values.carteira !== 'solflare' && values.carteira !== 'phantom') throw new UserError('--carteira deve ser solflare ou phantom.');
  APP = values.carteira;
  const max = Number(values.max);
  const gap = Number(values.folga);
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(gap) || gap < 1) throw new UserError('--max e --folga precisam ser inteiros positivos.');
  const onlyRaw = values.somente ? values.somente.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
  if (onlyRaw && onlyRaw.some((x) => !isAddress(x) && !/^\d+$/.test(x))) {
    throw new UserError('--somente espera números N ou endereços de temporárias, separados por vírgula. Ex.: --somente 3,7');
  }

  const rpcUrl = process.env.SOLANA_RPC_URL || RPC[cluster];
  const isPublic = rpcUrl === RPC[cluster];
  const meter = createRpcMeter();
  // público: 8/s no total e 3,5/s por método (PUBLIC_RPC_LIMITS); próprio (Helius): 8/s, só os limites padrão por método
  const own = createRpc({ url: rpcUrl, ...(isPublic ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }), fetchImpl: meter.fetchImpl });
  // getProgramAccounts recusado pelo RPC próprio (Helius) vai pelo público da rede, com a trava de rede (gpa-fallback.ts)
  const rpc = isPublic ? own : withGpaFallback(own, () => networkGuarded(createRpc({ url: RPC[cluster], ...PUBLIC_RPC_LIMITS }), cluster));
  const usage = () => `${meter.requests()} consultas ao RPC (≈ ${meter.credits()} créditos do Helius)`;

  line('━');
  console.log(`LIMPEZA DAS CARTEIRAS TEMPORÁRIAS — rede: ${cluster.toUpperCase()} — RPC: ${describeRpc(rpcUrl)}${isPublic ? ' (público, mais lento)' : ''}`);
  console.log('A frase fica só na memória deste computador. Nada é executado sem a sua confirmação no final.');
  line('━');

  // 1. frase
  // confere o RPC antes de pedir a frase: se ele bloquear algo, para aqui
  process.stdout.write('Conferindo o RPC… ');
  const rpcCheck = await checkRpc(rpc, undefined, undefined, cluster);
  if (!rpcCheck.ok) throw new UserError(rpcProblemMessage(rpcCheck.problems));
  console.log('ok.');
  const mnemonic = await readMnemonic({ seedFile: values['seed-file'], publicTest: values['frase-publica-teste'] });
  const words = mnemonicWordCount(mnemonic);
  if (![12, 15, 18, 21, 24].includes(words)) throw new UserError(`A frase tem ${words} palavras; o esperado é 12 ou 24.`);
  const seed = mnemonicToSeed(mnemonic);

  // 2. conferência e descoberta
  const main = deriveMainAddress(seed);
  const evmAddresses = Array.from({ length: EVM_ACCOUNTS }, (_, i) => evmAddress(seed, i));
  // contas comuns da frase (só endereços): para reconhecer destino que imita uma delas
  const known = knownWallets(Array.from({ length: KNOWN_ACCOUNTS }, (_, i) => addressAt(seed, standardPath(i))));
  console.log(`\nConfira: a carteira PRINCIPAL desta frase é ${main}`);
  console.log('Se não for a sua, pare aqui (Ctrl+C): a frase está errada. A principal NUNCA é tocada.\n');
  process.stdout.write(`Procurando ${KIND()} usadas (até ${max}, para depois de ${gap} vazias)…`);
  const discovery = await discoverBurners(seed, rpc, {
    app: APP,
    max,
    gap,
    onProgress: (n, k) => process.stdout.write(`\rProcurando ${KIND()} usadas… conferidos ${n} endereços, ${k} usadas até agora   `),
  });
  console.log(`\n${discovery.wallets.length} ${KIND()} encontradas.`);
  const only = onlyRaw ? resolveOnly(onlyRaw, discovery.wallets, APP) : undefined;
  if (discovery.reachedMax) console.log(`⚠ Ainda havia temporárias usadas perto do limite: rode de novo com --max ${max * 2} para ver todas.`);
  if (!discovery.wallets.length) {
    seed.fill(0);
    console.log(APP === 'phantom' ? 'Nenhuma conta com histórico nesta frase. Confira a frase.' : 'Nenhuma temporária com histórico. Confira a frase ou se as burners foram criadas como "Carteira Temporária" no Solflare. Se você usa a Phantom, rode com --carteira phantom.');
    return;
  }
  // na Phantom, a Conta 1 (principal) nunca ganha chave no app
  const signers = new Map<number, Signer>(
    discovery.wallets.filter((w) => !(APP === 'phantom' && w.index === PHANTOM_MAIN_INDEX)).map((w) => [w.index, burnerSigner(seed, w.index, APP)]),
  );
  seed.fill(0);

  // 3. varredura
  const rentExemptZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
  process.stdout.write('Lendo saldos, tokens e creator fees… ');
  // com --somente: leitura completa só das escolhidas; das outras só o saldo (para achar a pagadora)
  const chosen = discovery.wallets.filter((w) => !only || only.has(w.index));
  const others = discovery.wallets.filter((w) => only && !only.has(w.index));
  const full = await scanWallets(rpc, chosen, cleanupScanOptions(rentExemptZero), (d, t) => process.stdout.write(`\rLendo saldos, tokens e creator fees… ${d}/${t}`));
  const scans = [...full, ...(await balancesOnly(rpc, others))].sort((a, b) => a.index - b.index);
  console.log();
  const tokens = scans.flatMap((s) => s.tokens.filter((t) => t.kind === 'fungible' || t.kind === 'nft'));
  const mints = tokens.map((t) => t.mint);
  const prices = cluster === 'mainnet' ? await fetchPrices(mints) : { prices: new Map(), info: new Map<string, TokenInfo>(), solUsd: null, errors: [] as string[], unresolved: new Set<string>() };
  // a rede completa a API: moeda com BondingCurve é da Pump.fun e, enquanto não migra, tem preço em SOL pela curva
  const curveFailed = new Set<string>();
  applyCurves(prices, await readCurves(rpc, mints, { failed: curveFailed }), tokens);
  for (const m of curveFailed) if (!prices.prices.has(m)) prices.unresolved.add(m); // rede não respondeu: valor desconhecido, com aviso
  if (cluster === 'devnet') console.log('Rede de testes: sem preços (os tokens aparecem como valor desconhecido).');
  for (const e of prices.errors) console.log(`Aviso: ${e}`);

  // Phantom: mostra TODAS as contas, alerta diferenças e exige confirmação de quais serão limpas
  if (APP === 'phantom') {
    const review = reviewPhantomAccounts(discovery.wallets, scans, prices.prices, prices.info);
    line('━');
    console.log('CONTAS DESTA FRASE NA PHANTOM (confira com atenção):');
    for (const a of review.accounts) {
      const tag = a.isMain ? '  ← PRINCIPAL: nunca é limpa' : '';
      console.log(`  ${a.label.padEnd(9)} ${a.address}  ${formatSol(a.lamports)} SOL${a.hasHistory ? '' : '  (sem uso)'}${tag}`);
      for (const w of a.warnings) console.log(`      ⚠ ${w}`);
    }
    for (const w of review.warnings) console.log(`⚠ ${w}`);
    const existing = new Set(review.accounts.filter((a) => !a.isMain).map((a) => a.index));
    let protectedIdx = new Set<number>();
    for (;;) {
      const t = await ask('Alguma conta além da Conta 1 que NÃO deve ser limpa? Números separados por vírgula (Enter = nenhuma): ', { fresh: true });
      try {
        protectedIdx = parseProtectedAccounts(t, existing);
        break;
      } catch (e) {
        console.log(`  ${e instanceof Error ? e.message : 'entrada inválida'}. Tente de novo.`);
      }
    }
    const burnerIdx = new Set(phantomBurnerIndexes(discovery.wallets, protectedIdx));
    if (!burnerIdx.size) {
      console.log('Nenhuma conta para limpar. Nada foi feito.');
      return;
    }
    console.log(`\nSerão limpas ${burnerIdx.size} conta(s): ${[...burnerIdx].map(L).join(', ')}`);
    console.log(`Ficam intactas: Conta 1 (principal)${protectedIdx.size ? ', ' + [...protectedIdx].map(L).join(', ') : ''}`);
    const ok = await ask(`Para confirmar, digite o número de contas que serão limpas (${burnerIdx.size}): `, { fresh: true });
    if (ok.trim() !== String(burnerIdx.size)) {
      console.log('Cancelado. Nada foi feito.');
      return;
    }
    // daqui em diante só existem as contas confirmadas: as outras saem da análise e perdem a chave
    for (const i of [...signers.keys()]) if (!burnerIdx.has(i)) signers.delete(i);
    for (let k = scans.length - 1; k >= 0; k--) if (!burnerIdx.has(scans[k].index)) scans.splice(k, 1);
  }

  // 4. o que achou, carteira por carteira
  const holdings: Holding[] = [];
  for (const s of scans) {
    if (only && !only.has(s.index)) continue;
    for (const t of s.tokens) {
      if ((t.kind === 'fungible' || t.kind === 'nft') && !t.blockers.length) {
        const { usd: usdValue, sol: solValue } = tokenValue(prices.prices, t);
        holdings.push({ id: holdings.length + 1, scan: s, token: t, info: prices.info.get(t.mint), usdValue, solValue });
      }
    }
  }
  console.log('\nO QUE FOI ENCONTRADO (só carteiras com algo):');
  for (const s of scans) {
    if (only && !only.has(s.index)) continue;
    const hasSomething = s.lamports > 0 || s.tokens.length > 0 || (s.fees && totalCreatorFeeLamports(s.fees) > 0n) || s.errors.length;
    if (hasSomething) printWallet(s, holdings);
  }
  printEvm(await scanEvm(evmAddresses));
  const summary = summarize(scans.filter((s) => !only || only.has(s.index)), prices.prices);
  line('━');
  console.log(`TOTAL ESTIMADO EM SOL: ${formatSol(summary.totals.recoverableLamports)} SOL`);
  console.log(`  = SOL solto ${formatSol(summary.totals.solLamports)} + aluguel de contas ${formatSol(summary.totals.closableRentLamports)} + creator fees ${formatSol(summary.totals.creatorFeeLamports)} − taxas ${formatSol(summary.totals.feeEstimateLamports)}`);
  console.log('  (fora isso: os tokens que você decidir enviar)');
  // confere já se alguma temporária pode pagar as taxas, antes de pedir decisões
  try {
    buildPlan({ scans, prices: prices.prices, destination: main, rentExemptZero, only, walletName: WALLET_NAME, appName: APP_NAME() });
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    line('━');
    console.log(`⚠ ${e instanceof FeePayerError ? formatErrorPt(explainError(e)) : e.message}`);
    if (e instanceof FeePayerError) {
      for (const l of gatherHint(scans, e, rentExemptZero, L, APP)) console.log(l);
      console.log('Depois de mandar, rode o mesmo comando de novo.');
    }
    console.log('Nada foi feito.');
    return;
  }
  if (!holdings.length && summary.totals.recoverableLamports === 0n) {
    console.log('\nNada para limpar nessas temporárias. Nada foi feito.');
    return;
  }

  // 5. decisões, destino, plano
  const missing = holdings.filter((h) => priceLookupFailed(prices, h.token.mint)).length;
  if (missing) console.log(`⚠ A consulta de preços falhou para ${missing} token(s), mesmo tentando de novo: ficam como valor desconhecido; queimar só digitando QUEIMAR.`);
  const decisions = await decide(holdings);
  const destination = await askDestination(new Set(discovery.wallets.map((w) => w.address)), main, known);
  await validateDestination(rpc, destination, rentExemptZero, known);
  const plan = buildPlan({ scans, prices: prices.prices, destination, decisions, rentExemptZero, only, walletName: WALLET_NAME, appName: APP_NAME() });

  line('━');
  console.log('PLANO (nada foi feito ainda):');
  console.log(`  Destino: ${destination}`);
  console.log(`  Quem paga as taxas de rede: ${WALLET_NAME(plan.feePayerIndex)} (${short(plan.feePayer)})${plan.payerOutsideSelection ? '' : ', esvaziada por último'}`);
  if (plan.payerOutsideSelection) {
    console.log(`  ⚠ ${L(plan.feePayerIndex)} está fora do --somente: paga as taxas, mas o SOL dela NÃO vai para o destino agora (fica nela até a limpeza completa)`);
  }
  if (plan.appFee) console.log(`  Taxa do app: 11% do SOL recuperado vai para ${plan.appFee.wallet}, na mesma transação (o SOL da pagadora, tokens e NFTs não pagam)`);
  plan.steps.forEach((s, i) => console.log(`  ${String(i + 1).padStart(3)}. ${describeStep(s, L)}`));
  for (const k of plan.kept) console.log(`  fica onde está: ${L(k.walletIndex)} ${prices.info.get(k.mint)?.symbol ?? short(k.mint)} — ${k.reason}`);
  for (const s of plan.skipped) console.log(`  ⚠ ${L(s.walletIndex)} fica de fora: ${s.reason}`);

  // 6. simulação
  console.log('\nSimulando cada transação na rede (nada é enviado)…');
  const simulated = await execute({ rpc, plan, signers, mode: 'simulate', label: L });
  printResults(simulated, cluster);
  const simTotal = simulated.reduce((a, r) => a + (r.destinationDelta ?? 0n), 0n);
  const simFailed = simulated.filter((r) => r.status === 'falhou').length;
  console.log(`\nSimulação: o destino receberia ~${formatSol(simTotal)} SOL${simFailed ? `; ${simFailed} passo(s) falhariam (veja acima)` : ''}.`);
  const simFee = simulated.reduce((a, r) => a + (r.appFeeDelta ?? 0n), 0n);
  if (plan.appFee) console.log(`Taxa do app (11%): ~${formatSol(simFee)} SOL para ${plan.appFee.wallet} (já fora do valor acima).`);
  console.log('(a soma é aproximada: na simulação cada passo é testado isoladamente)');
  console.log(`Até aqui: ${usage()}.`);

  // 7. confirmação
  line('━');
  // 4 caracteres sorteados do MEIO: golpes de endereço parecido copiam o começo e o fim
  const challenge = makeChallenge(destination);
  console.log('DESTINO (confira o endereço inteiro):');
  console.log(`  ${markChallenge(destination, challenge)}`);
  const ok = await ask(`Para EXECUTAR de verdade na ${cluster.toUpperCase()}, digite os 4 caracteres entre colchetes (maiúscula ou minúscula). Qualquer outra coisa cancela: `, { fresh: true });
  if (!checkChallenge(ok, destination, challenge)) {
    console.log('Cancelado. Nada foi executado.');
    return;
  }

  // 8. execução
  console.log('\nExecutando…');
  const results: StepResult[] = []; // preenchido passo a passo: parada no meio não apaga o que já foi feito
  let aborted: string | null = null;
  try {
    await execute({ rpc, plan, signers, mode: 'execute', label: L, onResult: (r) => (results.push(r), printResults([r], cluster)) });
  } catch (e) {
    aborted = e instanceof ExecutionAborted ? e.message : 'erro inesperado durante a execução (detalhe omitido por segurança)';
    console.log(`\n⛔ ${e instanceof ExecutionAborted ? formatErrorPt(explainError(e)) : aborted}`);
  }

  // 9. relatório
  const received = results.filter((r) => r.status === 'enviado').reduce((a, r) => a + (r.destinationDelta ?? 0n), 0n);
  line('━');
  console.log('RELATÓRIO FINAL');
  console.log(`  Recebido no destino: ${formatSol(received)} SOL (+ tokens enviados)`);
  if (plan.appFee) {
    const fee = results.filter((r) => r.status === 'enviado').reduce((a, r) => a + (r.appFeeDelta ?? 0n), 0n);
    console.log(`  Taxa do app (11%): ${formatSol(fee)} SOL para ${plan.appFee.wallet}`);
  }
  console.log(`  Transações confirmadas: ${results.filter((r) => r.status === 'enviado').length}`);
  console.log(`  Falhas: ${results.filter((r) => r.status === 'falhou').length}   Canceladas: ${results.filter((r) => r.status === 'cancelado').length}${aborted ? '   (execução interrompida por segurança)' : ''}`);
  const unknown = results.filter((r) => r.status === 'desconhecido');
  if (unknown.length) console.log(`  ⚠ ${unknown.length} passo(s) sem confirmação da rede: confira pelos links acima se caíram.`);
  console.log(`  Uso do RPC nesta execução: ${usage()}, ${discovery.wallets.length} temporárias`);
  const file = writeReport(`limpeza-${cluster}`, { destination, cluster, plan, results, aborted });
  console.log(`  Relatório completo: ${path.relative(REPO_ROOT, file)} (fora do Git)`);
}

if (import.meta.main) {
  main()
    .finally(closeInput)
    .catch((e) => {
      if (e instanceof UserError || e instanceof RpcError || e instanceof PlanError || e instanceof ExecutionAborted) console.error(`\nErro: ${e.message}`);
      else console.error('\nErro inesperado (detalhe omitido por segurança; rode com --debug para ver).');
      if (process.argv.includes('--debug')) console.error(e);
      process.exit(1);
    });
}
