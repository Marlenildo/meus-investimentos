// Seletores no tema do app: troca a lista nativa dos <select> e o calendário nativo dos
// <input type="date"> por versões próprias, iguais no celular e no computador.
// O elemento original continua na página (escondido) com o mesmo id, valor e eventos,
// então o resto do app lê e escreve nele como sempre.

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const SETA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const CAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const ANT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const PROX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hoje = () => iso(new Date());
const dataBR = (s) => (s ? s.split('-').reverse().join('/') : '');
const celular = () => matchMedia('(max-width: 600px)').matches;

/** Ícone de uma opção (logo do banco…): HTML montado pelo próprio app em data-icone. */
const icone = (o) => o?.dataset?.icone || '';

/** Faz o `.value = x` do código continuar atualizando o botão visível. */
function vigiarValor(el, aoMudar) {
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return desc.get.call(this); },
    set(v) { desc.set.call(this, v); aoMudar(); },
  });
}

// ---------- painel flutuante (lista ou calendário) ----------
let aberto = null; // { painel, gatilho, fechar }

function fecharAberto() {
  if (aberto) aberto.fechar();
}

function abrirPainel(gatilho, conteudo, { classe = '', aoFechar } = {}) {
  fecharAberto();
  const raiz = gatilho.closest('dialog') || document.body; // dentro de um diálogo, o painel fica na mesma camada
  const fundo = document.createElement('div');
  fundo.className = 'sel-fundo';
  const painel = document.createElement('div');
  painel.className = `sel-painel ${classe}`;
  painel.setAttribute('role', 'presentation');
  painel.append(conteudo);
  raiz.append(fundo, painel);

  const posicionar = () => {
    if (celular()) { painel.classList.add('folha'); painel.style.cssText = ''; return; }
    painel.classList.remove('folha');
    const r = gatilho.getBoundingClientRect();
    const largura = Math.max(r.width, painel.classList.contains('cal') ? 300 : 200);
    let left = Math.min(r.left, innerWidth - largura - 12);
    left = Math.max(12, left);
    const alt = painel.offsetHeight;
    const abaixo = innerHeight - r.bottom - 12;
    const top = abaixo >= alt || abaixo >= r.top ? r.bottom + 6 : Math.max(12, r.top - alt - 6);
    painel.style.cssText = `left:${left}px;top:${top}px;width:${largura}px;max-height:${Math.max(160, abaixo >= alt || abaixo >= r.top ? abaixo : r.top - 18)}px`;
  };
  posicionar();
  requestAnimationFrame(() => { painel.classList.add('visivel'); fundo.classList.add('visivel'); });

  const aoRolar = (e) => { if (!painel.contains(e.target)) fechar(); };
  const aoTeclar = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fechar(); }
  };
  function fechar({ devolverFoco = true } = {}) {
    if (!aberto || aberto.painel !== painel) return;
    aberto = null;
    painel.remove(); fundo.remove();
    removeEventListener('resize', posicionar);
    removeEventListener('scroll', aoRolar, true);
    document.removeEventListener('keydown', aoTeclar, true);
    gatilho.setAttribute('aria-expanded', 'false');
    if (devolverFoco) gatilho.focus({ preventScroll: true });
    aoFechar?.();
  }
  fundo.addEventListener('click', () => fechar());
  addEventListener('resize', posicionar);
  addEventListener('scroll', aoRolar, true);
  document.addEventListener('keydown', aoTeclar, true);
  gatilho.setAttribute('aria-expanded', 'true');
  aberto = { painel, gatilho, fechar };
  return { painel, fechar };
}

/** Tocar no rótulo leva o foco para o botão, não para o campo escondido. */
function ligarRotulo(el, btn) {
  el.closest('label')?.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select')) return;
    e.preventDefault();
    btn.focus();
  });
}

