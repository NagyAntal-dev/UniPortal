"""Generate a private, transactional Supabase SQL import from the NJE workbook.

First import:  python tools/nje_import.py "NJE ...xlsx"
Later update:  python tools/nje_import.py "NJE ... new.xlsx" --previous "NJE ... old.xlsx"
                 --previous-credentials private-imports/<old>/credentials.csv --output private-imports/<new>

With --previous the SQL also synchronizes: enrollments missing from the new
workbook are marked dropped, and course data, teacher assignments, student
names and attributes change only where the database still holds the previous
workbook's value (admin edits win and are reported).
Requires openpyxl and bcrypt. Outputs are deliberately excluded from git.
"""
import argparse
import collections
import concurrent.futures
import csv
import hashlib
import json
from pathlib import Path
import re
import secrets
import unicodedata

import bcrypt
import openpyxl


SOURCE = "nje-workbook"
HEADERS = ["Félév", "Hallgató Szervezet kódja", "Kurzuskód", "Tárgykód",
           "Tárgynév", "Kurzustípus", "Órarendi információ", "Hallgató Neptun kód",
           "Egyén oktatási azonosító", "Hallgató Nyomtatási név", "Jelentkezés dátuma",
           "Modul neve", "Modulkód", "Tagozat", "Telephely neve", "Képzési szint",
           "Speciális indexsor típus", "Nem indul", "Jelentkezés letiltva",
           "Várólista létszám", "Létszám", "Nyelv", "Kurzus oktatók", "Típusazonosító",
           "Megjegyzés", "Kurzus Szervezeti egység kódja"]
# Teachers have no source ID, so their identity is the name. A spelling change
# between workbooks would otherwise create a second account for the same
# person. Map the NEW spelling to the spelling of the first import; keep only
# entries verified against course assignments.
TEACHER_ALIASES = {
    # 2026-09-28: same two courses (N-K-MGAMBAN-VALPENZ1-1-GY02/GY03).
    "Hamar Farkas Pál": "Hamar Farkas",
}


def clean(value):
    return unicodedata.normalize("NFC", str(value)).strip() if value is not None else ""


