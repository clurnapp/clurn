// Contra-teste da coleta da Meteora DBC (0.3.0): roda a suíte INTEIRA (o mesmo glob do npm test) a cada regra.
// Desliga cada regra (troca exata no código), roda os testes, exige que algum caia e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-dbc.cjs [filtro, ex.: "R1[0-9] "]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const R = [
  ['R1 scan chama dbcFees', 'src/core/limpeza/scan.ts', "Object.assign(fees, { dbc: await dbcFees(rpc, wallet), dbcError: null });", "Object.assign(fees, { dbcError: null });"],
  ["R2 total inclui Meteora", "src/core/limpeza/scan.ts", "cashbackLamports(f) + dbcClaimLamports(f.dbc) + ", "cashbackLamports(f) + "],
  ['R3 unreadParts com dbcError', 'src/core/limpeza/scan.ts', "if (f?.dbcError) out.push(`fee da Meteora: ${f.dbcError}`);", ""],
  ['R4 só quote WSOL', 'src/core/limpeza/dbc.ts', "const sol = quoteOf.get(p.config) === WSOL_MINT;", "const sol = true;"],
  ['R5 pool com transfer hook fora', 'src/core/limpeza/dbc.ts', "    if (p.hook) {", "    if (false) {"],
  ["R6 creator conferido na releitura", "src/core/limpeza/dbc.ts", "    if (p.creator !== wallet) return; // o creator é conferido de novo", "    if (false) return; // o creator é conferido de novo"],
  ['R7 gPA sem lista = erro', 'src/core/limpeza/dbc.ts', "if (!Array.isArray(gpa)) throw new Error('getProgramAccounts (Meteora): resposta fora do formato');", "if (!Array.isArray(gpa)) return { pools: [], found: 0, other: 0, cut: 0 };"],
  ['R8 config sem dado = erro', 'src/core/limpeza/dbc.ts', "if (!q) throw new Error('config da Meteora fora do formato');", "if (!q) return;"],
  ['R9 limite de pools por carteira', 'src/core/limpeza/dbc.ts', "const read = ranked.slice(0, DBC_MAX_FEE_POOLS);", "const read = ranked;"],
  ['R10 item de outro programa ignorado', 'src/core/limpeza/dbc.ts', "if (typeof a.account?.owner === 'string' && a.account.owner !== PROGRAMS.meteoraDbc) continue;", ""],
  ['R11 fee na moeda conta em other', 'src/core/limpeza/dbc.ts', "if (p.baseFee > 0n || (!sol && p.quoteFee > 0n)) out.other++;", "if (!sol && p.quoteFee > 0n) out.other++;"],
  ['R12 item com dado ruim = erro', 'src/core/limpeza/dbc.ts', "if (d.length !== DBC_FEE_SLICE.length) throw new Error('getProgramAccounts (Meteora): fee fora do formato');", "if (d.length !== DBC_FEE_SLICE.length) continue;"],
  ["R13 dono e discriminador na releitura", "src/core/limpeza/dbc.ts", "return accs.map((a) => (a && a.owner === PROGRAMS.meteoraDbc ? parseDbcPool(a.data) : null));", "return accs.map((a) => (a ? parseDbcPool(a.data) : null));"],
  ['R14 plano: ATA WSOL fora do passo tokens', 'src/core/limpeza/plan.ts', "        closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);\n        // a pagadora paga a ATA WSOL e a conta da moeda", "        // a pagadora paga a ATA WSOL e a conta da moeda"],
  ['R15 plano: wsolClosedBefore', 'src/core/limpeza/plan.ts', "pools, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });", "pools });"],
  ['R16 plano: empréstimo na reserva', 'src/core/limpeza/plan.ts', "        loan(tokenRent + pools.reduce((a, p) => a + (p.baseTokenProgram === PROGRAMS.token2022 ? token2022Rent : tokenRent), 0n));", ""],
  ['R17 plano: mínimo para coletar', 'src/core/limpeza/plan.ts', "if (dbcPools.reduce((a, p) => a + p.quoteFee, 0n) > BigInt(MIN_CLAIM_LAMPORTS)) {", "if (dbcPools.length) {"],
  ['R18 plano: lotes por transação', 'src/core/limpeza/plan.ts', "export const DBC_POOLS_PER_TX = 2;", "export const DBC_POOLS_PER_TX = 3;"],
  ['R19 exec: pool relido (creator)', 'src/core/limpeza/executor.ts', "return n !== null && !n.hook && n.creator === step.wallet &&", "return n !== null && !n.hook &&"],
  ['R20 exec: max_base = 0', 'src/core/limpeza/executor.ts', "            0n,\n            U64_MAX,\n          ),", "            U64_MAX,\n            U64_MAX,\n          ),"],
  ['R21 exec: token_a = conta da moeda', 'src/core/limpeza/executor.ts', "tokenA: baseAtas[i], tokenB: ata,", "tokenA: ata, tokenB: ata,"],
  ['R22 exec: cria a conta da moeda que falta', 'src/core/limpeza/executor.ts', "...live.flatMap((p, i) => (createBase[i] ? [ataCreateIdempotent(feePayer.address, step.wallet, p.baseMint, p.baseTokenProgram)] : [])),\n        ];", "        ];"],
  ['R23 exec: fecha a conta da moeda criada', 'src/core/limpeza/executor.ts', "...live.flatMap((p, i) => (createBase[i] ? [tokenCloseAccount(p.baseTokenProgram, baseAtas[i], feePayer.address, step.wallet)] : [])),", ""],
  ["R24 exec: ATA WSOL não conta duas vezes", "src/core/limpeza/executor.ts", "        const counts = !created && !step.wsolClosedBefore;\n        const signersNow = uniqueSigners([feePayer, owner]);\n        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como no PumpSwap).\n", "        const counts = !created;\n        const signersNow = uniqueSigners([feePayer, owner]);\n        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como no PumpSwap).\n"],
  ["R25 exec: sem coleta ainda fecha a ATA antiga", "src/core/limpeza/executor.ts", "        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como no PumpSwap).\n        const closeOnly = (why: string): Built | Skip => {\n          if (!counts) return { skip: why };", "        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como no PumpSwap).\n        const closeOnly = (why: string): Built | Skip => {\n          if (true) return { skip: why };"],
  ['R26 exec: fee menor que a taxa', 'src/core/limpeza/executor.ts', "if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return closeOnly(`fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar`);\n        // aluguel das contas da moeda", "// aluguel das contas da moeda"],
  ['R27 exec: cancela as próximas da Meteora', 'src/core/limpeza/executor.ts', "    if (dbcDisabled && step.kind === 'claim-dbc') {", "    if (false) {"],
  ['R28 exec: medida falha desliga a Meteora', 'src/core/limpeza/executor.ts', "        if (e instanceof DbcProbeFailed) dbcDisabled = true;", ""],
  ["R29 exec: devolve o aluguel da ATA WSOL", "src/core/limpeza/executor.ts", "          tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet),\n        ];\n        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n", "          tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet),\n        ];\n        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund: Instruction[] = [];\n"],
  ['R30 exec: divide o passo grande', 'src/core/limpeza/executor.ts', "&& step.kind === 'claim-dbc' && step.pools.length > 1) {", "&& step.kind === 'claim-dbc' && false) {"],
  ['R31 exec: 6050 não é fee sharing', 'src/core/limpeza/executor.ts', "[ata, feePayer.address, ...createdBase], signersNow, false);", "[ata, feePayer.address, ...createdBase], signersNow);"],
  ["R32 exec: 89/11 na coleta", "src/core/limpeza/executor.ts", "          tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet),\n        ];\n        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n        const out = split(recovered, step.wallet);\n", "          tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet),\n        ];\n        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n        const out = { toDest: recovered, fee: 0n, instructions: [systemTransfer(step.wallet, destination, recovered)] };\n"],
  ['R33 erro: código dbc-claim-failed', 'src/core/limpeza/errors.ts', "  if (ctx.stepKind === 'claim-dbc') return make('dbc-claim-failed');", ""],
  ["R34 recibo: claim-dbc é coleta", "src/app/receipt.ts", "s.kind === 'claim-cashback' || s.kind === 'claim-dbc' || s.kind === 'claim-launchlab';", "s.kind === 'claim-cashback' || s.kind === 'claim-launchlab';"],
  ['R35 servidor: contagem de pools', 'src/app/server.ts', "    pools: s.kind === 'claim-dbc' ? s.pools.length : 0,", "    pools: 0,"],
  ['R36 servidor: avisos da carteira', 'src/app/server.ts', "    dbcOther: s.fees?.dbc?.other ?? 0,", "    dbcOther: 0,"],
  ["R37 tela: grupo das coletas", "src/app/ui/index.html", "'close-uva': 'claims', 'claim-dbc': 'claims', 'claim-launchlab': 'claims',", "'close-uva': 'claims', 'claim-launchlab': 'claims',"],
  ["R38 tela: coleta na tela final", "src/app/ui/index.html", "'close-uva', 'claim-dbc', 'claim-launchlab'].includes(r.step?.kind)", "'close-uva', 'claim-launchlab'].includes(r.step?.kind)"],
  ['R39 tela: aviso de outra moeda', 'src/app/ui/index.html', "  if (dbcOther) out.push(t('warn.dbcOther', dbcOther));", ""],
  ['R40 tela: aviso do limite', 'src/app/ui/index.html', "  if (dbcCut) out.push(t('warn.dbcCut', dbcCut));", ""],
  ['R41 tela: leitura que falhou', 'src/app/ui/index.html', "wallets.filter((w) => w.unsweptError || w.sharedError || w.dbcError).length;", "wallets.filter((w) => w.unsweptError || w.sharedError).length;"],
  ['R42 tela: contagem no texto do passo', 'src/app/ui/index.html', "venue: s.venue, pools: s.pools });", "venue: s.venue });"],
  ['R43 eta: buscas por carteira', 'src/app/eta.ts', "i.customRpc ? (wallets * RUN_COSTS.gpaPerWallet) / RUN_COSTS.gpaRpsPublic : 0,", "i.customRpc ? wallets / RUN_COSTS.gpaRpsPublic : 0,"],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let bad = 0;
