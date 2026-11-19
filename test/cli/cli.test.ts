import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isInsideRepo } from '../../src/cli/io.ts';

const root = path.resolve('C:/projetos/autoclarn');

test('arquivo da frase dentro do repositório é recusado', () => {
  assert.ok(isInsideRepo('C:/projetos/autoclarn/frase.txt', root));
  assert.ok(isInsideRepo('C:/projetos/autoclarn/secrets/a.seed', root));
  assert.ok(isInsideRepo('C:/PROJETOS/Autoclarn/x.txt', root), 'Windows ignora maiúsculas');
  assert.ok(isInsideRepo('C:/projetos/autoclarn', root));
});

test('arquivo fora do repositório é aceito', () => {
  assert.ok(!isInsideRepo('C:/Users/pessoa/segredos/frase.txt', root));
  assert.ok(!isInsideRepo('C:/projetos/autoclarn-copia/frase.txt', root), 'pasta com prefixo parecido não conta como dentro');
  assert.ok(!isInsideRepo('D:/frase.txt', root));
});

test('terminal: falha mostra o que houve e o que fazer, não o texto técnico', async () => {
  const { resultLine } = await import('../../src/cli/limpar.ts');
  const { ERROR_TEXT_PT } = await import('../../src/core/limpeza/errors.ts');
  const r = {
    status: 'falhou', description: 'Conta 4: limpar', detail: 'Transfer: insufficient lamports 5 need 10',
    error: { code: 'sim-insufficient', params: {}, technical: 'Transfer: insufficient lamports 5 need 10', beforeSend: true },
  } as any;
  const out = resultLine(r, '', '');
  assert.ok(out.includes(ERROR_TEXT_PT['sim-insufficient'].what({})));
  assert.ok(!out.includes('insufficient lamports'));
  assert.ok(out.includes('Conta 4: limpar'));
});

test('terminal: limpar e scan conferem a rede do RPC (trava pelo hash de gênese) antes de qualquer leitura', () => {
  const src = (f: string) => fs.readFileSync(new URL(`../../src/cli/${f}`, import.meta.url), 'utf8');
  assert.match(src('limpar.ts'), /checkRpc\(rpc, undefined, undefined, cluster\)/, 'limpar: a rede escolhida (--devnet ou mainnet)');
  assert.match(src('scan.ts'), /checkRpc\(rpc, undefined, undefined, 'mainnet'\)/, 'scan: só mainnet');
});

test('terminal: com RPC próprio, limpar e scan mandam o getProgramAccounts recusado pelo público da rede, com a trava de rede', () => {
  const src = (f: string) => fs.readFileSync(new URL(`../../src/cli/${f}`, import.meta.url), 'utf8');
  assert.match(src('limpar.ts'), /withGpaFallback\(own, \(\) => networkGuarded\(createRpc\(\{ url: RPC\[cluster\], \.\.\.PUBLIC_RPC_LIMITS \}\), cluster\)\)/);
  assert.match(src('scan.ts'), /withGpaFallback\(own, \(\) => networkGuarded\(createRpc\(\{ url: DEFAULT_RPC, \.\.\.PUBLIC_RPC_LIMITS \}\), 'mainnet'\)\)/);
});
