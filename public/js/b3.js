// Lê o extrato de Movimentação da Área do Investidor da B3 (.xlsx ou .csv)
// e separa o que é novo: proventos, frações, resgates, bonificações e compras/vendas que ainda não estão no app.
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
  const mesmos = [...conhecidos].filter((k) => k.slice(0, 4) === raiz && /^[A-Z]{4}\d{1,2}$/.test(k));
  return mesmos.length === 1 && /^[A-Z]{4}(1|2|9|10)$/.test(x) ? mesmos[0] : x;
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
    const original = produto.split(' - ')[0].trim().toUpperCase();
    const ehTicker = /^[A-Z]{4}\d{1,2}[A-Z]?$/.test(original);
    const ticker = ehTicker ? normalizarTicker(original, conhecidos) : original;
    const qtd = numero(l['quantidade']);
    const preco = numero(l['preco unitario']);
    const valor = numero(l['valor da operacao']);
    const tipoAtivo = tipos.get(ticker) || (/11$/.test(ticker) ? 'fii' : 'acao');
    const nome = String(l['movimentacao']).trim();

    if (ehTicker && mov.startsWith('transferencia - liquidacao') && qtd > 0 && preco > 0) {
      const pregao = dataPregao(data);
      operacoes.push({ liq: data, data: pregao, ticker, original, tipo: tipoAtivo, lado: credito ? 'C' : 'V', qtdB3: qtd, precoB3: preco, valor: round2(qtd * preco), fator: fatorAte(ticker, pregao) });
      continue;
    }
    if (ehTicker && credito && mov.startsWith('bonificacao') && qtd > 0) {
      operacoes.push({ liq: data, data, ticker, original, tipo: tipoAtivo, lado: 'B', qtdB3: qtd, precoB3: 0, valor: 0, fator: fatorAte(ticker, data) });
      continue;
    }
    const tipo = credito && valor > 0 && ehTicker ? tipoProvento(mov, tipoAtivo === 'fii') : null;
    if (tipo) { proventos.push({ data, ticker, original, tipo, valor: round2(valor) }); continue; }
    if (ehTicker && EVENTOS_COTAS.some((e) => mov.startsWith(e))) avisos.push({ data, ticker, nome, qtd, credito });
    ignorados[nome] = (ignorados[nome] || 0) + 1;
  }
  return { proventos, operacoes, avisos, ignorados };
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

  const compras = (existentes.compras || []).filter((c) => c.tipo !== 'tesouro');
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
    preco: o.lado === 'B' ? 0 : Math.round((o.precoB3 / o.fator) * 1e4) / 1e4,
  }));
  // avisos de eventos que o app já registrou (ajuste ou bonificação perto da data, ou desdobramento conhecido) não aparecem
  // e eventos antigos (mais de um mês antes do último registro do app) já foram tratados
  const ultimo = [...(existentes.compras || []), ...provs].reduce((m, x) => (x.data > m ? x.data : m), '');
  const avisos = (lido.avisos || []).filter((a) => (!ultimo || dias(ultimo, a.data) <= 31) && !DESDOBRAMENTOS.some((d) => d.ticker === a.ticker && Math.abs(dias(d.data, a.data)) <= 10)
    && !(existentes.compras || []).some((c) => c.ticker === a.ticker && ['A', 'B'].includes(ladoApp(c)) && Math.abs(dias(c.data, a.data)) <= 10));
  return { proventos, operacoes, avisos };
}
