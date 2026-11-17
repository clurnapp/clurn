// Sons de aviso (pedido do autor, 31/10/2026): o bloco "sons" da página avaliado sozinho, sem navegador, com um
// AudioContext falso que anota o que foi agendado. Prende: notas confortáveis, limite de rajada, só envio de verdade
// toca, mudo não toca, contexto só depois do gesto e preferência com localStorage quebrado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTML, SCRIPT, fnSource } from './ui-source.ts';

type Note = { f: number; at: number; dur: number; gain: number; type: string; attack: number };
type Storage = () => { getItem(k: string): string | null; setItem(k: string, v: string): void };
type Sounds = {
  unlock(): void;
  play(kind: string | null): boolean;
  isOn(): boolean;
  played: Record<string, number>;
  screen(next: { section: string; phase: string }): boolean;
  setOn(on: boolean): void;
};
const S = (() => {
  const start = SCRIPT.indexOf('// sons:inicio');
  const end = SCRIPT.indexOf('// sons:fim');
  assert.ok(start > 0 && end > start, 'marcadores do bloco de sons');
  return new Function(`${SCRIPT.slice(start, end)}; return { soundNotes, soundGate, stepSound, finishSound, transitionSound, readSoundOn, saveSoundOn, scheduleNotes, makeSounds, SOUND_MAX_GAIN, SOUND_PREF };`)();
})() as {
  soundNotes(kind: string, i?: number): Note[];
  soundGate(last: Record<string, number>, kind: string, now: number): boolean;
  stepSound(r: unknown): string | null;
  finishSound(s: unknown): string;
  transitionSound(prev: unknown, next: unknown): string | null;
  readSoundOn(storage: Storage): boolean;
  saveSoundOn(storage: Storage, on: boolean): boolean;
  scheduleNotes(ctx: unknown, out: unknown, notes: Note[]): void;
  makeSounds(deps: { createContext: () => unknown; now: () => number; storage: Storage }): Sounds;
  SOUND_MAX_GAIN: number;
  SOUND_PREF: string;
};
const KINDS = ['etapa', 'deposito', 'tx', 'fim', 'erro', 'ligar'];
const length = (ns: Note[]) => Math.max(...ns.map((n) => n.at + n.dur));

// AudioContext falso: guarda cada osciladora (frequência, forma, quando começa e para) e cada mudança de volume
function fakeAudio(state = 'running') {
  const log = { oscillators: [] as { type: string; f: number[]; start: number; stop: number }[], gains: [] as [string, number, number][], resumed: 0, created: 0 };
  const param = (kind: string) => ({
    value: 0,
    setValueAtTime: (v: number, at: number) => log.gains.push([`${kind}:set`, v, at]),
    linearRampToValueAtTime: (v: number, at: number) => log.gains.push([`${kind}:linear`, v, at]),
    exponentialRampToValueAtTime: (v: number, at: number) => log.gains.push([`${kind}:exp`, v, at]),
  });
  const ctx = {
    state,
    currentTime: 10,
    destination: {},
    resume() { log.resumed++; return Promise.resolve(); },
    createBiquadFilter: () => ({ type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {} }),
    createGain: () => ({ gain: param('gain'), connect() {} }),
    createOscillator() {
      const o = { type: '', f: [] as number[], start: 0, stop: 0 };
      log.oscillators.push(o);
      return { set type(v: string) { o.type = v; }, frequency: { setValueAtTime: (v: number) => o.f.push(v) }, connect() {}, start: (at: number) => { o.start = at; }, stop: (at: number) => { o.stop = at; } };
    },
  };
  return { ctx, log, create: () => { log.created++; return ctx; } };
}
function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return { data, storage: (() => ({ getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } })) as Storage };
}
function player(opts: { state?: string; saved?: Record<string, string> } = {}) {
  const audio = fakeAudio(opts.state);
  const mem = memoryStorage(opts.saved);
  let clock = 0;
  const s = S.makeSounds({ createContext: audio.create, now: () => clock, storage: mem.storage });
  return { s, audio, mem, at: (ms: number) => { clock = ms; } };
}

