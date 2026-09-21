/* ============================================================
   UniPortal Pro — AI Assistant
   A student-facing assistant grounded in the university's English
   website content + admin-uploaded documents. Answers in the
   language of the question and surfaces the relevant source links.
   Available as a floating widget on every screen AND a full view.
   Admins manage the knowledge base from the full view.
   ============================================================ */

const ASSIST_SYS = [
  'You are the NJE UniPortal Assistant for prospective and current international students of John von Neumann University (Neumann János Egyetem), a state university in Kecskemét, Hungary.',
  'Answer ONLY using the KNOWLEDGE BASE below, which is derived from the university\u2019s official English website (nje.hu/en) and documents uploaded by admissions staff.',
  'If the answer is not in the knowledge base, say you are not certain and suggest emailing admission@nje.hu — do not invent programmes, fees, deadlines or requirements.',
  'Reply in the SAME language as the student\u2019s question (e.g. answer Hungarian questions in Hungarian, Arabic in Arabic).',
  'Be concise, warm and specific. Use short paragraphs or bullet points. When a knowledge-base entry lists a URL, include the most relevant link(s) in your answer as markdown [label](url).',
].join(' ');

const ASSIST_SUGGEST = [
  'Milyen képzések folynak angol nyelven?',
  'Hogyan jelentkezhetek nemzetközi hallgatóként?',
  'Mennyi a tandíj és a jelentkezési díj?',
  'Milyen dokumentumok kellenek a jelentkezéshez?',
  'Mesélj az ösztöndíjakról',
  'Hogyan zajlik a diákvízum-eljárás?',
];

async function ASSIST_ask(question, history, docs) {
  const { context, sources } = KB_context(docs, question, 7000);
  const hist = (history || []).slice(-6).map(m => (m.role === 'user' ? 'Student: ' : 'Assistant: ') + m.content).join('\n');
  const prompt = ASSIST_SYS +
    '\n\n=== KNOWLEDGE BASE ===\n' + (context || '(empty)') +
    '\n\n=== CONVERSATION SO FAR ===\n' + (hist || '(none)') +
    '\n\nStudent question: ' + question +
    '\n\nAssistant answer (reply in the question\u2019s language; include relevant markdown links where useful):';
  let text = '';
  try {
    const raw = await window.claude.complete({ messages: [{ role: 'user', content: prompt }] });
    text = (typeof raw === 'string') ? raw : (raw && (raw.content || raw.text)) || '';
  } catch (e) {
    try { const raw2 = await window.claude.complete(prompt); text = typeof raw2 === 'string' ? raw2 : ''; } catch (e2) {}
  }
  if (!text) throw new Error('no-response');
  return { text: text.trim(), sources };
}

