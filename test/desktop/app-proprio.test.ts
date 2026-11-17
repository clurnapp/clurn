// Cara de app próprio (09/11/2026): instalador, atalhos de navegador desligados, menu de edição.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blockedKey, editMenu, includedInPackage, type KeyInput } from '../../desktop/regras.ts';
import { scanText } from '../../scripts/publicar-codigo.ts';
import { findIscc, innoScript, INSTALLER_APP_ID, INSTALLER_BG, INSTALLER_MESSAGES, UNINSTALL_DATA_DIRS } from '../../scripts/instalador.ts';

const read = (p: string) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const MAIN = read('desktop/main.ts');
const HTML = read('src/app/ui/index.html');
const PACK = read('scripts/empacotar.ts');
const ATALHO = read('scripts/windows/criar-atalho.ps1');
const CREDITOS = read('src/app/creditos.ts');
const PKG = JSON.parse(read('package.json'));

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({ type: 'keyDown', key: k, control: false, meta: false, shift: false, alt: false, ...mods });
const ctrl = (k: string, mods: Partial<KeyInput> = {}) => key(k, { control: true, ...mods });

test('app próprio: recarregar, zoom, depuração, imprimir, salvar e voltar ficam desligados', () => {
  const blocked: Array<[string, KeyInput]> = [
    ['F5', key('F5')], ['Ctrl+R', ctrl('r')], ['Ctrl+Shift+R', ctrl('R', { shift: true })], ['F12', key('F12')],
    ['Ctrl+Shift+I', ctrl('I', { shift: true })], ['Ctrl+Shift+J', ctrl('J', { shift: true })], ['Ctrl+Shift+C', ctrl('C', { shift: true })],
    ['Ctrl+=', ctrl('=')], ['Ctrl++', ctrl('+', { shift: true })], ['Ctrl+-', ctrl('-')], ['Ctrl+0', ctrl('0')],
    ['Ctrl+P', ctrl('p')], ['Ctrl+S', ctrl('s')], ['Ctrl+O', ctrl('o')], ['Ctrl+U', ctrl('u')],
    ['Alt+←', key('ArrowLeft', { alt: true })], ['Alt+→', key('ArrowRight', { alt: true })],
    ['tecla Voltar', key('BrowserBack')], ['tecla Atualizar', key('BrowserRefresh')], ['Cmd+R', key('r', { meta: true })],
    ['rawKeyDown Ctrl+R', { ...ctrl('r'), type: 'rawKeyDown' }],
  ];
  for (const [name, i] of blocked) assert.equal(blockedKey(i), true, name);
});

test('app próprio: copiar, colar, recortar, desfazer, selecionar tudo e digitar continuam', () => {
  const allowed: Array<[string, KeyInput]> = [
    ['Ctrl+C', ctrl('c')], ['Ctrl+V', ctrl('v')], ['Ctrl+X', ctrl('x')], ['Ctrl+A', ctrl('a')], ['Ctrl+Z', ctrl('z')], ['Ctrl+Y', ctrl('y')],
    ['Ctrl+Shift+Z', ctrl('Z', { shift: true })], ['Ctrl+Shift+V', ctrl('V', { shift: true })],
    ['r', key('r')], ['R', key('R', { shift: true })], ['0', key('0')], ['-', key('-')], ['Enter', key('Enter')], ['Tab', key('Tab')],
    ['←', key('ArrowLeft')], ['Ctrl+←', ctrl('ArrowLeft')], ['Ctrl+Alt+← (AltGr)', key('ArrowLeft', { alt: true, control: true })],
    ['soltar Ctrl+R', { ...ctrl('r'), type: 'keyUp' }], ['soltar F5', { ...key('F5'), type: 'keyUp' }],
  ];
  for (const [name, i] of allowed) assert.equal(blockedKey(i), false, name);
});

