"""
One-time / optional: read District Flat File Report.xlsx (column D = MSID,
AO = Building Year Modified, AQ = Room Year Modified), compute per row
max(AO, AQ), then max across rows per MSID, merge into data/school_master.csv
as last_major_renovation_year.

Rows with no valid year in AO or AQ for that MSID → CSV value "N/A".
Values of 0 are treated as empty (not a renovation year).

Requires: pip install openpyxl
"""
from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

try:
    import openpyxl
except ImportError:
    print("Install openpyxl: pip install openpyxl", file=sys.stderr)
    raise

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "data" / "school_master.csv"
# Default path from project brief; override with argv[1]
DEFAULT_XLSX = Path(
    r"P:\0109260\Planning\WorkingFiles\03_Client Data & Resources\03_Facility & Site Data\05_Capacities & Room Use\260323 District Flat File Report.xlsx"
)

NEW_COL = "last_major_renovation_year"
INSERT_AFTER = "age_of_site_2026"


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


def parse_year_cell(cell) -> int | None:
    if cell is None or cell == "" or cell == 0 or cell == "0":
        return None
    if isinstance(cell, (int, float)):
        y = int(cell)
        if 1900 <= y <= 2100:
            return y
        return None
    if hasattr(cell, "year"):
        y = cell.year
        return y if 1900 <= y <= 2100 else None
    if isinstance(cell, str):
        s = re.sub(r"\.0$", "", cell.strip())
        if s.isdigit():
            y = int(s)
            return y if 1900 <= y <= 2100 else None
    return None


def max_renovation_year_by_msid(xlsx_path: Path) -> dict[int, int]:
    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb.active
    best: dict[int, int] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        if not row or len(row) < 43:
            continue
        mid = parse_msid_cell(row[3])
        if mid is None or mid == 0:
            continue
        y_ao = parse_year_cell(row[40])
        y_aq = parse_year_cell(row[42])
        candidates = [y for y in (y_ao, y_aq) if y is not None]
        if not candidates:
            continue
        y = max(candidates)
        if mid not in best or y > best[mid]:
            best[mid] = y
    wb.close()
    return best


def row_msid(cell0: str) -> int | None:
    try:
        return int(str(cell0).strip().lstrip("0") or "0")
    except ValueError:
        return None


def merge_into_school_master(csv_path: Path, by_msid: dict[int, int]) -> None:
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
            row[idx] = str(val) if val is not None else "N/A"
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
            cell = str(val) if val is not None else "N/A"
            rows[i] = row[:idx] + [cell] + row[idx:]

    with csv_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerows(rows)


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"Missing xlsx: {xlsx}", file=sys.stderr)
        sys.exit(1)
    by_msid = max_renovation_year_by_msid(xlsx)
    print(f"Loaded max renovation year for {len(by_msid)} MSIDs from {xlsx.name}")
    merge_into_school_master(CSV_PATH, by_msid)
    print(f"Updated {CSV_PATH}")


if __name__ == "__main__":
    main()
