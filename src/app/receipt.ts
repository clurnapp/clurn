// Recibo do "tem certeza?": agrupa o que vai para o destino, o que é queimado, o que fica e o que falharia.
// Função pura (sem RPC, sem tela). Guarda só o número da carteira: o rótulo ("N=3", "Conta 4") é da página.

import { blockerCode, explainError, type ErrorCode, type Explained } from '../core/limpeza/errors.ts';
import type { CardApp } from '../core/carteiras/derivation.ts';
import { FEE_SHARING_SKIP, type StepResult } from '../core/limpeza/executor.ts';
import type { KeptToken, Plan, Step, TokenAction } from '../core/limpeza/plan.ts';
import { BASE_FEE_LAMPORTS } from '../core/limpeza/summary.ts';
import { appFeeLamports } from '../core/limpeza/app-fee.ts';

export type ReceiptToken = { walletIndex: number; account: string; mint: string; symbol: string | null; amount: bigint; decimals: number; usdValue: number | null; solValue: number | null };
export type KeptReason = 'nft' | 'kept-by-choice' | ErrorCode;
// toDestination: o que foi ENCONTRADO por categoria, em BRUTO (antes dos 11%): SOL solto (já sem o que a pagadora gasta
// em taxas de rede e aluguéis), aluguel das contas fechadas e creator fees. Regra que a tela Confirmar mostra:
// looseSolLamports + closedRentLamports + claimLamports + depositLamports − appFeeLamports = totalLamports (achado de
// 31/10/2026: as linhas misturavam bruto e líquido e a tela descontava as taxas de novo, então não somavam o total).
// depositLamports: o SOL que a pessoa DEPOSITOU para as taxas e que volta no envio final da pagadora. Não é dinheiro
// encontrado (pedido do autor, 31/10/2026: "só deve aparecer a quantidade que vai realmente ser enviada, e mostrar
// quanto foi encontrado"): antes entrava somado no SOL solto, e quem depositou 0,01 via esse 0,01 como achado.
export type Receipt = {
  toDestination: { closedAccounts: number; closedRentLamports: bigint; claims: number; claimLamports: bigint; tokens: ReceiptToken[]; looseSolLamports: bigint; depositLamports: bigint };
  burned: ReceiptToken[];
  kept: Array<ReceiptToken & { reasonCode: KeptReason; reason: string }>;
  failed: Array<{ walletIndex: number; description: string; error: Explained }>;
  // coletas que a simulação pulou porque a fee da carteira é dividida (fee sharing): o app não coleta, a tela avisa
  feeSharing: number[];
  totalLamports: bigint; // o que chega ao destino, já sem a taxa do app
  appFeeLamports: bigint; // taxa do app (11%), somada dos passos simulados
  appFeeWallet: string | null; // null = sem taxa (destino = carteira da taxa)
  feeEstimateLamports: bigint; // taxas de rede e aluguéis que a pagadora gasta: informativo, já fora do SOL solto
  feePayerIndex: number;
  destination: string;
  destinationIsMain: boolean;
};
export type ReceiptHolding = { account: string; symbol: string | null; usdValue: number | null; solValue?: number | null };

// coletas: na Pump.fun, creator fee da curva, do PumpSwap, a parte desta carteira numa fee dividida (fee sharing) e o
// cashback de quem negociou; na Meteora DBC, a creator fee dos pools em que a carteira é creator (mesma linha
// "Creator fees e cashback" da Confirmar); no Raydium LaunchLab, o cofre de creator fee da carteira
const isClaim = (s: Step): s is Extract<Step, { kind: 'claim-curve' | 'claim-amm' | 'claim-shared' | 'claim-cashback' | 'claim-dbc' | 'claim-launchlab' }> =>
  s.kind === 'claim-curve' || s.kind === 'claim-amm' || s.kind === 'claim-shared' || s.kind === 'claim-cashback' || s.kind === 'claim-dbc' || s.kind === 'claim-launchlab';

function keptReasonCode(t: KeptToken): KeptReason {
  if (t.kind === 'nft') return 'nft';
  if (t.reason === 'você escolheu manter') return 'kept-by-choice';
  return blockerCode(t.reason);
}

