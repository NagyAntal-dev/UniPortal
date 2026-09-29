"""A sötét téma stíluslapjának előállítása a VALÓBAN használt osztálytokenekből."""
import json, re

TOKENEK = json.load(open('/tmp/osztalyok.json'))

# --- a sötét paletta ---------------------------------------------------------
# A FELÜLETI HIERARCHIA sötétben MEGFORDUL: a lap a legmélyebb, a kártya
# EMELKEDIK ki belőle. Az első változatban a kártya (bg-white) sötétebb volt,
# mint a lap háttere (bg-slate-50) — mérve #121c2e a #16203a alatt —, és így a
# kártya benyomódott a lapba ahelyett, hogy kiemelkedett volna.
FELULET   = {'alap': '#0b1220',        # html/body — a legmélyebb sík
             'lap': '#182544',         # bg-white: a kártya, EMELT sík
             'halvany': '#0f1829',     # bg-slate-50: lapháttér, a kártya alatt
             'tompa': '#16213a',       # bg-slate-100
             'kiemelt': '#1d2a46'}     # bg-slate-200
SZOVEG    = {900: '#eef3fa', 800: '#e4ecf6', 700: '#cfdaea', 600: '#b6c4d8',
             500: '#96a6bd', 400: '#8091a9', 300: '#64748b', 200: '#4d5a70', 100: '#3b475c', 50: '#2f3a4d'}
# akcentusok: (alapszín RGB, világos szövegárnyalat)
AKCENT = {
    'red':      ((239, 68, 68),  '#fca5a5'),
    'rose':     ((244, 63, 94),  '#fda4af'),
    'orange':   ((249, 115, 22), '#fdba74'),
    'amber':    ((245, 158, 11), '#fcd34d'),
    'yellow':   ((234, 179, 8),  '#fde047'),
    'lime':     ((132, 204, 22), '#bef264'),
    'green':    ((34, 197, 94),  '#86efac'),
    'emerald':  ((16, 185, 129), '#6ee7b7'),
    'teal':     ((20, 184, 166), '#5eead4'),
    'cyan':     ((6, 182, 212),  '#67e8f9'),
    'sky':      ((14, 165, 233), '#7dd3fc'),
    'blue':     ((59, 130, 246), '#93c5fd'),
    'violet':   ((139, 92, 246), '#c4b5fd'),
    'purple':   ((168, 85, 247), '#d8b4fe'),
    'fuchsia':  ((217, 70, 239), '#f0abfc'),
    'pink':     ((236, 72, 153), '#f9a8d4'),
    # a konfiguráció az indigót a narancs skálára képezi — itt is azt követjük
    'indigo':   ((208, 103, 0),  '#ffb166'),
    'primary':  ((208, 103, 0),  '#ffb166'),
}
def rgba(rgb, a): return f'rgba({rgb[0]}, {rgb[1]}, {rgb[2]}, {a})'

def esc(t):  # CSS-osztálynév menekítése
    return re.sub(r'([:/\[\]\.])', r'\\\1', t)

VALTOZO = {'hover': ':hover', 'focus': ':focus', 'focus-within': ':focus-within',
           'focus-visible': ':focus-visible', 'active': ':active', 'disabled': ':disabled',
           'checked': ':checked', 'first': ':first-child', 'last': ':last-child',
           'odd': ':nth-child(odd)', 'even': ':nth-child(even)'}

def szelektor(token):
    """A teljes tokenből CSS-szelektor. A csoportos és a töréspontos változatot
       kihagyjuk: az előbbi szülőre szűr, az utóbbi médialekérdezés — ezeket a
       generált szabály nem tudja helyesen visszaadni, és rosszabb, ha félig
       stimmel, mint ha az alapszabály érvényesül rájuk."""
    *elotagok, alap = token.split(':')
    utotag = ''
    elotag = ''
    for e in elotagok:
        if e in VALTOZO: utotag += VALTOZO[e]
        elif e == 'group-hover': elotag = '.group:hover '
        elif e == '': continue                      # „:group-hover:…” elgépelés a forrásban
        else: return None
    return f'html.sotet {elotag}.{esc(token)}{utotag}'

