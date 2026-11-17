// Tela de entrada (cartões de frase) num Edge headless, com o fetch do /api/analisar interceptado: nada é analisado.
// Usa só a frase pública de teste do BIP39 (vetor oficial "legal winner…", sem fundos) e não imprime frase nenhuma.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-entrada.mjs <pasta-prints>
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
  writeFileSync(path.join(outDir, name), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
}

await cdp('Runtime.enable');
await cdp('Page.navigate', { url });
await sleep(2500);
// vetor público do BIP39 (nunca uma frase real); fica só dentro da página, nada daqui é impresso
const P = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const C = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'; // outro vetor público do BIP39
const typeIn = (i, v) => run(`(() => { const ta = document.querySelectorAll('#frases textarea')[${i}]; ta.value = ${JSON.stringify(v)}; ta.dispatchEvent(new Event('input')); return true; })()`);
const snap = () => run(`({ cards: [...document.querySelectorAll('#frases .fr')].map((li) => { const ta = li.querySelector('textarea'); return { n: li.querySelector('.fr-num').textContent, badge: li.querySelector('.tag').textContent, cls: li.querySelector('.tag').className, err: li.querySelector('.fr-err').textContent, x: !li.querySelector('.fr-x').classList.contains('hidden'), masked: ta.className, invalid: ta.getAttribute('aria-invalid'), describedBy: document.getElementById(ta.getAttribute('aria-describedby')) === li.querySelector('.fr-err'), noApp: !li.querySelector('input[type=radio]'), attrs: ['autocomplete','spellcheck','autocapitalize','autocorrect','data-lpignore','data-1p-ignore'].map((a) => ta.getAttribute(a)) }; }), btn: document.getElementById('b-analisar').textContent, disabled: document.getElementById('b-analisar').disabled, why: document.getElementById('b-analisar-why').textContent, add: document.getElementById('b-add').textContent, addHidden: document.getElementById('b-add').classList.contains('hidden'), est: document.getElementById('est').textContent })`);
let s = await snap();
check('carrega sem erro de script', pageErrors.length === 0, pageErrors.join(' | '));
check('1 cartão vazio, botão desligado com o motivo', s.cards.length === 1 && s.disabled && s.cards[0].badge === 'Cole a frase' && !s.cards[0].x && s.why === 'Cole a frase 1 ou remova o cartão.', `${s.cards[0].badge} / ${s.why}`);
check('campo masked, anti-autocompletar e ligado ao erro', s.cards[0].masked === 'masked' && s.cards[0].attrs.join(',') === 'off,false,off,off,true,' && s.cards[0].describedBy, s.cards[0].attrs.join(','));
check('rodapé com estimativa', /1 frase · até ~100 carteiras/.test(s.est) && /min/.test(s.est), s.est);
await run(`(() => { window.__sent = []; window.__estFail = false; const real = window.fetch; window.fetch = async (u, o) => { window.__sent.push({ u, body: o?.body ? JSON.parse(o.body) : null }); if (u === '/api/analisar') return new Response('{"ok":true}', { status: 202 }); if (u === '/api/estimativa' && window.__estFail) return new Response('{"erro":"teste"}', { status: 500 }); return real(u, o); }; return true; })()`);
await typeIn(0, P); s = await snap();
check('logo depois de digitar: "conferindo…", botão desligado', s.cards[0].badge === 'conferindo…' && s.disabled && s.why === 'Conferindo as frases…', `${s.cards[0].badge} / ${s.why}`);
await sleep(500); s = await snap();
check('frase certa: selo verde, botão liga, sem motivo', s.cards[0].badge === '12 palavras ✓' && s.cards[0].cls === 'tag ok' && !s.disabled && s.btn === 'Começar' && s.why === '' && s.cards[0].invalid === null, `${s.cards[0].badge} / ${s.btn}`);
await run(`document.getElementById('b-add').click()`); await typeIn(1, P.toUpperCase()); await sleep(800); s = await snap();
check('repetida marcada na segunda, com motivo e aria-invalid', s.cards[1].badge === 'repete a frase 1' && s.cards[1].cls === 'tag bad' && s.disabled && /mesma da frase nº 1/.test(s.cards[1].err) && s.why === 'Corrija ou remova a frase 2.' && s.cards[1].invalid === 'true' && s.cards[1].describedBy, `${s.cards[1].badge} / ${s.why}`);
check('rodapé com 2 frases', /2 frases · até ~200 carteiras/.test(s.est) && s.add.includes('2 de 10'), s.est + ' / ' + s.add);
await typeIn(1, C); await sleep(800); s = await snap();
check('outra frase: selo verde; nenhum cartão pergunta o app (o app descobre Solflare ou Phantom)', s.cards[1].badge === '12 palavras ✓' && !s.disabled && s.cards[1].invalid === null && s.cards.every((c) => c.noApp), s.cards[1].badge);
await run(`document.getElementById('b-add').click()`); await sleep(500); s = await snap();
check('cartão vazio: motivo "cole a frase 3"', s.disabled && s.why === 'Cole a frase 3 ou remova o cartão.', s.why);
await typeIn(2, P.split(' ').slice(0, 11).join(' ')); await sleep(500); s = await snap();
check('11 palavras: falta 1', s.cards[2].badge === '11 palavras: falta 1' && s.disabled && s.why === 'Corrija ou remova a frase 3.', `${s.cards[2].badge} / ${s.why}`);
await typeIn(2, P.replace('wave', 'wavez')); await sleep(500); s = await snap();
check('palavra fora da lista: só a posição', s.cards[2].badge === 'palavra nº 5 fora da lista' && !/wavez/.test(JSON.stringify(s)), s.cards[2].badge);
await typeIn(2, P.replace('yellow', 'year')); await sleep(500); s = await snap();
check('checksum', s.cards[2].badge === 'não fecha na conferência', s.cards[2].badge);
await shot('entrada-escuro.png', 1280);
await shot('entrada-celular.png', 390);
await run(`document.querySelectorAll('#frases .fr')[2].querySelector('.fr-x').click()`); await sleep(500); s = await snap();
check('× tira a frase 3', s.cards.length === 2 && !s.disabled, String(s.cards.length));
// fluxo 0.1.4: sem campo de RPC (Helius embutido); a estimativa muda com o número de cartões
await run(`(() => { window.__estFail = true; document.getElementById('b-add').click(); return true; })()`); await sleep(900); s = await snap();
check('estimativa que falha: texto neutro', /estimativa indisponível agora/.test(s.est), s.est);
await run(`(() => { window.__estFail = false; document.querySelectorAll('#frases .fr')[2].querySelector('.fr-x').click(); return true; })()`); await sleep(900); s = await snap();
check('estimativa volta', /2 frases · até ~200 carteiras/.test(s.est), s.est);
// destino colado 1× (0.2: sem segunda colagem; sem "minha principal"; o app não preenche nada). Endereços públicos quaisquer:
// o /api/analisar é interceptado e nada vai à rede
const D1 = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN';
const D2 = '11111111111111111111111111111111';
const pasteDest = (a) => run(`(() => { const d = document.getElementById('destino'); d.value = ${JSON.stringify(a)}; d.dispatchEvent(new Event('input')); return true; })()`);
const destTry = async () => {
  await run(`document.getElementById('b-analisar').click()`); await sleep(500);
  return run(`({ msg: document.getElementById('e-frase').textContent, live: document.getElementById('dest-why').textContent, sent: window.__sent.filter((x) => x.u === '/api/analisar').length, focus: document.activeElement?.id })`);
};
check('sem o antigo "minha principal", um campo de destino só e vazio', await run(`!document.querySelector('input[name=destmode]') && document.getElementById('destino').value === '' && !document.getElementById('destino2')`));
// destino inválido: não envia nada, mostra o motivo (também ao vivo) e foca o 1º campo
await pasteDest('nao-e-endereco'); await sleep(200);
const destErr = await destTry();
check('destino colado inválido: não envia, mostra o motivo e foca o campo', destErr.sent === 0 && destErr.msg === 'Cole um endereço Solana válido no destino.' && destErr.live === destErr.msg && destErr.focus === 'destino', JSON.stringify(destErr));
// válido: o aviso ao vivo some (uma colagem basta; o servidor confere se a carteira existe, no plano)
await pasteDest(D2); await sleep(200);
check('destino válido: aviso ao vivo some (D2 sem uso aqui)', (await run(`document.getElementById('dest-why').textContent`)) === '');
await pasteDest(D1); await sleep(200);
check('destino colado uma vez: aviso ao vivo some', (await run(`document.getElementById('dest-why').textContent`)) === '');
for (let i = 2; i < 10; i++) await run(`document.getElementById('b-add').click()`);
await sleep(400); s = await snap();
check('+ Adicionar some no 10º', s.cards.length === 10 && s.addHidden, `${s.cards.length} ${s.addHidden}`);
for (let i = 9; i >= 2; i--) await run(`document.querySelectorAll('#frases .fr')[${i}].querySelector('.fr-x').click()`);
await sleep(400);
await run(`document.querySelector('input[name=idioma][value=en]').click()`); await sleep(600); s = await snap();
check('inglês', s.btn === 'Start with 2 phrases' && s.cards[0].badge === '12 words ✓' && /2 phrases/.test(s.est), s.btn + ' / ' + s.est);
await run(`document.querySelector('input[name=idioma][value=pt]').click()`); await sleep(600);
await run(`document.getElementById('b-analisar').click()`); await sleep(600);
const sent = await run(`window.__sent.filter((x) => x.u !== '/api/estimativa' && !x.u.startsWith('/assets'))`);
const est = await run(`window.__sent.filter((x) => x.u === '/api/estimativa').map((x) => x.body)`);
const a = sent.find((x) => x.u === '/api/analisar')?.body;
check('POST /api/analisar com frases [{texto, carteira}]', a && a.frases.length === 2 && a.frases.every((f) => f.carteira === 'auto') && a.frases.map((f) => f.texto.toLowerCase()).join('|') === [P, C].join('|') && a.rede === 'mainnet' && !('carteira' in a) && !JSON.stringify(a).includes(D1), JSON.stringify(a && { n: a.frases.length, apps: a.frases.map((f) => f.carteira), rede: a.rede }));
// o que importa: nenhum pedido além do /api/analisar leva a frase (o painel de créditos do Helius faz GETs próprios)
const others = sent.filter((x) => x.u !== '/api/analisar');
check('só o /api/analisar leva texto', sent.filter((x) => x.u === '/api/analisar').length === 1 && others.every((x) => !/legal|letter/.test(JSON.stringify(x).toLowerCase())) && est.every((b) => Object.keys(b).sort().join() === 'etapa,frases'), `${est.length} estimativas; outros: ${[...new Set(others.map((x) => x.u))].join(', ') || 'nenhum'}`);
const after = await run(`({ vals: [...document.querySelectorAll('#frases textarea')].map((t) => t.value), sec: !document.getElementById('s-preparo').classList.contains('hidden') })`);
check('campos apagados depois do 202 e tela de análise', after.vals.every((v) => v === '') && after.sec, JSON.stringify(after));
check('nenhuma frase no localStorage/sessionStorage', await run(`!JSON.stringify({ ...localStorage, ...sessionStorage }).includes('legal')`));
await run(`startOver()`); await sleep(500); s = await snap();
check('começar de novo: um cartão vazio', s.cards.length === 1 && s.cards[0].noApp && s.cards[0].badge === 'Cole a frase', JSON.stringify(s.cards.map((c) => c.badge)));
check('sem erro de script no fim', pageErrors.length === 0, pageErrors.join(' | '));
console.log(results.every(Boolean) ? 'TUDO OK' : 'FALHOU');
await closeBrowser(results.every(Boolean) ? 0 : 1);
