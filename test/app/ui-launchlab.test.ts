// Tela da coleta do Raydium LaunchLab (09/11/2026): descrição do passo nos dois idiomas, resumo de "Passos testados" sem
// valor, tela final contando a coleta, avisos do que fica de fora (outra moeda, leitura que falhou) e a visão da carteira
// no servidor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, fnSource } from './ui-source.ts';
import { resultView, stepView, walletsView } from '../../src/app/server.ts';
import { describeStep, type Step } from '../../src/core/limpeza/plan.ts';
import type { StepResult } from '../../src/core/limpeza/executor.ts';
import { explainError } from '../../src/core/limpeza/errors.ts';

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

const STEP: Step = { kind: 'claim-launchlab', walletIndex: 3, wallet: 'W', estimateLamports: 2_500_000n };

test('launchlab tela: passo descrito em português e inglês; servidor manda o valor estimado, não o cofre', () => {
  const v = stepView(STEP);
  assert.equal(v.kind, 'claim-launchlab');
  assert.equal(v.estimateLamports, 2_500_000n, 'o estimado vai (a tela de envio e o relatório mostram)');
  assert.equal(tx('pt', 'stepd.claim-launchlab', { who: 'temporária N=3', sol: '0,0025' }), 'temporária N=3: coletar creator fees do LaunchLab (bonk.fun e outros) (~0,0025 SOL) e enviar ao destino');
  assert.equal(tx('en', 'stepd.claim-launchlab', { who: 'temporary N=3', sol: '0.0025' }), 'temporary N=3: collect LaunchLab (bonk.fun and others) creator fees (~0.0025 SOL) and send to destination');
  // o texto do terminal (describeStep do núcleo) diz o mesmo
  assert.equal(describeStep(STEP, (i) => `temporária N=${i}`), 'temporária N=3: coletar creator fees do LaunchLab (bonk.fun e outros) (~0.0025 SOL) e enviar ao destino');
  const r = resultView({ step: STEP, description: 'x', status: 'simulado', destinationDelta: 1n, appFeeDelta: 1n } as StepResult);
  assert.equal(r.step.kind, 'claim-launchlab');
});

test('launchlab tela: "Passos testados" conta a coleta no grupo das coletas, sem valor; a tela final mostra a coleta enviada', () => {
  const { stepsSummary } = new Function(`${block('preparo')}; return { stepsSummary };`)() as { stepsSummary: (items: unknown) => { frases: Array<{ groups: Array<{ key: string; tx: number; wallets: number }> }> } };
  const sim = (kind: string, w: number) => ({ frase: 1, status: 'simulado', walletIndex: w, destinationDelta: '123456789', step: { kind, walletIndex: w, estimateLamports: '987654321' } });
  const v = stepsSummary([sim('claim-launchlab', 3), sim('claim-launchlab', 5), sim('claim-curve', 4), sim('sweep-sol', 3)]);
  assert.deepEqual(v.frases[0].groups[0], { key: 'claims', tx: 3, wallets: 3, accounts: 0 });
  assert.doesNotMatch(JSON.stringify(v), /123456789|987654321/, 'nenhum valor antes do envio');
  const claimRows = new Function('lamportsOf', `${fnSource('claimRows')}; return claimRows;`)(lamportsOf);
  const rows = claimRows([
    { frase: 1, walletIndex: 3, status: 'enviado', step: { kind: 'claim-launchlab' }, destinationDelta: '1780000', appFeeDelta: '220000', link: 'L' },
    { frase: 1, walletIndex: 4, status: 'enviado', step: { kind: 'claim-launchlab' }, destinationDelta: '1814960', appFeeDelta: '224320', closedRentLamports: '2039280', link: 'L' },
    { frase: 1, walletIndex: 5, status: 'enviado', step: { kind: 'claim-launchlab' }, skippedClaim: true, destinationDelta: '1', appFeeDelta: '0', link: 'L' },
    { frase: 1, walletIndex: 6, status: 'falhou', step: { kind: 'claim-launchlab' }, destinationDelta: '1', appFeeDelta: '0', link: 'L' },
  ]);
  assert.deepEqual(rows, [
    { frase: 1, walletIndex: 3, lamports: 2_000_000n, link: 'L' },
    { frase: 1, walletIndex: 4, lamports: 0n, link: 'L' }, // só a ATA WSOL antiga: aluguel, não fee
  ]);
});

