import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLI_FORA_DO_APP, EXPLORERS, includedInPackage, isAppUrl, isExternalLink, parseServerUrl, permissionAllowed, SUPPORT_URL, TITLE_BAR } from '../../desktop/regras.ts';

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MAIN = read('desktop/main.ts');
const PRELOAD = read('desktop/preload.cjs');
const HTML = read('src/app/ui/index.html');
const SERVER = read('src/app/server.ts');
const PKG = JSON.parse(read('package.json'));

test('desktop: acha o endereço com o código na saída real do servidor', () => {
  // a mesma linha que server.ts imprime (se o texto mudar lá, o app de desktop deixa de achar o endereço)
  const line = /console\.log\(`(Se não abriu sozinho[^`]*)`\)/.exec(SERVER)?.[1];
  assert.ok(line?.includes('${url}'), 'servidor imprime o endereço');
  assert.ok(SERVER.includes('const url = `http://127.0.0.1:${port}/#${TOKEN}`;'), 'formato do endereço');
  const url = 'http://127.0.0.1:51239/#53c8bf7824f5d89894f4024bbd9e60bbd0ced4d841f991fa';
  assert.equal(parseServerUrl(`Clurn aberto no seu navegador.\n${line!.replace('${url}', url)}\nPara fechar: ...`), url);
  assert.equal(parseServerUrl('Se não abriu sozinho, copie: http://127.0.0.1:51239/'), null, 'sem código, não abre');
  assert.equal(parseServerUrl('http://evil.com:1/#53c8bf7824f5d89894f4024bbd9e60bb'), null, 'só 127.0.0.1');
});

test('desktop: a janela só mostra o servidor local; links externos só para os exploradores', () => {
  const base = 'http://127.0.0.1:51239/#abc';
  assert.equal(isAppUrl('http://127.0.0.1:51239/api/estado', base), true);
  for (const other of ['http://127.0.0.1:51240/', 'https://127.0.0.1:51239/', 'http://localhost:51239/', 'file:///C:/x', 'lixo'])
    assert.equal(isAppUrl(other, base), false, other);
  assert.equal(isExternalLink('https://solscan.io/tx/abc'), true);
  assert.equal(isExternalLink('https://etherscan.io/address/0x1'), true);
  for (const bad of ['http://solscan.io/tx/a', 'https://solscan.io.evil.com/', 'https://evil.com/', 'https://solscan.io:8443/', 'file:///C:/Windows', 'javascript:alert(1)', ''])
    assert.equal(isExternalLink(bad), false, bad);
  // suporte no Telegram: só o endereço oficial exato abre no navegador; outro canal do t.me, não
  assert.equal(SUPPORT_URL, 'https://t.me/clurnapp');
  assert.equal(isExternalLink('https://t.me/clurnapp'), true);
  assert.equal(isExternalLink('https://t.me/clurnapp/'), true);
  for (const bad of ['https://t.me/clurnapp_suporte', 'https://t.me/outro', 'https://t.me/clurnapp?start=x', 'https://t.me/clurnapp#x', 'http://t.me/clurnapp', 'https://t.me.evil.com/clurnapp', 'https://x@t.me/clurnapp', 'https://t.me:444/clurnapp', 'tg://resolve?domain=clurnapp'])
    assert.equal(isExternalLink(bad), false, bad);
  // a página aponta para o mesmo endereço que a janela deixa abrir
  assert.ok(HTML.includes(`const SUPPORT_URL = '${SUPPORT_URL}';`), 'mesmo endereço na página e no Electron');
  // todo explorador usado pela página está na lista (senão o link não abre no app de desktop)
  for (const [host] of SERVER.matchAll(/https:\/\/([a-z0-9.-]*(?:scan|explorer)[a-z0-9.-]*\.[a-z]+)/g)) assert.ok(EXPLORERS.includes(host.slice(8)), host);
});

