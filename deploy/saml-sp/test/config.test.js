import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkKeyPair, loadConfig } from '../src/config.js';
import { SP_KEY, SP_CERT, IDP_CERT } from './helpers.js';

const env = (over = {}) => ({
  UNIPORTAL_PUBLIC_URL: 'https://uni.test/',
  SAML_SP_PRIVATE_KEY: Buffer.from(SP_KEY).toString('base64'),
  SAML_SP_CERT: Buffer.from(SP_CERT).toString('base64'),
  SAML_COOKIE_SECRET: 'x'.repeat(40),
  SERVICE_ROLE_KEY: 'k',
  ...over,
});

test('összetartozó kulcs és tanúsítvány: rendben', () => {
  assert.doesNotThrow(() => checkKeyPair(SP_KEY, SP_CERT));
  const cfg = loadConfig(env());
  assert.equal(cfg.entityId, 'https://uni.test/saml/metadata');
  assert.equal(cfg.acsUrl, 'https://uni.test/saml/acs');
});

test('más kulcshoz tartozó tanúsítvány: nem indul', () => {
  assert.throws(() => checkKeyPair(SP_KEY, IDP_CERT), /nem a SAML_SP_PRIVATE_KEY/);
});

test('hibás (csonka) tanúsítvány: nem indul', () => {
  assert.throws(() => loadConfig(env({ SAML_SP_CERT: 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==' })), /SAML_SP_CERT/);
});

test('hiányzó értékek: mind felsorolva', () => {
  assert.throws(() => loadConfig({}), /UNIPORTAL_PUBLIC_URL.*SAML_SP_PRIVATE_KEY.*SAML_SP_CERT.*SAML_COOKIE_SECRET.*SERVICE_ROLE_KEY/);
});
