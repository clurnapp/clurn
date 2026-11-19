// Instruções usadas pelo app. Cada uma com a referência do layout no programa oficial.

import { decodeBase58 } from './base58.ts';
import { PROGRAMS, findProgramAddress, associatedTokenAddress, pumpAmmCreatorVaultAuthority, pumpAmmCreatorVaultAta, pumpCreatorVault, userVolumeAccumulator, WSOL_MINT } from './pda.ts';
import type { Instruction } from './tx.ts';

const w = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: string, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

function u64(n: bigint): Buffer {
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error('valor fora de u64');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

// ---------- Compute Budget (taxa de prioridade) ----------

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

// SetComputeUnitLimit = 2: units u32
export function computeUnitLimit(units: number): Instruction {
  const d = Buffer.alloc(5);
  d[0] = 2;
  d.writeUInt32LE(units, 1);
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: d };
}

// SetComputeUnitPrice = 3: microLamports u64 (por unidade de processamento)
export function computeUnitPrice(microLamports: bigint): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([3]), u64(microLamports)]) };
}

// ---------- System Program ----------

// SystemInstruction::Transfer = 2 (u32), lamports u64
export function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  return { programId: PROGRAMS.system, keys: [w(from, true), w(to)], data: Buffer.concat([Buffer.from([2, 0, 0, 0]), u64(lamports)]) };
}

// SystemInstruction::CreateAccount = 0: lamports u64, space u64, owner [32]
export function systemCreateAccount(from: string, newAccount: string, lamports: bigint, space: bigint, owner: string): Instruction {
  return {
    programId: PROGRAMS.system,
    keys: [w(from, true), w(newAccount, true)],
    data: Buffer.concat([Buffer.from([0, 0, 0, 0]), u64(lamports), u64(space), decodeBase58(owner)]),
  };
}

// ---------- SPL Token / Token-2022 (mesmos códigos nos dois programas) ----------

// Burn = 8: amount u64. Contas: conta de token (W), mint (W), dono (S)
export function tokenBurn(tokenProgram: string, account: string, mint: string, owner: string, amount: bigint): Instruction {
  return { programId: tokenProgram, keys: [w(account), w(mint), r(owner, true)], data: Buffer.concat([Buffer.from([8]), u64(amount)]) };
}

// CloseAccount = 9. Contas: conta de token (W), destino do aluguel (W), dono (S)
export function tokenCloseAccount(tokenProgram: string, account: string, destination: string, owner: string): Instruction {
  return { programId: tokenProgram, keys: [w(account), w(destination), r(owner, true)], data: Buffer.from([9]) };
}

// TransferChecked = 12: amount u64, decimals u8. Contas: origem (W), mint, destino (W), dono (S)
export function tokenTransferChecked(tokenProgram: string, source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number): Instruction {
  return {
    programId: tokenProgram,
    keys: [w(source), r(mint), w(destination), r(owner, true)],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  };
}

// InitializeMint2 = 20: decimals u8, mint authority [32], freeze authority COption<[32]>
export function tokenInitializeMint2(tokenProgram: string, mint: string, decimals: number, mintAuthority: string, freezeAuthority: string | null): Instruction {
  const freeze = freezeAuthority ? Buffer.concat([Buffer.from([1]), decodeBase58(freezeAuthority)]) : Buffer.from([0]);
  return { programId: tokenProgram, keys: [w(mint)], data: Buffer.concat([Buffer.from([20, decimals]), decodeBase58(mintAuthority), freeze]) };
}

// MintTo = 7: amount u64. Contas: mint (W), conta de destino (W), autoridade (S)
export function tokenMintTo(tokenProgram: string, mint: string, account: string, authority: string, amount: bigint): Instruction {
  return { programId: tokenProgram, keys: [w(mint), w(account), r(authority, true)], data: Buffer.concat([Buffer.from([7]), u64(amount)]) };
}

