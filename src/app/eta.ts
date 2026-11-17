// Custos fixos de uma rodada (requisições, segundos, créditos do Helius), usados para a estimativa de tempo.
// Cada número diz de onde veio. Quem muda um deles refaz a medição e atualiza a data.

// Simulação e envio: o executor não usa getProgramAccounts, então cada requisição vale 1 crédito do Helius
// (docs/aprendizados.md, 30/10/2026): estes números são requisições E créditos.
// Fonte: executor real numa rede falsa, ~14 na simulação e ~20 no envio (confirmando na 2ª consulta).
// Estimativa, falta mainnet.
const SIM_REQ_PER_WALLET = 14;
const EXEC_REQ_PER_WALLET = 20;
// 14,85 medidos (abaixo) menos os 10 do getProgramAccounts, que no Helius vai pelo RPC público desde 31/10/2026
// (o Helius recusa essa busca; src/core/solana/gpa-fallback.ts): 4,85, arredondado para cima. + 1 getMultipleAccounts do
// cofre do Raydium LaunchLab (src/core/limpeza/launchlab.ts, 09/11/2026; 1 crédito, contado no código): 5,9.
const ANALYSIS_CREDITS_PER_WALLET = 5.9;

export const RUN_COSTS = {
  // Leitura de cada carteira: 2 getTokenAccountsByOwner (Token e Token-2022) + 1 getMultipleAccounts a cada 33 carteiras
  // + 1 getProgramAccounts (fee parada nas moedas, cleanupScanOptions).
  // É um PISO: o falso devolve zero contas de token e nenhuma moeda; moeda migrada ou com fee parada consulta mais.
  // Medido em 30/10/2026 (com a fee parada): `node scripts/medir-limites-rpc.ts 10 20` -> leituraReqPorCarteira 3,05
  // (`1 100` dá 3,04), sem 429, pico de 4 getProgramAccounts/s (limite 5).
  // + 1 getProgramAccounts da Meteora DBC (pools em que a carteira é creator, src/core/limpeza/dbc.ts, 09/11/2026):
  // contado no código, não medido. Pool com fee custa +1 getMultipleAccounts (e +1 da config), raro.
  // + 1 getMultipleAccounts do cofre do Raydium LaunchLab (PDA [carteira, WSOL] e 3 outras moedas, src/core/limpeza/launchlab.ts,
  // 09/11/2026): contado no código (test/limpeza/launchlab.test.ts), não medido. Sem getProgramAccounts.
  analysisReqPerWallet: 5.05,
  // Conta de volume da Pump.fun/PumpSwap (scan.ts uvaStates, 06/11/2026): a conta vem junto da leitura do cashback
  // (nada a mais); só a que EXISTE e passa nas outras condições custa +2 getTokenAccountsByOwner (Token e Token-2022,
  // as contas de token dela). A janela do incentivo é 1 getMultipleAccounts por rodada, e só se alguma existir.
  // Fica fora do piso acima (o falso não tem conta de volume). Contado no código, test/limpeza/uva.test.ts.
  uvaReqPerAccount: 2,
  uvaReqPerRound: 1,
  // Simulação de cada conta de volume que fecha (executor, passo close-uva): releitura (1 getMultipleAccounts + 2
  // getTokenAccountsByOwner), saldo da temporária, medida (1 simulateTransaction) e o passo (saldos + 1 simulação),
  // mais a janela do incentivo uma vez por execução. Contado no código, não medido; o envio soma o de um passo.
  uvaSimReqPerAccount: 7,
  // Descoberta: 1 getSignaturesForAddress por endereço, até a folga de 20 (SEARCH_GAP) depois do último usado.
  // Medido em 30/10/2026: `node scripts/medir-limites-rpc.ts 1 100` -> 120 por frase (100 usadas + 20 de folga,
  // lotes de 10). Com 20 carteiras por frase dá 40 (`1 20`, `3 20`, `10 20`).
  // + 30 da busca nas contas comuns, que a página sempre faz para descobrir se a frase é Solflare ou Phantom
  // (31/10/2026): com só a Conta 1 usada, para em 30 (lotes de 10 até passar a folga de 20). Contado no laço, não medido.
  // + 30 da busca nas contas m/44'/501'/i' (Trust e Phantom antiga, 06/11/2026), do mesmo jeito. Contado, não medido.
  discoveryReqPerFrase: 180,
  // Simulação: requisições e créditos (1 por requisição), ver a nota acima. Estimativa, falta mainnet.
  simReqPerWallet: SIM_REQ_PER_WALLET,
  // Envio: requisições e créditos (1 por requisição), ver a nota acima. Estimativa, falta mainnet.
  execReqPerWallet: EXEC_REQ_PER_WALLET,
  // Segundos do envio por carteira: 20 requisições a 8 req/s = 2,5 s (o limite de 1 sendTransaction/s não pesa).
  // Conta de 30/10/2026, estimativa, falta mainnet.
  execSecPerWallet: 2.5,
  // Créditos do Helius só da análise: 14,85 por carteira, descoberta + leitura com a fee parada, RPC público, 20
  // carteiras públicas da Pump.fun (314 moedas, 2 com moeda migrada, 4 moedas com fee parada), com novas tentativas
  // (`node scripts/medir-custo-rpc.ts 20`, 30/10/2026). Arredondado para cima. Antes da fee parada: 3,79.
  // O getProgramAccounts vale 10 créditos: é 10 dos ~15.
  analysisCreditsPerWallet: ANALYSIS_CREDITS_PER_WALLET,
  // Créditos do fluxo completo, DERIVADO: análise + simulação + envio = 4,9 + 14 + 20 = 38,9 por carteira (era 48,9 com o
  // getProgramAccounts no Helius): o plano grátis de 1 milhão cobre ~25 mil carteiras por mês.
  // (O "~29" antigo de docs/aprendizados.md não fechava com as partes.)
  fullCreditsPerWallet: ANALYSIS_CREDITS_PER_WALLET + SIM_REQ_PER_WALLET + EXEC_REQ_PER_WALLET,
  // Quantas carteiras por frase se supõe antes de descobrir (cada frase tem cerca de 100). Dado do dono, CLAUDE.md.
  assumedWalletsPerFrase: 100,
  // Requisições por segundo para a estimativa.
  // RPC próprio: Helius grátis dá 10/s (https://www.helius.dev/docs/billing/rate-limits, conferido em 30/10/2026); usamos 8.
  rpsCustom: 8,
  // RPC público da Solana (PUBLIC_RPC_LIMITS em src/core/solana/rpc.ts): 8/s no total, mas getTokenAccountsByOwner,
  // getProgramAccounts, getSignaturesForAddress e getSignatureStatuses têm corte escondido de 10 por 10 s (sondado na
  // mainnet em 30/10/2026) e ficam em 0,9/s. São taxas EFETIVAS, não o limite do cliente:
  // - análise: 2 leituras de token + 1 gPA por carteira e 1 histórico por endereço na descoberta, todos a 0,9/s →
  //   ~1 requisição/s efetiva (medido em 30/10/2026, `node scripts/medir-custo-rpc.ts 20`: 2,95 a 3,4 s por carteira
  //   para 3,05 requisições);
  // - simulação e envio: presos pelo getSignatureStatuses (2 a 4 por transação a 0,9/s) → ~5 s por carteira no envio
  //   (limpeza real de 30/10/2026: 83 transações em ~7 min), ou seja rpsCustom/rpsPublic = 2 sobre os 2,5 s do próprio.
  rpsPublic: 4,
  rpsPublicAnalysis: 1,
  // Com RPC próprio, o getProgramAccounts da fee parada (1 por carteira) vai pelo público a 0,9/s (PUBLIC_RPC_LIMITS):
  // a análise não fica mais rápida que 1 carteira a cada 1,1 s, por mais rápido que seja o resto no Helius.
  gpaRpsPublic: 0.9,
  // getProgramAccounts por carteira que vão pelo público: curvas da Pump.fun, fee dividida (31/10/2026) e Meteora DBC
  // (09/11/2026). Contado no código (test/limpeza/scan.test.ts), não medido.
  gpaPerWallet: 3,
} as const;