/* ---------- lightweight markdown → React (bold, links, bullets) ---------- */
function ASSIST_inline(str, keyBase) {
  const nodes = []; let rest = str; let k = 0;
  const re = /(\*\*([^*]+)\*\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/;
  while (rest.length) {
    const m = rest.match(re);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    if (m[1]) nodes.push(<strong key={keyBase + '-' + (k++)} className="font-black text-slate-800">{m[2]}</strong>);
    else nodes.push(<a key={keyBase + '-' + (k++)} href={m[5]} target="_blank" rel="noreferrer" className="text-primary font-bold underline decoration-primary/30 hover:decoration-primary">{m[4]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}
function ASSIST_rich(text) {
  const lines = (text || '').split('\n');
  const out = []; let bullets = null;
  const flush = () => { if (bullets) { out.push(<ul key={'ul' + out.length} className="list-disc pl-5 space-y-1 my-1.5">{bullets}</ul>); bullets = null; } };
  lines.forEach((ln, i) => {
    const t = ln.trim();
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); out.push(<p key={i} className="font-black text-slate-800 mt-2 mb-1">{ASSIST_inline(h[2], 'h' + i)}</p>); }
    else if (/^[-*]\s+/.test(t)) { if (!bullets) bullets = []; bullets.push(<li key={i}>{ASSIST_inline(t.replace(/^[-*]\s+/, ''), 'b' + i)}</li>); }
    else { flush(); if (t) out.push(<p key={i} className="my-1.5">{ASSIST_inline(t, 'p' + i)}</p>); }
  });
  flush();
  return out;
}

/* ---------- shared chat core ---------- */
function ASSIST_Chat({ user, compact }) {
  const lsKey = 'uni_chat_' + ((user && user.email) || 'anon');
  const [docs, setDocs] = useState([]);
  const [betoltesHiba, setBetoltesHiba] = useState('');
  const [msgs, setMsgs] = useState(() => { try { return JSON.parse(localStorage.getItem(lsKey)) || []; } catch (e) { return []; } });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  const noAI = !(typeof window !== 'undefined' && window.claude && window.claude.complete);

  useEffect(() => { KB_load().then(setDocs).catch(e => setBetoltesHiba(e.message || 'A betöltés nem sikerült.')); }, []);
  useEffect(() => { try { localStorage.setItem(lsKey, JSON.stringify(msgs.slice(-30))); } catch (e) {} if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs, busy]);

  const send = async (q) => {
    const question = (q != null ? q : input).trim();
    if (!question || busy) return;
    setInput(''); setBusy(true);
    const next = [...msgs, { role: 'user', content: question }];
    setMsgs(next);
    try {
      const { text, sources } = await ASSIST_ask(question, next, docs);
      setMsgs(m => [...m, { role: 'assistant', content: text, sources: (sources || []).map(s => ({ title: s.title, url: s.url })).filter(s => s.url) }]);
    } catch (e) {
      setMsgs(m => [...m, { role: 'assistant', content: noAI ? 'Az AI szolgáltatás ebben a nézetben nem érhető el. Segítségért írj az admission@nje.hu címre.' : 'Elnézést — most nem tudtam választ adni. Próbáld újra, vagy írj az admission@nje.hu címre.', sources: [] }]);
    } finally { setBusy(false); }
  };

  const clear = () => { setMsgs([]); try { localStorage.removeItem(lsKey); } catch (e) {} };

  return (
    /* MIÉRT h-full ÉS NEM h-[540px] compact módban:
       a lebegő panel legfeljebb min(70vh,560px) magas és overflow-hidden.
       Fejléc (~48px) + p-4 (32px) + 540px chat = 620px tartalom egy 560px-es
       dobozban, tehát a legalsó elem — pontosan a beviteli sor — levágódott.
       700px magas ablaknál már 130px hiányzott. Fix magasság helyett a chat
       most a panelhez igazodik. */
    <div className={'flex flex-col min-h-0 ' + (compact ? 'h-full' : 'h-[calc(100vh-220px)] min-h-[440px]')}>
      {betoltesHiba && <div role="alert" className="rounded-xl bg-red-50 p-3 text-red-700">{betoltesHiba}</div>}
      {/* messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto custom-scrollbar px-1 space-y-4">
        {msgs.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <div className="w-14 h-14 rounded-3xl bg-primary/10 text-primary flex items-center justify-center mb-3"><Lucide.Sparkles size={26} /></div>
            <h4 className="font-black text-slate-800">Kérdezz az NJE-n való tanulásról</h4>
            <p className="text-sm text-slate-400 mt-1 max-w-xs">Képzések, jelentkezés, díjak, dokumentumok, ösztöndíjak és vízum — a hivatalos információk alapján válaszolok, a te nyelveden.</p>
            <div className="flex flex-wrap gap-2 justify-center mt-5 max-w-md">
              {ASSIST_SUGGEST.slice(0, compact ? 3 : 6).map(s => <button key={s} onClick={() => send(s)} className="px-3 py-1.5 rounded-full bg-white border border-slate-200 text-[12px] font-bold text-slate-600 hover:border-primary hover:text-primary transition-colors">{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => m.role === 'user' ? (
          <div key={i} className="flex justify-end"><div className="max-w-[85%] bg-primary text-white rounded-2xl rounded-br-md px-4 py-2.5 text-sm font-medium shadow-sm">{m.content}</div></div>
        ) : (
          <div key={i} className="flex gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-none mt-0.5"><Lucide.Sparkles size={16} /></div>
            <div className="max-w-[85%]">
              <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md px-4 py-3 text-sm text-slate-600 shadow-sm leading-relaxed">{ASSIST_rich(m.content)}</div>
              {m.sources && m.sources.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {m.sources.slice(0, 4).map((s, j) => <a key={j} href={s.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 text-[11px] font-bold text-slate-500 hover:bg-primary/10 hover:text-primary transition-colors"><Lucide.Link2 size={11} /> {s.title}</a>)}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <div className="flex gap-2.5"><div className="w-8 h-8 rounded-xl bg-primary/10 text-primary flex items-center justify-center flex-none"><Lucide.Sparkles size={16} /></div><div className="bg-white border border-slate-100 rounded-2xl rounded-tl-md px-4 py-3 shadow-sm flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} /><span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} /><span className="w-2 h-2 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} /></div></div>}
      </div>

      {/* input */}
      <div className="pt-3 mt-2 border-t border-slate-100">
        {msgs.length > 0 && <button onClick={clear} className="text-[11px] font-bold text-slate-400 hover:text-slate-600 mb-2 flex items-center gap-1"><Lucide.RotateCcw size={12} /> Új beszélgetés</button>}
        <div className="flex items-end gap-2">
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} rows={1} placeholder="Kérdezz bármit az NJE-ről…" className="flex-1 resize-none bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 max-h-32" />
          <button onClick={() => send()} disabled={busy || !input.trim()} className="w-11 h-11 flex-none rounded-2xl bg-primary text-white flex items-center justify-center shadow-lg shadow-primary/10 hover:bg-primary/90 disabled:opacity-40 transition-all active:scale-95"><Lucide.ArrowUp size={18} /></button>
        </div>
      </div>
    </div>
  );
}

/* ---------- admin: knowledge base manager ---------- */
function ASSIST_KB({ user, onChange }) {
  const jog = PERM_of(user, 'assistant', { create: isAdmin(user), del: isAdmin(user) });
  const [docs, setDocs] = useState(null);
  const [adding, setAdding] = useState(false);
  const [nt, setNt] = useState({ title: '', content: '', url: '' });
  const [busy, setBusy] = useState(false);
  const refetch = async () => {
    try { setDocs(await KB_load()); }
    catch (e) { setKbHiba(e.message || 'A betöltés nem sikerült.'); }
  };
  useEffect(() => { refetch(); }, []);

  /* A tudásbázis írása megtagadható (72/73-as jogosultsági réteg): a KB_add /
     KB_remove a dlInsert/dlDelete-en át DOB. Enélkül a feltöltés a felületen
     sikeresnek látszana, és a dokumentum csak a helyi tárolóba kerülne. */
  const [kbHiba, setKbHiba] = useState('');
  const addText = async () => {
    if (!jog.create || busy) return;
    if (!nt.title.trim() || !nt.content.trim()) return;
    setBusy(true);
    try { await KB_add({ title: nt.title.trim(), content: nt.content.trim(), url: nt.url.trim(), source: 'upload' }); setKbHiba(''); }
    catch (e) { setKbHiba((e && e.message) || 'A mentés nem sikerült.'); setBusy(false); return; }
    setNt({ title: '', content: '', url: '' }); setAdding(false); setBusy(false); refetch(); onChange && onChange();
  };
  const upload = async (e) => {
    if (!jog.create || busy) return;
    const file = e.target.files && e.target.files[0]; if (!file) return;
    setBusy(true);
    try { const r = await KB_ingestFile(file); if (r.ok) await KB_add({ title: r.title, content: r.content, source: 'upload' }); setKbHiba(''); }
    catch (err) { setKbHiba((err && err.message) || 'A feltöltés nem sikerült.'); setBusy(false); e.target.value = ''; return; }
    setBusy(false); e.target.value = ''; refetch(); onChange && onChange();
  };
  const remove = async (id) => {
    if (!jog.del || busy) return;
    try { await KB_remove(id); setKbHiba(''); }
    catch (e) { setKbHiba((e && e.message) || 'A törlés nem sikerült.'); return; }
    refetch(); onChange && onChange();
  };

  return (
    <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-6">
      {kbHiba && (
        <div className="mb-4 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm font-semibold">
          <Lucide.AlertCircle size={16} className="mt-0.5 flex-none" />
          <span className="flex-1">{kbHiba}</span>
          <button onClick={() => setKbHiba('')} className="text-red-400 hover:text-red-700"><Lucide.X size={14} /></button>
        </div>
      )}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2"><Lucide.Database size={18} className="text-primary" /><h3 className="font-black text-slate-800">Tudásbázis</h3><UBadge tone="slate">{(docs ? docs.length : '…') + ' dokumentum'}</UBadge></div>
        {jog.create && <div className="flex items-center gap-2">
          <label className={U_btnGhost + ' cursor-pointer text-[13px] py-2 px-4'}><Lucide.Upload size={15} /> Feltöltés<input type="file" accept=".pdf,.txt,.md,.csv,.json" className="hidden" onChange={upload} /></label>
          <button className={U_btnPrimary + ' text-[13px] py-2 px-4'} onClick={() => setAdding(a => !a)}><Lucide.Plus size={15} /> Szöveg hozzáadása</button>
        </div>}
      </div>
      <p className="text-[12px] text-slate-400 mb-4">Az itt tárolt tartalom adja az asszisztens válaszainak alapját. Az NJE angol nyelvű honlapjáról indul; PDF-ekkel vagy szöveggel (díjtáblázat, GYIK, képzési kiadványok) bővíthető.</p>
      {adding && jog.create && (
        <div className="space-y-3 p-4 rounded-2xl bg-slate-50 mb-4">
          <input className={U_input} placeholder="Cím (pl. Tandíjak 2026)" value={nt.title} onChange={e => setNt(p => ({ ...p, title: e.target.value }))} />
          <input className={U_input} placeholder="Forrás URL (opcionális)" value={nt.url} onChange={e => setNt(p => ({ ...p, url: e.target.value }))} />
          <textarea className={U_input + ' min-h-[110px]'} placeholder="Illeszd be a tartalmat…" value={nt.content} onChange={e => setNt(p => ({ ...p, content: e.target.value }))} />
          <div className="flex justify-end gap-2"><button className={U_btnGhost + ' text-[13px] py-2 px-4'} onClick={() => setAdding(false)}>Mégse</button><button className={U_btnPrimary + ' text-[13px] py-2 px-4'} disabled={busy} onClick={addText}>Hozzáadás a tudásbázishoz</button></div>
        </div>
      )}
      {busy && !adding && <div className="text-[12px] font-bold text-slate-400 mb-3 flex items-center gap-2"><Lucide.Loader2 size={14} className="animate-spin" /> Dokumentum feldolgozása…</div>}
      <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
        {(docs || []).map(d => (
          <div key={d.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50/60">
            <div className="w-9 h-9 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center flex-none">{d.source === 'website' ? <Lucide.Globe size={16} /> : <Lucide.FileText size={16} />}</div>
            <div className="min-w-0 flex-1"><div className="text-sm font-bold text-slate-700 truncate">{d.title}</div><div className="text-[11px] text-slate-400 truncate">{d.url || (d.content || '').slice(0, 60) + '…'}</div></div>
            <UBadge tone={d.source === 'website' ? 'blue' : 'green'}>{d.source}</UBadge>
            {jog.del && <button onClick={() => remove(d.id)} className="w-8 h-8 rounded-lg text-slate-300 hover:bg-red-50 hover:text-red-500 flex items-center justify-center transition-colors"><Lucide.Trash2 size={15} /></button>}
          </div>
        ))}
        {docs && docs.length === 0 && <div className="text-sm text-slate-400 py-6 text-center">A tudásbázis üres.</div>}
      </div>
    </div>
  );
}

/* ---------- dedicated view ---------- */
const AssistantView = ({ user }) => {
  const [tab, setTab] = useState('chat');
  /* A tudásbázis szerkesztése az `assistant` modul CREATE/EDIT joga.
     A `regi` érték a mai viselkedés: isAdmin() — azaz ADMIN (és a 72-es
     óta a SUPERADMIN is, lásd data-layer.jsx). */
  const jog = PERM_of(user, 'assistant', { create: isAdmin(user), edit: isAdmin(user), del: isAdmin(user) });
  const admin = jog.create || jog.edit || jog.del;
  return (
    <div className="max-w-4xl 2xl:max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
        <div>
          <p className="text-primary font-black text-xs uppercase tracking-widest mb-1">AI Asszisztens</p>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Kérdezd az NJE-t</h1>
          <p className="text-slate-400 mt-1 font-medium max-w-[75ch]">Kérdéseid a Neumann János Egyetemen való tanulásról — hivatalos információk alapján megválaszolva.</p>
        </div>
        {admin && (
          <div className="flex items-center gap-1 bg-white border border-slate-100 rounded-2xl p-1">
            <button onClick={() => setTab('chat')} className={'px-4 py-2 rounded-xl text-[13px] font-bold transition-colors ' + (tab === 'chat' ? 'bg-primary text-white' : 'text-slate-500')}>Csevegés</button>
            <button onClick={() => setTab('kb')} className={'px-4 py-2 rounded-xl text-[13px] font-bold transition-colors ' + (tab === 'kb' ? 'bg-primary text-white' : 'text-slate-500')}>Tudásbázis</button>
          </div>
        )}
      </div>
      {tab === 'chat' || !admin
        ? <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-5 sm:p-6"><ASSIST_Chat user={user} compact={false} /></div>
        : <ASSIST_KB user={user} />}
    </div>
  );
};

/* ---------- floating widget (mounted globally) ---------- */

/**
 * Mekkora sávot foglal el a képernyő alján egy másik, fixen odarögzített
 * akciósáv (ma: az ECHO kitöltő alsó gombsora, `fixed bottom-0 ... z-40`).
 *
 * MIÉRT KELL: a lebegő asszisztens-gomb `fixed bottom-6 right-6 z-[95]`, tehát
 * mindig az ECHO sávja FÖLÖTT ül. Mérve 1216 px alatt pontosan a "Következő"
 * gombra takart rá. Ahelyett, hogy az app.jsx-ben rejtenénk el a widgetet
 * (az a keret dolga), itt kitérünk előle: a gomb annyival feljebb csúszik,
 * amennyi az alsó sáv magassága.
 *
 * A mérés olcsó: egyetlen querySelector, rAF-fel összevonva, és csak akkor
 * fut újra, ha a DOM vagy az ablakméret változik.
 */
const useBottomBarInset = () => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      let h = 0;
      const vh = window.innerHeight;
      document.querySelectorAll('[class*="fixed"][class*="bottom-0"]').forEach((el) => {
        if (el.hasAttribute('data-assistant-widget')) return;
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return;
        const r = el.getBoundingClientRect();
        // csak az valódi alsó sáv: a képernyő aljához ér, és nem teljes képernyős overlay
        if (r.height > 0 && r.height < 160 && Math.abs(r.bottom - vh) < 2) h = Math.max(h, r.height);
      });
      setInset((prev) => (prev === h ? prev : h));
    };
    const schedule = () => { if (!raf) raf = window.requestAnimationFrame(measure); };
    measure();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    window.addEventListener('resize', schedule);
    return () => { mo.disconnect(); window.removeEventListener('resize', schedule); if (raf) window.cancelAnimationFrame(raf); };
  }, []);
  return inset;
};