// FreezeAccount = 10. Contas: conta (W), mint, autoridade de congelamento (S)
export function tokenFreezeAccount(tokenProgram: string, account: string, mint: string, authority: string): Instruction {
  return { programId: tokenProgram, keys: [w(account), r(mint), r(authority, true)], data: Buffer.from([10]) };
}

// ---------- Associated Token Account ----------

// CreateIdempotent = 1. Contas: pagador (WS), ATA (W), dono, mint, system, token program
export function ataCreateIdempotent(payer: string, owner: string, mint: string, tokenProgram: string): Instruction {
  return {
    programId: PROGRAMS.associatedToken,
    keys: [w(payer, true), w(associatedTokenAddress(owner, mint, tokenProgram)), r(owner), r(mint), r(PROGRAMS.system), r(tokenProgram)],
    data: Buffer.from([1]),
  };
}

// ---------- Pump.fun (docs/pumpfun-creator-fees.md, IDL commit 639b87fb) ----------

const DISC = {
  distributeCreatorFeesV2: 'ffcb134ff444089f',
  claimCashbackV2: '7af3cc415e741d37', // Pump.fun
  claimCashback: '253a237ebe35e4c5', // PumpSwap (mesmo nome, mesmo discriminador)
  transferCreatorFeesToPumpV2: '01214eb921432c5c',
  collectCreatorFeeV2: 'cf118af204221338',
  collectCoinCreatorFee: 'a039592ab58b2b42',
  sweepCreatorFee: '20f6bf3408c949ba', // mesmo discriminador na curva e no PumpSwap (programas diferentes)
  closeUserVolumeAccumulator: 'f945a4da9667548a', // igual nos dois programas (IDL relido em 06/11/2026, 639b87fb)
};

function eventAuthority(program: string): string {
  return findProgramAddress(['__event_authority'], program).address;
}

// Curva: coleta o cofre de creator fee em SOL para o próprio criador (permissionless).
export function pumpCollectCreatorFeeV2(creator: string): Instruction {
  const vault = pumpCreatorVault(creator);
  return {
    programId: PROGRAMS.pump,
    keys: [
      w(creator),
      w(associatedTokenAddress(creator, WSOL_MINT, PROGRAMS.token)),
      w(vault),
      w(associatedTokenAddress(vault, WSOL_MINT, PROGRAMS.token)),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(PROGRAMS.associatedToken),
      r(PROGRAMS.system),
      r(eventAuthority(PROGRAMS.pump)),
      r(PROGRAMS.pump),
    ],
    data: Buffer.from(DISC.collectCreatorFeeV2, 'hex'),
  };
}

// Curva: leva a fee "não varrida" (BondingCurve.creator_fee, das trocas buy_v3/sell_v3) para o cofre do criador.
// Permissionless, sem dados; só moeda pareada em SOL. Contas na ordem do IDL (docs/instructions/SWEEP_FEES.md,
// commit 639b87fb). O `payer` paga um eventual reforço de aluguel da curva (layout antigo) e do cofre.
export function pumpSweepCreatorFee(payer: string, creator: string, mint: string): Instruction {
  const curve = findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address;
  const vault = pumpCreatorVault(creator);
  return {
    programId: PROGRAMS.pump,
    keys: [
      w(payer, true),
      r(findProgramAddress(['global'], PROGRAMS.pump).address),
      r(mint),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(PROGRAMS.associatedToken),
      r(PROGRAMS.system),
      w(curve),
      w(associatedTokenAddress(curve, WSOL_MINT, PROGRAMS.token)), // moeda em SOL: endereço derivado, não usado
      w(vault),
      w(associatedTokenAddress(vault, WSOL_MINT, PROGRAMS.token)), // idem
      r(eventAuthority(PROGRAMS.pump)),
      r(PROGRAMS.pump),
    ],
    data: Buffer.from(DISC.sweepCreatorFee, 'hex'),
  };
}

