// Modo Phantom: as burners são contas comuns da frase. Pedido do autor (30/10/2026): "geralmente a
// principal é a Conta 1; exigir confirmação e sempre mostrar se tem alguma diferença".
//
// Regras:
// - a Conta 1 NUNCA é limpa (o app nem cria chave para ela);
// - o usuário pode proteger outras contas;
// - diferenças viram alerta visível: Conta 1 sem uso enquanto outras têm; conta com valor relevante
//   (pode ser carteira de uso, não burner).

import { PHANTOM_MAIN_INDEX } from './derivation.ts';
import { tokenValue, type Price, type TokenInfo } from '../limpeza/prices.ts';
import { VALUABLE_SOL, VALUABLE_USD } from '../limpeza/recommend.ts';
import type { WalletScan } from '../limpeza/scan.ts';

export const NOTABLE_SOL_LAMPORTS = 50_000_000; // 0,05 SOL solto já chama atenção numa burner
export const NOTABLE_TOKEN_USD = VALUABLE_USD; // o mesmo corte da recomendação "vale US$ 1 ou mais"

// Alerta com código e números, para a página traduzir (os textos de `warnings` são os do terminal, em português).
export type AccountAlert = { code: 'loose-sol'; params: { lamports: number } } | { code: 'valuable-tokens'; params: { count: number } };
export type ReviewAlert = { code: 'main-unused' };

export type AccountReview = {
  index: number;
  label: string;
  address: string;
  hasHistory: boolean;
  lamports: number;
  isMain: boolean;
  warnings: string[];
  alerts: AccountAlert[]; // os mesmos alertas de `warnings`, na mesma ordem
};

export type Review = { accounts: AccountReview[]; warnings: string[]; alerts: ReviewAlert[] };

// opts.mainIndex: índice da principal do caminho (Phantom e Trust: 0); null quando não há principal (chaves coladas:
// toda carteira passa pela conferência e pode ter alerta). opts.label: rótulo de cada carteira ("Conta 4", "Chave 2").
export function reviewPhantomAccounts(
  discovered: Array<{ index: number; address: string; hasHistory: boolean }>,
  scans: WalletScan[],
  prices: Map<string, Price>,
  info: Map<string, TokenInfo> = new Map(),
  opts: { mainIndex?: number | null; label?: (index: number) => string } = {},
): Review {
  const mainIndex = opts.mainIndex === undefined ? PHANTOM_MAIN_INDEX : opts.mainIndex;
  const label = opts.label ?? ((i: number) => `Conta ${i + 1}`);
  const byIndex = new Map(scans.map((s) => [s.index, s]));
  const accounts: AccountReview[] = discovered.map((d) => {
    const s = byIndex.get(d.index);
    const warnings: string[] = [];
    const alerts: AccountAlert[] = [];
    const isMain = d.index === mainIndex;
    if (!isMain && s) {
      if (s.lamports >= NOTABLE_SOL_LAMPORTS) {
        warnings.push(`tem ${(s.lamports / 1e9).toFixed(4).replace('.', ',')} SOL solto: parece carteira de uso, não burner`);
        alerts.push({ code: 'loose-sol', params: { lamports: s.lamports } });
      }
      const valuable = s.tokens.filter((t) => {
        if (t.kind !== 'fungible') return false;
        const cat = info.get(t.mint)?.category;
        const { usd, sol } = tokenValue(prices, t);
        return cat === 'estável' || cat === 'cripto conhecida' || (usd !== null && usd >= NOTABLE_TOKEN_USD) || (sol !== null && sol >= VALUABLE_SOL);
      });
      if (valuable.length) {
        warnings.push(`tem ${valuable.length} token(s) de valor: parece carteira de uso, não burner`);
        alerts.push({ code: 'valuable-tokens', params: { count: valuable.length } });
      }
    }
    return { index: d.index, label: label(d.index), address: d.address, hasHistory: d.hasHistory, lamports: s?.lamports ?? 0, isMain, warnings, alerts };
  });
  const warnings: string[] = [];
  const alerts: ReviewAlert[] = [];
  const main = accounts.find((a) => a.isMain);
  if (main && !main.hasHistory && accounts.some((a) => !a.isMain && a.hasHistory)) {
    warnings.push('A Conta 1 nunca foi usada, mas outras contas sim: confira se a sua principal é mesmo a Conta 1. Se não for, proteja a sua principal.');
    alerts.push({ code: 'main-unused' });
  }
  return { accounts, warnings, alerts };
}

// "3, 5" (números das contas, como aparecem na Phantom) → índices. Conta inexistente → erro claro.
export function parseProtectedAccounts(text: string, existing: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(part)) throw new Error(`"${part}" não é um número de conta`);
    const idx = Number(part) - 1;
    if (!existing.has(idx)) throw new Error(`Conta ${part} não está na lista`);
    out.add(idx);
  }
  return out;
}

// Pedido da página para um app com conferência: contas a proteger (números como no app: 2, 3…) e quantas a
// pessoa confirmou que serão limpas. Devolve as contas a limpar, ou um texto de erro claro.
// mainIndex: índice da principal do caminho (Phantom e Trust: 0), que nunca entra; null quando não há principal
// conhecida (chaves coladas): aí todas passam pela conferência.
// allProtected: a pessoa protegeu todas as contas da frase (não é erro de pedido: a frase só fica fora da limpeza)
export function selectAccounts(discovered: Array<{ index: number }>, protegidas: unknown, confirmadas: unknown, mainIndex: number | null): { burners: Set<number> } | { error: string; allProtected?: true } {
  const existing = new Set(discovered.map((d) => d.index).filter((i) => i !== mainIndex));
  if (!Array.isArray(protegidas) || protegidas.some((n) => !Number.isInteger(n))) return { error: 'Lista de contas protegidas inválida.' };
  const protectedIdx = new Set<number>();
  for (const n of protegidas as number[]) {
    if (mainIndex !== null && n === mainIndex + 1) continue; // a principal já é protegida sempre
    if (!existing.has(n - 1)) return { error: `Conta ${n} não está na lista.` };
    protectedIdx.add(n - 1);
  }
  const burners = new Set(discovered.map((d) => d.index).filter((i) => i !== mainIndex && !protectedIdx.has(i)));
  if (!burners.size) return { error: 'Nenhuma conta para limpar: todas estão protegidas.', allProtected: true };
  if (confirmadas !== burners.size) return { error: `Confirme quantas contas serão limpas: são ${burners.size}.` };
  return { burners };
}

// Phantom: a Conta 1 (índice 0) é a principal
export function phantomSelection(discovered: Array<{ index: number }>, protegidas: unknown, confirmadas: unknown): { burners: Set<number> } | { error: string; allProtected?: true } {
  return selectAccounts(discovered, protegidas, confirmadas, PHANTOM_MAIN_INDEX);
}

// Quem será limpo: todas as contas encontradas, menos a Conta 1 e as protegidas.
export function phantomBurnerIndexes(discovered: Array<{ index: number }>, protectedIdx: Set<number>): number[] {
  return discovered.map((d) => d.index).filter((i) => i !== PHANTOM_MAIN_INDEX && !protectedIdx.has(i));
}
