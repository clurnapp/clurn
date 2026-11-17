import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SERVER = fs.readFileSync(new URL('../../src/app/server.ts', import.meta.url), 'utf8');
const PS1 = fs.readFileSync(new URL('../../scripts/windows/criar-atalho.ps1', import.meta.url));
const SCRIPT = PS1.toString('utf8');

test('atalho: ID da barra de tarefas é o mesmo da janela do Edge (senão volta o favicon de 16 px esticado)', () => {
  // a janela do Edge se identifica como MSEdge.<host>_<caminho>.<pasta do perfil>.Default (lido da janela aberta em 30/10/2026)
  const profile = SERVER.match(/path\.join\(local, 'Clurn', '([^']+)'\)/);
  assert.ok(profile, 'pasta do perfil da janela em server.ts');
  assert.match(SERVER, /`--app=\$\{url\}`/, 'janela abre o endereço do servidor');
  assert.match(SERVER, /127\.0\.0\.1/, 'servidor em 127.0.0.1');
  assert.ok(SCRIPT.includes(`$appId = 'MSEdge.127.0.0.1_/.${profile[1]}.Default'`), 'ID do atalho bate com o perfil');
});

test('atalho: com o Electron instalado abre o app de desktop desta pasta, com o mesmo ID que ele declara', () => {
  const MAIN = fs.readFileSync(new URL('../../desktop/main.ts', import.meta.url), 'utf8');
  const id = /app\.setAppUserModelId\('([^']+)'\)/.exec(MAIN)?.[1];
  assert.ok(id, 'app de desktop declara o ID');
  assert.match(SCRIPT, /\$electron = Join-Path \$repo 'node_modules\\electron\\dist\\electron\.exe'/);
  assert.match(SCRIPT, /\} elseif \(Test-Path \$electron\) \{\r?\n  \$target = \$electron\r?\n  \$arguments = '"' \+ \$repo \+ '"'/, 'sem pacote, abre esta pasta (sempre o código atual)');
  assert.ok(SCRIPT.includes(`  $appId = '${id}'`), 'ID do atalho = ID do app de desktop');
  assert.match(SCRIPT, /\$icon = Join-Path \$repo 'desktop\\clurn-icone\.ico'/, 'ícone do app de desktop');
  assert.ok(fs.existsSync(new URL('../../desktop/clurn-icone.ico', import.meta.url)), 'ícone existe');
});

test('atalho: com o app empacotado, abre o Clurn.exe copiado para fora do repositório (nome e ícone do Clurn)', () => {
  const PACK = fs.readFileSync(new URL('../../scripts/empacotar.ts', import.meta.url), 'utf8');
  assert.match(PACK, /name: 'Clurn',\s+executableName: 'Clurn',\s+platform: 'win32',\s+arch: 'x64',/, 'o empacotador gera dist\\Clurn-win32-x64\\Clurn.exe');
  assert.match(SCRIPT, /\$packaged = Join-Path \$repo 'dist\\Clurn-win32-x64'/);
  assert.match(SCRIPT, /\$installed = Join-Path \$env:LOCALAPPDATA 'Programs\\Clurn'/, 'cópia fora do repositório: empacotar de novo não esbarra no app aberto');
  // o pacote vem antes do Electron de desenvolvimento
  assert.ok(SCRIPT.indexOf("if (Test-Path (Join-Path $packaged 'Clurn.exe'))") < SCRIPT.indexOf('} elseif (Test-Path $electron)'));
  assert.match(SCRIPT, /if \(\$running\) \{ throw 'Feche o Clurn antes de atualizar a cópia instalada\.' \}/, 'não copia por cima do app aberto');
  assert.match(SCRIPT, /\$target = Join-Path \$installed 'Clurn\.exe'\r?\n  \$arguments = ''\r?\n  \$windowStyle = 1\r?\n  \$appId = 'Clurn'\r?\n  \$icon = \$target/);
  assert.match(SCRIPT, /\$s\.WorkingDirectory = \$workDir/);
  // 30/10/2026: a correção ficou na dist/ e o atalho continuou abrindo a cópia velha. Empacotar atualiza a
  // cópia instalada (mesma pasta do atalho), nunca por cima do app aberto, e avisa quando ficou velha.
  assert.match(PACK, /updateInstalledCopy\(dir\);/, 'empacotar atualiza a cópia instalada');
  assert.match(PACK, /path\.join\(process\.env\.LOCALAPPDATA, 'Programs', 'Clurn'\)/, 'mesma pasta do atalho');
  assert.ok(PACK.indexOf("'IMAGENAME eq Clurn.exe'") < PACK.indexOf("spawnSync('robocopy'"), 'confere se o app está aberto antes de copiar');
  assert.match(PACK, /if \(running\) \{\s+console\.log\(`AVISO: a cópia instalada .* continua VELHA/, 'aberto: avisa e não copia');
  assert.match(PACK, /\(r\.status \?\? 16\) >= 8\) throw/, 'robocopy 8+ é falha');
});

test('atalho: área de trabalho e Menu Iniciar, os dois com o ID; arquivo com BOM para o PowerShell 5.1 ler os acentos', () => {
  assert.match(SCRIPT, /GetFolderPath\('Desktop'\), \[Environment\]::GetFolderPath\('Programs'\)/, 'Menu Iniciar: é por ele que o Windows acha o ícone pelo ID');
  assert.match(SCRIPT, /\$s\.Save\(\)\s+\[ClurnLnk\]::SetAppId\(\$lnk, \$appId\)/, 'ID gravado em cada atalho, depois de salvar');
  assert.match(SCRIPT, /pid = 5 \}; \/\/ System\.AppUserModel\.ID/, 'propriedade certa');
  assert.deepEqual([...PS1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8');
});
