"""
Split data/school_master.csv into opaque JSON shards for the public dashboard.

The live site serves shards + an index (not a single CSV). Regenerate after
updating school_master.csv:

  py -3 scripts/export_school_master_shards.py
"""
from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = ROOT / "data" / "school_master.csv"
OUT_DIR = ROOT / "data" / "processed" / "school_master_d"
INDEX_PATH = ROOT / "data" / "processed" / "school_master_index.json"
NUM_SHARDS = 8


def read_rows(csv_path: Path) -> tuple[list[str], list[dict[str, str]]]:
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        headers = list(reader.fieldnames or [])
        rows = []
        for row in reader:
            obj = {h: (row.get(h) or "").strip() for h in headers}
            if not obj.get("msid"):
                continue
            rows.append(obj)
        return headers, rows


def shard_filename(shard_index: int) -> str:
    digest = hashlib.sha256(f"bps-school-master-shard-{shard_index}-v1".encode()).hexdigest()
    return digest[:12] + ".json"


def main() -> None:
    if not CSV_PATH.is_file():
        raise SystemExit(f"Missing {CSV_PATH}")

    _, rows = read_rows(CSV_PATH)
    if not rows:
        raise SystemExit("school_master.csv has no data rows")

    buckets: list[list[dict[str, str]]] = [[] for _ in range(NUM_SHARDS)]
    for i, row in enumerate(rows):
        buckets[i % NUM_SHARDS].append(row)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.json"):
        old.unlink()

    shard_paths: list[str] = []
    for i, bucket in enumerate(buckets):
        if not bucket:
            continue
        payload: dict[str, dict[str, str]] = {}
        for row in bucket:
            msid_raw = row["msid"]
            try:
                msid_num = int(str(msid_raw).strip())
            except ValueError:
                continue
            msid_padded = f"{msid_num:04d}"
            row_out = dict(row)
            row_out["msid"] = msid_padded
            payload[str(msid_num)] = row_out

        name = shard_filename(i)
        rel = f"data/processed/school_master_d/{name}"
        (OUT_DIR / name).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        shard_paths.append(rel)

    INDEX_PATH.write_text(
        json.dumps({"v": 1, "shards": shard_paths}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {len(shard_paths)} shards and {INDEX_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
