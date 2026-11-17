// Confere na mainnet, SÓ LEITURA, a descoberta automática nos três caminhos (Solflare 10000+, Phantom
// m/44'/501'/i'/0' e Trust/Phantom antiga m/44'/501'/i') com as frases PÚBLICAS de teste do BIP39 (terceiros
// usam essas frases; não são de ninguém). Nada é assinado nem enviado; nenhuma frase real entra aqui.
//
//   node scripts/conferir-ramos.ts
//
// RPC público da mainnet. Imprime, por frase e por caminho: quantas contas com histórico, quais números e
// quantas consultas a busca fez; e a resposta de detectBranches/detectWallet do app.

import { mnemonicToSeed, type WalletApp } from '../src/core/carteiras/derivation.ts';
import { detectBranches, detectWallet } from '../src/core/carteiras/detect.ts';
import { discoverBurners } from '../src/core/limpeza/scan.ts';
import { createRpc, PUBLIC_RPC_LIMITS, type RpcClient } from '../src/core/solana/rpc.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const PHRASES = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
];

const base = createRpc({ url: PUBLIC, ...PUBLIC_RPC_LIMITS });
let calls = 0;
const rpc: RpcClient = { call: (m, p) => { calls++; return base.call(m, p); } };

console.log(`Início: ${new Date().toISOString()}`);
for (const [k, phrase] of PHRASES.entries()) {
  const seed = mnemonicToSeed(phrase);
  const found: Partial<Record<WalletApp, Awaited<ReturnType<typeof discoverBurners>>>> = {};
  for (const app of ['solflare', 'phantom', 'trust'] as const) {
    const before = calls;
    const t0 = Date.now();
    const d = await discoverBurners(seed, rpc, { app });
    found[app] = d;
    const used = d.wallets.filter((w) => w.hasHistory).map((w) => w.index);
    console.log(`frase pública ${k + 1} · ${app.padEnd(8)}: ${used.length} com histórico [${used.join(', ')}] · ${calls - before} consultas · ${((Date.now() - t0) / 1000).toFixed(0)} s${d.reachedMax ? ' · chegou no máximo' : ''}`);
  }
  seed.fill(0);
  console.log(`  ramos: ${JSON.stringify(detectBranches(found.solflare!, found.phantom!, found.trust!))} · detecção: ${detectWallet(found.solflare!, found.phantom!, found.trust!)}`);
}
console.log(`Fim: ${new Date().toISOString()} · ${calls} consultas, nada enviado`);
