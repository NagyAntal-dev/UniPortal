// Policy integration harness, not a full production replica. Real predicates
// and all 86 migration-11 policies; minimal row fixtures without business triggers.
// node supabase/diagnostics/73_pglite_ellenorzes.mjs
import assert from 'node:assert/strict';
import { db, read, section } from './72_pglite_ellenorzes.mjs';
await db.exec(read('supabase/72_rbac_actions.sql'));
const tables = ['users','agencies','campaigns','marketingCampaigns','scholarships',
  'videoInterviewQuestions','integrations','webhooks','interviewSlots','payments',
  'invoices','students','admission_processes','process_messages','leads','auditLogs',
  'feed_posts','event_rsvps','ticket_claims','programs','kb_documents','program_applications'];
const ident = s => '"' + s.replaceAll('"', '""') + '"';
for (const t of tables) await db.exec(`
  create table public.${ident(t)} (id text primary key, email text, name text,
    owner_email text, applicant_email text, "agentId" text, "studentName" text,
    status text default 'Available', level text default 'course', marker text);
  alter table public.${ident(t)} enable row level security;
  grant select, insert, update, delete on public.${ident(t)} to authenticated;
`);
await db.exec(section('supabase/11_rbac_additive.sql',
  'create or replace function public.my_role()', '-- ---------- 1.11'));
await db.exec(section('supabase/11_rbac_additive.sql',
  'create policy "rbac_users_select"', '-- 10. SZAKASZ').replace(/-- =+\s*$/, ''));
const roles = ['SUPERADMIN','ADMIN','ADMISSIONS','FINANCE','STUDENT','AGENT','CUSTOM','PENDING'];
await db.exec(`insert into public.role_definition(kod,nev) values ('CUSTOM','Custom');`);
const ids = {};
for (const [i, role] of roles.entries()) {
  ids[role] = `99999999-9999-9999-9999-${String(i + 1).padStart(12,'0')}`;
  await db.query('insert into auth.users(id,email) values ($1,$2)', [ids[role], role + '@test.hu']);
  await db.query(`insert into public.profiles(id,email,name,role,approval_status)
    values ($1,$2,$3,$4,$5)`, [ids[role],role+'@test.hu',role,
    role === 'PENDING' ? 'STUDENT' : role, role === 'PENDING' ? 'pending' : 'approved']);
}
// Probe as authenticated, never as the table owner. Every operation rolls back.
async function probe(role, table, action, own = true, level = 'course') {
  const email = (own ? role : 'OTHER') + '@test.hu';
  await db.exec('begin');
  try {
    await db.query(`insert into public.${ident(table)}
      (id,email,name,owner_email,applicant_email,"studentName",level) values ('row',$1,$2,$1,$1,$2,$3)`, [email,role,level]);
    await db.query(`select set_config('teszt.uid',$1,true)`, [ids[role]]);
    await db.exec('set local role authenticated');
    const sql = action === 'CREATE'
      ? `insert into public.${ident(table)} (id,email,owner_email,applicant_email,"studentName",level)
          values ('new','${email}','${email}','${email}','${role}','${level}') returning id`
      : action === 'EDIT' ? `update public.${ident(table)} set marker='changed' where id='row' returning id`
      : action === 'DELETE' ? `delete from public.${ident(table)} where id='row' returning id`
      : `select id from public.${ident(table)} where id='row'`;
    try { return { rows: (await db.query(sql)).rows.length }; }
    catch (e) { if (e.code !== '42501') throw e; return { error: e.code }; }
  } finally { await db.exec('rollback'); }
}
async function matrix() {
  const results = {};
  for (const r of roles) for (const t of tables)
    for (const a of ['VIEW','CREATE','EDIT','DELETE']) for (const own of [true,false])
      results[[r,t,a,own].join('/')] = await probe(r,t,a,own);
  return results;
}
const before = await matrix();
const degreesBefore = [];
for (const r of roles) for (const a of ['CREATE','EDIT','DELETE'])
  degreesBefore.push(await probe(r,'programs',a,true,'bachelor'));
const migration = read('supabase/73_rbac_enforce_rls.sql');
// An unexpected self-service grant must abort before any restrictive policy appears.
await db.exec(`create policy unexpected_self_service on public.programs
  for insert to authenticated with check (public.is_approved());`);
await assert.rejects(() => db.exec(migration), /Nem igazolt/);
await db.exec('rollback; drop policy unexpected_self_service on public.programs;');
assert.equal((await db.query(`select count(*)::int n from pg_policies
  where starts_with(policyname,'rbacx_')`)).rows[0].n, 0);
