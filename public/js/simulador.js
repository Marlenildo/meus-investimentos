// Simulador: "e se eu tivesse aportado R$ X todo primeiro dia útil do mês desde tal mês?"
// Cálculos puros (sem DOM), para poder testar com Node.
//
// Ativos de bolsa (ações, FIIs, ETFs, BDRs): compra no fechamento do primeiro dia útil do mês,
// só cotas inteiras, com 0,03% de taxas da B3; o que sobra fica em caixa para o mês seguinte.
// Proventos (dividendos e JCP por cota, do Yahoo) entram para quem tinha a cota antes da data-com.
// Renda fixa: o valor rende dia a dia pela taxa escolhida (Selic, % do CDI, IPCA + taxa, prefixado),
// sem marcação a mercado — é o valor "na curva", como se fosse levado até o vencimento.
import { TAXA_B3_PADRAO, aliquotaRendaFixa } from './calc.js';

/** Tipos de investimento que o simulador conhece. */
export const TIPOS_SIM = {
  bolsa: { nome: 'Ação, FII ou ETF', curto: 'Bolsa' },
  selic: { nome: 'Tesouro Selic', curto: 'Tesouro Selic', taxa: null },
  ipca: { nome: 'Tesouro IPCA+', curto: 'Tesouro IPCA+', taxa: { rotulo: 'IPCA +', sufixo: '% ao ano', padrao: 6 } },
  pre: { nome: 'Tesouro Prefixado', curto: 'Tesouro Prefixado', taxa: { rotulo: 'Taxa', sufixo: '% ao ano', padrao: 12 } },
  cdb: { nome: 'CDB (% do CDI)', curto: 'CDB', taxa: { rotulo: 'Rende', sufixo: '% do CDI', padrao: 100 } },
  lci: { nome: 'LCI/LCA (% do CDI, isenta)', curto: 'LCI/LCA', taxa: { rotulo: 'Rende', sufixo: '% do CDI', padrao: 90 } },
};
export const ehRendaFixa = (tipo) => tipo !== 'bolsa';

/** Séries do Banco Central que um item precisa (a Selic sempre vem: é o calendário de dias úteis). */
export function seriesNecessarias(itens) {
  const s = new Set(['selic']);
  for (const it of itens) {
    if (it.tipo === 'cdb' || it.tipo === 'lci') s.add('cdi');
    if (it.tipo === 'ipca') s.add('ipca');
  }
  return [...s];
}

/** Nome curto de um item ("PETR4", "Tesouro IPCA+ 6%", "CDB 110% CDI"). */
export function rotuloItem(it) {
  if (it.tipo === 'bolsa') return String(it.ticker || '').toUpperCase() || '—';
  const n = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  if (it.tipo === 'selic') return 'Tesouro Selic';
  if (it.tipo === 'ipca') return `Tesouro IPCA+ ${n(it.taxa)}%`;
  if (it.tipo === 'pre') return `Prefixado ${n(it.taxa)}%`;
  return `${TIPOS_SIM[it.tipo].curto} ${n(it.taxa)}% CDI`;
}

const diasEntre = (a, b) => Math.max(0, Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000));

/** Primeiro dia útil de cada mês, do mês inicial até a data final. */
export function datasDeAporte(calendario, inicioYm, fim) {
  const out = [];
  let mes = '';
  for (const d of calendario) {
    if (d < `${inicioYm}-01` || d > fim) continue;
    if (d.slice(0, 7) !== mes) { mes = d.slice(0, 7); out.push(d); }
  }
  return out;
}

/** Busca o último valor com data <= d numa lista ordenada [[data, valor], ...]. */
function ultimoAte(lista, d) {
  let lo = 0, hi = lista.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lista[m][0] <= d) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r < 0 ? null : lista[r][1];
}

