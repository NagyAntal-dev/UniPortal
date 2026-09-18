// ============================================================================
// A szolgáltatás beállításai — kizárólag környezeti változókból (.env →
// docker-compose.yml). Hiányzó kötelező értéknél NEM indul el: egy félig
// beállított SAML-végpont rosszabb, mint egy, ami hangosan hibát jelez.
// ============================================================================

const NJE_IDP = 'https://idp.nje.hu/simplesaml/saml2/idp/metadata.php';

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

  const idpEntityId = String(env.SAML_IDP_ENTITY_ID || NJE_IDP).trim();

  return {
    port: Number(env.PORT) || 3000,
    publicUrl,
    entityId: String(env.SAML_SP_ENTITY_ID || `${publicUrl}/saml/metadata`).trim(),
    acsUrl: `${publicUrl}/saml/acs`,
    sloUrl: `${publicUrl}/saml/slo`,
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