def ertek(tulaj, csalad, arny, alfa):
    """Mit kapjon ez a tulajdonság sötét módban."""
    a = (int(alfa) / 100) if alfa else None
    if csalad in ('white', 'black'):
        if csalad == 'white':
            if tulaj == 'bg':     return FELULET['lap'] if a is None else rgba((255,255,255), a)
            if tulaj == 'text':   return SZOVEG[900] if a is None else rgba((226,232,240), a)
            if tulaj == 'border': return rgba((148,163,184), a if a is not None else 0.16)
            if tulaj in ('divide','ring','outline'): return rgba((148,163,184), a if a is not None else 0.16)
            if tulaj == 'placeholder': return SZOVEG[400]
            if tulaj in ('from','to','via'): return FELULET['lap']
            if tulaj in ('fill','stroke'): return SZOVEG[900]
        else:
            if tulaj == 'bg':   return FELULET['alap'] if a is None else rgba((0,0,0), a)
            if tulaj == 'text': return SZOVEG[900]
        return None
    if csalad in ('slate', 'gray', 'zinc', 'neutral', 'stone'):
        n = int(arny) if arny else 500
        if tulaj == 'bg':
            # a világos szürkék sötét felületek, a sötét szürkék VILÁGOSODNAK:
            # a fekete gomb világos alapon sötéten, sötét alapon világosan kell
            terkep = {50: FELULET['halvany'], 100: FELULET['tompa'], 200: FELULET['kiemelt'],
                      300: '#243консь', 400: '#2b3a55', 500: '#3a4b69',
                      # a sötét szürkék VILÁGOSODNAK: a fekete gomb világos
                      # alapon sötét, sötét alapon világos kell hogy legyen
                      600: '#44587a', 700: '#2f3e58', 800: '#293755', 900: '#31425f', 950: '#273449'}
            v = terkep.get(n, FELULET['lap'])
            if not v.startswith('#') or len(v) != 7: v = '#243450'
            return v if a is None else rgba((148,163,184), a)
        if tulaj in ('text', 'fill', 'stroke', 'placeholder', 'caret', 'accent', 'decoration'):
            return SZOVEG.get(n, SZOVEG[500])
        if tulaj in ('border', 'divide', 'ring', 'ring-offset', 'outline', 'shadow'):
            atl = {50: 0.10, 100: 0.14, 200: 0.20, 300: 0.28, 400: 0.36, 500: 0.44,
                   600: 0.52, 700: 0.60, 800: 0.70, 900: 0.80}
            return rgba((148,163,184), a if a is not None else atl.get(n, 0.2))
        if tulaj in ('from', 'to', 'via'):
            return FELULET['halvany'] if n <= 200 else FELULET['tompa']
        return None
    if csalad in AKCENT:
        rgb, vilagos = AKCENT[csalad]
        n = int(arny) if arny else 500
        if tulaj == 'bg':
            if a is not None: return rgba(rgb, min(a + 0.04, 0.9))
            # világos árnyalat = halvány háttér → sötét módban áttetsző szín
            if n <= 200: return rgba(rgb, 0.16)
            return f'rgb({rgb[0]}, {rgb[1]}, {rgb[2]})'
        if tulaj in ('text', 'fill', 'stroke', 'placeholder', 'caret', 'accent', 'decoration'):
            return vilagos if n >= 400 or not arny else vilagos
        if tulaj in ('border', 'divide', 'ring', 'ring-offset', 'outline'):
            return rgba(rgb, a if a is not None else (0.30 if n <= 200 else 0.55))
        if tulaj in ('from', 'to', 'via'):
            return rgba(rgb, 0.22)
        if tulaj == 'shadow':
            return rgba(rgb, 0.25)
    return None

CSS_TULAJ = {'bg': 'background-color', 'text': 'color', 'border': 'border-color',
             'divide': 'border-color', 'ring': '--tw-ring-color', 'ring-offset': '--tw-ring-offset-color',
             'from': '--tw-gradient-from', 'to': '--tw-gradient-to', 'via': '--tw-gradient-via',
             'placeholder': 'color', 'fill': 'fill', 'stroke': 'stroke', 'outline': 'outline-color',
             'accent': 'accent-color', 'caret': 'caret-color', 'decoration': 'text-decoration-color'}

sorok, kihagyott = [], 0
ARNYEK = re.compile(r'^shadow-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary)(?:-\\d{2,3})?(?:/\\d{1,3})?$')
minta = re.compile(r'^(bg|text|border|ring-offset|ring|divide|from|to|via|placeholder|fill|stroke|outline|accent|caret|decoration)-'
                   r'(white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|primary)'
                   r'(?:-(\d{2,3}))?(?:/(\d{1,3}))?$')
for token in TOKENEK:
    alap = token.split(':')[-1]
    if ARNYEK.match(alap):
        # A színes árnyék sötét alapon vagy láthatatlan, vagy piszkos glóriát
        # rajzol: egységesen mély, semleges árnyékra cseréljük.
        sz = szelektor(token)
        if sz: sorok.append(f'{sz} {{ --tw-shadow-color: rgba(0, 0, 0, 0.5); --tw-shadow: var(--tw-shadow-colored); }}')
        else: kihagyott += 1
        continue
    m = minta.match(alap)
    if not m: kihagyott += 1; continue
    tulaj, csalad, arny, alfa = m.groups()
    sz = szelektor(token)
    if not sz: kihagyott += 1; continue
    v = ertek(tulaj, csalad, arny, alfa)
    if v is None: kihagyott += 1; continue
    css = CSS_TULAJ[tulaj]
    if tulaj == 'placeholder': sz += '::placeholder'
    if tulaj == 'divide':      sz += ' > :not([hidden]) ~ :not([hidden])'
    sorok.append(f'{sz} {{ {css}: {v}; }}')

print('generált szabály:', len(sorok), '| kihagyott token:', kihagyott)
open('/tmp/sotet_szabalyok.css', 'w').write('\n'.join(sorok) + '\n')
