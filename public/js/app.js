import {
  TIPOS, TIPOS_PROVENTO, round2, normalizaQtd, passoDe, resumoPlano, linhaPlano, qtdMaxima, avisoMinimo,
  mesAnterior, mesDe, hojeISO, somaProventosMes, proventosPorTipo, carteira, resumoPorPeriodo, ladoDe, processarOperacoes, classesPorTicker, liquidoSeVender, dataLiquidacao, emLiquidacao, estimarCompra, fatoresDoMes, precoTesouroEm,
  PROV_DE_FATO, ehProvDeFato, custoOrdem, TAXA_B3_PADRAO, classeDe,
} from './calc.js';
import { lerMovimentacao, novidades, bancoDaInstituicao } from './b3.js';
import { carregar, salvar, exportar, importar, resetar, uid, BANCOS_PADRAO, paraNuvem, juntarComNuvem } from './store.js';
import { atualizarTodas, buscarCotacao } from './cotacoes.js';
import * as N from './nuvem.js';
import { simular, TIPOS_SIM, seriesNecessarias, resumoPorPeriodoSim, PRECOS_COMPRA, TIPOS_PROV_SIM } from './simulador.js';
import { CATALOGO, NOME_CLASSE_CAT, buscarNoCatalogo } from './catalogo.js';
import './seletores.js';

// ---------- estado ----------
// versão do app (mostrada no rodapé): suba a cada mudança publicada
export const VERSAO = '1.9.0';
const VERSAO_DATA = '2026-10-19';

let S = carregar();
const statusCotacao = {}; // ativoId -> {erro?, variacao?}
let atualizando = false;
let ultimaBusca = 0; // quando as cotações foram buscadas pela última vez nesta sessão

/** Salva no navegador e manda para a nuvem as partes que mudaram ('ajustes' | 'bancos' | 'plano' | 'ativos'). */
const persist = (...mudou) => {
  if (!salvar(S) && !N.ativa()) toast('Não consegui salvar neste navegador. Faça um backup em Ajustes.');
  for (const k of mudou) {
    if (k === 'ativos') N.salvarAtivos(S.ativos);
    else N.salvarConfig(k, S[k]);
  }
};
const temCotacaoAutomatica = () => N.nuvem.servidor || Boolean(S.ajustes.token);

// ---------- formatação ----------
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const R = (n) => brl.format(Number(n) || 0);
const pct = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`);
const fmtQtd = (q) => Number(q).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const nomeMes = (ym) => MESES[Number(ym.slice(5, 7)) - 1];
const nomeMesAno = (ym) => `${nomeMes(ym)} de ${ym.slice(0, 4)}`;
const mesCurto = (ym) => `${nomeMes(ym).slice(0, 3)}/${ym.slice(2, 4)}`;
const dataBR = (iso) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const num = (v) => {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/\s|R\$/g, '');
  if (!s) return NaN;
  // aceita "1.234,56" e "1234.56"
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return n;
};

function frescor(ativo) {
  const st = statusCotacao[ativo.id];
  if (!ativo.preco) return { txt: ativo.tipo === 'tesouro' ? 'site do Tesouro' : '', cls: '' };
  if (st?.erro) return { txt: 'sem atualização', cls: 'velho' };
  if (!ativo.precoEm) return { txt: '', cls: '' };
  const d = new Date(ativo.precoEm);
  const min = Math.round((Date.now() - d) / 60000);
  if (ativo.fonte === 'manual') return { txt: 'digitado', cls: '' };
  const manual = '';
  let txt;
  if (min < 1) txt = 'agora';
  else if (min < 60) txt = `há ${min} min`;
  else if (d.toDateString() === new Date().toDateString()) txt = `hoje ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  else txt = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const velho = min > 60 * 24 * (ativo.tipo === 'tesouro' ? 3 : 1);
  return { txt: txt + manual, cls: velho ? 'velho' : '' };
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- derivados ----------
const banco = (id = S.ajustes.banco) => S.bancos.find((b) => b.id === id) || S.bancos[0];

// logo de cada banco: o ícone do site dele; sem internet ou sem site conhecido, ficam as iniciais
const SITE_BANCO = {
  nubank: 'nubank.com.br', bb: 'bb.com.br', bradesco: 'bradesco.com.br', itau: 'itau.com.br', santander: 'santander.com.br',
  inter: 'bancointer.com.br', xp: 'xpi.com.br', rico: 'rico.com.vc', btg: 'btgpactual.com', c6: 'c6bank.com.br',
  toro: 'toroinvestimentos.com.br', orama: 'orama.com.br', nikos: 'nikos.com.br', clear: 'clear.com.br', genial: 'genialinvestimentos.com.br',
  modal: 'modalmais.com.br', warren: 'warren.com.br', avenue: 'avenue.us', mercadopago: 'mercadopago.com.br', picpay: 'picpay.com',
};
function logoBanco(id, nome = banco(id)?.nome || id) {
  const ini = esc(String(nome || '?').replace(/[^A-Za-zÀ-ú0-9 ]/g, '').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  const site = SITE_BANCO[id];
  const img = site ? `<img src="https://www.google.com/s2/favicons?domain=${site}&sz=64" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="this.naturalWidth > 16 ? this.classList.add('ok') : this.remove()" onerror="this.remove()">` : '';
  return `<span class="logo-banco" aria-hidden="true">${ini}${img}</span>`;
}
/** "· [logo] Nubank" ao lado de um título, quando há banco escolhido no Histórico. */
const tituloBanco = () => (G.banco ? ` <span class="graf-ativo-nome titulo-banco">· ${logoBanco(G.banco)}${esc(banco(G.banco)?.nome || G.banco)}</span>` : '');
/** Logo + nome do banco, para rodapés de cartão e listas. */
const comLogo = (id, nome = banco(id)?.nome || id) => `<span class="banco-tag">${logoBanco(id, nome)}${esc(nome)}</span>`;
const proventosAuto = () => somaProventosMes(S.proventos, mesAnterior(S.plano.mes));
const aporteMes = () => (S.plano.aporte == null ? Number(S.ajustes.aporteMensal) || 0 : S.plano.aporte);
const proventosMes = () => (S.plano.proventosManual == null ? proventosAuto() : S.plano.proventosManual);
const disponivel = () => round2(aporteMes() + proventosMes());
const resumo = (b = banco()) => resumoPlano(S.ativos, S.plano.qtds, b);

// ---------- topo: tema claro/escuro ----------
const TEMA_KEY = 'meus-investimentos:tema';
let tema = (() => { try { return localStorage.getItem(TEMA_KEY) || 'auto'; } catch { return 'auto'; } })();
const escuroAgora = () => tema === 'dark' || (tema === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
const ICONE_SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const ICONE_LUA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
function aplicarTema() {
  if (tema === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', tema);
  const b = $('#tema');
  b.innerHTML = escuroAgora() ? ICONE_SOL : ICONE_LUA;
  b.title = b.ariaLabel = escuroAgora() ? 'Usar tema claro' : 'Usar tema escuro';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', escuroAgora() ? '#0a0b10' : '#f5f6fa');
}
function mudarTema(novo) {
  tema = novo;
  try { localStorage.setItem(TEMA_KEY, tema); } catch { /* sem armazenamento */ }
  aplicarTema();
}
$('#tema').addEventListener('click', () => mudarTema(escuroAgora() ? 'light' : 'dark'));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', aplicarTema);
const renderBancos = () => {};

// ---------- boleta ----------
function renderBoleta() {
  const r = resumo();
  const disp = disponivel();
  const rest = round2(disp - r.total);
  const frac = disp > 0 ? Math.min(1, r.total / disp) : 0;
  const estado = rest < 0 ? 'estouro' : disp > 0 && rest < Math.max(1, disp * 0.01) && r.total > 0 ? 'cheio' : '';
  $('#boleta').innerHTML = `
    <div class="boleta-in">
      <div class="boleta-nums">
        <div class="bn"><small>Disponível</small><span class="num">${R(disp)}</span></div>
        <div class="bn"><small>Na compra</small><span class="num">${R(r.total)}</span></div>
        <div class="bn restante"><small>${rest < 0 ? 'Passou' : 'Falta usar'}</small><span class="num ${rest < 0 ? 'estouro' : estado === 'cheio' ? 'sobra' : ''}">${R(Math.abs(rest))}</span></div>
      </div>
      <div class="barra ${estado}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(frac * 100)}" aria-label="Quanto do valor disponível já está na compra"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>
    </div>`;
}

/** O que ainda está liquidando (bolsa, D+2): valor a preço de hoje e o dia em que entra na custódia. */
function liquidando(compras = S.compras) {
  const xs = emLiquidacao(compras, hojeISO());
  let valor = 0, ate = '';
  const porTicker = new Map();
  for (const c of xs) {
    const pr = Number(S.ativos.find((a) => a.ticker === c.ticker)?.preco) || Number(c.preco);
    const sinal = ladoDe(c) === 'V' ? -1 : 1;
    valor += sinal * Number(c.qtd) * pr;
    porTicker.set(c.ticker, (porTicker.get(c.ticker) || 0) + sinal * Number(c.qtd));
    const d = dataLiquidacao(c);
    if (d > ate) ate = d;
  }
  return { xs, valor: round2(valor), ate, porTicker };
}

// ---------- aba Comprar (tela inicial) ----------
const fmtPreco = (v) => (v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const ICONE_ATUALIZAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';

function posicoes() {
  const c = carteira(S.compras, S.ativos, S.proventos);
  const pend = liquidando().porTicker;
  const lq = liquidoSeVender(S.compras, S.ativos, hojeISO()).porTicker; // imposto se vendesse hoje
  return { ...c, porTicker: new Map(c.linhas.map((l) => [l.ticker, { ...l, aLiquidar: pend.get(l.ticker) || 0, ir: (lq[l.ticker]?.ir || 0) + (lq[l.ticker]?.iof || 0), liquido: lq[l.ticker]?.liquido }])) };
}

function htmlPosicao(pos) {
  if (!pos || !pos.qtd) return '<small class="pos nada">nenhuma cota ainda</small>';
  const cls = pos.resultado == null ? '' : pos.resultado >= 0 ? 'var-alta' : 'var-baixa';
  const un = pos.tipo === 'tesouro' ? 'títulos' : pos.qtd === 1 ? 'cota' : 'cotas';
  const liq = pos.ir >= 0.01 && pos.liquido != null ? ` · <span class="pos-liq" title="Descontado o IR de ${R(pos.ir)} se resgatasse hoje">líq. ${R(pos.liquido)}</span>` : '';
  const aliq = pos.aLiquidar ? ` <span class="pos-liq" title="Ainda liquidando: entra na custódia em até dois dias úteis">(${fmtQtd(pos.aLiquidar)} a liquidar)</span>` : '';
  return `<small class="pos"><b>${fmtQtd(pos.qtd)} ${un}</b>${aliq} · ${R(pos.valorAtual ?? pos.investido)}${pos.resultadoPct != null ? ` <span class="${cls}">${pct(pos.resultadoPct)}</span>` : ''}${liq}</small>`;
}

function htmlSubCarteira(cart) {
  if (!S.compras.length) return '<small class="sub-cab" id="sub-cart">Escolha quanto comprar de cada ativo.</small>';
  const cls = cart.resultado >= 0 ? 'var-alta' : 'var-baixa';
  return `<small class="sub-cab" id="sub-cart">Sua carteira: <b>${R(cart.valorAtual)}</b> <span class="${cls}">${pct(cart.investido ? cart.resultado / cart.investido : null)}</span></small>`;
}

const ICONE_ALCA = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></g></svg>';
let editandoLista = false;

/** Logo do ativo (ícones públicos da brapi); se não houver, mostra as iniciais na cor do tipo. */
function htmlLogo(a) {
  const ini = a.tipo === 'tesouro' ? 'TD' : a.ticker.replace(/[^A-Z]/gi, '').slice(0, 2).toUpperCase();
  const img = a.tipo === 'tesouro' ? '' : `<img src="https://icons.brapi.dev/icons/${encodeURIComponent(a.ticker.toUpperCase())}.svg" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onload="this.classList.add('ok')" onerror="this.remove()">`;
  return `<span class="logo-ativo ${a.tipo}" aria-hidden="true"><span>${esc(ini)}</span>${img}</span>`;
}

function htmlOrdem(a, pos) {
  const q = Number(S.plano.qtds[a.id]) || 0;
  const f = frescor(a);
  const passo = passoDe(a);
  return `
    <div class="ordem ${q > 0 ? 'tem-qtd' : ''}" data-id="${a.id}">
      <button type="button" class="arrasto" data-arrasto="${a.id}" title="Arraste para mudar a ordem" aria-label="Mover ${esc(a.ticker)} (setas para cima e para baixo)">${ICONE_ALCA}</button>
      <div class="o-ativo">
        ${htmlLogo(a)}
        <div class="o-texto">
          <div class="o-nome"><span class="tk" title="${esc(a.nome || a.ticker)}">${esc(a.ticker)}</span><span class="chip ${a.tipo}">${esc(TIPOS[a.tipo]?.nome || a.tipo)}</span></div>
          ${htmlPosicao(pos)}
        </div>
      </div>
      <div class="o-preco">
        <input class="preco-input num" data-preco="${a.id}" inputmode="decimal" aria-label="Preço de ${esc(a.ticker)}" value="${fmtPreco(a.preco)}" placeholder="preço">
        <span class="frescor ${f.cls}" data-frescor="${a.id}">${esc(f.txt)}</span>
      </div>
      <div class="o-qtd">
        <div class="qtd">
          <button type="button" data-menos="${a.id}" aria-label="Menos ${esc(a.ticker)}">−</button>
          <input type="number" id="q-${a.id}" data-qtd="${a.id}" min="0" step="${passo}" inputmode="${passo === 1 ? 'numeric' : 'decimal'}" value="${q || ''}" placeholder="0" aria-label="Quantidade de ${esc(a.ticker)} para comprar">
          <button type="button" data-mais="${a.id}" aria-label="Mais ${esc(a.ticker)}">+</button>
        </div>
        <button type="button" class="max" data-max="${a.id}" title="Usar o que falta">MÁX</button>
      </div>
      <div class="o-total" data-total="${a.id}"></div>
      <button type="button" class="x x-del" data-del-ativo="${a.id}" title="Tirar ${esc(a.ticker)} da lista" aria-label="Tirar ${esc(a.ticker)} da lista">✕</button>
    </div>`;
}

function pintarTotais() {
  const b = banco();
  for (const a of S.ativos) {
    const el = document.querySelector(`[data-total="${a.id}"]`);
    if (!el) continue;
    const q = Number(S.plano.qtds[a.id]) || 0;
    const l = linhaPlano(a, q, b);
    const aviso = avisoMinimo(a, q);
    el.innerHTML = q > 0
      ? `<span class="num">${R(l.total)}</span>${aviso ? `<small class="warn">${esc(aviso)}</small>` : ''}`
      : '<span class="num apagado">—</span>';
    el.closest('.ordem').classList.toggle('tem-qtd', q > 0);
  }
  const r = resumo();
  const box = $('#custos');
  if (box) {
    box.innerHTML = `
      <div class="ln"><span>${r.ordens} ${r.ordens === 1 ? 'ativo' : 'ativos'} na compra</span><span class="num">${R(r.bruto)}</span></div>
      <div class="ln"><span>Taxas (${esc(b.nome)})</span><span class="num">${R(r.custos)}</span></div>
      <div class="ln total"><span>Total da compra</span><span class="num">${R(r.total)}</span></div>`;
    $('#btn-registrar').disabled = r.ordens === 0;
  }
  renderBoleta();
}

/** Atualiza só preços e posições, sem redesenhar (não atrapalha quem está digitando). */
function pintarPrecos() {
  const cart = posicoes();
  for (const a of S.ativos) {
    const inp = document.querySelector(`[data-preco="${a.id}"]`);
    if (inp && document.activeElement !== inp) inp.value = fmtPreco(a.preco);
    const fr = document.querySelector(`[data-frescor="${a.id}"]`);
    if (fr) { const f = frescor(a); fr.className = `frescor ${f.cls}`; fr.textContent = f.txt; }
    const pos = document.querySelector(`.ordem[data-id="${a.id}"] .pos`);
    if (pos) pos.outerHTML = htmlPosicao(cart.porTicker.get(a.ticker));
  }
  const sub = $('#sub-cart');
  if (sub) sub.outerHTML = htmlSubCarteira(cart);
  $('#btn-cotacoes')?.classList.toggle('girando', atualizando);
  pintarTotais();
}

function adivinharTipo(cod) {
  const c = cod.trim().toUpperCase();
  if (/^TESOURO/.test(c)) return 'tesouro';
  if (/^(CDB|LCA|LCI|LC|CRI|CRA|DEB|RDB)\b/.test(c)) return 'rf';
  if (/^[A-Z]{4}(32|33|34|35|39)$/.test(c)) return 'bdr';
  if (/^(BOVA|IVVB|SMAL|HASH|DIVO|NASD|XINA|GOLD|SPXI|ACWI|BOVV|PIBB|FIND|MATB)11$/.test(c)) return 'etf';
  if (/^[A-Z]{4}11$/.test(c)) return 'fii';
  return 'acao';
}

function renderComprar() {
  const mesAnt = mesAnterior(S.plano.mes);
  const auto = proventosAuto();
  const manual = S.plano.proventosManual != null;
  const cart = posicoes();
  const ordem = S.ativos;
  return `
    <section class="bloco">
      <div class="campos plano">
        <label class="campo"><span>Aporte de ${nomeMes(S.plano.mes)}</span>
          <input id="in-aporte" class="num" inputmode="decimal" value="${aporteMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">padrão ${R(S.ajustes.aporteMensal)}</span>
        </label>
        <label class="campo"><span>+ Proventos de ${nomeMes(mesAnt)}</span>
          <input id="in-proventos" class="num" inputmode="decimal" value="${proventosMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">${manual ? `<button type="button" id="prov-auto">usar os lançados (${R(auto)})</button>` : 'soma dos proventos lançados'}</span>
        </label>
        <div class="campo"><span>= Para investir</span><div class="disp-valor num" id="disp">${R(disponivel())}</div><span class="sub"></span></div>
      </div>
    </section>

    <section class="bloco">
      <div class="bloco-cab">
        <div><h2>Meus ativos</h2>${htmlSubCarteira(cart)}</div>
        <div class="acoes">
          <select id="ordenar" class="peq" aria-label="Ordenar a lista">
            <option value="">Ordenar…</option><option value="tipo">Por tipo</option><option value="az">A → Z</option><option value="posicao">Maior posição</option>
          </select>
          <button type="button" class="btn peq" id="btn-dividir" title="Divide o valor igualmente entre os ativos">Dividir</button>
          <button type="button" class="btn peq" id="btn-limpar">Zerar</button>
          <button type="button" class="btn peq ${editandoLista ? 'ativo' : ''}" id="btn-editar" aria-pressed="${editandoLista}">${editandoLista ? 'Pronto' : 'Editar'}</button>
          <button type="button" class="icone-btn ${atualizando ? 'girando' : ''}" id="btn-cotacoes" title="Atualizar preços" aria-label="Atualizar preços">${ICONE_ATUALIZAR}</button>
        </div>
      </div>
      ${N.nuvem.estado === 'local' && !S.ajustes.token ? `<p class="aviso"><b>Preços manuais:</b> ${esc(N.nuvem.mensagem || '')} Toque no preço para digitar.</p>` : ''}
      ${ordem.length ? `<div class="lista-ativos ${editandoLista ? 'editando' : ''}">
        <div class="ordem-cab" aria-hidden="true"><span></span><span>Ativo</span><span>Preço</span><span>Comprar</span><span>Total</span><span></span></div>
        <div class="ordens">${ordem.map((a) => htmlOrdem(a, cart.porTicker.get(a.ticker))).join('')}</div>
      </div>` : '<p class="dica">Sua lista está vazia. Adicione o primeiro ativo.</p>'}
      <button type="button" class="add-abrir" id="add-abrir">+ Adicionar ativo</button>
      <form id="form-add" class="add-ativo" autocomplete="off" hidden>
        <input id="add-ticker" placeholder="Código: ITSA4, HGLG11, Tesouro IPCA+ 2035…" aria-label="Código do ativo" required>
        <select id="add-tipo" aria-label="Tipo do ativo">${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}">${v.nome}</option>`).join('')}</select>
        <button class="btn prim" type="submit">Adicionar</button>
        <button class="btn" type="button" id="add-cancelar">Cancelar</button>
      </form>
    </section>

    <section class="bloco fechar-compra">
      <div class="custos" id="custos"></div>
      <button type="button" class="btn prim" id="btn-registrar">Comprei — registrar</button>
    </section>`;
}

function ligarComprar() {
  const main = $('#conteudo');
  const atualizarDisp = () => { $('#disp').textContent = R(disponivel()); renderBoleta(); };

  $('#in-aporte').addEventListener('change', (e) => {
    const v = num(e.target.value);
    S.plano.aporte = Number.isFinite(v) ? Math.max(0, v) : null;
    e.target.value = aporteMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    persist('plano'); atualizarDisp();
  });
  $('#in-proventos').addEventListener('change', (e) => {
    const v = num(e.target.value);
    S.plano.proventosManual = Number.isFinite(v) ? Math.max(0, v) : null;
    persist('plano'); render();
  });
  $('#prov-auto')?.addEventListener('click', () => { S.plano.proventosManual = null; persist('plano'); render(); });
  $('#btn-cotacoes').addEventListener('click', atualizarCotacoes);
  $('#btn-limpar').addEventListener('click', () => { S.plano.qtds = {}; persist('plano'); render(); });
  $('#btn-editar').addEventListener('click', () => { editandoLista = !editandoLista; render(); });
  $('#btn-registrar').addEventListener('click', abrirRegistrar);

  // dividir igual: o valor para investir dividido pelo número de ativos, como na planilha
  $('#btn-dividir').addEventListener('click', () => {
    const comPreco = S.ativos.filter((a) => a.preco > 0);
    if (!comPreco.length) { toast('Informe os preços primeiro.'); return; }
    const parte = disponivel() / comPreco.length;
    const b = banco();
    S.plano.qtds = {};
    for (const a of comPreco) {
      const q = qtdMaxima(a, 0, parte, b);
      if (q > 0) S.plano.qtds[a.id] = q;
    }
    persist('plano'); render();
    toast(`${R(parte)} para cada ativo. Ajuste à vontade.`);
  });

  // adicionar ativo direto na tela
  const form = $('#form-add'), addT = $('#add-ticker'), addTipo = $('#add-tipo');
  const abrirManual = () => { $('#add-abrir').hidden = true; form.hidden = false; addT.focus(); };
  $('#add-abrir').addEventListener('click', () => abrirEscolherAtivo((a) => {
    const tipo = a.classe === 'fii' ? 'fii' : a.classe === 'etf' ? 'etf' : a.classe === 'bdr' ? 'bdr' : adivinharTipo(a.ticker) === 'fii' && a.classe !== 'acao' ? 'fii' : 'acao';
    adicionarAtivo(a.ticker, tipo, a.nome || '');
  }, { manual: abrirManual, naLista: new Set(S.ativos.map((x) => x.ticker)) }));
  $('#add-cancelar').addEventListener('click', () => { form.hidden = true; $('#add-abrir').hidden = false; form.reset(); delete addTipo.dataset.manual; });
  addT.addEventListener('input', () => { if (!addTipo.dataset.manual) addTipo.value = adivinharTipo(addT.value); });
  addTipo.addEventListener('change', () => { addTipo.dataset.manual = '1'; });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tipo = addTipo.value;
    let ticker = addT.value.trim();
    if (tipo !== 'tesouro') ticker = ticker.toUpperCase().replace(/\s+/g, '');
    if (!ticker) return;
    adicionarAtivo(ticker, tipo, '');
  });
  function adicionarAtivo(ticker, tipo, nome) {
    const existente = S.ativos.find((a) => a.ticker.toLowerCase() === ticker.toLowerCase());
    if (existente) { toast(`${ticker} já está na lista.`); $(`#q-${existente.id}`)?.focus(); return; }
    const novo = { id: uid(), ticker, tipo, nome: tipo === 'tesouro' ? ticker : nome || '', preco: null, precoEm: null, fonte: null };
    S.ativos.push(novo);
    persist('ativos');
    render();
    $(`#q-${novo.id}`)?.scrollIntoView({ block: 'center' });
    toast(tipo === 'tesouro' ? `${ticker} adicionado. Digite o preço do site do Tesouro.` : `${ticker} adicionado.`);
    if (tipo !== 'tesouro') {
      buscarCotacao(ticker, S.ajustes.token).then((q) => {
        novo.preco = q.preco; novo.precoEm = q.em; novo.fonte = q.fonte || 'brapi';
        if (!novo.nome && q.nome) novo.nome = q.nome;
        persist('ativos'); pintarPrecos();
      }).catch((err) => { statusCotacao[novo.id] = { erro: err.message }; pintarPrecos(); });
    }
  }

  const setQtd = (id, q, repintarInput = true) => {
    const a = S.ativos.find((x) => x.id === id);
    q = normalizaQtd(a, q);
    if (q > 0) S.plano.qtds[id] = q; else delete S.plano.qtds[id];
    if (repintarInput) $(`#q-${id}`).value = q || '';
    persist('plano'); pintarTotais();
  };

  main.addEventListener('input', (e) => {
    const id = e.target.dataset.qtd;
    if (id) setQtd(id, num(e.target.value), false);
  });
  main.addEventListener('change', (e) => {
    const id = e.target.dataset.qtd;
    if (id) setQtd(id, num(e.target.value));
    const pid = e.target.dataset.preco;
    if (pid) {
      const a = S.ativos.find((x) => x.id === pid);
      const v = num(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        a.preco = v; a.precoEm = new Date().toISOString(); a.fonte = 'manual';
        delete statusCotacao[a.id];
        persist('ativos');
      }
      e.target.blur();
      pintarPrecos();
    }
  });
  main.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const b = banco();
    if (t.dataset.mais || t.dataset.menos) {
      const id = t.dataset.mais || t.dataset.menos;
      const a = S.ativos.find((x) => x.id === id);
      const q = Number(S.plano.qtds[id]) || 0;
      setQtd(id, round2(q + (t.dataset.mais ? 1 : -1) * passoDe(a)));
    } else if (t.dataset.max) {
      const id = t.dataset.max;
      const a = S.ativos.find((x) => x.id === id);
      if (!a.preco) { toast(`Digite o preço de ${a.ticker} primeiro.`); $(`[data-preco="${id}"]`)?.focus(); return; }
      const rest = disponivel() - resumo(b).total;
      const q = qtdMaxima(a, Number(S.plano.qtds[id]) || 0, rest, b);
      setQtd(id, q);
      if (!q) toast(`Não sobra dinheiro para ${a.ticker}.`);
    }
  });
  ligarRemover('data-del-ativo', 'ativos');

  // ordenar de uma vez (vira a nova ordem da lista; dá para ajustar arrastando)
  $('#ordenar').addEventListener('change', (e) => {
    const modo = e.target.value;
    if (!modo) return;
    const cart = posicoes();
    const ordemTipo = Object.keys(TIPOS);
    const valorDe = (a) => cart.porTicker.get(a.ticker)?.valorAtual ?? cart.porTicker.get(a.ticker)?.investido ?? 0;
    S.ativos.sort((x, y) => modo === 'az' ? x.ticker.localeCompare(y.ticker, 'pt-BR')
      : modo === 'tipo' ? (ordemTipo.indexOf(x.tipo) - ordemTipo.indexOf(y.tipo)) || x.ticker.localeCompare(y.ticker, 'pt-BR')
      : valorDe(y) - valorDe(x));
    persist('ativos'); render();
  });

  // arrastar e soltar pela alça ou pelo nome do ativo (mouse e toque), com SortableJS;
  // setas do teclado na alça também movem
  const lista = $('.ordens');
  const salvarOrdem = () => {
    const ids = [...lista.children].map((el) => el.dataset.id);
    S.ativos.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
    persist('ativos');
  };
  if (lista && window.Sortable) {
    window.Sortable.create(lista, {
      handle: '.arrasto, .o-nome, .logo-ativo',
      animation: 160,
      delay: 120,
      delayOnTouchOnly: true,
      forceFallback: true,
      fallbackOnBody: true,
      ghostClass: 'arrasto-lugar',
      chosenClass: 'arrasto-escolhido',
      dragClass: 'arrasto-voando',
      onEnd: (ev) => { if (ev.oldIndex !== ev.newIndex) salvarOrdem(); },
    });
  } else if (lista) {
    lista.addEventListener('pointerdown', (e) => {
      const alca = e.target.closest('.arrasto');
      if (!alca) return;
      e.preventDefault();
      const linha = alca.closest('.ordem');
      linha.classList.add('arrasto-escolhido');
      alca.setPointerCapture(e.pointerId);
      const mover = (ev) => {
        const alvo = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.ordem');
        if (!alvo || alvo === linha || alvo.parentElement !== lista) return;
        const r = alvo.getBoundingClientRect();
        lista.insertBefore(linha, ev.clientY > r.top + r.height / 2 ? alvo.nextSibling : alvo);
      };
      const soltar = () => { alca.removeEventListener('pointermove', mover); linha.classList.remove('arrasto-escolhido'); salvarOrdem(); };
      alca.addEventListener('pointermove', mover);
      alca.addEventListener('pointerup', soltar, { once: true });
      alca.addEventListener('pointercancel', soltar, { once: true });
    });
  }
  lista?.addEventListener('keydown', (e) => {
    const alca = e.target.closest('.arrasto');
    if (!alca || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const i = S.ativos.findIndex((a) => a.id === alca.dataset.arrasto);
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= S.ativos.length) return;
    [S.ativos[i], S.ativos[j]] = [S.ativos[j], S.ativos[i]];
    persist('ativos'); render();
    $(`[data-arrasto="${alca.dataset.arrasto}"]`)?.focus();
  });
  pintarTotais();
}

