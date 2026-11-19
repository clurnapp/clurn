// Entrada de até 10 cartões: cada um é uma frase (valida o BIP39, marca duplicadas e deriva a seed das válidas) ou uma
// lista de chaves privadas coladas (src/core/carteiras/keys.ts), decidido pelo conteúdo quando a página manda 'auto'.
// O TEXTO nunca sai desta função: o resultado só leva a seed ou as chaves (bytes), o app e, se for o caso, o código do
// erro (que cita no máximo o número da linha e o do cartão).
// Não importa server.ts (o servidor é quem importa este arquivo): o erro sai como CodedError e a rota o converte.
import { validateMnemonic } from '../core/carteiras/bip39.ts';
import { mainAddresses, mnemonicToSeed, normalizeMnemonic, type WalletApp } from '../core/carteiras/derivation.ts';
import { looksLikeKeys, parseKeys, wipeParsedKeys, type ParsedKey } from '../core/carteiras/keys.ts';
import { CodedError, type ErrorCode, type ErrorParams } from '../core/limpeza/errors.ts';
import { FEATURES } from '../core/features.ts';

export const MAX_FRASES = 10;

// 'auto': o app descobre pela rede se a frase é Solflare, Phantom ou as duas (src/core/carteiras/detect.ts), e pelo
// conteúdo se o cartão é uma lista de chaves ('chaves'). A página só manda 'auto'; 'solflare' e 'phantom' seguem
// aceitos para quem chama a API direto (sempre como frase).
export type FraseApp = WalletApp | 'auto' | 'chaves';
// seed (frase) ou keys (chaves): no máximo um dos dois; os dois null quando o cartão tem erro
export type FraseInput = { n: number; seed: Buffer | null; keys: ParsedKey[] | null; app: FraseApp; error: { code: ErrorCode; params: ErrorParams } | null };

function isApp(x: unknown): x is FraseApp {
  return x === 'solflare' || x === 'phantom' || x === 'auto';
}

// chaves que colidem com a frase neste app: 'auto' cobre os dois apps, então bate com qualquer um
const dupKeys = (app: FraseApp, normalized: string) => (app === 'auto' ? ['auto', 'solflare', 'phantom'] : [app, 'auto']).map((a) => `${a}|${normalized}`);

export function parseFrases(raw: unknown): FraseInput[] {
  // mensagens sem dado do usuário (o texto técnico aparece em "detalhes")
  if (!Array.isArray(raw) || raw.length === 0) throw new CodedError('Nenhuma frase na lista.', 'seed-words', { words: 0 });
  if (raw.length > MAX_FRASES) throw new CodedError(`A lista tem ${raw.length} frases; o máximo é ${MAX_FRASES}.`, 'too-many-frases', { max: MAX_FRASES, count: raw.length });

  const firstOf = new Map<string, number>(); // app|frase normalizada → nº da primeira; só vive nesta chamada
  const out: FraseInput[] = [];
  raw.forEach((it, i) => {
    const n = i + 1;
    const fail = (app: FraseApp, code: ErrorCode, params: ErrorParams = {}): void => {
      out.push({ n, seed: null, keys: null, app, error: { code, params } });
    };
    const obj = typeof it === 'object' && it !== null ? (it as Record<string, unknown>) : {};
    if (typeof obj.texto !== 'string') return fail('solflare', 'seed-words', { words: 0 });
    if (!isApp(obj.carteira)) return fail('solflare', 'unknown');
    const app = obj.carteira;

    // lista de chaves (alguma linha com forma de chave): o parser aponta a 1ª linha ruim pelo número, sem eco.
    // Texto vazio não é lista de chaves: segue para a frase (erro de frase vazia, como antes).
    if (app === 'auto' && looksLikeKeys(obj.texto)) {
      // desligado na 1.0 (src/core/features.ts): recusa o cartão sem ler nenhuma chave
      if (!FEATURES.pastedKeys) return fail('chaves', 'keys-off');
      const r = parseKeys(obj.texto);
      if (!r.ok) return fail('chaves', r.code, r.params);
      out.push({ n, seed: null, keys: r.keys, app: 'chaves', error: null });
      return;
    }

    const check = validateMnemonic(obj.texto);
    if (!check.ok) return fail(app, check.code, check.params);

    // repetida = mesma frase no MESMO app (ou 'auto', que lê os dois); Solflare e Phantom da mesma frase não têm
    // carteira em comum (Solflare só no ramo 10000+, Phantom nunca assina a Conta 1)
    const normalized = normalizeMnemonic(obj.texto);
    const of = dupKeys(app, normalized).map((k) => firstOf.get(k)).find((x) => x !== undefined);
    if (of !== undefined) return fail(app, 'seed-duplicate', { of });
    firstOf.set(`${app}|${normalized}`, n);
    out.push({ n, seed: mnemonicToSeed(normalized), keys: null, app, error: null });
  });
  checkKeysAcrossCards(out);
  return out;
}

// Chaves contra os outros cartões da mesma lista (spec 2026-11-06 §4.1):
// - chave da conta principal de uma frase da lista (Conta 1 da Phantom/Solflare, conta 0 da Trust): 'key-is-main';
// - chave que já está num cartão de chaves anterior: 'key-duplicate' com `of`.
// O cartão recusado perde as chaves na hora (bytes zerados); o erro só cita a linha e o número do outro cartão.
function checkKeysAcrossCards(out: FraseInput[]): void {
  const mains = new Map<string, number>(); // endereço da principal → nº da frase
  for (const x of out) if (x.seed) for (const a of mainAddresses(x.seed)) if (!mains.has(a)) mains.set(a, x.n);
  const firstCard = new Map<string, number>(); // endereço de chave → nº do primeiro cartão que a trouxe
  for (const x of out) {
    if (!x.keys) continue;
    let error: FraseInput['error'] = null;
    for (const k of x.keys) {
      const main = mains.get(k.address);
      if (main !== undefined) {
        error = { code: 'key-is-main', params: { line: k.line, of: main } };
        break;
      }
      const of = firstCard.get(k.address);
      if (of !== undefined) {
        error = { code: 'key-duplicate', params: { line: k.line, of } };
        break;
      }
    }
    if (error) {
      wipeParsedKeys(x.keys);
      x.keys = null;
      x.error = error;
      continue;
    }
    for (const k of x.keys) firstCard.set(k.address, x.n);
  }
}
