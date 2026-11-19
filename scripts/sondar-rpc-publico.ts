// Sonda os limites REAIS do RPC público da Solana, método a método: em que ritmo cada um leva HTTP 429?
// Só leitura, com uma carteira pública que acabou de mexer na Pump.fun (nenhuma frase, nada é enviado).
//
//   node scripts/sondar-rpc-publico.ts [url=https://api.mainnet.solana.com]
//
// Por que existe: a documentação (solana.com/docs/references/clusters) fala em 100 req/10 s no total e 40 req/10 s
// por método, mas em 30/10/2026 quatro métodos cortavam em 10 por 10 s ("Too many requests for a specific RPC
// call", retry-after 10) e as recusadas contavam. O resultado alimenta PUBLIC_RPC_LIMITS (src/core/solana/rpc.ts)
// e docs/aprendizados.md. Leva uns 4 minutos (pausa de 12 s entre as fases para esvaziar a janela de 10 s).
//
// simulateTransaction usa uma transação de mentira (conta aleatória sem saldo, assinatura zerada, sigVerify false,
// replaceRecentBlockhash true): a simulação falha com AccountNotFound, mas a consulta conta para o limite.
// sendTransaction não é sondado: não se manda transação inválida para a rede só para medir.

import { randomBytes } from 'node:crypto';
import { PROGRAMS } from '../src/core/solana/pda.ts';

const URL_RPC = process.argv[2] ?? 'https://api.mainnet.solana.com';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

type Reply = { status: number; ms: number; retryAfter: string | null; body: string; json: { result?: unknown } | null };

async function rpc(method: string, params: unknown[]): Promise<Reply> {
  const t0 = Date.now();
  const r = await fetch(URL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const ms = Date.now() - t0;
  const text = await r.text();
  return { status: r.status, ms, retryAfter: r.headers.get('retry-after'), body: text.slice(0, 120), json: r.ok ? JSON.parse(text) : null };
}

// n chamadas a perSec por segundo; imprime quantas passaram, quantas levaram 429 e a 1ª resposta de 429
async function phase(label: string, n: number, perSec: number, call: () => Promise<Reply>) {
  let ok = 0;
  let r429 = 0;
  let other = 0;
  let lat = 0;
  let first429: string | null = null;
  const t0 = Date.now();
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1000 / perSec));
    jobs.push(
      call()
        .then((r) => {
          lat += r.ms;
          if (r.status === 429) {
            r429++;
            first429 ??= `retry-after=${r.retryAfter} corpo=${JSON.stringify(r.body)}`;
          } else if (r.status === 200) ok++;
          else other++;
        })
        .catch(() => void other++),
    );
  }
  await Promise.all(jobs);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${label.padEnd(52)} ${n} a ${perSec}/s em ${secs} s: ${ok} ok, ${r429} x 429, ${other} outro, latência média ${(lat / n).toFixed(0)} ms${first429 ? `  | 1º 429: ${first429}` : ''}`);
  await new Promise((r) => setTimeout(r, 12_000));
}

function fakeTx(): string {
  const msg = Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 assinatura, 0 só-leitura assinadas, 1 só-leitura não assinada
    Buffer.from([2]), randomBytes(32), Buffer.alloc(32), // pagador aleatório + System Program
    randomBytes(32), // blockhash (o RPC substitui)
    Buffer.from([1, 1, 2, 0, 0, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]), // 1 instrução: transferência de 1 lamport
  ]);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), msg]).toString('base64');
}

const sigs = ((await rpc('getSignaturesForAddress', [PROGRAMS.pump, { limit: 5 }])).json?.result ?? []) as Array<{ signature: string }>;
const tx = (await rpc('getTransaction', [sigs[0].signature, { encoding: 'json', maxSupportedTransactionVersion: 1 }])).json?.result as { transaction: { message: { accountKeys: string[] } } };
const wallet = tx.transaction.message.accountKeys[0];
console.log(`RPC ${new URL(URL_RPC).host}; carteira pública de amostra escolhida. Pausa de 12 s antes de cada fase.`);
await new Promise((r) => setTimeout(r, 12_000));

let flip = 0;
const tokenReads = () => rpc('getTokenAccountsByOwner', [wallet, { programId: flip++ % 2 ? TOKEN_2022 : PROGRAMS.token }, { encoding: 'jsonParsed' }]);
const gpa = () => rpc('getProgramAccounts', [PROGRAMS.pump, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: '5YcE3Qg6wG6c' } }, { memcmp: { offset: 49, bytes: wallet } }] }]);

await phase('getTokenAccountsByOwner (Token e Token-2022 alternados)', 36, 0.9, tokenReads);
await phase('getTokenAccountsByOwner (Token e Token-2022 alternados)', 24, 1.2, tokenReads);
await phase('getProgramAccounts Pump.fun com filtro', 30, 3, gpa);
await phase('getSignaturesForAddress', 30, 3, () => rpc('getSignaturesForAddress', [wallet, { limit: 1 }]));
await phase('getSignatureStatuses', 30, 3, () => rpc('getSignatureStatuses', [[sigs[0].signature], { searchTransactionHistory: false }]));
await phase('getAccountInfo', 30, 3, () => rpc('getAccountInfo', [wallet, { encoding: 'base64' }]));
await phase('getMultipleAccounts', 30, 3, () => rpc('getMultipleAccounts', [[wallet], { encoding: 'base64' }]));
await phase('getLatestBlockhash', 30, 3, () => rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
await phase('getBlockHeight', 30, 3, () => rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
await phase('getRecentPrioritizationFees', 20, 3, () => rpc('getRecentPrioritizationFees', [[]]));
await phase('simulateTransaction (transação de mentira)', 30, 3, () => rpc('simulateTransaction', [fakeTx(), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]));
