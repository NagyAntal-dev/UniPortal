import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvisioner, ProvisionError } from '../src/provision.js';
import { testConfig } from './helpers.js';

const ATTRS = { eppn: 'kiss.anna@nje.hu', email: 'kiss.anna@nje.hu', displayName: 'Kiss Anna', ou: 'GAMF', title: 'hallgató', office: 'A-101' };

// Álszerver: útvonal → válasz. Minden hívást feljegyez.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.origin}${u.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: init.headers });
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ msg: `no route ${key}` }), { status: 404 });
    const [status, json] = typeof h === 'function' ? h(body, calls) : h;
    return new Response(JSON.stringify(json), { status });
  };
  return { fetchImpl, calls };
}

const R = {
  find: 'POST http://rest:3000/rpc/saml_find_user',
  link: 'POST http://rest:3000/rpc/saml_link_login',
  create: 'POST http://auth:9999/admin/users',
  genlink: 'POST http://auth:9999/admin/generate_link',
  logout: 'POST http://rest:3000/rpc/saml_logout',
};

test('új felhasználó: létrehozás, jóváhagyás, token', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, []],
    [R.create]: [200, { id: 'u-1', email: 'kiss.anna@nje.hu' }],
    [R.link]: [200, null],
    [R.genlink]: [200, { id: 'u-1', hashed_token: 'th-abc' }],
  });
  const p = createProvisioner(testConfig(), { fetchImpl });
  const r = await p.provision(ATTRS, { nameID: '_nid', sessionIndex: '_s' });
  assert.deepEqual(r, { userId: 'u-1', tokenHash: 'th-abc', isNew: true, matchedBy: null, linked: false });

  const create = calls.find((c) => c.key === R.create).body;
  assert.equal(create.email_confirm, true);
  assert.deepEqual(create.user_metadata, { name: 'Kiss Anna' });
  assert.deepEqual(create.app_metadata, { sso: 'nje' });
  assert.equal('role' in create.user_metadata, false, 'a szerepkört a kliens-metaadat nem hordozhatja');

  const link = calls.find((c) => c.key === R.link).body;
  assert.equal(link.p_is_new, true);
  assert.equal(link.p_user_id, 'u-1');
  assert.equal(link.p_name_id, '_nid');
  assert.deepEqual(calls.find((c) => c.key === R.genlink).body, { type: 'magiclink', email: 'kiss.anna@nje.hu' });
  assert.equal(calls[0].headers.Authorization, 'Bearer service-key');
});

test('ismert ePPN: nincs új fiók, nincs admin-módosítás', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-9', email: 'regi.cim@nje.hu', matched_by: 'eppn', email_confirmed: true }]],
    [R.link]: [200, null],
    [R.genlink]: [200, { properties: { hashed_token: 'th-9' } }],
  });
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(ATTRS);
  assert.equal(r.userId, 'u-9');
  assert.equal(r.isNew, false);
  assert.equal(r.tokenHash, 'th-9');
  assert.ok(!calls.some((c) => c.key.startsWith('PUT') || c.key === R.create));
  assert.equal(calls.find((c) => c.key === R.link).body.p_is_new, false);
  // A token a fiók SAJÁT (auth.users) címére szól, nem az IdP-ére.
  assert.equal(calls.find((c) => c.key === R.genlink).body.email, 'regi.cim@nje.hu');
});

test('meglévő, megerősített jelszavas fiók: hozzákötés, jelszó marad', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-5', email: 'kiss.anna@nje.hu', matched_by: 'email', email_confirmed: true }]],
    'PUT http://auth:9999/admin/users/u-5': [200, {}],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(ATTRS);
  assert.equal(r.linked, true);
  assert.equal(r.isNew, false);
  const put = calls.find((c) => c.key.startsWith('PUT')).body;
  assert.deepEqual(put, { app_metadata: { sso: 'nje' } });
});

test('meglévő, MEG NEM erősített fiók: e-mail megerősítve, jelszó véletlenre cserélve', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-6', email: 'kiss.anna@nje.hu', matched_by: 'email', email_confirmed: false }]],
    'PUT http://auth:9999/admin/users/u-6': [200, {}],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  await createProvisioner(testConfig(), { fetchImpl }).provision(ATTRS);
  const put = calls.find((c) => c.key.startsWith('PUT')).body;
  assert.equal(put.email_confirm, true);
  assert.ok(put.password && put.password.length >= 40);
  assert.equal(calls.find((c) => c.key === R.link).body.p_is_new, false);
});

// ---------------------------------------------------------------------------
// A munkafüzetből importált fiókok átvétele (79_saml_import_match.sql).
// Ezek a fiókok .invalid bejelentkezési névvel és a credentials.csv-ben
// kiosztott jelszóval jöttek létre — mindkettőt le kell váltani.
// ---------------------------------------------------------------------------

const STUDENT = { ...ATTRS, eppn: 'a00kh0@kefo.hu', email: 'a00kh0@kefo.hu', displayName: 'Árvai Szabolcs' };

test('a keresés megkapja a displayName-t és a hallgatói tartományokat', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, []],
    [R.create]: [200, { id: 'u-0', email: 'a00kh0@kefo.hu' }],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  await createProvisioner(testConfig(), { fetchImpl }).provision(STUDENT);
  const find = calls.find((c) => c.key === R.find).body;
  assert.equal(find.p_display_name, 'Árvai Szabolcs', 'oktatói párosításhoz kell');
  assert.deepEqual(find.p_student_scopes, ['kefo.hu']);
});

