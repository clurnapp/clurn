// Gera as imagens do instalador do Windows (scripts/instalador.ts) a partir do logo do app, com o Edge invisível
// (sem dependência nova). Rodar de novo só quando o logo ou a cor de fundo mudarem:
//   node scripts/windows/imagens-instalador.mjs
// Saída em scripts/windows/, nos tamanhos de DPI que o Inno Setup 6.7 usa (ajuda de WizardImageFile e
// WizardSmallImageFile):
//   instalador-lateral-<largura>.png  tela final (logo + nome, proporção 164:314): 100%, 125% e 200%
//   instalador-canto-<lado>.png       canto de cima das outras telas (quadrado): 100%, 125%, 150% e 200%. O quadrado
//                                     do Inno encosta no topo e na lateral da janela: o logo fica menor, com margem.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { INSTALLER_BG } from '../instalador.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');
const OUT = import.meta.dirname;
const logo = fs.readFileSync(path.join(ROOT, 'src', 'app', 'ui', 'assets', 'clurn-icone.svg'), 'utf8');
const font = path.join(ROOT, 'site', 'assets', 'chakra-petch-700.woff2').replace(/\\/g, '/');

// o Edge invisível tem tamanho mínimo de janela: o desenho fica num quadro fixo no canto, que é o que a foto pega
const page = (w, h, css, body) => `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Chakra; src: url("file:///${font}") format("woff2"); font-weight: 700; }
html, body { margin: 0; background: ${INSTALLER_BG}; overflow: hidden; }
main { position: fixed; left: 0; top: 0; width: ${w}px; height: ${h}px; display: flex; flex-direction: column; align-items: center; justify-content: center; box-sizing: border-box; }
${css}
</style><body><main>${body}</main></body>`;

const IMAGES = [
  {
    name: 'instalador-lateral',
    w: 202,
    h: 386,
    sizes: [202, 269, 404],
    html: page(202, 386, 'main { gap: 14px; padding-bottom: 40px; } svg { width: 92px; height: 92px; } p { margin: 0; font: 700 30px/1 Chakra, sans-serif; color: #E6E3EE; letter-spacing: .02em; }', `${logo}<p>Clurn</p>`),
  },
  {
    name: 'instalador-canto',
    // base de 62 px: o maior tamanho sai com fator 2 (o Edge recusa fator acima de 2)
    w: 62,
    h: 62,
    sizes: [58, 77, 97, 124],
    // ~60% do quadrado: o logo respira longe do topo e da lateral da janela
    html: page(62, 62, 'svg { width: 37px; height: 37px; }', logo),
  },
];

const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean)
  .map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .find((p) => fs.existsSync(p));
if (!edge) throw new Error('Edge não encontrado');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clurn-inst-img-'));
try {
  for (const img of IMAGES) {
    const file = path.join(tmp, `${img.name}.html`);
    fs.writeFileSync(file, img.html);
    for (const size of img.sizes) {
      const out = path.join(OUT, `${img.name}-${size}.png`);
      // o fator de escala dá os tamanhos maiores sem mudar o desenho
      const args = ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-sync', '--no-first-run', `--user-data-dir=${path.join(tmp, `perfil-${img.name}-${size}`)}`, '--hide-scrollbars', `--force-device-scale-factor=${size / img.w}`, `--window-size=${img.w},${img.h}`, '--virtual-time-budget=2000', `--screenshot=${out}`, `file:///${file.replace(/\\/g, '/')}`];
      const r = spawnSync(edge, args, { stdio: 'ignore', timeout: 60_000 });
      if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`o Edge não gerou ${out} (saída ${r.status}, ${r.error?.message ?? 'sem erro'})`);
      const png = fs.readFileSync(out);
      console.log(`${path.basename(out)}: ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