// executed: recibo do que FOI enviado (tela final, achado de um tester em 31/10/2026: a coleta chegou e o relatório
// não dizia). Conta os passos 'enviado' em vez dos 'simulado', e sem os dois ajustes da simulação: a fee liberada
// pela varredura já está na coleta real (que mede o cofre cheio) e o envio final da pagadora já leu o saldo real.
export function buildReceipt(input: { plan: Plan; simResults: StepResult[]; holdings: ReceiptHolding[]; main: string | null; executed?: boolean }): Receipt {
  const { plan, simResults, main } = input;
  const counted: StepResult['status'] = input.executed ? 'enviado' : 'simulado';
  const holdings = new Map(input.holdings.map((h) => [h.account, h]));
  // sem holding (ou sem preço) = null: "valor desconhecido", nunca zero
  const token = (walletIndex: number, a: { account: string; mint: string; amount: bigint; decimals: number }, fallbackUsd: number | null = null): ReceiptToken => {
    const h = holdings.get(a.account);
    return { walletIndex, account: a.account, mint: a.mint, symbol: h?.symbol ?? null, amount: a.amount, decimals: a.decimals, usdValue: h?.usdValue ?? fallbackUsd, solValue: h?.solValue ?? null };
  };

  let closedAccounts = 0;
  let closedRentLamports = 0n;
  let claims = 0;
  let claimLamports = 0n;
  let looseSolLamports = 0n;
  let depositLamports = 0n;
  let totalLamports = 0n;
  const exempt = plan.payerExemptLamports && plan.payerExemptLamports > 0n ? plan.payerExemptLamports : 0n;
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  let appFeeSum = 0n;
  let simulated = 0;
  const tokens: ReceiptToken[] = [];
  const burned: ReceiptToken[] = [];
  const failed: Receipt['failed'] = [];
  const feeSharing: number[] = [];

  // coletas que vão acontecer (simuladas de verdade, não puladas): só para elas conta a fee que os passos só de
  // varrer liberam antes. Coleta seguinte pulada (fee sharing) ou que falhou = a fee liberada fica no cofre (revisão)
  const claimKey = (st: { walletIndex: number; kind: string }) => `${st.walletIndex}:${st.kind}`;
  // Conta também a coleta que a simulação viu "sem fee" ou "pequena demais": ela não vê o cofre que os passos
  // anteriores encheram, e na execução coleta (revisão da autoclarn-40, 0.1.7). Não conta falha nem fee sharing.
  const isFinalClaim = (r: StepResult) => isClaim(r.step) && !('sweepOnly' in r.step && r.step.sweepOnly);
  const collecting = new Set(
    simResults
      .filter((r) => isFinalClaim(r) && (r.status === counted || r.status === 'nada a fazer') && r.detail !== FEE_SHARING_SKIP)
      .map((r) => claimKey(r.step)),
  );
  // coletas já contadas (simuladas de verdade): a que só vai coletar o que a varredura liberou conta uma vez, lá embaixo
  let unsimulatedClaimCost = 0n;
  const countedClaims = new Set(simResults.filter((r) => isFinalClaim(r) && r.status === counted && !r.skippedClaim).map((r) => claimKey(r.step)));

  for (const r of simResults) {
    if (r.status === 'falhou' || r.status === 'cancelado') {
      failed.push({ walletIndex: r.step.walletIndex, description: r.description, error: r.error ?? explainError(r.detail ?? r.description) });
      continue;
    }
    if (r.status === 'nada a fazer' && isClaim(r.step) && r.detail === FEE_SHARING_SKIP) {
      if (!feeSharing.includes(r.step.walletIndex)) feeSharing.push(r.step.walletIndex);
      continue;
    }
    if (r.status !== counted) continue;
    simulated++;
    const delta = r.destinationDelta ?? 0n;
    const fee = r.appFeeDelta ?? 0n;
    const gross = delta + fee; // o que o passo recuperou: destino + taxa do app
    totalLamports += delta;
    appFeeSum += fee;
    const s = r.step;
    if (isClaim(s)) {
      // passo só de liberar a fee parada não é uma coleta (nada chega ao destino nele; a coleta é o passo seguinte);
      // coleta do PumpSwap pulada que só fechou a ATA WSOL também não (fee sharing entra no aviso)
      if (r.skippedClaim) {
        if (r.detail === FEE_SHARING_SKIP && !feeSharing.includes(s.walletIndex)) feeSharing.push(s.walletIndex);
      } else if (!('sweepOnly' in s && s.sweepOnly)) claims++;
      // a ATA WSOL que já existia e que a coleta do PumpSwap fechou: conta fechada, não creator fee. Junto vai o
      // WSOL esquecido nela (sem separar, como o passo das contas faz com a conta de WSOL: tudo é "contas fechadas")
      const rent = r.closedRentLamports ?? 0n;
      if (rent > 0n) {
        closedAccounts++;
        closedRentLamports += rent;
      }
      claimLamports += gross - rent;
      // ...mas o que ele libera chega na coleta seguinte, e a simulação dela não vê esta varredura (cada passo é
      // simulado sobre a rede de agora): conta aqui, com os 11% que a coleta cobra
      const pending = r.pendingClaimLamports ?? 0n;
      if (!input.executed && 'sweepOnly' in s && s.sweepOnly && pending > 0n && collecting.has(claimKey(s))) {
        const pendingFee = appFeeLamports(pending, plan.appFee);
        claimLamports += pending;
        totalLamports += pending - pendingFee;
        appFeeSum += pendingFee;
        if (!countedClaims.has(claimKey(s))) {
          claims++;
          countedClaims.add(claimKey(s));
          // essa coleta não foi simulada como transação: a taxa de rede dela (pagadora + temporária) também sai da pagadora
          unsimulatedClaimCost += 2n * BigInt(BASE_FEE_LAMPORTS);
        }
      }
    } else if (s.kind === 'sweep-sol') {
      // envio final da pagadora: a parte isenta (o depósito) volta à pessoa e fica numa linha própria
      const deposit = s.isFeePayer ? min(exempt, gross) : 0n;
      looseSolLamports += gross - deposit;
      depositLamports += deposit;
    } else if (s.kind === 'close-uva') {
      // conta de volume fechada: o aluguel entra em "contas fechadas" (aluguel de contas); o cashback em SOL que ela
      // ainda tinha, coletado no mesmo passo, é coleta (linha "Creator fees e cashback")
      const rent = r.closedRentLamports !== undefined && r.closedRentLamports < gross ? r.closedRentLamports : gross;
      closedAccounts++;
      closedRentLamports += rent;
      if (gross > rent) {
        claims++;
        claimLamports += gross - rent;
      }
    } else {
      // aluguel medido na simulação (o que o passo recuperou), não o da análise
      closedRentLamports += gross;
      for (const a of s.actions as TokenAction[]) {
        closedAccounts++;
        if (a.action === 'transfer-close') tokens.push(token(s.walletIndex, a));
        else if (a.action === 'burn-close') burned.push(token(s.walletIndex, a));
      }
    }
  }

  // Envio final da pagadora: a simulação dele roda sobre o saldo de ANTES da rodada, mas na execução a pagadora já
  // gastou o que os passos anteriores custam (taxa de rede, aluguel de conta que fica criada, payerCostLamports).
  // Esse gasto sai da parte que paga os 11% (o depósito isento é o que sobra por último, como em payerSplit).
  const ok = simResults.filter((r) => r.status === counted);
  const payerCost = input.executed ? 0n : ok.reduce((a, r) => a + (r.payerCostLamports ?? 0n), 0n) + unsimulatedClaimCost;
  const payerSweep = ok.find((r) => r.step.kind === 'sweep-sol' && r.step.isFeePayer);
  if (payerCost > 0n && payerSweep) {
    const amount = (payerSweep.destinationDelta ?? 0n) + (payerSweep.appFeeDelta ?? 0n);
    const after = amount - min(payerCost, amount);
    const feeCut = appFeeLamports(amount - min(exempt, amount), plan.appFee) - appFeeLamports(after - min(exempt, after), plan.appFee);
    const destCut = amount - after - feeCut;
    // o gasto sai primeiro do SOL esquecido; só o que passa dele come o depósito
    const depositCut = min(exempt, amount) - min(exempt, after);
    totalLamports -= destCut;
    looseSolLamports -= destCut + feeCut - depositCut;
    depositLamports -= depositCut;
    appFeeSum -= feeCut;
  }

  const kept = plan.kept.map((t) => ({ ...token(t.walletIndex, t, t.usd), reasonCode: keptReasonCode(t), reason: t.reason }));

  return {
    toDestination: { closedAccounts, closedRentLamports, claims, claimLamports, tokens, looseSolLamports, depositLamports },
    burned,
    kept,
    failed,
    feeSharing,
    totalLamports,
    appFeeLamports: appFeeSum,
    appFeeWallet: plan.appFee?.wallet ?? null,
    // medido na simulação quando há (taxas e aluguéis que a pagadora gasta); senão a estimativa por transação
    feeEstimateLamports: payerCost > 0n ? payerCost : BigInt(simulated) * 2n * BigInt(BASE_FEE_LAMPORTS),
    feePayerIndex: plan.feePayerIndex,
    destination: plan.destination,
    destinationIsMain: main !== null && plan.destination === main,
  };
}

