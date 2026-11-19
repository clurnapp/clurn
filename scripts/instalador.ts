// Instalador de Windows do Clurn (Inno Setup, programa grátis que roda só aqui, na hora de empacotar; não entra no
// app). Decisão do autor (09/11/2026): no lugar do .zip com a pasta cheia de arquivos do Chromium, um único
// Clurn-Setup-<versão>.exe que instala como app: atalho no Iniciar (e na área de trabalho, se a pessoa quiser),
// entrada em "Adicionar ou remover programas" e desinstalador que não deixa nada para trás.
// Sem pedir administrador: instala só para o usuário, em %LOCALAPPDATA%\Programs\Clurn (a mesma pasta que o
// scripts/windows/criar-atalho.ps1 já usava).
import fs from 'node:fs';
import path from 'node:path';

// Identidade do app para o Windows: NUNCA mudar (com outra, o Windows vê outro programa e instala dois Clurn).
export const INSTALLER_APP_ID = 'C6330C04-D9F7-4478-91FE-68E4FA327798';
// Pastas que o app grava fora da de instalação (nenhuma guarda frase ou chave): o desinstalador apaga.
//  {userappdata}\clurn  = cache do Chromium do Electron (%APPDATA%\clurn, nome do package.json)
//  {localappdata}\Clurn = histórico de créditos (src/app/creditos.ts) e o perfil da janela do Edge (server.ts)
export const UNINSTALL_DATA_DIRS = ['{userappdata}\\clurn', '{localappdata}\\Clurn'];

// smallImages: o logo do canto de cima, com margem (o quadrado do Inno encosta no topo e na lateral da janela);
// sideImages: a imagem da tela final (logo + nome). Cada uma em tamanhos para cada DPI (scripts/windows/imagens-instalador.mjs).
export type InstallerOptions = { version: string; appDir: string; outDir: string; icon: string; smallImages: string[]; sideImages: string[] };

// Lista de arquivos do Inno: separada por vírgula, entre aspas (vírgula no caminho quebraria a lista)
function fileList(files: string[]): string {
  for (const p of files) if (p.includes(',')) throw new Error(`caminho inválido para o instalador: ${p}`);
  return quoted(files.join(','));
}

// Cara do app (12/11/2026): escuro com o fundo do app, sem linhas, barra de título no mesmo tom
export const INSTALLER_BG = '#13121A';

// Textos próprios nas telas que a pessoa vê (o resto fica com o texto padrão do Inno). "A frase nunca sai deste
// computador" é a promessa da tela inicial do app (CLAUDE.md, seção 7), repetida aqui.
export const INSTALLER_MESSAGES: Record<'en' | 'ptbr', Record<string, string>> = {
  en: {
    WizardSelectTasks: 'Before installing',
    SelectTasksDesc: 'Clurn installs for you only, without admin rights.',
    SelectTasksLabel2: 'Choose whether you want a desktop shortcut, then click Install.',
    WizardInstalling: 'Installing Clurn',
    InstallingLabel: 'This takes a few seconds. Your phrase never leaves this computer.',
    FinishedHeadingLabel: 'Clurn is installed',
    FinishedLabel: 'Clurn is in the Start menu. It runs only on your computer: your phrase is never sent to any server.',
    FinishedLabelNoIcons: 'Clurn runs only on your computer: your phrase is never sent to any server.',
    ClickFinish: 'Click Finish to close.',
  },
  ptbr: {
    WizardSelectTasks: 'Antes de instalar',
    SelectTasksDesc: 'O Clurn instala só para você, sem pedir administrador.',
    SelectTasksLabel2: 'Escolha se quer um atalho na área de trabalho e clique em Instalar.',
    WizardInstalling: 'Instalando o Clurn',
    InstallingLabel: 'Leva alguns segundos. A sua frase nunca sai deste computador.',
    FinishedHeadingLabel: 'Clurn instalado',
    FinishedLabel: 'O Clurn está no menu Iniciar. Ele roda só no seu computador: a frase não vai para nenhum servidor.',
    FinishedLabelNoIcons: 'O Clurn roda só no seu computador: a frase não vai para nenhum servidor.',
    ClickFinish: 'Clique em Concluir para fechar.',
  },
};

// Inno lê caminhos e textos entre aspas: aspas no meio quebrariam a linha
function quoted(s: string): string {
  if (s.includes('"') || /[\r\n]/.test(s)) throw new Error(`caminho inválido para o instalador: ${s}`);
  return `"${s}"`;
}

