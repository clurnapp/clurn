// App local: servidor só em 127.0.0.1 + uma página no navegador.
//
//   npm start
//
// Segurança:
// - escuta só em 127.0.0.1 (nada de fora do computador alcança);
// - código secreto novo a cada abertura, exigido em toda chamada (outro site aberto no navegador não consegue usar a API);
// - confere o cabeçalho Host (contra DNS rebinding);
// - as frases (até 10) chegam do navegador para este processo e viram seed (bytes) na hora: o texto nunca é guardado,
//   gravado nem registrado; a seed de cada frase vive só até terminar a busca dela (depois fill(0));
// - chaves privadas coladas (um cartão de chaves) seguem a mesma regra: viram bytes no parser (keys.ts), os bytes vivem
//   só até virarem as chaves de assinatura do cartão (depois fill(0)), e nem o texto nem os bytes saem do servidor;
// - "Limpar outra frase" apaga as chaves e as seeds pendentes de todas as frases e volta ao início com o app aberto;
//   "Encerrar" faz o mesmo e fecha o app.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase58, isAddress } from '../core/solana/base58.ts';
import { addressAt, burnerSigner, deriveMainAddress, isMainAccount, mainAddresses, mainIndexOf, needsReview, standardPath, trustPath, walletLabel, type CardApp, type WalletApp } from '../core/carteiras/derivation.ts';
import { keySigners, wipeParsedKeys, type ParsedKey } from '../core/carteiras/keys.ts';
import { reviewPhantomAccounts, selectAccounts, type Review } from '../core/carteiras/accounts.ts';
import { detectBranches, detectWallet, type Detection } from '../core/carteiras/detect.ts';
import { KNOWN_ACCOUNTS, knownWallets, type KnownWallet } from '../core/limpeza/destination.ts';
import { execute, ExecutionAborted, explorerLink, validateDestination, type StepResult } from '../core/limpeza/executor.ts';
import { buildPlan, describeStep, FeePayerError, PlanError, type Plan, type Step, type TokenDecision } from '../core/limpeza/plan.ts';
import { applyCurves, fetchPrices, looksLikeImpostor, tokenValue, type PriceResult, type TokenInfo } from '../core/limpeza/prices.ts';
import { readCurves } from '../core/limpeza/curve-price.ts';
import { burnNeedsExtraConfirmation, inBurnAll, priceLookupFailed, recommend, type RecommendationCode } from '../core/limpeza/recommend.ts';
import { createRpc, describeRpc, PUBLIC_RPC_LIMITS, type RpcClient, type RpcOptions } from '../core/solana/rpc.ts';
import { checkRpc, networkGuarded, rpcProblemMessage } from '../core/solana/rpc-check.ts';
import { withGpaFallback } from '../core/solana/gpa-fallback.ts';
import { balancesOnly, cleanupScanOptions, discoverBurners, rereadIncomplete, scanWallets, SEARCH_GAP, SEARCH_MAX, totalCreatorFeeLamports, unreadParts, type Discovery, type WalletScan } from '../core/limpeza/scan.ts';
import { BASE_FEE_LAMPORTS, summarize } from '../core/limpeza/summary.ts';
import type { Signer } from '../core/solana/tx.ts';
import { evmAddress } from '../core/evm/evm.ts';
import { batchOf, scanEvm, type EvmCall, type EvmScan } from '../core/evm/evm-scan.ts';
import { EVM_ACCOUNTS, isDust, usedByChain } from '../cli/outras-redes.ts';
import { REPO_ROOT, writeReport } from '../cli/io.ts';
import { CodedError, explainError, type ErrorCode, type ErrorParams, type Explained } from '../core/limpeza/errors.ts';
import { buildReceipt, mergeReceipts, type FraseReceipt } from './receipt.ts';
import { waitForFunding } from './funding-wait.ts';
import { FUND_TX_FEE_LAMPORTS, fundingOffer, fundingPlan, type FundingOffer, type Lender } from '../core/limpeza/funding.ts';
import { GATHER_ENABLED, gatherOffer, gatherPlan, type GatherOffer } from '../core/limpeza/gather.ts';
import { MAX_FRASES, parseFrases, type FraseApp, type FraseInput } from './frases.ts';
import { createPausableRpc, StopRequested, type PausableRpc, type PauseReason } from './pausable-rpc.ts';
import { createEta, estimateRun, RUN_COSTS, type RunStage } from './eta.ts';

import { appVersion, hasCustomDefault, PUBLIC_RPC as RPC, readEmbeddedRpcs, rpcCandidates, rpcHeaders, type EmbeddedRpc, type RpcSources } from './rpc-padrao.ts';
import { appendHistory, createUsageMeter, defaultHistoryFile, fetchHeliusBalance, heliusTarget, historySummary, readHistory, usageDelta, type HeliusBalance, type Usage, type UsageMeter } from './creditos.ts';
import type { Cluster } from '../core/solana/rpc-check.ts';
import { FEATURES } from '../core/features.ts';
import { checkUpdate, downloadInstaller, launchInstaller, UpdateFailed, type Manifest } from './atualizacao.ts';

const TOKEN = randomBytes(24).toString('hex');
const UI_FILE = path.join(import.meta.dirname, 'ui', 'index.html');
// logo e fontes servidos daqui mesmo (a CSP não deixa a página buscar nada fora). Só esta lista fixa: nenhum outro arquivo sai do disco.
const ASSET_DIR = path.join(import.meta.dirname, 'ui', 'assets');
// ícone da janela e da barra de tarefas em PNG: SVG o Edge desenha em 16 px e estica (fica borrado)
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
export const ASSETS: Record<string, string> = {
  'clurn.svg': 'image/svg+xml',
  'clurn-icone.svg': 'image/svg+xml',
  ...Object.fromEntries(ICON_SIZES.map((s) => [`clurn-icone-${s}.png`, 'image/png'])),
  'inter.woff2': 'font/woff2',
  'chakra-petch-600.woff2': 'font/woff2',
  'chakra-petch-700.woff2': 'font/woff2',
  'jetbrains-mono-500.woff2': 'font/woff2',
  // lista BIP39: a página confere a frase (palavra por palavra) sem mandar nada ao servidor; o arquivo mora em src/core
  'bip39-english.txt': 'text/plain; charset=utf-8',
};
const ASSET_FILE: Record<string, string> = { 'bip39-english.txt': path.join(import.meta.dirname, '..', 'core', 'carteiras', 'bip39-english.txt') };

// ---------- só para testes: RPC, preços e outras redes falsos (sem rede) ----------

type RpcFactory = (o: RpcOptions) => RpcClient;
let rpcFactory: RpcFactory = createRpc;
export function setRpcFactoryForTest(f: RpcFactory | null) {
  rpcFactory = f ?? createRpc;
}
// Pausa com o RPC público fora do ar: o app tenta voltar sozinho a cada RPC_RETRY_MS (teste: curto).
export const RPC_RETRY_MS = 15_000;
let rpcRetryMs = RPC_RETRY_MS;
export function setRpcRetryForTest(ms: number | null) {
  rpcRetryMs = ms ?? RPC_RETRY_MS;
}
// RPCs embutidos no app empacotado (rpc-padrao.ts), na ordem: lidos uma vez ao subir. Nos testes, trocados por falsos
// (uma URL com o projeto, ou a lista inteira).
let embeddedRpcs: EmbeddedRpc[] = readEmbeddedRpcs();
// versão do app (package.json): vai só para o proxy do Clurn, no cabeçalho x-clurn-versao (rpcHeaders)
const APP_VERSION = appVersion();
export function setEmbeddedRpcForTest(x: string | EmbeddedRpc[] | null | undefined, project: string | null = null) {
  embeddedRpcs = x === undefined ? readEmbeddedRpcs() : x === null ? [] : typeof x === 'string' ? [{ url: x, heliusProject: project }] : x;
  balanceCache = null;
}
// Painel de créditos (creditos.ts): histórico deste computador e consulta do saldo. Nos testes, arquivo e fetch falsos.
const credits: { historyFile: string; heliusFetch: typeof fetch | undefined } = { historyFile: defaultHistoryFile(), heliusFetch: undefined };
export function setCreditsForTest(x: { historyFile?: string; heliusFetch?: typeof fetch } | null) {
  credits.historyFile = x?.historyFile ?? defaultHistoryFile();
  credits.heliusFetch = x?.heliusFetch;
  balanceCache = null;
}
// O proxy do Clurn (proxy/) guarda as chaves no Worker: o app não tem saldo para mostrar nem crédito próprio para contar
// (decisão de 16/11/2026, 1.0 sem chave embutida e sem o painel de créditos).
const isProxyRpc = (url: string | null | undefined): boolean => Boolean(url) && embeddedRpcs.some((e) => e.proxy && e.url === url);
const rpcSources = (chosen?: string | null): RpcSources => ({ chosen, env: process.env.SOLANA_RPC_URL, embedded: embeddedRpcs.map((e) => e.url) });
type EvmScanner = (addresses: string[]) => Promise<EvmScan>;
type Sleep = (ms: number) => Promise<void>;
type EvmAddressOf = (seed: Uint8Array, i: number) => string;
const external: { pricesFetch: typeof fetch | undefined; pricesSleep: Sleep | undefined; evmCall: EvmCall | null; evmScan: EvmScanner | null; evmAddressOf: EvmAddressOf; fundingSleep: Sleep | undefined; execSleep: Sleep | undefined; readSleep: Sleep | undefined; confirmTimeoutMs: number | undefined } = {
  pricesFetch: undefined,
  pricesSleep: undefined,
  evmCall: null, // null: lote JSON-RPC de verdade (defaultEvmBatch)
  evmScan: null,
  evmAddressOf: evmAddress, // teste: derivação que lança (o que o Node do Electron fazia sem secp256k1)
  fundingSleep: undefined, // espera do depósito: o teste decide quando a próxima leitura sai
  execSleep: undefined, // envio: sem a espera de 1,5 s entre confirmações
  readSleep: undefined, // busca e leitura: espera entre as novas leituras do que falhou (REREAD_WAITS_MS)
  confirmTimeoutMs: undefined, // envio: prazo até um passo sem confirmação virar 'desconhecido' (produção: 180 s, do executor)
};
export function setExternalForTest(x: { pricesFetch?: typeof fetch; pricesSleep?: Sleep; evmCall?: EvmCall; evmScan?: EvmScanner; evmAddressOf?: EvmAddressOf; fundingSleep?: Sleep; execSleep?: Sleep; readSleep?: Sleep; confirmTimeoutMs?: number } | null) {
  external.pricesFetch = x?.pricesFetch;
  external.pricesSleep = x?.pricesSleep;
  external.evmCall = x?.evmCall ?? null;
  external.evmScan = x?.evmScan ?? null;
  external.evmAddressOf = x?.evmAddressOf ?? evmAddress;
  external.fundingSleep = x?.fundingSleep;
  external.execSleep = x?.execSleep;
  external.readSleep = x?.readSleep;
  external.confirmTimeoutMs = x?.confirmTimeoutMs;
}
const readEvm = (addresses: string[]) => (external.evmScan ? external.evmScan(addresses) : scanEvm(addresses, external.evmCall ? batchOf(external.evmCall) : undefined));

// ---------- estado da sessão (só em memória) ----------

type Holding = {
  id: number; // único na rodada (todas as frases)
  frase: number;
  walletIndex: number;
  walletLabel: string; // Solflare "N=3" / Phantom "Conta 4"
  wallet: string;
  account: string;
  mint: string;
  kind: 'fungible' | 'nft';
  amount: bigint;
  decimals: number;
  symbol: string | null;
  name: string | null;
  category: TokenInfo['category'];
  impostor: boolean;
  usdValue: number | null;
  solValue: number | null; // só pela curva da Pump.fun (vale mesmo sem o preço do SOL em dólar)
  recommendation: TokenDecision;
  whyCode: RecommendationCode;
  why: string;
  burnNeedsConfirmation: boolean;
  priceLookupFailed: boolean; // a consulta de preços deste mint falhou e a rede não precificou: valor desconhecido (recommend.ts)
  inBurnAll: boolean; // entra no botão "Queimar todos" (só o que não tem valor conhecido e pode ser queimado)
  rentLamports: number; // aluguel da conta: o que queimar e fechar devolve (a Confirmar mostra o das moedas em "manter")
};

type FeeWait = { code: ErrorCode; params: ErrorParams; waiting: true }; // espera pelo depósito de SOL das taxas
// empréstimo das taxas feito por outra frase (um passo 'fund' executado): fica no cartão e no relatório
export type Funding = { fromFrase: number; fromIndex: number; from: string; toIndex: number; to: string; lamports: bigint; result: StepResult };
// SOL da própria frase juntado na pagadora (passos 'gather' executados, src/core/limpeza/gather.ts): cartão e relatório
export type Gathering = GatherOffer & { results: StepResult[] };
// Phantom com todas as contas protegidas: a frase fica fora da rodada, com o aviso no cartão (não recusa o pedido)
export type PlanNotice = { code: 'phantom-all-protected'; params: { frase: number } };
export type FraseStatus = 'fila' | 'busca' | 'leitura' | 'pronta' | 'erro';

