-- ============================================================================
-- 75_webshop_editor.sql — sablonos termékszerkesztő, változatok, képek,
--                         vázlat/közzététel, kurzushoz kötött ajánlás
--
-- A WEBSHOP TERV 1. LÉPÉSE (lásd „NJE Webshop terv”, 2026-09-22)
--   * sablon: digitális jegyzet, nyomtatott termék, ruházat, parkolókártya,
--     rendezvényjegy, bérlet, szolgáltatás — a felület ebből tölti elő a
--     mezőket; a szerver a közzétételkor a sablon kötelező adatait ellenőrzi;
--   * állapot: vázlat → közzétett → archivált. A vázlatot a vevő nem látja.
--     A régi 'aktiv' oszlop megmarad, és a közzétételt követi (aktiv =
--     közzétett), hogy a 74-es függvények és a meglévő sorok ne törjenek el;
--   * VÁLTOZATOK (pl. méret × szín), saját cikkszámmal, ár-eltéréssel és
--     készlettel. Ha egy terméknek van aktív változata, rendelni csak
--     változattal lehet, és a készlet a változaté;
--   * több KÉP (a legelső a borítókép — a régi kep_url is ezt kapja);
--   * értékesítési IDŐABLAK (tól–ig), sablonfüggő RÉSZLETEK (szerző, dátum,
--     helyszín, telephely …), TELJESÍTÉS módja és átvételi hely;
--   * KURZUS-kapcsolás: a jegyzet egy kurzushoz köthető; a hallgató „Neked”
--     fülén azok a termékek jelennek meg, amelyek a felvett kurzusaihoz
--     tartoznak, vagy célzottan neki szólnak.
--
-- A MÁR LEADOTT RENDELÉSEK VÁLTOZATLANOK: a tétel továbbra is pillanatkép
-- (név, ár, ÁFA), csak a változat neve kerül mellé.
--
-- FÜGGŐSÉG: 74_webshop.sql (és a 15-ös ECHO kurzustáblák, ha megvannak).
-- IDEMPOTENS: igen.
-- UTÁNA: a 21_echo_harden_submit.sql újrafuttatása (a szokásos szabály szerint).
-- ============================================================================

do $pre$
begin
  if to_regclass('shop.product') is null then
    raise exception 'ELOFELTETEL: eloszor a 74_webshop.sql-t kell lefuttatni.';
  end if;
end $pre$;

-- ---------------------------------------------------------------------------
-- 1) Termék — új mezők
-- ---------------------------------------------------------------------------
alter table shop.product add column if not exists statusz text;
alter table shop.product add column if not exists sablon text;
alter table shop.product add column if not exists reszletek jsonb not null default '{}'::jsonb;
alter table shop.product add column if not exists ertekesites_tol timestamptz;
alter table shop.product add column if not exists ertekesites_ig timestamptz;
alter table shop.product add column if not exists kurzus_id uuid;
alter table shop.product add column if not exists teljesites text;
alter table shop.product add column if not exists atveteli_hely text;

-- A meglévő sorok: ami aktív volt, az közzétett; ami nem, archivált.
update shop.product set statusz = case when aktiv then 'kozzetett' else 'archivalt' end where statusz is null;
update shop.product set sablon = case tipus when 'digitalis' then 'digitalis_jegyzet' when 'parkolokartya' then 'parkolokartya'
                                             when 'szolgaltatas' then 'szolgaltatas' else 'nyomtatott' end where sablon is null;
update shop.product set teljesites = case tipus when 'digitalis' then 'letoltes' when 'parkolokartya' then 'automatikus'
                                                 when 'szolgaltatas' then 'kezi' else 'atvetel' end where teljesites is null;

alter table shop.product alter column statusz set default 'vazlat';
alter table shop.product alter column statusz set not null;
alter table shop.product alter column sablon set default 'nyomtatott';
alter table shop.product alter column sablon set not null;
alter table shop.product alter column teljesites set default 'atvetel';
alter table shop.product alter column teljesites set not null;