export type RunStage = 'analysis' | 'simulate' | 'execute';

// Estimativa antes de começar: segundos e créditos do Helius de uma etapa para N frases.
export function estimateRun(i: { frases: number; wallets?: number; customRpc: boolean; stage: RunStage }): {
  seconds: number;
  credits: number;
  wallets: number;
} {
  const wallets = i.wallets ?? i.frases * RUN_COSTS.assumedWalletsPerFrase; // assumedWalletsPerFrase
  const rps = i.customRpc ? RUN_COSTS.rpsCustom : RUN_COSTS.rpsPublic; // rpsCustom / rpsPublic
  if (i.stage === 'analysis') {
    const rpsAnalysis = i.customRpc ? RUN_COSTS.rpsCustom : RUN_COSTS.rpsPublicAnalysis; // no público, a leitura de tokens manda
    return {
      // (carteiras * analysisReqPerWallet + frases * discoveryReqPerFrase) / rps.
      // Com `wallets` explícito a busca já foi feita: não soma a descoberta.
      // Com RPC próprio, o piso são as buscas por programa pelo público: carteiras * gpaPerWallet / gpaRpsPublic.
      seconds: Math.max(
        (wallets * RUN_COSTS.analysisReqPerWallet + (i.wallets === undefined ? i.frases * RUN_COSTS.discoveryReqPerFrase : 0)) / rpsAnalysis,
        i.customRpc ? (wallets * RUN_COSTS.gpaPerWallet) / RUN_COSTS.gpaRpsPublic : 0,
      ),
      // carteiras * analysisCreditsPerWallet
      credits: wallets * RUN_COSTS.analysisCreditsPerWallet,
      wallets,
    };
  }
  if (i.stage === 'simulate') {
    return {
      // carteiras * simReqPerWallet / rps
      seconds: (wallets * RUN_COSTS.simReqPerWallet) / rps,
      // carteiras * simReqPerWallet (1 crédito por requisição)
      credits: wallets * RUN_COSTS.simReqPerWallet,
      wallets,
    };
  }
  return {
    // carteiras * execSecPerWallet, medido a rpsCustom; no RPC público escala por rpsCustom / rpsPublic.
    // Supõe envio limitado pelo rate limit (não pela rede); falta re-medir na mainnet.
    seconds: wallets * RUN_COSTS.execSecPerWallet * (RUN_COSTS.rpsCustom / rps),
    // carteiras * execReqPerWallet (1 crédito por requisição)
    credits: wallets * RUN_COSTS.execReqPerWallet,
    wallets,
  };
}

