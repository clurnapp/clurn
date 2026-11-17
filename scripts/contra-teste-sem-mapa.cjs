// Contra-teste da Confirmar sem o mapa do dinheiro (0.3.0): valor por carteira e por passo só depois do envio.
// Desliga cada regra (troca exata no código), roda os testes, exige que algum caia e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-sem-mapa.cjs [filtro do nome]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const R = [
  ['valor de volta na tabela', 'src/app/ui/index.html', "el('td', {}, el('span', { class: 'addr' }, short(w.address)), copyButton(w.address)),", "el('td', {}, el('span', { class: 'addr' }, short(w.address)), copyButton(w.address)), el('td', { class: 'num' }, sol(w.creatorFees)),"],
  ['simulação pronta passo a passo', 'src/app/ui/index.html', "ui.prep.phase = 'pronto'; renderSimSummary();", "ui.prep.phase = 'pronto'; renderResults('sim-lista', ui.sim.items);"],
  ['ao vivo passo a passo', 'src/app/ui/index.html', "if (r.modo === 'simulate') renderSimSummary(); else $('x-lista').prepend(resultItem(r));", "(r.modo === 'simulate' ? $('sim-lista') : $('x-lista')).prepend(resultItem(r));"],
  ['falhou conta no resumo', 'src/app/ui/index.html', "if (r.status !== 'simulado') { apart.push(r); continue; }", "if (r.status !== 'simulado') { apart.push(r); }"],
  ['carteira sem dedupe', 'src/app/ui/index.html', "if (Number.isInteger(w)) g.wallets.add(w);", "if (Number.isInteger(w)) g.wallets.add(g.tx);"],
  ['contas não somadas', 'src/app/ui/index.html', "if (key === 'tokens') g.accounts +=", "if (key === 'x') g.accounts +="],
  ['dado sujo nas contas', 'src/app/ui/index.html', "(Number.isInteger(r.step?.[k]) && r.step[k] > 0 ? r.step[k] : 0)", "(Number(r.step?.[k]) || 0)"],
  ['coleta dividida fora das coletas', 'src/app/ui/index.html', "'claim-shared': 'claims', ", ""],
  ['tipo herdado vira grupo', 'src/app/ui/index.html', "Object.hasOwn(STEP_GROUP, r.step?.kind) ? STEP_GROUP[r.step.kind] : 'other'", "STEP_GROUP[r.step?.kind] ?? 'other'"],
  ['sem a linha do trabalho', 'src/app/ui/index.html', "v.steps > 1 ? el('p', { class: 'hint', id: 'c-trabalho' }, t('conf.work', { steps: v.steps })) : null,", "null,"],
  ['sem o aviso da tela final', 'src/app/ui/index.html', '<p class="hint" data-i18n="conf.stepsHint">O valor e o link de cada transação aparecem na tela final, depois do envio.</p>', ''],
  ['ordem dos não enviados', 'src/app/ui/index.html', "...newestFirst(v.apart).map((r) => resultItem(r))", "...v.apart.map((r) => resultItem(r))"],
  ['valor no texto do resumo', 'src/app/ui/index.html', "'sum.sol': (p) => `Enviar o SOL ao destino: ${p.wallets}", "'sum.sol': (p) => `Enviar o SOL ao destino (~0,5 SOL): ${p.wallets}"],
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
    res = spawnSync(process.execPath, ['--test', 'test/app/ui-sem-mapa.test.ts', 'test/app/ui-i18n.test.ts', 'test/app/ui-resumo.test.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
