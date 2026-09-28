// ============================================================
// echo-receipt — visszaigazoló e-mail az ECHO kérdőív kitöltése után
//
// MIÉRT NEM AZ echo_submit KÜLDI: az echo_submit anon jogon fut, és
// szándékosan nem tudja, ki küldött be (15_echo_core.sql fejléce). A
// böngésző a SIKERES anonim beküldés UTÁN, külön, AZONOSÍTOTT kérésben hívja
// ezt a függvényt — ugyanúgy, ahogy az echo_draft_drop-ot is. Ez a kérés
// semmilyen választ nem hordoz, csak a kampány/kurzus párt és a nyelvet.
//
// AMIT A LEVÉL NEM TARTALMAZ: se választ, se időpontot. A levelezőszolgáltató
// így is látja a címzettet, a kurzust és a küldés idejét — ez a felhasználó
// tudatos döntése volt az azonnali visszaigazolás mellett.
//
// JOGOSULTSÁG: a hívó tokenjével (auth.getUser()), majd ugyanazzal a
// tokennel az echo_my_courses() — csak akkor megy levél, ha a hívónak van
// részvételi sora erre a kampányra/kurzusra, és kért már jegyet (attempted).
// A CÍMZETT MINDIG A HÍVÓ SAJÁT CÍME, paraméterben nem adható meg. A
// mennyiséget a web nginxe (uni_fn vödör) fogja.
//
// SMTP nélkül nem hibázik: { sent: false, reason: 'smtp_not_configured' }
// — a kitöltés attól még sikeres, helyi próbához így is használható.
//
// Deploy:  supabase functions deploy echo-receipt
// Secretek: supabase secrets set SMTP_HOST=… SMTP_PORT=… SMTP_USER=… SMTP_PASS=…
//           SMTP_ADMIN_EMAIL=… SMTP_SENDER_NAME=… UNIPORTAL_SITE_URL=…
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6';
import { renderReceipt } from './template.ts';

// Ugyanaz a CORS-szűkítés, mint a whatsapp-send-ben: csak a saját nyilvános
// címünkről hívható.
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

// A levél linkjei (app.html, privacy.html, terms.html) erre a címre mutatnak.
// A Docker-telepítésen a web szolgáltatja az oldalt és az API-t is, ezért a
// SUPABASE_PUBLIC_URL jó tartalék.
const SITE_URL = Deno.env.get('UNIPORTAL_SITE_URL') || Deno.env.get('SUPABASE_PUBLIC_URL') || '';

const SMTP_HOST = Deno.env.get('SMTP_HOST') ?? '';
const SMTP_PORT = Number(Deno.env.get('SMTP_PORT') || '465');
const SMTP_USER = Deno.env.get('SMTP_USER') ?? '';
const SMTP_PASS = Deno.env.get('SMTP_PASS') ?? '';
const SMTP_FROM = Deno.env.get('SMTP_ADMIN_EMAIL') ?? '';
const SMTP_NAME = Deno.env.get('SMTP_SENDER_NAME') || 'UniPortal';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asLang = (v: unknown): 'hu' | 'en' | null => (v === 'hu' || v === 'en' ? v : null);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ---- 1. ki hívja? ----
  const authHeader = req.headers.get('Authorization') ?? '';
  const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });

  const { data: userData } = await caller.auth.getUser();
  const user = userData?.user;
  if (!user) return json({ error: 'unauthorised' }, 401);
  if (!user.email) return json({ error: 'no_email' }, 400);

  // ---- 2. bemenet ----
  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const campaignId = String(payload.campaign_id ?? '');
  const courseId = String(payload.course_id ?? '');
  if (!UUID_RE.test(campaignId) || !UUID_RE.test(courseId)) return json({ error: 'invalid_ids' }, 400);

  // A felület nyelve; ha nincs, a regisztrációkor mentett nyelv; ha az sincs,
  // kétnyelvű levél (renderReceipt, lang = null).
  const lang = asLang(payload.lang) ?? asLang(user.user_metadata?.lang);

  // ---- 3. részt vett-e ezen a kurzuson? ----
  const { data: courses, error: coursesErr } = await caller.rpc('echo_my_courses');
  if (coursesErr) {
    // A nyers hibaüzenet sémaneveket szivárogtatna — csak a naplóba kerül.
    console.error('echo-receipt: echo_my_courses hiba:', coursesErr.message);
    return json({ error: 'forbidden' }, 403);
  }
  const row = (Array.isArray(courses) ? courses : [])
    .find((r: Record<string, unknown>) => r.campaign_id === campaignId && r.course_id === courseId);
  if (!row || !row.attempted) return json({ error: 'forbidden' }, 403);

  // ---- 4. küldés ----
  if (!SMTP_HOST || !SMTP_FROM) return json({ sent: false, reason: 'smtp_not_configured' });

  const mail = renderReceipt({
    lang,
    courseName: String(row.course_name ?? ''),
    courseNameEn: String(row.course_name_en ?? ''),
    courseCode: String(row.course_code ?? ''),
    campaignName: String(row.campaign_name ?? ''),
    siteUrl: SITE_URL,
  });

  try {
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
    await transport.sendMail({
      from: { name: SMTP_NAME, address: SMTP_FROM },
      to: user.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (e) {
    console.error('echo-receipt: SMTP hiba:', (e as Error)?.message ?? e);
    return json({ sent: false, reason: 'smtp_failed' }, 502);
  }

  return json({ sent: true });
});