do $ck$
begin
  if not exists (select 1 from pg_constraint where conname = 'shop_product_statusz_ck') then
    alter table shop.product add constraint shop_product_statusz_ck check (statusz in ('vazlat', 'kozzetett', 'archivalt'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_product_sablon_ck') then
    alter table shop.product add constraint shop_product_sablon_ck check (sablon in
      ('digitalis_jegyzet', 'nyomtatott', 'ruhazat', 'parkolokartya', 'rendezvenyjegy', 'berlet', 'szolgaltatas'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_product_teljesites_ck') then
    alter table shop.product add constraint shop_product_teljesites_ck check (teljesites in ('letoltes', 'atvetel', 'automatikus', 'kezi'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'shop_product_ablak_ck') then
    alter table shop.product add constraint shop_product_ablak_ck check (ertekesites_ig is null or ertekesites_tol is null or ertekesites_ig > ertekesites_tol);
  end if;
end $ck$;

-- ---------------------------------------------------------------------------
-- 2) Változatok és képek
-- ---------------------------------------------------------------------------
create table if not exists shop.product_variant (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references shop.product(id) on delete cascade,
  nev            text not null,                         -- pl. "M · sötétkék"
  tulajdonsagok  jsonb not null default '{}'::jsonb,    -- {"Méret": "M", "Szín": "sötétkék"}
  sku            text,
  ar_huf         integer check (ar_huf is null or ar_huf >= 0),   -- NULL = a termék ára
  keszlet        integer check (keszlet is null or keszlet >= 0), -- NULL = korlátlan
  aktiv          boolean not null default true,
  sorrend        int not null default 100
);
create index if not exists shop_variant_product_idx on shop.product_variant (product_id);
create unique index if not exists shop_variant_sku_uidx on shop.product_variant (sku) where sku is not null;

create table if not exists shop.product_image (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references shop.product(id) on delete cascade,
  url        text not null check (url ~* '^https://'),
  alt        text,
  sorrend    int not null default 100
);
create index if not exists shop_image_product_idx on shop.product_image (product_id);

alter table shop.order_item add column if not exists variant_id uuid references shop.product_variant(id) on delete set null;
alter table shop.order_item add column if not exists variant_nev text;

revoke all on shop.product_variant, shop.product_image from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Segédek
-- ---------------------------------------------------------------------------
-- Árusítható-e most: közzétett, és az értékesítési időablakon belül van.
create or replace function shop.arusithato(p shop.product)
returns boolean language sql stable set search_path = shop, public, pg_temp as $$
  select p.statusz = 'kozzetett' and p.aktiv
     and (p.ertekesites_tol is null or p.ertekesites_tol <= now())
     and (p.ertekesites_ig is null or p.ertekesites_ig > now())
$$;

-- A közzététel akadályai a sablon szerint. Üres tömb = közzétehető.
create or replace function shop.kozzetetel_hianyok(p_id uuid)
returns text[] language plpgsql stable security definer set search_path = shop, public, pg_temp as $$
declare p shop.product%rowtype; h text[] := '{}';
begin
  select * into p from shop.product where id = p_id;
  if p.id is null then return array['termek']; end if;
  if coalesce(btrim(p.nev), '') = '' then h := array_append(h, 'nev'); end if;
  if p.ar_huf is null then h := array_append(h, 'ar'); end if;
  if p.sablon = 'digitalis_jegyzet' and p.fajl_utvonal is null then h := array_append(h, 'letoltheto_fajl'); end if;
  if p.sablon = 'ruhazat' and not exists (select 1 from shop.product_variant v where v.product_id = p.id and v.aktiv) then
    h := array_append(h, 'valtozatok');
  end if;
  if p.sablon in ('ruhazat', 'nyomtatott') and p.kep_url is null
     and not exists (select 1 from shop.product_image i where i.product_id = p.id) then
    h := array_append(h, 'kep');
  end if;
  if p.sablon = 'rendezvenyjegy' and (coalesce(p.reszletek ->> 'datum', '') = '' or coalesce(p.reszletek ->> 'helyszin', '') = '') then
    h := array_append(h, 'datum_helyszin');
  end if;
  if p.sablon = 'parkolokartya' and not exists (select 1 from jsonb_array_elements(coalesce(p.mezok, '[]'::jsonb)) m
                                                 where m ->> 'tipus' = 'rendszam') then
    h := array_append(h, 'rendszam_mezo');
  end if;
  if p.teljesites = 'atvetel' and coalesce(btrim(p.atveteli_hely), '') = '' then h := array_append(h, 'atveteli_hely'); end if;
  return h;
end $$;

-- A kurzus rövid leírása (ha az ECHO kurzustábla megvan)
create or replace function shop.kurzus_json(p_kurzus uuid)
returns jsonb language plpgsql stable security definer set search_path = shop, public, pg_temp as $$
declare v jsonb;
begin
  if p_kurzus is null or to_regclass('echo.course') is null then return null; end if;
  execute 'select jsonb_build_object(''id'', k.id, ''kod'', k.code, ''nev'', k.name_hu, ''felev'', k.term) from echo.course k where k.id = $1'
     into v using p_kurzus;
  return v;
end $$;

-- A hívó felvett kurzusai (aktív kurzusfelvétel)
create or replace function shop.sajat_kurzusok()
returns uuid[] language plpgsql stable security definer set search_path = shop, public, pg_temp as $$
declare v uuid[];
begin
  if to_regclass('echo.enrollment') is null then return '{}'::uuid[]; end if;
  execute 'select coalesce(array_agg(course_id), ''{}''::uuid[]) from echo.enrollment where student_key = $1 and status = ''active'''
     into v using auth.uid();
  return v;
end $$;

create or replace function shop.valtozatok_json(p_id uuid, p_csak_aktiv boolean)
returns jsonb language sql stable security definer set search_path = shop, public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'nev', v.nev, 'tulajdonsagok', v.tulajdonsagok, 'sku', v.sku,
           'ar_huf', v.ar_huf, 'keszlet', v.keszlet, 'aktiv', v.aktiv, 'sorrend', v.sorrend,
           'elfogyott', (v.keszlet is not null and v.keszlet = 0)) order by v.sorrend, v.nev), '[]'::jsonb)
    from shop.product_variant v where v.product_id = p_id and (not p_csak_aktiv or v.aktiv)
$$;

create or replace function shop.kepek_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = shop, public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'url', i.url, 'alt', i.alt) order by i.sorrend, i.id), '[]'::jsonb)
    from shop.product_image i where i.product_id = p_id
