import {
  TIPOS, TIPOS_PROVENTO, round2, normalizaQtd, passoDe, resumoPlano, linhaPlano, qtdMaxima, avisoMinimo,
  mesAnterior, mesDe, hojeISO, somaProventosMes, proventosPorTipo, carteira, resumoPorPeriodo, estimarCompra, fatoresDoMes, precoTesouroEm,
} from './calc.js';
import { carregar, salvar, exportar, importar, resetar, uid, BANCOS_PADRAO, paraNuvem, juntarComNuvem } from './store.js';
import { atualizarTodas, buscarCotacao } from './cotacoes.js';
import * as N from './nuvem.js';

// ---------- estado ----------
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

// ---------- aba Comprar (tela inicial) ----------
const fmtPreco = (v) => (v ? v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '');
const ICONE_ATUALIZAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/></svg>';

function posicoes() {
  const c = carteira(S.compras, S.ativos, S.proventos);
  return { ...c, porTicker: new Map(c.linhas.map((l) => [l.ticker, l])) };
}

function htmlPosicao(pos) {
  if (!pos || !pos.qtd) return '<small class="pos nada">nenhuma cota ainda</small>';
  const cls = pos.resultado == null ? '' : pos.resultado >= 0 ? 'var-alta' : 'var-baixa';
  const un = pos.tipo === 'tesouro' ? 'títulos' : pos.qtd === 1 ? 'cota' : 'cotas';
  return `<small class="pos"><b>${fmtQtd(pos.qtd)} ${un}</b> · ${R(pos.valorAtual ?? pos.investido)}${pos.resultadoPct != null ? ` <span class="${cls}">${pct(pos.resultadoPct)}</span>` : ''}</small>`;
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
      <button type="button" class="add-abrir" id="add-abrir" ${ordem.length ? '' : 'hidden'}>+ Adicionar ativo</button>
      <form id="form-add" class="add-ativo" autocomplete="off" ${ordem.length ? 'hidden' : ''}>
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
  $('#add-abrir').addEventListener('click', (e) => { e.currentTarget.hidden = true; form.hidden = false; addT.focus(); });
  $('#add-cancelar').addEventListener('click', () => { form.hidden = true; $('#add-abrir').hidden = false; form.reset(); delete addTipo.dataset.manual; });
  addT.addEventListener('input', () => { if (!addTipo.dataset.manual) addTipo.value = adivinharTipo(addT.value); });
  addTipo.addEventListener('change', () => { addTipo.dataset.manual = '1'; });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const tipo = addTipo.value;
    let ticker = addT.value.trim();
    if (tipo !== 'tesouro') ticker = ticker.toUpperCase().replace(/\s+/g, '');
    if (!ticker) return;
    const existente = S.ativos.find((a) => a.ticker.toLowerCase() === ticker.toLowerCase());
    if (existente) { toast(`${ticker} já está na lista.`); $(`#q-${existente.id}`)?.focus(); return; }
    const novo = { id: uid(), ticker, tipo, nome: tipo === 'tesouro' ? ticker : '', preco: null, precoEm: null, fonte: null };
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
  });

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
        <label class="campo"><span>Banco</span><select id="reg-banco">${S.bancos.map((bk) => `<option value="${bk.id}" ${bk.id === b.id ? 'selected' : ''}>${esc(bk.nome)}</option>`).join('')}</select></label>
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
const SERIES = [
  { k: 'prov', nome: 'Proventos' },
  { k: 'acao', nome: 'Ações' },
  { k: 'fii', nome: 'FIIs' },
  { k: 'outros', nome: 'ETF/BDR' },
  { k: 'tesouro', nome: 'Tesouro' },
  { k: 'taxa', nome: 'Com taxas' },
];
const PILHA = ['acao', 'fii', 'outros', 'tesouro']; // de baixo para cima
const GRAF_KEY = 'meus-investimentos:grafico';
const PADRAO_GRAF = { periodo: 'mes', modo: 'periodo', hist: ['prov', 'acao', 'fii', 'outros', 'tesouro', 'taxa', 'mercado'], sel: null };
let G = (() => { try { return { ...PADRAO_GRAF, ...JSON.parse(localStorage.getItem(GRAF_KEY) || '{}') }; } catch { return { ...PADRAO_GRAF }; } })();
if (typeof G.sel !== 'number') G.sel = null;
if (!G.hist.includes('mercado') && !G.semMercado) G.hist.push('mercado');
if (!G.hist.includes('taxa') && !G.semTaxa) G.hist.push('taxa');
const salvarG = () => { try { localStorage.setItem(GRAF_KEY, JSON.stringify(G)); } catch { /* sem armazenamento */ } };

