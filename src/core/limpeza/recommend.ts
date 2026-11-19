// Recomendação para cada token com saldo. É só sugestão: o usuário confirma ou troca.

import type { TokenDecision } from './plan.ts';
import type { TokenCategory } from './prices.ts';
import type { TokenKind } from './scan.ts';

export const VALUABLE_USD = 1;
// Valor só em SOL (preço pela curva da Pump.fun, sem o preço do SOL em dólar): 0,01 SOL ≈ US$ 1 na faixa de 2026.
export const VALUABLE_SOL = 0.01;

// code: motivo estável, para a tela mostrar o texto no idioma escolhido (why é o texto em português)
export type RecommendationCode = 'nft' | 'known' | 'valuable' | 'no-price' | 'cheap-memecoin' | 'uncertain';
export type Recommendation = { decision: TokenDecision; code: RecommendationCode; why: string };

// valor conhecido por qualquer das duas medidas (dólar pela Jupiter ou pela curva; SOL só pela curva)
const isValuable = (usd: number | null, sol: number | null) => (usd !== null && usd >= VALUABLE_USD) || (sol !== null && sol >= VALUABLE_SOL);
const hasValue = (usd: number | null, sol: number | null) => usd !== null || sol !== null;

export function recommend(kind: TokenKind, category: TokenCategory, usdValue: number | null, solValue: number | null = null): Recommendation {
  if (kind === 'nft') return { decision: 'keep', code: 'nft', why: 'NFT: fica na carteira, a não ser que você peça para enviar' };
  if (category === 'estável' || category === 'cripto conhecida') return { decision: 'transfer', code: 'known', why: `${category}: tem valor real, enviar para o destino` };
  if (isValuable(usdValue, solValue)) return { decision: 'transfer', code: 'valuable', why: `vale US$ ${VALUABLE_USD} ou mais: enviar para o destino` };
  // Sem preço = valor DESCONHECIDO, nunca zero (regra do briefing). Achado da revisão independente:
  // com a API de preços fora do ar, toda memecoin vinha recomendada para queimar sem confirmação.
  if (!hasValue(usdValue, solValue)) return { decision: 'keep', code: 'no-price', why: 'valor desconhecido (sem preço confiável agora): manter até você conferir' };
  if (category === 'memecoin Pump.fun') {
    return { decision: 'burn', code: 'cheap-memecoin', why: 'memecoin que vale menos de US$ 1: queimar e recuperar o aluguel (~0,002 SOL)' };
  }
  return { decision: 'keep', code: 'uncertain', why: 'origem e valor incertos: manter até você decidir' };
}

// Queimar sem confirmação extra só vale para memecoin com preço conhecido e baixo.
export function burnNeedsExtraConfirmation(category: TokenCategory, usdValue: number | null, solValue: number | null = null): boolean {
  return category !== 'memecoin Pump.fun' || !hasValue(usdValue, solValue) || isValuable(usdValue, solValue);
}

// Botão "Queimar todos": só o que não tem valor conhecido (lista fechada de motivos).
// NFT, estável, cripto conhecida e token que vale US$ 1 ou mais nunca entram; motivo novo também não, até alguém incluir aqui.
export function inBurnAll(code: RecommendationCode): boolean {
  return code === 'no-price' || code === 'cheap-memecoin' || code === 'uncertain';
}

// Token cuja consulta de preços falhou (Jupiter fora do ar ou no limite, mesmo depois das novas tentativas) e que a
// rede (curva ou pool da Pump.fun) não precificou: valor desconhecido, como qualquer token sem preço. Fica em "Manter"
// e só queima com a palavra de confirmação (burnNeedsExtraConfirmation), token a token. Não há mais trava de queimar:
// até a 0.1.3 a falha desligava queimar da rodada inteira, e um tester (31/10/2026, 470 tokens) ficou sem opção.
export function priceLookupFailed(prices: { unresolved: Set<string> }, mint: string): boolean {
  return prices.unresolved.has(mint);
}
