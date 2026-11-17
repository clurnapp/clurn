// Creator fees que existem e não estão no total: a tela Confirmar avisa, inclusive na tela "Nada para limpar".
// Achado de 31/10/2026: a fee parada que o app não conseguiu ler e a coleta pulada por fee sharing não apareciam em
// lugar nenhum (a primeira só numa coluna da tabela fechada; a segunda, em lugar nenhum).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnSource } from './ui-source.ts';

type Node = { tag: string; kids: unknown[] };
const el = (tag: string, _attrs: unknown, ...kids: unknown[]): Node => ({ tag, kids });
const text = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? (n as Node).kids.map(text).join('') : '');
const t = (key: string, v?: unknown) => `${key}(${String(v)})`;
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6);
const lamportsOf = (v: unknown) => (typeof v === 'bigint' ? v : BigInt((v as string | number | undefined) ?? 0));
const feeNotices: (s: unknown, v: unknown) => Node[] = new Function('el', 't', 'sol', 'lamportsOf', `${fnSource('feeNotices')}; return feeNotices;`)(el, t, sol, lamportsOf);

const wallet = (over: Record<string, unknown> = {}) => ({ unswept: '0', unsweptError: null, sharedOther: 0, sharedError: null, otherQuote: 0, ...over });

test('avisos de fee: parada que o app não coleta, leitura que falhou e fee sharing, cada um com a contagem', () => {
  const s = { frases: [{ wallets: [wallet({ unswept: '2500000' }), wallet({ unsweptError: 'getProgramAccounts pelo RPC público: HTTP 429' })] }, { wallets: [wallet({ unsweptError: 'x' })] }] };
  const out = feeNotices(s, { feeSharing: 3 }).map(text);
  assert.deepEqual(out, ['warn.unswept(0.002500)', 'warn.feeReadFailed(2)', 'warn.feeSharing(3)']);
});

test('avisos de fee: nada a avisar não gera aviso; estado sem frases não quebra', () => {
  assert.deepEqual(feeNotices({ frases: [{ wallets: [wallet()] }] }, { feeSharing: 0 }), []);
  assert.deepEqual(feeNotices(null, null), []);
});

test('"Nada para limpar" também mostra os avisos de fee (a frase vazia pode ter fee que o app não leu)', () => {
  const src = fnSource('renderConfirm');
  const empty = src.slice(src.indexOf('if (sv.allEmpty)'), src.indexOf('return;', src.indexOf('if (sv.allEmpty)')));
  assert.match(empty, /\$\('c-avisos'\)\.replaceChildren\(\.\.\.feeNotices\(s, v\)\)/);
  assert.match(src.slice(src.indexOf('return;')), /avisos\.push\(\.\.\.feeNotices\(s, v\)\)/, 'e a tela normal também');
});

// achado de 31/10/2026 (autoclarn-c7, e2e na devnet): as linhas de "Encontrado" não somavam o total (solto e creator
// fees líquidos, aluguel bruto, e a tela ainda descontava taxa de rede e taxa do app)
test('Encontrado: as linhas com SOL somam o total; a taxa de rede não é subtraída (já saiu do SOL solto)', async () => {
  const { buildReceipt, mergeReceipts } = await import('../../src/app/receipt.ts');
  const { appFeeFor } = await import('../../src/core/limpeza/app-fee.ts');
  const confirmView = new Function('lamportsOf', 'countOf', 'planStepCount', `${fnSource('confirmView')}; return confirmView;`)(lamportsOf, (n: number) => (Number.isFinite(n) ? n : 0), () => 0);
  const foundLines = new Function(`${fnSource('foundLines')}; return foundLines;`)();
  const W = 'So11111111111111111111111111111111111111112';
  const DEST = '95xmVS2X7UpPp5Gm6iQeU35CF5wosLHM1U9dsNuXAQ74';
  const plan = (steps: unknown[], exempt?: bigint) => ({ destination: DEST, feePayerIndex: 0, feePayer: W, steps, kept: [], skipped: [], reserveNeededLamports: 0n, appFee: appFeeFor(DEST), payerExemptLamports: exempt });
  const st = (kind: string, i: number, extra: object = {}) => ({ kind, walletIndex: i, wallet: W, estimateLamports: 1n, actions: [{ action: 'close', account: W, mint: W, program: W, amount: 0n, decimals: 0, rentLamports: 2_039_280 }], ...extra });
  const sim = (step: unknown, dest: bigint, fee: bigint, extra: object = {}) => ({ step, description: 'x', status: 'simulado', destinationDelta: dest, appFeeDelta: fee, ...extra });
  const payer = st('sweep-sol', 0, { isFeePayer: true });
  const cases = [
    // temporária com SOL, contas fechadas, coleta da curva e do PumpSwap (com ATA antiga), pagadora com gasto
    [sim(st('sweep-sol', 1), 890_000n, 110_000n, { payerCostLamports: 10_000n }), sim(st('tokens', 1), 1_814_960n, 224_320n, { payerCostLamports: 10_000n }), sim(st('claim-curve', 2), 445_000n, 55_000n, { payerCostLamports: 10_000n }), sim(st('claim-amm', 2), 3_150_000n, 389_280n, { closedRentLamports: 2_039_280n, payerCostLamports: 1_500_000n }), sim(payer, 8_900_000n, 1_100_000n)],
    // pagadora com depósito isento
    [sim(st('sweep-sol', 1), 890_000n, 110_000n, { payerCostLamports: 10_000n }), sim(payer, 9_890_000n, 1_100_000n)],
  ];
  for (const [i, sims] of cases.entries()) {
    const p = plan(sims.map((x) => x.step), i === 1 ? 1_000_000n : undefined);
    const r = mergeReceipts([{ frase: 1, app: 'solflare', receipt: buildReceipt({ plan: p as never, simResults: sims as never, holdings: [], main: null }) }]);
    const v = confirmView({ receipt: r, holdings: [], plan: { frases: [] } }, () => 'keep');
    const lines = foundLines(v) as Array<{ key: string; lamports: bigint }>;
    assert.equal(lines.reduce((a, x) => a + x.lamports, 0n), v.total, `caso ${i}: ${lines.map((x) => `${x.key}=${x.lamports}`).join(' ')} ≠ total ${v.total}`);
    assert.ok(!lines.some((x) => x.key === 'conf.netFee'), 'taxa de rede só informativa');
    assert.ok(v.netFee > 0n);
  }
});

