// Financiamento das taxas entre frases: uma frase sem SOL para as taxas de rede recebe o SOL de uma temporária de
// OUTRA frase da mesma rodada, em vez de a pessoa fazer um depósito por frase.
//
// Regras:
// - Só temporárias emprestam (as chaves que o app tem são só delas); a principal nunca entra.
// - A emprestadora é a pagadora de taxas da outra frase (a temporária com mais SOL dela), e só empresta o que
//   sobra depois de guardar o DOBRO da própria reserva: ela continua pagando a própria limpeza com folga.
// - O valor é o mesmo que o app pediria à pessoa (sendLamports: o que falta na temporária sugerida, com folga); se
//   não sobra tanto, o que falta até a reserva exata da frase que precisa. Menos que isso não resolve: ninguém empresta.
// - A transferência é um passo como qualquer outro: simulada, com o valor exato conferido no destino (a
//   temporária que recebe), e só enviada depois de a pessoa clicar. O SOL emprestado chega à pagadora da outra
//   frase e volta ao destino no fim, pagando a taxa do app uma vez na pagadora que recebe (é SOL esquecido da
//   frase que empresta; só o depósito do cliente é isento).
import type { WalletScan } from './scan.ts';
import { BASE_FEE_LAMPORTS } from './summary.ts';
import type { FeePayerError, Plan } from './plan.ts';

// o envio do empréstimo custa uma assinatura (+ taxa de prioridade no teto): folga de 10× a taxa base
export const FUND_TX_FEE_LAMPORTS = BigInt(BASE_FEE_LAMPORTS) * 10n;
// a emprestadora guarda este múltiplo da própria reserva antes de emprestar
export const LENDER_RESERVE_FACTOR = 2n;

export type Lender = {
  frase: number;
  scans: WalletScan[];
  plan: Plan; // o plano real (depois do /api/plano) ou o de teste da análise: dá a pagadora e a reserva
};

export type FundingOffer = {
  fromFrase: number;
  fromIndex: number;
  from: string;
  toFrase: number;
  toIndex: number;
  to: string;
  lamports: bigint;
};

// quanto a pagadora de uma frase pode emprestar sem comprometer a própria limpeza (0 se nada)
export function spareLamports(l: Lender): bigint {
  const payer = l.scans.find((s) => s.index === l.plan.feePayerIndex && s.address === l.plan.feePayer);
  if (!payer || payer.errors.length) return 0n;
  const spare = BigInt(payer.lamports) - l.plan.reserveNeededLamports * LENDER_RESERVE_FACTOR - FUND_TX_FEE_LAMPORTS;
  return spare > 0n ? spare : 0n;
}

// A oferta para a frase que precisa (need = o erro de falta de SOL dela, com a temporária sugerida e os valores):
// primeiro quem cobre o valor cheio, depois quem cobre só a reserva; entre iguais, quem tem mais sobra.
// A própria frase nunca é candidata. null = ninguém pode emprestar (fica o depósito).
export function fundingOffer(toFrase: number, need: FeePayerError, lenders: Lender[]): FundingOffer | null {
  const tiers = [need.sendLamports, need.reserveLamports].filter((v, i, arr) => v > 0n && arr.indexOf(v) === i);
  const candidates = lenders
    .filter((l) => l.frase !== toFrase)
    .map((l) => ({ l, spare: spareLamports(l) }))
    .filter((c) => c.spare > 0n)
    .sort((a, b) => (a.spare === b.spare ? a.l.frase - b.l.frase : a.spare > b.spare ? -1 : 1));
  for (const amount of tiers) {
    const c = candidates.find((x) => x.spare >= amount);
    if (c) return { fromFrase: c.l.frase, fromIndex: c.l.plan.feePayerIndex, from: c.l.plan.feePayer, toFrase, toIndex: need.walletIndex, to: need.wallet, lamports: amount };
  }
  return null;
}

// Plano de um passo só para o executor: a emprestadora manda `lamports` para a temporária da outra frase.
// destination = a temporária que recebe (o executor confere o valor exato que chega nela); a taxa do app sai no envio final da pagadora que recebe.
export function fundingPlan(offer: FundingOffer): Plan {
  return {
    destination: offer.to,
    feePayerIndex: offer.fromIndex,
    feePayer: offer.from,
    payerOutsideSelection: false,
    steps: [{ kind: 'fund', walletIndex: offer.fromIndex, wallet: offer.from, to: offer.to, toFrase: offer.toFrase, lamports: offer.lamports }],
    kept: [],
    skipped: [],
    reserveNeededLamports: offer.lamports + FUND_TX_FEE_LAMPORTS,
    appFee: null,
  };
}
