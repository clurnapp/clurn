// Modo Phantom no FLUXO NOVO (4 etapas), com estado inventado e fetch interceptado: nada é analisado nem enviado.
// Confere o que a página mostra no cartão "Confira as contas da Phantom" (tela "Preparando") e o que ela manda.
// Só usa o vetor público de teste do BIP39 ("legal winner…", sem fundos) e não imprime frase nenhuma.
// Uso: sh scripts/teste-tela/um-teste.sh cdp-phantom.mjs <pasta-prints>
import { openBrowser, sleep } from './cdp-devnet-lib.mjs';

const [url, outDir] = process.argv.slice(2);
const b = await openBrowser(url, outDir, 'ph');
const { run, check, shot, results, pageErrors, close } = b;
const PUBLIC_VECTOR = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

const addr = (tag, i) => `${tag}${String(i).padStart(4, '0')}KXtg2CW87d97TXJSDpbD5jBkheTqA83TZzzzzz`.slice(0, 44);
const DEST = '5aLz6u2X5vu4ftJguUvJt1pwjf7DftGosLAA3ZXKM4UN'; // endereço válido (base58); os inventados acima têm "0", que não existe em endereço Solana

await run(`(() => {
  window.__sent = [];
  const real = window.fetch;
  window.fetch = async (u, o) => {
    const body = o?.body ? JSON.parse(o.body) : null;
    window.__sent.push({ u, body });
    if (u === '/api/analisar') return new Response('{"erro":"teste: nada analisado"}', { status: 400 });
    if (u === '/api/plano') return new Response(JSON.stringify(window.__planReply ?? { erro: 'Confirme quantas contas serão limpas: são 3.\\nSegunda linha.' }), { status: window.__planReply ? 200 : 400 });
    if (u === '/api/estimativa') return new Response(JSON.stringify({ seconds: 600, credits: 1500, wallets: body.carteiras ?? 100 }), { status: 200 });
    if (u === '/api/estado') return new Response(JSON.stringify(window.__state), { status: 200 });
    if (u === '/api/creditos') return new Response('{"own":false}', { status: 200 });
    return real(u, o);
  };
  return true;
})()`);

// ---- 1. entrada: o cartão não pergunta o app; vai como 'auto' e o servidor descobre se é Phantom ----
await run(`(() => {
  const c = entry.cards[0];
  c.ta.value = ${JSON.stringify(PUBLIC_VECTOR)}; c.ta.dispatchEvent(new Event('input'));
  const a = document.getElementById('destino');
  a.value = ${JSON.stringify(DEST)}; a.dispatchEvent(new Event('input'));
  return true;
})()`);
await b.waitFor(`entry.cards[0].check.code === 'ok' && !document.getElementById('b-analisar').disabled`, 15000);
await run(`document.getElementById('b-analisar').click(); true`);
await sleep(800);
const a = await run(`window.__sent.find((s) => s.u === '/api/analisar')?.body ?? null`);
const noRadio = await run(`!document.querySelector('#frases input[type=radio]')`);
check("análise manda o cartão como 'auto' (só carteira e texto, sem RPC; o servidor descobre o app)", a?.frases?.length === 1 && a.frases[0].carteira === 'auto' && noRadio && !('rpc' in a), JSON.stringify(a && { carteiras: a.frases?.map((f) => f.carteira), chaves: Object.keys(a) }));
const e1 = await run(`document.getElementById('e-frase').textContent || document.getElementById('s-preparo').textContent`);
check('erro da análise aparece na tela', /teste: nada analisado/.test(e1), e1.slice(0, 80));
await shot('1-entrada');

