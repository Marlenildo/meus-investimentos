import {
  TIPOS, TIPOS_PROVENTO, round2, normalizaQtd, passoDe, resumoPlano, linhaPlano, qtdMaxima, avisoMinimo,
  mesAnterior, mesDe, hojeISO, somaProventosMes, proventosPorTipo, carteira, aportesPorMes,
} from './calc.js';
import { carregar, salvar, exportar, importar, resetar, uid, BANCOS_PADRAO } from './store.js';
import { atualizarTodas, buscarCotacao } from './cotacoes.js';

// ---------- estado ----------
let S = carregar();
const statusCotacao = {}; // ativoId -> {erro?, variacao?}
let atualizando = false;

const persist = () => { if (!salvar(S)) toast('Não consegui salvar neste navegador. Faça um backup em Ajustes.'); };

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
  if (st?.erro) return { txt: st.erro, cls: 'erro' };
  if (!ativo.preco) return { txt: ativo.tipo === 'tesouro' ? 'digite o preço do site do Tesouro' : 'sem cotação', cls: 'erro' };
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

// ---------- topo ----------
function renderBancos() {
  const sel = $('#banco');
  sel.innerHTML = S.bancos.map((b) => `<option value="${esc(b.id)}">${esc(b.nome)}</option>`).join('');
  sel.value = banco().id;
}
$('#banco').addEventListener('change', (e) => {
  S.ajustes.banco = e.target.value;
  persist();
  render();
});

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

