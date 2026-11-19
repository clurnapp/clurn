// Confere o APP DE DESKTOP empacotado (dist/Clurn-win32-x64/Clurn.exe) pela porta de depuração do Chromium:
// a página abre, o botão "Copiar" escreve na área de transferência do Windows (permissão clipboard-sanitized-write),
// e "Enviar arquivo .txt" preenche um cartão. Nada é analisado: o /api/analisar não é chamado.
// Só com o Clurn FECHADO (o app é de instância única). Escreve na área de transferência da máquina.
// Uso: node scripts/teste-tela/cdp-desktop.mjs [caminho-do-Clurn.exe] [--embutido=<url-https>]
// Painel de créditos (31/10/2026): sem RPC embutido, o cartão fica escondido (RPC público não gasta crédito).
// --embutido=<url>: grava um rpc-embutido.json de teste no app empacotado (apagado no fim), sem a chave real.
//   Com a devnet pública (https://api.devnet.solana.com): o cartão aparece com "saldo não configurado" e uma
//   análise na mainnet com o vetor público do BIP39 (sem fundos) tem que recusar o embutido pela trava de rede
//   (hash de gênese da devnet) e cair para o RPC público da mainnet. Faz umas 30 consultas de leitura no público.
// O histórico de créditos do app vai para uma pasta temporária (LOCALAPPDATA trocado só para o Clurn.exe).
// Um navegador por vez na máquina: pega a trava do um-teste.sh ($TEMP/clurn-edge.lock).
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const EMBUTIDO = args.find((a) => a.startsWith('--embutido='))?.slice('--embutido='.length) ?? null;
const EXE = args.find((a) => !a.startsWith('--')) || path.join(import.meta.dirname, '..', '..', 'dist', 'Clurn-win32-x64', 'Clurn.exe');
if (!existsSync(EXE)) { console.error(`não achei ${EXE}`); process.exit(2); }
if (EMBUTIDO !== null && !/^https:\/\/\S+$/.test(EMBUTIDO)) { console.error('--embutido precisa de uma URL https://'); process.exit(2); }
// trava de um navegador por vez (a mesma do um-teste.sh)
const LOCK = path.join(process.env.TMPDIR || process.env.TEMP || os.tmpdir(), 'clurn-edge.lock');
for (let w = 0; ; w++) {
  try { mkdirSync(LOCK); writeFileSync(path.join(LOCK, 'quem'), `cdp-desktop.mjs ${new Date().toTimeString().slice(0, 8)}`); break; } catch {}
  if (w === 0) { let quem = ''; try { quem = readFileSync(path.join(LOCK, 'quem'), 'utf8'); } catch {} console.log(`outro teste de tela está rodando (${quem}); esperando a vez…`); }
  if (w >= 1800) { console.error(`esperei 30 min pela vez; apague ${LOCK} se nenhum teste estiver rodando`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 1000));
}
const EMB_FILE = path.join(path.dirname(EXE), 'resources', 'app', 'src', 'app', 'rpc-embutido.json');
if (existsSync(EMB_FILE)) { console.error(`o app já tem um RPC embutido (${EMB_FILE}): este roteiro não mexe nele. Use um pacote sem CLURN_RPC_URL.`); rmSync(LOCK, { recursive: true, force: true }); process.exit(2); }
if (EMBUTIDO) writeFileSync(EMB_FILE, JSON.stringify({ url: EMBUTIDO }) + '\n');
const port = 9400 + Math.floor(Math.random() * 400);
const FILES = mkdtempSync(path.join(os.tmpdir(), 'cdp-desk-'));
// sem ELECTRON_RUN_AS_NODE: o terminal do VS Code (e o Claude Code) deixa essa variável no ambiente e o Clurn.exe abriria como Node puro
const env = { ...process.env, LOCALAPPDATA: FILES };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SOLANA_RPC_URL; // o teste é do que vem no pacote, não da variável deste terminal
delete env.HELIUS_PROJECT_ID;
// saída do processo do app (main do Electron + servidor) num arquivo: se o app cair, o motivo aparece no fim
const APP_LOG = path.join(FILES, 'app.log');
const logFd = openSync(APP_LOG, 'w');
const app = spawn(EXE, [`--remote-debugging-port=${port}`], { stdio: ['ignore', logFd, logFd], detached: false, env });
const appLogTail = () => { try { return readFileSync(APP_LOG, 'utf8').replace(/https?:\/\/127\.0\.0\.1:\d+\/#\S+/g, '<url do app>').split(/\r?\n/).slice(-25).join('\n'); } catch { return '(sem log)'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exited = null;
app.on('exit', (code) => { exited = code; });
app.on('error', (e) => { console.error('não abriu:', e.message); });
let closing = false;
async function shutdown(code) {
  if (closing) return; closing = true;
  if (EMBUTIDO) try { rmSync(EMB_FILE, { force: true }); } catch {}
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((r, j) => { bws.addEventListener('open', r); bws.addEventListener('error', j); setTimeout(j, 2000); });
    bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch {}
  try { app.kill(); } catch {}
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  try { closeSync(logFd); } catch {}
  try { rmSync(FILES, { recursive: true, force: true }); } catch {}
  try { rmSync(LOCK, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
process.on('uncaughtException', (e) => { console.error(e); shutdown(1); });
process.on('unhandledRejection', (e) => { console.error(e); shutdown(1); });
setTimeout(() => { console.error('tempo esgotado'); shutdown(1); }, EMBUTIDO ? 300_000 : 120_000).unref();

let target;
for (let i = 0; i < 120 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page' && /127\.0\.0\.1/.test(t.url)); } catch {}
}
if (!target) {
  let list = '(sem resposta na porta)';
  try { list = JSON.stringify((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).map((t) => [t.type, t.url])); } catch {}
  console.error(`a janela do app não apareceu na porta de depuração. processo saiu: ${exited}; alvos: ${list}`);
  await shutdown(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
// a janela fechou sem o roteiro pedir (app caiu ou saiu): falha com a saída do app, e limpa tudo
ws.addEventListener('close', async () => {
  if (closing) return;
  await sleep(1000);
  console.error(`FALHA a janela do app fechou sozinha (processo saiu: ${exited}). Saída do app:\n${appLogTail()}`);
  await shutdown(1);
});
let id = 0; const waiting = new Map(); const pageErrors = [];
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text); });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = async (expr, gesture = false) => { const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: gesture }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'erro'); return r.result.result.value; };
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FALHA'} ${name}${info ? ' — ' + info : ''}`); };
await cdp('Runtime.enable');
await cdp('DOM.enable');
await cdp('Page.bringToFront');
// a página se comporta como focada mesmo se outra janela pegar o foco ("Document is not focused" na cópia, 31/10/2026)
await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
await sleep(1500);
check('página do app aberta no Clurn.exe', /127\.0\.0\.1/.test(target.url) && (await run(`document.getElementById('s-frase') !== null`)));
check('versão do app na página é a do package.json', await run(`typeof APP_VERSION === 'undefined' ? true : APP_VERSION`) !== false);

// "Copiar": a API do navegador com a permissão liberada, e a área de transferência do Windows de verdade
const MARK = `clurn-teste-${Date.now()}`;
const copied = await run(`copyText(${JSON.stringify(MARK)})`, true); // como um clique (gesto do usuário)
await sleep(300);
const clip = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' }).trim();
check('copyText devolve true no app de desktop', copied === true, String(copied));
check('o texto copiado está na área de transferência do Windows', clip === MARK, clip.slice(0, 60));
// a API em si (não só o comando antigo): a permissão clipboard-sanitized-write foi liberada
const apiOk = await run(`navigator.clipboard.writeText(${JSON.stringify(MARK + '-api')}).then(() => true, (e) => String(e))`, true);
const apiNoGesture = await run(`navigator.clipboard.writeText('x').then(() => true, (e) => String(e))`);
console.log('info: writeText sem gesto →', apiNoGesture);
check('navigator.clipboard.writeText aceito (permissão liberada no main.ts)', apiOk === true, String(apiOk));
// leitura da área de transferência continua negada
const readDenied = await run(`navigator.clipboard.readText().then(() => 'LEU', (e) => e.name)`);
check('navigator.clipboard.readText continua negado', readDenied !== 'LEU', String(readDenied));
// limpa a área de transferência
execFileSync('powershell', ['-NoProfile', '-Command', 'Set-Clipboard -Value " "'], { stdio: 'ignore' });

// "Enviar arquivo .txt" com o vetor público do BIP39: um cartão preenchido, selo verde
const P = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const file = path.join(FILES, 'solflare.txt'); writeFileSync(file, P);
const doc = await cdp('DOM.getDocument', { depth: 1 });
const node = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#f-arq' });
await cdp('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [file] });
await sleep(1200);
const s = await run(`({ n: document.querySelectorAll('#frases .fr').length, badge: document.querySelector('#frases .fr .tag')?.textContent, msg: document.getElementById('arq-msg').textContent, len: document.querySelector('#frases textarea').value.length })`);
check('arquivo .txt preenche o cartão e o selo fica verde', s.n === 1 && s.badge === '12 palavras ✓' && s.len === P.length && /1 frase do arquivo entrou/.test(s.msg), JSON.stringify(s));
await run(`resetFrases()`);

// painel de créditos do Helius: depende do que veio no pacote
await sleep(800);
const cr = await run(`api('/api/creditos', {}).then((c) => ({ own: c.own, helius: c.helius, hidden: document.getElementById('creditos').classList.contains('hidden'), saldo: document.getElementById('cr-saldo').textContent }))`);
if (!EMBUTIDO) {
  check('sem RPC embutido: painel de créditos escondido (RPC público não gasta crédito)', cr.own === false && cr.hidden === true, JSON.stringify(cr));
} else {
  check('com RPC embutido: painel aparece e diz que o saldo não foi configurado (sem id de projeto)', cr.own === true && cr.hidden === false && cr.helius?.status === 'sem-projeto' && /não foi configurado/.test(cr.saldo), JSON.stringify(cr));
  // análise na mainnet com o vetor público do BIP39 (sem fundos): a trava de rede recusa o embutido de outra rede
  const pedido = await run(`api('/api/analisar', { frases: [{ texto: ${JSON.stringify(P)}, carteira: 'solflare' }], rede: 'mainnet' }).then(() => 'ok', (e) => String(e.message || e))`);
  check('análise aceita (202)', pedido === 'ok', pedido);
  let st = null;
  for (let i = 0; i < 240; i++) { await sleep(1000); st = await run(`api('/api/estado').then((s) => ({ busy: s.busy, rpc: s.rpc, frases: s.frases.map((f) => f.status) }))`); if (!st.busy) break; }
  const host = new URL(EMBUTIDO).host;
  check('trava de rede: o embutido de outra rede foi recusado e a rodada caiu para o RPC público da mainnet', st && !st.busy && st.rpc === 'api.mainnet-beta.solana.com (público, mais lento)', JSON.stringify(st));
  check('o host do embutido não ficou como RPC da rodada', st && !String(st.rpc).includes(host), String(st?.rpc));
  check('a frase terminou sem erro', st && st.frases.length === 1 && st.frases[0] !== 'erro', JSON.stringify(st?.frases));
  const histFile = path.join(FILES, 'Clurn', 'creditos.json');
  const hist = existsSync(histFile) ? JSON.parse(readFileSync(histFile, 'utf8')) : [];
  check('o histórico (pasta temporária) registra só a consulta recusada, no host do embutido', hist.length === 1 && hist[0].rpc === host && hist[0].creditos >= 1 && hist[0].creditos <= 3, JSON.stringify(hist));
}
check('sem erro de script', pageErrors.length === 0, pageErrors.join(' | '));
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await shutdown(results.every(Boolean) ? 0 : 1);