const ETA_MIN_MS = 3000;
const ETA_MIN_ITEMS = 3;
// A velocidade medida é a média dos últimos ETA_WINDOW itens (não uma média móvel exponencial, que pulava a
// cada carteira lenta: uma carteira de 5 s no meio de carteiras de 0,5 s subia o restante 2,7×; na janela
// ela pesa 1/20). Rede que fica 2× mais lenta de vez: o número acompanha em 20 itens.
export const ETA_WINDOW = 20;
// Amostra limitada a ETA_CLIP × a velocidade da janela antes de entrar: uma espera isolada (nova tentativa,
// confirmação demorada) vira "+8%", não um salto. Rede que ficou 10× mais lenta ainda é alcançada, em passos de 3×.
export const ETA_CLIP = 3;
// A prévia some depois de ETA_PRIOR_FADE do total ou de ETA_WINDOW itens, o que vier antes (nunca antes de ETA_MIN_ITEMS).
export const ETA_PRIOR_FADE = 0.2;

// Tempo restante durante a execução, em duas camadas:
// 1. Prévia: `start(total, priorMs)` recebe a estimativa de antes de começar (estimateRun). Vira uma velocidade
//    (priorMs / total) e há número desde o segundo 0. Sem prévia, só depois de 3 s e 3 itens, como antes.
// 2. Medição: média dos ms por item na janela dos últimos ETA_WINDOW itens, cada amostra limitada a ETA_CLIP ×
//    a média atual. Tick que pula itens é uma amostra só, com o peso dos itens que pulou. Entra com peso
//    done / fade (fade = max(3, min(20, 20% do total))): nada no começo, tudo depois de poucos itens.
// Total que muda (busca achou 37 em vez de 100, lote dividido) muda o número na hora: é informação, não ruído.
// A tela desconta sozinha o tempo entre um aviso e outro (etaView).
export function createEta(now: () => number = Date.now): {
  start(total: number, priorMs?: number | null): void;
  tick(done: number): void;
  setTotal(total: number): void;
  remainingMs(): number | null;
} {
  let started = false;
  let total = 0;
  let startedAt = 0;
  let lastAt = 0;
  let lastDone = 0;
  let done = 0;
  let window: Array<{ items: number; ms: number }> = [];
  let priorMsPerItem: number | null = null;
  const valid = (n: number): boolean => Number.isFinite(n) && n >= 0;
  const windowItems = () => window.reduce((k, s) => k + s.items, 0);
  const measuredRate = (): number | null => {
    const items = windowItems();
    return items > 0 ? window.reduce((k, s) => k + s.ms, 0) / items : null;
  };
  return {
    start(t, priorMs = null) {
      if (!valid(t)) return;
      started = true;
      total = t;
      startedAt = lastAt = now();
      lastDone = done = 0;
      window = [];
      priorMsPerItem = priorMs !== null && valid(priorMs) && t > 0 ? priorMs / t : null;
    },
    tick(d) {
      if (!started || !valid(d)) return; // antes do start ou valor inválido: ignora
      const at = now();
      done = d;
      if (d > lastDone && at >= lastAt) {
        const items = d - lastDone;
        const current = measuredRate();
        const ms = current === null ? at - lastAt : Math.min(at - lastAt, ETA_CLIP * current * items);
        window.push({ items, ms });
        // guarda só o que fecha os últimos ETA_WINDOW itens
        let kept = 0;
        for (let i = window.length - 1; i >= 0; i--) {
          kept += window[i]!.items;
          if (kept >= ETA_WINDOW) {
            window = window.slice(i);
            break;
          }
        }
        lastAt = at;
        lastDone = d;
      }
    },
    setTotal(t) {
      if (!started || !valid(t)) return;
      total = t;
    },
    remainingMs() {
      if (!started) return null;
      // Antes de 3 s E de 3 itens a medição é fraca demais: só a prévia (ou nada).
      const rate = measuredRate();
      const measured = rate !== null && now() - startedAt >= ETA_MIN_MS && done >= ETA_MIN_ITEMS ? rate : null;
      let msPerItem: number | null;
      if (measured === null) msPerItem = priorMsPerItem;
      else if (priorMsPerItem === null) msPerItem = measured;
      else {
        const fade = Math.max(ETA_MIN_ITEMS, Math.min(ETA_WINDOW, ETA_PRIOR_FADE * total));
        const w = Math.min(1, done / fade);
        msPerItem = w * measured + (1 - w) * priorMsPerItem;
      }
      if (msPerItem === null) return null;
      const r = Math.max(0, total - done) * msPerItem;
      return Number.isFinite(r) ? r : null;
    },
  };
}