test('sons: cada aviso tem notas finitas, graves a médias, curtas e baixas (nada estridente)', () => {
  for (const kind of KINDS) {
    for (const i of [0, 1, 2, 3, 7, -1, 1.5]) {
      const ns = S.soundNotes(kind, i);
      assert.ok(ns.length >= 1, `${kind}: sem nota`);
      for (const n of ns) {
        for (const k of ['f', 'at', 'dur', 'gain', 'attack'] as const) assert.ok(Number.isFinite(n[k]), `${kind}.${k} = ${n[k]}`);
        assert.ok(n.f >= 200 && n.f <= 1000, `${kind}: ${n.f} Hz fora de 200–1000 Hz`);
        assert.ok(n.gain > 0 && n.gain <= S.SOUND_MAX_GAIN && S.SOUND_MAX_GAIN <= 0.15, `${kind}: volume ${n.gain}`);
        assert.ok(n.dur >= 0.05 && n.dur <= 0.6, `${kind}: duração ${n.dur}`);
        assert.ok(n.at >= 0 && n.at < 0.6, `${kind}: começa em ${n.at}`);
        assert.ok(n.attack >= 0.003 && n.attack <= 0.02 && n.attack < n.dur, `${kind}: ataque ${n.attack}`);
        assert.ok(['sine', 'triangle'].includes(n.type), `${kind}: onda ${n.type}`);
      }
      assert.ok(length(ns) <= 0.9, `${kind}: dura ${length(ns)} s`);
    }
  }
  assert.deepEqual(S.soundNotes('outro'), [], 'evento desconhecido: silêncio');
});

test('sons: etapa sobe em dois tons curtos; fim é um arpejo subindo de 0,6 a 0,9 s; erro é grave e desce', () => {
  const etapa = S.soundNotes('etapa');
  assert.equal(etapa.length, 2);
  assert.ok(etapa[1].f > etapa[0].f && etapa[1].at > etapa[0].at && length(etapa) <= 0.4);
  const fim = S.soundNotes('fim');
  const melody = fim.filter((n) => n.type === 'triangle');
  assert.ok(melody.length >= 3 && melody.length <= 4, 'arpejo de 3 a 4 notas');
  for (let k = 1; k < melody.length; k++) assert.ok(melody[k].f > melody[k - 1].f && melody[k].at > melody[k - 1].at, 'cada nota mais alta e depois');
  assert.ok(length(fim) >= 0.6 && length(fim) <= 0.9, `fim dura ${length(fim)} s`);
  const erro = S.soundNotes('erro');
  assert.ok(erro.every((n) => n.f < 400) && erro[1].f < erro[0].f, 'erro grave e descendo');
  const tx = S.soundNotes('tx', 0);
  assert.equal(tx.length, 1);
  assert.ok(tx[0].dur <= 0.25 && tx[0].attack <= 0.01, 'envio: curto e com ataque rápido (pluck)');
});

test('sons: o "pluck" de cada envio varia a altura e repete o ciclo', () => {
  const fs = [0, 1, 2, 3, 4].map((i) => S.soundNotes('tx', i)[0].f);
  assert.ok(new Set(fs.slice(0, 4)).size >= 3, `pouca variação: ${fs}`);
  assert.equal(fs[4], fs[0], 'ciclo de 4');
});

test('sons: limite de rajada — envios no máximo 1 a cada 200 ms, o excedente é descartado (nunca enfileira)', () => {
  const last: Record<string, number> = {};
  const played = [];
  for (let ms = 0; ms < 1000; ms += 50) if (S.soundGate(last, 'tx', ms)) played.push(ms);
  assert.deepEqual(played, [0, 200, 400, 600, 800]);
  // depois da rajada, nada sobra para tocar: o próximo só toca se já passou o intervalo
  assert.equal(S.soundGate(last, 'tx', 850), false);
  assert.equal(S.soundGate(last, 'tx', 1000), true);
});

