-- ============================================================
-- 85_program_audience.sql — kinek szól a képzés: külföldi vagy magyar jelentkező
-- ============================================================
-- MIÉRT: a külügyi iroda észrevétele (2026-09-24): „A későbbiekben, ha a magyar
-- diákok is használják majd a portált, ők ne tudjanak a külföldieknek
-- meghirdetett programokra jelentkezni."
--
-- A mai kínálat teljes egészében az angol nyelvű, külföldieknek meghirdetett
-- képzés, ezért MINDEN meglévő sor alapértéke 'mind' marad — a mostani
-- működés nem változik. A megkülönböztetés akkor lép életbe, amikor az iroda
-- egy képzésnél tudatosan átállítja.
--
-- MIÉRT OSZLOP, ÉS NEM CÍMKE: a `tags` szabad szöveg, amit bárki átír; erre
-- viszont jogosultsági és szűrési szabály épül, tehát legyen zárt értékkészlet
-- (check), hogy elgépelés ne nyisson meg egy képzést.
--
-- A DÖNTÉS ALAPJA: a jelentkező ÁLLAMPOLGÁRSÁGA (a jelentkezés személyes
-- adataiban, illetve a profilban megadott ország). Nem a lakcím és nem a
-- nyelv — a „magyar diák" itt állampolgárságot jelent.
-- ============================================================

alter table public.programs add column if not exists audience text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'programs_audience_ck') then
    alter table public.programs
      add constraint programs_audience_ck
      check (audience is null or audience in ('mind', 'kulfoldi', 'magyar'));
  end if;
end $$;

comment on column public.programs.audience is
  'Kinek hirdetjük: mind (alapértelmezés) | kulfoldi (csak nem magyar állampolgár) | magyar (csak magyar állampolgár). NULL = mind, hogy a meglévő sorok viselkedése ne változzon.';

-- A meglévő kínálat marad mindenkinek szóló: az iroda állítja át, ha kell.
update public.programs set audience = 'mind' where audience is null;

do $chk$
declare v_db integer;
begin
  select count(*) into v_db from public.programs where audience is null;
  if v_db > 0 then
    raise exception 'HIBA: % kepzesnel maradt ures a celkozonseg.', v_db;
  end if;
  raise notice 'Rendben: 85 — celkozonseg mezo a kepzeseknel (% sor "mind").',
               (select count(*) from public.programs);
end $chk$;
