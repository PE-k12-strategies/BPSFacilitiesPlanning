"""
Replace school display names in the K-12 feeder CSV with MSIDs from school_master.csv.
Preserves cell layout; multiple schools get comma-separated MSIDs where names were adjacent.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MASTER_PATH = ROOT / "data" / "school_master.csv"
FEEDER_DEFAULT = ROOT / "data" / "sourcedocs" / "k12_feeder_plan_2026_2027_revised_2026_04_07.csv"


def norm_key(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().upper())


def load_master_rows() -> list[dict]:
    with MASTER_PATH.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def build_replacement_pairs(rows: list[dict]) -> list[tuple[str, str]]:
    """Ordered list (phrase, msid), longest phrases first — phrase uses spaces (single)."""
    seen: set[str] = set()
    pairs: list[tuple[str, str]] = []

    def add_phrase(phrase: str, msid: str) -> None:
        p = phrase.strip()
        if not p or norm_key(p) == "N/A":
            return
        k = norm_key(p)
        if k in seen:
            return
        seen.add(k)
        pairs.append((p, msid))

    for row in rows:
        raw = (row.get("msid") or "").strip()
        if not raw.isdigit():
            continue
        msid = str(int(raw))
        nu = (row.get("school_name") or "").strip()
        if not nu:
            continue
        u = nu.upper()

        add_phrase(nu, msid)

        if "ELEMENTARY SCHOOL" in u:
            add_phrase(
                re.sub(r"\s+ELEMENTARY(?:\s+MAGNET)?\s+SCHOOL\s*$", " ES", u, flags=re.I).strip(),
                msid,
            )
        if u.endswith(" MAGNET MIDDLE SCHOOL"):
            add_phrase(re.sub(r"\s+MAGNET\s+MIDDLE\s+SCHOOL\s*$", " MS", u, flags=re.I).strip(), msid)
        elif u.endswith(" MIDDLE SCHOOL"):
            add_phrase(re.sub(r"\s+MIDDLE\s+SCHOOL\s*$", " MS", u, flags=re.I).strip(), msid)
        if u.endswith(" MAGNET SENIOR HIGH SCHOOL"):
            add_phrase(
                re.sub(r"\s+MAGNET\s+SENIOR\s+HIGH\s+SCHOOL\s*$", " Magnet HS", u, flags=re.I).strip(),
                msid,
            )
        elif u.endswith(" SENIOR HIGH SCHOOL"):
            add_phrase(re.sub(r"\s+SENIOR\s+HIGH\s+SCHOOL\s*$", " HS", u, flags=re.I).strip(), msid)
        elif u.endswith(" HIGH SCHOOL"):
            add_phrase(re.sub(r"\s+HIGH\s+SCHOOL\s*$", " HS", u, flags=re.I).strip(), msid)
        if "JR/SR HIGH SCHOOL" in u or "JR SR HIGH SCHOOL" in u:
            add_phrase(
                re.sub(r"\s+JR\s*/?\s*SR\s+HIGH\s+SCHOOL\s*$", " Jr/Sr HS", u, flags=re.I).strip(),
                msid,
            )

        if "HANS CHRISTIAN ANDERSEN" in u:
            add_phrase("Andersen ES", msid)
        if "DR. W.J. CREEL" in u or "DR W.J. CREEL" in u:
            add_phrase("Dr. WJ Creel ES", msid)
            add_phrase("Dr. W.J. Creel ES", msid)
        if "LEWIS CARROLL" in u:
            add_phrase("Lewis Carroll ES", msid)
        if "THEODORE ROOSEVELT" in u:
            add_phrase("Roosevelt ES", msid)

    # Manual feeder / PDF forms (after auto so shorter forms can extend).
    # Include common PDF abbreviations not produced by shortening full legal names (e.g. Williams ES).
    manual = [
        ("Gardendale Separate Day School", "89"),
        ("Gardendale Elementary Magnet", "4101"),
        ("Gardendale ES", "89"),
        ("Gardendale", "89"),
        ("U Park", "2051"),
        ("University Park ES", "2051"),
        ("Port Malabar ES", "2061"),
        ("Merritt Island ES", "4031"),
        ("Space Coast Jr/Sr HS", "302"),
        ("Space Coast Jr/Sr", "302"),
        ("Space Coast Jr./Sr. HS", "302"),
        ("Space Coast", "302"),
        ("Palm Bay Magnet HS", "2021"),
        ("Kennedy MS Space Coast Jr/Sr HS", "1101, 302"),
        ("Kennedy MS Space Coast", "1101, 302"),
        ("Kennedy MS Rockledge HS", "1101, 1011"),
        ("Kennedy MS", "1101"),
        ("Kennedy ES", "1101"),
        ("Johnson MS", "3031"),
        ("Johnson ES", "3031"),
        ("Jefferson MS", "4111"),
        ("Jackson MS", "141"),
        ("Madison MS", "52"),
        ("Hoover MS", "6082"),
        ("McNair MS", "1081"),
        ("Williams ES", "1151"),
        ("Imperial ES", "151"),
        ("Golfview ES", "1071"),
        ("Cambridge ES", "1041"),
        ("Turner ES", "2121"),
        ("McAuliffe ES", "2161"),
        ("Holland ES", "6013"),
        ("Merritt Island HS", "4011"),
        ("Titusville HS", "11"),
        ("Eau Gallie ES", "3011"),
        ("Astronaut ES", "161"),
        ("Cocoa Jr/Sr HS", "1121"),
        ("Cocoa Jr/Sr", "1121"),
        ("Meadowlane Pri. (K-2)\nMeadowlane Int. (3-6)", "2041, 2031"),
        ("Meadowlane Pri. (K-2)", "2041"),
        ("Meadowlane Int. (3-6)", "2031"),
        ("Meadowlane Prim. (K-2)", "2041"),
        ("Meadowlane Pri. ES", "2041"),
        ("Meadowlane Int. ES", "2031"),
        ("Enterprise (N of 528)\nGolfview (S of 528)", "301, 1071"),
        ("Enterprise (N of 528)", "301"),
        ("Golfview (S of 528)", "1071"),
        ("Central MS", "3021"),
        ("DeLaura MS", "6012"),
        ("Delaura MS", "6012"),
        ("Viera MS", "3171"),
        ("Port Malabar HS", "2061"),
        ("Cocoa HS Viera HS", "1121, 1171"),
        ("Eau Gallie Bayside\nHeritage (Closest to\nhome address)", "3011, 2211, 2311"),
        ("Eau Gallie Bayside\nHeritage", "3011, 2211, 2311"),
        ("Bayside HS", "2211"),
        ("Heritage HS", "2311"),
        ("Heritage High", "2311"),
        ("Titusville HS", "11"),
        ("Cocoa HS", "1121"),
        ("Viera HS", "1171"),
        ("Eau Gallie HS", "3011"),
        ("Rockledge HS", "1011"),
        ("Satellite HS", "6011"),
        ("Melbourne HS", "2011"),
    ]
    for ph, mid in manual:
        add_phrase(ph, mid)

    pairs.sort(key=lambda x: len(x[0]), reverse=True)
    return pairs


def phrase_to_pattern(phrase: str) -> str:
    """Whitespace-tolerant: Dr. WJ matches Dr.  WJ with extra spaces."""
    parts = phrase.split()
    return r"\s+".join(re.escape(p) for p in parts)


def normalize_msid_list_format(s: str) -> str:
    """Comma-separate adjacent MSIDs that appear on separate lines (Excel export)."""
    t = s
    changed = True
    while changed:
        changed = False
        u = re.sub(r"(\d{2,5})\s*[\n\r]+\s*(\d{2,5})", r"\1, \2", t)
        if u != t:
            changed = True
            t = u
    return t


def replace_cell(text: str, pairs: list[tuple[str, str]]) -> str:
    if not text.strip():
        return text
    s = text
    for phrase, msid in pairs:
        pat = phrase_to_pattern(phrase)
        s = re.sub(pat, msid, s, flags=re.IGNORECASE)
    # two MSIDs jammed by PDF / spacing
    s = re.sub(r"(\d{2,5})\s+(\d{2,5})(?=[,\s\n]|$)", r"\1, \2", s)
    s = normalize_msid_list_format(s)
    return s.strip()


def should_skip_cell(raw: str) -> bool:
    t = raw.strip()
    if not t:
        return True
    if norm_key(t) == "N/A":
        return True
    if t.startswith("*"):
        return True
    return False


def main() -> int:
    feeder_path = Path(sys.argv[1]) if len(sys.argv) > 1 else FEEDER_DEFAULT
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else feeder_path

    pairs = build_replacement_pairs(load_master_rows())

    with feeder_path.open(encoding="utf-8", newline="") as f:
        grid = list(csv.reader(f))

    header_i = 0
    for idx, row in enumerate(grid):
        if row and row[0].strip().lower() == "school":
            header_i = idx
            break

    new_grid: list[list[str]] = []
    for ri, row in enumerate(grid):
        if ri <= header_i:
            new_grid.append(row)
            continue
        new_row = []
        for ci, cell in enumerate(row):
            if should_skip_cell(cell):
                new_row.append(cell)
            else:
                new_row.append(replace_cell(cell, pairs))
        new_grid.append(new_row)

    with out_path.open("w", encoding="utf-8", newline="") as f:
        csv.writer(f, quoting=csv.QUOTE_MINIMAL).writerows(new_grid)

    log = out_path.with_suffix(".msid_review.txt")
    hints = []
    token_like = re.compile(
        r"\b(?:[A-Z][a-z]+\s+){1,6}(?:ES|MS|HS|Jr/Sr\s+HS)\b|\b[A-Z][a-z]+\s+Magnet\s+HS\b",
        re.I,
    )
    for row in new_grid[header_i + 1 :]:
        for c in row:
            if not c or should_skip_cell(c):
                continue
            if token_like.search(c) and not re.search(r"\d{3,5}", c):
                hints.append(c[:200])

    with log.open("w", encoding="utf-8") as lf:
        lf.write("Samples of cells that may still contain name-like tokens (review):\n\n")
        for h in hints[:100]:
            lf.write(h + "\n---\n")

    print("Wrote", out_path)
    print("Review log", log, "hints", len(hints))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