test('app próprio: botão direito só com o menu de edição, no idioma do Windows', () => {
  const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };
  const field = editMenu({ isEditable: true, selectionText: '', editFlags: { ...flags, canCut: false, canCopy: false } }, 'pt-BR');
  assert.deepEqual(field, [
    { role: 'cut', label: 'Recortar', enabled: false },
    { role: 'copy', label: 'Copiar', enabled: false },
    { role: 'paste', label: 'Colar', enabled: true },
    { type: 'separator' },
    { role: 'selectAll', label: 'Selecionar tudo', enabled: true },
  ]);
  assert.deepEqual(editMenu({ isEditable: true, selectionText: 'x', editFlags: flags }, 'en-US').map((i) => ('label' in i ? i.label : '-')), ['Cut', 'Copy', 'Paste', '-', 'Select all']);
  assert.deepEqual(editMenu({ isEditable: true, selectionText: '', editFlags: flags }, 'pt-PT')[2], { role: 'paste', label: 'Colar', enabled: true });
  assert.deepEqual(editMenu({ isEditable: true, selectionText: '', editFlags: flags }, 'es')[2], { role: 'paste', label: 'Paste', enabled: true });
  // nada na área de transferência: "Colar" aparece desabilitado (e "Selecionar tudo" também, em campo vazio)
  const empty = editMenu({ isEditable: true, selectionText: '', editFlags: { ...flags, canPaste: false, canSelectAll: false } }, 'pt-BR');
  assert.deepEqual([empty[2], empty[4]], [{ role: 'paste', label: 'Colar', enabled: false }, { role: 'selectAll', label: 'Selecionar tudo', enabled: false }]);
  // fora de campo: só copiar o que está selecionado; sem seleção, nenhum menu (nada de "Inspecionar" ou "Voltar")
  assert.deepEqual(editMenu({ isEditable: false, selectionText: 'Abc123', editFlags: flags }, 'pt-BR'), [{ role: 'copy', label: 'Copiar', enabled: true }]);
  assert.deepEqual(editMenu({ isEditable: false, selectionText: '', editFlags: flags }, 'pt-BR'), []);
  assert.deepEqual(editMenu({ isEditable: false, selectionText: '  \n', editFlags: flags }, 'pt-BR'), []);
});