// Estado de UMA frase. Toda carteira é (frase, índice): as chaves ficam no mapa da própria frase,
// e a N=3 de uma frase nunca se confunde com a N=3 de outra.
export type FraseState = {
  n: number; // 1 a 10, na ordem em que a pessoa colou (a irmã de uma frase 'ambas' ganha o próximo número livre)
  app: CardApp; // na 'auto', 'solflare' até a busca dizer qual é; 'chaves': cartão de chaves privadas coladas
  auto: boolean; // o app descobre pela rede qual carteira a frase usa
  detected: Detection | null; // o que a busca achou (só na 'auto')
  pair: number | null; // 'ambas': nº da 1ª frase irmã (as irmãs são as frases com pairOf = n)
  pairOf: number | null; // a irmã: nº da frase colada (mesma frase, outro ramo: contas da Phantom ou da Trust)
  status: FraseStatus;
  error: { code: ErrorCode; params: ErrorParams } | null;
  seed: Buffer | null; // bytes, nunca o texto; só até terminar a busca desta frase (depois fill(0) e null)
  // cartão de chaves: os bytes das chaves (nunca o texto), só até virarem as chaves de assinatura (depois fill(0) e null)
  keys: ParsedKey[] | null;
  // cartão de chaves: endereço e linha de cada chave colada, na ordem (índice = carteira). Só dado público: confere
  // repetida e principal quando outro cartão é refeito, e cita a linha no erro
  keyList: Array<{ address: string; line: number }> | null;
  // cartão de chaves: quantas chaves já estavam como carteira de uma frase da rodada (entram pela frase) e a 1ª frase
  keysOverlap: { count: number; of: number } | null;
  main: string | null; // a principal do caminho do cartão (Trust: a conta 0; os outros: a Conta 1)
  known: KnownWallet[]; // contas comuns da frase (só endereços), para reconhecer destino imitador
  evmAddresses: string[];
  discovery: Discovery | null;
  signers: Map<number, Signer>;
  scans: WalletScan[];
  // saldo de cada temporária quando a análise leu (antes de depósito, juntar ou empréstimo): separa o SOL que o
  // cliente depositou (isento da taxa do app) do SOL esquecido (paga 11%)
  analysisLamports: Map<number, number>;
  review: Review | null; // Phantom e Trust: todas as contas, com a principal e os alertas de diferença
  holdings: Holding[];
  evm: EvmScan | null;
  feeWarning: string | null;
  nothingToClean: boolean; // burners lidas sem nada a fazer (não é falta de SOL)
  feeWait: FeeWait | null;
  feeNeed: FeePayerError | null; // o erro de falta de SOL atual (temporária sugerida, reserva): base da oferta de empréstimo
  funding: Funding | null; // empréstimo das taxas vindo de outra frase, já enviado (ou tentado)
  gathering: Gathering | null; // o último "juntar o SOL" desta frase, enviado (ou tentado)
  fundingAbort: AbortController | null;
  plan: Plan | null;
  planNotice: PlanNotice | null; // por que a frase ficou fora do plano (fora falta de SOL, que é o feeWait)
  // conferência depois do envio: as mesmas carteiras lidas de novo (o recibo continua sobre `scans`)
  afterScans: WalletScan[] | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export function newFrase(n: number, app: FraseApp = 'solflare', seed: Buffer | null = null, error: FraseState['error'] = null, keys: ParsedKey[] | null = null): FraseState {
  // cartão de chaves: não há busca, a lista de carteiras são as próprias chaves (todas contam como usadas)
  const keyList = keys && keys.map((k) => ({ address: k.address, line: k.line }));
  return {
    n,
    app: app === 'auto' ? 'solflare' : app,
    auto: app === 'auto',
    detected: null,
    pair: null,
    pairOf: null,
    status: error ? 'erro' : 'fila',
    error,
    seed,
    keys,
    keyList,
    keysOverlap: null,
    main: null,
    known: [],
    evmAddresses: [],
    discovery: keyList && { wallets: keyList.map((k, index) => ({ index, address: k.address, hasHistory: true })), checked: keyList.length, reachedMax: false },
    signers: new Map(),
    scans: [],
    analysisLamports: new Map(),
    review: null,
    holdings: [],
    evm: null,
    feeWarning: null,
    nothingToClean: false,
    feeWait: null,
    feeNeed: null,
    funding: null,
    gathering: null,
    fundingAbort: null,
    plan: null,
    planNotice: null,
    afterScans: null,
    startedAt: null,
    finishedAt: null,
  };
}

// o que a tela mostra em "Agora: …" e no tempo restante
export type Progress = {
  fase: string;
  frase: number | null;
  carteira: string | null;
  feitos: number;
  total: number;
  etaMs: number | null;
  geral: { feitos: number; total: number }; // todas as frases da tarefa
};

// resultado de um passo, sempre com a frase dele (a N=3 de uma frase nunca se confunde com a de outra)
export type FraseResult = StepResult & { frase: number };

type Session = {
  busy: string | null;
  cluster: Cluster;
  rpcLabel: string;
  // URL do RPC em uso e a lista da rodada (rpcCandidates), para a troca automática ir à próxima chave. Só no
  // servidor: a URL leva a chave e nunca vai para a página (que vê rpcLabel).
  rpcUrl: string;
  rpcUrls: string[];
  customRpc: boolean; // RPC próprio (Helius etc.) ou o público da Solana: muda a estimativa de tempo
  rpc: PausableRpc | null; // UM cliente para a rodada inteira, dividido por todas as frases (limite do Helius)
  fundings: Array<Funding & { frase: number }>; // empréstimos das taxas entre frases nesta rodada (relatório)
  single: SingleDeposit | null; // depósito único das taxas para a rodada inteira (uma carteira, um valor)
  forwards: Array<{ frase: number; fromFrase: number; from: string; to: string; lamports: bigint; result: StepResult }>; // repasses do depósito único (relatório)
  gatherings: Array<Gathering & { frase: number }>; // SOL juntado dentro de cada frase nesta rodada (relatório)
  search: { max: number; gap: number };
  roundReady: boolean; // RPC conferido e aluguel lido nesta rodada: só então uma frase pode ser refeita sozinha
  frases: FraseState[];
  prices: PriceResult | null; // uma consulta por rodada, com os tokens de todas as frases
  rentExemptZero: number;
  nextHoldingId: number;
  pause: PauseReason | null;
  progress: Progress | null;
  simResults: FraseResult[];
  execResults: FraseResult[];
  aborted: string | null;
  abortedError: Explained | null;
  abortedFrase: number | null; // frase em que a simulação/execução parou (as seguintes não rodaram)
  executed: boolean; // uma execução por rodada: só uma nova análise zera
  reportFile: string | null;
  usage: UsageMeter; // créditos do RPC próprio gastos nesta sessão, por etapa (o público não gasta crédito)
  recorded: Usage; // o que já foi gravado no histórico deste computador
  ownLabel: string; // host do RPC próprio que gastou os créditos (a rodada pode ter caído para o público depois)
  retrying: boolean; // pausa no público: as novas tentativas sozinhas estão rodando
  slot: { last: number }; // último passo confirmado na rodada: todo envio (frases, empréstimo, repasse, juntar) lê dali em diante
};

const fresh = (): Session => ({
  busy: null,
  cluster: 'mainnet',
  rpcLabel: '',
  rpcUrl: '',
  rpcUrls: [],
  customRpc: false,
  rpc: null,
  fundings: [],
  single: null,
  forwards: [],
  gatherings: [],
  slot: { last: 0 },
  search: { max: SEARCH_MAX, gap: SEARCH_GAP },
  roundReady: false,
  frases: [],
  prices: null,
  rentExemptZero: 0,
  nextHoldingId: 1,
  pause: null,
  progress: null,
  simResults: [],
  execResults: [],
  aborted: null,
  abortedError: null,
  abortedFrase: null,
  executed: false,
  reportFile: null,
  usage: createUsageMeter(),
  recorded: { requests: 0, credits: 0, byStage: {} },
  ownLabel: '',
  retrying: false,
});

let S: Session = fresh();

// as frases que entram na simulação e na execução, na ordem (frase sem plano fica fora da rodada)
const planned = (): FraseState[] => S.frases.filter((f) => f.plan);

// o destino é um só na rodada: todos os planos apontam para ele (senão, nenhum)
function roundDestination(): string | null {
  const ds = new Set(planned().map((f) => f.plan!.destination));
  return ds.size === 1 ? [...ds][0]! : null;
}

// ---------- eventos para a página (Server-Sent Events) ----------

const clients = new Set<http.ServerResponse>();
// para encerrar sozinho quando a janela fecha (ver shouldCloseIdle)
const link = { everConnected: false, lastDisconnect: 0 };
function emit(type: string, data: unknown) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`;
  for (const c of clients) c.write(payload);
}

// ---------- visão do estado para a página (nunca inclui chave, seed nem frase) ----------

// o passo em partes, para a página descrever no idioma escolhido (description continua em português)
export function stepView(s: Step) {
  const count = (a: string) => (s.kind === 'tokens' ? s.actions.filter((x) => x.action === a).length : 0);
  return {
    kind: s.kind,
    walletIndex: s.walletIndex,
    estimateLamports: s.kind === 'claim-curve' || s.kind === 'claim-amm' || s.kind === 'claim-shared' || s.kind === 'claim-cashback' || s.kind === 'close-uva' || s.kind === 'claim-dbc' || s.kind === 'claim-launchlab' ? s.estimateLamports : null,
    venue: s.kind === 'claim-cashback' || s.kind === 'close-uva' ? s.venue : null, // cashback e conta de volume: Pump.fun ou PumpSwap
    bps: s.kind === 'claim-shared' ? s.shared.bps : null, // parte desta carteira na fee dividida
    close: count('close'),
    burnClose: count('burn-close'),
    transferClose: count('transfer-close'),
    isFeePayer: s.kind === 'sweep-sol' && s.isFeePayer,
    // empréstimo das taxas para outra frase (funding.ts): valor e frase que recebe
    lamports: s.kind === 'fund' || s.kind === 'gather' ? s.lamports : null,
    all: s.kind === 'gather' && s.all === true, // juntar: manda tudo (valor exato na hora do envio)
    toFrase: s.kind === 'fund' ? s.toFrase : null,
    // passo que só libera creator fee parada (a coleta vem no passo seguinte da mesma carteira)
    sweepOnly: (s.kind === 'claim-curve' || s.kind === 'claim-amm') && s.sweepOnly === true,
    sweeps: s.kind === 'claim-curve' || s.kind === 'claim-amm' ? (s.sweeps?.length ?? 0) : 0,
    pools: s.kind === 'claim-dbc' ? s.pools.length : 0, // coleta da Meteora: quantos pools nesta transação
  };
}

export function resultView(r: StepResult & { frase?: number }) {
  return {
    frase: r.frase ?? null,
    status: r.status,
    description: r.description,
    step: stepView(r.step),
    walletIndex: r.step.walletIndex,
    destinationDelta: r.destinationDelta ?? null,
    appFeeDelta: r.appFeeDelta ?? null,
    skippedClaim: r.skippedClaim === true, // coleta do PumpSwap pulada que só fechou a ATA WSOL (não é coleta)
    closedRentLamports: r.closedRentLamports ?? null, // ATA WSOL antiga fechada pela coleta do PumpSwap (aluguel, não fee)
    detail: r.detail ?? null,
    link: r.signature ? explorerLink(r.signature, S.cluster) : null,
    error: r.error ?? null,
  };
}

// recibo do "tem certeza?": o rótulo da carteira vem do servidor (Solflare "N=3" / Phantom "Conta 4"), a página nunca fixa "N="
// Um recibo por frase simulada, somados (mergeReceipts). Sem nenhuma frase simulada: null (mergeReceipts lança com lista vazia).
// executed: o recibo do que foi ENVIADO, para a tela final (linhas iguais às da Confirmar, com a creator fee coletada)
function receiptView(executed = false) {
  const list: FraseReceipt[] = [];
  for (const f of planned()) {
    const sims = (executed ? S.execResults : S.simResults).filter((r) => r.frase === f.n);
    if (!sims.length) continue;
    const r = buildReceipt({ plan: f.plan!, simResults: sims, holdings: f.holdings, main: f.main, executed });
    const L = (i: number) => walletLabel(f.app, i);
    const labelled = {
      ...r,
      toDestination: { ...r.toDestination, tokens: r.toDestination.tokens.map((t) => ({ ...t, label: L(t.walletIndex) })) },
      burned: r.burned.map((t) => ({ ...t, label: L(t.walletIndex) })),
      kept: r.kept.map((t) => ({ ...t, label: L(t.walletIndex) })),
      failed: r.failed.map((x) => ({ ...x, label: L(x.walletIndex) })),
      feePayerLabel: L(r.feePayerIndex),
    };
    list.push({ frase: f.n, app: f.app, receipt: labelled });
  }
  if (!list.length) return null;
  return mergeReceipts(list);
}

// "Já chegou no destino": só o líquido (destinationDelta) dos passos enviados; a taxa do app vai à parte
const sentSum = (pick: (r: StepResult) => bigint | undefined) => S.execResults.filter((r) => r.status === 'enviado').reduce((a, r) => a + (pick(r) ?? 0n), 0n);

// a parada do servidor como erro explicado: só ExecutionAborted tem texto próprio; qualquer outro erro pode ter acontecido
// no meio do envio, então fica 'unknown' sem o texto bruto (não sabemos se algo saiu, e a mensagem pode ter qualquer coisa)
export function abortedErrorOf(e: unknown): Explained {
  return e instanceof ExecutionAborted || e instanceof StopRequested ? explainError(e) : { code: 'unknown', params: {}, technical: '', beforeSend: false };
}

// código do erro para a página: só de erro com código; o texto bruto de outro erro nunca vai para estes campos
export function codeOf(e: unknown): { codigo: ErrorCode; params: ErrorParams } {
  return e instanceof CodedError ? { codigo: e.code, params: e.params } : { codigo: 'unknown', params: {} };
}

// aviso "a rede está lenta": no máximo um por tarefa; o listener nunca lança (lançar abortaria a chamada de RPC)
export function makeRetryNotice(send: (type: string, data: unknown) => void) {
  let shown = false;
  return {
    reset() { shown = false; },
    onRetry(_info: { attempt: number; waitMs: number; code: number | undefined }) {
      try {
        if (shown) return;
        shown = true;
        send('aviso', { codigo: 'rpc-busy' });
      } catch { /* aviso é só informação */ }
    },
  };
}
const retryNotice = makeRetryNotice((t, d) => emit(t, d));

const totalsOf = (scans: WalletScan[]) => (scans.length ? summarize(scans, S.prices?.prices ?? new Map()).totals : null);

export function walletsView(f: Pick<FraseState, 'scans' | 'app'>) {
  return f.scans.map((s) => ({
    index: s.index,
    label: walletLabel(f.app, s.index),
    address: s.address,
    lamports: s.lamports,
    closable: s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length).length,
    closableRent: s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length).reduce((a, t) => a + t.rentLamports, 0),
    creatorFees: s.fees ? totalCreatorFeeLamports(s.fees) : 0n,
    unswept: s.fees ? s.fees.unsweptCurveLamports + s.fees.unsweptPoolLamports : 0n, // só o que o app não coleta
    unsweptError: s.fees?.unsweptError ?? null, // a busca da fee parada falhou (os cofres valem)
    sharedOther: s.fees?.sharedOther ?? 0, // divisões (fee sharing) em que ela participa e o app não coleta
    otherQuote: s.fees?.otherQuoteFees ?? 0, // creator fee em moeda pareada em outro token (o app não coleta)
    sharedError: s.fees?.sharedError ?? null, // a busca da fee dividida falhou
    dbcOther: s.fees?.dbc?.other ?? 0, // pools da Meteora com fee que o app não coleta (na moeda, em outro token, transfer hook)
    dbcCut: s.fees?.dbc?.cut ?? 0, // pools da Meteora com fee além do limite por carteira (não lidos)
    dbcError: s.fees?.dbcError ?? null, // a busca da fee da Meteora falhou
    launchlabOther: s.fees?.launchlab?.other ?? 0, // cofres do LaunchLab com fee em outra moeda (USD1, USDC, USDT): o app não coleta
    launchlabError: s.fees?.launchlabError ?? null, // a leitura do cofre do LaunchLab falhou
    blocked: s.tokens.filter((t) => t.blockers.length || t.kind === 'invalid').map((t) => ({ account: t.account, mint: t.mint, reason: t.blockers.join('; ') || 'dados fora do formato' })),
    errors: s.errors,
    // o que ficou sem ler depois de todas as tentativas (vazio = lida inteira): a tela mostra em destaque
    unread: unreadParts(s),
  }));
}

function evmView(e: EvmScan | null) {
  return (
    e && {
      holdings: e.holdings.filter((h) => !isDust(h)),
      dust: e.holdings.filter(isDust).map((h) => `${h.chainName} conta ${h.account + 1} ${h.asset}`),
      used: usedByChain(e),
      errors: e.errors,
    }
  );
}

// Lista FECHADA de campos (nunca espalhar a frase inteira: seed e signers ficam de fora por construção)
export function fraseView(f: FraseState) {
  return {
    n: f.n,
    app: f.app,
    auto: f.auto,
    detected: f.detected,
    pair: f.pair,
    pairOf: f.pairOf,
    pairs: siblingsOf(f).map((g) => ({ n: g.n, app: g.app })),
    status: f.status,
    error: f.error,
    main: f.main,
    // cartão de chaves: chaves que já estavam numa frase da rodada (entram uma vez, pela frase). Nunca as chaves.
    keysOverlap: f.keysOverlap,
    discovery: f.discovery && { found: f.discovery.wallets.length, checked: f.discovery.checked, reachedMax: f.discovery.reachedMax },
    wallets: walletsView(f),
    holdings: f.holdings,
    // Phantom: lista para a pessoa conferir; a Conta 1 (isMain) nunca é limpa
    review: f.review,
    reviewFp: reviewFingerprint(f),
    evm: evmView(f.evm),
    totals: totalsOf(f.scans),
    feeWarning: f.feeWarning,
    feeWait: f.feeWait,
    // empréstimo das taxas por outra frase: a oferta (só enquanto espera) e o que já foi enviado
    fundingOffer: offerView(f),
    // juntar o SOL da própria frase na pagadora: a oferta (só enquanto espera) e o que já foi enviado
    gatherOffer: gatherView(f),
    gathering: f.gathering && gatheringView(f, f.gathering),
    funding: f.funding && { fromFrase: f.funding.fromFrase, fromName: walletLabel(S.frases.find((g) => g.n === f.funding!.fromFrase)?.app ?? 'solflare', f.funding.fromIndex), toName: walletLabel(f.app, f.funding.toIndex), lamports: f.funding.lamports, ...resultView(f.funding.result) },
    planNotice: f.planNotice,
    nothingToClean: f.nothingToClean,
    tempoMs: f.startedAt === null ? null : (f.finishedAt ?? Date.now()) - f.startedAt,
  };
}

function planView(f: FraseState) {
  const plan = f.plan!;
  return {
    frase: f.n,
    app: f.app,
    feePayerIndex: plan.feePayerIndex,
    feePayer: plan.feePayer,
    payerOutsideSelection: plan.payerOutsideSelection,
    steps: plan.steps.map((s) => ({ walletIndex: s.walletIndex, label: walletLabel(f.app, s.walletIndex), description: describeStep(s, (i) => walletLabel(f.app, i)), step: stepView(s) })),
    kept: plan.kept.map((k) => ({ walletIndex: k.walletIndex, mint: k.mint, reason: k.reason })),
    skipped: plan.skipped,
  };
}

function view() {
  const plans = planned();
  const destination = roundDestination();
  return {
    busy: S.busy,
    atualizacao: updateView(),
    cluster: S.cluster,
    rpc: S.rpcLabel,
    frases: S.frases.map(fraseView),
    holdings: S.frases.flatMap((f) => f.holdings),
    totals: totalsOf(S.frases.flatMap((f) => f.scans)),
    progress: S.progress,
    pause: S.pause,
    solUsd: S.prices?.solUsd ?? null,
    priceErrors: S.prices?.errors ?? [],
    // tokens com a consulta de preços falhada: ficam como valor desconhecido (um aviso só, com a contagem)
    pricesMissing: S.frases.flatMap((f) => f.holdings).filter((h) => h.priceLookupFailed).length,
    pricesAvailable: S.cluster === 'mainnet',
    // um destino, um plano por frase (só as frases que entram na rodada)
    plan: destination ? { destination, frases: plans.map(planView) } : null,
    simResults: S.simResults.map(resultView),
    execResults: S.execResults.map(resultView),
    receipt: receiptView(),
    execReceipt: S.execResults.length ? receiptView(true) : null,
    // depósito único das taxas: uma carteira, um valor, e os repasses às outras frases
    single: singleView(),
    // conferência depois do envio (null = ainda não conferiu): o que sobrou de limpável nas carteiras
    leftover: S.frases.some((f) => f.afterScans) ? leftoverOf(S.frases.flatMap((f) => f.afterScans ?? [])) : null,
    arrived: sentSum((r) => r.destinationDelta),
    arrivedAppFee: sentSum((r) => r.appFeeDelta),
    aborted: S.aborted,
    abortedError: S.abortedError,
    abortedFrase: S.abortedFrase,
    reportFile: S.reportFile && path.relative(REPO_ROOT, S.reportFile),
    // créditos do RPC próprio gastos nesta rodada (estimativa do medidor; o número oficial é o do Helius)
    credits: { own: S.customRpc && !isProxyRpc(S.rpcUrl), round: S.usage.snapshot() },
  };
}

// Saldo da chave do Helius (Admin API), guardado por 1 minuto: a página pede ao abrir e ao fim de cada tarefa.
let balanceCache: { at: number; value: HeliusBalance } | null = null;
const BALANCE_TTL_MS = 60_000;
async function heliusBalance(force: boolean): Promise<HeliusBalance> {
  if (!force && balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
  // a chave da rodada, se ela está num RPC próprio da mainnet; fora disso, a 1ª chave da lista que ainda tem crédito
  // (a que a próxima análise vai usar: a esgotada é recusada na conferência e a seguinte assume)
  const own = S.customRpc && S.rpcUrl && S.cluster === 'mainnet' ? [S.rpcUrl] : rpcCandidates('mainnet', rpcSources()).filter((u) => u !== RPC.mainnet);
  let value: HeliusBalance | null = null;
  for (const url of own) {
    const v = await fetchHeliusBalance(heliusTarget(url, heliusProjectFor(url)), credits.heliusFetch);
    if (v.status === 'ok' && v.restantes > 0) {
      value = v;
      break;
    }
    value ??= v;
  }
  value ??= { status: 'sem-projeto' };
  balanceCache = { at: Date.now(), value };
  return value;
}
// id do projeto do Helius de cada RPC: o gravado junto com a chave embutida; para a SOLANA_RPC_URL, HELIUS_PROJECT_ID
function heliusProjectFor(url: string): string | null {
  const env = process.env.HELIUS_PROJECT_ID?.trim() || null;
  const entry = embeddedRpcs.find((e) => e.url === url);
  if (entry) return entry.heliusProject ?? (url === process.env.SOLANA_RPC_URL?.trim() ? env : null);
  return env;
}

// Painel de créditos: só números (nunca a URL nem a chave). Sem RPC próprio, nada a mostrar.
export async function creditos(body: Record<string, unknown>) {
  // o 1º RPC da próxima rodada; o proxy conta como sem RPC próprio (o painel some)
  const own = hasCustomDefault('mainnet', rpcSources()) && !isProxyRpc(rpcCandidates('mainnet', rpcSources())[0]);
  return {
    own,
    round: S.usage.snapshot(),
    history: historySummary(readHistory(credits.historyFile)),
    // sem RPC do Helius (só o público ou o proxy), o Helius nem é consultado
    helius: own ? await heliusBalance(body.atualizar === true) : { status: 'sem-projeto' as const },
  };
}

// ---------- ações ----------

// recusa da API: texto de sempre + código para a página (padrão 'unknown')
export class BadRequest extends CodedError {
  constructor(message: string, code: ErrorCode = 'unknown', params: ErrorParams = {}) {
    super(message, code, params);
    this.name = 'BadRequest';
  }
}
// outra tarefa no ar: com o código, a página espera ela acabar e repete o pedido (nunca fica num "Tentar de novo" morto)
const busyRefusal = () => new BadRequest('Espere a tarefa em andamento terminar.', 'task-busy');

// a página não pergunta mais os limites da busca (pedido do autor): sem eles, vale o padrão automático
export function searchLimits(body: { max?: unknown; folga?: unknown }): { max: number; gap: number } {
  const max = Number(body.max ?? SEARCH_MAX);
  const gap = Number(body.folga ?? SEARCH_GAP);
  if (!Number.isInteger(max) || max < 1 || max > SEARCH_MAX || !Number.isInteger(gap) || gap < 1 || gap > 200) throw new BadRequest('Limites inválidos.');
  return { max, gap };
}

// rpcUrls: os RPCs a tentar, em ordem (rpcCandidates); o primeiro que passa na checagem é o da rodada
type RoundConfig = { cluster: Cluster; rpcUrls: string[]; max: number; gap: number };

// rede, RPC e limites valem para a rodada inteira (todas as frases)
export function roundConfig(body: { rede?: unknown; rpc?: unknown; max?: unknown; folga?: unknown }): RoundConfig {
  const cluster: Cluster = body.rede === 'devnet' ? 'devnet' : 'mainnet';
  const { max, gap } = searchLimits(body);
  const customRpc = typeof body.rpc === 'string' && body.rpc.trim() ? body.rpc.trim() : null;
  if (customRpc && !/^https:\/\//.test(customRpc)) throw new BadRequest('O RPC precisa começar com https://');
  return { cluster, rpcUrls: rpcCandidates(cluster, rpcSources(customRpc)), max, gap };
}

// parseFrases lança CodedError (lista vazia, mais de 10): vira recusa da API com o mesmo código
function parseFrasesOrRefuse(raw: unknown): FraseInput[] {
  try {
    return parseFrases(raw);
  } catch (e) {
    if (e instanceof CodedError) throw new BadRequest(e.message, e.code, e.params);
    throw e;
  }
}

// tira o texto das frases do pedido: depois disto, nada no servidor aponta para ele
function forgetTexts(raw: unknown) {
  if (!Array.isArray(raw)) return;
  for (const it of raw) if (it && typeof it === 'object') delete (it as Record<string, unknown>).texto;
  raw.length = 0;
}

// apaga o segredo que o cartão ainda guarda: a seed da frase ou os bytes das chaves coladas
export function wipeSeed(f: FraseState) {
  if (f.seed) {
    f.seed.fill(0);
    f.seed = null;
  }
  if (f.keys) {
    wipeParsedKeys(f.keys);
    f.keys = null;
  }
}

// o cartão ainda tem segredo para analisar (frase com seed, ou chaves coladas)
const hasSecret = (f: FraseState) => f.seed !== null || f.keys !== null;

// a frase vira endereços públicos na hora (principal, contas comuns, outras redes); a seed segue até a vez dela
function deriveIdentity(f: FraseState) {
  const seed = f.seed!;
  f.main = deriveMainAddress(seed);
  // contas 1 a 10 dos dois caminhos com principal (Phantom/Solflare e Trust): destino que imita qualquer uma é recusado
  f.known = [standardPath, trustPath].flatMap((path) => knownWallets(Array.from({ length: KNOWN_ACCOUNTS }, (_, i) => addressAt(seed, path(i)))));
  // só endereços públicos. Outras redes são só informação: se a derivação falhar (ex.: 30/10/2026, node:crypto
  // do Electron sem secp256k1), a frase segue com aviso no cartão, em vez de derrubar a análise inteira
  try {
    f.evmAddresses = Array.from({ length: EVM_ACCOUNTS }, (_, i) => external.evmAddressOf(seed, i));
  } catch {
    f.evmAddresses = [];
    f.evm = { holdings: [], usedAccounts: [], errors: ['outras redes: não deu para calcular os endereços neste computador'] };
  }
  emit('principal', { frase: f.n, main: f.main });
}

// progresso + tempo restante da tarefa (carteiras lidas de todas as frases; frase ainda não buscada conta ~100)
// carteira = rótulo da carteira que acabou de ser lida ("N=37", "Conta 4"), nunca o endereço
type Tracker = { report(fase: string, f: FraseState | null, feitos: number, total: number, carteira?: string | null): void };
// A busca das carteiras usadas de uma frase custa discoveryReqPerFrase requisições; em "carteiras lidas"
// (analysisReqPerWallet cada) vale ~39. O tempo conta esse trabalho também, senão fica parado em toda busca.
export const DISCOVERY_WORK = RUN_COSTS.discoveryReqPerFrase / RUN_COSTS.analysisReqPerWallet;
export function makeTracker(frases: FraseState[], customRpc: boolean): Tracker {
  const eta = createEta();
  const active = frases.filter(hasSecret); // as que serão analisadas nesta tarefa
  const read = new Map<number, number>();
  const searched = new Map<number, number>(); // fração da busca de cada frase (0 a 1)
  // as irmãs de uma frase 'ambas' nascem no meio da tarefa: as carteiras delas contam junto
  const withPairs = () => active.flatMap((f) => [f, ...siblingsOf(f)]);
  // o que a tela mostra: carteiras lidas de todas as frases
  const geral = () => {
    let feitos = 0;
    let total = 0;
    for (const f of withPairs()) {
      const t = f.discovery ? f.discovery.wallets.length : f.status === 'erro' ? 0 : RUN_COSTS.assumedWalletsPerFrase;
      total += t;
      feitos += f.status === 'pronta' || f.status === 'erro' ? t : Math.min(read.get(f.n) ?? 0, t);
    }
    return { feitos, total };
  };
  // o que o tempo mede: carteiras lidas + a busca de cada frase (DISCOVERY_WORK, pela fração já conferida)
  const work = () => {
    const g = geral();
    let feitos = g.feitos;
    let total = g.total;
    for (const f of active) {
      if (f.app === 'chaves') continue; // cartão de chaves: sem busca
      if (!f.discovery && f.status === 'erro') continue; // caiu antes da busca: nada dela conta
      total += DISCOVERY_WORK;
      feitos += f.discovery || f.status === 'pronta' || f.status === 'erro' ? DISCOVERY_WORK : DISCOVERY_WORK * (searched.get(f.n) ?? 0);
    }
    return { feitos, total };
  };
  // prévia da etapa inteira (a mesma do botão), para haver número desde o começo
  const prior = estimateRun({ frases: active.length, customRpc, stage: 'analysis' }).seconds * 1000;
  eta.start(work().total, active.length ? prior : null);
  return {
    report(fase, f, feitos, total, carteira = null) {
      if (f && fase === 'leitura') read.set(f.n, feitos);
      if (f && fase === 'busca') searched.set(f.n, total > 0 ? Math.min(1, Math.max(0, feitos / total)) : 0);
      const g = geral();
      const w = work();
      eta.setTotal(w.total);
      eta.tick(w.feitos);
      S.progress = { fase, frase: f?.n ?? null, carteira, feitos, total, etaMs: eta.remainingMs(), geral: g };
      emit('progresso', S.progress);
    },
  };
}

// Uma frase: busca → chaves → seed apagada → leitura. Erro aqui marca só esta frase; as outras seguem.
// Frase 'auto' com uso em mais de um ramo ('ambas') ganha uma irmã por ramo a mais, logo depois dela na lista
// (contas da Phantom, contas da Trust); todas são lidas aqui. Devolve as irmãs (ou []).
async function analyseFrase(f: FraseState, rpc: RpcClient, t: Tracker): Promise<FraseState[]> {
  if (f.app === 'chaves') {
    await analyseKeys(f, rpc, t);
    return [];
  }
  const seed = f.seed;
  if (!seed) return [];
  f.status = 'busca';
  f.startedAt = Date.now();
  f.finishedAt = null;
  let pairs: FraseState[] = [];
  try {
    try {
      if (f.auto) pairs = await discoverAuto(f, seed, rpc, t);
      else {
        const { max, gap } = S.search;
        f.discovery = await discoverBurners(seed, rpc, { app: f.app, max, gap, sleep: external.readSleep, onProgress: (n, k) => t.report('busca', f, n, Math.max(n, k + gap)) });
        if (f.app === 'trust') f.main = mainAddresses(seed)[1];
        setSigners(f, seed);
      }
    } finally {
      wipeSeed(f);
    }
  } catch (e) {
    failFrase(f, e);
    f.finishedAt = Date.now();
    return [];
  }
  S.frases.splice(S.frases.indexOf(f) + 1, 0, ...pairs);
  await readFrase(f, rpc, t);
  for (const g of pairs) await readFrase(g, rpc, t);
  return pairs;
}

// Cartão de chaves: sem busca. As chaves viram as chaves de assinatura e os bytes são zerados logo em seguida; a carteira
// que já é de uma frase da rodada sai do cartão (entra uma vez, pela frase); depois a leitura, como a de uma frase.
async function analyseKeys(f: FraseState, rpc: RpcClient, t: Tracker) {
  if (!f.keys) return;
  f.status = 'busca';
  f.startedAt = Date.now();
  f.finishedAt = null;
  try {
    try {
      f.signers = keySigners(f.keys);
    } finally {
      wipeSeed(f);
    }
    dropKeysOverlap(f);
  } catch (e) {
    failFrase(f, e);
    f.finishedAt = Date.now();
    return;
  }
  await readFrase(f, rpc, t);
}

// Carteira de um cartão de chaves que também é carteira de uma frase da rodada: sai do cartão de chaves (chave,
// leitura, moedas e conferência) e fica só na frase, que tem a principal e as contas protegidas dela. Devolve se
// mudou algo (quem chama refaz moedas e plano de teste do cartão).
function dropKeysOverlap(k: FraseState): boolean {
  if (k.app !== 'chaves' || !k.discovery) return false;
  const owner = new Map<string, number>(); // endereço → nº da frase colada que tem a carteira
  for (const g of S.frases) if (g.app !== 'chaves' && g.status !== 'erro') for (const a of burnerAddresses(g)) if (!owner.has(a)) owner.set(a, g.pairOf ?? g.n);
  const dropped = k.discovery.wallets.filter((w) => owner.has(w.address));
  if (!dropped.length) return false;
  const drop = new Set(dropped.map((w) => w.index));
  const of = Math.min(...dropped.map((w) => owner.get(w.address)!), k.keysOverlap?.of ?? Infinity);
  k.discovery = { ...k.discovery, wallets: k.discovery.wallets.filter((w) => !drop.has(w.index)) };
  for (const i of drop) {
    k.signers.delete(i);
    k.analysisLamports.delete(i);
  }
  k.scans = k.scans.filter((s) => !drop.has(s.index));
  k.holdings = k.holdings.filter((h) => !drop.has(h.walletIndex));
  if (k.review) k.review = { ...k.review, accounts: k.review.accounts.filter((a) => !drop.has(a.index)) };
  k.keysOverlap = { count: (k.keysOverlap?.count ?? 0) + drop.size, of };
  return true;
}

// as irmãs de uma frase colada (mesma frase, outros ramos), na ordem da lista
function siblingsOf(f: FraseState): FraseState[] {
  return S.frases.filter((g) => g.pairOf === f.n);
}

// chaves no mapa DESTA frase; na Phantom e na Trust, a principal (Conta 1 / conta 0) nunca ganha chave no app
function setSigners(f: FraseState, seed: Uint8Array) {
  for (const w of f.discovery!.wallets) if (!isMainAccount(f.app, w.index)) f.signers.set(w.index, burnerSigner(seed, w.index, f.app));
}

const nextFraseNumber = () => Math.max(0, ...S.frases.map((g) => g.n)) + 1;

// 'auto': busca no ramo das temporárias, no das contas comuns e no da Trust, e a rede decide
// (src/core/carteiras/detect.ts). Cada ramo com uso além do primeiro vira uma irmã (mesma frase), já com as
// chaves dela; a seed não passa para ela. Devolve as irmãs, na ordem Phantom, Trust.
async function discoverAuto(f: FraseState, seed: Uint8Array, rpc: RpcClient, t: Tracker): Promise<FraseState[]> {
  const { max, gap } = S.search;
  // o total de cada busca já reserva as seguintes (pelo menos a principal e a folga), para o progresso não voltar
  const rest = gap + 1;
  const sol = await discoverBurners(seed, rpc, { app: 'solflare', max, gap, sleep: external.readSleep, onProgress: (n, k) => t.report('busca', f, n, Math.max(n, k + gap) + (FEATURES.trustPath ? 2 : 1) * rest) });
  const ph = await discoverBurners(seed, rpc, { app: 'phantom', max, gap, sleep: external.readSleep, onProgress: (n, k) => t.report('busca', f, sol.checked + n, sol.checked + Math.max(n, k + gap) + (FEATURES.trustPath ? rest : 0)) });
  const before = sol.checked + ph.checked;
  // caminho da Trust desligado na 1.0 (src/core/features.ts): nem busca; sem uso, a frase segue só Solflare/Phantom
  const tr: Discovery = FEATURES.trustPath
    ? await discoverBurners(seed, rpc, { app: 'trust', max, gap, sleep: external.readSleep, onProgress: (n, k) => t.report('busca', f, before + n, before + Math.max(n, k + gap)) })
    : { wallets: [], checked: 0, reachedMax: false };
  const found: Record<WalletApp, Discovery> = { solflare: sol, phantom: ph, trust: tr };
  const [phantomMain, trustMain] = mainAddresses(seed);
  const mainOf = (app: WalletApp) => (app === 'trust' ? trustMain : phantomMain);
  const branches = detectBranches(sol, ph, tr);
  f.detected = detectWallet(sol, ph, tr);
  // 'principal' e 'nenhuma': nenhum ramo; a lista do Solflare vem vazia, e a frase fica "nada para limpar"
  const [first = 'solflare', ...others] = branches;
  f.app = first;
  f.main = mainOf(first);
  f.discovery = found[first];
  setSigners(f, seed);
  const base = nextFraseNumber();
  const pairs = others.map((app, k) => {
    const g = newFrase(base + k, app);
    g.detected = f.detected;
    g.pairOf = f.n;
    g.main = mainOf(app);
    g.known = f.known;
    g.discovery = found[app];
    g.startedAt = Date.now();
    setSigners(g, seed);
    return g;
  });
  f.pair = pairs[0]?.n ?? null;
  return pairs;
}

// leitura das carteiras achadas na busca; erro marca só esta frase
async function readFrase(f: FraseState, rpc: RpcClient, t: Tracker) {
  try {
    f.status = 'leitura';
    const wallets = f.discovery!.wallets;
    t.report('leitura', f, 0, wallets.length);
    f.scans = await scanWallets(rpc, wallets, cleanupScanOptions(S.rentExemptZero), (d, total, w) => t.report('leitura', f, d, total, walletLabel(f.app, w.index)), {
      sleep: external.readSleep,
      // a tela narra "Lendo de novo N carteiras que a rede não respondeu por inteiro"
      onReread: (pending, round) => t.report('releitura', f, round, pending),
    });
    f.analysisLamports = new Map(f.scans.map((s) => [s.index, s.lamports]));
    f.status = 'pronta';
  } catch (e) {
    failFrase(f, e);
  } finally {
    f.finishedAt = Date.now();
  }
}

// a frase vira 'erro' sem chaves e sem leituras (nada pela metade dela entra em total, plano ou espera)
function failFrase(f: FraseState, e: unknown) {
  cancelFundingWait(f);
  wipeSeed(f);
  f.signers.clear();
  f.scans = [];
  f.holdings = [];
  f.review = null;
  f.plan = null;
  f.feeWarning = null;
  f.nothingToClean = false;
  const c = codeOf(e);
  f.status = 'erro';
  f.error = { code: c.codigo, params: c.params };
}

// outras redes da frase: só informação; falha vira aviso da frase, nunca derruba a frase nem a rodada
async function readFraseEvm(f: FraseState) {
  if (!f.evmAddresses.length) return;
  try {
    f.evm = await readEvm(f.evmAddresses);
  } catch {
    f.evm = { holdings: [], usedAccounts: [], errors: ['outras redes: a leitura falhou'] };
  }
}

// tokens + plano de teste de UMA frase: dado fora do formato que escape daqui marca só esta frase
function finishFrase(f: FraseState) {
  try {
    buildHoldings(f);
    void trialPlan(f);
  } catch (e) {
    failFrase(f, e);
  }
}

const tokensOf = (f: FraseState) => f.scans.flatMap((s) => s.tokens.filter((t) => t.kind === 'fungible' || t.kind === 'nft'));
const noPrices = (): PriceResult => ({ prices: new Map(), info: new Map(), solUsd: null, errors: [], unresolved: new Set() });
// API de preços (só na mainnet) completada pela rede: a curva da Pump.fun diz quem é memecoin dela e o preço em SOL
async function pricesFor(tokens: Array<{ mint: string; decimals: number }>, rpc: RpcClient): Promise<PriceResult> {
  const mints = tokens.map((t) => t.mint);
  const r = S.cluster === 'mainnet' ? await fetchPrices(mints, external.pricesFetch, external.pricesSleep) : noPrices();
  const failed = new Set<string>();
  applyCurves(r, await readCurves(rpc, mints, { sleep: external.readSleep, failed }), tokens);
  // curva ou pool que a rede não respondeu, sem preço por outro caminho: "consulta falhou" (aviso com a contagem),
  // nunca "sem valor" calado
  for (const m of failed) if (!r.prices.has(m)) r.unresolved.add(m);
  return r;
}

function mergePrices(r: PriceResult) {
  if (!S.prices) {
    S.prices = r;
    return;
  }
  for (const [k, v] of r.prices) S.prices.prices.set(k, v);
  for (const [k, v] of r.info) S.prices.info.set(k, v);
  S.prices.errors = [...new Set([...S.prices.errors, ...r.errors])]; // refazer a mesma frase não repete o aviso
  // a consulta desta frase decide os mints dela: quem falhou entra, quem passou agora sai
  for (const m of r.unresolved) S.prices.unresolved.add(m);
  for (const m of r.info.keys()) if (!r.unresolved.has(m)) S.prices.unresolved.delete(m);
  S.prices.solUsd = r.solUsd ?? S.prices.solUsd;
}

// tokens da frase (depois dos preços); na Phantom, a Conta 1 sai das leituras e fica só na revisão
function buildHoldings(f: FraseState) {
  const prices = S.prices!;
  // a revisão só nasce na 1ª vez: depois dela a principal já saiu das leituras (reler não pode recalcular sem ela)
  if (needsReview(f.app) && !f.review) {
    f.review = reviewPhantomAccounts(f.discovery!.wallets, f.scans, prices.prices, prices.info, { mainIndex: mainIndexOf(f.app), label: (i) => walletLabel(f.app, i) });
    f.scans = f.scans.filter((s) => !isMainAccount(f.app, s.index));
  }
  f.holdings = [];
  for (const s of f.scans) {
    for (const t of s.tokens) {
      if ((t.kind !== 'fungible' && t.kind !== 'nft') || t.blockers.length) continue;
      const info = prices.info.get(t.mint);
      const { usd: usdValue, sol: solValue } = tokenValue(prices.prices, t);
      const category = info?.category ?? 'desconhecido';
      const rec = recommend(t.kind, category, usdValue, solValue);
      f.holdings.push({
        id: S.nextHoldingId++,
        frase: f.n,
        walletIndex: s.index,
        walletLabel: walletLabel(f.app, s.index),
        wallet: s.address,
        account: t.account,
        mint: t.mint,
        kind: t.kind,
        amount: t.amount,
        decimals: t.decimals,
        symbol: info?.symbol ?? null,
        name: info?.name ?? null,
        category,
        impostor: looksLikeImpostor(t.mint, info?.symbol ?? null),
        usdValue,
        solValue,
        recommendation: rec.decision,
        whyCode: rec.code,
        why: rec.why,
        burnNeedsConfirmation: burnNeedsExtraConfirmation(category, usdValue, solValue),
        priceLookupFailed: priceLookupFailed(prices, t.mint),
        inBurnAll: inBurnAll(rec.code),
        rentLamports: t.rentLamports,
      });
    }
  }
}

// ---------- RPC da rodada: rótulo, cliente, pausa ----------

// o que a página mostra do RPC: só o host (describeRpc). A URL pode levar a chave de API e nunca sai daqui.
const rpcLabel = (url: string, isPublic: boolean) => describeRpc(url) + (isPublic ? ' (público, mais lento)' : '');
// RPC próprio (proxy do Clurn ou Helius): 8 req/s no total e, por método, só os padrões do createRpc (o proxy deixa
// 15/s por IP, proxy/wrangler.toml). RPC público da Solana:
// PUBLIC_RPC_LIMITS, 8/s no total e 3,5/s de cada método (o limite oficial é 40 por 10 s por método, por IP).
// O RPC próprio passa pelo medidor de créditos da sessão em que foi criado, com a etapa da hora da consulta.
const rpcClient = (url: string, isPublic: boolean, onRetry: RpcOptions['onRetry']): RpcClient => {
  if (isPublic) return rpcFactory({ url, ...PUBLIC_RPC_LIMITS, onRetry });
  const round = S;
  round.ownLabel = describeRpc(url);
  const stage = () => round.busy ?? 'espera';
  const headers = rpcHeaders(url, embeddedRpcs, APP_VERSION); // só o proxy embutido recebe a versão do app
  const client = rpcFactory({
    url,
    requestsPerSecond: RUN_COSTS.rpsCustom,
    ...(headers ? { headers } : {}),
    onRetry: (info) => {
      round.usage.retry(stage());
      onRetry?.(info);
    },
  });
  // getProgramAccounts recusado pelo RPC próprio (o Helius recusa a busca da Pump.fun) vai pelo público da mesma rede,
  // com os limites do público e a trava de rede; o resto fica no próprio (gpa-fallback.ts). O público não gasta crédito.
  const publicGpa = () => networkGuarded(rpcFactory({ url: RPC[round.cluster], ...PUBLIC_RPC_LIMITS, onRetry }), round.cluster);
  return withGpaFallback(round.usage.wrap(client, stage), publicGpa);
};

const notPaused = 'O app não está pausado.';
const roundStopped = 'A rodada foi parada. Analise as frases de novo para uma nova limpeza.';

// depois de "Parar", o RPC da rodada recusa tudo (StopRequested): nada mais roda nela, só uma análise nova
function assertRoundAlive() {
  if (S.rpc?.stopped?.()) throw new BadRequest(roundStopped, 'stopped-by-user'); // `?.()`: testes põem um RpcClient cru em S.rpc
}
const roundIsStopped = () => S.rpc?.stopped?.() === true;

// "Parar aqui": a chamada pausada falha com StopRequested e a tarefa termina (análise: frases que faltam
// viram 'erro'; execução: relatório parcial). As frases ainda na fila são marcadas AGORA, com as seeds
// zeradas, sem esperar o laço da análise. As esperas de depósito param (o RPC parado só devolveria erro).
// A rodada parada nunca mais executa nada: as chaves de TODAS as frases somem já (nada assina depois do
// stop: a chamada pausada falha antes de montar qualquer transação).
function stopRound() {
  if (!S.pause || !S.rpc) throw new BadRequest(notPaused);
  S.rpc.stop();
  S.pause = null;
  for (const f of S.frases) {
    cancelFundingWait(f);
    if (f.status === 'fila') failFrase(f, new StopRequested());
  }
  wipeKeys();
  emit('pausa', { motivo: null, parado: true });
}

// A URL do RPC candidato (pode levar a chave) nunca entra na mensagem de recusa, mesmo que o provedor a ecoe
// no erro: some a URL inteira, host+caminho+query e a query sozinha.
export function hideRpcUrl(problems: string[], url: string): string[] {
  const secrets = new Set<string>([url]);
  try {
    const u = new URL(url);
    for (const s of [u.host + u.pathname + u.search, u.pathname + u.search, u.search, u.search.slice(1), u.host]) if (s.length >= 6) secrets.add(s);
  } catch {
    // URL inválida: só o texto inteiro
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return problems.map((p) => ordered.reduce((t, s) => t.split(s).join('[rpc]'), p));
}

// Trocar o RPC durante a pausa: cria o cliente novo, confere se ele serve para o app (checkRpc) e só então
// troca; a chamada que estava pausada repete no novo. Se não servir, 400 e a pausa continua. Enquanto é só
// candidato, as novas tentativas dele não viram aviso "rede lenta" na página (não é o RPC em uso).
let swapping = false;
export async function trocarRpc(choice: unknown) {
  if (!S.pause || !S.rpc) throw new BadRequest(notPaused);
  if (swapping) throw new BadRequest('Já estou conferindo um RPC novo. Espere.');
  const round = S;
  const url = choice === 'publico' ? RPC[S.cluster] : typeof choice === 'string' ? choice.trim() : '';
  if (!/^https:\/\//.test(url)) throw new BadRequest('O RPC precisa começar com https://');
  await swapRpcTo(round, url, () => round.pause !== null);
  emit('pausa', { motivo: null, rpc: round.rpcLabel });
}

// Troca o RPC da rodada: cliente novo, conferido (checkRpc com a trava de rede) e só então posto no lugar; as chamadas
// que esperavam repetem no novo, com as regras de sempre (passo já enviado fica 'desconhecido', nada é montado de novo).
// `wanted` é conferido depois da conferência: rodada encerrada, parada ou já trocada por outro caminho não troca.
async function swapRpcTo(round: Session, url: string, wanted: () => boolean): Promise<void> {
  if (swapping) throw new BadRequest('Já estou conferindo um RPC novo. Espere.');
  const isPublic = url === RPC[round.cluster];
  swapping = true;
  try {
    let live = false;
    const next = rpcClient(url, isPublic, (info) => {
      if (live) retryNotice.onRetry(info);
    });
    const check = await checkRpc(next, undefined, undefined, round.cluster);
    if (S !== round || !round.rpc || round.rpc.stopped() || !wanted()) throw new BadRequest(notPaused); // encerrou ou parou enquanto conferia
    if (!check.ok) throw new BadRequest(rpcProblemMessage(hideRpcUrl(check.problems, url)), 'rpc-blocked');
    round.rpc.replace(next);
    live = true;
    round.pause = null;
    round.rpcLabel = rpcLabel(url, isPublic);
    round.rpcUrl = url;
    round.customRpc = !isPublic;
    balanceCache = null; // o painel passa a mostrar o saldo da chave nova
  } finally {
    swapping = false;
  }
}

// O RPC da rodada morreu (créditos esgotados ou rede fora, depois das novas tentativas). Pedido do autor (31/10/2026):
// "o processo não pode parar, senão o usuário perde o progresso".
// - RPC próprio (o Helius embutido, a SOLANA_RPC_URL ou um escolhido): troca sozinho para o público, do mesmo ponto
//   (a chamada que estava no ar repete no público; seeds e escolhas continuam na memória), com aviso na tela.
// - Já no público (ou o público também não serviu): pausa, e o app tenta voltar sozinho a cada RPC_RETRY_MS, sem
//   exigir clique. "Parar aqui" continua valendo.
// - Com mais de uma chave (03/11/2026: Helius 1 e Helius 2 embutidos), antes do público vão as próximas da lista da
//   rodada, uma de cada vez: a que passa na conferência assume ({ auto: 'troca', proximo: true }). Chave que já
//   ficou para trás nesta rodada não volta (esgotada ou caída).
function onRoundPause(round: Session, r: PauseReason) {
  if (S !== round) return;
  if (round.customRpc && !swapping) {
    const helius = /helius/i.test(round.rpcLabel);
    const pub = RPC[round.cluster];
    const at = round.rpcUrls.indexOf(round.rpcUrl);
    const nextOwn = at < 0 ? [] : round.rpcUrls.slice(at + 1).filter((u) => u !== pub);
    const tryNext = (i: number): void => {
      if (i >= nextOwn.length) {
        swapRpcTo(round, pub, () => true).then(
          () => emit('pausa', { motivo: null, rpc: round.rpcLabel, auto: 'troca', helius }),
          () => realPause(round, r),
        );
        return;
      }
      swapRpcTo(round, nextOwn[i]!, () => true).then(
        () => emit('pausa', { motivo: null, rpc: round.rpcLabel, auto: 'troca', helius, proximo: true }),
        () => tryNext(i + 1), // rodada encerrada ou parada: o público recusa também e realPause não faz nada
      );
    };
    tryNext(0);
    return;
  }
  realPause(round, r);
}
function realPause(round: Session, r: PauseReason) {
  if (S !== round || !round.rpc || round.rpc.stopped()) return;
  round.pause = r;
  emit('pausa', { motivo: r });
  retryPublic(round);
}
// Novas tentativas da pausa: uma de cada vez, até voltar, parar, encerrar ou alguém trocar pelo botão.
function retryPublic(round: Session) {
  if (round.retrying) return;
  round.retrying = true;
  const tick = () => {
    if (S !== round || !round.rpc || round.rpc.stopped() || !round.pause) {
      round.retrying = false;
      return;
    }
    if (swapping) {
      setTimeout(tick, rpcRetryMs).unref?.();
      return;
    }
    swapRpcTo(round, RPC[round.cluster], () => round.pause !== null).then(
      () => {
        round.retrying = false;
        emit('pausa', { motivo: null, rpc: round.rpcLabel, auto: 'volta' });
      },
      () => setTimeout(tick, rpcRetryMs).unref?.(),
    );
  };
  setTimeout(tick, rpcRetryMs).unref?.();
}

// Confere os RPCs da rodada em ordem (com a trava de rede) e devolve o primeiro que serve. Conferido com o cliente
// comum, não o pausável: chave esgotada na checagem passa ao próximo em vez de pausar. Nenhum serve: recusa com os
// motivos de todos, cada um sem a própria URL (provedor que ecoa a URL na recusa levaria a chave à página).
async function firstWorkingRpc(cfg: RoundConfig): Promise<{ url: string; client: RpcClient }> {
  const problems: string[] = [];
  for (const url of cfg.rpcUrls) {
    const isPublic = url === RPC[cfg.cluster];
    const client = rpcClient(url, isPublic, retryNotice.onRetry);
    const check = await checkRpc(client, undefined, undefined, cfg.cluster);
    if (check.ok) return { url, client };
    const who = cfg.rpcUrls.length > 1 ? `${rpcLabel(url, isPublic)}: ` : '';
    problems.push(...hideRpcUrl(check.problems, url).map((p) => who + p));
  }
  throw new BadRequest(rpcProblemMessage(problems), 'rpc-blocked');
}

// chamada só pela rota, que já conferiu se há tarefa em andamento e converteu as frases em seeds
async function analisar(inputs: FraseInput[], cfg: RoundConfig) {
  const frases = inputs.map((i) => newFrase(i.n, i.app, i.seed, i.error, i.keys));
  let sess: Session | null = null;
  try {
    resetSession();
    S.busy = 'analise'; // já marcado: estado zerado não pode parecer "ocioso" no meio da análise
    S.cluster = cfg.cluster;
    S.search = { max: cfg.max, gap: cfg.gap };
    S.frases = frases;
    sess = S;
    const round = S;
    const firstIsPublic = cfg.rpcUrls[0] === RPC[cfg.cluster];
    const tracker = makeTracker(frases, !firstIsPublic);
    tracker.report('rpc', null, 0, 0);
    const chosen = await firstWorkingRpc(cfg);
    if (S !== round) return; // "Encerrar" enquanto conferia
    const isPublic = chosen.url === RPC[cfg.cluster];
    S.rpcLabel = rpcLabel(chosen.url, isPublic);
    S.rpcUrl = chosen.url;
    S.rpcUrls = cfg.rpcUrls;
    S.customRpc = !isPublic;
    // um cliente para todas as frases; se o RPC morrer de vez, as chamadas esperam a pessoa trocar o RPC
    // (/api/trocar-rpc) ou parar (/api/parar). Pausa e retomada vão para a página pelo evento 'pausa'.
    const rpc = createPausableRpc(chosen.client, (r) => onRoundPause(round, r));
    S.rpc = rpc;
    S.busy = 'analise';
    for (const f of frases) if (f.seed) deriveIdentity(f);
    S.rentExemptZero = await rpc.call<number>('getMinimumBalanceForRentExemption', [0]);
    S.roundReady = true;
    // frases em sequência (todas dividem o mesmo limite do RPC). `frases` é a própria S.frases: a irmã de uma
    // frase 'ambas' entra logo depois dela e passa por este laço também (sem seed: só a checagem do "Parar").
    // Os cartões de chaves vão depois de todas as frases: a carteira que já é de uma frase sai do cartão de chaves,
    // e isso só se sabe com todas as buscas feitas.
    for (const keysPass of [false, true]) {
      for (const f of frases) {
        if (S !== round) return; // "Encerrar" no meio: a sessão já foi apagada, nada continua
        if ((f.app === 'chaves') !== keysPass) continue;
        if (hasSecret(f) && !rpc.stopped()) await analyseFrase(f, rpc, tracker);
        // "Parar" durante a pausa: a leitura engole erro por carteira (a frase sairia 'pronta' pela metade),
        // então a frase que estava no ar vira 'erro' (sem chaves nem leituras), e as que não começaram também
        // (seeds e chaves zeradas). As que já terminaram ficam prontas.
        if (rpc.stopped() && f.status !== 'erro') failFrase(f, new StopRequested());
      }
    }
    if (S !== round) return;

    tracker.report('outras-redes', null, 0, 0);
    await Promise.all(frases.map(readFraseEvm)); // frases ao mesmo tempo: cada uma é um lote por rede
    tracker.report('precos', null, 0, 0);
    const ready = frases.filter((f) => f.status === 'pronta');
    S.prices = await pricesFor(ready.flatMap(tokensOf), rpc); // uma vez, com os tokens de todas as frases
    for (const f of ready) finishFrase(f);
    syncSingleDeposit(); // um depósito só para todas as frases sem SOL para as taxas
  } catch (e) {
    // a rodada caiu (RPC recusado, aluguel não lido…): frase que não terminou fica 'erro' com o motivo, nunca "na fila"
    if (S === sess) for (const f of frases) if (f.status === 'fila' || f.status === 'busca' || f.status === 'leitura') failFrase(f, e);
    throw e;
  } finally {
    for (const f of frases) wipeSeed(f); // qualquer saída (erro, RPC recusado) apaga as seeds e as chaves que sobraram
    S.progress = null;
  }
}

// "Ler de novo" (pedido do autor, 31/10/2026: "nada passa"): só as carteiras que ficaram incompletas depois de
// todas as tentativas da análise, nas frases prontas, com o mesmo RPC e sem pedir a frase (só endereços). Os planos
// caem (uma leitura nova muda o que vai ser feito); as moedas novas ganham preço; o aviso de depósito é refeito.
export async function relerIncompletas() {
  const rpc = S.rpc!;
  const tracker = makeTracker([], S.customRpc);
  const touched: FraseState[] = [];
  for (const f of S.frases) {
    if (f.status !== 'pronta' || !f.scans.some((s) => unreadParts(s).length)) continue;
    touched.push(f);
    f.scans = await rereadIncomplete(rpc, f.scans, cleanupScanOptions(S.rentExemptZero), {
      sleep: external.readSleep,
      onReread: (pending, round) => tracker.report('releitura', f, round, pending),
    });
    f.analysisLamports = new Map(f.scans.map((s) => [s.index, s.lamports]));
  }
  if (!touched.length) return;
  S.simResults = [];
  for (const g of S.frases) {
    g.plan = null;
    g.planNotice = null;
  }
  tracker.report('precos', null, 0, 0);
  mergePrices(await pricesFor(touched.flatMap(tokensOf), rpc));
  for (const f of touched) finishFrase(f);
  syncSingleDeposit();
  S.progress = null;
}

// SOL abaixo disso não paga o próprio envio: não é sobra limpável (fica como poeira)
export const LEFTOVER_MIN_LAMPORTS = 2 * BASE_FEE_LAMPORTS;

// O que sobrou de limpável depois do envio: SOL que paga o próprio envio, contas de token que dá para fechar,
// creator fees que o app coleta, e carteiras que não deu para ler por inteiro. Moedas com saldo e NFTs ficam
// fora: são escolha da pessoa ("Manter" não é sobra).
export function leftoverOf(scans: WalletScan[]) {
  let lamports = 0n;
  let closable = 0;
  let creatorFees = 0n;
  let unread = 0;
  let wallets = 0;
  for (const s of scans) {
    const sol = s.lamports >= LEFTOVER_MIN_LAMPORTS ? BigInt(s.lamports) : 0n;
    const cl = s.tokens.filter((t) => (t.kind === 'empty' || t.kind === 'wsol') && !t.blockers.length).length;
    const fee = s.fees ? totalCreatorFeeLamports(s.fees) : 0n;
    const bad = unreadParts(s).length > 0;
    lamports += sol;
    closable += cl;
    creatorFees += fee;
    if (bad) unread++;
    if (sol > 0n || cl > 0 || fee > 0n || bad) wallets++;
  }
  return { lamports, closable, creatorFees, unread, wallets, clean: wallets === 0 };
}

// carteiras de uma frase que o app limpa (na Phantom e na Trust, a principal nunca)
const cleanableWallets = (f: FraseState) => f.discovery!.wallets.filter((w) => !isMainAccount(f.app, w.index));

// Conferência depois do envio (pedido do autor, 31/10/2026: a 2ª passada dos amigos vira parte do app): lê de novo
// todas as carteiras das frases da rodada, com as mesmas releituras da análise. Só leitura: guarda à parte.
export async function conferirSobras() {
  const rpc = S.rpc!;
  const tracker = makeTracker([], S.customRpc);
  for (const f of S.frases) {
    if (f.status !== 'pronta' || !f.discovery) continue;
    const wallets = cleanableWallets(f);
    f.afterScans = await scanWallets(rpc, wallets, cleanupScanOptions(S.rentExemptZero), (d, total, w) => tracker.report('conferencia', f, d, total, walletLabel(f.app, w.index)), {
      sleep: external.readSleep,
      onReread: (pending, round) => tracker.report('releitura', f, round, pending),
    });
  }
  S.progress = null;
}

// "Limpar o que sobrou": a leitura da conferência vira a análise de uma rodada nova, com as mesmas chaves (ainda na
// memória) e o mesmo destino. Nada da execução anterior vale para a nova (plano, simulação, empréstimos, juntar).
export async function limparSobras() {
  const rpc = S.rpc!;
  const touched = S.frases.filter((f) => f.afterScans);
  for (const f of S.frases) {
    cancelFundingWait(f);
    f.plan = null;
    f.planNotice = null;
    f.funding = null;
    f.gathering = null;
  }
  Object.assign(S, { simResults: [], execResults: [], executed: false, aborted: null, abortedError: null, abortedFrase: null, reportFile: null, fundings: [], gatherings: [], forwards: [], single: null });
  for (const f of touched) {
    f.scans = f.afterScans!;
    f.afterScans = null;
    f.analysisLamports = new Map(f.scans.map((s) => [s.index, s.lamports]));
  }
  mergePrices(await pricesFor(touched.flatMap(tokensOf), rpc));
  for (const f of touched) finishFrase(f);
  syncSingleDeposit();
}

function assertCanReread() {
  if (S.busy) throw busyRefusal();
  assertRoundAlive();
  if (S.simResults.length || S.execResults.length || S.executed) throw new BadRequest('Depois de simular, ler de novo vai numa nova rodada.');
  if (!S.rpc || !S.roundReady) throw new BadRequest('Analise as frases primeiro.');
}

// "corrigir e analisar só esta": refaz a frase n com o mesmo RPC; as outras ficam como estão
async function reanalisarFrase(n: number, input: FraseInput) {
  const old = S.frases.find((g) => g.n === n)!;
  cancelFundingWait(old);
  old.signers.clear();
  wipeSeed(old);
  // as irmãs da frase antiga ('ambas') saem juntas: a busca nova decide de novo
  for (const oldPair of siblingsOf(old)) {
    cancelFundingWait(oldPair);
    oldPair.signers.clear();
    S.frases.splice(S.frases.indexOf(oldPair), 1);
  }
  const f = newFrase(n, input.app, input.seed, null, input.keys);
  S.frases[S.frases.indexOf(old)] = f;
  let pairs: FraseState[] = [];
  try {
    clearPlans(f);
    if (f.seed) deriveIdentity(f);
    const tracker = makeTracker([f], S.customRpc);
    pairs = await analyseFrase(f, S.rpc!, tracker);
    // frase refeita: carteira dela que estava num cartão de chaves sai de lá (entra pela frase)
    const keyCards = f.app === 'chaves' ? [] : S.frases.filter((k) => k.app === 'chaves' && k.status === 'pronta' && dropKeysOverlap(k));
    const both = [f, ...pairs, ...keyCards];
    // "Parar" durante a pausa: a leitura engole erro por carteira, então a frase vira 'erro' (sem chaves), como no laço da análise
    for (const g of both) if (roundIsStopped() && g.status !== 'erro') failFrase(g, new StopRequested());
    tracker.report('outras-redes', f, 0, 0);
    await readFraseEvm(f);
    const ready = both.filter((g) => g.status === 'pronta');
    if (!ready.length) return;
    tracker.report('precos', f, 0, 0);
    mergePrices(await pricesFor(ready.flatMap(tokensOf), S.rpc!)); // só os tokens desta frase (e da irmã)
    for (const g of ready) finishFrase(g);
    syncSingleDeposit();
  } catch (e) {
    for (const g of [f, ...pairs]) if (g.status !== 'pronta' && g.status !== 'erro') failFrase(g, e);
    throw e;
  } finally {
    wipeSeed(f);
    S.progress = null;
  }
}

// Corrigir uma frase muda a rodada: os planos de todas caem (uma confirmação vale para o conjunto inteiro).
// Uma espera de depósito do /api/plano montaria depois um plano apagado: volta a ser a espera da análise.
function clearPlans(except: FraseState) {
  S.simResults = [];
  for (const g of S.frases) {
    g.plan = null;
    g.planNotice = null;
    if (g !== except && g.status === 'pronta' && g.fundingAbort) {
      cancelFundingWait(g);
      finishTrial(g);
    }
  }
}

function finishTrial(g: FraseState) {
  try {
    void trialPlan(g);
  } catch (e) {
    failFrase(g, e);
  }
}

// plano de teste da análise: decide o aviso (falta SOL / nada para limpar) e, se falta SOL, arma a espera do depósito
// As escolhas que a Confirmar mostra antes de a pessoa mexer: a recomendação de cada moeda, com a mesma trava do
// /api/plano (queimar o que pede confirmação extra fica em "manter" até a pessoa confirmar)
export function recommendedDecisions(holdings: Holding[]): Map<string, TokenDecision> {
  return new Map(holdings.map((h) => [h.account, h.recommendation === 'burn' && (h.kind === 'nft' || h.burnNeedsConfirmation) ? 'keep' : h.recommendation]));
}

// Destino dos planos de teste (aviso de depósito, "nada a limpar", emprestadora): a principal da frase. Cartão de chaves
// não tem principal: um endereço fixo que não é de ninguém (nunca recebe nada; o destino de verdade vem do /api/plano).
export const TRIAL_DESTINATION = encodeBase58(Buffer.alloc(32, 0xc1));
const trialDestination = (f: FraseState): string => f.main ?? TRIAL_DESTINATION;

// Leituras do plano de teste: sem as carteiras que já vêm protegidas (cartão de chaves: as com alerta de carteira de
// uso, defaultProtected). Senão a pagadora do teste, o depósito pedido e a central do depósito único podiam cair numa
// carteira que o /api/plano tira (revisão independente de 08/11/2026). Phantom e Trust: nenhuma vem protegida (a
// principal já não está nas leituras); o que a pessoa protege na tela só chega no /api/plano, que monta de novo.
export function trialScans(f: Pick<FraseState, 'app' | 'review' | 'scans'>): WalletScan[] {
  const prot = new Set(defaultProtected(f).map((n) => n - 1));
  return prot.size ? f.scans.filter((s) => !prot.has(s.index)) : f.scans;
}

function trialPlan(f: FraseState): Promise<void> | undefined {
  f.feeWarning = null;
  f.nothingToClean = false;
  // Com as escolhas recomendadas (achado de um tester, 31/10/2026): sem elas, toda moeda contava como "manter", e
  // carteiras com 0 SOL e só memecoin para queimar viravam "Nada para limpar", sem nem pedir o depósito.
  const decisions = recommendedDecisions(f.holdings);
  const scans = trialScans(f); // todas protegidas: "Nenhuma burner", sem aviso nem "nada a limpar" (abaixo)
  try {
    buildPlan({ scans, prices: S.prices!.prices, destination: trialDestination(f), decisions, rentExemptZero: S.rentExemptZero, walletName: walletName(f.app), appName: appName(f.app) });
  } catch (e) {
    // "nada a limpar" só quando tudo foi lido E não há moeda à espera da decisão da pessoa: carteira com leitura
    // incompleta nunca vira "nada a recuperar", e moeda em "manter" pode virar "queimar" ou "enviar" na Confirmar.
    // Por frase, "nenhuma usada" também é "nada a limpar" (o cartão mostra a busca com 0 encontradas).
    // Carteira protegida por padrão tem algo (é o alerta): o cartão nunca vira "nada a limpar" por ela ficar de fora do
    // teste (a pessoa pode desmarcar a proteção na conferência).
    ({ feeWarning: f.feeWarning, nothingToClean: f.nothingToClean } = analysisNotice(e, !f.scans.some((s) => s.errors.length) && !f.holdings.length && scans.length === f.scans.length));
    if (e instanceof FeePayerError) {
      // espera o depósito (só leitura) e some com o aviso sozinha quando a reserva estiver coberta
      const ctx = { scans, decisions, destino: trialDestination(f), app: f.app, prices: S.prices!.prices, rentExemptZero: S.rentExemptZero };
      return startAnalysisWait(f, e, ctx);
    }
  }
  return undefined;
}

// "Analisar de novo" no aviso de falta de SOL da frase n: confere o saldo das mesmas burners, sem pedir a frase de novo
// (a primeira leitura da espera é imediata; se o SOL já chegou, sai o evento "fundos").
// Devolve a promessa da espera (a rota ignora; os testes aguardam).
export function recheckFunding(n: unknown): Promise<void> | undefined {
  if (S.busy) throw busyRefusal();
  assertRoundAlive();
  const f = S.frases.find((g) => g.n === Number(n));
  if (!f || !f.feeWarning || !f.scans.length || !S.prices) throw new BadRequest('Não há depósito para conferir. Analise as carteiras primeiro.');
  return fundingWaitActive(f) ? undefined : trialPlan(f);
}

// Aviso do resumo a partir do plano de teste: falta de SOL para as taxas é uma coisa
// (a pessoa precisa mandar SOL); burners já vazias é outra (não há nada a fazer).
export function analysisNotice(e: unknown, hasWallets: boolean): { feeWarning: string | null; nothingToClean: boolean } {
  if (e instanceof FeePayerError) return { feeWarning: e.message, nothingToClean: false };
  if (e instanceof PlanError) return { feeWarning: null, nothingToClean: hasWallets };
  throw e;
}

// ---------- espera pelo depósito de SOL das taxas (uma por frase, no cartão dela) ----------

export function cancelFundingWait(f: FraseState) {
  f.fundingAbort?.abort();
  f.fundingAbort = null;
  f.feeWait = null;
  f.feeNeed = null;
}

// começa uma espera nova da frase (cancela a anterior dela); devolve o controle
export function armFundingAbort(f: FraseState): AbortController {
  cancelFundingWait(f);
  f.fundingAbort = new AbortController();
  return f.fundingAbort;
}

export const fundingWaitActive = (f: FraseState) => f.fundingAbort !== null;

// a espera resolveu: só vale se ESTA espera ainda é a atual da frase e não foi cancelada; então roda o que monta o estado
export function completeFunding(f: FraseState, ctl: AbortController, onReady: () => void): boolean {
  if (ctl.signal.aborted || f.fundingAbort !== ctl) return false;
  f.fundingAbort = null;
  f.feeWait = null;
  onReady();
  return true;
}

type PlanContext = { scans: WalletScan[]; decisions: Map<string, TokenDecision>; destino: string; app: CardApp; prices: PriceResult['prices']; rentExemptZero: number; deposits?: () => Map<number, bigint> };

// Depósito do cliente por temporária = saldo agora − saldo na análise − o que chegou por juntar (SOL esquecido de
// outras temporárias da frase) − o que chegou por empréstimo de outra frase (SOL esquecido de lá). Nunca negativo.
// Só o depósito é isento da taxa do app; o juntado e o emprestado pagam 11% uma vez, na pagadora que recebe (a
// emprestadora não tem isenção: o saldo dela caiu).
export function depositsOf(f: Pick<FraseState, 'scans' | 'analysisLamports' | 'gathering' | 'funding'>): Map<number, bigint> {
  const inflow = new Map<number, bigint>();
  const add = (i: number, l: bigint) => inflow.set(i, (inflow.get(i) ?? 0n) + l);
  if (f.gathering) for (const r of f.gathering.results) if (r.status === 'enviado') add(f.gathering.toIndex, r.destinationDelta ?? 0n);
  if (f.funding?.result.status === 'enviado') add(f.funding.toIndex, f.funding.result.destinationDelta ?? f.funding.lamports);
  const out = new Map<number, bigint>();
  for (const s of f.scans) {
    const before = f.analysisLamports?.get(s.index);
    if (before === undefined || !Number.isFinite(s.lamports)) continue;
    const d = BigInt(Math.floor(s.lamports)) - BigInt(Math.floor(before)) - (inflow.get(s.index) ?? 0n);
    if (d > 0n) out.set(s.index, d);
  }
  return out;
}

// o plano de depois do depósito: SÓ as carteiras da lista recebida (já filtrada pelo /api/plano), nunca as leituras inteiras
export function planForWait(c: PlanContext): Plan {
  return buildPlan({ scans: c.scans, prices: c.prices, destination: c.destino, decisions: c.decisions, rentExemptZero: c.rentExemptZero, walletName: walletName(c.app), appName: appName(c.app), deposits: c.deposits?.() });
}

export class AllProtected extends Error {}

// Impressão da lista que a pessoa confere (Phantom, Trust, chaves): o app e, por carteira, o número, o endereço, se é a
// principal e se tem alerta (o que muda a proteção padrão). Só endereços públicos. A página manda a impressão da lista
// que conferiu; lista diferente no /api/plano = recusa (revisão independente de 08/11/2026: cartão refeito ou irmã com
// o mesmo número podia usar a proteção e a contagem da lista antiga).
export function reviewFingerprint(f: Pick<FraseState, 'app' | 'review'>): string | null {
  if (!f.review) return null;
  const list = f.review.accounts.map((a) => [a.index, a.address, a.isMain, a.warnings.length > 0]);
  return createHash('sha256').update(JSON.stringify([f.app, list])).digest('hex').slice(0, 32);
}

// Contas protegidas quando o pedido não diz nenhuma lista. Cartão de chaves (decisão do autor, 06/11/2026): o app não
// sabe qual é a principal, então a carteira com alerta de "parece carteira de uso" já vem protegida; a página manda a
// mesma lista marcada e a pessoa desmarca o que quiser limpar. Os outros cartões: nenhuma (a principal já fica fora).
export function defaultProtected(f: Pick<FraseState, 'app' | 'review'>): number[] {
  if (f.app !== 'chaves' || !f.review) return [];
  return f.review.accounts.filter((a) => !a.isMain && a.warnings.length > 0).map((a) => a.index + 1);
}

// Phantom, Trust e chaves: só as contas confirmadas (nunca a principal, nunca as protegidas); Solflare: todas
export function scansForPlan(app: CardApp, scans: WalletScan[], discovered: Array<{ index: number }>, protegidas: unknown, contasConfirmadas: unknown): WalletScan[] {
  if (!needsReview(app)) return scans;
  const sel = selectAccounts(discovered, protegidas, contasConfirmadas, mainIndexOf(app));
  if ('error' in sel) throw sel.allProtected ? new AllProtected() : new BadRequest(sel.error);
  return scans.filter((s) => sel.burners.has(s.index));
}

// polling só de saldo (nunca assina, nunca envia, nunca mexe em S.busy); `attempt` tenta montar o plano com os saldos novos
export type FundingDeps = { rpc?: RpcClient; emit?: (type: string, data: unknown) => void; sleep?: (ms: number) => Promise<void> };

// devolve a promessa da espera (a produção ignora; os testes aguardam)
export function startFundingWait(f: FraseState, first: FeePayerError, scans: WalletScan[], attempt: () => Plan, onReady: (plan: Plan) => void, deps: FundingDeps = {}): Promise<void> {
  // rodada parada: o RPC só devolveria erro e a espera giraria para sempre (o aviso de falta de SOL fica, sem espera)
  if (!deps.rpc && roundIsStopped()) return Promise.resolve();
  const ctl = armFundingAbort(f);
  f.feeWait = { code: first.code, params: first.params, waiting: true };
  f.feeNeed = first;
  const byIndex = new Map(scans.map((s) => [s.index, s]));
  let built: Plan | null = null;
  return waitForFunding({
    rpc: deps.rpc ?? S.rpc!,
    sleep: deps.sleep ?? external.fundingSleep,
    wallets: scans.map((s) => ({ index: s.index, address: s.address })),
    signal: ctl.signal,
    passes: (balances) => {
      if (ctl.signal.aborted) return false;
      for (const [i, l] of balances) {
        const s = byIndex.get(i);
        if (s) s.lamports = l;
      }
      // a central do depósito único só monta o plano dela depois de repassar às outras frases: senão contaria
      // como dela (e como depósito isento) o SOL que ainda vai sair
      if (holdsForForward(f)) return false;
      try {
        built = attempt();
        return true;
      } catch (err) {
        // o valor pedido pode mudar: atualiza e segue esperando; qualquer outro erro também só segue esperando
        if (err instanceof FeePayerError && f.fundingAbort === ctl) {
          f.feeWait = { code: err.code, params: err.params, waiting: true };
          f.feeNeed = err;
        }
        return false;
      }
    },
  })
    .then((b) => {
      if (b === null || !built) return;
      const plan = built;
      if (completeFunding(f, ctl, () => onReady(plan))) {
        if (!S.single) syncSingleDeposit(deps); // pedido único desfeito (juntar/empréstimo): refeito com quem ainda espera
        (deps.emit ?? emit)('fundos', view());
      }
    })
    .catch(() => { /* a espera nunca derruba o servidor */ });
}

// análise: só tira o aviso da frase quando a reserva estiver coberta (o plano de verdade vem do /api/plano)
export function startAnalysisWait(f: FraseState, e: FeePayerError, ctx: PlanContext, deps?: FundingDeps) {
  return startFundingWait(f, e, ctx.scans, () => planForWait(ctx), () => { f.feeWarning = null; }, deps);
}

// /api/plano: espera com a MESMA lista, decisões e destino já validados
export function startPlanWait(f: FraseState, e: FeePayerError, ctx: PlanContext, deps?: FundingDeps) {
  return startFundingWait(f, e, ctx.scans, () => planForWait(ctx), (plan) => setPlanReady(f, plan, ctx.destino), deps);
}

// ---------- empréstimo das taxas entre frases (src/core/limpeza/funding.ts) ----------

// quem pode emprestar: frases prontas da rodada que NÃO estão esperando depósito, com a pagadora e a reserva do
// plano real (depois do /api/plano) ou do plano de teste (só leitura). Frase que não monta plano não empresta.
function lenders(): Lender[] {
  const out: Lender[] = [];
  for (const g of S.frases) {
    if (g.status !== 'pronta' || !g.scans.length || g.feeWait || g.nothingToClean || !S.prices) continue;
    let plan = g.plan;
    // Phantom/Trust sem o plano de verdade: o de teste vê também as contas que a pessoa protegeu, e a pagadora dele
    // poderia ser uma delas. Só empresta depois do /api/plano (contas confirmadas).
    if (!plan && needsReview(g.app)) continue;
    if (!plan) {
      try {
        plan = buildPlan({ scans: g.scans, prices: S.prices.prices, destination: trialDestination(g), rentExemptZero: S.rentExemptZero, walletName: walletName(g.app), appName: appName(g.app) });
      } catch {
        continue;
      }
    }
    out.push({ frase: g.n, scans: g.scans, plan });
  }
  return out;
}

// a oferta de empréstimo para uma frase que espera o depósito (null se ninguém pode)
export function fundingOfferFor(f: FraseState): FundingOffer | null {
  if (!f.feeWait || !f.feeNeed || f.funding?.result.status === 'enviado') return null;
  return fundingOffer(f.n, f.feeNeed, lenders());
}

function offerView(f: FraseState) {
  const o = fundingOfferFor(f);
  if (!o) return null;
  const from = S.frases.find((g) => g.n === o.fromFrase);
  return { fromFrase: o.fromFrase, fromName: walletLabel(from?.app ?? 'solflare', o.fromIndex), from: o.from, toName: walletLabel(f.app, o.toIndex), to: o.to, lamports: o.lamports };
}

// POST /api/financiar { frase }: a emprestadora manda o SOL das taxas para a temporária da frase que espera.
// É um envio de verdade (a pessoa clicou no botão da oferta): simulado antes, valor exato conferido, com link no
// cartão. Depois a espera do depósito da frase vê o saldo e segue sozinha, como se a pessoa tivesse depositado.
export async function financiar(body: { frase?: unknown }): Promise<void> {
  if (S.busy) throw busyRefusal();
  if (S.executed) throw new BadRequest(alreadyExecuted);
  assertRoundAlive();
  const f = S.frases.find((g) => g.n === Number(body.frase));
  if (!f || !f.feeWait) throw new BadRequest('Esta frase não está esperando o depósito das taxas.');
  const offer = fundingOfferFor(f);
  if (!offer) throw new BadRequest('Nenhuma outra frase desta rodada tem SOL sobrando para emprestar. Faça o depósito pedido no cartão.');
  const from = S.frases.find((g) => g.n === offer.fromFrase)!;
  const round = S;
  S.busy = 'financiamento';
  try {
    const results = await execute({
      rpc: round.rpc!,
      slot: round.slot,
      plan: fundingPlan(offer),
      signers: from.signers,
      mode: 'execute',
      sleep: external.execSleep,
      confirmTimeoutMs: external.confirmTimeoutMs,
      label: (i) => walletLabel(from.app, i),
    });
    const result = results.at(-1);
    if (!result) throw new BadRequest('O empréstimo não foi montado.');
    f.funding = { fromFrase: offer.fromFrase, fromIndex: offer.fromIndex, from: offer.from, toIndex: offer.toIndex, to: offer.to, lamports: offer.lamports, result };
    if (result.status === 'enviado') dropSingle();
    round.fundings.push({ frase: f.n, ...f.funding });
    if (result.status !== 'enviado') throw new BadRequest(`O empréstimo não foi enviado: ${result.detail ?? result.status}.`, result.error?.code ?? 'unknown', result.error?.params);
  } catch (e) {
    if (e instanceof CodedError) throw new BadRequest(e.message, e.code, e.params); // ExecutionAborted, PlanError
    throw e;
  } finally {
    S.busy = null;
  }
}

// ---------- depósito único das taxas (pedido do autor, 31/10/2026) ----------
// "Reúna todas as wallets que precisam de depósito, e que seja necessário enviar só para uma": em vez de um
// depósito por frase, a pessoa manda UM valor para UMA temporária (a central: a pagadora sugerida da 1ª frase que
// espera). Quando o valor inteiro chega, o app repassa a cada outra frase o que ela pediria, da central para a
// pagadora sugerida dela (um passo de envio como o empréstimo: simulado, valor exato conferido). Mandar o SOL é a
// confirmação: o cartão diz isso antes. O repassado é depósito da pessoa: chega isento da taxa do app na frase
// que recebe (depositsOf não o desconta, ao contrário do empréstimo), e a central fica isenta só do que sobrou.

export type SingleForward = { toFrase: number; toIndex: number; to: string; lamports: bigint; result: StepResult | null };
export type SingleDeposit = {
  hubFrase: number;
  hubIndex: number;
  hub: string;
  startLamports: number; // saldo da central quando o pedido nasceu: o que chega acima disso é o depósito
  lamports: bigint; // quanto a pessoa manda (a central + cada repasse + a taxa de rede de cada repasse)
  received: bigint;
  forwards: SingleForward[];
  status: 'esperando' | 'repassando' | 'pronto' | 'falhou';
  key: string; // frases e valores que deram origem: o pedido só é refeito quando eles mudam
  abort: AbortController;
};

// A pessoa resolveu uma frase de outro jeito (juntar ou empréstimo): o pedido único que ainda espera cai, e é refeito
// com as frases que continuarem esperando quando a espera desta acabar (completeFunding). Repasse no meio nunca cai.
function dropSingle() {
  if (S.single?.status !== 'esperando') return;
  S.single.abort.abort();
  S.single = null;
}

// a central espera os repasses antes de montar o próprio plano
function holdsForForward(f: FraseState): boolean {
  const sd = S.single;
  return Boolean(sd && sd.hubFrase === f.n && sd.forwards.length && (sd.status === 'esperando' || sd.status === 'repassando'));
}

// O pedido único a partir das frases que esperam o depósito agora (null se nenhuma). A central é a pagadora sugerida
// da 1ª frase que espera; cada outra recebe o sendLamports dela, e cada repasse custa FUND_TX_FEE_LAMPORTS à central.
export function singleDepositFor(waiting: Array<{ n: number; need: FeePayerError }>): { hubFrase: number; hubIndex: number; hub: string; lamports: bigint; forwards: SingleForward[]; key: string } | null {
  const ws = [...waiting].sort((a, b) => a.n - b.n);
  if (!ws.length) return null;
  const [hub, ...rest] = ws;
  const forwards = rest.map((w) => ({ toFrase: w.n, toIndex: w.need.walletIndex, to: w.need.wallet, lamports: w.need.sendLamports, result: null }));
  const lamports = hub.need.sendLamports + forwards.reduce((a, fw) => a + fw.lamports + FUND_TX_FEE_LAMPORTS, 0n);
  return { hubFrase: hub.n, hubIndex: hub.need.walletIndex, hub: hub.need.wallet, lamports, forwards, key: ws.map((w) => `${w.n}:${w.need.wallet}:${w.need.sendLamports}`).join('|') };
}

// (Re)faz o pedido único depois de análise, plano, releitura ou frase refeita. Repasse no meio ou que falhou não muda
// (o "Tentar de novo" usa o SOL que já está na central); o mesmo pedido não recomeça (o depósito que já chegou
// continua contando); um pedido já concluído dá lugar ao novo, se alguma frase voltar a esperar.
export function syncSingleDeposit(deps: FundingDeps = {}): Promise<void> | undefined {
  const cur = S.single;
  if (cur && (cur.status === 'repassando' || cur.status === 'falhou')) return undefined;
  const waiting = S.frases.filter((f) => f.status === 'pronta' && f.feeWait && f.feeNeed).map((f) => ({ n: f.n, need: f.feeNeed! }));
  const next = singleDepositFor(waiting);
  if (!next) {
    cur?.abort.abort();
    S.single = null;
    return undefined;
  }
  if (cur && cur.status === 'esperando' && cur.key === next.key) return undefined;
  cur?.abort.abort();
  const hubF = S.frases.find((g) => g.n === next.hubFrase)!;
  // mesma central: o saldo de partida é o de antes (um depósito já feito nela não some do "chegou")
  const start = cur && cur.hub === next.hub ? cur.startLamports : (hubF.analysisLamports.get(next.hubIndex) ?? hubF.scans.find((s) => s.index === next.hubIndex)?.lamports ?? 0);
  const sd: SingleDeposit = { ...next, startLamports: start, received: 0n, status: 'esperando', abort: new AbortController() };
  S.single = sd;
  return watchSingle(sd, deps);
}

// espera o valor inteiro na central (só leitura) e então repassa
async function watchSingle(sd: SingleDeposit, deps: FundingDeps): Promise<void> {
  const got = await waitForFunding({
    rpc: deps.rpc ?? S.rpc!,
    sleep: deps.sleep ?? external.fundingSleep,
    wallets: [{ index: sd.hubIndex, address: sd.hub }],
    signal: sd.abort.signal,
    passes: (b) => {
      const l = BigInt(b.get(sd.hubIndex) ?? 0) - BigInt(sd.startLamports);
      const before = sd.received;
      sd.received = l > 0n ? l : 0n;
      if (sd.received !== before) (deps.emit ?? emit)('deposito', singleView());
      return sd.received >= sd.lamports;
    },
  }).catch(() => null);
  if (!got || S.single !== sd || sd.abort.signal.aborted) return;
  if (!sd.forwards.length) {
    sd.status = 'pronto';
    (deps.emit ?? emit)('deposito', singleView());
    return;
  }
  await forwardSingle(sd, deps);
}

// Repasses da central para as outras frases, um por um. Espera a vez se outra tarefa está no ar (nunca dois envios
// ao mesmo tempo). Frase que já não espera (resolveu de outro jeito) é pulada. Falha num repasse não para os outros:
// o cartão mostra qual falhou e "Tentar de novo" (/api/repassar) refaz só os que faltam.
async function forwardSingle(sd: SingleDeposit, deps: FundingDeps = {}): Promise<void> {
  const round = S;
  const sleep = deps.sleep ?? external.fundingSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  while (round.busy && !sd.abort.signal.aborted) await sleep(500);
  if (S !== round || S.single !== sd || sd.abort.signal.aborted) return;
  round.busy = 'repasse';
  sd.status = 'repassando';
  (deps.emit ?? emit)('deposito', singleView());
  try {
    const hubF = round.frases.find((g) => g.n === sd.hubFrase)!;
    for (const fw of sd.forwards) {
      if (fw.result?.status === 'enviado') continue;
      const g = round.frases.find((x) => x.n === fw.toFrase);
      if (!g || !g.feeWait) {
        fw.result = { step: { kind: 'fund', walletIndex: sd.hubIndex, wallet: sd.hub, to: fw.to, toFrase: fw.toFrase, lamports: fw.lamports }, description: 'repasse', status: 'nada a fazer', detail: 'a frase já tem SOL para as taxas' } as StepResult;
        continue;
      }
      try {
        const results = await execute({
          rpc: deps.rpc ?? round.rpc!,
          slot: round.slot,
          plan: fundingPlan({ fromFrase: sd.hubFrase, fromIndex: sd.hubIndex, from: sd.hub, toFrase: fw.toFrase, toIndex: fw.toIndex, to: fw.to, lamports: fw.lamports }),
          signers: hubF.signers,
          mode: 'execute',
          sleep: external.execSleep,
          confirmTimeoutMs: external.confirmTimeoutMs,
          label: (i) => walletLabel(hubF.app, i),
        });
        fw.result = results.at(-1) ?? null;
      } catch (e) {
        if (e instanceof StopRequested) throw e;
        fw.result = { step: { kind: 'fund', walletIndex: sd.hubIndex, wallet: sd.hub, to: fw.to, toFrase: fw.toFrase, lamports: fw.lamports }, description: 'repasse', status: 'falhou', detail: e instanceof Error ? e.message : 'erro', error: e instanceof CodedError ? { code: e.code, params: e.params } : undefined } as StepResult;
      }
      if (fw.result?.status === 'enviado') round.forwards.push({ frase: fw.toFrase, fromFrase: sd.hubFrase, from: sd.hub, to: fw.to, lamports: fw.lamports, result: fw.result });
    }
    sd.status = sd.forwards.every((fw) => fw.result && fw.result.status !== 'falhou' && fw.result.status !== 'cancelado') ? 'pronto' : 'falhou';
  } finally {
    round.busy = null;
    (deps.emit ?? emit)('deposito', singleView());
  }
}

// "Tentar de novo" no cartão: refaz só os repasses que não foram
export async function repassar(deps: FundingDeps = {}): Promise<void> {
  if (S.busy) throw busyRefusal();
  if (S.executed) throw new BadRequest(alreadyExecuted);
  assertRoundAlive();
  const sd = S.single;
  if (!sd || sd.status !== 'falhou') throw new BadRequest('Não há repasse para refazer.');
  await forwardSingle(sd, deps);
}

// o que a página mostra no cartão único (nomes no idioma da página; valores em lamports)
export function singleView() {
  const sd = S.single;
  if (!sd) return null;
  const appOf = (n: number) => S.frases.find((g) => g.n === n)?.app ?? 'solflare';
  return {
    hubFrase: sd.hubFrase,
    hubName: walletLabel(appOf(sd.hubFrase), sd.hubIndex),
    hub: sd.hub,
    lamports: sd.lamports,
    received: sd.received,
    status: sd.status,
    frases: [sd.hubFrase, ...sd.forwards.map((fw) => fw.toFrase)],
    forwards: sd.forwards.map((fw) => ({ toFrase: fw.toFrase, toName: walletLabel(appOf(fw.toFrase), fw.toIndex), to: fw.to, lamports: fw.lamports, ...(fw.result ? resultView(fw.result) : { status: null }) })),
  };
}

// ---------- juntar o SOL da própria frase na pagadora (src/core/limpeza/gather.ts) ----------

// a oferta de juntar para uma frase que espera o depósito (null se juntando tudo não chega na reserva)
export function gatherOfferFor(f: FraseState): GatherOffer | null {
  if (!GATHER_ENABLED) return null; // desligado (gather.ts)
  if (!f.feeWait || !f.feeNeed || !f.scans.length) return null;
  // só sem conferência (Solflare): na Phantom e na Trust as leituras da frase têm as contas que a pessoa protegeu,
  // e juntar tiraria SOL delas
  if (needsReview(f.app)) return null;
  return gatherOffer(f.scans, f.feeNeed, S.rentExemptZero, f.main ? [f.main] : []);
}

function gatherView(f: FraseState) {
  const o = gatherOfferFor(f);
  if (!o) return null;
  return { toIndex: o.toIndex, toName: walletLabel(f.app, o.toIndex), to: o.to, lamports: o.lamports, from: o.transfers.length, transfers: o.transfers.map((t) => ({ fromIndex: t.fromIndex, fromName: walletLabel(f.app, t.fromIndex), from: t.from, lamports: t.lamports, all: t.all })) };
}

function gatheringView(f: FraseState, g: Gathering) {
  const sent = g.results.filter((r) => r.status === 'enviado');
  return {
    toIndex: g.toIndex,
    toName: walletLabel(f.app, g.toIndex),
    to: g.to,
    lamports: g.lamports,
    sentLamports: sent.reduce((a, r) => a + (r.destinationDelta ?? 0n), 0n),
    sent: sent.length,
    total: g.results.length,
    status: sent.length === g.results.length ? 'enviado' : sent.length ? 'parcial' : 'falhou',
    results: g.results.map((r) => resultView(r)),
  };
}

// POST /api/juntar { frase }: as temporárias da frase mandam o SOL delas para a pagadora (cada uma paga a própria taxa).
// Envio de verdade (a pessoa clicou no botão da oferta): cada passo simulado antes, valor exato conferido, com link
// no cartão. Depois a espera do depósito da frase vê o saldo e segue sozinha, como se a pessoa tivesse depositado.
export async function juntar(body: { frase?: unknown }): Promise<void> {
  if (S.busy) throw busyRefusal();
  if (S.executed) throw new BadRequest(alreadyExecuted);
  assertRoundAlive();
  if (!GATHER_ENABLED) throw new BadRequest('Juntar o SOL desta frase ainda não está disponível nesta versão. Faça o depósito pedido no cartão.'); // desligado (gather.ts)
  const f = S.frases.find((g) => g.n === Number(body.frase));
  if (!f || !f.feeWait) throw new BadRequest('Esta frase não está esperando o depósito das taxas.');
  const offer = gatherOfferFor(f);
  if (!offer) throw new BadRequest('As temporárias desta frase, juntas, não têm SOL para as taxas. Faça o depósito pedido no cartão.');
  const round = S;
  S.busy = 'juncao';
  try {
    const results = await execute({
      rpc: round.rpc!,
      slot: round.slot,
      plan: gatherPlan(offer),
      signers: f.signers,
      mode: 'execute',
      sleep: external.execSleep,
      confirmTimeoutMs: external.confirmTimeoutMs,
      label: (i) => walletLabel(f.app, i),
    });
    f.gathering = { ...offer, results };
    if (results.some((r) => r.status === 'enviado')) dropSingle();
    round.gatherings.push({ frase: f.n, ...f.gathering });
    // as leituras da frase ganham os saldos novos já: a oferta seguinte (se ainda faltar) pede só o que falta, de
    // quem ainda tem; a espera do depósito lê de novo em seguida de qualquer jeito
    try {
      const fresh = await balancesOnly(round.rpc!, [{ index: offer.toIndex, address: offer.to }, ...offer.transfers.map((t) => ({ index: t.fromIndex, address: t.from }))]);
      for (const b of fresh) {
        if (b.errors.length) continue;
        const s = f.scans.find((x) => x.index === b.index && x.address === b.address);
        if (s) s.lamports = b.lamports;
      }
    } catch {
      // sem leitura agora: a espera do depósito atualiza na próxima volta
    }
    const failed = results.find((r) => r.status !== 'enviado');
    if (!results.some((r) => r.status === 'enviado')) throw new BadRequest(`Nada foi juntado: ${failed?.detail ?? failed?.status ?? 'nenhum passo'}.`, failed?.error?.code ?? 'unknown', failed?.error?.params);
  } catch (e) {
    if (e instanceof CodedError) throw new BadRequest(e.message, e.code, e.params); // ExecutionAborted, PlanError
    throw e;
  } finally {
    S.busy = null;
  }
}

// só para testes: a sessão do servidor
export const sessionForTest = () => S;
export const viewForTest = () => view();

// plano pronto de UMA frase depois do depósito (o /api/plano monta todas de uma vez em montarPlano).
// O conjunto mudou: simulação anterior não vale mais e o trecho do destino é sorteado de novo.
// `executed` não volta a false: uma execução por rodada (só uma nova análise zera).
function setPlanReady(f: FraseState, plan: Plan, destino: string) {
  f.plan = plan;
  resetRun();
  f.feeWarning = null; // plano pronto não pode mostrar o aviso de depósito
}

function resetRun() {
  S.simResults = [];
  S.execResults = [];
  S.aborted = null;
  S.abortedError = null;
  S.abortedFrase = null;
}

// Solflare "temporária N=3" / Phantom e Trust "Conta 4" / chaves "Chave 2", para as mensagens do plano
const walletName = (app: CardApp) => (i: number) => (app === 'solflare' ? `temporária N=${i}` : walletLabel(app, i));
const appName = (app: CardApp) => (app === 'phantom' ? 'Phantom' : app === 'trust' ? 'Trust' : app === 'chaves' ? 'qualquer uma' : 'Solflare');

// endereços que serão esvaziados nesta frase (temporárias encontradas e lidas); na Phantom e na Trust, a principal
// (Conta 1 / conta 0) pode ser destino (fica fora daqui). Frase que falhou na busca não tem lista (failFrase apaga as leituras, e
// a busca que caiu não deixa discovery): ela não entra nesta rodada, então não há temporária dela a proteger.
function burnerAddresses(f: FraseState): Set<string> {
  const out = new Set(f.scans.map((s) => s.address));
  for (const w of f.discovery?.wallets ?? []) if (!isMainAccount(f.app, w.index)) out.add(w.address);
  return out;
}

const alreadyExecuted = 'Este plano já foi executado. Analise de novo para uma nova limpeza.';

type PlanOutcome = { f: FraseState; ctx: PlanContext | null; plan: Plan | null; error: PlanError | null; notice: PlanNotice | null };

// Plano de TODAS as frases prontas, um destino. Primeiro só confere (nada muda se o pedido for recusado);
// depois monta: cada frase com o próprio plano, a sem SOL para a taxa espera o depósito no próprio cartão.
export async function montarPlano(body: { decisoes?: unknown; destino?: unknown; queimarConfirmado?: unknown; porFrase?: unknown }) {
  if (S.busy) throw busyRefusal();
  if (S.executed) throw new BadRequest(alreadyExecuted); // uma execução por rodada
  assertRoundAlive();
  // frase sem nada a limpar fica fora (a página nem pede a contagem da Phantom dela): mesma regra de `plannable` na página
  const ready = S.frases.filter((f) => f.status === 'pronta' && f.scans.length && !f.nothingToClean);
  if (!S.rpc || !ready.length) throw new BadRequest('Analise as carteiras primeiro.');
  const destino = typeof body.destino === 'string' ? body.destino.trim() : '';
  // colado uma vez (decisão do autor, 31/10/2026, no lugar das duas colagens): válido, e mais abaixo, carteira que
  // já existe na rede, que não é burner da rodada nem imita conta comum de uma frase
  if (!isAddress(destino)) throw new BadRequest('O endereço de destino não é um endereço Solana válido.');
  // temporária de QUALQUER frase da rodada não serve de destino
  if (S.frases.some((g) => burnerAddresses(g).has(destino))) throw new BadRequest('Esse endereço é uma das burners que serão esvaziadas. Escolha outra carteira.');

  const raw = (body.decisoes && typeof body.decisoes === 'object' ? body.decisoes : {}) as Record<string, unknown>;
  const confirmedBurns = new Set(Array.isArray(body.queimarConfirmado) ? body.queimarConfirmado.filter((x): x is string => typeof x === 'string') : []);
  const porFrase = (body.porFrase && typeof body.porFrase === 'object' ? body.porFrase : {}) as Record<string, unknown>;
  const outcomes: PlanOutcome[] = [];
  for (const f of ready) {
    const decisions = new Map<string, TokenDecision>();
    for (const h of f.holdings) {
      const d = raw[h.account];
      let decision: TokenDecision = d === 'transfer' || d === 'burn' || d === 'keep' ? d : 'keep';
      if (decision === 'burn' && (h.kind === 'nft' || (h.burnNeedsConfirmation && !confirmedBurns.has(h.account)))) decision = 'keep';
      decisions.set(h.account, decision);
    }
    // Phantom: só as contas que a pessoa confirmou NESTA frase (nunca a Conta 1, nunca as protegidas)
    const pf = (porFrase[String(f.n)] && typeof porFrase[String(f.n)] === 'object' ? porFrase[String(f.n)] : {}) as { protegidas?: unknown; contasConfirmadas?: unknown; conferida?: unknown };
    // a contagem e a proteção valem para a lista que a pessoa conferiu: se a página diz qual foi e não é a de agora, recusa
    if (needsReview(f.app) && pf.conferida !== undefined && pf.conferida !== reviewFingerprint(f)) {
      throw new BadRequest(`Frase ${f.n}: a lista de carteiras mudou depois da conferência. Confira de novo.`, 'review-changed', { frase: f.n });
    }
    let scans: WalletScan[];
    try {
      scans = scansForPlan(f.app, f.scans, f.discovery!.wallets, pf.protegidas ?? defaultProtected(f), pf.contasConfirmadas);
    } catch (e) {
      if (e instanceof AllProtected) {
        outcomes.push({ f, ctx: null, plan: null, error: null, notice: { code: 'phantom-all-protected', params: { frase: f.n } } });
        continue;
      }
      if (e instanceof BadRequest) throw new BadRequest(`Frase ${f.n}: ${e.message}`, e.code, { ...e.params, frase: f.n });
      throw e;
    }
    const ctx: PlanContext = { scans, decisions, destino, app: f.app, prices: S.prices!.prices, rentExemptZero: S.rentExemptZero, deposits: () => depositsOf(f) };
    outcomes.push({ f, ctx, plan: null, error: null, notice: null });
  }

  S.busy = 'plano';
  try {
    // contas comuns de TODAS as frases contam para reconhecer destino imitador
    await validateDestination(S.rpc!, destino, S.rentExemptZero, S.frases.flatMap((g) => g.known));
    // planos montados antes de mexer no estado: erro inesperado numa frase recusa o pedido inteiro, sem plano pela metade
    for (const o of outcomes) {
      if (!o.ctx) continue; // frase pulada (todas as contas protegidas)
      try {
        o.plan = planForWait(o.ctx);
      } catch (e) {
        if (!(e instanceof PlanError)) throw e; // FeePayerError é PlanError
        o.error = e;
      }
    }
    // a partir daqui o pedido vale: planos e esperas antigos caem (decisões e destino velhos não voltam depois)
    for (const g of S.frases) {
      g.plan = null;
      g.planNotice = null;
    }
    resetRun();
    for (const o of outcomes) {
      cancelFundingWait(o.f);
      o.f.planNotice = o.notice;
      if (o.plan) {
        o.f.plan = o.plan;
        o.f.feeWarning = null;
      } else if (o.error instanceof FeePayerError) {
        startPlanWait(o.f, o.error, o.ctx!); // sem SOL para as taxas: espera com a MESMA lista, decisões e destino
      }
    }
    syncSingleDeposit(); // um depósito só para todas as frases que esperam
    if (!outcomes.some((o) => o.plan)) {
      const first = outcomes.find((o) => o.error)?.error;
      if (!first) throw new BadRequest('Nenhuma frase para limpar: todas as contas das frases Phantom estão protegidas.');
      throw new BadRequest(first.message, first.code, first.params);
    }
  } catch (e) {
    if (e instanceof CodedError) throw new BadRequest(e.message, e.code, e.params); // ExecutionAborted do destino, PlanError
    throw e;
  } finally {
    S.busy = null;
  }
}

// a porcentagem mostrada nunca volta: o total pode crescer no meio (lote dividido conta por conta),
// então "feitos" é empurrado para manter a fração de antes. Chamada no INÍCIO de um passo: ainda há passo pela
// frente, então "feitos" fica no máximo em total - 1 (nunca "10 de 10" com um passo rodando)
export function monotonicProgress(prev: { feitos: number; total: number } | null, next: { feitos: number; total: number }): { feitos: number; total: number } {
  const total = Math.max(next.total, prev?.total ?? 0);
  let feitos = Math.max(next.feitos, prev?.feitos ?? 0);
  if (prev && prev.total > 0) feitos = Math.max(feitos, Math.ceil((prev.feitos * total) / prev.total));
  return { feitos: Math.max(0, Math.min(feitos, total - 1)), total };
}

// progresso + tempo restante da simulação/execução: passos de todas as frases da rodada
function makeRunTracker(fase: 'simulacao' | 'execucao', frases: FraseState[]) {
  const totals = new Map(frases.map((f) => [f.n, f.plan!.steps.length]));
  const done = new Map<number, number>();
  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const eta = createEta();
  // prévia da etapa (a mesma do botão de simular): carteiras distintas com passo no plano, para haver número desde o 1º passo
  const wallets = frases.reduce((k, f) => k + new Set(f.plan!.steps.map((s) => s.walletIndex)).size, 0);
  const prior = estimateRun({ frases: frases.length, wallets, customRpc: S.customRpc, stage: fase === 'simulacao' ? 'simulate' : 'execute' }).seconds * 1000;
  eta.start(sum(totals), frases.length ? prior : null);
  let shownAll: { feitos: number; total: number } | null = null;
  let shownFrase: { n: number; p: { feitos: number; total: number } } | null = null;
  return {
    step(f: FraseState, step: Step, index: number, total: number) {
      totals.set(f.n, total); // pode crescer (lote dividido)
      done.set(f.n, index);
      const real = { feitos: sum(done), total: sum(totals) };
      eta.setTotal(real.total);
      eta.tick(real.feitos);
      shownAll = monotonicProgress(shownAll, real);
      const pf = monotonicProgress(shownFrase?.n === f.n ? shownFrase.p : null, { feitos: index, total });
      shownFrase = { n: f.n, p: pf };
      S.progress = { fase, frase: f.n, carteira: walletLabel(f.app, step.walletIndex), feitos: pf.feitos, total: pf.total, etaMs: eta.remainingMs(), geral: shownAll };
      emit('progresso', S.progress);
    },
    finished(f: FraseState) {
      done.set(f.n, totals.get(f.n) ?? 0);
    },
  };
}

// Frase por frase, na ordem, cada uma com as chaves DELA. Parada (ExecutionAborted ou erro inesperado) numa frase
// para as seguintes. Simular cancela as esperas de depósito: frase sem plano fica fora da rodada.
// "Parar" na pausa: StopRequested sai do executor (não é RpcError, então o laço de envio não insiste); os
// resultados já recebidos ficam, nada é remontado nem reenviado, e o relatório parcial é gravado no finally.
// O prazo de 180 s de um envio sem confirmação continua correndo durante a pausa: uma pausa longa termina
// o passo no ar como 'desconhecido' (sem reenvio; a pessoa confere pelo link), e o próximo segue no RPC novo.
async function rodar(mode: 'simulate' | 'execute') {
  const round = S; // "Encerrar" durante a pausa troca a sessão: o que esta tarefa grava fica na dela
  const frases = planned();
  const destination = roundDestination();
  if (!frases.length || !destination || !round.rpc) throw new BadRequest('Monte o plano primeiro.');
  for (const f of round.frases) cancelFundingWait(f);
  // simular sem as que esperam: o pedido único que ainda não chegou cai (repasse no meio nunca, a tarefa espera a vez)
  if (round.single?.status === 'esperando') {
    round.single.abort.abort();
    round.single = null;
  }
  const list: FraseResult[] = [];
  if (mode === 'simulate') round.simResults = list;
  else round.execResults = list;
  round.aborted = null;
  round.abortedError = null;
  round.abortedFrase = null;
  const tracker = makeRunTracker(mode === 'simulate' ? 'simulacao' : 'execucao', frases);
  let current: FraseState | null = null;
  try {
    for (const f of frases) {
      current = f;
      await execute({
        rpc: round.rpc,
        slot: round.slot,
        plan: f.plan!,
        signers: f.signers,
        mode,
        sleep: external.execSleep,
        confirmTimeoutMs: external.confirmTimeoutMs,
        label: (i) => walletLabel(f.app, i),
        onStepStart: (step, index, total) => tracker.step(f, step, index, total),
        onResult: (r) => {
          const x: FraseResult = { ...r, frase: f.n };
          list.push(x);
          emit('passo', { modo: mode, ...resultView(x), arrived: mode === 'execute' ? sentSum((y) => y.destinationDelta) : null });
        },
      });
      tracker.finished(f);
    }
  } catch (e) {
    round.aborted = e instanceof ExecutionAborted || e instanceof StopRequested ? e.message : 'Erro inesperado durante a tarefa. Confira os links dos passos já enviados.';
    // erro que não é parada nem recusa: o stack vai para o stderr (terminal ou app de desktop), nunca para a página
    if (!(e instanceof ExecutionAborted || e instanceof StopRequested)) console.error(`[tarefa ${mode}] ${e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : 'erro sem detalhes'}`);
    round.abortedError = abortedErrorOf(e);
    round.abortedFrase = current?.n ?? null;
  } finally {
    round.progress = null;
    // relatório sempre gravado, mesmo se algo der errado no meio (achado da revisão): uma seção por frase
    if (mode === 'execute') {
      round.executed = true;
      round.reportFile = writeReport(`limpeza-${round.cluster}`, {
        destination,
        cluster: round.cluster,
        frases: frases.map((f) => ({ n: f.n, app: f.app, plan: f.plan, results: list.filter((r) => r.frase === f.n) })),
        fundings: round.fundings, // empréstimos das taxas entre frases (enviados antes do plano)
        forwards: round.forwards, // repasses do depósito único (o depósito da pessoa, da central para as outras frases)
        gatherings: round.gatherings, // SOL juntado dentro de cada frase (enviado antes do plano)
        aborted: round.aborted,
      });
    }
  }
}

// chaves e seeds pendentes de TODAS as frases
function wipeKeys() {
  for (const f of S.frases) {
    // os signatários guardam as chaves em objetos do Node; soltar as referências deixa o coletor apagá-las
    f.signers.clear();
    wipeSeed(f); // seed de frase ainda na fila: bytes zerados
  }
}

// esquece a rodada anterior inteira: esperas de depósito, chaves, seeds pendentes, RPC e tudo o que foi lido
// Grava no histórico deste computador o que a sessão gastou desde a última gravação (nada, se não gastou).
function recordUsage(round: Session, etapa: string) {
  const now = round.usage.snapshot();
  const d = usageDelta(now, round.recorded);
  // no proxy, o gasto é das chaves do Worker (ownLabel: o último RPC próprio, mesmo depois de cair para o público)
  if (d.credits <= 0 || embeddedRpcs.some((e) => e.proxy && describeRpc(e.url) === round.ownLabel)) return;
  round.recorded = now;
  appendHistory(credits.historyFile, { quando: new Date().toISOString(), etapa, creditos: d.credits, consultas: d.requests, rpc: round.ownLabel || round.rpcLabel });
}

function resetSession() {
  recordUsage(S, S.busy ?? 'espera');
  S.single?.abort.abort();
  for (const f of S.frases) cancelFundingWait(f);
  wipeKeys();
  S.rpc?.stop?.(); // chamada ainda na fila do RPC antigo para de vez (nada continua escrevendo na sessão nova)
  S = fresh();
}

// Janela fechada (ver shouldCloseIdle): chaves e seeds somem já e o RPC da rodada para; uma tarefa pausada
// termina sozinha (a chamada pausada falha com StopRequested e a execução grava o relatório parcial no finally),
// e o app só sai depois que ela terminou (teto de capMs), nunca no meio da gravação.
let closing = false;
export async function closeIdle(exit: () => void, capMs = 10_000, tickMs = 50): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    for (const f of S.frases) cancelFundingWait(f);
    wipeKeys();
    S.rpc?.stop?.();
    const deadline = Date.now() + capMs;
    while (S.busy !== null && Date.now() < deadline) await new Promise((r) => setTimeout(r, tickMs));
    resetSession();
    exit();
  } finally {
    closing = false;
  }
}

// estimativa antes de começar (entrada e botão de simular): tempo e créditos de uma etapa
const STAGES: Record<string, RunStage> = { analise: 'analysis', simulacao: 'simulate', execucao: 'execute', analysis: 'analysis', simulate: 'simulate', execute: 'execute' };
export function estimativa(body: Record<string, unknown>) {
  const frases = Number(body.frases);
  if (!Number.isInteger(frases) || frases < 1 || frases > MAX_FRASES) throw new BadRequest(`Número de frases inválido (1 a ${MAX_FRASES}).`);
  const stage = typeof body.etapa === 'string' && Object.hasOwn(STAGES, body.etapa) ? STAGES[body.etapa] : null;
  if (!stage) throw new BadRequest('Etapa inválida.');
  let wallets: number | undefined;
  if (body.carteiras !== undefined && body.carteiras !== null) {
    wallets = Number(body.carteiras);
    if (!Number.isInteger(wallets) || wallets < 0 || wallets > MAX_FRASES * SEARCH_MAX) throw new BadRequest('Número de carteiras inválido.');
  }
  // a página não tem mais campo de RPC: o servidor sabe se há RPC próprio (variável ou embutido) antes do público
  const customRpc = body.rpcProprio === true || hasCustomDefault(S.busy || S.roundReady ? S.cluster : 'mainnet', rpcSources());
  return estimateRun({ frases, wallets, customRpc, stage });
}

// Cartão de chaves refeito sozinho: as mesmas conferências da análise contra os outros cartões da rodada (a refeita
// não passa por eles no parseFrases). Chave da principal de uma frase → 'key-is-main'; chave que já está noutro
// cartão de chaves → 'key-duplicate'. A principal sai de `known` (índice 0 dos dois caminhos com principal).
function keysRedoRefusal(f: FraseState, keys: ParsedKey[]): BadRequest | null {
  const mains = new Map<string, number>();
  const others = new Map<string, number>();
  for (const g of S.frases) {
    if (g.n === f.n || g.pairOf === f.n) continue;
    for (const k of g.known) if (k.index === 0 && !mains.has(k.address)) mains.set(k.address, g.pairOf ?? g.n);
    for (const k of g.keyList ?? []) if (!others.has(k.address)) others.set(k.address, g.n);
  }
  for (const k of keys) {
    const main = mains.get(k.address);
    if (main !== undefined) return new BadRequest(`A chave da linha ${k.line} é da conta principal da frase ${main}.`, 'key-is-main', { line: k.line, of: main });
    const of = others.get(k.address);
    if (of !== undefined) return new BadRequest(`A chave da linha ${k.line} repete uma chave da frase ${of}.`, 'key-duplicate', { line: k.line, of });
  }
  return null;
}

// Frase refeita cuja principal está num cartão de chaves da rodada: o cartão de chaves vira 'erro' (sem chaves, sem
// leituras, fora do plano), com a linha e o número da frase. Nada da principal é limpo.
function failKeyCardsWithMain(n: number, mains: string[]) {
  for (const g of S.frases) {
    if (g.app !== 'chaves' || g.n === n || !g.keyList) continue;
    const hit = g.keyList.find((k) => mains.includes(k.address));
    if (hit) failFrase(g, new CodedError(`A chave da linha ${hit.line} é da conta principal da frase ${n}.`, 'key-is-main', { line: hit.line, of: n }));
  }
}

// "corrigir e analisar só esta": só sem tarefa, só antes de simular, e a frase precisa existir na rodada
function fraseToRedo(n: unknown): FraseState {
  if (S.busy) throw busyRefusal();
  assertRoundAlive();
  if (S.simResults.length || S.execResults.length || S.executed) throw new BadRequest('Depois de simular, uma frase corrigida vai numa nova rodada.');
  // sem RPC conferido e aluguel lido, a frase sairia "pronta" com dados errados (aluguel 0): analise de novo
  if (!S.roundReady) throw new BadRequest('A análise desta rodada não chegou a começar (RPC recusado ou falhou). Analise as frases de novo.');
  const f = S.frases.find((g) => g.n === Number(n));
  if (!S.rpc || !f) throw new BadRequest('Analise as frases primeiro.');
  // a irmã ('ambas') não tem frase própria: refazer é refazer a frase colada, que decide de novo
  return (f.pairOf !== null && S.frases.find((g) => g.n === f.pairOf)) || f;
}

// ---------- travas (achados da revisão independente) ----------

export function executeBlockedReason(s: { simulated: boolean; aborted: string | null; executed: boolean }): string | null {
  if (!s.simulated) return 'Simule antes de executar.';
  if (s.aborted) return 'A simulação parou por segurança. Não dá para executar este plano.';
  if (s.executed) return 'Este plano já foi executado. Analise de novo para uma nova limpeza.';
  return null;
}

// encerrar no meio da execução sairia com transação em andamento e sem relatório. Pausado (RPC morto, à
// espera de outro), nada está no ar: pode fechar, e as chaves morrem com o processo.
export function canShutdown(busy: string | null, paused = false): boolean {
  return paused || busy !== 'execucao';
}

// "Limpar outra frase": só com o app parado (trocar a sessão no meio de uma tarefa deixaria ela escrevendo na nova)
export function canStartOver(busy: string | null): boolean {
  return busy === null;
}

// janela fechada: nenhuma página conectada há IDLE_GRACE_MS (o F5 reconecta antes disso) e nada sendo executado.
// Sem isso, o app aberto pelo atalho ficaria escondido com as chaves na memória depois de fechar a janela.
export const IDLE_GRACE_MS = 20_000;
export function shouldCloseIdle(s: { everConnected: boolean; connected: number; idleMs: number; busy: string | null; paused?: boolean }): boolean {
  return s.everConnected && s.connected === 0 && s.idleMs >= IDLE_GRACE_MS && canShutdown(s.busy, s.paused ?? false);
}

// ---------- HTTP ----------

function tokenOk(given: string | null | undefined, token: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new BadRequest('Pedido grande demais.');
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new BadRequest('Pedido em formato inválido.');
  }
}

// Tarefas longas rodam em segundo plano; a página acompanha pelos eventos.
function background(name: string, fn: () => Promise<void>) {
  S.busy = name;
  retryNotice.reset();
  fn()
    .then(() => emit('pronto', { tarefa: name, estado: view() }))
    .catch((e) => {
      const msg = e instanceof BadRequest || e instanceof ExecutionAborted || e instanceof PlanError || e instanceof StopRequested ? e.message : `Falha na tarefa (${e instanceof Error ? e.name : 'erro'}). Tente de novo.`;
      emit('erro', { tarefa: name, mensagem: msg, ...codeOf(e) });
      // A página só recebe o nome do erro (o texto bruto pode ter qualquer coisa); o stack vai para o stderr
      // (terminal do `npm start`, ou o do app de desktop), que é onde se descobre a causa. Sem seed nem chave:
      // nenhuma mensagem do app carrega as duas, e a URL do RPC (com chave) nunca entra em mensagem de erro.
      console.error(`[tarefa ${name}] ${e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : 'erro sem detalhes'}`);
    })
    .finally(() => {
      recordUsage(S, name); // a análise troca de sessão no começo: grava a sessão que ficou
      S.busy = null;
    });
}

export function createServer(port = 0, token = TOKEN) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const addr = server.address();
      const expectedHost = typeof addr === 'object' && addr ? `127.0.0.1:${addr.port}` : '';
      if (req.headers.host !== expectedHost) return send(res, 403, { erro: 'Acesso recusado.' });
      if (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) return send(res, 403, { erro: 'Acesso recusado.' });

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          // a página não usa câmera, microfone, localização, pagamento nem USB (a área de transferência fica liberada: "Copiar")
          'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()',
          'cross-origin-opener-policy': 'same-origin',
        });
        return res.end(fs.readFileSync(UI_FILE));
      }

      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const name = url.pathname.slice('/assets/'.length);
        if (!Object.hasOwn(ASSETS, name)) return send(res, 404, { erro: 'Não encontrado.' });
        res.writeHead(200, { 'content-type': ASSETS[name], 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(fs.readFileSync(ASSET_FILE[name] ?? path.join(ASSET_DIR, name)));
      }

      if (req.method === 'GET' && url.pathname === '/api/eventos') {
        if (!tokenOk(url.searchParams.get('t'), token)) return send(res, 401, { erro: 'Código de acesso inválido.' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': ok\n\n');
        clients.add(res);
        link.everConnected = true;
        req.on('close', () => {
          clients.delete(res);
          link.lastDisconnect = Date.now();
        });
        return;
      }

      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado.' });
      if (!tokenOk(req.headers['x-token'] as string | undefined, token)) return send(res, 401, { erro: 'Código de acesso inválido.' });

      if (req.method === 'GET' && url.pathname === '/api/estado') return send(res, 200, view());
      if (req.method !== 'POST') return send(res, 405, { erro: 'Método não permitido.' });
      const body = await readJson(req);

      switch (url.pathname) {
        case '/api/analisar': {
          // o texto das frases sai do pedido antes de qualquer await; depois de parseFrases só sobram seeds (bytes)
          const raw = body.frases;
          body.frases = undefined;
          body.frase = undefined; // formato antigo (uma frase): nunca usado nem guardado
          try {
            if (S.busy) throw busyRefusal();
            const cfg = roundConfig(body); // antes de converter: recusa aqui não deixa seed para trás
            const inputs = parseFrasesOrRefuse(raw);
            if (!inputs.some((i) => i.seed || i.keys)) {
              const first = inputs[0]!;
              throw new BadRequest(`Nenhuma frase válida para analisar (frase ${first.n}).`, first.error!.code, { ...first.error!.params, frase: first.n });
            }
            background('analise', () => analisar(inputs, cfg));
          } finally {
            forgetTexts(raw);
          }
          return send(res, 202, { ok: true });
        }
        case '/api/conferir': {
          if (S.busy) throw busyRefusal();
          assertRoundAlive();
          if (!S.executed || !S.rpc) throw new BadRequest('A conferência é depois do envio.');
          background('conferencia', conferirSobras);
          return send(res, 202, { ok: true });
        }
        case '/api/sobras': {
          if (S.busy) throw busyRefusal();
          assertRoundAlive();
          if (!S.executed || !S.frases.some((f) => f.afterScans)) throw new BadRequest('Confira as carteiras depois do envio primeiro.');
          background('sobras', limparSobras);
          return send(res, 202, { ok: true });
        }
        case '/api/reler': {
          assertCanReread();
          background('reler', relerIncompletas);
          return send(res, 202, { ok: true });
        }
        case '/api/analisar-frase': {
          const raw = [{ texto: body.texto, carteira: body.carteira }];
          body.texto = undefined;
          try {
            const f = fraseToRedo(body.n);
            const [input] = parseFrasesOrRefuse(raw);
            if (input!.error) throw new BadRequest(`A frase ${f.n} não passou na conferência.`, input!.error.code, input!.error.params);
            if (input!.keys) {
              const refusal = keysRedoRefusal(f, input!.keys);
              if (refusal) {
                wipeParsedKeys(input!.keys);
                throw refusal;
              }
            } else {
              // repetida = mesma frase no mesmo app que outra da rodada (mesma principal, de qualquer caminho: a do
              // cartão da Trust é a conta 0); 'auto' lê todos os apps. As irmãs da própria frase saem na refeita, então não contam
              const mains = mainAddresses(input!.seed!);
              const sameApp = (g: FraseState) => g.auto || input!.app === 'auto' || g.app === input!.app;
              const dup = S.frases.find((g) => g.n !== f.n && g.pairOf !== f.n && g.main !== null && mains.includes(g.main) && sameApp(g));
              if (dup) {
                input!.seed!.fill(0);
                throw new BadRequest(`A frase ${f.n} repete a frase ${dup.n}.`, 'seed-duplicate', { of: dup.n });
              }
              // a principal da frase nova está num cartão de chaves: esse cartão sai da rodada com o erro na linha
              // (a principal nunca é limpa), e a frase segue
              failKeyCardsWithMain(f.n, mains);
            }
            background('analise', () => reanalisarFrase(f.n, input!));
          } finally {
            forgetTexts(raw);
          }
          return send(res, 202, { ok: true });
        }
        case '/api/estimativa':
          return send(res, 200, estimativa(body));
        case '/api/creditos':
          return send(res, 200, await creditos(body));
        case '/api/conferir-saldo':
          recheckFunding(body.n);
          return send(res, 200, view());
        case '/api/repassar':
          await repassar();
          return send(res, 200, view());
        case '/api/financiar':
          await financiar(body);
          return send(res, 200, view());
        case '/api/juntar':
          await juntar(body);
          return send(res, 200, view());
        case '/api/plano':
          await montarPlano(body);
          return send(res, 200, view());
        case '/api/simular':
          if (S.busy) throw busyRefusal();
          if (S.executed) throw new BadRequest(alreadyExecuted);
          assertRoundAlive();
          if (!planned().length || !roundDestination()) throw new BadRequest('Monte o plano primeiro.');
          background('simulacao', () => rodar('simulate'));
          return send(res, 202, { ok: true });
        case '/api/executar': {
          if (S.busy) throw busyRefusal();
          assertRoundAlive();
          const plans = planned();
          const destination = roundDestination();
          if (!plans.length || !destination) throw new BadRequest('Monte o plano primeiro.');
          // e TODA frase com plano precisa ter resultado de simulação (plano que entrou depois precisa simular de novo)
          const allSimulated = plans.every((f) => S.simResults.some((r) => r.frase === f.n));
          const blocked = executeBlockedReason({ simulated: S.simResults.length > 0 || S.aborted !== null, aborted: S.aborted, executed: S.executed }) ?? (allSimulated ? null : 'Simule antes de executar.');
          if (blocked) throw new BadRequest(blocked);
          // confirmação: destino colado 2× na entrada (conferido no plano) e botão segurado na página (31/10/2026)
          background('execucao', () => rodar('execute'));
          return send(res, 202, { ok: true });
        }
        // pausa por RPC (o RPC da rodada morreu): trocar de RPC e continuar dali, ou parar e ver o relatório parcial
        case '/api/trocar-rpc':
          await trocarRpc(body.rpc);
          return send(res, 200, view());
        case '/api/parar':
          stopRound();
          return send(res, 200, view());
        case '/api/nova-limpeza':
          if (!canStartOver(S.busy)) throw busyRefusal();
          resetSession();
          return send(res, 200, view());
        case '/api/atualizar': {
          const refusal = updateRefusal(S.busy, S.pause !== null);
          if (refusal) throw refusal;
          void installUpdate();
          return send(res, 202, { ok: true });
        }
        case '/api/encerrar':
          if (!canShutdown(S.busy, S.pause !== null)) throw new BadRequest('A execução está em andamento. Espere terminar antes de encerrar.');
          resetSession();
          send(res, 200, { ok: true });
          setTimeout(() => process.exit(0), 200);
          return;
        default:
          return send(res, 404, { erro: 'Não encontrado.' });
      }
    } catch (e) {
      if (e instanceof BadRequest) return send(res, 400, { erro: e.message, codigo: e.code, params: e.params });
      return send(res, 500, { erro: 'Falha interna. Tente de novo.' });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// Sem shell: o endereço vai como argumento, nunca interpretado como comando.
function openBrowser(url: string) {
  if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url], () => {});
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => {});
}

// Windows: janela própria do Edge, sem barra de endereço, com perfil separado:
// as extensões do navegador do dia a dia não enxergam a página onde a frase é colada
function openAppWindow(url: string): boolean {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local) return false;
  const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, local]
    .filter((d): d is string => Boolean(d))
    .map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    .find((p) => fs.existsSync(p));
  if (!edge) return false;
  const profile = path.join(local, 'Clurn', 'janela');
  execFile(edge, [`--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1280,880', '--no-first-run', '--no-default-browser-check'], () => {});
  return true;
}

