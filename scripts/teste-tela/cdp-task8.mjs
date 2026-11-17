// Tela de confirmar e erros do fluxo 0.1.4 (antes "Task 8"), com estado inventado (o do cdp-fluxo.mjs) e fetch
// interceptado: recibo com passo que falharia (técnico só em "detalhes"), token sem nome e sem preço, botão
// "segure 2 s" (mouse e Espaço; soltar antes não envia), recusa do /api/executar em cartão (redesenha em inglês),
// rede caída na simulação ("Tentar de novo"), na execução (sem insistir) e na análise (colar de novo), aviso
// rpc-busy, celular 390 px e erros de JS. Sem frase nenhuma; nada sai da página.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-task8.mjs <pasta-prints>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`, '--force-dark-mode', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
async function closeEdge() {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await new Promise((r) => setTimeout(r, 300));
  } catch {}
  try { edge.kill(); } catch {}
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await closeEdge(); process.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
if (!target) { await closeEdge(); throw new Error('Edge não abriu'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
const cdp = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'erro'); return r.result.result.value; };
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${info ? ' — ' + info : ''}`); };
async function shot(name, width = 1280) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const h = await run('Math.ceil(document.documentElement.scrollHeight)');
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, 5000), deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400);
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}
const jsErrors = [];
await cdp('Runtime.enable');
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') jsErrors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text); });

const addr = (tag, i) => `${tag}${String(i).padStart(4, '0')}KXtg2CW87d97TXJSDpbD5jBkheTqA83TZzzzzz`.slice(0, 44);
const wal = (n, i) => ({ index: i, label: n === 2 ? `Conta ${i + 1}` : `N=${i}`, address: addr(`W${n}x`, i), lamports: '5000000', closable: 2, closableRent: '2976880', creatorFees: '0', unswept: '0', blocked: [], errors: [] });
const totals = (lamports) => ({ recoverableLamports: String(lamports), closable: 6, closableRentLamports: '8930640', creatorFeeLamports: '120000000', solLamports: '15000000', feeEstimateLamports: '30000' });
const MAIN = (n) => addr(`Main${n}`, n);
const frase = (n, over) => ({ n, app: 'solflare', status: 'pronta', error: null, main: MAIN(n), discovery: { found: 3, checked: 23, reachedMax: false }, wallets: [0, 1, 2].map((i) => wal(n, i)), holdings: [], review: null, evm: null, totals: totals(n * 1_000_000_000), feeWarning: null, feeWait: null, planNotice: null, nothingToClean: false, tempoMs: 61000, ...over });
const acc = (i, extra = {}) => ({ index: i, label: `Conta ${i + 1}`, address: i === 0 ? MAIN(2) : addr('W2x', i), hasHistory: true, lamports: '5000000', isMain: i === 0, warnings: [], ...extra });
const hold = (id, n, over) => ({ id, frase: n, account: `acct${id}`, mint: addr('Mint', id), symbol: 'MEME', name: null, kind: 'fungible', category: 'memecoin Pump.fun', amount: '98000000', decimals: 0, usdValue: 0.004, solValue: null, walletIndex: 1, recommendation: 'burn', whyCode: 'cheap-memecoin', why: '', burnNeedsConfirmation: false, inBurnAll: true, burnAllowed: true, impostor: false, ...over });
const WAIT = { code: 'no-fee-sol', params: { walletIndex: 0, wallet: addr('W3x', 0), sendSol: 0.003, walletName: 'temporária N=0', appName: 'Solflare' }, waiting: true };
const holdings = [
  hold(1, 1),
  hold(2, 2, { walletIndex: 2, symbol: 'BONK', category: 'cripto conhecida', amount: '154200', usdValue: 3.1, recommendation: 'transfer', whyCode: 'known', inBurnAll: false }),
  hold(3, 1, { kind: 'nft', symbol: 'Arte', category: 'outro', amount: '1', usdValue: null, recommendation: 'keep', whyCode: 'nft', inBurnAll: false, burnNeedsConfirmation: true }),
  hold(4, 1, { symbol: 'WIFCAT', category: 'outro', amount: '632554', decimals: 6, usdValue: null, recommendation: 'keep', whyCode: 'no-price', inBurnAll: true, burnNeedsConfirmation: true }),
  hold(5, 1, { symbol: 'PEPEMOON', amount: '5000000', decimals: 6, usdValue: null, solValue: 0.00015, recommendation: 'burn', whyCode: 'cheap-memecoin' }),
];
const frases = [
  frase(1, { holdings: [holdings[0], holdings[2], holdings[3], holdings[4]] }),
  frase(2, { app: 'phantom', wallets: [1, 2, 3].map((i) => wal(2, i)), holdings: [holdings[1]], review: { accounts: [acc(0), acc(1), acc(2), acc(3, { warnings: ['tem 0,1200 SOL solto: parece carteira de uso'] })], warnings: [] } }),
  frase(3, { feeWarning: 'Nenhuma burner tem SOL para pagar as taxas de rede.', feeWait: WAIT }),
  { n: 4, app: 'solflare', status: 'erro', error: { code: 'seed-checksum', params: {} }, main: null, discovery: null, wallets: [], holdings: [], review: null, evm: null, totals: null, feeWarning: null, feeWait: null, planNotice: null, nothingToClean: false, tempoMs: null },
];
const base = { busy: null, cluster: 'mainnet', rpc: 'api.mainnet-beta.solana.com (público, mais lento)', frases, holdings, totals: totals(9_000_000_000), progress: null, pause: null, solUsd: 150, priceErrors: [], burnLocked: 0, pricesAvailable: true, confirm: null, plan: null, simResults: [], execResults: [], receipt: null, arrived: '0', arrivedAppFee: '0', aborted: null, abortedError: null, abortedFrase: null, reportFile: null };
const step = (i, kind = 'tokens') => ({ kind, walletIndex: i, estimateLamports: null, close: 2, burnClose: 0, transferClose: 0, isFeePayer: kind === 'sweep-sol' });
const planStep = (i, kind) => ({ walletIndex: i, label: `N=${i}`, description: 'x', step: step(i, kind) });
const planF = (n, app, steps) => ({ frase: n, app, feePayerIndex: 0, feePayer: addr(`W${n}x`, 0), payerOutsideSelection: false, steps, kept: [], skipped: [] });
const DEST = MAIN(1);
const PLAN = { destination: DEST, frases: [planF(1, 'solflare', [planStep(1), planStep(0, 'sweep-sol')]), planF(2, 'phantom', [planStep(1), planStep(2), planStep(3, 'sweep-sol')])] };
const partial = { ...base, plan: PLAN, confirm: { start: 8, end: 12 }, frases: frases.map((f) => (f.n === 3 ? { ...f, feeWarning: null } : f)) };
const tk = (lbl, sym, amount, usd) => ({ walletIndex: 1, label: lbl, account: 'a', mint: 'm', symbol: sym, amount, decimals: 0, usdValue: usd, solValue: null });
const rcpt = (n, app, lbl, tokens = [], burned = []) => ({ frase: n, app, receipt: { destination: DEST, toDestination: { closedAccounts: '2', closedRentLamports: '2976880', claims: 1, claimLamports: '120000000', tokens, looseSolLamports: '5000000' }, burned, kept: [], failed: [], totalLamports: '127976880', feeEstimateLamports: '15000', appFeeLamports: '14000000', appFeeWallet: 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL', feePayerIndex: 0, feePayerLabel: n === 2 ? 'Conta 1' : 'N=0', destinationIsMain: true } });
const simDone = { ...partial, simResults: [{ frase: 1, status: 'simulado', step: step(1), walletIndex: 1, destinationDelta: '2976880' }, { frase: 2, status: 'simulado', step: step(1), walletIndex: 1, destinationDelta: '1000' }], receipt: { frases: [rcpt(1, 'solflare', 'N=1', [], [tk('N=1', 'MEME', '98000000', 0.004)]), rcpt(2, 'phantom', 'Conta 2', [tk('Conta 2', 'BONK', '154200', 3.1)])], totalLamports: '255953760', feeEstimateLamports: '30000', appFeeLamports: '28000000', destination: DEST, failedCount: 0, burnedCount: 1, keptCount: 0 } };
const ev = (type, data) => run(`events.dispatchEvent(new MessageEvent(${JSON.stringify(type)}, { data: ${JSON.stringify(JSON.stringify(data))} })); true`);
const calls = (u) => run(`window.__sent.filter((x) => x.u === ${JSON.stringify(u)}).length`);
// recibo com um passo que falharia e o técnico do nó; um token sem nome e sem preço
const failedErr = { code: 'sim-insufficient', params: {}, technical: 'Transfer: insufficient lamports 0, need 240640', beforeSend: true };
const r1 = simDone.receipt.frases[0].receipt;
const noName = { ...holdings[3], id: 6, account: 'acct6', mint: addr('Mint', 6), symbol: null, priceLookupFailed: true };
const rich = { ...simDone, holdings: [...holdings, noName],
  receipt: { ...simDone.receipt, frases: [{ ...simDone.receipt.frases[0], receipt: { ...r1, failed: [{ walletIndex: 2, label: 'N=2', description: 'z', error: failedErr }] } }, ...simDone.receipt.frases.slice(1)] },
  simResults: [...simDone.simResults, { frase: 1, status: 'falhou', step: { kind: 'sweep-sol', walletIndex: 2, estimateLamports: '1' }, walletIndex: 2, destinationDelta: null, detail: 'insufficient lamports', error: failedErr }] };

// Página nova, efeito de fundo desligado (a foto de página inteira, até 5000 px de altura, faz o fundo WebGL ocupar a
// GPU e atrasar os quadros de animação de que a barra e a troca de idioma dependem; este roteiro testa o botão, não o
// fundo, que o cdp-check e o cdp-fundo-gpu conferem), fetch falso e a confirmação aberta.
async function fresh() {
  await cdp('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await run(`(() => { if (typeof applyFx === 'function' && document.getElementById('fx-toggle')) applyFx(false); return true; })()`);
  // fetch falso: guarda o que a página manda; /api/executar responde conforme window.__exec
  await run(`(() => { window.__sent = []; window.__exec = () => new Response('{"ok":true}', { status: 202 }); window.fetch = async (u, o) => {
    const body = o?.body ? JSON.parse(o.body) : null; window.__sent.push({ u, body });
    if (u === '/api/executar') return window.__exec();
    if (u === '/api/estado') return new Response(JSON.stringify(window.__state ?? null), { status: 200 });
    if (u === '/api/simular') return new Response('{"ok":true}', { status: 202 });
    return new Response('{"ok":true}', { status: 200 });
  }; return true; })()`);
  await run(`window.__state = ${JSON.stringify(rich)}; true`);
  await ev('pronto', { tarefa: 'simulacao', estado: rich });
  await sleep(700);
}

try {
  await fresh();

  // ---- 1. recibo na confirmação ----
  const c = await run(`({ section: ui.section, avisos: document.getElementById('c-avisos').textContent, tokens: document.getElementById('c-tokens').innerText, pre: [...document.querySelectorAll('#s-confirmar pre')].map((p) => Boolean(p.closest('details')) && /insufficient lamports 0/.test(p.textContent)), loose: document.getElementById('s-confirmar').innerText.includes('insufficient lamports 0'), noName: t('dec.noName') })`);
  check('confirmação: passo que falharia vira aviso com a contagem', c.section === 's-confirmar' && /1 passo\(s\) falhariam/.test(c.avisos), c.avisos.slice(0, 120));
  check('confirmação: o técnico do nó só dentro de "detalhes", fechado', c.pre.length > 0 && c.pre.every(Boolean) && !c.loose, JSON.stringify(c.pre));
  check('confirmação: token sem nome aparece como "sem nome"', c.tokens.includes(c.noName), c.noName);
  check('confirmação: sem preço = "valor desconhecido", nunca US$ 0', /WIFCAT[^\n]*\n[^\n]*valor desconhecido/.test(c.tokens) && !/US\$ 0[,.]00\b/.test(c.tokens));
  await shot('t8-1-confirmar.png');

  // ---- 2. botão segurado ----
  await fresh();
  await run(`ui.sim.done = false; renderHold(); true`);
  const h0 = await run(`({ dis: document.getElementById('b-executar').disabled, hint: document.getElementById('hold-hint').textContent })`);
  check('botão trancado enquanto o teste dos passos não termina', h0.dis && /libera quando o teste/.test(h0.hint), h0.hint);
  await run(`ui.sim.done = true; renderHold(); document.getElementById('b-executar').scrollIntoView({ block: 'center' }); true`);
  await sleep(300);
  const h1 = await run(`({ dis: document.getElementById('b-executar').disabled, hint: document.getElementById('hold-hint').textContent })`);
  check('teste terminado: botão liga e explica como segurar', !h1.dis && /Mantenha apertado/.test(h1.hint), h1.hint);
  const box = await run(`(() => { const r = document.getElementById('b-executar').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const mouse = (type) => cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
  await mouse('mousePressed'); await sleep(900); await mouse('mouseReleased'); await sleep(1600);
  check('soltar com 0,9 s: NÃO chama /api/executar', (await calls('/api/executar')) === 0);
  check('soltar zera a barra', (await run(`document.getElementById('b-executar').style.getPropertyValue('--hold')`)) === '0');
  await mouse('mousePressed'); await sleep(1000);
  const mid = Number(await run(`document.getElementById('b-executar').style.getPropertyValue('--hold')`));
  check('segurando: barra no meio do caminho', mid > 0.3 && mid < 0.8, String(mid));
  await shot('t8-2-segurando.png');
  await sleep(1400); await mouse('mouseReleased'); await sleep(500);
  check('segurar 2 s: chama /api/executar uma vez', (await calls('/api/executar')) === 1);
  check('execução começou (tela Enviando)', (await run(`ui.section`)) === 's-execucao');
  // teclado: Espaço também conta; soltar antes não (página nova: o envio do mouse já levou à tela Enviando)
  await fresh();
  await run(`document.getElementById('b-executar').focus(); true`);
  const key = (type) => cdp('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined });
  await key('keyDown'); await sleep(700); await key('keyUp'); await sleep(1600);
  check('Espaço solto com 0,7 s: não executa', (await calls('/api/executar')) === 0);
  await key('keyDown'); await sleep(2300); await key('keyUp'); await sleep(400);
  check('Espaço segurado 2 s: executa', (await calls('/api/executar')) === 1);

  // ---- 3. recusa do /api/executar em cartão ----
  await fresh();
  await run(`(() => { window.__exec = () => new Response(JSON.stringify({ erro: 'O destino não é uma carteira comum...', codigo: 'dest-not-ordinary', params: { owner: 'P' } }), { status: 400 }); state.execResults = []; show('s-confirmar'); ui.sim.done = true; renderHold(); executar(); return true; })()`);
  await sleep(500);
  const e1 = await run(`({ card: !!document.querySelector('#e-executar .errcard'), txt: document.getElementById('e-executar').textContent, section: ui.section })`);
  check('recusa com código: cartão com o que houve / o app / você, e fica na confirmação', e1.card && /não é uma carteira comum/.test(e1.txt) && /O que você faz/.test(e1.txt) && e1.section === 's-confirmar', e1.txt.slice(0, 100));
  await run(`document.querySelector('input[name=idioma][value=en]').click(); true`);
  await sleep(400);
  check('cartão de recusa redesenha em inglês', /not an ordinary wallet/.test(await run(`document.getElementById('e-executar').textContent`)));
  await run(`document.querySelector('input[name=idioma][value=pt]').click(); true`);
  await sleep(400);
  await shot('t8-3-recusa.png');

  // ---- 4. rede caída: simulação (tenta de novo), execução (não insiste), análise (colar de novo) ----
  await run(`(() => { ui.prep.phase = 'simulacao'; ui.sim = { items: [], done: false, error: null }; renderPrep(); show('s-preparo'); return true; })()`);
  await ev('erro', { tarefa: 'simulacao', mensagem: 'x', codigo: 'network-down', params: {} });
  await sleep(300);
  const s1 = await run(`({ txt: document.getElementById('p-cards').textContent, btn: [...document.querySelectorAll('#p-cards button')].map((b) => b.textContent) })`);
  check('rede caiu na simulação: cartão + "Tentar de novo" + "Voltar ao início"', /Não deu para falar com a rede/.test(s1.txt) && s1.btn.includes('Tentar de novo') && s1.btn.some((b) => /Voltar ao início/.test(b)), JSON.stringify(s1.btn));
  const before = await calls('/api/simular');
  await run(`[...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Tentar de novo').click(); true`);
  await sleep(400);
  check('"Tentar de novo" simula de novo e o cartão some', (await calls('/api/simular')) === before + 1 && !/Não deu para falar/.test(await run(`document.getElementById('p-cards').textContent`)));
  await shot('t8-4-erro-sim.png');
  await ev('erro', { tarefa: 'execucao', mensagem: 'x', codigo: 'network-down', params: {} });
  await run(`show('s-execucao'); true`);
  const x1 = await run(`({ txt: document.getElementById('x-erro').textContent, btn: document.querySelectorAll('#x-erro button').length })`);
  check('rede caiu na execução: cartão SEM "Tentar de novo" (não insiste)', x1.btn === 0 && /Não deu para falar/.test(x1.txt) && /não insiste/.test(x1.txt), x1.txt.slice(0, 120));
  await ev('erro', { tarefa: 'analise', mensagem: 'x', codigo: 'network-down', params: {} });
  await sleep(300);
  const a1 = await run(`({ section: ui.section, msg: document.getElementById('e-frase').textContent, want: t('err.network-down.reanalyze') })`);
  check('rede caiu na análise: volta para as frases pedindo para colar de novo', a1.section === 's-frase' && a1.msg === a1.want && a1.msg.length > 0, a1.msg);

  // ---- 5. aviso rpc-busy ----
  await ev('aviso', { codigo: 'rpc-busy' });
  check('aviso rpc-busy aparece discreto (notice ok)', /mais devagar/.test(await run(`document.querySelector('#aviso-rede .notice.ok')?.textContent ?? ''`)));
  await ev('pronto', { tarefa: 'outra', estado: rich });
  await sleep(300);
  check('aviso some quando a tarefa termina', (await run(`document.getElementById('aviso-rede').textContent`)) === '');

  // ---- 6. celular ----
  await run(`window.__state = ${JSON.stringify(rich)}; true`);
  await ev('pronto', { tarefa: 'simulacao', estado: rich });
  await sleep(600);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await sleep(400);
  const w = await run(`document.documentElement.scrollWidth`);
  check('390 px: confirmação sem rolagem lateral', w <= 391, String(w));
  await shot('t8-5-confirmar-390.png', 390);
  check('nenhum erro de JavaScript', jsErrors.length === 0, jsErrors.join(' || ').slice(0, 300));
} finally {
  await closeEdge();
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checagens`);
process.exit(ok === results.length ? 0 : 1);
