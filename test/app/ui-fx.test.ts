// Fundo de fumaça (WebGL): só liga com GPU de verdade. Com driver básico ou GPU fraca, o canvas WebGL vira branco
// opaco por cima da página (app de um tester, 31/10/2026: tema escuro com fundo branco e texto claro ilegível).
// Reproduzido no Edge com ANGLE d3d9/gl; ver docs/aprendizados.md. Aqui a regra roda com canvas falsos, sem navegador.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnSource } from './ui-source.ts';

type FakeGl = { ext: string[]; renderer: string | null };
function canvasWith(gl: FakeGl | null, seen: unknown[] = []) {
  return () => ({
    getContext(kind: string, opts: unknown) {
      seen.push([kind, opts]);
      if (!gl) return null;
      return {
        getExtension: (n: string) => {
          if (n === 'WEBGL_debug_renderer_info') return gl.renderer === null ? null : { UNMASKED_RENDERER_WEBGL: 0x9246 };
          if (n === 'WEBGL_lose_context') return { loseContext() {} };
          return gl.ext.includes(n) ? {} : null;
        },
        getParameter: () => gl.renderer,
      };
    },
  });
}
const fxGpuOk = new Function(`${fnSource('fxGpuOk')}; return fxGpuOk;`)() as (make: () => unknown) => boolean;
const FLOAT = ['EXT_color_buffer_float'];

test('fundo: GPU de verdade liga o efeito, e o teste pede contexto recusando o caminho degradado', () => {
  const seen: unknown[] = [];
  assert.equal(fxGpuOk(canvasWith({ ext: FLOAT, renderer: 'ANGLE (AMD, AMD Radeon RX 580 2048SP Direct3D11 vs_5_0 ps_5_0, D3D11)' }, seen)), true);
  assert.deepEqual(seen, [['webgl2', { failIfMajorPerformanceCaveat: true }]]);
  assert.equal(fxGpuOk(canvasWith({ ext: FLOAT, renderer: null })), true, 'sem o nome da GPU, vale o failIfMajorPerformanceCaveat');
});

test('fundo: driver básico, GPU fraca, software ou erro deixam o efeito desligado', () => {
  assert.equal(fxGpuOk(canvasWith(null)), false, 'failIfMajorPerformanceCaveat recusou (o caso da tela branca)');
  assert.equal(fxGpuOk(canvasWith({ ext: [], renderer: 'ANGLE (NVIDIA)' })), false, 'sem float no framebuffer');
  for (const r of ['ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)']) {
    assert.equal(fxGpuOk(canvasWith({ ext: FLOAT, renderer: r })), false, r);
  }
  assert.equal(fxGpuOk(() => { throw new Error('sem canvas'); }), false);
});

test('fundo: o canvas visível só ganha contexto depois do teste, e também recusando o caminho degradado', () => {
  const src = fnSource('startFx');
  const probe = src.indexOf('if (!fxGpuOk()) return null;');
  const visible = src.indexOf("canvas.getContext('webgl2'");
  assert.ok(probe > 0 && visible > probe, 'fxGpuOk antes do getContext do canvas visível');
  assert.match(src.slice(visible, src.indexOf('\n', visible)), /failIfMajorPerformanceCaveat: true/);
  assert.match(src, /webglcontextlost[^\n]*canvas\.remove\(\)/, 'GPU caiu: o canvas sai da página');
});