async function atualizarCotacoes() {
  if (atualizando) return;
  atualizando = true;
  ultimaBusca = Date.now();
  pintarPrecos();
  const { ok, erros, total } = await atualizarTodas(S.ativos, S.ajustes.token, (a, q, err) => {
    if (q) {
      a.preco = q.preco; a.precoEm = q.em; a.fonte = q.fonte || 'brapi';
      if (!a.nome && q.nome) a.nome = q.nome;
      delete statusCotacao[a.id];
    } else {
      statusCotacao[a.id] = { erro: err.message };
    }
  });
  atualizando = false;
  persist();
  pintarPrecos();
  if (total && !ok) toast('Não consegui atualizar os preços agora. Você pode digitá-los.');
}

// ---------- registrar compras ----------
function abrirRegistrar() {
  const b = banco();
  const r = resumo(b);
  const linhas = r.linhas.filter((l) => l.qtd > 0);
  if (!linhas.length) return;
  const dlg = $('#dlg-registrar');
  dlg.innerHTML = `
    <form method="dialog" id="form-reg">
      <h2>Registrar compras</h2>
      <p class="dica">Confira as quantidades e o preço que saiu na nota do ${esc(b.nome)}. Se pagou um preço diferente, corrija aqui.</p>
      <div class="campos">
        <label class="campo"><span>Data da compra</span><input type="date" id="reg-data" value="${hojeISO()}" required></label>
        <label class="campo"><span>Banco</span><select id="reg-banco">${S.bancos.map((bk) => `<option value="${bk.id}" data-icone="${esc(logoBanco(bk.id, bk.nome))}" ${bk.id === b.id ? 'selected' : ''}>${esc(bk.nome)}</option>`).join('')}</select></label>
      </div>
      <div class="linhas">
        <div class="linha"><small>Ativo</small><small style="text-align:right">Qtd</small><small style="text-align:right">Preço pago</small></div>
        ${linhas.map((l) => `
          <div class="linha">
            <span><b>${esc(l.ativo.ticker)}</b></span>
            <input class="num" id="reg-q-${l.ativo.id}" data-reg-q="${l.ativo.id}" inputmode="decimal" value="${fmtQtd(l.qtd)}" aria-label="Quantidade ${esc(l.ativo.ticker)}">
            <input class="num" id="reg-p-${l.ativo.id}" data-reg-p="${l.ativo.id}" inputmode="decimal" value="${l.preco.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}" aria-label="Preço ${esc(l.ativo.ticker)}">
          </div>`).join('')}
      </div>
      <div class="custos" id="reg-total"></div>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok" id="reg-ok">Salvar compras</button></div>
    </form>`;
  const coletar = () => {
    const bk = banco($('#reg-banco').value);
    return linhas.map((l) => {
      const q = normalizaQtd(l.ativo, num($(`#reg-q-${l.ativo.id}`).value));
      const p = num($(`#reg-p-${l.ativo.id}`).value);
      const preco = Number.isFinite(p) && p > 0 ? p : l.preco;
      return { ativo: l.ativo, qtd: q, preco, custo: linhaPlano({ ...l.ativo, preco }, q, bk).custo, banco: bk.id };
    }).filter((x) => x.qtd > 0);
  };
  const totalReg = () => {
    const xs = coletar();
    const tot = xs.reduce((s, x) => s + x.qtd * x.preco + x.custo, 0);
    const c = xs.reduce((s, x) => s + x.custo, 0);
    $('#reg-total').innerHTML = `<div class="ln"><span>Custos</span><span class="num">${R(c)}</span></div><div class="ln total"><span>Total investido</span><span class="num">${R(tot)}</span></div>`;
  };
  dlg.oninput = totalReg;
  totalReg();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const data = $('#reg-data').value || hojeISO();
    const xs = coletar();
    const novas = xs.map((x) => ({ id: uid(), data, ticker: x.ativo.ticker, tipo: x.ativo.tipo, qtd: x.qtd, preco: x.preco, custo: x.custo, banco: x.banco }));
    S.compras.push(...novas);
    N.adicionarCompras(novas);
    S.plano.qtds = {};
    persist('plano');
    toast(`${xs.length} ${xs.length === 1 ? 'compra registrada' : 'compras registradas'}.`);
    render();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- aba Carteira ----------
// ---------- um gráfico só: investido por tipo + proventos, por dia, mês ou ano ----------
const NOME_CURTO_PROV = { rendimento: 'Rendimentos', atualizacao: 'Correção', fracao: 'Frações', resgate: 'Resgate' };
const NOME_CLASSE = { acao: 'de ações', fii: 'de FIIs', tesouro: 'do Tesouro', rf: 'de renda fixa', outros: 'de outros' };
const TIPOS_PROV_ORDEM = ['dividendo', 'jcp', 'rendimento', 'juros', 'atualizacao', 'fracao', 'resgate', 'outro'];
const SERIES = [
  { k: 'prov', nome: 'Proventos' },
  { k: 'acao', nome: 'Ações' },
  { k: 'fii', nome: 'FIIs' },
  { k: 'outros', nome: 'ETF/BDR' },
  { k: 'tesouro', nome: 'Tesouro' },
  { k: 'rf', nome: 'Renda fixa' },
  { k: 'taxa', nome: 'Com taxas' },
];
const PILHA = ['acao', 'fii', 'outros', 'tesouro', 'rf']; // de baixo para cima
const GRAF_KEY = 'meus-investimentos:grafico';
const PADRAO_GRAF = { periodo: 'mes', modo: 'periodo', vista: 'detalhado', hist: ['prov', 'acao', 'fii', 'outros', 'tesouro', 'rf', 'taxa', 'mercado'], sel: null };
let G = (() => { try { return { ...PADRAO_GRAF, ...JSON.parse(localStorage.getItem(GRAF_KEY) || '{}') }; } catch { return { ...PADRAO_GRAF }; } })();
if (typeof G.sel !== 'number') G.sel = null;
if (!G.hist.includes('mercado') && !G.semMercado) G.hist.push('mercado');
if (!G.hist.includes('taxa') && !G.semTaxa) G.hist.push('taxa');
if (!G.rfVisto) { if (!G.hist.includes('rf')) G.hist.push('rf'); G.rfVisto = true; } // renda fixa chegou depois: aparece ligada
const salvarG = () => { try { localStorage.setItem(GRAF_KEY, JSON.stringify(G)); } catch { /* sem armazenamento */ } };

const rotuloCurto = (chave, per) => per === 'ano' ? chave : per === 'mes' ? mesCurto(chave) : `${chave.slice(8, 10)}/${chave.slice(5, 7)}`;
const rotuloLongo = (chave, per) => per === 'ano' ? chave : per === 'mes' ? nomeMesAno(chave).replace(/^./, (c) => c.toUpperCase()) : dataBR(chave);
const compacto = (v) => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10000 ? 0 : 1 })} mil` : Math.round(v).toLocaleString('pt-BR');

/** Todos os meses (ou anos) do primeiro registro até hoje, inclusive os vazios. Dias: só os que tiveram movimento. */
/** Compras e proventos do ativo escolhido no Histórico (todos quando nenhum). */
/** Banco de uma operação ou provento (os antigos, sem banco, contam no banco padrão). */
const bancoDe = (x) => x.banco || S.ajustes.banco;
/** Bancos que aparecem nas operações e proventos, na ordem da lista de bancos. */
function bancosUsados() {
  const ids = new Set([...S.compras, ...S.proventos].map(bancoDe));
  return [...S.bancos.filter((b) => ids.has(b.id)), ...[...ids].filter((id) => !S.bancos.some((b) => b.id === id)).map((id) => ({ id, nome: id }))];
}
/** Compras e proventos do banco escolhido no Histórico (todos quando nenhum). */
function dadosDoBanco() {
  if (G.banco && !bancosUsados().some((b) => b.id === G.banco)) G.banco = '';
  if (!G.banco) return { compras: S.compras, proventos: S.proventos };
  return { compras: S.compras.filter((c) => bancoDe(c) === G.banco), proventos: S.proventos.filter((p) => bancoDe(p) === G.banco) };
}
function dadosDoFiltro() {
  const d = dadosDoBanco();
  if (G.ativo && !d.compras.some((c) => c.ticker === G.ativo) && !d.proventos.some((p) => p.ticker === G.ativo)) G.ativo = '';
  const t = G.ativo;
  if (!t) return d;
  return { compras: d.compras.filter((c) => c.ticker === t), proventos: d.proventos.filter((p) => p.ticker === t) };
}
/** Ativos que aparecem no filtro: os que você tem ou já teve, e os que pagaram proventos. */
function ativosDoFiltro() {
  const d = dadosDoBanco();
  return [...new Set([...d.compras.map((c) => c.ticker), ...d.proventos.map((p) => p.ticker)])]
    .filter((t) => t && t !== 'Vários')
    .sort((a, b) => a.localeCompare(b));
}

function linhasDoGrafico(per) {
  const d = dadosDoFiltro();
  const ls = resumoPorPeriodo(d.compras, d.proventos, per);
  if (per === 'dia' || !ls.length) return ls;
  const mapa = new Map(ls.map((l) => [l.chave, l]));
  const vazio = (k) => ({ chave: k, acao: 0, fii: 0, tesouro: 0, rf: 0, outros: 0, total: 0, compras: 0, proventos: 0, tx: { acao: 0, fii: 0, tesouro: 0, rf: 0, outros: 0 }, pv: {} });
  const out = [];
  const hoje = per === 'ano' ? hojeISO().slice(0, 4) : mesDe(hojeISO());
  let k = ls[0].chave;
  const fim = ls[ls.length - 1].chave > hoje ? ls[ls.length - 1].chave : hoje;
  while (k <= fim) {
    out.push(mapa.get(k) || vazio(k));
    if (per === 'ano') k = String(Number(k) + 1);
    else { const [y, m] = k.split('-').map(Number); k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; }
  }
  return out;
}

// ---------- valor de mercado da carteira em cada mês (para comparar com o investido) ----------
const HIST_KEY = 'meus-investimentos:historico-precos';
let HIST = (() => {
  try { const h = JSON.parse(localStorage.getItem(HIST_KEY) || 'null'); return h && h.data === hojeISO() ? h.tickers : null; } catch { return null; }
})();
let carregandoHist = false;

/** Busca uma vez por dia o fechamento mensal de cada ativo da carteira. */
async function garantirHistorico() {
  if (HIST || carregandoHist) return;
  if (!N.nuvem.servidor) { HIST = {}; return; }
  carregandoHist = true;
  const tickers = [...new Set(S.compras.filter((c) => c.tipo !== 'tesouro' && c.tipo !== 'rf').map((c) => c.ticker))];
  const out = {};
  await Promise.all(tickers.map(async (t) => {
    const h = await historicoMensal(t);
    out[t] = Object.fromEntries(Object.entries(h.meses).filter(([, v]) => v.close > 0).map(([m, v]) => [m, v.close]));
  }));
  HIST = out;
  carregandoHist = false;
  try { localStorage.setItem(HIST_KEY, JSON.stringify({ data: hojeISO(), tickers: out })); } catch { /* sem armazenamento */ }
  redesenharGrafico();
}

/** Preço de um ativo no fim do mês `ym` (preço de hoje no mês atual). */
function precoNoMes(ticker, tipo, ym) {
  const atual = mesDe(hojeISO());
  const ativo = S.ativos.find((a) => a.ticker === ticker);
  if (ym >= atual && ativo?.preco) return ativo.preco;
  if (tipo === 'tesouro') return ativo?.preco ? precoTesouroEm(ym, ativo.preco, atual) : null;
  const closes = HIST?.[ticker];
  if (!closes) return null;
  let melhor = null;
  for (const m in closes) if (m <= ym && (!melhor || m > melhor)) melhor = m;
  return melhor ? closes[melhor] : null;
}

/** Quanto a carteira valia no fim do mês `ym`, por tipo. Sem preço, vale o que custou. */
function mercadoAte(ym) {
  const pos = new Map();
  const { compras } = dadosDoFiltro();
  const vendas = processarOperacoes(compras);
  for (const c of compras) {
    if (mesDe(c.data) > ym) continue;
    const p = pos.get(c.ticker) || { tipo: c.tipo, qtd: 0, custo: 0 };
    const lado = ladoDe(c);
    if (lado === 'V') { p.qtd -= Number(c.qtd); p.custo -= vendas.get(c.id)?.custoBase || 0; }
    else if (lado === 'B' || lado === 'A') p.qtd += Number(c.qtd);
    else { p.qtd += Number(c.qtd); p.custo += Number(c.qtd) * Number(c.preco) + Number(c.custo || 0); }
    pos.set(c.ticker, p);
  }
  for (const [t, p] of pos) if (p.qtd <= 1e-9) pos.delete(t);
  const porTipo = { acao: 0, fii: 0, outros: 0, tesouro: 0, rf: 0, tes: {} };
  for (const [t, p] of pos) {
    const grupo = classeDe(p.tipo);
    const preco = precoNoMes(t, p.tipo, ym);
    const v = preco ? p.qtd * preco : p.custo;
    porTipo[grupo] += v;
    if (grupo === 'tesouro') porTipo.tes[t] = (porTipo.tes[t] || 0) + v;
  }
  return porTipo;
}
const fimDoPeriodo = (chave, per) => {
  const atual = mesDe(hojeISO());
  if (per === 'ano') return chave === atual.slice(0, 4) ? atual : `${chave}-12`;
  return chave;
};

/** Barra com só os cantos de cima arredondados. */
function barra(x, yTopo, w, h, r, cls) {
  if (h <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `<path class="${cls}" d="M${x},${yTopo + h}V${yTopo + r}Q${x},${yTopo} ${x + r},${yTopo}H${x + w - r}Q${x + w},${yTopo} ${x + w},${yTopo + r}V${yTopo + h}Z"/>`;
}

/** Tira as taxas de cada tipo quando o gráfico mostra só o valor dos ativos. */
const semTaxas = (l) => ({ ...l, ...Object.fromEntries(PILHA.map((k) => [k, Math.max(0, l[k] - (l.tx?.[k] || 0))])) });
const taxasDe = (l, pilha) => pilha.reduce((s, k) => s + (l.tx?.[k] || 0), 0);

function htmlGrafico(largura) {
  const per = G.periodo;
  const vista = G.vista === 'simples' ? 'simples' : 'detalhado';
  const acum = G.modo === 'acumulado';
  let linhas = linhasDoGrafico(per);
  if (acum) {
    const soma = { acao: 0, fii: 0, outros: 0, tesouro: 0, rf: 0, proventos: 0, extras: 0 };
    const tx = { acao: 0, fii: 0, outros: 0, tesouro: 0, rf: 0 };
    const pv = {};
    const pvc = {};
    const tes = {};
    linhas = linhas.map((l) => {
      for (const [k, v] of Object.entries(l.tes || {})) tes[k] = (tes[k] || 0) + v;
      for (const k of Object.keys(soma)) soma[k] += l[k] || 0;
      for (const k of Object.keys(tx)) tx[k] += l.tx?.[k] || 0;
      for (const [k, v] of Object.entries(l.pv || {})) pv[k] = (pv[k] || 0) + v;
      for (const [k, v] of Object.entries(l.pvc || {})) pvc[k] = (pvc[k] || 0) + v;
      return { ...l, ...soma, tx: { ...tx }, pv: { ...pv }, pvc: { ...pvc }, tes: { ...tes } };
    });
  }
  const temTaxa = dadosDoFiltro().compras.some((c) => Number(c.custo) > 0);
  const presentes = SERIES.filter((x) => (x.k === 'taxa' ? temTaxa : linhas.some((l) => (x.k === 'prov' ? l.proventos : l[x.k]) > 0)));
  const comTaxa = temTaxa && (G.hist || []).includes('taxa');
  // as taxas viram uma faixa própria no topo da barra (ou somem, com o filtro desligado)
  linhas = linhas.map(semTaxas);
  const podeMerc = acum && per !== 'dia' && dadosDoFiltro().compras.length > 0;
  if (podeMerc) presentes.push({ k: 'mercado', nome: 'Valorização' });
  const ativos = new Set((G.hist || []).filter((k) => presentes.some((x) => x.k === k)));
  const pilha = PILHA.filter((k) => ativos.has(k));
  const comProv = ativos.has('prov');
  linhas = linhas.map((l) => ({ ...l, taxa: comTaxa ? taxasDe(l, pilha) : 0 }));
  const pilhaBarra = comTaxa ? [...pilha, 'taxa'] : pilha;
  const inv = (l) => pilhaBarra.reduce((s, k) => s + (l[k] || 0), 0);
  const comMerc = podeMerc && ativos.has('mercado');
  if (comMerc && !HIST) garantirHistorico();
  // valor de mercado de cada classe (ações, FIIs, tesouro…) no fim de cada período
  const mercPorTipo = linhas.map((l) => (comMerc && HIST ? mercadoAte(fimDoPeriodo(l.chave, per)) : null));
  const merc = mercPorTipo.map((m) => (m ? pilha.reduce((s, k) => s + m[k], 0) : null));
  const brutas = linhasDoGrafico(per);
  const totTaxa = comTaxa ? brutas.reduce((s, l) => s + taxasDe(l, pilha), 0) : 0;
  const totInv = brutas.map(semTaxas).reduce((s, l) => s + pilha.reduce((t, k) => t + l[k], 0), 0) + totTaxa;
  const totProvTodos = brutas.reduce((s, l) => s + l.proventos, 0);
  const totProv = comProv ? totProvTodos : 0;

  // largura: cabe tudo na tela sempre que possível; só rola quando os períodos não cabem
  const n = linhas.length;
  const L = Math.max(280, Math.round(largura || 860));
  const minimo = per === 'ano' ? 78 : comMerc && comProv ? 96 : (comProv && pilha.length) || comMerc ? 86 : 74; // espaço para o valor em reais escrito por extenso
  const slot = n * minimo <= L ? L / Math.max(n, 1) : minimo;
  const W = Math.round(n * slot);
  const H = comMerc ? 300 : 280, topo = comMerc ? 62 : 46, base = 30;
  const alt = H - topo - base;
  // a linha mostra o valor da carteira. Proventos não somam em cima: eles entram no aporte do mês seguinte e já estão no investido
  const totalEm = (i) => (merc[i] != null ? merc[i] : null);
  const empilhaTudo = comMerc && HIST && pilha.length > 0; // acumulado: investido + valorização = carteira
  const simples = vista === 'simples'; // uma cor só para o investido e uma para os proventos
  // títulos do Tesouro em separado (Selic 2029, Selic 2031…), cada um num tom de dourado
  const titulosTes = [...new Set(S.compras.filter((c) => c.tipo === 'tesouro').map((c) => c.ticker))].sort();
  const nomeSerie = (k) => SERIES.find((x) => x.k === k)?.nome || k;
  /** Blocos de uma barra, de baixo para cima: investido (com as taxas, se ligadas) e quanto valia. */
  const blocosDe = (l, i) => {
    const mk = empilhaTudo ? mercPorTipo[i] : null;
    const out = [];
    if (simples) {
      // como no começo: só o investido de cada classe (Tesouro num bloco só), sem valorização
      for (const k of pilha) {
        const investido = (l[k] || 0) + (comTaxa ? l.tx?.[k] || 0 : 0);
        if (investido > 0.005) out.push({ k, cls: `s-${k}`, nome: nomeSerie(k), investido, vale: null });
      }
      return out;
    }
    for (const k of pilha) {
      if (k === 'tesouro' && titulosTes.length > 1) {
        titulosTes.forEach((t, j) => {
          const investido = l.tes?.[t] || 0;
          const vale = mk ? mk.tes?.[t] || 0 : null;
          if (investido > 0.005 || (vale || 0) > 0.005) out.push({ k, cls: `s-tes${j % 3}`, nome: t.replace(/^Tesouro /, ''), investido, vale });
        });
        continue;
      }
      const investido = (l[k] || 0) + (comTaxa ? l.tx?.[k] || 0 : 0);
      const vale = mk ? mk[k] || 0 : null;
      if (investido > 0.005 || (vale || 0) > 0.005) out.push({ k, cls: `s-${k}`, nome: nomeSerie(k), investido, vale });
    }
    return out;
  };
  const blocos = linhas.map((l, i) => blocosDe(l, i));
  // altura: cada bloco ocupa o maior entre investido e valor (a perda fica marcada dentro dele)
  const altura = blocos.map((bs) => bs.reduce((s2, b) => s2 + Math.max(b.investido, b.vale ?? 0), 0));
  const maxV = Math.max(1, ...linhas.map((l, i) => Math.max(altura[i], comProv ? l.proventos : 0, merc[i] || 0)));
  const y = (v) => topo + alt * (1 - v / maxV);
  const duas = pilha.length && comProv;
  const wInv = Math.min(58, Math.max(18, slot * (duas ? 0.46 : 0.5)));
  const wProv = duas ? Math.min(26, Math.max(10, slot * 0.18)) : wInv;
  const sel = Math.min(G.sel ?? n - 1, n - 1);
  const grade = [0.25, 0.5, 0.75, 1].map((f) => `<line class="grade" x1="0" x2="${W}" y1="${topo + alt * (1 - f)}" y2="${topo + alt * (1 - f)}"/>`).join('');
  const reais = (v) => R(v);
  const curto = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : Math.round(v).toLocaleString('pt-BR'));

  const barras = linhas.map((l, i) => {
    const cx = i * slot + slot / 2;
    const largGrupo = duas ? wInv + 3 + wProv : wInv;
    const xInv = cx - largGrupo / 2;
    const xProv = duas ? xInv + wInv + 3 : cx - wProv / 2;
    const etiqueta = (x, w, vTopo, vBase, texto, cls) => {
      const yT = y(vTopo), yB = y(vBase);
      if (simples || w < 30 || yB - yT < 12) return '';
      return `<text class="seg-rot ${cls}" x="${x + w / 2}" y="${(yT + yB) / 2 + 3.5}" text-anchor="middle">${texto}</text>`;
    };
    let acc = 0, segs = '', rotSeg = '';
    for (const b of blocos[i]) {
      const temValor = b.vale != null;
      const cheio = temValor ? Math.min(b.investido, b.vale) : b.investido;
      const y1 = y(acc + cheio), y0 = y(acc);
      segs += `<rect class="seg ${b.cls}" x="${xInv}" y="${y1}" width="${wInv}" height="${Math.max(0.5, y0 - y1)}"/>`;
      rotSeg += etiqueta(xInv, wInv, acc + cheio, acc, curto(b.investido), 'seg-inv');
      if (temValor) {
        const dif = b.vale - b.investido;
        if (dif >= 1) {
          // valorização: cresce para cima, hachurada em verde
          const v1 = y(acc + b.vale);
          segs += `<rect class="seg s-valoriz" x="${xInv}" y="${v1}" width="${wInv}" height="${Math.max(0.5, y1 - v1)}"/>`;
          rotSeg += etiqueta(xInv, wInv, acc + b.vale, acc + cheio, `+${curto(dif)}`, 'seg-val');
        } else if (dif <= -1) {
          // desvalorização: a parte do investido que se perdeu fica marcada em vermelho, por cima do que sobrou
          const v1 = y(acc + b.investido);
          segs += `<rect class="seg s-perda" x="${xInv}" y="${v1}" width="${wInv}" height="${Math.max(0.5, y1 - v1)}"/>`;
          rotSeg += etiqueta(xInv, wInv, acc + b.investido, acc + cheio, `−${curto(-dif)}`, 'seg-neg');
        }
      }
      acc += temValor ? Math.max(b.investido, b.vale) : b.investido;
    }
    // a barra inteira com o topo arredondado
    const yTopo = y(acc), yBase = y(0);
    const clip = acc ? `<clipPath id="cb${i}"><rect x="${xInv}" y="${yTopo}" width="${wInv}" height="${yBase - yTopo + 8}" rx="6"/></clipPath>` : '';
    // proventos por tipo, na barrinha ao lado
    let prov = '';
    if (comProv && l.proventos) {
      let ap = 0;
      const tiposBarra = simples ? [['prov', l.proventos]] : TIPOS_PROV_ORDEM.filter((t) => (l.pv?.[t] || 0) > 0).map((t) => [t, l.pv[t]]);
      for (const [k, v] of tiposBarra) {
        const p1 = y(ap + v), p0 = y(ap);
        prov += `<rect class="seg ${k === 'prov' ? 's-prov' : `pv-${k}`}" x="${xProv}" y="${p1}" width="${wProv}" height="${Math.max(0.5, p0 - p1)}"/>`;
        ap += v;
      }
      const yp = y(l.proventos);
      prov = `<clipPath id="cp${i}"><rect x="${xProv}" y="${yp}" width="${wProv}" height="${yBase - yp + 6}" rx="4"/></clipPath><g clip-path="url(#cp${i})">${prov}</g>`;
      if (duas && slot >= 60) rotSeg += `<text class="seg-rot seg-provtot" x="${xProv + wProv / 2}" y="${yp - 4}" text-anchor="middle">${curto(l.proventos)}</text>`;
    }
    const topoBarra = Math.min(acc ? yTopo : H, comProv && l.proventos ? y(l.proventos) - 12 : H, merc[i] != null ? y(merc[i]) - 7 : H);
    const [tx, anc] = slot >= 112 ? [cx, 'middle'] : i === 0 ? [i * slot + 4, 'start'] : i === n - 1 ? [(i + 1) * slot - 4, 'end'] : [cx, 'middle'];
    let rot = '';
    if (merc[i] != null && acc) {
      // em cima: quanto a carteira valia; embaixo, a valorização sobre o investido
      const ganho = merc[i] - inv(l);
      rot = `<text class="v" x="${tx}" y="${topoBarra - 22}" text-anchor="${anc}">${reais(merc[i])}</text>`
        + `<text class="v2 ${ganho >= 0 ? 'ganho' : 'perda'}" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">${ganho >= 0 ? '+' : '−'} ${reais(Math.abs(ganho))}</text>`;
    } else if (acc && comProv && l.proventos) rot = `<text class="v" x="${tx}" y="${topoBarra - 22}" text-anchor="${anc}">${reais(inv(l))}</text><text class="v2" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">+ ${reais(l.proventos)}</text>`;
    else if (acc) rot = `<text class="v" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">${reais(inv(l))}</text>`;
    else if (comProv && l.proventos) rot = `<text class="v" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">${reais(l.proventos)}</text>`;
    return `<g class="slot ${i === sel ? 'sel' : ''}" data-graf-slot="${i}">
      <rect class="alvo" x="${i * slot + 3}" y="4" width="${slot - 6}" height="${H - 8}" rx="10"/>
      ${clip}<g clip-path="url(#cb${i})">${segs}</g>${prov}${rotSeg}${rot}
      <text class="x" x="${cx}" y="${H - 10}" text-anchor="middle">${rotuloCurto(l.chave, per)}</text>
    </g>`;
  }).join('');

  // linha do valor da carteira ao longo do tempo, passando pelo topo de cada barra
  const pts = merc.map((v, i) => (v != null ? [i * slot + slot / 2, y(v)] : null));
  const linhaMerc = comMerc && HIST && pts.some(Boolean) ? `<polyline class="linha-merc" points="${pts.filter(Boolean).map((p2) => p2.join(',')).join(' ')}"/>${pts.map((p2, i) => (p2 ? `<circle class="ponto-merc ${i === sel ? 'sel' : ''}" cx="${p2[0]}" cy="${p2[1]}" r="${i === sel ? 5 : 3}"/>` : '')).join('')}` : '';

  const l = linhas[sel];
  const itens = !l ? [] : simples ? [
    ...blocos[sel].map((b) => [b.nome, b.investido, b.cls, null]),
    ...(comProv && l.proventos ? [['Proventos', l.proventos, 's-prov', null]] : []),
  ] : [
    ...blocos[sel].map((b) => [b.nome, b.investido, b.cls, b.vale]),
    ...(comProv ? TIPOS_PROV_ORDEM.map((k) => [TIPOS_PROVENTO[k].replace(' (FII)', ''), l.pv?.[k] || 0, `pv-${k}`, null]) : []),
  ].filter(([, v, , vale]) => v > 0.005 || (vale || 0) > 0.005);
  const temMercHoje = comMerc && HIST && merc[n - 1] != null;
  const subCab = acum && temMercHoje
    ? `Investido <b>${R(totInv)}</b> → carteira hoje <b>${R(merc[n - 1])}</b> <span class="${merc[n - 1] >= totInv ? 'var-alta' : 'var-baixa'}">${pct(totInv ? merc[n - 1] / totInv - 1 : null)}</span>${totProvTodos ? ` · proventos <b>${R(totProvTodos)}</b>` : ''}`
    : [
      pilha.length ? `Investido <b>${R(totInv)}</b>${totTaxa > 0 ? ` <span class="apagado">(taxas ${R(totTaxa)})</span>` : ''}` : '',
      comMerc && !HIST ? 'calculando o valor de mercado…' : '',
      comProv ? `Proventos <b>${R(totProv)}</b>` : '',
    ].filter(Boolean).join(' · ');
  const porClasse = (pvc) => Object.entries(NOME_CLASSE).filter(([k]) => (pvc?.[k] || 0) > 0).map(([k, nm]) => `${nm} ${R(pvc[k])}`).join(' · ');
  const conta = l && acum && pilha.length ? (() => {
    const invS = inv(l);
    const provS = l.proventos || 0; // tudo que entrou sem sair do bolso
    const extrasS = Math.min(provS, l.extras || 0); // frações, resgates…
    const provFato = provS - extrasS; // dividendos, JCP, rendimentos, correção
    const mercS = merc[sel];
    const valoriz = mercS != null ? mercS - invS : null;
    const bolso = Math.max(0, invS - provS); // o que saiu do seu bolso: proventos e créditos foram reinvestidos nos aportes
    const ganho = (valoriz || 0) + provS;
    const sinal = (v) => `${v >= 0 ? '+' : '−'} ${R(Math.abs(v))}`;
    const hoje = sel === n - 1;
    const lq = hoje && !simples ? liquidoSeVender(dadosDoFiltro().compras, S.ativos, hojeISO()) : null;
    const desc = lq ? lq.total.ir + lq.total.iof + lq.total.taxas : 0;
    const linhaVal = valoriz != null ? `<div class="conta-l"><span>Valorização<small>${hoje ? 'pelo preço das cotas hoje' : `pelo preço no fim de ${rotuloCurto(l.chave, per)}`}</small></span><b class="num ${valoriz >= 0 ? 'var-alta' : 'var-baixa'}">${sinal(valoriz)}</b></div>` : '';
    const linhaCarteira = valoriz != null ? `<div class="conta-l conta-total"><span>Valor da carteira</span><b class="num">${R(mercS)}</b></div>` : '<div class="conta-l conta-total"><span>Valor da carteira<small>sem preços para calcular</small></span><b class="num">—</b></div>';
    const linhaGanho = (sm) => `<div class="conta-ret"><span>Ganho total<small>${sm}</small></span><b class="${ganho >= 0 ? 'var-alta' : 'var-baixa'}">${sinal(ganho)} · ${pct(bolso ? ganho / bolso : null)}</b></div>`;
    const cab = `<div class="conta-cab"><b>Até ${rotuloLongo(l.chave, per).replace(/^Até /, '')}</b>${G.ativo ? `<span class="apagado">${esc(G.ativo)}</span>` : ''}</div>`;

    if (simples) {
      // só o essencial: bolso, o que veio de graça, valorização e o resultado
      return `
    <div class="conta conta-simples">
      ${cab}
      <div class="conta-linhas">
        ${provS ? `<div class="conta-l"><span>Do seu bolso</span><b class="num">${R(bolso)}</b></div>
        <div class="conta-l"><span>Proventos e créditos</span><b class="num var-alta">${sinal(provS)}</b></div>` : `<div class="conta-l"><span>Investido</span><b class="num">${R(invS)}</b></div>`}
        ${linhaVal}
        ${linhaCarteira}
        ${linhaGanho('sobre o que saiu do bolso')}
      </div>
    </div>`;
    }

    return `
    <div class="conta">
      ${cab}
      <div class="conta-linhas">
        ${provS ? `<div class="conta-l"><span>Do seu bolso<small>aportes</small></span><b class="num">${R(bolso)}</b></div>
        ${provFato > 0.005 ? `<div class="conta-l"><span>Proventos reinvestidos<small>dividendos, JCP, rendimentos e correção${extrasS > 0.005 ? '' : ` · ${porClasse(l.pvc)}`}</small></span><b class="num var-alta">${sinal(provFato)}</b></div>` : ''}
        ${extrasS > 0.005 ? `<div class="conta-l"><span>Outros créditos reinvestidos<small>frações, resgates e afins: não é provento, mas também não saiu do bolso</small></span><b class="num var-alta">${sinal(extrasS)}</b></div>` : ''}` : ''}
        <div class="conta-l ${provS ? 'conta-sub' : ''}"><span>Investido</span><b class="num">${R(invS)}</b></div>
        ${linhaVal}
        ${linhaCarteira}
        ${valoriz != null && desc >= 0.01 ? `<div class="conta-l"><span>Imposto e taxas se vender hoje<small>IR ${R(lq.total.ir + lq.total.iof)} · taxas ${R(lq.total.taxas)}</small></span><b class="num var-baixa">− ${R(desc)}</b></div>
          <div class="conta-l conta-liq"><span>Líquido</span><b class="num">${R(mercS - desc)}</b></div>` : ''}
        ${linhaGanho(`valorização ${R(valoriz || 0)} + proventos ${R(provFato)}${extrasS > 0.005 ? ` + outros créditos ${R(extrasS)}` : ''}, sobre o que saiu do bolso`)}
        ${desc >= 0.01 ? (() => {
          const g2 = ganho - desc;
          return `<div class="conta-ret"><span>Ganho líquido<small>descontado o imposto e as taxas de vender hoje</small></span><b class="${g2 >= 0 ? 'var-alta' : 'var-baixa'}">${sinal(g2)} · ${pct(bolso ? g2 / bolso : null)}</b></div>`;
        })() : ''}
      </div>
      ${itens.length ? `<div class="det-itens">${itens.map(([nome, v, cls, vale]) => {
        if (vale == null) return `<span><i class="sw ${cls}"></i>${nome}<b>${R(v)}</b></span>`;
        const d = vale - v;
        return `<span><i class="sw ${cls}"></i>${nome}<b>${R(v)}</b>${Math.abs(d) >= 0.01 ? `<b class="${d >= 0 ? 'var-alta' : 'var-baixa'}">${d >= 0 ? '+' : '−'}${R(Math.abs(d))}</b>` : ''}</span>`;
      }).join('')}</div>` : ''}
    </div>`;
  })() : '';
  const detalhe = conta || (l ? `
    <div class="det-cab"><b>${acum ? 'Até ' : ''}${rotuloLongo(l.chave, per)}</b>${pilha.length && inv(l) ? `<span>Investido <b>${R(inv(l))}</b>${comTaxa && l.taxa > 0 ? ` <span class="apagado">(taxas ${R(l.taxa)})</span>` : ''}${merc[sel] != null ? ` · Valia <b>${R(merc[sel])}</b> <span class="${merc[sel] >= inv(l) ? 'var-alta' : 'var-baixa'}">${merc[sel] >= inv(l) ? '+' : '−'}${R(Math.abs(merc[sel] - inv(l)))} (${pct(inv(l) ? merc[sel] / inv(l) - 1 : null)})</span>` : ''}</span>` : ''}</div>
    ${itens.length ? `<div class="det-itens">${itens.map(([nome, v, cls]) => `<span><i class="sw ${cls}"></i>${nome}<b>${R(v)}</b></span>`).join('')}${comProv && l.proventos && !simples ? `<span class="det-soma">Proventos<b>${R(l.proventos)}</b></span>` : ''}</div>${comProv && l.proventos ? `<div class="det-classe">${porClasse(l.pvc)}</div>` : ''}` : inv(l) ? '' : '<div class="det-itens"><span class="apagado">Sem movimento neste período.</span></div>'}` : '');

  return `
    <section class="bloco grafico-bloco" id="graf-hist">
      <div class="graf-topo">
        <div>
          <h2>${acum ? 'Total acumulado' : 'Quanto investi'}${tituloBanco()}${G.ativo ? ` <span class="graf-ativo-nome">· ${esc(G.ativo)}</span>` : ''}</h2>
          <small class="sub-cab">${subCab}</small>
        </div>
        <div class="graf-controles">
          ${bancosUsados().length > 1 ? `<select id="graf-banco" class="peq" aria-label="Banco">
            <option value="">Todos os bancos</option>
            ${bancosUsados().map((b) => `<option value="${esc(b.id)}" data-icone="${esc(logoBanco(b.id, b.nome))}" ${b.id === G.banco ? 'selected' : ''}>${esc(b.nome)}</option>`).join('')}
          </select>` : ''}
          <select id="graf-ativo" class="peq" aria-label="Ativo">
            <option value="">Todos os ativos</option>
            ${ativosDoFiltro().map((t) => `<option ${t === G.ativo ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          </select>
          <div class="seg" role="group" aria-label="Visão">
            ${[['simples', 'Simples'], ['detalhado', 'Detalhado']].map(([k, nm]) => `<button type="button" data-graf-vista="${k}" aria-pressed="${vista === k}">${nm}</button>`).join('')}
          </div>
          <div class="seg" role="group" aria-label="Mostrar">
            ${[['periodo', 'No período'], ['acumulado', 'Acumulado']].map(([k, nm]) => `<button type="button" data-graf-modo="${k}" aria-pressed="${(G.modo || 'periodo') === k}">${nm}</button>`).join('')}
          </div>
          <div class="seg" role="group" aria-label="Agrupar por">
            ${[['dia', 'Dia'], ['mes', 'Mês'], ['ano', 'Ano']].map(([k, nm]) => `<button type="button" data-graf-periodo="${k}" aria-pressed="${per === k}">${nm}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="filtros" role="group" aria-label="Mostrar no gráfico">
        ${presentes.map((x) => `<button type="button" class="filtro" data-graf-serie="${x.k}" aria-pressed="${ativos.has(x.k)}"><i class="sw s-${x.k}${simples && x.k === 'mercado' ? ' linha' : ''}"></i>${simples && x.k === 'mercado' ? 'Valor de mercado' : x.nome}</button>`).join('')}
      </div>
      ${n ? `<div class="graf-rolagem" data-largura="${L}"><svg class="grafico" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Investimentos${comProv ? ' e proventos' : ''} por ${per === 'mes' ? 'mês' : per}${acum ? ', acumulado' : ''}">
        <defs>
          <pattern id="hach-valoriz" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hach-fundo-alta" width="6" height="6"/><line class="hach-linha-alta" x1="0" y1="0" x2="0" y2="6"/></pattern>
          <pattern id="hach-perda" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect class="hach-fundo-baixa" width="6" height="6"/><line class="hach-linha-baixa" x1="0" y1="0" x2="0" y2="6"/></pattern>
        </defs>
        ${grade}<line class="base" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${barras}${linhaMerc}</svg></div>
      ${empilhaTudo && !simples ? `<div class="graf-legenda"><span><i class="sw s-valoriz"></i>valorização</span><span><i class="sw s-perda-sw"></i>desvalorização</span>${comProv ? '<span><i class="sw pv-dividendo"></i>proventos (barra ao lado)</span>' : ''}</div>` : ''}
      <div class="graf-detalhe">${detalhe}</div>` : '<p class="dica">Ainda não há compras nem proventos para mostrar.</p>'}
    </section>`;
}

function redesenharGrafico({ fim = false } = {}) {
  const sec = $('#graf-hist');
  if (!sec) return;
  const rol = sec.querySelector('.graf-rolagem');
  const pos = rol?.scrollLeft;
  const largura = sec.clientWidth - 36;
  sec.outerHTML = htmlGrafico(largura);
  const nova = $('#graf-hist .graf-rolagem');
  if (nova) nova.scrollLeft = fim ? nova.scrollWidth : pos;
}

function ligarGrafico() {
  // mede a largura real e redesenha para caber sem rolagem quando possível
  redesenharGrafico({ fim: true });
  $('#conteudo').addEventListener('change', (e) => {
    if (e.target.id !== 'graf-ativo' && e.target.id !== 'graf-banco') return;
    if (e.target.id === 'graf-banco') G.banco = e.target.value;
    else G.ativo = e.target.value;
    G.sel = null;
    salvarG();
    const y = scrollY;
    render(); // gráfico e lista de operações mostram só esse ativo
    scrollTo({ top: y });
  });
  $('#conteudo').addEventListener('click', (e) => {
    const t = e.target.closest('[data-graf-periodo],[data-graf-serie],[data-graf-slot],[data-graf-modo],[data-graf-vista]');
    if (!t) return;
    let fim = false;
    if (t.dataset.grafPeriodo) { G.periodo = t.dataset.grafPeriodo; G.sel = null; fim = true; }
    if (t.dataset.grafModo) { G.modo = t.dataset.grafModo; }
    if (t.dataset.grafVista) { G.vista = t.dataset.grafVista; }
    if (t.dataset.grafSerie) {
      const lista = new Set(G.hist);
      lista.has(t.dataset.grafSerie) ? lista.delete(t.dataset.grafSerie) : lista.add(t.dataset.grafSerie);
      if (![...lista].some((k) => k !== 'taxa')) return; // sempre fica pelo menos uma série
      G.hist = [...lista];
      if (t.dataset.grafSerie === 'mercado') G.semMercado = !lista.has('mercado');
      if (t.dataset.grafSerie === 'taxa') G.semTaxa = !lista.has('taxa');
    }
    if (t.dataset.grafSlot) G.sel = Number(t.dataset.grafSlot);
    salvarG();
    redesenharGrafico({ fim });
  });
}
let redimT;
window.addEventListener('resize', () => { clearTimeout(redimT); redimT = setTimeout(() => redesenharGrafico(), 150); });

function ligarHistorico() {
  ligarRemover('data-del-compra', 'compras');
  $('#conteudo').addEventListener('click', (e) => {
    const fb = e.target.closest('[data-filtra-banco]');
    if (fb) { G.banco = fb.dataset.filtraBanco; G.sel = null; salvarG(); render(); return; }
    const nova = e.target.closest('[data-nova-op]');
    if (nova) { abrirEditarCompra(null, nova.dataset.novaOp); return; }
    if (e.target.closest('[data-del-compra]')) return; // a lixeira não abre o editor
    const b = e.target.closest('[data-edit-compra]');
    if (b) abrirEditarCompra(b.dataset.editCompra);
  });
  $('#conteudo').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card-compra')) {
      e.preventDefault();
      abrirEditarCompra(e.target.dataset.editCompra);
    }
  });
  ligarGrafico();
}

