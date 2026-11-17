// Regressão visual das 4 telas do fluxo 0.1.4 (frases e destino, preparando, confirmar, enviando) com estado
// inventado (o mesmo do cdp-fluxo.mjs) e fetch interceptado: temas claro/escuro, pt/en, 1280 e 390 px; em cada tela,
// nada de "undefined/null/NaN" e sem rolagem horizontal. Depois: consulta de preço falhada (um aviso só; o token
// ainda pode ser queimado), fontes locais, contraste WCAG das cores, chaves do topo, efeito de fundo e erros de JS.
// O que cada tela FAZ está no cdp-fluxo.mjs; este confere como ela FICA. Sem frase nenhuma.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-check.mjs <pasta-prints>
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
// consulta de preço falhada (Jupiter no limite): o WIFCAT fica como valor desconhecido, com queimar pela palavra
holdings[3].priceLookupFailed = true;
const ready = { ...simDone, pricesMissing: 1, holdings };
const execDone = { ...ready, execResults: ready.simResults.map((r) => ({ ...r, status: 'enviado', link: 'https://solscan.io/tx/abc' })), reportFile: 'relatorios/2026-10-31.report.json' };
const intercept = `(() => {
  window.__sent = [];
  const real = window.fetch;
  window.fetch = async (u, o) => {
    const body = o?.body ? JSON.parse(o.body) : null;
    window.__sent.push({ u, body });
    if (u === '/api/estimativa') return new Response(JSON.stringify({ seconds: 900, credits: 4000, wallets: body?.carteiras ?? 100 }), { status: 200 });
    if (u === '/api/estado') return new Response(JSON.stringify(window.__state ?? null), { status: 200 });
    if (typeof u === 'string' && u.startsWith('/api/') && o?.method === 'POST') return new Response('{"ok":true}', { status: 202 });
    return real(u, o);
  };
  return true;
})()`;
const ev = (type, data) => run(`events.dispatchEvent(new MessageEvent(${JSON.stringify(type)}, { data: ${JSON.stringify(JSON.stringify(data))} })); true`);

async function sanity(label) {
  const r = await run(`(() => {
    const txt = document.querySelector('main').innerText;
    const bad = txt.match(/\\b(undefined|null|NaN|\\[object Object\\])\\b/g) || [];
    // largura VISÍVEL: no modo celular a janela de layout (innerWidth) cresce junto com o que vaza e esconderia o defeito
    const vw = Math.round(visualViewport.width);
    // texto que vaza da própria caixa (endereço longo sem quebra) e não está numa caixa com rolagem própria
    const leaks = []; const w = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); if ([...rg.getClientRects()].some((b) => b.right > vw + 1)) { let p = n.parentElement, scroll = false; for (; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') { scroll = true; break; } if (!scroll) leaks.push(n.parentElement.tagName + '.' + n.parentElement.className + ': ' + n.textContent.trim().slice(0, 40)); } }
    return { bad, leaks, over: document.documentElement.scrollWidth - vw, visible: [...document.querySelectorAll('main > section')].filter((s) => !s.classList.contains('hidden') && s.id.startsWith('s-')).map((s) => s.id) };
  })()`);
  check(`${label}: sem "undefined/null/NaN" no texto`, r.bad.length === 0, r.bad.join(','));
  check(`${label}: sem rolagem horizontal`, r.over <= 1, `sobra ${r.over}px`);
  check(`${label}: nenhum texto vaza da largura visível`, r.leaks.length === 0, r.leaks.slice(0, 2).join(' | '));
  return r;
}

