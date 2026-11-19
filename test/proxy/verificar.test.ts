// Verificador grátis do site (19/11/2026): GET /verificar?endereco=<carteira> no proxy. Sem frase: só o endereço
// público. Mesmas funções da varredura do app; cota própria; o endereço não é gravado; CORS só para clurn.app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pumpAmmCreatorVaultAta, pumpCreatorVault, PROGRAMS } from '../../src/core/solana/pda.ts';
import { json, makeWorld, SECRET } from './helpers.ts';
import { existsSync } from 'node:fs';

// O site não vai para o código público (scripts/publicar-codigo.ts): lá, os testes que leem site/verificar.js são pulados.
const NO_SITE = existsSync(new URL('../../site/verificar.js', import.meta.url)) ? false : 'o site não faz parte do código público';

const WALLET = 'BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL'; // qualquer endereço válido serve
const RENT0 = 890_880;
const TOKEN_RENT = 2_039_280;
const TOKEN_STATSKEY = 'tk_' + 'c0ffee12'.repeat(5);

const tokenAcc = (pubkey: string, mint: string, amount: string, extra: Record<string, unknown> = {}, lamports = TOKEN_RENT) => ({
  pubkey,
  account: { lamports, data: { parsed: { info: { mint, owner: WALLET, state: 'initialized', tokenAmount: { amount, decimals: amount === '1' ? 0 : 6 }, ...extra } } } },
});

type Over = { tokens?: unknown; tokens2022?: unknown; accounts?: unknown; failTokens?: boolean; failAll?: boolean };
function chain(o: Over = {}) {
  return (body: string): Response => {
    const { method, params } = JSON.parse(body);
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
    if (o.failAll) return new Response('fora', { status: 503 });
    if (method === 'getMinimumBalanceForRentExemption') return ok(RENT0);
    if (method === 'getMultipleAccounts') {
      assert.deepEqual(params[0], [WALLET, pumpCreatorVault(WALLET), pumpAmmCreatorVaultAta(WALLET)], 'carteira e os dois cofres de creator fee');
      return ok({ value: o.accounts ?? [{ lamports: 1_500_000_000 }, { lamports: RENT0 + 250_000_000 }, { lamports: TOKEN_RENT, data: { parsed: { info: { tokenAmount: { amount: '40000000' } } } } }] });
    }
    if (method === 'getTokenAccountsByOwner') {
      if (o.failTokens) return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'falhou' } });
      const legacy = params[1].programId === PROGRAMS.token;
      return ok({ value: legacy ? (o.tokens ?? [tokenAcc('A1', 'M1', '0'), tokenAcc('A2', 'M2', '0'), tokenAcc('A3', 'M3', '5000'), tokenAcc('A4', 'M4', '0', { state: 'frozen' })]) : (o.tokens2022 ?? [tokenAcc('B1', 'N1', '1')]) });
    }
    return Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'método' } });
  };
}

const req = (addr: string | null, init: RequestInit & { ip?: string; origin?: string; vaults?: false } = {}) => {
  const headers: Record<string, string> = { 'cf-connecting-ip': init.ip ?? '203.0.113.50' };
  if (init.origin) headers.origin = init.origin;
  // os cofres vêm calculados pelo navegador; aqui, pela conta do app (a mesma, conferida no teste do fim)
  const vaults = addr && init.vaults !== false ? `&cofre=${pumpCreatorVault(WALLET)}&ata=${pumpAmmCreatorVaultAta(WALLET)}` : '';
  return new Request(`https://rpc.clurn.app/verificar${addr === null ? '' : `?endereco=${encodeURIComponent(addr)}${vaults}`}`, { method: init.method ?? 'GET', headers });
};

test('verificar: lê saldo, contas vazias que fecham, moedas e os dois cofres de creator fee, com os números da varredura do app', async () => {
  const w = makeWorld({}, { reply: chain() });
  const r = await json(await w.send(req(WALLET, { origin: 'https://clurn.app' })));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.endereco, WALLET);
  assert.equal(b.sol, 1_500_000_000);
  assert.equal(b.contasVazias, 2, 'a congelada não fecha com a chave do dono');
  assert.equal(b.travadas, 1);
  assert.equal(b.aluguel, 2 * TOKEN_RENT);
  assert.equal(b.moedas, 2, 'moeda com saldo e NFT, sem preço');
  assert.equal(b.feePump, 250_000_000, 'cofre da curva acima do aluguel');
  assert.equal(b.feePumpSwap, 40_000_000);
  assert.equal(b.recuperavel, 2 * TOKEN_RENT + 250_000_000 + 40_000_000, 'o SOL solto fica fora: só volta se for uma temporária');
  assert.equal(b.incompleto, false);
  assert.equal(r.headers['access-control-allow-origin'], 'https://clurn.app');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!r.text.includes(SECRET) && !r.text.includes('helius'), 'nada do upstream volta');
  assert.equal(w.up.calls.length, 4, 'só as consultas fixas');
  assert.ok(w.up.calls.every((c) => !('cf-connecting-ip' in c.headers)), 'o IP de quem verifica não vai ao upstream');
});

