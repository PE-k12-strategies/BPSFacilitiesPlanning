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

## Optional legacy scripts

The `scripts/` folder still contains Python helpers used by an older workflow; they are not required to run this map.