// PumpSwap: leva Pool.creator_fees (trocas buy_v2/sell_v2) do cofre WSOL do pool para o cofre WSOL do criador.
// Permissionless, sem dados; só pool com quote WSOL. O `payer` cria a ATA do cofre se faltar.
export const PUMP_AMM_GLOBAL_CONFIG = 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw';
export function pumpAmmSweepCreatorFee(payer: string, creator: string, pool: string, poolQuoteAccount: string): Instruction {
  return {
    programId: PROGRAMS.pumpAmm,
    keys: [
      w(payer, true),
      r(PUMP_AMM_GLOBAL_CONFIG),
      w(pool),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      w(poolQuoteAccount),
      r(pumpAmmCreatorVaultAuthority(creator)),
      w(pumpAmmCreatorVaultAta(creator)),
      r(PROGRAMS.system),
      r(PROGRAMS.associatedToken),
      r(eventAuthority(PROGRAMS.pumpAmm)),
      r(PROGRAMS.pumpAmm),
    ],
    data: Buffer.from(DISC.sweepCreatorFee, 'hex'),
  };
}

// PumpSwap: move o WSOL do cofre para a ATA WSOL do criador (que precisa existir).
export function pumpAmmCollectCoinCreatorFee(creator: string): Instruction {
  return {
    programId: PROGRAMS.pumpAmm,
    keys: [
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(creator),
      r(pumpAmmCreatorVaultAuthority(creator)),
      w(pumpAmmCreatorVaultAta(creator)),
      w(associatedTokenAddress(creator, WSOL_MINT, PROGRAMS.token)),
      r(eventAuthority(PROGRAMS.pumpAmm)),
      r(PROGRAMS.pumpAmm),
    ],
    data: Buffer.from(DISC.collectCoinCreatorFee, 'hex'),
  };
}

// Fee sharing (IDL 639b87fb, docs/instructions/CREATOR_FEE_SHARING.md): paga o cofre da curva do sharing config
// a cada participante, na proporção dele. Sem permissão (só a pagadora assina). Moeda em SOL: os lamports vão direto
// a cada participante (contas restantes, na ordem do config, graváveis); initialize_ata não é usado em SOL (false).
export function pumpDistributeCreatorFeesV2(payer: string, mint: string, sharingConfig: string, shareholders: string[]): Instruction {
  const vault = pumpCreatorVault(sharingConfig);
  return {
    programId: PROGRAMS.pump,
    keys: [
      w(payer, true),
      r(mint),
      r(findProgramAddress(['bonding-curve', decodeBase58(mint)], PROGRAMS.pump).address),
      r(sharingConfig),
      w(vault),
      r(PROGRAMS.system),
      r(eventAuthority(PROGRAMS.pump)),
      r(PROGRAMS.pump),
      w(associatedTokenAddress(vault, WSOL_MINT, PROGRAMS.token)), // moeda em SOL: endereço derivado, não usado
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(PROGRAMS.associatedToken),
      ...shareholders.map((s) => w(s)),
    ],
    data: Buffer.concat([Buffer.from(DISC.distributeCreatorFeesV2, 'hex'), Buffer.from([0])]),
  };
}

// Fee sharing de moeda migrada: leva a fee do cofre do PumpSwap do sharing config para o cofre da curva dele (a
// distribuição paga dali). Sem permissão. O cofre do PumpSwap (ATA WSOL) precisa existir.
export function pumpAmmTransferCreatorFeesToPumpV2(payer: string, coinCreator: string): Instruction {
  const pumpVault = pumpCreatorVault(coinCreator);
  return {
    programId: PROGRAMS.pumpAmm,
    keys: [
      w(payer, true),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(PROGRAMS.system),
      r(PROGRAMS.associatedToken),
      r(coinCreator),
      w(pumpAmmCreatorVaultAuthority(coinCreator)),
      w(pumpAmmCreatorVaultAta(coinCreator)),
      w(pumpVault),
      w(associatedTokenAddress(pumpVault, WSOL_MINT, PROGRAMS.token)), // moeda em SOL: não usado
      r(eventAuthority(PROGRAMS.pumpAmm)),
      r(PROGRAMS.pumpAmm),
    ],
    data: Buffer.from(DISC.transferCreatorFeesToPumpV2, 'hex'),
  };
}

