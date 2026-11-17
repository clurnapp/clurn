// Contra-teste da auditoria de 16/11/2026 (código público da 1.0, estatísticas do proxy, painel do autor).
// Desliga cada regra (troca exata no código), roda os testes da regra, exige que algum caia e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-auditoria.cjs [filtro do nome]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const PUB = ['test/publico.test.ts'];
const PROXY = ['test/proxy/stats.test.ts', 'test/proxy/cotas.test.ts', 'test/proxy/worker.test.ts', 'test/proxy/rodizio.test.ts'];
const PAINEL = ['test/painel/painel.test.ts'];
const PC = 'scripts/publicar-codigo.ts';
const W = 'proxy/worker.ts';
const C = 'proxy/cotas.ts';
const M = 'scripts/painel/metricas.ts';
const R = [
  ['lista BIP39 só com \\n', 'src/core/carteiras/bip39.ts', 'const list = text.split(/\\r?\\n/)', "const list = text.split('\\n')", ['test/carteiras/bip39.test.ts']],
  ['.gitattributes fora do público', PC, "'.gitignore', '.gitattributes', ", "'.gitignore', ", PUB],
  ['lista privada vai para o público', PC, "export const EXCLUDED = ['scripts/servir-site.mjs', FORBIDDEN_FILE];", "export const EXCLUDED = ['scripts/servir-site.mjs'];", PUB],
  ['exporta sem a lista privada', PC, '  if (!forbidden.size) throw new Error(`Lista de palavras proibidas ausente ou vazia (${FORBIDDEN_FILE}): não dá para conferir o que vai ser publicado.`);', '', PUB],
  ['exporta a pasta de trabalho', PC, 'const content = new Map(files.map((f) => [f, committed(root, f)]));', 'const content = new Map(files.map((f) => [f, fs.readFileSync(path.join(root, f))]));', PUB],
  ['hash proibido não é achado', PC, 'else if (forbidden.size && (line.match', 'else if (false && (line.match', PUB],
  ['stats sem conferir o token', W, '  if (!(await sameSecret(auth, token))) return notFound();', '', PROXY],
  ['stats com token curto', W, 'token.length < MIN_STATS_TOKEN || ', '', PROXY],
  ['stats aceita POST', W, "request.method !== 'GET' || ", '', PROXY],
  ['recusa não conta', C, 'this.stats.recusas[reason]++;', '', PROXY],
  ['IPs distintos de hoje', C, 'ips: this.stats.dia === this.day ? this.perIp.size : 0', 'ips: 0', PROXY],
  ['histórico some no apagão do dia', C, 'for (const [d, h] of this.counter.history) entries[HIST_PREFIX + d] = h;', '', PROXY],
  ['histórico sem limite', C, 'for (const d of days.slice(0, Math.max(0, days.length - HISTORY_DAYS))) this.history.delete(d);', '', PROXY],
  ['versões sem limite', C, 'bump(s.versoes, r.version, r.requests, MAX_VERSIONS)', 'bump(s.versoes, r.version, r.requests, 1e9)', PROXY],
  ['método fora do formato conta', C, 'if (METHOD_NAME.test(m) && isCountValue(n)) bump', 'if (isCountValue(n)) bump', PROXY],
  ['evento: Helius fora do ar', W, "if (!fallback) await recordEvent(env, 'upstream-fora', t);", '', PROXY],
  ['evento: todas sem crédito', W, "await recordEvent(env, 'sem-chave', t);", '', PROXY],
  ['evento: chave pausada', W, "await recordEvent(env, 'chave-pausada', t);", '', PROXY],
  ['depósito vira limpeza', M, 'txs.filter((x) => x.fee > 0 && x.dest).sort', 'txs.filter((x) => x.fee > 0).sort', PAINEL],
  ['destino guardado em claro', M, 'dest: fee > 0 && best >= 0 ? shortHash(keys[best] as string) : null', 'dest: fee > 0 && best >= 0 ? (keys[best] as string) : null', PAINEL],
  ['transação com erro conta', M, "if (!t?.meta || t.meta.err || typeof t.blockTime !== 'number') return null;", "if (!t?.meta || typeof t.blockTime !== 'number') return null;", PAINEL],
  ['alerta: todas as chaves sem crédito', M, 'if (p.chaves.length && paused.length === p.chaves.length) crit(', 'if (false) crit(', PAINEL],
  ['alerta: atualização quebrada', M, "if (a.health.atualizacao.kind === 'error') crit(", 'if (false) crit(', PAINEL],
  ['alerta: versão velha', M, 'if (old >= 30) warn(', 'if (false) warn(', PAINEL],
  ['painel aceita outro Host', 'scripts/painel-admin.ts', "if (req.headers.host !== `127.0.0.1:${port}` || req.method !== 'GET')", "if (req.method !== 'GET')", PAINEL],
  // suporte no Telegram e clurn-versao.json no empacotamento (16/11/2026)
  ['cartão de erro sem o suporte', 'src/app/ui/index.html', '  const help = SUPPORT_CODES.has(code) ? supportBlock() : null;', '  const help = null;', ['test/app/ui-suporte.test.ts']],
  ['suporte sem o aviso contra golpe', 'src/app/ui/index.html', "supportLink(), el('p', { class: 'support-safe' }, t('support.safe'))", 'supportLink()', ['test/app/ui-suporte.test.ts']],
  ['erro "unknown" sem o botão', 'src/app/ui/index.html', "'token-rejected', 'unknown']);", "'token-rejected']);", ['test/app/ui-suporte.test.ts']],
  ['atalho do topo sem endereço', 'src/app/ui/index.html', "document.getElementById('support-top')?.setAttribute('href', SUPPORT_URL);", '', ['test/app/ui-suporte.test.ts']],
  ['janela abre qualquer t.me', 'desktop/regras.ts', "if (u.hostname === 't.me') return u.pathname.replace(/\\/$/, '') === '/clurnapp' && u.search === '' && u.hash === '';", "if (u.hostname === 't.me') return true;", ['test/desktop/desktop.test.ts']],
  ['janela sem o t.me', 'desktop/regras.ts', "if (u.hostname === 't.me') return", "if (false) return", ['test/desktop/desktop.test.ts']],
  ['empacotar sem apagar o manifesto velho', 'scripts/chave-atualizacao.ts', "  if (!keyFile) {\n    fs.rmSync(out, { force: true });", '  if (!keyFile) {', ['test/app/chave-atualizacao.test.ts']],
  ['empacotar com chave dentro do repositório', 'scripts/chave-atualizacao.ts', "  if (inside(keyFile, repoRoot)) throw new Error('A chave privada não pode ficar dentro do repositório. Nada foi assinado.');", '', ['test/app/chave-atualizacao.test.ts']],
  ['empacotar sem gravar o manifesto', 'scripts/chave-atualizacao.ts', "  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\\n');\n  // relê", '  // relê', ['test/app/chave-atualizacao.test.ts']],
  ['painel sem o código da abertura', 'scripts/painel-admin.ts', 'if (url.pathname === `/${code}`) {', 'if (url.pathname.endsWith(code) || url.pathname === "/") {', PAINEL],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let bad = 0;
let ran = 0;
for (const [name, file, before, after, tests] of R) {
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
    res = spawnSync(process.execPath, ['--test', ...tests], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
