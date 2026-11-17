// Base comum dos roteiros de ponta a ponta na DEVNET (e2e-juntar, e2e-financiar): Edge headless por CDP, checagens,
// fotos e consultas à devnet. Frases só de arquivo fora do repositório, nunca impressas.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEVNET = 'https://api.devnet.solana.com';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openBrowser(url, outDir, prefix) {
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
  const waitFor = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await run(expr)) return true; await sleep(1500); } return false; };
  async function shot(name) {
    const h = await run('Math.ceil(document.documentElement.scrollHeight)');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    writeFileSync(path.join(outDir, `${prefix}-${name}.png`), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  async function stop(msg) { console.log(`PAROU: ${msg}`); await shot('parou'); await closeBrowser(1); }
  await cdp('Runtime.enable');
  // a devnet só entra pelo parâmetro da URL (o app não pergunta a rede); o código de acesso vai depois do #
  await cdp('Page.navigate', { url: url.replace('/#', '/?rede=devnet#') });
  await sleep(2500);
  return { cdp, run, check, waitFor, shot, stop, results, pageErrors, close: closeBrowser };
}

export async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(DEVNET, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    return (await r.json()).result;
  }
  throw new Error(`${method}: 429 repetido`);
}
export const balance = async (a) => (await rpc('getBalance', [a, { commitment: 'confirmed' }])).value;
export const tokenAccountLamports = async (a) => ((await rpc('getTokenAccountsByOwner', [a, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'base64' }])).value ?? []).reduce((s, x) => s + x.account.lamports, 0);

// preenche os cartões (um por frase ou lista de chaves privadas; o app descobre o app da frase) com os arquivos da pasta
// e o destino colado uma vez, e envia; a rede já é a devnet. Cartão de chaves fica com o selo neutro "N chaves" (code 'keys').
export async function enterPhrases(b, files, dir, dest) {
  const texts = files.map((f) => readFileSync(path.join(dir, f), 'utf8').trim());
  await b.run(`(() => {
    const texts = ${JSON.stringify(texts)};
    while (entry.cards.length < texts.length) document.getElementById('b-add').click();
    entry.cards.forEach((c, i) => { c.ta.value = texts[i]; c.ta.dispatchEvent(new Event('input')); });
    for (const id of ['destino']) { const d = document.getElementById(id); d.value = ${JSON.stringify(dest)}; d.dispatchEvent(new Event('input')); }
    return true;
  })()`);
  texts.fill('');
  b.check(`${files.length} cartão(ões) conferido(s) na página (selo verde ou "N chaves")`, await b.waitFor(`entry.cards.length === ${files.length} && entry.cards.every((c) => c.check.code === 'ok' || c.check.code === 'keys') && !document.getElementById('b-analisar').disabled`, 20000));
  await b.run(`document.getElementById('b-analisar').click(); true`);
  b.check('frases apagadas da página logo depois de enviar', await b.waitFor(`entry.cards.every((c) => c.ta.value === '')`, 20000));
}

// confirmação → segurar 2 s → execução até o fim; devolve o resumo da execução
export async function confirmAndExecute(b) {
  // o destino já foi colado na entrada; aqui só se confere e segura o botão. Rolagem instantânea e uma pausa antes de
  // medir: medido no meio de uma rolagem suave, o clique caía fora do botão e nada era enviado (devnet de 08/11/2026)
  await b.run(`(() => { document.getElementById('b-executar').scrollIntoView({ block: 'center', behavior: 'instant' }); return true; })()`);
  await sleep(800);
  b.check('botão de enviar liberado depois da simulação', await b.waitFor(`!document.getElementById('b-executar').disabled`, 5000));
  const box = await b.run(`(() => { const r = document.getElementById('b-executar').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await b.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
  await b.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(2600);
  await b.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  const go = await b.waitFor(`ui.section === 's-execucao'`, 30000);
  b.check('segurar 2 s começou a execução', go);
  if (!go) await b.stop('execução não começou');
  const done = await b.waitFor(`ui.exec.done || Boolean(ui.exec.error)`, 900000);
  const ex = await b.run(`({
    done: ui.exec.done, err: ui.exec.error?.mensagem ?? null, aborted: state.aborted,
    sent: state.execResults.filter((r) => r.status === 'enviado').length,
    failed: state.execResults.filter((r) => r.status === 'falhou').map((r) => 'frase ' + r.frase + ' N=' + r.walletIndex + ': ' + (r.detail ?? r.error?.code ?? '')),
    arrived: state.arrived, arrivedAppFee: state.arrivedAppFee, links: state.execResults.filter((r) => r.link).length, report: state.reportFile,
    destination: state.plan?.destination ?? null,
  })`);
  console.log(`enviados ${ex.sent}, falhas ${ex.failed.length}, chegou ${Number(ex.arrived) / 1e9} SOL, taxa do app ${Number(ex.arrivedAppFee) / 1e9} SOL, links ${ex.links}, relatório ${ex.report}`);
  for (const x of ex.failed) console.log('  falhou:', x);
  b.check('execução terminou sem parada nem falha', done && ex.done && !ex.err && !ex.aborted && ex.failed.length === 0, ex.err ?? ex.aborted ?? '');
  b.check('chegou SOL no destino e cada passo enviado tem link', BigInt(ex.arrived ?? 0) > 0n && ex.links >= ex.sent, `${ex.arrived}`);
  return ex;
}