// ---------- atualização pelo próprio app (src/app/atualizacao.ts, a partir da 1.0) ----------
// Só no app instalado: o desktop/main.ts passa --empacotado quando roda a cópia empacotada. No `npm start` e nos
// testes, nada é consultado. A consulta não leva nada do usuário; o estado vai para a página no view() e no
// evento 'atualizacao'.
export type UpdateView = { status: 'nada' | 'disponivel' | 'baixando' | 'instalando' | 'erro'; versao: string | null; progresso: number | null; erro: 'rede' | 'conferencia' | 'instalador' | null };
const update: UpdateView = { status: 'nada', versao: null, progresso: null, erro: null };
let updateManifest: Manifest | null = null;
// trocados nos testes (test/app/atualizacao-servidor.test.ts)
export const updateDeps = { check: checkUpdate, download: downloadInstaller, launch: launchInstaller, exit: (code: number) => process.exit(code) };
export const updateView = (): UpdateView => ({ ...update });
const setUpdate = (x: Partial<UpdateView>) => {
  Object.assign(update, x);
  emit('atualizacao', updateView());
};

export async function startUpdateCheck(version: string = APP_VERSION): Promise<void> {
  const r = await updateDeps.check(version);
  if (r.kind !== 'available') return; // sem versão nova, desligada ou erro: a tela não mostra nada
  updateManifest = r.manifest;
  setUpdate({ status: 'disponivel', versao: r.manifest.versao, progresso: null, erro: null });
}