test('app próprio: a janela liga os atalhos, o zoom travado e o menu de edição', () => {
  assert.match(MAIN, /wc\.on\('before-input-event', \(e, input\) => \{\s*if \(blockedKey\(input\)\) e\.preventDefault\(\);/);
  assert.match(MAIN, /wc\.on\('zoom-changed', \(\) => wc\.setZoomLevel\(0\)\)/);
  assert.match(MAIN, /setVisualZoomLevelLimits\(1, 1\)/);
  assert.match(MAIN, /wc\.on\('context-menu', \(_e, params\) => \{\s*const items = editMenu\(params, app\.getLocale\(\)\);/);
  assert.match(MAIN, /lockDown\(win, base\);\s*behaveLikeApp\(win\);/);
  assert.match(MAIN, /Menu\.setApplicationMenu\(null\)/, 'sem barra de menu');
});

test('app próprio: arrastar o mouse não seleciona botões e títulos; campos e texto continuam selecionáveis', () => {
  const rule = /\.desktop :is\(([^)]*)\) \{ -webkit-user-select: none; user-select: none; \}/.exec(HTML);
  assert.ok(rule, 'regra de seleção no modo desktop');
  const sel = rule[1].split(',').map((s) => s.trim());
  for (const s of ['button', '.btn', 'label', 'h1', 'h2', '.top']) assert.ok(sel.includes(s), s);
  for (const s of ['input', 'textarea', 'body', 'p', 'code', 'td', '*']) assert.ok(!sel.includes(s), `${s} continua selecionável`);
  assert.match(HTML, /\.desktop :is\(img, a\) \{ -webkit-user-drag: none; \}/);
});

const OPTS = {
  version: '1.2.3',
  appDir: 'C:\\b\\dist\\Clurn-win32-x64',
  outDir: 'C:\\b\\dist',
  icon: 'C:\\b\\desktop\\clurn-icone.ico',
  smallImages: [58, 77, 97, 124].map((w) => `C:\\b\\scripts\\windows\\instalador-canto-${w}.png`),
  sideImages: [202, 269, 404].map((w) => `C:\\b\\scripts\\windows\\instalador-lateral-${w}.png`),
};
const line = (iss: string, k: string) => iss.split('\r\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);

test('instalador: cara do app (escuro com o fundo do app, sem linhas) e o caminho dos arquivos escondido', () => {
  const iss = innoScript(OPTS);
  assert.equal(line(iss, 'WizardStyle'), 'modern dark hidebevels includetitlebar');
  const appDark = /:root\[data-theme="dark"\]\s*\{[^}]*--bg:\s*(#[0-9A-Fa-f]{6})/.exec(HTML)?.[1];
  assert.equal(appDark?.toUpperCase(), INSTALLER_BG, 'mesma cor do tema escuro do app');
  for (const k of ['WizardBackColor', 'WizardImageBackColor', 'WizardSmallImageBackColor']) assert.equal(line(iss, k), INSTALLER_BG, k);
  assert.equal(line(iss, 'WizardImageFile'), `"${OPTS.sideImages.join(',')}"`, 'imagem da tela final em 3 tamanhos');
  assert.equal(line(iss, 'WizardSmallImageFile'), `"${OPTS.smallImages.join(',')}"`, 'logo do canto (com margem) em 4 tamanhos');
  assert.throws(() => innoScript({ ...OPTS, sideImages: ['C:\\a,b.png'] }), /caminho inválido/, 'vírgula separaria os arquivos');
  assert.throws(() => innoScript({ ...OPTS, smallImages: ['C:\\a,b.png'] }), /caminho inválido/);
  // o caminho de cada arquivo na cópia mostraria o nome do usuário do Windows
  assert.match(iss, /\[Code\]\r\nprocedure InitializeWizard;\r\nbegin\r\n {2}WizardForm\.FilenameLabel\.Visible := False;\r\nend;/);
  for (const f of [...OPTS.sideImages, ...OPTS.smallImages]) assert.ok(fs.existsSync(new URL(`../../scripts/windows/${f.split('\\').pop()}`, import.meta.url)), `${f} está no repositório`);
});

test('instalador: textos próprios em inglês e português, com a promessa de que a frase não sai do computador', () => {
  const iss = innoScript(OPTS);
  const en = INSTALLER_MESSAGES.en;
  const pt = INSTALLER_MESSAGES.ptbr;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort(), 'as duas línguas com as mesmas mensagens');
  for (const [lang, msgs] of Object.entries(INSTALLER_MESSAGES)) for (const [k, v] of Object.entries(msgs)) {
    assert.ok(iss.includes(`\r\n${lang}.${k}=${v}\r\n`), `${lang}.${k}`);
    assert.doesNotMatch(v, /[\r\n]/, 'uma linha só');
  }
  const messages = iss.slice(iss.indexOf('[Messages]'), iss.indexOf('[Tasks]'));
  assert.ok(messages.length > 20, 'seção [Messages] antes de [Tasks]');
  assert.match(en.InstallingLabel, /phrase never leaves this computer/);
  assert.match(pt.InstallingLabel, /frase nunca sai deste computador/);
  assert.match(pt.SelectTasksLabel2, /Instalar/, 'o texto manda clicar em Instalar');
  assert.match(iss, /if CurPageID = wpSelectTasks then\r\n {4}WizardForm\.NextButton\.Caption := SetupMessage\(msgButtonInstall\);/, 'e o botão da 1ª tela diz Instalar (sem a tela de "pronto para instalar")');
});

test('instalador: instala só para o usuário, sem administrador, sempre com a mesma identidade', () => {
  const iss = innoScript(OPTS);
  assert.equal(line(iss, 'PrivilegesRequired'), 'lowest');
  assert.equal(line(iss, 'DefaultDirName'), '{autopf}\\Clurn', 'sem admin, {autopf} = %LOCALAPPDATA%\\Programs');
  assert.equal(line(iss, 'AppId'), `{{${INSTALLER_APP_ID}}`, 'chave entre {{ }} do Inno');
  assert.equal(INSTALLER_APP_ID, 'C6330C04-D9F7-4478-91FE-68E4FA327798', 'NUNCA mudar: o Windows veria outro programa');
  assert.equal(line(iss, 'AppVersion'), '1.2.3');
  assert.equal(line(iss, 'OutputBaseFilename'), 'Clurn-Setup-1.2.3');
  assert.equal(line(iss, 'CloseApplications'), 'yes', 'pede para fechar o Clurn aberto');
  assert.ok(iss.includes(`Source: "${OPTS.appDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`));
  assert.ok(iss.includes('compiler:Languages\\BrazilianPortuguese.isl') && iss.includes('compiler:Default.isl'), 'português e inglês');
  // o Inno escolhe pelo idioma do Windows e, sem correspondência, usa o 1º da lista: Windows em qualquer outra língua → inglês
  const langs = iss.split('\r\n').filter((l) => l.startsWith('Name: "') && l.includes('MessagesFile:'));
  assert.deepEqual(langs.map((l) => /^Name: "(\w+)"/.exec(l)?.[1]), ['en', 'ptbr'], 'inglês primeiro (o padrão), português depois');
  assert.equal(line(iss, 'LanguageDetectionMethod'), undefined, 'padrão do Inno: idioma da interface do Windows');
  // poucas telas: sem pasta, sem grupo, sem boas-vindas, sem "pronto para instalar", sem escolher idioma
  for (const k of ['DisableDirPage', 'DisableProgramGroupPage', 'DisableWelcomePage', 'DisableReadyPage']) assert.equal(line(iss, k), 'yes', k);
  assert.equal(line(iss, 'ShowLanguageDialog'), 'no');
});

test('instalador: atalhos com o ID do app (ícone certo na barra), área de trabalho opcional, abre no fim', () => {
  const iss = innoScript(OPTS);
  const appId = /app\.setAppUserModelId\('([^']+)'\)/.exec(MAIN)?.[1];
  assert.equal(appId, 'Clurn');
  const icons = iss.split('\r\n').filter((l) => l.includes('Filename: "{app}\\Clurn.exe"; AppUserModelID'));
  assert.equal(icons.length, 2);
  for (const l of icons) assert.ok(l.includes(`AppUserModelID: "${appId}"`), l);
  assert.ok(icons.some((l) => l.startsWith('Name: "{autoprograms}\\Clurn"') && !l.includes('Tasks:')), 'Iniciar sempre');
  assert.ok(icons.some((l) => l.startsWith('Name: "{autodesktop}\\Clurn"') && l.endsWith('Tasks: desktopicon')), 'área de trabalho só se marcar');
  assert.ok(iss.includes('Filename: "{app}\\Clurn.exe"; Description: "{cm:LaunchProgram,Clurn}"; Flags: nowait postinstall skipifsilent'), 'instalação com tela: caixa "Iniciar o Clurn" no fim');
  // atualização pelo próprio app (1.0): roda o instalador com /VERYSILENT e fecha; o Clurn tem que reabrir sozinho
  assert.ok(iss.includes('\r\nFilename: "{app}\\Clurn.exe"; Flags: nowait skipifnotsilent\r\n'), 'instalação silenciosa reabre o Clurn');
  const run = iss.slice(iss.indexOf('[Run]'), iss.indexOf('[UninstallDelete]'));
  assert.equal(run.split('\r\n').filter((l) => l.startsWith('Filename:')).length, 2, 'só as duas formas de abrir, nunca as duas na mesma instalação');
});

test('instalador: o desinstalador apaga as pastas que o app grava (nenhuma com frase)', () => {
  const iss = innoScript(OPTS);
  for (const d of UNINSTALL_DATA_DIRS) assert.ok(iss.includes(`Type: filesandordirs; Name: "${d}"`), d);
  // as pastas batem com o código: Electron usa o "name" do package.json; créditos em %LOCALAPPDATA%\Clurn
  assert.ok(UNINSTALL_DATA_DIRS.includes(`{userappdata}\\${PKG.name}`), 'cache do Electron');
  assert.ok(CREDITOS.includes("path.join(process.env.LOCALAPPDATA, 'Clurn')") && UNINSTALL_DATA_DIRS.includes('{localappdata}\\Clurn'), 'créditos');
  assert.ok(!UNINSTALL_DATA_DIRS.some((d) => /\{(app|localappdata)\}\\Programs|^\{(userappdata|localappdata)\}$/.test(d)), 'nunca a pasta inteira');
});

test('instalador: nada do fundador; versão e caminhos fora do formato param', () => {
  const iss = innoScript(OPTS);
  // nomes do fundador conferidos por hash (scripts/publicar-codigo.ts): o nome nunca fica escrito no código público
  assert.deepEqual(scanText('instalador.iss', iss), []);
  assert.doesNotMatch(iss, /github\.com/i);
  assert.equal(line(iss, 'AppPublisher'), 'Clurn');
  for (const v of ['1.2', '1.2.3-beta', 'latest', '', '1.2.3"']) assert.throws(() => innoScript({ ...OPTS, version: v }), /versão inválida/, v);
  assert.throws(() => innoScript({ ...OPTS, appDir: 'C:\\a"b' }), /caminho inválido/);
  assert.throws(() => innoScript({ ...OPTS, icon: 'C:\\a\r\n[Run]' }), /caminho inválido/);
});

test('autoria: o package.json (vai dentro do app) e a licença assinam 0xkley, nunca o nome do fundador', () => {
  const lic = read('LICENCA.md');
  assert.equal(PKG.author, '0xkley');
  assert.equal(PKG.license, 'SEE LICENSE IN LICENCA.md');
  assert.match(lic, /Copyright © 2026 0xkley\./);
  assert.deepEqual(scanText('package.json', JSON.stringify(PKG)), [], 'package.json');
  assert.deepEqual(scanText('LICENCA.md', lic), [], 'LICENCA.md');
});

test('instalador: acha o Inno Setup (CLURN_ISCC primeiro, depois a instalação do usuário, depois a do sistema)', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  const env = { LOCALAPPDATA: 'C:\\U\\L', ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' };
  const user = 'C:\\U\\L\\Programs\\Inno Setup 6\\ISCC.exe';
  const x86 = 'C:\\PF86\\Inno Setup 6\\ISCC.exe';
  assert.equal(findIscc({ ...env, CLURN_ISCC: 'D:\\i\\ISCC.exe' }, has('D:\\i\\ISCC.exe', user)), 'D:\\i\\ISCC.exe');
  assert.equal(findIscc({ ...env, CLURN_ISCC: 'D:\\nao-existe.exe' }, has(user)), user);
  assert.equal(findIscc(env, has(user, x86)), user);
  assert.equal(findIscc(env, has(x86)), x86);
  assert.equal(findIscc(env, has()), null);
  assert.equal(findIscc({}, has(user)), null);
});

test('empacotar: instalador quando há Inno Setup, .zip com aviso quando não há; SHA-256 do que for distribuído', () => {
  assert.match(PACK, /const iscc = findIscc\(process\.env\);\s*const file = iscc \? buildInstaller\(iscc, dir\) : buildZip\(dir\);/);
  assert.match(PACK, /createHash\('sha256'\)\.update\(fs\.readFileSync\(file\)\)/);
  assert.match(PACK, /fs\.writeFileSync\(iss, innoScript\(/);
  assert.match(PACK, /if \(!fs\.existsSync\(setup\)\) throw/);
  assert.equal(includedInPackage('/scripts/instalador.ts'), false, 'o gerador do instalador não entra no app');
});

test('cópia instalada: atualizar pela dist/ não apaga o desinstalador', () => {
  assert.match(PACK, /'robocopy', \[dir, installed, '\/MIR', '\/XF', 'unins\*'/);
  assert.match(ATALHO, /robocopy \$packaged \$installed \/MIR \/XF unins\* /);
});