// Cashback de quem negociou moeda com cashback (IDL 639b87fb, docs/instructions/CLAIM_CASHBACK.md). Sem permissão:
// o usuário recebe e não assina. Pump.fun, em SOL: os lamports acima do aluguel do acumulador vão para o usuário.
export function pumpClaimCashbackV2(user: string): Instruction {
  const uva = userVolumeAccumulator(user, PROGRAMS.pump);
  return {
    programId: PROGRAMS.pump,
    keys: [
      w(user),
      w(uva),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      r(PROGRAMS.associatedToken),
      w(associatedTokenAddress(uva, WSOL_MINT, PROGRAMS.token)), // em SOL não é usada
      w(associatedTokenAddress(user, WSOL_MINT, PROGRAMS.token)), // idem
      r(PROGRAMS.system),
      r(eventAuthority(PROGRAMS.pump)),
      r(PROGRAMS.pump),
    ],
    data: Buffer.from(DISC.claimCashbackV2, 'hex'),
  };
}

// PumpSwap: o cashback é WSOL na ATA do acumulador e vai para a ATA WSOL do usuário (que tem que existir).
export function pumpAmmClaimCashback(user: string): Instruction {
  const uva = userVolumeAccumulator(user, PROGRAMS.pumpAmm);
  return {
    programId: PROGRAMS.pumpAmm,
    keys: [
      w(user),
      w(uva),
      r(WSOL_MINT),
      r(PROGRAMS.token),
      w(associatedTokenAddress(uva, WSOL_MINT, PROGRAMS.token)),
      w(associatedTokenAddress(user, WSOL_MINT, PROGRAMS.token)),
      r(PROGRAMS.system),
      r(eventAuthority(PROGRAMS.pumpAmm)),
      r(PROGRAMS.pumpAmm),
    ],
    data: Buffer.from(DISC.claimCashback, 'hex'),
  };
}

// Fecha a conta de volume (UserVolumeAccumulator) da Pump.fun ou do PumpSwap (IDL 639b87fb, relido em 06/11/2026):
// close_user_volume_accumulator, sem argumentos, contas user (W, S), user_volume_accumulator (W), event_authority,
// program. Todos os lamports da conta vão para o `user` (simulado na mainnet em 06/11/2026). Só o próprio usuário
// assina: a temporária. O app só fecha a conta que não guarda mais nada (scan.ts, uvaVerdict).
export function pumpCloseUserVolumeAccumulator(user: string, program: string): Instruction {
  if (program !== PROGRAMS.pump && program !== PROGRAMS.pumpAmm) throw new Error('conta de volume só existe nos programas da Pump.fun e do PumpSwap');
  return {
    programId: program,
    keys: [w(user, true), w(userVolumeAccumulator(user, program)), r(eventAuthority(program)), r(program)],
    data: Buffer.from(DISC.closeUserVolumeAccumulator, 'hex'),
  };
}

// ---------- Meteora DBC (docs/meteora-dbc.md; IDL 0.2.2 do SDK e código do programa 0.2.3, conferidos em 09/11/2026) ----------

// pool_authority: endereço fixo no IDL (= PDA ["pool_authority"] do programa, conferido)
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DBC_CLAIM_CREATOR_TRADING_FEE_DISC = Buffer.from([82, 220, 250, 189, 3, 85, 107, 45]);

