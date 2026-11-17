// Ponta a ponta do EMPRÉSTIMO das taxas entre frases pelo FLUXO NOVO (4 etapas), na DEVNET (dinheiro de mentira), com
// EXECUÇÃO. Cenário: `node scripts/teste-tela/devnet-juntar.ts emprestimo <pasta>` (frase-2 rica = frase 1 na tela;
// frase-3 sem SOL = frase 2 na tela). As frases vão do arquivo direto para os cartões e nunca são impressas.
// Confere na rede: o emprestado chega exato na N=0 da frase 2, a emprestadora paga a própria taxa, e o SOL emprestado
// volta ao destino pagando a taxa de 11% UMA vez (é SOL esquecido da frase 1; regra do autor, 31/10/2026).
// Uso: sh scripts/teste-tela/um-teste.sh e2e-financiar.mjs <pasta-das-frases> <pasta-prints>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openBrowser, enterPhrases, confirmAndExecute, balance, tokenAccountLamports, sleep } from './cdp-devnet-lib.mjs';
import { deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';

const [url, phraseDir, outDir] = process.argv.slice(2);
const b = await openBrowser(url, outDir, 'ef');
const { run, check, waitFor, shot, stop } = b;

// 1. duas frases: a rica primeiro (o destino padrão é a principal dela), depois a sem SOL
// destino = a principal da frase rica (calculada do arquivo; só o endereço sai daqui)
const seed2 = mnemonicToSeed(readFileSync(path.join(phraseDir, 'frase-2.txt'), 'utf8'));
const DEST = deriveMainAddress(seed2);
seed2.fill(0);
await enterPhrases(b, ['frase-2.txt', 'frase-3.txt'], phraseDir, DEST);
const t0 = Date.now();
// a frase 1 tem plano, a frase 2 espera o depósito: plano parcial, na tela "preparando"
const waited = await waitFor(`ui.section === 's-preparo' && ui.prep.phase === 'espera'`, 900000);
const err = await run(`document.getElementById('e-frase').textContent`);
check('análise das 2 frases terminou e a preparação ficou esperando o depósito da frase 2', waited && !err, `${Math.round((Date.now() - t0) / 1000)} s ${err}`);
if (!waited) await stop('análise');
if ((await run('state.cluster')) !== 'devnet') await stop('este roteiro só roda na devnet');

// 2. a oferta de empréstimo no cartão da frase 2
const s = await run(`(() => ({
  n: state.frases.map((f) => ({ n: f.n, wait: Boolean(f.feeWait), found: f.discovery?.found, wallets: f.wallets.map((w) => ({ index: w.index, address: w.address })) })),
  offer: state.frases[1].fundingOffer, gather: state.frases[1].gatherOffer, plan: Boolean(state.plan),
}))()`);
console.log('oferta:', JSON.stringify(s.offer));
check('frase 1 pronta com plano; frase 2 esperando o depósito', !s.n[0].wait && s.n[1].wait && s.plan, JSON.stringify(s.n.map((x) => [x.n, x.wait, x.found])));
// desde a 0.2.2 o empréstimo é só o que falta (antes: 0,01 SOL fixo)
const offered = BigInt(s.offer?.lamports ?? 0);
const offeredText = (Number(offered) / 1e9).toFixed(9).replace(/0+$/, '').replace('.', ',');
check('oferta da frase 1 para a N=0 da frase 2, só do que falta (até 0,01 SOL); sem oferta de juntar (a frase 2 não tem SOL)', s.offer && s.offer.fromFrase === 1 && s.offer.toName === 'N=0' && offered > 0n && offered <= 10000000n && s.gather === null, JSON.stringify(s.offer));
const btnText = await run(`([...document.querySelectorAll('#p-cards button')].find((b) => /^(Usar|Use) /.test(b.textContent)) || {}).textContent ?? ''`);
check('botão "Usar <valor> SOL da frase 1" no cartão da espera, com o valor da oferta', btnText === `Usar ${offeredText} SOL da frase 1`, btnText);
await shot('1-oferta');
if (!s.offer || !btnText) await stop('sem oferta de empréstimo');

// 3. clique: uma transação da pagadora da frase 1 para a N=0 da frase 2, conferida na rede
const before = { from: await balance(s.offer.from), to: await balance(s.offer.to) };
await run(`[...document.querySelectorAll('#p-cards button')].find((b) => /^(Usar|Use) /.test(b.textContent)).click(); true`);
const sent = await waitFor(`state.frases[1].funding && state.frases[1].funding.status !== undefined`, 120000);
const g = await run(`state.frases[1].funding`);
console.log('emprestado:', JSON.stringify({ status: g?.status, lamports: g?.lamports, link: g?.link, detail: g?.detail }));
check('empréstimo enviado, com link da transação', sent && g?.status === 'enviado' && g.link, g?.detail ?? '');
if (!sent || g?.status !== 'enviado') await stop('empréstimo não enviou');
await sleep(2000);
const after = { from: await balance(s.offer.from), to: await balance(s.offer.to) };
const lent = Number(g.lamports);
console.log(`na rede: emprestadora ${before.from} → ${after.from}; N=0 da frase 2 ${before.to} → ${after.to}`);
check('na rede: a N=0 da frase 2 recebeu exatamente o valor', after.to - before.to === lent, `${after.to - before.to} de ${lent}`);
check('na rede: a emprestadora pagou o valor e a própria taxa (5000 + prioridade, menos de 55 000)', before.from - after.from >= lent + 5000 && before.from - after.from < lent + 55000, `${before.from - after.from}`);

// 4. a espera termina sozinha; o fluxo monta o plano das 2 frases e simula; vai à confirmação
const confirmed = await waitFor(`ui.section === 's-confirmar' || ui.prep.phase === 'erro'`, 900000);
const phase = await run(`ui.prep.phase + ' ' + (ui.prep.error?.mensagem ?? '')`);
check('a espera terminou sozinha, o plano das 2 frases foi montado e simulado: tela de confirmação', confirmed && (await run(`ui.section`)) === 's-confirmar', phase);
await shot('2-confirmar');
if (!confirmed) await stop(`preparação: ${phase}`);
const plan = await run(`({ frases: state.plan.frases.map((p) => ({ n: p.frase, payer: p.feePayerIndex, steps: p.steps.map((x) => x.step.kind + ':' + x.walletIndex + (x.step.isFeePayer ? '*' : '')) })), dest: state.plan.destination })`);
console.log('plano:', JSON.stringify(plan.frases));
check('as 2 frases no plano; a pagadora da frase 2 é a N=0 (a que recebeu) e se esvazia por último', plan.frases.map((p) => p.n).join() === '1,2' && plan.frases[1].payer === 0 && /sweep-sol:0\*$/.test(plan.frases[1].steps.join(' ')), JSON.stringify(plan.frases));

// 5. antes de executar: saldos (nenhum depósito do cliente na rodada: todo envio paga 11%, inclusive as pagadoras e o emprestado)
const w = await run(`state.frases.map((f) => f.wallets.map((x) => ({ n: f.n, index: x.index, address: x.address })))`);
const all = w.flat();
const pre = {};
for (const x of all) pre[`${x.n}:${x.index}`] = await balance(x.address);
// a conta de wSOL da frase 2 fecha e o aluguel dela é SOL recuperado: paga os 11% como qualquer aluguel
const closedRent = await tokenAccountLamports(all.find((x) => x.n === 2 && x.index === 0).address);
const feeBefore = await balance(APP_FEE_WALLET);
const destBefore = await balance(plan.dest);
console.log('antes de executar:', JSON.stringify(pre), 'aluguel a fechar', closedRent);

// 6. executa
const ex = await confirmAndExecute(b);
await shot('3-fim');
await sleep(5000);
let left = 0;
for (const x of all) { const v = await balance(x.address); console.log(`  frase ${x.n} N=${x.index}: ${v / 1e9} SOL`); left += v; await sleep(300); }
const fee = (await balance(APP_FEE_WALLET)) - feeBefore;
const destDelta = (await balance(plan.dest)) - destBefore;
// todo o recuperado é SOL esquecido (o emprestado também): 11% de tudo, arredondado para baixo em cada envio
const expectedFee = Math.floor((fee + destDelta) * 0.11);
const oldRule = Math.floor(pre['1:1'] * 0.11) + Math.floor(closedRent * 0.11);
console.log(`taxa do app na rede: ${fee} (11% de tudo = ${expectedFee}; regra antiga, sem as pagadoras: ${oldRule}); destino +${destDelta}`);
check('as temporárias das 2 frases ficaram com 0 SOL', left === 0, `${left} lamports`);
check('taxa de 11% sobre todo o recuperado, inclusive as pagadoras e o emprestado (uma vez só)', Math.abs(fee - expectedFee) <= 10 && fee > oldRule + Math.floor(lent * 0.11) - 10, `${fee} vs ${expectedFee}`);
check('o relatório do app bate com a rede (taxa e destino)', BigInt(ex.arrivedAppFee) === BigInt(fee) && BigInt(ex.arrived) === BigInt(destDelta), `taxa ${ex.arrivedAppFee}/${fee}, destino ${ex.arrived}/${destDelta}`);
check('nenhum erro de JavaScript', b.pageErrors.length === 0, b.pageErrors.join(' || '));
console.log(b.results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await b.close(b.results.every(Boolean) ? 0 : 1);
