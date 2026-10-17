// Cálculos puros: custos por banco, resumo do plano, carteira, proventos.
// Sem DOM aqui, para poder testar com Node.

export const TAXA_B3_PADRAO = 0.0003; // 0,0250% liquidação + 0,0050% negociação (pessoa física, à vista)

export const TIPOS = {
  acao: { nome: 'Ação', bolsa: true, passo: 1 },
  fii: { nome: 'FII', bolsa: true, passo: 1 },
  etf: { nome: 'ETF', bolsa: true, passo: 1 },
  bdr: { nome: 'BDR', bolsa: true, passo: 1 },
  tesouro: { nome: 'Tesouro', bolsa: false, passo: 0.01 },
};

export const TIPOS_PROVENTO = {
  dividendo: 'Dividendos',
  jcp: 'JCP',
  rendimento: 'Rendimentos (FII)',
  juros: 'Juros / cupom',
  outro: 'Outros',
};

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function passoDe(ativo) {
  return (TIPOS[ativo.tipo] || TIPOS.acao).passo;
}

export function normalizaQtd(ativo, qtd) {
  const passo = passoDe(ativo);
  const q = Math.max(0, Number(qtd) || 0);
  return passo === 1 ? Math.floor(q) : Math.floor(q * 100 + 1e-9) / 100;
}

/** Custo de uma ordem de compra no banco escolhido. */
export function custoOrdem(ativo, qtd, preco, banco) {
  if (!qtd || qtd <= 0 || !preco) return 0;
  const valor = qtd * preco;
  const tipo = TIPOS[ativo.tipo] || TIPOS.acao;
  if (!tipo.bolsa) return round2(valor * (Number(banco.taxaTesouro) || 0));
  const taxa = banco.taxaB3 == null ? TAXA_B3_PADRAO : Number(banco.taxaB3);
  return round2((Number(banco.corretagem) || 0) + valor * taxa);
}

export function linhaPlano(ativo, qtd, banco) {
  const preco = Number(ativo.preco) || 0;
  const valor = round2(qtd * preco);
  const custo = custoOrdem(ativo, qtd, preco, banco);
  return { ativo, qtd, preco, valor, custo, total: round2(valor + custo) };
}

export function resumoPlano(ativos, qtds, banco) {
  const linhas = ativos.map((a) => linhaPlano(a, Number(qtds[a.id]) || 0, banco));
  const bruto = round2(linhas.reduce((s, l) => s + l.valor, 0));
  const custos = round2(linhas.reduce((s, l) => s + l.custo, 0));
  const ordens = linhas.filter((l) => l.qtd > 0).length;
  return { linhas, bruto, custos, total: round2(bruto + custos), ordens };
}

/**
 * Maior quantidade deste ativo que cabe no dinheiro que sobra,
 * considerando o que essa linha já ocupa (dá para "encher" o restante).
 */
export function qtdMaxima(ativo, qtdAtual, restante, banco) {
  const preco = Number(ativo.preco) || 0;
  if (preco <= 0) return qtdAtual;
  const ocupado = linhaPlano(ativo, qtdAtual, banco).total;
  const verba = restante + ocupado;
  const tipo = TIPOS[ativo.tipo] || TIPOS.acao;
  let q;
  if (tipo.bolsa) {
    const taxa = banco.taxaB3 == null ? TAXA_B3_PADRAO : Number(banco.taxaB3);
    q = Math.floor((verba - (Number(banco.corretagem) || 0)) / (preco * (1 + taxa)) + 1e-9);
  } else {
    const t = Number(banco.taxaTesouro) || 0;
    q = Math.floor((verba / (preco * (1 + t))) * 100 + 1e-9) / 100;
  }
  q = Math.max(0, q);
  // garante que não estoura por arredondamento
  while (q > 0 && linhaPlano(ativo, q, banco).total > verba + 0.001) q = normalizaQtd(ativo, q - passoDe(ativo));
  return q;
}

/** Tesouro: mínimo de 1% do título e R$ 30. Retorna texto de aviso ou null. */
export function avisoMinimo(ativo, qtd) {
  if (ativo.tipo !== 'tesouro' || !qtd) return null;
  const valor = qtd * (Number(ativo.preco) || 0);
  if (qtd < 0.01) return 'Mínimo de 0,01 título';
  if (valor < 30) return 'Mínimo de R$ 30 no Tesouro';
  return null;
}

