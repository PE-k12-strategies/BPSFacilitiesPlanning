"""
Read SchoolGrades25.xlsx (column C = "School Number" / MSID, column V = "Grade 2025"),
merge into data/school_master.csv as school_grade_2025.

Rows with no valid grade for that MSID → CSV value "N/A".
Empty / "-" / "N/A" cells are treated as no grade.

Requires: pip install openpyxl
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("Install openpyxl: pip install openpyxl", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "data" / "school_master.csv"
DEFAULT_XLSX = Path(
    r"P:\0109260\Planning\WorkingFiles\03_Client Data & Resources\04_Student & Program Data\05_Academic Achievement Data\SchoolGrades25.xlsx"
)

NEW_COL = "school_grade_2025"
INSERT_AFTER = "last_major_renovation_year"

VALID_GRADES = {"A", "B", "C", "D", "F"}


def parse_msid_cell(d) -> int | None:
    if d is None:
        return None
    s = str(d).strip().replace(".0", "")
    if not s:
        return None
    try:
        return int(s.lstrip("0") or "0")
    except ValueError:
        return None


def parse_grade_cell(cell) -> str | None:
    if cell is None:
        return None
    s = str(cell).strip().upper()
    if not s or s in {"-", "N/A", "NA", "NONE", "0"}:
        return None
    s = s[:1]
    return s if s in VALID_GRADES else None


def grade_by_msid(xlsx_path: Path) -> dict[int, str]:
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    out: dict[int, str] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or len(row) < 22:
            continue
        mid = parse_msid_cell(row[2])
        if mid is None or mid == 0:
            continue
        g = parse_grade_cell(row[21])
        if g is None:
            continue
        # Keep first grade seen for a given MSID (xlsx is typically one row per school).
        if mid not in out:
            out[mid] = g
    wb.close()
    return out


def row_msid(cell0: str) -> int | None:
    try:
        return int(str(cell0).strip().lstrip("0") or "0")
    except ValueError:
        return None


def merge_into_school_master(csv_path: Path, by_msid: dict[int, str]) -> None:
    with csv_path.open(newline="", encoding="utf-8") as f:
        rows = list(csv.reader(f))
    if not rows:
        raise SystemExit("empty csv")
    header = rows[0]

    if NEW_COL in header:
        idx = header.index(NEW_COL)
        for i in range(1, len(rows)):
            row = rows[i]
            if len(row) <= idx:
                continue
            m = row_msid(row[0])
            if m is None:
                continue
            val = by_msid.get(m)
            row[idx] = val if val is not None else "N/A"
    else:
        try:
            j = header.index(INSERT_AFTER)
        except ValueError as e:
            raise SystemExit(f"missing column {INSERT_AFTER}") from e
        idx = j + 1
        header = header[:idx] + [NEW_COL] + header[idx:]
        rows[0] = header
        for i in range(1, len(rows)):
            row = rows[i]
            m = row_msid(row[0]) if row else None
            if m is None:
                continue
            val = by_msid.get(m)
            cell = val if val is not None else "N/A"
            rows[i] = row[:idx] + [cell] + row[idx:]

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerows(rows)


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"Missing xlsx: {xlsx}", file=sys.stderr)
        sys.exit(1)
    by_msid = grade_by_msid(xlsx)
    print(f"Loaded 2025 school grade for {len(by_msid)} MSIDs from {xlsx.name}")
    merge_into_school_master(CSV_PATH, by_msid)
    print(f"Updated {CSV_PATH}")


if __name__ == "__main__":
    main()
