// Contra-teste do proxy (proxy/) e do proxy no app: desliga cada regra (troca exata no código), roda os testes, exige
// que algum caia (falha ou teste cancelado por tempo) e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-proxy.mjs [filtro do nome]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(import.meta.dirname, '..');
const ONLY = process.argv[2] ? new RegExp(process.argv[2]) : null;
const TESTS = ['test/proxy/worker.test.ts', 'test/proxy/cotas.test.ts', 'test/proxy/rodizio.test.ts', 'test/app/rpc-padrao.test.ts', 'test/desktop/desktop.test.ts'];
const SERVER_TESTS = ['test/app/frases-server.test.ts'];
const M = [
  ['lista de métodos (objeto)', 'proxy/worker.ts', 'const forbidden = rpcItems.find((it) => !ALLOWED_METHODS.has(it.method));', 'const forbidden = undefined as RpcItem | undefined;'],
  ['lista de métodos (lote: só o 1º item)', 'proxy/worker.ts', 'const forbidden = rpcItems.find((it) => !ALLOWED_METHODS.has(it.method));', 'const forbidden = rpcItems.slice(0, 1).find((it) => !ALLOWED_METHODS.has(it.method));'],
  ['par app × proxy (método a mais)', 'proxy/worker.ts', "  'sendTransaction',\n", "  'sendTransaction',\n  'getBalance',\n"],
  ['corpo máximo (content-length)', 'proxy/worker.ts', 'if (Number.isFinite(declared) && declared > lim.maxBody)', 'if (false)'],
  ['corpo máximo (lendo)', 'proxy/worker.ts', 'if (size > max) {', 'if (false) {'],
  ['lote máximo', 'proxy/worker.ts', 'if (items.length > lim.maxBatch)', 'if (false)'],
  ['JSON inválido', 'proxy/worker.ts', "return rpcError(400, -32700, 'JSON inválido');", 'parsed = {};'],
  ['formato JSON-RPC', 'proxy/worker.ts', "return o.jsonrpc === '2.0' && typeof o.method === 'string' && idOk && paramsOk;", "return typeof o.method === 'string';"],
  ['só POST', 'proxy/worker.ts', "if (request.method !== 'POST')", 'if (false)'],
  ['content-type json', 'proxy/worker.ts', "if (!/^application\\/json\\b/i.test(request.headers.get('content-type') ?? ''))", 'if (false)'],
  ['cabeçalho de versão', 'proxy/worker.ts', 'if (!VERSION.test(version))', 'if (false)'],
  ['versão mínima', 'proxy/worker.ts', 'if (min && VERSION.test(min) && olderThan(version, min))', 'if (false)'],
  ['falha fechada sem contador', 'proxy/worker.ts', "if (!quota) return rpcError(503, -32603, 'contador de uso indisponível');\n  if (!quota.ok) {", 'if (quota && !quota.ok) {'],
  ['"max usage" na cota do dia', 'proxy/worker.ts', '`max usage reached: cota diária', '`cota diária'],
  ['Retry-After 1 no limite por segundo', 'proxy/worker.ts', "id, { 'retry-after': '1' });", 'id);'],
  ['prazo do upstream', 'proxy/worker.ts', '        signal: AbortSignal.timeout(lim.upstreamMs),\n', ''],
  ['erro do upstream sem a URL', 'proxy/worker.ts', "rpcError(502, -32603, 'o RPC está fora do ar', id)", 'rpcError(502, -32603, String(e), id)'],
  ['limpa a chave ecoada', 'proxy/worker.ts', 'const out = new Response(scrub(body, secrets), { status: res.status, headers });', 'const out = new Response(body, { status: res.status, headers });'],
  ['não repassa cabeçalhos do usuário', 'proxy/worker.ts', "        headers: { 'content-type': 'application/json' },\n        body: forward,", '        headers: request.headers,\n        body: forward,'],
  // revisão de segurança de 09/11/2026: o que vai ao upstream é o pedido reescrito do que foi conferido
  ['repassa o reescrito, não o texto (chave repetida)', 'proxy/worker.ts', 'const forward = JSON.stringify(batch ? rpcItems.map(forwardItem) : forwardItem(rpcItems[0]!));', 'const forward = text;'],
  ['reescrito só com as 4 chaves', 'proxy/worker.ts', "const forwardItem = (it: RpcItem) => ({\n  jsonrpc: '2.0',", "const forwardItem = (it: RpcItem) => ({\n  ...it,\n  jsonrpc: '2.0',"],
  ['params só lista', 'proxy/worker.ts', 'const paramsOk = o.params === undefined || Array.isArray(o.params);', "const paramsOk = o.params === undefined || (typeof o.params === 'object' && o.params !== null);"],
  ['id de texto curto', 'proxy/worker.ts', "(typeof o.id === 'string' && o.id.length <= 64)", "typeof o.id === 'string'"],
  ['número inexato recusado', 'proxy/worker.ts', 'if (inexact) return', 'if (false) return'],
  ['teto por hora sai do worker', 'proxy/worker.ts', '    globalHour: lim.globalHour,\n', '    globalHour: 1e12,\n'],
  ['"max usage" no teto por hora', 'proxy/worker.ts', "'max usage reached: limite por hora do proxy", "'limite por hora do proxy"],
  ['Retry-After até a hora seguinte', 'proxy/worker.ts', "id, { 'retry-after': String(secondsToNextUtcHour(t)) });", "id, { 'retry-after': String(secondsToUtcMidnight(t)) });"],
  ['cota por IP bem abaixo do teto', 'proxy/worker.ts', 'LIMITE_IP_DIA: 6_000,', 'LIMITE_IP_DIA: 60_000,'],
  ['teto por hora = dia/8', 'proxy/worker.ts', 'TETO_HORA_FRACAO: 8,', 'TETO_HORA_FRACAO: 1,'],
  ['teto por hora nunca zero', 'proxy/worker.ts', 'Math.max(1, Math.floor(globalDay / DEFAULTS.TETO_HORA_FRACAO))', 'Math.floor(globalDay / DEFAULTS.TETO_HORA_FRACAO)'],
  ['wrangler.toml igual ao código', 'proxy/wrangler.toml', 'TETO_HORA = "15000"', 'TETO_HORA = "120000"'],
  ['teto por hora', 'proxy/cotas.ts', "if (this.hourTotal + r.credits > r.globalHour) return this.refuse('teto-hora');", ''],
  ['hora nova zera', 'proxy/cotas.ts', '      this.hour = hour;\n      this.hourTotal = 0;', '      this.hour = hour;'],
  ['hora gravada e lida ao reiniciar', 'proxy/cotas.ts', 'this.counter.restore(day, isCount(total) ? total : 0, perIp, hourOk ? hour : -1, hourOk ? hourTotal : 0);', 'this.counter.restore(day, isCount(total) ? total : 0, perIp);'],
  ['hora suja no armazenamento', 'proxy/cotas.ts', 'const hourOk = isCount(hour) && isCount(hourTotal);', 'const hourOk = true;'],
  ['IPv6 pelo /48, não /64', 'proxy/cotas.ts', 'return groups.slice(0, 3)', 'return groups.slice(0, 4)'],
  ['não repassa cabeçalhos do upstream', 'proxy/worker.ts', "const headers: Record<string, string> = { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' };", 'const headers: Record<string, string> = Object.fromEntries(res.headers.entries());'],
  ['créditos do getProgramAccounts', 'proxy/worker.ts', '{ getProgramAccounts: 10 }', '{}'],
  ['limite por segundo', 'proxy/cotas.ts', "if (inWindow + r.requests > r.perSecond) return this.refuse('segundo');", ''],
  ['lote conta cada item', 'proxy/cotas.ts', 'this.seconds.set(r.key, { sec, n: inWindow + r.requests });', 'this.seconds.set(r.key, { sec, n: inWindow + 1 });'],
  ['cota diária por IP', 'proxy/cotas.ts', "if (used + r.credits > r.perIpDay) return this.refuse('dia-ip');", ''],
  ['teto diário global', 'proxy/cotas.ts', "if (this.total + r.credits > r.globalDay) return this.refuse('teto');", ''],
  ['dia novo zera', 'proxy/cotas.ts', '      this.day = day;\n      this.total = 0;\n      this.perIp = new Map();', '      this.day = day;'],
  ['IPv6 por prefixo', 'proxy/cotas.ts', "return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':') + '::/48';", 'return s;'],
  ['grava no alarme', 'proxy/cotas.ts', 'await this.storage.put(Object.fromEntries(list.slice(i, i + 128)));', ''],
  ['lê o gravado ao reiniciar', 'proxy/cotas.ts', 'this.counter.restore(day, isCount(total) ? total : 0, perIp, hourOk ? hour : -1, hourOk ? hourTotal : 0);', ''],
  ['dado sujo no armazenamento', 'proxy/cotas.ts', "if (k.startsWith('ip:') && isCount(v))", "if (k.startsWith('ip:'))"],
  ['dia novo apaga o anterior', 'proxy/cotas.ts', '      await this.storage.deleteAll();\n', ''],
  ['put em partes de 128', 'proxy/cotas.ts', 'i += 128) await this.storage.put(Object.fromEntries(list.slice(i, i + 128)));', 'i += 100000) await this.storage.put(Object.fromEntries(list));'],
  ['pedido ruim ao contador', 'proxy/cotas.ts', 'if (!validRequest(body)) return', 'if (false) return'],
  ['um alarme por vez', 'proxy/cotas.ts', '    if (this.alarmSet) return;\n    this.alarmSet = true;\n', '    this.alarmSet = true;\n'],
  ['app: createRpc manda os cabeçalhos', 'src/core/solana/rpc.ts', "headers: { ...options.headers, 'content-type': 'application/json' },", "headers: { 'content-type': 'application/json' },"],
  ['app: proxy primeiro', 'src/app/rpc-padrao.ts', '  if (proxy) out.push({ url: proxy, proxy: true });\n  for (let i = 0; i < 9; i++) {', '  for (let i = 0; i < 9; i++) {'],
  ['app: lê a marca de proxy', 'src/app/rpc-padrao.ts', 'if ((it as { proxy?: unknown }).proxy === true) out.push', 'if (false) out.push'],
  ['app: grava a marca de proxy', 'src/app/rpc-padrao.ts', 'return { url, proxy: true };', 'return { url };'],
  ['app: erro diz CLURN_PROXY_URL', 'src/app/rpc-padrao.ts', 'throw new Error(`${PROXY_ENV} precisa', "throw new Error(`${embeddedEnvName(0, 'url')} precisa"],
  ['app: chaves contam sem o proxy', 'src/app/rpc-padrao.ts', '    const i = key++;\n', '    const i = key++ + (entries[0]?.proxy ? 1 : 0);\n'],
  ['app: versão só para o proxy', 'src/app/rpc-padrao.ts', 'return embedded.some((e) => e.proxy && e.url === url) ? { [VERSION_HEADER]: version } : undefined;', 'return { [VERSION_HEADER]: version };'],
  ['app: versão no formato', 'src/app/rpc-padrao.ts', "return typeof v === 'string' && /^\\d{1,4}\\.\\d{1,4}\\.\\d{1,4}$/.test(v) ? v : '0.0.0';", "return typeof v === 'string' ? v : '0.0.0';"],
  ['servidor: põe o cabeçalho no proxy', 'src/app/server.ts', '    ...(headers ? { headers } : {}),\n', ''],
  ['empacotar: saída do proxy', 'scripts/empacotar.ts', 'if (e.proxy) return `  ${i + 1}. ${describeRpc(e.url.trim())}, proxy do Clurn (a chave fica no Worker, não no app)`;', ''],
  // 16/11/2026: rodízio das chaves (UPSTREAM_URLS), pausa da sem crédito, domínio oficial
  ['rodízio: pula a pausada', 'proxy/worker.ts', '    if (paused.has(ids[i]!)) continue;\n', ''],
  ['rodízio: sem crédito passa à seguinte', 'proxy/worker.ts', '    if (keyUnusable(res.status, body)) {\n', '    if (false) {\n'],
  ['rodízio: pausa a sem crédito', 'proxy/worker.ts', '        await pauseKey(env, ids[i]!, t + lim.pauseMs);\n', ''],
  // revisão de segurança: só pausa se a chave recusar também a consulta fixa (pedido montado não pausa todo mundo)
  ['sonda: só pausa a confirmada', 'proxy/worker.ts', "      if (probe === 'recusada') {\n        await pauseKey", '      {\n        await pauseKey'],
  ['sonda: recusa do pedido volta ao app', 'proxy/worker.ts', "      if (probe !== 'boa') continue;", '      continue;'],
  ['sonda: sem resposta não pausa', 'proxy/worker.ts', "  } catch {\n    return 'sem-resposta';\n  }", "  } catch {\n    return 'recusada';\n  }"],
  ['sonda: consulta fixa', 'proxy/worker.ts', 'body: PROBE_BODY, signal', "body: '{}', signal"],
  ['rodízio: 401/403 é chave recusada', 'proxy/worker.ts', 'status === 401 || status === 403 || ', ''],
  ['rodízio: "max usage" no 429', 'proxy/worker.ts', '(status === 429 && /max usage/i.test(body))', 'status === 429'],
  ['rodízio: 429 comum passa à seguinte', 'proxy/worker.ts', '      fallback = out; // limite', '      return out; // limite'],
  ['rodízio: falha de rede passa à seguinte', 'proxy/worker.ts', "      fallback ??= rpcError(502, -32603, 'o RPC está fora do ar', id);\n      continue;", "      return rpcError(502, -32603, 'o RPC está fora do ar', id);"],
  ['rodízio: tempo esgotado não soma prazos', 'proxy/worker.ts', '      if (timeout) {\n        await recordEvent', '      if (false) {\n        await recordEvent'],
  ['rodízio: todas sem crédito = "max usage"', 'proxy/worker.ts', "'max usage reached: as chaves do proxy", "'as chaves do proxy"],
  ['rodízio: limpa todas as chaves da resposta', 'proxy/worker.ts', 'const secrets = [...new Set(upstreams.flatMap(secretParts))]', 'const secrets = [...new Set(secretParts(upstreams[0]!))]'],
  ['rodízio: lista separada por linha/espaço/vírgula', 'proxy/worker.ts', '.split(/[\\s,]+/)) {', ".split('\\n')) {"],
  ['rodízio: só https', 'proxy/worker.ts', 'if (/^https:\\/\\/\\S+$/.test(s) && !out.includes(s))', 'if (s && !out.includes(s))'],
  ['rodízio: repetida conta uma vez', 'proxy/worker.ts', '&& !out.includes(s)) out.push(s);', ') out.push(s);'],
  ['rodízio: UPSTREAM_URL entra no fim', 'proxy/worker.ts', "\\n${env.UPSTREAM_URL ?? ''}", ''],
  ['rodízio: PAUSA_CHAVE_MIN', 'proxy/worker.ts', 'pauseMs: num(env.PAUSA_CHAVE_MIN, DEFAULTS.PAUSA_CHAVE_MIN) * 60_000,', 'pauseMs: DEFAULTS.PAUSA_CHAVE_MIN * 60_000,'],
  ['rodízio: contador fora do ar ao pausar não derruba', 'proxy/worker.ts', '  } catch {\n    // contador fora do ar: segue\n  }', '  } finally {\n  }'],
  ['rodízio: o contador devolve as pausadas', 'proxy/cotas.ts', 'return paused.length ? { ok: true, paused } : { ok: true };', 'return { ok: true };'],
  ['rodízio: pausa vence', 'proxy/cotas.ts', 'for (const [id, until] of this.paused) if (until <= now) this.paused.delete(id);', ''],
  ['rodízio: pausa gravada', 'proxy/cotas.ts', '      await this.storage.put({ [PAUSE_PREFIX + p.id]: p.until });\n', ''],
  ['rodízio: pausa lida ao reiniciar', 'proxy/cotas.ts', '      for (const [k, v] of all) if (k.startsWith(PAUSE_PREFIX) && isCount(v)) this.counter.pause(k.slice(PAUSE_PREFIX.length), v);\n', ''],
  ['rodízio: pausa regravada na virada do dia', 'proxy/cotas.ts', '      for (const [id, until] of this.counter.paused) entries[PAUSE_PREFIX + id] = until;\n', ''],
  ['rodízio: id da pausa no formato', 'proxy/cotas.ts', '!/^[0-9a-f]{16}$/.test(p.id) || ', ''],
  ['rodízio: teto de pausas guardadas', 'proxy/cotas.ts', 'if (!this.paused.has(id) && this.paused.size >= MAX_PAUSED) return;', ''],
  ['domínio oficial, sem workers.dev', 'proxy/wrangler.toml', 'workers_dev = false', 'workers_dev = true'],
  ['domínio rpc.clurn.app', 'proxy/wrangler.toml', 'routes = [{ pattern = "rpc.clurn.app", custom_domain = true }]\n', ''],
  ['limite novo no wrangler.toml', 'proxy/wrangler.toml', 'PAUSA_CHAVE_MIN = "60"', 'PAUSA_CHAVE_MIN = "5"'],
];

