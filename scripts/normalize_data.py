"""
Merge heterogeneous CSV backups into canonical public/data/schools.json.

Place source files in data/raw/ (see README). If no recognized CSVs are found,
writes demo canonical data to data/processed/schools.json and public/data/schools.json.

Run: py scripts/normalize_data.py
"""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PROCESSED = ROOT / "data" / "processed"
PUBLIC_DATA = ROOT / "public" / "data"
DEMO_SOURCE = PUBLIC_DATA / "schools.json"


def write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)


def try_merge_csvs() -> dict | None:
    """
    Extend this function with real district column mappings.
    Expected patterns (examples):
    - enrollment_*.csv: SchoolID, SchoolName, Level, Enrollment
    - demographics_*.csv: SchoolID, ELL_Pct, SWD_Pct, FRL_Pct
    """
    if not RAW.is_dir():
        return None

    csv_files = list(RAW.glob("*.csv"))
    if not csv_files:
        return None

    by_id: dict[str, dict] = {}

    for path in csv_files:
        with path.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            if not reader.fieldnames:
                continue
            lower = {k.lower().strip(): k for k in reader.fieldnames}
            sid_key = next(
                (
                    lower[k]
                    for k in ("school_id", "schoolid", "nces_id", "id")
                    if k in lower
                ),
                None,
            )
            if not sid_key:
                continue
            for row in reader:
                sid = (row.get(sid_key) or "").strip()
                if not sid:
                    continue
                rec = by_id.setdefault(sid, {"id": sid})
                if "schoolname" in lower:
                    rec["name"] = row[lower["schoolname"]].strip()
                elif "name" in lower:
                    rec["name"] = row[lower["name"]].strip()
                if "enrollment" in lower and row.get(lower["enrollment"]):
                    try:
                        rec["enrollment"] = int(float(row[lower["enrollment"]]))
                    except ValueError:
                        pass

    if not by_id:
        return None

    return {
        "schemaVersion": "1.0",
        "districtName": "Merged from CSV (update districtName)",
        "mapCenter": [-73.948, 40.648],
        "mapZoom": 12,
        "schools": list(by_id.values()),
        "flowsElemToMiddle": [],
        "flowsMiddleToHigh": [],
    }


def main() -> None:
    merged = try_merge_csvs()
    if merged is None:
        if DEMO_SOURCE.is_file():
            data = json.loads(DEMO_SOURCE.read_text(encoding="utf-8"))
        else:
            raise SystemExit("No demo schools.json and no CSVs to merge.")
        print("No mergeable CSVs in data/raw — using demo canonical dataset.")
    else:
        data = merged
        print(f"Merged {len(data.get('schools', []))} school rows from CSV.")

    write_json(PROCESSED / "schools.json", data)
    write_json(PUBLIC_DATA / "schools.json", data)
    print(f"Wrote {PROCESSED / 'schools.json'}")
    print(f"Wrote {PUBLIC_DATA / 'schools.json'}")


if __name__ == "__main__":
    main()
