// ============================================================================
// A /saml/* végpontok. Az nginx (deploy/web/default.conf.template) a
// nyilvános cím /saml/ útvonalát továbbítja ide.
//
//   GET       /saml/metadata   SP-metaadat — ezt kapja meg az NJE IT
//   GET       /saml/login      bejelentkezés indítása (?next=app.html)
//   POST      /saml/acs        az IdP válasza → felhasználó → munkamenet
//   GET       /saml/logout     kijelentkezés az IdP-ről is (SP-kezdeményezett)
//   GET|POST  /saml/slo        az IdP kijelentkezési kérése / válasza
//   GET       /saml/healthz
// ============================================================================
import express from 'express';
import { mapAttributes, safeNext, validateLoginResponse } from './saml.js';
import { SID_COOKIE, sign, verify, readCookie, cookieHeader } from './cookie.js';

const SID_MAX_AGE = 12 * 3600;

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function createApp(cfg, { saml, provisioner, log = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const toPage = (page, fragment = '') => `${cfg.publicUrl}/${page}${fragment ? `#${fragment}` : ''}`;
  const fail = (res, code) => res.redirect(303, toPage('index.html', `sso_error=${encodeURIComponent(code)}`));
  const clearSid = (res) => res.append('Set-Cookie', cookieHeader(SID_COOKIE, '', { maxAgeSec: 0, secure: cfg.secureCookies }));

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });

  // Az IdP-nek szóló végpontok a /saml alatt ÉS a SAML_SP_PATH alatt is
  // elérhetők (pl. /auth/v1/sso/saml — lásd config.js).
  const spPath = cfg.spPath || '/saml';
  const idp = (name) => [...new Set([`/saml/${name}`, `${spPath}/${name}`])];

  const form = express.urlencoded({ extended: false, limit: '512kb', parameterLimit: 20 });

  app.get('/saml/healthz', (req, res) => res.type('text/plain').send('ok\n'));

  app.get(idp('metadata'), (req, res) => {
    res.type('application/xml').send(saml.generateServiceProviderMetadata(cfg.spCert, cfg.spCert));
  });

  app.get('/saml/login', async (req, res) => {
    try {
      const url = await saml.getAuthorizeUrlAsync(safeNext(req.query.next), undefined, {});
      res.redirect(302, url);
    } catch (e) {
      log.error(`[saml] login: ${e.message}`);
      fail(res, 'start_failed');
    }
  });

  app.post(idp('acs'), form, async (req, res) => {
    let profile;
    try {
      profile = await validateLoginResponse(saml, cfg, req.body);
    } catch (e) {
      log.warn(`[saml] acs: érvénytelen válasz: ${e.message}`);
      return fail(res, /InResponseTo/i.test(e.message) ? 'expired' : 'invalid_response');
    }

    const attrs = mapAttributes(profile);
    if (!attrs.eppn) return fail(res, 'missing_eppn');
    if (!attrs.email) return fail(res, 'missing_email');

    let result;
    try {
      result = await provisioner.provision(attrs, { nameID: profile.nameID, sessionIndex: profile.sessionIndex });
    } catch (e) {
      log.error(`[saml] acs: felhasználó (${attrs.eppn}): ${e.message}`);
      return fail(res, 'provision_failed');
    }
    log.info(`[saml] belépés: ${attrs.eppn}${result.isNew ? ' (új regisztráció)' : ''}${result.linked ? ' (meglévő fiókhoz kötve)' : ''}`);

    const sid = sign(cfg.cookieSecret, {
      nameID: profile.nameID,
      nameIDFormat: profile.nameIDFormat,
      nameQualifier: profile.nameQualifier,
      spNameQualifier: profile.spNameQualifier,
      sessionIndex: profile.sessionIndex,
    }, SID_MAX_AGE);
    res.append('Set-Cookie', cookieHeader(SID_COOKIE, sid, { maxAgeSec: SID_MAX_AGE, secure: cfg.secureCookies }));

    // A token a # utáni részben utazik: a böngésző nem küldi el a szervernek,
    // tehát semmilyen naplóba (nginx, proxy) nem kerül bele.
    const next = safeNext(req.body && req.body.RelayState);
    res.redirect(303, toPage(next, `sso_token_hash=${encodeURIComponent(result.tokenHash)}`));
  });

  app.get('/saml/logout', async (req, res) => {
    const sid = verify(cfg.cookieSecret, readCookie(req, SID_COOKIE));
    clearSid(res);
    if (!sid || !sid.nameID) return res.redirect(303, toPage('index.html'));
    try {
      const url = await saml.getLogoutUrlAsync({
        issuer: cfg.idpEntityId,
        nameID: sid.nameID,
        nameIDFormat: sid.nameIDFormat,
        nameQualifier: sid.nameQualifier,
        spNameQualifier: sid.spNameQualifier,
        sessionIndex: sid.sessionIndex,
      }, 'index.html', {});
      res.redirect(302, url);
    } catch (e) {
      log.error(`[saml] logout: ${e.message}`);
      res.redirect(303, toPage('index.html'));
    }
  });

  // Az IdP kijelentkeztetett (másik alkalmazásból indított SLO): a
  // munkameneteket az adatbázisban visszavonjuk, a böngészőben tárolt
  // Supabase-munkamenetet pedig ez az oldal törli (ugyanaz az origin), mielőtt
  // visszaküldi a választ az IdP-nek.
  const answerLogoutRequest = async (res, profile, relayState) => {
    try {
      const n = await provisioner.logoutByNameId(profile.nameID);
      log.info(`[saml] IdP-kijelentkeztetés: ${n} fiók munkamenetei visszavonva.`);
    } catch (e) {
      log.error(`[saml] slo: munkamenetek visszavonása: ${e.message}`);
    }
    const url = await saml.getLogoutResponseUrlAsync(profile, relayState || '', {}, true);
    clearSid(res);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Kijelentkezés…</title>
<script>
try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (/^sb-.+-auth-token/.test(k)) localStorage.removeItem(k); } } catch (e) {}
location.replace(${JSON.stringify(url).replace(/</g, '\\u003c')});
</script>
<noscript><a href="${htmlEscape(url)}">Tovább</a></noscript>`);
  };

  const handleSlo = async (req, res, validate) => {
    try {
      // LogoutRequest esetén a profile a kijelentkeztetett felhasználó;
      // LogoutResponse esetén null.
      const { profile } = await validate();
      if (profile && (req.query.SAMLRequest || (req.body && req.body.SAMLRequest))) {
        return answerLogoutRequest(res, profile, req.query.RelayState || (req.body && req.body.RelayState));
      }
      // Válasz a MI kijelentkezési kérésünkre — vissza a nyitóoldalra.
      clearSid(res);
      res.redirect(303, toPage('index.html'));
    } catch (e) {
      log.warn(`[saml] slo: ${e.message}`);
      clearSid(res);
      res.redirect(303, toPage('index.html'));
    }
  };

  app.get(idp('slo'), (req, res) => handleSlo(req, res, () => {
    const originalQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    return saml.validateRedirectAsync(req.query, originalQuery);
  }));

  app.post(idp('slo'), form, (req, res) => handleSlo(req, res, () => (
    req.body && req.body.SAMLRequest
      ? saml.validatePostRequestAsync(req.body)
      : saml.validatePostResponseAsync(req.body || {})
  )));

  app.use((req, res) => res.status(404).type('text/plain').send('not found\n'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`[saml] ${req.method} ${req.path}: ${err.message}`);
    if (req.path.endsWith('/acs')) return fail(res, 'invalid_response');
    res.status(err.status && err.status < 500 ? err.status : 500).type('text/plain').send('error\n');
  });

  return app;
}