test('sons: limite de rajada — falhas seguidas tocam um grave só; volta a tocar depois de 4 s de calma', () => {
  const last: Record<string, number> = {};
  const played = [];
  for (let ms = 0; ms <= 10_000; ms += 1000) if (S.soundGate(last, 'erro', ms)) played.push(ms);
  assert.deepEqual(played, [0], 'uma falha por segundo durante 10 s = uma rajada');
  assert.equal(S.soundGate(last, 'erro', 14_500), true, '4,5 s depois da última falha: rajada nova');
  // tipos diferentes não se bloqueiam
  assert.equal(S.soundGate(last, 'fim', 14_600), true);
});

test('sons: só o envio de verdade toca; simulação, "nada a fazer" e modo desconhecido ficam quietos', () => {
  const statuses = ['simulado', 'enviado', 'falhou', 'cancelado', 'nada a fazer', 'desconhecido'];
  for (const status of statuses) assert.equal(S.stepSound({ modo: 'simulate', status }), null, `simulação: ${status}`);
  assert.equal(S.stepSound({ modo: 'execute', status: 'enviado' }), 'tx');
  assert.equal(S.stepSound({ modo: 'execute', status: 'nada a fazer' }), null);
  assert.equal(S.stepSound({ modo: 'execute', status: 'cancelado' }), null);
  assert.equal(S.stepSound({ modo: 'execute', status: 'falhou' }), 'erro');
  assert.equal(S.stepSound({ modo: 'execute', status: 'desconhecido' }), 'erro');
  for (const r of [null, undefined, {}, { status: 'enviado' }, { modo: 'outro', status: 'enviado' }]) assert.equal(S.stepSound(r), null, JSON.stringify(r));
});

test('sons: fim animado quando a rodada termina; grave se parou ou se nada foi enviado e algo falhou', () => {
  const r = (status: string) => ({ status });
  assert.equal(S.finishSound({ execResults: [r('enviado'), r('nada a fazer')], aborted: null }), 'fim');
  assert.equal(S.finishSound({ execResults: [r('enviado'), r('falhou')], aborted: null }), 'fim', 'algo chegou: fim');
  assert.equal(S.finishSound({ execResults: [r('nada a fazer')], aborted: null }), 'fim');
  assert.equal(S.finishSound({ execResults: [r('falhou'), r('cancelado')], aborted: null }), 'erro');
  assert.equal(S.finishSound({ execResults: [r('enviado')], aborted: 'parado' }), 'erro');
  assert.equal(S.finishSound(null), 'fim');
});

test('sons: troca de etapa só para a frente; redesenho, idioma e volta ficam quietos', () => {
  const v = (section: string, phase = 'analise') => ({ section, phase });
  assert.equal(S.transitionSound(null, v('s-preparo')), null, 'abrir a página não toca');
  assert.equal(S.transitionSound(v(undefined as unknown as string), v('s-preparo')), null, 'antes da 1ª tela não toca');
  assert.equal(S.transitionSound(v('s-frase'), v('s-preparo')), 'etapa', 'Começar');
  assert.equal(S.transitionSound(v('s-preparo', 'simulacao'), v('s-confirmar', 'pronto')), 'etapa', 'teste terminou');
  assert.equal(S.transitionSound(v('s-confirmar', 'pronto'), v('s-execucao', 'pronto')), 'etapa', 'envio começou');
  assert.equal(S.transitionSound(v('s-preparo', 'analise'), v('s-preparo', 'plano')), 'etapa', 'análise terminou');
  assert.equal(S.transitionSound(v('s-preparo', 'analise'), v('s-preparo', 'pendente')), 'etapa', 'análise terminou com pendência');
  assert.equal(S.transitionSound(v('s-preparo', 'plano'), v('s-preparo', 'erro')), 'erro', 'plano deu erro');
  assert.equal(S.transitionSound(v('s-preparo', 'plano'), v('s-preparo', 'simulacao')), null, 'plano → teste: mesmo passo narrado');
  assert.equal(S.transitionSound(v('s-preparo', 'espera'), v('s-preparo', 'plano')), null, 'o depósito tem som próprio');
  assert.equal(S.transitionSound(v('s-preparo', 'analise'), v('s-preparo', 'analise')), null, 'redesenho');
  assert.equal(S.transitionSound(v('s-confirmar', 'pronto'), v('s-confirmar', 'plano')), null, '"Aplicar" na Confirmar');
  assert.equal(S.transitionSound(v('s-confirmar', 'plano'), v('s-preparo', 'plano')), null, 'voltar à preparação');
  assert.equal(S.transitionSound(v('s-execucao', 'pronto'), v('s-frase', 'analise')), null, 'começar de novo');
});

