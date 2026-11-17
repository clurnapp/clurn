// Ponta a ponta do "juntar o SOL desta frase" pelo FLUXO NOVO (4 etapas), na DEVNET (dinheiro de mentira), com
// EXECUÇÃO. Cenário: `node scripts/teste-tela/devnet-juntar.ts preparar <pasta>` (frase-1: aluguel + 0,00005 SOL
// em 4 temporárias, todas acima do aluguel mínimo, nenhuma cobre a reserva). A frase vai do arquivo direto para o cartão e nunca é impressa.
// Confere na rede: o juntado chega exato na N=0, a N=1 manda tudo e fica com 0 (nunca entre 0 e o aluguel), paga a
// própria taxa, e a taxa do app é 11% de todo o SOL recuperado (o juntado paga uma vez, na pagadora; só depósito é isento).
// Uso: sh scripts/teste-tela/um-teste.sh e2e-juntar.mjs <pasta-das-frases> <pasta-prints>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openBrowser, enterPhrases, confirmAndExecute, balance, tokenAccountLamports, sleep } from './cdp-devnet-lib.mjs';
import { deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';

const [url, phraseDir, outDir] = process.argv.slice(2);
const b = await openBrowser(url, outDir, 'ej');
const { run, check, waitFor, shot, stop } = b;

// 1. frase-1, rede devnet (pela URL), destino = principal (padrão)
const seed1 = mnemonicToSeed(readFileSync(path.join(phraseDir, 'frase-1.txt'), 'utf8'));
const DEST = deriveMainAddress(seed1);
seed1.fill(0);
await enterPhrases(b, ['frase-1.txt'], phraseDir, DEST);
const t0 = Date.now();
// nenhuma temporária cobre a reserva: o fluxo cai na espera do depósito, na tela "preparando"
const waited = await waitFor(`ui.section === 's-preparo' && ui.prep.phase === 'espera'`, 900000);
const err = await run(`document.getElementById('e-frase').textContent`);
check('análise terminou e a preparação ficou esperando o depósito', waited && !err, `${Math.round((Date.now() - t0) / 1000)} s ${err}`);
if (!waited) await stop('análise');
if ((await run('state.cluster')) !== 'devnet') await stop('este roteiro só roda na devnet');

// 2. a oferta de juntar no cartão da espera
const f = await run(`(() => { const f = state.frases[0]; return { wait: Boolean(f.feeWait), offer: f.gatherOffer, found: f.discovery?.found, wallets: f.wallets.map((w) => ({ index: w.index, address: w.address })) }; })()`);
console.log('oferta:', JSON.stringify(f.offer));
const app = await run(`state.frases[0].app`);
check('frase esperando o depósito, 4 temporárias achadas; detectada como Solflare (o juntar só vale nela)', f.wait && f.found === 4 && app === 'solflare', `found=${f.found} app=${app}`);
check('oferta de juntar: a N=0 recebe; a N=1 (sem excedente acima do aluguel, nada mais a limpar) manda tudo', f.offer && f.offer.toIndex === 0 && f.offer.from === 1 && f.offer.transfers.length === 1 && f.offer.transfers[0].fromIndex === 1 && f.offer.transfers[0].all === true, f.offer ? `${f.offer.lamports} lamports de N=${f.offer.transfers[0]?.fromIndex}` : 'sem oferta');
const btnText = await run(`([...document.querySelectorAll('#p-cards button')].find((b) => /^(Juntar|Gather) /.test(b.textContent)) || {}).textContent ?? ''`);
check('botão "Juntar … SOL de 1 temporária" no cartão da espera', /^Juntar .* SOL de 1 temporária$/.test(btnText), btnText);
await shot('1-oferta');
if (!f.offer || !btnText) await stop('sem oferta de juntar');

// 3. clique: uma transação da N=1 para a N=0, com link; conferida na rede
const sender = f.offer.transfers[0].from;
const before = { n0: await balance(f.offer.to), n1: await balance(sender) };
await run(`[...document.querySelectorAll('#p-cards button')].find((b) => /^(Juntar|Gather) /.test(b.textContent)).click(); true`);
const sent = await waitFor(`state.frases[0].gathering && state.frases[0].gathering.status !== undefined`, 120000);
const g = await run(`state.frases[0].gathering`);
console.log('juntado:', JSON.stringify({ status: g?.status, sent: g?.sent, total: g?.total, sentLamports: g?.sentLamports, links: g?.results?.map((r) => r.link) }));
check('juntar enviado: 1 de 1, com link da transação', sent && g?.status === 'enviado' && g.sent === 1 && g.total === 1 && g.results?.[0]?.link, g?.results?.[0]?.detail ?? '');
if (!sent || g?.status !== 'enviado') await stop('juntar não enviou');
await sleep(2000);
const after = { n0: await balance(f.offer.to), n1: await balance(sender) };
const moved = Number(g.sentLamports);
console.log(`na rede: N=0 ${before.n0} → ${after.n0}; N=1 ${before.n1} → ${after.n1}`);
check('na rede: a N=0 recebeu exatamente o valor', after.n0 - before.n0 === moved, `${after.n0 - before.n0} de ${moved}`);
check('na rede: a N=1 mandou tudo e ficou com 0 (nunca entre 0 e o aluguel); pagou a própria taxa (5000 + prioridade)', after.n1 === 0 && before.n1 - moved >= 5000 && before.n1 - moved < 55000, `sobrou ${after.n1}, taxa ${before.n1 - moved}`);

// 4. a espera termina sozinha; o fluxo monta o plano e simula sem ninguém clicar; vai à confirmação
const confirmed = await waitFor(`ui.section === 's-confirmar' || ui.prep.phase === 'erro'`, 900000);
const phase = await run(`ui.prep.phase + ' ' + (ui.prep.error?.mensagem ?? '')`);
check('a espera terminou sozinha, o plano foi montado e simulado: tela de confirmação', confirmed && (await run(`ui.section`)) === 's-confirmar', phase);
check('depois de juntar, sem oferta no cartão', await run(`state.frases[0].gatherOffer === null`));
await shot('2-confirmar');
if (!confirmed) await stop(`preparação: ${phase}`);
const plan = await run(`({ payer: state.plan.frases[0].feePayerIndex, steps: state.plan.frases[0].steps.map((s) => s.step.kind + ':' + s.walletIndex + (s.step.isFeePayer ? '*' : '')), dest: state.plan.destination })`);
console.log('plano:', plan.steps.join(' '), '| pagadora N=' + plan.payer);
check('a pagadora do plano é a N=0 (a que recebeu) e se esvazia por último', plan.payer === 0 && /sweep-sol:0\*$/.test(plan.steps.join(' ')));

// 5. antes de executar: o que cada carteira tem, para conferir a taxa de 11% depois
const pre = {};
for (const w of f.wallets) pre[w.index] = await balance(w.address);
const wsolRent = await tokenAccountLamports(f.wallets[2].address); // a conta de wSOL da N=2 devolve o aluguel à N=2 antes da varredura
const feeBefore = await balance(APP_FEE_WALLET);
const destBefore = await balance(plan.dest);
console.log('antes de executar:', JSON.stringify(pre), 'aluguel wSOL', wsolRent);

// 6. executa
const ex = await confirmAndExecute(b);
await shot('3-fim');
await sleep(5000);
let left = 0;
for (const w of f.wallets) { const v = await balance(w.address); console.log(`  N=${w.index}: ${v / 1e9} SOL`); left += v; await sleep(300); }
const fee = (await balance(APP_FEE_WALLET)) - feeBefore;
const destDelta = (await balance(plan.dest)) - destBefore;
// a taxa de 11% incide só nas temporárias que não são a pagadora (N=1..3, com o aluguel devolvido à N=2); o SOL da
// N=0 (o dela mais o juntado) vai inteiro. Se o juntado pagasse taxa, ela seria maior em 11% do valor juntado.
// regra da 0.1.4 (89ec534): todo SOL recuperado paga 11% uma vez; isento só o depósito do cliente (aqui, nenhum).
// O juntado não é depósito: paga na pagadora. Então a taxa é 11% de (destino + taxa), com arredondamento por envio.
const expectedFee = Math.floor((fee + destDelta) * 0.11);
const withoutGathered = Math.floor((fee + destDelta - moved) * 0.11); // o que seria se o juntado fosse isento
console.log(`taxa do app na rede: ${fee} (11% de ${fee + destDelta} = ${expectedFee}; se o juntado fosse isento: ${withoutGathered}); destino +${destDelta}`);
check('as 4 temporárias ficaram com 0 SOL', left === 0, `${left} lamports`);
check('taxa de 11% sobre todo o SOL recuperado, o juntado incluído uma vez (só depósito é isento)', Math.abs(fee - expectedFee) <= 10 && fee > withoutGathered + Math.floor(moved * 0.11) - 10, `${fee} vs ${expectedFee}`);
check('o relatório do app bate com a rede (taxa e destino)', BigInt(ex.arrivedAppFee) === BigInt(fee) && BigInt(ex.arrived) === BigInt(destDelta), `taxa ${ex.arrivedAppFee}/${fee}, destino ${ex.arrived}/${destDelta}`);
check('nenhum erro de JavaScript', b.pageErrors.length === 0, b.pageErrors.join(' || '));
console.log(b.results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await b.close(b.results.every(Boolean) ? 0 : 1);
