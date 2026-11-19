// Tela da coleta da Meteora DBC (09/11/2026): descrição do passo nos dois idiomas, resumo de "Passos testados" sem
// valor, tela final contando a coleta, avisos do que fica de fora, e a linha das coletas sem dizer só "Pump.fun".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, fnSource } from './ui-source.ts';
import { resultView, stepView, walletsView } from '../../src/app/server.ts';
import type { Step } from '../../src/core/limpeza/plan.ts';
import type { StepResult } from '../../src/core/limpeza/executor.ts';

const block = (name: string) => {
  const start = HTML.indexOf(`// ${name}:inicio`);
  const end = HTML.indexOf(`// ${name}:fim`);
  assert.ok(start > 0 && end > start, `marcadores de ${name}`);
  return HTML.slice(start, end);
};
type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = new Function(`${block('i18n')}; return I18N;`)();
const tx = (lang: 'pt' | 'en', key: string, arg?: unknown) => {
  const v = I18N[lang][key];
  return typeof v === 'function' ? v(arg) : v;
};
const lamportsOf = (v: unknown) => (typeof v === 'bigint' ? v : BigInt((v as string | number | undefined) ?? 0));

const STEP: Step = {
  kind: 'claim-dbc',
  walletIndex: 3,
  wallet: 'W',
  estimateLamports: 2_500_000n,
  pools: [
    { pool: 'P1', config: 'C', baseMint: 'M1', baseVault: 'B1', quoteVault: 'Q1', baseTokenProgram: 'T', migrated: false, quoteFee: 2_000_000n },
    { pool: 'P2', config: 'C', baseMint: 'M2', baseVault: 'B2', quoteVault: 'Q2', baseTokenProgram: 'T', migrated: true, quoteFee: 500_000n },
  ],
};

test('dbc tela: passo descrito em português e inglês, com quantos pools; servidor manda a contagem, não os pools', () => {
  const v = stepView(STEP);
  assert.equal(v.kind, 'claim-dbc');
  assert.equal(v.pools, 2);
  assert.equal(v.estimateLamports, 2_500_000n);
  assert.doesNotMatch(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)), /P1|M1|Q1/, 'nenhum endereço de pool vai para a página');
  assert.equal(tx('pt', 'stepd.claim-dbc', { who: 'temporária N=3', sol: '0,0025', pools: 2 }), 'temporária N=3: coletar creator fees da Meteora em 2 pools (~0,0025 SOL) e enviar ao destino');
  assert.equal(tx('en', 'stepd.claim-dbc', { who: 'temporary N=3', sol: '0.0025', pools: 1 }), 'temporary N=3: collect Meteora creator fees in 1 pool (~0.0025 SOL) and send to destination');
  assert.match(fnSource('describeStep'), /pools: s\.pools/, 'a página passa a contagem para o texto');
  const r = resultView({ step: STEP, description: 'x', status: 'simulado', destinationDelta: 1n, appFeeDelta: 1n } as StepResult);
  assert.equal(r.step.pools, 2);
});

test('dbc tela: "Passos testados" conta a coleta no grupo das coletas, sem valor; a tela final mostra a coleta enviada', () => {
  const { stepsSummary } = new Function(`${block('preparo')}; return { stepsSummary };`)() as { stepsSummary: (items: unknown) => { frases: Array<{ groups: Array<{ key: string; tx: number; wallets: number }> }> } };
  const sim = (kind: string, w: number) => ({ frase: 1, status: 'simulado', walletIndex: w, destinationDelta: '123456789', step: { kind, walletIndex: w, estimateLamports: '987654321', pools: 2 } });
  const v = stepsSummary([sim('claim-dbc', 3), sim('claim-dbc', 3), sim('claim-curve', 4), sim('sweep-sol', 3)]);
  assert.deepEqual(v.frases[0].groups[0], { key: 'claims', tx: 3, wallets: 2, accounts: 0 });
  assert.doesNotMatch(JSON.stringify(v), /123456789|987654321/);
  const claimRows = new Function('lamportsOf', `${fnSource('claimRows')}; return claimRows;`)(lamportsOf);
  const rows = claimRows([
    { frase: 1, walletIndex: 3, status: 'enviado', step: { kind: 'claim-dbc' }, destinationDelta: '1780000', appFeeDelta: '220000', link: 'L' },
    { frase: 1, walletIndex: 4, status: 'enviado', step: { kind: 'claim-dbc' }, destinationDelta: '1814960', appFeeDelta: '224320', closedRentLamports: '2039280', link: 'L' },
    { frase: 1, walletIndex: 5, status: 'enviado', step: { kind: 'claim-dbc' }, skippedClaim: true, destinationDelta: '1', appFeeDelta: '0', link: 'L' },
    { frase: 1, walletIndex: 6, status: 'simulado', step: { kind: 'claim-dbc' }, destinationDelta: '1', appFeeDelta: '0', link: 'L' },
  ]);
  assert.deepEqual(rows, [
    { frase: 1, walletIndex: 3, lamports: 2_000_000n, link: 'L' },
    { frase: 1, walletIndex: 4, lamports: 0n, link: 'L' }, // só a ATA WSOL antiga: aluguel, não fee (o recibo põe em contas fechadas)
  ]);
});