test('tela final: cada creator fee coletada aparece com valor e link; varrer, coleta pulada, falha e simulação não', () => {
  const claimRows = new Function('lamportsOf', `${fnSource('claimRows')}; return claimRows;`)(lamportsOf);
  const r = (kind: string, status: string, extra: Record<string, unknown> = {}) => ({ frase: 1, walletIndex: 3, status, step: { kind, sweepOnly: false }, destinationDelta: '890000', appFeeDelta: '110000', link: 'https://solscan.io/tx/x', ...extra });
  const rows = claimRows([
    r('claim-curve', 'enviado'),
    r('claim-amm', 'enviado', { walletIndex: 4, destinationDelta: '89', appFeeDelta: '11' }),
    r('claim-amm', 'enviado', { walletIndex: 5, destinationDelta: '2814960', appFeeDelta: '224320', closedRentLamports: '2039280' }),
    r('claim-shared', 'enviado', { walletIndex: 6 }),
    r('claim-amm', 'enviado', { step: { kind: 'claim-amm', sweepOnly: true } }),
    r('claim-amm', 'enviado', { skippedClaim: true }),
    r('claim-curve', 'falhou'),
    r('claim-curve', 'simulado'),
    r('sweep-sol', 'enviado'),
    // conta de cashback fechada: com cashback junto aparece (só o cashback); só com o aluguel, não
    r('close-uva', 'enviado', { walletIndex: 7, destinationDelta: '1554118', appFeeDelta: '192082', closedRentLamports: '1346200' }),
    r('close-uva', 'enviado', { walletIndex: 8, destinationDelta: '1198118', appFeeDelta: '148082', closedRentLamports: '1346200' }),
  ]);
  assert.deepEqual(rows, [
    { frase: 1, walletIndex: 3, lamports: 1_000_000n, link: 'https://solscan.io/tx/x' },
    { frase: 1, walletIndex: 4, lamports: 100n, link: 'https://solscan.io/tx/x' },
    { frase: 1, walletIndex: 5, lamports: 1_000_000n, link: 'https://solscan.io/tx/x' }, // sem a ATA antiga (aluguel)
    { frase: 1, walletIndex: 6, lamports: 1_000_000n, link: 'https://solscan.io/tx/x' }, // parte numa fee dividida
    { frase: 1, walletIndex: 7, lamports: 400_000n, link: 'https://solscan.io/tx/x' }, // cashback coletado ao fechar
  ]);
  const fim = fnSource('renderExecFim');
  assert.match(fim, /claimRows\(rs\)/, 'a tela final usa claimRows');
  assert.match(fim, /receiptLines\(xv, 'exec\.arrived'\)/, 'e as linhas do recibo pós-execução');
});

