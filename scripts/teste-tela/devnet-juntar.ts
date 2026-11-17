// Cenários DEVNET para "juntar o SOL desta frase" e para o empréstimo entre frases (rede de testes, dinheiro de
// mentira). Frases descartáveis em arquivos fora do repositório (`node scripts/devnet-frases.ts novas <pasta>`),
// nunca impressas: só endereços.
//
//   node scripts/teste-tela/devnet-juntar.ts preparar   <pasta>   juntar: frase-1 (pagadora com ~0,03 SOL)
//   node scripts/teste-tela/devnet-juntar.ts emprestimo <pasta>   empréstimo: frase-2 rica, frase-3 sem SOL (~0,05 SOL)
//   node scripts/teste-tela/devnet-juntar.ts saldos     <pasta>   só lê os saldos
//
// juntar, frase-1 (Solflare): N=0..3 com o aluguel de conta vazia + 0,00005 SOL cada (nenhuma cobre a reserva da
//   pagadora; as quatro juntas sim), conta de wSOL vazia na N=2, principal com 0,01 SOL (destino válido).
// empréstimo: frase-2: N=0 0,02 SOL (sobra para emprestar) e N=1 0,005 SOL (varre com a taxa de 11%), principal
//   0,01 SOL (destino). frase-3: N=0 com 0 SOL e uma conta de wSOL vazia (falta SOL: espera o depósito).
// Os dois: a carteira da taxa do app ganha 0,01 SOL se estiver quase vazia (senão a execução recusa).
import fs from 'node:fs';
import path from 'node:path';
import { APP_FEE_WALLET } from '../../src/core/limpeza/app-fee.ts';
import { encodeBase58 } from '../../src/core/solana/base58.ts';
import { deriveBurner, deriveMainAddress, derivePrivateKey, mnemonicToSeed, publicKeyFromPrivate, standardPath } from '../../src/core/carteiras/derivation.ts';
import { ataCreateIdempotent, systemTransfer } from '../../src/core/solana/instructions.ts';
import { PROGRAMS, WSOL_MINT } from '../../src/core/solana/pda.ts';
import { createRpc } from '../../src/core/solana/rpc.ts';
import { buildTransaction, signerFromPrivateKey, type Instruction, type Signer } from '../../src/core/solana/tx.ts';
import { isInsideRepo } from '../../src/cli/io.ts';

