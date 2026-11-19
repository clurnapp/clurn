// Cenário DEVNET para o cartão de chaves privadas (rede de testes, dinheiro de mentira). Chaves descartáveis geradas
// aqui, gravadas num arquivo FORA do repositório e nunca impressas (só endereços públicos saem na tela).
//
//   node scripts/devnet-chaves.ts preparar <pasta-fora-do-repo> [--pagadora <arquivo-de-frase-da-devnet>]
//   node scripts/devnet-chaves.ts saldos   <pasta-fora-do-repo>
//
// preparar: cria chaves.txt (4 chaves, uma por linha, em 3 formatos: base58 de 64 bytes, lista de 64 números e hex
// com "0x") e destino.txt (endereço público do destino), se faltarem, e monta o cenário:
//   Chave 1: 0,03 SOL
//   Chave 2: 0,02 SOL + 5 moedas A
//   Chave 3: 0,01 SOL + conta vazia da moeda A
//   Chave 4: 0 SOL + 3 moedas A (quem paga a taxa de rede dela é a pagadora da rodada)
//   destino: carteira nova só com o aluguel mínimo (o app exige destino que já existe na rede)
// A moeda A (6 casas) é criada pelo script, sem preço em lugar nenhum: aparece como "valor desconhecido".
// O SOL vem de um airdrop da devnet (com espera entre as tentativas); se o faucet recusar (está fechado por RPC desde
// 30/10/2026), vem da conta padrão nº 0 da frase de teste informada em --pagadora (a mesma pagadora de
// scripts/devnet-frases.ts, abastecida por fora).
// saldos: SOL e contas de token de cada chave, do destino e da carteira da taxa (para o antes e o depois).
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { APP_FEE_WALLET } from '../src/core/limpeza/app-fee.ts';
import { encodeBase58 } from '../src/core/solana/base58.ts';
import { parseKeys, wipeParsedKeys } from '../src/core/carteiras/keys.ts';
import { derivePrivateKey, mnemonicToSeed, publicKeyFromPrivate, standardPath } from '../src/core/carteiras/derivation.ts';
import { ataCreateIdempotent, systemCreateAccount, systemTransfer, tokenInitializeMint2, tokenMintTo } from '../src/core/solana/instructions.ts';
import { associatedTokenAddress, PROGRAMS } from '../src/core/solana/pda.ts';
import { createRpc } from '../src/core/solana/rpc.ts';
import { buildTransaction, signerFromPrivateKey, type Instruction, type Signer } from '../src/core/solana/tx.ts';
import { isInsideRepo } from '../src/cli/io.ts';

