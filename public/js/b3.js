// Lê o extrato de Movimentação da Área do Investidor da B3 (.xlsx ou .csv)
// e separa o que é novo: proventos, frações, resgates, bonificações e compras/vendas (inclusive do Tesouro Direto)
// que ainda não estão no app.
//
// O app guarda tudo pelo nome e pela quantidade de HOJE; a B3 mostra como era no dia. Por isso:
// - ticker antigo vira o atual (IRDM11 → IRIM11) e recibos/direitos de FII (IRIM15) viram a cota (IRIM11);
// - compras de antes de um desdobramento são comparadas pelo valor (1 × 46,78 = 2 × 23,39);
// - resgate que já está no app como venda (CIEL3 na OPA) não vira provento.
import { round2, dataPregao } from './calc.js';

/** Tickers que mudaram de nome: antigo → atual. */
export const RENOMEADOS = { IRDM11: 'IRIM11' };

/** Desdobramentos (fator > 1) e grupamentos (fator < 1): quantas cotas de hoje vale 1 cota de antes da data. */
export const DESDOBRAMENTOS = [{ ticker: 'BBAS3', data: '2024-04-16', fator: 2 }];

const semAcento = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** "R$ 1.234,56", "1234.56", 12.5 ou "-" → número (ou null). */
export function numero(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let t = String(v ?? '').replace(/R\$|\s/g, '');
  if (!t || t === '-') return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "14/10/2026", Date ou número de série do Excel → "2026-10-14". */
export function dataISO(v) {
  if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  const m = String(v ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const iso = String(v ?? '').match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

/** Fator para trazer uma quantidade da data `d` para a de hoje. */
export const fatorAte = (ticker, d) => DESDOBRAMENTOS.filter((s) => s.ticker === ticker && s.data > d).reduce((f, s) => f * s.fator, 1);

/**
 * Nome da B3 → nome usado no app.
 * `conhecidos`: tickers que o app já tem (ativos e compras).
 */
export function normalizarTicker(t, conhecidos = new Set()) {
  let x = RENOMEADOS[t] || t;
  // recibo ou direito de subscrição de FII (…12 a …15) é a mesma cota (…11)
  const fii = x.match(/^([A-Z]{4})1[2-5]$/);
  if (fii) x = RENOMEADOS[`${fii[1]}11`] || `${fii[1]}11`;
  if (conhecidos.has(x)) return x;
  // direito/recibo de ação (ITSA1, ITSA2, ITSA9…): se só um ativo do app tem a mesma raiz, é ele
  const raiz = x.slice(0, 4);
  const mesmos = [...conhecidos].filter((k) => k.slice(0, 4) === raiz && /^[A-Z][A-Z0-9]{3}\d{1,2}$/.test(k));
  return mesmos.length === 1 && /^[A-Z]{4}(1|2|9|10)$/.test(x) ? mesmos[0] : x;
}

// Instituição da B3 → banco do app. A B3 usa o nome da corretora ("NU INVEST CORRETORA…", "TORO CTVM LTDA").
const INSTITUICOES = [
  [/^nu (invest|investimentos)|nubank/, 'nubank'], [/\btoro\b/, 'toro'], [/\bxp\b/, 'xp'], [/\borama\b/, 'orama'], [/\bnikos\b/, 'nikos'],
  [/\brico\b/, 'rico'], [/\bclear\b/, 'clear'], [/\bbtg\b/, 'btg'], [/\binter\b/, 'inter'], [/\bitau\b|\bion\b/, 'itau'],
  [/bradesco|\bagora\b/, 'bradesco'], [/santander/, 'santander'], [/banco do brasil|\bbb\b/, 'bb'], [/\bc6\b/, 'c6'], [/genial/, 'genial'],
  [/modal/, 'modal'], [/warren/, 'warren'], [/avenue/, 'avenue'], [/mercado pago/, 'mercadopago'], [/picpay/, 'picpay'],
];
const LIXO_NOME = /\b(s\.?\s?a\.?|ltda|ctvm|cctvm|dtvm|corretora|distribuidora|de|titulos|e|valores|mobiliarios|investimentos|banco|-)\b/g;
/**
 * Banco do app para o nome da instituição na B3.
 * Devolve { id, nome, novo } — `novo` quando o banco ainda não existe na lista e precisa ser criado.
 */
export function bancoDaInstituicao(inst, bancos = []) {
  const t = semAcento(inst);
  if (!t) return null;
  const regra = INSTITUICOES.find(([re]) => re.test(t));
  const porNome = bancos.find((b) => { const n = semAcento(b.nome).split(/[\s(]/)[0]; return n.length > 2 && new RegExp(`\\b${n}\\b`).test(t); });
  const id = regra?.[1] || porNome?.id;
  const existente = bancos.find((b) => b.id === id);
  if (existente) return { id: existente.id, nome: existente.nome, novo: false };
  const limpo = t.replace(LIXO_NOME, ' ').replace(/\s+/g, ' ').trim() || t;
  const nome = String(inst).split(/\s+/).filter((w) => limpo.split(' ').includes(semAcento(w))).map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') || String(inst).slice(0, 30);
  return { id: id || limpo.split(' ')[0].replace(/[^a-z0-9]/g, '').slice(0, 20) || 'outro', nome, novo: true };
}

/** Tipo de provento a partir do nome da movimentação. */
function tipoProvento(mov, fii) {
  if (mov.includes('juros sobre capital')) return 'jcp';
  if (mov.startsWith('dividendo')) return 'dividendo';
  if (mov.startsWith('rendimento')) return fii ? 'rendimento' : 'atualizacao'; // em ações, a B3 chama de "Rendimento" a correção do dividendo
  if (mov.includes('leilao de fracao')) return 'fracao';
  if (mov.startsWith('resgate') || mov.includes('amortizacao') || mov.includes('restituicao de capital') || mov.startsWith('reembolso')) return 'resgate';
  if (mov.startsWith('juros') || mov.includes('cupom')) return 'juros';
  return null;
}

// eventos sem dinheiro que mexem na quantidade: o app não aplica sozinho, só avisa
const EVENTOS_COTAS = ['desdobro', 'desdobramento', 'grupamento', 'incorporacao', 'atualizacao', 'cisao', 'conversao'];

/**
 * Linhas da planilha (objetos com as colunas do cabeçalho) → movimentos entendidos.
 * `ctx.tipos`: Map ticker → tipo do app ('acao', 'fii'…).
 * Devolve { proventos, operacoes, avisos, ignorados }.
 */
export function lerMovimentacao(linhas, ctx = {}) {
  const tipos = ctx.tipos || new Map();
  const conhecidos = new Set(tipos.keys());
  const proventos = [], operacoes = [], avisos = [], ignorados = {};
  for (const bruta of linhas) {
    const l = {};
    for (const [k, v] of Object.entries(bruta)) l[semAcento(k)] = v;
    const mov = semAcento(l['movimentacao']);
    const produto = String(l['produto'] ?? '').trim();
    const data = dataISO(l['data']);
    if (!mov || !produto || !data) continue;
    const credito = semAcento(l['entrada/saida']).startsWith('cred');
    const qtd = numero(l['quantidade']);
    const preco = numero(l['preco unitario']);
    const valor = numero(l['valor da operacao']);
    const nome = String(l['movimentacao']).trim();
    const inst = String(l['instituicao'] ?? '').trim();

    // Tesouro Direto: o produto vem com o nome do título ("Tesouro Selic 2031") e a movimentação é "Compra"/"Venda"
    if (/^tesouro\s/i.test(produto)) {
      const tTes = [...conhecidos].find((k) => semAcento(k) === semAcento(produto)) || produto.replace(/\s+/g, ' ');
      const pu = preco > 0 ? preco : qtd > 0 && valor > 0 ? valor / qtd : null;
      const lado = mov.startsWith('compra') ? 'C' : /^(venda|resgate|vencimento)/.test(mov) ? 'V' : null;
      if (lado && qtd > 0 && pu > 0) {
        operacoes.push({ liq: data, data, ticker: tTes, original: tTes, tipo: 'tesouro', inst, lado, qtdB3: qtd, precoB3: pu, valor: round2(valor > 0 ? valor : qtd * pu), fator: 1 });
        continue;
      }
      const tipoT = credito && valor > 0 ? tipoProvento(mov, false) : null; // juros semestrais (cupom)
      if (tipoT === 'juros') { proventos.push({ data, ticker: tTes, original: tTes, tipo: 'juros', inst, valor: round2(valor) }); continue; }
      ignorados[nome] = (ignorados[nome] || 0) + 1;
      continue;
    }

    // Renda fixa: "CDB - CDB2241CUAJ - MERCADO CREDITO SOCIEDADE…", "LCA - 20C01038167 - BANCO ORIGINAL S/A"
    const rfm = produto.match(/^(CDB|LCA|LCI|LC|CRI|CRA|DEB|RDB|LF)\s*-\s*([A-Z0-9]+)\s*-\s*(.+)$/i);
    if (rfm) {
      const tRF = tickerRF(rfm[1], rfm[2], rfm[3]);
      const base = { liq: data, data, ticker: tRF, original: tRF, tipo: 'rf', inst, qtdB3: qtd, fator: 1 };
      const pu = qtd > 0 && valor > 0 ? valor / qtd : preco > 0 ? preco : null; // o valor da operação é exato; o PU vem arredondado (0,01)
      if (qtd > 0 && mov.startsWith('compra') && pu) {
        operacoes.push({ ...base, lado: credito ? 'C' : 'V', rotulo: credito ? 'compra' : 'resgate', precoB3: pu, valor: round2(valor > 0 ? valor : qtd * pu) });
        continue;
      }
      if (qtd > 0 && /^(vencimento|resgate)/.test(mov)) {
        // a B3 não traz quanto foi pago no vencimento: entra pelo custo, para zerar a posição (dá para corrigir no Histórico)
        operacoes.push({ ...base, lado: 'V', rotulo: 'vencimento', precoB3: pu, valor: pu ? round2(qtd * pu) : null, peloCusto: !pu });
        continue;
      }
      if (qtd > 0 && mov.startsWith('transferencia')) {
        // troca de corretora: sai de uma (venda) e entra na outra (compra), pelo custo
        operacoes.push({ ...base, lado: credito ? 'C' : 'V', rotulo: credito ? 'transferência (entrada)' : 'transferência (saída)', precoB3: null, valor: null, peloCusto: true, transf: true });
        continue;
      }
      const rotulo = `${rfm[1].toUpperCase()} (${nome.toLowerCase()})`;
      ignorados[rotulo] = (ignorados[rotulo] || 0) + 1;
      continue;
    }

    const original = produto.split(' - ')[0].trim().toUpperCase();
    const ehTicker = /^[A-Z][A-Z0-9]{3}\d{1,2}[A-Z]?$/.test(original); // B3SA3 também
    const ticker = ehTicker ? normalizarTicker(original, conhecidos) : original;
    const tipoAtivo = tipos.get(ticker) || (/11$/.test(ticker) ? 'fii' : 'acao');

    if (ehTicker && mov.startsWith('transferencia - liquidacao') && qtd > 0 && preco > 0) {
      const pregao = dataPregao(data);
      operacoes.push({ liq: data, data: pregao, ticker, original, tipo: tipoAtivo, inst, lado: credito ? 'C' : 'V', qtdB3: qtd, precoB3: preco, valor: round2(qtd * preco), fator: fatorAte(ticker, pregao) });
      continue;
    }
    if (ehTicker && credito && mov.startsWith('bonificacao') && qtd > 0) {
      operacoes.push({ liq: data, data, ticker, original, tipo: tipoAtivo, inst, lado: 'B', qtdB3: qtd, precoB3: 0, valor: 0, fator: fatorAte(ticker, data) });
      continue;
    }
    const tipo = credito && valor > 0 && ehTicker ? tipoProvento(mov, tipoAtivo === 'fii') : null;
    if (tipo) { proventos.push({ data, ticker, original, tipo, inst, valor: round2(valor) }); continue; }
    if (ehTicker && EVENTOS_COTAS.some((e) => mov.startsWith(e))) avisos.push({ data, ticker, nome, qtd, credito });
    const rotulo = ehTicker ? nome : `${produto.split(' - ')[0].trim()} (${nome.toLowerCase()})`; // CDB, LCA, Futuro…: o app não acompanha
    ignorados[rotulo] = (ignorados[rotulo] || 0) + 1;
  }
  // renda fixa sem valor (vencimento, transferência): preço médio das compras até aquele dia
  const anteriores = [...operacoes, ...(ctx.compras || []).map((c) => ({ ...c, liq: c.data, precoB3: Number(c.preco), qtdB3: Number(c.qtd), lado: c.lado || 'C' }))];
  for (const o of operacoes.filter((x) => x.tipo === 'rf' && x.peloCusto)) {
    const cs = anteriores.filter((c) => c.ticker === o.ticker && c.lado === 'C' && !c.transf && c.precoB3 > 0 && c.liq <= o.liq);
    const q = cs.reduce((s2, c) => s2 + c.qtdB3, 0);
    if (q > 0) { o.precoB3 = cs.reduce((s2, c) => s2 + c.qtdB3 * c.precoB3, 0) / q; o.valor = round2(o.qtdB3 * o.precoB3); }
  }
  const semCompra = operacoes.filter((o) => o.tipo === 'rf' && !(o.precoB3 > 0));
  for (const o of semCompra) avisos.push({ data: o.data, ticker: o.ticker, nome: `${o.rotulo[0].toUpperCase()}${o.rotulo.slice(1)} sem a compra no extrato (é de antes)`, qtd: o.qtdB3, credito: false, rf: true });
  return { proventos, operacoes: operacoes.filter((o) => !semCompra.includes(o)), avisos, ignorados };
}

const LIXO_EMISSOR = new Set(['SA', 'S/A', 'S.A.', 'S.A', 'BANCO', 'SOCIEDADE', 'FINANCIAMENTO', 'INVESTIMENTO', 'INVESTIMENTOS', 'E', 'DE', 'DO', 'DA', 'MULTIPLO', 'MÚLTIPLO', 'LTDA', 'CFI', '-', '–']);
/** Nome curto do título de renda fixa: "CDB Mercado Credito 2241CUAJ", "LCA Original 20C01038167". */
export function tickerRF(tipo, codigo, emissor) {
  const t = tipo.toUpperCase();
  const ws = [...new Set(String(emissor).toUpperCase().split(/\s+/).filter((w) => w && !LIXO_EMISSOR.has(w)))].slice(0, 2);
  const nome = ws.map((w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase())).join(' ');
  const cod = String(codigo).toUpperCase().replace(new RegExp(`^${t}`), '');
  return [t, nome, cod].filter(Boolean).join(' ');
}

const DIA = 86400000;
const dias = (a, b) => Math.round((new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / DIA);
const abrev = { dividendo: 'div', jcp: 'jcp', rendimento: 'ren', atualizacao: 'atu', juros: 'jur', fracao: 'out', resgate: 'out' };
const valorC = (c) => Number(c.qtd) * Number(c.preco);
const perto = (a, b) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.002);
const ladoApp = (c) => (['V', 'B', 'A'].includes(c.lado) ? c.lado : 'C');

/**
 * Compara com o que o app já tem e devolve só o que falta.
 * Proventos: mesmo ativo e valor na mesma data (com ou sem o mesmo tipo), depois até 7 dias de diferença.
 * Resgates e frações que já estão no app como venda do mesmo valor são pulados.
 * Operações: mesmo ativo e lado, com o valor (ou a quantidade de hoje) batendo com uma compra do app,
 * ou com a soma das compras de um mesmo pregão. Primeiro no dia exato, depois até 7 dias antes da liquidação.
 */
export function novidades(lido, existentes) {
  const provs = existentes.proventos || [];
  const usadosP = new Set();
  const casa = (p, fn) => { const x = provs.find((y) => !usadosP.has(y) && fn(y)); if (x) usadosP.add(x); return !!x; };
  const mesmoValor = (p) => (y) => y.ticker === p.ticker && Math.abs(Number(y.valor) - p.valor) < 0.005;
  let resto = lido.proventos.filter((p) => !casa(p, (y) => mesmoValor(p)(y) && y.tipo === p.tipo && y.data === p.data));
  resto = resto.filter((p) => !casa(p, (y) => mesmoValor(p)(y) && y.data === p.data));
  resto = resto.filter((p) => !casa(p, (y) => mesmoValor(p)(y) && y.tipo === p.tipo && Math.abs(dias(y.data, p.data)) <= 7));
  const vendas = (existentes.compras || []).filter((c) => ladoApp(c) === 'V');
  resto = resto.filter((p) => !(['resgate', 'fracao'].includes(p.tipo) && vendas.some((v) => v.ticker === p.ticker && Math.abs(dias(v.data, p.data)) <= 7 && perto(valorC(v), p.valor))));

  const ids = new Set(provs.map((y) => y.id));
  const proventos = resto.map((p) => {
    const base = `b3${p.data.replace(/-/g, '')}${p.ticker.toLowerCase()}${abrev[p.tipo] || 'out'}`;
    let n = 1;
    while (ids.has(`${base}${n}`)) n++;
    ids.add(`${base}${n}`);
    const { original, ...resto2 } = p;
    return { id: `${base}${n}`, ...resto2 };
  });

  // Tesouro também entra: o nome do título já separa (Selic 2029 ≠ Selic 2031) e a data é a do dia da compra
  const compras = existentes.compras || [];
  const usadasC = new Set();
  const bate = (o, cs) => {
    const q = cs.reduce((s, c) => s + Number(c.qtd), 0);
    if (o.lado === 'B') return true; // bonificação do mesmo ativo perto da data é o mesmo evento (a B3 pode mostrar com fração)
    return perto(cs.reduce((s, c) => s + valorC(c), 0), o.valor); // o valor não muda com desdobramento
  };
  const tenta = (o, filtroData) => {
    const cand = compras.filter((c) => !usadasC.has(c) && c.ticker === o.ticker && ladoApp(c) === o.lado && filtroData(c))
      .sort((a, b) => Math.abs(dias(a.data, o.data)) - Math.abs(dias(b.data, o.data)));
    const uma = cand.find((c) => bate(o, [c]));
    if (uma) { usadasC.add(uma); return true; }
    const porDia = new Map();
    for (const c of cand) porDia.set(c.data, [...(porDia.get(c.data) || []), c]);
    const grupo = [...porDia.values()].find((cs) => cs.length > 1 && bate(o, cs));
    if (grupo) { grupo.forEach((c) => usadasC.add(c)); return true; }
    return false;
  };
  const faltam1 = lido.operacoes.filter((o) => !tenta(o, (c) => c.data === o.data));
  // bonificação não tem pregão: a data da B3 (crédito das cotas) pode ficar semanas antes ou depois da data do app
  const faltam = faltam1.filter((o) => !tenta(o, (c) => (o.lado === 'B' ? Math.abs(dias(o.liq, c.data)) <= 45 : dias(o.liq, c.data) >= 0 && dias(o.liq, c.data) <= 7)));
  const operacoes = faltam.map((o) => ({
    ...o,
    qtd: round2(o.qtdB3 * o.fator * 1e6) / 1e6, // quantidade de hoje
    preco: o.lado === 'B' ? 0 : o.tipo === 'rf' ? Math.round(o.precoB3 * 1e8) / 1e8 : Math.round((o.precoB3 / o.fator) * 1e4) / 1e4, // renda fixa: PU com muitas casas (0,0101313)
  }));
  // avisos de eventos que o app já registrou (ajuste ou bonificação perto da data, ou desdobramento conhecido) não aparecem
  // e eventos antigos (mais de um mês antes do último registro do app) já foram tratados
  const ultimo = [...(existentes.compras || []), ...provs].reduce((m, x) => (x.data > m ? x.data : m), '');
  const avisos = (lido.avisos || []).filter((a) => a.rf || (!ultimo || dias(ultimo, a.data) <= 31) && !DESDOBRAMENTOS.some((d) => d.ticker === a.ticker && Math.abs(dias(d.data, a.data)) <= 10)
    && !(existentes.compras || []).some((c) => c.ticker === a.ticker && ['A', 'B'].includes(ladoApp(c)) && Math.abs(dias(c.data, a.data)) <= 10));
  return { proventos, operacoes, avisos };
}
