// Contra-teste do instalador do Windows e da janela com cara de app (0.3.0): roda os testes de desktop e do app a cada regra.
// Desliga cada regra (troca exata no código), roda os testes, exige que algum caia e restaura o arquivo.
// Uso (na raiz do repositório, sem outra sessão mexendo nos arquivos): node scripts/contra-teste-instalador.cjs [filtro do nome]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const R = [
  ['recarregar Ctrl+R', 'desktop/regras.ts', "['r', 'p', 's', 'o', 'u']", "['p', 's', 'o', 'u']"],
  ["zoom (teclado e numérico chegam como + - 0)", "desktop/regras.ts", "  if (['=', '+', '-', '_', '0'].includes(key)) return true;", ""],
  ['F5/F12', 'desktop/regras.ts', "['f5', 'f12', 'browserback'", "['browserback'"],
  ['Alt+setas', 'desktop/regras.ts', "if (i.alt && !i.control && !i.meta && (key === 'arrowleft' || key === 'arrowright')) return true;", ''],
  ['só keyDown', 'desktop/regras.ts', "if (i.type !== 'keyDown' && i.type !== 'rawKeyDown') return false;", ''],
  ['devtools Shift', 'desktop/regras.ts', "if (i.shift && ['i', 'j', 'c'].includes(key)) return true;", ''],
  ['menu: campo', 'desktop/regras.ts', "{ role: 'paste', label: l.paste, enabled: p.editFlags.canPaste },", "{ role: 'paste', label: l.paste, enabled: true },"],
  ['menu: seleção', 'desktop/regras.ts', "return p.selectionText.trim() ? [{ role: 'copy', label: l.copy, enabled: true }] : [];", 'return [];'],
  ['menu: idioma', 'desktop/regras.ts', "/^pt\\b/i.test(locale)", 'false'],
  ['janela: teclas', 'desktop/main.ts', 'if (blockedKey(input)) e.preventDefault();', ''],
  ['janela: zoom roda', 'desktop/main.ts', "wc.on('zoom-changed', () => wc.setZoomLevel(0));", ''],
  ['janela: pinça', 'desktop/main.ts', 'void wc.setVisualZoomLevelLimits(1, 1);', ''],
  ['janela: menu', 'desktop/main.ts', 'const items = editMenu(params, app.getLocale());', 'const items: never[] = [];'],
  ['janela: ligada', 'desktop/main.ts', '  behaveLikeApp(win);\n', ''],
  ['css seleção', 'src/app/ui/index.html', '.desktop :is(button, .btn, label, summary, h1, h2, h3, .top, nav) { -webkit-user-select: none; user-select: none; }', ''],
  ['css arrastar', 'src/app/ui/index.html', '.desktop :is(img, a) { -webkit-user-drag: none; }', ''],
  ['sem admin', 'scripts/instalador.ts', "'PrivilegesRequired=lowest',", "'PrivilegesRequired=admin',"],
  ['pasta do usuário', 'scripts/instalador.ts', "'DefaultDirName={autopf}\\\\Clurn',", "'DefaultDirName={commonpf}\\\\Clurn',"],
  ['AppId', 'scripts/instalador.ts', "`AppId={{${INSTALLER_APP_ID}}`,", "'AppId=Clurn',"],
  ['fechar Clurn aberto', 'scripts/instalador.ts', "'CloseApplications=yes',", "'CloseApplications=no',"],
  ['poucas telas', 'scripts/instalador.ts', "'DisableReadyPage=yes',", "'DisableReadyPage=no',"],
  ['idioma PT', 'scripts/instalador.ts', "    'Name: \"ptbr\"; MessagesFile: \"compiler:Languages\\\\BrazilianPortuguese.isl\"',\n", ''],
  ['atalho com ID', 'scripts/instalador.ts', `'Name: "{autoprograms}\\\\Clurn"; Filename: "{app}\\\\Clurn.exe"; AppUserModelID: "Clurn"',`, `'Name: "{autoprograms}\\\\Clurn"; Filename: "{app}\\\\Clurn.exe"',`],
  ['área de trabalho opcional', 'scripts/instalador.ts', 'AppUserModelID: "Clurn"; Tasks: desktopicon', 'AppUserModelID: "Clurn"'],
  ['desinstalar dados', 'scripts/instalador.ts', "...UNINSTALL_DATA_DIRS.map((d) => `Type: filesandordirs; Name: \"${d}\"`),", ''],
  ['pasta créditos', 'scripts/instalador.ts', "'{localappdata}\\\\Clurn'];", "'{localappdata}\\\\Outro'];"],
  ['publicador', 'scripts/instalador.ts', "'AppPublisher=Clurn',", "'AppPublisher=autor',"],
  ['versão', 'scripts/instalador.ts', 'if (!/^\\d+\\.\\d+\\.\\d+$/.test(o.version))', 'if (false)'],
  ['aspas', 'scripts/instalador.ts', "if (s.includes('\"') || /[\\r\\n]/.test(s))", 'if (false)'],
  ['CLURN_ISCC', 'scripts/instalador.ts', '    env.CLURN_ISCC,\n', ''],
  ['ISCC do usuário', 'scripts/instalador.ts', "    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),\n", ''],
  ['empacotar usa instalador', 'scripts/empacotar.ts', 'const file = iscc ? buildInstaller(iscc, dir) : buildZip(dir);', 'const file = buildZip(dir);'],
  ['empacotar confere saída', 'scripts/empacotar.ts', "  if (!fs.existsSync(setup)) throw new Error(`O Inno Setup não gerou ${setup}.`);\n", ''],
  ['robocopy empacotar', 'scripts/empacotar.ts', "'/MIR', '/XF', 'unins*',", "'/MIR',"],
  ['robocopy atalho', 'scripts/windows/criar-atalho.ps1', '/MIR /XF unins* ', '/MIR '],
  // 16/11/2026: cara do app, textos próprios, idioma e atualização silenciosa
  ['visual: escuro e sem linhas', 'scripts/instalador.ts', "'WizardStyle=modern dark hidebevels includetitlebar',", "'WizardStyle=modern',"],
  ['visual: fundo do app', 'scripts/instalador.ts', "    `WizardBackColor=${INSTALLER_BG}`,\n", ''],
  ['visual: logo do canto com margem', 'scripts/instalador.ts', '    `WizardSmallImageFile=${fileList(o.smallImages)}`,', '    `WizardSmallImageFile=${fileList(o.smallImages.slice(0, 1))}`,'],
  ['visual: imagem da tela final', 'scripts/instalador.ts', '    `WizardImageFile=${fileList(o.sideImages)}`,\n', ''],
  ['lista de imagens: vírgula no caminho', 'scripts/instalador.ts', "  for (const p of files) if (p.includes(',')) throw new Error(`caminho inválido para o instalador: ${p}`);\n", ''],
  ['textos próprios', 'scripts/instalador.ts', '    ...Object.entries(INSTALLER_MESSAGES).flatMap(([lang, msgs]) => Object.entries(msgs).map(([k, v]) => `${lang}.${k}=${v}`)),\n', ''],
  ['caminho dos arquivos escondido', 'scripts/instalador.ts', "    '  WizardForm.FilenameLabel.Visible := False;',\n", ''],
  ['botão Instalar na 1ª tela', 'scripts/instalador.ts', "    '    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);',", "    '    WizardForm.NextButton.Caption := SetupMessage(msgButtonNext);',"],
  ['inglês é o padrão (1º da lista)', 'scripts/instalador.ts', "    'Name: \"en\"; MessagesFile: \"compiler:Default.isl\"',\n    'Name: \"ptbr\"; MessagesFile: \"compiler:Languages\\\\BrazilianPortuguese.isl\"',", "    'Name: \"ptbr\"; MessagesFile: \"compiler:Languages\\\\BrazilianPortuguese.isl\"',\n    'Name: \"en\"; MessagesFile: \"compiler:Default.isl\"',"],
  ['atualização silenciosa reabre o Clurn', 'scripts/instalador.ts', "    'Filename: \"{app}\\\\Clurn.exe\"; Flags: nowait skipifnotsilent',\n", ''],
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
    res = spawnSync(process.execPath, ['--test', 'test/desktop/*.test.ts', 'test/app/*.test.ts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
