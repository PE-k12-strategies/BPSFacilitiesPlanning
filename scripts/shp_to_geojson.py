"""
Convert Esri shapefiles under data/raw/ to GeoJSON in public/geo/.

Priority:
1) ogr2ogr (GDAL), if on PATH
2) geopandas, if installed (see requirements-geo.txt)

Run: py scripts/shp_to_geojson.py

Set environment variable SHP_STEMS to comma-separated base names, e.g.
  SHP_STEMS=district_boundary,school_locations,student_locations
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "geo"


def run_ogr2ogr(src_shp: Path, dst_geojson: Path) -> bool:
    exe = shutil.which("ogr2ogr")
    if not exe:
        return False
    dst_geojson.parent.mkdir(parents=True, exist_ok=True)
    cmd = [exe, "-f", "GeoJSON", str(dst_geojson), str(src_shp), "-t_srs", "EPSG:4326"]
    subprocess.run(cmd, check=True)
    return True


def run_geopandas(src_shp: Path, dst_geojson: Path) -> bool:
    try:
        import geopandas as gpd  # type: ignore
    except ImportError:
        return False
    gdf = gpd.read_file(src_shp)
    if gdf.crs is not None and gdf.crs.to_string() != "EPSG:4326":
        gdf = gdf.to_crs(4326)
    dst_geojson.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(dst_geojson, driver="GeoJSON")
    return True


def convert_one(stem: str) -> None:
    src = RAW / f"{stem}.shp"
    if not src.is_file():
        print(f"Skip {stem}: not found at {src}")
        return
    dst = OUT / f"{stem}.geojson"
    if run_ogr2ogr(src, dst):
        print(f"ogr2ogr: {dst}")
        return
    if run_geopandas(src, dst):
        print(f"geopandas: {dst}")
        return
    print(
        f"Could not convert {src}. Install GDAL (ogr2ogr) or pip install geopandas.",
        file=sys.stderr,
    )


def main() -> None:
    stems_env = os.environ.get("SHP_STEMS", "").strip()
    if stems_env:
        stems = [s.strip() for s in stems_env.split(",") if s.strip()]
    else:
        stems = [
            "district_boundary",
            "school_locations",
            "student_locations",
        ]
    OUT.mkdir(parents=True, exist_ok=True)
    for stem in stems:
        convert_one(stem)


if __name__ == "__main__":
    main()