// ---------- <select> ----------
function melhorarSelect(sel) {
  if (sel.dataset.tema || sel.multiple || sel.size > 1) return;
  sel.dataset.tema = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `sel-btn ${sel.className}`;
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const rotulo = sel.getAttribute('aria-label') || sel.closest('label')?.querySelector('span')?.textContent || '';
  if (rotulo) btn.setAttribute('aria-label', rotulo);
  sel.after(btn);
  ligarRotulo(sel, btn);
  sel.classList.add('sel-nativo');
  sel.tabIndex = -1;
  sel.setAttribute('aria-hidden', 'true');

  const pintar = () => {
    const op = sel.options[sel.selectedIndex];
    btn.innerHTML = `${icone(op)}<span class="sel-txt">${esc(op ? op.text : '')}</span>${SETA}`;
    btn.disabled = sel.disabled;
  };
  vigiarValor(sel, pintar);
  sel.addEventListener('change', pintar);
  new MutationObserver(pintar).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  pintar();

  const escolher = (i) => {
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    pintar();
  };

  const abrir = () => {
    const lista = document.createElement('div');
    lista.className = 'sel-lista';
    lista.setAttribute('role', 'listbox');
    if (rotulo) lista.setAttribute('aria-label', rotulo);
    const ops = [...sel.options];
    lista.innerHTML = (rotulo && celular() ? `<div class="sel-titulo">${esc(rotulo)}</div>` : '')
      + ops.map((o, i) => `<button type="button" role="option" class="sel-op" data-i="${i}" aria-selected="${i === sel.selectedIndex}" ${o.disabled ? 'disabled' : ''}><span>${icone(o)}${esc(o.text)}</span>${i === sel.selectedIndex ? CHECK : ''}</button>`).join('');
    const { painel, fechar } = abrirPainel(btn, lista, { classe: 'lista' });
    const botoes = [...painel.querySelectorAll('.sel-op')];
    const atual = botoes[sel.selectedIndex] || botoes[0];
    atual?.focus({ preventScroll: true });
    atual?.scrollIntoView({ block: 'nearest' });
    painel.addEventListener('click', (e) => {
      const b = e.target.closest('.sel-op');
      if (!b || b.disabled) return;
      escolher(Number(b.dataset.i));
      fechar();
    });
    painel.addEventListener('keydown', (e) => {
      const i = botoes.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const passo = e.key === 'ArrowDown' ? 1 : -1;
        let j = i;
        do { j = (j + passo + botoes.length) % botoes.length; } while (botoes[j].disabled && j !== i);
        botoes[j].focus();
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        (e.key === 'Home' ? botoes[0] : botoes[botoes.length - 1]).focus();
      } else if (e.key === 'Tab') {
        fechar({ devolverFoco: false });
      }
    });
  };
  btn.addEventListener('click', abrir);
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); abrir(); }
  });
}

