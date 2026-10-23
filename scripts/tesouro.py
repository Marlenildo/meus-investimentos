"""Monta os dados do Tesouro Direto usados pelo app (Comprar e Simular).

Fontes, todas públicas:
- Planilhas "Histórico de preços e taxas" do Tesouro Direto (cdn.tesouro.gov.br): taxa e PU de compra e de venda
  de cada título, todo dia útil, desde 2004. O Tesouro atualiza essas planilhas de tempos em tempos.
- Arquivo diário de títulos públicos da ANBIMA (anbima.com.br, últimos ~5 dias úteis): taxa e PU de mercado.
  Fica guardado dia a dia aqui e cobre os dias que as planilhas do Tesouro ainda não trazem.

Dias depois da última planilha do Tesouro: o preço é calculado com a taxa do título de referência na ANBIMA
(mesmo vencimento, ou o mais próximo do mesmo indexador) e com o valor do índice (Selic ou IPCA) tirado da própria
ANBIMA. Entre a última planilha e o primeiro dia guardado da ANBIMA, taxa e índice são interpolados.
Todos esses dias ficam marcados como estimados.

Uso: python scripts/tesouro.py <pasta de saída>   (a pasta guarda o estado entre uma execução e outra)
"""
import bisect
import datetime as dt
import json
import math
import os
import statistics
import sys
import time
import urllib.request

import xlrd

CDN = 'https://cdn.tesouro.gov.br/sistemas-internos/apex/producao/sistemas/sistd/{ano}/{arq}_{ano}.xls'
ANBIMA = 'https://www.anbima.com.br/informacoes/merc-sec/arqs/ms{d}.txt'
UA = 'Mozilla/5.0 (compatible; meus-investimentos/1.0; +https://github.com/Marlenildo/meus-investimentos)'
PRIMEIRO_ANO = 2004

# arquivo da planilha -> tipo usado no app
ARQUIVOS = {'LFT': 'LFT', 'LTN': 'LTN', 'NTN-F': 'NTNF', 'NTN-B_Principal': 'NTNBP', 'NTN-B': 'NTNB', 'NTN-B1': 'NTNB1'}
INDEXADOR = {'LFT': 'selic', 'LTN': 'pre', 'NTNF': 'pre', 'NTNBP': 'ipca', 'NTNB': 'ipca', 'NTNB1': 'ipca'}
CUPOM_NTNF = 1000 * (math.sqrt(1.10) - 1)  # 10% ao ano, pago a cada semestre sobre R$ 1.000
CUPOM_NTNB = math.sqrt(1.06) - 1  # 6% ao ano sobre o VNA, a cada semestre


def nome_titulo(tipo, venc):
    a = int(venc[:4])
    if tipo == 'LFT': return f'Tesouro Selic {a}'
    if tipo == 'LTN': return f'Tesouro Prefixado {a}'
    if tipo == 'NTNF': return f'Tesouro Prefixado com Juros Semestrais {a}'
    if tipo == 'NTNBP': return f'Tesouro IPCA+ {a}'
    if tipo == 'NTNB': return f'Tesouro IPCA+ com Juros Semestrais {a}'
    # NTN-B1: Renda+ paga 240 meses (vence 19 anos depois do ano de conversão); Educa+ paga 60 meses (vence 4 anos depois)
    if a >= 2049 and (a - 2049) % 5 == 0: return f'Tesouro Renda+ Aposentadoria Extra {a - 19}'
    return f'Tesouro Educa+ {a - 4}'


# ---------- calendário de dias úteis (feriados nacionais, como a ANBIMA) ----------
def pascoa(a):
    b, c = divmod(a, 100)
    d, e = divmod(b, 4)
    g = (8 * b + 13) // 25
    h = (19 * (a % 19) + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a % 19 + 11 * h + 22 * l) // 451
    mes, dia = divmod(h + l - 7 * m + 114, 31)
    return dt.date(a, mes, dia + 1)


_feriados = {}