test('desktop: janela isolada, servidor como processo filho, fechar encerra o servidor', () => {
  for (const rule of [/contextIsolation: true/, /sandbox: true/, /nodeIntegration: false/, /devTools: !app\.isPackaged/])
    assert.match(MAIN, rule);
  assert.match(MAIN, /onBeforeRequest\(\(details, cb\) => cb\(\{ cancel: !isAppUrl\(details\.url, base\)/, 'Chromium sem rede externa');
  assert.match(MAIN, /setPermissionRequestHandler\(\(_wc, permission, cb, details\) => cb\(permissionAllowed\(permission, details\.requestingUrl, base\)\)\)/, 'permissões pela regra (só copiar)');
  assert.match(MAIN, /if \(!isAppUrl\(url, base\)\) e\.preventDefault\(\)/, 'não navega para fora');
  assert.match(MAIN, /if \(isExternalLink\(url\)\) void shell\.openExternal\(url\);\s+return \{ action: 'deny' \}/, 'nova janela nunca abre dentro do app');
  assert.match(MAIN, /spawn\(process\.execPath, \[SERVER, '--sem-navegador', \.\.\.\(app\.isPackaged \? \['--empacotado'\] : \[\]\)\]/, 'mesmo servidor do npm start, sem abrir navegador; só a cópia instalada consulta versão nova');
  assert.match(MAIN, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(MAIN, /server\?\.kill\(\)/, 'ao sair, o servidor (e as chaves) somem');
  assert.match(MAIN, /r === 'running'[\s\S]{0,400}return;\s+\}\s+closing = true;/, 'no meio da execução, não fecha');
  // o stack de uma tarefa que falhou (server.ts, background) sai no stderr do app: visível num terminal, nunca em arquivo
  assert.match(MAIN, /child\.stderr\.pipe\(process\.stderr\)/, 'saída de erro repassada ao terminal, não gravada');
  assert.doesNotMatch(MAIN, /createWriteStream|writeFile|appendFile/, 'nada do servidor vai para arquivo');
  assert.doesNotMatch(MAIN, /console\.(log|error)\(/, 'nada do servidor (endereço com código) vai para log');
});

test('desktop: barra da janela com a cor de cada tema; cabeçalho arrasta e deixa espaço aos botões', () => {
  for (const theme of ['light', 'dark'] as const) {
    const block = theme === 'dark' ? HTML.slice(HTML.indexOf(':root[data-theme="dark"] {')) : HTML.slice(HTML.indexOf(':root {'));
    const css = (v: string) => new RegExp(`--${v}: (#[0-9A-Fa-f]{6});`).exec(block)?.[1]?.toUpperCase();
    assert.equal(TITLE_BAR[theme].color, css('bg'), `${theme}: fundo`);
    assert.equal(TITLE_BAR[theme].symbolColor, css('text'), `${theme}: símbolos`);
  }
  assert.match(HTML, /window\.clurnDesktop\?\.setTheme\(theme\)/, 'trocar o tema avisa a janela');
  assert.match(MAIN, /ipcMain\.on\('clurn:tema', \(e, theme: unknown\) => \{\s+if \(e\.sender !== win\.webContents \|\| \(theme !== 'dark' && theme !== 'light'\)\) return;/, 'só aceita os dois temas');
  assert.match(PRELOAD, /exposeInMainWorld\('clurnDesktop', \{\s+setTheme:/, 'página só ganha setTheme');
  assert.doesNotMatch(PRELOAD, /ipcRenderer\.(invoke|sendSync|on)\b/, 'nada além de avisar o tema');
  assert.match(HTML, /\.desktop \.top \{[^}]*position: sticky[^}]*-webkit-app-region: drag[^}]*env\(titlebar-area-width/, 'cabeçalho = barra da janela');
  assert.match(HTML, /\.desktop \.top :is\(button, label, input, a, select\) \{ -webkit-app-region: no-drag; \}/, 'botões do cabeçalho continuam clicáveis');
});

test('dependências: só de desenvolvimento, versão fixa, e o app (src/) continua sem nenhuma', () => {
  assert.equal(PKG.dependencies, undefined, 'nada em dependencies');
  assert.deepEqual(Object.keys(PKG.devDependencies).sort(), ['@electron/packager', 'electron']);
  for (const [name, v] of Object.entries(PKG.devDependencies)) assert.match(String(v), /^\d+\.\d+\.\d+$/, `${name} com versão fixa`);
  assert.equal(PKG.main, 'desktop/main.ts');
});

test('empacotado: só entra o código do app; sem relatórios, segredos ou comandos de terminal (exportar chave)', () => {
  for (const ok of ['', '/package.json', '/desktop', '/desktop/main.ts', '/src', '/src/app/server.ts', '/src/core/limpeza/plan.ts', '/src/cli/io.ts', '/src/cli/outras-redes.ts'])
    assert.equal(includedInPackage(ok), true, ok);
  for (const no of ['/relatorios', '/relatorios/limpeza.json', '/.env', '/frase.seed', '/x.key', '/secrets/a', '/test/app/app.test.ts', '/docs', '/video', '/ico', '/node_modules', '/dist', '/README.md', '/CLAUDE.md', '/package-lock.json', '/package.json.bak', '/srcx/a.ts', '/src/cli/chave.ts', '/src/cli/limpar.ts', '/src/cli/scan.ts'])
    assert.equal(includedInPackage(no), false, no);
  // o servidor só usa de src/cli/ o que fica no pacote
  const SRC = ['src/app/server.ts', 'src/app/receipt.ts'].map(read).join('\n');
  for (const [, f] of SRC.matchAll(/from '\.\.\/cli\/([^']+)'/g)) assert.ok(!CLI_FORA_DO_APP.includes(f), `${f} é usado pelo app`);
});

test('desktop: a janela só pode escrever na área de transferência (botão Copiar), e só a página do app', () => {
  // em 31/10/2026 o "Copiar" não funcionava no app: todas as permissões eram negadas, inclusive clipboard-sanitized-write
  const base = 'http://127.0.0.1:51239/';
  assert.equal(permissionAllowed('clipboard-sanitized-write', `${base}#53c8bf7824f5d89894f4024bbd9e60bbd0ced4d841f991fa`, base), true);
  assert.equal(permissionAllowed('clipboard-sanitized-write', 'http://127.0.0.1:51240/', base), false, 'outra origem');
  assert.equal(permissionAllowed('clipboard-sanitized-write', 'https://solscan.io/', base), false);
  assert.equal(permissionAllowed('clipboard-sanitized-write', 'lixo', base), false);
  for (const p of ['clipboard-read', 'deprecated-sync-clipboard-read', 'media', 'geolocation', 'notifications', 'fullscreen', 'openExternal', 'display-capture', 'unknown'])
    assert.equal(permissionAllowed(p, base, base), false, p);
});

// ---------- RPC embutido (Helius) no app empacotado ----------

import { embedRpc } from '../../scripts/empacotar.ts';
import { readEmbeddedRpcs } from '../../src/app/rpc-padrao.ts';
import { EMBEDDED_RPC_PATH } from '../../desktop/regras.ts';

test('empacotado: o RPC embutido da pasta do projeto nunca é copiado; o empacotamento grava um novo dentro da cópia', () => {
  assert.equal(includedInPackage(EMBEDDED_RPC_PATH), false, 'arquivo velho esquecido na pasta não vai junto');
  assert.equal(EMBEDDED_RPC_PATH, '/src/app/rpc-embutido.json');
  const ignore = read('.gitignore');
  assert.match(ignore, /^src\/app\/rpc-embutido\.json$/m, 'nunca no repositório');
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-pack-'));
  try {
    fs.mkdirSync(path.join(app, 'src', 'app'), { recursive: true });
    const file = path.join(app, 'src', 'app', 'rpc-embutido.json');
    const URL_ = 'https://mainnet.helius-rpc.com/?api-key=CHAVE-SECRETA';
    const out = embedRpc(app, [{ url: URL_ }]);
    assert.deepEqual(readEmbeddedRpcs(file), [{ url: URL_, heliusProject: null }], 'o servidor empacotado lê o que foi gravado');
    assert.ok(!out.includes('CHAVE-SECRETA'), `a saída do empacotamento não mostra a chave: ${out}`);
    assert.match(out, /mainnet\.helius-rpc\.com/);
    assert.match(out, /sem CLURN_HELIUS_PROJECT/, 'avisa que o painel fica sem o saldo da chave');
    const PROJECT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';
    assert.match(embedRpc(app, [{ url: URL_, heliusProject: PROJECT }]), /com o saldo da chave no painel/);
    assert.deepEqual(readEmbeddedRpcs(file), [{ url: URL_, heliusProject: PROJECT }]);
    // duas chaves (03/11/2026): gravadas na ordem, a saída diz quantas e não mostra nenhuma
    const URL2 = 'https://mainnet.helius-rpc.com/?api-key=CHAVE-DOIS';
    const two = embedRpc(app, [{ url: URL_, heliusProject: PROJECT }, { url: URL2 }]);
    assert.deepEqual(readEmbeddedRpcs(file).map((e) => e.url), [URL_, URL2]);
    assert.match(two, /2 chaves, usadas nessa ordem/);
    assert.match(two, /sem CLURN_HELIUS_PROJECT_2/);
    assert.ok(!two.includes('CHAVE-SECRETA') && !two.includes('CHAVE-DOIS'), two);
    // proxy do Clurn (09/11/2026): gravado primeiro e marcado; a saída diz que a chave fica no Worker
    const PROXY = 'https://clurn-rpc.exemplo.workers.dev/';
    const onlyProxy = embedRpc(app, [{ url: PROXY, proxy: true }]);
    assert.deepEqual(readEmbeddedRpcs(file), [{ url: PROXY, heliusProject: null, proxy: true }]);
    assert.match(onlyProxy, /só o proxy; nenhuma chave dentro do app/);
    assert.match(onlyProxy, /clurn-rpc\.exemplo\.workers\.dev, proxy do Clurn/);
    const mixed = embedRpc(app, [{ url: PROXY, proxy: true }, { url: URL_ }]);
    assert.deepEqual(readEmbeddedRpcs(file).map((e) => [e.url, e.proxy === true]), [[PROXY, true], [URL_, false]]);
    assert.match(mixed, /proxy e 1 chave, usados nessa ordem/);
    assert.match(mixed, /sem CLURN_HELIUS_PROJECT:/, 'a 1ª chave continua sendo CLURN_RPC_URL (o proxy não conta)');
    assert.ok(!mixed.includes('CHAVE-SECRETA'), mixed);
    const none = embedRpc(app, []);
    assert.equal(fs.existsSync(file), false, 'sem CLURN_RPC_URL: sem arquivo (não sobra chave de um empacotamento anterior)');
    assert.match(none, /RPC público/);
    assert.throws(() => embedRpc(app, [{ url: 'http://inseguro/?api-key=CHAVE-SECRETA' }]), (e: Error) => !e.message.includes('CHAVE-SECRETA'));
  } finally {
    fs.rmSync(app, { recursive: true, force: true });
  }
});