export type DbcClaimAccounts = {
  pool: string;
  creator: string; // assina; o programa confere = pool.creator (access_control is_pool_creator)
  tokenA: string; // conta de token que receberia a fee em base (com maxBase = 0, nada chega nela)
  tokenB: string; // conta de token que recebe a fee em quote (WSOL: ATA WSOL da temporária)
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
};

// claim_creator_trading_fee (v1: só VirtualPool; pool com transfer hook exige a v2, que o app não usa). Args
// max_base_amount u64, max_quote_amount u64. Contas na ordem do IDL: pool_authority, pool (W), token_a (W), token_b (W),
// base_vault (W), quote_vault (W), base_mint, quote_mint, creator (S), token_base_program, token_quote_program,
// event_authority, program (#[event_cpi]).
export function dbcClaimCreatorTradingFee(a: DbcClaimAccounts, maxBaseAmount: bigint, maxQuoteAmount: bigint): Instruction {
  return {
    programId: PROGRAMS.meteoraDbc,
    keys: [
      r(DBC_POOL_AUTHORITY),
      w(a.pool),
      w(a.tokenA),
      w(a.tokenB),
      w(a.baseVault),
      w(a.quoteVault),
      r(a.baseMint),
      r(a.quoteMint),
      r(a.creator, true),
      r(a.baseTokenProgram),
      r(a.quoteTokenProgram),
      r(eventAuthority(PROGRAMS.meteoraDbc)),
      r(PROGRAMS.meteoraDbc),
    ],
    data: Buffer.concat([DBC_CLAIM_CREATOR_TRADING_FEE_DISC, u64(maxBaseAmount), u64(maxQuoteAmount)]),
  };
}

// ---------- Raydium LaunchLab (docs/launchlab.md; IDL 0.2.0, crate CPI 115df27 e SDK V2 1cf5bb1, conferidos em 09/11/2026) ----------

export const LAUNCHLAB_CLAIM_CREATOR_FEE_DISC = Buffer.from([26, 97, 138, 203, 132, 171, 141, 252]);

// claim_creator_fee, sem argumentos: leva TODO o saldo do cofre [creator, quote_mint] para a ATA do criador nessa moeda.
// Contas na ordem do IDL: creator (WS; é o payer do init_if_needed da ATA), fee_vault_authority (PDA
// ["creator_fee_vault_auth_seed"]), creator_fee_vault (W, PDA [creator, quote_mint]), recipient_token_account (W, ATA do
// creator: o programa confere o endereço), quote_mint, token_program (Token: fixo no IDL), system_program,
// associated_token_program. Só WSOL: quem chama passa a cotação WSOL.
export function launchlabClaimCreatorFee(creator: string, vaultAuthority: string, vault: string, quoteMint: string = WSOL_MINT): Instruction {
  return {
    programId: PROGRAMS.raydiumLaunchlab,
    keys: [
      w(creator, true),
      r(vaultAuthority),
      w(vault),
      w(associatedTokenAddress(creator, quoteMint, PROGRAMS.token)),
      r(quoteMint),
      r(PROGRAMS.token),
      r(PROGRAMS.system),
      r(PROGRAMS.associatedToken),
    ],
    data: Buffer.from(LAUNCHLAB_CLAIM_CREATOR_FEE_DISC),
  };
}

// Sequência completa do PumpSwap: cria a ATA WSOL do criador, varre os pools (se houver), coleta, fecha a ATA
// (desembrulha em SOL).
export function pumpAmmClaimToSol(feePayer: string, creator: string, sweeps: Instruction[] = []): Instruction[] {
  const ata = associatedTokenAddress(creator, WSOL_MINT, PROGRAMS.token);
  return [
    ataCreateIdempotent(feePayer, creator, WSOL_MINT, PROGRAMS.token),
    ...sweeps,
    pumpAmmCollectCoinCreatorFee(creator),
    tokenCloseAccount(PROGRAMS.token, ata, creator, creator),
  ];
}
