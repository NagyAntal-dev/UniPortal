// ============================================================================
// A SAML-lal azonosított felhasználó megkeresése / regisztrálása, és egy
// egyszer használható bejelentkezési token kiállítása.
//
// A GoTrue-t (auth) és a PostgREST-et (rest) a belső hálózaton, a
// SERVICE_ROLE_KEY-jel hívjuk. A felhasználó a végén NORMÁL Supabase
// munkamenetet kap (verifyOtp) — így minden RLS-szabály (auth.uid()), a
// tokenfrissítés és a kijelentkezés változatlanul működik.
//
// Sorrend:
//   1. saml_find_user(ePPN, e-mail, displayName, hallgatói tartományok) —
//      ePPN → e-mail → Neptun-kód → oktatónév (79_saml_import_match.sql).
//      A két utolsó ág a munkafüzetből importált, PLACEHOLDER bejelentkezési
//      nevű fiókokat találja meg: nélkülük a hallgató új, üres fiókot kapna,
//      az importált pedig a 66 ezer kurzusfelvétellel együtt árván maradna.
//   2a. Új felhasználó: POST /admin/users (megerősített e-mail). A profilt a
//       handle_new_user trigger hozza létre (STUDENT, pending) — a
//       saml_link_login ezt hagyja jóvá.
//   2b. Meglévő fiók (e-mail / Neptun-kód / oktatónév): hozzákötjük, de a
//       szerepkörét és jóváhagyását NEM bántjuk. Ha az e-mailje sosem lett
//       megerősítve, a jelszavát véletlenre cseréljük — különben aki előre
//       regisztrált valaki más NJE-címére, megtartaná a jelszót egy fiókhoz,
//       amit a valódi tulajdonos most átvesz. Importált fiók átvételekor a
//       .invalid bejelentkezési nevet a valódi címre cseréljük, és a
//       credentials.csv-ben kiosztott jelszót érvénytelenítjük.
//   3. saml_link_login — az azonosító sor és az attribútumok mentése.
//   4. POST /admin/generate_link (magiclink) — levelet NEM küld; a
//      hashed_token-t a böngésző a verifyOtp-vel váltja munkamenetre.
// ============================================================================
import { randomBytes } from 'node:crypto';

// Azok a találati ágak, ahol egy MEGLÉVŐ fiókot kötünk az NJE-azonosítóhoz.
// Az 'eppn' SZÁNDÉKOSAN nincs köztük: az a visszatérő felhasználó, akinél
// nincs mit átvenni, és egy fölösleges admin-hívás csak kockázat.
const LINKED_MATCHES = new Set(['email', 'neptun', 'teacher_name']);

