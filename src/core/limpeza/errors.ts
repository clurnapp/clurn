// Catálogo de erros: todo erro que o usuário pode ver vira um código estável + 4 respostas em português
// (o que houve / perdi algo? / o que o app faz / o que você faz). Um lugar só: executor, servidor, terminal e página usam este.
// O texto técnico (`technical`) existe para "detalhes técnicos" e para o suporte: nunca vai para o corpo da mensagem.

export const ERROR_CODES = ['no-fee-sol', 'sim-insufficient', 'rpc-busy', 'network-down', 'rpc-blocked', 'send-unknown',
  'token-frozen', 'token-2022-blocked', 'close-authority', 'rent-range', 'pump-claim-failed', 'dbc-claim-failed', 'launchlab-claim-failed', 'unexpected-effect',
  'dest-invalid', 'dest-missing', 'dest-not-ordinary', 'dest-low-balance', 'dest-lookalike', 'seed-words', 'seed-unknown-word', 'seed-checksum', 'seed-duplicate', 'too-many-frases',
  'key-unknown', 'key-mismatch', 'key-looks-address', 'key-duplicate', 'key-is-main', 'keys-off', 'too-many-keys', 'review-changed', 'rpc-quota', 'stopped-by-user',
  'app-fee-wallet', 'token-balance-changed', 'token-rejected', 'rpc-out-of-sync', 'payer-no-sol', 'task-busy', 'unknown'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export type ErrorParams = Record<string, string | number>;
export type Explained = { code: ErrorCode; params: ErrorParams; technical: string; beforeSend: boolean };
export type ErrorContext = { beforeSend?: boolean; stepKind?: 'claim-curve' | 'claim-amm' | 'claim-dbc' | 'claim-launchlab' | 'tokens' | 'sweep-sol' | 'fund' | 'gather' };

const TECHNICAL_MAX = 500;

// Erro que já nasce com código (o executor, a validação do destino etc. lançam este).
export class CodedError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;
  constructor(message: string, code: ErrorCode, params: ErrorParams = {}) {
    super(message);
    this.name = 'CodedError';
    this.code = code;
    this.params = params;
  }
}

function rawText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

export function explainError(raw: unknown, ctx: ErrorContext = {}): Explained {
  const technical = rawText(raw).slice(0, TECHNICAL_MAX);
  const beforeSend = ctx.beforeSend ?? true;
  const make = (code: ErrorCode, params: ErrorParams = {}): Explained => ({ code, params, technical, beforeSend });

  if (raw instanceof CodedError) return make(raw.code, raw.params);

  // FeePayerError é detectado pela forma: este arquivo não importa plan.ts.
  if (isObject(raw) && typeof raw.sendLamports === 'bigint' && typeof raw.walletIndex === 'number' && typeof raw.wallet === 'string') {
    return make('no-fee-sol', { walletIndex: raw.walletIndex, wallet: raw.wallet, sendSol: Number(raw.sendLamports) / 1e9 });
  }

  if (isObject(raw) && raw.name === 'RpcError') {
    return make(raw.code === -32601 || raw.code === 403 || raw.code === 401 ? 'rpc-blocked' : 'network-down');
  }

  // Erro da transação inteira (antes de qualquer instrução): nó do RPC atrasado ou pagadora sem SOL.
  if (/BlockhashNotFound|Blockhash not found/i.test(technical)) return make('rpc-out-of-sync');
  if (/InsufficientFundsForFee|AccountNotFound|found no record of a prior credit/i.test(technical)) return make('payer-no-sol');

  // A ordem importa: "insufficient funds for rent" é outro problema que "insufficient lamports".
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(technical)) return make('rent-range');
  if (/insufficient lamports/i.test(technical)) return make('sim-insufficient');
  if (/frozen/i.test(technical)) return make('token-frozen');
  if (/NonTransferable|non-transferable|TransferFee|withheld|confidential/i.test(technical)) return make('token-2022-blocked');

  const tokenCode = tokenProgramError(technical);
  if (tokenCode !== null) return make(TOKEN_ERROR_CODES[tokenCode] ?? 'token-rejected');

  if (ctx.stepKind === 'claim-curve' || ctx.stepKind === 'claim-amm') return make('pump-claim-failed');
  if (ctx.stepKind === 'claim-dbc') return make('dbc-claim-failed');
  if (ctx.stepKind === 'claim-launchlab') return make('launchlab-claim-failed');
  // passo de contas de token: a transação é atômica, então "nada saiu desta conta" é certo mesmo sem saber o motivo
  if (ctx.stepKind === 'tokens') return make('token-rejected');
  return make('unknown');
}

