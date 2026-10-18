// Lê o extrato de Movimentação da Área do Investidor da B3 (.xlsx ou .csv)
// e separa o que é novo: proventos, frações, resgates e compras/vendas que ainda não estão no app.
import { round2, dataPregao } from './calc.js';

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

/** Tipo de provento a partir do nome da movimentação. `fii`: se o ativo é fundo imobiliário. */
function tipoProvento(mov, fii) {
  if (mov.includes('juros sobre capital')) return 'jcp';
  if (mov.startsWith('dividendo')) return 'dividendo';
  if (mov.startsWith('rendimento')) return fii ? 'rendimento' : 'atualizacao'; // em ações, a B3 chama de "Rendimento" a correção do dividendo
  if (mov.includes('leilao de fracao')) return 'fracao';
  if (mov.startsWith('resgate') || mov.includes('amortizacao') || mov.includes('restituicao de capital') || mov.startsWith('reembolso')) return 'resgate';
  if (mov.startsWith('juros') || mov.includes('cupom')) return 'juros';
  return null;
}

/**
 * Linhas da planilha (objetos com as colunas do cabeçalho) → movimentos entendidos.
 * Devolve { proventos, operacoes, ignorados } — operações são compras (C) e vendas (V) da bolsa.
 */
export function lerMovimentacao(linhas) {
  const proventos = [], operacoes = [], ignorados = {};
  for (const bruta of linhas) {
    const l = {};
    for (const [k, v] of Object.entries(bruta)) l[semAcento(k)] = v;
    const mov = semAcento(l['movimentacao']);
    const produto = String(l['produto'] ?? '').trim();
    const data = dataISO(l['data']);
    if (!mov || !produto || !data) continue;
    const credito = semAcento(l['entrada/saida']).startsWith('cred');
    const ticker = produto.split(' - ')[0].trim().toUpperCase();
    const ehTicker = /^[A-Z]{4}\d{1,2}[A-Z]?$/.test(ticker);
    const qtd = numero(l['quantidade']);
    const preco = numero(l['preco unitario']);
    const valor = numero(l['valor da operacao']);
    const fii = /11[A-Z]?$/.test(ticker);

    if (ehTicker && mov.startsWith('transferencia - liquidacao') && qtd > 0 && preco > 0) {
      operacoes.push({ liq: data, data: dataPregao(data), ticker, tipo: fii ? 'fii' : 'acao', lado: credito ? 'C' : 'V', qtd, preco: round2(preco * 10000) / 10000 });
      continue;
    }
    const tipo = credito && valor > 0 && ehTicker ? tipoProvento(mov, fii) : null;
    if (tipo) { proventos.push({ data, ticker, tipo, valor: round2(valor) }); continue; }
    const nome = String(l['movimentacao']).trim();
    ignorados[nome] = (ignorados[nome] || 0) + 1;
  }
  return { proventos, operacoes, ignorados };
}

const DIA = 86400000;
const dias = (a, b) => Math.round((new Date(`${a}T12:00:00`) - new Date(`${b}T12:00:00`)) / DIA);
const abrev = { dividendo: 'div', jcp: 'jcp', rendimento: 'ren', atualizacao: 'atu', juros: 'jur', fracao: 'out', resgate: 'out' };

/**
 * Compara com o que o app já tem e devolve só o que falta.
 * Proventos: mesmo ativo, tipo e valor na mesma data (ou até 7 dias de diferença, para os lançados à mão).
 * Operações: mesmo ativo e lado, com a quantidade batendo com as compras do app do pregão até 7 dias antes da liquidação.
 */
export function novidades(lido, existentes) {
  const usadosP = new Set();
  const provs = existentes.proventos || [];
  const achaProv = (p, tolerancia) => provs.find((x) => !usadosP.has(x) && x.ticker === p.ticker && x.tipo === p.tipo
    && Math.abs(Number(x.valor) - p.valor) < 0.005 && Math.abs(dias(x.data, p.data)) <= tolerancia);
  const pendentes = [];
  for (const p of lido.proventos) { const x = achaProv(p, 0); if (x) usadosP.add(x); else pendentes.push(p); }
  const proventos = [];
  const seq = {};
  for (const p of pendentes) {
    const x = achaProv(p, 7);
    if (x) { usadosP.add(x); continue; }
    const base = `b3${p.data.replace(/-/g, '')}${p.ticker.toLowerCase()}${abrev[p.tipo] || 'out'}`;
    let n = seq[base] || 1;
    const ids = new Set(provs.map((y) => y.id));
    while (ids.has(`${base}${n}`) || proventos.some((y) => y.id === `${base}${n}`)) n++;
    seq[base] = n + 1;
    proventos.push({ id: `${base}${n}`, ...p });
  }

  const usadasC = new Set();
  const compras = (existentes.compras || []).filter((c) => c.tipo !== 'tesouro');
  const lado = (c) => (c.lado === 'V' ? 'V' : 'C');
  const operacoes = [];
  for (const o of lido.operacoes) {
    const candidatas = compras.filter((c) => !usadasC.has(c) && c.ticker === o.ticker && lado(c) === o.lado
      && dias(o.liq, c.data) >= 0 && dias(o.liq, c.data) <= 7);
    // uma compra igual, ou várias do mesmo pregão que somam a quantidade da liquidação
    const igual = candidatas.find((c) => Math.abs(c.qtd - o.qtd) < 1e-6);
    if (igual) { usadasC.add(igual); continue; }
    const porDia = new Map();
    for (const c of candidatas) porDia.set(c.data, [...(porDia.get(c.data) || []), c]);
    const grupo = [...porDia.values()].find((cs) => Math.abs(cs.reduce((s, c) => s + c.qtd, 0) - o.qtd) < 1e-6);
    if (grupo) { grupo.forEach((c) => usadasC.add(c)); continue; }
    operacoes.push(o);
  }
  return { proventos, operacoes };
}
