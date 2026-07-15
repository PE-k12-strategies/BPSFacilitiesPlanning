/**
 * Compare school_master 2025-26 utilization vs Boundary Sandbox utilization
 * when each traditional school (with assignment polygon + capacity) is set as
 * Boundary 1 base with auto-prefill and default toggles (Zoned + Choice-In on).
 *
 * Selection rules (current sandbox):
 *   - Prefill hexes this school owns per hybrid rule in
 *     data/processed/hex_assignment_owners.json
 *     (>70% area share of hex∩any-boundary on layer; else zoned plurality;
 *     else area plurality). Jr/Sr use MS+HS owner maps.
 *   - Plus gap student/homeschool hexes with centroid in the assignment polygon
 *     not owned by another school (empty filler hexes are NOT selected here)
 * Enrollment rules (current sandbox defaults):
 *   - Grade toggles from grades_served (+ PK when school has PK attendance)
 *   - Residence: Zoned Traditional only (attend == student's own zoned school)
 *     among selected hexes — no zone-to-base filter
 *   - Plus Choice-In (attend base, home hex outside selection, zoned ≠ base)
 *
 * Usage: node scripts/export_sandbox_utilization_test.cjs
 *        node scripts/export_sandbox_utilization_test.cjs [outfile.csv]
 * Output: data/UtilizationTest_area70_zoned.csv (default)
 */
/* eslint-disable no-console */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_OUT = path.join(
  ROOT,
  "data",
  "UtilizationTest_area70_zoned.csv"
);
const OUT =
  process.argv[2] != null && String(process.argv[2]).trim() !== ""
    ? path.isAbsolute(process.argv[2])
      ? process.argv[2]
      : path.join(ROOT, process.argv[2])
    : DEFAULT_OUT;

const MEADOWLANE_PRIMARY_MSID = 2041;
const MEADOWLANE_INTERMEDIATE_MSID = 2031;
const FIXED_GRADES = [
  "K",
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "09",
  "10",
  "11",
  "12"
];

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

function ringCentroid(ring) {
  if (!ring || ring.length < 2) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  const lim = ring.length - 1;
  for (let i = 0; i < lim; i++) {
    const p = ring[i];
    if (!p || p.length < 2) continue;
    sx += Number(p[0]);
    sy += Number(p[1]);
    n++;
  }
  if (!n) return null;
  return [sx / n, sy / n];
}

function polygonCentroid(geometry) {
  if (!geometry || !geometry.type) return null;
  if (geometry.type === "Polygon") {
    return ringCentroid(geometry.coordinates[0]);
  }
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

/** Ray-cast point-in-ring (lng/lat). */
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 0.0) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng, lat, geometry) {
  if (!geometry) return false;
  function inPoly(coords) {
    if (!coords || !coords.length) return false;
    if (!pointInRing(lng, lat, coords[0])) return false;
    for (let h = 1; h < coords.length; h++) {
      if (pointInRing(lng, lat, coords[h])) return false;
    }
    return true;
  }
  if (geometry.type === "Polygon") return inPoly(geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    for (let i = 0; i < geometry.coordinates.length; i++) {
      if (inPoly(geometry.coordinates[i])) return true;
    }
  }
  return false;
}

function studentHexIdKeyFromProperties(p) {
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
  if (id != null && id !== "") return "id:" + String(id);
  return null;
}

function studentHexDetailFromProps(p) {
  let g = "";
  if (p.Grade != null && String(p.Grade).trim() !== "") g = String(p.Grade).trim();
  else if (p.grade != null && String(p.grade).trim() !== "") g = String(p.grade).trim();
  else if (p.StudGRD != null && String(p.StudGRD).trim() !== "") g = String(p.StudGRD).trim();
  let oid = "";
  if (p.OBJECTID != null && String(p.OBJECTID).trim() !== "") oid = "o:" + String(p.OBJECTID).trim();
  else if (p.JOIN_FID != null && String(p.JOIN_FID).trim() !== "") oid = "j:" + String(p.JOIN_FID).trim();
  else if (p.TARGET_FID != null && String(p.TARGET_FID).trim() !== "") oid = "t:" + String(p.TARGET_FID).trim();
  return {
    Grade: g,
    MSID: p.MSID != null ? String(p.MSID).trim() : "",
    ELEM_: p.ELEM_,
    MID_: p.MID_,
    INT_: p.INT_,
    HIGH_: p.HIGH_,
    _oid: oid
  };
}

