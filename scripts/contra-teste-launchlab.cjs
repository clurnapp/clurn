// Contra-teste da coleta do Raydium LaunchLab: desliga cada regra nova (troca exata no código), roda a suíte INTEIRA
// (o mesmo glob do npm test), exige que algum teste caia, e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-launchlab.cjs [prefixo, ex.: L12]
const fs = require('fs');
const { spawnSync } = require('child_process');
const LL = 'src/core/limpeza/launchlab.ts', S = 'src/core/limpeza/scan.ts', P = 'src/core/limpeza/plan.ts', X = 'src/core/limpeza/executor.ts';
const I = 'src/core/solana/instructions.ts', E = 'src/core/limpeza/errors.ts', RC = 'src/app/receipt.ts', V = 'src/app/server.ts', U = 'src/app/ui/index.html', ETA = 'src/app/eta.ts';
const rules = [
  // leitura
  ['L1 cofre = PDA [criador, moeda] (ordem das sementes)', LL, 'findProgramAddress([decodeBase58(creator), decodeBase58(quoteMint)]', 'findProgramAddress([decodeBase58(quoteMint), decodeBase58(creator)]'],
  ['L2 cofre: dono tem que ser o programa de token', LL, "  if (!programs.includes(a.owner)) throw new Error('cofre do LaunchLab com dono inesperado');\n", ''],
  ['L3 cofre: tamanho', LL, "  if (d.length < TOKEN_ACCOUNT_BYTES || (a.owner === PROGRAMS.token && d.length !== TOKEN_ACCOUNT_BYTES)) throw new Error('cofre do LaunchLab com tamanho inesperado');\n", '  if (d.length < 109) throw new Error("curto");\n'],
  ['L4 cofre: mint', LL, "  if (encodeBase58(d.subarray(0, 32)) !== quoteMint) throw new Error('cofre do LaunchLab de outra moeda');\n", ''],
  ['L5 cofre: authority', LL, "  if (encodeBase58(d.subarray(32, 64)) !== LAUNCHLAB_FEE_VAULT_AUTH) throw new Error('cofre do LaunchLab com outra authority');\n", ''],
  ['L6 cofre: estado Initialized', LL, "  if (d[108] !== 1) throw new Error('cofre do LaunchLab congelado ou não inicializado'); // 1 = Initialized\n", ''],
  ['L7 resposta sem a lista do tamanho pedido', LL, "  if (!Array.isArray(r?.value) || r.value.length !== keys.length) throw new Error('getMultipleAccounts (LaunchLab): resposta fora do formato');", "  if (!Array.isArray(r?.value)) return { vault: keys[0], lamports: 0n, other: 0 };"],
  ['L8 fee em outra moeda conta no aviso', LL, '    if (amount !== null && amount > 0n) other++;', ''],
  ['L9 releitura sem a lista vira erro', LL, "  if (!Array.isArray(r?.value) || r.value.length !== 1) throw new Error('getMultipleAccounts (LaunchLab): resposta fora do formato');\n  return parseLaunchlabVault(r.value[0], WSOL_MINT);", '  return parseLaunchlabVault(r?.value?.[0] ?? null, WSOL_MINT);'],
  ['L10 authority fixa = PDA', LL, "export const LAUNCHLAB_FEE_VAULT_AUTH = '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan';", "export const LAUNCHLAB_FEE_VAULT_AUTH = '11111111111111111111111111111111';"],
  // scan
  ['L11 scan lê o LaunchLab', S, '      Object.assign(fees, { launchlab: await launchlabFees(rpc, wallet), launchlabError: null });', '      Object.assign(fees, { launchlabError: null });'],
  ['L12 falha de leitura vira "não sei", não some', S, "      Object.assign(fees, { launchlab: { vault: '', lamports: 0n, other: 0 }, launchlabError: e instanceof Error ? e.message : 'erro desconhecido' });", "      Object.assign(fees, { launchlab: { vault: '', lamports: 0n, other: 0 }, launchlabError: null });"],
  ['L13 total de creator fees soma o LaunchLab', S, ' + launchlabClaimLamports(f.launchlab);', ';'],
  ['L14 "não lida" lista o LaunchLab', S, '  if (f?.launchlabError) out.push(`fee do LaunchLab: ${f.launchlabError}`);\n', ''],
  // plano
  ['L15 plano: mínimo para coletar', P, '    if (launchlab > BigInt(MIN_CLAIM_LAMPORTS)) {', '    if (launchlab > 0n) {'],
  ['L16 plano: ATA WSOL sai do passo das contas', P, "      steps.push({ kind: 'claim-launchlab', walletIndex: s.index, wallet: s.address, estimateLamports: launchlab, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });\n      closedByClaim = associatedTokenAddress(s.address, WSOL_MINT, PROGRAMS.token);", "      steps.push({ kind: 'claim-launchlab', walletIndex: s.index, wallet: s.address, estimateLamports: launchlab, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });"],
  ['L17 plano: wsolClosedBefore', P, "estimateLamports: launchlab, ...(closedByClaim ? { wsolClosedBefore: true } : {}) });", 'estimateLamports: launchlab });'],
  ['L18 plano: reserva empresta a ATA WSOL', P, '      loan(tokenRent); // a pagadora paga a ATA WSOL (se faltar) e recebe de volta na mesma transação', ''],
  // executor
  ['L19 executor: releitura do cofre', X, "        if (!vaultNow) return closeOnly('o LaunchLab não tem fee para coletar agora');", ''],
  ['L20 executor: releitura fora do formato é falha só do LaunchLab', X, "          throw new LaunchlabProbeFailed(`releitura do cofre: ${e instanceof Error ? e.message : 'erro desconhecido'}`);", "          throw e;"],
  ['L21 executor: medida que falha desliga o LaunchLab', X, '        if (e instanceof LaunchlabProbeFailed) launchlabDisabled = true;\n', ''],
  ['L22 executor: cancela as próximas', X, "    if (launchlabDisabled && step.kind === 'claim-launchlab') {", "    if (false) {"],
  ['L23 executor: recusa na simulação final desliga', X, "          if (step.kind === 'claim-dbc') dbcDisabled = true;\n          if (step.kind === 'claim-launchlab') launchlabDisabled = true;\n          record({ step, description, status: 'falhou', detail: `simulação falhou", "          if (step.kind === 'claim-dbc') dbcDisabled = true;\n          record({ step, description, status: 'falhou', detail: `simulação falhou"],
  ['L24 executor: recusa no envio desliga', X, "      if (step.kind === 'claim-launchlab') launchlabDisabled = true;\n      if (outcome === 'desconhecido') {", "      if (outcome === 'desconhecido') {"],
  ['L25 executor: medida que falha vira falha do LaunchLab (não derruba tudo)', X, '          if (e instanceof ProbeFailed) throw new LaunchlabProbeFailed(e.message);\n          throw e;\n        }\n        if (!Array.isArray(m)) return closeOnly(m.skip);\n        const claim = m[0] - (created ? tokenRent : ataBefore);\n        if (claim <= 0n) return closeOnly(\'o LaunchLab', '          throw e;\n        }\n        if (!Array.isArray(m)) return closeOnly(m.skip);\n        const claim = m[0] - (created ? tokenRent : ataBefore);\n        if (claim <= 0n) return closeOnly(\'o LaunchLab'],
  ['L26 executor: fee abaixo da taxa da rede não é coletada', X, "        if (claim <= BigInt(BASE_FEE_LAMPORTS * 2)) return closeOnly(`fee de ${claim} lamports é menor que a taxa da rede: não compensa coletar`);\n        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n        const out = split(recovered, step.wallet);\n        // pagadora: perde o que perdeu na medida, menos a ATA", "        const recovered = claim + (counts ? ataBefore : 0n);\n        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n        const out = split(recovered, step.wallet);\n        // pagadora: perde o que perdeu na medida, menos a ATA"],
  ['L27 executor: devolve à pagadora o aluguel da ATA', X, "        const refund = created && !isPayer ? [systemTransfer(step.wallet, feePayer.address, tokenRent)] : [];\n        const out = split(recovered, step.wallet);\n        // pagadora: perde o que perdeu na medida, menos a ATA", "        const refund: Instruction[] = [];\n        const out = split(recovered, step.wallet);\n        // pagadora: perde o que perdeu na medida, menos a ATA"],
  ['L28 executor: ATA WSOL antiga conta uma vez (closedRent)', X, "          minWalletDelta,\n          ...(counts ? { closedRent: ataBefore } : {}),\n        };\n      }\n      case 'tokens': {", "          minWalletDelta,\n        };\n      }\n      case 'tokens': {"],
  ['L29 executor: 89/11 na mesma transação', X, "          instructions: [prep, claimIx, tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...refund, ...out.instructions],", "          instructions: [prep, claimIx, tokenCloseAccount(PROGRAMS.token, ata, step.wallet, step.wallet), ...refund, systemTransfer(step.wallet, destination, recovered)],"],
  ['L30 executor: a pagadora cria a ATA antes', X, "          m = await probeClaim([prep, claimIx], [ata, feePayer.address], signersNow, false);", "          m = await probeClaim([claimIx], [ata, feePayer.address], signersNow, false);"],
  ['L31 executor: sem coleta, a ATA antiga ainda fecha', X, "        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como na Meteora).\n        const closeOnly = (why: string): Built | Skip => {\n          if (!counts) return { skip: why };", "        // O plano tira a ATA WSOL do passo das contas (este passo a fecha). Sem coleta, fecha mesmo assim (como na Meteora).\n        const closeOnly = (why: string): Built | Skip => {\n          if (true) return { skip: why };"],
  // instrução
  ['L32 instrução: o criador assina', I, '    keys: [\n      w(creator, true),\n      r(vaultAuthority),', '    keys: [\n      w(creator),\n      r(vaultAuthority),'],
  ['L33 instrução: recebe na ATA do criador', I, '      w(associatedTokenAddress(creator, quoteMint, PROGRAMS.token)),\n      r(quoteMint),', '      w(associatedTokenAddress(vault, quoteMint, PROGRAMS.token)),\n      r(quoteMint),'],
  // erros, recibo, servidor, tela, custo
  ['L34 erro da coleta no catálogo', E, "  if (ctx.stepKind === 'claim-launchlab') return make('launchlab-claim-failed');\n", ''],
  ['L35 recibo conta a coleta', RC, " || s.kind === 'claim-launchlab';", ';'],
  ['L36 servidor: estimado do passo', V, " || s.kind === 'claim-launchlab' ? s.estimateLamports : null,", ' ? s.estimateLamports : null,'],
  ['L37 servidor: contagem em outra moeda', V, '    launchlabOther: s.fees?.launchlab?.other ?? 0,', '    launchlabOther: 0,'],
  ['L38 servidor: falha de leitura', V, '    launchlabError: s.fees?.launchlabError ?? null,', '    launchlabError: null,'],
  ['L39 tela final mostra a coleta', U, "'claim-dbc', 'claim-launchlab'].includes(r.step?.kind)", "'claim-dbc'].includes(r.step?.kind)"],
  ['L40 "Passos testados" no grupo das coletas', U, " 'claim-launchlab': 'claims',", ''],
  ['L41 aviso de leitura que falhou', U, ' || w.dbcError || w.launchlabError).length;', ' || w.dbcError).length;'],
  ['L42 aviso de fee em outra moeda', U, "  if (launchlabOther) out.push(t('warn.launchlabOther', launchlabOther));", ''],
  ['L43 custo da análise', ETA, '  analysisReqPerWallet: 5.05,', '  analysisReqPerWallet: 4.05,'],
  ['L44 texto do passo (pt)', U, "    'stepd.claim-launchlab': (p) => `${p.who ?? `N=${p.n}`}: coletar creator fees do LaunchLab (bonk.fun e outros) (~${p.sol} SOL) e enviar ao destino`,\n", ''],
];
const only = process.argv[2];
let bad = 0;
for (const [name, file, from, to] of rules) {
  if (only && !name.startsWith(only + ' ')) continue;
  const orig = fs.readFileSync(file, 'utf8');
  const crlf = orig.includes('\r\n');
  const lf = orig.replace(/\r\n/g, '\n');
  const n = lf.split(from).length - 1;
  if (n !== 1) { console.log(`?? ${name}: trecho achado ${n}x`); bad++; continue; }
  const mutated = lf.replace(from, () => to);
  fs.writeFileSync(file, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
  let failed = 0;
  let names = [];
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4', '--test-reporter=tap', 'test/**/*.test.ts'], { encoding: 'utf8', timeout: 600000 });
    failed = Number(/^# fail (\d+)/m.exec(r.stdout ?? '')?.[1] ?? 0);
    names = [...(r.stdout ?? '').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1].slice(0, 70));
  } finally {
    fs.writeFileSync(file, orig);
  }
  console.log(`${failed > 0 ? 'ok' : 'FALTA TESTE'}  ${name}: ${failed} caíram${names.length ? ` (${names.join(' | ')})` : ''}`);
  if (!failed) bad++;
}
console.log(bad ? `\n${bad} regra(s) sem teste que caia` : '\ntodas as regras derrubam algum teste');
process.exit(bad ? 1 : 0);