// por temporária: o aluguel de conta vazia LIDO DA REDE + 50 000. Acima do aluguel (a rede recusa conta entre 0 e o
// aluguel) e abaixo da reserva da pagadora (aluguel + 4 envios × 15 000 + 1 conta a fechar × 15 000): só juntando dá.
// O aluguel muda: era 890 880 na devnet e caiu para 650 240 em 31/10/2026 (com 900 000 fixo, a N=0 já cobria a reserva).
export const ABOVE_RENT_LAMPORTS = 50_000n;
const rpc = createRpc({ url: 'https://api.devnet.solana.com', requestsPerSecond: 3 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitSig(sig: string) {
  for (let i = 0; i < 60; i++) {
    const st = await rpc.call<{ value: Array<{ err: unknown; confirmationStatus?: string } | null> }>('getSignatureStatuses', [[sig]]);
    const s = st.value[0];
    if (s?.err) throw new Error(`transação falhou: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await sleep(1500);
  }
  throw new Error('transação não confirmou a tempo');
}
async function send(label: string, payer: Signer, ixs: Instruction[]) {
  const { value: bh } = await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = buildTransaction(payer.address, ixs, bh.blockhash, [payer]);
  const b64 = Buffer.from(tx.bytes).toString('base64');
  const sim = await rpc.call<{ value: { err: unknown; logs?: string[] } }>('simulateTransaction', [b64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  if (sim.value.err) throw new Error(`${label}: simulação falhou ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
  await rpc.call('sendTransaction', [b64, { encoding: 'base64' }]);
  await waitSig(tx.signature);
  console.log(`  ok: ${label} — https://solscan.io/tx/${tx.signature}?cluster=devnet`);
}
const balance = async (a: string) => (await rpc.call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value;

const [mode, dir] = process.argv.slice(2);
if (!['preparar', 'emprestimo', 'saldos'].includes(mode ?? '') || !dir) throw new Error('uso: preparar|emprestimo|saldos <pasta-fora-do-repo>');
if (isInsideRepo(dir)) throw new Error('a pasta das frases precisa ficar fora do repositório');
const file = (name: string) => path.join(dir, `${name}.txt`);

// só endereços saem daqui: a semente é lida, usada e zerada
function addresses(name: string, indexes: number[]) {
  const seed = mnemonicToSeed(fs.readFileSync(file(name), 'utf8'));
  try {
    return { main: deriveMainAddress(seed), wallets: indexes.map((i) => deriveBurner(seed, i, 'solflare').address) };
  } finally {
    seed.fill(0);
  }
}
const pseed = mnemonicToSeed(fs.readFileSync(file('pagadora'), 'utf8'));
const ppriv = derivePrivateKey(pseed, standardPath(0));
pseed.fill(0);
const payer = signerFromPrivateKey(encodeBase58(publicKeyFromPrivate(ppriv)), ppriv);
ppriv.fill(0);
const feeWallet = async (): Promise<Instruction[]> => ((await balance(APP_FEE_WALLET)) < 1_000_000 ? [systemTransfer(payer.address, APP_FEE_WALLET, 10_000_000n)] : []);
const show = async (label: string, a: string) => console.log(`  ${label} ${a}: ${(await balance(a)) / 1e9} SOL`);

console.log(`pagadora ${payer.address}: ${(await balance(payer.address)) / 1e9} SOL devnet`);
if (mode === 'preparar') {
  const f = addresses('frase-1', [0, 1, 2, 3]);
  if ((await balance(f.wallets[0]!)) !== 0) throw new Error('a N=0 da frase-1 já tem SOL: use frases novas');
  const rent0 = BigInt(await rpc.call<number>('getMinimumBalanceForRentExemption', [0]));
  const EACH_LAMPORTS = rent0 + ABOVE_RENT_LAMPORTS;
  console.log(`  aluguel de conta vazia na rede: ${rent0}; cada temporária com ${EACH_LAMPORTS}`);
  await send('juntar: aluguel + 0,00005 SOL em N=0..3, wSOL vazia na N=2, 0,01 SOL na principal, carteira da taxa', payer, [
    ...f.wallets.map((w) => systemTransfer(payer.address, w, EACH_LAMPORTS)),
    ataCreateIdempotent(payer.address, f.wallets[2]!, WSOL_MINT, PROGRAMS.token),
    systemTransfer(payer.address, f.main, 10_000_000n),
    ...(await feeWallet()),
  ]);
  for (const [i, w] of f.wallets.entries()) await show(`N=${i}`, w);
  await show('principal/destino', f.main);
} else if (mode === 'emprestimo') {
  const a = addresses('frase-2', [0, 1]);
  const b = addresses('frase-3', [0]);
  if ((await balance(a.wallets[0]!)) !== 0 || (await balance(b.wallets[0]!)) !== 0) throw new Error('frase-2/frase-3 já têm SOL: use frases novas');
  await send('empréstimo: frase-2 N=0 0,02 SOL e N=1 0,005 SOL, principal 0,01 SOL; frase-3 N=0 com wSOL vazia e 0 SOL; carteira da taxa', payer, [
    systemTransfer(payer.address, a.wallets[0]!, 20_000_000n),
    systemTransfer(payer.address, a.wallets[1]!, 5_000_000n),
    systemTransfer(payer.address, a.main, 10_000_000n),
    ataCreateIdempotent(payer.address, b.wallets[0]!, WSOL_MINT, PROGRAMS.token),
    ...(await feeWallet()),
  ]);
  await show('frase-2 N=0', a.wallets[0]!);
  await show('frase-2 N=1', a.wallets[1]!);
  await show('frase-2 principal/destino', a.main);
  await show('frase-3 N=0', b.wallets[0]!);
} else {
  for (const [name, n] of [['frase-1', 4], ['frase-2', 2], ['frase-3', 1]] as const) {
    if (!fs.existsSync(file(name))) continue;
    const f = addresses(name, Array.from({ length: n }, (_, i) => i));
    for (const [i, w] of f.wallets.entries()) await show(`${name} N=${i}`, w);
    await show(`${name} principal`, f.main);
  }
}
console.log(`  carteira da taxa ${APP_FEE_WALLET}: ${(await balance(APP_FEE_WALLET)) / 1e9} SOL`);