// ---------- editar uma compra ----------
const fmtValor = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** Preço do ativo no dia (último pregão até a data), pelo Worker. */
const precosDoDia = new Map();
async function precoNoDia(ticker, dia) {
  const k = `${ticker}|${dia}`;
  if (!precosDoDia.has(k)) {
    precosDoDia.set(k, fetch(`/api/preco-dia?t=${encodeURIComponent(ticker)}&d=${dia}`)
      .then((r) => r.json())
      .catch(() => ({ erro: 'sem conexão' })));
  }
  const j = await precosDoDia.get(k);
  if (j.erro) precosDoDia.delete(k); // tenta de novo na próxima vez
  return j;
}

const ROTULO_LADO = { C: 'Compra', V: 'Venda', B: 'Bonificação', A: 'Ajuste de cotas' };

/** Edita uma operação existente, ou cria uma nova quando `nova` traz o lado ('C' | 'V' | 'B'). */
function abrirEditarCompra(id, nova) {
  const existente = S.compras.find((x) => x.id === id);
  if (!existente && !nova) return;
  const posAtual = carteira(S.compras, S.ativos, S.proventos).linhas;
  const tipoDeLinha = (t) => posAtual.find((l) => l.ticker === t)?.tipo;
  const tickersPos = posAtual.map((l) => l.ticker).sort((a, b) => (tipoDeLinha(a) === 'tesouro') - (tipoDeLinha(b) === 'tesouro') || a.localeCompare(b));
  const todos = [...new Set([...tickersPos, ...S.ativos.map((a) => a.ticker), ...S.compras.map((x) => x.ticker)])];
  const c = existente || {
    id: uid(), data: hojeISO(), lado: nova,
    ticker: (nova === 'V' ? tickersPos[0] : S.ativos[0]?.ticker) || todos[0] || '',
    qtd: '', preco: '', custo: 0, banco: banco().id,
  };
  const tipoDe = (t) => S.ativos.find((a) => a.ticker === t)?.tipo || S.compras.find((x) => x.ticker === t)?.tipo || adivinharTipo(t);
  const bancoAtual = S.bancos.some((b) => b.id === c.banco) ? c.banco : banco().id;
  const lado0 = ladoDe(c);
  const opcoesTicker = (lado) => (lado === 'V' && !existente ? tickersPos : todos);
  const dlg = $('#dlg-compra');
  dlg.innerHTML = `
    <form method="dialog" id="form-edit" class="form-edit">
      <h2 id="ed-tit"></h2>
      ${c.importado ? '<p class="dica">Veio da planilha com a quantidade estimada. Corrigindo aqui, ela passa a valer como exata.</p>' : ''}
      <div class="campos dois">
        <label class="campo"><span>Operação</span><select id="ed-lado">${Object.entries(ROTULO_LADO).map(([k, v]) => `<option value="${k}" ${k === lado0 ? 'selected' : ''}>${v}</option>`).join('')}</select><small class="sub"></small></label>
        <label class="campo"><span>Ativo</span><select id="ed-ticker" ${existente ? 'disabled' : ''}>${opcoesTicker(lado0).map((t) => `<option ${t === c.ticker ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><small class="sub" id="ed-pos"></small></label>
        <label class="campo"><span id="ed-rot-data">Data</span><input type="date" id="ed-data" value="${esc(c.data)}" max="${hojeISO()}" required><small class="sub"></small></label>
        <label class="campo"><span>Banco</span><select id="ed-banco">${S.bancos.map((bk) => `<option value="${bk.id}" data-icone="${esc(logoBanco(bk.id, bk.nome))}" ${bk.id === bancoAtual ? 'selected' : ''}>${esc(bk.nome)}</option>`).join('')}</select><small class="sub"></small></label>
        <label class="campo"><span id="ed-rot-qtd">Cotas</span><input class="num" id="ed-qtd" inputmode="decimal" value="${c.qtd === '' ? '' : fmtQtd(c.qtd)}" placeholder="0" required><small class="sub"></small></label>
        <label class="campo" id="ed-c-preco"><span id="ed-rot-preco">Preço por cota</span><input class="num" id="ed-preco" inputmode="decimal" value="${c.preco === '' ? '' : fmtValor(c.preco)}" placeholder="0,00"><small class="sub" id="ed-dia"></small></label>
        <label class="campo" id="ed-c-custo"><span>Taxas</span><input class="num" id="ed-custo" inputmode="decimal" value="${fmtValor(c.custo || 0)}"><small class="sub"><button type="button" id="ed-recalc">calcular pelo banco</button></small></label>
        <div class="campo" id="ed-c-total"><span id="ed-rot-total">Total</span><div class="disp-valor num" id="ed-total"></div><small class="sub" id="ed-res"></small></div>
      </div>
      <p class="dica erro-campo" id="ed-erro" hidden></p>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok">Salvar</button></div>
    </form>`;

  const lado = () => $('#ed-lado').value;
  const ticker = () => $('#ed-ticker').value;
  const tipo = () => (existente ? c.tipo : tipoDe(ticker()));
  const ativoAtual = () => S.ativos.find((a) => a.ticker === ticker()) || { ticker: ticker(), tipo: tipo() };
  const ler = () => {
    const bruto = num($('#ed-qtd').value);
    const sinal = lado() === 'A' && bruto < 0 ? -1 : 1;
    const qtd = sinal * normalizaQtd(ativoAtual(), Math.abs(bruto));
    const semValor = lado() === 'B' || lado() === 'A';
    const preco = semValor ? 0 : num($('#ed-preco').value);
    const custo = semValor ? 0 : num($('#ed-custo').value || 0);
    return { qtd, preco, custo: Number.isFinite(custo) && custo >= 0 ? round2(custo) : NaN };
  };
  /** Posição antes desta operação (sem contar ela mesma), para a venda mostrar o preço médio e o resultado. */
  const posicaoSem = () => {
    const outras = S.compras.filter((x) => x.id !== c.id && x.ticker === ticker() && x.data <= $('#ed-data').value);
    return carteira(outras, [], []).linhas[0] || { qtd: 0, investido: 0, precoMedio: 0 };
  };
  const pintar = () => {
    const l = lado(), tes = tipo() === 'tesouro';
    const un = tes ? 'títulos' : 'cotas', un1 = tes ? 'título' : 'cota';
    $('#ed-tit').textContent = `${existente ? 'Editar' : 'Registrar'} ${ROTULO_LADO[l].toLowerCase()}${existente ? ` de ${c.ticker}` : ''}`;
    $('#ed-rot-data').textContent = l === 'B' || l === 'A' ? 'Data do crédito' : `Data da ${ROTULO_LADO[l].toLowerCase()}`;
    $('#ed-rot-qtd').textContent = l === 'B' ? `${tes ? 'Títulos' : 'Cotas'} recebidas` : l === 'A' ? 'Cotas a mais (+) ou a menos (−)' : tes ? 'Títulos' : 'Cotas';
    $('#ed-rot-preco').textContent = l === 'V' ? `Preço de venda por ${un1}` : `Preço pago por ${un1}`;
    $('#ed-rot-total').textContent = l === 'V' ? 'Você recebe' : 'Total';
    for (const k of ['#ed-c-preco', '#ed-c-custo', '#ed-c-total']) $(k).hidden = l === 'B' || l === 'A';
    const pos = posicaoSem();
    $('#ed-pos').textContent = pos.qtd ? `você tinha ${fmtQtd(pos.qtd)} ${pos.qtd === 1 ? un1 : un}` : '';
    const { qtd, preco, custo } = ler();
    const ok = qtd > 0 && preco > 0 && Number.isFinite(custo);
    $('#ed-total').textContent = ok ? R(l === 'V' ? qtd * preco - custo : qtd * preco + custo) : '—';
    const res = $('#ed-res');
    res.textContent = '';
    res.className = 'sub';
    if (l === 'V' && ok && pos.qtd && qtd <= pos.qtd + 1e-9) {
      const r = qtd * preco - custo - Math.min(qtd, pos.qtd) * (pos.investido / pos.qtd);
      res.textContent = `${r >= 0 ? 'lucro' : 'prejuízo'} de ${R(Math.abs(r))} (médio ${R(pos.investido / pos.qtd)})`;
      res.classList.add(r >= 0 ? 'var-alta' : 'var-baixa');
    }
  };
  const recalcular = () => {
    const { qtd, preco } = ler();
    if (!(qtd > 0 && preco > 0)) return;
    const custo = linhaPlano({ ...ativoAtual(), tipo: tipo(), preco }, qtd, banco($('#ed-banco').value)).custo;
    $('#ed-custo').value = fmtValor(custo);
    pintar();
  };

  // preço do pregão na data escolhida, com atalho para usar o fechamento
  let pedido = 0;
  const buscarDia = async () => {
    const box = $('#ed-dia');
    const dia = $('#ed-data').value;
    if (lado() === 'B' || lado() === 'A') { box.textContent = ''; return; }
    if (tipo() === 'tesouro') { box.textContent = 'Tesouro: confira no extrato do banco.'; return; }
    if (!N.nuvem.servidor || !dia || !ticker()) { box.textContent = ''; return; }
    const meu = ++pedido;
    box.textContent = 'buscando o preço do dia…';
    const j = await precoNoDia(ticker(), dia);
    if (meu !== pedido || !dlg.open) return;
    if (j.erro || !j.fechamento) { box.textContent = 'Não achei o preço desse dia.'; return; }
    const outroDia = j.data !== dia ? ` (pregão de ${dataBR(j.data)})` : '';
    const faixa = j.minima && j.maxima ? `entre ${R(j.minima)} e ${R(j.maxima)}` : '';
    box.innerHTML = `Fechou a ${R(j.fechamento)}${outroDia}${faixa ? `, ${faixa}` : ''} · <button type="button" id="ed-usar">usar</button>`;
    $('#ed-usar').onclick = () => { $('#ed-preco').value = fmtValor(j.fechamento); pintar(); };
  };

  dlg.oninput = (e) => {
    if (e.target.id === 'ed-data' || e.target.id === 'ed-ticker') buscarDia();
    pintar();
  };
  dlg.onchange = (e) => {
    if (e.target.id === 'ed-lado' && !existente) {
      // venda nova só oferece o que você tem em carteira
      const atual = ticker();
      const lista = opcoesTicker(lado());
      $('#ed-ticker').innerHTML = lista.map((t) => `<option ${t === atual ? 'selected' : ''}>${esc(t)}</option>`).join('');
    }
    if (['ed-lado', 'ed-data', 'ed-ticker'].includes(e.target.id)) buscarDia();
    pintar();
  };
  $('#ed-recalc').onclick = recalcular;
  $('#form-edit').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const { qtd, preco, custo } = ler();
    const data = $('#ed-data').value;
    const l = lado();
    const pos = posicaoSem();
    const msg = !ticker() ? 'Escolha o ativo.'
      : !/^\d{4}-\d{2}-\d{2}$/.test(data) ? 'Escolha a data.'
      : l === 'A' ? (!qtd ? 'Informe quantas cotas a mais ou a menos.' : qtd < 0 && -qtd > pos.qtd + 1e-9 ? `Nessa data você tinha só ${fmtQtd(pos.qtd)}.` : '')
      : !(qtd > 0) ? 'Informe a quantidade.'
      : l !== 'B' && !(preco > 0) ? `Informe o preço ${l === 'V' ? 'de venda' : 'pago'}.`
      : !Number.isFinite(custo) ? 'Taxa inválida.'
      : l === 'V' && qtd > pos.qtd + 1e-9 ? `Nessa data você tinha só ${fmtQtd(pos.qtd)}.` : '';
    if (msg) { e.preventDefault(); const er = $('#ed-erro'); er.textContent = msg; er.hidden = false; }
  });
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const { qtd, preco, custo } = ler();
    const l = lado();
    const nova = { id: c.id, data: $('#ed-data').value, ticker: ticker(), tipo: tipo(), qtd, preco, custo, banco: $('#ed-banco').value };
    if (l !== 'C') nova.lado = l;
    S.compras = existente ? S.compras.map((x) => (x.id === c.id ? nova : x)) : [...S.compras, nova];
    N.adicionarCompras([nova]); // a nuvem grava por cima do mesmo registro
    persist();
    toast(existente ? 'Operação corrigida.' : `${ROTULO_LADO[l]} registrada.`);
    render();
  };
  pintar();
  dlg.returnValue = '';
  dlg.showModal();
  buscarDia();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// ---------- quanto da carteira está em cada tipo (ações, FIIs, Tesouro, BDR, ETF…) ----------
const NOMES_TIPO = { acao: 'Ações', fii: 'Fundos imobiliários', tesouro: 'Tesouro', rf: 'Renda fixa', bdr: 'BDR', etf: 'ETF' };
const ORDEM_TIPO = ['acao', 'fii', 'tesouro', 'rf', 'bdr', 'etf'];
function htmlPorTipo(c) {
  const g = new Map();
  for (const l of c.linhas) {
    const t = S.ativos.find((a) => a.ticker === l.ticker)?.tipo || l.tipo || 'outros';
    const x = g.get(t) || { valor: 0, investido: 0, n: 0 };
    x.valor += l.valorAtual ?? l.investido;
    x.investido += l.investido;
    x.n++;
    g.set(t, x);
  }
  const total = [...g.values()].reduce((s, x) => s + x.valor, 0);
  if (!total || !g.size) return '';
  const tipos = [...g.keys()].sort((a, b) => g.get(b).valor - g.get(a).valor || ORDEM_TIPO.indexOf(a) - ORDEM_TIPO.indexOf(b));
  const pc = (v) => `${(v / total * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const sw = (t) => `s-${NOMES_TIPO[t] ? t : 'outros'}`;
  return `
    <section class="bloco carteira-tipos">
      <div class="bloco-cab"><h2>Por tipo${tituloBanco()}</h2><small>quanto da carteira está em cada tipo, pelo valor de hoje</small></div>
      <div class="pt-barra" role="img" aria-label="${tipos.map((t) => `${NOMES_TIPO[t] || t} ${pc(g.get(t).valor)}`).join(', ')}">${tipos.map((t) => `<i class="${sw(t)}" style="width:${(g.get(t).valor / total) * 100}%"></i>`).join('')}</div>
      <div class="pt-lista">${tipos.map((t) => {
        const x = g.get(t);
        const r = x.investido ? x.valor / x.investido - 1 : null;
        return `<div class="pt-item">
          <span class="pt-nome"><i class="sw ${sw(t)}"></i>${esc(NOMES_TIPO[t] || t)}<small>${x.n} ${x.n === 1 ? 'ativo' : 'ativos'}</small></span>
          <b class="pt-pct num">${pc(x.valor)}</b>
          <span class="pt-valor num">${R(x.valor)}${r != null ? ` <small class="${r >= 0 ? 'var-alta' : 'var-baixa'}">${pct(r)}</small>` : ''}</span>
        </div>`;
      }).join('')}</div>
      ${!G.banco && bancosUsados().length > 1 ? (() => {
        // quanto está em cada banco (toque para filtrar)
        const xs = bancosUsados().map((b) => ({ b, v: carteira(S.compras.filter((c) => bancoDe(c) === b.id), S.ativos, []).valorAtual })).filter((x) => x.v > 0.005);
        return xs.length > 1 ? `<div class="pt-bancos">${xs.sort((a, b) => b.v - a.v).map(({ b, v }) => `<button type="button" class="pt-banco" data-filtra-banco="${esc(b.id)}" title="Ver só ${esc(b.nome)}">${logoBanco(b.id, b.nome)}<span>${esc(b.nome)}</span><b>${pc(v)}</b><small>${R(v)}</small></button>`).join('')}</div>` : '';
      })() : ''}
    </section>`;
}

function renderCarteira() {
  if (!S.compras.length) {
    return `<section class="bloco"><div class="vazio"><h2>Sua carteira aparece aqui</h2><p>Depois de comprar no banco, toque em <b>Comprei — registrar</b> na tela inicial. Aqui você vê cotas, preço médio, quanto investiu e o retorno.</p><a class="btn prim" href="#comprar">Ir para Comprar</a></div></section>`;
  }
  const db = dadosDoBanco(); // com um banco escolhido, os números de cima são só dele
  const c = carteira(db.compras, S.ativos, db.proventos);
  VENDAS = processarOperacoes(S.compras);
  const cls = (v) => (v == null ? '' : v >= 0 ? 'var-alta' : 'var-baixa');
  const porMes = groupBy(dadosDoFiltro().compras.slice().sort((a, b) => b.data.localeCompare(a.data)), (x) => mesDe(x.data));
  return `
    <div class="kpis">
      <div class="kpi"><small>Investido</small><span class="num">${R(c.investido)}</span></div>
      <div class="kpi"><small>Valor hoje</small><span class="num">${R(c.valorAtual)}</span>${(() => {
        const lq = liquidando(db.compras);
        return lq.xs.length ? `<small class="kpi-extra">No banco agora: <b>${R(c.valorAtual - lq.valor)}</b> · ${R(lq.valor)} entra em ${dataBR(lq.ate).slice(0, 5)}</small>` : '';
      })()}</div>
      <div class="kpi"><small>Resultado</small><span class="num ${cls(c.resultado)}">${R(c.resultado)} <small class="${cls(c.resultado)}">${pct(c.investido ? c.resultado / c.investido : null)}</small></span>${c.realizado ? `<small class="kpi-extra">Vendas: <b class="${cls(c.realizado)}">${c.realizado > 0 ? '+' : ''}${R(c.realizado)}</b></small>` : ''}</div>
      <div class="kpi"><small>Proventos recebidos</small><span class="num">${R(c.proventos)}</span></div>
    </div>
    ${(() => {
      const lq = liquidoSeVender(db.compras, S.ativos, hojeISO());
      if (!lq.total.bruto) return '';
      const desc = lq.total.ir + lq.total.iof + lq.total.taxas;
      const partes = [
        lq.porTipo.tesouro.ir ? `IR do Tesouro ${R(lq.porTipo.tesouro.ir + lq.porTipo.tesouro.iof)}` : '',
        lq.porTipo.rf?.ir ? `IR de renda fixa ${R(lq.porTipo.rf.ir + lq.porTipo.rf.iof)}` : '',
        lq.porTipo.acao.ir ? `IR de ações ${R(lq.porTipo.acao.ir)}` : lq.acoesIsentas ? 'ações isentas (até R$ 20 mil no mês)' : '',
        lq.porTipo.fii.ir ? `IR de FIIs ${R(lq.porTipo.fii.ir)}` : lq.porTipo.fii.bruto ? 'FIIs sem lucro, sem IR' : '',
        lq.porTipo.outros.ir ? `IR de ETF/BDR ${R(lq.porTipo.outros.ir)}` : '',
        lq.total.taxas ? `taxas B3 ${R(lq.total.taxas)}` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="liquido-faixa">
        <div><small>Se vendesse tudo hoje, sobraria</small><b class="num">${R(lq.total.liquido)}</b></div>
        <div class="liq-desc"><span class="var-baixa">− ${R(desc)}</span><small>${partes}</small></div>
      </div>`;
    })()}

    ${htmlPorTipo(c)}

    ${htmlGrafico()}


    <section class="bloco">
      <div class="bloco-cab"><h2>Operações${tituloBanco()}${G.ativo ? ` <span class="graf-ativo-nome">· ${esc(G.ativo)}</span>` : ''}</h2>
        <div class="acoes"><button type="button" class="btn peq" data-nova-op="V">Registrar venda</button><button type="button" class="btn peq" data-nova-op="C">Compra antiga</button></div></div>
      ${[...porMes.entries()].map(([mes, xs], i) => `
        <details class="mes-grupo" ${i === 0 ? 'open' : ''}>
          <summary class="mes-cab"><span>${nomeMesAno(mes).replace(/^./, (c) => c.toUpperCase())}</span><span class="num">${R(xs.filter((x) => ladoDe(x) === 'C').reduce((s, x) => s + x.qtd * x.preco + (x.custo || 0), 0))}</span></summary>
          <div class="compras-lista">${xs.map(htmlCardCompra).join('')}</div>
        </details>`).join('')}
    </section>`;
}

const ICONE_EDITAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICONE_LIXO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/** Uma compra como card: toque em qualquer lugar para editar; lixeira pede confirmação. */
let VENDAS = new Map(); // resultado de cada venda, recalculado a cada desenho da lista
const unidade = (tipo, q) => (tipo === 'tesouro' ? (q === 1 ? 'título' : 'títulos') : tipo === 'rf' ? (q === 1 ? 'unidade' : 'unidades') : q === 1 ? 'cota' : 'cotas');

function htmlCardCompra(x) {
  const lado = ladoDe(x);
  if (lado !== 'C') return htmlCardOperacao(x, lado);
  const tes = x.tipo === 'tesouro';
  const total = x.qtd * x.preco + (x.custo || 0);
  const quando = x.importado ? `${nomeMesAno(mesDe(x.data))} · da planilha` : `${dataBR(x.data)} · ${comLogo(bancoDe(x))}`;
  const liq = dataLiquidacao(x);
  const pendente = liq > hojeISO() ? `<span class="cc-tag cc-liq" title="A B3 liquida a compra em dois dias úteis; até lá ela não aparece na custódia do banco">em liquidação · entra ${dataBR(liq).slice(0, 5)}</span>` : '';
  return `<div class="card-compra" role="button" tabindex="0" data-edit-compra="${x.id}" aria-label="Editar compra de ${esc(x.ticker)}, ${dataBR(x.data)}">
    ${htmlLogo({ ticker: x.ticker, tipo: x.tipo })}
    <div class="cc-info">
      <div class="cc-linha"><b class="cc-ticker">${esc(x.ticker)}</b><span class="cc-total num">${R(total)}</span></div>
      <div class="cc-linha cc-sub"><span>${fmtQtd(x.qtd)} ${tes ? (x.qtd === 1 ? 'título' : 'títulos') : (x.qtd === 1 ? 'cota' : 'cotas')} × ${R(x.preco)}</span>${Number(x.custo) > 0 ? `<span class="cc-taxa">taxa ${R(x.custo)}</span>` : ''}</div>
      <div class="cc-linha cc-rodape"><small>${quando}${x.importado ? ' <span class="cc-tag">estimada</span>' : ''} ${pendente}</small>
        <span class="cc-acoes">
          <button type="button" class="ic-btn" data-edit-compra="${x.id}" title="Editar" aria-label="Editar compra de ${esc(x.ticker)}">${ICONE_EDITAR}</button>
          <button type="button" class="ic-btn perigo" data-del-compra="${x.id}" title="Remover" aria-label="Remover compra de ${esc(x.ticker)}">${ICONE_LIXO}</button>
        </span>
      </div>
    </div>
  </div>`;
}

/** Venda ou bonificação: mesmo card, com etiqueta e o que muda. */
function htmlCardOperacao(x, lado) {
  const v = VENDAS.get(x.id);
  const venda = lado === 'V';
  const cor = v ? (v.resultado >= 0 ? 'var-alta' : 'var-baixa') : '';
  const nome = venda ? 'Venda' : lado === 'A' ? 'Ajuste' : 'Bonificação';
  const sinal = Number(x.qtd) < 0 ? '−' : '+';
  return `<div class="card-compra ${venda ? 'op-venda' : 'op-bonus'}" role="button" tabindex="0" data-edit-compra="${x.id}" aria-label="Editar ${nome.toLowerCase()} de ${esc(x.ticker)}, ${dataBR(x.data)}">
    ${htmlLogo({ ticker: x.ticker, tipo: x.tipo })}
    <div class="cc-info">
      <div class="cc-linha"><span class="cc-tit"><b class="cc-ticker">${esc(x.ticker)}</b><span class="cc-op">${nome}</span></span><span class="cc-total num">${venda ? R(v?.recebido ?? x.qtd * x.preco) : `${sinal}${fmtQtd(Math.abs(x.qtd))}`}</span></div>
      <div class="cc-linha cc-sub"><span>${venda ? `−${fmtQtd(x.qtd)} ${unidade(x.tipo, x.qtd)} × ${R(x.preco)}` : lado === 'A' ? `${sinal}${fmtQtd(Math.abs(x.qtd))} ${unidade(x.tipo, Math.abs(x.qtd))}, mesmo valor investido` : `${fmtQtd(x.qtd)} ${unidade(x.tipo, x.qtd)} sem custo`}</span>${venda && v ? `<span class="cc-res ${cor}">${v.resultado >= 0 ? '+' : '−'}${R(Math.abs(v.resultado))}</span>` : ''}</div>
      <div class="cc-linha cc-rodape"><small>${dataBR(x.data)} · ${comLogo(bancoDe(x))}${venda && v ? ` · preço médio ${R(v.precoMedio)}` : ''}${x.obs ? ` · ${esc(x.obs)}` : ''}</small>
        <span class="cc-acoes">
          <button type="button" class="ic-btn" data-edit-compra="${x.id}" title="Editar" aria-label="Editar">${ICONE_EDITAR}</button>
          <button type="button" class="ic-btn perigo" data-del-compra="${x.id}" title="Remover" aria-label="Remover">${ICONE_LIXO}</button>
        </span>
      </div>
    </div>
  </div>`;
}

function groupBy(xs, f) {
  const m = new Map();
  for (const x of xs) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

// remover com confirmação de dois toques
function ligarRemover(attr, colecao) {
  $('#conteudo').addEventListener('click', (e) => {
    const b = e.target.closest(`[${attr}]`);
    if (!b) return;
    if (!b.classList.contains('confirmar')) {
      const original = b.innerHTML;
      b.classList.add('confirmar');
      b.innerHTML = b.classList.contains('ic-btn') ? `${ICONE_LIXO}<span>remover?</span>` : colecao === 'ativos' ? 'tirar?' : 'confirmar?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('confirmar'); b.innerHTML = original; } }, 3000);
      return;
    }
    const id = b.getAttribute(attr);
    S[colecao] = S[colecao].filter((x) => x.id !== id);
    if (colecao === 'compras') N.removerCompra(id);
    if (colecao === 'proventos') N.removerProvento(id);
    persist(...(colecao === 'ativos' ? ['ativos'] : [])); render(); toast('Removido.');
  });
}

// ---------- aba Proventos ----------
let PV_ANO = null; // ano escolhido no resumo ('tudo' = todos)
let PV_MES = null; // mês dentro do ano ('2026-10'), ou null para o ano todo

/** Uma linha de barra empilhada com as fatias de cada tipo. */
const barraTipos = (por, total) => `<div class="pv-barra" role="img" aria-label="Proventos por tipo">${TIPOS_PROV_ORDEM.filter((k) => por[k] > 0).map((k) => `<i class="pv-${k}" style="width:${(por[k] / total) * 100}%"></i>`).join('')}</div>`;

function htmlCardProvento(x) {
  const ativo = S.ativos.find((a) => a.ticker === x.ticker) || { ticker: x.ticker, tipo: S.compras.find((c) => c.ticker === x.ticker)?.tipo || 'acao' };
  const varios = x.ticker === 'Vários';
  return `<div class="card-compra card-prov" role="button" tabindex="0" data-edit-prov="${x.id}" aria-label="Editar provento de ${esc(x.ticker)}, ${dataBR(x.data)}">
    ${varios ? '<span class="logo-ativo varios" aria-hidden="true"><span>∑</span></span>' : htmlLogo(ativo)}
    <div class="cc-info">
      <div class="cc-linha"><b class="cc-ticker">${esc(x.ticker)}</b><span class="cc-total num">${R(x.valor)}</span></div>
      <div class="cc-linha cc-sub"><span class="pv-rotulo"><i class="sw pv-${esc(x.tipo)}"></i>${esc(TIPOS_PROVENTO[x.tipo] || x.tipo)}</span></div>
      <div class="cc-linha cc-rodape"><small>${varios ? `${nomeMesAno(mesDe(x.data))} · da planilha` : dataBR(x.data)}</small>
        <span class="cc-acoes">
          <button type="button" class="ic-btn" data-edit-prov="${x.id}" title="Editar" aria-label="Editar provento de ${esc(x.ticker)}">${ICONE_EDITAR}</button>
          <button type="button" class="ic-btn perigo" data-del-prov="${x.id}" title="Remover" aria-label="Remover provento de ${esc(x.ticker)}">${ICONE_LIXO}</button>
        </span>
      </div>
    </div>
  </div>`;
}


/** Deixa à vista o ano e o mês escolhidos nas faixas que rolam para o lado. */
function centralizarFiltrosPv() {
  document.querySelectorAll('.pv-resumo .seg-rola').forEach((faixa) => {
    const b = faixa.querySelector('[aria-pressed="true"]');
    if (b) faixa.scrollLeft = b.offsetLeft - (faixa.clientWidth - b.offsetWidth) / 2;
  });
}

function htmlResumoProventos() {
  if (!S.proventos.length) return '';
  const anos = [...new Set(S.proventos.map((p) => p.data.slice(0, 4)))].sort().reverse();
  if (PV_ANO !== 'tudo' && !anos.includes(PV_ANO)) PV_ANO = anos[0];
  const meses = PV_ANO === 'tudo' ? [] : [...new Set(S.proventos.filter((p) => p.data.startsWith(PV_ANO)).map((p) => p.data.slice(0, 7)))].sort();
  if (PV_MES && !meses.includes(PV_MES)) PV_MES = null;
  const doAno = S.proventos.filter((p) => (PV_ANO === 'tudo' || p.data.startsWith(PV_ANO)) && (!PV_MES || p.data.startsWith(PV_MES)));
  const periodo = PV_ANO === 'tudo' ? 'desde o início' : PV_MES ? `em ${nomeMesAno(PV_MES)}` : `em ${PV_ANO}`;
  const xs = doAno.filter(ehProvDeFato);
  const extras = doAno.filter((p) => !ehProvDeFato(p));
  const somaDe = (ys) => round2(ys.reduce((s, p) => s + Number(p.valor || 0), 0));
  const total = somaDe(xs);
  const totalExtras = somaDe(extras);
  const por = proventosPorTipo(xs);
  const tipos = TIPOS_PROV_ORDEM.filter((k) => por[k] > 0);
  // por ativo, com a divisão por tipo de cada um
  const porAtivo = new Map();
  for (const p of xs) {
    const a = porAtivo.get(p.ticker) || { total: 0, tipos: {} };
    a.total += Number(p.valor || 0);
    a.tipos[p.tipo] = (a.tipos[p.tipo] || 0) + Number(p.valor || 0);
    porAtivo.set(p.ticker, a);
  }
  const ativos = [...porAtivo.entries()].sort((a, b) => b[1].total - a[1].total);
  const maior = ativos[0]?.[1].total || 1;
  const semTipo = xs.filter((p) => p.ticker === 'Vários');
  const pctDe = (v, base = total) => `${((v / (base || 1)) * 100).toLocaleString('pt-BR', { maximumFractionDigits: v / (base || 1) < 0.1 ? 1 : 0 })}%`;
  // outros créditos por ativo, numa linha curta cada
  const extrasPorAtivo = new Map();
  for (const p of extras) {
    const a = extrasPorAtivo.get(p.ticker) || {};
    a[p.tipo] = (a[p.tipo] || 0) + Number(p.valor || 0);
    extrasPorAtivo.set(p.ticker, a);
  }
  return `
    <section class="bloco pv-resumo">
      <div class="seg seg-rola pv-anos" role="group" aria-label="Ano">${[...anos, 'tudo'].map((a) => `<button type="button" data-pv-ano="${a}" aria-pressed="${PV_ANO === a}">${a === 'tudo' ? 'Tudo' : a}</button>`).join('')}</div>
      ${meses.length > 1 ? `<div class="seg seg-rola pv-meses" role="group" aria-label="Mês">${[null, ...meses].map((m) => `<button type="button" data-pv-mes="${m || ''}" aria-pressed="${PV_MES === m}">${m ? `<span class="cap">${nomeMes(m).slice(0, 3)}</span>` : 'Ano todo'}</button>`).join('')}</div>` : ''}

      <div class="pv-hero">
        <small>${totalExtras > 0 ? 'Total recebido' : 'Proventos'} ${periodo}</small>
        <b class="pv-hero-valor num">${R(round2(total + totalExtras))}</b>
        ${totalExtras > 0 ? `
        <div class="pv-hero-barra" role="img" aria-label="Proventos e outros créditos"><i class="pv-dividendo" style="width:${(total / (total + totalExtras)) * 100}%"></i><i class="pv-outro" style="width:${(totalExtras / (total + totalExtras)) * 100}%"></i></div>
        <div class="pv-hero-soma">
          <div><span><i class="sw pv-dividendo"></i>Proventos</span><b class="num">${R(total)}</b></div>
          <em aria-hidden="true">+</em>
          <div><span><i class="sw pv-outro"></i>Outros créditos</span><b class="num">${R(totalExtras)}</b></div>
        </div>` : `<span class="pv-hero-sub">${xs.length} ${xs.length === 1 ? 'pagamento' : 'pagamentos'}</span>`}
      </div>

      ${total > 0 ? `<div class="pv-secao">
        <div class="pv-secao-cab"><h3>Proventos</h3><span><b class="num">${R(total)}</b> · ${xs.length} ${xs.length === 1 ? 'pagamento' : 'pagamentos'}</span></div>
        ${barraTipos(por, total)}
        <div class="pv-tipos">
          ${tipos.map((k) => `<div class="pv-tipo"><i class="sw pv-${k}"></i><span title="${esc(TIPOS_PROVENTO[k])}">${esc(NOME_CURTO_PROV[k] || TIPOS_PROVENTO[k])}</span><b class="num">${R(por[k])}</b><small>${pctDe(por[k])}</small></div>`).join('')}
        </div>
      </div>` : ''}
      ${semTipo.length ? `<p class="aviso pv-aviso"><b>${R(semTipo.reduce((s, p) => s + Number(p.valor), 0))}</b> vieram da planilha antiga só com o total do mês, sem ativo nem tipo. Com o informe de rendimentos do banco dá para separar.</p>` : ''}

      ${totalExtras > 0 ? `<div class="pv-secao">
        <div class="pv-secao-cab"><h3>Outros créditos</h3><span><b class="num">${R(totalExtras)}</b> · frações, resgates</span></div>
        <div class="pv-extras-lista">${[...extrasPorAtivo.entries()].sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0)).map(([t, a]) => `<div class="pv-extra"><span><b>${esc(t)}</b><small>${TIPOS_PROV_ORDEM.filter((k) => a[k] > 0).map((k) => esc(NOME_CURTO_PROV[k] || TIPOS_PROVENTO[k])).join(' · ')}</small></span><b class="num">${R(Object.values(a).reduce((s, v) => s + v, 0))}</b></div>`).join('')}</div>
      </div>` : ''}

      ${total > 0 ? (() => {
        const classe = classesPorTicker(S.compras);
        const pc = {};
        const pct2 = {};
        for (const p of xs) {
          const c = classe.get(p.ticker) || 'outros';
          pc[c] = (pc[c] || 0) + Number(p.valor || 0);
          pct2[c] = pct2[c] || {};
          pct2[c][p.tipo] = (pct2[c][p.tipo] || 0) + Number(p.valor || 0);
        }
        const cls = ['acao', 'fii', 'tesouro', 'outros'].filter((k) => pc[k] > 0);
        const nome = { acao: 'Ações', fii: 'Fundos imobiliários', tesouro: 'Tesouro', outros: 'Outros' };
        return cls.length ? `<div class="pv-classes">
          <h3>Por classe</h3>
          <div class="pv-classes-grade">${cls.map((k) => `<div class="pv-classe">
            <div class="cc-linha"><span><i class="sw s-${k === 'outros' ? 'outros' : k}"></i>${nome[k]}</span><b class="num">${R(pc[k])}</b></div>
            ${barraTipos(pct2[k], pc[k])}
            <small>${pctDe(pc[k])} do total · ${TIPOS_PROV_ORDEM.filter((t) => pct2[k][t] > 0).map((t) => `${esc(TIPOS_PROVENTO[t].replace(' (FII)', ''))} ${R(pct2[k][t])}`).join(' · ')}</small>
          </div>`).join('')}</div>
        </div>` : '';
      })() : ''}

      ${ativos.length ? `<div class="pv-ativos">
        <h3>Por ativo</h3>
        ${(() => {
          // agrupa por classe: ações, fundos imobiliários…
          const classe = classesPorTicker(S.compras);
          const nomes = { acao: 'Ações', fii: 'Fundos imobiliários', tesouro: 'Tesouro', outros: 'Outros' };
          const grupos = ['acao', 'fii', 'tesouro', 'outros']
            .map((k) => [k, ativos.filter(([t]) => (classe.get(t) || 'outros') === k)])
            .filter(([, xs2]) => xs2.length);
          return grupos.map(([k, xs2]) => {
            const sub = xs2.reduce((s2, [, a]) => s2 + a.total, 0);
            return `<div class="pv-grupo">
              <div class="pv-grupo-cab"><span><i class="sw s-${k}"></i>${nomes[k]}</span><b class="num">${R(sub)}</b><small>${pctDe(sub)}</small></div>
              ${xs2.map(([t, a]) => `<div class="pv-ativo">
                <div class="cc-linha"><b>${esc(t)}</b><span class="num">${R(a.total)}</span></div>
                <div class="pv-mini" style="width:${Math.max(4, (a.total / maior) * 100)}%">${barraTipos(a.tipos, a.total)}</div>
                <small>${TIPOS_PROV_ORDEM.filter((k2) => a.tipos[k2] > 0).map((k2) => `${esc(TIPOS_PROVENTO[k2].replace(' (FII)', ''))} ${R(a.tipos[k2])}`).join(' · ')}</small>
              </div>`).join('')}
            </div>`;
          }).join('');
        })()}
      </div>` : ''}
    </section>`;
}

function renderProventos() {
  const tickers = [...new Set([...S.ativos.map((a) => a.ticker), ...S.compras.map((c) => c.ticker)])];
  const porMes = groupBy([...S.proventos].sort((a, b) => b.data.localeCompare(a.data)), (x) => mesDe(x.data));
  const mesAnt = mesAnterior(mesDe(hojeISO()));
  return `
    <section class="bloco">
      <div class="bloco-cab"><h2>Lançar provento</h2><small>O total de ${nomeMes(mesAnt)} entra sozinho no aporte de ${nomeMes(mesDe(hojeISO()))}</small></div>
      <form id="form-prov" class="campos">
        <label class="campo"><span>Data do pagamento</span><input type="date" id="pv-data" value="${hojeISO()}" required></label>
        <label class="campo"><span>Ativo</span><select id="pv-ticker" required>${tickers.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
        <label class="campo"><span>Tipo</span><select id="pv-tipo">${Object.entries(TIPOS_PROVENTO).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
        <label class="campo"><span>Valor recebido (R$)</span><input id="pv-valor" class="num" inputmode="decimal" placeholder="0,00" required></label>
        <div class="campo-acao"><button class="btn prim" type="submit">Lançar</button></div>
      </form>
    </section>

    ${htmlResumoProventos()}

    ${S.proventos.length ? `<section class="bloco"><h2>Recebidos</h2>
      ${[...porMes.entries()].map(([mes, xs], i) => `
        <details class="mes-grupo" ${i === 0 ? 'open' : ''}>
          <summary class="mes-cab"><span>${nomeMesAno(mes).replace(/^./, (c) => c.toUpperCase())}</span><span class="num">${R(xs.reduce((s, x) => s + Number(x.valor), 0))}</span></summary>
          <div class="compras-lista">${xs.map(htmlCardProvento).join('')}</div>
        </details>`).join('')}</section>` : ''}`;
}

function abrirEditarProvento(id) {
  const p = S.proventos.find((x) => x.id === id);
  if (!p) return;
  const tickers = [...new Set([p.ticker, ...S.ativos.map((a) => a.ticker), ...S.compras.map((c) => c.ticker)])];
  const dlg = $('#dlg-compra');
  dlg.innerHTML = `
    <form method="dialog" id="form-edit-prov" class="form-edit">
      <h2>Editar provento</h2>
      ${p.ticker === 'Vários' ? '<p class="dica">Veio da planilha antiga como total do mês. Escolha o ativo e o tipo, ou lance os pagamentos separados e remova este.</p>' : ''}
      <div class="campos dois">
        <label class="campo"><span>Data do pagamento</span><input type="date" id="ep-data" value="${esc(p.data)}" required></label>
        <label class="campo"><span>Ativo</span><select id="ep-ticker">${tickers.map((t) => `<option ${t === p.ticker ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
        <label class="campo"><span>Tipo</span><select id="ep-tipo">${Object.entries(TIPOS_PROVENTO).map(([k, v]) => `<option value="${k}" ${k === p.tipo ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="campo"><span>Valor recebido (R$)</span><input id="ep-valor" class="num" inputmode="decimal" value="${fmtValor(p.valor)}" required></label>
      </div>
      <p class="dica erro-campo" id="ep-erro" hidden></p>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok">Salvar</button></div>
    </form>`;
  dlg.oninput = null; dlg.onchange = null;
  $('#form-edit-prov').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const v = num($('#ep-valor').value);
    if (!(v > 0) || !$('#ep-data').value) { e.preventDefault(); const er = $('#ep-erro'); er.textContent = !(v > 0) ? 'Informe o valor recebido.' : 'Escolha a data.'; er.hidden = false; }
  });
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const novo = { id: p.id, data: $('#ep-data').value, ticker: $('#ep-ticker').value, tipo: $('#ep-tipo').value, valor: round2(num($('#ep-valor').value)) };
    S.proventos = S.proventos.map((x) => (x.id === p.id ? novo : x));
    N.adicionarProvento(novo); // a nuvem grava por cima do mesmo provento
    persist();
    toast('Provento corrigido.');
    render();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

function ligarProventos() {
  const sel = $('#pv-ticker'), tipo = $('#pv-tipo');
  const sugerir = () => {
    const a = S.ativos.find((x) => x.ticker === sel.value) || { tipo: S.compras.find((c) => c.ticker === sel.value)?.tipo };
    tipo.value = a?.tipo === 'fii' ? 'rendimento' : a?.tipo === 'tesouro' ? 'juros' : 'dividendo';
  };
  sel.addEventListener('change', sugerir); sugerir();
  $('#form-prov').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = num($('#pv-valor').value);
    if (!Number.isFinite(v) || v <= 0) { toast('Informe o valor recebido.'); return; }
    const p = { id: uid(), data: $('#pv-data').value || hojeISO(), ticker: sel.value, tipo: tipo.value, valor: round2(v) };
    S.proventos.push(p);
    N.adicionarProvento(p);
    persist(); render(); toast('Provento lançado.');
  });
  const raiz = $('#conteudo');
  raiz.addEventListener('click', (e) => {
    const ano = e.target.closest('[data-pv-ano]');
    if (ano) { PV_ANO = ano.dataset.pvAno; PV_MES = null; const sec = $('.pv-resumo'); if (sec) sec.outerHTML = htmlResumoProventos(); centralizarFiltrosPv(); return; }
    const mes = e.target.closest('[data-pv-mes]');
    if (mes) { PV_MES = mes.dataset.pvMes || null; const sec = $('.pv-resumo'); if (sec) sec.outerHTML = htmlResumoProventos(); centralizarFiltrosPv(); return; }
    if (e.target.closest('[data-del-prov]')) return;
    const b = e.target.closest('[data-edit-prov]');
    if (b) abrirEditarProvento(b.dataset.editProv);
  });
  raiz.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card-prov')) { e.preventDefault(); abrirEditarProvento(e.target.dataset.editProv); }
  });
  ligarRemover('data-del-prov', 'proventos');
}

// ---------- aba Simular ----------
// "E se eu tivesse aportado R$ X todo primeiro dia útil do mês desde tal mês?" — compara até duas carteiras.
const SIM_KEY = 'meus-investimentos:simulador';
const CORES_SIM = ['a', 'b'];
const simPadrao = () => ({
  inicio: '2024-05',
  aporte: Number(S.ajustes.aporteMensal) || 2000,
  proventos: 'dentro',
  preco: 'fechamento',
  comparar: true,
  carteiras: [
    { nome: 'Carteira A', itens: [{ tipo: 'bolsa', ticker: 'BBAS3', peso: 50 }, { tipo: 'bolsa', ticker: 'PETR4', peso: 50 }] },
    { nome: 'Carteira B', itens: [{ tipo: 'selic', peso: 100 }] },
  ],
});
let SIM = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(SIM_KEY) || 'null');
    if (v?.carteiras?.length !== 2) return simPadrao();
    if (!v.proventos) { v.proventos = v.reinvestir === false ? 'guardar' : 'dentro'; delete v.reinvestir; }
    if (!v.preco) v.preco = 'fechamento';
    return v;
  } catch { return simPadrao(); }
})();
const MODOS_PROV = {
  dentro: ['Fazem parte do aporte', 'o aporte é o total investido no mês; os proventos do mês anterior pagam parte e do bolso sai só a diferença'],
  somar: ['Somam ao aporte', 'sai o aporte inteiro do bolso e os proventos do mês anterior entram por cima'],
  guardar: ['Guardar', 'sai o aporte inteiro do bolso e os proventos ficam com você, fora da carteira'],
};
const salvarSim = () => { try { localStorage.setItem(SIM_KEY, JSON.stringify(SIM)); } catch { /* sem armazenamento */ } };
let SIM_RES = null; // { cfg, res: [resultado A, resultado B?] }
let simulando = false;
let SIM_VISTA = { per: 'ano', cart: 0, filtro: 'tudo' }; // por período: 'dia' | 'mes' | 'ano' | 'tudo', qual carteira e o filtro da lista do dia
const cacheSim = new Map();

async function apiSim(caminho) {
  if (cacheSim.has(caminho)) return cacheSim.get(caminho);
  const p = fetch(`/api/${caminho}`, { headers: { Accept: 'application/json' } }).then(async (r) => {
    const j = await r.json().catch(() => null);
    if (!r.ok || !j) throw new Error(j?.erro || `erro ${r.status}`);
    if (j.erro) throw new Error(j.erro);
    return j;
  });
  cacheSim.set(caminho, p);
  p.catch(() => cacheSim.delete(caminho));
  return p;
}

const pesoSoma = (c) => c.itens.reduce((s, it) => s + (Number(it.peso) || 0), 0);
const fmtPct0 = (v) => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

function htmlItemSim(it, ci, ii) {
  const t = TIPOS_SIM[it.tipo] || TIPOS_SIM.bolsa;
  const meio = it.tipo === 'bolsa'
    ? `<button type="button" class="sim-ativo-btn ${it.ticker ? '' : 'vazio'}" data-escolher aria-label="${it.ticker ? `Trocar ${esc(it.ticker)}` : 'Escolher ativo'}">
        ${it.ticker ? `${htmlLogo({ ticker: it.ticker, tipo: it.classe || 'acao' })}<span class="sa-txt"><b>${esc(it.ticker)}</b><small>${esc(it.nome || nomeDoAtivo(it.ticker) || '')}</small></span>` : `<span class="sa-txt"><b>Escolher ativo</b><small>buscar por nome ou código</small></span>`}
      </button>`
    : t.taxa
      ? `<span class="sim-taxa"><input class="num" data-campo="taxa" inputmode="decimal" value="${esc(String(it.taxa ?? t.taxa.padrao).replace('.', ','))}" aria-label="${esc(t.taxa.rotulo)}"><small>${esc(t.taxa.sufixo)}</small></span>`
      : '<span class="sim-taxa"><small>rende a Selic do dia</small></span>';
  return `<div class="sim-item" data-c="${ci}" data-i="${ii}">
    <span class="sim-tipo"><select data-campo="tipo" aria-label="Tipo">${Object.entries(TIPOS_SIM).map(([k, v]) => `<option value="${k}" ${k === it.tipo ? 'selected' : ''}>${esc(v.nome)}</option>`).join('')}</select></span>
    ${meio}
    <span class="sim-peso"><input class="num" data-campo="peso" inputmode="decimal" value="${esc(String(it.peso ?? '').replace('.', ','))}" aria-label="Percentual do aporte"><small>%</small></span>
    <button type="button" class="icone-btn sim-tirar" data-tirar aria-label="Tirar">${ICONE_LIXO}</button>
  </div>`;
}

function htmlCarteiraSim(c, ci) {
  const soma = pesoSoma(c);
  return `<section class="bloco sim-carteira sim-${CORES_SIM[ci]}" data-carteira="${ci}">
    <div class="bloco-cab"><h2><i class="sw sim-sw-${CORES_SIM[ci]}"></i>${esc(c.nome)}</h2>
      <small class="sim-soma ${Math.abs(soma - 100) < 0.01 ? '' : 'var-baixa'}" data-soma="${ci}">${Math.abs(soma - 100) < 0.01 ? 'soma 100%' : `soma ${fmtPct0(soma)} — o app divide na proporção`}</small></div>
    <div class="sim-itens">${c.itens.map((it, ii) => htmlItemSim(it, ci, ii)).join('')}</div>
    <div><button type="button" class="btn peq" data-add="${ci}">+ Investimento</button></div>
  </section>`;
}

// ---------- escolher o ativo: busca por nome ou código ----------
/** Ativos que você já tem ou acompanha, com o nome que o app conhece. */
function meusAtivosSim() {
  const vistos = new Map();
  for (const a of [...S.ativos, ...S.compras]) {
    if (['tesouro', 'rf'].includes(a.tipo) || vistos.has(a.ticker)) continue;
    const cat = CATALOGO.find((x) => x.ticker === a.ticker);
    vistos.set(a.ticker, { ticker: a.ticker, nome: S.ativos.find((x) => x.ticker === a.ticker)?.nome || cat?.nome || '', classe: a.tipo === 'fii' ? 'fii' : ['etf', 'bdr'].includes(a.tipo) ? a.tipo : cat?.classe || 'acao' });
  }
  return [...vistos.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
}
const nomeDoAtivo = (t) => CATALOGO.find((x) => x.ticker === t)?.nome || S.ativos.find((x) => x.ticker === t)?.nome || '';
const CHIP_CLASSE = { acao: ['acao', 'Ação'], fii: ['fii', 'FII'], etf: ['etf', 'ETF'], bdr: ['bdr', 'BDR'] };

/** Lista de ativos com busca. opts: { manual: () => void } mostra a opção de digitar à mão (Tesouro, CDB…); { naLista: Set } marca o que já está na lista. */
function abrirEscolherAtivo(aoEscolher, opts = {}) {
  const dlg = $('#dlg-ativo');
  const meus = meusAtivosSim();
  dlg.innerHTML = `
    <form method="dialog" class="form-edit pk-form">
      <div class="pk-cab"><h2>Escolher ativo</h2><button class="icone-btn" value="cancelar" aria-label="Fechar">✕</button></div>
      <input type="search" id="pk-q" placeholder="Nome ou código — ex.: banco do brasil, PETR4, kinea" autocomplete="off" spellcheck="false" enterkeyhint="search">
      <div class="pk-lista" id="pk-lista" role="listbox" aria-label="Ativos"></div>
      ${opts.manual ? '<button type="button" class="btn peq pk-manual" id="pk-manual">Tesouro, CDB ou outro? Digitar à mão</button>' : ''}
    </form>`;
  $('#pk-manual', dlg)?.addEventListener('click', () => { dlg.close('cancelar'); opts.manual(); });
  const lista = $('#pk-lista', dlg);
  const item = (a) => {
    const [cl, nome] = CHIP_CLASSE[a.classe] || CHIP_CLASSE.acao;
    return `<button type="button" class="pk-item" role="option" data-pick="${esc(a.ticker)}" data-nome="${esc(a.nome || '')}" data-classe="${esc(a.classe || 'acao')}">
      ${htmlLogo({ ticker: a.ticker, tipo: a.classe || 'acao' })}<span class="pk-txt"><b>${esc(a.ticker)}</b><small>${esc(a.nome || '')}</small></span>${opts.naLista?.has(a.ticker) ? '<span class="pk-ja">na lista</span>' : ''}<span class="chip ${cl}">${nome}</span></button>`;
  };
  const grupo = (titulo, xs) => (xs.length ? `<div class="pk-grupo"><small class="pk-tit">${esc(titulo)}</small>${xs.map(item).join('')}</div>` : '');
  let remotos = [];
  let buscaT, ultimaQ = '';
  const pintar = () => {
    const q = $('#pk-q', dlg).value.trim();
    if (!q) {
      lista.innerHTML = grupo('Da sua carteira', meus) + Object.entries(NOME_CLASSE_CAT).map(([k, n]) => grupo(`${n} conhecidos`, CATALOGO.filter((a) => a.classe === k && !meus.some((m) => m.ticker === a.ticker)))).join('');
      return;
    }
    const locais = buscarNoCatalogo([...meus, ...CATALOGO.filter((a) => !meus.some((m) => m.ticker === a.ticker))], q);
    const extra = remotos.filter((r) => !locais.some((l) => l.ticker === r.ticker));
    const cod = q.toUpperCase().replace(/\s/g, '');
    const usarCodigo = /^[A-Z]{4}\d{1,2}[A-Z]?$/.test(cod) && ![...locais, ...extra].some((a) => a.ticker === cod)
      ? `<button type="button" class="pk-item pk-codigo" data-pick="${esc(cod)}" data-nome="" data-classe="${/11$/.test(cod) ? 'fii' : 'acao'}"><span class="pk-txt"><b>Usar ${esc(cod)}</b><small>o código que você digitou</small></span></button>` : '';
    lista.innerHTML = (locais.length || extra.length || usarCodigo)
      ? grupo('Encontrados', locais) + grupo('Mais resultados na B3', extra) + usarCodigo + (N.nuvem.servidor && q.length >= 2 && ultimaQ !== q ? '<p class="dica pk-buscando">Procurando mais na B3…</p>' : '')
      : (N.nuvem.servidor && ultimaQ !== q ? '<p class="dica pk-buscando">Procurando na B3…</p>' : '<p class="dica">Nada encontrado. Tente outro nome ou o código (ex.: TAEE11).</p>');
  };
  const buscar = () => {
    const q = $('#pk-q', dlg).value.trim();
    clearTimeout(buscaT);
    remotos = [];
    pintar();
    if (!N.nuvem.servidor || q.length < 2) { ultimaQ = q; return; }
    buscaT = setTimeout(async () => {
      try {
        const r = await apiSim(`sim/busca?q=${encodeURIComponent(q)}`);
        if ($('#pk-q', dlg)?.value.trim() !== q) return;
        remotos = (r.resultados || []).map((x) => ({ ...x, nome: x.nome || nomeDoAtivo(x.ticker) }));
      } catch { remotos = []; }
      ultimaQ = q;
      pintar();
    }, 300);
  };
  $('#pk-q', dlg).addEventListener('input', buscar);
  lista.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    aoEscolher({ ticker: b.dataset.pick, nome: b.dataset.nome || nomeDoAtivo(b.dataset.pick), classe: b.dataset.classe });
    dlg.close('ok');
  });
  pintar();
  dlg.showModal();
  if (!matchMedia('(max-width: 600px)').matches) $('#pk-q', dlg).focus();
}

// ---------- resultado ----------
const ROTULO_PRECO = { fechamento: 'fechamento', abertura: 'abertura', medio: 'preço médio do dia' };
const NOMES_PROV_RES = { dividendo: 'Dividendos', jcp: 'JCP (juros sobre capital próprio)', rendimento: 'Rendimentos de FII', outro: 'Outros proventos', provento: 'Proventos sem tipo informado' };
const ORDEM_PROV_SIM = ['dividendo', 'jcp', 'rendimento', 'outro', 'provento'];
const swProv = (t) => `<i class="sw pv-${t === 'provento' ? 'outro' : esc(t)}"></i>`;

function htmlResultadoSim() {
  if (!SIM_RES) return '';
  const { res, cfg } = SIM_RES;
  const cls = (v) => (v >= 0 ? 'var-alta' : 'var-baixa');
  const r0 = res[0];
  const melhor = res.length === 2 ? (res[0].ganho >= res[1].ganho ? 0 : 1) : null;
  const temRF = res.some((r) => r.linhas.some((l) => l.tipo !== 'bolsa'));
  const temBolsa = res.some((r) => r.linhas.some((l) => l.tipo === 'bolsa'));
  const temIR = res.some((r) => r.ir > 0.005);
  const dentro = r0.modo === 'dentro';
  const sinal = (v) => `${v >= 0 ? '+' : '−'} ${R(Math.abs(v))}`;
  const linha = (rot, f, cl = '') => `<div class="${cl}"><span>${rot}</span>${res.map(f).join('')}</div>`;
  const tiposProv = ORDEM_PROV_SIM.filter((t) => res.some((r) => (r.provTipos[t] || 0) > 0.005));
  const veredito = () => {
    if (melhor == null) return '';
    const a = res[melhor], b = res[1 - melhor];
    const difBolso = b.bolso - a.bolso;
    return `<p class="sim-veredito"><b>${esc(cfg.carteiras[melhor].nome)}</b> teria ganho ${R(a.ganho - b.ganho)} a mais${Math.abs(difBolso) > 1 ? `, ${difBolso > 0 ? `saindo ${R(difBolso)} a menos` : `mesmo saindo ${R(-difBolso)} a mais`} do seu bolso` : ''}.</p>`;
  };
  return `
    <section class="bloco sim-res">
      <div class="bloco-cab"><h2>Resultado</h2><small>${r0.nAportes} aportes de ${R(cfg.aporte)} · ${dataBR(r0.inicio)} a ${dataBR(r0.fim)} · compra pelo ${ROTULO_PRECO[r0.modoPreco]}</small></div>
      ${veredito()}
      <div class="sim-comp" style="--cols:${res.length}">
        <div class="sim-comp-cab"><span></span>${res.map((r, i) => `<b><i class="sw sim-sw-${CORES_SIM[i]}"></i>${esc(cfg.carteiras[i].nome)}</b>`).join('')}</div>
        ${linha(`Saiu do seu bolso <small>${dentro ? `${R(cfg.aporte)} por mês menos os proventos recebidos no mês` : `${R(cfg.aporte)} por mês`}</small>`, (r) => `<span class="num forte">${R(r.bolso)}<small>média de ${R(r.bolso / r.nAportes)} por mês</small></span>`)}
        ${r0.modo !== 'guardar' ? linha('Proventos reinvestidos <small>entraram nas compras do mês seguinte</small>', (r) => `<span class="num">${r.reinvestido > 0.005 ? `+ ${R(r.reinvestido)}` : '—'}</span>`, 'sim-parte') : ''}
        ${r0.modo !== 'guardar' ? linha('Total investido <small>bolso + proventos reinvestidos</small>', (r) => `<span class="num">${R(r.investido)}</span>`) : ''}
        ${linha('Valor hoje', (r) => `<span class="num forte">${R(r.total)}${r.provFora > 0.005 ? `<small>com ${R(r.provFora)} de proventos guardados</small>` : ''}${r.provPend > 0.005 ? `<small>com ${R(r.provPend)} de proventos para o próximo aporte</small>` : ''}${r.caixa > 0.5 ? `<small>com ${R(r.caixa)} de sobra em caixa</small>` : ''}</span>`)}
        ${temBolsa ? linha('Valorização das cotas <small>preço de hoje − preço pago, já com as taxas</small>', (r) => (r.linhas.some((l) => l.tipo === 'bolsa') ? `<span class="num ${cls(r.valorizacaoBolsa)}">${sinal(r.valorizacaoBolsa)} <small>${pct(r.bolso ? r.valorizacaoBolsa / r.bolso : null)}</small></span>` : '<span class="num">—</span>'), 'sim-parte') : ''}
        ${temRF ? linha('Rendimento da renda fixa <small>juros do Tesouro, CDB ou LCI</small>', (r) => (r.linhas.some((l) => l.tipo !== 'bolsa') ? `<span class="num ${cls(r.rendimentoRF)}">${sinal(r.rendimentoRF)} <small>${pct(r.bolso ? r.rendimentoRF / r.bolso : null)}</small></span>` : '<span class="num">—</span>'), 'sim-parte') : ''}
        ${linha('Proventos recebidos <small>já líquidos, caídos na conta</small>', (r) => `<span class="num ${r.proventos ? 'var-alta' : ''}">${r.proventos ? `+ ${R(r.proventos)} <small>${pct(r.bolso ? r.proventos / r.bolso : null)}</small>` : '—'}</span>`, 'sim-parte')}
        ${tiposProv.map((t) => linha(`${swProv(t)}${esc(NOMES_PROV_RES[t])}${t === 'jcp' ? ' <small>líquido, sem os 15% de IR retidos</small>' : t === 'rendimento' ? ' <small>isentos de IR</small>' : t === 'dividendo' ? ' <small>isentos de IR</small>' : ''}`, (r) => `<span class="num">${r.provTipos[t] ? R(r.provTipos[t]) : '—'}${t === 'jcp' && r.irJcp > 0.005 ? `<small>IR retido ${R(r.irJcp)}</small>` : ''}</span>`, 'sim-sub-tipo')).join('')}
        ${linha('Ganho total <small>valor hoje − o que saiu do bolso</small>', (r) => `<span class="num ${cls(r.ganho)}">${sinal(r.ganho)} <small>${pct(r.ganhoPct)}</small></span>`, 'sim-total')}
        ${res.some((r) => r.aReceberTotal > 0.005) ? linha('A receber <small>data-com já passou, pagamento depois de hoje (fora do ganho)</small>', (r) => `<span class="num">${r.aReceberTotal > 0.005 ? R(r.aReceberTotal) : '—'}</span>`) : ''}
        ${temIR ? linha('Se resgatasse hoje <small>− IR da renda fixa</small>', (r) => `<span class="num">${R(r.liquido)}</span>`) : ''}
      </div>
    </section>

    <section class="bloco">
      <div class="bloco-cab"><h2>Evolução</h2>
        <div class="sim-legenda">${res.map((r, i) => `<span><i class="sw sim-sw-${CORES_SIM[i]}"></i>${esc(cfg.carteiras[i].nome)}</span>`).join('')}<span><i class="sw sim-sw-inv"></i>Saiu do bolso</span></div></div>
      <div class="sim-graf" id="sim-graf"></div>
    </section>

    ${htmlPeriodosSim()}

    ${res.map((r, i) => `<section class="bloco">
      <div class="bloco-cab"><h2 class="sim-h"><i class="sw sim-sw-${CORES_SIM[i]}"></i>${esc(cfg.carteiras[i].nome)} · por investimento</h2></div>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Investimento</th><th class="r">Aplicado</th><th class="r">Cotas</th><th class="r">Valor hoje</th><th class="r">Valorização</th><th class="r">Proventos</th><th class="r">Resultado</th></tr></thead>
        <tbody>${r.linhas.map((l) => `<tr><td><b>${esc(l.rotulo)}</b> <small class="dica">${fmtPct0(l.peso * 100)}</small></td><td class="r num">${R(l.aplicado)}</td><td class="r num">${l.qtd != null ? fmtQtd(l.qtd) : '—'}</td><td class="r num">${R(l.valor)}</td><td class="r num ${cls(l.valorizacao)}">${sinal(l.valorizacao)}</td><td class="r num">${l.proventos ? R(l.proventos) : '—'}${l.proventos ? `<small class="sim-sub">${ORDEM_PROV_SIM.filter((t) => l.porTipo[t]).map((t) => `${t === 'provento' ? 'sem tipo' : TIPOS_PROV_SIM[t]} ${R(l.porTipo[t])}`).join(' · ')}</small>` : ''}</td><td class="r num ${cls(l.resultado)}">${R(l.resultado)} <small>${pct(l.aplicado ? l.resultado / l.aplicado : null)}</small></td></tr>`).join('')}</tbody>
      </table></div>
    </section>`).join('')}

    ${htmlGlossarioSim()}`;
}

function htmlGlossarioSim() {
  const it = (t, d) => `<div><dt>${t}</dt><dd>${d}</dd></div>`;
  return `<details class="bloco sim-glossario">
    <summary><h2>Entenda cada número</h2></summary>
    <dl>
      ${it('Saiu do seu bolso', 'Dinheiro novo que você colocou. No modo "fazem parte do aporte", é o aporte do mês menos os proventos que caíram desde o aporte anterior.')}
      ${it('Proventos reinvestidos', 'Proventos que pagaram parte das compras do mês seguinte, em vez de sair do seu bolso.')}
      ${it('Total investido', 'Tudo o que foi usado nas compras: o que saiu do bolso mais os proventos reinvestidos.')}
      ${it('Valor hoje', 'Cotas × preço de hoje, mais o valor atualizado da renda fixa, mais o dinheiro parado (sobra das cotas inteiras e proventos esperando o próximo aporte).')}
      ${it('Valorização das cotas', 'Quanto as cotas valem hoje a mais (ou a menos) do que você pagou por elas, já com as taxas da B3. É ganho "no papel": só vira dinheiro se vender.')}
      ${it('Rendimento da renda fixa', 'Juros acumulados no Tesouro, CDB ou LCI/LCA, dia a dia, pela taxa escolhida.')}
      ${it(`${swProv('dividendo')}Dividendo`, 'Parte do lucro da empresa paga a quem tem a ação. Isento de IR para pessoa física.')}
      ${it(`${swProv('jcp')}JCP — juros sobre capital próprio`, 'Outra forma de a empresa distribuir lucro. Tem 15% de IR retido na fonte: o app mostra o valor líquido, o que cai na conta.')}
      ${it(`${swProv('rendimento')}Rendimento de FII`, 'Distribuição mensal dos fundos imobiliários (aluguéis, juros de CRI). Isento de IR para pessoa física.')}
      ${it('Data-com, data ex e pagamento', 'Tem direito ao provento quem tem a cota no fim da data-com; no dia seguinte (data ex) a cota já é negociada sem ele. O dinheiro cai depois, na data de pagamento — às vezes semanas ou meses depois. O app conta o direito na data-com e o dinheiro no pagamento.')}
      ${it('A receber', 'Proventos cuja data-com já passou mas que ainda não foram pagos. Não entram no ganho até caírem na conta.')}
      ${it('Ganho total', 'Valor hoje − o que saiu do seu bolso. É a soma da valorização das cotas, do rendimento da renda fixa e dos proventos recebidos.')}
      ${it('Preço de compra', 'A bolsa guarda, para cada dia, abertura (10h), mínima, máxima e fechamento (cerca de 18h). O app compra pelo que você escolher; o preço de cada hora do dia não fica guardado nas fontes grátis. Cada compra mostra a faixa do dia para você comparar.')}
      ${it('Cotas inteiras e sobra', 'Na bolsa só se compra cota inteira. O que não dá para uma cota fica em caixa e entra no aporte do mês seguinte.')}
      ${it('Taxas', 'Ações, FIIs e ETFs pagam 0,03% de taxas da B3 em cada compra (corretagem zero). Tesouro e CDB não têm taxa na compra; a custódia do Tesouro não está na conta.')}
      ${it('IR da renda fixa', 'Tesouro e CDB pagam IR só no resgate, de 22,5% (até 6 meses) a 15% (mais de 2 anos) sobre o rendimento. LCI/LCA é isenta. Ações vendidas até R$ 20 mil por mês são isentas; FIIs pagam 20% sobre o lucro na venda.')}
    </dl>
    <p class="dica">Fontes: preços e proventos do Yahoo Finance; tipo e data de pagamento dos proventos do Status Invest (ou da brapi); Selic, CDI e IPCA do Banco Central. É uma estimativa, não recomendação de investimento.</p>
  </details>`;
}

// ---------- por período: dia (cada operação), mês, ano, tudo ----------
const FILTROS_DIA = [['tudo', 'Tudo'], ['compra', 'Compras'], ['provento', 'Proventos']];

function htmlCardSim(o, modoPreco) {
  if (o.tipo === 'aporte') {
    const partes = [`${R(o.bolso)} do bolso`, o.reinvestido > 0.005 ? `${R(o.reinvestido)} de proventos` : '', o.sobra > 0.005 ? `${R(o.sobra)} de sobra do mês anterior` : ''].filter(Boolean);
    return `<div class="card-compra sim-card-aporte">
      <span class="logo-ativo sim-logo-aporte" aria-hidden="true"><span>+</span></span>
      <div class="cc-info">
        <div class="cc-linha"><b class="cc-ticker">Aporte do mês</b><span class="cc-total num">${R(o.total)}</span></div>
        <div class="cc-linha cc-sub"><span>${partes.join(' + ')}</span></div>
        <div class="cc-linha cc-rodape"><small>${dataBR(o.data)} · 1º dia útil do mês</small></div>
      </div></div>`;
  }
  if (o.tipo === 'compra') {
    return `<div class="card-compra">
      ${htmlLogo({ ticker: o.ticker, tipo: o.fii ? 'fii' : 'acao' })}
      <div class="cc-info">
        <div class="cc-linha"><b class="cc-ticker">${esc(o.ticker)} <span class="cc-op">compra</span></b><span class="cc-total num">${R(o.total)}</span></div>
        <div class="cc-linha cc-sub"><span>${fmtQtd(o.qtd)} ${o.qtd === 1 ? 'cota' : 'cotas'} × ${R(o.preco)}</span><span class="cc-taxa">taxa B3 ${R(o.custo)}</span></div>
        <div class="cc-linha cc-rodape"><small>${dataBR(o.data)} · ${ROTULO_PRECO[modoPreco]} · dia entre ${R(o.minima)} e ${R(o.maxima)}${o.diaPregao !== o.data ? ` · pregão de ${dataBR(o.diaPregao)}` : ''}</small></div>
      </div></div>`;
  }
  if (o.tipo === 'aplicacao') {
    return `<div class="card-compra">
      <span class="logo-ativo tesouro" aria-hidden="true"><span>${o.rf === 'cdb' || o.rf === 'lci' ? 'RF' : 'TD'}</span></span>
      <div class="cc-info">
        <div class="cc-linha"><b class="cc-ticker">${esc(o.rotulo)} <span class="cc-op">aplicação</span></b><span class="cc-total num">${R(o.valor)}</span></div>
        <div class="cc-linha cc-rodape"><small>${dataBR(o.data)} · sem taxa na compra</small></div>
      </div></div>`;
  }
  // provento
  const nomeTipo = o.ptipo === 'provento' ? 'Provento (tipo não informado)' : TIPOS_PROV_SIM[o.ptipo] || o.ptipo;
  return `<div class="card-compra card-prov">
    ${htmlLogo({ ticker: o.ticker, tipo: o.ptipo === 'rendimento' ? 'fii' : 'acao' })}
    <div class="cc-info">
      <div class="cc-linha"><b class="cc-ticker">${esc(o.ticker)}</b><span class="cc-total num var-alta">+ ${R(o.valor)}</span></div>
      <div class="cc-linha cc-sub"><span class="pv-rotulo">${swProv(o.ptipo)}${esc(nomeTipo)}</span></div>
      <div class="cc-linha cc-sub sim-prov-conta"><span>${fmtQtd(o.cotas)} ${o.cotas === 1 ? 'cota' : 'cotas'} × ${fmtValor(o.porCota)} por cota${o.ir > 0.005 ? ` = ${R(o.bruto)} − IR 15% ${R(o.ir)}` : ''}</span></div>
      <div class="cc-linha cc-rodape"><small>pago em ${dataBR(o.data)} · ${o.com ? `data-com ${dataBR(o.com)}` : `data ex ${dataBR(o.ex)}`}</small></div>
    </div></div>`;
}

function htmlDiaSim(r) {
  const f = SIM_VISTA.filtro || 'tudo';
  const ops = r.ops.map((o, i) => ({ ...o, i }))
    .filter((o) => f === 'tudo' || (f === 'compra' ? ['compra', 'aplicacao', 'aporte'].includes(o.tipo) : o.tipo === 'provento'))
    .sort((a, b) => b.data.localeCompare(a.data) || a.i - b.i);
  const porMes = groupBy(ops, (o) => mesDe(o.data));
  const pm = new Map(r.porMes.map((m) => [m.mes, m]));
  return `
    <div class="sim-filtro-dia"><div class="seg" role="group" aria-label="Mostrar">${FILTROS_DIA.map(([k, n]) => `<button type="button" data-sim-filtro="${k}" aria-pressed="${f === k}">${n}</button>`).join('')}</div></div>
    ${r.aReceber.length && f !== 'compra' ? `<details class="mes-grupo" open><summary class="mes-cab"><span>A receber</span><span class="num">${R(r.aReceberTotal)}</span></summary><div class="compras-lista">${r.aReceber.map((x) => htmlCardSim({ tipo: 'provento', data: x.pagamento, ticker: x.ticker, ptipo: x.tipo, ex: x.ex, com: x.com, cotas: x.cotas, porCota: x.porCota, bruto: x.bruto, ir: x.ir, valor: x.valor }, r.modoPreco).replace('pago em', 'paga em')).join('')}</div></details>` : ''}
    ${[...porMes.entries()].map(([mes, xs], i) => {
      const m = pm.get(mes);
      return `<details class="mes-grupo" ${i === 0 ? 'open' : ''}>
        <summary class="mes-cab"><span>${nomeMesAno(mes).replace(/^./, (c) => c.toUpperCase())}</span><span class="sim-mes-res">${m ? `<small>do bolso ${R(m.bolso)}${m.proventos > 0.005 ? ` · proventos <b class="var-alta">+${R(m.proventos)}</b>` : ''}</small>` : ''}</span></summary>
        <div class="compras-lista">${xs.map((o) => htmlCardSim(o, r.modoPreco)).join('')}</div>
      </details>`;
    }).join('') || '<p class="dica">Nada neste filtro.</p>'}`;
}

function htmlPeriodosSim() {
  const { res, cfg } = SIM_RES;
  const ci = Math.min(SIM_VISTA.cart, res.length - 1);
  const r = res[ci];
  const per = SIM_VISTA.per;
  const cls = (v) => (v >= 0 ? 'var-alta' : 'var-baixa');
  const sinal = (v) => `${v >= 0 ? '+' : '−'} ${R(Math.abs(v))}`;
  const temRF = r.linhas.some((l) => l.tipo !== 'bolsa');
  const temBolsa = r.linhas.some((l) => l.tipo === 'bolsa');
  const controles = `<div class="graf-controles">
    ${res.length > 1 ? `<div class="seg" role="group" aria-label="Carteira">${res.map((x, i) => `<button type="button" data-sim-cart="${i}" aria-pressed="${i === ci}"><i class="sw sim-sw-${CORES_SIM[i]}"></i> ${esc(cfg.carteiras[i].nome)}</button>`).join('')}</div>` : ''}
    <div class="seg" role="group" aria-label="Período">${[['dia', 'Dia'], ['mes', 'Mês'], ['ano', 'Ano'], ['tudo', 'Tudo']].map(([k, n]) => `<button type="button" data-sim-per="${k}" aria-pressed="${per === k}">${n}</button>`).join('')}</div>
  </div>`;
  if (per === 'dia') {
    return `<section class="bloco sim-periodos">
      <div class="bloco-cab"><h2 class="sim-h">Operações dia a dia</h2>${controles}</div>
      ${htmlDiaSim(r)}
    </section>`;
  }
  const linhas = resumoPorPeriodoSim(r.porMes, per).reverse(); // mais recente primeiro
  const rotulo = (g) => (per === 'ano' ? g.chave : per === 'tudo' ? `${mesCurto(g.de)} a ${mesCurto(g.ate)}` : mesCurto(g.chave).replace(/^./, (c) => c.toUpperCase()));
  const tot = resumoPorPeriodoSim(r.porMes, 'tudo')[0];
  const subProv = (g) => ORDEM_PROV_SIM.filter((t) => (g.provTipos[t] || 0) > 0.005).map((t) => `${t === 'provento' ? 'sem tipo' : TIPOS_PROV_SIM[t]} ${R(g.provTipos[t])}`).join(' · ');
  const cel = (g) => `
    <td class="r num">${R(g.bolso)}${g.reinvestido > 0.005 ? `<small class="sim-sub">+ ${R(g.reinvestido)} de proventos</small>` : ''}</td>
    <td class="r num ${g.proventos > 0.005 ? 'var-alta' : ''}">${g.proventos > 0.005 ? `+ ${R(g.proventos)}<small class="sim-sub">${subProv(g)}</small>` : '—'}</td>
    <td class="r num ${cls(g.valorizacao)}">${sinal(g.valorizacao)}${temRF && temBolsa ? `<small class="sim-sub">cotas ${sinal(g.valorizacaoBolsa)} · renda fixa ${sinal(g.rendimentoRF)}</small>` : ''}</td>
    <td class="r num ${cls(g.ganho)}"><b>${sinal(g.ganho)}</b>${g.ganhoPct != null ? `<small class="sim-sub">${pct(g.ganhoPct)}</small>` : ''}</td>
    <td class="r num">${R(g.valorFim)}</td>`;
  return `<section class="bloco sim-periodos">
    <div class="bloco-cab"><h2 class="sim-h">Por período</h2>${controles}</div>
    <div class="tabela-wrap"><table class="sim-tab">
      <thead><tr><th>${per === 'mes' ? 'Mês' : per === 'ano' ? 'Ano' : 'Período'}</th><th class="r">Do bolso</th><th class="r">Proventos</th><th class="r">${temRF && !temBolsa ? 'Rendimento' : 'Valorização'}</th><th class="r">Ganho</th><th class="r">Valor no fim</th></tr></thead>
      <tbody>${linhas.map((g) => `<tr><td><b>${esc(rotulo(g))}</b></td>${cel(g)}</tr>`).join('')}</tbody>
      ${per !== 'tudo' && linhas.length > 1 ? `<tfoot><tr><td>Total</td>${cel(tot)}</tr></tfoot>` : ''}
    </table></div>
    <p class="dica">Ganho do período = valor no fim − valor no início − o que saiu do bolso no período = valorização + proventos recebidos. Proventos contam no mês em que foram pagos. O % é sobre o que já havia mais o que entrou do bolso no período.</p>
  </section>`;
}

function renderSimular() {
  return `
    <section class="bloco">
      <div class="bloco-cab"><h2>Simular aportes</h2><small>e se eu tivesse investido todo mês desde…</small></div>
      <div class="campos">
        <label class="campo"><span>Desde</span><input type="month" id="sim-inicio" value="${esc(SIM.inicio)}" min="2015-01" max="${mesDe(hojeISO())}"><span class="sub">aporte no 1º dia útil de cada mês, até hoje</span></label>
        <label class="campo"><span>Aporte mensal</span><input id="sim-aporte" class="num" inputmode="decimal" value="${Number(SIM.aporte).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"><span class="sub"></span></label>
      </div>
      <div class="campos">
        <div class="campo campo-seg"><span>Proventos</span>
          <div class="seg sim-seg" role="group" aria-label="Proventos">${Object.entries(MODOS_PROV).map(([k, [n]]) => `<button type="button" data-modo-prov="${k}" aria-pressed="${SIM.proventos === k}">${n}</button>`).join('')}</div>
          <span class="sub">${MODOS_PROV[SIM.proventos][1]}</span></div>
        <div class="campo campo-seg"><span>Preço de compra</span>
          <div class="seg sim-seg" role="group" aria-label="Preço de compra">${Object.entries(PRECOS_COMPRA).map(([k, [n]]) => `<button type="button" data-preco="${k}" aria-pressed="${SIM.preco === k}">${n}</button>`).join('')}</div>
          <span class="sub">${PRECOS_COMPRA[SIM.preco][1]}</span></div>
      </div>
    </section>
    <div class="sim-carteiras">
      ${htmlCarteiraSim(SIM.carteiras[0], 0)}
      ${SIM.comparar ? htmlCarteiraSim(SIM.carteiras[1], 1) : ''}
    </div>
    <div class="sim-acoes">
      <button type="button" class="btn" id="sim-comparar">${SIM.comparar ? 'Simular só a Carteira A' : 'Comparar com outra carteira'}</button>
      <button type="button" class="btn prim" id="sim-rodar" ${simulando ? 'disabled' : ''}>${simulando ? 'Buscando o histórico…' : 'Simular'}</button>
    </div>
    ${!N.nuvem.servidor && N.nuvem.estado !== 'verificando' ? '<p class="aviso">O simulador busca o histórico pelo Worker da Cloudflare: abra o app pelo endereço publicado.</p>' : ''}
    <div id="sim-saida">${htmlResultadoSim()}</div>`;
}

function htmlGraficoSim(largura) {
  const { res, cfg } = SIM_RES;
  const W = Math.max(300, Math.round(largura)), H = Math.round(Math.min(300, Math.max(210, W * 0.45)));
  const m = { l: 8, r: 8, t: 14, b: 26 };
  const serie = res[0].serie;
  const n = serie.length;
  const maxV = Math.max(...res.flatMap((r) => r.serie.map((p) => Math.max(p.total, p.bolso))));
  const passo = niceStep(maxV / 4);
  const topo = Math.ceil(maxV / passo) * passo || 1;
  const x = (i) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
  const y = (v) => m.t + (1 - v / topo) * (H - m.t - m.b);
  const linha = (pts) => pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const grade = [];
  for (let v = passo; v <= topo + 1e-6; v += passo) grade.push(`<line class="grade" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l + 2}" y="${y(v) - 4}">${compacto(v)}</text>`);
  const anos = [];
  serie.forEach((p, i) => { if (i === 0 || p.data.slice(0, 4) !== serie[i - 1].data.slice(0, 4)) anos.push(`<text class="x" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'middle'}">${i === 0 ? mesCurto(p.data.slice(0, 7)) : p.data.slice(0, 4)}</text>`); });
  return `<svg class="grafico sim-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Evolução do valor de cada carteira e do que saiu do bolso">
    ${grade.join('')}<line class="base" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>${anos.join('')}
    ${res.map((r, i) => `<path class="sim-l-inv sim-li-${CORES_SIM[i]}" d="${linha(r.serie.map((p) => p.bolso))}"/>`).join('')}
    ${res.map((r, i) => `<path class="sim-l sim-l-${CORES_SIM[i]}" d="${linha(r.serie.map((p) => p.total))}"/>`).join('')}
    ${res.map((r, i) => `<circle class="sim-pt sim-pt-${CORES_SIM[i]}" r="4.5" cx="${x(n - 1)}" cy="${y(r.total)}"/>`).join('')}
    <g class="sim-mira" hidden><line class="sim-mira-l" y1="${m.t}" y2="${H - m.b}"/>${res.map((r, i) => `<circle class="sim-pt sim-pt-${CORES_SIM[i]}" r="4.5"/>`).join('')}${res.map((r, i) => `<circle class="sim-pt sim-pt-inv sim-pi-${CORES_SIM[i]}" r="3.5"/>`).join('')}</g>
    <rect class="sim-alvo" x="0" y="0" width="${W}" height="${H}" fill="transparent"/>
  </svg><div class="sim-dica" hidden></div>`;
}

function desenharGraficoSim() {
  const box = $('#sim-graf');
  if (!box || !SIM_RES) return;
  box.innerHTML = htmlGraficoSim(box.clientWidth || 600);
  const svg = $('svg', box), dica = $('.sim-dica', box), mira = $('.sim-mira', box);
  const { res, cfg } = SIM_RES;
  const serie = res[0].serie, n = serie.length;
  const W = svg.viewBox.baseVal.width, H = svg.viewBox.baseVal.height;
  const maxV = Math.max(...res.flatMap((r) => r.serie.map((p) => Math.max(p.total, p.bolso))));
  const passo = niceStep(maxV / 4);
  const topo = Math.ceil(maxV / passo) * passo || 1;
  const x = (i) => 8 + (n <= 1 ? 0 : (i / (n - 1)) * (W - 16));
  const y = (v) => 14 + (1 - v / topo) * (H - 40);
  const mostrar = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - 8) / (W - 16)) * (n - 1))));
    mira.hidden = false;
    const l = $('.sim-mira-l', mira); l.setAttribute('x1', x(i)); l.setAttribute('x2', x(i));
    const pts = mira.querySelectorAll('circle');
    res.forEach((rr, k) => { pts[k].setAttribute('cx', x(i)); pts[k].setAttribute('cy', y(rr.serie[i].total)); });
    res.forEach((rr, k) => { pts[res.length + k].setAttribute('cx', x(i)); pts[res.length + k].setAttribute('cy', y(rr.serie[i].bolso)); });
    dica.hidden = false;
    dica.innerHTML = `<b>${dataBR(serie[i].data)}</b>${res.map((rr, k) => `<span><i class="sw sim-sw-${CORES_SIM[k]}"></i>${esc(cfg.carteiras[k].nome)} <b class="num">${R(rr.serie[i].total)}</b></span><span class="sim-dica-sub">saiu do bolso <b class="num">${R(rr.serie[i].bolso)}</b></span>${rr.serie[i].proventos > 0.005 ? `<span class="sim-dica-sub">proventos até aqui <b class="num">${R(rr.serie[i].proventos)}</b></span>` : ''}`).join('')}`;
    const esq = (x(i) / W) * r.width;
    dica.style.left = `${Math.min(Math.max(0, esq - dica.offsetWidth / 2), r.width - dica.offsetWidth)}px`;
  };
  const esconder = () => { mira.hidden = true; dica.hidden = true; };
  svg.addEventListener('pointermove', mostrar);
  svg.addEventListener('pointerdown', mostrar);
  svg.addEventListener('pointerleave', esconder);
}

