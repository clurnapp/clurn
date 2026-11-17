// Gera o app de Windows: dist/Clurn-win32-x64/Clurn.exe e, para distribuir, o instalador dist/Clurn-Setup-<versão>.exe
// com o SHA-256 dele (Inno Setup 6 instalado aqui: scripts/instalador.ts). Sem o Inno Setup, sai o .zip de antes, com aviso.
// Uso: npm run empacotar
// Atualização (16/11/2026): com CLURN_CHAVE_ATUALIZACAO = caminho da chave .pem (fora do repositório), sai também o
// dist/clurn-versao.json assinado. Sem ele no GitHub Release, o app de ninguém se atualiza.
// RPC embutido (Helius): defina CLURN_RPC_URL com a URL completa antes de rodar, no seu terminal. Ela é gravada só
// dentro da cópia empacotada (src/app/rpc-embutido.json), nunca na pasta do projeto, e não aparece na saída.
// CLURN_HELIUS_PROJECT (opcional): id do projeto no Helius, para o painel de créditos mostrar o saldo da chave.
// Mais chaves (03/11/2026): CLURN_RPC_URL_2 + CLURN_HELIUS_PROJECT_2, _3… até _9. O app usa a 1ª; acabaram os
// créditos dela (ou ela caiu), passa sozinho para a próxima, e só depois da última vai para o RPC público.
// Proxy (09/11/2026, proxy/README.md): CLURN_PROXY_URL é a URL do Worker do Clurn na Cloudflare, que guarda a chave do
// Helius pago. Entra antes das chaves: proxy → CLURN_RPC_URL → _2… → público. A URL do proxy não tem chave.
// Sem a variável, o app sai sem RPC embutido e usa o público. Decisão do autor (31/10/2026): a chave fica legível
// no app, e quem abrir a pasta consegue usá-la (risco aceito, só para os amigos).
// O que entra está em includedInPackage (desktop/regras.ts). O código vai legível (sem asar), para quem quiser auditar.
import { packager } from '@electron/packager';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EMBEDDED_RPC_PATH, includedInPackage } from '../desktop/regras.ts';
import { embeddedEnvName, embeddedFromEnv, embeddedRpcFileContent } from '../src/app/rpc-padrao.ts';
import { describeRpc } from '../src/core/solana/rpc.ts';
import { findIscc, innoScript } from './instalador.ts';
import { signRelease } from './chave-atualizacao.ts';

