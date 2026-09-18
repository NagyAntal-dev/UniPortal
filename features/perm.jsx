/* ===========================================================================
   perm.jsx — akció-szintű jogosultság a felületen (72_rbac_actions.sql)

   MI VOLT EDDIG
     A jogosultság-ellenőrzés kódba égetett szerepkör-tömbökben élt, 43 helyen,
     14 fájlban:
         const canEditStatus = ['SUPERADMIN','ADMIN','ADMISSIONS'].indexOf(user.role) >= 0;
         const FEED_szerkeszto = (user) => ['SUPERADMIN','ADMIN'].includes(user.role);
     Egy szerepkör átszabásához kódot kellett módosítani és deployolni, és
     „olvashat, de nem szerkeszthet" szerepkört egyáltalán nem lehetett csinálni.

   MI LESZ
     Egyetlen igazságforrás: PERM_can(user, modul, művelet). A jogokat a
     loadProfile egyetlen RPC-hívásból hozza (my_module_permissions), és a
     currentUser.perms mezőben tartja.

   A HARMADIK PARAMÉTER A LÉNYEG — `regi`
     Minden hívóhely átadja azt az értéket, amit MA számolt. Ha a 72-es migráció
     még nem futott le (user.perms == null), EZ dönt. Egy nem lefutott migráció
     tehát nem vesz el semmit — pontosan úgy, ahogy a rolePerms === null ág is
     visszaesik a kódba égetett menülistákra (app.jsx).
     Ez nem óvatoskodás: a GitHub Pages változata és a Docker-telepítés
     külön ütemben frissül, tehát egy régi adatbázis + új bundle valós állapot.

   A SZUPERADMIN
     Mindig mindent. Se a szerver, se ez a fájl nem nézi nála a mátrixot —
     ha elvehető lenne, ki tudná zárni magát abból a képernyőből is, amivel
     visszaállítaná.

   Adatbázis: 72_rbac_actions.sql
   =========================================================================== */

/* A művelet-kódok egy helyen, hogy egy elírás ne csendben hamisat adjon. */
const PERM_ACTIONS = ['VIEW', 'USE', 'CREATE', 'EDIT', 'DELETE'];

/* A mai ügyintézői kör — az adatbázis is_staff() párja. CSAK a `regi` érték
   hiányában használjuk, tartalékként. A data-layer.jsx isStaff()-jával
   szándékosan NEM azonos: az kihagyja a SUPERADMIN-t (latens hiba), ez nem. */
const PERM_regiStaff = (user) =>
  !!(user && ['SUPERADMIN', 'ADMIN', 'ADMISSIONS', 'FINANCE'].indexOf(user.role) >= 0);

/* ---------------------------------------------------------------------------
   PERM_can — az egyetlen igazságforrás

   user   a currentUser (app.jsx loadProfile)
   modul  AppView-azonosító: 'feed', 'finance', 'admissions_core', …
   action 'VIEW' | 'USE' | 'CREATE' | 'EDIT' | 'DELETE'
   regi   a MA érvényes, kódba égetett érték. Ha a 72-es még nem futott le,
          ez dönt. Ha nincs megadva, a mai ügyintézői kör dönt.
   --------------------------------------------------------------------------- */
function PERM_can(user, modul, action, regi) {
  if (!user) return false;
  // A szuperadmin hozzáférése nem a táblából jön.
  if (user.role === 'SUPERADMIN') return true;
  // Jóváhagyás nélkül semmi. A szerver is így dönt (rbac_can -> is_approved).
  if (user.status && user.status !== 'approved') return false;

  const p = user.perms;
  if (!p || typeof p !== 'object') {
    // A 72-es nem futott le (vagy az RPC nem érhető el) — a mai viselkedés dönt.
    return regi === undefined ? PERM_regiStaff(user) : !!regi;
  }
  // A szerver a szuperadminnak {"*": [...]} alakot ad.
  if (Array.isArray(p['*'])) return true;

  const lista = p[modul];
  if (!Array.isArray(lista)) return false;
  return lista.indexOf(String(action || '').toUpperCase()) >= 0;
}

/* ---------------------------------------------------------------------------
   PERM_of — egy modul összes műveletét egy objektumban

   A hívóhelyek nagy része így a legolvashatóbb:
       const jog = PERM_of(user, 'admissions_core', { edit: canEditStatus });
       <button disabled={!jog.edit}>…</button>

   A `regi` itt objektum: { view, use, create, edit, del }. Ami nincs benne,
   arra a PERM_regiStaff dönt (csak a 72-es előtt).
   A `del` és nem `delete`: a delete nyelvi kulcsszó, és a `jog.delete`
   ugyan működik, de félreolvasható.
   --------------------------------------------------------------------------- */
function PERM_of(user, modul, regi) {
  const r = regi || {};
  return {
    view:   PERM_can(user, modul, 'VIEW',   r.view),
    use:    PERM_can(user, modul, 'USE',    r.use),
    create: PERM_can(user, modul, 'CREATE', r.create),
    edit:   PERM_can(user, modul, 'EDIT',   r.edit),
    del:    PERM_can(user, modul, 'DELETE', r.del),
  };
}

/* Igaz, ha a 72-es lefutott ÉS a felület megkapta a jogokat. A felület ezt
   használja annak eldöntésére, hogy kiírhatja-e: „ez a mátrixból jön". */
const PERM_elo = (user) => !!(user && user.perms && typeof user.perms === 'object');

