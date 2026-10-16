// Cotações.
// Com a nuvem ligada (Cloudflare): o Worker busca no Yahoo Finance (atraso de ~15 min na B3)
// e usa a brapi como reserva. Tudo numa requisição só.
// Sem a nuvem: busca direto na brapi.dev, um ativo por vez (atraso de ~30 min no plano grátis;
// sem token só PETR4, VALE3, ITUB4 e MGLU3).
import { nuvem, cotacoesNuvem } from './nuvem.js';
const ativa = () => nuvem.servidor;

export async function buscarCotacao(ticker, token) {
  if (ativa()) {
    const r = await cotacoesNuvem([ticker], token);
    const q = r[ticker.toUpperCase()];
    if (!q || q.erro) throw new Error(q?.erro || 'sem cotação');
    return q;
  }
  return buscarBrapi(ticker, token);
}

async function buscarBrapi(ticker, token) {
  const url = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(ticker.trim().toUpperCase())}`);
  if (token) url.searchParams.set('token', token.trim());
  let r;
  try {
    r = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('sem conexão com a brapi');
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 401) throw new Error(token ? 'token inválido' : 'precisa de token');
    if (r.status === 402 || r.status === 403) throw new Error('precisa de token');
    if (r.status === 404) throw new Error('ticker não encontrado');
    if (r.status === 429) throw new Error('limite de requisições');
    throw new Error(j?.message || `erro ${r.status}`);
  }
  const q = j?.results?.[0];
  if (!q || typeof q.regularMarketPrice !== 'number') throw new Error('sem preço');
  return {
    preco: q.regularMarketPrice,
    em: q.regularMarketTime || new Date().toISOString(),
    nome: q.longName || q.shortName || null,
    variacao: typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : null,
    fonte: 'brapi',
  };
}

/** Atualiza os ativos de bolsa; chama onProgresso(ativo, cotação|null, erro|null) para cada um. */
export async function atualizarTodas(ativos, token, onProgresso) {
  const daBolsa = ativos.filter((a) => a.tipo !== 'tesouro');
  let ok = 0;
  const erros = [];
  const registrar = (a, q, e) => {
    onProgresso(a, q, e);
    if (q) ok++; else erros.push({ ticker: a.ticker, msg: e.message });
  };

  if (ativa() && daBolsa.length) {
    try {
      const r = await cotacoesNuvem(daBolsa.map((a) => a.ticker.toUpperCase()), token);
      for (const a of daBolsa) {
        const q = r[a.ticker.toUpperCase()];
        if (q && !q.erro) registrar(a, q, null);
        else registrar(a, null, new Error(q?.erro || 'sem cotação'));
      }
      return { ok, erros, total: daBolsa.length };
    } catch {
      // nuvem fora do ar: tenta direto na brapi
    }
  }

  for (const a of daBolsa) {
    try { registrar(a, await buscarBrapi(a.ticker, token), null); } catch (e) { registrar(a, null, e); }
  }
  return { ok, erros, total: daBolsa.length };
}
