// Taxa do app (decisão do autor, 30/10/2026): 11% do SOL recuperado vai para a carteira dele.
//
// Entra em toda transação que entrega SOL ao destino, na MESMA transação: 89% destino, 11% esta carteira.
// Não entra: no que o cliente depositou na pagadora para as taxas de rede (plan.payerExemptLamports; o SOL esquecido
// nela paga, regra de 31/10/2026), em tokens e NFTs enviados, e quando o destino é a própria carteira da taxa.
// Quem lê o código consegue tirar a taxa: sabido e aceito (CLAUDE.md, seção 3).
//
// Carteira de 09/11/2026 (v0.2.5), criada sem histórico. Precisa ter sempre pelo menos ~0,001 SOL: as fatias da taxa (ex.: 0,000224 por
// conta fechada) ficam abaixo do mínimo para uma conta existir, e com ela zerada a transação do cliente falha.
// Nunca esvaziar por completo.

export const APP_FEE_WALLET = 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL';
export const APP_FEE_BPS = 1_100n; // 11%, em centésimos de por cento

export type AppFee = { wallet: string; bps: bigint };

// destino = carteira da taxa: sem taxa
export function appFeeFor(destination: string, wallet = APP_FEE_WALLET, bps = APP_FEE_BPS): AppFee | null {
  return destination === wallet ? null : { wallet, bps };
}

// parte da taxa, arredondada para baixo (o cliente nunca paga a mais)
export function appFeeLamports(amount: bigint, fee: AppFee | null | undefined): bigint {
  if (!fee || amount <= 0n) return 0n;
  return (amount * fee.bps) / 10_000n;
}
