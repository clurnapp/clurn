// Roda a suíte de testes no Node embutido no Electron (o que roda o servidor dentro do app de desktop).
// Uso: npm run test:electron
// Por quê: o Node do Electron usa BoringSSL, com menos curvas e algoritmos que o OpenSSL do Node do
// terminal. Em 30/10/2026 a análise caía só no app porque `createECDH('secp256k1')` não existe lá.
// `npm test` verde não prova que o app de desktop funciona; este script prova.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
// fora do Electron, `require('electron')` devolve o caminho do executável (sem shell: a pasta tem espaços)
const electron = createRequire(import.meta.url)('electron') as string;
const args = process.argv.slice(2);
const r = spawnSync(electron, ['--test', '--test-concurrency=4', ...(args.length ? args : ['test/**/*.test.ts'])], {
  cwd: ROOT,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
