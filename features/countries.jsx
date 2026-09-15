/* ===== Országválasztó zászlókkal (Country of citizenship) =====
   A világ összes országa és lakott területe, kereshető legördülő listában,
   zászlóval.

   TÁROLT ÉRTÉK: az angol rövid név (pl. 'Nigeria') — ugyanaz a szöveg, amit a
   korábbi szabad szöveges mező és a régi COUNTRIES lista adott, így a
   felvételi lista 'Származás' oszlopa, a szűrők és a riportok változatlanul
   működnek. A régi nevek ('Czech Republic', 'Turkey', 'Congo') szándékosan
   maradtak; az újabb hivatalos alakok ('Czechia', 'Türkiye') keresőnévként
   élnek.

   ZÁSZLÓK: assets/flags/<ISO>.svg — a country-flag-icons 1.6.20 (MIT) 3x2-es
   készletéből, SAJÁT tárhelyről. Nem emoji, mert Windowson a zászló-emoji
   két betűként jelenik meg; és nem külső CDN, mert az a jelentkező IP-címét
   harmadik félnek adná át (GDPR).

   A lista egy FÜGGVÉNYBEN él, nem modul-szintű konstansban: a feature-fájlok
   az app.jsx hatókörébe fűződnek a __FEATURES__ jelnél, és az app.jsx előbb
   futó kódja is hívhatja. A függvény-deklaráció hoistolódik, egy const nem. */

function CTRY_norm(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'").toLowerCase().trim();
}

