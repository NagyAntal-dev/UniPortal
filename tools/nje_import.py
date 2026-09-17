"""Generate a private, transactional Supabase SQL import from the NJE workbook.

Usage: python tools/nje_import.py "NJE ...xlsx"
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", type=Path)
    parser.add_argument("--output", type=Path, default=Path("private-imports/nje-2026-27-1"))
    args = parser.parse_args()
    # Never silently replace a credentials file: reruns retain database passwords.
    if args.output.exists():
        parser.error("Output directory already exists; choose a new --output directory")
    students, courses, enrollments, row_count = prepare(args.workbook)
    teacher_names = sorted({n.strip() for rows in courses.values() for row in rows
                            for n in row[22].split(",") if n.strip()})
    teachers = {name: "NJE-T-" + hashlib.sha256(name.casefold().encode()).hexdigest()[:16]
                for name in teacher_names}
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
    # Hash locally, so importing thousands of users does not spend minutes in
    # the SQL Editor computing bcrypt. Passwords never appear in the SQL file.
    passwords = ["Nje!" + secrets.token_urlsafe(18) for _ in accounts]
    def password_hash(password):
        return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    print(f"Hashing {len(accounts)} unique account passwords...", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        hashes = list(pool.map(password_hash, passwords))
    account_rows = [a + [h] for a, h in zip(accounts, hashes)]
    summary = dict(source=args.workbook.name, source_sha256=hashlib.sha256(args.workbook.read_bytes()).hexdigest(),
                   source_rows=row_count, students=len(students), teachers=len(teachers),
                   accounts=len(accounts), courses=len(courses), enrollments=len(enrollments),
                   duplicate_enrollment_rows=row_count - len(enrollments), teacher_assignments=len(teacher_links),
                   organizations=len(orgs), review_counts=dict(collections.Counter(r[0] for r in review)))
    template = Path(__file__).with_name("nje_import.sql.in").read_text(encoding="utf-8")
    data = "\n".join([
        *inserts("nje_accounts", "key,role,code,name,email,password_hash", account_rows),
        *inserts("nje_attributes", "key,neptun,tagozat,kepzesi_szint,szak,kar,szak_kod,nyelv,telephely", attributes),
        *inserts("nje_orgs", "code", [[o] for o in orgs]),
        *inserts("nje_courses", "term,code,name_hu,name_en,lang,org_code,letszam,van_orarendi_info,vizsgakurzus,leiras", course_rows),
        *inserts("nje_teachers", "code,name,key", [[code, name, "T:" + code] for name, code in teachers.items()]),
        *inserts("nje_links", "term,course_code,teacher_code,share_pct", teacher_links),
        *inserts("nje_enrollments", "term,course_code,key", [[t, c, "S:" + s] for t, c, s in sorted(enrollments)])])
    sql = template.replace("-- INSERT_WORKBOOK_DATA", data)
    args.output.mkdir(parents=True)
    (args.output / "import.sql").write_text(sql, encoding="utf-8")
    csv_file(args.output / "credentials.csv", ["import_key", "role", "source_code", "name", "placeholder_login", "initial_password"],
             [a + [p] for a, p in zip(accounts, passwords)])
    csv_file(args.output / "review.csv", ["issue", "source_code", "term_or_count", "details"], review)
    csv_file(args.output / "student-programs.csv", ["neptun", "name", "selected", "enrollment_rows",
             "tagozat", "kepzesi_szint", "szak", "kar", "szak_kod", "nyelv", "telephely"], student_variants)
    (args.output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    (args.output / "README.md").write_text(f"""# NJE enrollment import

Source: {args.workbook.name}

{len(students):,} students, {len(teachers):,} distinct teacher names, {len(courses):,} courses,
{len(enrollments):,} enrollments, {len(teacher_links):,} teacher assignments.

Run `import.sql` as the database owner against UniPortal with the repository migrations
applied (including 38, 43, 44, 54, 68). In Supabase SQL Editor, paste the entire file
and run it. For a large file, use psql:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f import.sql
```

The transaction either completes in full or rolls back. For a preview, replace the
final `commit;` with `rollback;` in a copy. The final result lists expected and actual
counts plus newly created and reused accounts. Keep this file out of migration manifests.

New accounts are approved and email-confirmed with unique bcrypt-hashed passwords.
`credentials.csv` holds their initial passwords. Addresses ending in `.invalid` are
placeholder login names, not mailboxes. Password-reset email cannot reach them.
Change passwords after handover; the app does not enforce first-login changes.

Existing accounts are resolved by placeholder email, student Neptun code, or an
exact case-insensitive teacher name match with an existing linked profile. Ambiguous
matches, incompatible roles and rejected/pending existing accounts abort the import.
Existing passwords, emails, roles, and approvals are preserved. For reused accounts,
the CSV's placeholder login/password do NOT replace their existing credentials.
Rerunning the SAME SQL file adds no duplicates and does not reset passwords. Keep
the original credentials CSV: regeneration creates different initial passwords.

Teachers have no source IDs: one record per distinct name is an explicit assumption.
Identical names may represent different people; title/spelling variants remain separate.
Review those identities before distributing credentials.

`review.csv` records missing teachers, multi-teacher courses, subject aliases, source
headcount differences, courses marked not starting, and student attribute variants.
Multi-teacher assignments use 0% because the workbook provides no teaching-hour
shares; enter actual shares before building ECHO evaluations. A sole listed teacher
uses 100%. Missing teachers are not invented. All source enrollments are retained.
Existing course metadata and teaching shares are preserved when records already exist.

`student-programs.csv` preserves every student attribute combination. The app supports
one student_attributes row per person, so the most frequent combination is selected
for new rows. Existing nonblank attributes are not replaced. Source subject aliases
and timetable text are preserved in new courses' descriptions. Organization names
are stored as their source codes because the workbook contains no organization names;
teacher departments are left unspecified. No admission applications or fake studentId
links are created: course memberships reference the actual portal profiles directly.

These files contain personal data and passwords. They are excluded from git.
The generator creates files only; no live database has been changed.
""", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"Output: {args.output.resolve()}")


if __name__ == "__main__":
    main()