// Botão "Atualizar": nunca no meio de uma tarefa (análise, execução, espera). Durante o download, S.busy fica
// 'atualizacao' e o resto do app espera.
async function installUpdate(): Promise<void> {
  const m = updateManifest!;
  S.busy = 'atualizacao';
  setUpdate({ status: 'baixando', progresso: 0, erro: null });
  let file: string;
  try {
    file = await updateDeps.download(m, { onProgress: (done, total) => {
      const p = Math.floor((done / total) * 100);
      if (p !== update.progresso) setUpdate({ progresso: p });
    } });
  } catch (e) {
    S.busy = null;
    setUpdate({ status: 'erro', progresso: null, erro: e instanceof UpdateFailed ? e.reason : 'rede' });
    return;
  }
  try {
    await updateDeps.launch(file);
  } catch {
    S.busy = null;
    setUpdate({ status: 'erro', progresso: null, erro: 'instalador' });
    return;
  }
  // o instalador abriu: apaga a sessão (seeds e chaves) e fecha; o instalador abre a versão nova
  setUpdate({ status: 'instalando', progresso: 100 });
  resetSession();
  setTimeout(() => updateDeps.exit(0), 300);
}

export function updateRefusal(busy: string | null, paused: boolean): BadRequest | null {
  if (!updateManifest || (update.status !== 'disponivel' && update.status !== 'erro')) return new BadRequest('Não há versão nova para instalar agora.');
  if (busy || paused) return new BadRequest('Espere a tarefa em andamento terminar antes de atualizar.');
  return null;
}

