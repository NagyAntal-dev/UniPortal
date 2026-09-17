// ============================================================
// whatsapp-send — kimenő WhatsApp üzenet a Meta Cloud API-n át
//
// Miért Edge Function: a WhatsApp access token soha nem kerülhet a
// böngészőbe. A statikus oldal ezt a függvényt hívja a bejelentkezett
// felhasználó JWT-jével; a token csak itt, szerveroldalon létezik.
//
// Ha a Meta-adatok nincsenek beállítva, a függvény SZIMULÁL: az üzenetet
// elmenti `simulated = true` jelöléssel, hibát nem dob. Így a CRM inbox már
// a Meta-fiók meglétele előtt is valódi, megosztott adatot használ, és a
// későbbi élesítés csak secretek beállítása — kódmódosítás nélkül.
//
// JOGOSULTSÁG: a saját szerveren a kapu hitelesítés NÉLKÜL engedi át a
// /functions/v1/ útvonalat (FUNCTIONS_VERIFY_JWT=false, mert a Meta webhookja
// nem tud Supabase-tokent küldeni), ezért a hívó ellenőrzése ITT történik:
// auth.getUser() a hívó tokenjével, majd is_staff() ugyanazzal a tokennel,
// tehát az RLS és a jóváhagyási szabály is érvényesül. A MENNYISÉGET két
// dolog fogja: a web nginxe (uni_fn vödör) és a küldőnkénti percenkénti
// korlát idelent (WHATSAPP_MAX_SENDS_PER_MINUTE).
//
// Deploy:  supabase functions deploy whatsapp-send
// Secretek: supabase secrets set WHATSAPP_ACCESS_TOKEN=… WHATSAPP_PHONE_NUMBER_ID=…
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

// A felület ugyanarról a címről hívja ezt a függvényt, amiről betöltődött
// (a web nginxe továbbítja a /functions/v1/ útvonalat), ezért a CORS-t a
// saját nyilvános címünkre szűkítjük. A '*' azt jelentette, hogy egy ellopott
// vagy kölcsönvett tokennel BÁRMELY oldalról vezérelhető volt a küldés.
const SITE_ORIGIN = (() => {
  const raw = Deno.env.get('SUPABASE_PUBLIC_URL') ?? '';
  try { return raw ? new URL(raw).origin : ''; } catch { return ''; }
})();

const CORS: Record<string, string> = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
if (SITE_ORIGIN) CORS['Access-Control-Allow-Origin'] = SITE_ORIGIN;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const WA_TOKEN = Deno.env.get('WHATSAPP_ACCESS_TOKEN') ?? '';
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') ?? '';
const WA_VERSION = Deno.env.get('WHATSAPP_API_VERSION') ?? 'v21.0';

// A Cloud API csak számjegyeket fogad (E.164, + nélkül).
const normalise = (raw: string) => String(raw ?? '').replace(/[^\d]/g, '').replace(/^0+/, '');

const newId = () => 'WA-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// ---- Bemeneti korlátok ----------------------------------------------------
// A Meta Cloud API saját korlátai, plusz néhány józan felső határ. A
// `components` korábban ELLENŐRZÉS NÉLKÜL ment tovább a Graph API-nak: egy
// ügyintézői tokennel tetszőleges sablon-hasznos teher volt összeállítható.
const MAX_TEXT_LEN     = 4096;   // a Cloud API szöveg-korlátja
const MAX_PHONE_DIGITS = 15;     // E.164 legfeljebb 15 számjegy
const MAX_COMPONENTS   = 10;
const MAX_COMPONENT_BYTES = 8192;
// A Meta sablonneve csak kisbetű, számjegy és aláhúzás lehet. SZÁNDÉKOSAN
// formátumot ellenőrzünk és nem beégetett listát: új sablont a Metánál hoznak
// létre, és ne kelljen hozzá kódot módosítani.
const TEMPLATE_RE = /^[a-z0-9_]{1,64}$/;
const LANGUAGE_RE = /^[a-z]{2}(_[A-Z]{2})?$/;

