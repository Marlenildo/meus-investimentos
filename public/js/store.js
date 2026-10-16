// Estado do app, salvo no navegador (localStorage), com exportar/importar backup.
import { TAXA_B3_PADRAO, hojeISO, mesDe } from './calc.js';

const KEY = 'meus-investimentos:v1';

// Corretagem em R$ por ordem; taxaB3 em fração do valor (0,03%).
// Valores de referência de out/2026 — confira no seu banco e ajuste em Ajustes.
export const BANCOS_PADRAO = [
  { id: 'nubank', nome: 'Nubank', corretagem: 0 },
  { id: 'bb', nome: 'Banco do Brasil', corretagem: 0 },
  { id: 'bradesco', nome: 'Bradesco (Ágora)', corretagem: 0 },
  { id: 'itau', nome: 'Itaú (Íon)', corretagem: 0 },
  { id: 'santander', nome: 'Santander', corretagem: 0 },
  { id: 'inter', nome: 'Inter', corretagem: 0 },
  { id: 'xp', nome: 'XP', corretagem: 0 },
  { id: 'rico', nome: 'Rico', corretagem: 0 },
  { id: 'btg', nome: 'BTG Pactual', corretagem: 4.5 },
  { id: 'c6', nome: 'C6 Bank', corretagem: 0 },
].map((b) => ({ taxaB3: TAXA_B3_PADRAO, taxaTesouro: 0, ...b }));

const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 12).padEnd(10, '0') + Date.now().toString(36).slice(-4));
export { uid };

function estadoInicial() {
  const a = (ticker, tipo, nome, extra = {}) => ({ id: uid(), ticker, tipo, nome, preco: null, precoEm: null, fonte: null, ...extra });
  return {
    versao: 1,
    ajustes: { banco: 'nubank', token: '', aporteMensal: 1000 },
    bancos: BANCOS_PADRAO,
    ativos: [
      a('BBAS3', 'acao', 'Banco do Brasil ON'),
      a('BRSR3', 'acao', 'Banrisul ON'),
      a('PETR4', 'acao', 'Petrobras PN'),
      a('VGIR11', 'fii', 'Valora RE III'),
      a('IRIM11', 'fii', 'Iridium Recebíveis'),
      a('Tesouro Selic 2031', 'tesouro', 'Tesouro Selic 2031', { preco: 20010.2, precoEm: '2026-10-15T12:00:00-03:00', fonte: 'manual' }),
    ],
    plano: { mes: mesDe(hojeISO()), aporte: null, proventosManual: null, qtds: {} },
    compras: [],
    proventos: [],
  };
}

export function carregar() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      return migrar(s);
    }
  } catch (e) {
    console.warn('Não foi possível ler os dados salvos', e);
  }
  return estadoInicial();
}

function migrar(s) {
  const base = estadoInicial();
  const out = { ...base, ...s, ajustes: { ...base.ajustes, ...(s.ajustes || {}) }, plano: { ...base.plano, ...(s.plano || {}) } };
  // bancos novos que ainda não existiam no backup
  const ids = new Set((out.bancos || []).map((b) => b.id));
  out.bancos = [...(out.bancos || []), ...BANCOS_PADRAO.filter((b) => !ids.has(b.id))];
  // novo mês: limpa o plano antigo
  const mesAtual = mesDe(hojeISO());
  if (out.plano.mes !== mesAtual) out.plano = { mes: mesAtual, aporte: null, proventosManual: null, qtds: {} };
  return out;
}

export function salvar(estado) {
  try {
    localStorage.setItem(KEY, JSON.stringify(estado));
    return true;
  } catch (e) {
    console.warn('Não foi possível salvar', e);
    return false;
  }
}

export function exportar(estado) {
  const blob = new Blob([JSON.stringify(estado, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `meus-investimentos-${hojeISO()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importar(file) {
  const texto = await file.text();
  const s = JSON.parse(texto);
  if (!s || !Array.isArray(s.ativos) || !Array.isArray(s.compras)) throw new Error('Arquivo não parece um backup deste app.');
  return migrar(s);
}

export function resetar() {
  return estadoInicial();
}

/** O que vai para a nuvem numa substituição completa. */
export function paraNuvem(estado) {
  const { ajustes, bancos, plano, ativos, compras, proventos } = estado;
  return { ajustes, bancos, plano, ativos, compras, proventos };
}

/**
 * Junta o que veio da nuvem com o que está no navegador.
 * A nuvem manda em tudo, exceto nas cotações: fica a mais recente de cada ativo.
 */
export function juntarComNuvem(local, srv) {
  const precoLocal = new Map(local.ativos.map((a) => [a.ticker, a]));
  const ativos = srv.ativos.map((a) => {
    const l = precoLocal.get(a.ticker);
    if (l?.precoEm && (!a.precoEm || new Date(l.precoEm) > new Date(a.precoEm))) {
      return { ...a, preco: l.preco, precoEm: l.precoEm, fonte: l.fonte };
    }
    return a;
  });
  return migrar({
    ...local,
    ajustes: srv.ajustes ?? local.ajustes,
    bancos: srv.bancos ?? local.bancos,
    plano: srv.plano ?? local.plano,
    ativos,
    compras: srv.compras,
    proventos: srv.proventos,
  });
}
