// Prepara um cenário de teste na DEVNET (rede de testes, dinheiro de mentira).
//
//   node scripts/devnet-preparar.ts C:\fora\do\repo\frase-devnet.txt
//
// Se o arquivo não existir, cria uma frase de teste nova nele (só serve para a devnet).
// Cenário criado nas temporárias da frase:
//   N=0  pagador: recebe o airdrop e cria os tokens de teste
//   N=1  0,01 SOL + conta vazia do token A + 1 NFT
//   N=2  0,02 SOL + 5 tokens A + conta CONGELADA do token B
//   N=3  0,005 SOL só
// Destino de teste: a carteira principal da frase (só recebe).

import fs from 'node:fs';
import { generateKeyPairSync, randomInt, sign } from 'node:crypto';
import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { burnerSigner, deriveMainAddress, mnemonicToSeed } from '../src/core/carteiras/derivation.ts';
import {
  ataCreateIdempotent,
  systemCreateAccount,
  systemTransfer,
  tokenFreezeAccount,
  tokenInitializeMint2,
  tokenMintTo,
} from '../src/core/solana/instructions.ts';
import { associatedTokenAddress, PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc } from '../src/core/solana/rpc.ts';
import { buildTransaction, type Instruction, type Signer } from '../src/core/solana/tx.ts';
import { isInsideRepo } from '../src/cli/io.ts';

const rpc = createRpc({ url: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com', requestsPerSecond: 3 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function randomSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const address = encodeBase58(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  return { address, sign: (m) => sign(null, m, privateKey) };
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

async function send(label: string, payer: Signer, ixs: Instruction[], signers: Signer[]) {
  const { value: bh } = await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = buildTransaction(payer.address, ixs, bh.blockhash, signers);
  const b64 = Buffer.from(tx.bytes).toString('base64');
  const sim = await rpc.call<{ value: { err: unknown; logs?: string[] } }>('simulateTransaction', [b64, { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  if (sim.value.err) throw new Error(`${label}: simulação falhou ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).slice(-3).join(' | ')}`);
  await rpc.call('sendTransaction', [b64, { encoding: 'base64' }]);
  await waitSig(tx.signature);
  console.log(`  ok: ${label}`);
}

async function balance(a: string) {
  return (await rpc.call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value;
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('informe o caminho do arquivo da frase de teste (fora do repositório)');
  if (isInsideRepo(file)) throw new Error('o arquivo da frase precisa ficar fora do repositório');
  if (!fs.existsSync(file)) {
    // frase descartável só para a devnet (não precisa ser BIP39 válida: o app não confere checksum)
    const words = Array.from({ length: 12 }, () => `teste${randomInt(0, 1_000_000)}`);
    fs.writeFileSync(file, words.join(' '));
    console.log('Frase de teste nova criada no arquivo informado.');
  }
  const seed = mnemonicToSeed(fs.readFileSync(file, 'utf8'));
  const [n0, n1, n2, n3] = [0, 1, 2, 3].map((n) => burnerSigner(seed, n));
  const main = deriveMainAddress(seed);
  seed.fill(0);
  console.log(`N0 ${n0.address}\nN1 ${n1.address}\nN2 ${n2.address}\nN3 ${n3.address}\nprincipal/destino ${main}`);

  if ((await balance(n0.address)) < 300_000_000) {
    console.log('Pedindo airdrop de 1 SOL de teste para N0…');
    const sig = await rpc.call<string>('requestAirdrop', [n0.address, 1_000_000_000]);
    await waitSig(sig);
  }
  console.log(`N0 tem ${(await balance(n0.address)) / 1e9} SOL de teste`);

  const rentMint = BigInt(await rpc.call<number>('getMinimumBalanceForRentExemption', [82]));
  const mintA = randomSigner();
  const mintNft = randomSigner();
  const mintB = randomSigner();
  const T = PROGRAMS.token;

  await send('cria token A (6 casas), NFT e token B (com congelamento)', n0, [
    systemCreateAccount(n0.address, mintA.address, rentMint, 82n, T),
    tokenInitializeMint2(T, mintA.address, 6, n0.address, null),
    systemCreateAccount(n0.address, mintNft.address, rentMint, 82n, T),
    tokenInitializeMint2(T, mintNft.address, 0, n0.address, null),
    systemCreateAccount(n0.address, mintB.address, rentMint, 82n, T),
    tokenInitializeMint2(T, mintB.address, 6, n0.address, n0.address),
  ], [n0, mintA, mintNft, mintB]);

  // a carteira da taxa do app precisa existir na rede (senão o app para antes de tudo): na devnet, 0,01 SOL de teste
  const feeWallet = (await balance(APP_FEE_WALLET)) < 1_000_000 ? [systemTransfer(n0.address, APP_FEE_WALLET, 10_000_000n)] : [];
  await send('SOL para N1, N2, N3, destino e carteira da taxa', n0, [
    systemTransfer(n0.address, n1.address, 10_000_000n),
    systemTransfer(n0.address, n2.address, 20_000_000n),
    systemTransfer(n0.address, n3.address, 5_000_000n),
    systemTransfer(n0.address, main, 10_000_000n),
    ...feeWallet,
  ], [n0]);

  await send('N1: conta vazia do token A + 1 NFT', n0, [
    ataCreateIdempotent(n0.address, n1.address, mintA.address, T),
    ataCreateIdempotent(n0.address, n1.address, mintNft.address, T),
    tokenMintTo(T, mintNft.address, associatedTokenAddress(n1.address, mintNft.address, T), n0.address, 1n),
  ], [n0]);

  await send('N2: 5 tokens A + conta congelada do token B', n0, [
    ataCreateIdempotent(n0.address, n2.address, mintA.address, T),
    tokenMintTo(T, mintA.address, associatedTokenAddress(n2.address, mintA.address, T), n0.address, 5_000_000n),
    ataCreateIdempotent(n0.address, n2.address, mintB.address, T),
    tokenFreezeAccount(T, associatedTokenAddress(n2.address, mintB.address, T), mintB.address, n0.address),
  ], [n0]);

  console.log(`\nCenário pronto. Token A: ${mintA.address}  NFT: ${mintNft.address}  Token B (congelado em N2): ${mintB.address}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : 'erro');
  process.exit(1);
});