$$;

-- A készlet visszaadása: a változaté, ha a tétel változathoz tartozik és annak van készlete
create or replace function shop.keszlet_vissza(p_item uuid)
returns void language plpgsql volatile security definer set search_path = shop, public, pg_temp as $$
declare i shop.order_item%rowtype; v_van boolean := false;
begin
  select * into i from shop.order_item where id = p_item;
  if i.variant_id is not null then
    update shop.product_variant set keszlet = keszlet + i.mennyiseg where id = i.variant_id and keszlet is not null;
    v_van := found;
  end if;
  if not v_van and i.product_id is not null then
    update shop.product set keszlet = keszlet + i.mennyiseg where id = i.product_id and keszlet is not null;
  end if;
end $$;

-- A rendelés képe: a 74-es, kiegészítve a változat nevével
create or replace function shop.order_json(p_order uuid, p_esemenyek boolean default false)
returns jsonb language sql stable security definer set search_path = shop, public, pg_temp as $$
  select jsonb_build_object(
    'id', o.id, 'ref_no', o.ref_no, 'rendelesszam', 'WS-' || lpad(o.ref_no::text, 5, '0'),
    'vevo', o.vevo, 'vevo_email', o.vevo_email, 'vevo_nev', o.vevo_nev,
    'szamlazasi_adatok', o.szamlazasi_adatok, 'osszeg_huf', o.osszeg_huf,
    'allapot', o.allapot, 'fizetesi_mod', o.fizetesi_mod,
    'fizetesi_kozlemeny', o.fizetesi_kozlemeny, 'fizetesi_hatarido', o.fizetesi_hatarido,
    'fizetve_at', o.fizetve_at, 'kulso_azonosito', o.kulso_azonosito,
    'szamla_szam', o.szamla_szam, 'szamla_url', o.szamla_url,
    'vevo_megjegyzes', o.vevo_megjegyzes,
    'megjegyzes', case when shop.is_manager() then o.megjegyzes else null end,
    'created_at', o.created_at, 'updated_at', o.updated_at,
    'tetelek', coalesce((select jsonb_agg(jsonb_build_object(
                   'id', i.id, 'product_id', i.product_id, 'nev', i.nev, 'tipus', i.tipus,
                   'variant_id', i.variant_id, 'variant_nev', i.variant_nev,
                   'egysegar_huf', i.egysegar_huf, 'afa_kulcs', i.afa_kulcs, 'mennyiseg', i.mennyiseg,
                   'adatok', i.adatok, 'jovahagyas', i.jovahagyas, 'dontes_at', i.dontes_at, 'indoklas', i.indoklas,
                   'atveteli_hely', (select p.atveteli_hely from shop.product p where p.id = i.product_id),
                   'letoltheto', (i.tipus = 'digitalis' and o.allapot in ('fizetve', 'teljesitve')
                                  and coalesce(i.jovahagyas, 'jovahagyva') = 'jovahagyva'
                                  and exists (select 1 from shop.product p where p.id = i.product_id and p.fajl_utvonal is not null)))
                 order by i.nev, i.variant_nev) from shop.order_item i where i.order_id = o.id), '[]'::jsonb),
    'esemenyek', case when p_esemenyek then
                   coalesce((select jsonb_agg(jsonb_build_object('tipus', e.tipus, 'reszletek', e.reszletek, 'mikor', e.mikor,
                               'ki', (select coalesce(nullif(pr.name, ''), pr.email) from public.profiles pr where pr.id = e.ki))
                             order by e.mikor desc, e.id desc) from shop.order_event e where e.order_id = o.id), '[]'::jsonb)
                 else null end)
  from shop.orders o where o.id = p_order
$$;

