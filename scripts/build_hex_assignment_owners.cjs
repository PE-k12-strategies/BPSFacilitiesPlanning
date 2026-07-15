/**
 * Precompute hexKey → owner MSID per ES / MS / HS layer.
 *
 * Rule (per layer):
 *  1. Among schools with an assignment polygon on that layer, compute
 *     area(hex ∩ school) / area(hex ∩ any school on layer).
 *  2. If any school has share > 70%, assign that school (largest share on ties).
 *  3. Else assign by plurality of students in the hex whose grade matches the
 *     layer and who are ZONED to a school that has a polygon on that layer.
 *  4. If zoned plurality ties (or no zoned votes), use area plurality.
 *
 * Jr/Sr high schools participate in BOTH the MS and HS layer school sets.
 *
 * Usage:  node scripts/build_hex_assignment_owners.cjs
 * Output: data/processed/hex_assignment_owners.json
 *
 * Requires: npm install @turf/turf (dev dependency for this script).
 */
/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");
const RBush = require("rbush").default || require("rbush");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "data", "processed", "hex_assignment_owners.json");
const AREA_SHARE_THRESHOLD = 0.7;

const ES_GRADES = {
  PK: true,
  K: true,
  "01": true,
  "02": true,
  "03": true,
  "04": true,
  "05": true,
  "06": true,
};
const MS_GRADES = { "07": true, "08": true };
const HS_GRADES = { "09": true, "10": true, "11": true, "12": true };

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let i = 0;
  const len = text.length;
  function readRow() {
    const cells = [];
    let cur = "";
    let inQ = false;
    while (i < len) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i += 2;
            continue;
          }
          inQ = false;
          i++;
          continue;
        }
        cur += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inQ = true;
        i++;
        continue;
      }
      if (ch === ",") {
        cells.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (ch === "\r") {
        i++;
        continue;
      }
      if (ch === "\n") {
        cells.push(cur);
        i++;
        return cells;
      }
      cur += ch;
      i++;
    }
    if (cur.length || cells.length) cells.push(cur);
    return cells.length ? cells : null;
  }
  const header = readRow();
  if (!header) return [];
  while (i < len) {
    const cells = readRow();
    if (!cells) break;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = cells[c] != null ? cells[c] : "";
    }
    rows.push(obj);
  }
  return rows;
}

function hexKeyFromProps(p) {
  if (!p) return null;
  const id =
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
  if (id == null || id === "") return null;
  return "id:" + String(id);
}

function ringCentroid(ring) {
  if (!ring || ring.length < 3) return null;
  const n = ring.length;
  const closed =
    ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const count = closed ? n - 1 : n;
  if (count < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < count; i++) {
    sx += ring[i][0];
    sy += ring[i][1];
  }
  return [sx / count, sy / count];
}

function polygonCentroid(geometry) {
  if (!geometry || !geometry.type) return null;
  if (geometry.type === "Polygon") return ringCentroid(geometry.coordinates[0]);
  if (geometry.type === "MultiPolygon") {
    let best = null;
    let bestLen = -1;
    for (let p = 0; p < geometry.coordinates.length; p++) {
      const ring = geometry.coordinates[p][0];
      if (!ring || ring.length < 2) continue;
      const c = ringCentroid(ring);
      if (!c) continue;
      if (ring.length > bestLen) {
        bestLen = ring.length;
        best = c;
      }
    }
    return best;
  }
  return null;
}

