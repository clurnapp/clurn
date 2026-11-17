// Juntar o SOL das temporárias de UMA frase: a frase tem SOL para as taxas, mas espalhado em dezenas de
// carteiras, e nenhuma sozinha cobre a reserva da pagadora (visto na mainnet em 31/10/2026: 0,0775 SOL em 98
// temporárias, nenhuma acima da reserva). Em vez de pedir depósito, as temporárias mandam o SOL delas para a mais
// rica, que vira a pagadora de todas.
//
// Regras:
// - Só temporárias da própria frase (as chaves que o app tem); a principal nunca entra. A mais rica sem erro de
//   leitura recebe; as outras mandam, da mais rica para a mais pobre, só o que falta.
// - Cada remetente paga a própria taxa da transação (a pagadora ainda não tem SOL), com folga de
//   GATHER_TX_FEE_LAMPORTS.
// - Aluguel mínimo da rede (aprendido na devnet em 31/10/2026): uma conta fica com 0 SOL ou com pelo menos o aluguel
//   de conta vazia; no meio do caminho a rede recusa (InsufficientFundsForRent). Por isso cada remetente ou manda só o
//   excedente acima do aluguel (fica com o aluguel), ou manda TUDO (fica com 0; o valor exato sai na hora do envio,
//   com a taxa real). Mandar tudo só vale para temporária sem conta de token e sem creator fee: ela não tem mais nada
//   para limpar depois. As outras só mandam o excedente.
// - Só temporárias da própria frase; `exclude` tira endereços que nunca podem mandar (a principal).
// - O alvo é o saldo que o pedido à pessoa deixaria na pagadora (sendLamports + o que a sugerida já tem); se a frase
//   inteira não tem tanto, a reserva exata. Menos que isso não resolve: ninguém manda (fica o depósito, ou o empréstimo de outra
//   frase: funding.ts).
// - Cada transferência é um passo como qualquer outro: simulada, com o valor exato conferido na pagadora, e só
//   enviada depois de a pessoa clicar. O SOL juntado fica na pagadora e, como todo SOL dela, volta inteiro ao
//   destino no fim e paga a taxa do app uma vez, como todo SOL recuperado (decisão de 31/10/2026, c91e728).
import { totalCreatorFeeLamports, type WalletScan } from './scan.ts';
import { BASE_FEE_LAMPORTS } from './summary.ts';
import type { FeePayerError, Plan } from './plan.ts';

// cada envio custa uma assinatura (+ taxa de prioridade no teto): folga de 10× a taxa base
export const GATHER_TX_FEE_LAMPORTS = BigInt(BASE_FEE_LAMPORTS) * 10n;

// Desligado da 0.1.4 à 0.1.6 (decisão do autor, 31/10/2026): na devnet a remetente podia ficar entre 0 e o aluguel
// mínimo e a rede recusava. Religado com a correção (excedente ou tudo, abaixo). Desligado, o servidor não oferece,
// /api/juntar responde 400, a página não mostra o bloco e o terminal não dá a dica.
export const GATHER_ENABLED = true;

// all: manda tudo (fica com 0); lamports é então a estimativa (saldo − folga da taxa): o envio de verdade é maior ou igual
export type GatherTransfer = { fromIndex: number; from: string; lamports: bigint; all: boolean };
export type GatherOffer = {
  toIndex: number;
  to: string;
  lamports: bigint; // soma das transferências (as de "tudo" pela estimativa)
  transfers: GatherTransfer[];
};

// saldo que vale: leitura sem erro e número são (dado fora do formato conta como 0)
function cleanLamports(s: WalletScan): bigint {
  if (s.errors.length || typeof s.lamports !== 'number' || !Number.isFinite(s.lamports) || s.lamports < 0) return 0n;
  return BigInt(Math.floor(s.lamports));
}

// sem conta de token nem creator fee: depois de mandar tudo, não sobra nada para limpar nela
const nothingElse = (s: WalletScan) => s.tokens.length === 0 && !(s.fees && totalCreatorFeeLamports(s.fees) > 0n);

// A oferta para a frase que precisa (need = o erro de falta de SOL dela): quem recebe, quem manda e quanto.
// null = juntando tudo não chega nem na reserva (fica o depósito).
export function gatherOffer(scans: WalletScan[], need: FeePayerError, rentExemptZero: number, exclude: string[] = []): GatherOffer | null {
  const rent = BigInt(Math.max(0, Math.floor(rentExemptZero)));
  const ranked = scans
    .filter((s) => !exclude.includes(s.address))
    .map((s) => ({ s, lamports: cleanLamports(s) }))
    .filter((x) => x.lamports > 0n)
    .sort((a, b) => (a.lamports === b.lamports ? a.s.index - b.s.index : a.lamports > b.lamports ? -1 : 1));
  const target = ranked[0];
  if (!target) return null;
  const senders = ranked
    .slice(1)
    .map((x) => ({ ...x, excess: x.lamports - GATHER_TX_FEE_LAMPORTS - rent, everything: nothingElse(x.s) ? x.lamports - GATHER_TX_FEE_LAMPORTS : 0n }))
    .filter((x) => x.excess > 0n || x.everything > 0n);
  const tiers = [need.sendLamports, need.reserveLamports].filter((v, i, arr) => v > 0n && arr.indexOf(v) === i);
  for (const tier of tiers) {
    // o pedido é o que falta na temporária sugerida (que já tem haveLamports): o saldo-alvo da pagadora é a soma
    const goal = tier + need.haveLamports;
    let missing = goal - target.lamports;
    if (missing <= 0n) return null; // a mais rica já cobre: o plano monta sem juntar nada
    const transfers: GatherTransfer[] = [];
    for (const x of senders) {
      if (missing <= 0n) break;
      // o excedente acima do aluguel basta: manda só o que falta (ela continua com o aluguel e o resto)
      if (x.excess >= missing) {
        transfers.push({ fromIndex: x.s.index, from: x.s.address, lamports: missing, all: false });
        missing = 0n;
      } else if (x.everything > 0n) {
        transfers.push({ fromIndex: x.s.index, from: x.s.address, lamports: x.everything, all: true });
        missing -= x.everything;
      } else {
        transfers.push({ fromIndex: x.s.index, from: x.s.address, lamports: x.excess, all: false });
        missing -= x.excess;
      }
    }
    if (missing <= 0n) return { toIndex: target.s.index, to: target.s.address, lamports: transfers.reduce((a, t) => a + t.lamports, 0n), transfers };
  }
  return null;
}

// Plano só de juntar, para o executor: cada remetente manda o seu valor para a pagadora (o "destino" deste plano,
// que o executor confere exato); o remetente paga a própria taxa de rede; a taxa do app sai uma vez, no envio ao destino.
export function gatherPlan(offer: GatherOffer): Plan {
  return {
    destination: offer.to,
    feePayerIndex: offer.toIndex,
    feePayer: offer.to,
    payerOutsideSelection: false,
    steps: offer.transfers.map((t) => ({ kind: 'gather' as const, walletIndex: t.fromIndex, wallet: t.from, to: offer.to, lamports: t.lamports, all: t.all })),
    kept: [],
    skipped: [],
    reserveNeededLamports: 0n,
    appFee: null,
  };
}
