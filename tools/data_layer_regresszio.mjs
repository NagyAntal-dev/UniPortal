// node tools/data_layer_regresszio.mjs — no browser or live database required.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../features/data-layer.jsx', import.meta.url), 'utf8')
  .split('/* ---------- formatting helpers')[0];
function fixture(responses, mode = 'sb') {
  const storage = new Map([['rows', JSON.stringify([{ id: '1', title: 'original' }])]]);
  const original = storage.get('rows');
  const client = { from() {
    const response = responses.shift();
    const qb = new Proxy({}, { get(_t, name) {
      if (name === 'then') return (resolve, reject) =>
        response instanceof Error ? reject(response) : resolve(response);
      return () => qb;
    } });
    return qb;
  } };
  const api = new Function('window', 'localStorage', 'POLL_nezdKorlat', `${source}
    return { dlEnsure, dlSelect, dlInsert, dlUpdate, dlDelete, DL_PROBE };`)(
    { sb: client }, { getItem: k => storage.get(k), setItem: (k,v) => storage.set(k,v) }, () => false);
  if (mode) api.DL_PROBE.items = mode;
  return { ...api, storage, original };
}
const writes = [
  api => api.dlInsert('items', { id: '2' }, 'rows'),
  api => api.dlUpdate('items', '1', { title: 'changed' }, 'rows'),
  api => api.dlDelete('items', '1', 'rows'),
];
let checks = 0;
for (const write of writes) {
  for (const response of [
    { error: { code: '42501', message: 'permission denied' } },
    { error: { code: 'PGRST116', message: 'no rows' } },
    { error: { code: 'PGRST204', message: 'column missing in schema cache' } },
    { error: { code: '23505', message: 'duplicate key' } },
    { data: [], error: null },
    Object.assign(new Error('permission denied'), { code: '42501' }),
    new Error('Failed to fetch'),
    null,
  ]) {
    // INSERT normally returns an object; empty data is represented by null.
    const value = write === writes[0] && response?.data ? { data: null, error: null } : response;
    const api = fixture([value]);
    await assert.rejects(() => write(api));
    assert.equal(api.storage.get('rows'), api.original);
    assert.equal(api.DL_PROBE.items, 'sb');
    checks++;
  }
  for (const code of ['42P01', 'PGRST205']) {
    const api = fixture([{ error: { code } }]);
    await write(api);
    assert.equal(api.DL_PROBE.items, 'ls');
    assert.notEqual(api.storage.get('rows'), api.original);
    checks++;
  }
  const probe = fixture([{ error: { code: '42501', message: 'probe denied' } }], null);
  await assert.rejects(() => write(probe), { code: '42501' });
  assert.equal(probe.DL_PROBE.items, undefined);
  assert.equal(probe.storage.get('rows'), probe.original);
  checks++;
}
const api = fixture([{ error: { code: '42501' } }, { error: { code: '42501' } }]);
await assert.rejects(() => api.dlSelect('items', 'rows'), { code: '42501' });
await assert.rejects(() => writes[0](api), { code: '42501' });
assert.equal(api.DL_PROBE.items, 'sb');
assert.equal(api.storage.get('rows'), api.original);
for (const [i, write] of writes.entries()) {
  const success = fixture([{ data: i === 0 ? { id: '2' } : [{ id: '1' }], error: null }]);
  assert.ok(await write(success));
  assert.equal(success.DL_PROBE.items, 'sb');
}
console.log(`OK — ${checks + 4} data-layer checks; denied writes never become local saves.`);
