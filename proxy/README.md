# Proxy de RPC do Clurn (Cloudflare Workers)

Tira a chave do Helius de dentro do `.exe`. O app chama o proxy em `https://rpc.clurn.app/`; o proxy confere o pedido e repassa ao Helius com a chave, que fica só num secret do Workers. Item B1 de `docs/lancamento-publico.md`.

**Rodízio de chaves.** O secret `UPSTREAM_URLS` guarda várias URLs, uma por linha, na ordem de uso. O proxy usa a primeira que não está pausada. Se ela responde "sem crédito" (HTTP 429 com `max usage`) ou "chave recusada" (401/403), fica pausada por `PAUSA_CHAVE_MIN` (60 min) e o **mesmo pedido** segue na seguinte: o app não percebe. Vencida a pausa, um pedido de verdade testa a chave de novo (quando o Helius renovar, ela volta sozinha). 429 comum (limite por segundo de uma conta) passa à seguinte sem pausar. Tempo esgotado não passa, porque o Helius lento vale para todas e somar prazos travaria o app. Todas sem crédito: 429 `max usage reached`, e o app usa o RPC público até a próxima rodada. As pausas ficam no Durable Object pelo hash da URL (`upstreamId`), nunca pela chave.

**Escrito e testado no Node (`npm test`, `test/proxy/`). No ar em `rpc.clurn.app` desde 16/11/2026.**

## O que ele faz e o que não faz

- Recebe só `POST /` com `content-type: application/json` e o cabeçalho `x-clurn-versao: a.b.c` (o app se identifica; não é segredo nem trava contra quem copia o cabeçalho).
- Aceita objeto JSON-RPC ou lote de até 10 itens, corpo de até 64 KiB.
- Deixa passar só os 13 métodos que o app chama (`ALLOWED_METHODS` em `worker.ts`; um teste confere a lista contra o código de `src/`): `getAccountInfo`, `getBlockHeight`, `getGenesisHash`, `getLatestBlockhash`, `getMinimumBalanceForRentExemption`, `getMultipleAccounts`, `getProgramAccounts`, `getRecentPrioritizationFees`, `getSignatureStatuses`, `getSignaturesForAddress`, `getTokenAccountsByOwner`, `sendTransaction`, `simulateTransaction`. Um lote com um método fora da lista é recusado inteiro.
- Cotas: 15 requisições por segundo por IP (o app manda no máximo 8), 6.000 créditos por IP por dia, 15.000 créditos por hora no total e 120.000 por dia no total (UTC). Créditos como o Helius cobra: `getProgramAccounts` vale 10 e o resto 1. No IPv6 conta o prefixo /48. Os números estão justificados em "Por que estes limites".
- Repassa ao Helius o pedido **reescrito** a partir do que foi conferido (só `jsonrpc`, `id`, `method` e `params`), com prazo de 25 s, e devolve status e corpo do Helius como vieram. O conteúdo é o mesmo; os bytes podem mudar (espaços, ordem das chaves). Assim, chave repetida (`"method":"requestAirdrop","method":"getLatestBlockhash"`) ou chave extra não chega ao Helius: o upstream só vê o método que passou na lista. `params` precisa ser lista, e número que não sobrevive à reescrita (inteiro acima de 2^53) é recusado. O Helius não vê IP nem cabeçalho do usuário. Se o Helius ecoar a URL ou a chave numa resposta, elas viram `[rpc]`.
- **Nunca recebe frase nem chave privada.** O app assina no computador da pessoa; aqui passam consultas e transações já assinadas. O corpo tem endereços e transações das temporárias. Por isso o proxy não grava log: o código não tem nenhuma linha de log, e o `wrangler.toml` desliga os logs do Workers (`[observability] enabled = false`).
- Sem CORS: o app chama do processo Node local (`src/core/solana/rpc.ts`), não do navegador. A página do app só fala com o próprio servidor (`connect-src 'self'`). Página de outro site não consegue usar o proxy: o navegador manda o pré-voo (OPTIONS), e o proxy responde 405 sem cabeçalho CORS.

Como o app entende cada resposta (ele já trata esses códigos hoje):