function run(files) {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=20000', ...files], { cwd: ROOT, encoding: 'utf8', timeout: 400_000 });
  const fail = Number(/ℹ fail (\d+)/.exec(r.stdout ?? '')?.[1] ?? NaN);
  const cancelled = Number(/ℹ cancelled (\d+)/.exec(r.stdout ?? '')?.[1] ?? 0); // teste que travou também caiu
  const names = [...(r.stdout ?? '').matchAll(/^✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((n) => !/^test[\\/]/.test(n));
  return { fail: fail + cancelled, names: [...new Set(names)] };
}

if (!ONLY) {
  const base = run([...TESTS, ...SERVER_TESTS]);
  if (base.fail !== 0) {
    console.log('base não está verde', base);
    process.exit(1);
  }
}
let bad = 0;
for (const [name, file, from0, to0] of M) {
  if (ONLY && !ONLY.test(name)) continue;
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const crlf = orig.includes('\r\n');
  const from = crlf ? from0.replaceAll('\n', '\r\n') : from0;
  const to = crlf ? to0.replaceAll('\n', '\r\n') : to0;
  if (!orig.includes(from)) {
    console.log(`?? ${name}: texto não encontrado em ${file}`);
    bad++;
    continue;
  }
  fs.writeFileSync(p, orig.replace(from, to));
  try {
    const files = file === 'src/app/server.ts' ? SERVER_TESTS : TESTS;
    const r = run(files);
    const ok = r.fail > 0; // NaN (a suíte nem rodou) não conta como "caiu"
    if (!ok) bad++;
    console.log(`${ok ? 'CAI   ' : 'PASSA!'} ${name} → ${r.names.slice(0, 2).join(' | ') || `fail=${r.fail}`}`);
  } finally {
    fs.writeFileSync(p, orig);
  }
}
console.log(bad ? `${bad} regra(s) sem teste que cai` : 'todas as regras derrubam algum teste');
