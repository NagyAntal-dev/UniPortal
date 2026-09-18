// SAML_SP_PATH=/auth/v1/sso/saml — az IT-nál a korábbi GoTrue-s címek vannak
// bejegyezve, és a saml-sp ugyanazokon válaszol.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createSaml, IdpCertStore } from '../src/saml.js';
import { loadConfig } from '../src/config.js';
import { testConfig, buildResponse, requestIdFromUrl, SP_KEY, SP_CERT } from './helpers.js';

const OLD = 'https://uniportal.test/auth/v1/sso/saml';
const cfg = testConfig({
  spPath: '/auth/v1/sso/saml',
  entityId: `${OLD}/metadata`,
  acsUrl: `${OLD}/acs`,
  sloUrl: `${OLD}/slo`,
});
const saml = createSaml(cfg, new IdpCertStore(cfg));
const provisioner = { async provision() { return { userId: 'u', tokenHash: 'th', isNew: false, linked: false }; }, async logoutByNameId() { return 0; } };
const quiet = { info() {}, warn() {}, error() {} };

let server;
let base;
before(async () => {
  server = createApp(cfg, { saml, provisioner, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('config: SAML_SP_PATH → régi címek', () => {
  const c = loadConfig({
    UNIPORTAL_PUBLIC_URL: 'https://uniportal.nje.hu',
    SAML_SP_PATH: '/auth/v1/sso/saml/',
    SAML_SP_PRIVATE_KEY: SP_KEY, SAML_SP_CERT: SP_CERT,
    SAML_COOKIE_SECRET: 'x'.repeat(40), SERVICE_ROLE_KEY: 'k',
  });
  assert.equal(c.entityId, 'https://uniportal.nje.hu/auth/v1/sso/saml/metadata');
  assert.equal(c.acsUrl, 'https://uniportal.nje.hu/auth/v1/sso/saml/acs');
  assert.equal(c.sloUrl, 'https://uniportal.nje.hu/auth/v1/sso/saml/slo');
  assert.throws(() => loadConfig({ UNIPORTAL_PUBLIC_URL: 'https://x', SAML_SP_PATH: '/a b', SAML_SP_PRIVATE_KEY: SP_KEY, SAML_SP_CERT: SP_CERT, SAML_COOKIE_SECRET: 'x'.repeat(40), SERVICE_ROLE_KEY: 'k' }), /SAML_SP_PATH/);
});

test('metaadat a régi címen is, a régi entityID-vel és ACS-sel', async () => {
  for (const p of ['/auth/v1/sso/saml/metadata', '/saml/metadata']) {
    const xml = await (await fetch(base + p)).text();
    assert.match(xml, /entityID="https:\/\/uniportal\.test\/auth\/v1\/sso\/saml\/metadata"/, p);
    assert.match(xml, /Location="https:\/\/uniportal\.test\/auth\/v1\/sso\/saml\/acs"/, p);
    assert.match(xml, /Location="https:\/\/uniportal\.test\/auth\/v1\/sso\/saml\/slo"/, p);
  }
});

test('a kérés a régi entityID-vel és ACS-sel megy ki; a régi ACS-re jövő válasz elfogadva', async () => {
  const login = await fetch(`${base}/saml/login?next=app.html`, { redirect: 'manual' });
  const url = login.headers.get('location');
  const { inflateRawSync } = await import('node:zlib');
  const xml = inflateRawSync(Buffer.from(new URL(url).searchParams.get('SAMLRequest'), 'base64')).toString();
  assert.match(xml, /AssertionConsumerServiceURL="https:\/\/uniportal\.test\/auth\/v1\/sso\/saml\/acs"/);
  assert.match(xml, />https:\/\/uniportal\.test\/auth\/v1\/sso\/saml\/metadata<\/saml:Issuer>/);

  const res = await fetch(`${base}/auth/v1/sso/saml/acs`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      SAMLResponse: buildResponse({ inResponseTo: requestIdFromUrl(url), audience: `${OLD}/metadata`, recipient: `${OLD}/acs` }),
      RelayState: 'app.html',
    }).toString(),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://uniportal.test/app.html#sso_token_hash=th');
});

test('a régi entityID-re szóló, de az új (/saml) címre küldött válasz is az audience alapján dől el', async () => {
  const login = await fetch(`${base}/saml/login`, { redirect: 'manual' });
  const id = requestIdFromUrl(login.headers.get('location'));
  const res = await fetch(`${base}/saml/acs`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: buildResponse({ inResponseTo: id, audience: 'https://uniportal.test/saml/metadata' }) }).toString(),
  });
  assert.match(res.headers.get('location'), /sso_error=invalid_response/);
});
