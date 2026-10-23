// Simulador: "e se eu tivesse aportado R$ X todo primeiro dia útil do mês desde tal mês?"
// Cálculos puros (sem DOM), para poder testar com Node.
//
// Ativos de bolsa (ações, FIIs, ETFs, BDRs): compra no fechamento do primeiro dia útil do mês,
// só cotas inteiras, com 0,03% de taxas da B3; o que sobra fica em caixa para o mês seguinte.
// Proventos (dividendos e JCP por cota, do Yahoo) entram para quem tinha a cota antes da data-com.
// Títulos do Tesouro Direto: compra pelo preço de compra do dia (frações de 0,01 título, sem taxa) e vale
// pelo preço de venda do dia (marcação a mercado, o que você receberia vendendo). Juros semestrais entram como
// provento, já sem o IR. Depois do vencimento, o valor fica parado.
// CDB e LCI/LCA (e os tipos antigos de Tesouro por taxa): o valor rende dia a dia pela taxa escolhida, sem
// marcação a mercado — é o valor "na curva", como se fosse levado até o vencimento.
import { TAXA_B3_PADRAO, aliquotaRendaFixa } from './calc.js';

/** Tipos de investimento que o simulador conhece. */
export const TIPOS_SIM = {
  bolsa: { nome: 'Ação, FII ou ETF', curto: 'Bolsa' },
  titulo: { nome: 'Tesouro Direto', curto: 'Tesouro' },
  cdb: { nome: 'CDB (% do CDI)', curto: 'CDB', taxa: { rotulo: 'Rende', sufixo: '% do CDI', padrao: 100 } },
  lci: { nome: 'LCI/LCA (% do CDI, isenta)', curto: 'LCI/LCA', taxa: { rotulo: 'Rende', sufixo: '% do CDI', padrao: 90 } },
  // antigos: Tesouro calculado só pela taxa (continuam funcionando nas carteiras já montadas)
  selic: { nome: 'Selic do dia (sem título)', curto: 'Tesouro Selic', taxa: null, antigo: true },
  ipca: { nome: 'IPCA + taxa fixa (sem título)', curto: 'Tesouro IPCA+', taxa: { rotulo: 'IPCA +', sufixo: '% ao ano', padrao: 6 }, antigo: true },
  pre: { nome: 'Prefixado com taxa fixa (sem título)', curto: 'Tesouro Prefixado', taxa: { rotulo: 'Taxa', sufixo: '% ao ano', padrao: 12 }, antigo: true },
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
  if (it.tipo === 'titulo') return it.nome || 'Tesouro Direto';
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
/** Opções de dia do aporte: 1º dia útil, um dia fixo do mês (vai para o próximo dia útil) ou o último dia útil. */
export const DIAS_APORTE = [['util1', '1º dia útil'], ...[5, 10, 15, 20, 25].map((n) => [String(n), `Dia ${n}`]), ['ultimo', 'Último dia útil']];

/**
 * Lançamentos de aporte entre cfg.de e cfg.ate: um por mês pela regra (cfg.dia), com as edições feitas à mão
 * (cfg.edicoes[chave] = { data, valor } ou { fora: true }) e os aportes extras (cfg.extras = [{ id, data, valor }]).
 * Datas sem pregão vão para o próximo dia útil. Devolve { lista, removidos }.
 */
export function agendaAportes(calendario, cfg) {
  const ini = cfg.de || `${cfg.inicio}-01`;
  const ultimoCal = calendario[calendario.length - 1];
  const fim = cfg.ate && cfg.ate < ultimoCal ? cfg.ate : ultimoCal;
  const dias = calendario.filter((d) => d >= ini && d <= fim);
  const proximoUtil = (d) => dias.find((x) => x >= d) || null;
  const porMes = groupByMes(dias);
  const regra = cfg.dia || 'util1';
  const lista = [], removidos = [];
  for (const [mes, ds] of porMes) {
    let base;
    if (regra === 'ultimo') base = ds[ds.length - 1];
    else if (regra === 'util1') base = ds[0];
    else base = ds.find((x) => x >= `${mes}-${String(regra).padStart(2, '0')}`) || null;
    if (!base) continue; // o dia escolhido ainda não chegou neste mês, ou caiu antes do início
    const e = cfg.edicoes?.[base];
    if (e?.fora) { removidos.push({ chave: base, data: base, valor: Number(cfg.aporte) }); continue; }
    const data = e?.data ? proximoUtil(e.data) : base;
    if (!data) continue;
    lista.push({ chave: base, data, valor: e?.valor != null ? Number(e.valor) : Number(cfg.aporte), editado: Boolean(e) });
  }
  for (const x of cfg.extras || []) {
    const data = x.data >= ini ? proximoUtil(x.data) : null;
    if (data) lista.push({ chave: `x:${x.id}`, extra: true, data, valor: Number(x.valor) || 0, editado: true });
  }
  lista.sort((a, b) => a.data.localeCompare(b.data) || (a.extra ? 1 : 0) - (b.extra ? 1 : 0));
  return { lista, removidos, ini, fim };
}
function groupByMes(dias) {
  const m = new Map();
  for (const d of dias) { const k = d.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
  return m;
}

/** Busca, numa lista ordenada [[data, ...], ...], a última linha com data <= d. */
function linhaAte(lista, d) {
  let lo = 0, hi = lista.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (lista[m][0] <= d) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r < 0 ? null : lista[r];
}
const ultimoAte = (lista, d) => linhaAte(lista, d)?.[1] ?? null;

/** Como o preço de compra é escolhido no dia: fechamento (fim do pregão), abertura (início) ou médio (meio da faixa do dia). */
export const PRECOS_COMPRA = {
  fechamento: ['Fechamento', 'o último preço do dia, por volta das 18h'],
  abertura: ['Abertura', 'o primeiro preço do dia, às 10h'],
  medio: ['Médio do dia', 'o meio entre a mínima e a máxima do dia'],
};

/** Nomes dos tipos de provento no simulador. */
export const TIPOS_PROV_SIM = {
  dividendo: 'Dividendo',
  jcp: 'JCP',
  rendimento: 'Rendimento',
  juros: 'Juros do Tesouro',
  outro: 'Outro provento',
  provento: 'Provento (tipo não informado)',
};
export const IR_JCP = 0.15; // JCP tem 15% de IR retido na fonte; dividendos e rendimentos de FII são isentos

/** Classe do item, com as mesmas chaves do gráfico do Histórico: acao, fii, outros (ETF/BDR), tesouro, rf. */
export function classeSim(it) {
  if (it.tipo === 'bolsa') return it.classe === 'fii' ? 'fii' : ['etf', 'bdr'].includes(it.classe) ? 'outros' : 'acao';
  if (it.tipo === 'titulo') return 'tesouro';
  return it.tipo === 'cdb' || it.tipo === 'lci' ? 'rf' : 'tesouro';
}

/**
 * Roda a simulação de uma carteira.
 * @param {object} cfg  { inicio: 'AAAA-MM', aporte: número, proventos: 'dentro' | 'somar' | 'guardar', preco: 'fechamento' | 'abertura' | 'medio', itens: [{tipo, ticker?, taxa?, peso}] }
 *   proventos 'dentro': o aporte é o total investido no mês; os proventos recebidos desde o aporte anterior pagam parte e do bolso sai só a diferença.
 *   proventos 'somar':  sai o aporte inteiro do bolso e os proventos entram por cima.
 *   proventos 'guardar': sai o aporte inteiro do bolso e os proventos ficam com você, fora da carteira.
 * @param {object} dados { precos: {TICKER: {dias: [[dia, fech, abert, mín, máx]], proventos: [{data (ex), valor, tipo?, pagamento?, com?}], splits}}, indices: {selic, cdi?, ipca?},
 *   titulos: {ID: {venc, indexador, dias: [[dia, taxaCompra, taxaVenda, puCompra, puVenda, estimado?]], cupons: [[dia, valor por título]]}} }
 *
 * Proventos: o direito é de quem tinha a cota no fim da data-com (antes da data ex); o dinheiro entra na data de
 * pagamento (sem a data, na própria data ex). JCP entra líquido, já sem os 15% de IR.
 */
export function simular(cfg, dados) {
  const calendario = (dados.indices.selic || []).map((x) => x[0]);
  if (!calendario.length) throw new Error('sem o calendário de dias úteis (Selic)');
  const pesoTotal = cfg.itens.reduce((s, it) => s + Math.max(0, Number(it.peso) || 0), 0);
  if (!pesoTotal) throw new Error('coloque um percentual em pelo menos um investimento');
  for (const it of cfg.itens) {
    if (it.tipo === 'bolsa' && !dados.precos[it.ticker]?.dias?.length) throw new Error(`sem preços de ${it.ticker}`);
    if (it.tipo === 'titulo' && !dados.titulos?.[it.titulo]?.dias?.length) throw new Error(`sem preços de ${it.nome || it.titulo}`);
  }
  const agenda = agendaAportes(calendario, cfg);
  const fim = agenda.fim;
  const inicioDia = agenda.ini;
  if (fim < inicioDia) throw new Error('o fim do período vem antes do início');
  const aportes = new Map();
  for (const a of agenda.lista) { if (!aportes.has(a.data)) aportes.set(a.data, []); aportes.get(a.data).push(a); }
  if (!agenda.lista.length) throw new Error('nenhum aporte no período escolhido');
  const modo = cfg.proventos || (cfg.reinvestir === false ? 'guardar' : 'dentro');
  const modoPreco = PRECOS_COMPRA[cfg.preco] ? cfg.preco : 'fechamento';

  const selic = new Map(dados.indices.selic);
  const cdi = new Map(dados.indices.cdi || []);
  const ipca = dados.indices.ipca || [];
  const ipcaMes = (d) => ultimoAte(ipca, `${d.slice(0, 7)}-01`) ?? 0.4; // mês ainda não divulgado: repete o último

  const pos = cfg.itens.map((it) => {
    const p = { ...it, classe: classeSim(it), rotulo: rotuloItem(it), peso: Math.max(0, Number(it.peso) || 0) / pesoTotal, aplicado: 0, custos: 0, proventos: 0, porTipo: {}, qtd: 0, lotes: [] };
    if (it.tipo === 'bolsa') {
      const h = dados.precos[it.ticker];
      p.dias = h.dias;
      p.fii = Boolean(h.fii) || it.classe === 'fii';
      if (p.fii) p.classe = 'fii';
      p.splits = h.splits || [];
      p.fatorFuturo = (d) => p.splits.filter((s) => s.data > d).reduce((f, s) => f * s.fator, 1);
      p.provs = (h.proventos || []).filter((x) => x.data >= inicioDia).map((x) => ({ ...x, tipo: x.tipo || (p.fii ? 'rendimento' : 'provento') }));
      p.iProv = 0;
    } else if (it.tipo === 'titulo') {
      const h = dados.titulos[it.titulo];
      p.ticker = p.rotulo;
      p.venc = h.venc;
      p.dias = h.dias;
      p.cupons = (h.cupons || []).filter((c) => c[0] >= inicioDia);
      p.iCupom = 0;
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
  const puVenda = (p, d) => linhaAte(p.dias, d)?.[4] || 0;
  const valorItem = (p, d) => (p.tipo === 'bolsa' ? p.qtd * (ultimoAte(p.dias, d) || 0) : p.tipo === 'titulo' ? p.qtd * puVenda(p, d) : p.lotes.reduce((s, l) => s + l.valor, 0));
  const valorRF = (d) => pos.reduce((s, p) => s + (p.tipo === 'bolsa' ? 0 : valorItem(p, d)), 0);

  let caixa = 0; // sobra das compras (cotas inteiras), fica para o mês seguinte
  let provPend = 0; // proventos recebidos desde o último aporte, esperando o próximo
  let provFora = 0; // proventos guardados (ficam com você, fora da carteira)
  let bolso = 0; // o que de fato saiu do seu bolso
  let reinvestido = 0; // proventos que entraram nas compras
  const aReceber = []; // proventos com direito já garantido, mas pagos depois do fim da simulação
  const ops = []; // todas as operações, na ordem: aporte, compra, aplicacao, provento
  const serie = [];
  const meses = new Map();
  const doMes = (d) => {
    const k = d.slice(0, 7);
    if (!meses.has(k)) meses.set(k, { mes: k, bolso: 0, reinvestido: 0, proventos: 0, provTipos: {}, valorFim: 0, rfFim: 0, rfAplicado: 0, aplicado: {}, valorClasse: {} });
    return meses.get(k);
  };
  const totalEm = (d) => pos.reduce((s, p) => s + valorItem(p, d), 0) + caixa + provPend + provFora;
  const receber = (x, d) => {
    // dinheiro do provento entrando
    x.p.proventos += x.valor;
    x.p.porTipo[x.tipo] = (x.p.porTipo[x.tipo] || 0) + x.valor;
    const m = doMes(d);
    m.proventos += x.valor;
    m.provTipos[x.tipo] = (m.provTipos[x.tipo] || 0) + x.valor;
    if (modo === 'guardar') provFora += x.valor; else provPend += x.valor;
    ops.push({ tipo: 'provento', data: d, ticker: x.p.ticker, ptipo: x.tipo, ex: x.ex, com: x.com, cotas: x.cotas, porCota: x.porCota, bruto: x.bruto, ir: x.ir, valor: x.valor });
  };
  let aPagar = []; // direitos já garantidos esperando a data de pagamento
  let anterior = null;

  for (const d of calendario) {
    if (d > fim) break;
    if (d < inicioDia) { anterior = d; continue; }
    // 1. a renda fixa rende o dia anterior
    if (anterior) for (const p of pos) if (p.tipo !== 'bolsa' && p.tipo !== 'titulo') { const f = fatorDoDia(p, anterior); for (const l of p.lotes) l.valor *= f; }
    // juros semestrais dos títulos: pagos a quem tinha o título, com o IR da tabela regressiva de cada compra
    for (const p of pos) {
      if (p.tipo !== 'titulo') continue;
      while (p.iCupom < p.cupons.length && p.cupons[p.iCupom][0] <= d) {
        const [dia, porTitulo] = p.cupons[p.iCupom++];
        if (p.qtd <= 0) continue;
        const bruto = p.qtd * porTitulo;
        const ir = p.lotes.reduce((s, l) => s + l.qtd * porTitulo * aliquotaRendaFixa(diasEntre(l.data, dia)), 0);
        receber({ p, tipo: 'juros', ex: dia, cotas: p.qtd, porCota: porTitulo, bruto, ir, valor: bruto - ir }, d);
      }
    }
    // 2. data ex chegou: quem tinha a cota antes ganha o direito ao provento
    for (const p of pos) {
      if (p.tipo !== 'bolsa') continue;
      while (p.iProv < p.provs.length && p.provs[p.iProv].data <= d) {
        const pv = p.provs[p.iProv++];
        if (p.qtd <= 0) continue;
        const fator = p.fatorFuturo(pv.data); // cotas e valor como eram naquele dia
        const bruto = p.qtd * pv.valor;
        const ir = pv.tipo === 'jcp' ? bruto * IR_JCP : 0;
        aPagar.push({ p, tipo: pv.tipo, ex: pv.data, com: pv.com || null, pag: pv.pagamento && pv.pagamento >= pv.data ? pv.pagamento : pv.data,
          cotas: p.qtd / fator, porCota: pv.valor * fator, bruto, ir, valor: bruto - ir });
      }
    }
    // 3. pagamentos do dia
    const hoje = aPagar.filter((x) => x.pag <= d);
    aPagar = aPagar.filter((x) => x.pag > d);
    for (const x of hoje) receber(x, d);
    // 4. aportes do dia (normalmente um por mês; edições e extras podem cair no mesmo dia)
    for (const ap of aportes.get(d) || []) {
      const m = doMes(d);
      const investir = modo === 'dentro' ? Math.max(ap.valor, provPend) : ap.valor + provPend;
      const doBolso = modo === 'dentro' ? Math.max(0, ap.valor - provPend) : ap.valor;
      ops.push({ tipo: 'aporte', data: d, chave: ap.chave, extra: Boolean(ap.extra), editado: ap.editado, valor: ap.valor, bolso: doBolso, reinvestido: provPend, sobra: caixa, total: investir + caixa });
      bolso += doBolso; reinvestido += provPend; m.bolso += doBolso; m.reinvestido += provPend;
      provPend = 0;
      const disponivel = caixa + investir;
      let resta = disponivel;
      const compras = [];
      for (const p of pos) {
        const verba = disponivel * p.peso;
        if (p.tipo === 'bolsa') {
          const vela = linhaAte(p.dias, d);
          if (!vela) continue; // ainda não era negociado: a verba fica em caixa
          const fator = p.fatorFuturo(d);
          const adj = modoPreco === 'abertura' ? vela[2] : modoPreco === 'medio' ? (vela[3] + vela[4]) / 2 : vela[1];
          const precoReal = Math.round(adj * fator * 100) / 100; // como aparecia no home broker naquele dia
          const custoCota = precoReal * (1 + TAXA_B3_PADRAO);
          const n = Math.floor(verba / custoCota + 1e-9);
          const c = { p, d, fator, precoReal, custoCota, n, falta: verba - n * custoCota, vela, diaVela: vela[0] };
          resta -= n * custoCota;
          compras.push(c);
        } else if (p.tipo === 'titulo') {
          const linha = linhaAte(p.dias, d);
          if (!linha || d >= p.venc) continue; // ainda não existia, ou já venceu: a verba fica em caixa
          const pu = linha[3] || linha[4];
          const n = Math.floor((verba / pu) * 100 + 1e-9) / 100; // o Tesouro vende em frações de 0,01 título
          if (n <= 0) continue;
          const valor = n * pu;
          p.qtd = Math.round((p.qtd + n) * 100) / 100;
          p.lotes.push({ data: d, qtd: n, aplicado: valor });
          p.aplicado += valor;
          m.rfAplicado += valor;
          m.aplicado[p.classe] = (m.aplicado[p.classe] || 0) + valor;
          resta -= valor;
          ops.push({ tipo: 'aplicacao', data: d, rotulo: p.rotulo, rf: 'titulo', valor, qtd: n, preco: pu, taxa: linha[1], indexador: dados.titulos[p.titulo].indexador, diaPreco: linha[0], estimado: Boolean(linha[5]) });
        } else if (verba > 0) {
          p.lotes.push({ data: d, aplicado: verba, valor: verba });
          p.aplicado += verba;
          m.rfAplicado += verba;
          m.aplicado[p.classe] = (m.aplicado[p.classe] || 0) + verba;
          resta -= verba;
          ops.push({ tipo: 'aplicacao', data: d, rotulo: p.rotulo, rf: p.tipo, valor: verba });
        }
      }
      // a sobra compra mais uma cota de quem ficou mais longe do percentual
      compras.slice().sort((a, b) => b.falta - a.falta).forEach((c) => { if (resta + 1e-9 >= c.custoCota) { c.n++; resta -= c.custoCota; } });
      for (const c of compras) {
        if (!c.n) continue;
        const custo = c.n * c.precoReal * TAXA_B3_PADRAO;
        c.p.qtd += c.n * c.fator; c.p.aplicado += c.n * c.precoReal; c.p.custos += custo;
        m.aplicado[c.p.classe] = (m.aplicado[c.p.classe] || 0) + c.n * c.precoReal + custo;
        ops.push({ tipo: 'compra', data: d, ticker: c.p.ticker, fii: c.p.fii, qtd: c.n, preco: c.precoReal, custo, total: c.n * c.precoReal + custo,
          diaPregao: c.diaVela, abertura: c.vela[2] * c.fator, minima: c.vela[3] * c.fator, maxima: c.vela[4] * c.fator, fechamento: c.vela[1] * c.fator });
      }
      caixa = Math.max(0, resta);
      serie.push({ data: d, bolso, total: totalEm(d), proventos: pos.reduce((s, p) => s + p.proventos, 0) });
    }
    const mf = doMes(d); // o último dia útil do mês fica por último
    mf.valorFim = totalEm(d);
    mf.rfFim = valorRF(d);
    mf.valorClasse = {};
    for (const p of pos) mf.valorClasse[p.classe] = (mf.valorClasse[p.classe] || 0) + valorItem(p, d);
    anterior = d;
  }
  if (!serie.length || serie[serie.length - 1].data !== fim) serie.push({ data: fim, bolso, total: totalEm(fim), proventos: pos.reduce((s, p) => s + p.proventos, 0) });
  for (const x of aPagar) aReceber.push({ ticker: x.p.ticker, tipo: x.tipo, ex: x.ex, com: x.com, pagamento: x.pag, cotas: x.cotas, porCota: x.porCota, bruto: x.bruto, ir: x.ir, valor: x.valor });

  const linhas = pos.map((p) => {
    const valor = valorItem(p, fim);
    const ir = p.tipo === 'bolsa' || p.tipo === 'lci' ? 0
      : p.tipo === 'titulo' ? p.lotes.reduce((s, l) => s + Math.max(0, l.qtd * puVenda(p, fim) - l.aplicado) * aliquotaRendaFixa(diasEntre(l.data, fim)), 0)
      : p.lotes.reduce((s, l) => s + Math.max(0, l.valor - l.aplicado) * aliquotaRendaFixa(diasEntre(l.data, fim)), 0);
    return {
      rotulo: p.rotulo, tipo: p.tipo, classe: p.classe, ticker: p.ticker, fii: p.fii, peso: p.peso, aplicado: p.aplicado + p.custos, custos: p.custos,
      qtd: p.tipo === 'bolsa' ? Math.round(p.qtd * 1000) / 1000 : p.tipo === 'titulo' ? p.qtd : null,
      preco: p.tipo === 'bolsa' ? ultimoAte(p.dias, fim) : p.tipo === 'titulo' ? puVenda(p, fim) : null,
      // título: se venceu no período, desde quando existe e se o preço do fim é estimado
      venc: p.venc || null, venceu: p.venc ? p.venc <= fim : false, desde: p.tipo === 'titulo' ? p.dias[0][0] : null,
      estimado: p.tipo === 'titulo' ? Boolean(linhaAte(p.dias, fim)?.[5]) : false,
      valor, proventos: p.proventos, porTipo: p.porTipo, ir,
      // valorização das cotas (bolsa) ou rendimento (renda fixa)
      valorizacao: valor - (p.aplicado + p.custos),
      resultado: valor + p.proventos - (p.aplicado + p.custos),
    };
  });
  const posicao = linhas.reduce((s, l) => s + l.valor, 0);
  const proventos = linhas.reduce((s, l) => s + l.proventos, 0);
  const total = posicao + caixa + provPend + provFora;
  const ir = linhas.reduce((s, l) => s + l.ir, 0);
  const rendimentoRF = linhas.filter((l) => l.tipo !== 'bolsa').reduce((s, l) => s + l.valorizacao, 0);
  const provTipos = {};
  for (const l of linhas) for (const [k, v] of Object.entries(l.porTipo)) provTipos[k] = (provTipos[k] || 0) + v;
  const irJcp = ops.filter((o) => o.tipo === 'provento' && o.ptipo === 'jcp').reduce((s, o) => s + o.ir, 0);
  const irJuros = ops.filter((o) => o.tipo === 'provento' && o.ptipo === 'juros').reduce((s, o) => s + o.ir, 0);
  const valorizacao = total - bolso - proventos;
  return {
    inicio: agenda.lista[0].data, de: inicioDia, fim, ateHoje: fim === calendario[calendario.length - 1], nAportes: agenda.lista.length,
    agenda: agenda.lista, removidos: agenda.removidos, nEditados: agenda.lista.filter((a) => a.editado).length + agenda.removidos.length, modo, modoPreco, aporteMes: cfg.aporte,
    bolso, reinvestido, investido: bolso + reinvestido, posicao, caixa, provPend, proventos, provTipos, irJcp, irJuros, provFora,
    aReceber, aReceberTotal: aReceber.reduce((s, x) => s + x.valor, 0),
    // ganho sobre o que saiu do bolso = valorização das cotas + rendimento da renda fixa + proventos recebidos
    total, ganho: total - bolso, ganhoPct: bolso ? total / bolso - 1 : 0,
    valorizacao, rendimentoRF, valorizacaoBolsa: valorizacao - rendimentoRF,
    ir, liquido: total - ir, custos: linhas.reduce((s, l) => s + l.custos, 0),
    linhas, serie, porMes: [...meses.values()], ops,
  };
}

/**
 * Junta os meses em períodos ('mes' | 'ano' | 'tudo'). Em cada período:
 * ganho = valor no fim − valor no início − o que saiu do bolso = valorização das cotas + rendimento da renda fixa + proventos.
 * Somando os períodos dá exatamente o total da simulação.
 */
export function resumoPorPeriodoSim(porMes, periodo) {
  const chave = (m) => (periodo === 'ano' ? m.slice(0, 4) : periodo === 'tudo' ? 'tudo' : m);
  const out = [];
  let valorAntes = 0, rfAntes = 0;
  for (const m of porMes) {
    const k = chave(m.mes);
    let g = out[out.length - 1];
    if (!g || g.chave !== k) { g = { chave: k, de: m.mes, ate: m.mes, valorIni: valorAntes, rfIni: rfAntes, bolso: 0, reinvestido: 0, proventos: 0, provTipos: {}, rfAplicado: 0, valorFim: 0, rfFim: 0 }; out.push(g); }
    g.ate = m.mes;
    g.bolso += m.bolso; g.reinvestido += m.reinvestido; g.proventos += m.proventos; g.rfAplicado += m.rfAplicado;
    for (const [t, v] of Object.entries(m.provTipos)) g.provTipos[t] = (g.provTipos[t] || 0) + v;
    g.valorFim = m.valorFim; g.rfFim = m.rfFim;
    valorAntes = m.valorFim; rfAntes = m.rfFim;
  }
  for (const g of out) {
    g.ganho = g.valorFim - g.valorIni - g.bolso;
    g.valorizacao = g.ganho - g.proventos;
    g.rendimentoRF = g.rfFim - g.rfIni - g.rfAplicado;
    g.valorizacaoBolsa = g.valorizacao - g.rendimentoRF;
    const base = g.valorIni + g.bolso;
    g.ganhoPct = base ? g.ganho / base : null; // sobre o que já havia mais o que entrou do bolso no período
  }
  return out;
}