export class ProvisionError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function createProvisioner(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const headers = {
    Authorization: `Bearer ${cfg.serviceKey}`,
    apikey: cfg.serviceKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  async function call(url, method, body) {
    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* nem JSON */ }
    if (!res.ok) {
      const msg = (json && (json.msg || json.message || json.error_description || json.error)) || text.slice(0, 200);
      throw new ProvisionError(`${method} ${new URL(url).pathname}: HTTP ${res.status} ${msg}`, res.status, json);
    }
    return json;
  }

  const rpc = (fn, args) => call(`${cfg.restUrl}/rpc/${fn}`, 'POST', args);
  const admin = (path, method, body) => call(`${cfg.gotrueUrl}${path}`, method, body);

  // A displayName az OKTATÓI párosításhoz kell: az importált oktatóknak nincs
  // se Neptun-kódjuk, se valódi e-mail-címük, csak a nevük.
  async function findUser(a) {
    const rows = await rpc('saml_find_user', {
      p_eppn: a.eppn,
      p_email: a.email,
      p_display_name: a.displayName || null,
      p_student_scopes: cfg.studentScopes,
    });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  // Egy munkafüzet-importból származó, még soha nem használt bejelentkezési név.
  const isImportPlaceholder = (email) =>
    String(email || '').toLowerCase().endsWith(`@${cfg.importEmailDomain}`);

  async function createUser(a) {
    return admin('/admin/users', 'POST', {
      email: a.email,
      email_confirm: true,
      user_metadata: a.displayName ? { name: a.displayName } : {},
      app_metadata: { sso: 'nje' },
    });
  }

  async function provision(a, session = {}) {
    if (!a.eppn) throw new ProvisionError('Hiányzó eduPersonPrincipalName.', 400);
    if (!a.email) throw new ProvisionError('Hiányzó e-mail cím.', 400);

    let found = await findUser(a);
    let userId;
    let email;
    let isNew = false;

    if (!found) {
      try {
        const u = await createUser(a);
        userId = u.id;
        email = u.email;
        isNew = true;
      } catch (e) {
        // Két párhuzamos első belépés: a másik kérés már létrehozta.
        if (!(e instanceof ProvisionError) || e.status !== 422) throw e;
        found = await findUser(a);
        if (!found) throw e;
      }
    }

    if (found) {
      userId = found.user_id;
      email = found.email;
      if (LINKED_MATCHES.has(found.matched_by)) {
        const patch = { app_metadata: { sso: 'nje' } };
        if (!found.email_confirmed) {
          patch.email_confirm = true;
          patch.password = randomBytes(32).toString('base64url');
        }
        // A munkafüzetből importált fiók ÁTVÉTELE. A .invalid cím nem
        // postafiók (jelszó-emlékeztető sem érhet oda), a hozzá kiosztott
        // jelszó pedig egy CSV-ben kézen-közön terjedt. Az IdP most igazolta,
        // hogy a fiók gazdája lépett be, tehát átállunk a valódi címére, és a
        // régi jelszót érvénytelenítjük.
        //
        // Ütközés nincs: ha az a.email MÁR létezne fiókként, a saml_find_user
        // 2. lépése (e-mail) megtalálta volna, és ide sem jutnánk el.
        //
        // A GoTrue az e-mail cserekor a hozzá tartozó 'email' identity sorát is
        // átírja. Ezt élő GoTrue nélkül nem tudjuk lemérni — az üzembe
        // helyezés füst-tesztjén ezt kell elsőként megnézni.
        if (isImportPlaceholder(email) && a.email) {
          patch.email = a.email;
          patch.email_confirm = true;
          patch.password = randomBytes(32).toString('base64url');
        }
        await admin(`/admin/users/${encodeURIComponent(userId)}`, 'PUT', patch);
        // A magic linket LENT a fiók saját címére kérjük — ha az imént
        // írtuk át, a RÉGI címmel a bejelentkezés elhasalna.
        if (patch.email) email = patch.email;
      }
    }

    await rpc('saml_link_login', {
      p_eppn: a.eppn,
      p_user_id: userId,
      p_email: a.email,
      p_display_name: a.displayName || null,
      p_ou: a.ou || null,
      p_title: a.title || null,
      p_office: a.office || null,
      p_name_id: session.nameID || null,
      p_session_index: session.sessionIndex || null,
      p_is_new: isNew,
    });

    const link = await admin('/admin/generate_link', 'POST', { type: 'magiclink', email });
    const tokenHash = (link && (link.hashed_token || (link.properties && link.properties.hashed_token))) || '';
    if (!tokenHash) throw new ProvisionError('A GoTrue nem adott bejelentkezési tokent.', 502, link);

    return {
      userId,
      tokenHash,
      isNew,
      matchedBy: found ? found.matched_by : null,
      linked: Boolean(found && LINKED_MATCHES.has(found.matched_by)),
    };
  }

  // Az IdP által kezdeményezett kijelentkezés: a NameID-hez tartozó
  // felhasználó(k) munkameneteinek visszavonása.
  async function logoutByNameId(nameID) {
    if (!nameID) return 0;
    const n = await rpc('saml_logout', { p_name_id: nameID });
    return Number(n) || 0;
  }

  return { provision, logoutByNameId };
}