| Situação | Resposta | O app |
| --- | --- | --- |
| Limite por segundo | HTTP 429, `Retry-After: 1`, `-32005` | espera e repete |
| Cota do dia (do IP ou global) ou teto da hora | HTTP 429, `-32005` com "max usage reached", `Retry-After` até a virada | não repete e passa na hora para o próximo RPC da lista (como faz com a chave do Helius esgotada); a próxima rodada tenta o proxy de novo |
| Helius fora do ar ou lento | HTTP 502 ou 504 | repete algumas vezes e depois passa para o próximo |
| Método fora da lista | HTTP 200, `-32601` | a conferência do começo recusa o proxy e o app usa o próximo |
| Todas as chaves sem crédito | HTTP 429, `-32005` com "max usage reached", `Retry-After` = a pausa | passa para o RPC público |
| Proxy sem nenhuma URL válida ou contador fora do ar | HTTP 503 | o mesmo que Helius fora do ar (falha fechada: nada é repassado sem contar) |

No app, a ordem fica: `SOLANA_RPC_URL` → **proxy** → chaves embutidas (se houver) → RPC público da Solana.

## O que continua possível (risco aceito)

- A URL do proxy fica legível no `.exe`, como qualquer endereço. Quem a extrair pode usar os 13 métodos, mas só dentro das cotas por IP. A chave do Helius não sai.
- Quem tiver muitos IPs consegue gastar o teto. Para levar a hora são precisos ~4 IPs no limite; para levar o dia, ~25 IPs, ou rajadas sustentadas por 8 horas (o teto da hora não deixa uma rajada só gastar mais que 1/8 do dia). Nesse caso o proxy recusa todo mundo até a virada, e o app cai para o RPC público (mais lento, mas segue). A conta do Helius nunca passa do `TETO_DIA`.
- `sendTransaction` aceita transação de qualquer pessoa (1 crédito cada, dentro das cotas). O proxy não tem como saber se a transação é do Clurn.
- Uma consulta `getProgramAccounts` sem filtro custa 10 créditos e conta 10 na cota. O Helius recusa as grandes, e a do app (a da Pump.fun) ele já recusa hoje. O app então faz essa busca pelo RPC público (`src/core/solana/gpa-fallback.ts`), e a recusa do Helius passa pelo proxy sem mudança para o app reconhecer.

## Por que estes limites

Revisão de segurança de 09/11/2026. Antes eram 60.000 créditos por IP e 300.000 por dia, ou seja, 5 IPs (fáceis de trocar) gastavam o dia de todos.

Quanto o app gasta, pelo que já foi medido em `docs/aprendizados.md` (não rodei nada na mainnet para isto):
- análise com RPC próprio: **~4,9 créditos por carteira**, e fluxo completo (análise + simulação + envio) **~38,9 por carteira** (entrada de 31/10/2026, "o Helius recusava a busca das moedas"; a busca das moedas vai pelo RPC público e não gasta crédito);
- descoberta das temporárias: ~180 requisições por frase (`discoveryReqPerFrase`, `src/app/eta.ts`);
- uma frase de 100 temporárias no fluxo completo: 180 + 100 × 38,9 ≈ **4.100 créditos**; só a análise: 180 + 100 × 4,9 ≈ 670.

| Limite | Valor | Por quê |
| --- | --- | --- |
| `LIMITE_IP_DIA` | 6.000 créditos | ~1,5 frase de 100 temporárias limpa por dia por casa, ou ~9 análises. O teto do dia só acaba com 20 IPs no limite. Quem limpa mais que isso num dia cai para o RPC público no meio, sem parar, ou usa a própria `SOLANA_RPC_URL`. |
| `TETO_HORA` | 15.000 créditos (`TETO_DIA`/8) | Uma rajada de muitos IPs leva no máximo 1/8 do dia, não o dia inteiro. Dá ~3,5 frases de 100 limpas por hora para todo mundo junto. Sem a variável, vale `TETO_DIA`/8. |
| `TETO_DIA` | 120.000 créditos | 16/11/2026: as chaves do Helius somam ~3,7 milhões por mês (~123 mil por dia). Um abuso não leva o mês num dia. Com o Helius pago, suba (Developer: 10 milhões/mês, ~333 mil/dia). |
| `LIMITE_IP_SEGUNDO` | 15 requisições | O app manda no máximo 8 por segundo. A folga é para dois apps na mesma casa. |
| IPv6 | prefixo /48 | Um provedor entrega a uma casa de /64 a /48 (RFC 6177). Contando por /64, quem recebe um /48 teria 65 mil cotas só trocando o 4º bloco. |

Depois do lançamento, ajuste olhando o painel do Helius: se o teto da hora recusa gente de verdade (muitos 429 nas métricas em horário de pico), suba `TETO_HORA` e mantenha a soma do dia.

## Arquivos

- `worker.ts`: o pedido (validação, cotas, repasse). Roda no Workers e no Node.
- `cotas.ts`: o contador (Durable Object `Cotas`).
- `entrada.ts`: a entrada do Workers (`main` do `wrangler.toml`). Só liga as duas peças. Importa `cloudflare:workers`, que não existe no Node, por isso não tem lógica.
- `wrangler.toml`: nome, Durable Object, limites. Nada secreto.

