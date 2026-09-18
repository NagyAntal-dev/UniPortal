// ============================================================================
// A szolgáltatás beállításai — kizárólag környezeti változókból (.env →
// docker-compose.yml). Hiányzó kötelező értéknél NEM indul el: egy félig
// beállított SAML-végpont rosszabb, mint egy, ami hangosan hibát jelez.
// ============================================================================

import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';

const NJE_IDP ='https://idp.nje.hu/simplesaml/saml2/idp/metadata.php';

// A kulcs / tanúsítvány háromféle alakban jöhet a .env-ből:
//   - PEM szövegként (-----BEGIN …),
//   - a PEM base64-e (így fér el egy .env sorban — az init-env.sh így írja),
//   - a tanúsítvány puszta base64 törzse (ahogy a metaadat XML-ben áll).
export function decodePem(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.includes('-----BEGIN')) return v.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8');
    if (decoded.includes('-----BEGIN')) return decoded.trim();
  } catch { /* nem base64 — lent puszta törzsként kezeljük */ }
  return v.replace(/\s+/g, '');
}

// Az SP kulcsa és tanúsítványa összetartozik-e. Ha nem, az IdP az aláírt
// kéréseinket csendben elutasítaná — ezt inkább induláskor mondjuk ki.
export function checkKeyPair(keyPem, certPem) {
  let key;
  let cert;
  try {
    key = createPrivateKey(keyPem);
  } catch (e) {
    throw new Error(`A SAML_SP_PRIVATE_KEY nem olvasható privát kulcs (${e.message}). Futtasd: sh deploy/saml-sp/gen-keys.sh`);
  }
  try {
    cert = new X509Certificate(certPem);
  } catch (e) {
    throw new Error(`A SAML_SP_CERT nem olvasható tanúsítvány (${e.message}). Futtasd: sh deploy/saml-sp/gen-keys.sh`);
  }
  const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const fromCert = cert.publicKey.export({ type: 'spki', format: 'der' });
  if (!fromKey.equals(fromCert)) {
    throw new Error('A SAML_SP_CERT nem a SAML_SP_PRIVATE_KEY kulcshoz tartozik. Futtasd: sh deploy/saml-sp/gen-keys.sh');
  }
}

export function loadConfig(env = process.env) {
  const missing = [];
  const need = (name) => {
    const v = String(env[name] || '').trim();
    if (!v) missing.push(name);
    return v;
  };

  const publicUrl = need('UNIPORTAL_PUBLIC_URL').replace(/\/+$/, '');
  const spKey = decodePem(need('SAML_SP_PRIVATE_KEY'));
  const spCert = decodePem(need('SAML_SP_CERT'));
  const cookieSecret = need('SAML_COOKIE_SECRET');
  const serviceKey = need('SERVICE_ROLE_KEY');

  if (missing.length) {
    throw new Error(`Hiányzó környezeti változó(k): ${missing.join(', ')} — lásd docs/nje-saml.md`);
  }
  if (cookieSecret.length < 32) {
    throw new Error('A SAML_COOKIE_SECRET legalább 32 karakter legyen (openssl rand -hex 32).');
  }
  checkKeyPair(spKey, spCert);

  const idpEntityId = String(env.SAML_IDP_ENTITY_ID || NJE_IDP).trim();

  // Az IdP felé hirdetett útvonal (metadata, acs, slo). Alapból /saml; ha az
  // IT-nál egy korábbi bejegyzés él (pl. a GoTrue-s /auth/v1/sso/saml), a
  // SAML_SP_PATH-szal ugyanazokon a címeken válaszolunk. A /saml/login és a
  // /saml/logout mindig /saml alatt marad (azokat a felület hívja).
  const spPath = `/${String(env.SAML_SP_PATH || '/saml').trim().replace(/^\/+|\/+$/g, '')}`;
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(spPath)) {
    throw new Error(`Érvénytelen SAML_SP_PATH: ${spPath}`);
  }

  return {
    port: Number(env.PORT) || 3000,
    publicUrl,
    spPath,
    entityId: String(env.SAML_SP_ENTITY_ID || `${publicUrl}${spPath}/metadata`).trim(),
    acsUrl: `${publicUrl}${spPath}/acs`,
    sloUrl: `${publicUrl}${spPath}/slo`,
    spKey,
    spCert,
    idpEntityId,
    idpSsoUrl: String(env.SAML_IDP_SSO_URL || 'https://idp.nje.hu/simplesaml/saml2/idp/SSOService.php').trim(),
    idpSloUrl: String(env.SAML_IDP_SLO_URL || 'https://idp.nje.hu/simplesaml/saml2/idp/SingleLogoutService.php').trim(),
    idpMetadataUrl: String(env.SAML_IDP_METADATA_URL || idpEntityId).trim(),
    // Ha meg van adva, ez a tanúsítvány az EGYETLEN elfogadott aláíró —
    // a metaadatot ekkor nem töltjük le. Élesben ez az ajánlott.
    idpCert: decodePem(env.SAML_IDP_CERT),
    cookieSecret,
    secureCookies: publicUrl.startsWith('https://'),
    gotrueUrl: String(env.GOTRUE_URL || 'http://auth:9999').replace(/\/+$/, ''),
    restUrl: String(env.POSTGREST_URL || 'http://rest:3000').replace(/\/+$/, ''),
    serviceKey,
  };
}