export function innoScript(o: InstallerOptions): string {
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error(`versão inválida: ${o.version}`);
  return [
    '; Gerado por scripts/instalador.ts (npm run empacotar). Não editar à mão.',
    '[Setup]',
    `AppId={{${INSTALLER_APP_ID}}`,
    'AppName=Clurn',
    `AppVersion=${o.version}`,
    'AppVerName=Clurn',
    'AppPublisher=Clurn',
    'AppPublisherURL=https://clurn.app',
    'AppSupportURL=https://clurn.app',
    `VersionInfoVersion=${o.version}`,
    'VersionInfoCompany=Clurn',
    'VersionInfoProductName=Clurn',
    'VersionInfoDescription=Clurn Setup',
    'PrivilegesRequired=lowest',
    'DefaultDirName={autopf}\\Clurn',
    'DisableDirPage=yes',
    'DisableProgramGroupPage=yes',
    'DisableWelcomePage=yes',
    'DisableReadyPage=yes',
    'ShowLanguageDialog=no',
    'ArchitecturesAllowed=x64compatible',
    'ArchitecturesInstallIn64BitMode=x64compatible',
    // Clurn aberto: o instalador pede para fechar (a janela recusa no meio de uma execução, desktop/main.ts)
    'CloseApplications=yes',
    'RestartApplications=no',
    // escuro sempre (o app é escuro), sem as linhas entre as partes, barra de título e bordas no mesmo estilo
    'WizardStyle=modern dark hidebevels includetitlebar',
    `WizardBackColor=${INSTALLER_BG}`,
    `WizardImageBackColor=${INSTALLER_BG}`,
    `WizardSmallImageBackColor=${INSTALLER_BG}`,
    `SetupIconFile=${quoted(o.icon)}`,
    `WizardSmallImageFile=${fileList(o.smallImages)}`,
    `WizardImageFile=${fileList(o.sideImages)}`,
    'UninstallDisplayIcon={app}\\Clurn.exe',
    'UninstallDisplayName=Clurn',
    `OutputDir=${quoted(o.outDir)}`,
    `OutputBaseFilename=Clurn-Setup-${o.version}`,
    'Compression=lzma2/ultra64',
    'SolidCompression=yes',
    '',
    '[Languages]',
    'Name: "en"; MessagesFile: "compiler:Default.isl"',
    'Name: "ptbr"; MessagesFile: "compiler:Languages\\BrazilianPortuguese.isl"',
    '',
    '[Messages]',
    ...Object.entries(INSTALLER_MESSAGES).flatMap(([lang, msgs]) => Object.entries(msgs).map(([k, v]) => `${lang}.${k}=${v}`)),
    '',
    '[Tasks]',
    'Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"',
    '',
    '[Files]',
    `Source: ${quoted(path.join(o.appDir, '*'))}; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    '',
    // AppUserModelID igual ao app.setAppUserModelId('Clurn') de desktop/main.ts: o ícone certo na barra de tarefas
    '[Icons]',
    'Name: "{autoprograms}\\Clurn"; Filename: "{app}\\Clurn.exe"; AppUserModelID: "Clurn"',
    'Name: "{autodesktop}\\Clurn"; Filename: "{app}\\Clurn.exe"; AppUserModelID: "Clurn"; Tasks: desktopicon',
    '',
    '[Run]',
    'Filename: "{app}\\Clurn.exe"; Description: "{cm:LaunchProgram,Clurn}"; Flags: nowait postinstall skipifsilent',
    // atualização pelo próprio app (1.0): ele roda este instalador em silêncio e fecha; aqui o Clurn reabre sozinho
    'Filename: "{app}\\Clurn.exe"; Flags: nowait skipifnotsilent',
    '',
    '[UninstallDelete]',
    ...UNINSTALL_DATA_DIRS.map((d) => `Type: filesandordirs; Name: "${d}"`),
    '',
    // durante a cópia, o Inno mostra o caminho de cada arquivo (com o nome do usuário do Windows): some.
    // Sem a tela "pronto para instalar", a 1ª tela já instala: o botão diz Instalar, não Avançar.
    '[Code]',
    'procedure InitializeWizard;',
    'begin',
    '  WizardForm.FilenameLabel.Visible := False;',
    'end;',
    '',
    'procedure CurPageChanged(CurPageID: Integer);',
    'begin',
    '  if CurPageID = wpSelectTasks then',
    '    WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);',
    'end;',
    '',
  ].join('\r\n');
}

// ISCC.exe (compilador do Inno Setup 6): CLURN_ISCC, ou as pastas onde o instalador oficial e o winget o põem
export function findIscc(env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): string | null {
  const candidates = [
    env.CLURN_ISCC,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Inno Setup 6', 'ISCC.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Inno Setup 6', 'ISCC.exe'),
  ];
  return candidates.find((p): p is string => Boolean(p) && exists(p!)) ?? null;
}
