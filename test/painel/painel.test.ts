// Painel do autor (scripts/painel-admin.ts e scripts/painel/metricas.ts): contas certas, dado sujo não derruba,
// nada de endereço de usuário, página só neste computador e com o código da abertura.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { alerts, feeSummary, LAMPORTS, parseProxyStats, releaseSummary, versionShare, type FeeTx, type Health } from '../../scripts/painel/metricas.ts';
import { parseFeeTx, shortHash } from '../../scripts/painel/ler-tx.ts';

const FEE = 'CarteiraDaTaxa1111111111111111111111111111';
const DEST = 'DestinoDoCliente11111111111111111111111111';
const BURNER = 'Temporaria111111111111111111111111111111111';
const NOW = Date.UTC(2026, 10, 16, 12);
const DAY = 86_400_000;

const tx = (over: any = {}) => ({
  blockTime: NOW / 1000,
  transaction: { message: { accountKeys: [BURNER, DEST, FEE] } },
  meta: { err: null, preBalances: [1_000_000_000, 5, 7], postBalances: [0, 5 + 890_000_000, 7 + 110_000_000], ...over.meta },
  ...over,
});

test('painel: taxa da transação = o que a carteira da taxa recebeu; destino guardado só como hash', () => {
  const x = parseFeeTx('sig1', tx(), FEE)!;
  assert.equal(x.fee, 110_000_000);
  assert.equal(x.t, NOW);
  assert.equal(x.dest, shortHash(DEST));
  assert.ok(!JSON.stringify(x).includes(DEST), 'o endereço do cliente não fica guardado');
  // contas carregadas por tabela de endereços (v0) entram na busca
  const v0 = parseFeeTx('sig2', tx({ transaction: { message: { accountKeys: [BURNER, DEST] } }, meta: { err: null, preBalances: [10, 0, 0], postBalances: [0, 8, 2], loadedAddresses: { writable: [FEE], readonly: [] } } }), FEE)!;
  assert.equal(v0.fee, 2);
});

test('painel: transação com erro, de outra carteira ou fora do formato é pulada sem derrubar', () => {
  assert.equal(parseFeeTx('s', tx({ meta: { err: { InstructionError: [0, 'x'] }, preBalances: [1, 1, 1], postBalances: [1, 1, 1] } }), FEE), null);
  assert.equal(parseFeeTx('s', tx(), 'OutraCarteira'), null);
  for (const bad of [null, undefined, 42, 'x', {}, { meta: {} }, tx({ blockTime: 'ontem' }), tx({ meta: { err: null, preBalances: [1], postBalances: [1, 2] } }), tx({ transaction: null })]) {
    assert.equal(parseFeeTx('s', bad, FEE), null, JSON.stringify(bad)?.slice(0, 60));
  }
  // saída da carteira (saque do autor): negativa, sem destino de cliente
  const out = parseFeeTx('s', tx({ meta: { err: null, preBalances: [0, 0, 500], postBalances: [0, 495, 0] } }), FEE)!;
  assert.equal(out.fee, -500);
  assert.equal(out.dest, null);
});

test('painel: resumo da taxa (receita por janela, clientes novos e recorrentes, saques fora da receita)', () => {
  const a = shortHash('A');
  const b = shortHash('B');
  const txs: FeeTx[] = [
    { sig: '1', t: NOW - 40 * DAY, fee: 1 * LAMPORTS, dest: a },
    { sig: '2', t: NOW - 3 * DAY, fee: 0.5 * LAMPORTS, dest: a },
    { sig: '3', t: NOW - 1 * DAY, fee: 0.25 * LAMPORTS, dest: b },
    { sig: '4', t: NOW - 60_000, fee: 0.125 * LAMPORTS, dest: b },
    { sig: '5', t: NOW - 2 * DAY, fee: -2 * LAMPORTS, dest: null },
    // depósito na carteira (ninguém mais recebeu): não é limpeza nem receita (achado de 16/11/2026: o depósito
    // de 09/11 aparecia como limpeza paga)
    { sig: '6', t: NOW - 5 * DAY, fee: 0.955 * LAMPORTS, dest: null },
  ];
  const s = feeSummary(txs, NOW);
  assert.equal(s.depositos, 0.955);
  assert.equal(s.receitaTotal, 1.875);
  assert.equal(s.receitaHoje, 0.125);
  assert.equal(s.receita7d, 0.875);
  assert.equal(s.receita30d, 0.875);
  assert.equal(s.limpezasTotal, 4);
  assert.equal(s.limpezas7d, 3);
  assert.equal(s.clientesTotal, 2);
  assert.equal(s.clientesNovos7d, 1, 'A já era cliente há 40 dias');
  assert.equal(s.clientesRecorrentes, 2, 'A e B voltaram em outro dia');
  assert.equal(s.saidas, 2);
  assert.equal(s.porDia.length, 30);
  assert.equal(s.porDia.at(-1)!.dia, '2026-11-16');
  assert.equal(s.porDia.at(-1)!.sol, 0.125);
  assert.equal(s.porDia.reduce((x, d) => x + d.novos, 0), 1);
  assert.deepEqual(feeSummary([], NOW).porDia.every((d) => d.sol === 0), true);
});