// Erros do programa de tokens (SPL Token; o Token-2022 usa os mesmos números de 0 a 19). Só os que têm explicação
// própria; o resto do programa de tokens vira 'token-rejected'. 1 = InsufficientFunds (saldo menor que o da
// varredura), 11 = NonNativeHasBalance (chegou token depois da varredura: a conta não fecha com saldo), 17 = AccountFrozen.
const TOKEN_ERROR_CODES: Record<number, ErrorCode> = { 1: 'token-balance-changed', 11: 'token-balance-changed', 17: 'token-frozen' };
const TOKEN_PROGRAM_IDS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

// Número do erro quando quem falhou foi o programa de tokens, pelo log da rede:
// "Program Tokenkeg... failed: custom program error: 0xb". Sem o log do programa de tokens: null (não adivinha).
export function tokenProgramError(technical: string): number | null {
  const m = /Program (\w+) failed: custom program error: 0x([0-9a-f]+)/i.exec(technical);
  if (!m || !TOKEN_PROGRAM_IDS.includes(m[1])) return null;
  const n = Number.parseInt(m[2], 16);
  return Number.isSafeInteger(n) ? n : null;
}

// Motivos de bloqueio escritos por scan.ts (texto em português) → código.
export function blockerCode(reason: string): ErrorCode {
  if (reason.includes('congelada')) return 'token-frozen';
  if (reason.includes('autoridade de fechamento')) return 'close-authority';
  if (reason.includes('Token-2022') || reason.includes('não transferível')) return 'token-2022-blocked';
  return 'unknown';
}

type Text = { what: (p: ErrorParams) => string; app: (p: ErrorParams) => string; you: (p: ErrorParams) => string };

