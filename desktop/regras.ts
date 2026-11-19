// Regras do app de desktop sem depender do Electron (testadas em test/desktop/desktop.test.ts).

// cores da barra (botões minimizar/maximizar/fechar) iguais ao --bg e --text de cada tema da página
export const TITLE_BAR = {
  dark: { color: '#13121A', symbolColor: '#E6E3EE' },
  light: { color: '#F5F4F9', symbolColor: '#1E1B2B' },
} as const;
export const TITLE_BAR_HEIGHT = 40;

// o servidor imprime o endereço com o código de acesso; só este processo lê (nunca vai para log)
export function parseServerUrl(output: string): string | null {
  return /http:\/\/127\.0\.0\.1:\d{1,5}\/#[0-9a-f]{16,}/.exec(output)?.[0] ?? null;
}

// a janela só mostra o próprio servidor; qualquer outro endereço (links do Solscan) vai para o navegador do sistema
export function isAppUrl(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}
// Permissões que a janela pode pedir ao Chromium: só escrever na área de transferência (o botão "Copiar" dos
// endereços usa navigator.clipboard.writeText, que no Electron passa por esta permissão), e só vindo da página
// do app. Câmera, microfone, localização, notificações, ler a área de transferência etc.: negadas.
export function permissionAllowed(permission: string, requestingUrl: string, base: string): boolean {
  return permission === 'clipboard-sanitized-write' && isAppUrl(requestingUrl, base);
}
// só os exploradores para onde a página aponta (transações e endereços); o resto é ignorado
export const EXPLORERS = ['solscan.io', 'etherscan.io', 'basescan.org', 'bscscan.com', 'arbiscan.io', 'polygonscan.com'];
// suporte oficial no Telegram (16/11/2026): só este endereço exato abre; outro t.me (de um golpista que conseguisse
// pôr um link na página) não sai do app
export const SUPPORT_URL = 'https://t.me/clurnapp';
// compartilhar o resultado (18/11/2026): só a tela de escrever post do X, só com o texto (sem outro parâmetro)
export const SHARE_URL = 'https://x.com/intent/post';
export function isExternalLink(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
    if (u.hostname === 't.me') return u.pathname.replace(/\/$/, '') === '/clurnapp' && u.search === '' && u.hash === '';
    if (u.hostname === 'x.com') return u.pathname === '/intent/post' && u.hash === '' && [...u.searchParams.keys()].join() === 'text' && (u.searchParams.get('text') ?? '').length <= 1000;
    return EXPLORERS.includes(u.hostname);
  } catch {
    return false;
  }
}

// o que entra no app empacotado (npm run empacotar), caminho relativo à raiz com "/" no começo ("" é a raiz).
// Lista do que ENTRA: relatório, frase de teste ou arquivo novo na raiz nunca vai junto por engano.
// Os comandos de terminal ficam de fora: a versão dos amigos não tem como exportar chave (npm run chave).
export const CLI_FORA_DO_APP = ['chave.ts', 'limpar.ts', 'scan.ts'];
// O RPC embutido (src/app/rpc-embutido.json, com a chave do Helius) nunca é copiado da pasta do projeto: o
// empacotamento grava um novo dentro da cópia, a partir de CLURN_RPC_URL (scripts/empacotar.ts). Um arquivo velho
// esquecido na pasta não vai junto por engano.
export const EMBEDDED_RPC_PATH = '/src/app/rpc-embutido.json';
export function includedInPackage(p: string): boolean {
  if (p === '') return true;
  if (!/^\/(package\.json$|desktop(\/|$)|src(\/|$))/.test(p)) return false;
  if (p === EMBEDDED_RPC_PATH) return false;
  return !CLI_FORA_DO_APP.some((f) => p === `/src/cli/${f}`);
}

// ---------- cara de app, não de navegador (pedido do autor, 09/11/2026) ----------

// Atalhos de navegador que a janela ignora: recarregar (perderia a análise e a frase colada no meio do caminho),
// zoom, ferramentas de desenvolvedor, imprimir, salvar, abrir, ver código, voltar/avançar. Copiar, colar, recortar,
// desfazer e selecionar tudo continuam (a frase e o endereço são colados).
export type KeyInput = { type: string; key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean };
export function blockedKey(i: KeyInput): boolean {
  if (i.type !== 'keyDown' && i.type !== 'rawKeyDown') return false;
  const key = i.key.toLowerCase();
  if (['f5', 'f12', 'browserback', 'browserforward', 'browserrefresh'].includes(key)) return true;
  if (i.alt && !i.control && !i.meta && (key === 'arrowleft' || key === 'arrowright')) return true; // voltar/avançar
  const mod = i.control || i.meta;
  if (!mod) return false;
  if (['=', '+', '-', '_', '0'].includes(key)) return true; // zoom (o teclado numérico também chega como "+", "-" e "0")
  if (['r', 'p', 's', 'o', 'u'].includes(key)) return true; // recarregar, imprimir, salvar, abrir, ver código
  if (i.shift && ['i', 'j', 'c'].includes(key)) return true; // ferramentas de desenvolvedor
  return false;
}

// Menu do botão direito: só o de edição, do jeito de um app do Windows. Em campo de texto: recortar, copiar, colar,
// selecionar tudo (cada um só quando dá). Fora de campo, com texto selecionado: copiar. Resto: nenhum menu
// (nada de "Inspecionar", "Voltar" ou "Salvar imagem como").
export type ContextParams = { isEditable: boolean; selectionText: string; editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean } };
export type EditItem = { role: 'cut' | 'copy' | 'paste' | 'selectAll'; label: string; enabled: boolean } | { type: 'separator' };
const EDIT_LABELS = {
  pt: { cut: 'Recortar', copy: 'Copiar', paste: 'Colar', selectAll: 'Selecionar tudo' },
  en: { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all' },
} as const;
export function editMenu(p: ContextParams, locale: string): EditItem[] {
  const l = EDIT_LABELS[/^pt\b/i.test(locale) ? 'pt' : 'en'];
  if (p.isEditable) {
    return [
      { role: 'cut', label: l.cut, enabled: p.editFlags.canCut },
      { role: 'copy', label: l.copy, enabled: p.editFlags.canCopy },
      { role: 'paste', label: l.paste, enabled: p.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: l.selectAll, enabled: p.editFlags.canSelectAll },
    ];
  }
  return p.selectionText.trim() ? [{ role: 'copy', label: l.copy, enabled: true }] : [];
}