/**
 * Roda a simulação de uma carteira.
 * @param {object} cfg  { inicio: 'AAAA-MM', aporte: número, reinvestir: bool, itens: [{tipo, ticker?, taxa?, peso}] }
 * @param {object} dados { precos: {TICKER: {dias, proventos, splits}}, indices: {selic, cdi?, ipca?} }
 */
export function simular(cfg, dados) {
  const calendario = (dados.indices.selic || []).map((x) => x[0]);
  if (!calendario.length) throw new Error('sem o calendário de dias úteis (Selic)');
  const pesoTotal = cfg.itens.reduce((s, it) => s + Math.max(0, Number(it.peso) || 0), 0);
  if (!pesoTotal) throw new Error('coloque um percentual em pelo menos um investimento');

  // o calendário de dias úteis manda; na bolsa vale o último fechamento até cada dia
  const fim = calendario[calendario.length - 1];
  for (const it of cfg.itens) {
    if (it.tipo === 'bolsa' && !dados.precos[it.ticker]?.dias?.length) throw new Error(`sem preços de ${it.ticker}`);
  }
  const aportes = new Set(datasDeAporte(calendario, cfg.inicio, fim));
  if (!aportes.size) throw new Error('nenhum dia útil no período escolhido');

  const selic = new Map(dados.indices.selic);
  const cdi = new Map(dados.indices.cdi || []);
  const ipca = dados.indices.ipca || [];
  const ipcaMes = (d) => ultimoAte(ipca, `${d.slice(0, 7)}-01`) ?? 0.4; // mês ainda não divulgado: repete o último

  // estado de cada item
  const pos = cfg.itens.map((it) => {
    const p = { ...it, peso: Math.max(0, Number(it.peso) || 0) / pesoTotal, aplicado: 0, custos: 0, proventos: 0, qtd: 0, lotes: [] };
    if (it.tipo === 'bolsa') {
      const h = dados.precos[it.ticker];
      p.dias = h.dias;
      p.provs = h.proventos || [];
      p.splits = h.splits || [];
      p.iProv = 0;
      p.fatorFuturo = (d) => p.splits.filter((s) => s.data > d).reduce((f, s) => f * s.fator, 1);
    }
    return p;
  });

  const fatorDoDia = (p, d) => {
    switch (p.tipo) {
      case 'selic': return 1 + (selic.get(d) ?? 0) / 100;
      case 'cdb': case 'lci': return 1 + ((cdi.get(d) ?? selic.get(d) ?? 0) / 100) * (Number(p.taxa) / 100);
      case 'pre': return Math.pow(1 + Number(p.taxa) / 100, 1 / 252);
      case 'ipca': return Math.pow(1 + ipcaMes(d) / 100, 1 / 21) * Math.pow(1 + Number(p.taxa) / 100, 1 / 252);
      default: return 1;
    }
  };
  const valorItem = (p, d) => (p.tipo === 'bolsa'
    ? p.qtd * (ultimoAte(p.dias, d) || 0)
    : p.lotes.reduce((s, l) => s + l.valor, 0));

  let caixa = 0; // sobra das compras (cotas inteiras) e proventos esperando o próximo aporte
  let provFora = 0; // proventos não reinvestidos (ficam com você)
  let aportado = 0;
  const serie = [];
  let anterior = null;

  for (const d of calendario) {
    if (d < `${cfg.inicio}-01` || d > fim) { if (d < `${cfg.inicio}-01`) anterior = d; continue; }
    // 1. a renda fixa rende o dia anterior
    if (anterior) {
      for (const p of pos) if (p.tipo !== 'bolsa') { const f = fatorDoDia(p, anterior); for (const l of p.lotes) l.valor *= f; }
    }
    // 2. proventos com data-com até hoje, para quem já tinha a cota
    for (const p of pos) {
      if (p.tipo !== 'bolsa') continue;
      while (p.iProv < p.provs.length && p.provs[p.iProv].data <= d) {
        const pv = p.provs[p.iProv++];
        if (anterior && pv.data > anterior && p.qtd > 0) {
          const v = p.qtd * pv.valor;
          p.proventos += v;
          if (cfg.reinvestir) caixa += v; else provFora += v;
        }
      }
    }
    // 3. aporte do mês
    if (aportes.has(d)) {
      aportado += cfg.aporte;
      const disponivel = caixa + cfg.aporte;
      let resta = disponivel;
      const cotasBolsa = [];
      for (const p of pos) {
        const verba = disponivel * p.peso;
        if (p.tipo === 'bolsa') {
          const adj = ultimoAte(p.dias, d);
          if (!adj) continue; // ainda não era negociado: a verba fica em caixa
          const fator = p.fatorFuturo(d);
          const precoReal = adj * fator;
          const custoCota = precoReal * (1 + TAXA_B3_PADRAO);
          const n = Math.floor(verba / custoCota + 1e-9);
          if (n > 0) { p.qtd += n * fator; p.aplicado += n * precoReal; p.custos += n * precoReal * TAXA_B3_PADRAO; resta -= n * custoCota; }
          cotasBolsa.push({ p, custoCota, fator, precoReal, falta: verba - n * custoCota });
        } else {
          p.lotes.push({ data: d, aplicado: verba, valor: verba });
          p.aplicado += verba;
          resta -= verba;
        }
      }
      // a sobra compra mais uma cota de quem ficou mais longe do percentual
      cotasBolsa.sort((a, b) => b.falta - a.falta);
      for (const c of cotasBolsa) {
        if (resta + 1e-9 >= c.custoCota) {
          c.p.qtd += c.fator; c.p.aplicado += c.precoReal; c.p.custos += c.precoReal * TAXA_B3_PADRAO; resta -= c.custoCota;
        }
      }
      caixa = Math.max(0, resta);
      serie.push({ data: d, aportado, total: pos.reduce((s, p) => s + valorItem(p, d), 0) + caixa + provFora, proventos: pos.reduce((s, p) => s + p.proventos, 0) });
    }
    anterior = d;
  }
  if (!serie.length || serie[serie.length - 1].data !== fim) {
    serie.push({ data: fim, aportado, total: pos.reduce((s, p) => s + valorItem(p, fim), 0) + caixa + provFora, proventos: pos.reduce((s, p) => s + p.proventos, 0) });
  }

  const linhas = pos.map((p) => {
    const valor = valorItem(p, fim);
    const ir = p.tipo === 'bolsa' || p.tipo === 'lci' ? 0
      : p.lotes.reduce((s, l) => s + Math.max(0, l.valor - l.aplicado) * aliquotaRendaFixa(diasEntre(l.data, fim)), 0);
    return {
      rotulo: rotuloItem(p), tipo: p.tipo, peso: p.peso, aplicado: p.aplicado + p.custos, custos: p.custos,
      qtd: p.tipo === 'bolsa' ? Math.round(p.qtd * 1000) / 1000 : null,
      preco: p.tipo === 'bolsa' ? ultimoAte(p.dias, fim) : null,
      valor, proventos: p.proventos, ir,
      resultado: valor + p.proventos - (p.aplicado + p.custos),
    };
  });
  const posicao = linhas.reduce((s, l) => s + l.valor, 0);
  const proventos = linhas.reduce((s, l) => s + l.proventos, 0);
  const total = posicao + caixa + provFora;
  const ir = linhas.reduce((s, l) => s + l.ir, 0);
  return {
    inicio: [...aportes][0], fim, meses: aportes.size, aportado, posicao, caixa, proventos, provFora,
    total, ganho: total - aportado, ganhoPct: aportado ? total / aportado - 1 : 0,
    // o ganho total se divide em valorização (preço das cotas ou rendimento da renda fixa) e proventos recebidos
    valorizacao: total - aportado - proventos, ir, liquido: total - ir,
    custos: linhas.reduce((s, l) => s + l.custos, 0), linhas, serie,
  };
}
