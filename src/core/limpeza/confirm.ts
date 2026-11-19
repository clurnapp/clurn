// Confirmação final do destino: 4 caracteres SORTEADOS DO MEIO do endereço, mostrados na tela.
//
// O que protege: confirmação por engano/pressa (não dá para confirmar sem olhar o endereço inteiro)
// e digitação antecipada. O que NÃO protege: se o endereço colado já for o de um golpe de endereço
// parecido, a tela mostra o meio do falso e a pessoa digita esse meio (achado da sessão de
// segurança). O autor decidiu manter assim para não piorar a experiência (30/10/2026).
// A defesa contra esse golpe é o aviso quando o destino não é a carteira principal da frase.
// Maiúscula/minúscula não importa.

import { randomInt } from 'node:crypto';

export const CHALLENGE_LENGTH = 4;
const EDGE = 8; // longe do começo e do fim, que é o que os golpes copiam

export type Challenge = { start: number; end: number }; // índices no endereço, fim exclusivo

export function makeChallenge(destination: string, pick: (min: number, max: number) => number = randomInt): Challenge {
  if (destination.length < EDGE * 2 + CHALLENGE_LENGTH) throw new Error('endereço curto demais para confirmar');
  const start = pick(EDGE, destination.length - EDGE - CHALLENGE_LENGTH + 1);
  return { start, end: start + CHALLENGE_LENGTH };
}

export function challengeText(destination: string, c: Challenge): string {
  return destination.slice(c.start, c.end);
}

// Endereço com o trecho pedido entre colchetes, para o terminal.
export function markChallenge(destination: string, c: Challenge): string {
  return `${destination.slice(0, c.start)}[${destination.slice(c.start, c.end)}]${destination.slice(c.end)}`;
}

export function checkChallenge(typed: string, destination: string, c: Challenge): boolean {
  return typed.trim().toLowerCase() === challengeText(destination, c).toLowerCase();
}