// ---- estado inventado: uma frase Phantom pronta, 5 contas, a Conta 4 com alerta ----
const wal = (i) => ({ index: i, label: `Conta ${i + 1}`, address: addr('W1x', i), lamports: '5000000', closable: 2, closableRent: '2976880', creatorFees: '0', unswept: '0', blocked: [], errors: [] });
const acc = (i, extra = {}) => ({ index: i, label: `Conta ${i + 1}`, address: i === 0 ? addr('Main', 1) : addr('W1x', i), hasHistory: i !== 4, lamports: '5000000', isMain: i === 0, warnings: [], ...extra });
const totals = { recoverableLamports: '9000000', closable: 6, closableRentLamports: '8930640', creatorFeeLamports: '0', solLamports: '15000000', feeEstimateLamports: '30000' };
const frase = (n, app, over = {}) => ({ n, app, status: 'pronta', error: null, main: addr('Main', n), discovery: { found: 4, checked: 24, reachedMax: false }, wallets: [1, 2, 3, 4].map(wal), holdings: [], review: null, evm: null, totals, feeWarning: null, feeWait: null, planNotice: null, nothingToClean: false, tempoMs: 61000, ...over });
const review = { accounts: [acc(0), acc(1), acc(2), acc(3, { warnings: ['tem 0,1200 SOL solto: parece carteira de uso'] }), acc(4)], warnings: ['Conferir antes: alguma conta pode ser de uso no dia a dia.'] };
const base = (frases) => ({ busy: null, cluster: 'mainnet', rpc: 'api.mainnet-beta.solana.com (público, mais lento)', frases, holdings: [], totals, progress: null, pause: null, solUsd: 150, priceErrors: [], burnLocked: 0, pricesAvailable: true, confirm: null, plan: null, simResults: [], execResults: [], receipt: null, arrived: '0', arrivedAppFee: '0', aborted: null, abortedError: null, abortedFrase: null, reportFile: null, credits: { own: false, round: { requests: 0, credits: 0, byStage: {} } } });
const ev = (type, data) => run(`events.dispatchEvent(new MessageEvent(${JSON.stringify(type)}, { data: ${JSON.stringify(JSON.stringify(data))} })); true`);
const PH = base([frase(1, 'phantom', { review })]);

