import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSaml, mapAttributes, safeNext, extractSigningCerts, IdpCertStore, OID, validateLoginResponse } from '../src/saml.js';
import { decodePem } from '../src/config.js';
import { testConfig, buildResponse, requestIdFromUrl, IDP_CERT, OTHER_KEY } from './helpers.js';

function setup(over) {
  const cfg = testConfig(over);
  const store = new IdpCertStore(cfg);
  return { cfg, saml: createSaml(cfg, store) };
}

async function freshRequestId(saml) {
  return requestIdFromUrl(await saml.getAuthorizeUrlAsync('app.html', undefined, {}));
}

test('attribútumok OID szerint', () => {
  const a = mapAttributes({ attributes: {
    [OID.eppn]: 'Kiss.Anna@NJE.hu', [OID.mail]: ['', 'kiss.anna@nje.hu'],
    [OID.displayName]: 'Kiss Anna', [OID.ou]: 'GAMF', [OID.title]: 'oktató', [OID.office]: 'A-101',
  } });
  assert.deepEqual(a, { eppn: 'kiss.anna@nje.hu', email: 'kiss.anna@nje.hu', displayName: 'Kiss Anna', ou: 'GAMF', title: 'oktató', office: 'A-101' });
});

test('levélcím híján az ePPN a cím; érvénytelen cím nem jut át', () => {
  assert.equal(mapAttributes({ attributes: { [OID.eppn]: 'x@nje.hu' } }).email, 'x@nje.hu');
  assert.equal(mapAttributes({ attributes: { [OID.eppn]: 'x@nje.hu', [OID.mail]: 'nem-cim' } }).email, 'x@nje.hu');
  assert.equal(mapAttributes({ attributes: { [OID.eppn]: 'x' } }).email, '');
  assert.equal(mapAttributes({ attributes: { eduPersonPrincipalName: 'y@nje.hu' } }).eppn, 'y@nje.hu');
});

test('next: csak engedélyezett oldal', () => {
  assert.equal(safeNext('app.html'), 'app.html');
  assert.equal(safeNext('index.html'), 'index.html');
  assert.equal(safeNext('https://evil.example/'), 'app.html');
  assert.equal(safeNext('//evil.example'), 'app.html');
  assert.equal(safeNext(undefined, 'index.html'), 'index.html');
});

test('aláíró tanúsítvány a metaadatból', () => {
  const xml = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"><md:IDPSSODescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>ENC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
      AB CD
      EF</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor><ds:KeyInfo><ds:X509Data><ds:X509Certificate>GH</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
  </md:IDPSSODescriptor></md:EntityDescriptor>`;
  assert.deepEqual(extractSigningCerts(xml), ['ABCDEF', 'GH']);
});

test('PEM dekódolás: PEM, base64(PEM), puszta törzs', () => {
  assert.equal(decodePem(IDP_CERT), IDP_CERT.trim());
  assert.equal(decodePem(Buffer.from(IDP_CERT).toString('base64')), IDP_CERT.trim());
  assert.equal(decodePem('MIIB ab\ncd'), 'MIIBabcd');
});

test('a bejelentkezési kérés az IdP-re visz, aláírva', async () => {
  const { saml } = setup();
  const url = new URL(await saml.getAuthorizeUrlAsync('app.html', undefined, {}));
  assert.equal(url.origin + url.pathname, 'https://idp.nje.hu/simplesaml/saml2/idp/SSOService.php');
  assert.ok(url.searchParams.get('SAMLRequest'));
  assert.ok(url.searchParams.get('Signature'));
  assert.equal(url.searchParams.get('RelayState'), 'app.html');
});

test('érvényes válasz elfogadva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: id }) });
  const a = mapAttributes(profile);
  assert.equal(a.eppn, 'kiss.anna@nje.hu');
  assert.equal(a.email, 'kiss.anna@nje.hu');
  assert.equal(profile.sessionIndex, '_sess42');
});

test('visszajátszott válasz elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  const body = { SAMLResponse: buildResponse({ inResponseTo: id }) };
  await saml.validatePostResponseAsync(body);
  await assert.rejects(saml.validatePostResponseAsync(body));
});

test('kéretlen (IdP-kezdeményezett) válasz elutasítva', async () => {
  const { saml } = setup();
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({}) }));
});

test('ismeretlen kérésre adott válasz elutasítva', async () => {
  const { saml } = setup();
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: '_nincs_ilyen' }) }));
});

test('rossz kulccsal aláírt válasz elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: id, signingKey: OTHER_KEY }) }));
});

test('aláíratlan válasz elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: id, sign: false }) }));
});

test('aláírás után módosított attribútum elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  const xml = Buffer.from(buildResponse({ inResponseTo: id }), 'base64').toString('utf8')
    .replace('kiss.anna@nje.hu</saml:AttributeValue>', 'rektor@nje.hu</saml:AttributeValue>');
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(xml).toString('base64') }));
});

test('más SP-nek szóló (rossz audience) válasz elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: id, audience: 'https://masik.test/sp' }) }));
});

test('lejárt válasz elutasítva', async () => {
  const { saml } = setup();
  const id = await freshRequestId(saml);
  const past = new Date(Date.now() - 10 * 60 * 1000);
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({
    inResponseTo: id, notBefore: new Date(past.getTime() - 60000), notOnOrAfter: past,
  }) }));
});

test('idegen kiállító (issuer) elutasítva', async () => {
  const { saml, cfg } = setup();
  const id = await freshRequestId(saml);
  await assert.rejects(
    validateLoginResponse(saml, cfg, { SAMLResponse: buildResponse({ inResponseTo: id, issuer: 'https://idp.evil.example/' }) }),
    /kiállító/,
  );
});

test('validateLoginResponse: érvényes válasz → profil', async () => {
  const { saml, cfg } = setup();
  const id = await freshRequestId(saml);
  const profile = await validateLoginResponse(saml, cfg, { SAMLResponse: buildResponse({ inResponseTo: id }) });
  assert.equal(profile.issuer, cfg.idpEntityId);
});

test('tanúsítvány nélkül (metaadat még nem jött meg) nincs belépés', async () => {
  const { saml } = setup({ idpCert: '' });
  const id = await freshRequestId(saml);
  await assert.rejects(saml.validatePostResponseAsync({ SAMLResponse: buildResponse({ inResponseTo: id }) }));
});

test('titkosított (EncryptedAssertion) válasz visszafejtve', async () => {
  const { encrypt } = await import('xml-encryption');
  const { SP_CERT } = await import('./helpers.js');
  const { saml } = setup();
  const id = await freshRequestId(saml);
  const xml = Buffer.from(buildResponse({ inResponseTo: id }), 'base64').toString('utf8');
  const m = /<saml:Assertion[\s\S]*<\/saml:Assertion>/.exec(xml);
  const enc = await new Promise((resolve, reject) => encrypt(m[0], {
    rsa_pub: SP_CERT, pem: SP_CERT,
    encryptionAlgorithm: 'http://www.w3.org/2009/xmlenc11#aes256-gcm',
    keyEncryptionAlgorithm: 'http://www.w3.org/2001/04/xmlenc#rsa-oaep-mgf1p',
  }, (e, r) => (e ? reject(e) : resolve(r))));
  const wrapped = xml.replace(m[0], `<saml:EncryptedAssertion>${enc}</saml:EncryptedAssertion>`);
  const { profile } = await saml.validatePostResponseAsync({ SAMLResponse: Buffer.from(wrapped).toString('base64') });
  assert.equal(mapAttributes(profile).eppn, 'kiss.anna@nje.hu');
});
