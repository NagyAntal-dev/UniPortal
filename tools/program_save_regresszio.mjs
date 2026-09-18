// Exercise the actual application workflow callbacks without a live browser.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../features/programs.jsx', import.meta.url),'utf8');
const nextSource = source.match(/const goNext = (async[^\n]+);\r?\n/)[1];
const submitStart = source.indexOf('onSubmit={async () => {') + 'onSubmit={'.length;
const submitEnd = source.indexOf('} /> : <PROG_IrodaiLepes',submitStart);
assert.ok(submitStart > 0 && submitEnd > submitStart);
const submitSource = source.slice(submitStart,submitEnd);
for (const saved of [null, { id: 'app' }]) {
  const indexes = [], submitted = [], errors = [], updates = [];
  const context = {
    persist: async () => saved, lepes: 1, steps: ['first','second','third'],
    setIdx: n => indexes.push(n),
    window: { sb: { rpc: async (...args) => { submitted.push(args); return { error: null }; } } },
    cur: { id: 'app', status: 'draft' }, setCur: fn => updates.push(fn({ status:'draft' })),
    onSaved: () => {}, alert: message => errors.push(message), setMentesHiba: message => errors.push(message),
  };
  const make = expression => new Function(...Object.keys(context), `return (${expression});`)(...Object.values(context));
  await make(nextSource)();
  assert.deepEqual(indexes, saved ? [2] : []);
  await make(submitSource)();
  assert.equal(submitted.length,saved ? 1 : 0);
  assert.equal(updates.length,saved ? 1 : 0);
  assert.deepEqual(errors,[]);
  if (saved) {
    context.window.sb.rpc = async () => { throw new Error('permission denied'); };
    await make(submitSource)();
    assert.deepEqual(errors,['permission denied']);
    assert.equal(updates.length,1);
  }
}
console.log('OK — failed saves do not advance or submit; successful saves do; RPC failures stay visible.');
