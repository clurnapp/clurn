# Clurn

[English](README.md) · **Português**

**Recupera o que ficou nas carteiras temporárias (burners) usadas para lançar moedas na Pump.fun.**

Você cola as frases de recuperação (até 10, do Solflare ou da Phantom). O Clurn encontra todas as burners de cada frase, mostra quanto dá para recuperar e não faz nada antes da sua confirmação. Depois fecha as contas vazias, queima o lixo, coleta as creator fees e manda tudo para **uma** carteira de destino que você escolhe.

Download oficial: [clurn.app](https://clurn.app) · Conta oficial: [@clurnapp](https://x.com/clurnapp)

## O que faz

| Encontrado nas burners | O que acontece |
| --- | --- |
| SOL solto | Vai para o destino |
| Conta de token vazia | Fechada; o aluguel (~0,002 SOL por conta) vai para o destino |
| Creator fees e cashback da Pump.fun | Coletados e enviados ao destino |
| Creator fees da Meteora DBC e do Raydium LaunchLab (pares em SOL) | Coletadas e enviadas ao destino |
| Memecoin sem valor | Queimada e fechada, só depois da sua confirmação |
| Token com valor de mercado | **Você escolhe:** enviar ao destino, queimar ou manter |
| Token sem preço conhecido | Aparece como "valor desconhecido", nunca como zero, e fica em "manter" |
| NFT | Só listado. Nunca é queimado |
| Saldos em Ethereum, Base, BSC, Arbitrum e Polygon da mesma frase | Só mostrados (leitura) |

A tela tem quatro etapas: **frases e destino → preparação → confirmar → envio**. O recibo final traz os totais, cada falha com o motivo e o link do Solscan de cada transação.

## Segurança

O app recebe a frase da sua carteira principal, por isso foi feito para ela não sair do seu computador:

- **A frase fica só na memória.** Nunca vai para servidor, arquivo, log ou armazenamento do navegador. O app roda em `127.0.0.1`, só aceita conexões do próprio computador e usa um código de acesso novo a cada abertura. Fechar a janela apaga as chaves.
- **A carteira principal nunca assina nada.** Só as burners ganham chave:
  - "Carteira Temporária" do Solflare: caminho `m/44'/501'/(N+10000)'/0'/0'`.
  - Phantom: as contas da frase, com a Conta 1 tratada como principal e deixada de fora.
- **Toda transação é simulada antes.** Se o resultado for diferente do plano, o app para e diz por quê.
- **O destino é conferido.** Você mesmo cola; o app nunca preenche. O plano só é montado para um endereço válido de uma carteira que já existe e não é uma das burners.
- **Uma conta com erro não derruba as outras.** Contas congeladas e tokens Token-2022 com restrição aparecem no recibo com o motivo.
- **Sem pacotes npm no app.** O código em `src/` usa só o próprio Node (`node:crypto` para BIP39, SLIP-0010 e ed25519). O Electron serve só para a janela do app.

**Tudo o que o app manda pela rede:** consultas e transações já assinadas para um RPC da Solana, preços para a Jupiter, consultas de saldo para RPCs públicos de outras redes e a procura de uma versão nova assinada nos Releases deste repositório. Nunca a frase nem as chaves.

### Atualizações

A partir da versão 1.0, o app de Windows se atualiza sozinho. Quando sai uma versão nova aqui, o app mostra "Atualizar agora". Ele só instala depois do seu clique, e só se o arquivo da versão estiver assinado com a chave de atualização do Clurn (Ed25519). Antes de instalar, confere o tamanho, o SHA-256 e a assinatura do instalador; o que não bate é apagado. As chaves públicas estão em [`src/app/atualizacao.ts`](src/app/atualizacao.ts).

## Taxa

O Clurn cobra **11% do SOL recuperado**, na mesma transação que entrega o SOL: 89% para o seu destino, 11% para a carteira do app `BniYdnbtcqxTfbGgAq3tCxCN2sHJGeiZKMLsX1jbL6GL`. Não há taxa sobre tokens ou NFTs enviados, nem sobre o SOL que você deposita para pagar as taxas de rede. A taxa aparece no resumo, na simulação e no recibo.

## Baixar e conferir

Baixe o `Clurn-Setup-<versão>.exe` só em [clurn.app](https://clurn.app) ou nos [Releases](https://github.com/clurnapp/clurn/releases) deste repositório, e confira o SHA-256 com o publicado lá. O instalador ainda não tem assinatura de código, então o SmartScreen do Windows mostra "O Windows protegeu o computador" na primeira vez; "Mais informações" → "Executar assim mesmo" abre. Ele instala só para o seu usuário, sem pedir administrador.

**Comece por uma frase de pouco valor** para ver como funciona.

## A partir do código

Precisa do [Node.js 24](https://nodejs.org/) ou mais novo.

```bash
git clone https://github.com/clurnapp/clurn.git
cd clurn
npm start          # abre o app no navegador (sem npm install)
npm test           # testes
```

App de desktop (Windows):

```bash
npm install        # Electron e o empacotador (só desenvolvimento, versões fixas)
npm run desktop    # abre a janela do app
npm run empacotar  # gera o instalador dist/Clurn-Setup-<versão>.exe e o SHA-256 (precisa do Inno Setup 6)
```

Por padrão o app usa o RPC público da Solana. Para usar o seu, defina `SOLANA_RPC_URL` antes de abrir.

## Estrutura

```text
src/core/      núcleo, sem tela: frases e derivação, transações da Solana, varredura, plano, execução, taxa
src/app/       app local: servidor em 127.0.0.1, tela (ui/index.html), recibo, atualizações
desktop/       janela do app (Electron)
src/cli/       comandos de terminal
test/          testes (node:test)
scripts/       empacotar, instalador, assinatura das atualizações, devnet e testes de tela
proxy/         proxy de RPC opcional (Cloudflare Worker): repassa consultas, nunca recebe frase
```

## Licença e segurança

Código disponível para leitura: dá para ler e auditar tudo. Veja [LICENCA.md](LICENCA.md). Para relatar uma falha de segurança, veja [SECURITY.md](SECURITY.md).