-- ---------------------------------------------------------------------------
-- 4) HALLGATÓI katalógus és rendelés
-- ---------------------------------------------------------------------------
create or replace function public.shop_catalog()
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare v_out jsonb; v_kurz uuid[] := shop.sajat_kurzusok();
begin
  if auth.uid() is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'SHOP_NOT_APPROVED'; end if;

  select jsonb_build_object(
    'kategoriak', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nev', c.nev, 'leiras', c.leiras)
                                              order by c.sorrend, c.nev)
                              from shop.category c where c.aktiv), '[]'::jsonb),
    'termekek', coalesce((select jsonb_agg(x order by (x->>'sorrend')::int, x->>'nev') from (
                select jsonb_build_object(
                  'id', p.id, 'sku', p.sku, 'nev', p.nev, 'leiras', p.leiras, 'category_id', p.category_id,
                  'tipus', p.tipus, 'sablon', p.sablon, 'ar_huf', p.ar_huf, 'afa_kulcs', p.afa_kulcs,
                  'ar_tol', least(p.ar_huf, (select min(coalesce(v.ar_huf, p.ar_huf)) from shop.product_variant v where v.product_id = p.id and v.aktiv)),
                  'keszlet', p.keszlet,
                  'elfogyott', case when exists (select 1 from shop.product_variant v where v.product_id = p.id and v.aktiv)
                                    then not exists (select 1 from shop.product_variant v where v.product_id = p.id and v.aktiv
                                                                                       and (v.keszlet is null or v.keszlet > 0))
                                    else (p.keszlet is not null and p.keszlet = 0) end,
                  'max_rendelesenkent', p.max_rendelesenkent, 'jovahagyas_kell', p.jovahagyas_kell,
                  'mezok', p.mezok, 'kep_url', p.kep_url, 'digitalis_fajl', (p.fajl_utvonal is not null),
                  'valtozatok', shop.valtozatok_json(p.id, true), 'kepek', shop.kepek_json(p.id),
                  'reszletek', p.reszletek, 'teljesites', p.teljesites, 'atveteli_hely', p.atveteli_hely,
                  'ertekesites_ig', p.ertekesites_ig, 'kurzus', shop.kurzus_json(p.kurzus_id),
                  -- „Neked”: a felvett kurzusodhoz tartozik, vagy célzottan neked szól
                  'neked', (p.kurzus_id is not null and p.kurzus_id = any (v_kurz)) or (p.celkozonseg is not null),
                  'kurzusodhoz', (p.kurzus_id is not null and p.kurzus_id = any (v_kurz)),
                  'sorrend', p.sorrend) as x
                from shop.product p
               where shop.arusithato(p) and shop.lathato(p.celkozonseg)) s), '[]'::jsonb),
    'fizetes', jsonb_build_object(
      'bank',    (select ertek from shop.setting where kulcs = 'bank'),
      'kartya',  coalesce(((select ertek from shop.setting where kulcs = 'kartya') ->> 'aktiv')::boolean, false),
      'qvik',    coalesce(((select ertek from shop.setting where kulcs = 'qvik') ->> 'aktiv')::boolean, false),
      'hatarido_nap', coalesce(((select ertek from shop.setting where kulcs = 'fizetes') ->> 'hatarido_nap')::int, 8))
  ) into v_out;
  return v_out;
end $$;

-- p_items: [{"product_id": "...", "variant_id": "...", "mennyiseg": 1, "adatok": {...}}]
create or replace function public.shop_order_create(
  p_items jsonb, p_szamlazas jsonb default '{}'::jsonb,
  p_fizetesi_mod text default 'atutalas', p_megjegyzes text default null
) returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare
  v_me     uuid := auth.uid();
  v_p      public.profiles%rowtype;
  v_order  uuid;
  v_ref    bigint;
  v_tetel  jsonb;
  v_prod   shop.product%rowtype;
  v_var    shop.product_variant%rowtype;
  v_van_valt boolean;
  v_ar     int;
  v_menny  int;
  v_adatok jsonb;
  v_mezo   jsonb;
  v_ertek  text;
  v_jovah  boolean := false;
  v_hat    int;
  v_bank   jsonb;