// ---------- <input type="date"> ----------
function melhorarData(inp) {
  if (inp.dataset.tema) return;
  inp.dataset.tema = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sel-btn sel-data';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  const rotulo = inp.getAttribute('aria-label') || inp.closest('label')?.querySelector('span')?.textContent || 'Data';
  btn.setAttribute('aria-label', rotulo);
  inp.after(btn);
  ligarRotulo(inp, btn);
  inp.classList.add('sel-nativo');
  inp.tabIndex = -1;
  inp.setAttribute('aria-hidden', 'true');

  const pintar = () => {
    btn.innerHTML = `${CAL}<span class="sel-txt">${inp.value ? dataBR(inp.value) : '<span class="apagado">dd/mm/aaaa</span>'}</span>`;
  };
  vigiarValor(inp, pintar);
  inp.addEventListener('change', pintar);
  inp.addEventListener('input', pintar);
  pintar();

  const abrir = () => {
    const min = inp.min || '', max = inp.max || '';
    const valido = (d) => (!min || d >= min) && (!max || d <= max);
    let sel = inp.value || '';
    const base = sel || (max && hoje() > max ? max : hoje());
    let ano = Number(base.slice(0, 4)), mes = Number(base.slice(5, 7)) - 1;
    let foco = sel || base;

    const cal = document.createElement('div');
    cal.className = 'sel-cal';
    cal.setAttribute('role', 'dialog');
    cal.setAttribute('aria-label', rotulo);

    const desenhar = (focar) => {
      const primeiro = new Date(ano, mes, 1);
      const inicio = new Date(ano, mes, 1 - primeiro.getDay());
      const dias = [];
      for (let i = 0; i < 42; i++) {
        const d = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i);
        dias.push(d);
      }
      // corta a última semana quando ela é toda do mês seguinte
      const semanas = dias.slice(35).every((d) => d.getMonth() !== mes) ? 5 : 6;
      const h = hoje();
      const antOk = !min || iso(new Date(ano, mes, 0)) >= min;
      const proxOk = !max || iso(new Date(ano, mes + 1, 1)) <= max;
      cal.innerHTML = `
        ${celular() ? `<div class="sel-titulo">${esc(rotulo)}</div>` : ''}
        <div class="cal-cab">
          <button type="button" class="cal-nav" data-nav="-1" aria-label="Mês anterior" ${antOk ? '' : 'disabled'}>${ANT}</button>
          <b>${MESES[mes].replace(/^./, (c) => c.toUpperCase())} de ${ano}</b>
          <button type="button" class="cal-nav" data-nav="1" aria-label="Próximo mês" ${proxOk ? '' : 'disabled'}>${PROX}</button>
        </div>
        <div class="cal-grade" role="grid">
          ${DIAS.map((d) => `<span class="cal-dsem" aria-hidden="true">${d}</span>`).join('')}
          ${dias.slice(0, semanas * 7).map((d) => {
            const s = iso(d);
            const cls = [d.getMonth() !== mes ? 'fora' : '', s === h ? 'hoje' : '', s === sel ? 'sel' : ''].join(' ');
            return `<button type="button" class="cal-dia ${cls}" data-d="${s}" tabindex="${s === foco ? 0 : -1}" aria-label="${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}" ${s === sel ? 'aria-pressed="true"' : ''} ${valido(s) ? '' : 'disabled'}>${d.getDate()}</button>`;
          }).join('')}
        </div>
        <div class="cal-rodape">
          <button type="button" class="cal-hoje" data-d="${h}" ${valido(h) ? '' : 'disabled'}>Hoje</button>
        </div>`;
      if (focar) cal.querySelector(`[data-d="${foco}"].cal-dia`)?.focus({ preventScroll: true });
    };

    const ir = (s) => {
      foco = s;
      ano = Number(s.slice(0, 4)); mes = Number(s.slice(5, 7)) - 1;
      desenhar(true);
    };

    desenhar(false);
    const { painel, fechar } = abrirPainel(btn, cal, { classe: 'cal' });
    (cal.querySelector('.cal-dia.sel') || cal.querySelector('.cal-dia.hoje:not(:disabled)') || cal.querySelector('.cal-dia:not(.fora):not(:disabled)'))?.focus({ preventScroll: true });

    painel.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        mes += Number(nav.dataset.nav);
        if (mes < 0) { mes = 11; ano--; } else if (mes > 11) { mes = 0; ano++; }
        foco = iso(new Date(ano, mes, 1));
        desenhar(false);
        return;
      }
      const d = e.target.closest('[data-d]');
      if (!d || d.disabled) return;
      sel = d.dataset.d;
      if (inp.value !== sel) {
        inp.value = sel;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      fechar();
    });
    painel.addEventListener('keydown', (e) => {
      const d = document.activeElement?.dataset?.d;
      if (!d || !document.activeElement.classList.contains('cal-dia')) return;
      const passos = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
      if (passos[e.key] != null) {
        e.preventDefault();
        const [y, m, dd] = d.split('-').map(Number);
        ir(iso(new Date(y, m - 1, dd + passos[e.key])));
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        const [y, m, dd] = d.split('-').map(Number);
        ir(iso(new Date(y, m - 1 + (e.key === 'PageDown' ? 1 : -1), dd)));
      }
    });
  };
  btn.addEventListener('click', abrir);
}

// ---------- aplica em tudo que aparecer na página ----------
function melhorar(raiz) {
  raiz.querySelectorAll?.('select').forEach(melhorarSelect);
  raiz.querySelectorAll?.('input[type="date"]').forEach(melhorarData);
}

melhorar(document);
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) {
    if (n.matches?.('select')) melhorarSelect(n);
    else if (n.matches?.('input[type="date"]')) melhorarData(n);
    else melhorar(n);
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// um diálogo que fecha leva junto o painel aberto dentro dele
document.addEventListener('close', (e) => {
  if (aberto && e.target.contains?.(aberto.painel)) aberto.fechar({ devolverFoco: false });
}, true);