function msidNorm(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function canonicalStudentGradeCode(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  const u = t.toUpperCase();
  if (/^(PK|PRE-?K|PREK|VPK)$/.test(u)) return "PK";
  if (/^(K|KG|KIN|KINDERGARTEN)$/.test(u)) return "K";
  const n = parseInt(t.replace(/^0+/, "") || t, 10);
  if (isNaN(n)) return null;
  if (n === 0) return "K";
  if (n >= 1 && n <= 9) return "0" + n;
  if (n >= 10 && n <= 12) return String(n);
  return null;
}

function gradeMatchesLayer(canon, layerKey) {
  if (!canon) return false;
  if (layerKey === "es") return !!ES_GRADES[canon];
  if (layerKey === "ms") return !!MS_GRADES[canon];
  if (layerKey === "hs") return !!HS_GRADES[canon];
  return false;
}

/** Zoned school for a detail on a given assignment layer (grade already matched). */
function zonedMsidForLayer(d, layerKey) {
  if (!d) return null;
  if (layerKey === "es") return msidNorm(d.ELEM_);
  if (layerKey === "ms") return msidNorm(d.MID_) || msidNorm(d.INT_);
  if (layerKey === "hs") return msidNorm(d.HIGH_) || msidNorm(d.INT_);
  return null;
}

function bboxesOverlap(a, b) {
  if (!a || !b || a.length < 4 || b.length < 4) return true;
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function intersectArea(hexFeat, schFeat) {
  try {
    const inter = turf.intersect(turf.featureCollection([hexFeat, schFeat]));
    if (!inter || !inter.geometry) return { area: 0, feat: null };
    return { area: Number(turf.area(inter)) || 0, feat: inter };
  } catch (e) {
    return { area: 0, feat: null };
  }
}

function unionArea(feats) {
  if (!feats || !feats.length) return 0;
  if (feats.length === 1) return Number(turf.area(feats[0])) || 0;
  try {
    let u = feats[0];
    for (let i = 1; i < feats.length; i++) {
      const next = turf.union(turf.featureCollection([u, feats[i]]));
      if (next && next.geometry) u = next;
    }
    return Number(turf.area(u)) || 0;
  } catch (e) {
    let sum = 0;
    for (let i = 0; i < feats.length; i++) sum += Number(turf.area(feats[i])) || 0;
    return sum;
  }
}

function loadMasterLevels() {
  const rows = parseCsv(
    fs.readFileSync(path.join(ROOT, "data", "school_master.csv"), "utf8")
  );
  const byMsid = Object.create(null);
  for (let i = 0; i < rows.length; i++) {
    const id = msidNorm(rows[i].msid);
    if (id == null) continue;
    byMsid[String(id)] = String(rows[i].school_level || "")
      .toLowerCase()
      .trim();
  }
  return byMsid;
}

function featureToSchool(f) {
  if (!f || !f.geometry) return null;
  const ms = msidNorm(f.properties && f.properties.MSID);
  if (ms == null) return null;
  let feat;
  try {
    feat = turf.feature(f.geometry);
  } catch (e) {
    return null;
  }
  let bbox = null;
  try {
    bbox = turf.bbox(feat);
  } catch (e2) {
    bbox = null;
  }
  return { msid: ms, feat: feat, bbox: bbox };
}

/**
 * School set for a layer. Jr/Sr highs are included in both MS and HS.
 */
function schoolsForLayer(layerKey, es, ms, hs, levelByMsid) {
  const seen = Object.create(null);
  const out = [];
  function addFc(fc, onlyJrSr) {
    const feats = (fc && fc.features) || [];
    for (let i = 0; i < feats.length; i++) {
      const sch = featureToSchool(feats[i]);
      if (!sch) continue;
      const sk = String(sch.msid);
      if (seen[sk]) continue;
      if (onlyJrSr) {
        if (levelByMsid[sk] !== "jr_sr_high") continue;
      }
      seen[sk] = true;
      out.push(sch);
    }
  }
  if (layerKey === "es") {
    addFc(es, false);
  } else if (layerKey === "ms") {
    addFc(ms, false);
    addFc(hs, true); /* Jr/Sr from HS layer if missing in MS */
  } else if (layerKey === "hs") {
    addFc(hs, false);
    addFc(ms, true); /* Jr/Sr from MS layer if missing in HS */
  }
  return out;
}

function collectHexGeomsAndStudents() {
  const geoms = Object.create(null);
  const studentsByHex = Object.create(null);
  const bundle = readJson("geo/StudentHexagons.bundle.json");
  if (bundle && bundle.v === 2 && bundle.g) {
    for (const k of Object.keys(bundle.g)) geoms[k] = bundle.g[k];
  }
  const rows = Array.isArray(bundle.r) ? bundle.r : [];
  for (let ri = 0; ri < rows.length; ri++) {
    const pr = rows[ri] || {};
    const hk = hexKeyFromProps(pr);
    if (!hk || !geoms[hk]) continue;
    let g = "";
    if (pr.Grade != null && String(pr.Grade).trim() !== "") g = String(pr.Grade).trim();
    else if (pr.grade != null && String(pr.grade).trim() !== "") g = String(pr.grade).trim();
    else if (pr.StudGRD != null && String(pr.StudGRD).trim() !== "")
      g = String(pr.StudGRD).trim();
    const det = {
      Grade: g,
      ELEM_: pr.ELEM_,
      MID_: pr.MID_,
      INT_: pr.INT_,
      HIGH_: pr.HIGH_,
    };
    let inc = 1;
    if (pr.count != null && isFinite(Number(pr.count))) inc = Number(pr.count);
    if (!studentsByHex[hk]) studentsByHex[hk] = [];
    for (let jd = 0; jd < inc; jd++) studentsByHex[hk].push(det);
  }
  const hsPath = path.join(ROOT, "geo", "HomeschoolStudentHexagons.geojson");
  if (fs.existsSync(hsPath)) {
    const hfc = JSON.parse(fs.readFileSync(hsPath, "utf8"));
    for (const f of hfc.features || []) {
      if (!f || !f.geometry) continue;
      const hk = hexKeyFromProps(f.properties || {});
      if (!hk || geoms[hk]) continue;
      geoms[hk] = f.geometry;
    }
  }
  return { geoms: geoms, studentsByHex: studentsByHex };
}

function areaPluralityWinner(areaByMsid) {
  let bestMsid = null;
  let bestArea = 0;
  for (const sk of Object.keys(areaByMsid)) {
    const a = areaByMsid[sk];
    if (a <= 0) continue;
    const ms = Number(sk);
    if (
      a > bestArea ||
      (a === bestArea && (bestMsid == null || ms < bestMsid))
    ) {
      bestArea = a;
      bestMsid = ms;
    }
  }
  return bestMsid;
}

function zonedPluralityWinner(students, layerKey, eligibleMsids) {
  const votes = Object.create(null);
  let total = 0;
  for (let i = 0; i < students.length; i++) {
    const d = students[i];
    const g = canonicalStudentGradeCode(d.Grade);
    if (!gradeMatchesLayer(g, layerKey)) continue;
    const z = zonedMsidForLayer(d, layerKey);
    if (z == null || !eligibleMsids[String(z)]) continue;
    votes[String(z)] = (votes[String(z)] || 0) + 1;
    total++;
  }
  if (!total) return { winner: null, tied: false };
  let best = null;
  let bestN = 0;
  let tie = false;
  for (const sk of Object.keys(votes)) {
    const n = votes[sk];
    if (n > bestN) {
      bestN = n;
      best = Number(sk);
      tie = false;
    } else if (n === bestN && Number(sk) !== best) {
      tie = true;
    }
  }
  if (tie) return { winner: null, tied: true };
  return { winner: best, tied: false };
}

function buildSchoolIndex(schools) {
  const tree = new RBush();
  const items = [];
  for (let i = 0; i < schools.length; i++) {
    const sch = schools[i];
    if (!sch.bbox || sch.bbox.length < 4) continue;
    items.push({
      minX: sch.bbox[0],
      minY: sch.bbox[1],
      maxX: sch.bbox[2],
      maxY: sch.bbox[3],
      sch: sch,
    });
  }
  tree.load(items);
  return tree;
}

/**
 * Resolve ownership for one layer. Fast path: unique school containing the hex
 * centroid (among bbox candidates) → assign immediately. Expensive intersects
 * only when the centroid is in 0 or 2+ schools (true border / gap hexes).
 */
function ownerMapForLayer(layerKey, schools, geoms, studentsByHex) {
  const out = Object.create(null);
  const eligible = Object.create(null);
  for (let i = 0; i < schools.length; i++) eligible[String(schools[i].msid)] = true;
  const tree = buildSchoolIndex(schools);

  let nClear = 0;
  let nFast = 0;
  let nZoned = 0;
  let nArea = 0;
  let nSkip = 0;
  const keys = Object.keys(geoms);
  const tStart = Date.now();

  for (let ki = 0; ki < keys.length; ki++) {
    if (ki > 0 && ki % 1500 === 0) {
      console.log(
        "    " +
          layerKey.toUpperCase() +
          " progress " +
          ki +
          "/" +
          keys.length +
          " (" +
          ((Date.now() - tStart) / 1000).toFixed(1) +
          "s)"
      );
    }
    const hk = keys[ki];
    const geom = geoms[hk];
    if (!geom) continue;
    let hexFeat;
    try {
      hexFeat = turf.feature(geom);
    } catch (e) {
      nSkip++;
      continue;
    }
    let hbb;
    try {
      hbb = turf.bbox(hexFeat);
    } catch (e2) {
      hbb = null;
    }
    if (!hbb) {
      nSkip++;
      continue;
    }

    const ctr = polygonCentroid(geom);
    let pt = null;
    if (ctr) {
      try {
        pt = turf.point(ctr);
      } catch (ePt) {
        pt = null;
      }
    }

    /* Candidate schools whose bbox overlaps the hex (cheap via RBush). */
    const hits = tree.search({
      minX: hbb[0],
      minY: hbb[1],
      maxX: hbb[2],
      maxY: hbb[3],
    });
    const candidates = [];
    for (let hi = 0; hi < hits.length; hi++) candidates.push(hits[hi].sch);

    /* Fast path: unique centroid containment → treat as >70% clear winner.
       (MS/HS polygons have large bboxes; requiring candidates.length===1
       almost never fires, so PIP among bbox hits is the real interior test.) */
    if (pt && candidates.length) {
      const containers = [];
      for (let ci = 0; ci < candidates.length; ci++) {
        try {
          if (turf.booleanPointInPolygon(pt, candidates[ci].feat)) {
            containers.push(candidates[ci]);
          }
        } catch (ePip) {
          /* skip */
        }
      }
      if (containers.length === 1) {
        out[hk] = containers[0].msid;
        nFast++;
        nClear++;
        continue;
      }
    }

    if (!candidates.length) {
      nSkip++;
      continue;
    }

    const areaByMsid = Object.create(null);
    const interFeats = [];
    for (let si = 0; si < candidates.length; si++) {
      const sch = candidates[si];
      const ia = intersectArea(hexFeat, sch.feat);
      if (ia.area <= 0 || !ia.feat) continue;
      areaByMsid[String(sch.msid)] = ia.area;
      interFeats.push(ia.feat);
    }

    if (!interFeats.length) {
      nSkip++;
      continue;
    }

    /* Single-school touch: share is 100% of hex∩any-boundary — no union needed. */
    const insideArea =
      interFeats.length === 1
        ? Number(turf.area(interFeats[0])) || 0
        : unionArea(interFeats);
    if (!(insideArea > 0)) {
      nSkip++;
      continue;
    }

    let bestMsid = null;
    let bestShare = 0;
    for (const sk of Object.keys(areaByMsid)) {
      const share = areaByMsid[sk] / insideArea;
      const ms = Number(sk);
      if (
        share > bestShare ||
        (share === bestShare && (bestMsid == null || ms < bestMsid))
      ) {
        bestShare = share;
        bestMsid = ms;
      }
    }

    if (bestMsid != null && bestShare > AREA_SHARE_THRESHOLD) {
      out[hk] = bestMsid;
      nClear++;
      continue;
    }

    const students = studentsByHex[hk] || [];
    const zv = zonedPluralityWinner(students, layerKey, eligible);
    if (zv.winner != null && !zv.tied) {
      out[hk] = zv.winner;
      nZoned++;
      continue;
    }

    const areaWin = areaPluralityWinner(areaByMsid);
    if (areaWin != null) {
      out[hk] = areaWin;
      nArea++;
    } else {
      nSkip++;
    }
  }

  return {
    map: out,
    nClear: nClear,
    nFast: nFast,
    nZoned: nZoned,
    nArea: nArea,
    nSkip: nSkip,
  };
}

function main() {
  console.log("Loading…");
  const levelByMsid = loadMasterLevels();
  const es = readJson("geo/ESBoundaries.json");
  const ms = readJson("geo/MSBoundaries.json");
  const hs = readJson("geo/HSBoundaries.json");
  const { geoms, studentsByHex } = collectHexGeomsAndStudents();
  console.log(
    "Hexes:",
    Object.keys(geoms).length,
    "hexes-with-students:",
    Object.keys(studentsByHex).length
  );

  const out = { v: 2, rule: "area70_then_zoned_plurality", es: {}, ms: {}, hs: {} };
  const layers = ["es", "ms", "hs"];
  for (let li = 0; li < layers.length; li++) {
    const lk = layers[li];
    const schools = schoolsForLayer(lk, es, ms, hs, levelByMsid);
    console.log(lk.toUpperCase() + ": schools=" + schools.length + " (computing…)");
    const t0 = Date.now();
    const res = ownerMapForLayer(lk, schools, geoms, studentsByHex);
    out[lk] = res.map;
    console.log(
      "  owned=" +
        Object.keys(res.map).length +
        " clear70=" +
        res.nClear +
        " (fastInterior=" +
        res.nFast +
        ") zoned=" +
        res.nZoned +
        " areaTiebreak=" +
        res.nArea +
        " skip=" +
        res.nSkip +
        " " +
        ((Date.now() - t0) / 1000).toFixed(1) +
        "s"
    );
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(
    "Wrote",
    OUT,
    (fs.statSync(OUT).size / 1024).toFixed(1) + " KB"
  );
}

main();