def quote(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def inserts(table, columns, rows):
    for start in range(0, len(rows), 500):
        yield f"insert into {table} ({columns}) values\n" + ",\n".join(
            "(" + ",".join(map(quote, row)) + ")" for row in rows[start:start + 500]) + ";\n"


def csv_file(path, header, rows):
    with path.open("w", encoding="utf-8-sig", newline="") as out:
        writer = csv.writer(out)
        writer.writerow(header)
        writer.writerows(rows)


def prepare(path):
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    students = collections.defaultdict(list)
    courses = collections.defaultdict(list)
    enrollments = set()
    count = 0
    for sheet in workbook:
        iterator = sheet.values
        headers = next(iterator, ())
        if not headers:
            continue
        if list(headers) != HEADERS:
            raise ValueError(f"Unexpected columns in {sheet.title}; no import generated")
        for number, row in enumerate(iterator, 2):
            if all(v is None for v in row):
                continue
            row = tuple(clean(v) if not isinstance(v, (int, float)) else v for v in row)
            if not all(row[i] for i in [0, 2, 4, 7, 9, 25]):
                raise ValueError(f"Missing required value: {sheet.title}:{number}")
            if not re.fullmatch(r"[A-Z0-9]{6}", row[7]):
                raise ValueError(f"Invalid student Neptun code: {sheet.title}:{number}")
            students[row[7]].append(row)
            courses[row[0], row[2]].append(row)
            enrollments.add((row[0], row[2], row[7]))
            count += 1
    workbook.close()
    if not count:
        raise ValueError("No enrollment rows found")
    return students, courses, enrollments, count


def teacher_code(name):
    canonical = TEACHER_ALIASES.get(name, name)
    return "NJE-T-" + hashlib.sha256(canonical.casefold().encode()).hexdigest()[:16]


def build(students, courses):
    """Derive accounts, courses and assignments exactly as the import stores them."""
    teacher_names = sorted({n.strip() for rows in courses.values() for row in rows
                            for n in row[22].split(",") if n.strip()})
    teachers = {name: teacher_code(name) for name in teacher_names}
    if len(set(teachers.values())) != len(teachers):
        raise ValueError("Teacher name collision; resolve spelling before importing")
    accounts, attributes, student_variants, course_rows, teacher_links = [], [], [], [], []
    review = []
    for code, rows in sorted(students.items()):
        names = {r[9] for r in rows}
        if len(names) != 1:
            raise ValueError(f"Multiple names for Neptun code {code}: {names}")
        accounts.append(["S:" + code, "STUDENT", code, rows[0][9],
                         f"student.{code.lower()}@nje-import.invalid"])
        # Nyelv describes the COURSE, not the student's program language.
        variants = collections.Counter(tuple(r[i] for i in [13, 15, 11, 1, 12]) + (None, r[14]) for r in rows)
        # A profile has one attribute row. Keep the most frequent program and
        # preserve every variant in a separate review CSV instead of discarding it.
        primary = sorted(variants, key=lambda v: (-variants[v], v))[0]
        attributes.append(["S:" + code, code, *primary])
        for variant, frequency in sorted(variants.items()):
            student_variants.append([code, rows[0][9], variant == primary, frequency, *variant])
        if len(variants) > 1:
            review.append(["student_multiple_attributes", code, str(len(variants)),
                           "Most frequent combination used; all combinations in student-programs.csv"])
    for name, code in teachers.items():
        accounts.append(["T:" + code, "TEACHER", code, name,
                         f"teacher.{code[6:]}@nje-import.invalid"])
    orgs = sorted({r[i] for rows in courses.values() for r in rows for i in [1, 25] if r[i]})
    for (term, code), rows in sorted(courses.items()):
        for index in [5, 6, 17, 18, 20, 21, 22, 23, 25]:
            if len({r[index] for r in rows}) != 1:
                raise ValueError(f"Conflicting course metadata {code}: {HEADERS[index]}")
        row = rows[0]
        names = sorted({r[4] for r in rows})
        subject_codes = sorted({r[3] for r in rows})
        # Prefer the subject code embedded in the course code; otherwise use
        # the most common subject name with deterministic tie breaking.
        preferred = [r[4] for r in rows if r[3] in code] or [r[4] for r in rows]
        counts = collections.Counter(preferred)
        name = sorted(counts, key=lambda n: (-counts[n], n))[0]
        description = "\n".join(["Neptun workbook import", "Subject codes: " + ", ".join(subject_codes),
                                  "Subject names: " + " / ".join(names), "Course type: " + row[5],
                                  "Timetable: " + (row[6] or "not provided"),
                                  "Not starting: " + row[17], "Registration disabled: " + row[18]])
        lang = {"magyar": "hu", "angol": "en", "német": "de"}.get(row[21], "other")
        exam = row[5] == "Vizsgakurzus" or row[23] == "Vizsgakurzus"
        course_rows.append([term, code, name, name if lang == "en" else None, lang, row[25],
                            int(row[20]), bool(row[6]), exam, description])
        linked = sorted({n.strip() for n in row[22].split(",") if n.strip()})
        if not linked:
            review.append(["course_without_teacher", code, term, "No teacher in source; no assignment invented"])
        if len(linked) > 1:
            review.append(["unknown_teaching_shares", code, term,
                           " | ".join(linked) + "; share_pct=0 until actual teaching shares are entered"])
        for teacher in linked:
            teacher_links.append([term, code, teachers[teacher], 100 if len(linked) == 1 else 0])
        if len(names) > 1:
            review.append(["course_subject_aliases", code, term, " / ".join(names)])
        if row[17] == "Igaz":
            review.append(["course_not_starting", code, term, "Source enrollments retained; confirm status"])
        actual = len({r[7] for r in rows})
        if actual != int(row[20]):
            review.append(["headcount_difference", code, term,
                           f"Source headcount {row[20]}; imported student memberships {actual}"])
    return dict(teachers=teachers, accounts=accounts, attributes=attributes,
                student_variants=student_variants, orgs=orgs, course_rows=course_rows,
                teacher_links=teacher_links, review=review)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, default=Path("private-imports/nje-2026-27-1"))
    parser.add_argument("--previous", type=Path,
                        help="workbook of the import already applied to the database (enables sync)")
    parser.add_argument("--previous-credentials", type=Path,
                        help="credentials.csv of that import; its accounts must already exist")
    parser.add_argument("--student-scopes", default="kefo.hu",
                        help="comma-separated SAML student ePPN domains (SAML_STUDENT_SCOPES)")
    parser.add_argument("--max-drop-pct", type=float, default=5.0,
                        help="abort if more workbook enrollments than this would be dropped")
    args = parser.parse_args()
    # Never silently replace a credentials file: reruns retain database passwords.
    if args.output.exists():
        parser.error("Output directory already exists; choose a new --output directory")
    if bool(args.previous) != bool(args.previous_credentials):
        parser.error("--previous and --previous-credentials must be given together")
    students, courses, enrollments, row_count = prepare(args.workbook)
    new = build(students, courses)
    teachers, accounts, review = new["teachers"], new["accounts"], new["review"]
    course_rows, teacher_links = new["course_rows"], new["teacher_links"]

    prev, prev_keys, p_enrollments, sync = None, set(), set(), {}
    if args.previous:
        p_students, p_courses, p_enrollments, _ = prepare(args.previous)
        prev = build(p_students, p_courses)
        with args.previous_credentials.open(encoding="utf-8-sig", newline="") as src:
            prev_keys = {row["import_key"] for row in csv.DictReader(src)}
        if prev_keys != {a[0] for a in prev["accounts"]}:
            raise ValueError("--previous-credentials does not belong to --previous workbook")
        terms = {k[0] for k in courses}
        removed = sorted(k for k in p_courses if k not in courses and k[0] in terms)
        for term, code in removed:
            review.append(["course_removed_from_source", code, term,
                           "Enrollments marked dropped; headcount set to 0 unless edited in the portal"])
        renamed = {TEACHER_ALIASES[n] for n in teachers if n in TEACHER_ALIASES}
        for name in sorted(set(prev["teachers"]) - set(teachers) - renamed):
            review.append(["teacher_removed_from_source", prev["teachers"][name], name,
                           "Account kept; assignments follow the new workbook where not edited"])
        for name, canonical in TEACHER_ALIASES.items():
            if name in teachers and canonical in prev["teachers"]:
                review.append(["teacher_renamed", teachers[name], canonical + " -> " + name,
                               "Same teacher record and account; name updated unless edited"])
        sync = dict(added=len(enrollments - p_enrollments), dropped=len({e for e in p_enrollments - enrollments
                    if e[0] in terms}), new_students=len(set(students) - set(p_students)),
                    removed_students=len(set(p_students) - set(students)),
                    new_courses=len(set(courses) - set(p_courses)), removed_courses=len(removed))

    # Hash locally, so importing thousands of users does not spend minutes in
    # the SQL Editor computing bcrypt. Passwords never appear in the SQL file.
    # Accounts of the previous import already exist (the SQL aborts otherwise),
    # so they get no new password and never appear in this credentials file.
    fresh = [a for a in accounts if a[0] not in prev_keys]
    passwords = {a[0]: "Nje!" + secrets.token_urlsafe(18) for a in fresh}
    def password_hash(password):
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    print(f"Hashing {len(fresh)} unique account passwords...", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        hashes = dict(zip(passwords, pool.map(password_hash, passwords.values())))
    account_rows = [a + [hashes.get(a[0], ""), a[0] in prev_keys] for a in accounts]
    summary = dict(source=args.workbook.name, source_sha256=hashlib.sha256(args.workbook.read_bytes()).hexdigest(),
                   source_rows=row_count, students=len(students), teachers=len(teachers),
                   accounts=len(accounts), new_account_credentials=len(fresh), courses=len(courses),
                   enrollments=len(enrollments), duplicate_enrollment_rows=row_count - len(enrollments),
                   teacher_assignments=len(teacher_links), organizations=len(new["orgs"]),
                   review_counts=dict(collections.Counter(r[0] for r in review)))
    if prev:
        summary.update(previous=args.previous.name, changes_vs_previous=sync)
    template = Path(__file__).with_name("nje_import.sql.in").read_text(encoding="utf-8")
    scopes = [s.strip().lower() for s in args.student_scopes.split(",") if s.strip()]
    data = "\n".join([
        f"insert into nje_settings values ({quote(','.join(scopes))}, {args.max_drop_pct!r});\n",
        *inserts("nje_accounts", "key,role,code,name,email,password_hash,in_previous", account_rows),
        *inserts("nje_attributes", "key,neptun,tagozat,kepzesi_szint,szak,kar,szak_kod,nyelv,telephely", new["attributes"]),
        *inserts("nje_orgs", "code", [[o] for o in new["orgs"]]),
        *inserts("nje_courses", "term,code,name_hu,name_en,lang,org_code,letszam,van_orarendi_info,vizsgakurzus,leiras", course_rows),
        *inserts("nje_teachers", "code,name,key", [[code, name, "T:" + code] for name, code in teachers.items()]),
        *inserts("nje_links", "term,course_code,teacher_code,share_pct", teacher_links),
        *inserts("nje_enrollments", "term,course_code,key,in_previous",
                 [[t, c, "S:" + s, (t, c, s) in p_enrollments] for t, c, s in sorted(enrollments)])])
    if prev:
        data += "\n".join([
            *inserts("nje_prev_accounts", "key,name", [[a[0], a[3]] for a in prev["accounts"]]),
            *inserts("nje_prev_attributes", "neptun,tagozat,kepzesi_szint,szak,kar,szak_kod,nyelv,telephely",
                     [a[1:] for a in prev["attributes"]]),
            *inserts("nje_prev_courses", "term,code,name_hu,name_en,lang,org_code,letszam,van_orarendi_info,vizsgakurzus,leiras",
                     prev["course_rows"]),
            *inserts("nje_prev_teachers", "code,name", [[code, name] for name, code in prev["teachers"].items()]),
            *inserts("nje_prev_links", "term,course_code,teacher_code,share_pct", prev["teacher_links"])])
    sql = template.replace("-- INSERT_WORKBOOK_DATA", data)
    args.output.mkdir(parents=True)
    # LF even on Windows: the file is run by psql on the Linux server.
    (args.output / "import.sql").write_text(sql, encoding="utf-8", newline="\n")
    csv_file(args.output / "credentials.csv", ["import_key", "role", "source_code", "name", "placeholder_login", "initial_password"],
             [a + [passwords[a[0]]] for a in fresh])
    csv_file(args.output / "review.csv", ["issue", "source_code", "term_or_count", "details"], review)
    csv_file(args.output / "student-programs.csv", ["neptun", "name", "selected", "enrollment_rows",
             "tagozat", "kepzesi_szint", "szak", "kar", "szak_kod", "nyelv", "telephely"], new["student_variants"])
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    sync_text = "" if not prev else f"""
## Update of a previous import

Previous workbook: {args.previous.name}
Versus previous: {sync['added']:,} enrollments added, {sync['dropped']:,} dropped;
{sync['new_students']:,} new / {sync['removed_students']:,} vanished students;
{sync['new_courses']:,} new / {sync['removed_courses']:,} vanished courses.

Every account of the previous import must already exist, otherwise the SQL
aborts (wrong database, or the previous import was never applied).
`credentials.csv` holds ONLY the accounts that are new in this workbook; keep
using the previous credentials file for the others. A new student who already
signed in through NJE SSO (ePPN <neptun>@{'/'.join(scopes)}) keeps that account;
the credentials CSV row then does not apply (listed in the SQL output).

Sync rules — nothing is ever deleted:
- A workbook enrollment missing from this workbook becomes `dropped`
  (ext_source `nje-workbook-dropped`), and is reactivated if it returns later.
  An enrollment dropped by an admin stays dropped and is listed.
  More than {args.max_drop_pct}% dropped aborts (guards against a truncated export).
- Course fields, teacher assignments, student names/attributes and teacher
  names change only where the database still holds the previous workbook's
  value. Portal edits are kept and listed as conflicts.
- Courses gone from the workbook keep their record; headcount becomes 0 so
  ECHO eligibility excludes them.
- Existing campaign eligibility is not rebuilt; rebuild it for the term
  (only if the campaign is not yet open) to pick up the changes.
"""
    (args.output / "README.md").write_text(f"""# NJE enrollment import

Source: {args.workbook.name}

{len(students):,} students, {len(teachers):,} distinct teacher names, {len(courses):,} courses,
{len(enrollments):,} enrollments, {len(teacher_links):,} teacher assignments.
{sync_text}
Run `import.sql` as the database owner with psql against UniPortal with the
repository migrations applied (including 38, 43, 44, 54, 68). It is a PREVIEW by
default: it prints its results and rolls back. Take a backup, then apply:

```sh
psql -v ON_ERROR_STOP=1 -f import.sql              # preview, rolls back
psql -v ON_ERROR_STOP=1 -v apply=1 -f import.sql   # commits
```

The transaction either completes in full or rolls back. The result lists
expected and actual counts, newly created and reused accounts, and every
change or conflict. Keep this file out of migration manifests.

New accounts are approved and email-confirmed with unique bcrypt-hashed passwords.
`credentials.csv` holds their initial passwords. Addresses ending in `.invalid` are
placeholder login names, not mailboxes. Password-reset email cannot reach them.
Change passwords after handover; the app does not enforce first-login changes.

Existing accounts are resolved by placeholder email, student Neptun code, student
SSO ePPN, or an exact case-insensitive teacher name match with an existing linked
profile. Ambiguous matches, incompatible roles and rejected/pending existing accounts
abort the import. Existing passwords, emails, roles, and approvals are preserved.
Rerunning the SAME SQL file adds no duplicates and does not reset passwords. Keep
the original credentials CSV: regeneration creates different initial passwords.

Teachers have no source IDs: one record per distinct name is an explicit assumption
(spelling changes are mapped in TEACHER_ALIASES in tools/nje_import.py).
Identical names may represent different people; title/spelling variants remain separate.
Review those identities before distributing credentials.

`review.csv` records missing teachers, multi-teacher courses, subject aliases, source
headcount differences, courses marked not starting, student attribute variants,
and courses/teachers gone from the source. Multi-teacher assignments use 0% because
the workbook provides no teaching-hour shares; enter actual shares before building
ECHO evaluations. A sole listed teacher uses 100%. Missing teachers are not invented.

`student-programs.csv` preserves every student attribute combination. The app supports
one student_attributes row per person, so the most frequent combination is selected.
Source subject aliases and timetable text are preserved in course descriptions.
Organization names are stored as their source codes because the workbook contains no
organization names; teacher departments are left unspecified. No admission
applications or fake studentId links are created.

These files contain personal data and passwords. They are excluded from git.
The generator creates files only; no live database has been changed.
""", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Output: {args.output.resolve()}")


if __name__ == "__main__":
    main()
