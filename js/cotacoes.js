// Cotações via brapi.dev (B3, atraso de ~30 min no plano gratuito).
// Sem token só funcionam ativos de teste (PETR4, VALE3, ITUB4, MGLU3).
// Com o token gratuito (brapi.dev/dashboard) funcionam todas as ações, FIIs, ETFs e BDRs.
// O plano gratuito aceita 1 ativo por requisição, então buscamos um de cada vez.

export async function buscarCotacao(ticker, token) {
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
  };
}

/** Atualiza em sequência; chama onProgresso(ativo, resultado|erro) a cada ativo. */
export async function atualizarTodas(ativos, token, onProgresso) {
  const daBolsa = ativos.filter((a) => a.tipo !== 'tesouro');
  let ok = 0;
  const erros = [];
  for (const a of daBolsa) {
    try {
      const q = await buscarCotacao(a.ticker, token);
      onProgresso(a, q, null);
      ok++;
    } catch (e) {
      onProgresso(a, null, e);
      erros.push({ ticker: a.ticker, msg: e.message });
    }
  }
  return { ok, erros, total: daBolsa.length };
}