const rpc = createRpc({ url: 'https://api.devnet.solana.com', requestsPerSecond: 3 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T = PROGRAMS.token;

// par novo: 32 bytes da semente + pública (o formato de 64 bytes que as carteiras exportam)
function newKeypairBytes(): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return Buffer.concat([seed, pub]);
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
  console.log(`  ok: ${label} (${tx.signature})`);
}
const balance = async (a: string) => (await rpc.call<{ value: number }>('getBalance', [a, { commitment: 'confirmed' }])).value;
async function tokenAccounts(owner: string) {
  const r = await rpc.call<{ value: Array<{ account: { lamports: number; data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }> }>(
    'getTokenAccountsByOwner', [owner, { programId: T }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return r.value.map((x) => ({ mint: x.account.data.parsed.info.mint, amount: x.account.data.parsed.info.tokenAmount.amount, lamports: x.account.lamports }));
}

// airdrop com espera entre as tentativas; null quando o faucet não deu (limite, HTTP 410/429)
async function tryAirdrop(to: string, lamports: number): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      const sig = await rpc.call<string>('requestAirdrop', [to, lamports]);
      await waitSig(sig);
      return true;
    } catch (e) {
      console.log(`  airdrop recusado (tentativa ${i + 1}/3): ${e instanceof Error ? e.message.slice(0, 120) : 'erro'}`);
      if (i < 2) await sleep(10_000 * (i + 1));
    }
  }
  return false;
}

// a pagadora: a conta padrão nº 0 de uma frase de teste da devnet (a semente é lida, usada e zerada)
function payerFromPhrase(file: string): Signer {
  if (isInsideRepo(file)) throw new Error('a frase da pagadora precisa ficar fora do repositório');
  const seed = mnemonicToSeed(fs.readFileSync(file, 'utf8'));
  const priv = derivePrivateKey(seed, standardPath(0));
  seed.fill(0);
  const s = signerFromPrivateKey(encodeBase58(publicKeyFromPrivate(priv)), priv);
  priv.fill(0);
  return s;
}

// lê chaves.txt pelo mesmo leitor do app (só endereços e chaves de assinatura saem; bytes zerados)
function readKeys(dir: string): Signer[] {
  const parsed = parseKeys(fs.readFileSync(path.join(dir, 'chaves.txt'), 'utf8'));
  if (!parsed.ok) throw new Error(`chaves.txt não passou no leitor do app: ${parsed.code} linha ${parsed.params.line ?? '?'}`);
  try {
    return parsed.keys.map((k) => signerFromPrivateKey(k.address, k.secret));
  } finally {
    wipeParsedKeys(parsed.keys);
  }
}

const args = process.argv.slice(2);
const [mode, dir] = args;
const payerFile = args.includes('--pagadora') ? args[args.indexOf('--pagadora') + 1] : undefined;
if (!['preparar', 'saldos'].includes(mode ?? '') || !dir) throw new Error('uso: preparar|saldos <pasta-fora-do-repo> [--pagadora <arquivo>]');
if (isInsideRepo(dir)) throw new Error('a pasta das chaves precisa ficar fora do repositório');

if (mode === 'preparar') {
  fs.mkdirSync(dir, { recursive: true });
  const keysFile = path.join(dir, 'chaves.txt');
  const destFile = path.join(dir, 'destino.txt');
  if (fs.existsSync(keysFile)) throw new Error('chaves.txt já existe: use outra pasta (o cenário é montado uma vez)');
  const pairs = [0, 1, 2, 3].map(() => newKeypairBytes());
  // formatos variados, como as carteiras e os bots exportam (o leitor do app aceita os três)
  const lines = [
    encodeBase58(pairs[0]!),
    `[${[...pairs[1]!].join(',')}]`,
    `0x${pairs[2]!.toString('hex')}`,
    `  ${encodeBase58(pairs[3]!)}  `,
  ];
  fs.writeFileSync(keysFile, lines.join('\r\n') + '\r\n', { mode: 0o600 });
  lines.fill('');
  for (const p of pairs) p.fill(0);
  const keys = readKeys(dir);
  const dest = randomSigner(); // o destino só recebe: a chave dele nem é guardada
  fs.writeFileSync(destFile, dest.address);
  keys.forEach((k, i) => console.log(`Chave ${i + 1}: ${k.address}`));
  console.log(`destino: ${dest.address}`);

  const NEED = 100_000_000; // 0,1 SOL cobre o cenário (~0,07) com folga
  const funder = randomSigner();
  let payer: Signer;
  console.log('Pedindo airdrop de 0,1 SOL de teste…');
  if (await tryAirdrop(funder.address, NEED)) payer = funder;
  else {
    if (!payerFile) throw new Error('o faucet da devnet recusou e não há --pagadora <arquivo-de-frase-da-devnet>');
    payer = payerFromPhrase(payerFile);
    console.log(`faucet fechado: SOL da pagadora ${payer.address}`);
  }
  const before = await balance(payer.address);
  console.log(`pagadora: ${before / 1e9} SOL devnet`);
  if (before < NEED) throw new Error('a pagadora tem menos de 0,1 SOL de teste');

  const [k1, k2, k3, k4] = keys as [Signer, Signer, Signer, Signer];
  const rentMint = BigInt(await rpc.call<number>('getMinimumBalanceForRentExemption', [82]));
  const rentWallet = BigInt(await rpc.call<number>('getMinimumBalanceForRentExemption', [0]));
  const mintA = randomSigner();
  await send('moeda A (6 casas, sem preço)', payer, [
    systemCreateAccount(payer.address, mintA.address, rentMint, 82n, T),
    tokenInitializeMint2(T, mintA.address, 6, payer.address, null),
  ], [mintA]);
  // a carteira da taxa precisa existir na devnet (senão o app para antes de tudo)
  const fee = (await balance(APP_FEE_WALLET)) < 1_000_000 ? [systemTransfer(payer.address, APP_FEE_WALLET, 10_000_000n)] : [];
  await send('SOL nas chaves 1 a 3, aluguel no destino', payer, [
    systemTransfer(payer.address, k1.address, 30_000_000n),
    systemTransfer(payer.address, k2.address, 20_000_000n),
    systemTransfer(payer.address, k3.address, 10_000_000n),
    systemTransfer(payer.address, dest.address, rentWallet),
    ...fee,
  ]);
  await send('moeda A: 5 na Chave 2, conta vazia na Chave 3, 3 na Chave 4', payer, [
    ataCreateIdempotent(payer.address, k2.address, mintA.address, T),
    tokenMintTo(T, mintA.address, associatedTokenAddress(k2.address, mintA.address, T), payer.address, 5_000_000n),
    ataCreateIdempotent(payer.address, k3.address, mintA.address, T),
    ataCreateIdempotent(payer.address, k4.address, mintA.address, T),
    tokenMintTo(T, mintA.address, associatedTokenAddress(k4.address, mintA.address, T), payer.address, 3_000_000n),
  ]);
  console.log(`\nCenário pronto. Moeda A: ${mintA.address}. Pagadora agora: ${(await balance(payer.address)) / 1e9} SOL devnet`);
} else {
  const keys = readKeys(dir);
  const dest = fs.readFileSync(path.join(dir, 'destino.txt'), 'utf8').trim();
  const rows: Array<[string, string]> = [...keys.map((k, i) => [`Chave ${i + 1}`, k.address] as [string, string]), ['destino', dest], ['taxa do app', APP_FEE_WALLET]];
  for (const [name, a] of rows) {
    const t = await tokenAccounts(a);
    console.log(`${name} ${a}: ${await balance(a)} lamports; ${t.length} conta(s) de token${t.length ? ' ' + JSON.stringify(t) : ''}`);
  }
}
