/**
 * Off-main-thread fetch + parse for school isochrones and the student hex bundle.
 * Keeps the UI (pan/zoom/menus) responsive while ~40MB of JSON is handled.
 *
 * Messages in:  { op: "iso"|"hex", url: string, id?: * }
 * Messages out: { op, id, ok: true, ...payload } | { op, id, ok: false, error: string }
 */
/* eslint-disable no-restricted-globals */
(function () {
  "use strict";

  var FEET_PER_MILE = 5280;

  function parseSchoolIsochroneName(name) {
    if (name == null || name === "") return null;
    var m = String(name).trim().match(/^(\d+)\s*:\s*0\s*-\s*(\d+)\s*$/i);
    if (!m) return null;
    var msid = parseInt(m[1], 10);
    var toBreakFt = parseInt(m[2], 10);
    if (isNaN(msid) || isNaN(toBreakFt)) return null;
    return { msid: msid, toBreakFt: toBreakFt };
  }

  function enrichIsochrones(fc) {
    if (!fc || !fc.features || !fc.features.length) {
      return { type: "FeatureCollection", features: [] };
    }
    var out = [];
    for (var i = 0; i < fc.features.length; i++) {
      var f = fc.features[i];
      if (!f) continue;
      var p = f.properties || {};
      var rawName = p.Name != null ? p.Name : p.name;
      var parsed = parseSchoolIsochroneName(rawName);
      if (!parsed) continue;
      var toBreak =
        p.ToBreak != null && p.ToBreak !== ""
          ? Number(p.ToBreak)
          : parsed.toBreakFt;
      if (isNaN(toBreak) || toBreak < 0) toBreak = parsed.toBreakFt;
      var miles = Math.round(toBreak / FEET_PER_MILE);
      if (miles < 1) miles = 1;
      else if (miles > 10) miles = 10;
      out.push({
        type: "Feature",
        geometry: f.geometry,
        properties: Object.assign({}, p, {
          iso_msid: parsed.msid,
          iso_break_ft: toBreak,
          iso_miles: miles,
        }),
      });
    }
    out.sort(function (a, b) {
      return (b.properties.iso_break_ft || 0) - (a.properties.iso_break_ft || 0);
    });
    return { type: "FeatureCollection", features: out };
  }

  function studentHexIdKeyFromProperties(p) {
    if (!p) return null;
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
    if (id != null && id !== "") return "id:" + String(id);
    return null;
  }

  function studentHexKey(feature) {
    var p = feature.properties || {};
    var fromId = studentHexIdKeyFromProperties(p);
    if (fromId) return fromId;
    return "geom:" + JSON.stringify(feature.geometry);
  }

  function expandStudentHexBundle(raw) {
    if (!raw) return null;
    if (raw.v === 2 && raw.g && Array.isArray(raw.r)) {
      var geoms = raw.g;
      var rows = raw.r;
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var pr = rows[i] || {};
        var hk = studentHexIdKeyFromProperties(pr);
        if (!hk) continue;
        var geom = geoms[hk];
        if (!geom) continue;
        out.push({ type: "Feature", properties: pr, geometry: geom });
      }
      return { type: "FeatureCollection", features: out };
    }
    if (raw.type === "FeatureCollection") return raw;
    return null;
  }

  function studentHexDetailFromProps(p) {
    var g = "";
    if (p.Grade != null && String(p.Grade).trim() !== "") {
      g = String(p.Grade).trim();
    } else if (p.grade != null && String(p.grade).trim() !== "") {
      g = String(p.grade).trim();
    } else if (p.StudGRD != null && String(p.StudGRD).trim() !== "") {
      g = String(p.StudGRD).trim();
    }
    var oid = "";
    if (p.OBJECTID != null && String(p.OBJECTID).trim() !== "") {
      oid = "o:" + String(p.OBJECTID).trim();
    } else if (p.JOIN_FID != null && String(p.JOIN_FID).trim() !== "") {
      oid = "j:" + String(p.JOIN_FID).trim();
    } else if (p.TARGET_FID != null && String(p.TARGET_FID).trim() !== "") {
      oid = "t:" + String(p.TARGET_FID).trim();
    }
    return {
      Grade: g,
      MSID: p.MSID != null ? String(p.MSID).trim() : "",
      ELEM_: p.ELEM_,
      MID_: p.MID_,
      INT_: p.INT_,
      HIGH_: p.HIGH_,
      _oid: oid,
      ethnicity: p.ethnicity != null ? String(p.ethnicity).trim() : "",
      lunch_stat: p.lunch_stat != null ? String(p.lunch_stat).trim() : "",
    };
  }

  function attendanceMsidIsCharterDistrictResidentialRange(msid) {
    var n = Number(msid);
    if (!isFinite(n) || isNaN(n)) return false;
    return n >= 6500 && n <= 6699;
  }

  function canonicalStudentGradeCode(raw) {
    if (raw == null) return null;
    var t = String(raw).trim();
    if (!t) return null;
    var u = t.toUpperCase();
    if (/^(PK|PRE-?K|PREK|VPK)$/.test(u)) return "PK";
    if (/^(K|KG|KIN|KINDERGARTEN)$/.test(u)) return "K";
    var n = parseInt(t.replace(/^0+/, "") || t, 10);
    if (isNaN(n)) return null;
    if (n === 0) return "K";
    if (n >= 1 && n <= 9) return "0" + n;
    if (n >= 10 && n <= 12) return String(n);
    return null;
  }

  function ringCentroid(ring) {
    if (!ring || ring.length < 2) return null;
    var sx = 0;
    var sy = 0;
    var n = 0;
    var lim = ring.length;
    if (
      lim > 1 &&
      ring[0][0] === ring[lim - 1][0] &&
      ring[0][1] === ring[lim - 1][1]
    ) {
      lim -= 1;
    }
    for (var i = 0; i < lim; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
      n += 1;
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
      var best = null;
      var bestLen = -1;
      for (var p = 0; p < geometry.coordinates.length; p++) {
        var ring = geometry.coordinates[p][0];
        if (!ring || ring.length < 2) continue;
        var c = ringCentroid(ring);
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

  function buildStudentHexIndex(fc) {
    var countsByMsid = {};
    var geometryByHexKey = {};
    var detailsByMsid = {};
    var detailsByHexKey = {};
    var charterDistrictHexCounts = {};
    if (!fc || !fc.features) {
      return {
        countsByMsid: countsByMsid,
        geometryByHexKey: geometryByHexKey,
        detailsByMsid: detailsByMsid,
        detailsByHexKey: detailsByHexKey,
        charterDistrictHexCounts: charterDistrictHexCounts,
        neighborsByHexKey: Object.create(null),
      };
    }
    var seq = 0;
    for (var i = 0; i < fc.features.length; i++) {
      var f = fc.features[i];
      var p = f.properties || {};
      var msid = Number(
        p.MSID != null ? p.MSID : p.SCHOOLS_ID != null ? p.SCHOOLS_ID : NaN
      );
      if (isNaN(msid)) continue;
      var key = studentHexKey(f);
      if (!geometryByHexKey[key]) geometryByHexKey[key] = f.geometry;
      var sk = String(msid);
      if (!countsByMsid[sk]) countsByMsid[sk] = {};
      var inc = 1;
      if (p.count != null && isFinite(Number(p.count))) inc = Number(p.count);
      countsByMsid[sk][key] = (countsByMsid[sk][key] || 0) + inc;
      if (attendanceMsidIsCharterDistrictResidentialRange(msid)) {
        charterDistrictHexCounts[key] =
          (charterDistrictHexCounts[key] || 0) + inc;
      }
      if (!detailsByMsid[sk]) detailsByMsid[sk] = {};
      if (!detailsByMsid[sk][key]) detailsByMsid[sk][key] = [];
      if (!detailsByHexKey[key]) detailsByHexKey[key] = [];
      var detBase = studentHexDetailFromProps(p);
      for (var jd = 0; jd < inc; jd++) {
        var detRow = jd === 0 && inc === 1 ? detBase : Object.assign({}, detBase);
        if (!detRow._oid) {
          seq += 1;
          detRow._oid = "g:" + key + ":" + sk + ":" + seq;
        }
        detailsByMsid[sk][key].push(detRow);
        detailsByHexKey[key].push(detRow);
      }
    }
    return {
      countsByMsid: countsByMsid,
      geometryByHexKey: geometryByHexKey,
      detailsByMsid: detailsByMsid,
      detailsByHexKey: detailsByHexKey,
      charterDistrictHexCounts: charterDistrictHexCounts,
      /* turf is unavailable in the worker; main thread can rebuild neighbors later if needed */
      neighborsByHexKey: Object.create(null),
    };
  }

  function buildTravelShedResidenceIndex(fc) {
    var gradeCountsByHex = {};
    var geometryByHexKey = {};
    if (!fc || !fc.features) {
      return { gradeCountsByHex: {}, centroidsByHex: {}, hexKeyList: [] };
    }
    for (var i0 = 0; i0 < fc.features.length; i0++) {
      var f0 = fc.features[i0];
      if (!f0 || !f0.geometry) continue;
      var key0 = studentHexKey(f0);
      if (!geometryByHexKey[key0]) geometryByHexKey[key0] = f0.geometry;
      var p0 = f0.properties || {};
      var inc0 = 1;
      if (p0.count != null && isFinite(Number(p0.count))) {
        inc0 = Number(p0.count);
      }
      var det0 = studentHexDetailFromProps(p0);
      var gCanon = canonicalStudentGradeCode(det0.Grade);
      if (gCanon == null || gCanon === "") gCanon = "__UNK__";
      if (!gradeCountsByHex[key0]) gradeCountsByHex[key0] = {};
      gradeCountsByHex[key0][gCanon] =
        (gradeCountsByHex[key0][gCanon] || 0) + inc0;
    }
    var centroidsByHex = {};
    var hexKeyList = [];
    for (var k0 in geometryByHexKey) {
      if (!Object.prototype.hasOwnProperty.call(geometryByHexKey, k0)) continue;
      var c0 = polygonCentroid(geometryByHexKey[k0]);
      if (c0 && c0.length === 2) {
        centroidsByHex[k0] = c0;
        hexKeyList.push(k0);
      }
    }
    return {
      gradeCountsByHex: gradeCountsByHex,
      centroidsByHex: centroidsByHex,
      hexKeyList: hexKeyList,
    };
  }

  function fail(op, id, err) {
    self.postMessage({
      op: op,
      id: id,
      ok: false,
      error: err && err.message ? String(err.message) : String(err || "error"),
    });
  }

  self.onmessage = function (ev) {
    var msg = ev.data || {};
    var op = msg.op;
    var url = msg.url;
    var id = msg.id;
    if (!op || !url) {
      fail(op || "unknown", id, new Error("Missing op or url"));
      return;
    }

    fetch(url)
      .then(function (r) {
        if (!r || !r.ok) {
          throw new Error("HTTP " + (r ? r.status : 0) + " for " + url);
        }
        return r.json();
      })
      .then(function (raw) {
        if (op === "iso") {
          self.postMessage({
            op: op,
            id: id,
            ok: true,
            fc: enrichIsochrones(raw),
          });
          return;
        }
        if (op === "hex") {
          var fc = expandStudentHexBundle(raw);
          if (!fc) {
            self.postMessage({
              op: op,
              id: id,
              ok: true,
              fc: null,
              index: null,
              travelIndex: null,
            });
            return;
          }
          var index = buildStudentHexIndex(fc);
          var travelIndex = buildTravelShedResidenceIndex(fc);
          /* Do not post the expanded FeatureCollection — structured clone of
             hundreds of thousands of features freezes the main thread. Cache
             only indexes; style reload rebuilds from indexes when needed. */
          self.postMessage({
            op: op,
            id: id,
            ok: true,
            fc: null,
            index: index,
            travelIndex: travelIndex,
            featureCount: fc.features ? fc.features.length : 0,
          });
          return;
        }
        if (op === "homeschool") {
          var counts = Object.create(null);
          var details = Object.create(null);
          var geomFallback = Object.create(null);
          var feats = raw && raw.features ? raw.features : [];
          for (var hi = 0; hi < feats.length; hi++) {
            var hf = feats[hi];
            if (!hf) continue;
            var hk = studentHexKey(hf);
            counts[hk] = (counts[hk] || 0) + 1;
            if (!details[hk]) details[hk] = [];
            var hp = hf.properties || {};
            details[hk].push({
              Grade:
                hp.Grade != null && String(hp.Grade).trim() !== ""
                  ? String(hp.Grade).trim()
                  : hp.grade != null && String(hp.grade).trim() !== ""
                    ? String(hp.grade).trim()
                    : hp.StudGRD != null && String(hp.StudGRD).trim() !== ""
                      ? String(hp.StudGRD).trim()
                      : "",
              MSID: hp.MSID != null ? String(hp.MSID).trim() : "",
            });
            if (
              hf.geometry &&
              (hf.geometry.type === "Polygon" ||
                hf.geometry.type === "MultiPolygon") &&
              !geomFallback[hk]
            ) {
              geomFallback[hk] = hf.geometry;
            }
          }
          self.postMessage({
            op: op,
            id: id,
            ok: true,
            counts: counts,
            details: details,
            geometryFallback: geomFallback,
          });
          return;
        }
        throw new Error("Unknown op: " + op);
      })
      .catch(function (err) {
        fail(op, id, err);
      });
  };
})();
