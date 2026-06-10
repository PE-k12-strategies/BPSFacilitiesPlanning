# School district map (Phase One)

Static web page that shows **school locations** and **elementary / middle / high assignment boundaries** from GeoJSON files in the `geo/` folder.

## Preview

This project has **no build step**. Use any local static server so the browser can load files under `geo/`:

- **Live Server** (VS Code / Cursor extension): open `index.html` and use *Go Live*.
- Or from PowerShell in this folder: `python -m http.server 8080` then open `http://localhost:8080`.

Do not open `index.html` directly as `file://` — fetching `geo/*.json` will usually be blocked.

## Data

Source files were copied from the project working folder into `geo/`:

- `SchoolLocations.json` — point features (schools)
- `ESBoundaries.json`, `MSBoundaries.json`, `HSBoundaries.json` — assignment zones

To refresh data, replace those files (same names) or edit the paths in `app.js` (`DATA`).

## Private source data

Raw Excel workbooks, feeder-plan source docs, and MSID lookup files live in a **separate private repo**:

https://github.com/PE-k12-strategies/BPSFacilitiesPlanning-Public_PrivateData

`data/school_master.csv` lives in the **private repo** only. For the public site, run `py -3 scripts/export_school_master_shards.py` after updating the CSV — that writes `data/processed/school_master_index.json` and opaque JSON shards under `data/processed/school_master_d/` (no single downloadable spreadsheet on Pages). Commit the updated shards to this repo, or set `PRIVATE_DATA_PAT` so deploy rebuilds them from the private CSV.

Clone the private repo alongside this project and copy files into `data/raw/`, `data/sourcedocs/`, and the project root (`MSID_Lookup.*`) before running data scripts. See that repo's README for details.

## GitHub Pages deployment

The live site at https://pe-k12-strategies.github.io/BPSFacilitiesPlanning/ is built by `.github/workflows/deploy-pages.yml`. That workflow copies private data into the site and writes `config.local.js` at deploy time.

**Repository secrets required** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `MAPBOX_ACCESS_TOKEN` | Mapbox public token (`pk.…`) for the basemap — **required** |
| `PRIVATE_DATA_PAT` | GitHub PAT with read access to [BPSFacilitiesPlanning-Public_PrivateData](https://github.com/PE-k12-strategies/BPSFacilitiesPlanning-Public_PrivateData) — needed for `school_master.csv` on the live site |

**Pages source:** Settings → Pages → Build and deployment → **GitHub Actions** (not “Deploy from a branch”). Also enable **Settings → Actions → General → Workflow permissions → Read and write permissions** so deploys can publish.

## Optional legacy scripts

The `scripts/` folder still contains Python helpers used by an older workflow; they are not required to run this map.
