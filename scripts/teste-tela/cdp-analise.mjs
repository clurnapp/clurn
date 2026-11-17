// Análise dentro da tela "Preparando" (fluxo em 4 etapas, 31/10/2026) e cartão da pausa num Edge headless. Nenhuma frase: o estado das frases e os
// pedidos /api/estado, /api/trocar-rpc e /api/parar são respostas falsas dentro da página, e os eventos do app
// ('progresso', 'pausa') são entregues chamando as mesmas funções que os eventos chamam. Nada é analisado.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-analise.mjs <pasta-prints>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`, '--force-dark-mode', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
// fecha o Edge de verdade: Browser.close pelo endpoint do navegador (edge.kill() só mata o lançador no Windows)
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
async function shot(name, width = 1280) {
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const h = await run('Math.ceil(document.documentElement.scrollHeight)');
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: Math.min(h, 5000), deviceScaleFactor: 1, mobile: width < 600 });
  await sleep(400);
  const wide = await run('document.documentElement.scrollWidth');
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return wide;
}

await cdp('Runtime.enable');
await cdp('Page.navigate', { url });
await sleep(2500);
// respostas falsas: 4 frases (a 2ª lendo, a 3ª com palavra errada); endereços inventados, públicos
const FRASES = [
  { n: 1, app: 'solflare', status: 'pronta', error: null, main: 'Fake1AAAA1111111111111111111111111111111ZZZ1', discovery: { found: 87, checked: 107, reachedMax: false }, tempoMs: 72000 },
  { n: 2, app: 'phantom', status: 'busca', error: null, main: 'Fake2BBBB1111111111111111111111111111111YYY2', discovery: null, tempoMs: 5000 },
  { n: 3, app: 'solflare', status: 'erro', error: { code: 'seed-unknown-word', params: { position: 7 } }, main: null, discovery: null, tempoMs: null },
  { n: 4, app: 'solflare', status: 'fila', error: null, main: 'Fake4DDDD1111111111111111111111111111111WWW4', discovery: null, tempoMs: null },
];
await run(`(() => {
  window.__sent = []; window.__frases = ${JSON.stringify(FRASES)}; window.__swapFail = true;
  const real = window.fetch;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (u, o) => {
    const body = o?.body ? JSON.parse(o.body) : null;
    window.__sent.push({ u, body });
    if (u === '/api/estado') return json({ busy: 'analise', frases: window.__frases, pause: null, progress: null });
    if (u === '/api/trocar-rpc') {
      if (window.__swapFail) return json({ erro: 'O servidor da rede recusou: [rpc]', codigo: 'rpc-blocked', params: {} }, 400);
      return json({ rpc: 'novo.exemplo', frases: window.__frases });
    }
    if (u === '/api/parar') return json({ rpc: 'x', frases: window.__frases.map((f) => f.status === 'fila' ? { ...f, status: 'erro', error: { code: 'stopped-by-user', params: {} } } : f) });
    return real(u, o);
  };
  return true;
})()`);
const snap = () => run(`({
  title: document.getElementById('p-titulo').textContent,
  eta: document.getElementById('p-eta').textContent,
  count: document.getElementById('p-count').textContent,
  bar: document.getElementById('p-barra').style.width,
  nowLabel: document.getElementById('p-now-label').textContent,
  now: document.getElementById('p-now').textContent,
  rows: [...document.querySelectorAll('#p-frases .pf-row')].map((r) => ({ cls: r.className, text: r.querySelector('.pf-what').textContent, chip: r.querySelector('.pf-st').textContent, mini: r.querySelector('.pf-mini i')?.style.width ?? null })),
  restart: { hidden: document.getElementById('restart').classList.contains('hidden'), disabled: document.getElementById('b-inicio').disabled, hint: document.getElementById('restart-hint').textContent },
  pause: { hidden: document.getElementById('pausa').classList.contains('hidden'), title: document.getElementById('pausa-title').textContent, err: document.getElementById('e-pausa').textContent, stop: document.getElementById('b-pausa-parar').textContent, stopHint: document.getElementById('pausa-stop-hint').textContent, note: document.getElementById('pausa-nota').textContent, field: !!document.getElementById('pausa-rpc') },
  stages: [...document.querySelectorAll('#p-stages .stage')].map((x) => x.className.replace('stage ', '')),
  docTitle: document.title,
})`);
check('carrega sem erro de script', pageErrors.length === 0, pageErrors.join(' | '));
await run(`beginAnalysis(4); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
await sleep(300);
let s = await snap();
check('título com o número de frases e da etapa', s.title === 'Analisando 4 frases' && s.docTitle === 'Etapa 2 de 4 · Preparando', `${s.title} / ${s.docTitle}`);
check('etapas narradas: a 1ª "agora", nenhuma feita antes do primeiro aviso', s.stages.join() === 'now,todo,todo,todo,todo', s.stages.join());
check('antes do primeiro aviso: "calculando…" e "começando…"', s.eta === 'calculando…' && s.now === 'começando…' && s.nowLabel === 'Agora:', `${s.eta} / ${s.now}`);
check('uma linha por frase com o estado do /api/estado', s.rows.length === 4 && s.rows.map((r) => r.chip).join('|') === 'Pronta ✓|Procurando|Pulada|Na fila', s.rows.map((r) => r.chip).join('|'));
check('pronta: carteiras, tempo e principal', /Solflare · 87 temporárias/.test(s.rows[0].text) && /pronta em 1 min 12 s · principal Fake…ZZZ1/.test(s.rows[0].text), s.rows[0].text);
check('erro: motivo pelo código, sem "principal"', /palavra nº 7/.test(s.rows[2].text) && !/principal/.test(s.rows[2].text), s.rows[2].text);
check('"Começar de novo" à vista, desligado durante a análise, diz quando libera', !s.restart.hidden && s.restart.disabled && /assim que a análise terminar/.test(s.restart.hint), s.restart.hint);
// aviso da leitura da frase 2, com tempo
await run(`onProgress({ fase: 'leitura', frase: 2, carteira: 'Conta 38', feitos: 55, total: 102, etaMs: 185000, geral: { feitos: 142, total: 289 } }); true`);
await sleep(200); s = await snap();
check('topo: "~3 min restantes", "142 de ~289 carteiras · 49%", barra', s.eta === '~3 min restantes' && s.count === '142 de ~289 carteiras · 49%' && s.bar === '49%', `${s.eta} / ${s.count} / ${s.bar}`);
check('"Agora:" com frase e carteira (Phantom)', s.now === 'lendo saldos, tokens e creator fees da frase 2 · Conta 38', s.now);
check('etapas: encontrar feita, ler "agora"', s.stages.join() === 'done,now,todo,todo,todo', s.stages.join());
check('nenhum valor em dinheiro na preparação', !(await run(`/SOL\\b|US\\$/.test(document.getElementById('s-preparo').textContent)`)));
check('linha da frase 2: lendo n de N, mini barra e tempo da frase', /Phantom · lendo 55 de 102/.test(s.rows[1].text) && s.rows[1].mini === '53%' && /min/.test(s.rows[1].chip), `${s.rows[1].text} / ${s.rows[1].chip}`);
const wideDark = await shot('analise-escuro.png', 1280);
const wideMobile = await shot('analise-celular.png', 390);
check('celular (390 px) sem rolagem lateral', wideMobile <= 390, String(wideMobile));
await run(`document.querySelector('input[name=tema][value=light]').click()`); await sleep(500);
await shot('analise-claro.png', 1280);
await run(`document.querySelector('input[name=tema][value=dark]').click()`); await sleep(300);
// inglês
await run(`document.querySelector('input[name=idioma][value=en]').click()`); await sleep(1500); s = await snap(); // a troca de tema logo antes atrasa o redesenho
check('inglês', s.title === 'Analyzing 4 phrases' && s.eta === '~3 min left' && s.now === 'reading balances, tokens and creator fees of phrase 2 · Account 38' && s.rows[0].chip === 'Ready ✓', `${s.title} / ${s.now}`);
await run(`document.querySelector('input[name=idioma][value=pt]').click()`); await sleep(600);
// pausa: créditos acabaram
await run(`onPause({ motivo: 'rpc-quota' }); true`); await sleep(200); s = await snap();
check('pausa: cartão no topo com o motivo e o que "parar" faz na análise; sem campo de RPC (Helius embutido)', !s.pause.hidden && s.pause.title === 'Os créditos do RPC acabaram' && /frases prontas seguem/.test(s.pause.stopHint) && !s.pause.field, s.pause.title);
check('pausado: "Pausado:" e "pausado" no topo, linha "Pausada"', s.nowLabel === 'Pausado:' && s.eta === 'pausado' && s.rows[1].chip === 'Pausada', `${s.nowLabel} ${s.eta} ${s.rows[1].chip}`);
check('"Começar de novo" diz para parar no cartão', s.restart.disabled && /Parar aqui/.test(s.restart.hint), s.restart.hint);
await shot('pausa-escuro.png', 1280);
await shot('pausa-celular.png', 390);
// "Tentar de novo agora" (usa o público): recusado mostra o erro e a pausa continua; aceito, o cartão some com o aviso
await run(`document.getElementById('b-pausa-publico').click(); true`);
await sleep(500); s = await snap();
const swap1 = await run(`window.__sent.filter((x) => x.u === '/api/trocar-rpc').map((x) => x.body)`);
check('"Tentar de novo agora" manda só a escolha; recusado mostra o erro e a pausa continua', swap1.length === 1 && swap1[0].rpc === 'publico' && !s.pause.hidden && /recusou/.test(s.pause.err), s.pause.err.slice(0, 60));
await run(`window.__swapFail = false; document.getElementById('b-pausa-publico').click(); true`); await sleep(500); s = await snap();
check('trocado: cartão some, aviso com o host', s.pause.hidden && /novo\.exemplo/.test(s.pause.note), s.pause.note);
// nova pausa, parar com dois cliques
await run(`onPause({ motivo: 'network-down' }); true`); await sleep(200);
await run(`document.getElementById('b-pausa-parar').click(); true`); await sleep(200); s = await snap();
const stops0 = await run(`window.__sent.filter((x) => x.u === '/api/parar').length`);
check('"Parar aqui": 1º clique só pede confirmação', stops0 === 0 && s.pause.stop === 'Clique de novo para parar' && s.pause.title === 'O RPC parou de responder', s.pause.stop);
await run(`document.getElementById('b-pausa-parar').click(); true`); await sleep(400); s = await snap();
const stops1 = await run(`window.__sent.filter((x) => x.u === '/api/parar').length`);
check('2º clique para: frase da fila vira "Parada"', stops1 === 1 && s.pause.hidden && s.rows[3].chip === 'Parada' && /Parado/.test(s.pause.note), `${s.rows[3].chip} / ${s.pause.note}`);
// 20 s sem aviso: "aguardando a rede…"
await run(`onProgress({ fase: 'leitura', frase: 2, carteira: 'Conta 40', feitos: 60, total: 102, etaMs: 160000, geral: { feitos: 147, total: 289 } }); true`);
await sleep(300); s = await snap();
check('aviso novo: número de novo', s.eta === '~3 min restantes', s.eta);
await sleep(21500); s = await snap();
check('20 s sem aviso: o número fica, com "aguardando a rede…" ao lado; a linha mantém o tempo', /min restantes · aguardando a rede…/.test(s.eta) && /min/.test(s.rows[1].chip), `${s.eta} / ${s.rows[1].chip}`);
// fim da análise: "Começar de novo" libera
await run(`endTask('analise'); true`); await sleep(200); s = await snap();
check('análise terminou: "Começar de novo" liberado', !s.restart.disabled && s.restart.hint === '', s.restart.hint);
check('sem erro de script no fim', pageErrors.length === 0, pageErrors.join(' | '));
console.log(`largura no escuro: ${wideDark}`);
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await closeBrowser(results.every(Boolean) ? 0 : 1);