test('painel: downloads por versão (só o instalador .exe), rascunho e tag fora do formato ficam de fora', () => {
  const r = releaseSummary([
    { tag_name: 'v1.0.0', published_at: '2026-11-17T10:00:00Z', assets: [{ name: 'Clurn-Setup-1.0.0.exe', download_count: 40 }, { name: 'clurn-versao.json', download_count: 900 }] },
    { tag_name: 'v1.0.1', published_at: '2026-11-20T10:00:00Z', assets: [{ name: 'Clurn-Setup-1.0.1.exe', download_count: 7 }] },
    { tag_name: 'v2.0.0', draft: true, assets: [{ name: 'x.exe', download_count: 99 }] },
    { tag_name: 'teste', assets: [] },
    { tag_name: 'v0.9.9', assets: [{ name: 'a.exe', download_count: -5 }, { name: 'b.exe', download_count: 'muitos' }] },
    null,
  ]);
  assert.equal(r.ultima!.versao, '1.0.1');
  assert.deepEqual(r.porVersao.map((x) => [x.versao, x.downloads]), [['1.0.1', 7], ['1.0.0', 40], ['0.9.9', 0]]);
  assert.equal(r.total, 47);
  assert.deepEqual(releaseSummary({ message: 'Not Found' }), { ultima: null, porVersao: [], total: 0, aberturas: 0 });
});

const proxyJson = (over: any = {}) => ({
  hoje: { dia: '2026-11-16', pedidos: 100, creditos: 900, ips: 3, metodos: { sendTransaction: 4 }, versoes: { '1.0.0': 30, '0.2.4': 70 }, recusas: { segundo: 0, 'dia-ip': 0, teto: 0, 'teto-hora': 0 }, eventos: {} },
  historico: [{ dia: '2026-11-15', pedidos: 10, creditos: 10, ips: 1, metodos: {}, versoes: { '1.0.0': 10 }, recusas: {}, eventos: {} }, { dia: 'lixo' }],
  chaves: [{ posicao: 1, pausadaAte: null }, { posicao: 2, pausadaAte: NOW + 60_000 }, { posicao: 'x' }],
  limites: { porIpDia: 6000, tetoHora: 15000, tetoDia: 1000 },
  versaoMinima: null,
  ...over,
});

test('painel: estatísticas do proxy conferidas campo a campo (dia e chave fora do formato saem)', () => {
  const p = parseProxyStats(proxyJson())!;
  assert.equal(p.historico.length, 1);
  assert.equal(p.chaves.length, 2);
  assert.equal(parseProxyStats({ erro: 'x' }), null);
  assert.equal(parseProxyStats(null), null);
  const share = versionShare(p);
  assert.deepEqual(share.map((v) => [v.versao, v.pedidos]), [['0.2.4', 70], ['1.0.0', 40]]);
  assert.equal(Math.round(share[0]!.pct), 64);
});

const healthy: Health = { proxy: 'ok', site: 'ok', atualizacao: { kind: 'ok', versao: '1.0.0' } };

test('painel: alertas (chave sem crédito, crédito perto do teto, versão velha, atualização quebrada, proxy fora)', () => {
  const p = parseProxyStats(proxyJson())!;
  const rel = releaseSummary([{ tag_name: 'v1.0.0', assets: [] }]);
  const texts = (x: ReturnType<typeof alerts>) => x.map((a) => `${a.nivel}: ${a.texto}`).join('\n');
  const a = alerts({ now: NOW, proxy: p, proxyErro: null, health: healthy, releases: rel, fee: null });
  assert.match(texts(a), /atencao: 1 de 2 chave/);
  assert.match(texts(a), /atencao: Créditos de hoje em 90%/);
  assert.match(texts(a), /atencao: 64% dos pedidos .* anteriores à 1\.0\.0/);
  const allPaused = parseProxyStats(proxyJson({ chaves: [{ posicao: 1, pausadaAte: NOW + 1 }] }))!;
  assert.match(texts(alerts({ now: NOW, proxy: allPaused, proxyErro: null, health: healthy, releases: null, fee: null })), /critico: Todas as chaves/);
  const broken = alerts({ now: NOW, proxy: null, proxyErro: 'sem conexão com o proxy', health: { proxy: 'erro', site: 'ok', atualizacao: { kind: 'error', reason: 'assinatura não confere' } }, releases: null, fee: null });
  assert.equal(broken[0]!.nivel, 'critico');
  assert.match(texts(broken), /critico: O proxy/);
  assert.match(texts(broken), /critico: O arquivo de versão .*assinatura não confere/);
  assert.match(texts(broken), /atencao: Estatísticas do proxy indisponíveis/);
  const calm = parseProxyStats(proxyJson({ hoje: { ...proxyJson().hoje, creditos: 10, versoes: { '1.0.0': 5 } }, chaves: [{ posicao: 1, pausadaAte: null }] }))!;
  assert.deepEqual(alerts({ now: NOW, proxy: calm, proxyErro: null, health: healthy, releases: rel, fee: null }), []);
});

