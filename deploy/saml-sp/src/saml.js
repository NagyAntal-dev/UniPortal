// ============================================================================
// SAML 2.0 service provider — a node-saml köré épített vékony réteg.
//
// Az NJE IdP (SimpleSAMLphp) az attribútumokat OID-névvel küldi
// (NameFormat: urn:oasis:names:tc:SAML:2.0:attrname-format:uri):
//
//   urn:oid:1.3.6.1.4.1.5923.1.1.1.6   eduPersonPrincipalName  → állandó azonosító
//   urn:oid:0.9.2342.19200300.100.1.3  mail
//   urn:oid:2.16.840.1.113730.3.1.241  displayName
//   urn:oid:2.5.4.11                   ou
//   urn:oid:2.5.4.12                   title
//   urn:oid:2.5.4.19                   physicalDeliveryOfficeName
// ============================================================================
import { SAML, ValidateInResponseTo } from '@node-saml/node-saml';

export const OID = {
  eppn: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
  mail: 'urn:oid:0.9.2342.19200300.100.1.3',
  displayName: 'urn:oid:2.16.840.1.113730.3.1.241',
  ou: 'urn:oid:2.5.4.11',
  title: 'urn:oid:2.5.4.12',
  office: 'urn:oid:2.5.4.19',
};
// Tartalék: ha az IdP egyszer átállna a rövid (basic) nevekre.
const FRIENDLY = {
  eppn: 'eduPersonPrincipalName',
  mail: 'mail',
  displayName: 'displayName',
  ou: 'ou',
  title: 'title',
  office: 'physicalDeliveryOfficeName',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstValue(v) {
  const list = Array.isArray(v) ? v : [v];
  for (const item of list) {
    const s = typeof item === 'string' ? item : (item && typeof item._ === 'string' ? item._ : '');
    if (s.trim()) return s.trim();
  }
  return '';
}

export function mapAttributes(profile) {
  const attrs = (profile && profile.attributes) || profile || {};
  const get = (k) => firstValue(attrs[OID[k]] ?? attrs[FRIENDLY[k]]).slice(0, 320);
  const eppn = get('eppn').toLowerCase();
  let email = get('mail').toLowerCase();
  // Az ePPN az NJE-nél felhasznalo@nje.hu alakú — levélcím híján az is megfelel.
  if (!EMAIL_RE.test(email)) email = EMAIL_RE.test(eppn) ? eppn : '';
  return {
    eppn,
    email,
    displayName: get('displayName'),
    ou: get('ou'),
    title: get('title'),
    office: get('office'),
  };
}

// A bejelentkezés után csak ezekre az oldalakra térhetünk vissza — a
// RelayState a böngészőn át utazik, tehát nem lehet belőle nyitott átirányítás.
const ALLOWED_NEXT = new Set(['app.html', 'index.html']);
export function safeNext(value, fallback = 'app.html') {
  return ALLOWED_NEXT.has(String(value || '')) ? String(value) : fallback;
}

// Az IdP metaadatából az ALÁÍRÓ tanúsítvány(ok) (use="signing" vagy use nélkül).
export function extractSigningCerts(xml) {
  const certs = [];
  const kdRe = /<(?:[\w-]+:)?KeyDescriptor\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?KeyDescriptor>/g;
  let m;
  while ((m = kdRe.exec(String(xml || '')))) {
    const use = /\buse\s*=\s*["']([^"']+)["']/.exec(m[1]);
    if (use && use[1] !== 'signing') continue;
    const certRe = /<(?:[\w-]+:)?X509Certificate\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?X509Certificate>/g;
    let c;
    while ((c = certRe.exec(m[2]))) {
      const body = c[1].replace(/\s+/g, '');
      if (body && !certs.includes(body)) certs.push(body);
    }
  }
  return certs;
}

// Az IdP aláíró tanúsítványa. A .env-ben rögzített (SAML_IDP_CERT) érték
// mindig nyer; különben a metaadatból töltjük le HTTPS-en, és naponta
// frissítjük (az IdP tanúsítványcseréje így magától átjön).
export class IdpCertStore {
  constructor(cfg, { fetchImpl = globalThis.fetch, log = console } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.certs = cfg.idpCert ? [cfg.idpCert] : [];
    this.pinned = Boolean(cfg.idpCert);
    this.callback = (cb) => {
      if (this.certs.length) cb(null, this.certs);
      else cb(new Error('Az IdP aláíró tanúsítványa még nem töltődött be.'));
    };
  }

  async refresh() {
    if (this.pinned) return this.certs;
    const res = await this.fetchImpl(this.cfg.idpMetadataUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`IdP metaadat: HTTP ${res.status}`);
    const certs = extractSigningCerts(await res.text());
    if (!certs.length) throw new Error('IdP metaadat: nincs benne aláíró tanúsítvány.');
    this.certs = certs;
    return certs;
  }

  // Induláskor addig próbálkozik percenként, amíg sikerül; utána naponta.
  start() {
    if (this.pinned) {
      this.log.info('[saml] IdP tanúsítvány: rögzített (SAML_IDP_CERT).');
      return;
    }
    const tick = async () => {
      let next = 24 * 3600 * 1000;
      try {
        const certs = await this.refresh();
        this.log.info(`[saml] IdP tanúsítvány betöltve a metaadatból (${certs.length} db).`);
      } catch (e) {
        this.log.error(`[saml] IdP metaadat letöltése sikertelen: ${e.message}`);
        if (!this.certs.length) next = 60 * 1000;
      }
      this.timer = setTimeout(tick, next);
      this.timer.unref?.();
    };
    tick();
  }
}

// A bejelentkezési válasz ellenőrzése. A node-saml az idpIssuer-t CSAK a
// kijelentkezési üzeneteken nézi — az assertion kiállítóját itt ellenőrizzük.
// (Az aláírás már az NJE kulcsához köti; ez a második, olcsó védvonal.)
export async function validateLoginResponse(saml, cfg, body) {
  const { profile } = await saml.validatePostResponseAsync(body || {});
  if (!profile) throw new Error('A válasz nem tartalmaz bejelentkezést.');
  if (profile.issuer !== cfg.idpEntityId) {
    throw new Error(`Ismeretlen SAML-kiállító: ${profile.issuer}`);
  }
  return profile;
}

export function createSaml(cfg, certStore, overrides = {}) {
  return new SAML({
    entryPoint: cfg.idpSsoUrl,
    logoutUrl: cfg.idpSloUrl,
    issuer: cfg.entityId,
    audience: cfg.entityId,
    callbackUrl: cfg.acsUrl,
    logoutCallbackUrl: cfg.sloUrl,
    idpIssuer: cfg.idpEntityId,
    idpCert: certStore.callback,
    // A kéréseinket aláírjuk (AuthnRequest, LogoutRequest/Response).
    privateKey: cfg.spKey,
    publicCert: cfg.spCert,
    // Ha az IdP titkosítja az assertiont (egy korábbi bejegyzés alapján a
    // tanúsítványunkkal), ugyanezzel a kulccsal fejtjük vissza.
    decryptionPvk: cfg.spKey,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    // Az ASSERTION aláírása kötelező — ez hordozza a személyazonosságot. A
    // külső Response-borítékot a SimpleSAMLphp beállítástól függően írja alá.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // NameIDPolicy és AuthnContext nélkül: az IdP a saját alapértelmezését
    // adja (transient NameID). A felhasználót az ePPN azonosítja, nem a NameID.
    identifierFormat: null,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60 * 1000,
    // Csak az általunk indított bejelentkezésre adott választ fogadjuk el, és
    // mindegyiket egyszer: az IdP által kezdeményezett (kéretlen) belépést és a
    // visszajátszott választ is elutasítjuk.
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60 * 1000,
    ...overrides,
  });
}
