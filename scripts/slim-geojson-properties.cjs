/**
 * Strips unused feature properties from dashboard GeoJSON assets.
 * Whitelists are derived from app.js (indexing, hovers, filters, enrichers).
 *
 * Usage:  node scripts/slim-geojson-properties.cjs
 * Pass --dry-run to only print would-be sizes.
 * Pass --backup to write *.geojson.bak before each rewrite (can be 100MB+; usually not needed).
 */
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DRY = process.argv.includes("--dry-run");
const WRITE_BACKUP = process.argv.includes("--backup");

/** @type {Object<string, Set<string>>} relpath from geo/ */
const WHITELISTS = {
  "StudentHexagons.geojson": new Set([
    "GRID_ID",
    "HEX_ID",
    "HexID",
    "hex_id",
    "OBJECTID",
    "FID",
    "MSID",
    "SCHOOLS_ID",
    "count",
    "Grade",
    "grade",
    "StudGRD",
    "JOIN_FID",
    "TARGET_FID",
    "ELEM_",
    "MID_",
    "INT_",
    "HIGH_",
    "ethnicity",
    "lunch_stat",
    "_hexKey",
    "students_per_sq_mi",
  ]),
  "SchoolIsochrones.geojson": new Set(["Name", "name", "ToBreak"]),
  "MunicipalBoundaries.geojson": new Set(["OBJECTID", "objectid", "CITY_NAME"]),
  "SchoolParcels.geojson": new Set(["SCHL_CODE", "Schl_Code", "schl_code"]),
  "SchoolBoardDistricts.geojson": new Set(["NAME", "SchBoardMe", "OBJECTID"]),
  "CharterSchoolLocations.geojson": new Set(["SCHOOLS_ID", "TYPE", "SchAB_Type", "OBJECTID"]),
};

/**
 * @param {Record<string, unknown>|null|undefined} p
 * @param {Set<string>} allow
 */
function pickProps(p, allow) {
  if (!p || typeof p !== "object") {
    return {};
  }
  /** @type {Record<string, unknown>} */
  const o = {};
  for (const k of Object.keys(p)) {
    if (allow.has(k)) {
      o[k] = p[k];
    }
  }
  return o;
}

/**
 * @param {string} name
 * @param {Set<string>} allow
 */
function processFile(name, allow) {
  const full = path.join(ROOT, "geo", name);
  if (!fs.existsSync(full)) {
    console.warn("  skip (missing):", name);
    return;
  }
  const before = fs.statSync(full).size;
  const raw = fs.readFileSync(full, "utf8");
  const fc = JSON.parse(raw);
  if (!fc || !Array.isArray(fc.features)) {
    console.warn("  skip (not a FeatureCollection):", name);
    return;
  }
  let n = 0;
  for (const f of fc.features) {
    if (!f || f.type !== "Feature" || !f.properties) {
      continue;
    }
    const newP = pickProps(f.properties, allow);
    n += Object.keys(f.properties).length - Object.keys(newP).length;
    f.properties = newP;
  }
  const out = JSON.stringify(fc);
  const after = Buffer.byteLength(out, "utf8");
  console.log(
    name,
    "bytes:",
    before,
    "->",
    after,
    "(" + ((100 * (before - after)) / before).toFixed(1) + "% smaller)"
  );
  if (n > 0) {
    console.log("  dropped", n, "property key occurrences across", fc.features.length, "features");
  }
  if (DRY) {
    return;
  }
  if (WRITE_BACKUP) {
    fs.writeFileSync(full + ".bak", raw, "utf8");
  }
  fs.writeFileSync(full, out, "utf8");
}

function main() {
  console.log("Slimming geo/*.geojson (whitelist in scripts/slim-geojson-properties.cjs)\n");
  for (const [name, allow] of Object.entries(WHITELISTS)) {
    processFile(name, allow);
  }
  if (DRY) {
    console.log("\n(dry run — no files written)");
  } else {
    console.log(WRITE_BACKUP ? "\nDone. Backups written next to each .geojson." : "\nDone.");
  }
}

main();