begin
  if v_me is null then raise exception 'SHOP_NOT_AUTHENTICATED'; end if;
  if not public.is_approved() then raise exception 'SHOP_NOT_APPROVED'; end if;
  select * into v_p from public.profiles where id = v_me;
  if v_p.role = 'AGENT' then raise exception 'SHOP_FORBIDDEN: ugynoki fiokkal nem lehet vasarolni.'; end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'SHOP_EMPTY_CART'; end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'SHOP_TOO_MANY_ITEMS'; end if;

  p_fizetesi_mod := coalesce(p_fizetesi_mod, 'atutalas');
  if p_fizetesi_mod not in ('atutalas', 'kartya', 'qvik') then raise exception 'SHOP_BAD_PAYMENT_METHOD'; end if;
  if p_fizetesi_mod = 'kartya' and not coalesce(((select ertek from shop.setting where kulcs = 'kartya') ->> 'aktiv')::boolean, false) then
    raise exception 'SHOP_PAYMENT_METHOD_OFF: a kartyas fizetes meg nincs bekapcsolva.';
  end if;
  if p_fizetesi_mod = 'qvik' and not coalesce(((select ertek from shop.setting where kulcs = 'qvik') ->> 'aktiv')::boolean, false) then
    raise exception 'SHOP_PAYMENT_METHOD_OFF: a qvik fizetes meg nincs bekapcsolva.';
  end if;
  if p_fizetesi_mod = 'atutalas' then
    select ertek into v_bank from shop.setting where kulcs = 'bank';
    if coalesce(v_bank ->> 'szamlaszam', '') = '' and coalesce(v_bank ->> 'iban', '') = '' then
      raise exception 'SHOP_NO_BANK_DETAILS: a banki atutalashoz meg nincs megadva a szamlaszam.';
    end if;
  end if;

  select coalesce((ertek ->> 'hatarido_nap')::int, 8) into v_hat from shop.setting where kulcs = 'fizetes';

  insert into shop.orders (vevo, vevo_email, vevo_nev, szamlazasi_adatok, fizetesi_mod, vevo_megjegyzes)
  values (v_me, v_p.email, coalesce(nullif(v_p.name, ''), v_p.email),
          coalesce(p_szamlazas, '{}'::jsonb), p_fizetesi_mod, nullif(btrim(coalesce(p_megjegyzes, '')), ''))
  returning id, ref_no into v_order, v_ref;

  for v_tetel in select * from jsonb_array_elements(p_items)
  loop
    select * into v_prod from shop.product where id = nullif(v_tetel ->> 'product_id', '')::uuid;
    if v_prod.id is null or not shop.arusithato(v_prod) or not shop.lathato(v_prod.celkozonseg) then
      raise exception 'SHOP_PRODUCT_UNAVAILABLE: %', coalesce(v_prod.nev, v_tetel ->> 'product_id', '?');
    end if;
    v_menny := greatest(coalesce((v_tetel ->> 'mennyiseg')::int, 1), 1);
    if v_prod.max_rendelesenkent is not null and v_menny > v_prod.max_rendelesenkent then
      raise exception 'SHOP_LIMIT: % — legfeljebb % db rendelheto.', v_prod.nev, v_prod.max_rendelesenkent;
    end if;

    -- Változat: ha a terméknek van aktív változata, kötelező, és csak a sajátja lehet
    v_var := null;
    v_van_valt := exists (select 1 from shop.product_variant v where v.product_id = v_prod.id and v.aktiv);
    if v_van_valt then
      select * into v_var from shop.product_variant
       where id = nullif(v_tetel ->> 'variant_id', '')::uuid and product_id = v_prod.id and aktiv;
      if v_var.id is null then raise exception 'SHOP_VARIANT_REQUIRED: %', v_prod.nev; end if;
    elsif nullif(v_tetel ->> 'variant_id', '') is not null then
      raise exception 'SHOP_PRODUCT_UNAVAILABLE: %', v_prod.nev;
    end if;
    v_ar := coalesce(v_var.ar_huf, v_prod.ar_huf);

    -- Bekért adatok a termék mezőlistája szerint
    v_adatok := case when jsonb_typeof(v_tetel -> 'adatok') = 'object' then v_tetel -> 'adatok' else '{}'::jsonb end;
    for v_mezo in select * from jsonb_array_elements(coalesce(v_prod.mezok, '[]'::jsonb))
    loop
      v_ertek := btrim(coalesce(v_adatok ->> (v_mezo ->> 'kulcs'), ''));
      if coalesce((v_mezo ->> 'kotelezo')::boolean, false) and v_ertek = '' then
        raise exception 'SHOP_FIELD_REQUIRED: % — %', v_prod.nev, coalesce(v_mezo ->> 'cimke', v_mezo ->> 'kulcs');
      end if;
      if v_mezo ->> 'tipus' = 'rendszam' and v_ertek <> '' then
        v_ertek := upper(regexp_replace(v_ertek, '\s+', '', 'g'));
        if v_ertek !~ '^[A-Z0-9-]{4,10}$' then
          raise exception 'SHOP_FIELD_INVALID: % — ervenytelen rendszam: %', v_prod.nev, v_ertek;
        end if;
        v_adatok := jsonb_set(v_adatok, array[v_mezo ->> 'kulcs'], to_jsonb(v_ertek));
      end if;
    end loop;

    -- Atomi készletfoglalás: a változaté, ha van neki készlete; különben a terméké
    if v_var.id is not null and v_var.keszlet is not null then
      update shop.product_variant set keszlet = keszlet - v_menny where id = v_var.id and keszlet >= v_menny;
      if not found then raise exception 'SHOP_OUT_OF_STOCK: % (%)', v_prod.nev, v_var.nev; end if;
    elsif v_prod.keszlet is not null then
      update shop.product set keszlet = keszlet - v_menny where id = v_prod.id and keszlet >= v_menny;
      if not found then raise exception 'SHOP_OUT_OF_STOCK: %', v_prod.nev; end if;
    end if;

    insert into shop.order_item (order_id, product_id, variant_id, variant_nev, nev, tipus, egysegar_huf, afa_kulcs, mennyiseg, adatok, jovahagyas)
    values (v_order, v_prod.id, v_var.id, v_var.nev, v_prod.nev, v_prod.tipus, v_ar, v_prod.afa_kulcs, v_menny, v_adatok,
            case when v_prod.jovahagyas_kell then 'var' else null end);
    if v_prod.jovahagyas_kell then v_jovah := true; end if;
  end loop;

  perform shop.osszeg_ujra(v_order);
  update shop.orders
     set fizetesi_kozlemeny = shop.kozlemeny(v_ref),
         allapot = case when v_jovah then 'jovahagyasra_var' else 'fizetesre_var' end,
         fizetesi_hatarido = case when v_jovah then null else now() + make_interval(days => v_hat) end
   where id = v_order;
  update shop.orders set allapot = 'fizetve', fizetve_at = now(), fizetesi_mod = 'kezi'
   where id = v_order and osszeg_huf = 0 and allapot = 'fizetesre_var';

  perform shop.naplo(v_order, 'letrehozva', jsonb_build_object('tetelek', jsonb_array_length(p_items), 'fizetesi_mod', p_fizetesi_mod));
  return shop.order_json(v_order);
