// Cenário DEVNET para o "várias frases" (rede de testes, dinheiro de mentira). Frases descartáveis, BIP39 válidas,
// em arquivos fora do repositório; nunca impressas (só endereços públicos).
//
//   node scripts/devnet-frases.ts novas     <pasta-fora-do-repo>   cria pagadora.txt e frase-1..3.txt (se faltarem)
//   node scripts/devnet-frases.ts preparar  <pasta-fora-do-repo>   monta o cenário (a pagadora precisa de ~0,15 SOL)
//   node scripts/devnet-frases.ts depositar <pasta-fora-do-repo>   0,01 SOL na N=0 da frase 3 (a que espera depósito)
//
// Pagadora: conta padrão nº 0 da pagadora.txt (abastecida por fora; o faucet do RPC da devnet está fechado).
// Cenário:
//   frase 1 (Solflare): N=0 0,01 SOL; N=1 0,01 SOL + conta vazia do token A + 1 NFT; N=2 0,02 SOL + 5 tokens A +
//                       conta congelada do token B; N=3 0,005 SOL. Principal: 0,01 SOL (destino de teste).
//   frase 2 (Phantom):  Conta 2 0,015 SOL + conta vazia do token A; Conta 3 0,005 SOL. Conta 1 (principal) intocada.
//   frase 3 (Solflare): N=0 com uma conta de wSOL vazia e 0 SOL (falta SOL para a taxa: espera o depósito).
import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { validateMnemonic } from '../src/core/carteiras/bip39.ts';
import { deriveBurner, deriveMainAddress, derivePrivateKey, mnemonicToSeed, publicKeyFromPrivate, standardPath, type WalletApp } from '../src/core/carteiras/derivation.ts';
import { ataCreateIdempotent, systemCreateAccount, systemTransfer, tokenFreezeAccount, tokenInitializeMint2, tokenMintTo } from '../src/core/solana/instructions.ts';
import { associatedTokenAddress, PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc } from '../src/core/solana/rpc.ts';
import { buildTransaction, signerFromPrivateKey, type Instruction, type Signer } from '../src/core/solana/tx.ts';
import { isInsideRepo } from '../src/cli/io.ts';

