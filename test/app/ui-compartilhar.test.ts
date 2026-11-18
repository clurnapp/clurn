// Compartilhar o resultado (tela final, 18/11/2026): a imagem e o post do X levam só o total que chegou e quantas
// carteiras; nada de endereço, frase, transação ou nome de carteira. O link do X é o único lugar novo para onde o app abre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, fnSource } from './ui-source.ts';
import { isExternalLink, SHARE_URL } from '../../desktop/regras.ts';

type Dict = Record<string, string | ((arg?: unknown) => string)>;
const I18N: { pt: Dict; en: Dict } = (() => {
  const start = HTML.indexOf('// i18n:inicio');
  const end = HTML.indexOf('// i18n:fim');
  return new Function(`${HTML.slice(start, end)}; return I18N;`)();
})();
const BLOCK = (() => {
  const start = HTML.indexOf('// compartilhar:inicio');
  const end = HTML.indexOf('// compartilhar:fim');
  assert.ok(start > 0 && end > start, 'marcadores do compartilhar');
  return HTML.slice(start, end);
})();
type S = { lamports: bigint; wallets: number; txs: number };
function load(lang: 'pt' | 'en') {
  const t = (k: string, a?: unknown) => { const v = I18N[lang][k] ?? I18N.pt[k]; return typeof v === 'function' ? v(a) : v; };
  const sol = new Function('LANG', `const LPS = 1000000000n; const loc = () => (LANG === 'pt' ? 'pt-BR' : 'en-US'); const dec = () => (LANG === 'pt' ? ',' : '.'); ${fnSource('sol')}; return sol;`)(lang);
  return new Function('t', 'sol', `${BLOCK}; return { shareStats, shareAmount, shareText, shareIntentUrl, SHARE_INTENT };`)(t, sol) as {
    shareStats: (items: unknown, received: unknown) => S;
    shareAmount: (l: bigint) => string;
    shareText: (s: S) => string;
    shareIntentUrl: (text: string) => string;
    SHARE_INTENT: string;
  };
}

const ADDR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const items = [
  { status: 'enviado', frase: 1, walletIndex: 0, wallet: ADDR, link: 'https://solscan.io/tx/abc' },
  { status: 'enviado', frase: 1, walletIndex: 0 },
  { status: 'enviado', frase: 1, walletIndex: 3 },
  { status: 'enviado', frase: 2, walletIndex: 0 }, // mesma posição em outra frase: outra carteira
  { status: 'falhou', frase: 1, walletIndex: 9 },
  { status: 'nada a fazer', frase: 1, walletIndex: 8 },
  null,
];

test('compartilhar: conta carteiras distintas (frase + posição) e transações enviadas; falha e "nada a fazer" ficam de fora', () => {
  const { shareStats } = load('en');
  assert.deepEqual(shareStats(items, 217086000n), { lamports: 217086000n, wallets: 3, txs: 4 });
  assert.deepEqual(shareStats(null, 'lixo'), { lamports: 0n, wallets: 0, txs: 0 }, 'dado sujo não derruba a tela');
  assert.equal(shareStats([], -5n).lamports, 0n, 'valor negativo nunca vira número na imagem');
});

test('compartilhar: o post marca o @clurnapp, leva só total e carteiras (sem endereço nem transação), nos dois idiomas', () => {
  for (const lang of ['en', 'pt'] as const) {
    const L = load(lang);
    const s = L.shareStats(items, 217086000n);
    const text = L.shareText(s);
    assert.match(text, /@clurnapp/);
    assert.match(text, /clurn\.app/);
    assert.ok(text.includes(lang === 'en' ? '0.2170' : '0,2170'), text);
    assert.ok(text.includes(' 3 '), 'número de carteiras');
    for (const leak of [ADDR, 'solscan', 'tx/abc']) assert.ok(!text.includes(leak), `vazou ${leak}`);
    const url = L.shareIntentUrl(text);
    assert.ok(url.startsWith(`${SHARE_URL}?text=`));
    assert.equal(new URL(url).searchParams.get('text'), text);
    assert.equal(isExternalLink(url), true, 'o Electron abre o post pronto');
  }
  const one = load('en').shareText({ lamports: 5000n, wallets: 1, txs: 1 });
  assert.match(one, /1 old burner wallet with/, 'singular');
  assert.match(one, /0\.000005/, 'valor pequeno com 6 casas, nunca 0');
});

test('compartilhar: o app só abre a tela de post do X, e só com o texto', () => {
  assert.equal(SHARE_URL, 'https://x.com/intent/post');
  for (const bad of [
    'https://x.com/clurnapp',
    'https://x.com/golpe?text=oi', // caminho errado, só com o texto
    'https://x.com/i/flow/login?text=oi',
    'https://x.com/intent/post?text=oi&url=https://golpe.com',
    'https://x.com/intent/post?text=oi#x',
    'https://x.com/intent/follow?screen_name=golpe',
    'https://twitter.com/intent/tweet?text=oi',
    'http://x.com/intent/post?text=oi',
    'https://x.com.golpe.com/intent/post?text=oi',
    `https://x.com/intent/post?text=${'a'.repeat(1001)}`,
  ]) assert.equal(isExternalLink(bad), false, bad);
  assert.equal(isExternalLink('https://x.com/intent/post?text=oi'), true);
});

test('compartilhar: o bloco só aparece com rodada completa e algo recebido', () => {
  assert.ok(HTML.includes('!state.aborted && received > 0n ? shareBlock(shareStats(rs, received)) : null'));
});
