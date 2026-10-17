// Worker do Meus Investimentos.
// - Serve o site (pasta public/) e a API em /api/*.
// - Guarda ativos, compras, proventos e ajustes no D1 (binding DB).
// - Busca cotações no Yahoo Finance (atraso de ~15 min na B3), com a brapi como reserva.
// - Os dados exigem a senha definida na variável SENHA; /api/saude, /api/cotacoes, /api/historico e /api/preco-dia são públicos.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS config (chave TEXT PRIMARY KEY, valor TEXT NOT NULL, atualizado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS ativos (id TEXT PRIMARY KEY, ticker TEXT NOT NULL, tipo TEXT NOT NULL, nome TEXT, preco REAL, preco_em TEXT, fonte TEXT, ordem INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS compras (id TEXT PRIMARY KEY, data TEXT NOT NULL, ticker TEXT NOT NULL, tipo TEXT, qtd REAL NOT NULL, preco REAL NOT NULL, custo REAL DEFAULT 0, banco TEXT, criado_em TEXT)`,
  `CREATE TABLE IF NOT EXISTS proventos (id TEXT PRIMARY KEY, data TEXT NOT NULL, ticker TEXT NOT NULL, tipo TEXT, valor REAL NOT NULL, criado_em TEXT)`,
  `CREATE INDEX IF NOT EXISTS compras_data ON compras(data)`,
  `CREATE INDEX IF NOT EXISTS proventos_data ON proventos(data)`,
];
const CHAVES_CONFIG = new Set(['ajustes', 'bancos', 'plano']);
const TIPOS = new Set(['acao', 'fii', 'etf', 'bdr', 'tesouro']);

let schemaPronto = false;
async function garantirSchema(db) {
  if (schemaPronto) return;
  await db.batch(SCHEMA.map((s) => db.prepare(s)));
  // colunas novas em bancos criados por versões anteriores
  try { await db.prepare('ALTER TABLE compras ADD COLUMN importado INTEGER DEFAULT 0').run(); } catch { /* já existe */ }
  // lado: C = compra, V = venda, B = bonificação, A = ajuste de cotas (incorporação, grupamento)
  try { await db.prepare("ALTER TABLE compras ADD COLUMN lado TEXT DEFAULT 'C'").run(); } catch { /* já existe */ }
  schemaPronto = true;
}

const json = (dados, status = 200) =>
  new Response(JSON.stringify(dados), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const erro = (status, mensagem) => json({ erro: mensagem }, status);
const agora = () => new Date().toISOString();

// ---------- senha ----------
async function hash(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function conferirSenha(req, env) {
  if (!env.SENHA) return erro(503, 'Defina a variável SENHA no Worker (Settings → Variables and Secrets) e faça o deploy de novo.');
  const h = req.headers.get('Authorization') || '';
  const enviada = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [a, b] = await Promise.all([hash(enviada), hash(env.SENHA)]);
  const ok = crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(a, b) : a.every((x, i) => x === b[i]);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400)); // freia tentativas em sequência
    return erro(401, 'Senha incorreta.');
  }
  return null;
}

// ---------- validação simples ----------
const texto = (v, max = 120) => String(v ?? '').slice(0, max);
const numero = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('número inválido');
  return n;
};
const dataISO = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('data inválida (use AAAA-MM-DD)');
  return s;
};
const id = (v) => {
  const s = String(v || '');
  if (!/^[a-z0-9]{6,40}$/i.test(s)) throw new Error('id inválido');
  return s;
};
const ativoLimpo = (a, i) => ({
  id: id(a.id),
  ticker: texto(a.ticker, 60),
  tipo: TIPOS.has(a.tipo) ? a.tipo : 'acao',
  nome: texto(a.nome, 120),
  preco: a.preco == null ? null : numero(a.preco),
  preco_em: a.precoEm ? texto(a.precoEm, 40) : null,
  fonte: a.fonte ? texto(a.fonte, 20) : null,
  ordem: i,
});
const compraLimpa = (c) => ({
  id: id(c.id), data: dataISO(c.data), ticker: texto(c.ticker, 60), tipo: TIPOS.has(c.tipo) ? c.tipo : 'acao',
  qtd: numero(c.qtd), preco: numero(c.preco), custo: numero(c.custo || 0), banco: texto(c.banco, 40),
  importado: c.importado ? 1 : 0,
  lado: ['V', 'B', 'A'].includes(c.lado) ? c.lado : 'C',
});
const proventoLimpo = (p) => ({
  id: id(p.id), data: dataISO(p.data), ticker: texto(p.ticker, 60), tipo: texto(p.tipo, 20), valor: numero(p.valor),
});