test('sons: o contexto de áudio só nasce no gesto, uma vez; o tocador agenda as notas com envelope suave', () => {
  const p = player();
  assert.equal(p.audio.log.created, 0, 'criar o tocador não cria contexto');
  assert.equal(p.s.play('tx'), false, 'antes do gesto: quieto');
  p.s.unlock();
  p.s.unlock();
  assert.equal(p.audio.log.created, 1);
  assert.equal(p.s.play('fim'), true);
  const notes = S.soundNotes('fim');
  assert.equal(p.audio.log.oscillators.length, notes.length);
  assert.deepEqual(p.audio.log.oscillators.map((o) => o.f[0]), notes.map((n) => n.f));
  assert.equal(p.s.played.fim, 1);
  // envelope: começa em ~0, sobe até o pico no ataque, cai exponencialmente até ~0 no fim da nota; a osciladora para depois
  const g = p.audio.log.gains;
  for (let k = 0; k < notes.length; k++) {
    const [set, peak, decay] = g.slice(3 * k, 3 * k + 3);
    const start = 10.01 + notes[k].at;
    assert.equal(set[0], 'gain:set');
    assert.ok(set[1] <= 0.001 && Math.abs(set[2] - start) < 1e-9);
    assert.equal(peak[0], 'gain:linear');
    assert.ok(peak[1] <= S.SOUND_MAX_GAIN && Math.abs(peak[2] - (start + notes[k].attack)) < 1e-9);
    assert.equal(decay[0], 'gain:exp');
    assert.ok(decay[1] <= 0.001 && Math.abs(decay[2] - (start + notes[k].dur)) < 1e-9);
    assert.ok(p.audio.log.oscillators[k].stop > decay[2]);
  }
});

test('sons: volume acima do teto é cortado no agendamento', () => {
  const audio = fakeAudio();
  S.scheduleNotes(audio.ctx, {}, [{ f: 440, at: 0, dur: 0.2, gain: 0.9, type: 'sine', attack: 0.01 }]);
  const peak = audio.log.gains.find((x) => x[0] === 'gain:linear');
  assert.equal(peak?.[1], S.SOUND_MAX_GAIN);
});

test('sons: mudo não toca nada (nem cria contexto); ligar de novo grava e toca um tom curto', () => {
  const p = player({ saved: { [S.SOUND_PREF]: 'off' } });
  assert.equal(p.s.isOn(), false);
  p.s.unlock();
  assert.equal(p.audio.log.created, 0, 'mudo: sem contexto');
  for (const kind of KINDS) assert.equal(p.s.play(kind), false, kind);
  assert.equal(p.s.screen({ section: 's-frase', phase: 'analise' }), false);
  assert.equal(p.s.screen({ section: 's-preparo', phase: 'analise' }), false);
  assert.equal(p.audio.log.oscillators.length, 0);
  p.s.setOn(true);
  assert.equal(p.mem.data[S.SOUND_PREF], 'on');
  assert.equal(p.s.played.ligar, 1, 'religar toca a confirmação');
  p.s.setOn(false);
  assert.equal(p.mem.data[S.SOUND_PREF], 'off');
  const before = p.audio.log.oscillators.length;
  assert.equal(p.s.play('tx'), false);
  assert.equal(p.audio.log.oscillators.length, before, 'silenciado depois de tocar: para de vez');
});

