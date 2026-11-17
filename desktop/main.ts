// App de desktop (Electron): janela própria com o cabeçalho do Clurn como barra da janela.
// Sobe o mesmo servidor local do `npm start` (src/app/server.ts) como processo filho e abre a página dele.
// A frase continua só no processo do servidor; fechar a janela encerra o servidor e as chaves somem com ele.
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { blockedKey, editMenu, isAppUrl, isExternalLink, parseServerUrl, permissionAllowed, TITLE_BAR, TITLE_BAR_HEIGHT } from './regras.ts';

const ROOT = path.join(import.meta.dirname, '..');
const SERVER = path.join(ROOT, 'src', 'app', 'server.ts');
const ICON = path.join(import.meta.dirname, 'clurn-icone.ico');

let server: ChildProcess | null = null;
let quitting = false;

function startServer(): Promise<string> {
  return new Promise((resolve, reject) => {
    // --empacotado: só a cópia instalada consulta versão nova (src/app/atualizacao.ts); o `npm run desktop` não
    const child = spawn(process.execPath, [SERVER, '--sem-navegador', ...(app.isPackaged ? ['--empacotado'] : [])], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server = child;
    let out = '';
    let found = false;
    const timer = setTimeout(() => reject(new Error('O servidor local não respondeu em 30 s.')), 30_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (found) return;
      out += chunk;
      const url = parseServerUrl(out);
      if (url) {
        found = true;
        clearTimeout(timer);
        out = '';
        resolve(url);
      }
    });
    child.stderr.pipe(process.stderr); // o stack de uma tarefa que falhou sai aqui (visível com `npm run desktop` num terminal)
    child.on('exit', (code) => {
      server = null;
      clearTimeout(timer);
      if (quitting) return;
      if (code === 0) app.quit(); // "Encerrar" na página, ou o servidor encerrou sozinho
      else {
        dialog.showErrorBox('Clurn', `O servidor local parou (código ${code}). Abra o Clurn de novo.`);
        app.quit();
      }
    });
  });
}

// encerra pelo próprio servidor (ele recusa no meio da execução); sem servidor, só fecha
async function askServerToClose(base: string): Promise<'ok' | 'running' | 'gone'> {
  const token = new URL(base).hash.slice(1);
  try {
    const res = await fetch(new URL('/api/encerrar', base), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': token },
      body: '{}',
    });
    return res.ok ? 'ok' : res.status === 400 ? 'running' : 'gone';
  } catch {
    return 'gone';
  }
}

function lockDown(win: BrowserWindow, base: string) {
  // Chromium só fala com o servidor local; nada de rede externa por dentro da janela
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !isAppUrl(details.url, base) && !details.url.startsWith('devtools:') }));
  // só copiar para a área de transferência, e só a página do app (desktop/regras.ts); o resto negado
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => cb(permissionAllowed(permission, details.requestingUrl, base)));
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url, base)) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

// cara de app, não de navegador (desktop/regras.ts): sem atalhos de navegador, sem zoom, menu de edição no botão direito
function behaveLikeApp(win: BrowserWindow) {
  const wc = win.webContents;
  wc.on('before-input-event', (e, input) => {
    if (blockedKey(input)) e.preventDefault();
  });
  wc.on('zoom-changed', () => wc.setZoomLevel(0)); // Ctrl + roda do mouse
  wc.on('did-finish-load', () => {
    wc.setZoomLevel(0);
    void wc.setVisualZoomLevelLimits(1, 1); // pinça do touchpad
  });
  wc.on('context-menu', (_e, params) => {
    const items = editMenu(params, app.getLocale());
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });
}

async function createWindow() {
  const base = await startServer();
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: 'Clurn',
    icon: ICON,
    backgroundColor: TITLE_BAR.dark.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLE_BAR.dark, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  lockDown(win, base);
  behaveLikeApp(win);

  ipcMain.on('clurn:tema', (e, theme: unknown) => {
    if (e.sender !== win.webContents || (theme !== 'dark' && theme !== 'light')) return;
    win.setTitleBarOverlay({ ...TITLE_BAR[theme], height: TITLE_BAR_HEIGHT });
    win.setBackgroundColor(TITLE_BAR[theme].color);
  });

  let closing = false;
  win.on('close', (e) => {
    if (closing) return;
    e.preventDefault();
    void askServerToClose(base).then(async (r) => {
      if (r === 'running') {
        await dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Clurn',
          message: 'A execução está em andamento.',
          detail: 'Espere terminar antes de fechar. Fechar agora deixaria transações sem confirmação.',
        });
        return;
      }
      closing = true;
      win.close();
    });
  });

  win.once('ready-to-show', () => win.show());
  await win.loadURL(base);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setAppUserModelId('Clurn');
  Menu.setApplicationMenu(null);
  app.on('second-instance', () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    server?.kill(); // garante: processo do servidor encerrado, chaves fora da memória
  });
  app.whenReady().then(createWindow).catch((e: unknown) => {
    dialog.showErrorBox('Clurn', e instanceof Error ? e.message : String(e));
    app.quit();
  });
}
