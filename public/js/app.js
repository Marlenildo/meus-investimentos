import {
  TIPOS, TIPOS_PROVENTO, round2, normalizaQtd, passoDe, resumoPlano, linhaPlano, qtdMaxima, avisoMinimo,
  mesAnterior, mesDe, hojeISO, somaProventosMes, proventosPorTipo, carteira, resumoPorPeriodo, estimarCompra, precoTesouroEm,
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
  if (!ativo.preco) return { txt: ativo.tipo === 'tesouro' ? 'preço do site do Tesouro' : 'toque para digitar', cls: '' };
  if (st?.erro) return { txt: 'sem atualização', cls: 'velho' };
  if (!ativo.precoEm) return { txt: '', cls: '' };
  const d = new Date(ativo.precoEm);
  const min = Math.round((Date.now() - d) / 60000);
  const manual = ativo.fonte === 'manual' ? ' · manual' : '';
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

function htmlOrdem(a, pos) {
  const q = Number(S.plano.qtds[a.id]) || 0;
  const f = frescor(a);
  const passo = passoDe(a);
  return `
    <div class="ordem ${q > 0 ? 'tem-qtd' : ''}" data-id="${a.id}">
      <div class="ordem-ativo">
        <div class="linha1"><span class="tk" title="${esc(a.nome || a.ticker)}">${esc(a.ticker)}</span><span class="chip ${a.tipo}">${esc(TIPOS[a.tipo]?.nome || a.tipo)}</span></div>
        ${htmlPosicao(pos)}
      </div>
      <div class="ordem-preco">
        <input class="preco-input num" data-preco="${a.id}" inputmode="decimal" aria-label="Preço de ${esc(a.ticker)}" value="${fmtPreco(a.preco)}" placeholder="preço">
        <span class="frescor ${f.cls}" data-frescor="${a.id}">${esc(f.txt)}</span>
      </div>
      <div class="ordem-qtd">
        <div class="qtd">
          <button type="button" data-menos="${a.id}" aria-label="Menos ${esc(a.ticker)}">−</button>
          <input type="number" id="q-${a.id}" data-qtd="${a.id}" min="0" step="${passo}" inputmode="${passo === 1 ? 'numeric' : 'decimal'}" value="${q || ''}" placeholder="0" aria-label="Quantidade de ${esc(a.ticker)} para comprar">
          <button type="button" data-mais="${a.id}" aria-label="Mais ${esc(a.ticker)}">+</button>
          <button type="button" class="max" data-max="${a.id}" title="Usar o que falta">MÁX</button>
        </div>
      </div>
      <div class="ordem-total" data-total="${a.id}"></div>
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
  const ordem = [...S.ativos].sort((x, y) => (cart.porTicker.get(y.ticker)?.qtd ? 1 : 0) - (cart.porTicker.get(x.ticker)?.qtd ? 1 : 0));
  return `
    <section class="bloco">
      <div class="campos">
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
          <button type="button" class="btn peq" id="btn-dividir" title="Divide o valor igualmente entre os ativos">Dividir igual</button>
          <button type="button" class="btn peq" id="btn-limpar">Zerar</button>
          <button type="button" class="icone-btn ${atualizando ? 'girando' : ''}" id="btn-cotacoes" title="Atualizar preços" aria-label="Atualizar preços">${ICONE_ATUALIZAR}</button>
        </div>
      </div>
      ${N.nuvem.estado === 'local' && !S.ajustes.token ? `<p class="aviso"><b>Preços manuais:</b> ${esc(N.nuvem.mensagem || '')} Toque no preço para digitar.</p>` : ''}
      ${ordem.length ? `<div class="ordens">${ordem.map((a) => htmlOrdem(a, cart.porTicker.get(a.ticker))).join('')}</div>` : '<p class="dica">Sua lista está vazia. Adicione o primeiro ativo.</p>'}
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
// ---------- quanto investi: por dia, mês ou ano ----------
const PERIODO_KEY = 'meus-investimentos:periodo';
let periodo = (() => { try { return localStorage.getItem(PERIODO_KEY) || 'mes'; } catch { return 'mes'; } })();
const rotuloCurto = (chave, per) => per === 'ano' ? chave : per === 'mes' ? mesCurto(chave) : `${chave.slice(8, 10)}/${chave.slice(5, 7)}`;
const rotuloLongo = (chave, per) => per === 'ano' ? chave : per === 'mes' ? nomeMesAno(chave).replace(/^./, (c) => c.toUpperCase()) : dataBR(chave);

function graficoPeriodo(linhas, per) {
  const pts = linhas.slice(-12);
  if (!pts.length) return '';
  const W = 640, H = 230, pl = 64, pr = 12, pt = 14, pb = 30;
  const maxV = Math.max(...pts.map((p) => p.total), 1);
  const passoY = niceStep(maxV / 4);
  const topo = Math.ceil(maxV / passoY) * passoY;
  const y = (v) => pt + (H - pt - pb) * (1 - v / topo);
  const bw = (W - pl - pr) / pts.length;
  const ticks = [];
  for (let v = 0; v <= topo + 1e-6; v += passoY) ticks.push(v);
  const curto = (v) => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('pt-BR');
  const cx = (i) => pl + i * bw + bw / 2;
  return `
    <svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Quanto investi em cada período">
      <defs><linearGradient id="grad-barra" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
      ${ticks.map((v) => `<line class="grade" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${curto(v)}</text>`).join('')}
      ${pts.map((p, i) => `<rect class="barra-g" x="${pl + i * bw + bw * 0.2}" y="${y(p.total)}" width="${bw * 0.6}" height="${Math.max(0, y(0) - y(p.total))}" rx="4"><title>${rotuloLongo(p.chave, per)}: ${R(p.total)}</title></rect>
        <text x="${cx(i)}" y="${H - 9}" text-anchor="middle">${rotuloCurto(p.chave, per)}</text>`).join('')}
    </svg>`;
}

function htmlQuantoInvesti() {
  const linhas = resumoPorPeriodo(S.compras, S.proventos, periodo);
  const tem = (k) => linhas.some((l) => l[k] > 0);
  const cols = [['acao', 'Ações'], ['fii', 'FIIs'], ['tesouro', 'Tesouro'], ['outros', 'ETF/BDR']].filter(([k]) => tem(k));
  const soma = (k) => round2(linhas.reduce((s, l) => s + l[k], 0));
  const nomePer = { dia: 'dia', mes: 'mês', ano: 'ano' }[periodo];
  return `
    <section class="bloco" id="quanto-investi">
      <div class="bloco-cab">
        <h2>Quanto investi por ${nomePer}</h2>
        <div class="seg" role="group" aria-label="Agrupar por">
          ${[['dia', 'Dia'], ['mes', 'Mês'], ['ano', 'Ano']].map(([k, n]) => `<button type="button" data-periodo="${k}" aria-pressed="${periodo === k}">${n}</button>`).join('')}
        </div>
      </div>
      ${graficoPeriodo(linhas, periodo)}
      <div class="tabela-wrap"><table>
        <thead><tr><th>${nomePer[0].toUpperCase() + nomePer.slice(1)}</th>${cols.map(([, n]) => `<th class="r">${n}</th>`).join('')}<th class="r">Total investido</th><th class="r">Proventos</th><th class="r">Acumulado</th></tr></thead>
        <tbody>${[...linhas].reverse().map((l) => `<tr>
          <td>${rotuloLongo(l.chave, periodo)}</td>
          ${cols.map(([k]) => `<td class="r num">${l[k] ? R(l[k]) : '<span class="apagado">—</span>'}</td>`).join('')}
          <td class="r num"><b>${R(l.total)}</b></td>
          <td class="r num">${l.proventos ? R(l.proventos) : '<span class="apagado">—</span>'}</td>
          <td class="r num">${R(l.acumulado)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td>${cols.map(([k]) => `<td class="r num">${R(soma(k))}</td>`).join('')}<td class="r num">${R(soma('total'))}</td><td class="r num">${R(soma('proventos'))}</td><td></td></tr></tfoot>
      </table></div>
    </section>`;
}

function ligarHistorico() {
  ligarRemover('data-del-compra', 'compras');
  $('#conteudo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-periodo]');
    if (!b) return;
    periodo = b.dataset.periodo;
    try { localStorage.setItem(PERIODO_KEY, periodo); } catch { /* sem armazenamento */ }
    $('#quanto-investi').outerHTML = htmlQuantoInvesti();
  });
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

    ${htmlQuantoInvesti()}


    <section class="bloco">
      <h2>Compras</h2>
      ${[...porMes.entries()].map(([mes, xs], i) => `
        <details class="mes-grupo" ${i === 0 ? 'open' : ''}>
          <summary class="mes-cab"><span>${nomeMesAno(mes).replace(/^./, (c) => c.toUpperCase())}</span><span class="num">${R(xs.reduce((s, x) => s + x.qtd * x.preco + (x.custo || 0), 0))}</span></summary>
          ${xs.map((x) => `<div class="item">
            <span><b>${esc(x.ticker)}</b> · ${fmtQtd(x.qtd)} ${x.tipo === 'tesouro' ? 'tít.' : 'cotas'} × ${R(x.preco)}<small>${x.importado ? `${nomeMesAno(mes)} · da planilha, quantidade estimada` : `${dataBR(x.data)} · ${esc(banco(x.banco)?.nome || x.banco || '')}`}</small></span>
            <span class="num">${R(x.qtd * x.preco + (x.custo || 0))}</span>
            <button type="button" class="x" data-del-compra="${x.id}" aria-label="Remover compra de ${esc(x.ticker)}">remover</button>
          </div>`).join('')}
        </details>`).join('')}
    </section>`;
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
      const original = b.textContent;
      b.classList.add('confirmar');
      b.textContent = colecao === 'ativos' ? 'tirar?' : 'confirmar?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('confirmar'); b.textContent = original; } }, 3000);
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
function renderProventos() {
  const tickers = [...new Set([...S.ativos.map((a) => a.ticker), ...S.compras.map((c) => c.ticker)])];
  const ano = String(new Date().getFullYear());
  const doAno = proventosPorTipo(S.proventos, (p) => p.data.startsWith(ano));
  const totalAno = Object.values(doAno).reduce((s, v) => s + v, 0);
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

    <section class="bloco">
      <div class="bloco-cab"><h2>Em ${ano}</h2><span class="num"><b>${R(totalAno)}</b></span></div>
      ${totalAno ? `<div class="por-tipo">${Object.entries(doAno).map(([k, v]) => `<div><small>${esc(TIPOS_PROVENTO[k] || k)}</small><span class="num">${R(v)}</span></div>`).join('')}</div>` : `<p class="dica">Nenhum provento lançado em ${ano} ainda.</p>`}
    </section>

    ${S.proventos.length ? `<section class="bloco"><h2>Recebidos</h2>
      ${[...porMes.entries()].map(([mes, xs]) => `
        <div class="mes-grupo">
          <div class="mes-cab"><span>${nomeMesAno(mes)}</span><span class="num">${R(xs.reduce((s, x) => s + Number(x.valor), 0))}</span></div>
          ${xs.map((x) => `<div class="item">
            <span><b>${esc(x.ticker)}</b> · ${esc(TIPOS_PROVENTO[x.tipo] || x.tipo)}<small>${dataBR(x.data)}</small></span>
            <span class="num">${R(x.valor)}</span>
            <button type="button" class="x" data-del-prov="${x.id}" aria-label="Remover provento de ${esc(x.ticker)}">remover</button>
          </div>`).join('')}
        </div>`).join('')}</section>` : ''}`;
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
    return j.meses || {};
  } catch { return {}; }
}

async function lerPlanilha(file, avisar) {
  let dados;
  try { dados = JSON.parse(await file.text()); } catch { throw new Error('Esse arquivo não é o planilha-acoes.json.'); }
  if (dados?.formato !== 'meus-investimentos/planilha') throw new Error('Esse arquivo não é o planilha-acoes.json.');
  const tickers = [...new Set(dados.acoes.map((c) => c.ticker))];
  const hist = {};
  for (const [i, t] of tickers.entries()) {
    avisar(`Buscando preços de ${t} (${i + 1} de ${tickers.length})…`);
    hist[t] = N.nuvem.servidor ? await historicoMensal(t) : {};
  }
  const compras = [], semPreco = [];
  for (const c of dados.acoes) {
    const est = estimarCompra(c.valor, hist[c.ticker]?.[c.mes] || PRECO_SEM_HISTORICO[c.ticker]);
    if (!est) { semPreco.push(c); continue; }
    compras.push({ id: `pl${c.ticker}${c.mes.replace('-', '')}`.toLowerCase(), data: `${c.mes}-15`, ticker: c.ticker, tipo: c.tipo, qtd: est.qtd, preco: est.preco, custo: est.custo, banco: dados.banco || 'nubank', importado: true });
  }
  const tes = S.ativos.find((a) => a.tipo === 'tesouro');
  const tesTicker = tes?.ticker || 'Tesouro Selic 2031';
  const tesPreco = tes?.preco || 20010.2;
  for (const t of dados.tesouro || []) {
    const p = precoTesouroEm(t.mes, tesPreco, mesDe(hojeISO()));
    const qtd = Math.round((t.valor / p) * 10000) / 10000;
    const preco = Math.round((t.valor / qtd) * 10000) / 10000;
    compras.push({ id: `pltesouro${t.mes.replace('-', '')}`, data: `${t.mes}-15`, ticker: tesTicker, tipo: 'tesouro', qtd, preco, custo: round2(t.valor - qtd * preco), banco: dados.banco || 'nubank', importado: true });
  }
  const proventos = (dados.proventos || []).map((p) => ({ id: `plprov${p.mes.replace('-', '')}`, data: `${p.mes}-15`, ticker: 'Vários', tipo: 'outro', valor: p.valor }));
  return { compras, proventos, semPreco, tesTicker };
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
      <p class="dica">As cotas são estimadas pelo preço de cada mês (corrigido por desdobramentos). No Tesouro, a quantidade vem do preço do ${esc(res.tesTicker)} trazido para cada mês pela Selic. As compras ficam marcadas como “da planilha” no Histórico, e você pode corrigir qualquer uma.${res.semPreco.length ? ` <b>${res.semPreco.length} compras ficaram de fora</b> por falta de preço do mês.` : ''}</p>
      <div class="acoes"><span class="esp"></span><button class="btn" value="cancelar" formnovalidate>Cancelar</button><button class="btn prim" value="ok">Salvar no app</button></div>
    </form>`;
  dlg.oninput = null;
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const ids = new Set(res.compras.map((c) => c.id));
    const idsP = new Set(res.proventos.map((p) => p.id));
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
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
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
