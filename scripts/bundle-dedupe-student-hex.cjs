/**
 * Builds a deduplicated bundle for the student-hex student residence layer.
 * The raw GeoJSON repeats the same hex geometry for every student row (~74k features,
 * ~6.2k unique hexes) — this explodes file size. The bundle stores one geometry per
 * hex id and a flat list of property rows, then app.js expands to a FeatureCollection
 * (same as the original) at load time.
 *
 * Input:  geo/StudentHexagons.geojson  (e.g. after scripts/slim-geojson-properties.cjs)
 * Output: geo/StudentHexagons.bundle.json
 *
 * Usage:  node scripts/bundle-dedupe-student-hex.cjs
 */
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INPUT = path.join(ROOT, "geo", "StudentHexagons.geojson");
const OUT = path.join(ROOT, "geo", "StudentHexagons.bundle.json");

/**
 * @param {Record<string, unknown>} p
 * @returns {string|null}
 */
function hexKeyFromProps(p) {
  if (!p) {
    return null;
  }
  var id =
    p.GRID_ID != null
      ? p.GRID_ID
      : p.HEX_ID != null
        ? p.HEX_ID
        : p.HexID != null
          ? p.HexID
          : p.hex_id != null
            ? p.hex_id
            : p.OBJECTID != null
              ? p.OBJECTID
              : p.FID != null
                ? p.FID
                : null;
  if (id == null || id === "") {
    return null;
  }
  return "id:" + String(id);
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.error("Missing", INPUT);
    process.exit(1);
  }
  const raw = fs.readFileSync(INPUT, "utf8");
  const d = JSON.parse(raw);
  if (!d || !d.features) {
    console.error("Not a FeatureCollection");
    process.exit(1);
  }
  const g = Object.create(null);
  const r = [];
  for (var i = 0; i < d.features.length; i++) {
    var f = d.features[i];
    if (!f || f.type !== "Feature") {
      continue;
    }
    var p = f.properties || {};
    var k = hexKeyFromProps(p);
    if (k) {
      if (g[k] == null) {
        g[k] = f.geometry;
      }
    }
    r.push(p);
  }
  var outObj = { v: 2, g: g, r: r };
  var s = JSON.stringify(outObj);
  var bytes = Buffer.byteLength(s, "utf8");
  console.log("Unique hex geoms:", Object.keys(g).length, "rows:", r.length);
  console.log("Output", OUT, (bytes / 1e6).toFixed(2) + " MB");
  fs.writeFileSync(OUT, s, "utf8");
}

main();
