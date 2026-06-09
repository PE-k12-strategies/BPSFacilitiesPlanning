"""
One-time / optional regeneration of data/school_master.csv from legacy JSON exports.
The dashboard reads data/school_master.csv as the sole source of tabular stats.

    Grades served (grades_served column): When editing the CSV in Excel, format that column
    as Text before typing ranges like 9-12 or 7-8, or Excel may convert them to dates and
    save as "12-Sep", "8-Jul", etc. Alternatively use a Unicode en dash between numbers
    (e.g. 9–12) which is usually left as text. The dashboard also normalizes common
    mis-exports in normalizeGradesServedForUi (app.js).

    last_major_renovation_year is not produced by this script by default; run
    scripts/merge_last_major_renovation_from_flatfile.py after build to populate from the
    district flat file (or leave blank / merge manually).
"""
from __future__ import annotations

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "school_master.csv"

ETH_SLUGS = [
    ("Hawaiian Native/Pacific Islander", "eth_hawaiian_native_pacific_islander"),
    ("Asian", "eth_asian"),
    ("Black, Non-Hispanic", "eth_black_non_hispanic"),
    ("Hispanic", "eth_hispanic"),
    ("Amer. Indian or Alaskan Native", "eth_amer_indian_or_alaskan_native"),
    ("Multi-Racial", "eth_multi_racial"),
    ("White, Non-Hispanic", "eth_white_non_hispanic"),
]

LUNCH_SLUGS = [
    ("Not free/reduced", "lunch_not_free_reduced"),
    ("Free", "lunch_free"),
    ("Reduced", "lunch_reduced"),
]

CAL_YEARS = list(range(2017, 2026))
PROJ_LABELS = ["2026-27", "2027-28", "2028-29", "2029-30", "2030-31"]


def load_msid_lookup(path: Path) -> dict[int, str]:
    """Authoritative school names from MSID_Lookup.csv (School, Name, Active)."""
    if not path.exists():
        return {}
    out: dict[int, str] = {}
    with path.open(newline="", encoding="utf-8-sig") as f:
        r = csv.DictReader(f)
        for row in r:
            s = (row.get("School") or "").strip()
            name = (row.get("Name") or "").strip()
            if not s or not name:
                continue
            try:
                out[int(s)] = name
            except ValueError:
                pass
    return out


