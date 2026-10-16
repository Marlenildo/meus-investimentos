# Meus Investimentos

App para montar a compra do mês na bolsa: quanto tenho para investir (aporte + proventos do mês anterior), quanto custa cada ativo agora, quantas cotas comprar de cada um e quanto isso dá no total, já com os custos do banco.

As compras continuam sendo feitas no app do banco (Nubank, BB, Bradesco etc.). Depois de comprar, você registra aqui e acompanha a carteira.

Roda na Cloudflare (grátis): o site, uma API e um banco de dados D1 onde ficam ativos, compras, proventos e ajustes. Abre igual no celular e no computador.

## O que tem

- **Comprar** — aporte do mês + proventos do mês anterior = disponível. Lista dos seus ativos com preço atual, botões − / + para as cotas, botão **MÁX** que enche com o que falta, total por ativo e barra mostrando quanto falta (ou quanto passou). Mostra o custo da compra no banco escolhido e compara com os outros bancos. As cotações se atualizam sozinhas a cada 5 minutos com a tela aberta.
- **Carteira** — cotas, preço médio, investido, valor hoje, resultado e proventos por ativo; gráfico de aportes por mês; histórico de compras.
- **Proventos** — lança dividendos, JCP, rendimentos de FII e juros. O total do mês anterior entra sozinho no aporte.
- **Ajustes** — aporte padrão, lista de ativos, custos por banco, backup e status da nuvem.

## Colocar no ar na Cloudflare (uma vez só)

1. **Crie uma conta grátis** em <https://dash.cloudflare.com/sign-up>.
2. **Conecte este repositório:** no painel, vá em **Workers & Pages → Create application → Import a repository**, autorize o GitHub e escolha `meus-investimentos`. Na tela de configuração deixe:
   - Project name: `meus-investimentos`
   - Build command: *(vazio)*
   - Deploy command: `npx wrangler deploy`

   Clique em **Deploy**. No primeiro deploy a Cloudflare cria sozinha o banco D1 `meus-investimentos`.
3. **Defina sua senha:** abra o Worker → **Settings → Variables and Secrets → Add**. Tipo **Secret**, nome `SENHA`, valor = a senha que você quer usar no app. Salve.
4. **Abra o app** no endereço que aparece no painel (algo como `https://meus-investimentos.SEU-USUARIO.workers.dev`), digite a senha e pronto. No celular, use "Adicionar à tela inicial".

Daí em diante, cada mudança enviada para a branch `main` publica sozinha.

**Se o passo 2 der erro sobre o banco D1:** vá em **Storage & Databases → D1 → Create database**, nome `meus-investimentos`, copie o **Database ID** e coloque em `wrangler.jsonc`, na linha do `d1_databases`: `"database_id": "o-id-copiado"`. Depois rode o deploy de novo (botão **Retry build** ou um novo commit).

### Opcional

- `BRAPI_TOKEN` (Secret): token grátis da brapi.dev, usado só como reserva se o Yahoo falhar.

## Cotações

Nenhuma fonte grátis dá o preço da B3 em tempo real — a B3 cobra por isso. O app usa o **Yahoo Finance pelo Worker** (atraso de ~15 min, o mesmo do Google Finance) e a **brapi** como reserva. O horário mostrado embaixo de cada preço é o do último negócio recebido. Para o preço exato do momento, toque no preço e digite o que o app do banco mostra; na hora de registrar a compra você também corrige para o preço da nota.

Tesouro Direto não tem cotação automática: copie o preço de compra do [site do Tesouro](https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm).

## Custos considerados (referência de out/2026 — confira no seu banco)

- Corretagem: zero na maioria dos bancos pelo app; BTG a partir de R$ 4,50 por ordem. Editável em Ajustes.
- B3 em ações/FIIs/ETFs: 0,03% do valor (0,025% liquidação + 0,005% negociação).
- Tesouro Direto: sem taxa na compra; custódia B3 de 0,20% ao ano, com Tesouro Selic isento até R$ 10 mil.

## Dados e segurança

- Ficam no seu banco D1, na sua conta Cloudflare. Plano grátis: 5 GB e 100 mil gravações por dia — sobra muito.
- A API só responde com a senha (`SENHA`). Use uma senha forte: o endereço `workers.dev` é público.
- O navegador guarda uma cópia para abrir rápido e funcionar sem internet; as alterações feitas offline são enviadas quando a conexão volta.
- **Ajustes → Exportar backup** gera um arquivo JSON com tudo. **Importar** substitui tudo, aqui e na nuvem.
- Aberto sem o Worker (por exemplo, `index.html` direto), o app funciona só no navegador.

## Desenvolver

```bash
npm install
echo "SENHA=teste" > .dev.vars
npm run dev          # http://localhost:8787, com D1 local
```

## Estrutura

```
wrangler.jsonc        configuração da Cloudflare (Worker, site, D1)
src/worker.js         API: senha, dados no D1, cotações (Yahoo + brapi)
public/index.html     página
public/styles.css     visual (tema claro e escuro)
public/js/app.js      telas e interação
public/js/calc.js     cálculos (custos, MÁX, carteira, proventos)
public/js/store.js    dados no navegador, bancos de referência, backup
public/js/nuvem.js    conversa com a API e fila de envio
public/js/cotacoes.js busca de preços
```
