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
const DONO = ['test/painel/visao-dono.test.ts', 'test/painel/painel.test.ts'];
const LEITURA = ['test/painel/leitura.test.ts'];
const ADMIN = ['test/admin/leitor.test.ts', 'test/admin/worker.test.ts'];
const PC = 'scripts/publicar-codigo.ts';
const W = 'proxy/worker.ts';
const C = 'proxy/cotas.ts';
const M = 'scripts/painel/metricas.ts';
const LT = 'scripts/painel/ler-tx.ts';
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
  ['destino guardado em claro', LT, 'dest: fee > 0 && best >= 0 ? shortHash(keys[best] as string) : null', 'dest: fee > 0 && best >= 0 ? (keys[best] as string) : null', PAINEL],
  ['transação com erro conta', LT, "if (!t?.meta || t.meta.err || typeof t.blockTime !== 'number') return null;", "if (!t?.meta || typeof t.blockTime !== 'number') return null;", PAINEL],
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
  ['painel serve qualquer arquivo de assets/', 'scripts/painel-admin.ts', 'const asset = PANEL_ASSETS[name];', "const asset = name ? 'font/woff2' : undefined;", PAINEL],
  ['painel serve assets sem o código', 'scripts/painel-admin.ts', "url.pathname.startsWith(`/${code}/assets/`) ? url.pathname.slice(code.length + 9) : '';", 'path.basename(url.pathname);', PAINEL],
  ['painel sem font-src na CSP', 'scripts/painel-admin.ts', "style-src 'nonce-${nonce}'; font-src 'self';", "style-src 'nonce-${nonce}';", PAINEL],
  ['painel com fonte de CDN', 'scripts/painel/painel.html', 'src: url(/{{CODE}}/assets/inter.woff2)', 'src: url(https://fonts.gstatic.com/inter.woff2)', PAINEL],
  // painel: visão de dono (17/11/2026)
  ['dono: depósito ou destino ausente vira limpeza', M, "x.fee > 0 && typeof x.dest === 'string' && Number.isFinite(x.t)", 'x.fee > 0', DONO],
  ['dono: volume sem dividir pela taxa', M, 'return { receita, volume: receita / FEE_SHARE,', 'return { receita, volume: receita,', DONO],
  ['dono: todo cliente da janela é novo', M, '  for (const c of clients) if (first.get(c)! >= from) novos++;', '  for (const c of clients) novos++;', DONO],
  ['dono: janela anterior errada', M, 'windowNumbers(paid, first, now - 2 * days * DAY, from)', 'windowNumbers(paid, first, from, to)', DONO],
  ['dono: horário em UTC, não Brasília', M, 'const d = new Date(x.t + BRT_OFFSET);', 'const d = new Date(x.t);', DONO],
  ['dono: faixa sem tolerância', M, 'vol < e * (1 - 1e-9)', 'vol < e', DONO],
  ['dono: top 5 vira todos', M, 'ranked.slice(0, 5)', 'ranked.slice(0, 50)', DONO],
  ['dono: série corta o histórico antigo', M, 'const start = Math.min(today - (minDays - 1) * DAY', 'const start = Math.max(today - (minDays - 1) * DAY', DONO],
  ['dono: retorno do dia vira novo', M, '    for (const c of clients) if (utcDay(first.get(c)!) === dia) novos++;', '    for (const c of clients) novos++;', DONO],
  ['dono: semana começa no domingo', M, 'return d - ((new Date(d).getUTCDay() + 6) % 7) * DAY;', 'return d - new Date(d).getUTCDay() * DAY;', DONO],
  ['dono: projeção multiplica poucas horas', M, 'projecao: diasPassados >= 1 ?', 'projecao: diasPassados > 0 ?', DONO],
  ['dono: toda limpeza recente é "novo"', M, 'novo: firstSig.get(x.dest) === x.sig', 'novo: true', DONO],
  ['dono: conversão conta dia sem proxy', M, 'conversao: ips ? withProxy.reduce((a, s) => a + s.clientes, 0) / ips : null', 'conversao: ips ? serie.reduce((a, s) => a + s.clientes, 0) / ips : null', DONO],
  ['dono: preço sem faixa', M, "typeof v === 'number' && Number.isFinite(v) && v > 0.01 && v < 1e6", "typeof v === 'number' && v > 0", DONO],
  ['dono: alerta de queda desligado', M, 'w.receita < 0.5 * w.anterior.receita', 'false', DONO],
  ['dono: alerta de queda com base de poeira', M, 'w?.anterior && w.anterior.receita >= 0.05 && ', 'w?.anterior && w.anterior.receita > 0 && ', DONO],
  ['dono: demonstração com sorteio variável', 'scripts/painel/demo.ts', 'const r = rng(20261117);', 'const r = Math.random;', DONO],
  // painel: histórico com as carteiras antigas da taxa (17/11/2026)
  ['hist: carteira atual entra como antiga', M, ' || addr === current || ', ' || ', DONO],
  ['hist: sem data conta a vida toda da carteira', M, 'Number.isFinite(t) ? t : BETA_START', 'Number.isFinite(t) ? t : 0', DONO],
  ['hist: todo cliente da semana é novo', M, '    for (const c of clients) if (first.get(c)! >= s) novos++;', '    for (const c of clients) novos++;', DONO],
  ['hist: receita sem separar a carteira', M, 'porCarteira[x.w ?? 0]! += x.fee / LAMPORTS;', 'porCarteira[0]! += x.fee / LAMPORTS;', DONO],
  ['hist: falhas fora do período', M, 'falhas: failed.filter((f) => f.t >= s && f.t < e).length', 'falhas: failed.length', DONO],
  ['hist: sucesso sem as falhas', M, 'paid.length / (paid.length + failed.length)', 'paid.length / paid.length', DONO],
  ['leitura: para na 1ª conhecida mesmo com cache incompleto', 'scripts/painel-admin.ts', '        if (!fullPass) {', '        if (true) {', LEITURA],
  ['leitura: baixa o que é de antes da beta', 'scripts/painel-admin.ts', '      if (t !== null && t < since) {', '      if (false) {', LEITURA],
  ['leitura: o que o RPC não respondeu some', 'scripts/painel-admin.ts', "      } else retry.push(sig); // o RPC não deu: fica na fila para a próxima leitura", '      }', LEITURA],
  ['leitura: fila não é salva', 'scripts/painel-admin.ts', '  cache.pending = [...fresh, ...cache.pending];', '  cache.pending = [];', LEITURA],
  ['ativ: erro conta como sucesso', M, '    const m = s.ok ? ok : erro;', '    const m = ok;', DONO],
  ['ativ: total por carteira ignora a carteira', M, '    const w = s.w ?? 0;', '    const w = 0;', DONO],
  ['leitura: atividade sem as já lidas', 'scripts/painel-admin.ts', '        if (t !== null) newSeen.push([t, s.err ? 0 : 1]);\n        continue;', '        continue;', LEITURA],
  ['leitura: atividade duplica a cada abertura', 'scripts/painel-admin.ts', '  const seen: Array<[number, number]> = fullPass ? [] : cache.seen;', '  const seen: Array<[number, number]> = cache.seen;', LEITURA],
  ['leitura: falha sem a hora', 'scripts/painel-admin.ts', '        if (t !== null) cache.failed.push({ sig: s.signature, t });', '        if (false) cache.failed.push({ sig: s.signature, t });', LEITURA],
  // painel privado (admin/, 18/11/2026)
  ['admin: aceita JWT sem conferir a assinatura', 'admin/acesso.ts', '    if (!ok) return null;', '', ADMIN],
  ['admin: aceita JWT de outra equipe', 'admin/acesso.ts', "    if (claims?.iss !== `https://${team}.cloudflareaccess.com`) return null;", '', ADMIN],
  ['admin: aceita JWT de outra aplicação', 'admin/acesso.ts', '    if (!auds.includes(aud)) return null;', '', ADMIN],
  ['admin: aceita JWT vencido', 'admin/acesso.ts', "    if (typeof claims.exp !== 'number' || claims.exp < sec) return null;", '', ADMIN],
  ['admin: aceita JWT ainda não válido', 'admin/acesso.ts', "    if (typeof claims.nbf === 'number' && claims.nbf > sec + 60) return null;", '', ADMIN],
  ['admin: aceita qualquer e-mail', 'admin/acesso.ts', '    return email && allowed.includes(email) ? email : null;', "    return email || 'x';", ADMIN],
  ['admin: aceita alg diferente de RS256', 'admin/acesso.ts', "    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;", "    if (typeof header.kid !== 'string') return null;", ADMIN],
  ['admin: sem configuração, abre', 'admin/acesso.ts', '  if (!TEAM.test(team) || aud.length < 16 || !allowed.length) return null;', '', ADMIN],
  ['admin: chave do Access sem cache', 'admin/acesso.ts', '  if (!force && certs && certs.team === team && now - certs.at < CERTS_TTL_MS) return certs.keys;', '', ADMIN],
  ['admin: rota sem login', 'admin/worker.ts', '  if (!(await accessEmail(request, env, now(), (u) => doFetch(u)))) return notFound();', '', ADMIN],
  ['admin: aceita POST', 'admin/worker.ts', "  if (request.method !== 'GET') return notFound();\n  const path = new URL(request.url).pathname;\n  if (path === '/')", "  const path = new URL(request.url).pathname;\n  if (path === '/')", ADMIN],
  ['admin: arquivo fora da lista', 'admin/worker.ts', "  const asset = path.startsWith(`${BASE}/assets/`) ? path.slice(BASE.length + 8) : '';\n  if (ASSETS[asset]) return fromAssets(env.ASSETS, `/assets/${asset}`, ASSETS[asset]);", "  const asset = path.startsWith(`${BASE}/assets/`) ? path.slice(BASE.length + 8) : '';\n  if (asset) return fromAssets(env.ASSETS, `/assets/${asset}`, 'x');", ADMIN],
  ['admin: passo do leitor por GET', 'admin/worker.ts', "  if (path === '/passo' && request.method === 'POST') {", "  if (path === '/passo') {", ADMIN],
  ['admin: lê a blockchain sem o RPC do secret', 'admin/worker.ts', '    const url = env.RPC_URL?.trim() || PUBLIC_RPC;', '    const url = PUBLIC_RPC;', ADMIN],
  ['admin: carteiras antigas fora do secret', 'admin/worker.ts', "  return [{ endereco: APP_FEE_WALLET, desde: BETA_START }, ...parseWalletList(env.CARTEIRAS_ANTIGAS ?? '', APP_FEE_WALLET)];", '  return [{ endereco: APP_FEE_WALLET, desde: BETA_START }];', ADMIN],
  ['admin: leitor passa da data de início', 'admin/leitor.ts', '      if (t !== null && t < m.since) {', '      if (false) {', ADMIN],
  ['admin: leitor relê tudo a cada passo', 'admin/leitor.ts', '    const walk: Walk = m.walk ?? { before: null, until: m.newest, top: null };', '    const walk: Walk = m.walk ?? { before: null, until: null, top: null };', ADMIN],
  ['admin: leitor perde a página seguinte', 'admin/leitor.ts', '      walk.before = last;\n      m.walk = walk;', '      m.newest = walk.top ?? m.newest;\n      m.walk = null;', ADMIN],
  ['admin: 429 perde a fila', 'admin/leitor.ts', "        retry += take.slice(i).map((x) => `${x};`).join('');", '', ADMIN],
  ['admin: 429 conta tentativa', 'admin/leitor.ts', "        retry += take.slice(i).map((x) => `${x};`).join('');\n        break;", "        retry += take.slice(i).map((x) => `${x.split('~')[0]}~${MAX_TRIES};`).join('');\n        break;", ADMIN],
  ['admin: resposta vazia desiste na 1ª', 'admin/leitor.ts', '      } else if (tries + 1 < MAX_TRIES) retry += `${sig}~${tries + 1};`;', '      } else if (false) retry += `${sig}~${tries + 1};`;', ADMIN],
  ['admin: leitor sem teto por passo', 'admin/leitor.ts', '        budget -= n;', '', ADMIN],
  ['admin: pedaço da fila não é apagado', 'admin/leitor.ts', '      writes[key] = null; // pedaço esvaziado: apagado no fim (null = apagar)', '', ADMIN],
  ['admin: pedaço sem limite de tamanho', 'admin/leitor.ts', '        if (cur && cur.length >= this.chunk) {', '        if (false) {', ADMIN],
  ['admin: carteira trocada mantém o histórico', 'admin/leitor.ts', '        if (m && wipe) await this.wipe(w);', '', ADMIN],
  ['admin: gravação aceita destino em claro', 'scripts/painel/compacto.ts', '  if (x.dest !== null && !DEST.test(x.dest)) return null;', '', ADMIN],
  ['admin: leitura aceita item quebrado', 'scripts/painel/compacto.ts', "    if (dest !== '' && (dest === undefined || !DEST.test(dest))) continue;", '', ADMIN],
  ['admin: navegador conta o que é de antes da carteira', 'scripts/painel/remoto.ts', '    for (const t of decodeTxs(typeof x.tx === \'string\' ? x.tx : \'\', w)) if (t.t >= c.desde) txs.push(t);', '    for (const t of decodeTxs(typeof x.tx === \'string\' ? x.tx : \'\', w)) txs.push(t);', ADMIN],
  ['admin: navegador sem as falhas', 'scripts/painel/remoto.ts', '      if (!s.ok) failed.push({ t: s.t, w });', '', ADMIN],
  ['admin: preço sem o câmbio', 'scripts/painel/remoto.ts', '  return parsePrice({ solana: { usd, brl: usd * rate } });', '  return parsePrice({ solana: { usd, brl: usd } });', ADMIN],
  ['admin: câmbio fora da faixa aceito', 'scripts/painel/remoto.ts', "typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0.5 || rate > 100", "typeof rate !== 'number'", ADMIN],
  ['admin: leitor sem pausa com chave', 'admin/worker.ts', 'gapMs: env.RPC_URL?.trim() ? 120 : 300', 'gapMs: env.RPC_URL?.trim() ? 0 : 300', ADMIN],
  ['admin: leitor encadeia sem ter lido nada', 'admin/worker.ts', '  return r.lidas > 0 || r.listadas > 0 ? now + CHAIN_GAP_MS : null;', '  return now + CHAIN_GAP_MS;', ADMIN],
  ['admin: leitor nunca encadeia', 'admin/worker.ts', '  return r.lidas > 0 || r.listadas > 0 ? now + CHAIN_GAP_MS : null;', '  return null;', ADMIN],
  ['admin: créditos do Helius vazam a URL com a chave', 'admin/worker.ts', '({ nome: k.nome, app: k.app, ...(await', '({ nome: k.nome, app: k.app, url: k.url, ...(await', ADMIN],
  ['admin: chave do painel conta para o app', 'scripts/painel/remoto.ts', '  const app = rows.filter((r) => r.app && r.ok);', '  const app = rows.filter((r) => r.ok);', ADMIN],
  ['admin: linha de chave com campo a mais aceita', 'admin/worker.ts', 'if (extra !== undefined || !nome ||', 'if (!nome ||', ADMIN],
  ['admin: créditos com restantes em texto aceitos', 'scripts/painel/remoto.ts', "    const ok = r.status === 'ok' && n(r.restantes) !== null;", "    const ok = r.status === 'ok';", ADMIN],
  ['compartilhar: link do X com outro parâmetro aceito', 'desktop/regras.ts', "u.hash === '' && [...u.searchParams.keys()].join() === 'text' && ", "u.hash === '' && ", ['test/app/ui-compartilhar.test.ts']],
  ['compartilhar: qualquer caminho do x.com abre', 'desktop/regras.ts', "return u.pathname === '/intent/post' && u.hash", "return u.hash", ['test/app/ui-compartilhar.test.ts']],
  ['compartilhar: carteira repetida contada duas vezes', 'src/app/ui/index.html', "const wallets = new Set(sent.filter((r) => Number.isInteger(r.walletIndex)).map((r) => `${r.frase ?? 0}:${r.walletIndex}`)).size;", "const wallets = sent.length;", ['test/app/ui-compartilhar.test.ts']],
  ['compartilhar: valor negativo na imagem', 'src/app/ui/index.html', "return { lamports: lamports > 0n ? lamports : 0n, wallets, txs: sent.length };", "return { lamports, wallets, txs: sent.length };", ['test/app/ui-compartilhar.test.ts']],
  ['compartilhar: post sem marcar o @clurnapp', 'src/app/ui/index.html', "carteiras antigas'} com @clurnapp", "carteiras antigas'} com o app", ['test/app/ui-compartilhar.test.ts']],
  ['admin: navegador recebe import de Node', 'admin/gerar.ts', "throw new Error(`${name}: import que não roda no navegador: ${m[1]}`);", 'void 0;', ADMIN],
];
const only = process.argv[2] ? new RegExp(process.argv[2]) : null;
let bad = 0;
let ran = 0;
for (const [name, file, before, after, tests] of R) {
  if (only && !only.test(name)) continue;
  const p = path.join(ROOT, file);
  // clone do código público: o painel privado (admin/, test/admin/) não vem junto; essas regras não se aplicam
  if (tests.some((t) => !fs.existsSync(path.join(ROOT, t))) || !fs.existsSync(p)) {
    console.log(`FORA   ${name} (arquivo do painel privado ausente)`);
    continue;
  }
  ran++;
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
