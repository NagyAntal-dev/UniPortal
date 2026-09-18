// Aláírt (HMAC-SHA256) süti a SAML-munkamenet adataihoz (NameID,
// SessionIndex) — ezek kellenek az IdP felé indított kijelentkezéshez.
// Nem titkos adat, de a hamisítását meg kell akadályozni.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SID_COOKIE = 'saml_sid';

const mac = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function sign(secret, data, maxAgeSec) {
  const payload = Buffer.from(JSON.stringify({ ...data, exp: Date.now() + maxAgeSec * 1000 })).toString('base64url');
  return `${payload}.${mac(secret, payload)}`;
}

export function verify(secret, value) {
  const [payload, sig] = String(value || '').split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data && data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export function cookieHeader(name, value, { maxAgeSec, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/saml/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}
