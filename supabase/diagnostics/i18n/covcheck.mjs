// A2 lefedettség-mérés: a felületen megjelenő magyar szövegek közül hánynak
// van fordítása. A kommenteket kilexeljük, a szótár-blokkot kihagyjuk.
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname} from 'node:path';
// a projekt gyökere: .../supabase/diagnostics/i18n -> három szinttel feljebb
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE + '/../../../';
// A szótár-modult mindig FRISSEN állítjuk elő, hogy ne egy elavult
// pillanatképet mérjünk, ha az app.jsx közben változott.
await import('node:child_process').then(cp =>
  cp.execFileSync(process.execPath, [HERE + '/mkdict.mjs'], {stdio: 'ignore'}));
// Windowson a csupasz abszolút út ('C:\...') nem érvényes ESM-URL: a
// betűjelet a loader sémának nézi (ERR_UNSUPPORTED_ESM_URL_SCHEME).
const m=await import(pathToFileURL(HERE+'/.dicteval.mjs').href + '?t=' + Date.now());
const dict=m.HU_EN, rxs=m.HU_EN_PHRASES.map(p=>p[0]);
function stripComments(src){let out='',i=0,n=src.length;
 while(i<n){const c=src[i];
  if(c==="'"||c==='"'||c==='`'){const q=c;out+=c;i++;while(i<n){if(src[i]==='\\'){out+=src[i]+(src[i+1]||'');i+=2;continue;}out+=src[i];if(src[i]===q){i++;break;}i++;}continue;}
  if(c==='/'&&src[i+1]==='/'){while(i<n&&src[i]!=='\n'){out+=' ';i++;}continue;}
  if(c==='/'&&src[i+1]==='*'){i+=2;while(i<n&&!(src[i]==='*'&&src[i+1]==='/')){out+=(src[i]==='\n'?'\n':' ');i++;}i+=2;continue;}
  out+=c;i++;}return out;}
const HUN=/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/;
const raw=readFileSync(ROOT+'app.jsx','utf8').split('\n');
const dictFrom=raw.findIndex(l=>/^const HU_EN = \{/.test(l))+1;
const dictTo=raw.findIndex(l=>/^\(function setupI18n\(\)\{/.test(l));
const statFrom=raw.findIndex(l=>/^const STATUS_I18N = \{/.test(l))+1;
// A 72-es jogosultsági mátrix két új fájlt hozott; a mérésnek látnia kell
// őket, különben a lefedettség jobbnak látszik, mint amilyen.
const FILES=['app.jsx','features/programs.jsx','features/feed.jsx','features/assistant.jsx','features/registrations.jsx','features/knowledge-base.jsx','features/roles.jsx','features/perm.jsx'];
let gt=0,gc=0;const miss=[];
for(const f of FILES){
  const src=stripComments(readFileSync(ROOT+f,'utf8'));
  const cand=new Map();
  const push=(t,idx)=>{t=t.trim().replace(/\s+/g,' ');if(!t||!HUN.test(t))return;
    if(/^[\d\s.,:;%€$—·•\/()-]+$/.test(t))return;
    const ln=src.slice(0,idx).split('\n').length;
    if(f==='app.jsx'&&((ln>=statFrom&&ln<=statFrom+60)||(ln>=dictFrom&&ln<=dictTo)))return;
    if(!cand.has(t))cand.set(t,ln);};
  for(const mm of src.matchAll(/>([^<>{}\n]{2,200})</g))push(mm[1],mm.index);
  for(const mm of src.matchAll(/(?:placeholder|title|alt|aria-label)=\{?["']([^"'\n]{2,200})["']\}?/g))push(mm[1],mm.index);
  let cov=0;
  for(const [t,ln] of cand){ if(dict[t]!==undefined||rxs.some(r=>{r.lastIndex=0;return r.test(t);}))cov++; else miss.push(`${f}:${ln}  ${t}`); }
  gt+=cand.size;gc+=cov;
  console.log(`  ${f}: ${cov}/${cand.size}`);
}
console.log(`\nA2 LEFEDETTSÉG: ${gc}/${gt} = ${(gc/gt*100).toFixed(1)}%  | lefordítatlan: ${gt-gc}`);
for(const x of miss)console.log('   '+x);