function CTRY_all() {
  if (CTRY_all.cache) return CTRY_all.cache;
  // kód | angol név | további keresőnevek (vesszővel)
  const nyers = `AD|Andorra
AE|United Arab Emirates|UAE,Emirates
AF|Afghanistan
AG|Antigua and Barbuda
AI|Anguilla
AL|Albania
AM|Armenia
AO|Angola
AR|Argentina
AS|American Samoa
AT|Austria
AU|Australia
AW|Aruba
AX|Åland Islands|Aland
AZ|Azerbaijan
BA|Bosnia and Herzegovina|Bosnia,Herzegovina
BB|Barbados
BD|Bangladesh
BE|Belgium
BF|Burkina Faso
BG|Bulgaria
BH|Bahrain
BI|Burundi
BJ|Benin
BL|Saint Barthélemy|St Barthelemy
BM|Bermuda
BN|Brunei|Brunei Darussalam
BO|Bolivia
BQ|Caribbean Netherlands|Bonaire,Sint Eustatius,Saba
BR|Brazil|Brasil
BS|Bahamas|The Bahamas
BT|Bhutan
BW|Botswana
BY|Belarus
BZ|Belize
CA|Canada
CC|Cocos (Keeling) Islands|Cocos Islands
CD|Democratic Republic of the Congo|DR Congo,DRC,Congo-Kinshasa,Zaire
CF|Central African Republic|CAR
CG|Congo|Republic of the Congo,Congo-Brazzaville
CH|Switzerland
CI|Côte d’Ivoire|Ivory Coast,Cote d'Ivoire
CK|Cook Islands
CL|Chile
CM|Cameroon
CN|China|PRC,People's Republic of China
CO|Colombia
CR|Costa Rica
CU|Cuba
CV|Cabo Verde|Cape Verde
CW|Curaçao|Curacao
CX|Christmas Island
CY|Cyprus
CZ|Czech Republic|Czechia
DE|Germany|Deutschland
DJ|Djibouti
DK|Denmark
DM|Dominica
DO|Dominican Republic
DZ|Algeria
EC|Ecuador
EE|Estonia
EG|Egypt
EH|Western Sahara
ER|Eritrea
ES|Spain|España
ET|Ethiopia
FI|Finland
FJ|Fiji
FK|Falkland Islands|Malvinas
FM|Micronesia|Federated States of Micronesia
FO|Faroe Islands
FR|France
GA|Gabon
GB|United Kingdom|UK,Great Britain,Britain,England,Scotland,Wales,Northern Ireland
GD|Grenada
GE|Georgia
GF|French Guiana
GG|Guernsey
GH|Ghana
GI|Gibraltar
GL|Greenland
GM|Gambia|The Gambia
GN|Guinea
GP|Guadeloupe
GQ|Equatorial Guinea
GR|Greece|Hellas
GT|Guatemala
GU|Guam
GW|Guinea-Bissau
GY|Guyana
HK|Hong Kong
HN|Honduras
HR|Croatia
HT|Haiti
HU|Hungary|Magyarország
ID|Indonesia
IE|Ireland
IL|Israel
IM|Isle of Man
IN|India
IQ|Iraq
IR|Iran
IS|Iceland
IT|Italy
JE|Jersey
JM|Jamaica
JO|Jordan
JP|Japan
KE|Kenya
KG|Kyrgyzstan
KH|Cambodia
KI|Kiribati
KM|Comoros
KN|Saint Kitts and Nevis|St Kitts
KP|North Korea|DPRK
KR|South Korea|Korea,Republic of Korea
KW|Kuwait
KY|Cayman Islands
KZ|Kazakhstan
LA|Laos|Lao PDR
LB|Lebanon
LC|Saint Lucia|St Lucia
LI|Liechtenstein
LK|Sri Lanka
LR|Liberia
LS|Lesotho
LT|Lithuania
LU|Luxembourg
LV|Latvia
LY|Libya
MA|Morocco
MC|Monaco
MD|Moldova
ME|Montenegro
MF|Saint Martin
MG|Madagascar
MH|Marshall Islands
MK|North Macedonia|Macedonia
ML|Mali
MM|Myanmar|Burma
MN|Mongolia
MO|Macao|Macau
MP|Northern Mariana Islands
MQ|Martinique
MR|Mauritania
MS|Montserrat
MT|Malta
MU|Mauritius
MV|Maldives
MW|Malawi
MX|Mexico
MY|Malaysia
MZ|Mozambique
NA|Namibia
NC|New Caledonia
NE|Niger
NF|Norfolk Island
NG|Nigeria
NI|Nicaragua
NL|Netherlands|Holland,The Netherlands
NO|Norway
NP|Nepal
NR|Nauru
NU|Niue
NZ|New Zealand
OM|Oman
PA|Panama
PE|Peru
PF|French Polynesia
PG|Papua New Guinea
PH|Philippines
PK|Pakistan
PL|Poland
PM|Saint Pierre and Miquelon
PN|Pitcairn Islands
PR|Puerto Rico
PS|Palestine|State of Palestine
PT|Portugal
PW|Palau
PY|Paraguay
QA|Qatar
RE|Réunion|Reunion
RO|Romania
RS|Serbia
RU|Russia|Russian Federation
RW|Rwanda
SA|Saudi Arabia|KSA
SB|Solomon Islands
SC|Seychelles
SD|Sudan
SE|Sweden
SG|Singapore
SH|Saint Helena
SI|Slovenia
SK|Slovakia
SL|Sierra Leone
SM|San Marino
SN|Senegal
SO|Somalia
SR|Suriname
SS|South Sudan
ST|São Tomé and Príncipe|Sao Tome and Principe
SV|El Salvador
SX|Sint Maarten
SY|Syria
SZ|Eswatini|Swaziland
TC|Turks and Caicos Islands
TD|Chad
TG|Togo
TH|Thailand
TJ|Tajikistan
TK|Tokelau
TL|Timor-Leste|East Timor
TM|Turkmenistan
TN|Tunisia
TO|Tonga
TR|Turkey|Türkiye,Turkiye
TT|Trinidad and Tobago
TV|Tuvalu
TW|Taiwan
TZ|Tanzania
UA|Ukraine
UG|Uganda
US|United States|USA,United States of America,America
UY|Uruguay
UZ|Uzbekistan
VA|Vatican City|Holy See
VC|Saint Vincent and the Grenadines|St Vincent
VE|Venezuela
VG|British Virgin Islands
VI|U.S. Virgin Islands|US Virgin Islands
VN|Vietnam|Viet Nam
VU|Vanuatu
WF|Wallis and Futuna
WS|Samoa
XK|Kosovo
YE|Yemen
YT|Mayotte
ZA|South Africa
ZM|Zambia
ZW|Zimbabwe`;
  let huNev = null;
  try { huNev = new Intl.DisplayNames(['hu'], { type: 'region' }); } catch (e) { /* régi böngésző: magyar keresőnév nélkül */ }
  const lista = nyers.split('\n').map(sor => {
    const [code, name, alias] = sor.split('|');
    let hu = '';
    try { const h = huNev && huNev.of(code); if (h && h !== code) hu = h; } catch (e) {}
    const kulcsok = [name, hu, ...(alias ? alias.split(',') : [])].filter(Boolean).map(CTRY_norm);
    return { code, name, hu, kulcsok };
  });
  lista.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  CTRY_all.cache = lista;
  return lista;
}

