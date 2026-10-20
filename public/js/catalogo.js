// Ativos conhecidos da B3, para escolher sem precisar lembrar o código.
// A busca do simulador também procura pelo Worker (Yahoo / brapi) qualquer ativo que não esteja aqui.
// classe: acao | fii | etf

export const CATALOGO = [
  // ações
  ['BBAS3', 'Banco do Brasil', 'acao'],
  ['PETR4', 'Petrobras PN', 'acao'],
  ['PETR3', 'Petrobras ON', 'acao'],
  ['VALE3', 'Vale', 'acao'],
  ['ITUB4', 'Itaú Unibanco', 'acao'],
  ['ITSA4', 'Itaúsa', 'acao'],
  ['BBDC4', 'Bradesco PN', 'acao'],
  ['BBDC3', 'Bradesco ON', 'acao'],
  ['SANB11', 'Santander Brasil', 'acao'],
  ['BPAC11', 'BTG Pactual', 'acao'],
  ['BRSR6', 'Banrisul PNB', 'acao'],
  ['BRSR3', 'Banrisul ON', 'acao'],
  ['BBSE3', 'BB Seguridade', 'acao'],
  ['CXSE3', 'Caixa Seguridade', 'acao'],
  ['PSSA3', 'Porto Seguro', 'acao'],
  ['B3SA3', 'B3', 'acao'],
  ['ABEV3', 'Ambev', 'acao'],
  ['WEGE3', 'WEG', 'acao'],
  ['TAEE11', 'Taesa (unit)', 'acao'],
  ['TAEE4', 'Taesa PN', 'acao'],
  ['TAEE3', 'Taesa ON', 'acao'],
  ['EGIE3', 'Engie Brasil', 'acao'],
  ['CMIG4', 'Cemig PN', 'acao'],
  ['CPFE3', 'CPFL Energia', 'acao'],
  ['ISAE4', 'ISA Energia', 'acao'],
  ['ALUP11', 'Alupar (unit)', 'acao'],
  ['SAPR11', 'Sanepar (unit)', 'acao'],
  ['SAPR4', 'Sanepar PN', 'acao'],
  ['SBSP3', 'Sabesp', 'acao'],
  ['KLBN11', 'Klabin (unit)', 'acao'],
  ['SUZB3', 'Suzano', 'acao'],
  ['GGBR4', 'Gerdau', 'acao'],
  ['GOAU4', 'Metalúrgica Gerdau', 'acao'],
  ['CSNA3', 'CSN', 'acao'],
  ['CMIN3', 'CSN Mineração', 'acao'],
  ['USIM5', 'Usiminas', 'acao'],
  ['PRIO3', 'PRIO', 'acao'],
  ['RECV3', 'PetroReconcavo', 'acao'],
  ['VBBR3', 'Vibra Energia', 'acao'],
  ['UGPA3', 'Ultrapar', 'acao'],
  ['RENT3', 'Localiza', 'acao'],
  ['RADL3', 'Raia Drogasil', 'acao'],
  ['LREN3', 'Lojas Renner', 'acao'],
  ['MGLU3', 'Magazine Luiza', 'acao'],
  ['TIMS3', 'TIM', 'acao'],
  ['VIVT3', 'Telefônica Vivo', 'acao'],
  // fundos imobiliários
  ['MXRF11', 'Maxi Renda', 'fii'],
  ['KNSC11', 'Kinea Securities', 'fii'],
  ['KNCR11', 'Kinea Rendimentos Imobiliários', 'fii'],
  ['KNIP11', 'Kinea Índices de Preços', 'fii'],
  ['KNRI11', 'Kinea Renda Imobiliária', 'fii'],
  ['VGIR11', 'Valora RE III', 'fii'],
  ['VGHF11', 'Valora Hedge Fund', 'fii'],
  ['IRIM11', 'Iridium Recebíveis Imobiliários', 'fii'],
  ['CPTS11', 'Capitânia Securities', 'fii'],
  ['RECR11', 'REC Recebíveis', 'fii'],
  ['MCCI11', 'Mauá Capital Recebíveis', 'fii'],
  ['HGLG11', 'CSHG Logística', 'fii'],
  ['BTLG11', 'BTG Logística', 'fii'],
  ['XPLG11', 'XP Log', 'fii'],
  ['XPML11', 'XP Malls', 'fii'],
  ['VISC11', 'Vinci Shopping Centers', 'fii'],
  ['HGBS11', 'Hedge Brasil Shopping', 'fii'],
  ['HGRU11', 'CSHG Renda Urbana', 'fii'],
  ['TGAR11', 'TG Ativo Real', 'fii'],
  // ETFs
  ['BOVA11', 'iShares Ibovespa', 'etf'],
  ['SMAL11', 'iShares Small Cap', 'etf'],
  ['IVVB11', 'iShares S&P 500', 'etf'],
  ['DIVO11', 'It Now IDIV (dividendos)', 'etf'],
  ['NASD11', 'Trend Nasdaq 100', 'etf'],
  ['GOLD11', 'Trend Ouro', 'etf'],
  ['HASH11', 'Hashdex Nasdaq Crypto', 'etf'],
].map(([ticker, nome, classe]) => ({ ticker, nome, classe }));

export const NOME_CLASSE_CAT = { acao: 'Ações', fii: 'Fundos imobiliários', etf: 'ETFs', bdr: 'BDRs' };

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Procura por código ou nome, sem ligar para acentos e maiúsculas. Códigos que começam com o texto vêm primeiro. */
export function buscarNoCatalogo(lista, q) {
  const t = semAcento(q).trim();
  if (!t) return lista;
  const partes = t.split(/\s+/);
  return lista
    .map((a) => {
      const cod = semAcento(a.ticker), nome = semAcento(a.nome);
      if (!partes.every((p) => cod.includes(p) || nome.includes(p))) return null;
      return { a, nota: cod.startsWith(t) ? 0 : nome.startsWith(t) ? 1 : 2 };
    })
    .filter(Boolean)
    .sort((x, y) => x.nota - y.nota || x.a.ticker.localeCompare(y.a.ticker))
    .map((x) => x.a);
}