const rpc = createRpc({ url: 'https://api.devnet.solana.com', requestsPerSecond: 3 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WSOL = 'So11111111111111111111111111111111111111112';
const WORDS = fs.readFileSync(new URL('../src/core/carteiras/bip39-english.txt', import.meta.url), 'utf8').split(/\r?\n/).filter(Boolean);

// 12 palavras de 128 bits de entropia aleatória + checksum (os primeiros 4 bits do SHA-256)
function newMnemonic(): string {
  const entropy = randomBytes(16);
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('') + createHash('sha256').update(entropy).digest()[0]!.toString(2).padStart(8, '0').slice(0, 4);
  entropy.fill(0);
  const m = bits.match(/.{11}/g)!.map((b) => WORDS[parseInt(b, 2)]).join(' ');
  if (!validateMnemonic(m).ok) throw new Error('frase gerada não passou na conferência');
  return m;
}
function randomSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { address: encodeBase58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), sign: (m) => sign(null, m, privateKey) };
}
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
async function send(label: string, payer: Signer, ixs: Instruction[], extra: Signer[] = []) {
  const { value: bh } = await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = buildTransaction(payer.address, ixs, bh.blockhash, [payer, ...extra]);
  const b64 = Buffer.from(tx.bytes).toString('base64');
  const sim = await rpc.call<{ value: { err: unknown; logs?: string[] } }>('simulateTransaction', [b64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  if (sim.value.err) throw new Error(`${label}: simulação falhou ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
  await rpc.call('sendTransaction', [b64, { encoding: 'base64' }]);
  await waitSig(tx.signature);
  console.log(`  ok: ${label}`);
}
const balance = async (a: string) => (await rpc.call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value;

const [mode, dir] = process.argv.slice(2);
if (!['novas', 'preparar', 'depositar'].includes(mode ?? '') || !dir) throw new Error('uso: novas|preparar|depositar <pasta-fora-do-repo>');
if (isInsideRepo(dir)) throw new Error('a pasta das frases precisa ficar fora do repositório');
const file = (name: string) => path.join(dir, `${name}.txt`);

// só endereços saem daqui: a semente é lida, usada e zerada
function addresses(name: string, app: WalletApp, indexes: number[]): { main: string; wallets: string[] } {
  const seed = mnemonicToSeed(fs.readFileSync(file(name), 'utf8'));
  try {
    return { main: deriveMainAddress(seed), wallets: indexes.map((i) => deriveBurner(seed, i, app).address) };
  } finally {
    seed.fill(0);
  }
}
function payerSigner(): Signer {
  const seed = mnemonicToSeed(fs.readFileSync(file('pagadora'), 'utf8'));
  const priv = derivePrivateKey(seed, standardPath(0));
  seed.fill(0);
  const s = signerFromPrivateKey(encodeBase58(publicKeyFromPrivate(priv)), priv);
  priv.fill(0);
  return s;
}

if (mode === 'novas') {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['pagadora', 'frase-1', 'frase-2', 'frase-3']) {
    if (!fs.existsSync(file(name))) fs.writeFileSync(file(name), newMnemonic(), { mode: 0o600 });
  }
  console.log(`pagadora (mande SOL de teste para cá): ${payerSigner().address}`);
} else {
  const payer = payerSigner();
  const f1 = addresses('frase-1', 'solflare', [0, 1, 2, 3]);
  const f2 = addresses('frase-2', 'phantom', [1, 2]);
  const f3 = addresses('frase-3', 'solflare', [0]);
  console.log(`pagadora ${payer.address}: ${(await balance(payer.address)) / 1e9} SOL devnet`);
  if (mode === 'depositar') {
    await send('depósito de 0,01 SOL na N=0 da frase 3', payer, [systemTransfer(payer.address, f3.wallets[0]!, 10_000_000n)]);
  } else {
    if ((await balance(f3.wallets[0]!)) !== 0) throw new Error('a N=0 da frase 3 já tem SOL: use frases novas');
    const T = PROGRAMS.token;
    const rentMint = BigInt(await rpc.call<number>('getMinimumBalanceForRentExemption', [82]));
    const [mintA, mintNft, mintB] = [randomSigner(), randomSigner(), randomSigner()];
    await send('tokens de teste: A (6 casas), NFT e B (com congelamento)', payer, [
      systemCreateAccount(payer.address, mintA.address, rentMint, 82n, T),
      tokenInitializeMint2(T, mintA.address, 6, payer.address, null),
      systemCreateAccount(payer.address, mintNft.address, rentMint, 82n, T),
      tokenInitializeMint2(T, mintNft.address, 0, payer.address, null),
      systemCreateAccount(payer.address, mintB.address, rentMint, 82n, T),
      tokenInitializeMint2(T, mintB.address, 6, payer.address, payer.address),
    ], [mintA, mintNft, mintB]);
    const [n0, n1, n2, n3] = f1.wallets as [string, string, string, string];
    const fee = (await balance(APP_FEE_WALLET)) < 1_000_000 ? [systemTransfer(payer.address, APP_FEE_WALLET, 10_000_000n)] : [];
    await send('frase 1: SOL nas temporárias e na principal; carteira da taxa', payer, [
      systemTransfer(payer.address, n0, 10_000_000n), systemTransfer(payer.address, n1, 10_000_000n),
      systemTransfer(payer.address, n2, 20_000_000n), systemTransfer(payer.address, n3, 5_000_000n),
      systemTransfer(payer.address, f1.main, 10_000_000n), ...fee,
    ]);
    await send('frase 1: N=1 conta vazia do token A + 1 NFT', payer, [
      ataCreateIdempotent(payer.address, n1, mintA.address, T),
      ataCreateIdempotent(payer.address, n1, mintNft.address, T),
      tokenMintTo(T, mintNft.address, associatedTokenAddress(n1, mintNft.address, T), payer.address, 1n),
    ]);
    await send('frase 1: N=2 5 tokens A + conta congelada do token B', payer, [
      ataCreateIdempotent(payer.address, n2, mintA.address, T),
      tokenMintTo(T, mintA.address, associatedTokenAddress(n2, mintA.address, T), payer.address, 5_000_000n),
      ataCreateIdempotent(payer.address, n2, mintB.address, T),
      tokenFreezeAccount(T, associatedTokenAddress(n2, mintB.address, T), mintB.address, payer.address),
    ]);
    const [c2, c3] = f2.wallets as [string, string];
    await send('frase 2 (Phantom): Conta 2 com SOL e conta vazia do token A; Conta 3 com SOL', payer, [
      systemTransfer(payer.address, c2, 15_000_000n), systemTransfer(payer.address, c3, 5_000_000n),
      ataCreateIdempotent(payer.address, c2, mintA.address, T),
    ]);
    await send('frase 3: N=0 com conta de wSOL vazia e 0 SOL', payer, [ataCreateIdempotent(payer.address, f3.wallets[0]!, WSOL, T)]);
    console.log(`\nCenário pronto. Destino de teste: principal da frase 1 (${f1.main}).`);
  }
  console.log(`pagadora agora: ${(await balance(payer.address)) / 1e9} SOL devnet`);
}