def feriados(a):
    if a not in _feriados:
        p = pascoa(a)
        fs = {dt.date(a, m, d) for m, d in [(1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (12, 25)]}
        if a >= 2024: fs.add(dt.date(a, 11, 20))
        fs |= {p - dt.timedelta(48), p - dt.timedelta(47), p - dt.timedelta(2), p + dt.timedelta(60)}
        _feriados[a] = fs
    return _feriados[a]


def util(d):
    return d.weekday() < 5 and d not in feriados(d.year)


_INI = dt.date(2000, 1, 1)
_acum = [0]  # _acum[i] = dias úteis de _INI até _INI + i (excluído)
for _i in range(0, 100 * 366):
    _acum.append(_acum[-1] + (1 if util(_INI + dt.timedelta(_i)) else 0))


def du(a, b):
    """Dias úteis de a (incluído) até b (excluído)."""
    if b <= a: return 0
    return _acum[(b - _INI).days] - _acum[(a - _INI).days]


def uteis_entre(a, b):
    """Dias úteis depois de a, até b (incluído)."""
    out, d = [], a + dt.timedelta(1)
    while d <= b:
        if util(d): out.append(d)
        d += dt.timedelta(1)
    return out


D = dt.date.fromisoformat
S = lambda d: d.isoformat()


# ---------- fluxos de cada título (para precificar pela taxa) ----------
def datas_cupom(tipo, venc):
    """Datas de pagamento de juros (semestrais) até o vencimento, inclusive."""
    v = D(venc)
    if tipo == 'NTNF':
        meses = (1, 7)
    elif tipo == 'NTNB':
        meses = (5, 11) if v.month in (5, 11) else (2, 8)
    else:
        return []
    out = []
    for a in range(2000, v.year + 1):
        for m in meses:
            x = dt.date(a, m, v.day)
            if x <= v: out.append(x)
    return out


def fluxos(tipo, venc, d):
    """[(dias úteis até o pagamento, valor por unidade de índice)] dos pagamentos depois de d."""
    v = D(venc)
    if tipo in ('LFT', 'LTN', 'NTNBP'):
        return [(du(d, v), 1.0)]
    if tipo in ('NTNF', 'NTNB'):
        c = CUPOM_NTNF / 1000 if tipo == 'NTNF' else CUPOM_NTNB
        fs = [(du(d, x), c) for x in datas_cupom(tipo, venc) if x > d]
        if fs: fs[-1] = (fs[-1][0], fs[-1][1] + 1.0)
        return fs
    # NTN-B1: parcelas mensais iguais, de janeiro do ano de conversão até dezembro do vencimento
    anos = 20 if v.year >= 2049 and (v.year - 2049) % 5 == 0 else 5
    ini = v.year - anos + 1
    out = []
    for a in range(ini, v.year + 1):
        for m in range(1, 13):
            x = dt.date(a, m, 15)
            if x > d: out.append((du(d, x), 1.0 / (anos * 12)))
    return out


def desconto(tipo, venc, d, r):
    return sum(f / (1 + r) ** (n / 252) for n, f in fluxos(tipo, venc, d))


# ---------- download ----------
def baixar(url, tentativas=3):
    for i in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404: return None
            if i == tentativas - 1: raise
        except Exception:
            if i == tentativas - 1: raise
        time.sleep(3 * (i + 1))
    return None


def ler_planilha(conteudo):
    """{venc: [[data, taxaCompra, taxaVenda, puCompra, puVenda], ...]} de um arquivo .xls do Tesouro."""
    livro = xlrd.open_workbook(file_contents=conteudo)
    out = {}
    for sh in livro.sheets():
        nome = sh.name.strip()
        if len(nome) < 6 or not nome[-6:].isdigit(): continue
        venc = f'20{nome[-2:]}-{nome[-4:-2]}-{nome[-6:-4]}'
        linhas = []
        for r in range(sh.nrows):
            row = sh.row(r)
            if len(row) < 5: continue
            c0 = row[0]
            if c0.ctype == xlrd.XL_CELL_DATE:
                data = dt.date(*xlrd.xldate_as_tuple(c0.value, livro.datemode)[:3])
            elif c0.ctype == xlrd.XL_CELL_TEXT and len(c0.value.strip()) == 10 and c0.value[2] == '/':
                dd, mm, aa = c0.value.strip().split('/')
                data = dt.date(int(aa), int(mm), int(dd))
            else:
                continue
            vals = []
            for c in row[1:5]:
                if c.ctype in (xlrd.XL_CELL_NUMBER, xlrd.XL_CELL_DATE):
                    vals.append(float(c.value))
                elif c.ctype == xlrd.XL_CELL_TEXT and c.value.strip():
                    try: vals.append(float(c.value.strip().replace('.', '').replace(',', '.')))
                    except ValueError: vals.append(None)
                else:
                    vals.append(None)
            txc, txv, puc, puv = vals
            if not puv: continue
            # taxas vêm em fração (0,1025); planilhas antigas às vezes trazem em % (10,25)
            txc = txc / 100 if txc is not None and abs(txc) > 1 else txc
            txv = txv / 100 if txv is not None and abs(txv) > 1 else txv
            r6 = lambda x: round(x, 6) if x is not None else None
            linhas.append([S(data), r6(txc), r6(txv), puc or None, puv])
        if linhas:
            out.setdefault(venc, []).extend(linhas)
    return out


def ler_anbima(texto, data_arq):
    """{(tipo, venc): (taxa, pu)} do arquivo diário da ANBIMA."""
    out = {}
    conv = {'LFT': 'LFT', 'LTN': 'LTN', 'NTN-F': 'NTNF', 'NTN-B': 'NTNB'}
    for ln in texto.splitlines():
        p = ln.split('@')
        if len(p) < 9 or p[0] not in conv or not p[1].isdigit(): continue
        try:
            venc = f'{p[4][:4]}-{p[4][4:6]}-{p[4][6:8]}'
            taxa = float(p[7].replace(',', '.')) / 100
            pu = float(p[8].replace(',', '.'))
        except ValueError:
            continue
        out[f'{conv[p[0]]}|{venc}'] = [taxa, pu]
    return out


# ---------- principal ----------
def main(pasta):
    hoje = dt.date.today()
    bruto = os.path.join(pasta, 'bruto')
    os.makedirs(bruto, exist_ok=True)

    # 1. planilhas do Tesouro: anos passados ficam guardados; o ano atual (e o anterior, até março) sempre de novo
    for ano in range(PRIMEIRO_ANO, hoje.year + 1):
        for arq, tipo in ARQUIVOS.items():
            dest = os.path.join(bruto, f'{tipo}_{ano}.json')
            recente = ano == hoje.year or (ano == hoje.year - 1 and hoje.month <= 3)
            if os.path.exists(dest) and not recente: continue
            conteudo = baixar(CDN.format(ano=ano, arq=arq))
            if conteudo is None:
                if not os.path.exists(dest): json.dump({}, open(dest, 'w'))
                continue
            dados = ler_planilha(conteudo)
            json.dump(dados, open(dest, 'w'), separators=(',', ':'))
            print(f'{arq} {ano}: {len(dados)} títulos')

    # 2. ANBIMA dos últimos dias, guardada dia a dia
    arq_anb = os.path.join(bruto, 'anbima.json')
    anb = json.load(open(arq_anb)) if os.path.exists(arq_anb) else {}
    for i in range(0, 8):
        d = hoje - dt.timedelta(i)
        if not util(d) or S(d) in anb: continue
        conteudo = baixar(ANBIMA.format(d=d.strftime('%y%m%d')))
        if not conteudo or b'@' not in conteudo: continue
        lido = ler_anbima(conteudo.decode('latin-1'), d)
        if lido:
            anb[S(d)] = lido
            print(f'ANBIMA {d}: {len(lido)} títulos')
    json.dump(dict(sorted(anb.items())), open(arq_anb, 'w'), separators=(',', ':'))

    # 3. junta tudo por título
    series = {}  # (tipo, venc) -> {data: [txc, txv, puc, puv]}
    for nome in sorted(os.listdir(bruto)):
        if nome == 'anbima.json' or not nome.endswith('.json'): continue
        tipo = nome.split('_')[0]
        for venc, linhas in json.load(open(os.path.join(bruto, nome))).items():
            s = series.setdefault((tipo, venc), {})
            for data, txc, txv, puc, puv in linhas:
                s[data] = [txc, txv, puc, puv]
    if not series: raise SystemExit('nenhuma planilha do Tesouro foi lida')
    cdn_ate = max(max(s) for s in series.values())

    # 4. índices (Selic e IPCA) por dia: dos títulos sem cupom do Tesouro e da ANBIMA
    def indice_tesouro(tipo, venc, data, txv, puv):
        n = du(D(data), D(venc))
        return puv * (1 + txv) ** (n / 252) if txv is not None and n > 0 else None

    def indices_anbima(dia):
        sel, ipca = [], []
        for chave, (taxa, pu) in anb.get(dia, {}).items():
            tipo, venc = chave.split('|')
            if D(venc) <= D(dia): continue
            if tipo == 'LFT': sel.append(pu * (1 + taxa) ** (du(D(dia), D(venc)) / 252))
            elif tipo == 'NTNB':
                q = desconto('NTNB', venc, D(dia), taxa)
                if q > 0: ipca.append(pu / q)
        return (statistics.median(sel) if sel else None, statistics.median(ipca) if ipca else None)

    def indice_no_ultimo_dia(indexador):
        tipos = {'selic': ['LFT'], 'ipca': ['NTNBP']}[indexador]
        vals = [indice_tesouro(t, v, cdn_ate, *s[cdn_ate][1:2], s[cdn_ate][3]) for (t, v), s in series.items() if t in tipos and cdn_ate in s]
        vals = [x for x in vals if x]
        return statistics.median(vals) if vals else None

    dias_anb = sorted(d for d in anb if d > cdn_ate)
    idx0 = {'selic': indice_no_ultimo_dia('selic'), 'ipca': indice_no_ultimo_dia('ipca'), 'pre': 1.0}
    idx_anb = {d: dict(zip(('selic', 'ipca'), indices_anbima(d)), pre=1.0) for d in dias_anb}

    def taxa_ref_anbima(tipo, venc, dia):
        """Taxa de mercado do título de referência na ANBIMA: mesmo tipo e vencimento, ou o mais próximo do mesmo indexador."""
        tab = anb.get(dia, {})
        if f'{tipo}|{venc}' in tab: return tipo, venc, tab[f'{tipo}|{venc}'][0]
        alvo = {'NTNBP': 'NTNB', 'NTNB1': 'NTNB', 'NTNF': 'LTN', 'LTN': 'LTN', 'LFT': 'LFT', 'NTNB': 'NTNB'}[tipo]
        cands = [(abs((D(k.split('|')[1]) - D(venc)).days), k) for k in tab if k.startswith(alvo + '|')]
        if not cands: return None
        k = min(cands)[1]
        return alvo, k.split('|')[1], tab[k][0]

    # VNA do IPCA de cada dia, tirado dos Tesouro IPCA+ (sem cupom): vale para os juros do IPCA+ com juros semestrais
    vna_dias = {}
    for (t2, v2), s2 in series.items():
        if t2 != 'NTNBP': continue
        for d2, (_, txv2, _, puv2) in s2.items():
            x = indice_tesouro(t2, v2, d2, txv2, puv2)
            if x: vna_dias.setdefault(d2, []).append(x)
    for d2 in dias_anb:
        if idx_anb[d2].get('ipca'): vna_dias.setdefault(d2, []).append(idx_anb[d2]['ipca'])
    vna_ipca = {d2: statistics.median(v) for d2, v in vna_dias.items()}
    datas_vna = sorted(vna_ipca)

    # 5. estimativa dos dias depois da última planilha
    agora_ate = max(dias_anb) if dias_anb else cdn_ate
    saida = []
    os.makedirs(os.path.join(pasta, 'titulos'), exist_ok=True)
    for (tipo, venc), s in series.items():
        dias = sorted(s)
        ultimo = dias[-1]
        id_ = f'{tipo}-{venc}'
        linhas = [[d, *s[d], 0] for d in dias]
        if ultimo == cdn_ate and D(venc) > D(cdn_ate) and dias_anb:
            txc0, txv0, puc0, puv0 = s[ultimo]
            ind = INDEXADOR[tipo]
            base0 = desconto(tipo, venc, D(ultimo), txv0)
            # diferença entre a taxa do título e a do título de referência, no último dia do Tesouro
            ref0 = taxa_ref_anbima(tipo, venc, dias_anb[0])
            base_ref = 0.0
            if ref0 and (ref0[0] != tipo or ref0[1] != venc):
                sr = series.get((ref0[0], ref0[1]), {}).get(ultimo)
                base_ref = (txv0 - sr[1]) if sr and sr[1] is not None else 0.0
            spread = (txc0 - txv0) if txc0 is not None else 0.0
            razao_pu = (puc0 / puv0) if puc0 else 1.0
            calc = {}
            for dia in dias_anb:
                ref = taxa_ref_anbima(tipo, venc, dia)
                i_t = idx_anb[dia].get(ind)
                if not ref or not i_t or not idx0.get(ind): continue
                r = ref[2] + base_ref
                calc[dia] = (r, i_t)
            if calc:
                primeiro = min(calc)
                r1, i1 = calc[primeiro]
                for d in uteis_entre(D(ultimo), D(agora_ate)):
                    ds = S(d)
                    if D(venc) <= d: break
                    if ds in calc:
                        r, i_t = calc[ds]
                        marca = 1
                    elif ds < primeiro:
                        # entre a última planilha e o primeiro dia da ANBIMA: interpola taxa e índice
                        f = du(D(ultimo), d) / max(1, du(D(ultimo), D(primeiro)))
                        r = txv0 + (r1 - txv0) * f
                        i_t = idx0[ind] * (i1 / idx0[ind]) ** f
                        marca = 2
                    else:
                        continue
                    puv = puv0 * (i_t / idx0[ind]) * desconto(tipo, venc, d, r) / base0
                    if not math.isfinite(puv) or puv <= 0: continue
                    puc = round(puv * razao_pu, 2) if puc0 else None
                    linhas.append([ds, round(r + spread, 6) if txc0 is not None else None, round(r, 6), puc, round(puv, 2), marca])

        # juros semestrais, com o valor por título na data de pagamento
        cupons = []
        if tipo == 'NTNF':
            cupons = [[S(x), round(CUPOM_NTNF, 6)] for x in datas_cupom(tipo, venc) if S(x) >= linhas[0][0]]
        elif tipo == 'NTNB':
            for x in datas_cupom(tipo, venc):
                if S(x) < linhas[0][0]: continue
                i = bisect.bisect_right(datas_vna, S(x)) - 1
                if i < 0: continue
                cupons.append([S(x), round(vna_ipca[datas_vna[i]] * CUPOM_NTNB, 6)])

        linhas.sort(key=lambda l: l[0])
        cupons = [c for c in cupons if c[0] <= linhas[-1][0]]  # juros futuros ainda não têm valor
        json.dump({'id': id_, 'tipo': tipo, 'nome': nome_titulo(tipo, venc), 'venc': venc, 'indexador': INDEXADOR[tipo],
                   'dias': [[l[0], l[1], l[2], l[3], l[4]] + ([l[5]] if l[5] else []) for l in linhas], 'cupons': cupons},
                  open(os.path.join(pasta, 'titulos', f'{id_}.json'), 'w'), separators=(',', ':'))
        u = linhas[-1]
        saida.append({'id': id_, 'tipo': tipo, 'nome': nome_titulo(tipo, venc), 'venc': venc, 'indexador': INDEXADOR[tipo],
                      'desde': linhas[0][0], 'ate': u[0], 'aVenda': u[0] >= cdn_ate and D(venc) > hoje,
                      'hoje': {'data': u[0], 'taxaCompra': u[1], 'taxaVenda': u[2], 'puCompra': u[3], 'puVenda': u[4], 'estimado': bool(u[5])}})

    saida.sort(key=lambda t: (not t['aVenda'], list(INDEXADOR).index(t['tipo']), t['venc']))
    json.dump({'atualizado': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'tesouroAte': cdn_ate,
               'anbimaAte': dias_anb[-1] if dias_anb else None, 'titulos': saida},
              open(os.path.join(pasta, 'titulos.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(saida)} títulos; Tesouro até {cdn_ate}; ANBIMA até {dias_anb[-1] if dias_anb else "—"}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'dados-tesouro')
