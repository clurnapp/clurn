// Resumo da varredura: o que dá para recuperar e o que depende de escolha do usuário.
// Valores em lamports (1 SOL = 1_000_000_000 lamports).

import { tokenValue, type Price } from './prices.ts';
import { totalCreatorFeeLamports, type TokenAccount, type WalletScan } from './scan.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const BASE_FEE_LAMPORTS = 5_000; // taxa por assinatura
export const ACCOUNTS_PER_TX = 15; // contas fechadas por transação (estimativa do briefing: 10 a 20)

// usd: pela Jupiter ou pela curva da Pump.fun; sol: só pela curva (vale mesmo sem o preço do SOL em dólar)
export type ValuedToken = TokenAccount & { wallet: string; walletIndex: number; usd: number | null; sol: number | null };

export type WalletSummary = {
  index: number;
  address: string;
  solLamports: number;
  closable: number; // contas vazias que dá para fechar
  closableRentLamports: number;
  creatorFeeLamports: bigint;
  txEstimate: number;
  pendingChoice: number; // tokens com saldo, NFTs: o usuário decide
  blocked: number;
  errors: string[];
};

export type Summary = {
  wallets: WalletSummary[];
  totals: {
    solLamports: number;
    closable: number;
    closableRentLamports: number;
    creatorFeeLamports: bigint;
    feeEstimateLamports: number;
    recoverableLamports: bigint; // SOL + aluguel + creator fees − taxas de rede
  };
  tokensWithBalance: ValuedToken[]; // ordenados por valor (desconhecido no fim)
  nfts: ValuedToken[];
  blocked: ValuedToken[];
  walletsWithErrors: number;
  feesDetailed: boolean;
};

export function summarize(scans: WalletScan[], prices: Map<string, Price>): Summary {
  const wallets: WalletSummary[] = [];
  const tokensWithBalance: ValuedToken[] = [];
  const nfts: ValuedToken[] = [];
  const blocked: ValuedToken[] = [];
  let feesDetailed = scans.length > 0;

  for (const s of scans) {
    let closable = 0;
    let closableRent = 0;
    let pendingChoice = 0;
    let blockedCount = 0;
    for (const t of s.tokens) {
      const v: ValuedToken = { ...t, wallet: s.address, walletIndex: s.index, ...tokenValue(prices, t) };
      if (t.blockers.length > 0 || t.kind === 'invalid') {
        blocked.push(v);
        blockedCount++;
        continue;
      }
      if (t.kind === 'empty' || t.kind === 'wsol') {
        // WSOL: fechar a conta devolve o saldo embrulhado + aluguel
        closable++;
        closableRent += t.rentLamports;
      } else if (t.kind === 'nft') {
        nfts.push(v);
        pendingChoice++;
      } else {
        tokensWithBalance.push(v);
        pendingChoice++;
      }
    }
    // cofres + fee parada que o app varre e coleta; a parte que ele não coleta (unswept*) fica fora
    // (achado da revisão); carteira com erro fica fora
    const creatorFeeLamports = s.fees && !s.errors.length ? totalCreatorFeeLamports(s.fees) : 0n;
    if (!s.fees?.detailed) feesDetailed = false;
    const txEstimate = Math.ceil(closable / ACCOUNTS_PER_TX) + (creatorFeeLamports > 0n ? 1 : 0) + (s.lamports > 0 || closable > 0 ? 1 : 0);
    wallets.push({
      index: s.index,
      address: s.address,
      solLamports: s.lamports,
      closable,
      closableRentLamports: closableRent,
      creatorFeeLamports,
      txEstimate,
      pendingChoice,
      blocked: blockedCount,
      errors: s.errors,
    });
  }

  const sum = (f: (w: WalletSummary) => number) => wallets.reduce((a, w) => a + f(w), 0);
  const solLamports = sum((w) => w.solLamports);
  const closableRentLamports = sum((w) => w.closableRentLamports);
  const creatorFeeLamports = wallets.reduce((a, w) => a + w.creatorFeeLamports, 0n);
  const feeEstimateLamports = sum((w) => w.txEstimate) * BASE_FEE_LAMPORTS;
  const gross = BigInt(solLamports + closableRentLamports) + creatorFeeLamports;
  const net = gross - BigInt(feeEstimateLamports);

  tokensWithBalance.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  return {
    wallets,
    totals: {
      solLamports,
      closable: sum((w) => w.closable),
      closableRentLamports,
      creatorFeeLamports,
      feeEstimateLamports,
      recoverableLamports: net > 0n ? net : 0n,
    },
    tokensWithBalance,
    nfts,
    blocked,
    walletsWithErrors: wallets.filter((w) => w.errors.length > 0).length,
    feesDetailed,
  };
}

export function formatSol(lamports: number | bigint, digits = 6): string {
  const l = BigInt(lamports);
  const neg = l < 0n;
  const abs = neg ? -l : l;
  const whole = abs / BigInt(LAMPORTS_PER_SOL);
  const frac = (abs % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, '0').slice(0, digits);
  return `${neg ? '-' : ''}${whole},${frac}`;
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole},${frac}` : whole;
}