test('importált HALLGATÓI fiók: valódi cím, a CSV-jelszó érvénytelenítve', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-s', email: 'student.a00kh0@nje-import.invalid', matched_by: 'neptun', email_confirmed: true }]],
    'PUT http://auth:9999/admin/users/u-s': [200, {}],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(STUDENT);
  assert.equal(r.isNew, false, 'NEM új fiók — a meglévőt vesszük át');
  assert.equal(r.matchedBy, 'neptun');
  assert.equal(r.userId, 'u-s');

  const put = calls.find((c) => c.key.startsWith('PUT')).body;
  assert.equal(put.email, 'a00kh0@kefo.hu', 'a .invalid login helyére a valódi cím kerül');
  assert.equal(put.email_confirm, true);
  assert.ok(put.password && put.password.length >= 40, 'a credentials.csv jelszava nem maradhat érvényben');

  // A LÉNYEG: a magic link az ÚJ címre szól. A régivel a belépés elhasalna.
  assert.equal(calls.find((c) => c.key === R.genlink).body.email, 'a00kh0@kefo.hu');
});

test('importált OKTATÓI fiók: névegyezés alapján átvéve', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-t', email: 'teacher.407debeaed928719@nje-import.invalid', matched_by: 'teacher_name', email_confirmed: true }]],
    'PUT http://auth:9999/admin/users/u-t': [200, {}],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  const attrs = { ...ATTRS, eppn: 'bferenc@nje.hu', email: 'bferenc@nje.hu', displayName: 'Dr. Baglyas Ferenc' };
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(attrs);
  assert.equal(r.matchedBy, 'teacher_name');
  assert.equal(r.linked, true);
  assert.equal(calls.find((c) => c.key.startsWith('PUT')).body.email, 'bferenc@nje.hu');
  assert.equal(calls.find((c) => c.key === R.genlink).body.email, 'bferenc@nje.hu');
  // A szerepkört a párosított fióké marad: a link-hívás nem új regisztráció.
  assert.equal(calls.find((c) => c.key === R.link).body.p_is_new, false);
});

test('már valódi címen lévő fiók: a címet és a jelszót NEM bántjuk', async () => {
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-r', email: 'sajat.cim@nje.hu', matched_by: 'neptun', email_confirmed: true }]],
    'PUT http://auth:9999/admin/users/u-r': [200, {}],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  await createProvisioner(testConfig(), { fetchImpl }).provision(STUDENT);
  const put = calls.find((c) => c.key.startsWith('PUT')).body;
  assert.deepEqual(put, { app_metadata: { sso: 'nje' } }, 'csak az sso-jelölés');
  assert.equal(calls.find((c) => c.key === R.genlink).body.email, 'sajat.cim@nje.hu');
});

test('visszatérő felhasználó importált címmel: nincs admin-módosítás', async () => {
  // A matched_by='eppn' SZÁNDÉKOSAN kimarad az átvételből: itt már nincs mit
  // átvenni, és egy fölösleges jelszócsere kizárná a felhasználót.
  const { fetchImpl, calls } = fakeFetch({
    [R.find]: [200, [{ user_id: 'u-e', email: 'student.a00kh0@nje-import.invalid', matched_by: 'eppn', email_confirmed: true }]],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(STUDENT);
  assert.equal(r.linked, false);
  assert.ok(!calls.some((c) => c.key.startsWith('PUT')), 'visszatérőnél nincs PUT');
});

test('párhuzamos első belépés (422): újrakeresés', async () => {
  let n = 0;
  const { fetchImpl } = fakeFetch({
    [R.find]: () => (n++ === 0 ? [200, []] : [200, [{ user_id: 'u-2', email: 'kiss.anna@nje.hu', matched_by: 'eppn', email_confirmed: true }]]),
    [R.create]: [422, { code: 'email_exists', msg: 'A user with this email address has already been registered' }],
    [R.link]: [200, null],
    [R.genlink]: [200, { hashed_token: 't' }],
  });
  const r = await createProvisioner(testConfig(), { fetchImpl }).provision(ATTRS);
  assert.equal(r.userId, 'u-2');
  assert.equal(r.isNew, false);
});

test('hiba a GoTrue-ban: ProvisionError', async () => {
  const { fetchImpl } = fakeFetch({ [R.find]: [200, []], [R.create]: [500, { msg: 'boom' }] });
  await assert.rejects(createProvisioner(testConfig(), { fetchImpl }).provision(ATTRS), ProvisionError);
});

test('hiányzó ePPN / e-mail: nincs hívás', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const p = createProvisioner(testConfig(), { fetchImpl });
  await assert.rejects(p.provision({ ...ATTRS, eppn: '' }), ProvisionError);
  await assert.rejects(p.provision({ ...ATTRS, email: '' }), ProvisionError);
  assert.equal(calls.length, 0);
});

test('IdP-kijelentkeztetés NameID szerint', async () => {
  const { fetchImpl, calls } = fakeFetch({ [R.logout]: [200, 1] });
  const p = createProvisioner(testConfig(), { fetchImpl });
  assert.equal(await p.logoutByNameId('_nid'), 1);
  assert.deepEqual(calls[0].body, { p_name_id: '_nid' });
  assert.equal(await p.logoutByNameId(''), 0);
});