TypeScript direto: o wrangler compila `.ts` sozinho, e o Node 24 roda os mesmos arquivos nos testes. Sem dependência npm.

## Por que um Durable Object para as cotas

Comparei as três opções do Workers (documentação consultada em 09/11/2026):

| Opção | Serve? | Por quê |
| --- | --- | --- |
| Rate Limiting binding | Não sozinho | Só conta janelas de 10 ou 60 s, e a contagem é aproximada e separada por local da Cloudflare. Não faz o "por dia" nem o teto global, que é o que protege a fatura. A página dele não cita preço. [Doc](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) |
| KV | Não | O plano grátis aceita 1.000 escritas por dia. Não dá para contar requisição por requisição. |
| Durable Object (SQLite) | Sim | Um contador só, exato, guardado. Entra no plano grátis (só o tipo SQLite). |

Um objeto só (`global`) conta tudo na memória e grava a cada 2 s (alarme). Se o objeto reiniciar, perde no máximo os últimos 2 s de contagem. Um objeto aguenta, pela Cloudflare, perto de mil pedidos por segundo. Isso dá cerca de 100 apps rodando juntos a 8 req/s. Se um dia passar disso, divida o contador por IP.

## Quanto custa

Preços da [página oficial de preços do Workers](https://developers.cloudflare.com/workers/platform/pricing/), conferida em 09/11/2026. Mudam, confira de novo antes de assinar.

| | Grátis | Workers Paid (US$ 5/mês por conta) |
| --- | --- | --- |
| Pedidos ao Worker | 100.000/dia | 10 milhões/mês, depois US$ 0,30 por milhão |
| CPU | 10 ms por pedido | 30 milhões de ms/mês, depois US$ 0,02 por milhão de ms |
| Pedidos ao Durable Object | 100.000/dia | 1 milhão/mês, depois US$ 0,15 por milhão |
| Tempo do Durable Object | 13.000 GB-s/dia | 400.000 GB-s/mês, depois US$ 12,50 por milhão de GB-s |
| Linhas gravadas (SQLite) | 100.000/dia | 50 milhões/mês, depois US$ 1,00 por milhão |

Cada pedido do app vira 1 pedido ao Worker e 1 ao Durable Object.

Estimativa com os números do app (`src/app/eta.ts`: cerca de 3 requisições por carteira na análise, 14 na simulação e 20 no envio, ou seja, cerca de 37 por carteira no fluxo completo):

- **Grátis:** 100 mil por dia dá cerca de 2.700 carteiras por dia, umas 27 frases de 100 temporárias. Os 5 amigos gastaram cerca de 725 mil créditos em poucos dias, então com público o grátis acaba no primeiro dia. Passou do limite, o Workers responde erro, e o app cai para o RPC público. Não para, só fica mais lento.
- **Paid:** com 10 milhões de pedidos por mês, são US$ 5 + cerca de US$ 1,35 de Durable Object (9 milhões além do incluído). O tempo do objeto, ligado o mês todo, fica perto de 330 mil GB-s, dentro dos 400 mil incluídos. Total de cerca de **US$ 6 a 7 por mês** na Cloudflare. Estimativa, não medição.
- **Helius Developer:** US$ 49/mês, 10 milhões de créditos, 50 req/s ([planos](https://www.helius.dev/docs/billing/plans), [créditos por método](https://www.helius.dev/docs/billing/credits), conferidos em 09/11/2026).

## Como publicar

O `wrangler` é a ferramenta oficial da Cloudflare. Não entra no `package.json`: roda por `npx` com a versão fixa, a mesma do site (`wrangler@4.151.3`, `wrangler.jsonc` na raiz). Comandos dentro de `proxy/`.

1. **Entrar na conta** (uma vez por computador; abre o navegador): `npx wrangler@4.151.3 login`.
2. **Pôr as chaves** antes do primeiro deploy (o wrangler pede o valor, que não aparece na tela nem fica no histórico; uma URL completa do Helius por linha, na ordem de uso):

   ```sh
   npx wrangler@4.151.3 secret put UPSTREAM_URLS
   ```

   Ou a partir das variáveis do Windows, sem a chave passar pela tela: um script lê `CLURN_RPC_URL`, `_2`, `_3`… e manda pela entrada padrão do `secret put`.
3. **Publicar:** `npx wrangler@4.151.3 deploy`. O `wrangler.toml` liga `rpc.clurn.app` como domínio próprio (o DNS do `clurn.app` já está na Cloudflare) e desliga o `workers.dev`. Sem chave válida, o proxy responde 503 (falha fechada) e o app usa o próximo RPC.
4. **Conferir** (1 crédito):

   ```sh
   curl -s -X POST https://rpc.clurn.app/ -H "content-type: application/json" -H "x-clurn-versao: 1.0.0" -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getGenesisHash\"}"
   ```

   O esperado é `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` (mainnet). Sem o `x-clurn-versao` a resposta é 403. Com `"method":"requestAirdrop"` a resposta é `-32601`.
5. **Empacotar o app com o proxy e sem chave dentro** (PowerShell, no terminal do empacotamento):

   ```powershell
   $env:CLURN_PROXY_URL = 'https://rpc.clurn.app/'
   Remove-Item Env:CLURN_RPC_URL, Env:CLURN_RPC_URL_2, Env:CLURN_RPC_URL_3, Env:CLURN_RPC_URL_4 -ErrorAction SilentlyContinue
   npm run empacotar
   ```

   A saída diz "só o proxy; nenhuma chave dentro do app". Com alguma `CLURN_RPC_URL` definida, a chave volta para dentro do `.exe`.
6. **Teste de ponta a ponta:** uma análise na mainnet com uma frase de pouco valor. Depois, o limite estourado: `LIMITE_IP_DIA = "50"` no `wrangler.toml`, `deploy`, analise; o app deve passar sozinho para o RPC público. Volte o valor e `deploy`. Registre em `docs/aprendizados.md`.

## Trocar, pôr ou tirar chaves

`npx wrangler@4.151.3 secret put UPSTREAM_URLS` com a lista nova inteira (o secret é substituído). Vale na hora para todos os apps, sem atualizar nada. Uma chave tirada da lista sai do rodízio; uma nova entra na posição em que foi posta. Troque se o gasto subir sem explicação ou se uma chave aparecer em algum lugar.

## Mudar os limites

Edite `[vars]` no `wrangler.toml` e rode `npx wrangler@<versão> deploy`. O app não muda. `VERSAO_MINIMA = "0.3.0"` recusa apps mais velhos (por exemplo, versão com defeito conhecido): eles caem para o RPC público.

## Ver o uso sem ver os dados

- **Painel do autor (`npm run admin`, `scripts/painel-admin.ts`):** página só no seu computador que junta a carteira da taxa (blockchain), o `GET /stats` deste proxy, os downloads dos Releases e a saúde do proxy, do site e do arquivo de versão assinado. O `/stats` devolve só números por dia UTC (pedidos, créditos, IPs distintos como contagem, itens por método, versões do app, recusas por motivo, eventos do Helius) e as chaves pela posição. Para ligar:

  ```sh
  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
  npx wrangler@4.151.3 secret put STATS_TOKEN --config proxy/wrangler.toml
  ```

  Feito em 16/11/2026: o token fica em `%USERPROFILE%.clurn-adminstats-token` (fora do repositório; o painel lê sozinho) e foi para o secret direto do arquivo, sem aparecer na tela. Para trocar: gere outro nesse arquivo e rode `npx wrangler@4.151.3 secret put STATS_TOKEN --config proxy/wrangler.toml < %USERPROFILE%.clurn-adminstats-token`. A variável `CLURN_STATS_TOKEN` do terminal, se definida, vale antes do arquivo. Sem `STATS_TOKEN` (ou com menos de 32 caracteres), o `/stats` responde 404 como qualquer caminho desconhecido. Troque o token se ele aparecer em algum lugar: `secret put` de novo vale na hora.
- **Cloudflare:** *Workers & Pages → clurn-rpc → Metrics* mostra pedidos, erros e tempo, sem conteúdo. O Durable Object `Cotas` tem métricas próprias na mesma tela. Respostas 429 são as cotas funcionando.
- **Helius:** o painel de cada conta mostra os créditos gastos dela. O painel de créditos do app não lê o saldo do proxy (a chave não está no app).
- Não ligue `observability` nem rode `wrangler tail` sem necessidade. O tail mostra cada pedido ao vivo com cabeçalhos e IP (o corpo não aparece, porque o proxy não loga).

## Testes

`npm test` roda `test/proxy/` junto com o resto. Cobrem método fora da lista, lote com um proibido, corpo e lote grandes, JSON inválido, cada cota estourada, upstream fora do ar e lento, resposta repassada sem mudança, segredo que não aparece, sem CORS e o app (`createRpc` e `checkRpc`) conversando com o proxy. Contra-teste de 09/11/2026: cada regra desligada derruba algum teste (lista em `docs/aprendizados.md`).
