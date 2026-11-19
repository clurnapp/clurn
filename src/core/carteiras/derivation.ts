// Derivação de carteiras a partir da frase de recuperação, igual ao Solflare.
// Detalhes e prova em docs/derivacao-solflare.md.
//
// Regra de segurança: nada neste arquivo registra, grava ou devolve a frase ou a seed
// em mensagem de erro. Só endereços públicos saem daqui.

import { createHmac, createPrivateKey, createPublicKey, pbkdf2Sync } from 'node:crypto';
import { encodeBase58 } from '../solana/base58.ts';
import { signerFromPrivateKey, type Signer } from '../solana/tx.ts';

const HARDENED = 0x80000000;
export const BURNER_OFFSET = 10000;

export function burnerPath(n: number): string {
  return `m/44'/501'/${n + BURNER_OFFSET}'/0'/0'`;
}

export function standardPath(i: number): string {
  return `m/44'/501'/${i}'/0'`;
}

// Trust Wallet e Phantom antiga (06/11/2026, docs/pesquisa-multirredes.md): m/44'/501'/i', sem o /0' do fim.
// A conta 0 é a principal da Trust. Vetor público em test/carteiras/derivation.test.ts.
export function trustPath(i: number): string {
  return `m/44'/501'/${i}'`;
}

// Mesma normalização do Solflare: minúsculas, espaços simples.
export function normalizeMnemonic(text: string): string {
  return text.trim().toLowerCase().split(/\s+/).join(' ');
}

export function mnemonicWordCount(text: string): number {
  const t = normalizeMnemonic(text);
  return t === '' ? 0 : t.split(' ').length;
}

// BIP39: frase -> seed de 64 bytes (sem senha extra, como o Solflare).
export function mnemonicToSeed(mnemonic: string, passphrase = ''): Buffer {
  const m = normalizeMnemonic(mnemonic).normalize('NFKD');
  const salt = ('mnemonic' + passphrase).normalize('NFKD');
  return pbkdf2Sync(Buffer.from(m, 'utf8'), Buffer.from(salt, 'utf8'), 2048, 64, 'sha512');
}

type Node = { key: Buffer; chainCode: Buffer };

function masterNode(seed: Uint8Array): Node {
  const I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

function childNode(parent: Node, index: number): Node {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(index + HARDENED);
  const I = createHmac('sha512', parent.chainCode)
    .update(Buffer.concat([Buffer.alloc(1, 0), parent.key, idx]))
    .digest();
  return { key: I.subarray(0, 32), chainCode: I.subarray(32) };
}

// SLIP-0010 ed25519: só índices hardened ("44'").
export function derivePrivateKey(seed: Uint8Array, path: string): Buffer {
  const parts = path.split('/');
  if (parts[0] !== 'm') throw new Error('caminho de derivação inválido');
  let node = masterNode(seed);
  for (const p of parts.slice(1)) {
    if (!/^\d+'$/.test(p)) throw new Error('caminho de derivação inválido');
    node = childNode(node, Number(p.slice(0, -1)));
  }
  return node.key;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function publicKeyFromPrivate(privateKey: Uint8Array): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, privateKey]),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
}

export function addressAt(seed: Uint8Array, path: string): string {
  const priv = derivePrivateKey(seed, path);
  try {
    return encodeBase58(publicKeyFromPrivate(priv));
  } finally {
    priv.fill(0);
  }
}

export type DerivedWallet = { index: number; path: string; address: string };

// De onde vêm as burners (confirmado pelo autor, 30/10/2026):
// - Solflare: "Carteira Temporária", ramo próprio m/44'/501'/(N+10000)'/0'/0' (N = 0, 1, 2...);
// - Phantom: não tem temporária; as burners são contas comuns m/44'/501'/N'/0' e a Conta 1 (N=0) é a principal;
// - Trust e Phantom antiga (06/11/2026): contas m/44'/501'/N' e a conta 0 é a principal.
export type WalletApp = 'solflare' | 'phantom' | 'trust';
// Cartão da tela: um app de carteira (frase) ou uma lista de chaves privadas coladas (src/core/carteiras/keys.ts).
// Chaves não têm caminho nem principal: nunca passam por walletPath/burnerSigner.
export type CardApp = WalletApp | 'chaves';

// Na Phantom a Conta 1 NUNCA é limpa: o app nem cria chave para ela. Na Trust, a conta 0, do mesmo jeito.
export const PHANTOM_MAIN_INDEX = 0;
export const TRUST_MAIN_INDEX = 0;

// índice da principal no caminho do app; null quando o caminho não tem principal (Solflare: o ramo 10000+
// fica longe dela por construção; chaves coladas: o app não sabe qual é a principal)
export function mainIndexOf(app: CardApp): number | null {
  if (app === 'phantom') return PHANTOM_MAIN_INDEX;
  if (app === 'trust') return TRUST_MAIN_INDEX;
  return null;
}

// a principal mora no mesmo caminho das burners (Phantom, Trust): nunca ganha chave e nunca entra na limpeza
export function hasMainAccount(app: CardApp): boolean {
  return mainIndexOf(app) !== null;
}

// as carteiras passam pela conferência (proteger, alertas, contagem digitada) antes do plano
export function needsReview(app: CardApp): boolean {
  return app === 'phantom' || app === 'trust' || app === 'chaves';
}

// é a principal deste caminho? (a regra única de "nunca assina, nunca limpa")
export function isMainAccount(app: CardApp, n: number): boolean {
  return mainIndexOf(app) === n;
}

export function walletPath(app: WalletApp, n: number): string {
  if (app === 'phantom') return standardPath(n);
  if (app === 'trust') return trustPath(n);
  return burnerPath(n);
}

export function walletLabel(app: CardApp, n: number): string {
  if (app === 'chaves') return `Chave ${n + 1}`;
  return app === 'solflare' ? `N=${n}` : `Conta ${n + 1}`;
}

export function deriveBurner(seed: Uint8Array, n: number, app: WalletApp = 'solflare'): DerivedWallet {
  const path = walletPath(app, n);
  return { index: n, path, address: addressAt(seed, path) };
}

// Signatário de uma burner. Solflare: só o ramo 10000+. Phantom e Trust: nunca a principal (Conta 1 / conta 0).
export function burnerSigner(seed: Uint8Array, n: number, app: WalletApp = 'solflare'): Signer & { index: number } {
  if (isMainAccount(app, n)) throw new Error(app === 'phantom' ? 'a Conta 1 é a principal: o app não cria chave para ela' : 'a conta 0 é a principal: o app não cria chave para ela');
  const priv = derivePrivateKey(seed, walletPath(app, n));
  try {
    const address = encodeBase58(publicKeyFromPrivate(priv));
    return { index: n, ...signerFromPrivateKey(address, priv) };
  } finally {
    priv.fill(0);
  }
}

// Usada só para o usuário conferir que digitou a frase certa. Nunca entra em ação nenhuma.
export function deriveMainAddress(seed: Uint8Array): string {
  return addressAt(seed, standardPath(0));
}

// As principais da frase nos caminhos com principal: Conta 1 da Phantom/Solflare e conta 0 da Trust.
// Nenhuma delas assina nada; servem para reconhecer a principal (chave colada igual a ela, destino).
export function mainAddresses(seed: Uint8Array): string[] {
  return [addressAt(seed, standardPath(PHANTOM_MAIN_INDEX)), addressAt(seed, trustPath(TRUST_MAIN_INDEX))];
}
