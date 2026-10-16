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
