// Ponte mínima entre a página e a janela do Electron: só avisa o tema, para a barra da janela ter a mesma cor.
// A página não recebe acesso ao Node nem ao Electron (contextIsolation + sandbox).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clurnDesktop', {
  setTheme: (theme) => {
    if (theme === 'dark' || theme === 'light') ipcRenderer.send('clurn:tema', theme);
  },
});

// classe no <html>: o CSS do cabeçalho vira barra da janela (arrastar, espaço para os botões do Windows)
window.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('desktop'));