test('Confirmar e tela final: total grande com a precisão da linha do total; tokens num bloco abaixo, fora da coluna em SOL', () => {
  const src = fnSource('renderConfirm');
  assert.doesNotMatch(src, /sol\(v\.total, 4\)/, 'total grande sem cortar casas');
  const totalLine = src.indexOf("receiptLines(v, 'conf.total')");
  const tokens = src.indexOf('...tokensSent');
  assert.ok(totalLine > 0 && tokens > totalLine, 'tokens depois da linha do total');
  assert.doesNotMatch(fnSource('renderExecFim'), /sol\(received, 4\)/);
});

test('valores: o depósito para as taxas volta numa linha própria, fora do encontrado e depois da taxa do app; as linhas somam o total', async () => {
  const { buildReceipt, mergeReceipts } = await import('../../src/app/receipt.ts');
  const { appFeeFor } = await import('../../src/core/limpeza/app-fee.ts');
  const confirmView = new Function('lamportsOf', 'countOf', 'planStepCount', `${fnSource('confirmView')}; return confirmView;`)(lamportsOf, (n: number) => (Number.isFinite(n) ? n : 0), () => 0);
  const foundLines = new Function(`${fnSource('foundLines')}; return foundLines;`)();
  const W = 'So11111111111111111111111111111111111111112';
  const DEST = '95xmVS2X7UpPp5Gm6iQeU35CF5wosLHM1U9dsNuXAQ74';
  const st = (kind: string, i: number, extra: object = {}) => ({ kind, walletIndex: i, wallet: W, estimateLamports: 1n, actions: [], ...extra });
  const sim = (step: unknown, dest: bigint, fee: bigint, extra: object = {}) => ({ step, description: 'x', status: 'simulado', destinationDelta: dest, appFeeDelta: fee, ...extra });
  // pagadora com 10 000 000 de depósito (isento) + 1 000 000 esquecidos (pagam 11%); outra temporária com 1 000 000
  const sims = [sim(st('sweep-sol', 1), 890_000n, 110_000n, { payerCostLamports: 20_000n }), sim(st('sweep-sol', 0, { isFeePayer: true }), 10_890_000n, 110_000n)];
  const plan = { destination: DEST, feePayerIndex: 0, feePayer: W, steps: sims.map((x) => x.step), kept: [], skipped: [], reserveNeededLamports: 0n, appFee: appFeeFor(DEST), payerExemptLamports: 10_000_000n };
  const rc = buildReceipt({ plan: plan as never, simResults: sims as never, holdings: [], main: null });
  assert.equal(rc.toDestination.depositLamports, 10_000_000n, 'o depósito volta inteiro: o gasto de 20 000 sai do SOL esquecido');
  assert.equal(rc.toDestination.looseSolLamports, 1_000_000n + 1_000_000n - 20_000n, 'o SOL solto é só o esquecido');
  const v = confirmView({ receipt: mergeReceipts([{ frase: 1, app: 'solflare', receipt: rc }]), holdings: [], plan: { frases: [] } }, () => 'keep');
  const lines = foundLines(v) as Array<{ key: string; lamports: bigint; deposit?: boolean }>;
  assert.deepEqual(lines.map((x) => x.key), ['conf.loose', 'conf.appFee', 'conf.deposit']);
  assert.equal(lines.reduce((a, x) => a + x.lamports, 0n), v.total);
  // gasto maior que o esquecido: o que passa come o depósito (nunca fica negativo)
  const big = [sim(st('sweep-sol', 0, { isFeePayer: true }), 9_890_000n, 110_000n, { payerCostLamports: 1_500_000n })];
  const rb = buildReceipt({ plan: { ...plan, steps: big.map((x) => x.step) } as never, simResults: big as never, holdings: [], main: null });
  assert.equal(rb.toDestination.looseSolLamports, 0n);
  assert.equal(rb.toDestination.depositLamports, 10_000_000n - 1_500_000n, 'pagadora só com o depósito: o gasto sai dele');
  assert.equal(rb.toDestination.looseSolLamports + rb.toDestination.depositLamports - rb.appFeeLamports, rb.totalLamports);
  // a tela: linhas na ordem encontrado → soma → taxa → depósito → total
  const order = fnSource('receiptLines');
  const at = (s: string) => order.indexOf(s);
  assert.ok(at("'conf.foundSum'") < at("'minus')") && at("'minus')") < at("'deposit')") && at("'deposit')") < at('line(t(totalKey)'), 'encontrado → soma → taxa → depósito → total');
});