test('painel: servidor só responde em 127.0.0.1 com o código da abertura; página com CSP de nonce; nada de token na página', async () => {
  process.env.CLURN_STATS_TOKEN = 'TOKEN-DE-TESTE-' + 'x'.repeat(30);
  const { startServer } = await import('../../scripts/painel-admin.ts');
  const { server, code } = startServer({ log: () => {} });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string, host = `127.0.0.1:${port}`) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const rq = request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        });
        rq.on('error', reject);
        rq.end();
      });
    });
  try {
    assert.ok(code.length >= 20);
    assert.equal((await get('/')).status, 404);
    assert.equal((await get('/x' + code)).status, 404);
    assert.equal((await get(`/${code}`, `evil.example:${port}`)).status, 404, 'DNS rebinding: Host errado');
    assert.equal((await get(`/${code}`, `localhost:${port}`)).status, 404);
    const page = await get(`/${code}`);
    assert.equal(page.status, 200);
    const csp = String(page.headers['content-security-policy']);
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    assert.match(csp, /default-src 'none'/);
    assert.ok(page.body.includes(`<script nonce="${nonce}">`) && page.body.includes(`<style nonce="${nonce}">`));
    assert.ok(!page.body.includes('{{NONCE}}'));
    assert.ok(!page.body.includes('TOKEN-DE-TESTE'), 'o token do proxy nunca vai para a página');
    assert.ok(!/innerHTML|insertAdjacentHTML|eval\(/.test(page.body), 'texto de fora só por textContent');
    assert.equal(page.headers['x-frame-options'], 'DENY');
    // tema do app: fontes e logo só pela lista, só com o código da abertura, nada fora do próprio painel
    assert.match(csp, /font-src 'self'/);
    assert.ok(!/https?:\/\//.test(page.body.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'nenhum recurso externo');
    assert.ok(page.body.includes(`/${code}/assets/inter.woff2`) && !page.body.includes('{{CODE}}'));
    const font = await get(`/${code}/assets/inter.woff2`);
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.equal((await get(`/${code}/assets/clurn.svg`)).headers['content-type'], 'image/svg+xml');
    for (const p of [`/assets/inter.woff2`, `/${code}/assets/OFL-inter.txt`, `/${code}/assets/clurn-icone-256.png`, `/${code}/assets/index.html`, `/${code}/assets/../index.html`, `/${code}/assets/%2e%2e%2findex.html`, `/${code}/assets/constructor`, `/${code}/assets/__proto__`]) {
      assert.equal((await get(p)).status, 404, p);
    }
  } finally {
    server.close();
    delete process.env.CLURN_STATS_TOKEN;
  }
});

test('painel: o código não grava o token nem endereço de cliente; cache fora do repositório', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'painel-admin.ts'), 'utf8');
  assert.match(src, /os\.homedir\(\), '\.clurn-admin'/);
  // nenhum log interpola o valor do token (citar o nome da variável é permitido)
  for (const line of src.split('\n').filter((l) => /console\.(log|error)|\blog\(/.test(l))) {
    assert.ok(!/\$\{[^}]*(token|CLURN_STATS_TOKEN)[^}]*\}|[+,]\s*(token|process\.env\.CLURN_STATS_TOKEN)\s*[),+]/i.test(line), `log com o token: ${line.trim()}`);
  }
  const metricas = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'scripts', 'painel', 'ler-tx.ts'), 'utf8');
  assert.match(metricas, /dest: paid \? shortHash\(/, 'destino só como hash');
});

test('painel: token do proxy vem da variável ou do arquivo fora do repositório (variável primeiro)', async () => {
  const { statsToken, TOKEN_FILE } = await import('../../scripts/painel-admin.ts');
  const os = await import('node:os');
  assert.ok(!path.relative(path.resolve(import.meta.dirname, '..', '..'), TOKEN_FILE).match(/^[^.]/), 'arquivo fora do repositório');
  assert.ok(TOKEN_FILE.startsWith(os.homedir()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-tk-'));
  const f = path.join(dir, 'stats-token');
  fs.writeFileSync(f, '  do-arquivo  \n');
  assert.equal(statsToken({}, f), 'do-arquivo');
  assert.equal(statsToken({ CLURN_STATS_TOKEN: 'da-variavel' }, f), 'da-variavel');
  assert.equal(statsToken({}, path.join(dir, 'nao-existe')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