async function scenario(theme, lang, width, mobile = width < 600) {
  const tag = `${theme}-${lang}-${width}${mobile ? '' : '-janela'}`;
  // a foto (shot) volta a janela para 1280 px no fim: a largura do cenário é reposta depois de cada foto, senão as
  // telas seguintes seriam conferidas em 1280 (foi assim até 31/10/2026 e escondeu o endereço vazando em 390/420)
  const view = () => cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
  const photo = async (name) => { await shot(name, width); await view(); await sleep(250); };
  // about:blank antes: a URL só muda no '#' (código de acesso) e o navegador não recarregaria a página
  await cdp('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await run(intercept);
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
  await run(`(() => { document.querySelector('input[name=tema][value=${theme}]').click(); document.querySelector('input[name=idioma][value=${lang}]').click(); return true; })()`);
  await sleep(500);
  check(`${tag}: tema aplicado`, (await run('document.documentElement.dataset.theme')) === theme);
  const s1 = await sanity(`${tag} frases e destino`);
  check(`${tag}: só a tela das frases visível`, s1.visible.join() === 's-frase', s1.visible.join());
  await photo(`${tag}-1-frases.png`);

  await run(`window.__state = ${JSON.stringify({ ...base, busy: 'analise' })}; ui.dest = { mode: 'main', addr: '' }; beginAnalysis(4); ui.prep.phase = 'analise'; onProgress({ fase: 'leitura', frase: 2, carteira: 'Conta 3', feitos: 1, total: 3, etaMs: 95000, geral: { feitos: 4, total: 12 } }); renderPrep(); show('s-preparo'); true`);
  await sleep(600);
  await sanity(`${tag} preparando (análise)`);
  await photo(`${tag}-2-preparando.png`);

  await run(`window.__state = ${JSON.stringify(base)}; true`);
  await ev('pronto', { tarefa: 'analise', estado: base });
  await sleep(500);
  await sanity(`${tag} preparando (pendências)`);
  await photo(`${tag}-3-pendencias.png`);

  await run(`window.__state = ${JSON.stringify(ready)}; true`);
  await ev('pronto', { tarefa: 'simulacao', estado: ready });
  await sleep(600);
  const s4 = await sanity(`${tag} confirmar`);
  // texto que passa da borda do próprio cartão (endereço longo sem quebra, por exemplo) também é defeito no celular
  const clip = await run(`[...document.querySelectorAll('#s-confirmar *')]
    .filter((e) => e.children.length === 0 && e.textContent.trim() && e.getBoundingClientRect().width > 0)
    .filter((e) => { const box = e.closest('.receipt, .sheet, section'); for (let p = e.parentElement; p && p !== box; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return false; const r = e.getBoundingClientRect(); const b = box.getBoundingClientRect(); return r.right > b.right + 1; })
    .map((e) => e.tagName + '.' + e.className + ': ' + e.textContent.trim().slice(0, 50))`);
  check(`${tag}: nenhum texto passa da borda do cartão na confirmação`, clip.length === 0, clip.slice(0, 3).join(' | '));
  check(`${tag}: tela de confirmar visível`, s4.visible.join() === 's-confirmar', s4.visible.join());
  await photo(`${tag}-4-confirmar.png`);

  await run(`state = ${JSON.stringify(execDone)}; ui.exec = { items: state.execResults, done: true, error: null }; show('s-execucao'); renderExecFim(); true`);
  await sleep(500);
  const s5 = await sanity(`${tag} enviando (fim)`);
  check(`${tag}: tela de envio visível`, s5.visible.join() === 's-execucao', s5.visible.join());
  await photo(`${tag}-5-enviado.png`);
}

try {
  // 420 sem modo celular = a janela do app de desktop na largura mínima (minWidth de desktop/main.ts)
  for (const [theme, lang, width, mobile] of [['dark', 'pt', 1280], ['light', 'pt', 1280], ['dark', 'en', 1280], ['light', 'en', 390], ['dark', 'pt', 390], ['dark', 'pt', 420, false]]) await scenario(theme, lang, width, mobile);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // consulta de preço falhada: um aviso só, com a contagem; o token continua com "Queimar" (pela palavra)
  // about:blank antes: a URL só muda no '#' (código de acesso) e o navegador não recarregaria a página
  await cdp('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await cdp('Page.navigate', { url });
  await sleep(2200);
  await run(intercept);
  await run(`document.querySelector('input[name=idioma][value=pt]').click(); window.__state = ${JSON.stringify(ready)}; true`);
  await ev('pronto', { tarefa: 'simulacao', estado: ready });
  await sleep(600);
  const pm = await run(`({ notices: [...document.querySelectorAll('#s-confirmar .notice')].map((n) => n.textContent), opts: [...(document.querySelector('#c-tokens .tk[data-account="acct4"] select')?.options ?? [])].map((o) => o.value) })`);
  check('preço falhado: um aviso com a contagem e "queimar confirmando com a palavra"', pm.notices.filter((n) => /consulta de preços falhou para 1 token/.test(n)).length === 1 && pm.notices.some((n) => /queimar confirmando com a palavra/.test(n)), JSON.stringify(pm.notices).slice(0, 300));
  check('preço falhado: o token ainda tem a opção Queimar', pm.opts.includes('burn'), pm.opts.join(','));
  check('preço falhado: nenhum aviso técnico por lote da API', !pm.notices.some((n) => /lote \d/.test(n)));
  await shot('preco-falhado-confirmar.png');

  // fontes locais carregadas
  const fonts = await run(`document.fonts.ready.then(() => [...document.fonts].map((f) => f.family.replace(/"/g, '') + ':' + f.weight + ':' + f.status))`);
  for (const want of ['Inter', 'Chakra Petch', 'JetBrains Mono']) check(`fonte ${want} carregada`, fonts.some((f) => f.startsWith(want) && f.endsWith('loaded')), fonts.join(' | '));

  // chaves do topo: sem giro no PT/EN; barra de rolagem do app
  const css = await run(`[...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => r.cssText).join('\\n')`);
  check('chave PT/EN: animação sem rotate', /@keyframes switch-in/.test(css) && !/switch-in[^}]*rotate/.test(css.replace(/\n/g, ' ')));
  check('barra de rolagem com o desenho do app', css.includes('::-webkit-scrollbar-thumb'));

  // efeito de fundo: este Edge (--force-dark-mode, sem forçar GPU) usa a GPU desta máquina; com GPU de verdade o
  // efeito liga e o botão existe; desligar esconde o canvas e lembra. Sem GPU o cdp-fundo-gpu.mjs confere.
  const fx0 = await run(`({ canvas: !!document.getElementById('fx'), btn: !!document.getElementById('fx-toggle') })`);
  check('efeito: canvas e botão andam juntos (os dois ou nenhum)', fx0.canvas === fx0.btn, JSON.stringify(fx0));
  if (fx0.btn) {
    const fx1 = await run(`(() => { const b = document.getElementById('fx-toggle'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); b.click(); return { pressed: b.getAttribute('aria-pressed'), hidden: document.getElementById('fx').classList.contains('hidden'), saved: localStorage.getItem('autoclarn-efeito') }; })()`);
    check('efeito: desligar esconde o fundo e lembra', fx1.pressed === 'false' && fx1.hidden && fx1.saved === 'off', JSON.stringify(fx1));
    await run(`document.getElementById('fx-toggle').click(); true`);
  }

  // contraste das cores (WCAG): texto normal precisa de 4,5:1
  const contrast = await run(`(() => {
    const lum = (hex) => { const c = hex.match(/\\w\\w/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return +((x + .05) / (y + .05)).toFixed(2); };
    const out = {};
    for (const theme of ['light', 'dark']) {
      document.documentElement.dataset.theme = theme;
      const s = getComputedStyle(document.documentElement); const v = (n) => s.getPropertyValue(n).trim();
      for (const fg of ['--text', '--soft', '--faint', '--money', '--burn', '--warn', '--danger', '--brand']) for (const bg of ['--bg', '--surface']) out[theme + ' ' + fg + ' em ' + bg] = ratio(v(fg), v(bg));
      out[theme + ' --brand-ink em --brand'] = ratio(v('--brand-ink'), v('--brand'));
      out[theme + ' --brand-ink em --danger'] = ratio(v('--brand-ink'), v('--danger'));
    }
    return out;
  })()`);
  for (const [k, r] of Object.entries(contrast)) check(`contraste ${k}`, r >= 4.5, String(r));

  check('nenhum erro de JavaScript na página', jsErrors.length === 0, jsErrors.join(' || ').slice(0, 400));
} finally {
  await closeEdge();
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checagens`);
process.exit(ok === results.length ? 0 : 1);
