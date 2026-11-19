// Testa o instalador de verdade (Windows, Inno Setup 6) sem tocar no Clurn instalado de quem roda:
// compila uma VARIANTE do dist/clurn.iss com outra identidade (AppId, nome "ClurnTesteInstalador", atalho com esse
// nome, sem atalho na área de trabalho) e com as pastas de dados trocadas por pastas temporárias; instala em silêncio
// numa pasta temporária, confere arquivos, registro de desinstalação e atalho; abre o Clurn.exe instalado por alguns
// segundos (o servidor sobe e a janela aparece); desinstala em silêncio e confere que nada ficou.
// Uso (depois de npm run empacotar):  node scripts/testar-instalador.ts
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findIscc, INSTALLER_APP_ID, UNINSTALL_DATA_DIRS } from './instalador.ts';

const ROOT = path.join(import.meta.dirname, '..');
const ISS = path.join(ROOT, 'dist', 'clurn.iss');
const TEST_ID = '0E7C2B9A-5D41-4F38-9B6A-3C1F00D7A111';
const NAME = 'ClurnTesteInstalador';
const iscc = findIscc(process.env);
if (!iscc) throw new Error('Inno Setup 6 não encontrado (veja scripts/instalador.ts).');
if (!fs.existsSync(ISS)) throw new Error('Rode npm run empacotar antes (falta dist/clurn.iss).');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-instalador-'));
const appDir = path.join(tmp, 'app');
const dataDirs = UNINSTALL_DATA_DIRS.map((_, i) => path.join(tmp, `dados-${i}`));
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'OK  ' : 'FALHOU'} ${what}`);
  if (!ok) failures++;
};

// variante: só identidade, nomes e pastas de dados mudam; o resto é o script que vai para o público
let iss = fs.readFileSync(ISS, 'utf8');
const swap = (from: string, to: string) => {
  if (!iss.includes(from)) throw new Error(`o script mudou: não achei ${from}`);
  iss = iss.split(from).join(to);
};
swap(INSTALLER_APP_ID, TEST_ID);
swap('{autoprograms}\\Clurn"', `{autoprograms}\\${NAME}"`);
swap('UninstallDisplayName=Clurn', `UninstallDisplayName=${NAME}`);
swap('OutputBaseFilename=Clurn-Setup-', `OutputBaseFilename=${NAME}-`);
UNINSTALL_DATA_DIRS.forEach((d, i) => swap(`Name: "${d}"`, `Name: "${dataDirs[i]}"`));
iss = iss.replace(/^OutputDir=.*$/m, `OutputDir="${tmp}"`);
const variant = path.join(tmp, 'teste.iss');
fs.writeFileSync(variant, iss);
execFileSync(iscc, ['/Q', variant], { stdio: ['ignore', 'ignore', 'inherit'] });
const setup = fs.readdirSync(tmp).find((f) => f.startsWith(NAME) && f.endsWith('.exe'));
check(Boolean(setup), 'variante de teste compilada');

for (const d of dataDirs) {
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'x.json'), '{}');
}
const regKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{${TEST_ID}}_is1`;
const reg = () => {
  try {
    return execFileSync('reg', ['query', regKey], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};
const startMenu = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);

// O terminal do VS Code passa ELECTRON_RUN_AS_NODE=1 adiante: com ela o Clurn.exe roda como Node puro e sai na hora
// (09/11/2026, primeira rodada deste roteiro). O app de verdade abre sem ela.
const appEnv = { ...process.env };
delete appEnv.ELECTRON_RUN_AS_NODE;
const kill = (pid: number | undefined) => pid && spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
// processos rodando de dentro da pasta de teste (o Clurn que a instalação silenciosa reabre e os filhos do Electron)
const procsIn = (dir: string): number[] => {
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:ALVO, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`;
  const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, ALVO: dir + path.sep } }).stdout ?? '';
  return out.split(/\s+/).filter(Boolean).map(Number);
};
const killAllIn = async (dir: string) => {
  for (const pid of procsIn(dir)) kill(pid);
  await new Promise((res) => setTimeout(res, 2000)); // os filhos do Electron soltam os arquivos
};
const uninstall = async () => {
  await killAllIn(appDir); // arquivo aberto não sai na desinstalação
  const u = fs.existsSync(appDir) ? fs.readdirSync(appDir).find((f) => /^unins\d+\.exe$/.test(f)) : undefined;
  if (!u) return false;
  execFileSync(path.join(appDir, u), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore' });
  await new Promise((res) => setTimeout(res, 3000)); // o desinstalador se copia para o temp e termina depois
  return true;
};

// instala sem tela e sem atalho na área de trabalho, como a atualização pelo próprio app (1.0): no modo silencioso o
// instalador reabre o Clurn sozinho ([Run] com skipifnotsilent)
execFileSync(path.join(tmp, setup!), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', `/DIR=${appDir}`, '/TASKS='], { stdio: 'ignore', env: appEnv });
try {
  let reopened = false;
  for (let i = 0; i < 30 && !reopened; i++) {
    reopened = procsIn(appDir).length > 0;
    if (!reopened) await new Promise((res) => setTimeout(res, 500));
  }
  check(reopened, 'instalação silenciosa (atualização pelo app) reabre o Clurn');
  await killAllIn(appDir);
  check(fs.existsSync(path.join(appDir, 'Clurn.exe')), 'Clurn.exe instalado na pasta escolhida');
  check(fs.existsSync(path.join(appDir, 'resources', 'app', 'src', 'app', 'server.ts')), 'código legível do app instalado (para auditar)');
  check(fs.readdirSync(appDir).some((f) => /^unins\d+\.exe$/.test(f)), 'desinstalador na pasta');
  const r = reg();
  check(r.includes(`DisplayName    REG_SZ    ${NAME}`), '"Adicionar ou remover programas": nome');
  check(/Publisher\s+REG_SZ\s+Clurn\r?\n/.test(r), '"Adicionar ou remover programas": publicador Clurn');
  check(/DisplayIcon\s+REG_SZ\s+.*Clurn\.exe/.test(r), '"Adicionar ou remover programas": ícone do Clurn');
  check(fs.existsSync(startMenu), 'atalho no menu Iniciar');

  // abre o instalado: o processo continua vivo (servidor e janela subiram) até ser fechado aqui
  const child = spawn(path.join(appDir, 'Clurn.exe'), [], { stdio: 'ignore', env: appEnv });
  await new Promise((res) => setTimeout(res, 8000));
  check(child.exitCode === null, 'Clurn.exe instalado abre e continua aberto');
  kill(child.pid);
  await new Promise((res) => setTimeout(res, 1500));
} finally {
  // desinstala mesmo se algo acima falhou: a cópia de teste nunca fica no computador
  check(await uninstall(), 'desinstalador rodou');
}
check(!fs.existsSync(path.join(appDir, 'Clurn.exe')), 'desinstalado: Clurn.exe removido');
check(reg() === '', 'desinstalado: some de "Adicionar ou remover programas"');
check(!fs.existsSync(startMenu), 'desinstalado: atalho do Iniciar removido');
for (const d of dataDirs) check(!fs.existsSync(d), `desinstalado: pasta de dados apagada (${path.basename(d)})`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo');
process.exitCode = failures ? 1 : 0;