await run(`window.__state = ${JSON.stringify(PH)}; ui.dest = { addr: ${JSON.stringify(DEST)} }; beginAnalysis(1); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
await ev('pronto', { tarefa: 'analise', estado: PH });
await sleep(700);

// ---- 2. o cartão das contas ----
const r = await run(`(() => {
  const card = document.querySelector('#p-cards [data-frase="1"]');
  const rows = [...document.querySelectorAll('#rev-lista-1 li')];
  return {
    phase: ui.prep.phase, section: ui.section, visible: Boolean(card) && card.offsetParent !== null,
    title: card?.querySelector('h3')?.textContent ?? '',
    lede: card?.querySelector('.hint')?.textContent ?? '',
    rows: rows.map((li) => li.querySelector('.addr-name, strong, b')?.textContent ?? li.textContent.split(/\\s{2,}/)[0]),
    rowText: rows.map((li) => li.textContent),
    mainNoBox: rows[0] ? !rows[0].querySelector('input[type=checkbox]') && rows[0].classList.contains('main') : false,
    mainTag: rows[0]?.querySelector('.acc-state.main')?.textContent ?? null,
    keptRow: rows[3] ? rows[3].classList.contains('kept') && /Protegida/.test(rows[3].querySelector('.protect')?.textContent ?? '') : false,
    unused: rows[4]?.textContent ?? '',
    preChecked: [...document.querySelectorAll('#rev-lista-1 input:checked')].map((c) => c.value),
    resumo: document.getElementById('rev-resumo-1')?.textContent ?? '',
    text: card?.textContent ?? '',
  };
})()`);
check('pendência: fica na tela "Preparando" com o cartão "Confira as contas da Phantom"', r.phase === 'pendente' && r.section === 's-preparo' && r.visible && /Confira as contas da Phantom/.test(r.title), JSON.stringify({ phase: r.phase, section: r.section, title: r.title }));
check('5 contas em ordem, com o nome da Phantom ("Conta N")', r.rowText.length === 5 && r.rowText.every((t, i) => t.includes(`Conta ${i + 1}`)), r.rowText.map((t) => t.slice(0, 20)).join(' | '));
check('Conta 1: principal, sem caixa de proteger', r.mainNoBox && /^Principal$/.test(r.mainTag ?? ''), String(r.mainTag));
check('conta protegida: linha em destaque, escrito "Protegida"', r.keptRow);
check('conta nunca usada aparece marcada', /nunca usada/.test(r.unused), r.unused.slice(0, 60));
check('conta com alerta já vem protegida (só a Conta 4)', r.preChecked.join() === '3', r.preChecked.join());
check('resumo: 3 contas e o que fica de fora (a principal e a protegida)', /^3\s*contas serão limpas\s*Ficam de fora: Conta 1 \(principal\), Conta 4$/.test(r.resumo), r.resumo);
check('alerta da conta aparece no cartão', /parece carteira de uso/.test(r.text));
check('texto do cartão fala da Phantom e da Conta 1', /Conta 1 é a principal/.test(r.lede), r.lede.slice(0, 80));
await shot('2-contas');

// proteger a Conta 2
await run(`(() => { const c = document.querySelector('#rev-lista-1 input[value="1"]'); c.click(); return true; })()`);
await sleep(200);
const c1 = await run(`document.getElementById('rev-resumo-1').textContent`);
check('proteger a Conta 2: 2 contas, e ela entra no que fica de fora', /^2\s*contas serão limpas\s*Ficam de fora: Conta 1 \(principal\), Conta 2, Conta 4$/.test(c1), c1);

// inglês: mantém as protegidas e troca os nomes
await run(`(() => { const e = document.querySelector('input[name=idioma][value=en]'); e.checked = true; e.dispatchEvent(new Event('change')); return true; })()`);
// o redesenho vem num quadro de animação (requestAnimationFrame): com a máquina ocupada pode passar de 900 ms; espera o inglês
await b.waitFor(`/accounts? will be cleaned|No account will be cleaned/.test(document.getElementById('rev-resumo-1')?.textContent ?? '')`, 10000);
const en = await run(`({ checked: [...document.querySelectorAll('#rev-lista-1 input:checked')].map((c) => c.value).join(), resumo: document.getElementById('rev-resumo-1').textContent, title: document.querySelector('#p-cards [data-frase="1"] h3').textContent })`);
check('inglês: mantém as protegidas', en.checked === '1,3', en.checked);
check('inglês: "2 accounts will be cleaned / Left out: Account 1 (main), Account 2, Account 4"', /^2\s*accounts will be cleaned\s*Left out: Account 1 \(main\), Account 2, Account 4$/.test(en.resumo) && /Review your Phantom accounts/.test(en.title), en.resumo);
await shot('3-ingles');
await run(`(() => { const e = document.querySelector('input[name=idioma][value=pt]'); e.checked = true; e.dispatchEvent(new Event('change')); return true; })()`);
await b.waitFor(`/serão limpas|será limpa|Nenhuma conta/.test(document.getElementById('rev-resumo-1')?.textContent ?? '')`, 10000);

// todas protegidas
await run(`(() => { for (const v of ['2', '4']) document.querySelector('#rev-lista-1 input[value="' + v + '"]').click(); return true; })()`);
await sleep(200);
const zero = await run(`document.getElementById('rev-resumo-1').textContent`);
check('todas protegidas: diz que nenhuma será limpa (sem número, sem "null")', /^Nenhuma conta será limpa/.test(zero) && !/null/.test(zero), zero);
await run(`(() => { for (const v of ['2', '4']) document.querySelector('#rev-lista-1 input[value="' + v + '"]').click(); return true; })()`);
await sleep(200);

// contagem errada não passa; contagem certa pede o plano com as protegidas (números da Phantom) e a contagem
await run(`document.getElementById('rev-n-1').value = '3'; [...document.querySelectorAll('#p-cards button')].find((x) => x.textContent === 'Continuar').click(); true`);
await sleep(300);
const wrong = await run(`document.querySelector('#p-cards [data-frase="1"] [role=alert]')?.textContent ?? ''`);
check('contagem errada não passa (e nada é pedido)', /Não bate: serão limpas 2 contas/.test(wrong) && !(await run(`window.__sent.some((s) => s.u === '/api/plano')`)), wrong);
await run(`document.getElementById('rev-n-1').value = ' 2 '; [...document.querySelectorAll('#p-cards button')].find((x) => x.textContent === 'Continuar').click(); true`);
await sleep(1200);
const p1 = await run(`({ body: window.__sent.find((s) => s.u === '/api/plano')?.body ?? null, phase: ui.prep.phase, err: document.getElementById('s-preparo').textContent })`);
const pf = p1.body?.porFrase?.['1'];
check('plano manda as protegidas como na Phantom (Conta 2 = 2, Conta 4 = 4) e a contagem digitada (aparada)', JSON.stringify([...(pf?.protegidas ?? [])].sort()) === '[2,4]' && pf?.contasConfirmadas === 2 && Object.keys(p1.body.porFrase).join() === '1', JSON.stringify(p1.body?.porFrase));
check('plano manda o destino colado 1×', p1.body?.destino === DEST && !('destino2' in p1.body));
check('recusa do servidor aparece na tela da preparação', p1.phase === 'erro' && /Confirme quantas contas serão limpas/.test(p1.err), p1.phase);
await shot('4-recusa');

// ---- 2b. o caso do print do autor (03/11/2026): 61 contas. Uma linha por conta, ~10 à vista sem rolar a lista, o
// resumo com o que fica de fora (não a lista das 59), e a confirmação ANTES da lista ----
await run(`resetPage(); window.__sent = []; true`);
const BIG = { accounts: Array.from({ length: 61 }, (_, i) => acc(i, { lamports: i === 0 ? '41200000' : i === 39 ? '120000000' : '0', hasHistory: i < 50, warnings: i === 39 ? ['tem 0,1200 SOL solto: parece carteira de uso'] : [] })), warnings: [] };
const PH61 = base([frase(1, 'phantom', { review: BIG })]);
await run(`window.__state = ${JSON.stringify(PH61)}; ui.protect = new Map(); ui.reviewTyped = new Map(); ui.reviewed = new Set(); ui.dest = { addr: ${JSON.stringify(DEST)} }; beginAnalysis(1); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
await ev('pronto', { tarefa: 'analise', estado: PH61 });
await sleep(700);
const big = await run(`(() => {
  const card = document.querySelector('#p-cards [data-frase="1"]');
  const list = document.getElementById('rev-lista-1');
  const rows = [...list.querySelectorAll('li')];
  const box = list.getBoundingClientRect();
  return {
    rows: rows.length,
    visible: rows.filter((li) => { const r = li.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1; }).length,
    rowH: Math.round(rows[1].getBoundingClientRect().height),
    resumo: document.getElementById('rev-resumo-1').textContent,
    confirmAbove: document.getElementById('rev-n-1').getBoundingClientRect().bottom < box.top,
    noHScroll: card.scrollWidth <= card.clientWidth && list.scrollWidth <= list.clientWidth,
    addr40: rows[39].querySelector('.acc-addr').textContent, addr40Full: rows[39].querySelector('.acc-addr').title,
    bal: [rows[0].querySelector('.acc-bal').textContent, rows[1].querySelector('.acc-bal').textContent],
  };
})()`);
check('61 contas: uma linha por conta, baixa (≤ 46 px), ao menos 10 à vista sem rolar a lista', big.rows === 61 && big.rowH <= 46 && big.visible >= 10, JSON.stringify({ rows: big.rows, rowH: big.rowH, visible: big.visible }));
check('61 contas: resumo é o número e o que fica de fora, não a lista das 59', /^59\s*contas serão limpas\s*Ficam de fora: Conta 1 \(principal\), Conta 40$/.test(big.resumo), big.resumo);
check('61 contas: a confirmação vem antes da lista', big.confirmAbove);
check('61 contas: sem rolagem para o lado', big.noHScroll);
check('endereço curto como na Phantom, inteiro ao passar o mouse', /^.{4}….{4}$/.test(big.addr40) && big.addr40Full.length > 30, big.addr40);
check('saldo: com casas quando tem, "0 SOL" quando não', /^0,0412 SOL$/.test(big.bal[0]) && big.bal[1] === '0 SOL', big.bal.join(' | '));
await shot('2b-61-contas');
await run(`document.getElementById('rev-lista-1').scrollTop = 1400; true`);
await sleep(200);
await shot('2c-61-contas-rolada');

// ---- 3. Solflare: sem cartão de contas e sem nada da Phantom no pedido ----
await run(`resetPage(); window.__sent = []; true`);
const SF = base([frase(1, 'solflare', { wallets: [1, 2].map((i) => ({ ...wal(i), label: `N=${i}` })) })]);
await run(`window.__state = ${JSON.stringify(SF)}; window.__planReply = null; ui.dest = { addr: ${JSON.stringify(DEST)} }; beginAnalysis(1); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
await ev('pronto', { tarefa: 'analise', estado: SF });
await sleep(1200);
const sf = await run(`({ card: Boolean(document.getElementById('rev-lista-1')), body: window.__sent.find((s) => s.u === '/api/plano')?.body ?? null })`);
check('Solflare: sem cartão de contas da Phantom', !sf.card);
check('Solflare: plano pedido sozinho, sem protegidas nem contagem', sf.body && JSON.stringify(sf.body.porFrase) === '{}', JSON.stringify(sf.body?.porFrase));

// ---- 4. Phantom com as contas vazias: "Nada para limpar", sem cartão de contas e sem plano ----
await run(`resetPage(); window.__sent = []; true`);
const EMPTY = base([frase(1, 'phantom', { wallets: [], nothingToClean: true, review, totals: { ...totals, recoverableLamports: '0', closable: 0, closableRentLamports: '0', solLamports: '0' } })]);
await run(`window.__state = ${JSON.stringify(EMPTY)}; ui.dest = { addr: ${JSON.stringify(DEST)} }; beginAnalysis(1); ui.prep.phase = 'analise'; renderPrep(); show('s-preparo'); true`);
await ev('pronto', { tarefa: 'analise', estado: EMPTY });
await sleep(1000);
const nt = await run(`({ section: ui.section, text: document.getElementById('c-encontrado')?.textContent ?? '', card: Boolean(document.getElementById('rev-lista-1')), plan: window.__sent.some((s) => s.u === '/api/plano'), fee: /Falta SOL/.test(document.querySelector('main').innerText) })`);
check('contas vazias: "Nada para limpar" na confirmação, sem cartão de contas, sem plano, sem "Falta SOL"', nt.section === 's-confirmar' && /Nada para limpar/.test(nt.text) && !nt.card && !nt.plan && !nt.fee, JSON.stringify(nt).slice(0, 200));
await run(`(() => { const e = document.querySelector('input[name=idioma][value=en]'); e.checked = true; e.dispatchEvent(new Event('change')); return true; })()`);
await b.waitFor(`/Nothing to clean/.test(document.getElementById('c-encontrado')?.textContent ?? '')`, 10000);
const ntEn = await run(`document.getElementById('c-encontrado')?.textContent ?? ''`);
check('contas vazias (inglês): "Nothing to clean."', /Nothing to clean/.test(ntEn), ntEn.slice(0, 80));
await shot('5-vazia');
await run(`(() => { const e = document.querySelector('input[name=idioma][value=pt]'); e.checked = true; e.dispatchEvent(new Event('change')); return true; })()`);

check('nenhum erro de JavaScript', pageErrors.length === 0, pageErrors.join(' || '));
console.log(results.every(Boolean) ? `TUDO OK (${results.length})` : 'FALHOU');
await close(results.every(Boolean) ? 0 : 1);