// ---------- datas ----------
export const mesDe = (iso) => String(iso || '').slice(0, 7); // "2026-10"
export function mesAnterior(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- proventos ----------
export function somaProventosMes(proventos, ym) {
  return round2(proventos.filter((p) => mesDe(p.data) === ym).reduce((s, p) => s + Number(p.valor || 0), 0));
}

export function proventosPorTipo(proventos, filtro = () => true) {
  const out = {};
  for (const p of proventos.filter(filtro)) out[p.tipo] = round2((out[p.tipo] || 0) + Number(p.valor || 0));
  return out;
}

// ---------- carteira ----------
export function carteira(compras, ativos, proventos) {
  const porTicker = new Map();
  for (const c of compras) {
    const k = c.ticker;
    const pos = porTicker.get(k) || { ticker: k, tipo: c.tipo, qtd: 0, investido: 0, custos: 0, proventos: 0 };
    pos.qtd = round2(pos.qtd + Number(c.qtd));
    pos.investido = round2(pos.investido + Number(c.qtd) * Number(c.preco) + Number(c.custo || 0));
    pos.custos = round2(pos.custos + Number(c.custo || 0));
    porTicker.set(k, pos);
  }
  for (const p of proventos) {
    const pos = porTicker.get(p.ticker);
    if (pos) pos.proventos = round2(pos.proventos + Number(p.valor || 0));
  }
  const linhas = [...porTicker.values()].map((pos) => {
    const ativo = ativos.find((a) => a.ticker === pos.ticker);
    const preco = ativo ? Number(ativo.preco) || 0 : 0;
    const valorAtual = preco ? round2(pos.qtd * preco) : null;
    const resultado = valorAtual == null ? null : round2(valorAtual - pos.investido);
    return {
      ...pos,
      precoMedio: pos.qtd ? round2(pos.investido / pos.qtd) : 0,
      precoAtual: preco || null,
      valorAtual,
      resultado,
      resultadoPct: resultado == null || !pos.investido ? null : resultado / pos.investido,
    };
  });
  linhas.sort((a, b) => (b.valorAtual ?? b.investido) - (a.valorAtual ?? a.investido));
  const investido = round2(linhas.reduce((s, l) => s + l.investido, 0));
  const valorAtual = round2(linhas.reduce((s, l) => s + (l.valorAtual ?? l.investido), 0));
  const totalProventos = round2(proventos.reduce((s, p) => s + Number(p.valor || 0), 0));
  return { linhas, investido, valorAtual, resultado: round2(valorAtual - investido), proventos: totalProventos };
}

export function aportesPorMes(compras) {
  const m = new Map();
  for (const c of compras) {
    const k = mesDe(c.data);
    m.set(k, round2((m.get(k) || 0) + Number(c.qtd) * Number(c.preco) + Number(c.custo || 0)));
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mes, valor]) => ({ mes, valor }));
}

// ---------- quanto investi por dia / mês / ano ----------
export const CHAVE_PERIODO = {
  dia: (d) => String(d).slice(0, 10),
  mes: (d) => String(d).slice(0, 7),
  ano: (d) => String(d).slice(0, 4),
};

/** Linhas em ordem cronológica: valor investido por tipo, total, proventos e acumulado. */
export function resumoPorPeriodo(compras, proventos, periodo = 'mes') {
  const chave = CHAVE_PERIODO[periodo] || CHAVE_PERIODO.mes;
  const m = new Map();
  const linha = (k) => {
    if (!m.has(k)) m.set(k, { chave: k, acao: 0, fii: 0, tesouro: 0, outros: 0, total: 0, compras: 0, proventos: 0, tx: { acao: 0, fii: 0, tesouro: 0, outros: 0 } });
    return m.get(k);
  };
  for (const c of compras) {
    const custo = Number(c.custo || 0);
    const v = Number(c.qtd) * Number(c.preco) + custo;
    const l = linha(chave(c.data));
    const grupo = c.tipo === 'acao' || c.tipo === 'fii' || c.tipo === 'tesouro' ? c.tipo : 'outros';
    l[grupo] += v;
    l.tx[grupo] += custo; // taxas por tipo, para o gráfico poder mostrar o valor com ou sem elas
    l.total += v;
    l.compras++;
  }
  for (const p of proventos) linha(chave(p.data)).proventos += Number(p.valor || 0);
  let acum = 0;
  return [...m.values()]
    .sort((a, b) => a.chave.localeCompare(b.chave))
    .map((l) => {
      acum += l.total;
      return {
        ...l,
        acao: round2(l.acao), fii: round2(l.fii), tesouro: round2(l.tesouro), outros: round2(l.outros),
        total: round2(l.total), proventos: round2(l.proventos), acumulado: round2(acum),
        tx: Object.fromEntries(Object.entries(l.tx).map(([k, v]) => [k, round2(v)])),
      };
    });
}

