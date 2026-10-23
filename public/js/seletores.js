// Seletores no tema do app: troca a lista nativa dos <select> e o calendário nativo dos
// <input type="date"> por versões próprias, iguais no celular e no computador
// (a data também pode ser digitada, e o calendário escolhe mês e ano direto).
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

function abrirPainel(gatilho, conteudo, { classe = '', aoFechar, ancora = gatilho } = {}) {
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
    const r = ancora.getBoundingClientRect();
    const largura = painel.classList.contains('cal') ? 304 : Math.max(r.width, 200); // o calendário tem tamanho próprio, não estica com o campo
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
// Vira um campo onde se digita dd/mm/aaaa (as barras entram sozinhas) com o calendário ao lado.
// No calendário, tocar no título troca para a escolha do mês e, de novo, para a do ano.
const MESES_CURTOS = MESES.map((m) => m.slice(0, 3));
const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());

/** "05/03/2024", "5/3/2024" ou "2024-03-05" → "2024-03-05" (null se não for uma data de verdade). */
function lerData(txt) {
  const s = String(txt || '').trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const [d, mo, a] = m ? [m[1], m[2], m[3]] : (m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)) ? [m[3], m[2], m[1]] : [];
  if (!a) return null;
  const dt = new Date(Number(a), Number(mo) - 1, Number(d));
  return dt.getFullYear() === Number(a) && dt.getMonth() === Number(mo) - 1 && dt.getDate() === Number(d) ? iso(dt) : null;
}

/** Põe as barras enquanto se digita: "0503" → "05/03", "05032024" → "05/03/2024". */
function mascara(txt) {
  const n = txt.replace(/\D/g, '').slice(0, 8);
  return n.length > 4 ? `${n.slice(0, 2)}/${n.slice(2, 4)}/${n.slice(4)}` : n.length > 2 ? `${n.slice(0, 2)}/${n.slice(2)}` : n;
}