async function rodarSimulacao() {
  const cfg = JSON.parse(JSON.stringify(SIM));
  cfg.carteiras = cfg.comparar ? cfg.carteiras : cfg.carteiras.slice(0, 1);
  for (const c of cfg.carteiras) {
    c.itens = c.itens.filter((it) => (Number(it.peso) || 0) > 0);
    for (const it of c.itens) {
      if (it.tipo === 'bolsa') {
        it.ticker = String(it.ticker || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(it.ticker)) { toast(`${c.nome}: escolha o ativo de cada linha.`); return; }
      } else if (TIPOS_SIM[it.tipo].taxa) {
        it.taxa = Number(it.taxa ?? TIPOS_SIM[it.tipo].taxa.padrao);
        if (!Number.isFinite(it.taxa)) { toast(`${c.nome}: confira a taxa.`); return; }
      }
    }
    if (!c.itens.length) { toast(`${c.nome}: coloque um percentual em pelo menos um investimento.`); return; }
  }
  if (!(cfg.aporte > 0)) { toast('Informe o valor do aporte mensal.'); return; }
  if (!/^\d{4}-\d{2}$/.test(cfg.inicio) || cfg.inicio > mesDe(hojeISO())) { toast('Escolha o mês de início.'); return; }

  simulando = true; render();
  try {
    const de = `${cfg.inicio}-01`;
    const todos = cfg.carteiras.flatMap((c) => c.itens);
    const tickers = [...new Set(todos.filter((it) => it.tipo === 'bolsa').map((it) => it.ticker))];
    const series = seriesNecessarias(todos);
    const [precos, indices] = await Promise.all([
      Promise.all(tickers.map((t) => apiSim(`sim/precos?t=${t}&de=${de}`).catch((e) => { throw new Error(`${t}: ${e.message}`); }))),
      Promise.all(series.map((s) => apiSim(`sim/indice?s=${s}&de=${de}`).catch((e) => { throw new Error(`taxa ${s.toUpperCase()}: ${e.message}`); }))),
    ]);
    const dados = { precos: Object.fromEntries(precos.map((p) => [p.ticker, p])), indices: Object.fromEntries(indices.map((x) => [x.serie, x.dados])) };
    SIM_RES = { cfg, res: cfg.carteiras.map((c) => simular({ inicio: cfg.inicio, aporte: cfg.aporte, proventos: cfg.proventos, preco: cfg.preco, itens: c.itens }, dados)) };
  } catch (e) {
    toast(`Não deu para simular: ${e.message}`);
  } finally {
    simulando = false;
    if (location.hash === '#simular') { render(); $('#sim-saida')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }
}

function ligarSimular() {
  const raiz = $('#conteudo');
  const redesenharCarteira = (ci) => {
    const velho = raiz.querySelector(`[data-carteira="${ci}"]`);
    if (!velho) return;
    velho.outerHTML = htmlCarteiraSim(SIM.carteiras[ci], ci);
  };
  const atualizaSoma = (ci) => {
    const el = raiz.querySelector(`[data-soma="${ci}"]`);
    if (!el) return;
    const soma = pesoSoma(SIM.carteiras[ci]);
    const ok = Math.abs(soma - 100) < 0.01;
    el.textContent = ok ? 'soma 100%' : `soma ${fmtPct0(soma)} — o app divide na proporção`;
    el.classList.toggle('var-baixa', !ok);
  };
  raiz.addEventListener('input', (e) => {
    const t = e.target;
    if (t.id === 'sim-aporte') { SIM.aporte = num(t.value) || 0; salvarSim(); return; }
    if (t.id === 'sim-inicio') { if (t.value) { SIM.inicio = t.value; salvarSim(); } return; }
    const row = t.closest('.sim-item');
    if (!row || t.dataset.campo === 'tipo') return;
    const it = SIM.carteiras[row.dataset.c].itens[row.dataset.i];
    if (t.dataset.campo === 'taxa') it.taxa = num(t.value);
    if (t.dataset.campo === 'peso') { it.peso = num(t.value) || 0; atualizaSoma(row.dataset.c); }
    salvarSim();
  });
  raiz.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.campo !== 'tipo') return;
    const row = t.closest('.sim-item');
    const it = SIM.carteiras[row.dataset.c].itens[row.dataset.i];
    it.tipo = t.value;
    if (TIPOS_SIM[it.tipo].taxa) it.taxa = TIPOS_SIM[it.tipo].taxa.padrao; else delete it.taxa;
    if (it.tipo !== 'bolsa') delete it.ticker;
    salvarSim(); redesenharCarteira(row.dataset.c);
  });
  raiz.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-escolher')) {
      const row = t.closest('.sim-item');
      const it = SIM.carteiras[row.dataset.c].itens[row.dataset.i];
      abrirEscolherAtivo((a) => { it.ticker = a.ticker; it.nome = a.nome; it.classe = a.classe; salvarSim(); redesenharCarteira(row.dataset.c); });
      return;
    }
    if (t.dataset.preco) { SIM.preco = t.dataset.preco; salvarSim(); render(); return; }
    if (t.dataset.simPer || t.dataset.simCart || t.dataset.simFiltro) {
      if (t.dataset.simPer) SIM_VISTA.per = t.dataset.simPer;
      if (t.dataset.simCart) SIM_VISTA.cart = Number(t.dataset.simCart);
      if (t.dataset.simFiltro) SIM_VISTA.filtro = t.dataset.simFiltro;
      raiz.querySelector('.sim-periodos').outerHTML = htmlPeriodosSim();
      return;
    }
    if (t.dataset.modoProv) { SIM.proventos = t.dataset.modoProv; salvarSim(); render(); return; }
    if (t.dataset.add != null) {
      const c = SIM.carteiras[t.dataset.add];
      c.itens.push({ tipo: 'bolsa', ticker: '', peso: Math.max(0, 100 - pesoSoma(c)) });
      salvarSim(); redesenharCarteira(t.dataset.add);
      raiz.querySelector(`[data-carteira="${t.dataset.add}"] .sim-item:last-child [data-escolher]`)?.click();
      return;
    }
    if (t.hasAttribute('data-tirar')) {
      const row = t.closest('.sim-item');
      SIM.carteiras[row.dataset.c].itens.splice(Number(row.dataset.i), 1);
      salvarSim(); redesenharCarteira(row.dataset.c);
      return;
    }
    if (t.id === 'sim-comparar') { SIM.comparar = !SIM.comparar; salvarSim(); render(); return; }
    if (t.id === 'sim-rodar') rodarSimulacao();
  });
  desenharGraficoSim();
}
window.addEventListener('resize', () => { if (location.hash === '#simular') { clearTimeout(ligarSimular.t); ligarSimular.t = setTimeout(desenharGraficoSim, 150); } });