// testes: volta ao estado da abertura
export function resetUpdateForTest() {
  updateManifest = null;
  Object.assign(update, { status: 'nada', versao: null, progresso: null, erro: null });
}

if (import.meta.main) {
  const server = createServer(Number(process.env.PORT ?? 0));
  if (process.argv.includes('--empacotado')) void startUpdateCheck();
  server.on('listening', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const url = `http://127.0.0.1:${port}/#${TOKEN}`;
    console.log('Clurn aberto no seu navegador.');
    console.log(`Se não abriu sozinho, copie este endereço no navegador: ${url}`);
    console.log('Para fechar: botão "Encerrar" na página, fechar a página (encerra em 20 s), ou Ctrl + C aqui.');
    if (process.argv.includes('--sem-navegador')) return;
    if (!(process.argv.includes('--janela') && openAppWindow(url))) openBrowser(url);
  });
  setInterval(() => {
    if (shouldCloseIdle({ everConnected: link.everConnected, connected: clients.size, idleMs: Date.now() - link.lastDisconnect, busy: S.busy, paused: S.pause !== null })) {
      void closeIdle(() => process.exit(0)); // esperas canceladas, RPC parado, chaves e seeds apagadas; sai quando a tarefa pausada terminar
    }
  }, 5_000);
}
