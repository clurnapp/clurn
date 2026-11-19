// Leitura de uma transação da carteira da taxa (painel local e Worker do painel privado). Fica fora de metricas.ts
// porque usa node:crypto (o hash do destino), e metricas.ts também roda no navegador.
//
// Privacidade: o destino de cada limpeza (a carteira que recebeu os 89%) sai daqui só como hash curto, nunca o endereço.
import crypto from 'node:crypto';
import type { FeeTx } from './metricas.ts';

export const MIN_DEST_RATIO = 7;
export const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Lê uma transação do getTransaction (encoding json). null se não for da carteira, tiver erro ou vier fora do formato.
export function parseFeeTx(sig: string, tx: unknown, feeWallet: string): FeeTx | null {
  try {
    const t = tx as any;
    if (!t?.meta || t.meta.err || typeof t.blockTime !== 'number') return null;
    const msgKeys: unknown[] = t.transaction?.message?.accountKeys ?? [];
    const keys = [...msgKeys, ...(t.meta.loadedAddresses?.writable ?? []), ...(t.meta.loadedAddresses?.readonly ?? [])].map((k) => (typeof k === 'string' ? k : (k as any)?.pubkey));
    const pre: unknown[] = t.meta.preBalances;
    const post: unknown[] = t.meta.postBalances;
    if (!Array.isArray(pre) || !Array.isArray(post) || pre.length !== post.length) return null;
    const at = keys.indexOf(feeWallet);
    if (at < 0 || typeof pre[at] !== 'number' || typeof post[at] !== 'number') return null;
    const fee = (post[at] as number) - (pre[at] as number);
    // destino: a conta (fora a da taxa) que mais recebeu SOL nesta transação
    let best = -1;
    let gain = 0;
    for (let i = 0; i < keys.length && i < pre.length; i++) {
      const d = (post[i] as number) - (pre[i] as number);
      if (i !== at && typeof keys[i] === 'string' && Number.isFinite(d) && d > gain) {
        gain = d;
        best = i;
      }
    }
    // limpeza paga: o destino recebe 89% e a taxa 11% (8,09 vezes a taxa; mais, se o depósito do cliente volta junto).
    // Menos que MIN_DEST_RATIO vezes não é limpeza (poeira de envenenamento de endereço, depósito com troco).
    const paid = fee > 0 && best >= 0 && gain >= MIN_DEST_RATIO * fee;
    return { sig, t: t.blockTime * 1000, fee, dest: paid ? shortHash(keys[best] as string) : null };
  } catch {
    return null;
  }
}
