// Mede na mainnet (só leitura, sem frase) quanto de creator fee do Raydium LaunchLab está parado em SOL e de quem é:
// 1) todos os cofres de creator fee em WSOL numa consulta: getTokenAccountsByOwner da authority dos cofres (PDA
//    ["creator_fee_vault_auth_seed"]), mint WSOL, só o saldo (dataSlice 64..72);
// 2) para os 10 maiores e N espalhados entre 0,01 e 1 SOL, o criador (pela transação mais recente do cofre: o pool dela tem
//    o criador, e o PDA [criador, WSOL] tem que dar o cofre) e se é carteira comum (na curva, do System ou sem conta).
//
//   node scripts/medir-launchlab.ts [espalhados=30]
//
// RPC: variável SOLANA_RPC_URL (padrão: RPC público). A URL não é impressa. Nada é assinado nem enviado.

import { decodeBase58, encodeBase58 } from '../src/core/solana/base58.ts';
import { LAUNCHLAB_FEE_VAULT_AUTH, launchlabCreatorFeeVault } from '../src/core/limpeza/launchlab.ts';
import { isOnCurve, PROGRAMS, WSOL_MINT } from '../src/core/solana/pda.ts';
import { createRpc, PUBLIC_RPC_LIMITS } from '../src/core/solana/rpc.ts';

const PUBLIC = 'https://api.mainnet-beta.solana.com';
const url = process.env.SOLANA_RPC_URL || PUBLIC;
const rpc = createRpc({ url, timeoutMs: 180_000, ...(url === PUBLIC ? PUBLIC_RPC_LIMITS : { requestsPerSecond: 8 }) });
const SPREAD = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 30);
const LL = PROGRAMS.raydiumLaunchlab;
const f = (l: bigint) => (Number(l) / 1e9).toFixed(6);

const t0 = Date.now();
const r = await rpc.call<{ value: Array<{ pubkey: string; account: { data: [string, string] } }> }>('getTokenAccountsByOwner', [
  LAUNCHLAB_FEE_VAULT_AUTH,
  { mint: WSOL_MINT },
  { encoding: 'base64', dataSlice: { offset: 64, length: 8 }, commitment: 'confirmed' },
]);
const vaults = r.value.map((x) => ({ v: x.pubkey, amt: Buffer.from(x.account.data[0], 'base64').readBigUInt64LE(0) })).sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
const pos = vaults.filter((x) => x.amt > 0n);
console.log(`${new Date().toISOString()}: ${vaults.length} cofres de creator fee em WSOL; com saldo: ${pos.length}; total parado: ${f(pos.reduce((s, x) => s + x.amt, 0n))} SOL`);
for (const [lo, hi, n] of [[0n, 1_000_000n, '≤ 0,001'], [1_000_000n, 10_000_000n, '0,001–0,01'], [10_000_000n, 100_000_000n, '0,01–0,1'], [100_000_000n, 1_000_000_000n, '0,1–1'], [1_000_000_000n, 10n ** 18n, '> 1']] as const) {
  const b = pos.filter((x) => x.amt > lo && x.amt <= hi);
  console.log(`  ${n} SOL: ${b.length} cofres, ${f(b.reduce((s, x) => s + x.amt, 0n))} SOL`);
}
console.log(`mediana dos com saldo: ${pos.length ? f(pos[Math.floor(pos.length / 2)].amt) : '-'}`);

type Tx = { transaction?: { message?: { accountKeys?: string[] } }; meta?: { loadedAddresses?: { writable?: string[]; readonly?: string[] } } } | null;
async function creatorOf(vault: string): Promise<string | null> {
  const sigs = await rpc.call<Array<{ signature: string }>>('getSignaturesForAddress', [vault, { limit: 3 }]);
  for (const s of sigs) {
    const tx = await rpc.call<Tx>('getTransaction', [s.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]).catch(() => null);
    const keys = [...(tx?.transaction?.message?.accountKeys ?? []), ...(tx?.meta?.loadedAddresses?.writable ?? []), ...(tx?.meta?.loadedAddresses?.readonly ?? [])];
    const cands = new Set(keys);
    const accs = await rpc.call<{ value: Array<{ owner: string; data: [string, string] } | null> }>('getMultipleAccounts', [keys.slice(0, 100), { encoding: 'base64' }]);
    for (const a of accs.value) {
      const d = a && a.owner === LL ? Buffer.from(a.data[0], 'base64') : null;
      if (d && d.length === 429) cands.add(encodeBase58(d.subarray(333, 365))); // PoolState.creator
    }
    const c = [...cands].find((k) => launchlabCreatorFeeVault(k) === vault);
    if (c) return c;
  }
  return null;
}
const mid = pos.filter((x) => x.amt > 10_000_000n && x.amt <= 1_000_000_000n);
const pick = [...pos.slice(0, 10), ...Array.from({ length: SPREAD }, (_, i) => mid[Math.floor((i * mid.length) / SPREAD)]).filter(Boolean)];
const byKind = new Map<string, { n: number; amt: bigint }>();
for (const x of pick) {
  const c = await creatorOf(x.v);
  let kind = 'criador não achado';
  if (c) {
    const a = await rpc.call<{ value: { owner: string } | null }>('getAccountInfo', [c, { encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    kind = !isOnCurve(decodeBase58(c)) ? 'PDA (fora da curva)' : !a.value ? 'carteira comum sem saldo' : a.value.owner === PROGRAMS.system ? 'carteira comum' : `conta de outro programa`;
  }
  const k = byKind.get(kind) ?? { n: 0, amt: 0n };
  byKind.set(kind, { n: k.n + 1, amt: k.amt + x.amt });
  console.log(`  ${f(x.amt)} SOL  cofre ${x.v}  ${kind}`);
}
console.log(`dos ${pick.length} conferidos: ${[...byKind].map(([k, v]) => `${k}: ${v.n} (${f(v.amt)} SOL)`).join('; ')}`);
console.log(`tempo ${((Date.now() - t0) / 1000).toFixed(0)} s. Nada foi enviado.`);
