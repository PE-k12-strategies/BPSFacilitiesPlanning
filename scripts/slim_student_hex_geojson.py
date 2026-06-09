"""
Legacy: aggregate StudentHexagons.geojson to one Feature per (GRID_ID, MSID) with a count.

The dashboard now expects one GeoJSON feature per student (attendance MSID, GRID_ID, and
per-student attributes). Do not run this on the current workflow unless you intentionally
want a smaller file and accept losing per-student Grade / zoned-school fields.

Historical usage (not recommended for current data):

  py -3 scripts/slim_student_hex_geojson.py geo/StudentHexagons.geojson geo/StudentHexagons_slim.geojson
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from typing import Any


def round_coords(obj: Any, ndigits: int) -> Any:
    if isinstance(obj, float):
        return round(obj, ndigits)
    if isinstance(obj, list):
        return [round_coords(x, ndigits) for x in obj]
    return obj


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input_path", help="Source GeoJSON path")
    p.add_argument("output_path", help="Output GeoJSON path")
    p.add_argument(
        "--precision",
        type=int,
        default=6,
        help="Decimal places for coordinates (default 6)",
    )
    args = p.parse_args()

    with open(args.input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        print("error: expected a GeoJSON FeatureCollection", file=sys.stderr)
        return 1

    # (GRID_ID, msid_key) -> { count, geometry, msid_val }
    buckets: dict[tuple[Any, str], dict[str, Any]] = {}
    skipped_no_msid = 0
    skipped_no_grid = 0

    for feat in data["features"]:
        props = feat.get("properties") or {}
        grid = props.get("GRID_ID")
        if grid is None or grid == "":
            skipped_no_grid += 1
            continue
        raw_msid = props.get("MSID")
        if raw_msid is None:
            skipped_no_msid += 1
            continue
        try:
            msid = float(raw_msid)
        except (TypeError, ValueError):
            skipped_no_msid += 1
            continue
        if msid != msid:  # NaN
            skipped_no_msid += 1
            continue
        msid_key = str(int(msid)) if msid == int(msid) else str(msid)
        key = (grid, msid_key)
        geom = feat.get("geometry")
        if not geom:
            continue
        if key not in buckets:
            buckets[key] = {"count": 0, "geometry": geom, "msid_val": int(msid) if msid == int(msid) else msid}
        buckets[key]["count"] += 1

    out_features = []
    for (grid, _msid_key), bucket in buckets.items():
        geom = round_coords(bucket["geometry"], args.precision)
        out_features.append(
            {
                "type": "Feature",
                "properties": {
                    "MSID": bucket["msid_val"],
                    "GRID_ID": grid,
                    "count": bucket["count"],
                },
                "geometry": geom,
            }
        )

    out = {"type": "FeatureCollection", "features": out_features}

    with open(args.output_path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))

    mb_in = __import__("os").path.getsize(args.input_path) / (1024 * 1024)
    mb_out = __import__("os").path.getsize(args.output_path) / (1024 * 1024)
    print(
        f"features: {len(data['features'])} -> {len(out_features)} "
        f"(skipped no GRID_ID: {skipped_no_grid}, skipped bad MSID: {skipped_no_msid})"
    )
    print(f"size: {mb_in:.2f} MB -> {mb_out:.2f} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
