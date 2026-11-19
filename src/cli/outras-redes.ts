// Seção "Outras redes (só leitura)" comum ao scan e ao limpar no terminal.

import type { EvmHolding, EvmScan } from '../core/evm/evm-scan.ts';
import { formatTokenAmount } from '../core/limpeza/summary.ts';

export const EVM_ACCOUNTS = 5; // contas 1 a 5, como MetaMask/Trust criam

// Saldo minúsculo (menos de 0,000001 da moeda) é poeira: aparece à parte para não confundir.
export function isDust(h: EvmHolding): boolean {
  return h.amount * 10n ** 6n < 10n ** BigInt(h.decimals);
}

export function usedByChain(r: EvmScan): string[] {
  const used = r.usedAccounts.filter((u) => !r.holdings.some((h) => h.address === u.address && h.chainName === u.chain && !isDust(h)));
  const byChain = new Map<string, number[]>();
  for (const u of used) byChain.set(u.chain, [...(byChain.get(u.chain) ?? []), u.account + 1]);
  return [...byChain].map(([c, accs]) => `${c}: contas ${accs.sort((a, b) => a - b).join(', ')}`);
}

export function printEvm(r: EvmScan) {
  console.log('\nOutras redes da mesma frase (Ethereum, Base, BSC, Arbitrum, Polygon, Monad, HyperEVM; contas 1 a 5; só leitura):');
  const real = r.holdings.filter((h) => !isDust(h));
  const dust = r.holdings.filter(isDust);
  if (!real.length) console.log('  Nada de valor encontrado (moeda principal, USDC e USDT).');
  for (const h of real) console.log(`  ${h.chainName}, conta ${h.account + 1} (${h.address}): ${formatTokenAmount(h.amount, h.decimals)} ${h.asset}`);
  if (real.length) console.log('  Para mover: importe a mesma frase numa carteira dessa rede (MetaMask, Trust). Este app não mexe em outras redes.');
  if (dust.length) console.log(`  Poeira (valor desprezível): ${dust.map((h) => `${h.chainName} conta ${h.account + 1} ${h.asset}`).join(', ')}`);
  const used = usedByChain(r);
  if (used.length) console.log(`  Contas já usadas, hoje sem saldo: ${used.join(' | ')}`);
  for (const e of r.errors) console.log(`  ⚠ não consegui ler: ${e}`);
}