const rotuloCurto = (chave, per) => per === 'ano' ? chave : per === 'mes' ? mesCurto(chave) : `${chave.slice(8, 10)}/${chave.slice(5, 7)}`;
const rotuloLongo = (chave, per) => per === 'ano' ? chave : per === 'mes' ? nomeMesAno(chave).replace(/^./, (c) => c.toUpperCase()) : dataBR(chave);
const compacto = (v) => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10000 ? 0 : 1 })} mil` : Math.round(v).toLocaleString('pt-BR');

/** Todos os meses (ou anos) do primeiro registro até hoje, inclusive os vazios. Dias: só os que tiveram movimento. */
function linhasDoGrafico(per) {
  const ls = resumoPorPeriodo(S.compras, S.proventos, per);
  if (per === 'dia' || !ls.length) return ls;
  const mapa = new Map(ls.map((l) => [l.chave, l]));
  const vazio = (k) => ({ chave: k, acao: 0, fii: 0, tesouro: 0, outros: 0, total: 0, compras: 0, proventos: 0, tx: { acao: 0, fii: 0, tesouro: 0, outros: 0 } });
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
  const tickers = [...new Set(S.compras.filter((c) => c.tipo !== 'tesouro').map((c) => c.ticker))];
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
  for (const c of S.compras) {
    if (mesDe(c.data) > ym) continue;
    const p = pos.get(c.ticker) || { tipo: c.tipo, qtd: 0, custo: 0 };
    p.qtd += Number(c.qtd); p.custo += Number(c.qtd) * Number(c.preco) + Number(c.custo || 0);
    pos.set(c.ticker, p);
  }
  const porTipo = { acao: 0, fii: 0, outros: 0, tesouro: 0 };
  for (const [t, p] of pos) {
    const grupo = ['acao', 'fii', 'tesouro'].includes(p.tipo) ? p.tipo : 'outros';
    const preco = precoNoMes(t, p.tipo, ym);
    porTipo[grupo] += preco ? p.qtd * preco : p.custo;
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
  const acum = G.modo === 'acumulado';
  let linhas = linhasDoGrafico(per);
  if (acum) {
    const soma = { acao: 0, fii: 0, outros: 0, tesouro: 0, proventos: 0 };
    const tx = { acao: 0, fii: 0, outros: 0, tesouro: 0 };
    linhas = linhas.map((l) => {
      for (const k of Object.keys(soma)) soma[k] += l[k];
      for (const k of Object.keys(tx)) tx[k] += l.tx?.[k] || 0;
      return { ...l, ...soma, tx: { ...tx } };
    });
  }
  const temTaxa = S.compras.some((c) => Number(c.custo) > 0);
  const presentes = SERIES.filter((x) => (x.k === 'taxa' ? temTaxa : linhas.some((l) => (x.k === 'prov' ? l.proventos : l[x.k]) > 0)));
  const comTaxa = temTaxa && (G.hist || []).includes('taxa');
  if (!comTaxa) linhas = linhas.map(semTaxas);
  const podeMerc = acum && per !== 'dia' && S.compras.length > 0;
  if (podeMerc) presentes.push({ k: 'mercado', nome: 'Valor de mercado' });
  const ativos = new Set((G.hist || []).filter((k) => presentes.some((x) => x.k === k)));
  const pilha = PILHA.filter((k) => ativos.has(k));
  const comProv = ativos.has('prov');
  const inv = (l) => pilha.reduce((s, k) => s + l[k], 0);
  const comMerc = podeMerc && ativos.has('mercado');
  if (comMerc && !HIST) garantirHistorico();
  const merc = linhas.map((l) => {
    if (!comMerc || !HIST) return null;
    const m = mercadoAte(fimDoPeriodo(l.chave, per));
    return pilha.reduce((s, k) => s + m[k], 0);
  });
  const brutas = linhasDoGrafico(per).map((l) => (comTaxa ? l : semTaxas(l)));
  const totInv = brutas.reduce((s, l) => s + pilha.reduce((t, k) => t + l[k], 0), 0);
  const totTaxa = comTaxa ? brutas.reduce((s, l) => s + taxasDe(l, pilha), 0) : 0;
  const totProv = comProv ? brutas.reduce((s, l) => s + l.proventos, 0) : 0;

  // largura: cabe tudo na tela sempre que possível; só rola quando os períodos não cabem
  const n = linhas.length;
  const L = Math.max(280, Math.round(largura || 860));
  const minimo = per === 'ano' ? 78 : comMerc && comProv ? 96 : (comProv && pilha.length) || comMerc ? 86 : 74; // espaço para o valor em reais escrito por extenso
  const slot = n * minimo <= L ? L / Math.max(n, 1) : minimo;
  const W = Math.round(n * slot);
  const H = comMerc ? 300 : 280, topo = comMerc ? 62 : 46, base = 30;
  const alt = H - topo - base;
  const maxV = Math.max(1, ...linhas.map((l, i) => Math.max(inv(l), comProv ? l.proventos : 0, merc[i] || 0)));
  const y = (v) => topo + alt * (1 - v / maxV);
  const duas = pilha.length && comProv;
  const wInv = Math.min(56, Math.max(18, slot * (duas ? 0.38 : 0.5)));
  const wProv = duas ? Math.min(30, Math.max(10, slot * 0.2)) : wInv;
  const sel = Math.min(G.sel ?? n - 1, n - 1);
  const grade = [0.25, 0.5, 0.75, 1].map((f) => `<line class="grade" x1="0" x2="${W}" y1="${topo + alt * (1 - f)}" y2="${topo + alt * (1 - f)}"/>`).join('');
  const reais = (v) => R(v);

  const barras = linhas.map((l, i) => {
    const cx = i * slot + slot / 2;
    const largGrupo = duas ? wInv + 4 + wProv : wInv;
    const xInv = cx - largGrupo / 2;
    const xProv = duas ? xInv + wInv + 4 : cx - wProv / 2;
    let acc = 0, segs = '';
    const visiveis = pilha.filter((k) => l[k] > 0);
    visiveis.forEach((k, j) => {
      const v = l[k];
      const y1 = y(acc + v), y0 = y(acc);
      const ultimo = j === visiveis.length - 1;
      const h = Math.max(1.5, y0 - y1 - (j ? 2 : 0));
      segs += ultimo ? barra(xInv, y1, wInv, h, 5, `s-${k}`) : `<rect class="s-${k}" x="${xInv}" y="${y1}" width="${wInv}" height="${h}"/>`;
      acc += v;
    });
    const prov = comProv && l.proventos ? barra(xProv, y(l.proventos), wProv, y(0) - y(l.proventos), 4, 's-prov') : '';
    const topoBarra = Math.min(acc ? y(acc) : H, comProv && l.proventos ? y(l.proventos) : H, merc[i] ? y(merc[i]) - 6 : H);
    const [tx, anc] = slot >= 112 ? [cx, 'middle'] : i === 0 ? [i * slot + 4, 'start'] : i === n - 1 ? [(i + 1) * slot - 4, 'end'] : [cx, 'middle'];
    let rot = '';
    if (merc[i] != null && acc) {
      const ganho = merc[i] - acc;
      rot = `<text class="v" x="${tx}" y="${topoBarra - (comProv && l.proventos ? 36 : 22)}" text-anchor="${anc}">${reais(merc[i])}</text>`
        + `<text class="v2 ${ganho >= 0 ? 'ganho' : 'perda'}" x="${tx}" y="${topoBarra - (comProv && l.proventos ? 22 : 8)}" text-anchor="${anc}">${ganho >= 0 ? '+' : '−'} ${reais(Math.abs(ganho))}</text>`
        + (comProv && l.proventos ? `<text class="v2" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">prov. ${reais(l.proventos)}</text>` : '');
    } else if (acc && comProv && l.proventos) rot = `<text class="v" x="${tx}" y="${topoBarra - 22}" text-anchor="${anc}">${reais(acc)}</text><text class="v2" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">+ ${reais(l.proventos)}</text>`;
    else if (acc) rot = `<text class="v" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">${reais(acc)}</text>`;
    else if (comProv && l.proventos) rot = `<text class="v" x="${tx}" y="${topoBarra - 8}" text-anchor="${anc}">${reais(l.proventos)}</text>`;
    return `<g class="slot ${i === sel ? 'sel' : ''}" data-graf-slot="${i}">
      <rect class="alvo" x="${i * slot + 3}" y="4" width="${slot - 6}" height="${H - 8}" rx="10"/>
      ${segs}${prov}${rot}
      <text class="x" x="${cx}" y="${H - 10}" text-anchor="middle">${rotuloCurto(l.chave, per)}</text>
    </g>`;
  }).join('');

  const pts = merc.map((v, i) => (v != null ? [i * slot + slot / 2, y(v)] : null));
  const linhaMerc = comMerc && HIST ? `<polyline class="linha-merc" points="${pts.filter(Boolean).map((p) => p.join(',')).join(' ')}"/>${pts.map((p, i) => (p ? `<circle class="ponto-merc ${i === sel ? 'sel' : ''}" cx="${p[0]}" cy="${p[1]}" r="${i === sel ? 5 : 3}"/>` : '')).join('')}` : '';

  const l = linhas[sel];
  const itens = l ? [...pilha.map((k) => [SERIES.find((x) => x.k === k).nome, l[k], k]), ...(comProv ? [['Proventos', l.proventos, 'prov']] : [])].filter(([, v]) => v > 0) : [];
  const detalhe = l ? `
    <div class="det-cab"><b>${acum ? 'Até ' : ''}${rotuloLongo(l.chave, per)}</b>${pilha.length ? `<span>Investido <b>${R(inv(l))}</b>${comTaxa && taxasDe(l, pilha) > 0 ? ` <span class="apagado">(taxas ${R(taxasDe(l, pilha))})</span>` : ''}${merc[sel] != null ? ` · Valia <b>${R(merc[sel])}</b> <span class="${merc[sel] >= inv(l) ? 'var-alta' : 'var-baixa'}">${merc[sel] >= inv(l) ? '+' : '−'}${R(Math.abs(merc[sel] - inv(l)))} (${pct(inv(l) ? merc[sel] / inv(l) - 1 : null)})</span>` : ''}</span>` : ''}</div>
    ${itens.length ? `<div class="det-itens">${itens.map(([nome, v, k]) => `<span><i class="sw s-${k}"></i>${nome}<b>${R(v)}</b></span>`).join('')}</div>` : '<div class="det-itens"><span class="apagado">Sem movimento neste período.</span></div>'}` : '';

  return `
    <section class="bloco grafico-bloco" id="graf-hist">
      <div class="graf-topo">
        <div>
          <h2>${acum ? 'Total acumulado' : 'Quanto investi'}</h2>
          <small class="sub-cab">${pilha.length ? `Investido <b>${R(totInv)}</b>${totTaxa > 0 ? ` <span class="apagado">(taxas ${R(totTaxa)})</span>` : ''}` : ''}${comMerc && HIST && merc[n - 1] != null ? ` · Vale hoje <b>${R(merc[n - 1])}</b> <span class="${merc[n - 1] >= totInv ? 'var-alta' : 'var-baixa'}">${pct(totInv ? merc[n - 1] / totInv - 1 : null)}</span>` : ''}${comMerc && !HIST ? ' · calculando o valor de mercado…' : ''}${pilha.length && comProv ? ' · ' : ''}${comProv ? `Proventos <b>${R(totProv)}</b>` : ''}</small>
        </div>
        <div class="graf-controles">
          <div class="seg" role="group" aria-label="Mostrar">
            ${[['periodo', 'No período'], ['acumulado', 'Acumulado']].map(([k, nm]) => `<button type="button" data-graf-modo="${k}" aria-pressed="${(G.modo || 'periodo') === k}">${nm}</button>`).join('')}
          </div>
          <div class="seg" role="group" aria-label="Agrupar por">
            ${[['dia', 'Dia'], ['mes', 'Mês'], ['ano', 'Ano']].map(([k, nm]) => `<button type="button" data-graf-periodo="${k}" aria-pressed="${per === k}">${nm}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="filtros" role="group" aria-label="Mostrar no gráfico">
        ${presentes.map((x) => `<button type="button" class="filtro" data-graf-serie="${x.k}" aria-pressed="${ativos.has(x.k)}"><i class="sw s-${x.k}"></i>${x.nome}</button>`).join('')}
      </div>
      ${n ? `<div class="graf-rolagem" data-largura="${L}"><svg class="grafico" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Investimentos${comProv ? ' e proventos' : ''} por ${per === 'mes' ? 'mês' : per}${acum ? ', acumulado' : ''}">
        ${grade}<line class="base" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>${barras}${linhaMerc}</svg></div>
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
  $('#conteudo').addEventListener('click', (e) => {
    const t = e.target.closest('[data-graf-periodo],[data-graf-serie],[data-graf-slot],[data-graf-modo]');
    if (!t) return;
    let fim = false;
    if (t.dataset.grafPeriodo) { G.periodo = t.dataset.grafPeriodo; G.sel = null; fim = true; }
    if (t.dataset.grafModo) { G.modo = t.dataset.grafModo; }
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

function abrirEditarCompra(id) {
  const c = S.compras.find((x) => x.id === id);
  if (!c) return;
  const ativo = S.ativos.find((a) => a.ticker === c.ticker) || { ticker: c.ticker, tipo: c.tipo };
  const tes = c.tipo === 'tesouro';
  const temHistorico = N.nuvem.servidor && !tes;
  const bancoAtual = S.bancos.some((b) => b.id === c.banco) ? c.banco : banco().id;
  const dlg = $('#dlg-compra');
  dlg.innerHTML = `
    <form method="dialog" id="form-edit" class="form-edit">
      <h2>Editar compra de ${esc(c.ticker)}</h2>
      ${c.importado ? '<p class="dica">Veio da planilha com a quantidade estimada. Corrigindo aqui, ela passa a valer como compra exata.</p>' : ''}
      <div class="campos dois">
        <label class="campo"><span>Data da compra</span><input type="date" id="ed-data" value="${esc(c.data)}" max="${hojeISO()}" required><small class="sub"></small></label>
        <label class="campo"><span>Banco</span><select id="ed-banco">${S.bancos.map((bk) => `<option value="${bk.id}" ${bk.id === bancoAtual ? 'selected' : ''}>${esc(bk.nome)}</option>`).join('')}</select><small class="sub"></small></label>
        <label class="campo"><span>${tes ? 'Títulos' : 'Cotas'}</span><input class="num" id="ed-qtd" inputmode="decimal" value="${fmtQtd(c.qtd)}" required><small class="sub"></small></label>
        <label class="campo"><span>Preço pago por ${tes ? 'título' : 'cota'}</span><input class="num" id="ed-preco" inputmode="decimal" value="${fmtValor(c.preco)}" required><small class="sub" id="ed-dia">${temHistorico ? 'buscando o preço do dia…' : tes ? 'Tesouro: confira no extrato do banco.' : ''}</small></label>
        <label class="campo"><span>Taxas</span><input class="num" id="ed-custo" inputmode="decimal" value="${fmtValor(c.custo || 0)}"><small class="sub"><button type="button" id="ed-recalc">calcular pelo banco</button></small></label>
        <div class="campo"><span>Total</span><div class="disp-valor num" id="ed-total"></div><small class="sub"></small></div>
      </div>
      <p class="dica erro-campo" id="ed-erro" hidden></p>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok">Salvar</button></div>
    </form>`;

  const ler = () => {
    const qtd = normalizaQtd(ativo, num($('#ed-qtd').value));
    const preco = num($('#ed-preco').value);
    const custo = num($('#ed-custo').value);
    return { qtd, preco, custo: Number.isFinite(custo) && custo >= 0 ? round2(custo) : NaN };
  };
  const total = () => {
    const { qtd, preco, custo } = ler();
    const ok = qtd > 0 && preco > 0 && Number.isFinite(custo);
    $('#ed-total').textContent = ok ? R(qtd * preco + custo) : '—';
  };
  const recalcular = () => {
    const { qtd, preco } = ler();
    if (!(qtd > 0 && preco > 0)) return;
    const custo = linhaPlano({ ...ativo, tipo: c.tipo, preco }, qtd, banco($('#ed-banco').value)).custo;
    $('#ed-custo').value = fmtValor(custo);
    total();
  };

  // preço do pregão na data escolhida, com atalho para usar o fechamento
  let pedido = 0;
  const buscarDia = async () => {
    if (!temHistorico) return;
    const dia = $('#ed-data').value;
    const box = $('#ed-dia');
    if (!dia) { box.textContent = ''; return; }
    const meu = ++pedido;
    box.textContent = 'buscando o preço do dia…';
    const j = await precoNoDia(c.ticker, dia);
    if (meu !== pedido || !dlg.open) return;
    if (j.erro || !j.fechamento) { box.textContent = 'Não achei o preço desse dia.'; return; }
    const outroDia = j.data !== dia ? ` (pregão de ${dataBR(j.data)})` : '';
    const faixa = j.minima && j.maxima ? `entre ${R(j.minima)} e ${R(j.maxima)}` : '';
    box.innerHTML = `Fechou a ${R(j.fechamento)}${outroDia}${faixa ? `, ${faixa}` : ''} · <button type="button" id="ed-usar">usar</button>`;
    $('#ed-usar').onclick = () => { $('#ed-preco').value = fmtValor(j.fechamento); total(); };
  };

  dlg.oninput = (e) => {
    if (e.target.id === 'ed-data') buscarDia();
    total();
  };
  dlg.onchange = (e) => { if (e.target.id === 'ed-data') buscarDia(); };
  $('#ed-recalc').onclick = recalcular;
  $('#form-edit').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'ok') return;
    const { qtd, preco, custo } = ler();
    const data = $('#ed-data').value;
    const msg = !/^\d{4}-\d{2}-\d{2}$/.test(data) ? 'Escolha a data.'
      : !(qtd > 0) ? `Informe ${tes ? 'quantos títulos' : 'quantas cotas'}.`
      : !(preco > 0) ? 'Informe o preço pago.'
      : !Number.isFinite(custo) ? 'Taxa inválida.' : '';
    if (msg) { e.preventDefault(); const er = $('#ed-erro'); er.textContent = msg; er.hidden = false; }
  });
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const { qtd, preco, custo } = ler();
    const nova = { id: c.id, data: $('#ed-data').value, ticker: c.ticker, tipo: c.tipo, qtd, preco, custo, banco: $('#ed-banco').value };
    S.compras = S.compras.map((x) => (x.id === c.id ? nova : x));
    N.adicionarCompras([nova]); // a nuvem grava por cima da mesma compra
    persist();
    toast('Compra corrigida.');
    render();
  };
  total();
  dlg.returnValue = '';
  dlg.showModal();
  buscarDia();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function renderCarteira() {
  if (!S.compras.length) {
    return `<section class="bloco"><div class="vazio"><h2>Sua carteira aparece aqui</h2><p>Depois de comprar no banco, toque em <b>Comprei — registrar</b> na tela inicial. Aqui você vê cotas, preço médio, quanto investiu e o retorno.</p><a class="btn prim" href="#comprar">Ir para Comprar</a></div></section>`;
  }
  const c = carteira(S.compras, S.ativos, S.proventos);
  const cls = (v) => (v == null ? '' : v >= 0 ? 'var-alta' : 'var-baixa');
  const porMes = groupBy([...S.compras].sort((a, b) => b.data.localeCompare(a.data)), (x) => mesDe(x.data));
  return `
    <div class="kpis">
      <div class="kpi"><small>Investido</small><span class="num">${R(c.investido)}</span></div>
      <div class="kpi"><small>Valor hoje</small><span class="num">${R(c.valorAtual)}</span></div>
      <div class="kpi"><small>Resultado</small><span class="num ${cls(c.resultado)}">${R(c.resultado)} <small class="${cls(c.resultado)}">${pct(c.investido ? c.resultado / c.investido : null)}</small></span></div>
      <div class="kpi"><small>Proventos recebidos</small><span class="num">${R(c.proventos)}</span></div>
    </div>

    ${htmlGrafico()}


    <section class="bloco">
      <h2>Compras</h2>
      ${[...porMes.entries()].map(([mes, xs], i) => `
        <details class="mes-grupo" ${i === 0 ? 'open' : ''}>
          <summary class="mes-cab"><span>${nomeMesAno(mes).replace(/^./, (c) => c.toUpperCase())}</span><span class="num">${R(xs.reduce((s, x) => s + x.qtd * x.preco + (x.custo || 0), 0))}</span></summary>
          <div class="compras-lista">${xs.map(htmlCardCompra).join('')}</div>
        </details>`).join('')}
    </section>`;
}

const ICONE_EDITAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>';
const ICONE_LIXO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

/** Uma compra como card: toque em qualquer lugar para editar; lixeira pede confirmação. */
function htmlCardCompra(x) {
  const tes = x.tipo === 'tesouro';
  const total = x.qtd * x.preco + (x.custo || 0);
  const quando = x.importado ? `${nomeMesAno(mesDe(x.data))} · da planilha` : `${dataBR(x.data)} · ${esc(banco(x.banco)?.nome || x.banco || '')}`;
  return `<div class="card-compra" role="button" tabindex="0" data-edit-compra="${x.id}" aria-label="Editar compra de ${esc(x.ticker)}, ${dataBR(x.data)}">
    ${htmlLogo({ ticker: x.ticker, tipo: x.tipo })}
    <div class="cc-info">
      <div class="cc-linha"><b class="cc-ticker">${esc(x.ticker)}</b><span class="cc-total num">${R(total)}</span></div>
      <div class="cc-linha cc-sub"><span>${fmtQtd(x.qtd)} ${tes ? (x.qtd === 1 ? 'título' : 'títulos') : (x.qtd === 1 ? 'cota' : 'cotas')} × ${R(x.preco)}</span>${Number(x.custo) > 0 ? `<span class="cc-taxa">taxa ${R(x.custo)}</span>` : ''}</div>
      <div class="cc-linha cc-rodape"><small>${quando}${x.importado ? ' <span class="cc-tag">estimada</span>' : ''}</small>
        <span class="cc-acoes">
          <button type="button" class="ic-btn" data-edit-compra="${x.id}" title="Editar" aria-label="Editar compra de ${esc(x.ticker)}">${ICONE_EDITAR}</button>
          <button type="button" class="ic-btn perigo" data-del-compra="${x.id}" title="Remover" aria-label="Remover compra de ${esc(x.ticker)}">${ICONE_LIXO}</button>
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
const TIPOS_PROV_ORDEM = ['dividendo', 'jcp', 'rendimento', 'juros', 'outro'];
let PV_ANO = null; // ano escolhido no resumo ('tudo' = todos)

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

function htmlResumoProventos() {
  if (!S.proventos.length) return '';
  const anos = [...new Set(S.proventos.map((p) => p.data.slice(0, 4)))].sort().reverse();
  if (PV_ANO !== 'tudo' && !anos.includes(PV_ANO)) PV_ANO = anos[0];
  const xs = S.proventos.filter((p) => PV_ANO === 'tudo' || p.data.startsWith(PV_ANO));
  const total = round2(xs.reduce((s, p) => s + Number(p.valor || 0), 0));
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
  const pctDe = (v) => `${((v / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: v / total < 0.1 ? 1 : 0 })}%`;
  return `
    <section class="bloco pv-resumo">
      <div class="bloco-cab">
        <div><h2>Proventos ${PV_ANO === 'tudo' ? 'desde o início' : `em ${PV_ANO}`}</h2>
          <small class="sub-cab"><b class="pv-total">${R(total)}</b>${xs.length > 1 ? ` · ${xs.length} pagamentos` : ''}</small></div>
        <div class="seg" role="group" aria-label="Ano">${[...anos.slice(0, 3), 'tudo'].map((a) => `<button type="button" data-pv-ano="${a}" aria-pressed="${PV_ANO === a}">${a === 'tudo' ? 'Tudo' : a}</button>`).join('')}</div>
      </div>

      ${barraTipos(por, total)}
      <div class="pv-tipos">
        ${tipos.map((k) => `<div class="pv-tipo"><i class="sw pv-${k}"></i><span>${esc(TIPOS_PROVENTO[k].replace(' (FII)', ''))}</span><b class="num">${R(por[k])}</b><small>${pctDe(por[k])}</small></div>`).join('')}
      </div>
      ${semTipo.length ? `<p class="aviso pv-aviso"><b>${R(semTipo.reduce((s, p) => s + Number(p.valor), 0))}</b> vieram da planilha antiga só com o total do mês, sem ativo nem tipo. Com o informe de rendimentos do banco dá para separar.</p>` : ''}

      <div class="pv-ativos">
        <h3>Por ativo</h3>
        ${ativos.map(([t, a]) => `<div class="pv-ativo">
          <div class="cc-linha"><b>${esc(t)}</b><span class="num">${R(a.total)}</span></div>
          <div class="pv-mini" style="width:${Math.max(4, (a.total / maior) * 100)}%">${barraTipos(a.tipos, a.total)}</div>
          <small>${TIPOS_PROV_ORDEM.filter((k) => a.tipos[k] > 0).map((k) => `${esc(TIPOS_PROVENTO[k])} ${R(a.tipos[k])}`).join(' · ')}</small>
        </div>`).join('')}
      </div>
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
    if (ano) { PV_ANO = ano.dataset.pvAno; const sec = $('.pv-resumo'); if (sec) sec.outerHTML = htmlResumoProventos(); return; }
    if (e.target.closest('[data-del-prov]')) return;
    const b = e.target.closest('[data-edit-prov]');
    if (b) abrirEditarProvento(b.dataset.editProv);
  });
  raiz.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card-prov')) { e.preventDefault(); abrirEditarProvento(e.target.dataset.editProv); }
  });
  ligarRemover('data-del-prov', 'proventos');
}

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
          <select id="aj-banco">${S.bancos.map((b) => `<option value="${esc(b.id)}" ${b.id === banco().id ? 'selected' : ''}>${esc(b.nome)}</option>`).join('')}</select>
          <span class="sub">usado para calcular as taxas</span>
        </label>
        <label class="campo"><span>Aporte mensal padrão</span>
          <input id="aj-aporte" class="num" inputmode="decimal" value="${Number(S.ajustes.aporteMensal).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">já aparece preenchido todo mês</span>
        </label>
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
            <td>${esc(b.nome)}</td>
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
  let mudou = false;
  for (const c of S.compras) {
    if (tem.has(c.ticker)) continue;
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
