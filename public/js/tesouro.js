// Títulos do Tesouro Direto: lista com o preço de hoje e histórico diário de cada um.
// Os dados vêm das planilhas oficiais do Tesouro e da ANBIMA, montados todo dia útil pelo
// GitHub Actions (scripts/tesouro.py) e entregues pelo Worker em /api/tesouro/*.

const CHAVE = 'meus-investimentos:tesouro';
const VALIDADE = 3 * 3600e3; // a lista muda uma vez por dia útil

let lista = null; // promessa da lista
const historicos = new Map();

async function api(caminho) {
  const r = await fetch(`/api/${caminho}`, { headers: { Accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.erro) throw new Error(j?.erro || `erro ${r.status}`);
  return j;
}

/** { atualizado, tesouroAte, anbimaAte, titulos: [{ id, tipo, nome, venc, indexador, desde, ate, aVenda, hoje }] } */
export function carregarTitulos() {
  if (lista) return lista;
  let guardado = null;
  try { guardado = JSON.parse(localStorage.getItem(CHAVE) || 'null'); } catch { /* sem armazenamento */ }
  const fresco = guardado && Date.now() - guardado.em < VALIDADE;
  lista = fresco ? Promise.resolve(guardado.dados) : api('tesouro/titulos').then((dados) => {
    try { localStorage.setItem(CHAVE, JSON.stringify({ em: Date.now(), dados })); } catch { /* sem armazenamento */ }
    return dados;
  }).catch((e) => {
    lista = null;
    if (guardado) return guardado.dados; // sem internet: usa a última lista
    throw e;
  });
  return lista;
}

/** { id, tipo, nome, venc, indexador, dias: [[data, taxaCompra, taxaVenda, puCompra, puVenda, estimado?]], cupons: [[data, valor]] } */
export function historicoTitulo(id) {
  if (!historicos.has(id)) {
    const p = api(`tesouro/titulo/${id}`);
    p.catch(() => historicos.delete(id));
    historicos.set(id, p);
  }
  return historicos.get(id);
}

const normal = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Títulos que combinam com a busca ("ipca 2035", "selic", "renda+"). Os à venda vêm primeiro. */
export function buscarTitulos(titulos, q) {
  const partes = normal(q).replace(/tesouro/g, '').split(' ').filter(Boolean);
  if (!partes.length) return titulos;
  return titulos.filter((t) => {
    const alvo = `${normal(t.nome)} ${t.venc.slice(0, 4)} ${t.tipo.toLowerCase()}`;
    return partes.every((p) => alvo.includes(p));
  });
}

/** Acha o título pelo nome que está na lista de ativos ("Tesouro IPCA+ 2035", "Tesouro Selic 2031"). */
export function tituloPorNome(titulos, nome) {
  const n = normal(nome);
  const exato = titulos.find((t) => normal(t.nome) === n);
  if (exato) return exato;
  // nome abreviado ("Tesouro Renda+ 2030"): mesmo ano e o nome do título começa igual
  const [, base, ano] = n.match(/^(.*?) ?(\d{4})$/) || [];
  if (!ano) return null;
  const cands = titulos.filter((t) => t.nome.endsWith(ano) && normal(t.nome).replace(/ \d{4}$/, '').startsWith(base));
  return cands.find((t) => t.aVenda) || cands[0] || null;
}

/** Nome curto do indexador, para chips e legendas. */
export const INDEXADORES = { selic: 'Selic', pre: 'Prefixado', ipca: 'IPCA+' };

/** "taxa 6,63% ao ano" ou "Selic + 0,09%" — como o Tesouro mostra a taxa de compra. */
export function taxaTexto(t, taxa = t.hoje?.taxaCompra) {
  if (taxa == null) return '';
  const pc = (x) => `${(x * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
  if (t.indexador === 'selic') return `Selic ${taxa >= 0 ? '+' : '−'} ${pc(Math.abs(taxa))}`;
  if (t.indexador === 'ipca') return `IPCA + ${pc(taxa)}`;
  return `${pc(taxa)} ao ano`;
}
