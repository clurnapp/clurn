// "Enviar arquivo .txt" na tela de entrada, num Edge headless, com o fetch do /api/analisar interceptado: nada é analisado.
// Usa só vetores públicos de teste do BIP39 (publicados na especificação, sem fundos), gravados em arquivos .txt
// numa pasta temporária que é apagada no fim; nenhuma frase é impressa.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-arquivo.mjs <pasta-prints>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const [url, outDir] = process.argv.slice(2);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const port = 9300 + Math.floor(Math.random() * 500);
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(path.join(os.tmpdir(), 'cdp-'))}`, '--force-dark-mode', '--hide-scrollbars', '--window-size=1280,900', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-features=CalculateNativeWinOcclusion', '--disable-extensions', '--disable-sync', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const FILES = mkdtempSync(path.join(os.tmpdir(), 'cdp-arq-'));
let closing = false;
async function closeBrowser(code = 0) {
  if (closing) return; closing = true;
  try { rmSync(FILES, { recursive: true, force: true }); } catch {}
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
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

await cdp('Runtime.enable');
await cdp('DOM.enable');
await cdp('Page.navigate', { url });
await sleep(2500);

// vetores públicos do BIP39 (nunca uma frase real); ficam nos arquivos temporários e dentro da página
const V = [
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
  'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
];
const file = (name, content) => { const p = path.join(FILES, name); writeFileSync(p, content); return p; };
// escolhe arquivos no campo escondido (como a janela do sistema faria) e dispara a leitura
async function pick(...paths) {
  const doc = await cdp('DOM.getDocument', { depth: 1 });
  const node = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#f-arq' });
  await cdp('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: paths }); // o Chromium dispara o "change" sozinho, como a janela do sistema
  await sleep(900); // leitura dos arquivos + conferência (150 ms) + lista BIP39
}
const snap = () => run(`({ cards: [...document.querySelectorAll('#frases .fr')].map((li) => ({ badge: li.querySelector('.tag').textContent, cls: li.querySelector('.tag').className, noApp: !li.querySelector('input[type=radio]'), len: li.querySelector('textarea').value.length })), msg: document.getElementById('arq-msg').textContent, msgBad: document.getElementById('arq-msg').classList.contains('bad'), btn: document.getElementById('b-analisar').textContent, disabled: document.getElementById('b-analisar').disabled, why: document.getElementById('b-analisar-why').textContent, addHidden: document.getElementById('b-add').classList.contains('hidden'), arqBtn: document.getElementById('b-arq').textContent, inputVal: document.getElementById('f-arq').value, accept: document.getElementById('f-arq').accept, multiple: document.getElementById('f-arq').multiple, hint: document.querySelector('[data-i18n="frase.fileHint"]').textContent, focused: [...document.querySelectorAll('#frases textarea')].indexOf(document.activeElement) })`);
let s = await snap();
check('carrega sem erro de script', pageErrors.length === 0, pageErrors.join(' | '));
check('botão "Enviar arquivo .txt" e campo escondido (.txt, vários)', s.arqBtn === 'Enviar arquivo .txt' && s.accept === '.txt,text/plain' && s.multiple && s.msg === '' && /Solflare baixa/.test(s.hint), `${s.arqBtn} / ${s.accept}`);
await run(`(() => { window.__sent = []; const real = window.fetch; window.fetch = async (u, o) => { window.__sent.push({ u, body: o?.body ? JSON.parse(o.body) : null }); if (u === '/api/analisar') return new Response('{"ok":true}', { status: 202 }); return real(u, o); }; return true; })()`);

// 1. o arquivo da Solflare (uma linha) no 1º cartão, que estava vazio (o cartão não pergunta o app: o app descobre)
await pick(file('solflare.txt', V[0])); s = await snap();
check('1 arquivo: preenche o cartão vazio, selo verde, botão liga, sem escolha de app', s.cards.length === 1 && s.cards[0].badge === '12 palavras ✓' && s.cards[0].noApp && !s.disabled && s.btn === 'Começar', JSON.stringify(s.cards));
check('mensagem "1 frase do arquivo entrou…", campo de arquivo zerado, foco no cartão', s.msg === '1 frase do arquivo entrou nos cartões: confira o selo.' && !s.msgBad && s.inputVal === '' && s.focused === 0, `${s.msg} / foco ${s.focused}`);
// 2. dois arquivos: uma palavra por linha numerada, e 24 palavras com CRLF e BOM → 2 cartões novos
await pick(file('a.txt', V[1].split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')), file('b.txt', `\uFEFF${V[4].toUpperCase().split(' ').join('\r\n')}\r\n`)); s = await snap();
check('2 arquivos (numerado; 24 palavras CRLF+BOM): 2 cartões novos, selos verdes', s.cards.length === 3 && s.cards[1].badge === '12 palavras ✓' && s.cards[2].badge === '24 palavras ✓' && s.cards.every((c) => c.noApp) && !s.disabled && s.msg === '2 frases dos arquivos entraram nos cartões: confira os selos.', JSON.stringify(s.cards.map((c) => c.badge)) + ' / ' + s.msg);
// 3. um arquivo com 3 frases (uma por linha, vírgulas numa delas) e outro sem frase
await pick(file('tres.txt', `${V[2]}\n\n${V[3].split(' ').join(', ')}\n${V[5]}\n`), file('vazio.txt', 'Recovery phrase\nnothing here')); s = await snap();
check('arquivo com 3 frases + arquivo sem frase: as 3 entram; mensagem diz o arquivo que não deu', s.cards.length === 6 && s.cards.slice(3).map((c) => c.badge).join(',') === '12 palavras ✓,12 palavras ✓,24 palavras ✓' && s.msg === 'Nenhuma frase reconhecida em vazio.txt: o arquivo precisa ter 12 ou 24 palavras por frase.' && s.msgBad, JSON.stringify(s.cards.map((c) => c.badge)) + ' / ' + s.msg);
check('nenhuma palavra das frases na mensagem', !/legal|abandon|letter|zoo/.test(s.msg));
// 4. arquivo com 11 frases: não cabem (4 vagas) → nada entra
await pick(file('onze.txt', Array.from({ length: 11 }, (_, k) => V[k % 6]).join('\n'))); s = await snap();
check('11 frases para 4 vagas: nada entra, mensagem com as contagens', s.cards.length === 6 && s.msg === 'Os arquivos têm 11 frases e só cabem mais 4 nesta rodada (máximo de 10). Nada foi adicionado: tire frases dos arquivos ou faça outra rodada.' && s.msgBad, `${s.cards.length} / ${s.msg}`);
// 5. a mesma frase de novo, por arquivo: repetida
await pick(file('repetida.txt', V[0].toUpperCase())); s = await snap();
check('frase repetida vinda de arquivo: "repete a frase 1", botão desligado', s.cards.length === 7 && s.cards[6].badge === 'repete a frase 1' && s.cards[6].cls === 'tag bad' && s.disabled && s.why === 'Corrija ou remova a frase 7.', `${s.cards[6].badge} / ${s.why}`);
await run(`document.querySelectorAll('#frases .fr')[6].querySelector('.fr-x').click()`); await sleep(500);
// 6. mais de 10 arquivos
await pick(...Array.from({ length: 11 }, (_, k) => file(`f${k}.txt`, V[0]))); s = await snap();
check('11 arquivos: recusa com a contagem, nada muda', s.cards.length === 6 && s.msg === 'São 11 arquivos; o máximo é 10 por vez.' && s.msgBad, `${s.cards.length} / ${s.msg}`);
// 7. arquivo grande demais
await pick(file('grande.txt', `${V[0]}\n${'#'.repeat(70 * 1024)}`)); s = await snap();
check('arquivo acima de 64 KB: recusado pelo nome', s.cards.length === 6 && s.msg === 'grande.txt é grande demais para ser um arquivo de frase.', s.msg);
// 8. completa os 10 com um arquivo de 4 frases (repetidas, só para contar cartões) → "+ Adicionar" some
await pick(file('quatro.txt', [V[0], V[1], V[2], V[3]].join('\n'))); s = await snap();
check('arquivo que completa os 10: "+ Adicionar frase" some; repetidas marcadas', s.cards.length === 10 && s.addHidden && s.cards.slice(6).every((c) => /repete a frase/.test(c.badge)), `${s.cards.length} / ${s.cards.slice(6).map((c) => c.badge).join(',')}`);
await pick(file('mais.txt', V[5])); s = await snap();
check('com 10 cartões cheios: "só cabem mais 0"', s.cards.length === 10 && s.msg.startsWith('O arquivo tem 1 frase e só cabem mais 0 nesta rodada'), s.msg);
await shot('arquivo-escuro.png', 1280);
await shot('arquivo-celular.png', 390);
for (let i = 9; i >= 6; i--) await run(`document.querySelectorAll('#frases .fr')[${i}].querySelector('.fr-x').click()`);
await sleep(500);
// 9. inglês
await run(`document.querySelector('input[name=idioma][value=en]').click()`); await sleep(600);
await pick(file('none.txt', 'x')); s = await snap();
check('inglês: botão e mensagem', s.arqBtn === 'Upload .txt file' && s.msg === 'No phrase recognized in none.txt: the file needs 12 or 24 words per phrase.' && /Solflare downloads/.test(s.hint), `${s.arqBtn} / ${s.msg}`);
await run(`document.querySelector('input[name=idioma][value=pt]').click()`); await sleep(600);
// 10. analisar: o POST leva as frases dos arquivos normalizadas (minúsculas, um espaço), nada mais
// destino colado 1× (a entrada não envia sem ele); endereço público qualquer, o /api/analisar é interceptado
await run(`(() => { for (const id of ['destino']) { const d = document.getElementById(id); d.value = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN'; d.dispatchEvent(new Event('input')); } return true; })()`); await sleep(300);
await run(`document.getElementById('b-analisar').click()`); await sleep(800);
const a = await run(`window.__sent.find((x) => x.u === '/api/analisar')?.body`);
const expected = [V[0], V[1], V[4], V[2], V[3], V[5]];
check("POST /api/analisar com as 6 frases dos arquivos, normalizadas, todas 'auto'", a && a.frases.length === 6 && a.frases.every((f, i) => f.texto === expected[i] && f.carteira === 'auto'), JSON.stringify(a && { n: a.frases.length, ok: a.frases.map((f, i) => f.texto === expected[i]) }));
const after = await run(`({ vals: [...document.querySelectorAll('#frases textarea')].map((t) => t.value), sec: !document.getElementById('s-preparo').classList.contains('hidden') })`);
check('campos apagados depois do 202 e tela de análise', after.vals.every((v) => v === '') && after.sec, JSON.stringify(after));
check('nenhuma frase no localStorage/sessionStorage', await run(`!/legal|abandon|letter|zoo/.test(JSON.stringify({ ...localStorage, ...sessionStorage }))`));
await run(`startOver()`); await sleep(500); s = await snap();
check('começar de novo: um cartão vazio, mensagem do arquivo some', s.cards.length === 1 && s.cards[0].badge === 'Cole a frase' && s.msg === '', `${s.cards.length} / ${s.msg}`);
check('sem erro de script no fim', pageErrors.length === 0, pageErrors.join(' | '));
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await closeBrowser(results.every(Boolean) ? 0 : 1);