test('verificar: CORS só para clurn.app; endereço inválido, ausente ou método errado é recusado sem ler a rede', async () => {
  const w = makeWorld({}, { reply: chain() });
  const other = await json(await w.send(req(WALLET, { origin: 'https://golpe.example' })));
  assert.equal(other.status, 200);
  assert.equal(other.headers['access-control-allow-origin'], undefined, 'outro site não lê a resposta no navegador');
  const before = w.up.calls.length;
  for (const bad of [null, '', 'abc', '0OIl' + 'x'.repeat(40), WALLET + 'A', '<script>']) {
    assert.equal((await w.send(req(bad))).status, 400, String(bad));
  }
  assert.equal((await w.send(req(WALLET, { method: 'POST' }))).status, 405);
  assert.equal((await w.send(req(WALLET, { vaults: false }))).status, 400, 'sem os cofres');
  assert.equal(w.up.calls.length, before, 'pedido recusado não gasta crédito');
});

test('verificar: parte que falha vem como "não lido" (null), nunca zero, e não derruba as outras', async () => {
  const w = makeWorld({}, { reply: chain({ failTokens: true }) });
  const b = (await json(await w.send(req(WALLET)))).body;
  assert.equal(b.aluguel, null);
  assert.equal(b.contasVazias, null);
  assert.equal(b.moedas, null);
  assert.equal(b.feePump, 250_000_000);
  assert.equal(b.recuperavel, 290_000_000, 'soma do que foi lido');
  assert.equal(b.incompleto, true);
  const all = makeWorld({}, { reply: chain({ failAll: true }) });
  assert.equal((await all.send(req(WALLET))).status, 502, 'nada lido: erro, não uma carteira vazia');
});

test('verificar: dado sujo (conta fora do formato, conta repetida, cofre com saldo quebrado) não derruba nem duplica', async () => {
  const dup = tokenAcc('A1', 'M1', '0');
  const w = makeWorld({}, {
    reply: chain({
      tokens: [dup, dup, { pubkey: 'X', account: { lamports: 'muito' } }, null, tokenAcc('A9', 'M9', 'não-número')],
      tokens2022: [],
      accounts: [{ lamports: 1 }, { lamports: 'quebrado' }, null],
    }),
  });
  const b = (await json(await w.send(req(WALLET)))).body;
  assert.equal(b.contasVazias, 1, 'a mesma conta duas vezes conta uma');
  assert.equal(b.aluguel, TOKEN_RENT);
  assert.equal(b.moedas, 0, 'conta fora do formato não vira moeda');
  assert.equal(b.feePump, null, 'cofre com saldo quebrado: não lido, nunca "0 de fee"');
  assert.equal(b.feePumpSwap, null);
  assert.equal(b.sol, 1);
  assert.equal(b.incompleto, true);
});

test('verificar: limite por IP e teto do dia próprios; contados no painel sem endereço nem IP gravado', async () => {
  const w = makeWorld({ LIMITE_VERIF_IP: '2', TETO_VERIF: '3', STATS_TOKEN: TOKEN_STATSKEY }, { reply: chain() });
  assert.equal((await w.send(req(WALLET, { ip: '198.51.100.1' }))).status, 200);
  assert.equal((await w.send(req(WALLET, { ip: '198.51.100.1' }))).status, 200);
  const ipOver = await json(await w.send(req(WALLET, { ip: '198.51.100.1' })));
  assert.equal(ipOver.status, 429);
  assert.equal(ipOver.body.erro, 'limite-ip');
  assert.ok(Number(ipOver.headers['retry-after']) > 0);
  assert.equal((await w.send(req(WALLET, { ip: '198.51.100.2' }))).status, 200);
  const dayOver = await json(await w.send(req(WALLET, { ip: '198.51.100.3' })));
  assert.equal(dayOver.status, 429);
  assert.equal(dayOver.body.erro, 'limite-dia');
  await w.cotas.alarm();
  const stats = (await json(await w.send(new Request('https://rpc.clurn.app/stats', { headers: { authorization: `Bearer ${TOKEN_STATSKEY}` } })))).body;
  assert.equal(stats.hoje.verificacoes, 3);
  assert.equal(stats.hoje.recusas['verif-ip'], 1);
  assert.equal(stats.hoje.recusas['verif-teto'], 1);
  assert.equal(stats.hoje.creditos, 15, '3 verificações × 5 créditos, somados ao dia');
  const stored = JSON.stringify([...w.mem.data.entries()]);
  assert.ok(!stored.includes(WALLET), 'o endereço verificado não é gravado');
  w.advance(24 * 3_600_000);
  assert.equal((await w.send(req(WALLET, { ip: '198.51.100.1' }))).status, 200, 'o dia novo zera o limite');
  await w.cotas.alarm();
  assert.ok(![...w.mem.data.keys()].some((k) => k.includes('198.51.100.2')), 'IPs do dia anterior saem');
});