/* ---------------------------------------------------------------------------
   PERM_Denied — „nincs jogosultsága" panel

   MIÉRT KELL: a renderContent() ma a nem engedélyezett nézet helyett CSENDBEN
   a Hírfolyamra dob. A felhasználó azt hiszi, elkattintott, és újra
   megpróbálja. Ez a panel KIMONDJA, mi történt, és hogy kihez fordulhat.
   Ugyanaz a hangvétel, mint az AGENCY_Empty (features/agency.jsx:280) és a
   DORM_Empty (features/dorm.jsx:3568) tiltó képernyőinél.
   --------------------------------------------------------------------------- */
const PERM_MUVELET_SZO = {
  VIEW: 'megtekintéséhez', USE: 'használatához', CREATE: 'létrehozásához',
  EDIT: 'szerkesztéséhez', DELETE: 'törléséhez',
};

function PERM_Denied({ modul, action, modulNev }) {
  const nev = modulNev || modul || 'ez a képernyő';
  const szo = PERM_MUVELET_SZO[String(action || 'VIEW').toUpperCase()] || 'eléréséhez';
  return (
    <div className="bg-white rounded-3xl border border-slate-100">
      <UEmpty
        icon={<Lucide.Lock size={26} />}
        title="Ehhez nincs jogosultsága"
        subtitle={'A(z) „' + nev + '" ' + szo + ' a szerepköre nem ad jogot. '
                + 'Ha szükséged van rá, a rendszergazda a Regisztrációk → Szerepkörök '
                + 'fülön tudja megadni.'}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   PERM_Gate — feltételes megjelenítés

   <PERM_Gate user={user} modul="finance" action="EDIT">
     <button …>Mentés</button>
   </PERM_Gate>

   Jog nélkül alapból NEM rajzol semmit (a gomb eltűnik). A `fallback`-kel
   lehet helyette mást kiírni, a `tiltva`-val pedig a PERM_Denied panelt.
   --------------------------------------------------------------------------- */
function PERM_Gate({ user, modul, action, regi, children, fallback, tiltva, modulNev }) {
  if (PERM_can(user, modul, action, regi)) return children || null;
  if (tiltva) return <PERM_Denied modul={modul} action={action} modulNev={modulNev} />;
  return fallback || null;
}

/* ---------------------------------------------------------------------------
   PERM_Miert — egy rövid magyarázó címke a letiltott gombokra

   A repó máshol is ezt a megoldást választja a rejtés helyett: az app.jsx:3814
   nem elrejti a döntés-gombot, hanem kiírja, hogy „Felvételi döntést a
   felvételi iroda munkatársa hozhat". Egy letiltott gomb magyarázat nélkül
   hibának látszik.
   --------------------------------------------------------------------------- */
const PERM_cim = (action) =>
  'Ehhez nincs jogosultsága (' + String(action || 'VIEW').toUpperCase() + ').';

/* ===========================================================================
   AMI SZÁNDÉKOSAN NEM A MÁTRIXBÓL JÖN

   A 72-es bevezetésekor a 43 kódba égetett szerepkör-ellenőrzés közül nem
   mindegyik lett PERM_can. A megmaradók három csoportba esnek, és mindhárom
   megmaradása szándékos — aki „befejezi a munkát" és ezeket is átírja, az
   elront valamit. Ezért itt felsoroljuk, hol és miért.

   1. „KI VAGYOK", nem „MIT TEHETEK" — PERSPEKTÍVA-választás
      features/agency.jsx:480,482  isAgent / isFinance
      features/agency.jsx (lejjebb) isAgent
      features/courses.jsx         hallgato
      features/messages.jsx        a hallgatói menü-jelvény ága
      Ezek nem azt döntik el, hogy SZABAD-e, hanem hogy MELYIK NÉZET jelenjen
      meg. Egy ügynöknek ügynöki, egy pénzügyesnek pénzügyi képernyő jár —
      ezt nem jogosultsággal kell állítani, és a mátrixban nem is lenne
      értelmes cellája.

   2. AZ ECHO ÉS A KOLLÉGIUM SAJÁT, HATÓKÖRÖS DIMENZIÓJA
      features/dorm.jsx:235        DORM_isAdmin
      features/dorm-views.jsx      isAdminUser
      features/echo.jsx            isAdminRole
      features/teachers.jsx        a fiók-kötés gombja (ECHO-grantot oszt)
      Az echo.role_grant és a dorm.role_grant ÖNÁLLÓ jogosultsági dimenzió, a
      19-es és a 26-os migrációval. A 19-es fejléce kimondja: „AZ ECHO-JOG
      SOHA NEM SZÁRMAZIK A UniPortal SUPERADMIN-BÓL." Ezekben a modulokban a
      modul-mátrix SZÁNDÉKOSAN csak a menü-láthatóságot (VIEW) vezérli.
      A kódban látszó is_admin()-ág a két migráció dokumentált tyúk-tojás
      hídja: valakinek ki kell tudnia adni az ELSŐ SYSADMIN grantot. Ha ezt
      mátrix-jogra cserélnénk, a felület és a szerver (dorm.can_grant,
      echo.can_grant) azonnal elcsúszna egymástól.

   3. SZUPERADMIN-KAPUK, amiket nem szabad delegálhatóvá tenni
      features/roles.jsx           isSuper
      features/groups.jsx          isSuper
      features/registrations.jsx   REG_* (a jóváhagyási sor)
      app.jsx canSeeView           registrations / consents ága
      Aki a jogosultságokat vagy a fiók-jóváhagyást szerkeszti, az a saját
      jogait is át tudja írni. Ha ez mátrix-jog lenne, egy elrontott cella
      után nem maradna, aki visszaállítja. A szerver is így dönt: a
      role_action_set, a group_permission_set és a profiles.role írása mind
      is_superadmin()-hoz kötött, nem modul-joghoz.
   =========================================================================== */