function melhorarData(inp) {
  if (inp.dataset.tema) return;
  inp.dataset.tema = '1';
  const rotulo = inp.getAttribute('aria-label') || inp.closest('label')?.querySelector('span')?.textContent || 'Data';
  const caixa = document.createElement('span');
  caixa.className = 'data-campo';
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.className = 'data-txt';
  txt.inputMode = 'numeric';
  txt.autocomplete = 'off';
  txt.placeholder = 'dd/mm/aaaa';
  txt.maxLength = 10;
  txt.setAttribute('aria-label', `${rotulo} (dd/mm/aaaa)`);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'data-abrir';
  btn.innerHTML = CAL;
  btn.setAttribute('aria-label', `Abrir calendário: ${rotulo}`);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.setAttribute('aria-expanded', 'false');
  inp.before(caixa);
  caixa.append(inp, txt, btn);
  inp.classList.add('sel-nativo');
  inp.tabIndex = -1;
  inp.setAttribute('aria-hidden', 'true');
  // tocar no rótulo leva o foco para onde se digita
  inp.closest('label')?.addEventListener('click', (e) => {
    if (e.target.closest('button, a, input, select')) return;
    e.preventDefault();
    txt.focus();
  });

  const pintar = () => { txt.value = dataBR(inp.value); caixa.classList.remove('invalida'); txt.removeAttribute('aria-invalid'); txt.title = ''; };
  vigiarValor(inp, pintar);
  inp.addEventListener('change', pintar);
  pintar();

  const foraDoLimite = (d) => (inp.min && d < inp.min ? `A data mínima é ${dataBR(inp.min)}.` : inp.max && d > inp.max ? `A data máxima é ${dataBR(inp.max)}.` : '');
  const gravar = (d) => {
    if (inp.value !== d) {
      inp.value = d;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    pintar();
  };
  const marcarErro = (msg) => { caixa.classList.add('invalida'); txt.setAttribute('aria-invalid', 'true'); txt.title = msg; };
  /** Lê o que foi digitado; final = saiu do campo (aí volta ao valor anterior se não der). */
  const conferir = (final) => {
    const d = lerData(txt.value);
    if (d && !foraDoLimite(d)) { gravar(d); return true; }
    if (!final) { if (txt.value.length === 10) marcarErro(d ? foraDoLimite(d) : 'Essa data não existe.'); return false; }
    if (!txt.value.trim() && !inp.required) gravar('');
    else pintar();
    return false;
  };

  txt.addEventListener('input', (e) => {
    caixa.classList.remove('invalida');
    const cru = txt.value;
    const apagando = e.inputType?.startsWith('delete');
    const noFim = txt.selectionStart === cru.length;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cru) && !apagando && noFim) txt.value = mascara(cru);
    if (txt.value.length === 10) conferir(false);
  });
  txt.addEventListener('blur', () => conferir(true));
  txt.addEventListener('focus', () => txt.select());
  txt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); conferir(true); }
    else if (e.key === 'Escape' && txt.value !== dataBR(inp.value)) { e.preventDefault(); e.stopPropagation(); pintar(); }
    else if ((e.key === 'ArrowDown' && e.altKey) || e.key === 'F4') { e.preventDefault(); abrir(); }
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && inp.value) {
      // setas sobem e descem um dia
      e.preventDefault();
      const [y, m, dd] = inp.value.split('-').map(Number);
      const d = iso(new Date(y, m - 1, dd + (e.key === 'ArrowUp' ? 1 : -1)));
      if (!foraDoLimite(d)) gravar(d);
    }
  });

  const abrir = () => {
    conferir(true);
    const min = inp.min || '', max = inp.max || '';
    const valido = (d) => (!min || d >= min) && (!max || d <= max);
    const sel = inp.value || '';
    const base = sel || (max && hoje() > max ? max : min && hoje() < min ? min : hoje());
    let ano = Number(base.slice(0, 4)), mes = Number(base.slice(5, 7)) - 1;
    let foco = sel || base;
    let vista = 'dias'; // 'dias' | 'meses' | 'anos'

    const cal = document.createElement('div');
    cal.className = 'sel-cal';
    cal.setAttribute('role', 'dialog');
    cal.setAttribute('aria-label', rotulo);

    const anoMin = min ? Number(min.slice(0, 4)) : -Infinity, anoMax = max ? Number(max.slice(0, 4)) : Infinity;
    const mesOk = (a, m) => (!min || iso(new Date(a, m + 1, 0)) >= min) && (!max || iso(new Date(a, m, 1)) <= max);
    const inicioAnos = () => ano - (((ano % 12) + 12) % 12);

    const htmlDias = () => {
      const primeiro = new Date(ano, mes, 1);
      const inicio = new Date(ano, mes, 1 - primeiro.getDay());
      const dias = Array.from({ length: 42 }, (_, i) => new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i));
      const semanas = dias.slice(35).every((d) => d.getMonth() !== mes) ? 5 : 6; // corta a última semana quando ela é toda do mês seguinte
      const h = hoje();
      return `<div class="cal-grade" role="grid">
          ${DIAS.map((d) => `<span class="cal-dsem" aria-hidden="true">${d}</span>`).join('')}
          ${dias.slice(0, semanas * 7).map((d) => {
            const s = iso(d);
            const cls = [d.getMonth() !== mes ? 'fora' : '', s === h ? 'hoje' : '', s === sel ? 'sel' : ''].join(' ');
            return `<button type="button" class="cal-dia ${cls}" data-d="${s}" tabindex="${s === foco ? 0 : -1}" aria-label="${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}" ${s === sel ? 'aria-pressed="true"' : ''} ${valido(s) ? '' : 'disabled'}>${d.getDate()}</button>`;
          }).join('')}
        </div>`;
    };
    const htmlMeses = () => `<div class="cal-grade-g">${MESES_CURTOS.map((m, i) => {
      const cls = [i === mes ? 'sel' : '', ano === new Date().getFullYear() && i === new Date().getMonth() ? 'hoje' : ''].join(' ');
      return `<button type="button" class="cal-mes ${cls}" data-mes="${i}" aria-label="${MESES[i]} de ${ano}" ${mesOk(ano, i) ? '' : 'disabled'}>${cap(m)}</button>`;
    }).join('')}</div>`;
    const htmlAnos = () => {
      const a0 = inicioAnos();
      return `<div class="cal-grade-g">${Array.from({ length: 12 }, (_, i) => a0 + i).map((a) => {
        const cls = [a === ano ? 'sel' : '', a === new Date().getFullYear() ? 'hoje' : ''].join(' ');
        return `<button type="button" class="cal-mes ${cls}" data-ano="${a}" ${a < anoMin || a > anoMax ? 'disabled' : ''}>${a}</button>`;
      }).join('')}</div>`;
    };

    const desenhar = (focar) => {
      const a0 = inicioAnos();
      const [titulo, antOk, proxOk, rotAnt, rotProx] = vista === 'dias'
        ? [`${cap(MESES[mes])} de ${ano}`, mesOk(mes ? ano : ano - 1, (mes + 11) % 12), mesOk(mes === 11 ? ano + 1 : ano, (mes + 1) % 12), 'Mês anterior', 'Próximo mês']
        : vista === 'meses'
          ? [String(ano), ano - 1 >= anoMin, ano + 1 <= anoMax, 'Ano anterior', 'Próximo ano']
          : [`${a0} – ${a0 + 11}`, a0 - 1 >= anoMin, a0 + 12 <= anoMax, 'Anos anteriores', 'Próximos anos'];
      cal.innerHTML = `
        ${celular() ? `<div class="sel-titulo">${esc(rotulo)}</div>` : ''}
        <div class="cal-cab">
          <button type="button" class="cal-nav" data-nav="-1" aria-label="${rotAnt}" ${antOk ? '' : 'disabled'}>${ANT}</button>
          <button type="button" class="cal-titulo" data-vista ${vista === 'anos' ? 'disabled' : ''} aria-label="${vista === 'dias' ? 'Escolher mês e ano' : 'Escolher o ano'}">${titulo}${vista === 'anos' ? '' : SETA}</button>
          <button type="button" class="cal-nav" data-nav="1" aria-label="${rotProx}" ${proxOk ? '' : 'disabled'}>${PROX}</button>
        </div>
        ${vista === 'dias' ? htmlDias() : vista === 'meses' ? htmlMeses() : htmlAnos()}
        <div class="cal-rodape">
          ${vista === 'dias' ? '' : '<button type="button" class="cal-hoje cal-voltar" data-voltar>Voltar aos dias</button>'}
          <button type="button" class="cal-hoje" data-d="${hoje()}" ${valido(hoje()) ? '' : 'disabled'}>Hoje</button>
        </div>`;
      if (!focar) return;
      const alvo = vista === 'dias' ? cal.querySelector(`[data-d="${foco}"].cal-dia`) : cal.querySelector('.cal-mes.sel:not(:disabled)') || cal.querySelector('.cal-mes:not(:disabled)');
      alvo?.focus({ preventScroll: true });
    };

    const ir = (s) => {
      foco = s;
      ano = Number(s.slice(0, 4)); mes = Number(s.slice(5, 7)) - 1;
      desenhar(true);
    };

    desenhar(false);
    const { painel, fechar } = abrirPainel(btn, cal, { classe: 'cal', ancora: caixa });
    (cal.querySelector('.cal-dia.sel') || cal.querySelector('.cal-dia.hoje:not(:disabled)') || cal.querySelector('.cal-dia:not(.fora):not(:disabled)'))?.focus({ preventScroll: true });

    painel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.nav) {
        const passo = Number(b.dataset.nav);
        if (vista === 'dias') {
          mes += passo;
          if (mes < 0) { mes = 11; ano--; } else if (mes > 11) { mes = 0; ano++; }
          foco = iso(new Date(ano, mes, 1));
        } else ano += vista === 'meses' ? passo : passo * 12;
        desenhar(false);
      } else if (b.hasAttribute('data-vista')) {
        vista = vista === 'dias' ? 'meses' : 'anos';
        desenhar(true);
      } else if (b.hasAttribute('data-voltar')) {
        vista = 'dias';
        desenhar(true);
      } else if (b.dataset.ano) {
        ano = Number(b.dataset.ano);
        vista = 'meses';
        desenhar(true);
      } else if (b.dataset.mes) {
        mes = Number(b.dataset.mes);
        vista = 'dias';
        // mantém o dia escolhido no novo mês, se der
        const dia = Math.min(Number((sel || base).slice(8, 10)), new Date(ano, mes + 1, 0).getDate());
        foco = iso(new Date(ano, mes, dia));
        desenhar(true);
      } else if (b.dataset.d) {
        gravar(b.dataset.d);
        fechar({ devolverFoco: false });
        if (!celular()) txt.focus({ preventScroll: true });
      }
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
