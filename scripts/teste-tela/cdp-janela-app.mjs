// Roteiro da janela do app de desktop (Electron de desenvolvimento, `electron .`): confere na janela de verdade que
// os atalhos de navegador não fazem nada (recarregar, zoom pelo teclado e pela roda do mouse) e que botões e títulos
// não ficam selecionáveis, enquanto o campo da frase continua. Sem frase, sem rede: só a tela inicial.
// Uso: node scripts/teste-tela/cdp-janela-app.mjs
// O app empacotado recusa porta de depuração (desktop/main.ts); por isso este roteiro usa o Electron da pasta.
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const PORT = 9334;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // o terminal do VS Code passa adiante; com ela o Electron vira Node puro
const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok, what, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALHOU'} ${what}${extra ? ` — ${extra}` : ''}`);
  if (!ok) fails++;
};

try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
    } catch {}
  }
  if (!target) throw new Error('a janela do app não apareceu');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  for (let i = 0; i < 40 && !(await evaluate('document.readyState === "complete" && !!document.querySelector("textarea")')); i++) await sleep(250);

  await evaluate('window.__marca = 42');
  const key = async (k, code, vk, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(700);
  };
  const CTRL = 2;
  const zoom = () => evaluate('Math.round(window.devicePixelRatio * 1000) / 1000');
  const z0 = await zoom();

  await key('r', 'KeyR', 82, CTRL);
  check((await evaluate('window.__marca')) === 42, 'Ctrl+R não recarrega a página');
  await key('F5', 'F5', 116, 0);
  check((await evaluate('window.__marca')) === 42, 'F5 não recarrega a página');
  await key('=', 'Equal', 187, CTRL);
  await key('+', 'NumpadAdd', 107, CTRL);
  check((await zoom()) === z0, 'Ctrl+= e Ctrl+Numpad+ não dão zoom', `devicePixelRatio ${z0} → ${await zoom()}`);
  await key('-', 'Minus', 189, CTRL);
  check((await zoom()) === z0, 'Ctrl+- não diminui');
  for (let i = 0; i < 3; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -120, modifiers: CTRL });
    await sleep(300);
  }
  await sleep(500);
  check((await zoom()) === z0, 'Ctrl + roda do mouse não dá zoom', `devicePixelRatio ${z0} → ${await zoom()}`);

  const sel = await evaluate(`(() => {
    const us = (el) => el ? getComputedStyle(el).userSelect : null;
    return { desktop: document.documentElement.classList.contains('desktop'), button: us(document.querySelector('button')),
      h: us(document.querySelector('h1, h2')), textarea: us(document.querySelector('textarea')), p: us([...document.querySelectorAll('p')].find((x) => x.offsetParent && !x.closest('button, .btn, label, summary, h1, h2, h3, .top, nav'))) };
  })()`);
  check(sel.desktop === true, 'página em modo desktop');
  check(sel.button === 'none' && sel.h === 'none', 'botão e título não selecionáveis', JSON.stringify(sel));
  check(sel.textarea !== 'none' && sel.p !== 'none', 'campo da frase e texto continuam selecionáveis', JSON.stringify(sel));
  // colar continua: Ctrl+A e digitar no campo
  await evaluate('document.querySelector("textarea").focus()');
  await send('Input.insertText', { text: 'abc' });
  await key('a', 'KeyA', 65, CTRL);
  const typed = await evaluate('(() => { const t = document.querySelector("textarea"); return [t.value, t.selectionStart, t.selectionEnd]; })()');
  check(typed[0].endsWith('abc') && typed[1] === 0 && typed[2] === typed[0].length, 'digitar e Ctrl+A no campo funcionam', JSON.stringify([typed[1], typed[2]]));
  await evaluate('(() => { const t = document.querySelector("textarea"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()');
  ws.close();
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  app.kill();
}
console.log(fails ? `\n${fails} falha(s)` : '\ntudo certo');
process.exitCode = fails ? 1 : 0;