// ---------- leitura do estado ----------
async function lerEstado(db) {
  const [cfg, ativos, compras, proventos] = await db.batch([
    db.prepare('SELECT chave, valor FROM config'),
    db.prepare('SELECT * FROM ativos ORDER BY ordem, ticker'),
    db.prepare('SELECT * FROM compras ORDER BY data, criado_em'),
    db.prepare('SELECT * FROM proventos ORDER BY data, criado_em'),
  ]);
  const config = {};
  for (const r of cfg.results) {
    try { config[r.chave] = JSON.parse(r.valor); } catch { /* ignora valor corrompido */ }
  }
  return {
    vazio: cfg.results.length === 0 && ativos.results.length === 0 && compras.results.length === 0,
    ajustes: config.ajustes ?? null,
    bancos: config.bancos ?? null,
    plano: config.plano ?? null,
    ativos: ativos.results.map((a) => ({ id: a.id, ticker: a.ticker, tipo: a.tipo, nome: a.nome, preco: a.preco, precoEm: a.preco_em, fonte: a.fonte })),
    compras: compras.results.map(({ criado_em, importado, lado, ...c }) => ({ ...c, ...(importado ? { importado: true } : {}), ...(lado && lado !== 'C' ? { lado } : {}) })),
    proventos: proventos.results.map(({ criado_em, ...p }) => p),
  };
}

// ---------- escritas ----------
function stmtsConfig(db, chave, valor) {
  return db.prepare('INSERT INTO config (chave, valor, atualizado_em) VALUES (?1, ?2, ?3) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em')
    .bind(chave, JSON.stringify(valor), agora());
}
function stmtsAtivos(db, lista) {
  const limpos = lista.slice(0, 200).map(ativoLimpo);
  return [
    db.prepare('DELETE FROM ativos'),
    ...limpos.map((a) => db.prepare('INSERT INTO ativos (id, ticker, tipo, nome, preco, preco_em, fonte, ordem) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
      .bind(a.id, a.ticker, a.tipo, a.nome, a.preco, a.preco_em, a.fonte, a.ordem)),
  ];
}
// grava ou corrige uma compra; ao corrigir, mantém quando ela foi criada (a ordem no mesmo dia não muda)
const stmtCompra = (db, c) => db.prepare(`INSERT INTO compras (id, data, ticker, tipo, qtd, preco, custo, banco, criado_em, importado, lado) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  ON CONFLICT(id) DO UPDATE SET data = excluded.data, ticker = excluded.ticker, tipo = excluded.tipo, qtd = excluded.qtd, preco = excluded.preco,
  custo = excluded.custo, banco = excluded.banco, importado = excluded.importado, lado = excluded.lado`)
  .bind(c.id, c.data, c.ticker, c.tipo, c.qtd, c.preco, c.custo, c.banco, agora(), c.importado, c.lado);
const stmtProvento = (db, p) => db.prepare('INSERT OR REPLACE INTO proventos (id, data, ticker, tipo, valor, criado_em) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
  .bind(p.id, p.data, p.ticker, p.tipo, p.valor, agora());

// ---------- cotações ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function cotacaoYahoo(ticker) {
  const simbolo = `${ticker.toUpperCase()}.SA`;
  let ultimoErro;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?interval=1d&range=1d`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: 60, cacheEverything: true } });
      if (r.status === 404) throw new Error('ticker não encontrado');
      if (!r.ok) throw new Error(`yahoo ${r.status}`);
      const j = await r.json();
      const m = j?.chart?.result?.[0]?.meta;
      if (!m || typeof m.regularMarketPrice !== 'number') throw new Error('yahoo sem preço');
      const anterior = m.chartPreviousClose ?? m.previousClose;
      return {
        preco: m.regularMarketPrice,
        em: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : agora(),
        variacao: anterior ? (m.regularMarketPrice / anterior - 1) * 100 : null,
        nome: m.longName || m.shortName || null,
        fonte: 'yahoo',
      };
    } catch (e) {
      ultimoErro = e;
      if (e.message === 'ticker não encontrado') break;
    }
  }
  throw ultimoErro;
}

async function cotacaoBrapi(ticker, token) {
  const url = new URL(`https://brapi.dev/api/quote/${encodeURIComponent(ticker.toUpperCase())}`);
  if (token) url.searchParams.set('token', token);
  const r = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) throw new Error(r.status === 401 || r.status === 402 || r.status === 403 ? 'brapi precisa de token' : `brapi ${r.status}`);
  const q = (await r.json())?.results?.[0];
  if (!q || typeof q.regularMarketPrice !== 'number') throw new Error('brapi sem preço');
  return {
    preco: q.regularMarketPrice,
    em: q.regularMarketTime || agora(),
    variacao: typeof q.regularMarketChangePercent === 'number' ? q.regularMarketChangePercent : null,
    nome: q.longName || q.shortName || null,
    fonte: 'brapi',
  };
}