export const ERROR_TEXT_PT: Record<ErrorCode, Text> = {
  'no-fee-sol': {
    what: () => 'Nenhuma burner tem SOL para pagar a taxa de rede.',
    app: () => 'O app parou antes de enviar qualquer coisa.',
    // cartão de chaves privadas manda appName "qualquer uma": qualquer carteira da pessoa paga o depósito
    you: (p) => `Mande ${p.sendSol} SOL ${p.appName === 'qualquer uma' ? 'de qualquer carteira sua' : `do seu ${p.appName ?? 'Solflare'}`} para a ${p.walletName ?? `temporária nº ${p.walletIndex}`}: ${p.wallet}. Esse valor volta para o destino no final da limpeza.`,
  },
  'sim-insufficient': {
    what: () => 'A simulação mostrou que a burner não tem SOL suficiente para este passo.',
    app: () => 'O app não enviou esse passo e segue com os outros que dá para fazer.',
    you: () => 'Rode a varredura de novo: o app recalcula o plano com o saldo de agora.',
  },
  'rpc-busy': {
    what: () => 'O servidor da rede está ocupado e pediu para esperar.',
    app: () => 'O app espera um pouco e tenta de novo sozinho.',
    you: () => '',
  },
  'network-down': {
    what: () => 'Não deu para falar com a rede Solana agora.',
    app: () => 'O app parou este passo e não insiste.',
    you: () => 'Confira sua internet e rode de novo. O app continua de onde parou.',
  },
  'rpc-blocked': {
    what: () => 'O servidor da rede recusou a consulta (acesso negado ou função não liberada).',
    app: () => 'O app parou: sem essa consulta ele não consegue conferir o que vai fazer.',
    you: () => 'Confira a internet e rode de novo. Se continuar, avise quem te passou o app.',
  },
  'send-unknown': {
    what: () => 'O app enviou a transação, mas não conseguiu confirmar se ela passou.',
    app: () => 'O app parou para não enviar duas vezes.',
    you: () => 'Confira a transação pelo link do relatório antes de rodar de novo.',
  },
  'token-frozen': {
    what: () => 'A conta deste token está congelada pelo criador do token.',
    app: () => 'O app pula esta conta e segue com as outras.',
    you: () => 'Nada a fazer: só o criador do token pode descongelar. O aluguel dessa conta fica preso.',
  },
  'token-2022-blocked': {
    what: () => 'Este token (Token-2022) tem uma regra que impede queimar, enviar ou fechar a conta.',
    app: () => 'O app pula esta conta e segue com as outras.',
    you: () => 'Nada a fazer por aqui. Se tiver valor, veja se o próprio token permite resolver pelo site dele.',
  },
  'close-authority': {
    what: () => 'Outra carteira tem a autoridade de fechar esta conta de token.',
    app: () => 'O app pula esta conta e segue com as outras.',
    you: () => 'Nada a fazer: só quem tem essa autoridade consegue fechar a conta.',
  },
  'rent-range': {
    what: () => 'Depois deste passo a conta ficaria com menos SOL do que o mínimo que a rede exige.',
    app: () => 'O app não enviou esse passo e segue com os outros.',
    you: () => 'Rode a varredura de novo: o app recalcula deixando o mínimo na conta.',
  },
  'pump-claim-failed': {
    what: () => 'O claim das creator fees da Pump.fun falhou.',
    app: () => 'O app parou este passo e não insiste. As fees continuam na Pump.fun.',
    you: () => 'Tente de novo mais tarde. Se repetir, a Pump.fun pode ter mudado o jeito de fazer o claim: avise o suporte do Clurn.',
  },
  'dbc-claim-failed': {
    what: () => 'A coleta das creator fees da Meteora falhou.',
    app: () => 'O app parou este passo e as próximas coletas da Meteora, e não insiste. As fees continuam no pool da Meteora.',
    you: () => 'Tente de novo mais tarde. Se repetir, a Meteora pode ter mudado o jeito de coletar: avise o suporte do Clurn.',
  },
  'launchlab-claim-failed': {
    what: () => 'A coleta das creator fees do LaunchLab (bonk.fun e outros) falhou.',
    app: () => 'O app parou este passo e as próximas coletas do LaunchLab, e não insiste. As fees continuam no cofre do LaunchLab.',
    you: () => 'Tente de novo mais tarde. Se repetir, o LaunchLab pode ter mudado o jeito de coletar: avise o suporte do Clurn.',
  },
  'unexpected-effect': {
    what: () => 'A simulação mostrou um resultado diferente do esperado para o seu destino.',
    app: () => 'O app parou tudo e não enviou nada.',
    you: () => 'Confira o endereço de destino e rode de novo. Se repetir, avise o suporte do Clurn antes de continuar.',
  },
  'dest-invalid': {
    what: () => 'O endereço de destino não é um endereço Solana válido.',
    app: () => 'O app não começa a limpeza com um destino assim.',
    you: () => 'Copie o endereço de novo, direto do Solflare, e cole inteiro.',
  },
  'dest-missing': {
    // destino que nunca recebeu SOL (getAccountInfo vazio). Até a 0.1.5 o texto dizia "Falta o endereço de destino" e o
    // autor achou que o campo não funcionava (31/10/2026)
    what: () => 'Este endereço de destino ainda não existe na rede Solana: ele nunca recebeu SOL.',
    app: () => 'O app não envia para uma carteira que nunca recebeu nada: um endereço com erro de digitação aparece igual, e o que fosse enviado não voltaria.',
    you: () => 'Confira se é o endereço da sua carteira. Se for uma carteira nova, mande um pouco de SOL para ela antes (0,001 SOL basta) e clique em \"Tentar de novo\".',
  },
  'dest-not-ordinary': {
    what: () => 'O destino não é uma carteira comum (é uma conta de programa ou de token).',
    app: () => 'O app não envia para este endereço.',
    you: () => 'Use o endereço de uma carteira sua, como a principal do Solflare.',
  },
  'dest-low-balance': {
    what: () => 'O destino ainda não existe na rede: o primeiro envio para ele precisa de um valor mínimo.',
    app: () => 'O app não envia um valor abaixo do mínimo para este destino.',
    you: () => 'Mande um pouco de SOL para o destino antes, ou escolha outro destino.',
  },
  'dest-lookalike': {
    what: (p) => `O endereço colado imita uma conta da sua frase (conta nº ${p.index}): começo e fim iguais, meio diferente.`,
    app: () => 'O app parou: isso é o sinal de um golpe de endereço parecido.',
    you: () => 'Copie o endereço de novo, direto do Solflare, e confira o meio dele.',
  },
  'seed-words': {
    what: () => 'A frase não parece válida (palavras faltando, a mais ou fora da lista).',
    app: () => 'O app não derivou nenhuma carteira e não guardou a frase.',
    you: () => 'Confira as palavras e a ordem, sem espaços sobrando.',
  },
  'seed-unknown-word': {
    what: (p) => `Uma palavra da frase não está na lista oficial (palavra nº ${p.position}).`,
    app: () => 'O app não derivou nenhuma carteira e não guardou a frase.',
    you: () => 'Confira a grafia dessa palavra: pode ter uma letra trocada.',
  },
  'seed-checksum': {
    what: () => 'As palavras estão na lista, mas a frase não fecha na conferência final (alguma palavra errada ou fora de ordem).',
    app: () => 'O app não derivou nenhuma carteira e não guardou a frase.',
    you: () => 'Confira a ordem e se alguma palavra foi trocada por outra parecida.',
  },
  'seed-duplicate': {
    what: (p) => `Esta frase é a mesma da frase nº ${p.of}.`,
    app: () => 'O app ignora a repetida e limpa só uma vez.',
    you: () => 'Tire a repetida da lista, ou troque por outra frase.',
  },
  'too-many-frases': {
    what: () => 'A lista passou do máximo de 10 frases por rodada.',
    app: () => 'O app não começou nada e não guardou as frases.',
    you: () => 'Faça a limpeza em duas rodadas, com até 10 frases em cada.',
  },
  // chave privada colada (src/core/carteiras/keys.ts): o texto só cita a linha (e a frase ou o limite), nunca a chave
  'key-unknown': {
    what: (p) => `A linha ${p.line} não é uma chave privada que o app reconhece.`,
    app: () => 'O app não leu nenhuma chave deste cartão e não guardou o texto.',
    you: () => 'Cole uma chave privada por linha, inteira, do jeito que a carteira ou o bot exporta. Frase de palavras vai num cartão separado.',
  },
  'key-mismatch': {
    what: (p) => `A chave da linha ${p.line} não confere: parece cortada ou com algum caractere trocado.`,
    app: () => 'O app não leu nenhuma chave deste cartão e não guardou o texto.',
    you: () => 'Copie essa chave de novo, inteira, direto da carteira ou do bot.',
  },
  'key-looks-address': {
    what: (p) => `A linha ${p.line} parece um endereço público, não uma chave privada.`,
    app: () => 'O app não aceita endereço no lugar da chave: com ele não dá para limpar nada.',
    you: () => 'Cole a chave privada (a opção de exportar chave privada, na carteira ou no bot), não o endereço.',
  },
  'key-duplicate': {
    what: (p) => (p.of === undefined ? `A chave da linha ${p.line} aparece mais de uma vez neste cartão.` : `A chave da linha ${p.line} repete uma chave da frase nº ${p.of}.`),
    app: () => 'O app não leu nenhuma chave deste cartão e não guardou o texto.',
    you: () => 'Tire a linha repetida.',
  },
  'key-is-main': {
    what: (p) => `A chave da linha ${p.line} é da conta principal da frase nº ${p.of}.`,
    app: () => 'O app nunca mexe na conta principal e não leu nenhuma chave deste cartão.',
    you: () => 'Tire essa linha: a conta principal fica de fora da limpeza.',
  },
  'review-changed': {
    what: (p) => `A lista de carteiras da frase nº ${p.frase} mudou depois da sua conferência.`,
    app: () => 'O app não montou o plano e não enviou nada.',
    you: () => 'Confira as carteiras dessa frase de novo e digite a contagem.',
  },
  // cartão de chaves com o recurso desligado (src/core/features.ts): nenhuma chave é lida
  'keys-off': {
    what: () => 'Esta versão do Clurn ainda não aceita chaves privadas coladas, só frases de recuperação.',
    app: () => 'O app não leu nenhuma chave deste cartão e não guardou o texto.',
    you: () => 'Cole a frase de recuperação (12 ou 24 palavras) da carteira dessas burners.',
  },
  'too-many-keys': {
    what: (p) => `O cartão passou do máximo de ${p.max} chaves.`,
    app: () => 'O app não leu nenhuma chave deste cartão e não guardou o texto.',
    you: (p) => `Divida as chaves em mais de um cartão, com até ${p.max} em cada.`,
  },
  'rpc-quota': {
    what: () => 'O servidor da rede recusou por limite de uso (cota do plano esgotada).',
    app: () => 'O app parou este passo e não insiste.',
    you: () => 'Rode de novo: sem créditos no RPC do app, ele usa o público sozinho (mais lento). O que já foi enviado continua valendo.',
  },
  'task-busy': {
    what: () => 'Outra tarefa do app ainda está terminando.',
    app: () => 'O app espera ela acabar e continua sozinho.',
    you: () => '',
  },
  'stopped-by-user': {
    what: () => 'Você parou a limpeza.',
    app: () => 'O app terminou o passo que estava no ar e não enviou os próximos.',
    you: () => 'Rode a varredura de novo quando quiser continuar: o app recalcula o que falta.',
  },
  'app-fee-wallet': {
    what: () => 'A carteira que recebe a taxa do app ainda não está pronta na rede.',
    app: () => 'O app parou antes de qualquer envio: sem ela, as transações seriam recusadas.',
    you: () => 'Avise quem te passou o app. Nada foi feito nas suas carteiras.',
  },
  'token-balance-changed': {
    what: () => 'O saldo desta moeda mudou desde a análise (chegou ou saiu token), então a conta não fecha com o valor analisado.',
    app: () => 'O app não mexeu nesta conta e segue com as outras.',
    you: () => 'Rode a análise de novo: o app lê o saldo de agora e queima o valor certo.',
  },
  'token-rejected': {
    what: () => 'A rede recusou queimar ou fechar esta conta de token.',
    app: () => 'Nada saiu desta conta. O app segue com as outras.',
    you: () => 'Rode a análise de novo. Se repetir, copie os detalhes técnicos e mande para o suporte do Clurn.',
  },
  'rpc-out-of-sync': {
    what: () => 'O servidor da rede estava atrasado e não reconheceu a transação.',
    app: () => 'O app tentou de novo com dados novos e não deu; não enviou este passo e segue com os outros.',
    you: () => 'Rode de novo daqui a pouco: o app recalcula o que falta.',
  },
  'payer-no-sol': {
    what: () => 'A carteira que paga as taxas de rede ficou sem SOL para esta transação.',
    app: () => 'O app não enviou este passo.',
    you: () => 'Rode a análise de novo: ela mostra quanto depositar e em qual carteira.',
  },
  unknown: {
    what: () => 'Algo deu errado e o app não reconheceu o erro.',
    app: () => 'O app parou este passo e não insiste.',
    you: () => 'Rode de novo. Se repetir, copie os detalhes técnicos e mande para o suporte do Clurn.',
  },
};

export const LOST_PT = { before: 'Não. Nada saiu neste passo.', after: 'Ainda não sabemos. Confira pelo link.' };

// Terminal: só "o que houve" + "o que você faz". O texto técnico nunca entra aqui.
export function formatErrorPt(e: Explained): string {
  const t = ERROR_TEXT_PT[e.code];
  const lines = [`[${e.code}] ${t.what(e.params)}`];
  const you = t.you(e.params);
  if (you) lines.push(`O que fazer: ${you}`);
  return lines.join('\n');
}
