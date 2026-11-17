// Ponta a ponta do cartão de CHAVES PRIVADAS pela tela, na DEVNET (dinheiro de mentira), com EXECUÇÃO (fase 1
// multirredes, Task 7). Cenário: `node scripts/devnet-chaves.ts preparar <pasta>` (4 chaves em 3 formatos: SOL em 3,
// moeda A sem preço em 2, conta vazia em 1, a Chave 4 sem SOL; destino novo só com o aluguel). As chaves vão do arquivo
// direto para o cartão e nunca são impressas.
// Confere: selo "4 chaves", conferência obrigatória sem nenhuma protegida, a moeda sem preço em "manter" até a pessoa
// mandar queimar (QUEIMAR), e na rede: as 4 chaves com 0 SOL e sem conta de token, o destino com o que a tela mostrou,
// a taxa de 11% de cada envio na carteira da taxa e a moeda A queimada.
// Uso: sh scripts/teste-tela/um-teste.sh e2e-chaves.mjs <pasta-das-chaves> <pasta-prints>
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openBrowser, enterPhrases, confirmAndExecute, balance, rpc, sleep } from './cdp-devnet-lib.mjs';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';

const [url, keysDir, outDir] = process.argv.slice(2);
const DEST = readFileSync(path.join(keysDir, 'destino.txt'), 'utf8').trim();
const b = await openBrowser(url, outDir, 'ek');
const { run, check, waitFor, shot, stop } = b;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const tokenAccounts = async (a) => (await rpc('getTokenAccountsByOwner', [a, { programId: TOKEN }, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value ?? [];

// 1. o cartão com as 4 chaves (rede devnet pela URL), destino colado uma vez
await enterPhrases(b, ['chaves.txt'], keysDir, DEST);
const t0 = Date.now();
const pend = await waitFor(`(ui.section === 's-preparo' && ['pendente', 'erro', 'espera'].includes(ui.prep.phase)) || ui.section === 's-confirmar' || document.getElementById('e-frase').textContent.length > 0`, 900000);
const err = await run(`document.getElementById('e-frase').textContent + (ui.prep.error?.mensagem ?? '')`);
check('análise do cartão de chaves terminou e pediu a conferência', pend && !err && (await run(`ui.prep.phase`)) === 'pendente', `${Math.round((Date.now() - t0) / 1000)} s ${err}`);
if (!pend || err) await stop(`análise: ${err}`);
if ((await run('state.cluster')) !== 'devnet') await stop('este roteiro só roda na devnet');

// 2. conferência das chaves: 4 carteiras, nenhuma com alerta (todas abaixo de 0,05 SOL), nenhuma protegida
const rv = await run(`(() => { const f = state.frases[0]; const c = document.querySelector('#p-cards .rev[data-frase="1"]'); return {
  app: f.app, main: f.main, found: f.discovery?.found, wallets: f.wallets.map((w) => ({ index: w.index, label: w.label, address: w.address })),
  warnings: f.review.accounts.flatMap((a) => a.warnings), title: c?.querySelector('h3')?.textContent,
  names: [...(c?.querySelectorAll('.acc-name') ?? [])].map((x) => x.textContent), prot: [...(c?.querySelectorAll('.accounts input:checked') ?? [])].length,
  notice: c?.querySelector('.notice:not(.danger)')?.textContent ?? '', money: /US\\$/.test(c?.textContent ?? '') }; })()`);
console.log('carteiras:', JSON.stringify(rv.wallets));
check('cartão de chaves: app "chaves", sem principal, 4 carteiras', rv.app === 'chaves' && rv.main === null && rv.found === 4 && rv.wallets.length === 4, JSON.stringify({ app: rv.app, found: rv.found }));
check('conferência "Confira as carteiras das chaves" com Chave 1..4, nenhuma protegida, aviso visível, sem valor em dinheiro', rv.title === 'Confira as carteiras das chaves' && rv.names.join() === 'Chave 1,Chave 2,Chave 3,Chave 4' && rv.prot === 0 && rv.warnings.length === 0 && /Confira cada carteira marcada/.test(rv.notice) && !rv.money, JSON.stringify(rv).slice(0, 300));
await shot('1-conferir');
await run(`document.getElementById('rev-n-1').value = '4'; [...document.querySelectorAll('#p-cards button')].find((x) => x.textContent === 'Continuar').click(); true`);

// 3. Confirmar: a moeda sem preço fica em "manter"; a pessoa manda queimar todas e digita QUEIMAR
const conf = await waitFor(`ui.section === 's-confirmar' || ui.prep.phase === 'erro'`, 900000);
check('plano e teste de cada passo: tela de confirmação', conf && (await run(`ui.section`)) === 's-confirmar', await run(`ui.prep.error?.mensagem ?? ''`));
if (!conf || (await run(`ui.section`)) !== 's-confirmar') await stop('confirmação');
const c1 = await run(`({ hs: (state.holdings ?? []).map((h) => ({ w: h.walletIndex, amount: h.amount, rec: h.recommendation, usd: h.usdValue, sol: h.solValue })),
  groups: [...document.querySelectorAll('#c-tokens-box .tk-group h3')].map((h) => h.textContent), text: document.getElementById('c-tokens-box')?.textContent ?? '' })`);
console.log('moedas:', JSON.stringify(c1.hs));
check('moeda A nas Chaves 2 e 4, sem preço ("valor desconhecido"), recomendada manter', c1.hs.length === 2 && c1.hs.map((h) => h.w).sort().join() === '1,3' && c1.hs.every((h) => h.rec === 'keep' && h.usd === null && h.sol === null), JSON.stringify(c1.hs));
await shot('2-confirmar-manter');
await run(`[...document.querySelectorAll('#c-tokens-box button')].find((x) => /^Queimar todos sem valor conhecido/.test(x.textContent)).click(); true`);
await sleep(500);
check('pedir queimar sem a palavra deixa "aplicar" travado', await run(`document.getElementById('b-apply').disabled && !!document.getElementById('bci-all')`));
await run(`const i = document.getElementById('bci-all'); i.value = 'QUEIMAR'; i.dispatchEvent(new Event('input')); document.getElementById('b-apply').click(); true`);
await sleep(3000);
const again = await waitFor(`ui.section === 's-confirmar' && !ui.dirty && !ui.planBusy && !document.getElementById('b-executar').disabled`, 900000);
const plan = await run(`({ steps: state.plan.frases.flatMap((p) => p.steps.map((x) => x.step.kind + ':' + x.walletIndex + (x.step.isFeePayer ? '*' : ''))), payer: state.plan.frases[0].feePayerIndex,
  total: document.querySelector('#c-encontrado .receipt-total')?.textContent, lines: [...document.querySelectorAll('#c-encontrado .line')].map((l) => l.textContent) })`);
console.log('plano:', JSON.stringify(plan));
check('plano refeito com a queima: as 4 chaves no plano, a Chave 1 (mais SOL) paga as taxas e se esvazia por último', again && plan.payer === 0 && [0, 1, 2, 3].every((i) => plan.steps.some((s) => s.split(':')[1].startsWith(String(i)))) && /:0\*$/.test(plan.steps.at(-1)), plan.steps.join(' '));
check('Confirmar mostra total, taxa do app e o que chega', Boolean(plan.total) && plan.lines.some((l) => /Taxa do app/.test(l)) && plan.lines.some((l) => /Vai chegar no destino/.test(l)), plan.lines.join(' | ').slice(0, 300));
await shot('3-confirmar-queimar');

// 4. antes: saldos; executa (segura o botão)
const keys = rv.wallets.map((w) => w.address);
const before = { keys: [], dest: await balance(DEST), fee: await balance(APP_FEE_WALLET) };
for (const a of keys) { before.keys.push(await balance(a)); await sleep(300); }
const shownTotal = plan.total;
const ex = await confirmAndExecute(b);
await shot('4-fim');
const finalText = await run(`document.getElementById('s-execucao').textContent.replace(/\\s+/g, ' ').slice(0, 600)`);
console.log('tela final:', finalText);

// 5. na rede
await sleep(6000);
const after = { keys: [], tokens: [], dest: await balance(DEST), fee: await balance(APP_FEE_WALLET) };
for (const a of keys) { after.keys.push(await balance(a)); after.tokens.push((await tokenAccounts(a)).length); await sleep(300); }
const destDelta = after.dest - before.dest, feeDelta = after.fee - before.fee;
console.log(`chaves antes ${before.keys.join(',')} → depois ${after.keys.join(',')}; contas de token depois ${after.tokens.join(',')}`);
console.log(`destino ${before.dest} → ${after.dest} (+${destDelta}); taxa ${before.fee} → ${after.fee} (+${feeDelta}); total mostrado na Confirmar: ${shownTotal}`);
check('na rede: as 4 chaves com 0 SOL e nenhuma conta de token', after.keys.every((v) => v === 0) && after.tokens.every((n) => n === 0), `${after.keys.join(',')} / ${after.tokens.join(',')}`);
check('na rede: o destino recebeu exatamente o que a tela final mostrou', BigInt(destDelta) === BigInt(ex.arrived), `${destDelta} × ${ex.arrived}`);
check('na rede: a carteira da taxa recebeu exatamente o que o app relatou', BigInt(feeDelta) === BigInt(ex.arrivedAppFee) && feeDelta > 0, `${feeDelta} × ${ex.arrivedAppFee}`);
// cada envio paga 11% (arredondado para baixo) do que saiu para destino + taxa; nenhum depósito do cliente na rodada
const rep = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', '..', ex.report), 'utf8'));
const rows = []; const seen = new Set();
const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if ('destinationDelta' in o && o.status === 'enviado' && o.step) { const k = o.signature ?? JSON.stringify(o).slice(0, 120); if (!seen.has(k)) { seen.add(k); rows.push(o); } } Object.values(o).forEach(walk); } };
walk(rep);
const big = (v) => BigInt(String(v ?? 0));
for (const r of rows) console.log(`  ${r.step.kind}${r.step.isFeePayer ? ' (pagadora)' : ''} Chave ${r.step.walletIndex + 1}: destino ${r.destinationDelta}, taxa ${r.appFeeDelta}, ${r.signature ?? ''}`);
const wrong = rows.filter((r) => big(r.appFeeDelta) !== ((big(r.destinationDelta) + big(r.appFeeDelta)) * 1100n) / 10_000n);
check('cada envio pagou exatamente 11% (para baixo)', rows.length === ex.sent && rows.length > 0 && wrong.length === 0, wrong.map((r) => `Chave ${r.step.walletIndex + 1}`).join(', '));
const mints = new Set(c1.hs.length ? (await run(`state.holdings.map((h) => h.mint)`)) : []);
for (const m of mints) { const s = await rpc('getTokenSupply', [m, { commitment: 'confirmed' }]); console.log(`supply da moeda ${m}: ${s?.value?.amount}`); check('moeda A queimada (supply 0)', s?.value?.amount === '0', s?.value?.amount); }
check('nenhum erro de JavaScript', b.pageErrors.length === 0, b.pageErrors.join(' || '));
console.log(b.results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await b.close(b.results.every(Boolean) ? 0 : 1);