const ROOT = path.join(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Grava os RPCs embutidos dentro do app empacotado (pasta resources/app), na ordem. Devolve o que imprimir (só os
// hosts, nunca a URL).
export function embedRpc(appDir: string, entries: Array<{ url: string; heliusProject?: string; proxy?: boolean }>): string {
  const file = path.join(appDir, ...EMBEDDED_RPC_PATH.split('/').filter(Boolean));
  if (!entries.length) {
    fs.rmSync(file, { force: true });
    return 'RPC embutido: nenhum (CLURN_PROXY_URL e CLURN_RPC_URL vazias). O app vai usar o RPC público, mais lento.';
  }
  fs.writeFileSync(file, embeddedRpcFileContent(entries));
  let keys = 0; // as chaves contam sem o proxy (a 1ª chave é CLURN_RPC_URL)
  const lines = entries.map((e, i) => {
    if (e.proxy) return `  ${i + 1}. ${describeRpc(e.url.trim())}, proxy do Clurn (a chave fica no Worker, não no app)`;
    const saldo = e.heliusProject?.trim() ? 'com o saldo da chave no painel' : `sem ${embeddedEnvName(keys, 'project')}: o painel não mostra o saldo desta chave`;
    keys++;
    return `  ${i + 1}. ${describeRpc(e.url.trim())}, ${saldo}`;
  });
  const hasProxy = keys < entries.length;
  const n = !hasProxy
    ? entries.length === 1 ? '1 chave' : `${entries.length} chaves, usadas nessa ordem (acabou uma, passa para a próxima)`
    : entries.length === 1 ? 'só o proxy' : `proxy e ${keys} ${keys === 1 ? 'chave' : 'chaves'}, usados nessa ordem (caiu um, passa para o próximo)`;
  const where = keys === 0 ? 'nenhuma chave dentro do app' : 'a chave vai legível dentro do app';
  return [`RPC embutido: ${n}; ${where}.`, ...lines].join('\n');
}

if (import.meta.main) {
  // URL inválida para aqui, antes de gastar um minuto empacotando (o erro não repete a URL)
  const embedded = embeddedFromEnv(process.env);
  embeddedRpcFileContent(embedded);
  const [dir] = await packager({
    dir: ROOT,
    out: OUT,
    name: 'Clurn',
    executableName: 'Clurn',
    platform: 'win32',
    arch: 'x64',
    icon: path.join(ROOT, 'desktop', 'clurn-icone.ico'),
    appVersion: pkg.version,
    asar: false,
    overwrite: true,
    prune: true,
    ignore: (p: string) => !includedInPackage(p),
    win32Metadata: { CompanyName: 'Clurn', ProductName: 'Clurn', FileDescription: 'Clurn', OriginalFilename: 'Clurn.exe' },
  });
  console.log(embedRpc(path.join(dir, 'resources', 'app'), embedded));
  const iscc = findIscc(process.env);
  const file = iscc ? buildInstaller(iscc, dir) : buildZip(dir);
  const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  fs.writeFileSync(`${file}.sha256`, `${sha}  ${path.basename(file)}\n`);
  console.log(`App: ${path.join(dir, 'Clurn.exe')}`);
  console.log(`Para distribuir: ${file}`);
  console.log(`SHA-256: ${sha}`);
  // o arquivo da atualização (clurn-versao.json), assinado com a chave de CLURN_CHAVE_ATUALIZACAO
  console.log(signRelease(file, process.env));
  updateInstalledCopy(dir);
}

// Clurn-Setup-<versão>.exe: o script do Inno vai para dist/ (fora do app) e o compilador roda quieto
function buildInstaller(iscc: string, dir: string): string {
  const iss = path.join(OUT, 'clurn.iss');
  fs.writeFileSync(iss, innoScript({
    version: pkg.version,
    appDir: dir,
    outDir: OUT,
    icon: path.join(ROOT, 'desktop', 'clurn-icone.ico'),
    smallImages: [58, 77, 97, 124].map((w) => path.join(ROOT, 'scripts', 'windows', `instalador-canto-${w}.png`)),
    sideImages: [202, 269, 404].map((w) => path.join(ROOT, 'scripts', 'windows', `instalador-lateral-${w}.png`)),
  }));
  const setup = path.join(OUT, `Clurn-Setup-${pkg.version}.exe`);
  fs.rmSync(setup, { force: true });
  execFileSync(iscc, ['/Q', iss], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (!fs.existsSync(setup)) throw new Error(`O Inno Setup não gerou ${setup}.`);
  return setup;
}

// Sem Inno Setup: o .zip de antes (a pasta do app), com aviso de como ter o instalador
function buildZip(dir: string): string {
  console.log('AVISO: Inno Setup 6 não encontrado; saiu o .zip no lugar do instalador. Instale com: winget install --id JRSoftware.InnoSetup -e --scope user (ou defina CLURN_ISCC com o caminho do ISCC.exe).');
  const zip = path.join(OUT, `Clurn-${pkg.version}-windows-x64.zip`);
  fs.rmSync(zip, { force: true });
  // tar.exe do próprio Windows (bsdtar) grava .zip; sem dependência nova. Pelo caminho completo: o tar do Git Bash
  // entende "C:" como nome de máquina. Caminhos relativos à pasta dist/.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-a', '-c', '-f', path.basename(zip), path.basename(dir)], { cwd: OUT });
  return zip;
}

// O atalho (scripts/windows/criar-atalho.ps1) abre uma CÓPIA em %LOCALAPPDATA%\Programs\Clurn, não a dist/.
// Em 30/10/2026 uma correção ficou só na dist/ e o app do atalho continuou caindo: a cópia instalada é
// atualizada aqui, ou o aviso diz que ficou velha. Nunca por cima do app aberto (copiaria pela metade).
function updateInstalledCopy(dir: string) {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) return;
  const installed = path.join(process.env.LOCALAPPDATA, 'Programs', 'Clurn');
  if (!fs.existsSync(path.join(installed, 'Clurn.exe'))) return;
  const running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Clurn.exe', '/NH'], { encoding: 'utf8' }).includes('Clurn.exe');
  if (running) {
    console.log(`AVISO: a cópia instalada (${installed}) continua VELHA: o Clurn está aberto. Feche-o e rode de novo (ou scripts\\windows\\criar-atalho.ps1).`);
    return;
  }
  // robocopy: 0-7 = ok (bits de "copiou", "extra apagado" etc.); 8+ = falha
  // /XF unins*: o desinstalador que o Clurn-Setup pôs nessa pasta fica (o /MIR o apagaria como "extra")
  const r = spawnSync('robocopy', [dir, installed, '/MIR', '/XF', 'unins*', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
  if ((r.status ?? 16) >= 8) throw new Error(`Falha ao atualizar a cópia instalada em ${installed} (robocopy ${r.status}).`);
  console.log(`Cópia instalada atualizada: ${path.join(installed, 'Clurn.exe')} (é ela que o atalho abre)`);
}