test('valores: a tela final compara o que chegou com o que a confirmação mostrou e diz o motivo da diferença', () => {
  const sol = (l: bigint) => (Number(l) / 1e9).toFixed(6);
  const vs = new Function('t', 'sol', `${fnSource('arrivedVsShown')}; return arrivedVsShown;`)((k: string, p?: unknown) => `${k}(${JSON.stringify(p)})`, sol);
  assert.equal(vs(100n, null, 0, false), null, 'sem confirmação para comparar');
  assert.deepEqual(vs(100n, 100n, 0, false), { same: true });
  assert.match(vs(60n, 100n, 2, false).text, /exec\.vsConfirm.*"more":false.*exec\.why\.failed\(2\)/);
  assert.match(vs(60n, 100n, 0, true).text, /exec\.why\.aborted/);
  assert.match(vs(130n, 100n, 0, false).text, /"diff":"0\.000000".*"more":true.*exec\.why\.more/);
  assert.match(vs(90n, 100n, 0, false).text, /exec\.why\.less/);
  assert.match(fnSource('renderExecFim'), /arrivedVsShown\(received, state\.receipt \? lamportsOf\(state\.receipt\.totalLamports\) : null/);
});

test('avisos de fee dividida: leitura que falhou conta junto com a da fee parada; divisões fora da coleta têm a contagem', () => {
  const s = { frases: [{ wallets: [wallet({ sharedError: 'getProgramAccounts pelo RPC público: HTTP 429' }), wallet({ sharedOther: 2 }), wallet({ sharedOther: 1, unsweptError: 'x', sharedError: 'y' })] }] };
  assert.deepEqual(feeNotices(s, { feeSharing: 0 }).map(text), ['warn.feeReadFailed(2)', 'warn.sharedOther(3)']);
});

test('aviso de creator fee em moeda pareada em outro token, com a contagem de todas as carteiras', () => {
  const s = { frases: [{ wallets: [wallet({ otherQuote: 2 })] }, { wallets: [wallet({ otherQuote: 1 }), wallet()] }] };
  assert.deepEqual(feeNotices(s, { feeSharing: 0 }).map(text), ['warn.otherQuote(3)']);
});

// dois testers (01/11/2026): 390 carteiras e o total só com 128 contas; o resto estava em "manter", sem aparecer
test('Confirmar: aluguel das moedas sem valor conhecido em "manter" aparece fora do total, com o botão de queimar', () => {
  const confirmView = new Function('lamportsOf', 'countOf', 'planStepCount', `${fnSource('confirmView')}; return confirmView;`)(lamportsOf, (n: number) => (Number.isFinite(n) ? n : 0), () => 0);
  const h = (account: string, over: Record<string, unknown> = {}) => ({ account, kind: 'fungible', inBurnAll: true, rentLamports: 2_039_280, ...over });
  const holdings = [h('a'), h('b'), h('c', { rentLamports: 'x' }), h('nft', { kind: 'nft' }), h('usdc', { inBurnAll: false }), h('queimar')];
  const decide = (x: { account: string }) => (x.account === 'queimar' ? 'burn' : x.account === 'usdc' ? 'transfer' : 'keep');
  const v = confirmView({ holdings }, decide);
  assert.equal(v.unknownKept.length, 3);
  assert.equal(v.keptRent, 2n * 2_039_280n, 'só as em "manter" sem valor conhecido; aluguel fora do formato vale 0; NFT, enviar e queimar fora');
  assert.match(fnSource('renderConfirm'), /if \(v\.keptRent > 0n\) avisos\.push\(keptNotice\(v\)\)/);
  assert.match(fnSource('keptNotice'), /t\('dec\.burnAll', n\)/);
});

test('conta de token travada (congelada, Token-2022) aparece nos avisos do resumo com o motivo, não só nos detalhes', () => {
  const b = (reason: string) => ({ account: 'A', mint: 'M', reason });
  const s = { frases: [{ wallets: [wallet({ blocked: [b('conta congelada pelo emissor')] }), wallet()] }, { wallets: [wallet({ blocked: [b('conta congelada pelo emissor'), b('token não transferível')] })] }] };
  const seen: unknown[] = [];
  const tt = (key: string, v?: unknown) => (seen.push([key, v]), key);
  const out = new Function('el', 't', 'sol', 'lamportsOf', `${fnSource('feeNotices')}; return feeNotices;`)(el, tt, sol, lamportsOf)(s, null);
  assert.equal(out.length, 1);
  assert.deepEqual(seen, [['warn.blocked', { n: 3, reasons: 'conta congelada pelo emissor; token não transferível' }]]);
});

test('valores: mesma precisão (6 casas) na Confirmar, durante o envio ("Já chegou", linha de cada frase) e na tela final', () => {
  for (const fn of ['renderConfirm', 'renderExecFim', 'renderRun', 'runRowsView']) assert.doesNotMatch(fnSource(fn), /sol\([^()]*(\([^()]*\))?[^()]*, 4\)/, `${fn} sem cortar casas`);
});
