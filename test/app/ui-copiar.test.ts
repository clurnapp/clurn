// Botão "Copiar" dos endereços: a API do navegador primeiro; se falhar (permissão negada no app de desktop, janela
// sem foco), o comando antigo de copiar sobre um campo temporário. Em 31/10/2026 o botão não copiava no app:
// a API era negada e a página só dizia "Selecione e copie".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fnSource } from './ui-source.ts';

type Fakes = { writeText?: (t: string) => Promise<void>; execCommand?: (cmd: string) => boolean; noClipboard?: boolean };
function run(text: string, f: Fakes) {
  const calls: string[] = [];
  const body: { children: Array<{ value: string; removed: boolean }> } = { children: [] };
  const navigator = f.noClipboard ? {} : { clipboard: { writeText: async (t: string) => { calls.push(`write:${t}`); await f.writeText!(t); } } };
  const document = {
    body: { append: (n: { value: string; removed: boolean }) => body.children.push(n) },
    createElement: (tag: string) => {
      assert.equal(tag, 'textarea');
      const n = { value: '', removed: false, attrs: {} as Record<string, string>, style: {} as Record<string, string>, selected: false,
        setAttribute(k: string, v: string) { this.attrs[k] = v; }, select() { this.selected = true; calls.push(`select:${this.value}`); }, remove() { this.removed = true; } };
      return n;
    },
    execCommand: (cmd: string) => { calls.push(`exec:${cmd}`); return f.execCommand ? f.execCommand(cmd) : false; },
  };
  const copyText = new Function('navigator', 'document', `${fnSource('copyText')}\nreturn copyText;`)(navigator, document) as (t: string) => Promise<boolean>;
  return { ok: copyText(text), calls, body };
}
const ADDR = '3bFJHJkwjwJsyp1fKunSi5TUurV8rkmMBxW63bvyMNk4';

test('copiar: a API do navegador funciona → copiado, sem campo temporário', async () => {
  const r = run(ADDR, { writeText: async () => {} });
  assert.equal(await r.ok, true);
  assert.deepEqual(r.calls, [`write:${ADDR}`]);
  assert.equal(r.body.children.length, 0);
});

test('copiar: API negada (app de desktop) → copia pelo comando antigo e tira o campo da página', async () => {
  const r = run(ADDR, { writeText: async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); }, execCommand: () => true });
  assert.equal(await r.ok, true);
  assert.deepEqual(r.calls, [`write:${ADDR}`, `select:${ADDR}`, 'exec:copy']);
  assert.equal(r.body.children.length, 1);
  assert.equal(r.body.children[0].value, ADDR, 'o campo temporário leva o endereço inteiro');
  assert.equal(r.body.children[0].removed, true, 'campo tirado da página depois de copiar');
});

test('copiar: sem navigator.clipboard (contexto sem a API) → comando antigo', async () => {
  const r = run(ADDR, { noClipboard: true, execCommand: () => true });
  assert.equal(await r.ok, true);
  assert.deepEqual(r.calls, [`select:${ADDR}`, 'exec:copy']);
});

test('copiar: os dois falham → false ("Selecione e copie"), sem exceção e sem campo sobrando', async () => {
  const r = run(ADDR, { writeText: async () => { throw new Error('x'); }, execCommand: () => false });
  assert.equal(await r.ok, false);
  assert.equal(r.body.children[0]?.removed, true);
  const r2 = run(ADDR, { writeText: async () => { throw new Error('x'); }, execCommand: () => { throw new Error('execCommand indisponível'); } });
  assert.equal(await r2.ok, false);
});

test('copiar: o botão escreve "Copiado" ou "Selecione e copie" pelo resultado de copyText', () => {
  const src = fnSource('copyButton');
  assert.match(src, /const ok = await copyText\(text\);/);
  assert.match(src, /ev\.target\.textContent = t\(ok \? 'copy\.ok' : 'copy\.fail'\);/);
});
