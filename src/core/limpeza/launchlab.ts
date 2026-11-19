// Creator fee do Raydium LaunchLab (bonk.fun/letsbonk e outros launchpads sobre o LaunchLab).
// SÓ LEITURA: quanto de fee em SOL a carteira tem para coletar. Quem coleta é o executor (passo claim-launchlab).
// Fontes, conferidas em 09/11/2026 (docs/launchlab.md): IDL 0.2.0 (github.com/raydium-io/raydium-idl,
// raydium_launchpad/raydium_launchpad.json), contexto ClaimCreatorFee do crate CPI (github.com/raydium-io/raydium-cpi,
// programs/launch-cpi, commit 115df27 de 20/07/2026) e o SDK V2 (src/raydium/launchpad, commit 1cf5bb1 de 06/11/2026).
// O código do programa não é público: o efeito da coleta foi medido por simulação na mainnet (scripts/conferir-launchlab.ts).
//
// A fee do criador não fica no pool: a cada troca ela entra num cofre (conta de token) do criador por moeda de cotação,
// no PDA [creator, quote_mint] do programa, com dono (authority) o PDA ["creator_fee_vault_auth_seed"]. Então basta
// ler UMA conta por carteira (sem getProgramAccounts). Na mainnet, em 09/11/2026: 71.843 cofres em WSOL, 652 SOL parados.

import { decodeBase58, encodeBase58 } from '../solana/base58.ts';
import { findProgramAddress, PROGRAMS, WSOL_MINT } from '../solana/pda.ts';
import type { RpcClient } from '../solana/rpc.ts';

export const LAUNCHLAB_FEE_VAULT_AUTH_SEED = 'creator_fee_vault_auth_seed';
// = PDA ["creator_fee_vault_auth_seed"] do LaunchLab (conferido no teste e na mainnet)
export const LAUNCHLAB_FEE_VAULT_AUTH = '9sHpTfmVpCfP2zexRNK6j38NBchMv1RWpdXPK5NEcZan';
// Moedas de cotação em que o app só AVISA (não coleta): USD1 (pares do bonk.fun), USDC e USDT. Outras cotações vistas
// nas transações (moedas Token-2022) não são lidas: ficam fora do aviso.
export const LAUNCHLAB_OTHER_QUOTES = [
  'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
] as const;
const TOKEN_ACCOUNT_BYTES = 165;

export function launchlabCreatorFeeVault(creator: string, quoteMint: string = WSOL_MINT): string {
  return findProgramAddress([decodeBase58(creator), decodeBase58(quoteMint)], PROGRAMS.raydiumLaunchlab).address;
}

export type LaunchlabFees = {
  vault: string; // cofre em WSOL desta carteira
  lamports: bigint; // fee em SOL a coletar (saldo de token do cofre; 0 se o cofre não existe)
  other: number; // cofres com fee em outra moeda (USD1, USDC, USDT) que o app não coleta
};

type RawAcc = { owner?: unknown; lamports?: unknown; data?: unknown[] } | null;

// Conta do cofre: null = não existe (nada a coletar). Conta que existe e não é cofre deste criador nesta moeda (dono,
// tamanho, mint, authority, estado) LANÇA: "não sei", nunca "sem fee".
export function parseLaunchlabVault(a: RawAcc, quoteMint: string, programs: readonly string[] = [PROGRAMS.token]): bigint | null {
  if (a === null) return null;
  const raw = a?.data?.[0];
  if (typeof raw !== 'string' || typeof a?.owner !== 'string') throw new Error('cofre do LaunchLab fora do formato');
  if (!programs.includes(a.owner)) throw new Error('cofre do LaunchLab com dono inesperado');
  const d = Buffer.from(raw, 'base64');
  // Token: 165 bytes. Token-2022 (outra cotação): 165 + extensões
  if (d.length < TOKEN_ACCOUNT_BYTES || (a.owner === PROGRAMS.token && d.length !== TOKEN_ACCOUNT_BYTES)) throw new Error('cofre do LaunchLab com tamanho inesperado');
  if (encodeBase58(d.subarray(0, 32)) !== quoteMint) throw new Error('cofre do LaunchLab de outra moeda');
  if (encodeBase58(d.subarray(32, 64)) !== LAUNCHLAB_FEE_VAULT_AUTH) throw new Error('cofre do LaunchLab com outra authority');
  if (d[108] !== 1) throw new Error('cofre do LaunchLab congelado ou não inicializado'); // 1 = Initialized
  return d.readBigUInt64LE(64);
}

// Cofres da carteira: 1 getMultipleAccounts (WSOL + as outras cotações avisadas). Erro de consulta ou resposta fora do
// formato lança (o scan marca "fee do LaunchLab: não lida").
export async function launchlabFees(rpc: RpcClient, wallet: string): Promise<LaunchlabFees> {
  const quotes = [WSOL_MINT, ...LAUNCHLAB_OTHER_QUOTES];
  const keys = quotes.map((q) => launchlabCreatorFeeVault(wallet, q));
  const r = await rpc.call<{ value?: RawAcc[] }>('getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!Array.isArray(r?.value) || r.value.length !== keys.length) throw new Error('getMultipleAccounts (LaunchLab): resposta fora do formato');
  const sol = parseLaunchlabVault(r.value[0], WSOL_MINT) ?? 0n;
  let other = 0;
  quotes.slice(1).forEach((q, i) => {
    const amount = parseLaunchlabVault(r.value![i + 1], q, [PROGRAMS.token, PROGRAMS.token2022]);
    if (amount !== null && amount > 0n) other++;
  });
  return { vault: keys[0], lamports: sol, other };
}

// Releitura do cofre em WSOL (executor, antes de montar a coleta). null = não existe. Lança se fora do formato.
export async function readLaunchlabVault(rpc: RpcClient, wallet: string): Promise<bigint | null> {
  const vault = launchlabCreatorFeeVault(wallet);
  const r = await rpc.call<{ value?: RawAcc[] }>('getMultipleAccounts', [[vault], { encoding: 'base64', commitment: 'confirmed' }]);
  if (!Array.isArray(r?.value) || r.value.length !== 1) throw new Error('getMultipleAccounts (LaunchLab): resposta fora do formato');
  return parseLaunchlabVault(r.value[0], WSOL_MINT);
}

export const launchlabClaimLamports = (f: LaunchlabFees | undefined) => f?.lamports ?? 0n;
