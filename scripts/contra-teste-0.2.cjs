// Contra-teste: desliga cada regra nova (troca exata no código), roda os testes ligados a ela, exige que algum
// caia, e restaura o arquivo. Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-0.2.cjs [prefixo, ex.: R12]
const fs = require('fs');
const { spawnSync } = require('child_process');
const X = 'src/core/limpeza/executor.ts', S = 'src/core/limpeza/scan.ts', R = 'src/core/solana/rpc.ts', V = 'src/app/server.ts', U = 'src/app/ui/index.html', RC = 'src/app/receipt.ts';
const T = { claim: 'test/limpeza/claim-visivel.test.ts', scan: 'test/limpeza/scan.test.ts', srv: 'test/app/frases-server.test.ts', ana: 'test/app/ui-analise.test.ts', fees: 'test/app/ui-fees.test.ts', dep: 'test/app/ui-deposito.test.ts', ent: 'test/app/ui-entrada.test.ts', i18n: 'test/app/ui-i18n.test.ts' };
const rules = [
  ['R1 RPC repete erro passageiro do nó', R, '|| TRANSIENT_RPC_CODES.has(e.code)', '', [T.scan]],
  ['R2 busca: resposta sem lista não é "sem histórico"', S, "  if (!Array.isArray(sigs)) throw new Error('getSignaturesForAddress: resposta fora do formato');\n  return sigs.length > 0;", '  return Array.isArray(sigs) && sigs.length > 0;', [T.scan]],
  ['R3 busca: lote que falhou é conferido de novo', S, 'const flags = await untilRead(() => Promise.all(derived.map((w) => hasHistory(rpc, w.address))), opts.sleep);', 'const flags = await Promise.all(derived.map((w) => hasHistory(rpc, w.address)));', [T.scan]],
  ['R4 tokens: resposta sem lista vira erro', S, "    if (!Array.isArray(res?.value)) throw new Error(`getTokenAccountsByOwner (${label}): resposta fora do formato`);\n    // chave", '    if (!Array.isArray(res?.value)) continue;\n    // chave', [T.scan]],
  ['R5 fee parada: getProgramAccounts sem lista vira erro', S, "  if (!Array.isArray(res)) throw new Error('getProgramAccounts: resposta fora do formato');", "  if (!Array.isArray(res)) return [];", [T.scan]],
  ['R6 mint da curva: sem lista vira erro', S, "    if (!Array.isArray(res?.value)) throw new Error('getTokenAccountsByOwner (mint da curva): resposta fora do formato');", '    if (!Array.isArray(res?.value)) continue;', [T.scan]],
  ['R7 fee dividida: sem lista vira erro', S, "  if (!Array.isArray(gpa)) throw new Error('getProgramAccounts (fee dividida): resposta fora do formato');\n  for (const a of gpa) {", '  for (const a of Array.isArray(gpa) ? gpa : []) {', [T.scan]],
  ['R8 leitura: incompletas são lidas de novo', S, '  return rereadIncomplete(rpc, results.sort((a, b) => a.index - b.index), opts, ro);', '  return results.sort((a, b) => a.index - b.index);', [T.scan, T.srv]],
  ['R9 fee parada/dividida/cashback contam como sem ler', S, "  if (f?.unsweptError) out.push(`fee parada nas moedas: ${f.unsweptError}`);", '', [T.scan]],
  ['R10 releitura fica com a melhor leitura', S, '      if (unreadParts(again).length <= unreadParts(s).length) out[i] = again;', '      out[i] = s;', [T.scan]],
  ['R11 tela: incompleta segura o plano', U, '  const incomplete = u.goOnIncomplete ? [] : incompleteOf(s);', '  const incomplete = [];', [T.ana]],
  ['R12 "Ler de novo" relê só as incompletas', V, "    if (f.status !== 'pronta' || !f.scans.some((s) => unreadParts(s).length)) continue;\n    touched.push(f);", "    if (true) continue;\n    touched.push(f);", [T.srv]],
  ['R13 sobra: poeira não conta', V, '    const sol = s.lamports >= LEFTOVER_MIN_LAMPORTS ? BigInt(s.lamports) : 0n;', '    const sol = BigInt(s.lamports);', [T.srv]],
  ['R14 "Limpar o que sobrou" abre rodada nova', V, "  Object.assign(S, { simResults: [], execResults: [], executed: false,", "  Object.assign(S, { simResults: [], execResults: [], executed: true,", [T.srv]],
  ['R15 conferência começa sozinha', U, "  if (tarefa === 'execucao') startLeftoverCheck(); // conferência: começa sozinha quando o envio acaba", '', [T.ana]],
  ['R16 recibo: depósito fora do SOL solto', RC, '      const deposit = s.isFeePayer ? min(exempt, gross) : 0n;', '      const deposit = 0n;', [T.fees]],
  ['R17 recibo: gasto sai primeiro do esquecido', RC, '    const depositCut = min(exempt, amount) - min(exempt, after);', '    const depositCut = 0n;', [T.fees]],
  ['R18 tela final compara com a confirmação', U, "  if (diff === 0n) return { same: true };", "  return { same: true };", [T.fees]],
  ['R19 mesma precisão no envio', U, "el('b', {}, `${sol(lamportsOf(state.arrived))} SOL`)", "el('b', {}, `${sol(lamportsOf(state.arrived), 4)} SOL`)", [T.fees]],
  ['R20 destino: uma colagem basta', V, "  if (!isAddress(destino)) throw new BadRequest('O endereço de destino não é um endereço Solana válido.');", "  if (!isAddress(destino)) throw new BadRequest('O endereço de destino não é um endereço Solana válido.');\n  if (destino !== (typeof (body as { destino2?: unknown }).destino2 === 'string' ? ((body as { destino2: string }).destino2).trim() : '')) throw new BadRequest('Os dois endereços de destino não são iguais.');", [T.srv]],
  ['R21 destino fica em "Recomeçar"', U, '  // o destino fica (colado uma vez por sessão): o campo da entrada continua com ele, e ui.dest também\n', "  $('destino').value = '';\n", [T.i18n]],
  ['R22 depósito único: a central segura o plano até repassar', V, '      if (holdsForForward(f)) return false;', '', [T.srv]],
  ['R23 depósito único: valor = central + repasses + taxas', V, "  const lamports = hub.need.sendLamports + forwards.reduce((a, fw) => a + fw.lamports + FUND_TX_FEE_LAMPORTS, 0n);", "  const lamports = hub.need.sendLamports + forwards.reduce((a, fw) => a + fw.lamports, 0n);", [T.srv]],
  ['R24 depósito único: empréstimo desfaz o pedido', V, "    if (result.status === 'enviado') dropSingle();", '', [T.srv]],
  ['R25 depósito único: cartão na espera', U, "      cards.push(singleCard(state.single, canSkip ? el('button', { class: 'btn quiet', type: 'button', onclick: simulateWithout }, t('plan.partialGo', { list: waitingFrases(state) })) : null));", '', [T.dep]],
  ['R26 "Voltar" só com o que mudar', U, "  return fs.some((f) => f.status === 'erro') ||", "  return true ||", [T.ana]],
  ['R27 depósito único: pedido concluído é refeito quando uma frase volta a esperar', V, "  if (cur && (cur.status === 'repassando' || cur.status === 'falhou')) return undefined;", "  if (cur && cur.status !== 'esperando') return undefined;", [T.srv]],
  ['R28 plano de teste usa as escolhas recomendadas (tester)', V, 'destination: trialDestination(f), decisions, rentExemptZero: S.rentExemptZero, walletName: walletName(f.app)', 'destination: trialDestination(f), rentExemptZero: S.rentExemptZero, walletName: walletName(f.app)', [T.srv]],
  ['R29 moeda à espera de decisão não é "Nada para limpar"', V, "!f.scans.some((s) => s.errors.length) && !f.holdings.length && scans.length === f.scans.length));", "!f.scans.some((s) => s.errors.length) && scans.length === f.scans.length));", [T.srv]],
  ['R30 só "manter": a pessoa escolhe na Confirmar', U, "if (e.codigo !== 'no-fee-sol' && onlyKeptLeft(state, decisionOf)) {", "if (false) {", [T.ana]],
  ['R31 leitura e simulação nunca antes do último passo confirmado', X, '      if (slot <= 0 || !SLOT_BOUND.has(method)) return rpc.call<T>(method, params);', '      if (true) return rpc.call<T>(method, params);', [T.claim]],
  ['R32 conferência da simulação relê com espera antes de parar', X, 'export const SIM_CHECK_WAITS_MS = [0, 1_000, 2_000, 4_000, 8_000];', 'export const SIM_CHECK_WAITS_MS = [0, 0];', [T.claim]],
];
const only = process.argv[2];
let bad = 0;
for (const [name, file, from, to, tests] of rules) {
  if (only && !name.startsWith(only)) continue;
  const orig = fs.readFileSync(file, 'utf8');
  const crlf = orig.includes('\r\n');
  const lf = orig.replace(/\r\n/g, '\n');
  const n = lf.split(from).length - 1;
  if (n !== 1) { console.log(`?? ${name}: trecho achado ${n}x`); bad++; continue; }
  const mutated = lf.replace(from, () => to);
  fs.writeFileSync(file, crlf ? mutated.replace(/\n/g, '\r\n') : mutated);
  let failed = 0;
  try {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], { encoding: 'utf8', timeout: 300000 });
    failed = Number(/^# fail (\d+)/m.exec(r.stdout ?? '')?.[1] ?? 0);
  } finally {
    fs.writeFileSync(file, orig);
  }
  console.log(`${failed > 0 ? 'ok' : 'FALTA TESTE'}  ${name}: ${failed} caíram`);
  if (!failed) bad++;
}
process.exit(bad ? 1 : 0);