const AssistantWidget = ({ user }) => {
  const [open, setOpen] = useState(false);
  const inset = useBottomBarInset();            // px, 0 ha nincs alsó akciósáv
  const btnBottom = inset + 24;                 // bottom-6 = 24px
  const panelBottom = btnBottom + 56 + 16;      // a gomb (h-14) fölé, 16px hézaggal
  return (
    <>
      {open && (
        <div data-assistant-widget style={{ bottom: panelBottom }} className="fixed right-4 sm:right-6 z-[95] w-[min(400px,calc(100vw-2rem))] h-[min(70vh,560px)] bg-white rounded-3xl shadow-2xl border border-slate-100 flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 fade-in duration-200">
          <div className="flex items-center justify-between px-4 py-3 bg-primary text-white">
            <div className="flex items-center gap-2 font-black"><Lucide.Sparkles size={18} /> NJE Asszisztens</div>
            <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg hover:bg-white/20 flex items-center justify-center"><Lucide.X size={17} /></button>
          </div>
          <div className="p-4 flex-1 min-h-0"><ASSIST_Chat user={user} compact={true} /></div>
        </div>
      )}
      <button data-assistant-widget onClick={() => setOpen(o => !o)} style={{ bottom: btnBottom }} className="fixed right-4 sm:right-6 z-[95] w-14 h-14 rounded-2xl bg-primary text-white shadow-2xl shadow-primary/30 flex items-center justify-center hover:bg-primary/90 transition-all active:scale-95" aria-label="Kérdezd az NJE Asszisztenst" aria-expanded={open} title="Kérdezd az NJE Asszisztenst">
        {open ? <Lucide.ChevronDown size={24} /> : <Lucide.Sparkles size={24} />}
      </button>
    </>
  );
};
