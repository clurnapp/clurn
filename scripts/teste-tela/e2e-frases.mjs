// Ponta a ponta do fluxo em 4 etapas pela TELA, na DEVNET (dinheiro de mentira), até o ENVIO (31/10/2026).
// A página abre com ?rede=devnet (a tela não tem mais a escolha de rede). Confere na rede a taxa de 11% e as principais.
// Frases descartáveis da devnet criadas por `node scripts/devnet-frases.ts novas|preparar <pasta>` (fora do repositório).
// As frases vão do arquivo direto para os cartões da página e nunca são impressas.
// Só executa com a rodada na devnet (state.cluster === 'devnet'); em qualquer outra rede, para antes.
// Uso: node e2e-frases.mjs <url-do-app> <pasta-das-frases> <pasta-prints>
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { deriveMainAddress, mnemonicToSeed } from '../../src/core/carteiras/derivation.ts';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';

const [url, phraseDir, outDir] = process.argv.slice(2);
const ROOT = path.join(import.meta.dirname, '..', '..');
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
const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${info ? ' — ' + info : ''}`); };
async function waitFor(expr, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await run(expr)) return true; await sleep(1500); } return false; }
async function shot(name) {
  const h = await run('Math.ceil(document.documentElement.scrollHeight)');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}
async function stop(msg) {
  console.log(`PAROU: ${msg}`);
  await shot('ef-parou.png');
  await closeBrowser(1);
}

await cdp('Runtime.enable');
const devUrl = (() => { const u = new URL(url); u.searchParams.set('rede', 'devnet'); return u.toString(); })();
await cdp('Page.navigate', { url: devUrl });
await sleep(2500);

// guarda o corpo de cada /api/plano (só endereços públicos e decisões) para conferir os dois destinos
await run(`(() => { window.__planBodies = []; const real = window.fetch; window.fetch = (u, o) => { if (u === '/api/plano' && o?.body) window.__planBodies.push(JSON.parse(o.body)); return real(u, o); }; return true; })()`);

// 1. três cartões: frase 1 Solflare, frase 2 Phantom, frase 3 Solflare; destino = principal da frase 1, colado 2×
// (o roteiro calcula o endereço público da frase 1 aqui, como a pessoa leria na própria Solflare; a semente é zerada)
const phrases = ['frase-1', 'frase-2', 'frase-3'].map((n) => readFileSync(path.join(phraseDir, `${n}.txt`), 'utf8').trim());
const mainOf = (p) => { const seed = mnemonicToSeed(p); try { return deriveMainAddress(seed); } finally { seed.fill(0); } };
const DEST = mainOf(phrases[0]);
const OTHER_MAINS = [mainOf(phrases[1]), mainOf(phrases[2])]; // principais das frases 2 (Conta 1 da Phantom) e 3: não podem mudar
const devnet = async (method, params) => (await (await fetch('https://api.devnet.solana.com', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const bal = async (a) => (await devnet('getBalance', [a, { commitment: 'confirmed' }]))?.value ?? -1;
const before = { fee: await bal(APP_FEE_WALLET), mains: [] };
for (const m of OTHER_MAINS) { before.mains.push(await bal(m)); await sleep(400); }
if (!(await run(`PARAMS.rede === 'devnet' && !document.querySelector('input[name=rede]')`))) await stop('a página não abriu na devnet (?rede=devnet)');
await run(`(() => {
  document.getElementById('b-add').click();
  document.getElementById('b-add').click();
  // o cartão não pergunta o app: o servidor descobre (frase 2 tem a Conta 2 e 3 → Phantom)
  const texts = ${JSON.stringify(phrases)};
  entry.cards.forEach((c, i) => {
    c.ta.value = texts[i];
    c.ta.dispatchEvent(new Event('input'));
  });
  for (const id of ['destino']) { const f = document.getElementById(id); f.value = ${JSON.stringify(DEST)}; f.dispatchEvent(new Event('input')); }
  return true;
})()`);
phrases.fill('');
check('3 frases conferidas na página (selo verde) e o destino colado 2×', await waitFor(`entry.cards.length === 3 && entry.cards.every((c) => c.check.code === 'ok') && !document.getElementById('b-analisar').disabled && document.getElementById('dest-why').textContent === ''`, 20000),
  await run(`entry.cards.map((c) => c.check.code).join(',')`));
await run(`document.getElementById('b-analisar').click(); true`);
check('frases apagadas da página logo depois de enviar', await waitFor(`entry.cards.every((c) => c.ta.value === '')`, 20000));
check('vai para "Preparando" e narra a análise, sem valor em dinheiro', await waitFor(`ui.section === 's-preparo' && ui.prep.phase === 'analise'`, 20000) && !(await run(`/SOL\\b|US\\$/.test(document.getElementById('s-preparo').textContent)`)));
await sleep(8000);
await shot('ef-1-analisando.png');
const t0 = Date.now();
const done = await waitFor(`(ui.section === 's-preparo' && ui.prep.phase !== 'analise') || ui.section === 's-confirmar' || document.getElementById('e-frase').textContent.length > 0`, 900000);
const eFrase = await run(`document.getElementById('e-frase').textContent`);
check('análise das 3 frases terminou', done && !eFrase, `${Math.round((Date.now() - t0) / 1000)} s ${eFrase}`);
if (!done || eFrase) await stop('análise');

// 2. estado de cada frase; a Phantom pede a confirmação das contas
const res = await run(`({
  cluster: state.cluster, phase: ui.prep.phase,
  frases: state.frases.map((f) => ({ n: f.n, app: f.app, status: f.status, found: f.discovery?.found, wait: Boolean(f.feeWait), nothing: f.nothingToClean })),
  cards: [...document.querySelectorAll('#p-cards .need')].map((c) => c.dataset.frase).join(),
})`);
console.log('frases:', JSON.stringify(res.frases), '| fase', res.phase, '| cartões', res.cards);
if (res.cluster !== 'devnet') await stop(`rede ${res.cluster}: este roteiro só roda na devnet`);
check('frase 1 (Solflare) e frase 2 (Phantom) prontas; frase 3 esperando o depósito', res.frases[0]?.status === 'pronta' && res.frases[1]?.status === 'pronta' && res.frases[1]?.app === 'phantom' && res.frases[2]?.wait === true, JSON.stringify(res.frases));
check('pendência: cartão das contas da Phantom (frase 2)', res.phase === 'pendente' && res.cards.split(',').includes('2'), res.cards);
check('nenhuma Conta 1 da Phantom entre as carteiras da frase 2', await run(`state.frases[1].wallets.every((w) => w.index !== 0)`));
await shot('ef-2-phantom.png');

// 3. confirma a contagem da Phantom → o app monta o plano sozinho → parcial (frase 3 espera o depósito)
await run(`(() => { document.getElementById('rev-n-2').value = String(reviewTargets(fraseOf(2)).length); [...document.querySelectorAll('#p-cards [data-frase="2"] button')].find((b) => b.textContent === 'Continuar').click(); return true; })()`);
const partial = await waitFor(`ui.prep.phase === 'espera' || ui.prep.phase === 'erro' || ui.section === 's-confirmar'`, 180000);
const after = await run(`({ phase: ui.prep.phase, cards: document.getElementById('p-cards').textContent, err: ui.prep.error?.mensagem ?? null, plan: (state.plan?.frases ?? []).map((p) => p.frase).join() })`);
check('plano parcial: espera o depósito da frase 3 na mesma tela (frases 1 e 2 no plano)', partial && after.phase === 'espera' && /Esperando o depósito/.test(after.cards) && after.plan === '1,2', after.err ?? `${after.phase} ${after.plan}`);
if (after.err) await stop(`plano recusado: ${after.err}`);
const sentPlan = await run(`window.__planBodies?.at(-1) ?? null`);
if (sentPlan) check('o plano levou o destino como foi colado (uma vez)', sentPlan.destino === DEST && !('destino2' in sentPlan), JSON.stringify(sentPlan).slice(0, 120));
await shot('ef-3-espera.png');

// 4. depósito na frase 3 (fora do app): o app percebe, monta o plano de novo com as 3 e simula sozinho
console.log(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'devnet-frases.ts'), 'depositar', phraseDir], { encoding: 'utf8' }).trim());
const simGo = await waitFor(`ui.prep.phase === 'simulacao' || ui.section === 's-confirmar'`, 180000);
check('depósito chegou: o app seguiu sozinho para o teste de cada passo', simGo);
if (!simGo) await stop('o depósito não levou à simulação');
await sleep(5000);
await shot('ef-4-testando.png');
const simDone = await waitFor(`ui.section === 's-confirmar' || Boolean(ui.sim.error)`, 900000);
const sim = await run(`({
  section: ui.section, err: ui.sim.error?.mensagem ?? null, aborted: state.aborted,
  planFrases: state.plan.frases.map((p) => ({ n: p.frase, steps: p.steps.length, idx: p.steps.map((s) => s.walletIndex) })),
  total: document.querySelector('#c-encontrado .receipt-total')?.textContent,
  lines: [...document.querySelectorAll('#c-encontrado .line')].map((l) => l.textContent),
  main: !document.getElementById('c-main').classList.contains('hidden'),
  dest: [...document.querySelectorAll('#c-destino span')].map((s) => s.textContent).join(''),
  hold: document.getElementById('b-executar').disabled,
})`);
console.log('plano:', JSON.stringify(sim.planFrases), '| total', sim.total);
check('teste terminou sem parada e abriu "Confira e envie"', simDone && sim.section === 's-confirmar' && !sim.err && !sim.aborted, sim.err ?? sim.aborted ?? '');
check('as 3 frases no plano', sim.planFrases.map((p) => p.n).join() === '1,2,3', sim.planFrases.map((p) => p.n).join());
check('nenhum passo na Conta 1 da Phantom (frase 2)', sim.planFrases.find((p) => p.n === 2)?.idx.every((i) => i !== 0));
check('confirmação: total, de onde vem e a taxa do app', Boolean(sim.total) && sim.lines.some((l) => /Taxa do app/.test(l)) && sim.lines.some((l) => /Vai chegar no destino/.test(l)), sim.lines.join(' | ').slice(0, 200));
check('destino inteiro em blocos, com o selo "sua principal"; botão liberado sem digitar nada', sim.dest === DEST && sim.main && !sim.hold, JSON.stringify({ main: sim.main, hold: sim.hold }));
await shot('ef-5-confirmar.png');
if (sim.section !== 's-confirmar' || sim.err || sim.aborted) await stop('simulação');

// 5. executar (só devnet): segura o botão 2,6 s com o mouse
if ((await run('state.cluster')) !== 'devnet') await stop('rede mudou: não executa');
await run(`document.getElementById('b-executar').scrollIntoView({ block: 'center', behavior: 'instant' }); true`);
await sleep(800);
const box = await run(`(() => { const r = document.getElementById('b-executar').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
// soltar antes de 2 s não envia
await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(900);
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(1500);
check('soltar antes de 2 s não envia', (await run(`ui.section`)) === 's-confirmar');
await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await sleep(2600);
await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
const execGo = await waitFor(`ui.section === 's-execucao'`, 30000);
check('segurar 2 s começou o envio', execGo, await run(`document.getElementById('e-executar').textContent`));
if (!execGo) await stop('execução não começou');
await sleep(4000);
await shot('ef-6-enviando.png');
const execDone = await waitFor(`ui.exec.done || Boolean(ui.exec.error)`, 1200000);
const ex = await run(`({
  done: ui.exec.done, err: ui.exec.error?.mensagem ?? null, aborted: state.aborted,
  sent: state.execResults.filter((r) => r.status === 'enviado').length,
  failed: state.execResults.filter((r) => r.status === 'falhou').map((r) => 'frase ' + r.frase + ' ' + r.walletIndex + ': ' + (r.detail ?? r.error?.code ?? '')),
  unknown: state.execResults.filter((r) => r.status === 'desconhecido').length,
  arrived: state.arrived, appFee: state.arrivedAppFee, links: state.execResults.filter((r) => r.link).length,
  rows: [...document.querySelectorAll('#x-run .pf-row .pf-st')].map((e) => e.textContent),
  wallets: state.frases.flatMap((f) => (f.wallets ?? []).map((w) => ({ frase: f.n, label: w.label, address: w.address }))),
  report: state.reportFile,
})`);
console.log(`enviados ${ex.sent}, falhas ${ex.failed.length}, sem confirmação ${ex.unknown}, chegou ${Number(ex.arrived) / 1e9} SOL, taxa do app ${Number(ex.appFee) / 1e9} SOL, links ${ex.links}, relatório ${ex.report}`);
for (const f of ex.failed) console.log('  falhou:', f);
check('envio terminou sem parada', execDone && ex.done && !ex.err && !ex.aborted, ex.err ?? ex.aborted ?? '');
check('chegou SOL no destino e cada passo enviado tem link', BigInt(ex.arrived ?? 0) > 0n && ex.links >= ex.sent, `${ex.arrived}`);
check('linha de cada frase "Pronta ✓"', ex.rows.length === 3 && ex.rows.every((r) => /Pronta/.test(r)), ex.rows.join(','));
await shot('ef-7-fim.png');

// 6. na rede: taxa de 11%, principais intocadas e o que sobrou em cada carteira (conta congelada e NFT ficam por desenho)
await sleep(5000);
const after2 = { fee: await bal(APP_FEE_WALLET), mains: [] };
for (const m of OTHER_MAINS) { after2.mains.push(await bal(m)); await sleep(400); }
const feeGot = BigInt(after2.fee - before.fee), appFee = BigInt(ex.appFee ?? 0), arrived = BigInt(ex.arrived ?? 0);
check('carteira da taxa recebeu na rede exatamente o que o app relatou', feeGot === appFee && appFee > 0n, `rede ${feeGot} × relatado ${appFee}`);
// Regra (autor, 31/10/2026): todo SOL recuperado paga 11% UMA vez; isento só o depósito do cliente. No cenário, o
// único depósito é o da frase 3 (0,01 SOL na N=0, a pagadora dela), e ele cobre todo o envio final dela.
const rep = JSON.parse(readFileSync(path.join(ROOT, ex.report), 'utf8'));
const rows = []; const seenSig = new Set();
const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if ('destinationDelta' in o && o.status === 'enviado' && o.step) { const k = o.signature ?? JSON.stringify(o).slice(0, 120); if (!seenSig.has(k)) { seenSig.add(k); rows.push(o); } } Object.values(o).forEach(walk); } };
walk(rep);
const big = (v) => BigInt(String(v ?? 0));
const isDeposit = (r) => r.frase === 3 && r.step.kind === 'sweep-sol' && r.step.isFeePayer;
const wrong = rows.filter((r) => !isDeposit(r) && big(r.appFeeDelta) !== ((big(r.destinationDelta) + big(r.appFeeDelta)) * 1100n) / 10_000n);
for (const r of rows) console.log(`  frase ${r.frase} ${r.step.kind}${r.step.isFeePayer ? ' (pagadora)' : ''} N=${r.step.walletIndex}: destino ${r.destinationDelta}, taxa ${r.appFeeDelta}`);
check('cada envio paga exatamente 11% (inclusive a pagadora com SOL esquecido das frases 1 e 2)', rows.length === ex.sent && wrong.length === 0, wrong.map((r) => `frase ${r.frase} N=${r.step.walletIndex}`).join(', '));
check('o depósito da frase 3 não paga taxa', rows.filter(isDeposit).length === 1 && rows.filter(isDeposit).every((r) => big(r.appFeeDelta) === 0n));
const taxable = rows.filter((r) => !isDeposit(r)).reduce((x, r) => x + big(r.destinationDelta) + big(r.appFeeDelta), 0n);
const bps = taxable > 0n ? Number((appFee * 1_000_000n) / taxable) / 100 : 0;
check('rodada inteira: taxa = 11% do recuperado não depositado (arredondamento só para baixo, por envio)', bps > 1099 && bps <= 1100, `${(bps / 100).toFixed(4)}% de ${Number(taxable) / 1e9} SOL`);
check('principais das frases 2 (Conta 1 da Phantom) e 3 não mudaram', after2.mains.every((v, i) => v === before.mains[i]), `${before.mains.join(',')} → ${after2.mains.join(',')}`);
for (const w of ex.wallets) {
  const b = await bal(w.address);
  const t = await devnet('getTokenAccountsByOwner', [w.address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'base64' }]);
  console.log(`  frase ${w.frase} ${w.label}: ${b / 1e9} SOL, ${t?.value?.length ?? '?'} conta(s) de token`);
  await sleep(400);
}
check('nenhum erro de JavaScript', pageErrors.length === 0, pageErrors.join(' || '));
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await closeBrowser(results.every(Boolean) ? 0 : 1);