def normalize_school_name_key(s: str) -> str:
    if not s:
        return ""
    t = str(s).upper().replace("/", " ")
    t = re.sub(r"[.'\u2019]", " ", t)
    t = t.replace(",", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def facility_row_for_props(by_name: dict, name: str, common: str):
    if not by_name:
        return None
    n = normalize_school_name_key(name or "")
    keys = [n, normalize_school_name_key(common or "")]
    if n and "JR SR" in n and "HIGH" not in n:
        keys.append(n + " HIGH")
    for k in keys:
        if k and k in by_name:
            return by_name[k]
    return None


def type_to_level(type_str: str) -> str:
    t = (type_str or "").upper()
    if "ELEMENTARY" in t:
        return "elementary"
    if "MIDDLE" in t and "HIGH" not in t:
        return "middle"
    if t == "JR SR HIGH" or ("HIGH" in t and "MIDDLE" not in t):
        return "jr_sr_high" if t == "JR SR HIGH" else "high"
    return "middle"


def out_num(v):
    """Write enrollment / demographic counts: empty only when missing; keep 0 as 0."""
    if v is None:
        return ""
    return v


def main():
    ms_lookup = load_msid_lookup(ROOT / "MSID_Lookup.csv")

    enrollment = json.loads((ROOT / "data" / "processed" / "enrollment.json").read_text(encoding="utf-8"))
    demo = json.loads((ROOT / "data" / "processed" / "demographics_by_msid.json").read_text(encoding="utf-8"))
    capture = json.loads((ROOT / "data" / "processed" / "capture_by_msid.json").read_text(encoding="utf-8"))
    facility = json.loads((ROOT / "data" / "processed" / "facility_age.json").read_text(encoding="utf-8"))
    schools = json.loads((ROOT / "geo" / "SchoolLocations.json").read_text(encoding="utf-8"))

    by_name = facility.get("byNameKey") or {}
    cap_by = capture.get("byMsid") or {}
    demo_by = demo.get("byMsid") or {}
    en_by = enrollment.get("byMsid") or {}
    cal_by = enrollment.get("calendarByMsid") or {}

    msids: set[int] = set()
    for d in (en_by, cal_by, demo_by):
        for k in d:
            try:
                msids.add(int(k))
            except ValueError:
                pass

    geo_by_msid: dict[int, dict] = {}
    dropdown_ids: set[int] = set()
    for ft in schools.get("features") or []:
        p = ft.get("properties") or {}
        sid = p.get("SCHOOLS_ID")
        if sid is None:
            continue
        try:
            mid = int(sid)
        except (TypeError, ValueError):
            continue
        geo_by_msid[mid] = p
        dropdown_ids.add(mid)

    rows_sorted = sorted(msids)

    fieldnames = [
        "msid",
        "school_name",
        "appears_in_dropdown",
        "school_level",
        "grades_served",
        "address",
        "city_state_zip",
        "opened_year",
        "age_of_site_2026",
        "last_major_renovation_year",
        "site_acres",
    ]
    for y in CAL_YEARS:
        fieldnames.append(f"enrollment_{y}")
    fieldnames.append("sy2526_actual")
    for lab in PROJ_LABELS:
        fieldnames.append("projected_" + lab.replace("-", "_"))
    fieldnames.extend(
        [
            "factored_capacity_2025_26",
            "utilization_2025_26",
            "assignment_capture_rate",
            "other_district_capture_rate",
            "choice_capture_rate",
            "charter_capture_rate",
            "fromto_resident_denominator",
            "assignment_capture_students",
            "other_district_capture_students",
            "choice_capture_students",
            "charter_capture_students",
        ]
    )
    for _label, slug in ETH_SLUGS:
        fieldnames.append(slug)
    for _label, slug in LUNCH_SLUGS:
        fieldnames.append(slug)

    out_rows = []
    for msid in rows_sorted:
        g = geo_by_msid.get(msid)
        in_dd = "yes" if msid in dropdown_ids else "no"

        if g:
            name = (g.get("NAME") or g.get("CommonName") or "").strip()
            grades = (g.get("Grades") or "").strip()
            addr = (g.get("ADDRESS") or "").strip()
            city = (g.get("CITY_ST_ZI") or "").strip()
            acres = g.get("ACREAGE")
            level = type_to_level(g.get("TYPE") or "")
        else:
            name = ""
            grades = ""
            addr = ""
            city = ""
            acres = ""
            level = ""

        if not name:
            name = f"School {msid}"
        if msid in ms_lookup:
            name = ms_lookup[msid]

        fac = facility_row_for_props(by_name, g.get("NAME") if g else "", g.get("CommonName") if g else "") if g else None
        if not fac:
            fac = None

        y_open = fac.get("yearSchoolOpened") if fac else None
        age_2026 = fac.get("ageAsOf2026") if fac else None

        ek = str(msid)
        er = en_by.get(ek) or {}
        cal = cal_by.get(ek) or {}

        sy2526 = er.get("sy2526Actual")
        fc = er.get("factoredCapacity202526")
        util = er.get("utilization202526Pct")
        util_dec = "" if util is None else round(float(util) / 100.0, 6)
        proj = er.get("projected") or []

        cap_row = cap_by.get(ek) or {}
        if not level:
            for band in ("elementary", "middle", "high"):
                b = cap_row.get(band) or {}
                if b.get("captureRatePct") is not None:
                    level = band
                    break

        drow = demo_by.get(ek) or {}
        eth_src = drow.get("ethnicity") or {}
        lunch_src = drow.get("lunchStatus") or {}

        row = {
            "msid": str(msid).zfill(4),
            "school_name": name,
            "appears_in_dropdown": in_dd,
            "school_level": level,
            "grades_served": grades,
            "address": addr,
            "city_state_zip": city,
            "opened_year": "" if y_open is None else y_open,
            "age_of_site_2026": "" if age_2026 is None else age_2026,
            "last_major_renovation_year": "",
            "site_acres": "" if acres is None or acres == "" else acres,
            "sy2526_actual": out_num(sy2526),
            "factored_capacity_2025_26": out_num(fc),
            "utilization_2025_26": util_dec,
            "assignment_capture_rate": "",
            "other_district_capture_rate": "",
            "choice_capture_rate": "",
            "charter_capture_rate": "",
            "fromto_resident_denominator": "",
            "assignment_capture_students": "",
            "other_district_capture_students": "",
            "choice_capture_students": "",
            "charter_capture_students": "",
        }

        for y in CAL_YEARS:
            v = cal.get(str(y))
            row[f"enrollment_{y}"] = out_num(v)

        for i, lab in enumerate(PROJ_LABELS):
            pv = proj[i] if i < len(proj) else None
            row["projected_" + lab.replace("-", "_")] = out_num(pv)

        for label, slug in ETH_SLUGS:
            row[slug] = out_num(eth_src.get(label))
        for label, slug in LUNCH_SLUGS:
            row[slug] = out_num(lunch_src.get(label))

        out_rows.append(row)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for r in out_rows:
            w.writerow(r)

    print(f"Wrote {len(out_rows)} rows to {OUT}")


if __name__ == "__main__":
    main()
