-- KÉZI vész-visszaállítás. NEM kerülhet a manifestbe.
-- Először lehetőleg: select public.rbac_enforce_set(false);
-- Ez a fájl a 73-as policy-ket és a 74-es beszúrt RPC-őröket bontja el.
-- A mátrixot, naplót, eredeti permisszív szabályokat és RPC-kapukat megőrzi.
-- Teljes 72-es bontás ezután, SUPERADMIN munkamenetben:
--   select public.rbac_actions_rollback();
-- Futtatás: adatbázis-tulajdonos (SQL Editor / psql), egy tranzakcióban.
begin;
set local search_path = public;
set local lock_timeout = '15s';

do $rollback$
declare p record; g record; ddl text; guard text;
begin
  if to_regclass('public.rbac_rpc_guard') is not null then
    for g in select * from public.rbac_rpc_guard loop
      for p in select oid, prosrc from pg_proc
        where pronamespace = 'public'::regnamespace and proname = g.proc_name
      loop
        guard := format(E'if not public.is_trusted_caller() then\n    perform public.rbac_require(%L, %L);\n  end if;',
          g.module_kod, g.action);
        ddl := replace(pg_get_functiondef(p.oid), E'\r\n', E'\n');
        if position(guard in ddl) > 0 then
          -- Csak az ismert beszúrt blokkot vesszük ki, az RPC minden más
          -- része (beleértve későbbi javításait és grantjait) megmarad.
          execute replace(ddl, guard, '-- RBAC action guard removed by migration 75.');
        end if;
      end loop;
    end loop;
    -- Ismeretlen vagy módosított őrt nem alakítunk át találgatással.
    if exists (select 1 from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname <> 'rbac_actions_rollback'
          and position('public.rbac_require(' in prosrc) > 0) then
      raise exception 'Módosított RPC-őr maradt; a visszavonás teljesen visszagördül.';
    end if;
    update public.rbac_rpc_guard set aktiv = false;
  end if;

  for p in select * from pg_policies
    where schemaname = 'public' and starts_with(policyname, 'rbacx_')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
  -- A leképezési nyilvántartást megtartjuk: az újratelepítés így tudja,
  -- mely sorokon futott már le a backfill-ellenőrzés. A közben elvett
  -- jogokat nem kell visszaadni a 73-as újbóli telepítéséhez.
end $rollback$;

commit;
