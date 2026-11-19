// Verificador grátis do site (19/11/2026): GET /verificar?endereco=<carteira> no proxy.
//
// A pessoa cola o endereço PÚBLICO de uma carteira em clurn.app e vê o que dá para recuperar nela, sem frase e sem
// baixar nada. Lê com as mesmas funções da varredura do app (src/core/limpeza/scan.ts), então os números batem:
//   - SOL solto (só volta se a carteira for uma temporária: o app nunca mexe na principal);
//   - contas de token vazias que dá para fechar e o aluguel delas;
//   - moedas e NFTs com saldo (contados, sem preço: valor desconhecido, nunca zero);
//   - creator fees nos cofres da Pump.fun e do PumpSwap.
// É o mínimo: o app olha mais lugares (fee parada nas curvas, fee dividida, cashback, outros launchpads).
//
// Os dois cofres (PDAs) vêm calculados pelo navegador (site/verificar.js): a conta de curva elíptica levava até 10 ms
// de CPU, o limite do plano grátis do Workers (medido em 19/11/2026: mediana 3,4 ms, p95 7,4 ms, máximo 10,2 ms em 200
// carteiras). Endereço errado ali só faz a própria pessoa ler a conta errada: a consulta continua fixa e pública.
// test/proxy/verificar.test.ts confere a conta do site contra a do app.
//
// Sempre as mesmas 5 consultas (getMinimumBalanceForRentExemption, getMultipleAccounts e getTokenAccountsByOwner
// nos dois programas de token): quem chama não escolhe método nem parâmetro. Limite próprio por IP e por dia
// (cotas.ts, consumeCheck). O endereço não é gravado nem contado: só o número de verificações do dia.
import { isAddress } from '../src/core/solana/base58.ts';
import { readBasics, tokenAccounts } from '../src/core/limpeza/scan.ts';
import type { RpcClient } from '../src/core/solana/rpc.ts';

export const CHECK_CREDITS = 5; // uma unidade por consulta ao upstream
export const CHECK_ORIGINS: ReadonlySet<string> = new Set(['https://clurn.app', 'https://www.clurn.app']);

// Cada parte é lida sozinha: a que falhar vem null ("não deu para ler"), nunca 0, e não derruba as outras.
export type CheckResult = {
  endereco: string;
  sol: number | null; // lamports na carteira
  contasVazias: number | null; // contas de token vazias que o dono pode fechar
  aluguel: number | null; // lamports que voltam fechando essas contas
  travadas: number | null; // vazias que não fecham com a chave do dono (congelada, outra autoridade, taxa retida)
  moedas: number | null; // contas com saldo (moedas e NFTs), sem preço
  feePump: number | null; // creator fee no cofre da curva da Pump.fun, acima do aluguel
  feePumpSwap: number | null; // creator fee no cofre do PumpSwap (WSOL)
  recuperavel: number | null; // aluguel + creator fees lidos (o que volta mesmo se esta for a principal)
  incompleto: boolean; // alguma parte não foi lida
};

export function validAddress(text: string | null): string | null {
  const a = (text ?? '').trim();
  return a.length >= 32 && a.length <= 44 && isAddress(a) ? a : null;
}

export async function checkWallet(rpc: RpcClient, address: string, cofre: string, ata: string): Promise<CheckResult> {
  const [basicsPart, tokensPart] = await Promise.all([
    (async () => {
      const rentZero = await rpc.call<unknown>('getMinimumBalanceForRentExemption', [0]);
      if (typeof rentZero !== 'number' || !Number.isSafeInteger(rentZero) || rentZero <= 0) throw new Error('aluguel fora do formato');
      const b = (await readBasics(rpc, [address], rentZero, () => [cofre, ata])).get(address);
      if (!b) throw new Error('sem leitura');
      return b;
    })().catch(() => null),
    tokenAccounts(rpc, address).catch(() => null),
  ]);

  let sol: number | null = null;
  let feePump: number | null = null;
  let feePumpSwap: number | null = null;
  if (basicsPart) {
    if (!basicsPart.balanceError) sol = basicsPart.lamports;
    if (!basicsPart.vaultsError) {
      feePump = basicsPart.vaultLamports;
      const amm = Number(basicsPart.ataAmount);
      feePumpSwap = Number.isSafeInteger(amm) ? amm : null;
    }
  }

  let contasVazias: number | null = null;
  let aluguel: number | null = null;
  let travadas: number | null = null;
  let moedas: number | null = null;
  if (tokensPart) {
    const empty = tokensPart.filter((t) => t.kind === 'empty');
    const closable = empty.filter((t) => t.blockers.length === 0);
    contasVazias = closable.length;
    aluguel = closable.reduce((s, t) => s + t.rentLamports, 0);
    travadas = empty.length - closable.length;
    moedas = tokensPart.filter((t) => t.kind === 'fungible' || t.kind === 'nft').length;
  }

  const parts = [aluguel, feePump, feePumpSwap];
  // soma do que foi lido; com parte faltando, a tela mostra "pelo menos" (incompleto). Nada lido: null.
  const known = parts.filter((p): p is number => p !== null);
  const recuperavel = known.length ? known.reduce((s, p) => s + p, 0) : null;
  const incompleto = [sol, aluguel, feePump, feePumpSwap].some((p) => p === null);
  return { endereco: address, sol, contasVazias, aluguel, travadas, moedas, feePump, feePumpSwap, recuperavel, incompleto };
}
