// Interruptores da versão 1.0 (congelamento decidido pelo autor em 16/11/2026).
//
// A 1.0 leva só o que já rodou de verdade na mainnet com os testers (0.2.4: 814 limpezas com taxa de 09 a 13/11/2026,
// 0 erros, conferido na blockchain) mais a creator fee da Meteora DBC e do Raydium LaunchLab, por decisão dele.
// O que ficou pronto na 0.3.0 mas nunca rodou de verdade fica desligado aqui e volta numa versão seguinte, depois de
// um envio real conferido (docs/aprendizados.md). Desligado = o app nem lê: nada disso aparece na análise nem no plano.
//
// O código continua no repositório e com os testes dele (cada suíte liga o próprio interruptor). Mudar um destes
// valores para true é decisão do autor, nunca de um teste ou de uma sessão.
export const FEATURES = {
  // fechar a conta de volume (cashback/incentivo) da Pump.fun e do PumpSwap: só simulado na mainnet (08/11/2026).
  // Desligado, o cashback continua sendo coletado como na 0.2.4 (claim_cashback), só a conta fica aberta.
  closeVolumeAccounts: false,
  // caminho m/44'/501'/i' (Trust e Phantom antiga) na descoberta automática: só leitura na mainnet (08/11/2026)
  trustPath: false,
  // cartão de chaves privadas coladas no lugar da frase: só devnet (08/11/2026)
  pastedKeys: false,
  // Monad e HyperEVM entre as outras redes (só leitura): entraram em 06/11/2026, depois da 0.2.4
  extraEvmNetworks: false,
};

export type Feature = keyof typeof FEATURES;