test('dbc servidor: a carteira leva à página a contagem do que fica de fora e a falha de leitura, nunca os pools', () => {
  const fees = { bondingVault: 'V', bondingVaultLamports: 0, ammVaultAta: 'A', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null };
  const scans = [
    { index: 1, address: 'W1', lamports: 0, tokens: [], errors: [], fees: { ...fees, dbc: { pools: (STEP as Extract<Step, { kind: 'claim-dbc' }>).pools, found: 9, other: 2, cut: 4 }, dbcError: null } },
    { index: 2, address: 'W2', lamports: 0, tokens: [], errors: [], fees: { ...fees, dbc: { pools: [], found: 0, other: 0, cut: 0 }, dbcError: 'HTTP 429' } },
    { index: 3, address: 'W3', lamports: 0, tokens: [], errors: [], fees }, // leitura de antes desta regra
  ];
  const v = walletsView({ scans, app: 'solflare' } as Parameters<typeof walletsView>[0]);
  assert.deepEqual(v.map((w) => [w.dbcOther, w.dbcCut, w.dbcError]), [[2, 4, null], [0, 0, 'HTTP 429'], [0, 0, null]]);
  assert.equal(v[0].creatorFees, 2_500_000n, 'a fee da Meteora entra nas creator fees da carteira');
  assert.ok(v[1].unread.some((u: string) => /Meteora/.test(u)), 'leitura que falhou aparece como "não lida"');
  assert.doesNotMatch(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)), /"P1"|"M1"/);
});

test('dbc tela: avisos do que fica de fora (outra moeda, pools além do limite, leitura que falhou), nos dois idiomas', () => {
  type Node = { tag: string; kids: unknown[] };
  const el = (tag: string, _a: unknown, ...kids: unknown[]): Node => ({ tag, kids });
  const text = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? (n as Node).kids.map(text).join('') : '');
  const t = (key: string, v?: unknown) => `${key}(${String(v)})`;
  const feeNotices = new Function('el', 't', 'sol', 'lamportsOf', `${fnSource('feeNotices')}; return feeNotices;`)(el, t, String, lamportsOf);
  const w = (over: Record<string, unknown>) => ({ unswept: '0', sharedOther: 0, otherQuote: 0, ...over });
  const out = feeNotices({ frases: [{ wallets: [w({ dbcOther: 2 }), w({ dbcCut: 7, dbcError: 'HTTP 429' }), w({ dbcOther: 'x' })] }] }, {}).map(text);
  assert.deepEqual(out, ['warn.feeReadFailed(1)', 'warn.dbcOther(2)', 'warn.dbcCut(7)']);
  assert.deepEqual(feeNotices({ frases: [{ wallets: [w({})] }] }, {}), [], 'sem nada da Meteora, nenhum aviso');
  for (const lang of ['pt', 'en'] as const) {
    assert.match(tx(lang, 'warn.dbcOther', 1), lang === 'pt' ? /1 pool da Meteora/ : /1 Meteora pool/);
    assert.match(tx(lang, 'warn.dbcCut', 7), /7 .*300/);
    assert.match(tx(lang, 'warn.feeReadFailed', 2), /Meteora/);
    // a linha das coletas da Confirmar soma Pump.fun e Meteora: não diz só "Pump.fun"
    assert.doesNotMatch(tx(lang, 'conf.claims', 2), /Pump\.fun/);
    assert.match(tx(lang, 'conf.claims', 2), /Creator fees/);
  }
});
