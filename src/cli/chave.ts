// Mostra a CHAVE PRIVADA de UMA temporária, para movimentar algo nela manualmente (ex.: USDC).
//
//   npm run chave            (pede a frase e o número N da temporária)
//
// Prefira o caminho do Solflare, que não expõe chave nenhuma:
//   Solflare → Frase de recuperação → "Reativar carteira temporária" → ela aparece como "Used burner N".
//
// A chave aparece UMA vez na tela. Não é gravada em arquivo nem em log.

import { parseArgs } from 'node:util';
import { ask, closeInput, line, readMnemonic, UserError } from './io.ts';
import { encodeBase58 } from '../core/solana/base58.ts';
import { burnerPath, derivePrivateKey, mnemonicToSeed, mnemonicWordCount, publicKeyFromPrivate } from '../core/carteiras/derivation.ts';

async function main() {
  const { values } = parseArgs({ options: { 'seed-file': { type: 'string' }, debug: { type: 'boolean', default: false } } });
  line('━');
  console.log('EXPORTAR A CHAVE DE UMA CARTEIRA TEMPORÁRIA');
  console.log('Quem tiver essa chave controla a temporária. Só continue se for você, no seu computador, sem compartilhar a tela.');
  console.log('Alternativa sem expor chave: Solflare → Frase de recuperação → "Reativar carteira temporária" → "Used burner N".');
  line('━');

  const mnemonic = await readMnemonic({ seedFile: values['seed-file'], publicTest: false });
  if (![12, 15, 18, 21, 24].includes(mnemonicWordCount(mnemonic))) throw new UserError('A frase precisa ter 12 ou 24 palavras.');
  const n = Number((await ask('Número N da temporária (o mesmo do relatório / "Used burner N"): ')).trim());
  if (!Number.isInteger(n) || n < 0 || n > 100_000) throw new UserError('Número inválido.');

  const seed = mnemonicToSeed(mnemonic);
  const priv = derivePrivateKey(seed, burnerPath(n));
  seed.fill(0);
  try {
    const pub = publicKeyFromPrivate(priv);
    console.log(`\nTemporária N=${n}: ${encodeBase58(pub)}`);
    console.log('Confira se é o endereço onde está o que você quer movimentar.');
    const ok = await ask('Para MOSTRAR a chave privada desta temporária, digite MOSTRAR (qualquer outra coisa cancela): ', { fresh: true });
    if (ok.trim() !== 'MOSTRAR') {
      console.log('Cancelado. Nenhuma chave foi mostrada.');
      return;
    }
    // formato aceito por Solflare/Phantom em "Importar chave privada": base58 de 64 bytes (privada + pública)
    const secret = Buffer.concat([priv, pub]);
    console.log(`\nCHAVE PRIVADA (N=${n}):\n${encodeBase58(secret)}\n`);
    secret.fill(0);
    console.log('No Solflare: Adicionar carteira → Importar existente → Chave privada.');
    console.log('Depois de copiar, limpe a tela (comando cls) e a área de transferência.');
  } finally {
    priv.fill(0);
  }
}

if (import.meta.main) {
  main()
    .finally(closeInput)
    .catch((e) => {
      if (e instanceof UserError) console.error(`\nErro: ${e.message}`);
      else console.error('\nErro inesperado (detalhe omitido por segurança).');
      process.exit(1);
    });
}
