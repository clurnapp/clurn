// Qual carteira a frase usa, pelo que a rede mostra (pedido do autor, 31/10/2026: os amigos não sabem
// dizer se a frase é da Phantom ou do Solflare).
//
// A rede não diz qual app a pessoa abre; diz ONDE estão as carteiras usadas da frase:
// - ramo 10000+ (m/44'/501'/(N+10000)'/0'/0'): só o Solflare cria ("Carteira Temporária");
// - contas comuns 2, 3… (m/44'/501'/i'/0', i >= 1): Phantom, ou contas comuns do Solflare (mesmas chaves;
//   a rede não separa). Por isso entram com a revisão da Phantom (alertas, proteger, contagem digitada);
// - Conta 1 (i = 0): a principal nos dois apps; nunca é limpa;
// - contas m/44'/501'/i' (06/11/2026): Trust Wallet e Phantom antiga. A conta 0 é a principal da Trust; nunca é limpa.
//
// Cada ramo com uso vira um cartão (o primeiro é a frase colada; os outros, irmãs logo depois dela).

import { PHANTOM_MAIN_INDEX, TRUST_MAIN_INDEX, type WalletApp } from './derivation.ts';

// 'ambas': mais de um ramo com uso (decisão do autor: limpa todos, um cartão por ramo)
// 'principal': só a principal tem uso (Conta 1 da Phantom ou conta 0 da Trust), nada para limpar
// 'nenhuma': nada com uso em nenhum caminho (frase sem uso, ou de outra carteira)
export type Detection = WalletApp | 'ambas' | 'principal' | 'nenhuma';

type Found = { wallets: Array<{ index: number; hasHistory: boolean }> };

const usedBeyond = (f: Found, main: number | null) => f.wallets.some((w) => w.index !== main && w.hasHistory);
const mainUsed = (f: Found, main: number) => f.wallets.some((w) => w.index === main && w.hasHistory);

// ramos com uso, na ordem Solflare, Phantom, Trust; a principal dos ramos com principal não conta
export function detectBranches(solflare: Found, phantom: Found, trust: Found): WalletApp[] {
  const out: WalletApp[] = [];
  if (usedBeyond(solflare, null)) out.push('solflare');
  if (usedBeyond(phantom, PHANTOM_MAIN_INDEX)) out.push('phantom');
  if (usedBeyond(trust, TRUST_MAIN_INDEX)) out.push('trust');
  return out;
}

// solflare = busca no ramo 10000+; phantom = contas comuns a partir da Conta 1; trust = contas m/44'/501'/i'
export function detectWallet(solflare: Found, phantom: Found, trust: Found = { wallets: [] }): Detection {
  const branches = detectBranches(solflare, phantom, trust);
  if (branches.length > 1) return 'ambas';
  if (branches.length === 1) return branches[0];
  return mainUsed(phantom, PHANTOM_MAIN_INDEX) || mainUsed(trust, TRUST_MAIN_INDEX) ? 'principal' : 'nenhuma';
}