test('sons: ligado por padrão; tela que anda para a frente toca uma vez, redesenho não repete', () => {
  const p = player();
  assert.equal(p.s.isOn(), true, 'sem preferência guardada: ligado');
  p.s.unlock();
  assert.equal(p.s.screen({ section: 's-frase', phase: 'analise' }), false, '1ª tela');
  p.at(1000);
  assert.equal(p.s.screen({ section: 's-preparo', phase: 'analise' }), true);
  for (let k = 0; k < 5; k++) assert.equal(p.s.screen({ section: 's-preparo', phase: 'analise' }), false, 'redesenho');
  assert.equal(p.s.played.etapa, 1);
});

test('sons: rajada real de envios pelo tocador — 20 passos em 1 s tocam 5, sem fila', () => {
  const p = player();
  p.s.unlock();
  let n = 0;
  for (let ms = 0; ms < 1000; ms += 50) { p.at(ms); if (p.s.play('tx')) n++; }
  assert.equal(n, 5);
  assert.equal(p.audio.log.oscillators.length, 5, 'só o que tocou foi agendado');
});

test('sons: sem Web Audio, contexto suspenso ou erro no meio, fica quieto sem lançar erro', () => {
  const none = S.makeSounds({ createContext: () => null, now: () => 0, storage: memoryStorage().storage });
  assert.doesNotThrow(() => none.unlock());
  assert.equal(none.play('fim'), false);
  const boom = S.makeSounds({ createContext: () => { throw new Error('sem áudio'); }, now: () => 0, storage: memoryStorage().storage });
  assert.doesNotThrow(() => { boom.unlock(); boom.setOn(true); });
  assert.equal(boom.play('fim'), false);
  const p = player({ state: 'suspended' });
  p.s.unlock();
  assert.equal(p.audio.log.resumed, 1, 'suspenso: pede para retomar no gesto');
  assert.equal(p.s.play('tx'), false, 'suspenso: não agenda (senão tocaria tudo junto ao retomar)');
  const broken = fakeAudio();
  broken.ctx.createOscillator = () => { throw new Error('quebrou'); };
  const q = S.makeSounds({ createContext: broken.create, now: () => 0, storage: memoryStorage().storage });
  q.unlock();
  assert.doesNotThrow(() => assert.equal(q.play('tx'), false));
});

test('sons: preferência com localStorage que lança erro — liga, não guarda e nada quebra', () => {
  const throwsGet: Storage = () => { throw new Error('SecurityError'); };
  const throwsItem: Storage = () => ({ getItem() { throw new Error('bloqueado'); }, setItem() { throw new Error('cheio'); } });
  for (const storage of [throwsGet, throwsItem]) {
    assert.equal(S.readSoundOn(storage), true);
    assert.equal(S.saveSoundOn(storage, false), false);
    const audio = fakeAudio();
    const s = S.makeSounds({ createContext: audio.create, now: () => 0, storage });
    assert.equal(s.isOn(), true);
    assert.doesNotThrow(() => s.setOn(false));
    assert.equal(s.isOn(), false, 'o clique vale nesta sessão mesmo sem guardar');
    assert.doesNotThrow(() => s.setOn(true));
    assert.equal(s.isOn(), true);
  }
  const mem = memoryStorage({ [S.SOUND_PREF]: 'on' });
  assert.equal(S.readSoundOn(mem.storage), true);
  mem.data[S.SOUND_PREF] = 'qualquer coisa';
  assert.equal(S.readSoundOn(mem.storage), true, 'valor estranho: ligado');
});

