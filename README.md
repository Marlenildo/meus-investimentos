# Meus Investimentos

App para montar a compra do mês na bolsa: quanto tenho para investir (aporte + proventos do mês anterior), quanto custa cada ativo agora, quantas cotas comprar de cada um e quanto isso dá no total, já com os custos do banco.

As compras continuam sendo feitas no app do banco (Nubank, BB, Bradesco etc.). Depois de comprar, você registra aqui e acompanha a carteira.

Roda na Cloudflare (grátis): o site, uma API e um banco de dados D1 onde ficam ativos, compras, proventos e ajustes. Abre igual no celular e no computador.

## O que tem

- **Comprar (tela inicial)** — resumo da carteira; aporte do mês + proventos do mês anterior = disponível. Cada ativo mostra quanto você já tem (cotas, preço médio, valor e resultado), o preço atual e os botões − / + / **MÁX** para montar a compra, com o total ao lado. Adicione ou tire ativos ali mesmo. Depois de comprar no banco, **Comprei — registrar** e as cotas entram na carteira. Cotações se atualizam sozinhas a cada 5 minutos.
- **Histórico** — totais, posição por ativo, gráfico de aportes por mês (com ou sem as taxas) e lista de compras. Cada compra pode ser **editada** (data, cotas, preço pago, taxas e banco): ao escolher a data, o app mostra o fechamento e a faixa de preço daquele pregão, com um toque para usar.
- **Proventos** — lança dividendos, JCP, rendimentos de FII e juros. Resumo por ano com a divisão por tipo e por ativo; cada provento pode ser editado. O total do mês anterior entra sozinho no aporte.
- **Simular** — "e se eu tivesse aportado R$ X no 1º dia útil de cada mês desde tal mês?". Monte até duas carteiras (por exemplo, meio a meio BBAS3 e PETR4 contra 100% Tesouro Selic) e compare valor de hoje, ganho, proventos e a evolução mês a mês. Vale para ações, FIIs, ETFs e BDRs (histórico diário e proventos do Yahoo, só cotas inteiras, com as taxas da B3), Tesouro Selic, IPCA+ e Prefixado, CDB e LCI/LCA em % do CDI (taxas do Banco Central). Os proventos podem fazer parte do aporte (o aporte é o total do mês e do bolso sai só o que falta depois dos proventos do mês anterior), somar ao aporte ou ficar guardados. O resultado mostra o que saiu do bolso, os proventos reinvestidos, a valorização, os proventos recebidos e o ganho total, também por mês, por ano ou no período todo. A renda fixa é calculada "na curva", sem marcação a mercado; o IR estimado vale só para ela.
- **Ajustes** — aporte padrão, lista de ativos, custos por banco, backup e status da nuvem.

## Colocar no ar na Cloudflare (uma vez só)

1. **Crie uma conta grátis** em <https://dash.cloudflare.com/sign-up>.
2. **Conecte este repositório:** no painel, vá em **Workers & Pages → Create application → Import a repository**, autorize o GitHub e escolha `meus-investimentos`. Na tela de configuração deixe:
   - Project name: `meus-investimentos`
   - Build command: *(vazio)*
   - Deploy command: `npx wrangler deploy`

   Clique em **Deploy**. No primeiro deploy a Cloudflare cria sozinha o banco D1 `meus-investimentos`.
3. **Defina sua senha:** abra o Worker → **Settings → Variables and Secrets → Add**. Tipo **Secret**, nome `SENHA`, valor = a senha que você quer usar no app. Salve.
4. **Abra o app** no endereço que aparece no painel (algo como `https://meus-investimentos.SEU-USUARIO.workers.dev`). Ele já funciona como calculadora sem entrar. Toque em **Entrar** no topo e use a senha para salvar tudo na nuvem; o botão vira **Conectado** e mostra onde os dados estão. No celular, use "Adicionar à tela inicial".

Daí em diante, cada mudança enviada para a branch `main` publica sozinha.

**Se o passo 2 der erro sobre o banco D1:** vá em **Storage & Databases → D1 → Create database**, nome `meus-investimentos`, copie o **Database ID** e coloque em `wrangler.jsonc`, na linha do `d1_databases`: `"database_id": "o-id-copiado"`. Depois rode o deploy de novo (botão **Retry build** ou um novo commit).

### Opcional

- `BRAPI_TOKEN` (Secret): token grátis da brapi.dev, usado só como reserva se o Yahoo falhar.

## Trazer a planilha antiga

Em **Ajustes → Trazer a planilha antiga**, escolha o arquivo `planilha-acoes.json` (gerado a partir do Excel: valor gasto por ativo em cada mês, Tesouro e proventos). O app busca o preço de cada mês no Yahoo pelo Worker, estima quantas cotas foram compradas (os preços andam de centavo em centavo, então ele escolhe a quantidade que dá um preço redondo dentro da faixa do mês, já corrigida por desdobramentos), mostra um resumo e salva. Os valores ficam exatamente os da planilha; as compras aparecem como "da planilha" no Histórico. Importar de novo não duplica.

Esse arquivo tem seus dados financeiros: não coloque no repositório.

## Cotações

Nenhuma fonte grátis dá o preço da B3 em tempo real — a B3 cobra por isso. O app usa o **Yahoo Finance pelo Worker** (atraso de ~15 min, o mesmo do Google Finance) e a **brapi** como reserva. O horário mostrado embaixo de cada preço é o do último negócio recebido. Para o preço exato do momento, toque no preço e digite o que o app do banco mostra; na hora de registrar a compra você também corrige para o preço da nota.

Tesouro Direto não tem cotação automática: copie o preço de compra do [site do Tesouro](https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm).

## Custos considerados (referência de out/2026 — confira no seu banco)

- Corretagem: zero na maioria dos bancos pelo app; BTG a partir de R$ 4,50 por ordem. Editável em Ajustes.
- B3 em ações/FIIs/ETFs: 0,03% do valor (0,025% liquidação + 0,005% negociação).
- Tesouro Direto: sem taxa na compra; custódia B3 de 0,20% ao ano, com Tesouro Selic isento até R$ 10 mil.

## Dados e segurança

- Ficam no seu banco D1, na sua conta Cloudflare. Plano grátis: 5 GB e 100 mil gravações por dia — sobra muito.
- Os dados só saem com a senha (`SENHA`); só as cotações são públicas. Use uma senha forte: o endereço `workers.dev` é público.
- Sem entrar, o app é uma calculadora: tudo fica só no aparelho. Ao sair, o aparelho esquece compras e proventos (eles continuam na nuvem).
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
public/js/simulador.js cálculos do simulador de aportes
```