// ---------- aba Ajustes ----------
function renderAjustes() {
  const pctTxt = (f) => (Number(f || 0) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  return `
    <section class="bloco conta-bloco">${htmlConta()}</section>

    <section class="bloco">
      <h2>Preferências</h2>
      <div class="campos">
        <div class="campo"><span>Tema</span>
          <div class="seg" role="group" aria-label="Tema">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([k, n]) => `<button type="button" data-tema="${k}" aria-pressed="${tema === k}">${n}</button>`).join('')}</div>
          <span class="sub"></span>
        </div>
        <label class="campo"><span>Banco onde você compra</span>
          <select id="aj-banco">${S.bancos.map((b) => `<option value="${esc(b.id)}" data-icone="${esc(logoBanco(b.id, b.nome))}" ${b.id === banco().id ? 'selected' : ''}>${esc(b.nome)}</option>`).join('')}</select>
          <span class="sub">usado para calcular as taxas</span>
        </label>
        <label class="campo"><span>Aporte mensal padrão</span>
          <input id="aj-aporte" class="num" inputmode="decimal" value="${Number(S.ajustes.aporteMensal).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">já aparece preenchido todo mês</span>
        </label>
      </div>
    </section>

    <section class="bloco">
      <h2>Importar extrato da B3</h2>
      <p class="dica">Uma vez por mês, traga os proventos e as compras do mês. Pode repetir meses sem medo: o que já está no app é pulado.</p>
      <ol class="passos">
        <li>Entre em <b>investidor.b3.com.br</b> pelo navegador, com seu CPF e senha (ou gov.br).</li>
        <li>No menu, abra <b>Extratos</b> e depois a aba <b>Movimentação</b>.</li>
        <li>Em <b>Filtrar</b>, escolha o período. Pode ser só o mês passado.</li>
        <li>Toque no botão de <b>baixar</b> e escolha <b>Excel</b>.</li>
        <li>Volte aqui, toque em <b>Escolher extrato</b> e pegue o arquivo baixado.</li>
        <li>Confira o resumo e toque em <b>Adicionar ao app</b>.</li>
      </ol>
      <div class="acoes">
        <label class="btn prim" for="b3-arquivo">Escolher extrato…</label>
        <input type="file" id="b3-arquivo" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
        <span class="dica" id="b3-status"></span>
      </div>
    </section>

    <section class="bloco">
      <h2>Trazer a planilha antiga</h2>
      <p class="dica">Escolha o arquivo <b>planilha-acoes.json</b> (gerado a partir do seu Excel). O app busca o preço de cada mês, estima quantas cotas você comprou e mostra um resumo antes de salvar. Os valores ficam exatamente os da planilha.</p>
      <div class="acoes">
        <label class="btn" for="pl-arquivo">Escolher arquivo…</label>
        <input type="file" id="pl-arquivo" accept="application/json,.json" hidden>
        <span class="dica" id="pl-status"></span>
      </div>
    </section>

    <section class="bloco">
      <details class="mais">
        <summary>Taxas por banco</summary>
        <p class="dica">Referência de outubro/2026: a maioria não cobra corretagem pelo app; a B3 cobra 0,03% em ações e FIIs. Tesouro não tem taxa na compra (custódia de 0,20% ao ano, Selic isento até R$ 10 mil).</p>
        <div class="tabela-wrap"><table>
          <thead><tr><th>Banco</th><th class="r">Corretagem (R$)</th><th class="r">B3 (%)</th><th class="r">Tesouro (%)</th></tr></thead>
          <tbody>${S.bancos.map((b) => `<tr>
            <td>${comLogo(b.id, b.nome)}</td>
            <td class="r"><input class="num preco-input" data-bk="${b.id}" data-campo="corretagem" inputmode="decimal" value="${Number(b.corretagem).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}" aria-label="Corretagem ${esc(b.nome)}"></td>
            <td class="r"><input class="num preco-input" data-bk="${b.id}" data-campo="taxaB3" inputmode="decimal" value="${pctTxt(b.taxaB3)}" aria-label="Taxa B3 ${esc(b.nome)}"></td>
            <td class="r"><input class="num preco-input" data-bk="${b.id}" data-campo="taxaTesouro" inputmode="decimal" value="${pctTxt(b.taxaTesouro)}" aria-label="Taxa Tesouro ${esc(b.nome)}"></td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="acoes"><button type="button" class="btn peq" id="bk-padrao">Voltar aos valores de referência</button></div>
      </details>
      <details class="mais">
        <summary>Preços</summary>
        <p class="dica">${N.nuvem.servidor
          ? 'Os preços vêm do Yahoo Finance pelo seu servidor na Cloudflare, com cerca de 15 minutos de atraso (o mesmo de todo serviço gratuito da B3).'
          : 'Sem o servidor da Cloudflare, os preços vêm da brapi.dev, que pede um token grátis (brapi.dev/dashboard).'}
          Tesouro Direto não tem preço automático: copie do <a href="https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm" target="_blank" rel="noopener">site do Tesouro</a>.</p>
        ${N.nuvem.servidor ? '' : `<div class="campos"><label class="campo"><span>Token da brapi.dev</span><input id="aj-token" type="password" autocomplete="off" value="${esc(S.ajustes.token)}" placeholder="cole o token aqui"><span class="sub"></span></label></div>`}
      </details>
      <details class="mais">
        <summary>Backup e apagar dados</summary>
        <div class="acoes">
          <button type="button" class="btn peq" id="bk-exportar">Exportar backup</button>
          <label class="btn peq" for="bk-importar">Importar backup</label>
          <input type="file" id="bk-importar" accept="application/json,.json" hidden>
          <span class="esp"></span>
          <button type="button" class="btn peq perigo" id="bk-apagar">Apagar tudo</button>
        </div>
        <p class="dica">Importar um backup substitui tudo${N.ativa() ? ', aqui e na nuvem' : ''}.</p>
      </details>
    </section>`;
}

// ---------- importar a planilha antiga ----------
const PRECO_SEM_HISTORICO = { CIEL3: { low: 3.8, high: 6.0, close: 5.0 } }; // Cielo saiu da bolsa em 2024

async function historicoMensal(ticker) {
  try {
    const r = await fetch(`/api/historico?t=${encodeURIComponent(ticker)}`);
    const j = await r.json();
    return { meses: j.meses || {}, splits: j.splits || [] };
  } catch { return { meses: {}, splits: [] }; }
}

async function lerPlanilha(file, avisar) {
  let dados;
  try { dados = JSON.parse(await file.text()); } catch { throw new Error('Esse arquivo não é o planilha-acoes.json.'); }
  if (dados?.formato !== 'meus-investimentos/planilha') throw new Error('Esse arquivo não é o planilha-acoes.json.');
  const tickers = [...new Set(dados.acoes.map((c) => c.ticker))];
  const hist = {};
  for (const [i, t] of tickers.entries()) {
    avisar(`Buscando preços de ${t} (${i + 1} de ${tickers.length})…`);
    hist[t] = N.nuvem.servidor ? await historicoMensal(t) : { meses: {}, splits: [] };
  }
  const compras = [], semPreco = [];
  for (const c of dados.acoes) {
    const h = hist[c.ticker];
    const est = estimarCompra(c.valor, h.meses[c.mes] || PRECO_SEM_HISTORICO[c.ticker], fatoresDoMes(c.mes, h.splits));
    if (!est) { semPreco.push(c); continue; }
    compras.push({ id: `pl${c.ticker}${c.mes.replace('-', '')}`.toLowerCase(), data: `${c.mes}-15`, ticker: c.ticker, tipo: c.tipo, qtd: est.qtd, preco: est.preco, custo: est.custo, banco: dados.banco || 'nubank', importado: true, exato: est.exato, qtdOriginal: est.qtdOriginal });
  }
  const tes = S.ativos.find((a) => a.tipo === 'tesouro');
  const tesTicker = tes?.ticker || 'Tesouro Selic 2031';
  const tesPreco = tes?.preco || 20010.2;
  for (const t of dados.tesouro || []) {
    const p = precoTesouroEm(t.mes, tesPreco, mesDe(hojeISO()));
    const qtd = Math.round((t.valor / p) * 10000) / 10000;
    const preco = Math.round((t.valor / qtd) * 10000) / 10000;
    compras.push({ id: `pltesouro${t.mes.replace('-', '')}`, data: `${t.mes}-15`, ticker: tesTicker, tipo: 'tesouro', qtd, preco, custo: Math.round((t.valor - qtd * preco) * 1e6) / 1e6, banco: dados.banco || 'nubank', importado: true });
  }
  const proventos = (dados.proventos || []).map((p) => ({ id: `plprov${p.mes.replace('-', '')}`, data: `${p.mes}-15`, ticker: 'Vários', tipo: 'outro', valor: p.valor }));
  const desdobradas = compras.filter((c) => c.qtdOriginal && c.qtdOriginal !== c.qtd).length;
  return { compras, proventos, semPreco, tesTicker, exatas: compras.filter((c) => c.exato).length, acoes: dados.acoes.length, desdobradas };
}

function abrirResumoPlanilha(res) {
  const total = (xs) => xs.reduce((s, c) => s + c.qtd * c.preco + (c.custo || 0), 0);
  const porTicker = groupBy(res.compras, (c) => c.ticker);
  const meses = res.compras.map((c) => mesDe(c.data)).sort();
  const dlg = $('#dlg-registrar');
  dlg.innerHTML = `
    <form method="dialog" id="form-reg">
      <h2>Trazer a planilha</h2>
      <p class="dica">De ${mesCurto(meses[0])} a ${mesCurto(meses[meses.length - 1])}: <b>${res.compras.length} compras</b> somando <b>${R(total(res.compras))}</b> e <b>${res.proventos.length} meses de proventos</b> somando <b>${R(res.proventos.reduce((s, p) => s + p.valor, 0))}</b>.</p>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ativo</th><th class="r">Compras</th><th class="r">Cotas (estimadas)</th><th class="r">Investido</th></tr></thead>
        <tbody>${[...porTicker.entries()].map(([t, xs]) => `<tr><td><b>${esc(t)}</b></td><td class="r num">${xs.length}</td><td class="r num">${fmtQtd(xs.reduce((s, x) => s + x.qtd, 0))}</td><td class="r num">${R(total(xs))}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="dica"><b>${res.exatas} de ${res.acoes}</b> compras de ações e FIIs fecharam ao centavo: quantidade × preço do mês + taxa do Nubank dá exatamente o valor da planilha.${res.exatas < res.acoes ? ' As outras (geralmente meses com mais de uma compra) foram aproximadas pelo preço do mês.' : ''}${res.desdobradas ? ` ${res.desdobradas} compras são de antes de um desdobramento e já aparecem com a quantidade de hoje.` : ''} No Tesouro, a quantidade vem do preço do ${esc(res.tesTicker)} trazido para cada mês pela Selic. Tudo pode ser corrigido no Histórico.${res.semPreco.length ? ` <b>${res.semPreco.length} compras ficaram de fora</b> por falta de preço do mês.` : ''}</p>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok">Salvar no app</button></div>
    </form>`;
  dlg.oninput = null;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const ids = new Set(res.compras.map((c) => c.id));
    const idsP = new Set(res.proventos.map((p) => p.id));
    res.compras.forEach((c) => { delete c.exato; delete c.qtdOriginal; });
    S.compras = [...S.compras.filter((c) => !ids.has(c.id)), ...res.compras];
    S.proventos = [...S.proventos.filter((p) => !idsP.has(p.id)), ...res.proventos];
    for (let i = 0; i < res.compras.length; i += 150) N.adicionarCompras(res.compras.slice(i, i + 150));
    if (res.proventos.length) N.adicionarProvento(res.proventos);
    garantirAtivosDaCarteira();
    persist();
    toast('Planilha salva. Veja tudo no Histórico.');
    location.hash = '#carteira';
    render();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- extrato de Movimentação da B3 ----------
let xlsxPronto = null;
function carregarXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxPronto ||= new Promise((ok, falha) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    sc.onload = () => ok(window.XLSX);
    sc.onerror = () => { xlsxPronto = null; falha(new Error('Não consegui carregar o leitor de planilhas. Verifique a internet.')); };
    document.head.appendChild(sc);
  });
  return xlsxPronto;
}

async function lerExtratoB3(f) {
  const XLSX = await carregarXLSX();
  const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
  const linhas = wb.SheetNames.flatMap((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '', raw: true }));
  const tipos = new Map([...S.compras.map((c) => [c.ticker, c.tipo]), ...S.ativos.map((a) => [a.ticker, a.tipo])]);
  const lido = lerMovimentacao(linhas, { tipos, compras: S.compras });
  if (!lido.proventos.length && !lido.operacoes.length && !Object.keys(lido.ignorados).length) {
    throw new Error('Esse arquivo não parece o extrato de Movimentação da B3.');
  }
  const datas = [...lido.proventos.map((p) => p.data), ...lido.operacoes.map((o) => o.liq)].sort();
  return { ...novidades(lido, S), lido, de: datas[0], ate: datas[datas.length - 1] };
}

function abrirResumoB3(res) {
  const { proventos, operacoes, lido } = res;
  // cada linha vai para o banco da instituição que aparece no extrato (Nubank, Toro, XP…); banco desconhecido é criado
  const novosBancos = new Map();
  const qualBanco = (inst) => {
    const r = bancoDaInstituicao(inst, [...S.bancos, ...novosBancos.values()]);
    if (!r) return banco().id;
    if (r.novo && !novosBancos.has(r.id)) novosBancos.set(r.id, { id: r.id, nome: r.nome, corretagem: 0, taxaB3: TAXA_B3_PADRAO, taxaTesouro: 0 });
    return r.id;
  };
  for (const x of [...operacoes, ...proventos]) x.banco = qualBanco(x.inst);
  const nomeBanco = (id) => (S.bancos.find((b) => b.id === id) || novosBancos.get(id))?.nome || id;
  const variosBancos = new Set([...lido.operacoes, ...lido.proventos].map((x) => qualBanco(x.inst))).size > 1;
  const tagBanco = (id) => (variosBancos ? ` · ${comLogo(id, nomeBanco(id))}` : '');
  const contagem = (xs) => [...xs.reduce((m, x) => m.set(x.banco, (m.get(x.banco) || 0) + 1), new Map())].map(([id, n]) => `${comLogo(id, nomeBanco(id))} ${n}`).join(' · ');
  const jaTinha = lido.proventos.length - proventos.length + lido.operacoes.length - operacoes.length;
  const somaP = round2(proventos.reduce((s, p) => s + p.valor, 0));
  const porTipo = proventosPorTipo(proventos);
  const ignorados = Object.entries(lido.ignorados);
  const dlg = $('#dlg-registrar');
  dlg.innerHTML = `
    <form method="dialog" id="form-reg">
      <h2>Extrato da B3</h2>
      <p class="dica">${res.de ? `De ${dataBR(res.de)} a ${dataBR(res.ate)}.` : ''} ${jaTinha ? `${jaTinha} ${jaTinha === 1 ? 'item já estava' : 'itens já estavam'} no app e ${jaTinha === 1 ? 'foi pulado' : 'foram pulados'}.` : ''}</p>
      ${variosBancos && (proventos.length || operacoes.length) ? `<p class="dica">Cada item vai para o banco que aparece no extrato: ${contagem([...operacoes, ...proventos])}.${novosBancos.size ? ` ${[...novosBancos.values()].map((b) => esc(b.nome)).join(', ')} ${novosBancos.size === 1 ? 'entra' : 'entram'} na lista de bancos.` : ''}</p>` : ''}
      ${!proventos.length && !operacoes.length ? '<p class="aviso">Nada novo: tudo deste extrato já está no app.</p>' : ''}
      ${proventos.length ? `<div class="b3-bloco">
        <div class="cc-linha"><b>${proventos.length} ${proventos.length === 1 ? 'provento novo' : 'proventos novos'}</b><b class="num">${R(somaP)}</b></div>
        <small class="dica">${TIPOS_PROV_ORDEM.filter((k) => porTipo[k] > 0).map((k) => `${esc(NOME_CURTO_PROV[k] || TIPOS_PROVENTO[k])} ${R(porTipo[k])}`).join(' · ')}</small>
        <div class="b3-lista">${proventos.map((p) => `<div class="cc-linha"><span>${dataBR(p.data).slice(0, 5)}${p.data.slice(0, 4) !== String(new Date().getFullYear()) ? `/${p.data.slice(2, 4)}` : ''} <b>${esc(p.ticker)}</b> <small>${esc(NOME_CURTO_PROV[p.tipo] || TIPOS_PROVENTO[p.tipo])}${tagBanco(p.banco)}</small></span><span class="num">${R(p.valor)}</span></div>`).join('')}</div>
      </div>` : ''}
      ${operacoes.length ? `<div class="b3-bloco">
        <div class="cc-linha"><b>${operacoes.length} ${operacoes.length === 1 ? 'operação que não está' : 'operações que não estão'} no app</b></div>
        <small class="dica">Compras e vendas liquidadas na B3 sem registro aqui. A data é a do pregão (dois dias úteis antes da liquidação) e a taxa é estimada pelo seu banco; no Tesouro, data e preço são os exatos da B3, sem taxa. Desmarque o que não quiser.</small>
        <div class="b3-lista">${operacoes.map((o, i) => `<label class="cc-linha b3-op"><span><input type="checkbox" data-b3-op="${i}" checked> ${dataBR(o.data).slice(0, 5)}${o.data.slice(0, 4) !== String(new Date().getFullYear()) ? `/${o.data.slice(2, 4)}` : ''} <b>${esc(o.ticker)}</b> <small>${o.rotulo || (o.lado === 'V' ? 'venda' : o.lado === 'B' ? 'bonificação' : 'compra')}${o.peloCusto && !o.transf ? ' (pelo custo)' : ''} · ${fmtQtd(o.qtd)}${o.lado === 'B' ? ' cotas' : ` × ${R(o.preco)}`}${o.original !== o.ticker ? ` · era ${esc(o.original)}` : ''}${o.fator !== 1 ? ' · já com o desdobramento' : ''}${tagBanco(o.banco)}</small></span><span class="num">${o.lado === 'B' ? '' : R(o.qtd * o.preco)}</span></label>`).join('')}</div>
      </div>` : ''}
      ${operacoes.some((o) => o.tipo === 'rf') ? '<p class="dica">Renda fixa (CDB, LCA…): a B3 não informa quanto você recebeu no vencimento, então ele entra pelo valor aplicado, sem rendimento. Se quiser o ganho certo, corrija o valor no Histórico. Títulos ainda abertos ficam pelo valor aplicado até você informar o valor atual.</p>' : ''}
      ${res.avisos.length ? `<p class="aviso">Confira à mão, o app não ajusta sozinho: ${res.avisos.map((a) => `${esc(a.nome)} de ${esc(a.ticker)} em ${dataBR(a.data)}`).join('; ')}.</p>` : ''}
      ${ignorados.length ? `<p class="dica">Sem efeito no app: ${ignorados.map(([n, q]) => `${esc(n)}${q > 1 ? ` (${q})` : ''}`).join(', ')}.</p>` : ''}
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>${proventos.length || operacoes.length ? 'Cancelar' : 'Fechar'}</button>${proventos.length || operacoes.length ? '<button class="btn prim" value="ok">Adicionar ao app</button>' : ''}</div>
    </form>`;
  dlg.oninput = null;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const marcadas = [...dlg.querySelectorAll('[data-b3-op]')].filter((c) => c.checked).map((c) => operacoes[Number(c.dataset.b3Op)]);
    const usados = new Set([...marcadas, ...proventos].map((x) => x.banco));
    const criar = [...novosBancos.values()].filter((b) => usados.has(b.id));
    if (criar.length) { S.bancos.push(...criar); persist('bancos'); }
    const novas = marcadas.map((o) => {
      const { inst, rotulo, peloCusto, transf, ...op } = o;
      const bk = banco(op.banco);
      return { id: uid(), data: op.data, ticker: op.ticker, tipo: S.ativos.find((a) => a.ticker === op.ticker)?.tipo || op.tipo, qtd: op.qtd, preco: op.preco, custo: op.lado === 'B' || op.tipo === 'tesouro' || op.tipo === 'rf' ? 0 : custoOrdem({ tipo: op.tipo }, op.qtd, op.preco, bk), banco: bk.id, ...(op.lado !== 'C' ? { lado: op.lado } : {}) };
    });
    proventos.forEach((p) => delete p.inst);
    if (novas.length) { S.compras.push(...novas); N.adicionarCompras(novas); }
    if (proventos.length) { S.proventos.push(...proventos); N.adicionarProvento(proventos); }
    garantirAtivosDaCarteira();
    persist();
    toast(`Adicionado: ${[proventos.length ? `${proventos.length} ${proventos.length === 1 ? 'provento' : 'proventos'}` : '', novas.length ? `${novas.length} ${novas.length === 1 ? 'operação' : 'operações'}` : ''].filter(Boolean).join(' e ')}.`);
    render();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

function ligarAjustes() {
  $('#conteudo').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tema]');
    if (!t) return;
    mudarTema(t.dataset.tema);
    document.querySelectorAll('[data-tema]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tema === tema)));
  });
  $('#aj-banco').addEventListener('change', (e) => { S.ajustes.banco = e.target.value; persist('ajustes'); renderBoleta(); toast(`Taxas do ${banco().nome}.`); });
  $('#aj-aporte').addEventListener('change', (e) => {
    const v = num(e.target.value);
    if (Number.isFinite(v) && v >= 0) S.ajustes.aporteMensal = v;
    e.target.value = Number(S.ajustes.aporteMensal).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    persist('ajustes'); renderBoleta(); toast('Aporte padrão salvo.');
  });
  $('#aj-token')?.addEventListener('change', async (e) => {
    S.ajustes.token = e.target.value.trim();
    persist('ajustes');
    if (!S.ajustes.token) return;
    try { await buscarCotacao('BBAS3', S.ajustes.token); toast('Token funcionando.'); }
    catch (err) { toast(`Token salvo, mas a brapi respondeu: ${err.message}.`); }
  });
  $('#b3-arquivo').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const st = $('#b3-status');
    st.textContent = 'Lendo o extrato…';
    try { const res = await lerExtratoB3(f); st.textContent = ''; abrirResumoB3(res); } catch (err) { st.textContent = ''; toast(err.message || 'Não consegui ler esse arquivo.'); }
  });
  $('#pl-arquivo').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const st = $('#pl-status');
    try {
      const res = await lerPlanilha(f, (msg) => { st.textContent = msg; });
      st.textContent = '';
      abrirResumoPlanilha(res);
    } catch (err) { st.textContent = ''; toast(err.message || 'Não consegui ler esse arquivo.'); }
  });
  $('#conteudo').addEventListener('change', (e) => {
    const id = e.target.dataset.bk;
    if (!id) return;
    const b = S.bancos.find((x) => x.id === id);
    const v = num(e.target.value);
    if (Number.isFinite(v) && v >= 0) b[e.target.dataset.campo] = e.target.dataset.campo === 'corretagem' ? v : v / 100;
    persist('bancos');
  });
  $('#bk-padrao').addEventListener('click', () => {
    const extras = S.bancos.filter((b) => !BANCOS_PADRAO.some((p) => p.id === b.id));
    S.bancos = [...BANCOS_PADRAO.map((b) => ({ ...b })), ...extras];
    persist('bancos'); render(); toast('Taxas de referência restauradas.');
  });
  $('#bk-exportar').addEventListener('click', () => exportar(S));
  $('#bk-importar').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { S = await importar(f); persist(); N.substituirTudo(paraNuvem(S)); render(); toast('Backup importado.'); }
    catch (err) { toast(err.message || 'Não consegui ler esse arquivo.'); }
  });
  const apagar = $('#bk-apagar');
  apagar.addEventListener('click', () => {
    if (!apagar.dataset.ok) { apagar.dataset.ok = '1'; apagar.textContent = 'Tem certeza? Toque de novo'; setTimeout(() => { if (apagar.isConnected) { delete apagar.dataset.ok; apagar.textContent = 'Apagar tudo'; } }, 4000); return; }
    S = resetar(); persist(); N.substituirTudo(paraNuvem(S)); render(); toast(N.ativa() ? 'Dados apagados aqui e na nuvem.' : 'Dados apagados.');
  });
  ligarConta($('.conta-bloco'));
}

