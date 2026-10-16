# Meus Investimentos

App para montar a compra do mês na bolsa: quanto tenho para investir (aporte + proventos do mês anterior), quanto custa cada ativo agora, quantas cotas comprar de cada um e quanto isso dá no total, já com os custos do banco.

As compras continuam sendo feitas no app do banco (Nubank, BB, Bradesco etc.). Depois de comprar, você registra aqui e acompanha a carteira.

## O que tem

- **Comprar** — aporte do mês + proventos do mês anterior = disponível. Lista dos seus ativos com preço atual, botões − / + para as cotas, botão **MÁX** que enche com o que falta, total por ativo e barra mostrando quanto falta (ou quanto passou). Mostra o custo da compra no banco escolhido e compara com os outros bancos.
- **Carteira** — cotas, preço médio, investido, valor hoje, resultado e proventos por ativo; gráfico de aportes por mês; histórico de compras.
- **Proventos** — lança dividendos, JCP, rendimentos de FII e juros. O total do mês anterior entra sozinho no aporte.
- **Ajustes** — aporte padrão, token de cotações, lista de ativos, custos por banco e backup.

## Cotações

Vêm da [brapi.dev](https://brapi.dev) (atraso de ~30 min no plano grátis). Sem token só PETR4, VALE3, ITUB4 e MGLU3 funcionam. Crie um token grátis em <https://brapi.dev/dashboard> e cole em **Ajustes**.

Tesouro Direto não tem cotação automática: copie o preço de compra do [site do Tesouro](https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm) e digite no próprio campo de preço. Qualquer preço pode ser digitado à mão.

## Custos considerados (referência de out/2026 — confira no seu banco)

- Corretagem: zero na maioria dos bancos pelo app; BTG a partir de R$ 4,50 por ordem. Editável em Ajustes.
- B3 em ações/FIIs/ETFs: 0,03% do valor (0,025% liquidação + 0,005% negociação).
- Tesouro Direto: sem taxa na compra; custódia B3 de 0,20% ao ano, com Tesouro Selic isento até R$ 10 mil.

## Dados

Tudo fica salvo no navegador (localStorage). Use **Ajustes → Exportar backup** de vez em quando e **Importar** para levar para outro aparelho.

## Rodar

É um site estático, sem build. Publicado pelo GitHub Pages a partir da branch `main`. Para rodar local:

```bash
python3 -m http.server 8000
# abra http://localhost:8000
```

No celular, abra o link e use "Adicionar à tela inicial" para usar como app.

## Estrutura

```
index.html            página
styles.css            visual (tema claro e escuro)
js/app.js             telas e interação
js/calc.js            cálculos (custos, MÁX, carteira, proventos)
js/store.js           dados salvos, bancos de referência, backup
js/cotacoes.js        busca de preços na brapi
```
