// Defesas do destino que não pioram a experiência de quem colou certo (aprovadas pelo autor, 30/10/2026).
//
// Golpe de "endereço parecido" (address poisoning): o golpista manda uma transação de valor zero de um
// endereço que começa e termina igual a uma carteira da pessoa, para ela copiar o falso do histórico.
// O app conhece as contas da frase (calcula sozinho), então dá para reconhecer a imitação.

export const KNOWN_ACCOUNTS = 10; // contas comuns 1 a 10 da frase (Solflare/Phantom)
const EDGE = 4;

export type KnownWallet = { index: number; label: string; address: string }; // index: 0 = Conta 1

export function knownWallets(addresses: string[]): KnownWallet[] {
  return addresses.map((address, index) => ({ index, label: `Conta ${index + 1}`, address }));
}

// Mesmos 4 primeiros e 4 últimos caracteres de uma carteira da pessoa, mas endereço diferente.
export function imitatedWallet(destination: string, known: KnownWallet[]): KnownWallet | null {
  for (const k of known) {
    if (destination === k.address) continue;
    if (destination.slice(0, EDGE) === k.address.slice(0, EDGE) && destination.slice(-EDGE) === k.address.slice(-EDGE)) return k;
  }
  return null;
}

export function imitationMessage(destination: string, k: KnownWallet): string {
  return (
    `Este endereço IMITA a sua ${k.label}: começa e termina igual, mas o meio é diferente. ` +
    `É o golpe de "endereço parecido". Não envio para ele.\n` +
    `  colado: ${destination}\n` +
    `  sua:    ${k.address}\n` +
    'Use o botão "usar minha carteira principal" ou copie o endereço direto do seu Solflare/Phantom.'
  );
}