// Percenként ennyi kimenő üzenetet küldhet EGY ügyintéző. A Graph API hívása
// pénzbe kerül, és a wa_messages tábla is telik — a nginx vödre (uni_fn) a
// mennyiséget fogja, ez pedig a küldőt. Meglévő táblából számolunk, hogy ne
// kelljen se új séma, se memóriában tartott állapot (az izolátum bármikor
// újraindulhat).
const MAX_SENDS_PER_MINUTE = Number(Deno.env.get('WHATSAPP_MAX_SENDS_PER_MINUTE') ?? '20');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ---- 1. ki hívja? Csak bejelentkezett ügyintéző küldhet. ----
  const authHeader = req.headers.get('Authorization') ?? '';
  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });

  const { data: userData } = await caller.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ error: 'unauthorised' }, 401);

  const { data: isStaff, error: staffErr } = await caller.rpc('is_staff');
  if (staffErr) {
    // A nyers adatbázishiba séma- és megszorításneveket szivárogtat, ezért
    // csak a naplóba kerül; a hívó kódot kap.
    console.error('whatsapp-send: is_staff hiba:', staffErr.message);
    return json({ error: 'staff_check_failed' }, 500);
  }
  if (!isStaff) return json({ error: 'forbidden', detail: 'Csak ügyintéző küldhet WhatsApp üzenetet.' }, 403);

  // ---- 2. bemenet ----
  let payload: Record<string, any>;
  try { payload = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const to = normalise(payload.to);
  const text: string = (payload.text ?? '').toString().trim();
  const template: string = (payload.template ?? '').toString().trim();
  const language: string = (payload.language ?? 'hu').toString();
  const components = Array.isArray(payload.components) ? payload.components : [];

  if (!to) return json({ error: 'missing_to' }, 400);
  if (to.length > MAX_PHONE_DIGITS) {
    return json({ error: 'invalid_to', detail: 'A telefonszám legfeljebb 15 számjegy lehet (E.164).' }, 400);
  }
  if (!text && !template) return json({ error: 'missing_body', detail: 'Szöveg vagy sablonnév kötelező.' }, 400);
  if (text.length > MAX_TEXT_LEN) {
    return json({ error: 'text_too_long', detail: `A szöveg legfeljebb ${MAX_TEXT_LEN} karakter lehet.` }, 400);
  }
  if (template && !TEMPLATE_RE.test(template)) {
    return json({ error: 'invalid_template', detail: 'A sablonnév csak kisbetűt, számjegyet és aláhúzást tartalmazhat.' }, 400);
  }
  if (!LANGUAGE_RE.test(language)) {
    return json({ error: 'invalid_language', detail: 'A nyelvkód formátuma pl. "hu" vagy "en_US".' }, 400);
  }
  if (components.length > MAX_COMPONENTS) {
    return json({ error: 'too_many_components' }, 400);
  }
  if (components.length && JSON.stringify(components).length > MAX_COMPONENT_BYTES) {
    return json({ error: 'components_too_large' }, 400);
  }
  if (components.length && !template) {
    return json({ error: 'components_without_template', detail: 'A "components" csak sablonhoz adható meg.' }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- 2b. küldési sebességkorlát, küldőnként ----
  // A meglévő wa_messages táblából számolunk: nem kell új séma, és az
  // Edge-izolátum újraindulása sem nullázza le a számlálót.
  if (MAX_SENDS_PER_MINUTE > 0) {
    const egyPercce = new Date(Date.now() - 60_000).toISOString();
    const { count, error: countErr } = await admin
      .from('wa_messages')
      .select('id', { count: 'exact', head: true })
      .eq('direction', 'out')
      .eq('sent_by', user.email ?? '')
      .gte('created_at', egyPercce);
    if (countErr) {
      // Ha a számlálás nem megy, NEM blokkolunk: a nginx vödre akkor is véd.
      console.error('whatsapp-send: a küldésszámlálás nem sikerült:', countErr.message);
    } else if ((count ?? 0) >= MAX_SENDS_PER_MINUTE) {
      return new Response(
        JSON.stringify({ error: 'rate_limited', detail: `Percenként legfeljebb ${MAX_SENDS_PER_MINUTE} üzenet küldhető.` }),
        { status: 429, headers: { ...CORS, 'Content-Type': 'application/json', 'Retry-After': '60' } },
      );
    }
  }

  // ---- 3. a 24 órás ablak ----
  // A Meta csak akkor engedi a szabad szöveget, ha a partner az elmúlt 24
  // órában írt. Ezt itt is ellenőrizzük, hogy ne a Graph API hibájából
  // derüljön ki — az üzenet így el sem indul, és nem kerül a naplóba sikeresként.
  if (!template) {
    const { data: open } = await admin.rpc('wa_window_open', { p_wa_id: to });
    if (open === false) {
      return json({
        error: 'window_closed',
        detail: 'A 24 órás ablak lezárult: ehhez a partnerhez csak jóváhagyott sablonnal lehet üzenetet kezdeményezni.',
      }, 409);
    }
  }

  // ---- 4. küldés (vagy szimuláció) ----
  const live = Boolean(WA_TOKEN && WA_PHONE_ID);
  let waMessageId: string | null = null;
  let status = 'sent';
  let errorText: string | null = null;

  if (live) {
    const body = template
      ? { messaging_product: 'whatsapp', to, type: 'template', template: { name: template, language: { code: language }, components } }
      : { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } };

    try {
      const res = await fetch(`https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        status = 'failed';
        errorText = data?.error?.message ?? `HTTP ${res.status}`;
      } else {
        waMessageId = data?.messages?.[0]?.id ?? null;
      }
    } catch (e) {
      status = 'failed';
      errorText = (e as Error).message;
    }
  }

  // ---- 5. naplózás ----
  const row = {
    id: newId(),
    wa_message_id: waMessageId,
    wa_id: to,
    direction: 'out',
    msg_type: template ? 'template' : 'text',
    body: template ? (text || `[sablon: ${template}]`) : text,
    template_name: template || null,
    status,
    error: errorText,
    sent_by: user.email ?? null,
    simulated: !live,
  };
  const { error: insErr } = await admin.from('wa_messages').insert(row);
  if (insErr) {
    console.error('whatsapp-send: a naplózás nem sikerült:', insErr.message);
    return json({ error: 'db_insert_failed' }, 500);
  }

  await admin.from('wa_contacts')
    .upsert({ wa_id: to, last_message_at: new Date().toISOString() }, { onConflict: 'wa_id' });

  return json({
    ok: status !== 'failed',
    simulated: !live,
    status,
    message_id: waMessageId,
    error: errorText,
  }, status === 'failed' ? 502 : 200);
});