// ---------- importar a planilha antiga (só tem o valor gasto por mês) ----------
/**
 * Descobre quantas cotas foram compradas a partir do valor gasto (com a taxa incluída).
 * Na bolsa, o preço anda de centavo em centavo e a taxa da B3 é ~0,03% do valor.
 * Então procuramos a quantidade q, o preço p (em centavos, dentro da faixa de preço do mês)
 * e a taxa t (em centavos) tais que q × p + t = valor, ao centavo, com t o mais perto de 0,033%.
 *
 * ref: { low, high, close } do mês, já corrigidos por desdobramentos (como o Yahoo entrega).
 * fatores: quantas ações de hoje vale 1 ação comprada naquele mês (desdobramentos depois da compra).
 * Devolve a quantidade e o preço em ações de hoje.
 */
export const TAXA_NUBANK_OBSERVADA = 0.00033;

export function estimarCompra(valor, ref, fatores = [1]) {
  if (!ref || !(ref.low > 0) || !(ref.high > 0)) return null;
  const vc = Math.round(valor * 100);
  let melhor = null;
  for (const fator of fatores) {
    const lo = Math.floor(ref.low * fator * 100 * 0.995);   // faixa do mês no preço da época, em centavos
    const hi = Math.ceil(ref.high * fator * 100 * 1.005);
    const alvo = (ref.close > 0 ? ref.close : (ref.low + ref.high) / 2) * fator * 100;
    const qmin = Math.max(1, Math.floor(vc / (hi * 1.0006)));
    const qmax = Math.max(qmin, Math.ceil(vc / lo));
    const tmax = Math.max(2, Math.ceil(vc * 0.0006));
    for (let q = qmin; q <= Math.min(qmax, qmin + 50000); q++) {
      for (let t = 0; t <= tmax; t++) {
        const g = vc - t;
        if (g % q) continue;
        const p = g / q;
        if (p < lo || p > hi) continue;
        const esperado = g * TAXA_NUBANK_OBSERVADA;
        const nota = Math.abs(t - esperado) + Math.abs(p - alvo) / alvo * 0.5; // a taxa decide; o preço desempata
        if (!melhor || nota < melhor.nota) melhor = { q, p, t, fator, nota };
      }
    }
  }
  if (melhor && melhor.nota < Math.max(3, vc * 0.0002)) {
    const qtd = Math.round(melhor.q * melhor.fator * 10000) / 10000;
    return { qtd, preco: Math.round(((vc - melhor.t) / 100 / qtd) * 1e6) / 1e6, custo: melhor.t / 100, exato: true, qtdOriginal: melhor.q, precoOriginal: melhor.p / 100 };
  }
  // não fechou ao centavo (ex.: duas compras no mesmo mês a preços diferentes): aproxima pelo fechamento
  const fator = fatores[0];
  const liquido = valor / (1 + TAXA_NUBANK_OBSERVADA);
  const alvo = (ref.close > 0 ? ref.close : (ref.low + ref.high) / 2) * fator;
  const q = Math.max(1, Math.round(liquido / alvo));
  const qtd = Math.round(q * fator * 10000) / 10000;
  const preco = Math.round((liquido / qtd) * 1e6) / 1e6;
  return { qtd, preco, custo: Math.round((valor - qtd * preco) * 1e6) / 1e6, exato: false, qtdOriginal: q };
}

/** Fatores de desdobramento possíveis para uma compra feita no mês `ym`. */
export function fatoresDoMes(ym, splits = []) {
  const ini = `${ym}-01`, fim = `${ym}-31`;
  const depois = (d) => splits.filter((s) => s.data > d).reduce((f, s) => f * s.fator, 1);
  const f1 = depois(ini), f2 = depois(fim);
  return f1 === f2 ? [f1] : [f1, f2];
}

// Selic média de cada ano, para trazer o preço atual do Tesouro Selic até a data da compra.
const SELIC_ANO = { 2022: 0.1275, 2023: 0.1290, 2024: 0.1085, 2025: 0.1440, 2026: 0.1490 };

/** Preço aproximado do Tesouro Selic no mês `ym`, a partir do preço de hoje. */
export function precoTesouroEm(ym, precoHoje, hojeYm) {
  let [y, m] = ym.split('-').map(Number);
  const [yh, mh] = hojeYm.split('-').map(Number);
  let fator = 1;
  while (y < yh || (y === yh && m < mh)) {
    fator *= Math.pow(1 + (SELIC_ANO[y] ?? 0.12), 1 / 12);
    m++; if (m > 12) { m = 1; y++; }
  }
  return precoHoje / fator;
}
