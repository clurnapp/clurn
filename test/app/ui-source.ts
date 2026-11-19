// Página do app lida pelos testes de tela (não é um teste: o npm test só roda *.test.ts).
// Os testes avaliam trechos do script da página sozinhos, sem navegador.
import fs from 'node:fs';
import path from 'node:path';

export const HTML = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'app', 'ui', 'index.html'), 'utf8');
export const SCRIPT = HTML.slice(HTML.lastIndexOf('<script>'));

// fim de uma função de topo: a primeira "}" sozinha numa linha depois de `from`, com LF ou CRLF (checkout no Windows)
// at = começo da quebra de linha antes da "}"; end = logo depois da "}"
export function closingBrace(from: number, src = SCRIPT): { at: number; end: number } | null {
  const re = /\r?\n\}\r?\n/g;
  re.lastIndex = from;
  const m = re.exec(src);
  return m ? { at: m.index, end: m.index + m[0].indexOf('}') + 1 } : null;
}

// código de uma função de topo do script, inteiro (do "function nome(" até a "}" final)
export function fnSource(name: string): string {
  const start = SCRIPT.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`função ${name} não achada na página`);
  const end = closingBrace(start)?.end;
  if (!end) throw new Error(`fim da função ${name} não achado`);
  return SCRIPT.slice(start, end);
}
