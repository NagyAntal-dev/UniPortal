// Tesztsegéd: egy álIdP, amely a fixtures/idp.key kulccsal aláírt SAML
// választ állít elő — ugyanolyan szerkezettel, mint a SimpleSAMLphp.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { OID } from '../src/saml.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
export const IDP_KEY = fx('idp.key');
export const IDP_CERT = fx('idp.crt');
export const SP_KEY = fx('sp.key');
export const SP_CERT = fx('sp.crt');
export const OTHER_KEY = SP_KEY; // „rossz” aláíró: nem az IdP kulcsa

export const IDP_ENTITY = 'https://idp.nje.hu/simplesaml/saml2/idp/metadata.php';

export function testConfig(over = {}) {
  return {
    port: 0,
    publicUrl: 'https://uniportal.test',
    entityId: 'https://uniportal.test/saml/metadata',
    acsUrl: 'https://uniportal.test/saml/acs',
    sloUrl: 'https://uniportal.test/saml/slo',
    spKey: SP_KEY,
    spCert: SP_CERT,
    idpEntityId: IDP_ENTITY,
    idpSsoUrl: 'https://idp.nje.hu/simplesaml/saml2/idp/SSOService.php',
    idpSloUrl: 'https://idp.nje.hu/simplesaml/saml2/idp/SingleLogoutService.php',
    idpMetadataUrl: IDP_ENTITY,
    idpCert: IDP_CERT,
    cookieSecret: 'x'.repeat(40),
    secureCookies: true,
    gotrueUrl: 'http://auth:9999',
    restUrl: 'http://rest:3000',
    serviceKey: 'service-key',
    ...over,
  };
}

export function requestIdFromUrl(url) {
  const req = new URL(url).searchParams.get('SAMLRequest');
  const xml = inflateRawSync(Buffer.from(req, 'base64')).toString('utf8');
  return /\bID="([^"]+)"/.exec(xml)[1];
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export const DEFAULT_ATTRS = {
  [OID.eppn]: 'kiss.anna@nje.hu',
  [OID.mail]: 'Kiss.Anna@nje.hu',
  [OID.displayName]: 'Kiss Anna',
  [OID.ou]: 'Informatikai Intézet',
  [OID.title]: 'hallgató',
  [OID.office]: 'GAMF A-101',
};

export function buildResponse({
  inResponseTo,
  audience = 'https://uniportal.test/saml/metadata',
  recipient = 'https://uniportal.test/saml/acs',
  issuer = IDP_ENTITY,
  attrs = DEFAULT_ATTRS,
  notBefore = new Date(Date.now() - 60 * 1000),
  notOnOrAfter = new Date(Date.now() + 5 * 60 * 1000),
  signingKey = IDP_KEY,
  sign = true,
} = {}) {
  const now = new Date().toISOString();
  const aid = `_a${randomUUID()}`;
  const irt = inResponseTo ? ` InResponseTo="${esc(inResponseTo)}"` : '';
  const attrXml = Object.entries(attrs).map(([name, v]) => (
    `<saml:Attribute Name="${esc(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri">` +
    [].concat(v).map((x) => `<saml:AttributeValue xsi:type="xs:string">${esc(x)}</saml:AttributeValue>`).join('') +
    '</saml:Attribute>'
  )).join('');

  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema" ID="${aid}" Version="2.0" IssueInstant="${now}">` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    '<saml:Subject>' +
    `<saml:NameID SPNameQualifier="${esc(audience)}" Format="urn:oasis:names:tc:SAML:2.0:nameid-format:transient">_nid123</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter.toISOString()}" Recipient="${esc(recipient)}"${irt}/></saml:SubjectConfirmation>` +
    '</saml:Subject>' +
    `<saml:Conditions NotBefore="${notBefore.toISOString()}" NotOnOrAfter="${notOnOrAfter.toISOString()}"><saml:AudienceRestriction><saml:Audience>${esc(audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now}" SessionIndex="_sess42"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `<saml:AttributeStatement>${attrXml}</saml:AttributeStatement>` +
    '</saml:Assertion>';

  let signedAssertion = assertion;
  if (sign) {
    const sig = new SignedXml({
      privateKey: signingKey,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    sig.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    sig.computeSignature(assertion, {
      location: { reference: "//*[local-name(.)='Issuer']", action: 'after' },
    });
    signedAssertion = sig.getSignedXml();
  }

  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${esc(recipient)}"${irt}>` +
    `<saml:Issuer>${esc(issuer)}</saml:Issuer>` +
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>' +
    signedAssertion +
    '</samlp:Response>';
  return Buffer.from(xml).toString('base64');
}
