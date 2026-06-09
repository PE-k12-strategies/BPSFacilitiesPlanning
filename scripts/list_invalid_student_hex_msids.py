"""
List raw MSID values from StudentHexagons features that are invalid for indexing
(missing, non-numeric, or NaN). Run against the repo GeoJSON (one feature per student):

  py -3 scripts/list_invalid_student_hex_msids.py geo/StudentHexagons.geojson

Prints counts and unique raw values to stdout. Optional JSON output:

  py -3 scripts/list_invalid_student_hex_msids.py in.geojson --json out.json
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter


def raw_msid_invalid(raw) -> bool:
    if raw is None:
        return True
    try:
        msid = float(raw)
    except (TypeError, ValueError):
        return True
    return msid != msid


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input_path", help="GeoJSON path (full student-level export)")
    p.add_argument("--json", metavar="PATH", help="Write summary JSON")
    args = p.parse_args()

    with open(args.input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    feats = data.get("features") or []
    invalid_rows = []
    for feat in feats:
        raw = (feat.get("properties") or {}).get("MSID")
        if raw_msid_invalid(raw):
            invalid_rows.append(raw)

    ctr = Counter()
    for r in invalid_rows:
        key = "__none__" if r is None else str(r)
        ctr[key] += 1

    print(f"invalid_feature_count: {len(invalid_rows)}")
    print(f"unique_raw_msid_values: {len(ctr)}")
    for val, n in sorted(ctr.items(), key=lambda x: (-x[1], x[0])):
        display = "(null)" if val == "__none__" else val
        print(f"  {n:5d}  {display}")

    if args.json:
        out = {
            "invalid_feature_count": len(invalid_rows),
            "unique_values": [
                {"raw_msid": None if k == "__none__" else k, "count": v}
                for k, v in sorted(ctr.items(), key=lambda x: (-x[1], x[0]))
            ],
        }
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        print(f"wrote {args.json}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