async function historicoYahoo(ticker) {
  const simbolo = `${ticker}.SA`;
  let ultimoErro;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?interval=1mo&range=10y&events=split`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: 86400, cacheEverything: true } });
      if (!r.ok) throw new Error(`yahoo ${r.status}`);
      const res = (await r.json())?.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const q = res?.indicators?.quote?.[0] || {};
      const meses = {};
      ts.forEach((t, i) => {
        const d = new Date((t + 3 * 3600) * 1000); // meia-noite de São Paulo vira o mês certo
        const mes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        if (q.low?.[i] != null && q.high?.[i] != null) meses[mes] = { low: q.low[i], high: q.high[i], close: q.close?.[i] ?? null };
      });
      // desdobramentos e grupamentos: os preços do Yahoo já vêm corrigidos por eles
      const splits = Object.values(res?.events?.splits || {})
        .filter((x) => x.numerator > 0 && x.denominator > 0)
        .map((x) => ({ data: new Date((x.date + 3 * 3600) * 1000).toISOString().slice(0, 10), fator: x.numerator / x.denominator }))
        .sort((a, b) => a.data.localeCompare(b.data));
      return { ticker, meses, splits };
    } catch (e) {
      ultimoErro = e;
    }
  }
  return { ticker, meses: {}, splits: [], erro: ultimoErro?.message || 'sem histórico' };
}

/**
 * Preço de um dia (abertura, mínima, máxima e fechamento). Se a bolsa não abriu nesse dia,
 * devolve o último pregão antes dele. O Yahoo corrige preços antigos por desdobramentos;
 * aqui eles voltam ao valor que realmente foi negociado naquele dia.
 */
async function precoDoDia(ticker, dia) {
  const simbolo = `${ticker}.SA`;
  const alvo = Date.parse(`${dia}T00:00:00-03:00`) / 1000;
  const p1 = alvo - 12 * 86400, p2 = alvo + 86400;
  let ultimoErro;
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?interval=1d&period1=${p1}&period2=${p2}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, cf: { cacheTtl: 3600, cacheEverything: true } });
      if (r.status === 404) throw new Error('ticker não encontrado');
      if (!r.ok) throw new Error(`yahoo ${r.status}`);
      const res = (await r.json())?.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const q = res?.indicators?.quote?.[0] || {};
      let achado = null;
      ts.forEach((t, i) => {
        const d = new Date((t - 3 * 3600) * 1000).toISOString().slice(0, 10); // dia em São Paulo
        if (d <= dia && q.close?.[i] != null) achado = { data: d, i };
      });
      if (!achado) throw new Error('sem pregão nessa data');
      const { splits } = await historicoYahoo(ticker);
      const fator = splits.filter((x) => x.data > achado.data).reduce((f, x) => f * x.fator, 1);
      const v = (arr) => (arr?.[achado.i] != null ? Math.round(arr[achado.i] * fator * 100) / 100 : null);
      return { ticker, data: achado.data, abertura: v(q.open), minima: v(q.low), maxima: v(q.high), fechamento: v(q.close), fonte: 'yahoo' };
    } catch (e) {
      ultimoErro = e;
      if (e.message === 'ticker não encontrado' || e.message === 'sem pregão nessa data') break;
    }
  }
  return { ticker, erro: ultimoErro?.message || 'sem preço nessa data' };
}

async function cotacoes(tickers, brapiToken) {
  const out = {};
  await Promise.all(tickers.map(async (t) => {
    try {
      out[t] = await cotacaoYahoo(t);
    } catch (e1) {
      try {
        out[t] = await cotacaoBrapi(t, brapiToken);
      } catch (e2) {
        out[t] = { erro: e1.message === 'ticker não encontrado' ? e1.message : 'sem cotação agora' };
      }
    }
  }));
  return out;
}

// ---------- roteador ----------
async function api(req, env, url) {
  const caminho = url.pathname.replace(/^\/api\/?/, '');
  const metodo = req.method;

  if (caminho === 'saude') {
    return json({ app: 'meus-investimentos', banco: Boolean(env.DB), senhaDefinida: Boolean(env.SENHA) });
  }
  // cotações são públicas: o app funciona como calculadora mesmo sem entrar
  if (caminho === 'cotacoes' && metodo === 'GET') {
    const tickers = [...new Set((url.searchParams.get('t') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{4,12}$/.test(s)))].slice(0, 40);
    if (!tickers.length) return erro(400, 'Informe os códigos em ?t=BBAS3,PETR4');
    const token = req.headers.get('X-Brapi-Token') || env.BRAPI_TOKEN || '';
    return json(await cotacoes(tickers, token));
  }

  // histórico mensal de preços (mínima, máxima e fechamento), usado para estimar quantidades de compras antigas
  if (caminho === 'historico' && metodo === 'GET') {
    const t = (url.searchParams.get('t') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(t)) return erro(400, 'Informe o código em ?t=BBAS3');
    return json(await historicoYahoo(t));
  }

  // preço de um dia, para corrigir compras antigas
  if (caminho === 'preco-dia' && metodo === 'GET') {
    const t = (url.searchParams.get('t') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(t)) return erro(400, 'Informe o código em ?t=BBAS3');
    const dia = dataISO(url.searchParams.get('d'));
    if (dia > new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10)) return erro(400, 'Essa data ainda não chegou.');
    return json(await precoDoDia(t, dia));
  }

  const negado = await conferirSenha(req, env);
  if (negado) return negado;

  if (!env.DB) return erro(503, 'O banco D1 não está ligado ao Worker (binding DB).');
  const db = env.DB;
  await garantirSchema(db);
  const corpo = metodo === 'GET' || metodo === 'DELETE' ? null : await req.json().catch(() => {
    throw new Error('corpo da requisição não é JSON');
  });
  const partes = caminho.split('/');

  if (caminho === 'estado' && metodo === 'GET') return json(await lerEstado(db));

  if (partes[0] === 'config' && metodo === 'PUT' && CHAVES_CONFIG.has(partes[1])) {
    await stmtsConfig(db, partes[1], corpo).run();
    return json({ ok: true });
  }

  if (caminho === 'ativos' && metodo === 'PUT') {
    if (!Array.isArray(corpo)) return erro(400, 'Envie a lista de ativos.');
    await db.batch(stmtsAtivos(db, corpo));
    return json({ ok: true });
  }

  if (caminho === 'compras' && metodo === 'POST') {
    const lista = (Array.isArray(corpo) ? corpo : [corpo]).slice(0, 200).map(compraLimpa);
    if (lista.length) await db.batch(lista.map((c) => stmtCompra(db, c)));
    return json({ ok: true, gravadas: lista.length });
  }
  if (partes[0] === 'compras' && partes[1] && metodo === 'DELETE') {
    await db.prepare('DELETE FROM compras WHERE id = ?1').bind(id(partes[1])).run();
    return json({ ok: true });
  }

  if (caminho === 'proventos' && metodo === 'POST') {
    const lista = (Array.isArray(corpo) ? corpo : [corpo]).slice(0, 500).map(proventoLimpo);
    if (lista.length) await db.batch(lista.map((p) => stmtProvento(db, p)));
    return json({ ok: true, gravados: lista.length });
  }
  if (partes[0] === 'proventos' && partes[1] && metodo === 'DELETE') {
    await db.prepare('DELETE FROM proventos WHERE id = ?1').bind(id(partes[1])).run();
    return json({ ok: true });
  }

  // substitui tudo (importar backup, primeira subida dos dados do navegador, apagar tudo)
  if (caminho === 'importar' && metodo === 'POST') {
    const s = corpo || {};
    if (!Array.isArray(s.ativos) || !Array.isArray(s.compras) || !Array.isArray(s.proventos)) return erro(400, 'Backup inválido.');
    const stmts = [
      db.prepare('DELETE FROM compras'),
      db.prepare('DELETE FROM proventos'),
      db.prepare('DELETE FROM config'),
      ...stmtsAtivos(db, s.ativos),
      ...s.compras.slice(0, 5000).map((c) => stmtCompra(db, compraLimpa(c))),
      ...s.proventos.slice(0, 10000).map((p) => stmtProvento(db, proventoLimpo(p))),
    ];
    for (const k of CHAVES_CONFIG) if (s[k] != null) stmts.push(stmtsConfig(db, k, s[k]));
    await db.batch(stmts);
    return json({ ok: true });
  }

  return erro(404, 'Rota não encontrada.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      try {
        return await api(req, env, url);
      } catch (e) {
        return erro(400, e.message || 'Erro na requisição.');
      }
    }
    return env.ASSETS.fetch(req);
  },
};