test('verificar: o teto global do app também barra (o verificador nunca gasta o que o app precisa)', async () => {
  const w = makeWorld({ TETO_DIA: '7', TETO_HORA: '100' }, { reply: chain() });
  assert.equal((await w.send(req(WALLET, { ip: '192.0.2.1' }))).status, 200, '5 de 7 créditos');
  const r = await json(await w.send(req(WALLET, { ip: '192.0.2.2' })));
  assert.equal(r.status, 429);
  assert.equal(r.body.erro, 'limite-dia');
});

test('verificar: a conta dos cofres feita no navegador (site/verificar.js) dá os mesmos endereços que a do app', { skip: NO_SITE }, async () => {
  const site = await import('../../site/verificar.js');
  const { encodeBase58 } = await import('../../src/core/solana/base58.ts');
  const { randomBytes } = await import('node:crypto');
  const wallets = [WALLET, ...Array.from({ length: 40 }, () => encodeBase58(randomBytes(32)))];
  for (const w of wallets) {
    assert.equal(await site.pumpCreatorVault(w), pumpCreatorVault(w), `cofre da curva de ${w}`);
    assert.equal(await site.pumpAmmCreatorVaultAta(w), pumpAmmCreatorVaultAta(w), `cofre do PumpSwap de ${w}`);
    assert.equal(site.isAddress(w), true);
  }
  assert.equal(site.isAddress('abc'), false);
  assert.equal(site.isAddress(WALLET + 'A'), false);
});

test('verificar: o site nunca manda frase de recuperação nem chave privada (reconhece e para antes da rede)', { skip: NO_SITE }, async () => {
  const { looksSecret } = await import('../../site/verificar.js');
  const { encodeBase58 } = await import('../../src/core/solana/base58.ts');
  const { randomBytes } = await import('node:crypto');
  const frase12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
  for (const s of [frase12, `  ${frase12.toUpperCase()}  `, frase12.split(' ').join('\n'), frase12 + ' acid acoustic acquire across act action actor actress actual adapt adjust admit', encodeBase58(randomBytes(64)), `[${Array.from({ length: 64 }, (_, i) => i).join(',')}]`]) {
    assert.equal(looksSecret(s), true, s.slice(0, 30));
  }
  for (const s of [WALLET, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', '']) assert.equal(looksSecret(s), false, s);
  // e o envio fica atrás dessa conferência no código do site
  const code = (await import('node:fs')).readFileSync(new URL('../../site/verificar.js', import.meta.url), 'utf8');
  const check = code.slice(code.indexOf('async function check('));
  assert.ok(check.indexOf('looksSecret(t)') < check.indexOf('fetch('), 'a conferência vem antes do fetch');
});

test('verificar: o teto por hora do proxy também barra e é dividido com o app (revisão de segurança de 19/11/2026)', async () => {
  const w = makeWorld({ TETO_HORA: '12' }, { reply: chain() });
  assert.equal((await w.send(req(WALLET, { ip: '192.0.2.11' }))).status, 200, '5 de 12 na hora');
  assert.equal((await w.send(req(WALLET, { ip: '192.0.2.12' }))).status, 200, '10 de 12');
  const r = await json(await w.send(req(WALLET, { ip: '192.0.2.13' })));
  assert.equal(r.status, 429, 'a 3ª passaria do teto da hora');
  w.advance(3_600_000);
  assert.equal((await w.send(req(WALLET, { ip: '192.0.2.13' }))).status, 200, 'hora nova, teto novo');
});

test('verificar: o post de compartilhar leva só o valor achado, nunca o endereço da carteira', { skip: NO_SITE }, async () => {
  const code = (await import('node:fs')).readFileSync(new URL('../../site/verificar.js', import.meta.url), 'utf8');
  const texts = [...code.matchAll(/shareText: \(v\) => `([^`]*)`/g)].map((m) => m[1]!);
  assert.equal(texts.length, 2, 'inglês e português');
  for (const t of texts) {
    assert.ok(t.includes('${v}') && t.includes('clurn.app'));
    assert.ok(!/endereco|address|\$\{d\.|\$\{t\}/.test(t), 'sem endereço no texto');
  }
  const share = code.slice(code.indexOf('// compartilhar'), code.indexOf('// compartilhar') + 500);
  assert.ok(share.includes('T.shareText(sol(total))') && !share.includes('d.endereco'), 'o link só recebe o total');
});