// ---------- aba Comprar ----------
function htmlOrdem(a) {
  const q = Number(S.plano.qtds[a.id]) || 0;
  const f = frescor(a);
  const st = statusCotacao[a.id];
  const varTxt = st?.variacao != null ? ` <span class="${st.variacao >= 0 ? 'var-alta' : 'var-baixa'}">${pct(st.variacao / 100)}</span>` : '';
  const passo = passoDe(a);
  return `
    <div class="ordem ${q > 0 ? 'tem-qtd' : ''}" data-id="${a.id}">
      <div class="ordem-ativo">
        <div class="linha1"><span class="tk">${esc(a.ticker)}</span><span class="chip ${a.tipo}">${esc(TIPOS[a.tipo]?.nome || a.tipo)}</span></div>
        <small title="${esc(a.nome)}">${esc(a.nome || '')}</small>
      </div>
      <div class="ordem-preco">
        <input class="preco-input num" data-preco="${a.id}" inputmode="decimal" aria-label="Preço de ${esc(a.ticker)}" value="${a.preco ? a.preco.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''}" placeholder="R$ 0,00">
        <span class="frescor ${f.cls}">${esc(f.txt)}${varTxt}</span>
      </div>
      <div class="ordem-qtd">
        <div class="qtd">
          <button type="button" data-menos="${a.id}" aria-label="Menos ${esc(a.ticker)}">−</button>
          <input type="number" id="q-${a.id}" data-qtd="${a.id}" min="0" step="${passo}" inputmode="${passo === 1 ? 'numeric' : 'decimal'}" value="${q || ''}" placeholder="0" aria-label="Quantidade de ${esc(a.ticker)}">
          <button type="button" data-mais="${a.id}" aria-label="Mais ${esc(a.ticker)}">+</button>
          <button type="button" class="max" data-max="${a.id}" title="Preencher com o que falta usar">MÁX</button>
        </div>
      </div>
      <div class="ordem-total" data-total="${a.id}"></div>
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
      ? `<span class="num">${R(l.valor)}</span><small>${aviso ? `<span class="warn">${esc(aviso)}</span>` : l.custo ? `+ ${R(l.custo)} custos` : 'sem custo'}</small>`
      : `<span class="num" style="color:var(--tinta-3)">—</span>`;
    el.closest('.ordem').classList.toggle('tem-qtd', q > 0);
  }
  const r = resumo();
  const box = $('#custos');
  if (box) {
    box.innerHTML = `
      <div class="ln"><span>Ativos (${r.ordens} ${r.ordens === 1 ? 'ordem' : 'ordens'})</span><span class="num">${R(r.bruto)}</span></div>
      <div class="ln"><span>Custos no ${esc(b.nome)} <small>(corretagem + taxas B3)</small></span><span class="num">${R(r.custos)}</span></div>
      <div class="ln total"><span>Total a investir</span><span class="num">${R(r.total)}</span></div>`;
    const comp = S.bancos.map((bk) => ({ bk, c: resumo(bk).custos })).sort((x, y) => x.c - y.c);
    $('#comparar').innerHTML = r.ordens ? `<small style="width:100%">Custos desta compra em cada banco:</small>` + comp.map(({ bk, c }) =>
      `<span class="${bk.id === b.id ? 'atual' : ''}">${esc(bk.nome)} <b class="num">${R(c)}</b></span>`).join('') : '';
    $('#btn-registrar').disabled = r.ordens === 0;
  }
  renderBoleta();
}

function renderComprar() {
  const mesAnt = mesAnterior(S.plano.mes);
  const auto = proventosAuto();
  const manual = S.plano.proventosManual != null;
  const semToken = !S.ajustes.token;
  return `
    <section class="bloco">
      <div class="bloco-cab"><h2>Compra de ${nomeMesAno(S.plano.mes)}</h2></div>
      <div class="campos">
        <label class="campo"><span>Aporte do mês</span>
          <input id="in-aporte" class="num" inputmode="decimal" value="${aporteMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">Padrão: ${R(S.ajustes.aporteMensal)} · muda em Ajustes</span>
        </label>
        <label class="campo"><span>+ Proventos para reinvestir</span>
          <input id="in-proventos" class="num" inputmode="decimal" value="${proventosMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 })}">
          <span class="sub">${manual ? `Valor digitado · <button type="button" id="prov-auto">usar ${R(auto)} de ${nomeMes(mesAnt)}</button>` : `Recebidos em ${nomeMes(mesAnt)} · <a href="#proventos">lançar</a>`}</span>
        </label>
        <div class="disp"><span>= Disponível para investir</span><span class="num" id="disp">${R(disponivel())}</span></div>
      </div>
    </section>

    <section class="bloco">
      <div class="bloco-cab">
        <h2>Quanto comprar de cada</h2>
        <div class="acoes">
          <button type="button" class="btn peq" id="btn-cotacoes" ${atualizando ? 'disabled' : ''}>${atualizando ? 'Atualizando…' : 'Atualizar cotações'}</button>
          <button type="button" class="btn peq" id="btn-limpar">Zerar quantidades</button>
        </div>
      </div>
      ${semToken ? `<p class="aviso"><b>Cotações automáticas:</b> sem token só a PETR4 atualiza. Crie um token grátis em <a href="https://brapi.dev/dashboard" target="_blank" rel="noopener">brapi.dev</a> e cole em <a href="#ajustes">Ajustes</a>. Enquanto isso, você pode digitar o preço tocando nele.</p>` : ''}
      ${S.ativos.length ? `<div class="ordens">${S.ativos.map(htmlOrdem).join('')}</div>` : `<div class="vazio"><p>Nenhum ativo na sua lista.</p><a class="btn" href="#ajustes">Adicionar ativos</a></div>`}
    </section>

    <section class="bloco">
      <div class="custos" id="custos"></div>
      <div class="comparar" id="comparar"></div>
      <div class="acoes">
        <span class="dica">As compras você faz no app do banco. Depois, registre aqui para acompanhar a carteira.</span>
        <span class="esp"></span>
        <button type="button" class="btn prim" id="btn-registrar">Registrar compras</button>
      </div>
    </section>`;
}

function ligarComprar() {
  const main = $('#conteudo');
  const atualizarDisp = () => { $('#disp').textContent = R(disponivel()); renderBoleta(); };

  $('#in-aporte').addEventListener('change', (e) => {
    const v = num(e.target.value);
    S.plano.aporte = Number.isFinite(v) ? Math.max(0, v) : null;
    e.target.value = aporteMes().toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    persist(); atualizarDisp();
  });
  $('#in-proventos').addEventListener('change', (e) => {
    const v = num(e.target.value);
    S.plano.proventosManual = Number.isFinite(v) ? Math.max(0, v) : null;
    persist(); render();
  });
  $('#prov-auto')?.addEventListener('click', () => { S.plano.proventosManual = null; persist(); render(); });
  $('#btn-cotacoes').addEventListener('click', atualizarCotacoes);
  $('#btn-limpar').addEventListener('click', () => { S.plano.qtds = {}; persist(); render(); });
  $('#btn-registrar').addEventListener('click', abrirRegistrar);

  const setQtd = (id, q, repintarInput = true) => {
    const a = S.ativos.find((x) => x.id === id);
    q = normalizaQtd(a, q);
    if (q > 0) S.plano.qtds[id] = q; else delete S.plano.qtds[id];
    if (repintarInput) $(`#q-${id}`).value = q || '';
    persist(); pintarTotais();
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
      }
      persist();
      const f = frescor(a);
      const fr = e.target.parentElement.querySelector('.frescor');
      fr.className = `frescor ${f.cls}`; fr.textContent = f.txt;
      e.target.value = a.preco ? a.preco.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
      pintarTotais();
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
      if (!a.preco) { toast(`Informe o preço de ${a.ticker} primeiro.`); return; }
      const rest = disponivel() - resumo(b).total;
      const q = qtdMaxima(a, Number(S.plano.qtds[id]) || 0, rest, b);
      setQtd(id, q);
      if (!q) toast(`Não sobra dinheiro para ${a.ticker}.`);
    }
  });
  pintarTotais();
}