function msidNormForZoning(v) {
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

function charterGradeCanonToOrdinal(canon) {
  if (canon == null || canon === "") return null;
  if (canon === "PK") return -2;
  if (canon === "K") return -1;
  const n = parseInt(String(canon), 10);
  if (isNaN(n)) return null;
  return n;
}

function normalizeGradesServedForUi(raw) {
  if (raw == null || raw === "") return "";
  let t = String(raw).trim();
  if (t.charAt(0) === "'") t = t.slice(1).trim();
  if (/^12-sep$/i.test(t)) return "9-12";
  if (/^12-jul$/i.test(t)) return "7-12";
  if (/^8-jul$/i.test(t)) return "7-8";
  if (/^6-apr$/i.test(t)) return "4-6";
  if (/^6-mar$/i.test(t)) return "3-6";
  return t;
}

function parseGradesServedToCanonList(raw) {
  const norm = normalizeGradesServedForUi(raw);
  if (!norm) return [];
  const t = String(norm).trim();
  if (!/[-–]/.test(t)) {
    const single = canonicalStudentGradeCode(t);
    return single ? [single] : [];
  }
  const parts = t.split(/[-–]/);
  if (parts.length < 2) return [];
  const lo = canonicalStudentGradeCode(parts[0].trim());
  const hi = canonicalStudentGradeCode(parts[parts.length - 1].trim());
  if (!lo || !hi) return [];
  const loOrd = charterGradeCanonToOrdinal(lo);
  const hiOrd = charterGradeCanonToOrdinal(hi);
  if (loOrd == null || hiOrd == null || loOrd > hiOrd) return [];
  const out = [];
  for (let o = loOrd; o <= hiOrd; o++) {
    if (o === -2) out.push("PK");
    else if (o === -1) out.push("K");
    else if (o >= 1 && o <= 9) out.push("0" + o);
    else if (o >= 10 && o <= 12) out.push(String(o));
  }
  return out;
}

function elementaryGradeAllowedSet(msidNum) {
  const o = Object.create(null);
  if (msidNum === MEADOWLANE_PRIMARY_MSID) {
    o.K = true;
    o["01"] = true;
    o["02"] = true;
    return o;
  }
  if (msidNum === MEADOWLANE_INTERMEDIATE_MSID) {
    o["03"] = true;
    o["04"] = true;
    o["05"] = true;
    o["06"] = true;
    return o;
  }
  o.PK = true;
  o.K = true;
  for (let g = 1; g <= 6; g++) o[g < 10 ? "0" + g : String(g)] = true;
  return o;
}

function studentGradeInSelectedSchoolBand(gradeRaw, m) {
  if (!m) return false;
  const g = canonicalStudentGradeCode(gradeRaw);
  if (!g) return false;
  const msidNum = parseInt(String(m.msid || "").trim(), 10);
  const lv = String(m.school_level || "").toLowerCase().trim();
  if (lv === "elementary") return !!elementaryGradeAllowedSet(msidNum)[g];
  if (lv === "middle") return g === "07" || g === "08";
  if (lv === "high") return g === "09" || g === "10" || g === "11" || g === "12";
  if (lv === "jr_sr_high") {
    return (
      g === "07" ||
      g === "08" ||
      g === "09" ||
      g === "10" ||
      g === "11" ||
      g === "12"
    );
  }
  return false;
}

function detailMatchesZonedTargetMsid(d, targetNum, schoolLevel) {
  const lv = String(schoolLevel || "").toLowerCase().trim();
  if (lv === "elementary") return msidNormForZoning(d.ELEM_) === targetNum;
  if (lv === "middle") return msidNormForZoning(d.MID_) === targetNum;
  if (lv === "high") return msidNormForZoning(d.HIGH_) === targetNum;
  if (lv === "jr_sr_high") {
    return (
      msidNormForZoning(d.MID_) === targetNum ||
      msidNormForZoning(d.INT_) === targetNum ||
      msidNormForZoning(d.HIGH_) === targetNum
    );
  }
  return false;
}

function zonedMsidForDetailForAggregate(d) {
  if (!d) return null;
  const g = canonicalStudentGradeCode(d.Grade);
  if (!g) return null;
  if (
    g === "PK" ||
    g === "K" ||
    g === "01" ||
    g === "02" ||
    g === "03" ||
    g === "04" ||
    g === "05" ||
    g === "06"
  ) {
    return msidNormForZoning(d.ELEM_);
  }
  if (g === "07" || g === "08") {
    return msidNormForZoning(d.MID_) || msidNormForZoning(d.INT_);
  }
  if (g === "09" || g === "10" || g === "11" || g === "12") {
    return msidNormForZoning(d.HIGH_) || msidNormForZoning(d.INT_);
  }
  return null;
}

function attendanceCategory(d, charterSet, choiceSet) {
  if (!d) return "otherTraditional";
  if (d.__homeschool) return "homeschool";
  const att = parseInt(String(d.MSID != null ? d.MSID : "").trim(), 10);
  if (isNaN(att) || att <= 0) return "otherTraditional";
  const attK = String(att);
  if (charterSet[attK]) return "charter";
  if (choiceSet[attK]) return "choice";
  const zoned = zonedMsidForDetailForAggregate(d);
  if (zoned != null && !isNaN(zoned) && Number(zoned) === att) return "zonedTraditional";
  return "otherTraditional";
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function main() {
  console.log("Loading data…");
  const masterRows = parseCsv(
    fs.readFileSync(path.join(ROOT, "data", "school_master.csv"), "utf8")
  );
  const masterByMsid = Object.create(null);
  for (let i = 0; i < masterRows.length; i++) {
    const r = masterRows[i];
    const id = parseInt(String(r.msid || "").trim(), 10);
    if (isNaN(id)) continue;
    r.msid = String(id);
    masterByMsid[String(id)] = r;
  }

  const es = readJson("geo/ESBoundaries.json");
  const ms = readJson("geo/MSBoundaries.json");
  const hs = readJson("geo/HSBoundaries.json");
  const schools = readJson("geo/SchoolLocations.json");
  const charterFc = readJson("geo/CharterSchoolLocations.geojson");
  const hmFc = readJson("geo/HomeschoolStudentHexagons.geojson");
  const bundle = readJson("geo/StudentHexagons.bundle.json");
  const ownersPath = path.join(
    ROOT,
    "data",
    "processed",
    "hex_assignment_owners.json"
  );
  if (!fs.existsSync(ownersPath)) {
    console.error(
      "Missing",
      ownersPath,
      "— run: node scripts/build_hex_assignment_owners.cjs"
    );
    process.exit(1);
  }
  const owners = readJson("data/processed/hex_assignment_owners.json");
  if (!owners || (owners.v !== 1 && owners.v !== 2)) {
    console.error(
      "hex_assignment_owners.json is missing or invalid (need v:1 or v:2)"
    );
    process.exit(1);
  }

  const choiceSet = Object.create(null);
  const charterSet = Object.create(null);
  function addChoice(p) {
    if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") return;
    if (String(p.SchAB_Type || "").toUpperCase() !== "CHOICE") return;
    choiceSet[String(parseInt(String(p.SCHOOLS_ID), 10))] = true;
  }
  function addCharter(p) {
    if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") return;
    const t = String(p.TYPE || "").toUpperCase();
    const ab = String(p.SchAB_Type || "").toUpperCase();
    if (t !== "CHARTER" && ab !== "CHARTER") return;
    const id = parseInt(String(p.SCHOOLS_ID).trim(), 10);
    if (!isNaN(id)) charterSet[String(id)] = true;
  }
  for (const f of schools.features || []) {
    addChoice(f.properties);
    addCharter(f.properties);
  }
  for (const f of charterFc.features || []) addCharter(f.properties);

  const boundaryByMsid = Object.create(null);
  const layerByMsid = Object.create(null);
  function indexBoundaries(fc, layerKey) {
    if (!fc || !fc.features) return;
    for (const f of fc.features) {
      const m =
        f.properties && f.properties.MSID != null
          ? Number(f.properties.MSID)
          : NaN;
      if (!isNaN(m) && m > 0) {
        const k = String(Math.round(m));
        boundaryByMsid[k] = f;
        layerByMsid[k] = layerKey;
      }
    }
  }
  indexBoundaries(es, "es");
  indexBoundaries(ms, "ms");
  indexBoundaries(hs, "hs");

  function layerKeysForSchool(msid, m) {
    const lv = m ? String(m.school_level || "").toLowerCase().trim() : "";
    if (lv === "jr_sr_high") return ["ms", "hs"];
    const fromBound = layerByMsid[String(msid)];
    if (fromBound) return [fromBound];
    if (lv === "elementary") return ["es"];
    if (lv === "middle") return ["ms"];
    if (lv === "high") return ["hs"];
    return [];
  }

  console.log("Indexing student hex bundle…");
  const geometryByHexKey = Object.create(null);
  const detailsByMsid = Object.create(null);
  const detailsByHex = Object.create(null);
  const geoms = bundle.g || {};
  const rows = Array.isArray(bundle.r) ? bundle.r : [];
  for (const k of Object.keys(geoms)) geometryByHexKey[k] = geoms[k];

  for (let ri = 0; ri < rows.length; ri++) {
    const pr = rows[ri] || {};
    const hk = studentHexIdKeyFromProperties(pr);
    if (!hk || !geoms[hk]) continue;
    const msid = Number(
      pr.MSID != null ? pr.MSID : pr.SCHOOLS_ID != null ? pr.SCHOOLS_ID : NaN
    );
    if (isNaN(msid)) continue;
    const sk = String(msid);
    const det = studentHexDetailFromProps(pr);
    let inc = 1;
    if (pr.count != null && isFinite(Number(pr.count))) inc = Number(pr.count);
    if (!detailsByMsid[sk]) detailsByMsid[sk] = Object.create(null);
    if (!detailsByMsid[sk][hk]) detailsByMsid[sk][hk] = [];
    if (!detailsByHex[hk]) detailsByHex[hk] = [];
    for (let jd = 0; jd < inc; jd++) {
      const d = Object.assign({}, det);
      detailsByMsid[sk][hk].push(d);
      detailsByHex[hk].push(d);
    }
  }

  const centroidByHex = Object.create(null);
  for (const hk of Object.keys(geometryByHexKey)) {
    centroidByHex[hk] = polygonCentroid(geometryByHexKey[hk]);
  }

  /* Homeschool geometry fallback + counts */
  const hmGeom = Object.create(null);
  const hmKeys = Object.create(null);
  for (const f of hmFc.features || []) {
    const hk = studentHexIdKeyFromProperties(f.properties || {});
    if (!hk) continue;
    hmKeys[hk] = true;
    if (!geometryByHexKey[hk] && f.geometry && !hmGeom[hk]) {
      hmGeom[hk] = f.geometry;
      centroidByHex[hk] = polygonCentroid(f.geometry);
    }
  }

  console.log(
    "Hexes:",
    Object.keys(geometryByHexKey).length,
    "students:",
    rows.length,
    "boundaries:",
    Object.keys(boundaryByMsid).length
  );

  const outRows = [];
  const schoolIds = Object.keys(boundaryByMsid)
    .map(Number)
    .sort((a, b) => a - b);

  for (let si = 0; si < schoolIds.length; si++) {
    const msid = schoolIds[si];
    const mKey = String(msid);
    if (choiceSet[mKey] || charterSet[mKey]) continue;
    const m = masterByMsid[mKey];
    if (!m) continue;
    const cap = Number(m.factored_capacity_2025_26);
    if (!isFinite(cap) || cap <= 0) continue;
    const realUtilDec = Number(m.utilization_2025_26);
    if (!isFinite(realUtilDec)) continue;
    const bf = boundaryByMsid[mKey];
    if (!bf || !bf.geometry) continue;

    const poly = bf.geometry;
    const selected = Object.create(null);
    const layerKeys = layerKeysForSchool(msid, m);
    const ownedByOther = Object.create(null);
    for (let lki = 0; lki < layerKeys.length; lki++) {
      const ownerMap =
        owners[layerKeys[lki]] && typeof owners[layerKeys[lki]] === "object"
          ? owners[layerKeys[lki]]
          : Object.create(null);
      for (const hkOwn of Object.keys(ownerMap)) {
        const om = Number(ownerMap[hkOwn]);
        if (om === msid) selected[hkOwn] = true;
        else if (!isNaN(om) && om > 0) ownedByOther[hkOwn] = true;
      }
    }

    /* Gap student / homeschool hexes: centroid in polygon, not owned by another
       school (no empty: fillers in this export). */
    const gapCandidates = Object.keys(geometryByHexKey).concat(
      Object.keys(hmGeom)
    );
    for (let gi = 0; gi < gapCandidates.length; gi++) {
      const hk = gapCandidates[gi];
      if (selected[hk]) continue;
      if (ownedByOther[hk]) continue;
      const c = centroidByHex[hk];
      if (!c) continue;
      if (pointInPolygon(c[0], c[1], poly)) selected[hk] = true;
    }

    /* Grade toggles: grades_served ON among K–12. PK only for elementaries
       (or explicit PK in grades_served) — not secondary schools with a small
       on-site PK program (otherwise ES-zoned PK residents inflate HS util). */
    const gradeOn = Object.create(null);
    gradeOn.PK = false;
    gradeOn.__NOGRADE__ = false;
    for (let gi = 0; gi < FIXED_GRADES.length; gi++) gradeOn[FIXED_GRADES[gi]] = false;
    const served = parseGradesServedToCanonList(m.grades_served);
    for (let gi = 0; gi < served.length; gi++) {
      const g = served[gi];
      if (g === "PK" || g === "__NOGRADE__") continue;
      gradeOn[g] = true;
    }
    const lvlPk = String(m.school_level || "").toLowerCase().trim();
    let servesPk = served.indexOf("PK") !== -1;
    if (!servesPk && lvlPk === "elementary") {
      const attMapForPk = detailsByMsid[mKey] || Object.create(null);
      for (const hkPk of Object.keys(attMapForPk)) {
        const arrPk = attMapForPk[hkPk];
        for (let pi = 0; pi < arrPk.length; pi++) {
          if (canonicalStudentGradeCode(arrPk[pi].Grade) === "PK") {
            servesPk = true;
            break;
          }
        }
        if (servesPk) break;
      }
    }
    gradeOn.PK = !!servesPk;
    function gradeOk(d) {
      const g = canonicalStudentGradeCode(d.Grade);
      const canon = g || "__NOGRADE__";
      if (gradeOn[canon] !== true) return false;
      /* Match app.js: PK residence toward a secondary base only if attending that base. */
      if (canon === "PK" && lvlPk && lvlPk !== "elementary") {
        const att = parseInt(String(d.MSID != null ? d.MSID : "").trim(), 10);
        if (isNaN(att) || att !== msid) return false;
      }
      return true;
    }

    let sandboxEnr = 0;
    const selKeys = Object.keys(selected);
    for (let hi = 0; hi < selKeys.length; hi++) {
      const hk = selKeys[hi];
      const arr = detailsByHex[hk] || [];
      for (let di = 0; di < arr.length; di++) {
        const d = arr[di];
        if (!gradeOk(d)) continue;
        /* Default attendance toggles: Zoned Traditional ON (attend == that
           student's own zoned school). No zone-to-base filter. */
        if (attendanceCategory(d, charterSet, choiceSet) !== "zonedTraditional") {
          continue;
        }
        sandboxEnr++;
      }
    }

    /* Choice-in: attend base, hex outside selection, zoned ≠ base, grade on */
    let choiceIn = 0;
    const attMap = detailsByMsid[mKey] || Object.create(null);
    for (const hk of Object.keys(attMap)) {
      if (selected[hk]) continue;
      const arr = attMap[hk];
      for (let di = 0; di < arr.length; di++) {
        const d = arr[di];
        if (!gradeOk(d)) continue;
        const zoned = zonedMsidForDetailForAggregate(d);
        if (zoned != null && !isNaN(zoned) && Number(zoned) === msid) continue;
        choiceIn++;
      }
    }
    sandboxEnr += choiceIn;

    const realEnr = Number(m.sy2526_actual);
    const realUtilPct = Math.round(realUtilDec * 100);
    const sandboxUtilPct = Math.round((sandboxEnr / cap) * 100);
    const hexCount = selKeys.length;

    outRows.push({
      msid,
      school_name: m.school_name || "",
      school_level: m.school_level || "",
      real_util_pct: realUtilPct,
      sandbox_util_pct: sandboxUtilPct,
      util_delta_pp: sandboxUtilPct - realUtilPct,
      real_enrollment_sy2526: isFinite(realEnr) ? realEnr : "",
      sandbox_enrollment: sandboxEnr,
      factored_capacity_2025_26: cap,
      sandbox_hex_count: hexCount,
      sandbox_choice_in_count: choiceIn
    });

    if ((si + 1) % 10 === 0 || si === schoolIds.length - 1) {
      console.log("  processed", si + 1, "/", schoolIds.length, "boundary ids…");
    }
  }

  outRows.sort((a, b) => a.msid - b.msid);

  const cols = [
    "msid",
    "school_name",
    "school_level",
    "real_util_pct",
    "sandbox_util_pct",
    "util_delta_pp",
    "real_enrollment_sy2526",
    "sandbox_enrollment",
    "factored_capacity_2025_26",
    "sandbox_hex_count",
    "sandbox_choice_in_count"
  ];
  const lines = [cols.join(",")];
  for (const r of outRows) {
    lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  }
  fs.writeFileSync(OUT, lines.join("\n") + "\n", "utf8");
  console.log("Wrote", OUT, "(" + outRows.length + " schools)");
}

main();
