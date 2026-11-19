// getProgramAccounts pelo RPC público quando o RPC próprio recusa.
//
// O Helius recusa getProgramAccounts com filtro no programa da Pump.fun: "Too many accounts requested (10000001
// pubkeys), Please use getProgramAccountsV2 with pagination". O V2 paginado não serve: com filtro ele varre o programa
// inteiro, 10 mil contas por página, ~0,23 s e ~1 crédito por página, e passou de 60 páginas sem terminar (medido com a
// chave do app em 31/10/2026, docs/aprendizados.md): ~1.000 páginas e ~1.000 créditos por busca, uma por carteira.
// Então SÓ essa consulta vai para o RPC público (que aceita, com o limite dele); leituras, simulação e envio continuam
// no RPC próprio. A primeira recusa liga o desvio para o resto da rodada.

import { RpcError, type RpcClient } from './rpc.ts';

const GPA_REFUSED = /getProgramAccountsV2|Too many accounts requested/i;

export function isGpaRefusal(e: unknown): boolean {
  return e instanceof Error && GPA_REFUSED.test(e.message);
}

// `fallback` é criado só na primeira recusa (rodada que nunca precisa dele não abre outro cliente).
// Falha do RPC público nesta busca vira erro comum (não fatal): a busca da fee parada é um extra por carteira e o
// scan a marca só naquela carteira; um erro "fatal" pausaria ou trocaria a rodada inteira, com o RPC próprio vivo.
export function withGpaFallback(own: RpcClient, fallback: () => RpcClient, onSwitch?: () => void): RpcClient {
  let alt: RpcClient | null = null;
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      if (method !== 'getProgramAccounts') return own.call<T>(method, params);
      if (alt) return viaAlt<T>(alt, method, params);
      try {
        return await own.call<T>(method, params);
      } catch (e) {
        if (!isGpaRefusal(e)) throw e;
        alt = fallback();
        try {
          onSwitch?.();
        } catch {
          // aviso é só informação
        }
        return viaAlt(alt, method, params);
      }
    },
  };
  async function viaAlt<T>(c: RpcClient, method: string, params: unknown[]): Promise<T> {
    try {
      return await c.call<T>(method, params);
    } catch (e) {
      throw new RpcError(`${method} pelo RPC público: ${e instanceof Error ? e.message : 'erro'}`, -32000);
    }
  }
}