// An incomplete backfill must also abort atomically.
await db.exec(`delete from public.role_module_permission
  where role_kod='FINANCE' and module_kod='feed' and action='EDIT';`);
await assert.rejects(() => db.exec(migration), /Hiányos backfill/);
await db.exec(`rollback; insert into public.role_module_permission(role_kod,module_kod,action)
  values ('FINANCE','feed','EDIT');`);
await db.exec(migration);
const policies = (await db.query(`select * from pg_policies
  where schemaname='public' and starts_with(policyname,'rbacx_')`)).rows;
assert.equal(policies.length, 49);
assert.ok(policies.every(p => p.permissive === 'RESTRICTIVE' && p.roles.join() === 'authenticated' && p.cmd !== 'SELECT'));
assert.equal((await db.query(`select count(*)::int n from pg_policies
  where schemaname='public' and starts_with(policyname,'rbac_')`)).rows[0].n, 86);
const after = await matrix();
assert.deepEqual(after, before);
const degreesAfter = [];
for (const r of roles) for (const a of ['CREATE','EDIT','DELETE'])
  degreesAfter.push(await probe(r,'programs',a,true,'bachelor'));
assert.deepEqual(degreesAfter,degreesBefore);
console.log('OK — 24 degree-program cases unchanged; separate trainings permissions.');
console.log(`OK — ${Object.keys(before).length} role/table/action/ownership cases unchanged; 49 restrictive policies.`);
// Revoke every mapped operation independently, then exercise actual SQL.
const mappings = (await db.query('select * from public.rbacx_table_module')).rows;
for (const action of ['CREATE','EDIT','DELETE']) {
  await db.query(`delete from public.role_module_permission
    where role_kod='ADMIN' and module_kod='trainings' and action=$1`, [action]);
  const denied = await probe('ADMIN','programs',action,true,'bachelor');
  assert.ok(denied.error === '42501' || denied.rows === 0);
  assert.equal((await probe('ADMIN','programs',action)).rows,1);
  await db.query(`insert into public.role_module_permission(role_kod,module_kod,action)
    values ('ADMIN','trainings',$1)`,[action]);
}
for (const m of mappings) {
  await db.query(`delete from public.role_module_permission
    where role_kod='ADMIN' and module_kod=$1 and action=$2`, [m.module_kod,m.action]);
  const denied = await probe('ADMIN',m.table_name,m.action);
  assert.ok(denied.error === '42501' || denied.rows === 0, JSON.stringify(m));
  await db.query(`insert into public.role_module_permission(role_kod,module_kod,action)
    values ('ADMIN',$1,$2)`, [m.module_kod,m.action]);
  assert.equal((await probe('ADMIN',m.table_name,m.action)).rows, 1, JSON.stringify(m));
}
// A rerun must preserve revocation. Kill switch and SUPERADMIN still work.
await db.exec(`delete from public.role_module_permission
  where role_kod='ADMIN' and module_kod='feed' and action='CREATE';`);
await db.exec(migration);
assert.equal((await probe('ADMIN','feed_posts','CREATE')).error, '42501');
assert.equal((await probe('SUPERADMIN','feed_posts','CREATE')).rows, 1);
await db.query(`select set_config('teszt.uid',$1,false)`, [ids.SUPERADMIN]);
await db.exec('select public.rbac_enforce_set(false)');
assert.equal((await probe('ADMIN','feed_posts','CREATE')).rows, 1);
await db.exec('select public.rbac_enforce_set(true)');
assert.equal((await probe('ADMIN','feed_posts','CREATE')).error, '42501');
await assert.rejects(() => db.exec('select public.rbac_actions_rollback()'), /MEGTAGADVA/);
await db.exec(read('supabase/75_rbac_actions_rollback.sql'));
await db.exec(read('supabase/75_rbac_actions_rollback.sql'));
assert.deepEqual(await matrix(), before);
await db.exec(migration);
assert.equal((await probe('ADMIN','feed_posts','CREATE')).error, '42501');
await db.exec(read('supabase/75_rbac_actions_rollback.sql'));
await db.exec('select public.rbac_actions_rollback()');
assert.equal((await db.query(`select count(*)::int n from pg_policies
  where schemaname='public' and starts_with(policyname,'rbac_')`)).rows[0].n,86);
console.log('OK — all 49 revocations, grants, rerun, kill switch and two-stage rollback.');
await db.close();
