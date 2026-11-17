// "Limpar outra frase" no fim da execução: volta ao início com o app aberto. Sem frase real (texto qualquer, nunca enviado).
// Uso: sh um-teste.sh cdp-nova-limpeza.mjs <pasta-prints>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) pageErrors.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') pageErrors.push(`log: ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
});
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${info ? ' — ' + info : ''}`); };
async function viewport(width, height = 900, mobile = false) { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await sleep(250); }
async function shot(name, width = 1280) {
  const h = await run('Math.ceil(document.documentElement.scrollHeight)');
  await viewport(width, Math.min(h, 4000), width < 600);
  await sleep(300);
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(outDir, name), Buffer.from(r.result.data, 'base64'));
  await viewport(width, 900, width < 600);
}

await cdp('Runtime.enable'); await cdp('Log.enable');
await cdp('Page.navigate', { url });
await sleep(2500);

// campos preenchidos como depois de uma limpeza (texto qualquer: nada é enviado ao app)
await run(`(() => {
  entry.cards[0].ta.value = 'texto qualquer de teste';
  document.getElementById('destino').value = 'DestinoAntigo111'; ui.dest = { addr: 'DestinoAntigo111' };
  ui.decisions.set('conta-antiga', 'burn'); ui.dirty = true;
  document.getElementById('x-lista').append(Object.assign(document.createElement('li'), { textContent: 'passo antigo' }));
  document.getElementById('x-resumo').textContent = 'resumo antigo';
  document.getElementById('x-fim').classList.remove('hidden');
  show('s-execucao');
})()`);
await sleep(300);
check('fim da execução mostra os dois botões', await run(`!document.getElementById('x-fim').classList.contains('hidden') && document.getElementById('b-nova').offsetParent !== null && document.getElementById('b-encerrar').offsetParent !== null`));
check('botões acima da lista de passos', await run(`document.getElementById('b-nova').getBoundingClientRect().top < document.getElementById('x-lista').getBoundingClientRect().top`));
await shot('fim-execucao.png');

await run(`document.getElementById('b-nova').click()`);
await sleep(800);
check('voltou ao início', await run(`!document.getElementById('s-frase').classList.contains('hidden') && document.getElementById('s-execucao').classList.contains('hidden')`));
check('frase e escolhas de token vazias; o destino colado fica (0.2: colado uma vez por sessão)', await run(`entry.cards.length === 1 && entry.cards[0].ta.value === '' && document.getElementById('destino').value === 'DestinoAntigo111' && ui.dest.addr === 'DestinoAntigo111' && ui.decisions.size === 0 && !ui.dirty`));
check('lista e resumo antigos apagados', await run(`!document.getElementById('x-lista').children.length && !document.getElementById('x-resumo').children.length && !document.getElementById('x-resumo').textContent`));
check('cursor na caixa da frase', await run(`document.activeElement === entry.cards[0].ta`));
check('app continua aberto (estado responde)', await run(`api('/api/estado').then((s) => Array.isArray(s.frases) && s.frases.length === 0, () => false)`));
await shot('depois-nova.png');
await run(`LANG = 'en'; rerender(); document.getElementById('x-fim').classList.remove('hidden'); show('s-execucao');`);
check('inglês: botão traduzido', (await run(`document.getElementById('b-nova').textContent`)) === 'Clean other phrases');

check('sem erro na página', pageErrors.length === 0, pageErrors.join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} checagens`);
await closeBrowser(failed ? 1 : 0);
