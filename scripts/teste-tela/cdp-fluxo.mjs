// Fluxo em 3 telas (31/10/2026) com estado inventado e fetch interceptado: entrada com destino, preparação narrada
// (análise, pendências, espera do depósito, simulação), confirmação única (quanto, em quê, para onde, tokens),
// mudar uma escolha pede "Aplicar", inglês, claro, celular 390 px, botão de som (clique de verdade) e quais sons
// tocaram; cenário "chaves" (chaves coladas, conferência com a suspeita protegida e os dois avisos de conferência).
// Sem frase nem chave de ninguém.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-fluxo.mjs <pasta-prints>
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

try {
  await cdp('Page.navigate', { url });
  await sleep(2500);
  await run(`(() => {
    window.__sent = [];
    const real = window.fetch;
    window.fetch = async (u, o) => {
      const body = o?.body ? JSON.parse(o.body) : null;
      window.__sent.push({ u, body });
      if (u === '/api/plano') { window.__state = window.__planView; return new Response(JSON.stringify(window.__planView), { status: 200 }); }
      if (u === '/api/simular' || u === '/api/analisar-frase') return new Response('{"ok":true}', { status: 202 });
      if (u === '/api/estimativa') return new Response(JSON.stringify(body.etapa === 'simulacao' ? { seconds: 480, credits: 3000, wallets: body.carteiras } : { seconds: 1500, credits: 6000, wallets: body.carteiras }), { status: 200 });
      if (u === '/api/estado') return new Response(JSON.stringify(window.__state), { status: 200 });
      return real(u, o);
    };
    return true;
  })()`);

  // ---- 1. entrada: destino na mesma tela, sem escolha de rede ----
  const e1 = await run(`({ rede: !!document.querySelector('input[name=rede]'), dest: !!document.getElementById('destino') && !document.getElementById('destino2'), radio: !!document.querySelector('input[name=destmode]'), btn: document.getElementById('b-analisar').textContent, steps: [...document.querySelectorAll('#steps li')].map((l) => l.textContent), title: document.title })`);
  // ---- botão de som (topo, todas as telas): clique de verdade (gesto) silencia e religa ----
  const clickAt = async (sel) => {
    const r = await run(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    await sleep(150);
  };
  const snd = async () => run(`(() => { const b = document.getElementById('snd-toggle'); return b && { pressed: b.getAttribute('aria-pressed'), title: b.title, name: b.textContent, saved: localStorage.getItem('autoclarn-som'), played: { ...sounds.played } }; })()`);
  const so = await snd();
  await clickAt('#snd-toggle');
  const sOff = await snd();
  await clickAt('#snd-toggle');
  const sOn = await snd();
  check('som: botão no topo, ligado por padrão; clique silencia (aria-pressed false, guardado) e religa com o tom curto', so?.pressed === 'true' && so.name === 'Sons de aviso' && /clique para silenciar/.test(so.title) && sOff.pressed === 'false' && sOff.saved === 'off' && /clique para ligar/.test(sOff.title) && sOn.pressed === 'true' && sOn.saved === 'on' && sOn.played.ligar === 1, JSON.stringify({ so, sOff, sOn }));
  check('entrada: sem rede, destino colado 1× (sem segunda colagem nem "minha principal"), botão "Começar", 4 etapas',!e1.rede && e1.dest && !e1.radio && /Começar/.test(e1.btn) && e1.steps.join('|') === 'Frases e destino|Preparando|Confirmar|Enviando' && e1.title === 'Etapa 1 de 4 · Frases e destino', JSON.stringify(e1));
  await run(`(() => { const a = document.getElementById('destino'); a.value = 'nao-e-endereco'; a.dispatchEvent(new Event('input')); return true; })()`);
  const e2 = await run(`document.getElementById('dest-why').textContent`);
  check('entrada: destino que não é endereço avisa ao vivo', /endereço Solana válido/.test(e2), e2);
  await run(`(() => { const a = document.getElementById('destino'); a.value = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN'; a.dispatchEvent(new Event('input')); return true; })()`);
  const e3 = await run(`document.getElementById('dest-why').textContent`);
  check('entrada: válido, colado uma vez, o aviso some', e3 === '', e3);
  await shot('fx-1-entrada.png');

  // ---- estado inventado (o mesmo das várias frases) ----
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
  await run(`window.__state = ${JSON.stringify({ ...base, busy: 'analise', frases: frases.map((f) => ({ ...f, status: f.n === 1 ? 'pronta' : f.n === 2 ? 'leitura' : 'fila' })) })}; window.__planView = ${JSON.stringify(partial)}; true`);

  // ---- 2. preparação: análise narrada ----
  await run(`ui.dest = { addr: ${JSON.stringify(DEST)} }; document.getElementById('destino').value = ${JSON.stringify(DEST)}; beginAnalysis(4); ui.prep.phase = 'analise'; onProgress({ fase: 'leitura', frase: 2, carteira: 'Conta 3', feitos: 1, total: 3, etaMs: 95000, geral: { feitos: 4, total: 12 } }); renderPrep(); show('s-preparo'); true`);
  await sleep(800);
  const p1 = await run(`({ title: document.getElementById('p-titulo').textContent, stages: [...document.querySelectorAll('#p-stages .stage')].map((s) => s.className.replace('stage ', '')), now: document.getElementById('p-now').textContent, money: /SOL|US\\$/.test(document.getElementById('s-preparo').textContent), rows: document.querySelectorAll('#p-frases .pf-row').length, doc: document.title })`);
  check('preparando: etapas (1 feita, 2 agora), "Agora:", sem nenhum valor em dinheiro, 4 linhas de frase', /Analisando 4 frases/.test(p1.title) && p1.stages.join() === 'done,now,todo,todo,todo' && /lendo saldos/.test(p1.now) && !p1.money && p1.rows === 4 && p1.doc === 'Etapa 2 de 4 · Preparando', JSON.stringify(p1));
  await shot('fx-2-analisando.png');

  // ---- análise terminou: pendências (frase 4 com erro, contas da Phantom) ----
  await run(`window.__state = ${JSON.stringify(base)}; true`);
  const ev = (type, data) => run(`events.dispatchEvent(new MessageEvent(${JSON.stringify(type)}, { data: ${JSON.stringify(JSON.stringify(data))} })); true`);
  await ev('pronto', { tarefa: 'analise', estado: base });
  await sleep(500);
  const p2 = await run(`({ phase: ui.prep.phase, section: ui.section, title: document.getElementById('p-titulo').textContent, cards: [...document.querySelectorAll('#p-cards .need')].map((c) => c.className + ':' + c.querySelector('h3').textContent), stages: [...document.querySelectorAll('#p-stages .stage')].map((s) => s.className.replace('stage ', '')), prot: [...document.querySelectorAll('#rev-lista-2 input:checked')].map((c) => c.value), count: document.getElementById('rev-resumo-2')?.textContent })`);
  // contagem no desenho da 0.2.3: o número em destaque e "contas serão limpas" (o texto antigo era "Serão limpas 2 contas")
  check('pendências: fica na preparação com o cartão da frase 4 (erro) e o da Phantom (frase 2), etapa do plano à espera', p2.phase === 'pendente' && p2.section === 's-preparo' && /Antes de continuar/.test(p2.title) && p2.cards.length === 2 && /bad:A frase 4 não pôde/.test(p2.cards[0]) && /Confira as contas da Phantom/.test(p2.cards[1]) && p2.stages[3] === 'wait' && p2.prot.join() === '3' && /^2\s*contas serão limpas/.test(p2.count), JSON.stringify(p2));
  await shot('fx-3-pendencias.png');
  // "corrigir e analisar só esta" na frase 4 (vetor público do BIP39, sem fundos; o texto nunca é impresso)
  await run(`[...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Corrigir e analisar só esta').click(); true`);
  await sleep(300);
  await run(`(() => { const ta = document.querySelector('#p-cards [data-frase="4"] textarea'); ta.value = 'legal winner thank year wave sausage worth useful legal winner thank yellow'; ta.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(1500);
  const fx = await run(`(() => { const d = document.querySelector('#p-cards [data-frase="4"]'); return { badge: d.querySelector('.fr .tag')?.textContent, disabled: d.querySelector('.fc-fix .row .btn').disabled, goOn: [...d.querySelectorAll('button')].some((b) => b.textContent === 'Seguir sem ela') }; })()`);
  check('corrigir só esta: o cartão de frase abre dentro do cartão do erro, confere aqui e libera o botão', !fx.disabled && /12 palavras/.test(fx.badge ?? '') && !fx.goOn, JSON.stringify(fx));
  await run(`document.querySelector('#p-cards [data-frase="4"] .fc-fix .row .btn').click(); true`);
  await sleep(600);
  const redo = await run(`(() => { const b = window.__sent.find((x) => x.u === '/api/analisar-frase')?.body; return { n: b?.n, carteira: b?.carteira, hasText: typeof b?.texto === 'string' && b.texto.split(' ').length === 12, left: [...document.querySelectorAll('textarea')].filter((t) => t.value !== '').length, section: ui.section, phase: ui.prep.phase, redo: ui.redo }; })()`);
  check('manda só a frase 4, apaga o campo depois do 202 e volta à análise na mesma tela', redo.n === 4 && redo.carteira === 'auto' && redo.hasText && redo.left === 0 && redo.section === 's-preparo' && redo.phase === 'analise' && redo.redo === 4, JSON.stringify(redo));
  // a frase 4 deu erro de novo: o cartão dela volta, com "Seguir sem ela"
  await ev('erro', { tarefa: 'analise', mensagem: 'x', codigo: 'seed-checksum', params: {} });
  await sleep(600);
  const back = await run(`({ phase: ui.prep.phase, cards: [...document.querySelectorAll('#p-cards .need')].map((c) => c.dataset.frase).join() })`);
  check('frase refeita com erro: volta às pendências (frase 4 e Phantom)', back.phase === 'pendente' && back.cards === '4,2', JSON.stringify(back));
  // contagem errada avisa; "Seguir sem ela" + contagem certa → plano
  await run(`document.getElementById('rev-n-2').value = '3'; [...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Continuar').click(); true`);
  const p3 = await run(`document.querySelector('#p-cards [data-frase="2"] [role=alert]')?.textContent ?? ''`);
  check('contagem errada não passa', /Não bate: serão limpas 2 contas/.test(p3), p3);
  await run(`[...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Seguir sem ela').click(); true`);
  await sleep(300);
  await run(`document.getElementById('rev-n-2').value = '2'; [...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Continuar').click(); true`);
  await sleep(900);
  const sentPlan = await run(`window.__sent.find((x) => x.u === '/api/plano')?.body`);
  check('plano pedido sozinho: destino = principal da frase 1 (1×, sem destino2), queimar só os recomendados, Phantom protegida = Conta 4, contagem 2', sentPlan?.destino === DEST && !('destino2' in (sentPlan ?? {})) && JSON.stringify(sentPlan?.decisoes) === '{"acct1":"burn","acct2":"transfer","acct5":"burn"}' && JSON.stringify(sentPlan?.porFrase) === '{"2":{"protegidas":[4],"contasConfirmadas":2}}', JSON.stringify(sentPlan));
  const p4 = await run(`({ phase: ui.prep.phase, title: document.getElementById('p-titulo').textContent, wait: document.getElementById('p-cards').textContent })`);
  check('plano parcial: espera do depósito da frase 3 aqui mesmo, com "Simular agora sem a frase 3"', p4.phase === 'espera' && /Esperando o depósito das taxas/.test(p4.title) && /Esperando o depósito/.test(p4.wait) && /Simular agora sem a frase 3/.test(p4.wait) && !/Voltar ao início/.test(p4.wait), JSON.stringify(p4).slice(0, 200));
  await shot('fx-4-espera.png');

  // ---- simulação na mesma tela ----
  await run(`[...document.querySelectorAll('#p-cards button')].find((b) => /Simular agora/.test(b.textContent)).click(); true`);
  await sleep(600);
  await run(`onProgress({ fase: 'simulacao', frase: 2, carteira: 'Conta 3', feitos: 1, total: 3, etaMs: 95000, geral: { feitos: 3, total: 5 } }); true`);
  await ev('passo', { modo: 'simulate', frase: 1, status: 'simulado', step: step(1), walletIndex: 1, destinationDelta: '2976880', link: null, error: null, detail: null, arrived: null });
  await sleep(1200);
  const s1 = await run(`({ phase: ui.prep.phase, section: ui.section, title: document.getElementById('p-titulo').textContent, stages: [...document.querySelectorAll('#p-stages .stage')].map((s) => s.className.replace('stage ', '')), txt: document.getElementById('prep-run').textContent, hidden: document.getElementById('prep-run').classList.contains('hidden') })`);
  check('simulação: etapa 5 "agora", tempo restante e "Agora: testando a frase 2 · Conta 3 (passo 2 de 3)" na mesma tela', s1.phase === 'simulacao' && s1.section === 's-preparo' && s1.stages.join() === 'done,done,done,done,now' && !s1.hidden && /~2 min restantes/.test(s1.txt) && /testando a frase 2 · Conta 3 \(passo 2 de 3\)/.test(s1.txt), JSON.stringify(s1).slice(0, 300));
  const s2 = await run(`({ rows: [...document.querySelectorAll('#prep-run .pf-row')].map((r) => r.className.replace('pf-row ', '') + ':' + r.querySelector('.pf-what').textContent), out: document.querySelector('#prep-run .run-out')?.textContent ?? '' })`);
  check('teste: as frases 3 (esperando) e 4 (pulada) aparecem na lista como "Fora desta rodada", com o motivo e o aviso', s2.rows.length === 4 && /^out:.*esperando o depósito/.test(s2.rows[2]) && /^out:.*pulada na análise/.test(s2.rows[3]) && s2.out.includes('Ficam fora desta rodada: frase 3 (esperando o depósito); frase 4 (pulada na análise)'), JSON.stringify(s2));
  await shot('fx-5-testando.png');

  // ---- 3. confirmação ----
  const tk = (lbl, sym, amount, usd) => ({ walletIndex: 1, label: lbl, account: 'a', mint: 'm', symbol: sym, amount, decimals: 0, usdValue: usd, solValue: null });
  const rcpt = (n, app, lbl, tokens = [], burned = []) => ({ frase: n, app, receipt: { destination: DEST, toDestination: { closedAccounts: '2', closedRentLamports: '2976880', claims: 1, claimLamports: '120000000', tokens, looseSolLamports: '5000000' }, burned, kept: [], failed: [], totalLamports: '127976880', feeEstimateLamports: '15000', appFeeLamports: '14000000', appFeeWallet: 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL', feePayerIndex: 0, feePayerLabel: n === 2 ? 'Conta 1' : 'N=0', destinationIsMain: true } });
  const simDone = { ...partial, simResults: [{ frase: 1, status: 'simulado', step: step(1), walletIndex: 1, destinationDelta: '2976880' }, { frase: 2, status: 'simulado', step: step(1), walletIndex: 1, destinationDelta: '1000' }], receipt: { frases: [rcpt(1, 'solflare', 'N=1', [], [tk('N=1', 'MEME', '98000000', 0.004)]), rcpt(2, 'phantom', 'Conta 2', [tk('Conta 2', 'BONK', '154200', 3.1)])], totalLamports: '255953760', feeEstimateLamports: '30000', appFeeLamports: '28000000', destination: DEST, failedCount: 0, burnedCount: 1, keptCount: 0 } };
  await ev('pronto', { tarefa: 'simulacao', estado: simDone });
  await sleep(600);
  const c1 = await run(`({ section: ui.section, doc: document.title, total: document.querySelector('#c-encontrado .receipt-total')?.textContent, label: document.querySelector('#c-encontrado .receipt-total-label')?.textContent, usd: document.querySelector('#c-encontrado .receipt-usd')?.textContent, lines: [...document.querySelectorAll('#c-encontrado .line')].map((l) => l.textContent), groups: [...document.querySelectorAll('#c-tokens .tk-group h3')].map((h) => h.textContent), rows: document.querySelectorAll('#c-tokens .tk').length, main: !document.getElementById('c-main').classList.contains('hidden'), hold: document.getElementById('b-executar').disabled, blocks: document.querySelectorAll('#c-destino span').length, phantom: document.getElementById('c-phantom').textContent, passos: document.getElementById('c-passos-sum').textContent, apply: document.getElementById('c-apply').classList.contains('hidden'), det: document.querySelectorAll('#c-detalhes details.det').length })`);
  check('confirmação: total líquido grande, US$, de onde vem, taxa do app e total (taxa de rede só como informação)', /0,2559/.test(c1.total) && /Vai chegar no destino/.test(c1.label) && /US\$ 38,39/.test(c1.usd) && c1.lines.some((l) => /SOL solto/.test(l)) && c1.lines.some((l) => /Aluguel de 4 contas/.test(l)) && c1.lines.some((l) => /Creator fees .*2 coletas/.test(l)) && c1.lines.some((l) => /BONK/.test(l)) && !c1.lines.some((l) => /^Taxas de rede/.test(l)) && c1.lines.some((l) => /Taxa do app/.test(l)), JSON.stringify(c1.lines));
  check('confirmação: tokens em 3 grupos (vão, queimados, ficam), 5 linhas; Phantom resumida; passos e detalhes fechados', c1.groups.join('|') === 'Vão para o destino (1)|Vão ser queimados, somem para sempre (2)|Ficam onde estão (2)' && c1.rows === 5 && /serão limpas Conta 2, Conta 3/.test(c1.phantom) && /protegidas: Conta 4/.test(c1.phantom) && /2 passos testados/.test(c1.passos) && c1.det === 3, JSON.stringify({ g: c1.groups, r: c1.rows, ph: c1.phantom, p: c1.passos, d: c1.det }));
  check('confirmação: destino = principal (selo) em blocos, botão liberado (sem digitação); aplicar escondido', c1.section === 's-confirmar' && c1.doc === 'Etapa 3 de 4 · Confirmar' && c1.main && !c1.hold && c1.blocks === 11 && c1.apply, JSON.stringify({ s: c1.section, m: c1.main, h: c1.hold, k: c1.blocks, a: c1.apply }));
  // sem o mapa do dinheiro (08/11/2026): passos testados por tipo, sem carteira nem valor; tabela das carteiras só com
  // nome, endereço e observações; a linha do trabalho que a taxa paga
  const nm = await run(`({ rows: [...document.querySelectorAll('#sim-lista li')].map((l) => l.textContent), hint: document.querySelector('#c-passos .det-body > .hint')?.textContent ?? '', heads: [...document.querySelectorAll('#c-detalhes table')].map((tb) => [...tb.querySelectorAll('th')].map((th) => th.textContent).join('|')), det: document.getElementById('c-detalhes').textContent, work: document.getElementById('c-trabalho')?.textContent ?? '' })`);
  check('sem mapa: passos testados por tipo e frase, sem carteira e sem valor; aviso de que o valor vem na tela final', nm.rows.length === 2 && nm.rows.every((r) => /^simuladoFrase [12] · Fechar contas de token \(queimar ou transferir antes, como você escolheu\): 2 contas em 1 carteira$/.test(r)) && !nm.rows.some((r) => /SOL|N=1|Conta 2|\d,\d/.test(r)) && /tela final/.test(nm.hint), JSON.stringify(nm.rows) + nm.hint);
  check('sem mapa: tabela das carteiras só com nome, endereço e observações (sem SOL, aluguel nem creator fee)', nm.heads.length === 3 && nm.heads.every((h) => h === 'Carteira|Endereço|Observações') && !/0,005|0,00297|Creator fees|SOL solto/.test(nm.det), JSON.stringify(nm.heads));
  check('trabalho: "À mão seriam N transações, uma carteira por vez"', /^À mão seriam \d+ transações, uma carteira por vez\. O Clurn faz todas agora\.$/.test(nm.work), nm.work);
  await shot('fx-6-confirmar.png');
  // detalhes abertos: passos testados por tipo e as carteiras sem valor (foto para conferir a olho)
  await run(`document.querySelectorAll('#c-passos, #c-detalhes details').forEach((d) => { d.open = true; }); document.getElementById('c-passos').scrollIntoView(); true`);
  await sleep(300);
  await shot('fx-6b-detalhes.png');
  await run(`document.querySelectorAll('#c-passos, #c-detalhes details').forEach((d) => { d.open = false; }); window.scrollTo(0, 0); true`);
  // creator fees na Confirmar (correção do claim visível): a linha "Creator fees (N coletas)" soma as coletas das
  // frases (bruto, antes dos 11%), e os avisos dizem o que existe e não entrou no total
  {
    const feeState = JSON.parse(JSON.stringify(simDone));
    feeState.receipt.frases[0].receipt.toDestination.claims = 4;
    feeState.receipt.frases[0].receipt.toDestination.claimLamports = '300000000';
    feeState.receipt.frases[1].receipt.feeSharing = [2];
    feeState.frases[0].wallets[1].unswept = '5000000';
    feeState.frases[0].wallets[2].unsweptError = 'getProgramAccounts: tempo esgotado';
    feeState.frases[0].wallets[1].launchlabOther = 2; // cofres do LaunchLab com fee em USD1/USDC/USDT (09/11/2026)
    await run(`state = ${JSON.stringify(feeState)}; renderConfirm(true); true`);
    const cf = await run(`({ lines: [...document.querySelectorAll('#c-encontrado .line')].map((l) => l.textContent), avisos: document.getElementById('c-avisos').textContent, total: document.querySelector('#c-encontrado .receipt-total')?.textContent })`);
    check('Confirmar: "Creator fees e cashback (5 coletas)" com a soma das coletas das duas frases (0,42 SOL)', cf.lines.includes('Creator fees e cashback (5 coletas)0,420000 SOL'), cf.lines.join(' | '));
    check('Confirmar: avisos do que não entrou no total (parada não coletável, leitura que falhou, fee sharing)', /Fora do total: 0,005000 SOL de creator fees/.test(cf.avisos) && /Em 1 carteira, a leitura das creator fees paradas nas moedas/.test(cf.avisos) && /1 carteira tem a creator fee de alguma moeda dividida/.test(cf.avisos), cf.avisos.slice(0, 300));
    check('Confirmar: aviso dos cofres do LaunchLab com fee em outra moeda', /2 cofres do LaunchLab \(bonk\.fun e outros\) com creator fee em USD1, USDC ou USDT/.test(cf.avisos), cf.avisos.slice(0, 600));
    await shot('fx-6b-creator-fees.png');
    await run(`state = ${JSON.stringify(simDone)}; renderConfirm(true); true`);
  }
  // soma das linhas = total (correção da 0.1.7): na Confirmar e na tela final, as categorias vêm em BRUTO e a taxa do app
  // é a única subtração; a taxa de rede é só informação. Dados falsos coerentes: cada passo divide 89% / 11%.
  {
    const lam = (txt) => { const m = /(−?)([\d.]+),(\d{6}) SOL$/.exec(txt); return m ? (m[1] ? -1 : 1) * (Number(m[2].replace(/\./g, '')) * 1e6 + Number(m[3])) : null; };
    const mk = (kind, gross) => { const fee = Math.floor((gross * 11) / 100); return { kind, gross, fee, dest: gross - fee }; };
    const parts = [mk('tokens', 2_976_000), mk('claim-curve', 120_000_000), mk('sweep-sol', 5_000_000)];
    const by = (k) => parts.filter((x) => x.kind === k).reduce((a, x) => a + x.gross, 0);
    const fee = parts.reduce((a, x) => a + x.fee, 0), dest = parts.reduce((a, x) => a + x.dest, 0);
    const rc = (n, app) => ({ frase: n, app, receipt: { destination: DEST, toDestination: { closedAccounts: 2, closedRentLamports: String(by('tokens')), claims: 1, claimLamports: String(by('claim-curve')), tokens: [], looseSolLamports: String(by('sweep-sol')) }, burned: [], kept: [], failed: [], feeSharing: [], totalLamports: String(dest), feeEstimateLamports: '15000', appFeeLamports: String(fee), appFeeWallet: 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL', feePayerIndex: 0, feePayerLabel: n === 2 ? 'Conta 1' : 'N=0', destinationIsMain: true } });
    const receipt = { frases: [rc(1, 'solflare'), rc(2, 'phantom')], totalLamports: String(2 * dest), feeEstimateLamports: '30000', appFeeLamports: String(2 * fee), destination: DEST, failedCount: 0, burnedCount: 0, keptCount: 0 };
    const sumState = { ...simDone, receipt };
    await run(`state = ${JSON.stringify(sumState)}; renderConfirm(true); true`);
    const cl = await run(`({ lines: [...document.querySelectorAll('#c-encontrado .line')].map((l) => l.textContent), hint: [...document.querySelectorAll('#c-encontrado .hint')].map((h) => h.textContent).join(' ') })`);
    const totalLine = cl.lines.find((l) => /^Vai chegar no destino/.test(l));
    // a soma "Encontrado nas carteiras" (0.2) é subtotal: fora da conta das linhas
    const parts1 = cl.lines.filter((l) => l !== totalLine && !/^Encontrado nas carteiras/.test(l) && / SOL$/.test(l)).map(lam);
    const sum1 = parts1.reduce((a, x) => a + x, 0);
    check('Confirmar: solto + aluguel + creator fees (brutos) − taxa do app = total, pelo texto da tela (cada linha cortada em 6 casas: até 1 milionésimo por linha)', totalLine && lam(totalLine) === Math.floor((2 * dest) / 1000) && Math.abs(sum1 - lam(totalLine)) <= parts1.length && !cl.lines.some((l) => /^Taxas de rede/.test(l)), `${cl.lines.join(' | ')} → soma ${sum1}`);
    check('Confirmar: taxa de rede só como informação ("já descontados do SOL solto"), fora da soma', /Taxas de rede e aluguel de contas novas: 0,000030 SOL, já descontados do SOL solto/.test(cl.hint), cl.hint.slice(0, 160));
    await shot('fx-6c-soma.png');
    // tela final: as mesmas linhas sobre o que foi ENVIADO (execReceipt) e cada coleta com o link
    const execResults = parts.map((x, k) => ({ frase: 1, status: 'enviado', step: { ...step(1, x.kind), kind: x.kind }, walletIndex: 1, destinationDelta: String(x.dest), appFeeDelta: String(x.fee), link: `https://solscan.io/tx/s${k}` }));
    const execReceipt = { frases: [rc(1, 'solflare')], totalLamports: String(dest), feeEstimateLamports: '15000', appFeeLamports: String(fee), destination: DEST, failedCount: 0, burnedCount: 0, keptCount: 0 };
    await run(`state = ${JSON.stringify({ ...sumState, execResults, execReceipt, arrived: String(dest) })}; ui.exec = { items: state.execResults, done: true, error: null }; show('s-execucao'); renderExecFim(); true`);
    await sleep(300);
    const xl = await run(`({ big: document.querySelector('#x-resumo .receipt-total')?.textContent, lines: [...document.querySelectorAll('#x-resumo .lines')][0] ? [...[...document.querySelectorAll('#x-resumo .lines')][0].querySelectorAll('.line')].map((l) => l.textContent) : [], claims: [...document.querySelectorAll('#x-resumo p.hint')].map((p) => ({ text: p.textContent, link: p.querySelector('a')?.href ?? null })) })`);
    // 0.2: a coluna da tela final tem também a soma do encontrado e a linha "Chegou no destino": fora da conta
    const xparts = xl.lines.filter((l) => !/^(Encontrado nas carteiras|Chegou no destino)/.test(l));
    const sum2 = xparts.map(lam).reduce((a, x) => a + (x ?? 0), 0);
    const big = Number((xl.big ?? '').replace(/[^\d,]/g, '').replace(',', '.'));
    check('tela final: as linhas (brutos − taxa do app) somam o "Recebido no destino"', xparts.length === 4 && xl.lines.some((l) => /^Chegou no destino/.test(l) && lam(l) === Math.floor(dest / 1000)) && Math.abs(sum2 - Math.floor(dest / 1000)) <= xparts.length && Math.abs(big - dest / 1e9) < 0.0001, `${xl.lines.join(' | ')} → soma ${sum2}, grande ${xl.big}`);
    const claimRow = xl.claims.find((c) => /frase 1/.test(c.text) && /0,120000 SOL/.test(c.text));
    check('tela final: "Creator fees coletadas" com a coleta (bruto) e o link da transação', Boolean(claimRow) && claimRow.link === 'https://solscan.io/tx/s1', JSON.stringify(xl.claims).slice(0, 200));
    await shot('fx-6d-final-soma.png');
    await run(`state = ${JSON.stringify(simDone)}; ui.exec = { items: [], done: false, error: null }; renderConfirm(true); show('s-confirmar'); true`);
  }
  // mudar uma escolha: aplicar aparece, botão trava de novo, aviso de valores velhos
  await run(`(() => { const s = document.querySelector('#c-tokens .tk[data-account="acct4"] select'); s.value = 'burn'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(200);
  const c3 = await run(`({ apply: !document.getElementById('c-apply').classList.contains('hidden'), hold: document.getElementById('b-executar').disabled, hint: document.getElementById('hold-hint').textContent, word: !!document.getElementById('bci-all'), applyDisabled: document.getElementById('b-apply').disabled, stale: /teste anterior/.test(document.getElementById('c-avisos').textContent), groups: [...document.querySelectorAll('#c-tokens .tk-group h3')].map((h) => h.textContent) })`);
  check('mudar escolha (queimar sem valor conhecido): "Aplicar" aparece mas pede a palavra; botão trava; aviso de valores velhos', c3.apply && c3.hold && /Aplique as mudanças/.test(c3.hint) && c3.word && c3.applyDisabled && c3.stale && /queimados.*\(3\)/.test(c3.groups[1]), JSON.stringify(c3));
  await run(`document.getElementById('bci-all').value = 'queimar'; document.getElementById('bci-all').dispatchEvent(new Event('input')); true`);
  const c4 = await run(`document.getElementById('b-apply').disabled`);
  check('palavra digitada libera "Aplicar"', c4 === false);
  await shot('fx-7-aplicar.png');
  await run(`document.getElementById('b-apply').click(); true`);
  await sleep(700);
  const sentPlan2 = await run(`window.__sent.filter((x) => x.u === '/api/plano').at(-1)?.body`);
  check('"Aplicar" monta o plano de novo com a escolha nova e a palavra; volta à preparação (plano/simulação)', sentPlan2?.decisoes?.acct4 === 'burn' && JSON.stringify(sentPlan2?.queimarConfirmado) === '["acct4"]' && (await run(`ui.section`)) === 's-preparo', JSON.stringify(sentPlan2));

  // ---- enviando: "Já chegou no destino", "Agora: … · ver", pausa, fim por frase ----
  await ev('pronto', { tarefa: 'simulacao', estado: simDone });
  await sleep(400);
  await run(`ui.exec = { items: [], done: false, error: null }; ui.run = { clock: null, pct: 0, link: null }; state.arrived = '0'; show('s-execucao'); renderExecHeader(); true`);
  await run(`onProgress({ fase: 'execucao', frase: 2, carteira: 'Conta 2', feitos: 0, total: 3, etaMs: 240000, geral: { feitos: 2, total: 5 } }); true`);
  await ev('passo', { modo: 'execute', frase: 1, status: 'enviado', step: step(1), walletIndex: 1, destinationDelta: '2976880', link: 'https://solscan.io/tx/abc', error: null, detail: null, arrived: '2976880' });
  await sleep(1200);
  const x = await run(`({ txt: document.getElementById('x-run').textContent, link: document.querySelector('#x-run .pf-now a')?.href, doc: document.title })`);
  check('enviando: "Já chegou no destino" soma, "Agora: frase 2 · Conta 2" com "ver" da última transação, etapa 4 de 4', /Já chegou no destino0,002976 SOL/.test(x.txt) && /frase 2 · Conta 2 \(passo 1 de 3\)/.test(x.txt) && x.link === 'https://solscan.io/tx/abc' && x.doc === 'Etapa 4 de 4 · Enviando', `${x.txt.slice(0, 160)} / ${x.link} / ${x.doc}`);
  await run(`onPause({ motivo: 'rpc-quota' }); true`);
  await sleep(1100);
  const px = await run(`({ pause: !document.getElementById('pausa').classList.contains('hidden'), now: document.querySelector('#x-run .pf-now').className, eta: document.querySelector('#x-run .big')?.textContent, hint: document.getElementById('pausa-stop-hint').textContent })`);
  check('pausa no envio: cartão no topo, "Pausado:", tempo "pausado", parar leva ao relatório', px.pause && /paused/.test(px.now) && px.eta === 'pausado' && /relatório/.test(px.hint), JSON.stringify(px));
  await shot('fx-10-enviando.png');
  await run(`onPause({ motivo: null, rpc: 'mainnet.helius-rpc.com' }); true`);
  await ev('pronto', { tarefa: 'execucao', estado: { ...simDone, execResults: [{ frase: 1, status: 'enviado', step: step(1), walletIndex: 1, destinationDelta: '2976880', link: 'https://solscan.io/tx/abc' }], arrived: '2976880', reportFile: 'relatorios/limpeza-mainnet.json' } });
  await sleep(1200);
  const fim = await run(`({ rows: [...document.querySelectorAll('#x-run .pf-row')].map((r) => r.querySelector('.pf-st').textContent), fim: !document.getElementById('x-fim').classList.contains('hidden'), before: document.getElementById('x-fim').compareDocumentPosition(document.getElementById('x-lista')) & 4, total: document.querySelector('#x-resumo .receipt-total')?.textContent })`);
  check('fim: frase 1 pronta, frase 2 "Não rodou", frases 3 e 4 "Fora desta rodada"; total recebido; botões acima da lista', fim.rows.join() === 'Pronta ✓,Não rodou,Fora desta rodada,Fora desta rodada' && fim.fim && fim.before === 4 && /0,0029/.test(fim.total ?? ''), JSON.stringify(fim));
  await shot('fx-11-fim.png');
  // um passo de simulação (não toca) e um enviado de verdade (toca), etapas para a frente e o fim animado uma vez
  const sp = await run(`({ ...sounds.played })`);
  check('som: 1 envio de verdade = 1 "pluck" (a simulação não tocou); etapas tocaram; fim animado uma vez; o grave só na frase refeita com erro', sp.tx === 1 && sp.fim === 1 && sp.etapa >= 2 && sp.erro === 1, JSON.stringify(sp));

  // ---- inglês, claro, celular ----
  await ev('pronto', { tarefa: 'simulacao', estado: simDone });
  await sleep(400);
  await run(`show('s-confirmar'); true`);
  await run(`LANG = 'en'; rerender(); applyTheme('light'); true`);
  await sleep(600);
  const en = await run(`({ title: document.title, label: document.querySelector('#c-encontrado .receipt-total-label')?.textContent, groups: [...document.querySelectorAll('#c-tokens .tk-group h3')].map((h) => h.textContent), steps: [...document.querySelectorAll('#steps li')].map((l) => l.textContent).join('|') })`);
  check('inglês: título, rótulo do total, grupos e etapas', en.title === 'Step 3 of 4 · Confirm' && /Will reach the destination/.test(en.label) && /Go to the destination/.test(en.groups[0]) && en.steps === 'Phrases and destination|Preparing|Confirm|Sending', JSON.stringify(en));
  const sEn = await snd();
  check('som em inglês: nome e título do botão traduzidos; trocar de idioma não toca o fim de novo', sEn.name === 'Notification sounds' && sEn.title === 'Sounds on: click to mute' && sEn.played.fim === 1, JSON.stringify(sEn));
  await shot('fx-8-en-claro.png');
  await shot('fx-9-celular.png', 390);
  await run(`LANG = 'pt'; applyTheme('dark'); rerender(); true`);

  // ---- "começar de novo" limpa as escolhas ----
  await run(`(() => { const real = window.fetch; window.fetch = async (u, o) => (u === '/api/nova-limpeza' ? new Response(JSON.stringify({ frases: [], holdings: [], busy: null, execResults: [], simResults: [], plan: null }), { status: 200 }) : real(u, o)); return true; })()`);
  await run(`startOver(); true`);
  await sleep(500);
  const z = await run(`({ section: ui.section, dec: ui.decisions.size, dirty: ui.dirty, dest: ui.dest.addr, addr: document.getElementById('destino').value })`);
  check('recomeçar tudo: volta às frases sem escolhas e sem "aplicar" pendente; o destino colado fica', z.section === 's-frase' && z.dec === 0 && !z.dirty && z.dest === DEST && z.addr === DEST, JSON.stringify(z));

  // ---- cenário "chaves" (Task 6 da fase 1 multirredes): chaves coladas, conferência e os dois avisos ----
  // Entrada: o cartão aceita a lista (texto com a forma de chave, gerado aqui e nunca enviado: só o selo é conferido)
  await run(`(() => { const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; const k = () => Array.from({ length: 88 }, () => A[Math.floor(Math.random() * 58)]).join(''); const ta = document.querySelector('#frases textarea'); ta.value = [k(), k(), k()].join('\\n'); ta.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(900);
  const k0 = await run(`({ label: document.getElementById('frases-label').textContent, badge: document.querySelector('#frases .fr .tag')?.textContent, bad: document.querySelector('#frases .fr').classList.contains('bad'), err: document.querySelector('#frases .fr-err')?.textContent })`);
  check('chaves: rótulo "frase ou chaves", 3 linhas de chave viram o selo "3 chaves", sem erro de frase', k0.label === 'Frase de recuperação ou chaves privadas (uma por linha)' && k0.badge === '3 chaves' && !k0.bad && k0.err === '', JSON.stringify(k0));
  await shot('fx-12-chaves-entrada.png');
  await run(`resetFrases(); true`);
  // estado inventado: um cartão de chaves com 3 carteiras, a Chave 2 com alerta de carteira de uso
  const KEYW = (i) => ({ ...wal(1, i), label: `Chave ${i + 1}`, address: addr('Key', i) });
  const kacc = (i, extra = {}) => ({ index: i, label: `Chave ${i + 1}`, address: addr('Key', i), hasHistory: true, lamports: i === 1 ? '80000000' : '5000000', isMain: false, warnings: [], ...extra });
  const chavesF = frase(1, { app: 'chaves', auto: false, main: null, keysOverlap: null, discovery: { found: 3, checked: 3, reachedMax: false }, wallets: [0, 1, 2].map(KEYW), holdings: [], review: { accounts: [kacc(0), kacc(1, { warnings: ['tem 0,0800 SOL solto: parece carteira de uso, não burner'] }), kacc(2)], warnings: [] } });
  const kBase = { ...base, frases: [chavesF], holdings: [] };
  const kPlan = { destination: DEST, frases: [{ ...planF(1, 'chaves', [planStep(0), planStep(2, 'sweep-sol')]), feePayer: addr('Key', 0) }] };
  const kPlanned = { ...kBase, plan: kPlan, confirm: { start: 4, end: 6 } };
  await run(`window.__state = ${JSON.stringify(kBase)}; window.__planView = ${JSON.stringify(kPlanned)}; ui.reviewed = new Set(); ui.protect = new Map(); ui.reviewTyped = new Map(); ui.cardErrors = {}; ui.goOn = false; ui.goOnIncomplete = false; beginAnalysis(1); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
  await ev('pronto', { tarefa: 'analise', estado: kBase });
  await sleep(600);
  // aviso visível: existe, não está em "detalhes", tem altura na tela e fica acima do campo da contagem
  const kRev = () => run(`(() => { const c = document.querySelector('#p-cards .rev[data-frase="1"]'); if (!c) return null; const n = c.querySelector('.notice:not(.danger)'); const inp = c.querySelector('#rev-n-1'); const r = n?.getBoundingClientRect(); return { phase: ui.prep.phase, title: c.querySelector('h3').textContent, notice: n?.textContent, noticeVisible: !!r && r.height > 0 && !n.closest('details') && getComputedStyle(n).display !== 'none', noticeAbove: !!r && r.bottom <= inp.getBoundingClientRect().top, noticeTop: c.children[1] === n, prot: [...c.querySelectorAll('.accounts input:checked')].map((x) => x.value), names: [...c.querySelectorAll('.acc-name')].map((x) => x.textContent), count: document.getElementById('rev-resumo-1')?.textContent, main: c.querySelectorAll('.account.main').length, money: /US\\$/.test(c.textContent) }; })()`);
  const kr = await kRev();
  check('chaves: conferência obrigatória com o título das chaves, a suspeita (Chave 2) já protegida, sem "Conta 1"', kr?.phase === 'pendente' && kr.title === 'Confira as carteiras das chaves' && kr.prot.join() === '1' && kr.names.join() === 'Chave 1,Chave 2,Chave 3' && kr.main === 0 && /^2\s*carteiras serão limpas\s*Ficam de fora: Chave 2$/.test(kr.count) && !kr.money, JSON.stringify(kr));
  check('chaves: aviso "Confira cada carteira marcada…" visível, amarelo, no topo do cartão e acima do campo da contagem', kr?.notice === 'Confira cada carteira marcada. Tudo o que estiver marcado será limpo: o SOL vai para o seu destino e as moedas sem valor são queimadas. Proteja qualquer carteira que você ainda usa.' && kr.noticeVisible && kr.noticeAbove && kr.noticeTop, JSON.stringify(kr));
  await shot('fx-13-chaves-conferir.png');
  await run(`LANG = 'en'; rerender(); true`);
  await sleep(400);
  const krEn = await kRev();
  check('chaves (inglês): título, aviso e nomes "Key N" traduzidos; a suspeita continua protegida', krEn?.title === 'Review the wallets of your keys' && krEn.notice === 'Check every selected wallet. Everything selected will be cleaned: SOL goes to your destination and worthless coins are burned. Protect any wallet you still use.' && krEn.noticeVisible && krEn.noticeAbove && krEn.names.join() === 'Key 1,Key 2,Key 3' && krEn.prot.join() === '1' && /^2\s*wallets will be cleaned\s*Left out: Key 2$/.test(krEn.count), JSON.stringify(krEn));
  await shot('fx-13-chaves-conferir-en.png');
  await run(`LANG = 'pt'; rerender(); true`);
  await sleep(300);
  // a contagem confirma: plano pedido com a Chave 2 protegida (número como na tela) e a contagem 2
  await run(`document.getElementById('rev-n-1').value = '2'; [...document.querySelectorAll('#p-cards button')].find((b) => b.textContent === 'Continuar').click(); true`);
  await sleep(900);
  const kSent = await run(`window.__sent.filter((x) => x.u === '/api/plano').at(-1)?.body`);
  check('chaves: a contagem confirma e o plano vai com a suspeita protegida (Chave 2) sem a pessoa tocar', JSON.stringify(kSent?.porFrase) === '{"1":{"protegidas":[2],"contasConfirmadas":2}}' && kSent?.destino === DEST, JSON.stringify(kSent));
  // Confirmar: o aviso de queimar acima do botão de enviar
  const kRc = rcpt(1, 'chaves', 'Chave 1', [], [tk('Chave 1', 'MEME', '98000000', 0.004)]);
  const kSim = { ...kPlanned, simResults: [{ frase: 1, status: 'simulado', step: step(0), walletIndex: 0, destinationDelta: '2976880' }], receipt: { frases: [{ ...kRc, receipt: { ...kRc.receipt, feePayerLabel: 'Chave 1' } }], totalLamports: '127976880', feeEstimateLamports: '15000', appFeeLamports: '14000000', destination: DEST, failedCount: 0, burnedCount: 1, keptCount: 0 } };
  await ev('pronto', { tarefa: 'simulacao', estado: kSim });
  await sleep(700);
  const kConf = () => run(`(() => { const n = document.getElementById('c-checkburn'); const b = document.getElementById('b-executar'); const r = n.getBoundingClientRect(); return { section: ui.section, notice: n.textContent, cls: n.className, inBox: n.parentElement.id === 'c-box', visible: r.height > 0 && !n.closest('details') && getComputedStyle(n).display !== 'none' && !document.getElementById('c-box').classList.contains('hidden'), above: r.bottom <= b.getBoundingClientRect().top, next: !!n.nextElementSibling?.contains(b), phantom: document.getElementById('c-phantom').textContent }; })()`);
  const kc = await kConf();
  check('chaves: Confirmar com "Antes de enviar, confira…" amarelo, visível, logo acima do botão de enviar', kc.section === 's-confirmar' && kc.notice === 'Antes de enviar, confira o que vai ser queimado e o que vai ser enviado. Queimar não tem volta.' && kc.cls === 'notice' && kc.inBox && kc.visible && kc.above && kc.next, JSON.stringify(kc));
  check('chaves: a Confirmar resume as carteiras das chaves (limpas e protegidas)', /Carteiras das chaves: serão limpas Chave 1, Chave 3 · protegidas: Chave 2/.test(kc.phantom), kc.phantom);
  const kNull = await run(`(() => { const out = []; const w = document.createTreeWalker(document.getElementById('s-confirmar'), NodeFilter.SHOW_TEXT); while (w.nextNode()) if (/null|undefined|NaN/.test(w.currentNode.textContent)) out.push(w.currentNode.parentElement.outerHTML.slice(0, 300)); return out; })()`);
  check('chaves: nenhum "null", "undefined" ou "NaN" na Confirmar', kNull.length === 0, JSON.stringify(kNull));
  await shot('fx-14-chaves-confirmar.png');
  await run(`LANG = 'en'; rerender(); true`);
  await sleep(400);
  const kcEn = await kConf();
  check('chaves (inglês): "Before sending, check…" acima do botão; resumo com "Key N"', kcEn.notice === "Before sending, check what will be burned and what will be sent. Burning can't be undone." && kcEn.visible && kcEn.above && /Wallets of your keys: Key 1, Key 3 will be cleaned · protected: Key 2/.test(kcEn.phantom), JSON.stringify(kcEn));
  await shot('fx-14-chaves-confirmar-en.png');
  await run(`LANG = 'pt'; rerender(); true`);
  check('sem erro de JS na página', jsErrors.length === 0, jsErrors.join(' | ').slice(0, 300));
} finally {
  await closeEdge();
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} checagens`);
process.exit(ok === results.length ? 0 : 1);