async function atualizarCotacoes() {
  if (atualizando) return;
  atualizando = true;
  if (location.hash.replace('#', '') === 'comprar' || !location.hash) render();
  const { ok, erros, total } = await atualizarTodas(S.ativos, S.ajustes.token, (a, q, err) => {
    if (q) {
      a.preco = q.preco; a.precoEm = q.em; a.fonte = 'brapi';
      if (!a.nome && q.nome) a.nome = q.nome;
      statusCotacao[a.id] = { variacao: q.variacao };
    } else {
      statusCotacao[a.id] = { erro: err.message };
    }
  });
  atualizando = false;
  persist();
  render();
  if (!total) toast('Nenhum ativo de bolsa na lista.');
  else if (!erros.length) toast(`${ok} cotações atualizadas.`);
  else toast(`${ok} de ${total} atualizadas. ${erros.some((x) => x.msg === 'precisa de token') ? 'Falta o token da brapi em Ajustes.' : 'Veja os avisos na lista.'}`);
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
    for (const x of xs) {
      S.compras.push({ id: uid(), data, ticker: x.ativo.ticker, tipo: x.ativo.tipo, qtd: x.qtd, preco: x.preco, custo: x.custo, banco: x.banco });
    }
    S.plano.qtds = {};
    persist();
    toast(`${xs.length} ${xs.length === 1 ? 'compra registrada' : 'compras registradas'}.`);
    render();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

// ---------- aba Carteira ----------
function graficoAportes(serie) {
  const ult = serie.slice(-12);
  if (!ult.length) return '';
  let acum = 0;
  const antes = serie.slice(0, -12).reduce((s, x) => s + x.valor, 0);
  acum = antes;
  const pts = ult.map((x) => ({ ...x, acum: (acum += x.valor) }));
  const W = 640, H = 220, pl = 64, pr = 12, pt = 14, pb = 28;
  const maxV = Math.max(...pts.map((p) => p.acum), 1);
  const passoY = niceStep(maxV / 4);
  const topo = Math.ceil(maxV / passoY) * passoY;
  const y = (v) => pt + (H - pt - pb) * (1 - v / topo);
  const bw = (W - pl - pr) / pts.length;
  const ticks = [];
  for (let v = 0; v <= topo + 1e-6; v += passoY) ticks.push(v);
  const curto = (v) => v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('pt-BR');
  return `
    <svg class="grafico" viewBox="0 0 ${W} ${H}" role="img" aria-label="Aportes por mês e total acumulado">
      ${ticks.map((v) => `<line class="grade" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end">${curto(v)}</text>`).join('')}
      ${pts.map((p, i) => `<rect class="barra-g" x="${pl + i * bw + bw * 0.2}" y="${y(p.valor)}" width="${bw * 0.6}" height="${Math.max(0, y(0) - y(p.valor))}" rx="2"><title>${mesCurto(p.mes)}: ${R(p.valor)}</title></rect>
        <text x="${pl + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${mesCurto(p.mes)}</text>`).join('')}
      <polyline class="acum" points="${pts.map((p, i) => `${pl + i * bw + bw / 2},${y(p.acum)}`).join(' ')}"/>
      ${pts.map((p, i) => `<circle class="acum-pt" cx="${pl + i * bw + bw / 2}" cy="${y(p.acum)}" r="${i === pts.length - 1 ? 4 : 2.5}"><title>Acumulado: ${R(p.acum)}</title></circle>`).join('')}
    </svg>
    <div class="legenda"><span><i></i>Aporte no mês</span><span><i class="l"></i>Total investido acumulado</span></div>`;
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x, 1))));
  const m = x / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function renderCarteira() {
  if (!S.compras.length) {
    return `<section class="bloco"><div class="vazio"><h2>Sua carteira aparece aqui</h2><p>Depois de comprar no banco, toque em <b>Registrar compras</b> na aba Comprar. Aqui você vê cotas, preço médio, quanto investiu e o retorno.</p><a class="btn prim" href="#comprar">Ir para Comprar</a></div></section>`;
  }
  const c = carteira(S.compras, S.ativos, S.proventos);
  const cls = (v) => (v == null ? '' : v >= 0 ? 'var-alta' : 'var-baixa');
  const serie = aportesPorMes(S.compras);
  const porMes = groupBy([...S.compras].sort((a, b) => b.data.localeCompare(a.data)), (x) => mesDe(x.data));
  return `
    <div class="kpis">
      <div class="kpi"><small>Investido</small><span class="num">${R(c.investido)}</span></div>
      <div class="kpi"><small>Valor hoje</small><span class="num">${R(c.valorAtual)}</span></div>
      <div class="kpi"><small>Resultado</small><span class="num ${cls(c.resultado)}">${R(c.resultado)}</span><small class="${cls(c.resultado)}">${pct(c.investido ? c.resultado / c.investido : null)}</small></div>
      <div class="kpi"><small>Proventos recebidos</small><span class="num">${R(c.proventos)}</span></div>
    </div>

    <section class="bloco">
      <div class="bloco-cab"><h2>Posição por ativo</h2><small>Valor hoje usa a última cotação da aba Comprar</small></div>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ativo</th><th class="r">Cotas</th><th class="r">Preço médio</th><th class="r">Investido</th><th class="r">Valor hoje</th><th class="r">Resultado</th><th class="r">Proventos</th></tr></thead>
        <tbody>${c.linhas.map((l) => `<tr>
          <td><b>${esc(l.ticker)}</b> <span class="chip ${l.tipo}">${esc(TIPOS[l.tipo]?.nome || '')}</span></td>
          <td class="r num">${fmtQtd(l.qtd)}</td>
          <td class="r num">${R(l.precoMedio)}</td>
          <td class="r num">${R(l.investido)}</td>
          <td class="r num">${l.valorAtual == null ? '—' : R(l.valorAtual)}</td>
          <td class="r num ${cls(l.resultado)}">${l.resultado == null ? '—' : `${R(l.resultado)}<br><small class="${cls(l.resultado)}">${pct(l.resultadoPct)}</small>`}</td>
          <td class="r num">${R(l.proventos)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    <section class="bloco">
      <h2>Aportes ao longo do tempo</h2>
      ${graficoAportes(serie)}
    </section>

    <section class="bloco">
      <h2>Histórico de compras</h2>
      ${[...porMes.entries()].map(([mes, xs]) => `
        <div class="mes-grupo">
          <div class="mes-cab"><span>${nomeMesAno(mes)}</span><span class="num">${R(xs.reduce((s, x) => s + x.qtd * x.preco + (x.custo || 0), 0))}</span></div>
          ${xs.map((x) => `<div class="item">
            <span><b>${esc(x.ticker)}</b> · ${fmtQtd(x.qtd)} × ${R(x.preco)}<small>${dataBR(x.data)} · ${esc(banco(x.banco)?.nome || x.banco || '')}${x.custo ? ` · custos ${R(x.custo)}` : ''}</small></span>
            <span class="num">${R(x.qtd * x.preco + (x.custo || 0))}</span>
            <button type="button" class="x" data-del-compra="${x.id}" aria-label="Remover compra de ${esc(x.ticker)}">remover</button>
          </div>`).join('')}
        </div>`).join('')}
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
      b.classList.add('confirmar');
      b.textContent = 'confirmar?';
      setTimeout(() => { if (b.isConnected) { b.classList.remove('confirmar'); b.textContent = 'remover'; } }, 3000);
      return;
    }
    const id = b.getAttribute(attr);
    S[colecao] = S[colecao].filter((x) => x.id !== id);
    persist(); render(); toast('Removido.');
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
        <button class="btn prim" type="submit">Lançar</button>
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
    S.proventos.push({ id: uid(), data: $('#pv-data').value, ticker: sel.value, tipo: tipo.value, valor: round2(v) });
    persist(); render(); toast('Provento lançado.');
  });
  ligarRemover('data-del-prov', 'proventos');
}

// ---------- aba Ajustes ----------
function renderAjustes() {
  const pctTxt = (f) => (Number(f || 0) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
  return `
    <section class="bloco">
      <h2>Aporte e cotações</h2>
      <div class="campos">
        <label class="campo"><span>Aporte mensal padrão (R$)</span><input id="aj-aporte" class="num" inputmode="decimal" value="${Number(S.ajustes.aporteMensal).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}"></label>
        <label class="campo" style="grid-column: span 2"><span>Token da brapi.dev</span><input id="aj-token" type="password" autocomplete="off" value="${esc(S.ajustes.token)}" placeholder="cole aqui o token gratuito"></label>
      </div>
      <p class="dica">O token é grátis em <a href="https://brapi.dev/dashboard" target="_blank" rel="noopener">brapi.dev/dashboard</a> (15 mil consultas por mês, atraso de ~30 min). Fica salvo só neste navegador. Tesouro Direto não tem cotação automática: copie o preço de compra do <a href="https://www.tesourodireto.com.br/titulos/precos-e-taxas.htm" target="_blank" rel="noopener">site do Tesouro</a> e digite na aba Comprar.</p>
    </section>

    <section class="bloco">
      <div class="bloco-cab"><h2>Meus ativos</h2><small>${S.ativos.length} na lista de compra</small></div>
      <form id="form-ativo" class="campos">
        <label class="campo"><span>Código</span><input id="at-ticker" placeholder="ex.: ITSA4 ou Tesouro IPCA+ 2035" required></label>
        <label class="campo"><span>Tipo</span><select id="at-tipo">${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}">${v.nome}</option>`).join('')}</select></label>
        <label class="campo"><span>Nome (opcional)</span><input id="at-nome" placeholder="ex.: Itaúsa PN"></label>
        <button class="btn prim" type="submit">Adicionar</button>
      </form>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Ativo</th><th>Tipo</th><th>Nome</th><th></th></tr></thead>
        <tbody>${S.ativos.map((a, i) => `<tr>
          <td><b>${esc(a.ticker)}</b></td><td><span class="chip ${a.tipo}">${esc(TIPOS[a.tipo]?.nome || a.tipo)}</span></td><td>${esc(a.nome || '')}</td>
          <td class="r"><button type="button" class="x" data-subir="${i}" aria-label="Subir ${esc(a.ticker)}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="x" data-del-ativo="${a.id}">remover</button></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="dica">Remover um ativo da lista não apaga as compras já registradas dele.</p>
    </section>

    <section class="bloco">
      <h2>Custos por banco</h2>
      <p class="dica">Valores de referência de outubro/2026: a maioria dos bancos não cobra corretagem em ações e FIIs pelo app, e a B3 cobra 0,03% (liquidação + negociação). Tesouro Direto não tem taxa na compra; a B3 cobra 0,20% ao ano de custódia, com isenção no Tesouro Selic até R$ 10 mil. Confira as taxas do seu banco e ajuste.</p>
      <div class="tabela-wrap"><table>
        <thead><tr><th>Banco</th><th class="r">Corretagem por ordem (R$)</th><th class="r">Taxa B3 (%)</th><th class="r">Taxa Tesouro na compra (%)</th></tr></thead>
        <tbody>${S.bancos.map((b) => `<tr>
          <td>${esc(b.nome)}${b.id === S.ajustes.banco ? ' <small>(atual)</small>' : ''}</td>
          <td class="r"><input class="num preco-input" style="text-align:right" data-bk="${b.id}" data-campo="corretagem" inputmode="decimal" value="${Number(b.corretagem).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}" aria-label="Corretagem ${esc(b.nome)}"></td>
          <td class="r"><input class="num preco-input" style="text-align:right" data-bk="${b.id}" data-campo="taxaB3" inputmode="decimal" value="${pctTxt(b.taxaB3)}" aria-label="Taxa B3 ${esc(b.nome)}"></td>
          <td class="r"><input class="num preco-input" style="text-align:right" data-bk="${b.id}" data-campo="taxaTesouro" inputmode="decimal" value="${pctTxt(b.taxaTesouro)}" aria-label="Taxa Tesouro ${esc(b.nome)}"></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="acoes"><button type="button" class="btn peq" id="bk-padrao">Voltar aos valores de referência</button></div>
    </section>

    <section class="bloco">
      <h2>Backup</h2>
      <p class="dica">Seus dados ficam só neste navegador. Exporte um backup de vez em quando e importe para usar em outro aparelho.</p>
      <div class="acoes">
        <button type="button" class="btn" id="bk-exportar">Exportar backup</button>
        <label class="btn" for="bk-importar">Importar backup</label>
        <input type="file" id="bk-importar" accept="application/json,.json" hidden>
        <span class="esp"></span>
        <button type="button" class="btn perigo" id="bk-apagar">Apagar tudo</button>
      </div>
    </section>`;
}

function ligarAjustes() {
  $('#aj-aporte').addEventListener('change', (e) => {
    const v = num(e.target.value);
    if (Number.isFinite(v) && v >= 0) S.ajustes.aporteMensal = v;
    e.target.value = Number(S.ajustes.aporteMensal).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    persist(); renderBoleta(); toast('Aporte padrão salvo.');
  });
  $('#aj-token').addEventListener('change', async (e) => {
    S.ajustes.token = e.target.value.trim();
    persist();
    if (!S.ajustes.token) return;
    try { await buscarCotacao('BBAS3', S.ajustes.token); toast('Token funcionando.'); }
    catch (err) { toast(`Token salvo, mas a brapi respondeu: ${err.message}.`); }
  });
  $('#form-ativo').addEventListener('submit', (e) => {
    e.preventDefault();
    const tipo = $('#at-tipo').value;
    let ticker = $('#at-ticker').value.trim();
    if (tipo !== 'tesouro') ticker = ticker.toUpperCase().replace(/\s+/g, '');
    if (!ticker) return;
    if (S.ativos.some((a) => a.ticker.toLowerCase() === ticker.toLowerCase())) { toast(`${ticker} já está na lista.`); return; }
    const novo = { id: uid(), ticker, tipo, nome: $('#at-nome').value.trim() || (tipo === 'tesouro' ? ticker : ''), preco: null, precoEm: null, fonte: null };
    S.ativos.push(novo);
    persist(); render(); toast(`${ticker} adicionado.`);
    if (tipo !== 'tesouro') buscarCotacao(ticker, S.ajustes.token).then((q) => {
      novo.preco = q.preco; novo.precoEm = q.em; novo.fonte = 'brapi'; if (!novo.nome && q.nome) novo.nome = q.nome; persist();
      if (location.hash === '#ajustes') render();
    }).catch(() => {});
  });
  $('#conteudo').addEventListener('click', (e) => {
    const s = e.target.closest('[data-subir]');
    if (s) { const i = Number(s.dataset.subir); [S.ativos[i - 1], S.ativos[i]] = [S.ativos[i], S.ativos[i - 1]]; persist(); render(); }
  });
  ligarRemover('data-del-ativo', 'ativos');
  $('#conteudo').addEventListener('change', (e) => {
    const id = e.target.dataset.bk;
    if (!id) return;
    const b = S.bancos.find((x) => x.id === id);
    const v = num(e.target.value);
    if (Number.isFinite(v) && v >= 0) b[e.target.dataset.campo] = e.target.dataset.campo === 'corretagem' ? v : v / 100;
    persist(); render();
  });
  $('#bk-padrao').addEventListener('click', () => {
    const extras = S.bancos.filter((b) => !BANCOS_PADRAO.some((p) => p.id === b.id));
    S.bancos = [...BANCOS_PADRAO.map((b) => ({ ...b })), ...extras];
    persist(); render(); toast('Custos de referência restaurados.');
  });
  $('#bk-exportar').addEventListener('click', () => exportar(S));
  $('#bk-importar').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { S = await importar(f); persist(); renderBancos(); render(); toast('Backup importado.'); }
    catch (err) { toast(err.message || 'Não consegui ler esse arquivo.'); }
  });
  const apagar = $('#bk-apagar');
  apagar.addEventListener('click', () => {
    if (!apagar.dataset.ok) { apagar.dataset.ok = '1'; apagar.textContent = 'Tem certeza? Toque de novo'; setTimeout(() => { if (apagar.isConnected) { delete apagar.dataset.ok; apagar.textContent = 'Apagar tudo'; } }, 4000); return; }
    S = resetar(); persist(); renderBancos(); render(); toast('Dados apagados.');
  });
}

// ---------- roteamento ----------
const ABAS = {
  comprar: [renderComprar, ligarComprar],
  carteira: [renderCarteira, () => ligarRemover('data-del-compra', 'compras')],
  proventos: [renderProventos, ligarProventos],
  ajustes: [renderAjustes, ligarAjustes],
};

function render() {
  const aba = ABAS[location.hash.slice(1)] ? location.hash.slice(1) : 'comprar';
  document.querySelectorAll('.abas a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === aba));
  // troca o <main> para descartar listeners antigos
  const velho = $('#conteudo');
  const novo = velho.cloneNode(false);
  velho.replaceWith(novo);
  const [html, ligar] = ABAS[aba];
  novo.innerHTML = html();
  ligar();
  renderBoleta();
}

window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });

renderBancos();
render();

// atualiza sozinho ao abrir se tiver token e a última cotação for antiga (> 15 min)
const precisa = S.ativos.some((a) => a.tipo !== 'tesouro' && (!a.precoEm || Date.now() - new Date(a.precoEm) > 15 * 60000));
if (S.ajustes.token && precisa) atualizarCotacoes();
else if (!S.ajustes.token && precisa) {
  // sem token: só tenta os ativos liberados na brapi
  const livres = S.ativos.filter((a) => ['PETR4', 'VALE3', 'ITUB4', 'MGLU3'].includes(a.ticker));
  if (livres.length) atualizarTodas(livres, '', (a, q) => { if (q) { a.preco = q.preco; a.precoEm = q.em; a.fonte = 'brapi'; statusCotacao[a.id] = { variacao: q.variacao }; } })
    .then(() => { persist(); if (!location.hash || location.hash === '#comprar') render(); });
}
