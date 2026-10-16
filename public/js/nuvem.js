// Conversa com a API do Worker (Cloudflare + D1).
// Se o app estiver aberto sem o Worker (ex.: arquivo local), tudo continua funcionando só no navegador.
// As escritas entram numa fila salva no navegador e são reenviadas se a internet cair.

const SENHA_KEY = 'meus-investimentos:senha';
const FILA_KEY = 'meus-investimentos:fila';

const ler = (k, padrao) => { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch { return padrao; } };
const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };

let senha = ler(SENHA_KEY, '');
let fila = ler(FILA_KEY, []);
let enviando = false;
let tentativaT;
const ouvintes = new Set();

// estado: 'verificando' | 'local' (sem Worker) | 'senha' (pedir senha) | 'config' (Worker sem SENHA/DB)
//         | 'ok' (tudo salvo) | 'pendente' (enviando) | 'offline' (vai tentar de novo)
export const nuvem = { estado: 'verificando', mensagem: '' };

function mudar(estado, mensagem = '') {
  nuvem.estado = estado;
  nuvem.mensagem = mensagem;
  ouvintes.forEach((f) => f(nuvem));
}
export const aoMudar = (f) => ouvintes.add(f);
export const ativa = () => ['ok', 'pendente', 'offline'].includes(nuvem.estado);

class ErroApi extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

async function req(metodo, caminho, corpo, extraHeaders = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (senha) headers.Authorization = `Bearer ${senha}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let r;
  try {
    r = await fetch(`/api/${caminho}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: ctrl.signal });
  } catch {
    throw new ErroApi(0, 'sem conexão');
  } finally {
    clearTimeout(t);
  }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new ErroApi(r.status, j?.erro || `erro ${r.status}`);
  return j;
}

/** Descobre se existe o Worker. Retorna o estado do servidor ou null (modo só navegador). */
export async function iniciar() {
  try {
    const r = await fetch('/api/saude', { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    if (!r.ok || j?.app !== 'meus-investimentos') { mudar('local'); return null; }
    if (!j.senhaDefinida) { mudar('config', 'Defina a variável SENHA no Worker na Cloudflare.'); return null; }
    if (!j.banco) { mudar('config', 'Ligue o banco D1 ao Worker (binding DB).'); return null; }
  } catch {
    mudar('local');
    return null;
  }
  if (!senha) { mudar('senha'); return null; }
  return carregarServidor();
}

async function carregarServidor() {
  try {
    await esvaziarFila();
    const estado = await req('GET', 'estado');
    mudar(fila.length ? 'pendente' : 'ok');
    return estado;
  } catch (e) {
    if (e.status === 401) { senha = ''; gravar(SENHA_KEY, ''); mudar('senha', 'Senha incorreta.'); return null; }
    if (e.status === 503) { mudar('config', e.message); return null; }
    mudar('offline', 'Sem conexão com a nuvem. Usando os dados deste aparelho.');
    return null;
  }
}

export async function entrar(nova) {
  senha = nova;
  try {
    await req('GET', 'estado');
  } catch (e) {
    senha = '';
    if (e.status === 401) { mudar('senha', 'Senha incorreta.'); return null; }
    mudar('senha', e.message);
    return null;
  }
  gravar(SENHA_KEY, senha);
  return carregarServidor();
}

export function sair() {
  senha = '';
  gravar(SENHA_KEY, '');
  mudar('senha');
}

// ---------- fila de escritas ----------
// Itens com a mesma "chave" se substituem (ex.: o plano muda a cada toque no +; só o último importa).
function enfileirar(item) {
  if (!ativa()) return;
  if (item.chave) fila = fila.filter((x) => x.chave !== item.chave);
  fila.push(item);
  gravar(FILA_KEY, fila);
  agendar(item.chave ? 700 : 0);
}

function agendar(ms) {
  clearTimeout(tentativaT);
  tentativaT = setTimeout(() => esvaziarFila().catch(() => {}), ms);
}

async function esvaziarFila() {
  if (enviando || !fila.length) return;
  enviando = true;
  mudar('pendente');
  try {
    while (fila.length) {
      const item = fila[0];
      try {
        await req(item.metodo, item.caminho, item.corpo);
      } catch (e) {
        if (e.status === 401) { sair(); throw e; }
        if (e.status >= 400 && e.status < 500) {
          // dado recusado pelo servidor: descarta para não travar a fila
          console.warn('Descartado pela nuvem:', item, e.message);
        } else {
          mudar('offline', 'Sem conexão. As alterações ficam guardadas e serão enviadas depois.');
          agendar(15000);
          throw e;
        }
      }
      fila.shift();
      gravar(FILA_KEY, fila);
    }
    mudar('ok');
  } finally {
    enviando = false;
  }
}

window.addEventListener('online', () => { if (ativa()) agendar(0); });

export const salvarConfig = (chave, valor) => enfileirar({ chave: `config:${chave}`, metodo: 'PUT', caminho: `config/${chave}`, corpo: valor });
export const salvarAtivos = (ativos) => enfileirar({ chave: 'ativos', metodo: 'PUT', caminho: 'ativos', corpo: ativos });
export const adicionarCompras = (lista) => enfileirar({ metodo: 'POST', caminho: 'compras', corpo: lista });
export const removerCompra = (id) => enfileirar({ metodo: 'DELETE', caminho: `compras/${id}` });
export const adicionarProvento = (p) => enfileirar({ metodo: 'POST', caminho: 'proventos', corpo: p });
export const removerProvento = (id) => enfileirar({ metodo: 'DELETE', caminho: `proventos/${id}` });
export function substituirTudo(estado) {
  fila = []; // tudo que estava pendente fica coberto pela substituição
  enfileirar({ metodo: 'POST', caminho: 'importar', corpo: estado });
}

/** Cotações pelo Worker (Yahoo ~15 min, reserva brapi). */
export async function cotacoesNuvem(tickers, brapiToken) {
  return req('GET', `cotacoes?t=${encodeURIComponent(tickers.join(','))}`, undefined, brapiToken ? { 'X-Brapi-Token': brapiToken } : {});
}
