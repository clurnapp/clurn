// Formato compacto do histórico guardado pelo painel privado (admin/leitor.ts) e lido no navegador (painel/remoto.ts).
//
// Texto puro, um item por ";", só com caracteres [0-9A-Za-z,;!-]. Assim o Worker junta os pedaços e monta a resposta
// por concatenação, sem JSON.parse nem escape (o plano grátis dá 10 ms de processador por pedido). Quem grava confere
// cada campo antes; quem lê pula o item fora do formato, nunca derruba o resto.
//
//   transação da taxa: <assinatura>,<hora em s, base 36>,<lamports recebidos, pode ser negativo>,<hash do destino ou vazio>;
//   atividade (toda assinatura, com ou sem erro): <hora em s, base 36>[!];      ! = deu erro
import type { FeeTx, Seen } from './metricas.ts';

export const SIG = /^[1-9A-HJ-NP-Za-km-z]{32,100}$/;
const DEST = /^[0-9a-f]{16}$/;
const B36 = /^[0-9a-z]{1,10}$/;
export const SAFE = /^[0-9A-Za-z,;!-]*$/;

const secs = (ms: number) => Math.floor(ms / 1000).toString(36);

// null quando algum campo não está no formato (o leitor pula a transação em vez de gravar lixo).
export function encodeTx(x: FeeTx): string | null {
  if (!SIG.test(x.sig) || !Number.isSafeInteger(x.t) || x.t <= 0 || !Number.isSafeInteger(x.fee)) return null;
  if (x.dest !== null && !DEST.test(x.dest)) return null;
  return `${x.sig},${secs(x.t)},${x.fee},${x.dest ?? ''};`;
}

export function encodeSeen(t: number, ok: boolean): string | null {
  return Number.isSafeInteger(t) && t > 0 ? `${secs(t)}${ok ? '' : '!'};` : null;
}

export function decodeTxs(text: string, w: number): FeeTx[] {
  const out: FeeTx[] = [];
  for (const item of text.split(';')) {
    const [sig, t, fee, dest, extra] = item.split(',');
    if (extra !== undefined || !sig || !SIG.test(sig) || !t || !B36.test(t) || !fee || !/^-?\d{1,19}$/.test(fee)) continue;
    if (dest !== '' && (dest === undefined || !DEST.test(dest))) continue;
    const f = Number(fee);
    if (!Number.isSafeInteger(f)) continue;
    out.push({ sig, t: parseInt(t, 36) * 1000, fee: f, dest: dest || null, w });
  }
  return out;
}

export function decodeSeen(text: string, w: number): Seen[] {
  const out: Seen[] = [];
  for (const item of text.split(';')) {
    const err = item.endsWith('!');
    const t = err ? item.slice(0, -1) : item;
    if (!B36.test(t)) continue;
    out.push({ t: parseInt(t, 36) * 1000, ok: !err, w });
  }
  return out;
}