// ---------- roteamento ----------
const ABAS = {
  comprar: [renderComprar, ligarComprar],
  carteira: [renderCarteira, ligarHistorico],
  proventos: [renderProventos, ligarProventos],
  simular: [renderSimular, ligarSimular],
  ajustes: [renderAjustes, ligarAjustes],
};

// ---------- conta / nuvem ----------
function quando(d) {
  if (!d) return 'ainda não';
  const min = Math.round((Date.now() - d) / 60000);
  return min < 1 ? 'agora há pouco' : min < 60 ? `há ${min} min` : `às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Conteúdo da conta: usado no painel do topo e em Ajustes. */
function htmlConta() {
  const st = N.nuvem.estado;
  if (N.ativa()) {
    const sinc = st === 'pendente' ? 'salvando agora…' : st === 'offline' ? 'sem internet — as alterações serão enviadas quando voltar' : quando(N.nuvem.ultimaSinc);
    return `
      <div class="conta-cab"><span class="ponto ${st === 'offline' ? 'off' : st === 'pendente' ? 'pend' : 'ok'}"></span><h2>Conectado à sua nuvem</h2></div>
      <dl class="conta-info">
        <dt>Endereço</dt><dd>${esc(location.host)}</dd>
        <dt>Onde ficam os dados</dt><dd>Banco D1 “meus-investimentos”, na sua conta Cloudflare</dd>
        <dt>Salvo lá</dt><dd>${S.ativos.length} ativos · ${S.compras.length} compras · ${S.proventos.length} proventos</dd>
        <dt>Última sincronização</dt><dd>${esc(sinc)}</dd>
      </dl>
      <p class="dica">O acesso é só seu, pela senha definida na Cloudflare. Abra este mesmo endereço no celular ou no computador e entre com ela para ver tudo igual.</p>
      <div class="acoes"><button type="button" class="btn" data-conta="sinc">Sincronizar agora</button><span class="esp"></span><button type="button" class="btn perigo" data-conta="sair">Sair deste aparelho</button></div>`;
  }
  if (st === 'senha') {
    return `
      <div class="conta-cab"><span class="ponto local"></span><h2>Entrar na sua nuvem</h2></div>
      <p class="dica">Entrando, suas compras, proventos e ativos ficam salvos na Cloudflare e aparecem em qualquer aparelho. Sem entrar, o app funciona como calculadora: monte a compra normalmente, mas tudo fica só neste aparelho.</p>
      <form class="campos" data-conta-form>
        <label class="campo"><span>Senha</span><input type="password" id="nv-senha" autocomplete="current-password" required></label>
        <div class="campo-acao"><button class="btn prim" type="submit">Entrar</button></div>
      </form>
      ${N.nuvem.mensagem ? `<p class="aviso"><b>${esc(N.nuvem.mensagem)}</b></p>` : ''}
      <div class="acoes"><button type="button" class="btn" data-conta="fechar">Continuar sem entrar</button></div>`;
  }
  if (st === 'config') {
    return `
      <div class="conta-cab"><span class="ponto off"></span><h2>Nuvem quase pronta</h2></div>
      <p class="dica">${esc(N.nuvem.mensagem)} Enquanto isso, o app funciona como calculadora neste aparelho.</p>`;
  }
  return `
    <div class="conta-cab"><span class="ponto local"></span><h2>Modo calculadora</h2></div>
    <p class="dica">${st === 'verificando' ? 'Verificando a nuvem…' : `${esc(N.nuvem.mensagem || 'Este endereço não tem a nuvem.')} Tudo funciona, mas fica só neste aparelho.`}</p>`;
}

function ligarConta(raiz) {
  if (!raiz) return;
  raiz.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-conta-form]')) return;
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Entrando…';
    const srv = await N.entrar(e.target.querySelector('#nv-senha').value);
    if (srv) { $('#dlg-conta').open && $('#dlg-conta').close(); toast('Conectado. Seus dados estão salvos na nuvem.'); }
    aplicarNuvem(srv);
  });
  raiz.addEventListener('click', async (e) => {
    const acao = e.target.closest('[data-conta]')?.dataset.conta;
    if (acao === 'fechar') $('#dlg-conta').close();
    if (acao === 'sinc') { const srv = await N.sincronizar(); if (srv) { aplicarNuvem(srv); toast('Sincronizado.'); } }
    if (acao === 'sair') {
      N.sair();
      // ao sair, o aparelho guarda só a lista de ativos para continuar como calculadora
      S.compras = []; S.proventos = []; salvar(S);
      if ($('#dlg-conta').open) $('#dlg-conta').close();
      render(); toast('Você saiu. Os dados continuam na nuvem.');
    }
  });
}

function abrirConta() {
  const dlg = $('#dlg-conta');
  dlg.innerHTML = `<div class="conta-dlg">${htmlConta()}<button type="button" class="x fechar" data-conta="fechar" aria-label="Fechar">✕</button></div>`;
  dlg.showModal();
  dlg.querySelector('#nv-senha')?.focus();
}
$('#nuvem').addEventListener('click', (e) => { e.preventDefault(); abrirConta(); });
ligarConta($('#dlg-conta'));
$('#dlg-conta').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// avisos de configuração, acima de qualquer aba
function htmlNuvemTopo() {
  if (N.nuvem.estado === 'config') return `<p class="aviso"><b>Nuvem quase pronta:</b> ${esc(N.nuvem.mensagem)}</p>`;
  return '';
}

function renderNuvem() {
  const el = $('#nuvem');
  const t = {
    ok: ['Conectado', 'ok'], pendente: ['Salvando…', 'pend'], offline: ['Sem internet', 'off'],
    local: ['Calculadora', 'local'], config: ['Configurar nuvem', 'off'], senha: ['Entrar', 'entrar'], verificando: ['', ''],
  }[N.nuvem.estado] || ['', ''];
  el.textContent = t[0];
  el.className = `nuvem-st ${t[1]}`;
  el.hidden = !t[0];
  el.title = N.ativa() ? `Conectado à nuvem em ${location.host}` : N.nuvem.mensagem || '';
  // painel de conta aberto acompanha o estado
  const dlg = $('#dlg-conta');
  if (dlg.open && !dlg.contains(document.activeElement?.closest?.('form') || null)) {
    dlg.querySelector('.conta-dlg').innerHTML = `${htmlConta()}<button type="button" class="x fechar" data-conta="fechar" aria-label="Fechar">✕</button>`;
  }
  const bloco = $('.conta-bloco');
  if (bloco && !bloco.contains(document.activeElement)) bloco.innerHTML = htmlConta();
}

// rodapé: versão, como nos outros apps
{
  const ver = $('#versao');
  if (ver) { ver.textContent = `Meus Investimentos v${VERSAO}`; ver.title = `Publicada em ${dataBR(VERSAO_DATA)}`; }
}

function render() {
  const aba = ABAS[location.hash.slice(1)] ? location.hash.slice(1) : 'comprar';
  document.querySelectorAll('.abas a, .navbar a').forEach((a) => {
    a.classList.toggle('ativa', a.dataset.aba === aba);
    if (a.dataset.aba === aba) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  // troca o <main> para descartar listeners antigos
  const velho = $('#conteudo');
  const novo = velho.cloneNode(false);
  velho.replaceWith(novo);
  const [html, ligar] = ABAS[aba];
  novo.innerHTML = htmlNuvemTopo() + html();
  ligar();
  renderBoleta();
  renderNuvem();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });
N.aoMudar(renderNuvem);

/** Todo ativo que você tem em carteira aparece na lista, mesmo se foi tirado dela. */
function garantirAtivosDaCarteira() {
  const tem = new Set(S.ativos.map((a) => a.ticker));
  const emCarteira = new Set(carteira(S.compras, [], []).linhas.map((l) => l.ticker)); // vendidos por inteiro não voltam
  let mudou = false;
  for (const c of S.compras) {
    if (tem.has(c.ticker) || !emCarteira.has(c.ticker) || c.tipo === 'rf') continue; // CDB/LCA não entram na lista de compra do mês
    S.ativos.push({ id: uid(), ticker: c.ticker, tipo: c.tipo || 'acao', nome: c.tipo === 'tesouro' ? c.ticker : '', preco: null, precoEm: null, fonte: null });
    tem.add(c.ticker); mudou = true;
  }
  if (mudou) persist('ativos');
}

function aplicarNuvem(srv) {
  if (srv) {
    if (srv.vazio) {
      // primeira vez: sobe o que está neste navegador
      N.substituirTudo(paraNuvem(S));
      toast('Nuvem ligada. Seus dados deste aparelho foram enviados.');
    } else {
      S = juntarComNuvem(S, srv);
      salvar(S);
      renderBancos();
    }
  }
  garantirAtivosDaCarteira();
  render();
  cotacoesAoAbrir();
}

const cotacoesVelhas = (min) => Date.now() - ultimaBusca > min * 60000;

function cotacoesAoAbrir() {
  if (!cotacoesVelhas(5)) return;
  if (temCotacaoAutomatica()) { atualizarCotacoes(); return; }
  // sem nuvem e sem token: só os ativos liberados na brapi
  const livres = S.ativos.filter((a) => ['PETR4', 'VALE3', 'ITUB4', 'MGLU3'].includes(a.ticker));
  if (livres.length) {
    atualizarTodas(livres, '', (a, q) => { if (q) { a.preco = q.preco; a.precoEm = q.em; a.fonte = q.fonte || 'brapi'; statusCotacao[a.id] = { variacao: q.variacao }; } })
      .then(() => { persist(); if (!location.hash || location.hash === '#comprar') render(); });
  }
}

// com a tela aberta na aba Comprar, atualiza as cotações a cada 5 minutos
setInterval(() => {
  const naCompra = !location.hash || location.hash === '#comprar';
  const digitando = document.activeElement?.matches?.('input, select');
  if (document.visibilityState === 'visible' && naCompra && !digitando && !$('#dlg-registrar').open && temCotacaoAutomatica() && cotacoesVelhas(5)) atualizarCotacoes();
}, 60000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && temCotacaoAutomatica() && cotacoesVelhas(5)) atualizarCotacoes(); });

aplicarTema();
render();
N.iniciar().then(aplicarNuvem);
