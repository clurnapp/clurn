// Fluxo novo (4 etapas): os cartões da espera do depósito na tela "preparando", com estado inventado e fetch
// interceptado (nada é analisado nem enviado). Confere o empréstimo de outra frase (oferta, POST /api/financiar,
// cartão com o link, recusa do servidor), o "juntar o SOL desta frase" (oferta, POST /api/juntar, parcial com o motivo
// da falha), o cartão do depósito único (0.2: uma carteira, um valor, os passos, juntar e empréstimo em "Outras
// opções"), inglês e erros de JS.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-financiar.mjs <pasta-prints>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`, '--force-dark-mode', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
let closing = false;
async function closeBrowser(code = 0) {
  if (closing) return; closing = true;
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, j) => { bws.addEventListener('open', r); bws.addEventListener('error', j); setTimeout(j, 2000); });
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 800));
  } catch {}
  try { edge.kill(); } catch {}
  process.exit(code);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => closeBrowser(1));
process.on('uncaughtException', (e) => { console.error(e); closeBrowser(1); });
process.on('unhandledRejection', (e) => { console.error(e); closeBrowser(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const waiting = new Map(); const pageErrors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'erro'); return r.result.result.value; };
const results = [];
const check = (name, ok, info = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${info ? ' — ' + info : ''}`); };
async function shot(name, width = 1280) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const h = await run('Math.ceil(document.documentElement.scrollHeight)');
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, 5000), deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400);
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

await cdp('Runtime.enable');
await cdp('Page.navigate', { url });
await sleep(2500);

// estado inventado: frase 1 pronta e rica; frase 2 esperando com a oferta da frase 1; frase 3 esperando com a de juntar
const W = (n, k) => `${'W'.repeat(4)}${n}${k}${'x'.repeat(36)}`.slice(0, 44);
const wait = (n, sendSol) => ({ code: 'no-fee-sol', params: { walletIndex: 0, wallet: W(n, 'b'), sendSol, walletName: 'temporária N=0', appName: 'Solflare' }, waiting: true });
const wal = (n, i) => ({ index: i, label: `N=${i}`, address: W(n, String(i)), lamports: '5000000', closable: 0, closableRent: '0', creatorFees: '0', unswept: '0', blocked: [], errors: [] });
const frase = (n, extra) => ({ n, app: 'solflare', status: 'pronta', error: null, main: W(n, 'm'), discovery: { found: 2, checked: 20, reachedMax: false }, wallets: [0, 1].map((i) => wal(n, i)), holdings: [], review: null, evm: null,
  totals: { closable: 0, closableRentLamports: '0', creatorFeeLamports: '0', solLamports: '0', feeEstimateLamports: '0', recoverableLamports: '0' }, feeWarning: null, feeWait: null, fundingOffer: null, funding: null, gatherOffer: null, gathering: null, planNotice: null, nothingToClean: false, tempoMs: 1000, ...extra });
const offer = { fromFrase: 1, fromName: 'N=7', from: W(1, 'p'), toName: 'N=0', to: W(2, 'b'), lamports: '10000000' };
const gatherOffer = { toIndex: 0, toName: 'N=0', to: W(3, 'b'), lamports: '350880', from: 2, transfers: [{ fromIndex: 1, fromName: 'N=1', from: W(3, '1'), lamports: '200000' }, { fromIndex: 2, fromName: 'N=2', from: W(3, '2'), lamports: '150880' }] };
const base = () => ({ busy: null, cluster: 'devnet', rpc: 'devnet (público)', holdings: [], totals: { closable: 0, closableRentLamports: '0', creatorFeeLamports: '0', solLamports: '0', feeEstimateLamports: '0', recoverableLamports: '0' }, progress: null, pause: null, solUsd: 150, priceErrors: [], burnLocked: 0, pricesAvailable: true, confirm: null, plan: null, simResults: [], execResults: [], receipt: null, arrived: '0', arrivedAppFee: '0', aborted: null, abortedError: null, abortedFrase: null, reportFile: null,
  frases: [frase(1), frase(2, { feeWarning: 'x', feeWait: wait(2, 0.01), fundingOffer: offer }), frase(3, { feeWarning: 'x', feeWait: wait(3, 0.01), gatherOffer })] });
const funded = () => { const s = base(); s.frases[1].fundingOffer = null; s.frases[1].funding = { fromFrase: 1, fromName: 'N=7', toName: 'N=0', lamports: '10000000', status: 'enviado', link: 'https://solscan.io/tx/abc?cluster=devnet', detail: null, description: '', step: null, walletIndex: 7, destinationDelta: '10000000', error: null, frase: 2 }; return s; };
const res = (walletIndex, status, link, detail = null) => ({ status, link, detail, description: '', step: { kind: 'gather', walletIndex, lamports: '200000', toFrase: null, estimateLamports: null, close: 0, burnClose: 0, transferClose: 0, isFeePayer: false, sweepOnly: false, sweeps: 0 }, walletIndex, destinationDelta: null, error: null, frase: 3 });
const gathered = (results) => { const s = base(); const sent = results.filter((r) => r.status === 'enviado'); s.frases[2].gatherOffer = null; s.frases[2].gathering = { toIndex: 0, toName: 'N=0', to: W(3, 'b'), lamports: '350880', sentLamports: String(sent.length * 200000), sent: sent.length, total: results.length, status: sent.length === results.length ? 'enviado' : sent.length ? 'parcial' : 'falhou', results }; return s; };
const est = `if (u === '/api/estimativa') return new Response('{"seconds":60,"credits":1,"wallets":1}', { status: 200 });`;
await run(`(() => {
  window.__sent = []; window.__state = ${JSON.stringify(base())};
  const real = window.fetch;
  window.fetch = async (u, o) => {
    if (u === '/api/financiar') { window.__sent.push({ u, ...JSON.parse(o.body) }); window.__state = ${JSON.stringify(funded())}; return new Response(JSON.stringify(window.__state), { status: 200 }); }
    if (u === '/api/juntar') { window.__sent.push({ u, ...JSON.parse(o.body) }); window.__state = ${JSON.stringify(gathered([res(1, 'enviado', 'https://solscan.io/tx/g1?cluster=devnet'), res(2, 'falhou', null, 'a rede recusou')]))}; return new Response(JSON.stringify(window.__state), { status: 200 }); }
    if (u === '/api/estado') return new Response(JSON.stringify(window.__state), { status: 200 });
    ${est}
    return real(u, o);
  };
  state = window.__state; ui.planWaiting = true; ui.prep.phase = 'espera'; renderPrep(); show('s-preparo'); return true; })()`);
await sleep(500);
const card = (n) => run(`(() => { const c = document.querySelector('#p-cards [data-frase="${n}"]'); if (!c) return null; return { text: c.textContent, btns: [...c.querySelectorAll('button')].map((b) => b.textContent), links: [...c.querySelectorAll('a')].map((a) => a.href) }; })()`);
check('carrega sem erro de script', pageErrors.length === 0, pageErrors.join(' | '));
check('a espera aparece na tela "preparando", um cartão por frase que espera (2 e 3)', await run(`!document.getElementById('s-preparo').classList.contains('hidden') && document.querySelectorAll('#p-cards [data-frase]').length === 2`));

// ---- empréstimo (frase 2) ----
let c2 = await card(2);
check('frase 2: oferta da frase 1 com valor, carteiras e botão', c2 && /Ou use SOL de outra frase/.test(c2.text) && /A frase 1 tem SOL sobrando na N=7/.test(c2.text) && /0,01 SOL dela para a N=0/.test(c2.text) && c2.btns.includes('Usar 0,01 SOL da frase 1'), JSON.stringify(c2?.btns));
check('frase 2: endereços de origem e destino encurtados no cartão', c2 && c2.text.includes(`${W(1, 'p').slice(0, 4)}…${W(1, 'p').slice(-4)}`) && c2.text.includes(`${W(2, 'b').slice(0, 4)}…${W(2, 'b').slice(-4)}`));
let c3 = await card(3);
check('frase 3: sem a dica antiga de "um depósito por frase" (o cartão único a substitui)', c3 && !/Dica: em vez de um depósito por frase/.test(c3.text), c3?.text.slice(0, 200));
await shot('financiar-oferta.png');
await run(`[...document.querySelectorAll('#p-cards [data-frase="2"] button')].find((b) => b.textContent.startsWith('Usar')).click()`);
await sleep(600);
check('clique manda POST /api/financiar { frase: 2 } e nada mais', JSON.stringify(await run('window.__sent')) === '[{"u":"/api/financiar","frase":2}]', JSON.stringify(await run('window.__sent')));
c2 = await card(2);
check('depois do envio: "Taxas emprestadas pela frase 1" com o link da transação, sem botão de usar', c2 && /Taxas emprestadas pela frase 1: 0,01 SOL, da N=7 para a N=0\./.test(c2.text) && c2.links.some((l) => l.includes('solscan.io/tx/abc')) && !c2.btns.some((b) => /Usar/.test(b)), JSON.stringify(c2?.btns));
check('a espera continua até o saldo chegar ("Esperando o depósito…")', c2 && /Esperando o depósito…/.test(c2.text));
await shot('financiar-enviado.png');

// ---- juntar o SOL desta frase (frase 3) ----
await run(`(() => { window.__state = ${JSON.stringify(base())}; state = window.__state; renderPrep(); return true; })()`);
await sleep(300);
c3 = await card(3);
check('frase 3: oferta de juntar, texto com valor e botão "Juntar … SOL de 2 temporárias"', c3 && /Ou junte o SOL desta frase/.test(c3.text) && /0,00035088 SOL de 2 temporárias para a N=0/.test(c3.text) && c3.btns.includes('Juntar 0,00035088 SOL de 2 temporárias'), JSON.stringify(c3?.btns));
await shot('juntar-oferta.png');
await run(`[...document.querySelectorAll('#p-cards [data-frase="3"] button')].find((b) => b.textContent.startsWith('Juntar')).click()`);
await sleep(600);
check('clique manda POST /api/juntar { frase: 3 }', JSON.stringify((await run('window.__sent')).at(-1)) === '{"u":"/api/juntar","frase":3}', JSON.stringify(await run('window.__sent')));
c3 = await card(3);
check('depois do envio parcial: "Juntou … (1 de 2 envios)", motivo da falha, link só no enviado', c3 && /Juntou 0,0002 SOL na N=0 \(1 de 2 envios\)/.test(c3.text) && /falhou · a rede recusou/.test(c3.text) && c3.links.length === 1 && c3.links[0].includes('solscan.io/tx/g1'), c3?.text.slice(0, 300));
await shot('juntar-parcial.png');

// ---- inglês ----
await run(`(() => { window.__state = ${JSON.stringify(base())}; state = window.__state; LANG = 'en'; rerender(); renderPrep(); return true; })()`);
await sleep(500);
c2 = await card(2); c3 = await card(3);
check('inglês: oferta de empréstimo e de juntar', c2 && /Or use SOL from another phrase/.test(c2.text) && c2.btns.includes('Use 0.01 SOL from phrase 1') && c3 && /Or gather the SOL of this phrase/.test(c3.text) && c3.btns.includes('Gather 0.00035088 SOL from 2 burners'), JSON.stringify([c2?.btns, c3?.btns]));
await shot('financiar-en.png');
await run(`LANG = 'pt'; rerender(); renderPrep(); true`);

// ---- recusas do servidor: o erro aparece no cartão e a oferta continua ----
await run(`(() => { window.__state = ${JSON.stringify(base())}; window.fetch = async (u, o) => { if (u === '/api/financiar') return new Response(JSON.stringify({ erro: 'Nenhuma outra frase desta rodada tem SOL sobrando para emprestar. Faça o depósito pedido no cartão.' }), { status: 400 }); if (u === '/api/juntar') return new Response(JSON.stringify({ erro: 'As temporárias desta frase, juntas, não têm SOL para as taxas. Faça o depósito pedido no cartão.' }), { status: 400 }); if (u === '/api/estado') return new Response(JSON.stringify(window.__state), { status: 200 }); ${est} throw new Error('fetch inesperado ' + u); }; state = window.__state; renderPrep(); return true; })()`);
await sleep(300);
await run(`[...document.querySelectorAll('#p-cards [data-frase="2"] button')].find((b) => b.textContent.startsWith('Usar')).click()`);
await sleep(600);
c2 = await card(2);
check('recusa do empréstimo: a mensagem do servidor aparece no cartão e a oferta continua', c2 && /Nenhuma outra frase desta rodada tem SOL sobrando/.test(c2.text) && c2.btns.includes('Usar 0,01 SOL da frase 1'), JSON.stringify(c2?.btns));
await run(`[...document.querySelectorAll('#p-cards [data-frase="3"] button')].find((b) => b.textContent.startsWith('Juntar')).click()`);
await sleep(600);
c3 = await card(3);
check('recusa do juntar: a mensagem do servidor aparece no cartão e a oferta continua', c3 && /juntas, não têm SOL para as taxas/.test(c3.text) && c3.btns.some((b) => b.startsWith('Juntar')), JSON.stringify(c3?.btns));
// ---- depósito único (0.2): o servidor manda `single` quando há frase esperando; um cartão só ----
const single = (over = {}) => ({ hubFrase: 2, hubName: 'N=0', hub: W(2, 'b'), lamports: '20050000', received: '0', status: 'esperando', frases: [2, 3], forwards: [{ toFrase: 3, toName: 'N=0', to: W(3, 'b'), lamports: '10000000', status: null }], ...over });
await run(`(() => { window.__state = { ...${JSON.stringify(base())}, single: ${JSON.stringify(single())} }; state = window.__state; ui.cardErrors = {}; renderPrep(); show('s-preparo'); return true; })()`);
await sleep(400);
const dep = async () => run(`(() => { const c = document.getElementById('p-deposito'); const o = [...document.querySelectorAll('#p-cards details.det')].at(-1); return c && { text: c.textContent, n: document.querySelectorAll('#p-deposito').length, perFrase: document.querySelectorAll('#p-cards [data-frase]').length, other: o ? { summary: o.querySelector('summary').textContent, btns: [...o.querySelectorAll('button')].map((b) => b.textContent) } : null }; })()`);
let d = await dep();
check('depósito único: um cartão só, sem cartão por frase', d && d.n === 1 && d.perFrase === 0, JSON.stringify(d && { n: d.n, perFrase: d.perFrase }));
check('depósito único: uma carteira e o valor exato (frase 2 · temporária N=0, 0,020050 SOL), com o endereço', d && /Falta SOL para as taxas de rede em 2 frases: um depósito só resolve todas/.test(d.text) && /Mande exatamente 0,020050 SOL da sua carteira para esta, Frase 2 · temporária N=0:/.test(d.text) && d.text.includes(W(2, 'b')), d?.text.slice(0, 260));
check('depósito único: o que o app faz depois, em ordem (repassa, monta e testa, mostra e só envia com a confirmação)', d && /repassa sozinho 0,010000 SOL para Frase 3 · temporária N=0/.test(d.text) && d.text.indexOf('repassa') < d.text.indexOf('monta e testa a limpeza das 2 frases') && /só envia depois da sua confirmação/.test(d.text) && /sem a taxa do app/.test(d.text) && /Esperando o depósito…/.test(d.text), d?.text.slice(0, 400));
check('depósito único: juntar e empréstimo continuam, fechados em "Não quer depositar? Outras opções"', d?.other && d.other.summary === 'Não quer depositar? Outras opções' && d.other.btns.includes('Usar 0,01 SOL da frase 1') && d.other.btns.some((b) => b.startsWith('Juntar')), JSON.stringify(d?.other));
await shot('deposito-unico.png');
await shot('deposito-unico-390.png', 390);
// andamento: chegou parte, repassando, repasse que falhou (com "Tentar o repasse de novo" → POST /api/repassar)
await run(`(() => { state = { ...state, single: ${JSON.stringify(single({ received: '5000000' }))} }; renderPrep(); return true; })()`);
d = await dep();
check('depósito único: chegou parte ("Chegou 0,005000 de 0,020050 SOL")', d && /Chegou 0,005000 de 0,020050 SOL\. Falta 0,015050 SOL\./.test(d.text), d?.text.slice(-200));
await run(`(() => { window.__sent = []; window.fetch = async (u, o) => { if (u === '/api/repassar') { window.__sent.push({ u }); return new Response(JSON.stringify({ ...window.__state, single: ${JSON.stringify(single({ status: 'pronto', forwards: [{ toFrase: 3, toName: 'N=0', to: W(3, 'b'), lamports: '10000000', status: 'enviado', link: 'https://solscan.io/tx/r1' }] }))} }), { status: 200 }); } return new Response('{}', { status: 200 }); }; state = { ...state, single: ${JSON.stringify(single({ status: 'falhou', forwards: [{ toFrase: 3, toName: 'N=0', to: W(3, 'b'), lamports: '10000000', status: 'falhou', detail: 'a rede recusou' }] }))} }; renderPrep(); return true; })()`);
d = await dep();
check('depósito único: repasse que falhou diz qual e o motivo, com "Tentar o repasse de novo"', d && /O repasse para Frase 3 · temporária N=0 não foi enviado\./.test(d.text) && /a rede recusou/.test(d.text) && /Tentar o repasse de novo/.test(d.text), d?.text.slice(-260));
await run(`[...document.querySelectorAll('#p-deposito button')].find((b) => b.textContent === 'Tentar o repasse de novo').click()`);
await sleep(500);
d = await dep();
check('depósito único: "Tentar de novo" chama /api/repassar e o cartão mostra o repasse feito, com link', JSON.stringify(await run('window.__sent')) === '[{"u":"/api/repassar"}]' && d && /Depósito recebido e repassado/.test(d.text) && /ver transação/.test(d.text), d?.text.slice(-200));
await run(`(() => { LANG = 'en'; rerender(); state = { ...state, single: ${JSON.stringify(single())} }; renderPrep(); return true; })()`);
d = await dep();
check('depósito único em inglês', d && /one deposit covers them all/.test(d.text) && /Send exactly 0.020050 SOL/.test(d.text) && /forwards by itself/.test(d.text), d?.text.slice(0, 200));
await run(`LANG = 'pt'; rerender(); true`);
check('sem erro de script no fim', pageErrors.length === 0, pageErrors.join(' | '));
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await closeBrowser(results.every(Boolean) ? 0 : 1);