test('sons: a página chama o som nos pontos certos (passo enviado, fim da execução, erro, depósito, troca de tela)', () => {
  const passo = SCRIPT.slice(SCRIPT.indexOf("events.addEventListener('passo'"), SCRIPT.indexOf("events.addEventListener('pronto'"));
  assert.match(passo, /const sound = stepSound\(r\);[^\n]*\n\s*if \(sound\) sounds\.play\(sound\);/);
  const pronto = SCRIPT.slice(SCRIPT.indexOf("events.addEventListener('pronto'"), SCRIPT.indexOf("events.addEventListener('erro'"));
  assert.match(pronto, /if \(tarefa === 'execucao'\) \{[^\n]*renderExecFim\(\); sounds\.play\(finishSound\(state\)\); \}/);
  assert.doesNotMatch(fnSource('renderExecFim'), /sounds\./, 'o fim não toca ao redesenhar (idioma, recarregar)');
  const erro = SCRIPT.slice(SCRIPT.indexOf("events.addEventListener('erro'"), SCRIPT.indexOf('async function backToPrep('));
  assert.match(erro, /sounds\.play\('erro'\);/);
  const fundos = SCRIPT.slice(SCRIPT.indexOf("events.addEventListener('fundos'"), SCRIPT.indexOf("events.addEventListener('aviso'"));
  assert.match(fundos, /if \(next === 'simulate'\) \{[^}]*sounds\.play\('deposito'\);/);
  assert.match(fnSource('show'), /ui\.section = section;\s*\n\s*renderTitle\(\);\s*\n\s*sounds\.screen\(\{ section, phase: ui\.prep\.phase \}\);/);
  assert.match(fnSource('renderPrep'), /sounds\.screen\(\{ section: ui\.section, phase \}\);/);
  assert.match(SCRIPT, /for \(const type of \['pointerdown', 'keydown'\]\) document\.addEventListener\(type, \(\) => sounds\.unlock\(\), \{ capture: true \}\);/);
  assert.match(fnSource('rerender'), /renderSoundToggle\(\);/, 'trocar o idioma traduz o título do botão');
});

test('sons: botão no topo, ligado por padrão, com nome traduzido, ícone escondido do leitor e estado no aria-pressed', () => {
  const head = HTML.slice(HTML.indexOf('<header class="top">'), HTML.indexOf('</header>'));
  const b = head.match(/<button[^>]*id="snd-toggle"[^>]*>([\s\S]*?)<\/button>/);
  assert.ok(b, 'botão de som no cabeçalho (visível em todas as telas)');
  assert.match(b[0], /type="button"/);
  assert.match(b[0], /aria-pressed="true"/);
  assert.match(b[1], /<svg[^>]*aria-hidden="true"/);
  assert.match(b[1], /<span class="sr" data-i18n="pref.sound">/);
  const src = fnSource('renderSoundToggle');
  assert.match(src, /setAttribute\('aria-pressed', String\(on\)\)/);
  assert.match(src, /t\(on \? 'pref\.soundOn' : 'pref\.soundOff'\)/);
});

test('sons: textos do botão em português e inglês, diferentes entre si', () => {
  const start = HTML.indexOf('// i18n:inicio');
  const I18N = new Function(`${HTML.slice(start, HTML.indexOf('// i18n:fim'))}; return I18N;`)() as Record<'pt' | 'en', Record<string, unknown>>;
  for (const k of ['pref.sound', 'pref.soundOn', 'pref.soundOff']) {
    for (const lang of ['pt', 'en'] as const) assert.equal(typeof I18N[lang][k], 'string', `${lang}.${k}`);
    assert.notEqual(I18N.pt[k], I18N.en[k], k);
  }
  assert.notEqual(I18N.pt['pref.soundOn'], I18N.pt['pref.soundOff']);
});
