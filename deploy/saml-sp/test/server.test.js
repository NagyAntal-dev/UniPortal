import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createSaml, IdpCertStore, OID } from '../src/saml.js';
import { testConfig, buildResponse, requestIdFromUrl, DEFAULT_ATTRS } from './helpers.js';

const cfg = testConfig();
const saml = createSaml(cfg, new IdpCertStore(cfg));
const provisioned = [];
const provisioner = {
  async provision(a, s) {
    provisioned.push({ a, s });
    if (a.eppn === 'hiba@nje.hu') throw new Error('boom');
    return { userId: 'u-1', tokenHash: 'th+/=abc', isNew: true, linked: false };
  },
  async logoutByNameId() { return 1; },
};
const quiet = { info() {}, warn() {}, error() {} };

let server;
let base;
before(async () => {
  server = createApp(cfg, { saml, provisioner, log: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (p, headers = {}) => fetch(base + p, { redirect: 'manual', headers });
const post = (p, form) => fetch(base + p, {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(form).toString(),
});

async function startLogin(next = 'app.html') {
  const res = await get(`/saml/login?next=${encodeURIComponent(next)}`);
  assert.equal(res.status, 302);
  return res.headers.get('location');
}

test('metaadat: entityID, ACS, SLO, tanúsítvány', async () => {
  const res = await get('/saml/metadata');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /xml/);
  const xml = await res.text();
  assert.match(xml, /entityID="https:\/\/uniportal\.test\/saml\/metadata"/);
  assert.match(xml, /Location="https:\/\/uniportal\.test\/saml\/acs"/);
  assert.match(xml, /Location="https:\/\/uniportal\.test\/saml\/slo"/);
  assert.match(xml, /X509Certificate/);
  assert.match(xml, /WantAssertionsSigned="true"/);
});

test('login: átirányítás az IdP-re, idegen next helyett app.html', async () => {
  const loc = new URL(await startLogin('https://evil.example/'));
  assert.equal(loc.host, 'idp.nje.hu');
  assert.equal(loc.searchParams.get('RelayState'), 'app.html');
});

test('ACS: sikeres belépés → app.html#sso_token_hash, süti', async () => {
  const id = requestIdFromUrl(await startLogin('app.html'));
  const res = await post('/saml/acs', { SAMLResponse: buildResponse({ inResponseTo: id }), RelayState: 'app.html' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `https://uniportal.test/app.html#sso_token_hash=${encodeURIComponent('th+/=abc')}`);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^saml_sid=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\/saml\//);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const last = provisioned.at(-1);
  assert.equal(last.a.eppn, 'kiss.anna@nje.hu');
  assert.equal(last.s.nameID, '_nid123');
  assert.equal(last.s.sessionIndex, '_sess42');
});

test('ACS: érvénytelen válasz → index.html#sso_error', async () => {
  const res = await post('/saml/acs', { SAMLResponse: buildResponse({}) });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /^https:\/\/uniportal\.test\/index\.html#sso_error=/);
});

test('ACS: üres törzs → sso_error', async () => {
  const res = await post('/saml/acs', {});
  assert.match(res.headers.get('location'), /#sso_error=invalid_response$/);
});

test('ACS: hiányzó ePPN → sso_error=missing_eppn', async () => {
  const id = requestIdFromUrl(await startLogin());
  const attrs = { ...DEFAULT_ATTRS };
  delete attrs[OID.eppn];
  const res = await post('/saml/acs', { SAMLResponse: buildResponse({ inResponseTo: id, attrs }) });
  assert.match(res.headers.get('location'), /#sso_error=missing_eppn$/);
});

test('ACS: regisztrációs hiba → sso_error=provision_failed', async () => {
  const id = requestIdFromUrl(await startLogin());
  const attrs = { ...DEFAULT_ATTRS, [OID.eppn]: 'hiba@nje.hu' };
  const res = await post('/saml/acs', { SAMLResponse: buildResponse({ inResponseTo: id, attrs }) });
  assert.match(res.headers.get('location'), /#sso_error=provision_failed$/);
});

test('logout süti nélkül → index.html', async () => {
  const res = await get('/saml/logout');
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), 'https://uniportal.test/index.html');
});

test('logout süti mellett → aláírt LogoutRequest az IdP-nek', async () => {
  const id = requestIdFromUrl(await startLogin());
  const acs = await post('/saml/acs', { SAMLResponse: buildResponse({ inResponseTo: id }) });
  const cookie = acs.headers.get('set-cookie').split(';')[0];
  const res = await get('/saml/logout', { Cookie: cookie });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.pathname, '/simplesaml/saml2/idp/SingleLogoutService.php');
  assert.ok(loc.searchParams.get('SAMLRequest'));
  assert.ok(loc.searchParams.get('Signature'));
  assert.match(res.headers.get('set-cookie'), /saml_sid=;.*Max-Age=0/);
});

test('logout hamisított sütivel → nincs IdP-hívás', async () => {
  const res = await get('/saml/logout', { Cookie: 'saml_sid=eyJuYW1lSUQiOiJ4In0.hamis' });
  assert.equal(res.headers.get('location'), 'https://uniportal.test/index.html');
});

test('ismeretlen útvonal → 404', async () => {
  assert.equal((await get('/saml/nincs')).status, 404);
});