/* Tárolt szövegből ország: angol név, keresőnév, magyar név vagy ISO-kód.
   A régi szabad szöveges mezőbe írt 'Nigéria' így is zászlót kap. */
function CTRY_find(value) {
  const n = CTRY_norm(value);
  if (!n) return null;
  const lista = CTRY_all();
  if (n.length === 2) { const k = lista.find(c => c.code.toLowerCase() === n); if (k) return k; }
  return lista.find(c => c.kulcsok.includes(n)) || null;
}

function CTRY_Flag({ code, w = 24 }) {
  if (!code) return null;
  return (
    <img src={'assets/flags/' + code + '.svg'} alt="" width={w} height={Math.round(w * 2 / 3)} loading="lazy" draggable={false}
      className="shrink-0 rounded-[3px] object-cover ring-1 ring-black/10"
      style={{ width: w, height: Math.round(w * 2 / 3) }}
      onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />
  );
}

function CTRY_Select({ value, onChange, inputClassName, placeholder, id, disabled }) {
  const EN = (() => { try { return localStorage.getItem('nje_lang') === 'en'; } catch (e) { return false; } })();
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [aktiv, setAktiv] = React.useState(0);
  const listRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const listId = React.useMemo(() => 'ctry-lista-' + Math.random().toString(36).slice(2, 8), []);

  const valasztott = CTRY_find(value);
  const talalatok = React.useMemo(() => {
    const lista = CTRY_all();
    const n = CTRY_norm(q);
    if (!n) return lista;
    const pont = c => {
      if (c.code.toLowerCase() === n) return 0;
      const nev = c.kulcsok[0];
      if (nev.startsWith(n)) return 1;
      if (nev.split(/[\s-]+/).some(sz => sz.startsWith(n))) return 2;
      if (c.kulcsok.some(k => k.startsWith(n))) return 3;
      if (c.kulcsok.some(k => k.includes(n))) return 4;
      return 9;
    };
    return lista.map(c => [pont(c), c]).filter(([p]) => p < 9).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  }, [q]);

  const nyit = () => {
    if (disabled) return;
    setQ('');
    const i = valasztott ? CTRY_all().findIndex(c => c.code === valasztott.code) : 0;
    setAktiv(Math.max(0, i));
    setOpen(true);
  };
  const valaszt = c => { onChange(c ? c.name : ''); setOpen(false); setQ(''); };

  React.useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector('[data-idx="' + aktiv + '"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [aktiv, open]);

  const billentyu = e => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') { e.preventDefault(); nyit(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setAktiv(i => Math.min(talalatok.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAktiv(i => Math.max(0, i - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setAktiv(0); }
    else if (e.key === 'End') { e.preventDefault(); setAktiv(talalatok.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (talalatok[aktiv]) valaszt(talalatok[aktiv]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ(''); }
    else if (e.key === 'Tab') { setOpen(false); setQ(''); }
  };

  const alap = inputClassName || 'w-full bg-slate-50 border border-slate-100 rounded-xl px-4 py-3 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all';
  const aktivOpcio = open && talalatok[aktiv] ? listId + '-' + talalatok[aktiv].code : undefined;

  return (
    <div className="relative" data-orszag-valaszto>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
          {open ? <Lucide.Search size={16} className="text-slate-400" />
            : valasztott ? <CTRY_Flag code={valasztott.code} w={22} />
            : <Lucide.Globe size={16} className="text-slate-400" />}
        </span>
        <input ref={inputRef} id={id} type="text" role="combobox" aria-expanded={open} aria-controls={listId}
          aria-autocomplete="list" aria-activedescendant={aktivOpcio} autoComplete="off" spellCheck={false} disabled={disabled}
          className={alap + (disabled ? ' opacity-60 cursor-not-allowed' : ' cursor-pointer')}
          style={{ paddingLeft: 42, paddingRight: value && !disabled ? 60 : 36 }}
          value={open ? q : (valasztott ? valasztott.name : (value || ''))}
          placeholder={open ? (EN ? 'Search by country name or code…' : 'Keresés ország neve vagy kódja szerint…') : (placeholder || (EN ? 'Select a country…' : 'Válassz országot…'))}
          onFocus={nyit} onClick={() => { if (!open) nyit(); }}
          onBlur={() => setTimeout(() => { setOpen(false); setQ(''); }, 120)}
          onChange={e => { setQ(e.target.value); setAktiv(0); if (!open) setOpen(true); }}
          onKeyDown={billentyu} />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {value && !disabled && !open && (
            <button type="button" tabIndex={-1} aria-label={EN ? 'Clear country' : 'Ország törlése'} title={EN ? 'Clear country' : 'Ország törlése'}
              onMouseDown={e => { e.preventDefault(); valaszt(null); }}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 hover:bg-slate-200/60">
              <Lucide.X size={14} />
            </button>
          )}
          <Lucide.ChevronDown size={16} className={'text-slate-400 pointer-events-none transition-transform ' + (open ? 'rotate-180' : '')} />
        </span>
      </div>
      {open && (
        <ul ref={listRef} id={listId} role="listbox" aria-label={EN ? 'Countries' : 'Országok'}
          className="absolute z-40 mt-1.5 w-full max-h-72 overflow-auto overscroll-contain bg-white border border-slate-200 rounded-xl shadow-xl py-1">
          {talalatok.length ? talalatok.map((c, i) => {
            const sel = valasztott && valasztott.code === c.code;
            return (
              <li key={c.code} id={listId + '-' + c.code} data-idx={i} data-kod={c.code} role="option" aria-selected={!!sel}
                onMouseDown={e => { e.preventDefault(); valaszt(c); }} onMouseMove={() => { if (aktiv !== i) setAktiv(i); }}
                className={'flex items-center gap-3 px-3 py-2 text-sm cursor-pointer select-none ' + (i === aktiv ? 'bg-primary/10' : '')}>
                <CTRY_Flag code={c.code} w={24} />
                <span className={'flex-1 min-w-0 truncate ' + (sel ? 'font-bold text-primary' : 'text-slate-700')}>
                  {c.name}
                  {!EN && c.hu && CTRY_norm(c.hu) !== CTRY_norm(c.name) && <span className="ml-2 text-xs font-normal text-slate-400">{c.hu}</span>}
                </span>
                <span className="text-[10px] font-bold tracking-wider text-slate-300 tabular-nums">{c.code}</span>
                {sel && <Lucide.Check size={14} className="text-primary shrink-0" />}
              </li>
            );
          }) : <li className="px-3.5 py-3 text-sm text-slate-400">{EN ? 'No matching country' : 'Nincs ilyen ország'}</li>}
        </ul>
      )}
    </div>
  );
}