test('launchlab servidor: a carteira leva à página a contagem do que fica de fora e a falha de leitura, nunca o cofre', () => {
  const fees = { bondingVault: 'V', bondingVaultLamports: 0, ammVaultAta: 'A', ammVaultLamports: 0, curveSweeps: [], poolSweeps: [], unsweptCurveLamports: 0n, unsweptPoolLamports: 0n, coinsOnCurve: 0, pools: 0, detailed: true, unsweptError: null };
  const scans = [
    { index: 1, address: 'W1', lamports: 0, tokens: [], errors: [], fees: { ...fees, launchlab: { vault: 'COFRE1', lamports: 2_500_000n, other: 2 }, launchlabError: null } },
    { index: 2, address: 'W2', lamports: 0, tokens: [], errors: [], fees: { ...fees, launchlab: { vault: '', lamports: 0n, other: 0 }, launchlabError: 'HTTP 429' } },
    { index: 3, address: 'W3', lamports: 0, tokens: [], errors: [], fees }, // leitura de antes desta regra
  ];
  const v = walletsView({ scans, app: 'solflare' } as Parameters<typeof walletsView>[0]);
  assert.deepEqual(v.map((w) => [w.launchlabOther, w.launchlabError]), [[2, null], [0, 'HTTP 429'], [0, null]]);
  assert.equal(v[0].creatorFees, 2_500_000n, 'a fee do LaunchLab entra nas creator fees da carteira');
  assert.ok(v[1].unread.some((u: string) => /LaunchLab/.test(u)), 'leitura que falhou aparece como "não lida"');
  assert.doesNotMatch(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)), /COFRE1/);
});

test('launchlab tela: avisos do que fica de fora (outra moeda, leitura que falhou), nos dois idiomas; erro da coleta no catálogo', () => {
  type Node = { tag: string; kids: unknown[] };
  const el = (tag: string, _a: unknown, ...kids: unknown[]): Node => ({ tag, kids });
  const text = (n: unknown): string => (typeof n === 'string' ? n : n && typeof n === 'object' ? (n as Node).kids.map(text).join('') : '');
  const t = (key: string, v?: unknown) => `${key}(${String(v)})`;
  const feeNotices = new Function('el', 't', 'sol', 'lamportsOf', `${fnSource('feeNotices')}; return feeNotices;`)(el, t, String, lamportsOf);
  const w = (over: Record<string, unknown>) => ({ unswept: '0', sharedOther: 0, otherQuote: 0, ...over });
  const out = feeNotices({ frases: [{ wallets: [w({ launchlabOther: 2 }), w({ launchlabError: 'HTTP 429' }), w({ launchlabOther: 'x' })] }] }, {}).map(text);
  assert.deepEqual(out, ['warn.feeReadFailed(1)', 'warn.launchlabOther(2)']);
  assert.deepEqual(feeNotices({ frases: [{ wallets: [w({})] }] }, {}), [], 'sem nada do LaunchLab, nenhum aviso');
  for (const lang of ['pt', 'en'] as const) {
    assert.match(tx(lang, 'warn.launchlabOther', 1), lang === 'pt' ? /^1 cofre do LaunchLab/ : /^1 LaunchLab .* vault /);
    assert.match(tx(lang, 'warn.launchlabOther', 3), /USD1/);
    assert.match(tx(lang, 'warn.feeReadFailed', 2), /LaunchLab/);
    for (const part of ['what', 'app', 'you']) assert.match(tx(lang, `err.launchlab-claim-failed.${part}`), /LaunchLab/);
  }
  assert.equal(explainError('x', { stepKind: 'claim-launchlab' }).code, 'launchlab-claim-failed');
});