let ran = 0;
for (const [name, file, before, after] of R) {
  if (only && !only.test(name)) continue;
  ran++;
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  // arquivo com CRLF no Windows: a troca é feita em LF e gravada de volta como estava ("não achei" não é "passou")
  const lf = orig.replace(/\r\n/g, '\n');
  const n = lf.split(before).length - 1;
  if (n !== 1) {
    console.log(`TRECHO NÃO ACHADO (${n}×)  ${name}`);
    bad++;
    continue;
  }
  const changed = lf.replace(before, () => after);
  let res;
  try {
    fs.writeFileSync(p, orig.includes('\r\n') ? changed.replace(/\n/g, '\r\n') : changed);
    res = spawnSync(process.execPath, ['--test', '--test-concurrency=4', 'test/**/*.test.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } finally {
    fs.writeFileSync(p, orig);
  }
  const text = (res.stdout || '') + (res.stderr || '');
  const num = (re) => Number((re.exec(text) || [])[1] ?? 0);
  // sem a linha "ℹ tests" a suíte nem rodou: não conta como "caiu"
  const fail = /^ℹ tests \d+/m.test(text) ? num(/^ℹ fail (\d+)/m) + num(/^ℹ cancelled (\d+)/m) : -1;
  const first = [...text.matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).find((x) => x !== 'failing tests:') ?? '';
  if (fail > 0) console.log(`CAI    ${name} → ${first.slice(0, 110)}`);
  else {
    console.log(fail < 0 ? `A SUÍTE NÃO RODOU  ${name}` : `NÃO CAI (falta teste)  ${name}`);
    bad++;
  }
}
console.log(bad ? `\n${bad} de ${ran} regras sem teste que caia` : `\n${ran} regras, todas derrubam algum teste`);
process.exit(bad ? 1 : 0);