// Recibo de várias frases: cada frase tem o seu recibo; aqui só somamos. O destino é um só na rodada.
export type FraseReceipt = { frase: number; app: CardApp; receipt: Receipt };

export function mergeReceipts(list: FraseReceipt[]): {
  frases: FraseReceipt[];
  totalLamports: bigint;
  feeEstimateLamports: bigint;
  appFeeLamports: bigint;
  destination: string;
  failedCount: number;
  burnedCount: number;
  keptCount: number;
} {
  if (list.length === 0) throw new Error('Sem recibo para somar.');
  const destination = list[0].receipt.destination;
  if (list.some((f) => f.receipt.destination !== destination)) throw new Error('Os recibos têm destinos diferentes; a rodada só tem um destino.');
  let totalLamports = 0n;
  let feeEstimateLamports = 0n;
  let appFeeLamports = 0n;
  let failedCount = 0;
  let burnedCount = 0;
  let keptCount = 0;
  for (const { receipt: r } of list) {
    totalLamports += r.totalLamports;
    feeEstimateLamports += r.feeEstimateLamports;
    appFeeLamports += r.appFeeLamports;
    failedCount += r.failed.length;
    burnedCount += r.burned.length;
    keptCount += r.kept.length;
  }
  return { frases: list, totalLamports, feeEstimateLamports, appFeeLamports, destination, failedCount, burnedCount, keptCount };
}