end $$;

-- ---------------------------------------------------------------------------
-- 5) KEZELŐI katalógus, mentés, közzététel, másolás, kurzusválasztó
-- ---------------------------------------------------------------------------
create or replace function public.shop_admin_catalog()
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  return jsonb_build_object(
    'kategoriak', coalesce((select jsonb_agg(to_jsonb(c) || jsonb_build_object(
                     'termek_db', (select count(*) from shop.product p where p.category_id = c.id))
                   order by c.sorrend, c.nev) from shop.category c), '[]'::jsonb),
    'termekek', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
                     'eladott_db', (select coalesce(sum(i.mennyiseg), 0) from shop.order_item i
                                     join shop.orders o on o.id = i.order_id
                                    where i.product_id = p.id and o.allapot in ('fizetve', 'teljesitve')),
                     'valtozatok', shop.valtozatok_json(p.id, false),
                     'kepek', shop.kepek_json(p.id),
                     'kurzus', shop.kurzus_json(p.kurzus_id),
                     'hianyok', to_jsonb(shop.kozzetetel_hianyok(p.id)),
                     'arusithato', shop.arusithato(p))
                   order by p.sorrend, p.nev) from shop.product p), '[]'::jsonb),
    'beallitasok', coalesce((select jsonb_object_agg(kulcs, ertek) from shop.setting), '{}'::jsonb));
end $$;

