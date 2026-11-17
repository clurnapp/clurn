// Fundo de fumaça (WebGL) com GPUs diferentes, no tema escuro. Nenhuma frase: só abre a página inicial.
// Caso real (31/10/2026, app de um tester): fundo branco e texto claro ilegível. Com driver básico/GPU fraca, só criar
// o contexto WebGL deixa o canvas branco opaco por cima da página. Aqui o Edge é forçado a cada caminho de GPU (ANGLE
// d3d11 = GPU de verdade; d3d9 e gl = os que davam branco nesta máquina) e a foto da página tem que ficar escura.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-fundo-gpu.mjs [pasta-prints]
// Um Edge por vez (cada um fecha antes do próximo). Sai com código 1 se algum modo ficar claro.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MODES = { gpu: ['--use-angle=d3d11', '--ignore-gpu-blocklist'], d3d9: ['--use-angle=d3d9'], gl: ['--use-angle=gl'] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// parte da tela com pixel claro (R, G e B > 200), lendo o PNG sem dependência
function brightShare(buf) {
  let p = 8, w, h, ct; const data = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') data.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = zlib.inflateSync(Buffer.concat(data)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  let bright = 0, n = 0;
  for (let i = 0; i < out.length; i += bpp * 7) { n++; if (out[i] > 200 && out[i + 1] > 200 && out[i + 2] > 200) bright++; }
  return bright / n;
}

async function runMode(mode) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`, '--force-dark-mode', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', ...MODES[mode], 'about:blank'], { stdio: 'ignore' });
  const close = async () => {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const b = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((r, j) => { b.addEventListener('open', r); b.addEventListener('error', j); setTimeout(j, 2000); });
      b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      await sleep(800);
    } catch {}
    try { edge.kill(); } catch {}
  };
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const waiting = new Map(); const errors = [];
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); });
    const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url });
    await sleep(3500);
    for (let k = 0; k < 20; k++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 100 + k * 50, y: 300 + (k % 3) * 80 }); await sleep(40); }
    await sleep(800);
    const ev = await send('Runtime.evaluate', { expression: "JSON.stringify({ tema: document.documentElement.dataset.theme, efeito: !!document.getElementById('fx'), botao: !!document.getElementById('fx-toggle') })", returnByValue: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const png = Buffer.from(shot.result.data, 'base64');
    if (outDir) writeFileSync(path.join(outDir, `fundo-${mode}.png`), png);
    return { mode, claro: brightShare(png), ...JSON.parse(ev.result.result.value), errors };
  } finally { await close(); }
}

let bad = 0;
for (const mode of Object.keys(MODES)) {
  const r = await runMode(mode);
  const ok = r.tema === 'dark' && r.claro < 0.1 && !r.errors.length;
  if (!ok) bad++;
  console.log(`${ok ? 'OK ' : 'ERRO'} ${mode.padEnd(5)} tela clara ${(r.claro * 100).toFixed(1).padStart(5)}%  tema ${r.tema}  efeito ${r.efeito ? 'ligado' : 'desligado'}  botão ${r.botao ? 'sim' : 'não'}${r.errors.length ? '  erros JS: ' + r.errors.join(' | ') : ''}`);
}
process.exit(bad ? 1 : 0);