-- Mentés: törzsadat + változatok + képek egy lépésben. A 'statusz' =
-- 'kozzetett' csak akkor marad meg, ha a sablon kötelező adatai megvannak.
create or replace function public.shop_product_save(p jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare
  v_id     uuid := nullif(p ->> 'id', '')::uuid;
  -- Visszafelé kompatibilitás a 74-es felülettel: ha nincs 'statusz' / 'sablon',
  -- az 'aktiv' és a 'tipus' mezőből vezetjük le.
  v_stat   text := coalesce(nullif(p ->> 'statusz', ''),
                            case when (p ->> 'aktiv')::boolean then 'kozzetett' when p ? 'aktiv' then 'archivalt' else 'vazlat' end);
  v_sablon text := coalesce(nullif(p ->> 'sablon', ''),
                            case p ->> 'tipus' when 'digitalis' then 'digitalis_jegyzet' when 'parkolokartya' then 'parkolokartya'
                                               when 'szolgaltatas' then 'szolgaltatas' else 'nyomtatott' end);
  v_tipus  text;
  v_v      jsonb;
  v_vid    uuid;
  v_tartott uuid[] := '{}';
  v_kep    jsonb;
  v_n      int := 0;
  v_hiany  text[];
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if coalesce(btrim(p ->> 'nev'), '') = '' then raise exception 'SHOP_FIELD_REQUIRED: nev'; end if;
  if (p ->> 'ar_huf') is null or (p ->> 'ar_huf')::int < 0 then raise exception 'SHOP_FIELD_REQUIRED: ar_huf'; end if;
  if p ? 'mezok' and jsonb_typeof(p -> 'mezok') <> 'array' then raise exception 'SHOP_FIELD_INVALID: mezok'; end if;
  if v_stat not in ('vazlat', 'kozzetett', 'archivalt') then raise exception 'SHOP_FIELD_INVALID: statusz'; end if;
  v_tipus := case v_sablon when 'digitalis_jegyzet' then 'digitalis' when 'parkolokartya' then 'parkolokartya'
                           when 'rendezvenyjegy' then 'szolgaltatas' when 'berlet' then 'szolgaltatas'
                           when 'szolgaltatas' then 'szolgaltatas' else 'fizikai' end;

  if v_id is null then
    insert into shop.product (sku, nev, ar_huf, created_by, statusz, sablon, tipus)
    values (nullif(btrim(coalesce(p ->> 'sku', '')), ''), btrim(p ->> 'nev'), (p ->> 'ar_huf')::int, auth.uid(), 'vazlat', v_sablon, v_tipus)
    returning id into v_id;
  elsif not exists (select 1 from shop.product where id = v_id) then
    raise exception 'SHOP_NOT_FOUND';
  end if;

  update shop.product set
    sku = nullif(btrim(coalesce(p ->> 'sku', '')), ''), nev = btrim(p ->> 'nev'), leiras = nullif(p ->> 'leiras', ''),
    category_id = nullif(p ->> 'category_id', '')::uuid, sablon = v_sablon, tipus = v_tipus,
    ar_huf = (p ->> 'ar_huf')::int, afa_kulcs = coalesce(nullif(p ->> 'afa_kulcs', ''), afa_kulcs),
    keszlet = nullif(p ->> 'keszlet', '')::int, max_rendelesenkent = nullif(p ->> 'max_rendelesenkent', '')::int,
    jovahagyas_kell = coalesce((p ->> 'jovahagyas_kell')::boolean, jovahagyas_kell),
    mezok = coalesce(p -> 'mezok', mezok), fajl_utvonal = nullif(p ->> 'fajl_utvonal', ''),
    celkozonseg = case when jsonb_typeof(p -> 'celkozonseg') = 'object' then p -> 'celkozonseg' else null end,
    sorrend = coalesce((p ->> 'sorrend')::int, sorrend),
    reszletek = case when jsonb_typeof(p -> 'reszletek') = 'object' then p -> 'reszletek' else '{}'::jsonb end,
    ertekesites_tol = nullif(p ->> 'ertekesites_tol', '')::timestamptz,
    ertekesites_ig  = nullif(p ->> 'ertekesites_ig', '')::timestamptz,
    kurzus_id = nullif(p ->> 'kurzus_id', '')::uuid,
    -- Ha a felület nem küld teljesítési módot, a sablon alapértelmezése szerint.
    teljesites = coalesce(nullif(p ->> 'teljesites', ''),
                          case v_sablon when 'digitalis_jegyzet' then 'letoltes' when 'parkolokartya' then 'automatikus'
                                        when 'rendezvenyjegy' then 'kezi' when 'berlet' then 'kezi' when 'szolgaltatas' then 'kezi'
                                        else 'atvetel' end),
    atveteli_hely = nullif(btrim(coalesce(p ->> 'atveteli_hely', '')), ''),
    updated_at = now()
   where id = v_id;

  -- Változatok: a listában szereplőket frissítjük/felvesszük; a kimaradókat
  -- töröljük, ha nincs rájuk rendelés — különben csak inaktiváljuk.
  if jsonb_typeof(p -> 'valtozatok') = 'array' then
    for v_v in select * from jsonb_array_elements(p -> 'valtozatok')
    loop
      if coalesce(btrim(v_v ->> 'nev'), '') = '' then continue; end if;
      v_vid := nullif(v_v ->> 'id', '')::uuid;
      if v_vid is not null and exists (select 1 from shop.product_variant where id = v_vid and product_id = v_id) then
        update shop.product_variant set nev = btrim(v_v ->> 'nev'),
               tulajdonsagok = case when jsonb_typeof(v_v -> 'tulajdonsagok') = 'object' then v_v -> 'tulajdonsagok' else '{}'::jsonb end,
               sku = nullif(btrim(coalesce(v_v ->> 'sku', '')), ''), ar_huf = nullif(v_v ->> 'ar_huf', '')::int,
               keszlet = nullif(v_v ->> 'keszlet', '')::int, aktiv = coalesce((v_v ->> 'aktiv')::boolean, true),
               sorrend = coalesce((v_v ->> 'sorrend')::int, 100)
         where id = v_vid;
      else
        insert into shop.product_variant (product_id, nev, tulajdonsagok, sku, ar_huf, keszlet, aktiv, sorrend)
        values (v_id, btrim(v_v ->> 'nev'),
                case when jsonb_typeof(v_v -> 'tulajdonsagok') = 'object' then v_v -> 'tulajdonsagok' else '{}'::jsonb end,
                nullif(btrim(coalesce(v_v ->> 'sku', '')), ''), nullif(v_v ->> 'ar_huf', '')::int,
                nullif(v_v ->> 'keszlet', '')::int, coalesce((v_v ->> 'aktiv')::boolean, true), coalesce((v_v ->> 'sorrend')::int, 100))
        returning id into v_vid;
      end if;
      v_tartott := v_tartott || v_vid;
    end loop;
    delete from shop.product_variant v
     where v.product_id = v_id and not (v.id = any (v_tartott))
       and not exists (select 1 from shop.order_item i where i.variant_id = v.id);
    update shop.product_variant set aktiv = false where product_id = v_id and not (id = any (v_tartott));
  end if;

  -- Képek: a lista a teljes, sorrendhelyes képsor
  if jsonb_typeof(p -> 'kepek') = 'array' then
    delete from shop.product_image where product_id = v_id;
    for v_kep in select * from jsonb_array_elements(p -> 'kepek')
    loop
      if coalesce(btrim(v_kep ->> 'url'), '') = '' then continue; end if;
      if (v_kep ->> 'url') !~* '^https://' then raise exception 'SHOP_FIELD_INVALID: a kep cime https:// kell legyen.'; end if;
      v_n := v_n + 1;
      insert into shop.product_image (product_id, url, alt, sorrend) values (v_id, btrim(v_kep ->> 'url'), nullif(v_kep ->> 'alt', ''), v_n);
    end loop;
    update shop.product set kep_url = (select url from shop.product_image where product_id = v_id order by sorrend limit 1) where id = v_id;
  elsif p ? 'kep_url' then
    update shop.product set kep_url = nullif(p ->> 'kep_url', '') where id = v_id;
  end if;

  -- Állapot: közzétételkor a sablon kötelező adatai
  if v_stat = 'kozzetett' then
    v_hiany := shop.kozzetetel_hianyok(v_id);
    if cardinality(v_hiany) > 0 then
      raise exception 'SHOP_PUBLISH_MISSING: %', array_to_string(v_hiany, ', ');
    end if;
  end if;
  update shop.product set statusz = v_stat, aktiv = (v_stat = 'kozzetett') where id = v_id;

  return (select to_jsonb(x) || jsonb_build_object('valtozatok', shop.valtozatok_json(x.id, false), 'kepek', shop.kepek_json(x.id),
                                                   'kurzus', shop.kurzus_json(x.kurzus_id), 'hianyok', to_jsonb(shop.kozzetetel_hianyok(x.id)))
            from shop.product x where x.id = v_id);
end $$;

-- Másolat vázlatként (pl. a következő félév parkolókártyája). A készlet
-- szándékosan nem öröklődik: 0 lesz, hogy ne adjunk el nem létező árut.
create or replace function public.shop_product_copy(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = shop, public, pg_temp
as $$
declare v_uj uuid;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  insert into shop.product (sku, nev, leiras, category_id, tipus, ar_huf, afa_kulcs, keszlet, max_rendelesenkent, jovahagyas_kell,
                            mezok, kep_url, fajl_utvonal, celkozonseg, aktiv, sorrend, created_by, statusz, sablon, reszletek,
                            ertekesites_tol, ertekesites_ig, kurzus_id, teljesites, atveteli_hely)
  select null, nev || ' (másolat)', leiras, category_id, tipus, ar_huf, afa_kulcs, case when keszlet is null then null else 0 end,
         max_rendelesenkent, jovahagyas_kell, mezok, kep_url, fajl_utvonal, celkozonseg, false, sorrend, auth.uid(), 'vazlat', sablon,
         reszletek, null, null, kurzus_id, teljesites, atveteli_hely
    from shop.product where id = p_id
  returning id into v_uj;
  if v_uj is null then raise exception 'SHOP_NOT_FOUND'; end if;
  insert into shop.product_variant (product_id, nev, tulajdonsagok, sku, ar_huf, keszlet, aktiv, sorrend)
  select v_uj, nev, tulajdonsagok, null, ar_huf, case when keszlet is null then null else 0 end, aktiv, sorrend
    from shop.product_variant where product_id = p_id;
  insert into shop.product_image (product_id, url, alt, sorrend)
  select v_uj, url, alt, sorrend from shop.product_image where product_id = p_id;
  return (select to_jsonb(x) || jsonb_build_object('valtozatok', shop.valtozatok_json(x.id, false), 'kepek', shop.kepek_json(x.id))
            from shop.product x where x.id = v_uj);
end $$;

-- Kurzusválasztó a szerkesztőhöz
create or replace function public.shop_course_options(p_q text default null)
returns jsonb
language plpgsql stable security definer
set search_path = shop, public, pg_temp
as $$
declare v_q text := nullif(btrim(coalesce(p_q, '')), ''); v_out jsonb;
begin
  if not shop.is_manager() then raise exception 'SHOP_FORBIDDEN'; end if;
  if to_regclass('echo.course') is null then return '[]'::jsonb; end if;
  execute $q$
    select coalesce(jsonb_agg(x), '[]'::jsonb) from (
      select jsonb_build_object('id', k.id, 'cimke', k.code || ' · ' || k.name_hu, 'reszlet', k.term) as x
        from echo.course k
       where $1 is null or k.code ilike '%' || $1 || '%' or k.name_hu ilike '%' || $1 || '%'
       order by k.term desc, k.code limit 50) s
  $q$ into v_out using v_q;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 6) Jogosultságok
-- ---------------------------------------------------------------------------
revoke all on all functions in schema shop from public, anon, authenticated;
grant execute on function shop.is_manager() to authenticated;
grant execute on function shop.fajl_olvashato(text) to authenticated;

do $g$
declare f text;
begin
  foreach f in array array['public.shop_catalog()', 'public.shop_order_create(jsonb, jsonb, text, text)',
                           'public.shop_admin_catalog()', 'public.shop_product_save(jsonb)',
                           'public.shop_product_copy(uuid)', 'public.shop_course_options(text)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $g$;

do $chk$
begin
  if has_function_privilege('anon', 'public.shop_product_save(jsonb)', 'execute')
     or has_table_privilege('authenticated', 'shop.product_variant', 'select') then
    raise exception 'BIZTONSAGI HIBA: a webshop szerkeszto jogosultsagai tul tagok.';
  end if;
  raise notice 'Rendben: 75 — sablonos termekszerkeszto (valtozatok, kepek, kozzetetel, kurzus).';
end $chk$;
