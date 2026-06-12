(function () {
  "use strict";

  var DATA = {
    es: "geo/ESBoundaries.json",
    ms: "geo/MSBoundaries.json",
    hs: "geo/HSBoundaries.json",
    schools: "geo/SchoolLocations.json",
    /** Sharded JSON index (public deploy); no single downloadable CSV. */
    masterIndex: "data/processed/school_master_index.json",
    /** Local/dev fallback when shards are missing. */
    masterCsv: "data/school_master.csv",
    sankeyEsMs: "data/processed/sankey_es_ms.json",
    /** Deduped bundle (see scripts/bundle-dedupe-student-hex.cjs) — one geometry per hex, all student rows. */
    studentHexagons: "geo/StudentHexagons.bundle.json",
    schoolParcels: "geo/SchoolParcels.geojson",
    schoolBoardDistricts: "geo/SchoolBoardDistricts.geojson",
    municipalBoundaries: "geo/MunicipalBoundaries.geojson",
    charterSchoolLocations: "geo/CharterSchoolLocations.geojson",
    privateSchoolLocations: "geo/PrivateSchools.json",
    /** Homeschool students joined to hex grid (GRID_ID); one polygon row per student in source export. */
    homeschoolStudentHexagons: "geo/HomeschoolStudentHexagons.geojson",
    /** Meadowlane Primary/Intermediate grade-band capture overrides (see notes inside file). */
    meadowlaneCaptureOverride: "data/processed/meadowlane_capture_override.json",
    /** K-12 ESE feeder matrix (columns = program destinations per school row). */
    eseFeederMatrix: "data/processed/ese_feeder_matrix.json",
    /** Network isochrones (1–10 mi by school); "Name" encodes MSID and ToBreak in feet. */
    schoolIsochrones: "geo/SchoolIsochrones.geojson",
    /** On-site BPS employee counts by MSID (see scripts/export_bps_employee_count_from_xlsx.py). */
    bpsEmployeeCount: "data/processed/bps_employee_count_by_msid.json",
  };

  /**
   * Wraps fetch() to reuse promises started by the inline prefetch script in
   * index.html (window.__prefetchPromises). Returns a Response-shaped object
   * so existing call sites that do `.then(r => r.json())` or
   * `.then(r => r.ok ? r.json() : null)` keep working unchanged.
   *
   * Cached values: parsed JSON (for json) or string (for text). A null/'' cache
   * value indicates the prefetch failed; we expose ok=false and reject
   * .json()/.text() so the caller's existing null/catch handling takes over.
   *
   * @param {string} path
   * @param {"json"|"text"} [parseAs] defaults to "json"
   * @returns {Promise<Response|{ok:boolean, status:number, json:()=>Promise, text:()=>Promise}>}
   */
  function smartFetch(path, parseAs) {
    var mode = parseAs === "text" ? "text" : "json";
    var bag = typeof window !== "undefined" ? window.__prefetchPromises : null;
    var cached = bag ? bag[path] : null;
    if (cached) {
      return cached.then(function (data) {
        var hasData =
          data !== null &&
          data !== undefined &&
          !(mode === "text" && data === "");
        return {
          ok: !!hasData,
          status: hasData ? 200 : 0,
          json: function () {
            if (!hasData) {
              return Promise.reject(
                new Error("Prefetch returned no data for " + path)
              );
            }
            return Promise.resolve(data);
          },
          text: function () {
            if (!hasData) {
              return Promise.reject(
                new Error("Prefetch returned no data for " + path)
              );
            }
            return Promise.resolve(data);
          },
        };
      });
    }
    return fetch(path);
  }

  var FEET_PER_MILE = 5280;
  /** US survey / international foot–based conversion (Turf geodesic area in m² → sq mi for student density). */
  var SQ_METERS_PER_SQ_MI = 2589988.110336;
  /** Histogram bucket width for travel-distance charts (miles). */
  var TRAVEL_BIN_MI = 0.25;
  /** Median line and label (flag) for travel histograms. */
  var TRAVEL_MEDIAN_COLOR = "#dc2626";
  /** Mean / average line and label. */
  var TRAVEL_MEAN_COLOR = "#2563eb";

  /** Mapbox access token — set in gitignored `config.local.js` (see `config.local.js.example`). */
  var MAPBOX_ACCESS_TOKEN =
    (typeof window !== "undefined" && window.MAPBOX_ACCESS_TOKEN) || "";
  var MAPBOX_STYLES = {
    light: "mapbox://styles/mapbox/light-v11",
    streets: "mapbox://styles/mapbox/streets-v12",
    satellite: "mapbox://styles/mapbox/satellite-v9",
  };
  /** Sentinel for municipal hover line layer filter when nothing is highlighted. */
  var MUN_HOVER_FILTER_OFF = "__mun_hover_off__";
  /** Cached Promise.all results so basemap style switches can re-add GeoJSON layers. */
  var geoJsonDataCache = null;
  /** Meadowlane 2031/2041 capture numerators/denominators; null until fetch completes. */
  var MEADOWLANE_CAPTURE_OVERRIDE = null;

  /**
   * @param {string} text
   * @returns {string[][]}
   */
  function parseCsvRows(text) {
    var rows = [];
    var row = [];
    var cur = "";
    var inQ = false;
    if (!text) return rows;
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQ = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === '"') {
          inQ = true;
        } else if (c === ",") {
          row.push(cur);
          cur = "";
        } else if (c === "\n") {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = "";
        } else if (c === "\r") {
          /* ignore */
        } else {
          cur += c;
        }
      }
    }
    row.push(cur);
    if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
      rows.push(row);
    }
    return rows;
  }

  /**
   * @param {string} text raw CSV
   * @returns {Object<string, Object>|null} keyed by MSID string
   */
  function parseSchoolMasterCsv(text) {
    var grid = parseCsvRows(text);
    if (!grid || grid.length < 2) return null;
    var headers = grid[0].map(function (h) {
      return String(h).trim();
    });
    var byMsid = {};
    for (var r = 1; r < grid.length; r++) {
      var cells = grid[r];
      if (!cells || !cells.length) continue;
      var obj = {};
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = cells[c] != null ? String(cells[c]).trim() : "";
      }
      var idRaw = obj.msid != null ? String(obj.msid).trim() : "";
      if (!idRaw) continue;
      var idNum = parseInt(idRaw, 10);
      if (isNaN(idNum)) continue;
      var idPadded = String(idNum).padStart(4, "0");
      var idUnpadded = String(idNum);
      obj.msid = idPadded;
      byMsid[idPadded] = obj;
      byMsid[idUnpadded] = obj;
    }
    return byMsid;
  }

  /**
   * Merges one shard object into MASTER_BY_MSID (padded + unpadded MSID keys).
   * @param {Object<string, Object>} into
   * @param {Object<string, Object>|null} shard
   * @returns {Object<string, Object>}
   */
  function mergeSchoolMasterShard(into, shard) {
    if (!shard) return into;
    Object.keys(shard).forEach(function (k) {
      var obj = shard[k];
      if (!obj || obj.msid == null) return;
      var idNum = parseInt(String(obj.msid).trim(), 10);
      if (isNaN(idNum)) return;
      var idPadded = String(idNum).padStart(4, "0");
      var idUnpadded = String(idNum);
      var row = Object.assign({}, obj, { msid: idPadded });
      into[idPadded] = row;
      into[idUnpadded] = row;
    });
    return into;
  }

  /**
   * Loads school stats from sharded JSON on the public site; falls back to CSV locally.
   * @returns {Promise<Object<string, Object>|null>}
   */
  function loadSchoolMasterByMsid() {
    return smartFetch(DATA.masterIndex, "json")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (idx) {
        if (!idx || !idx.shards || !idx.shards.length) {
          return smartFetch(DATA.masterCsv, "text")
            .then(function (r) {
              return r.ok ? r.text() : "";
            })
            .then(function (text) {
              return parseSchoolMasterCsv(text);
            });
        }
        return Promise.all(
          idx.shards.map(function (path) {
            return smartFetch(path, "json")
              .then(function (r) {
                return r.ok ? r.json() : null;
              })
              .catch(function () {
                return null;
              });
          })
        ).then(function (parts) {
          var byMsid = {};
          for (var i = 0; i < parts.length; i++) {
            mergeSchoolMasterShard(byMsid, parts[i]);
          }
          return Object.keys(byMsid).length ? byMsid : null;
        });
      })
      .catch(function () {
        return null;
      });
  }

  /** @returns {Object|null} */
  function masterRow(msid) {
    if (msid == null || isNaN(msid) || !MASTER_BY_MSID) return null;
    return MASTER_BY_MSID[String(msid)] || null;
  }

  /** Formatted count from data/processed/bps_employee_count_by_msid.json, or "—". */
  function bpsOnSiteEmployeeCountDisplay(msid) {
    if (msid == null || isNaN(Number(msid)) || !BPS_EMPLOYEE_COUNT_BY_MSID) {
      return "—";
    }
    var map = BPS_EMPLOYEE_COUNT_BY_MSID;
    var n = Number(msid);
    var keys = [String(n), String(n).padStart(4, "0")];
    var raw = null;
    for (var ki = 0; ki < keys.length; ki++) {
      if (Object.prototype.hasOwnProperty.call(map, keys[ki])) {
        raw = map[keys[ki]];
        break;
      }
    }
    if (raw == null || raw === "") return "—";
    var num = Number(raw);
    if (isNaN(num)) return "—";
    return num.toLocaleString();
  }

  function schoolLevelToTypeString(level) {
    var lv = String(level || "").toLowerCase();
    if (lv === "elementary") return "ELEMENTARY";
    if (lv === "middle") return "MIDDLE";
    if (lv === "high") return "HIGH";
    if (lv === "jr_sr_high") return "JR SR HIGH";
    return "";
  }

  /** Overlays TYPE from master CSV school_level when present (single source of truth). */
  function schoolPropsWithMasterType(p) {
    if (!p) return p;
    var msid = p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : NaN;
    var m = masterRow(msid);
    var t = m && schoolLevelToTypeString(m.school_level);
    if (t) return Object.assign({}, p, { TYPE: t });
    return p;
  }

  /** Applies master TYPE to every school feature so map layers and parcels match CSV (e.g. 7–12). */
  function enrichSchoolsFcWithMasterType(schoolsFc) {
    if (!schoolsFc || !schoolsFc.features || !schoolsFc.features.length) {
      return schoolsFc;
    }
    return {
      type: "FeatureCollection",
      features: schoolsFc.features.map(function (ft) {
        var p = ft.properties;
        var merged = schoolPropsWithMasterType(p) || p;
        /* Short-form name used by the map label symbol layer (e.g., "Golfview ES"). */
        var withLabel = Object.assign({}, merged, {
          _mapLabel: schoolShortNameFromProps(merged),
        });
        return Object.assign({}, ft, { properties: withLabel });
      }),
    };
  }

  /** @returns {{ ethnicity: Object<string, number>, lunchStatus: Object<string, number> }|null} */
  function demographicsObjectsFromMaster(m) {
    if (!m) return null;
    var eth = {};
    var lunch = {};
    for (var i = 0; i < DEMO_ETH_SLUGS.length; i++) {
      var d = DEMO_ETH_SLUGS[i];
      var v = m[d.slug];
      if (v !== "" && v != null && !isNaN(Number(v))) {
        var n = Number(v);
        if (n > 0) eth[d.label] = n;
      }
    }
    for (var j = 0; j < DEMO_LUNCH_SLUGS.length; j++) {
      var e = DEMO_LUNCH_SLUGS[j];
      var w = m[e.slug];
      if (w !== "" && w != null && !isNaN(Number(w))) {
        lunch[e.label] = Number(w);
      }
    }
    return { ethnicity: eth, lunchStatus: lunch };
  }

  function projectedColumnForSyLabel(label) {
    return "projected_" + String(label).replace(/-/g, "_");
  }

  /** Set after GeoJSON loads; used to zoom to assignment boundaries. */
  var GEO_CACHE = {
    es: null,
    ms: null,
    hs: null,
    schools: null,
    charter: null,
    private: null,
  };
  /** Enriched `SchoolIsochrones.geojson` (parsed Name → iso_msid, iso_miles, etc.); set from fetch. */
  var SCHOOL_ISOCHRONES_ENRICHED = null;
  /** Parsed rows from data/school_master.csv keyed by MSID string; null if missing or failed to load. */
  var MASTER_BY_MSID = null;
  /** From data/processed/ese_feeder_matrix.json; null if missing or failed to load. */
  var ESE_FEEDER_MATRIX = null;
  /** From data/processed/bps_employee_count_by_msid.json; null if missing or failed to load. */
  var BPS_EMPLOYEE_COUNT_BY_MSID = null;
  /** SCHOOLS_ID keys for `SchAB_Type === "CHOICE"` from SchoolLocations (capture KPI). */
  var CHOICE_SCHOOL_MSIDS = null;
  /** SCHOOLS_ID keys for charter schools (TYPE/SchAB_Type CHARTER on boundary + charter location layers). */
  var CHARTER_SCHOOL_MSIDS = null;
  /**
   * Charter MSID string → "K–5" style span from student-hex rows where attendance MSID matches
   * (min–max grade among students, treating gaps as consecutive for display).
   */
  var CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID = null;
  /** Projected school-year column labels (matches CSV projected_* headers). */
  var MASTER_PROJECTION_LABELS = ["2026-27", "2027-28", "2028-29", "2029-30", "2030-31"];
  /** Slugs and display labels for ethnicity count columns in the master CSV. */
  var DEMO_ETH_SLUGS = [
    { slug: "eth_hawaiian_native_pacific_islander", label: "Hawaiian Native/Pacific Islander" },
    { slug: "eth_asian", label: "Asian" },
    { slug: "eth_black_non_hispanic", label: "Black, Non-Hispanic" },
    { slug: "eth_hispanic", label: "Hispanic" },
    { slug: "eth_amer_indian_or_alaskan_native", label: "Amer. Indian or Alaskan Native" },
    { slug: "eth_multi_racial", label: "Multi-Racial" },
    { slug: "eth_white_non_hispanic", label: "White, Non-Hispanic" },
  ];
  var DEMO_LUNCH_SLUGS = [
    { slug: "lunch_not_free_reduced", label: "Not free/reduced" },
    { slug: "lunch_free", label: "Free" },
    { slug: "lunch_reduced", label: "Reduced" },
  ];
  /** ES→MS flows from SankeyFlowHelper export; null if missing. */
  var SANKEY_CACHE = null;
  /** Travel impact triples [attendance_msid, scenario_msid, ft] per middle workbook; see DATA.travelImpact. */
  var TRAVEL_IMPACT_ALL = null;
  /** Map string MSID -> true where GeoJSON(+master) TYPE is middle school (non–Jr/Sr high). */
  var MIDDLE_SCHOOL_MSID_SET = null;
  /**
   * Student hex overlay index: counts + geometry by hex key, per-student detail rows
   * (Grade, MSID attendance, zoned ELEM_/MID_/INT_/HIGH_), and districtwide charter hex counts
   * (attendance MSID 6500–6699).
   */
  var STUDENT_HEX_INDEX = null;
  /** Per-hex homeschool student counts (`studentHexKey` → count), from homeschool GeoJSON. */
  var HOMESCHOOL_HEX_COUNTS = null;
  /**
   * Hex geometries from homeschool export for IDs missing from `STUDENT_HEX_INDEX.geometryByHexKey`
   * (bundle-first resolution in `homeschoolHexGeometry`).
   */
  var HOMESCHOOL_HEX_GEOMETRY_FALLBACK = null;
  /**
   * Synthetic "filler" hex geometries (hexKey → Polygon) generated from the
   * student-hex grid so the boundary sandbox map has no swiss-cheese holes
   * where no students happen to live. These keys are prefixed `empty:` and
   * contribute 0 students to every aggregation; they exist solely to make
   * lasso/paintbrush selections look contiguous. Built once after the
   * student-hex index loads (see `buildEmptyHexGeometryMesh`). */
  var EMPTY_HEX_GEOMETRY = null;
  /**
   * Per-hex arrays of sandbox detail rows for homeschool students (`studentHexKey` → rows).
   * Built from homeschool GeoJSON when layers refresh.
   */
  var HOMESCHOOL_DETAILS_BY_HEX_KEY = null;
  /** Canonical attendance MSID for homeschool (district lookup / exports). */
  var HOMESCHOOL_ATTENDANCE_MSID = 9998;
  /** Lazily filled: assignment MSID string → homeschool student count in that polygon (centroid-in-boundary). */
  var homeschoolInBoundaryByMsidCache = Object.create(null);

  function clearHomeschoolInBoundaryCountCache() {
    homeschoolInBoundaryByMsidCache = Object.create(null);
  }
  /**
   * All student residence rows (any MSID): per-hex grade tallies + hex centroids
   * for travel-shed tooltips (centroid-in-isochrone, districtwide).
   */
  var TRAVEL_SHED_RESIDENCE_INDEX = null;
  /** @type {number|undefined} */
  var travelShedResidenceDebounceId = null;
  /** Incremented to drop stale travel-shed count results after rapid cursor moves. */
  var travelShedResidenceHoverGen = 0;
  /** Dropdown- or map-driven selection; kept in sync with #school-select. */
  var selectedSchoolMsid = null;
  /**
   * When a map click applies #school-select, the next `applyExistingSchoolFromSelectValue` run uses
   * this: "centerOnSchool" = pan only; "assignment" = fit assignment (dropdown default, boundary picks).
   */
  var pendingMapSelectFrame = null;
  /** { source, id } for assignment outline emphasis when a school is chosen from the dropdown. */
  var selectedAssignmentBoundary = null;

  /** Scenario Testing: consolidated tool state. `scenarioMiddleMsid` is kept as the variable
   *  name for backward compatibility but actually represents the "base receiving school" MSID,
   *  which can now be any traditional school with an assignment boundary (not just middle/Jr-Sr). */
  var scenarioSchoolByMsid = null;
  var scenarioMiddleMsid = null;
  var scenarioLastFeederRows = [];
  var scenarioFeederChecked = {};
  /** When true, the candidate-schools list is restricted to existing matriculation feeder
   *  chain members of the base school; the "Complete merger" control becomes visible. */
  var scenarioUseFeederChainOnly = false;
  /** MSIDs the user has explicitly added to the contributing-schools list via the
   *  "Add another school" search input. Only honored when scenarioUseFeederChainOnly is
   *  false (turning on feeder-chain mode clears this list). Order preserves insert order. */
  var scenarioUserAddedFeederMsids = [];
  /** Per-(school × grade) toggles for non-base contributing schools. The base school's grades
   *  are implicitly always on. Shape: { [msid]: { [gradeCanon]: boolean } } */
  var scenarioGradeCheckedByMsid = Object.create(null);
  /** MSIDs last given map feature-state `scenarioFeeder`; cleared before each update. */
  var lastScenarioFeederHighlightMsids = [];
  /** `{ source, id }` for assignment polygon `feature-state: scenarioRelevant`; cleared in scenario or when leaving the view. */
  var lastScenarioBoundaryRelevant = [];
  /** When true, each selected school counts at 100%; when false, use flow proportion × enrollment.
   *  Only meaningful when scenarioUseFeederChainOnly is also true. */
  var scenarioCompleteMerger = false;
  /** Set to false to restore the single aggregated bar chart on the Scenario page. */
  var SCENARIO_USE_STACKED_ENROLLMENT_CHART = true;
  /** Cached schools FeatureCollection passed to runScenarioForMiddleMsid; needed when toggling feeder-chain mode. */
  var scenarioCachedSchoolsFc = null;

  /** Default school year for the by-grade summary table when no bar is hovered/locked. */
  var SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL = "2025-26";
  /** Bar currently under the mouse cursor in the stacked enrollment chart (period label). */
  var scenarioGradeSummaryHoverLabel = null;
  /** Bar currently click-locked in the stacked enrollment chart (period label). */
  var scenarioGradeSummaryLockedLabel = null;

  /** Fixed palette for the up-to-5 sandbox boundaries. Distinct hues with similar saturation. */
  var SANDBOX_BOUNDARY_PALETTE = [
    { id: "b1", fill: "#84cc16", outline: "#65a30d" }, /* lime */
    { id: "b2", fill: "#06b6d4", outline: "#0e7490" }, /* cyan */
    { id: "b3", fill: "#f97316", outline: "#c2410c" }, /* orange */
    { id: "b4", fill: "#a855f7", outline: "#7e22ce" }, /* violet */
    { id: "b5", fill: "#ec4899", outline: "#be185d" }  /* pink */
  ];
  var SANDBOX_MAX_BOUNDARIES = 5;

  /**
   * Boundary Sandbox state. Now supports up to 5 simultaneous, non-overlapping boundaries.
   * Each entry in `boundaries` owns its own selectedHexKeys, confirmedHexKeysSnapshot,
   * gradeToggles, attendanceTypeToggles, schoolListExpanded, lassoRegionFootprintFeature,
   * baseMsid, color, and name. `selectionConfirmed` is treated as always-on (legacy field).
   *
   * For backward compatibility with the large body of single-selection code, the legacy
   * single-selection properties (`selectedHexKeys`, `confirmedHexKeysSnapshot`,
   * `gradeToggles`, `attendanceTypeToggles`, `schoolListExpanded`, `lassoRegionFootprintFeature`,
   * `selectionConfirmed`) are exposed as Object.defineProperty getters/setters that proxy
   * onto the currently active boundary. Code that reads/writes these continues to work.
   */
  var BOUNDARY_SANDBOX = {
    /** @type {Array<{id:string, name:string, color:string, outline:string, baseMsid:number|null, selectedHexKeys:Object<string,boolean>, confirmedHexKeysSnapshot:Object<string,boolean>, gradeToggles:Object<string,boolean|undefined>, attendanceTypeToggles:Object<string,boolean|undefined>, schoolListExpanded:{attendance:boolean,zoned:boolean}, lassoRegionFootprintFeature:Object|null }>} */
    boundaries: [],
    /** @type {string|null} */
    activeBoundaryId: null,
  };

  /** @returns {Object|null} */
  function sandboxActiveBoundary() {
    if (!BOUNDARY_SANDBOX.boundaries.length) return null;
    var id = BOUNDARY_SANDBOX.activeBoundaryId;
    if (!id) return BOUNDARY_SANDBOX.boundaries[0];
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      if (BOUNDARY_SANDBOX.boundaries[i].id === id) {
        return BOUNDARY_SANDBOX.boundaries[i];
      }
    }
    return BOUNDARY_SANDBOX.boundaries[0];
  }

  /** Returns the FIRST boundary that currently owns `hexKey`, or null.
   *  Hexes may now be owned by multiple boundaries simultaneously when the
   *  owners' enabled grade ranges do not overlap (see `sandboxBoundariesOwningHex`).
   *  Legacy callers that only need to know "is this hex used somewhere" still
   *  work with the single-owner return. */
  function sandboxBoundaryOwningHex(hexKey) {
    if (!hexKey) return null;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      if (BOUNDARY_SANDBOX.boundaries[i].selectedHexKeys[hexKey]) {
        return BOUNDARY_SANDBOX.boundaries[i];
      }
    }
    return null;
  }

  /** Returns all boundaries that currently own `hexKey` (zero or more). */
  function sandboxBoundariesOwningHex(hexKey) {
    var out = [];
    if (!hexKey) return out;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      if (BOUNDARY_SANDBOX.boundaries[i].selectedHexKeys[hexKey]) {
        out.push(BOUNDARY_SANDBOX.boundaries[i]);
      }
    }
    return out;
  }

  /** Returns the first boundary owning `hexKey` whose id is NOT `excludeId`,
   *  or null. Used to repaint the hex when one owner removes it. */
  function sandboxBoundaryOwningHexExcluding(hexKey, excludeId) {
    if (!hexKey) return null;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      var b = BOUNDARY_SANDBOX.boundaries[i];
      if (b.id === excludeId) continue;
      if (b.selectedHexKeys[hexKey]) return b;
    }
    return null;
  }

  /** Fixed K-12 list used for grade-overlap conflict checks between boundaries. */
  var SANDBOX_FIXED_GRADE_CHIPS = [
    "K", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"
  ];

  /** Grade buckets that start unchecked on every boundary (still selectable). */
  var SANDBOX_DEFAULT_OFF_GRADES = ["PK", "__NOGRADE__"];
  /** Attendance-type buckets that start unchecked on every boundary. */
  var SANDBOX_DEFAULT_OFF_ATTENDANCE_TYPES = ["charter", "choice", "homeschool"];
  /** Per-boundary grade-chip strip order: PK first, then K-12, then No-grade. */
  var SANDBOX_BOUNDARY_GRADE_CHIPS = ["PK"]
    .concat(SANDBOX_FIXED_GRADE_CHIPS)
    .concat(["__NOGRADE__"]);

  function sandboxDefaultGradeIncluded(gradeCanon) {
    return SANDBOX_DEFAULT_OFF_GRADES.indexOf(gradeCanon) === -1;
  }
  function sandboxDefaultAttendanceTypeIncluded(atype) {
    return SANDBOX_DEFAULT_OFF_ATTENDANCE_TYPES.indexOf(atype) === -1;
  }
  /** Fresh gradeToggles object pre-seeded with the default-off grade buckets. */
  function sandboxMakeDefaultGradeToggles() {
    var t = Object.create(null);
    for (var i = 0; i < SANDBOX_DEFAULT_OFF_GRADES.length; i++) {
      t[SANDBOX_DEFAULT_OFF_GRADES[i]] = false;
    }
    return t;
  }
  /** Fresh attendanceTypeToggles object pre-seeded with the default-off types. */
  function sandboxMakeDefaultAttendanceTypeToggles() {
    var t = Object.create(null);
    for (var i = 0; i < SANDBOX_DEFAULT_OFF_ATTENDANCE_TYPES.length; i++) {
      t[SANDBOX_DEFAULT_OFF_ATTENDANCE_TYPES[i]] = false;
    }
    return t;
  }

  /** Returns the set of grade codes (from SANDBOX_FIXED_GRADE_CHIPS) that are
   *  *enabled* on boundary `b` — i.e., gradeToggles[g] !== false. New
   *  boundaries default to all grades on. */
  function sandboxEnabledFixedGradeSet(b) {
    var set = Object.create(null);
    if (!b) return set;
    var t = b.gradeToggles || Object.create(null);
    for (var i = 0; i < SANDBOX_FIXED_GRADE_CHIPS.length; i++) {
      var g = SANDBOX_FIXED_GRADE_CHIPS[i];
      if (t[g] !== false) set[g] = true;
    }
    return set;
  }

  /** True iff adding `hexKey` to `boundary` would conflict on enabled grades
   *  with any *other* boundary that already owns the hex. */
  function sandboxHexOverlapWouldConflict(hexKey, boundary) {
    if (!boundary || !hexKey) return false;
    var mine = sandboxEnabledFixedGradeSet(boundary);
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      var other = BOUNDARY_SANDBOX.boundaries[i];
      if (other.id === boundary.id) continue;
      if (!other.selectedHexKeys[hexKey]) continue;
      var theirs = sandboxEnabledFixedGradeSet(other);
      for (var g in mine) {
        if (theirs[g]) return true;
      }
    }
    return false;
  }

  /* Per-hex cache: true iff hex centroid falls inside ANY school assignment
     polygon (i.e., somewhere inside the district's serviced county area).
     Used by the sandbox to reject clicks/lasso over the ocean or outside the
     county. Populated lazily; cleared on boundary/data reloads. */
  var SANDBOX_HEX_IN_COUNTY_CACHE = Object.create(null);

  function resetSandboxHexInCountyCache() {
    SANDBOX_HEX_IN_COUNTY_CACHE = Object.create(null);
  }

  /** Returns the cached list of all assignment-boundary features (ES + MS +
   *  HS combined) as turf-compatible polygon features. Returns null if turf
   *  is unavailable or no boundaries have loaded yet. */
  function sandboxAllAssignmentBoundaryFeatures() {
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return null;
    }
    if (!GEO_CACHE) return null;
    var sources = [GEO_CACHE.es, GEO_CACHE.ms, GEO_CACHE.hs];
    var feats = [];
    for (var s = 0; s < sources.length; s++) {
      var fc = sources[s];
      if (!fc || !fc.features) continue;
      for (var f = 0; f < fc.features.length; f++) {
        var ft = fc.features[f];
        if (ft && ft.geometry) feats.push(ft);
      }
    }
    return feats.length ? feats : null;
  }

  /** True iff the hex's centroid lies inside ANY school's assignment polygon
   *  (ES, MS, or HS). Used to keep sandbox selection within the district's
   *  serviced area — clicks/lassos over the ocean or out-of-county land are
   *  silently ignored. When boundaries are not yet loaded, returns true so
   *  the sandbox stays usable. */
  function sandboxHexCentroidIsInsideAnyAssignmentBoundary(hexKey) {
    if (!hexKey) return false;
    var key = String(hexKey);
    if (SANDBOX_HEX_IN_COUNTY_CACHE[key] !== undefined) {
      return SANDBOX_HEX_IN_COUNTY_CACHE[key];
    }
    var feats = sandboxAllAssignmentBoundaryFeatures();
    if (!feats) {
      /* Boundaries not loaded — don't block selection. */
      return true;
    }
    var geom = homeschoolHexGeometry(key);
    if (!geom) return false;
    var ctr = polygonCentroid(geom);
    if (!ctr || ctr.length < 2) {
      SANDBOX_HEX_IN_COUNTY_CACHE[key] = false;
      return false;
    }
    var pt = turf.point(ctr);
    for (var i = 0; i < feats.length; i++) {
      try {
        if (turf.booleanPointInPolygon(pt, feats[i])) {
          SANDBOX_HEX_IN_COUNTY_CACHE[key] = true;
          return true;
        }
      } catch (e) {
        /* skip malformed polygon */
      }
    }
    SANDBOX_HEX_IN_COUNTY_CACHE[key] = false;
    return false;
  }

  /** True iff enabling `grade` on `boundary` would create a grade-overlap
   *  conflict on at least one shared hex with another boundary that already
   *  has `grade` enabled. Used to validate chip toggles. */
  function sandboxEnablingGradeWouldConflict(boundary, grade) {
    if (!boundary || !grade) return false;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      var other = BOUNDARY_SANDBOX.boundaries[i];
      if (other.id === boundary.id) continue;
      if (sandboxEnabledFixedGradeSet(other)[grade] !== true) continue;
      for (var hk in boundary.selectedHexKeys) {
        if (other.selectedHexKeys[hk]) return true;
      }
    }
    return false;
  }

  /** Build a new empty boundary record. */
  function sandboxMakeBoundaryRecord(slotIndex, customName) {
    var pal = SANDBOX_BOUNDARY_PALETTE[slotIndex % SANDBOX_BOUNDARY_PALETTE.length];
    return {
      id: pal.id,
      name: (customName && String(customName).trim()) || ("Boundary " + (slotIndex + 1)),
      color: pal.fill,
      outline: pal.outline,
      baseMsid: null,
      selectedHexKeys: Object.create(null),
      confirmedHexKeysSnapshot: Object.create(null),
      gradeToggles: sandboxMakeDefaultGradeToggles(),
      attendanceTypeToggles: sandboxMakeDefaultAttendanceTypeToggles(),
      schoolListExpanded: { attendance: false, zoned: false },
      lassoRegionFootprintFeature: null,
    };
  }

  /* Backward-compatible proxy properties: most existing sandbox code reads/writes
     BOUNDARY_SANDBOX.selectedHexKeys, etc. These accessors route to the active boundary
     so existing code keeps working without invasive rewrites. */
  function defineActiveBoundaryProxy(prop, fallback) {
    Object.defineProperty(BOUNDARY_SANDBOX, prop, {
      configurable: true,
      enumerable: true,
      get: function () {
        var b = sandboxActiveBoundary();
        return b ? b[prop] : fallback();
      },
      set: function (v) {
        var b = sandboxActiveBoundary();
        if (b) b[prop] = v;
      },
    });
  }
  defineActiveBoundaryProxy("selectedHexKeys", function () { return Object.create(null); });
  defineActiveBoundaryProxy("confirmedHexKeysSnapshot", function () { return Object.create(null); });
  defineActiveBoundaryProxy("gradeToggles", function () { return Object.create(null); });
  defineActiveBoundaryProxy("attendanceTypeToggles", function () { return Object.create(null); });
  defineActiveBoundaryProxy("schoolListExpanded", function () { return { attendance: false, zoned: false }; });
  defineActiveBoundaryProxy("lassoRegionFootprintFeature", function () { return null; });

  /* `selectionConfirmed` is treated as always-true when there are selections in the active
     boundary (the live selection drives the stats and outline). Setter is a no-op. */
  Object.defineProperty(BOUNDARY_SANDBOX, "selectionConfirmed", {
    configurable: true,
    enumerable: true,
    get: function () {
      var b = sandboxActiveBoundary();
      if (!b) return false;
      for (var k in b.selectedHexKeys) {
        if (b.selectedHexKeys[k]) return true;
      }
      return false;
    },
    set: function () { /* no-op */ },
  });

  /**
   * Paint: drag uses Select (add) / Erase (remove); click-to-toggle when pointer did not drag.
   * @type {{ active: boolean, lastKey: string|null, startX: number, startY: number, clickKey: string|null, isDrag: boolean }}
   */
  var BOUNDARY_SANDBOX_PAINT = {
    active: false,
    lastKey: null,
    startX: 0,
    startY: 0,
    clickKey: null,
    isDrag: false,
  };
  /** @const Compare squared distance to 5px drag threshold. */
  var BOUNDARY_SANDBOX_BRUSH_DRAG_THRESH2 = 25;
  /** @type {{ active: boolean, points: [number, number][]|null }} */
  var BOUNDARY_SANDBOX_LASSO = { active: false, points: null };

  /* Touch "Draw" mode (phones only): when true, one-finger drags draw on the
     map instead of panning. Toggled by the mobile Pan/Draw control. On desktop
     this stays false (mouse drawing already works). */
  var BOUNDARY_SANDBOX_TOUCH_DRAW = false;

  /** No-op until setupMapInteractions wires the density tooltip popup. */
  var dismissStudentHexDensityTooltip = function () {};

  /** Show/disable the density-tooltip control when either student or charter residence density is on. */
  function syncStudentHexTooltipCheckboxVisibility() {
    var row = document.getElementById("student-hex-tooltip-row");
    var main = document.getElementById("toggle-student-hex");
    var ch = document.getElementById("toggle-charter-student-hex");
    var hm = document.getElementById("toggle-homeschool-student-hex");
    var tt = document.getElementById("toggle-student-hex-density-tooltip");
    var modeWrap = document.getElementById("student-hex-residence-modes");
    if (!row) return;
    var anyDensityOn =
      (!!main && main.checked) || (!!ch && ch.checked) || (!!hm && hm.checked);
    row.hidden = !anyDensityOn;
    if (tt) {
      tt.disabled = !anyDensityOn;
    }
    if (modeWrap) {
      modeWrap.classList.toggle("student-hex-residence-modes--inactive", !main || !main.checked);
    }
    if (!anyDensityOn) dismissStudentHexDensityTooltip();
    syncMapDensityLegend();
  }

  var mapDensityLegendValueRefreshHandle = null;
  var mapDensityLegendViewListenersSet = false;

  function getMapDensityLegendVisibility() {
    var stuInp = document.getElementById("toggle-student-hex");
    var chInp = document.getElementById("toggle-charter-student-hex");
    var hmInp = document.getElementById("toggle-homeschool-student-hex");
    var stuOn = !!(stuInp && stuInp.checked);
    var chOn = !!(chInp && chInp.checked);
    var hmOn = !!(hmInp && hmInp.checked);
    var stuVis = stuOn;
    var chVis = chOn;
    var hmVis = hmOn;
    if (map && map.getLayer) {
      try {
        if (map.getLayer("student-hex-heatmap")) {
          stuVis =
            stuOn && map.getLayoutProperty("student-hex-heatmap", "visibility") === "visible";
        }
      } catch (e0) {
        /* ignore */
      }
      try {
        if (map.getLayer("charter-student-hex-heatmap")) {
          chVis =
            chOn && map.getLayoutProperty("charter-student-hex-heatmap", "visibility") === "visible";
        }
      } catch (e1) {
        /* ignore */
      }
      try {
        if (map.getLayer("homeschool-student-hex-heatmap")) {
          hmVis =
            hmOn && map.getLayoutProperty("homeschool-student-hex-heatmap", "visibility") === "visible";
        }
      } catch (e2) {
        /* ignore */
      }
    }
    return { stu: stuVis, ch: chVis, hm: hmVis };
  }

  function formatMapLegendStudentsPerSqMi(n) {
    if (n == null || !isFinite(n)) {
      return "—";
    }
    return Math.round(Number(n)).toLocaleString();
  }

  /**
   * Min/max of neighborhood-mean students/sq mi (center hex + adjacents) for each hex
   * centroid in the viewport — matches tooltip / smoothed treatment.
   */
  function minMaxNeighborhoodSchoolDensitiesInViewForLegend() {
    if (!map || !map.getSource || !map.getSource("student-hex")) {
      return { min: null, max: null };
    }
    var b;
    try {
      b = map.getBounds();
    } catch (e) {
      return { min: null, max: null };
    }
    if (!b) {
      return { min: null, max: null };
    }
    var features;
    try {
      features = map.querySourceFeatures("student-hex", {});
    } catch (e2) {
      return { min: null, max: null };
    }
    if (!features || !features.length) {
      return { min: null, max: null };
    }
    var preIdx = buildStudentHexDisplayCountsByHex();
    if (preIdx == null) {
      preIdx = Object.create(null);
    }
    var minC = null;
    var maxC = null;
    for (var i = 0; i < features.length; i++) {
      var f = features[i];
      if (!f || !f.properties) continue;
      var g = f.geometry;
      if (!g || g.type !== "Point" || !g.coordinates) continue;
      var lng = g.coordinates[0];
      var lat = g.coordinates[1];
      if (lng == null || lat == null) continue;
      var ll;
      try {
        ll = new mapboxgl.LngLat(lng, lat);
      } catch (e3) {
        continue;
      }
      if (!b.contains(ll)) {
        continue;
      }
      var c = null;
      var hk = f.properties._hexKey != null ? String(f.properties._hexKey) : null;
      if (hk) {
        c = neighborhoodAverageSchoolResidenceStudentsPerSqMi(hk, preIdx);
      }
      if (c == null || !isFinite(c)) {
        if (f.properties.students_per_sq_mi == null) {
          continue;
        }
        c = Number(f.properties.students_per_sq_mi);
        if (!isFinite(c)) continue;
      }
      if (minC == null || c < minC) {
        minC = c;
      }
      if (maxC == null || c > maxC) {
        maxC = c;
      }
    }
    return { min: minC, max: maxC };
  }

  function minMaxNeighborhoodCharterDensitiesInViewForLegend() {
    if (!map || !map.getSource || !map.getSource("charter-student-hex")) {
      return { min: null, max: null };
    }
    var b;
    try {
      b = map.getBounds();
    } catch (e) {
      return { min: null, max: null };
    }
    if (!b) {
      return { min: null, max: null };
    }
    var features;
    try {
      features = map.querySourceFeatures("charter-student-hex", {});
    } catch (e2) {
      return { min: null, max: null };
    }
    if (!features || !features.length) {
      return { min: null, max: null };
    }
    var preCh =
      (STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.charterDistrictHexCounts) ||
      Object.create(null);
    var minC = null;
    var maxC = null;
    for (var j = 0; j < features.length; j++) {
      var f2 = features[j];
      if (!f2 || !f2.properties) continue;
      var g2 = f2.geometry;
      if (!g2 || g2.type !== "Point" || !g2.coordinates) continue;
      var lng2 = g2.coordinates[0];
      var lat2 = g2.coordinates[1];
      if (lng2 == null || lat2 == null) continue;
      var ll2;
      try {
        ll2 = new mapboxgl.LngLat(lng2, lat2);
      } catch (e3b) {
        continue;
      }
      if (!b.contains(ll2)) {
        continue;
      }
      var c2 = null;
      var hk2 = f2.properties._hexKey != null ? String(f2.properties._hexKey) : null;
      if (hk2) {
        c2 = neighborhoodAverageCharterResidenceStudentsPerSqMi(hk2, preCh);
      }
      if (c2 == null || !isFinite(c2)) {
        if (f2.properties.students_per_sq_mi == null) {
          continue;
        }
        c2 = Number(f2.properties.students_per_sq_mi);
        if (!isFinite(c2)) continue;
      }
      if (minC == null || c2 < minC) {
        minC = c2;
      }
      if (maxC == null || c2 > maxC) {
        maxC = c2;
      }
    }
    return { min: minC, max: maxC };
  }

  function minMaxNeighborhoodHomeschoolDensitiesInViewForLegend() {
    if (!map || !map.getSource || !map.getSource("homeschool-student-hex")) {
      return { min: null, max: null };
    }
    var b;
    try {
      b = map.getBounds();
    } catch (e) {
      return { min: null, max: null };
    }
    if (!b) {
      return { min: null, max: null };
    }
    var features;
    try {
      features = map.querySourceFeatures("homeschool-student-hex", {});
    } catch (e2) {
      return { min: null, max: null };
    }
    if (!features || !features.length) {
      return { min: null, max: null };
    }
    var preHm = HOMESCHOOL_HEX_COUNTS || Object.create(null);
    var minC = null;
    var maxC = null;
    for (var j = 0; j < features.length; j++) {
      var f2 = features[j];
      if (!f2 || !f2.properties) continue;
      var g2 = f2.geometry;
      if (!g2 || g2.type !== "Point" || !g2.coordinates) continue;
      var lng2 = g2.coordinates[0];
      var lat2 = g2.coordinates[1];
      if (lng2 == null || lat2 == null) continue;
      var ll2;
      try {
        ll2 = new mapboxgl.LngLat(lng2, lat2);
      } catch (e3b) {
        continue;
      }
      if (!b.contains(ll2)) {
        continue;
      }
      var c2 = null;
      var hk2 = f2.properties._hexKey != null ? String(f2.properties._hexKey) : null;
      if (hk2) {
        c2 = neighborhoodAverageHomeschoolResidenceStudentsPerSqMi(hk2, preHm);
      }
      if (c2 == null || !isFinite(c2)) {
        if (f2.properties.students_per_sq_mi == null) {
          continue;
        }
        c2 = Number(f2.properties.students_per_sq_mi);
        if (!isFinite(c2)) continue;
      }
      if (minC == null || c2 < minC) {
        minC = c2;
      }
      if (maxC == null || c2 > maxC) {
        maxC = c2;
      }
    }
    return { min: minC, max: maxC };
  }

  function scheduleRefreshMapDensityLegendValueRanges() {
    if (mapDensityLegendValueRefreshHandle) {
      clearTimeout(mapDensityLegendValueRefreshHandle);
    }
    mapDensityLegendValueRefreshHandle = setTimeout(function () {
      mapDensityLegendValueRefreshHandle = null;
      refreshMapDensityLegendValueRanges();
    }, 100);
  }

  function refreshMapDensityLegendValueRanges() {
    var stuMin = document.getElementById("map-density-legend-student-min");
    var stuMax = document.getElementById("map-density-legend-student-max");
    var chMin = document.getElementById("map-density-legend-charter-min");
    var chMax = document.getElementById("map-density-legend-charter-max");
    var hmMin = document.getElementById("map-density-legend-homeschool-min");
    var hmMax = document.getElementById("map-density-legend-homeschool-max");
    if (!stuMin && !chMin && !hmMin) {
      return;
    }
    var v = getMapDensityLegendVisibility();
    if (v.stu && stuMin && stuMax) {
      var r1 = minMaxNeighborhoodSchoolDensitiesInViewForLegend();
      stuMin.textContent = formatMapLegendStudentsPerSqMi(r1.min);
      stuMax.textContent = formatMapLegendStudentsPerSqMi(r1.max);
      var bar = document.getElementById("map-density-legend-student-scale");
      if (bar) {
        bar.setAttribute(
          "aria-label",
          "Color scale: student residences; in current view, neighborhood-mean students per square mile, minimum " +
            (r1.min == null ? "—" : formatMapLegendStudentsPerSqMi(r1.min)) +
            " to maximum " +
            (r1.max == null ? "—" : formatMapLegendStudentsPerSqMi(r1.max))
        );
      }
    } else {
      if (stuMin) stuMin.textContent = "—";
      if (stuMax) stuMax.textContent = "—";
    }
    if (v.ch && chMin && chMax) {
      var r2 = minMaxNeighborhoodCharterDensitiesInViewForLegend();
      chMin.textContent = formatMapLegendStudentsPerSqMi(r2.min);
      chMax.textContent = formatMapLegendStudentsPerSqMi(r2.max);
      var bar2 = document.getElementById("map-density-legend-charter-scale");
      if (bar2) {
        bar2.setAttribute(
          "aria-label",
          "Color scale: charter student residences; in current view, neighborhood-mean students per square mile, minimum " +
            (r2.min == null ? "—" : formatMapLegendStudentsPerSqMi(r2.min)) +
            " to maximum " +
            (r2.max == null ? "—" : formatMapLegendStudentsPerSqMi(r2.max))
        );
      }
    } else {
      if (chMin) chMin.textContent = "—";
      if (chMax) chMax.textContent = "—";
    }
    if (v.hm && hmMin && hmMax) {
      var r3 = minMaxNeighborhoodHomeschoolDensitiesInViewForLegend();
      hmMin.textContent = formatMapLegendStudentsPerSqMi(r3.min);
      hmMax.textContent = formatMapLegendStudentsPerSqMi(r3.max);
      var bar3 = document.getElementById("map-density-legend-homeschool-scale");
      if (bar3) {
        bar3.setAttribute(
          "aria-label",
          "Color scale: homeschool student residences; in current view, neighborhood-mean students per square mile, minimum " +
            (r3.min == null ? "—" : formatMapLegendStudentsPerSqMi(r3.min)) +
            " to maximum " +
            (r3.max == null ? "—" : formatMapLegendStudentsPerSqMi(r3.max))
        );
      }
    } else {
      if (hmMin) hmMin.textContent = "—";
      if (hmMax) hmMax.textContent = "—";
    }
  }

  function setupMapDensityLegendViewListeners() {
    if (mapDensityLegendViewListenersSet || !map) {
      return;
    }
    mapDensityLegendViewListenersSet = true;
    function onView() {
      syncResidenceDensityHeatmapZoomVisibility();
      scheduleRefreshMapDensityLegendValueRanges();
    }
    map.on("moveend", onView);
    map.on("zoomend", onView);
    map.on("resize", onView);
  }

  /**
   * Bottom-right map legend for student / charter residence heatmap scales.
   * Shown when the corresponding layer toggle is on and the heatmap layer is visible.
   */
  function syncMapDensityLegend() {
    var leg = document.getElementById("map-density-legend");
    if (!leg) {
      return;
    }
    var v = getMapDensityLegendVisibility();
    var rowStu = document.getElementById("map-density-legend-student");
    var rowCh = document.getElementById("map-density-legend-charter");
    var rowHm = document.getElementById("map-density-legend-homeschool");
    if (rowStu) {
      rowStu.hidden = !v.stu;
    }
    if (rowCh) {
      rowCh.hidden = !v.ch;
    }
    if (rowHm) {
      rowHm.hidden = !v.hm;
    }
    leg.hidden = !v.stu && !v.ch && !v.hm;
    scheduleRefreshMapDensityLegendValueRanges();
  }

  var MAP_DENSITY_LEGEND_COLLAPSED_KEY = "brevardMapDensityLegendCollapsed";

  function applyMapDensityLegendCollapsed(collapsed) {
    var leg = document.getElementById("map-density-legend");
    var btn = document.getElementById("map-density-legend-collapse");
    if (!leg) return;
    leg.classList.toggle("is-collapsed", !!collapsed);
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute(
        "aria-label",
        collapsed
          ? "Expand the residence density legend"
          : "Collapse the residence density legend"
      );
    }
  }

  (function setupMapDensityLegendCollapse() {
    var btn = document.getElementById("map-density-legend-collapse");
    if (!btn) return;
    var collapsed = false;
    try {
      collapsed =
        localStorage.getItem(MAP_DENSITY_LEGEND_COLLAPSED_KEY) === "1";
    } catch (e) {
      collapsed = false;
    }
    applyMapDensityLegendCollapsed(collapsed);
    btn.addEventListener("click", function () {
      var leg = document.getElementById("map-density-legend");
      if (!leg) return;
      var next = !leg.classList.contains("is-collapsed");
      applyMapDensityLegendCollapsed(next);
      try {
        localStorage.setItem(
          MAP_DENSITY_LEGEND_COLLAPSED_KEY,
          next ? "1" : "0"
        );
      } catch (e) {
        /* ignore */
      }
    });
  })();

  /**
   * Discrete fill colors for travel shed rings, keyed by mile (1–10).
   * Must match the `school-isochrones-fill` `fill-color` match expression.
   */
  var TRAVEL_SHED_MILE_COLORS = {
    1: "#fffbeb",
    2: "#fef3c7",
    3: "#fde68a",
    4: "#fcd34d",
    5: "#fbbf24",
    6: "#d97706",
    7: "#b45309",
    8: "#92400e",
    9: "#78350f",
    10: "#451a03",
  };

  /** Build the labeled mile swatches for the travel shed legend, up to maxMiles. */
  function renderTravelShedLegendScale(maxMiles) {
    var scale = document.getElementById("map-travel-shed-legend-scale");
    if (!scale) return;
    var max = Math.round(Number(maxMiles));
    if (isNaN(max) || max < 1) max = 1;
    if (max > 10) max = 10;
    var html = "";
    for (var mi = 1; mi <= max; mi++) {
      var color = TRAVEL_SHED_MILE_COLORS[mi] || "#d4d4d8";
      html +=
        '<span class="map-travel-shed-legend__swatch">' +
        '<span class="map-travel-shed-legend__chip" style="background:' +
        color +
        ';"></span>' +
        '<span class="map-travel-shed-legend__chip-label">' +
        mi +
        "</span></span>";
    }
    scale.innerHTML = html;
  }

  /**
   * Show the travel shed legend when the Travel sheds layer is on, visible, and a
   * school's sheds are actually drawn; keep its mile swatches in sync with the
   * current max-miles slider.
   */
  function syncTravelShedLegend() {
    var leg = document.getElementById("map-travel-shed-legend");
    if (!leg) {
      return;
    }
    var tgl = document.getElementById("toggle-travel-sheds");
    var on = !!(tgl && tgl.checked);
    var visible = on;
    if (visible && map && map.getLayer) {
      try {
        if (map.getLayer("school-isochrones-fill")) {
          visible =
            map.getLayoutProperty("school-isochrones-fill", "visibility") ===
            "visible";
        }
      } catch (e) {
        /* ignore */
      }
    }
    var msid = getActiveTravelShedMsid();
    if (visible && (msid == null || isNaN(Number(msid)))) {
      visible = false;
    }
    if (visible) {
      renderTravelShedLegendScale(travelShedMaxMiles);
    }
    leg.hidden = !visible;
  }

  var MAP_TRAVEL_SHED_LEGEND_COLLAPSED_KEY = "brevardMapTravelShedLegendCollapsed";

  function applyTravelShedLegendCollapsed(collapsed) {
    var leg = document.getElementById("map-travel-shed-legend");
    var btn = document.getElementById("map-travel-shed-legend-collapse");
    if (!leg) return;
    leg.classList.toggle("is-collapsed", !!collapsed);
    if (btn) {
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      btn.setAttribute(
        "aria-label",
        collapsed
          ? "Expand the travel shed legend"
          : "Collapse the travel shed legend"
      );
    }
  }

  (function setupTravelShedLegendCollapse() {
    var btn = document.getElementById("map-travel-shed-legend-collapse");
    if (!btn) return;
    var collapsed = false;
    try {
      collapsed =
        localStorage.getItem(MAP_TRAVEL_SHED_LEGEND_COLLAPSED_KEY) === "1";
    } catch (e) {
      collapsed = false;
    }
    applyTravelShedLegendCollapsed(collapsed);
    btn.addEventListener("click", function () {
      var leg = document.getElementById("map-travel-shed-legend");
      if (!leg) return;
      var next = !leg.classList.contains("is-collapsed");
      applyTravelShedLegendCollapsed(next);
      try {
        localStorage.setItem(
          MAP_TRAVEL_SHED_LEGEND_COLLAPSED_KEY,
          next ? "1" : "0"
        );
      } catch (e) {
        /* ignore */
      }
    });
  })();

  var ENCHART_COLORS = { calendar: "#94a3b8", projected: "#93c5fd" };

  /** Matches school location dot colors (elementary / middle / high). */
  var PALETTE = {
    /** `highlightStroke`: light tint for the thick selection / hover / scenario ring (same hue family as `fill`). */
    elementary: { fill: "#16a34a", line: "#15803d", highlightStroke: "#4ade80" },
    middle: { fill: "#2563eb", line: "#1d4ed8", highlightStroke: "#93c5fd" },
    high: { fill: "#9333ea", line: "#7e22ce", highlightStroke: "#d8b4fe" },
    /** 7–12 / Jr–Sr schools (distinct from 9–12 high on map and Sankey). */
    jrSr: { fill: "#ea580c", line: "#c2410c", highlightStroke: "#fb923c" },
    charter: { fill: "#ec4899", line: "#be185d", highlightStroke: "#fbcfe8" },
    /** Private schools (non-BPS): golden yellow dot / hover ring. */
    privateSchool: { fill: "#eab308", line: "#ca8a04", highlightStroke: "#fde047" },
  };
  var schoolMapCircleStrokeColorDefault = "#ffffff";

  /** Shared zoom → px radius for school location dots (Mapbox `circle-radius`). */
  var SCHOOL_MAP_CIRCLE_RADIUS_ZOOM = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    3,
    12,
    6,
    16,
    10,
  ];

  /**
   * Quintile → radius multiplier for charter + private location dots (`_pe_quintile` on features).
   */
  var ENROLLMENT_QUINTILE_RADIUS_MULT = [
    "match",
    ["to-number", ["get", "_pe_quintile"]],
    0,
    0.5,
    1,
    1,
    2,
    1.5,
    3,
    2,
    4,
    2.5,
    1,
  ];

  /**
   * Mapbox requires `["zoom"]` as input to a top-level `interpolate`/`step` in paint — cannot wrap
   * the zoom interpolate inside `*`; scale each zoom stop by enrollment quintile instead.
   */
  function varyEnrollmentCircleRadiusPaintExpr(vary) {
    if (vary) {
      return [
        "interpolate",
        ["linear"],
        ["zoom"],
        8,
        ["*", 3, ENROLLMENT_QUINTILE_RADIUS_MULT],
        12,
        ["*", 6, ENROLLMENT_QUINTILE_RADIUS_MULT],
        16,
        ["*", 10, ENROLLMENT_QUINTILE_RADIUS_MULT],
      ];
    }
    return SCHOOL_MAP_CIRCLE_RADIUS_ZOOM;
  }

  /** More transparent assignment zone fills */
  var BOUNDARY_FILL_OPACITY = 0.1;

  /** @param {GeoJSON.FeatureCollection} fc */
  function computeBbox(fc) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;

    function walk(coords) {
      if (typeof coords[0] === "number") {
        var x = coords[0];
        var y = coords[1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        return;
      }
      for (var i = 0; i < coords.length; i++) walk(coords[i]);
    }

    if (!fc || !fc.features) return null;
    for (var f = 0; f < fc.features.length; f++) {
      var g = fc.features[f].geometry;
      if (g) walk(g.coordinates);
    }
    if (!isFinite(minX)) return null;
    return [minX, minY, maxX, maxY];
  }

  function mergeBbox(a, b) {
    if (!a) return b;
    if (!b) return a;
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ];
  }

  mapboxgl.accessToken = MAPBOX_ACCESS_TOKEN;

  /** Update or dismiss the map loading overlay (defined before map init). */
  function showMapLoadingOverlayMessage(title, hint) {
    var el = document.getElementById("map-loading-overlay");
    if (!el) return;
    el.classList.remove("is-hidden");
    var t = el.querySelector(".map-loading-overlay__title");
    var h = el.querySelector(".map-loading-overlay__hint");
    if (t) t.textContent = title;
    if (h) h.textContent = hint;
  }

  function hideMapLoadingOverlay() {
    var el = document.getElementById("map-loading-overlay");
    if (!el) return;
    el.classList.add("is-hidden");
  }

  var map = new mapboxgl.Map({
    container: "map",
    style: MAPBOX_STYLES.light,
    center: [-80.7, 28.2],
    zoom: 8,
    maxZoom: 19,
    /* Required so map.getCanvas().toDataURL() returns the rendered scene
       (used by the Save & Share PDF export). Without this, WebGL clears the
       drawing buffer after every frame and the exported image is blank. */
    preserveDrawingBuffer: true,
  });

  function syncCharterPrivateVaryEnrollmentCirclePaint() {
    if (!map || !map.getLayer) return;
    var inp = document.getElementById("toggle-nontraditional-vary-enrollment-size");
    var vary = !!(inp && inp.checked);
    var rad = varyEnrollmentCircleRadiusPaintExpr(vary);
    try {
      if (map.getLayer("schools-charter")) {
        map.setPaintProperty("schools-charter", "circle-radius", rad);
      }
    } catch (errSyncCh) {
      /* ignore */
    }
    try {
      if (map.getLayer("schools-private")) {
        map.setPaintProperty("schools-private", "circle-radius", rad);
      }
    } catch (errSyncPs) {
      /* ignore */
    }
  }

  map.addControl(new mapboxgl.NavigationControl(), "top-left");
  map.addControl(
    new mapboxgl.ScaleControl({
      maxWidth: 120,
      unit: "imperial",
    }),
    "bottom-left"
  );
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");

  map.on("error", function (evt) {
    console.error(evt);
    var msg =
      evt && evt.error && evt.error.message
        ? evt.error.message
        : "Mapbox failed to load the basemap.";
    showMapLoadingOverlayMessage(
      "Unable to load map",
      msg + " Check that config.local.js contains a valid Mapbox public token (pk.)."
    );
  });

  if (!MAPBOX_ACCESS_TOKEN) {
    showMapLoadingOverlayMessage(
      "Map configuration missing",
      "config.local.js was not found or has no Mapbox token. For local use, copy config.local.js.example to config.local.js. For GitHub Pages, set the MAPBOX_ACCESS_TOKEN repository secret and redeploy."
    );
  }

  function setMapboxBasemap(mode) {
    if (!MAPBOX_STYLES[mode]) return;
    map.setStyle(MAPBOX_STYLES[mode]);
    var root = document.getElementById("basemap-toggle");
    if (root) {
      root.querySelectorAll("[data-basemap]").forEach(function (btn) {
        var active = btn.getAttribute("data-basemap") === mode;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
    }
  }

  /** After first fetch; GeoJSON layers are re-added on each Mapbox `style.load` (basemap switch). */
  var mapLayersInitialized = false;

  var outlinePaintBase = {
    "line-width": [
      "case",
      [
        "any",
        ["==", ["feature-state", "highlight"], true],
        ["==", ["feature-state", "selectedAssignment"], true],
      ],
      4,
      1,
    ],
    "line-opacity": [
      "case",
      [
        "any",
        ["==", ["feature-state", "highlight"], true],
        ["==", ["feature-state", "selectedAssignment"], true],
      ],
      1,
      0.75,
    ],
  };

  /**
   * For single–school (sparse) views, `heatmap-density` is often 0 – ~0.25 across most of the view while
   * the warm part of the ramp (red → yellow) is concentrated at 0.5 – 1.0. A sublinear power stretches the
   * 0 – 1 range so local peaks use more of the full blue → yellow palette (perceived auto–scaling).
   */
  var HEAT_SCHOOL_DENSITY = [
    "^",
    ["max", 0, ["min", 1, ["heatmap-density"]]],
    0.42,
  ];
  /**
   * District / all–schools view: ^0.45 `heatmap-density` remapping. Single–school (or scenario middle /
   * sandbox) selected: pre–exponent linear stop keys, with HEAT_SCHOOL_DENSITY on the input.
   */
  var HEAT_STUDENT_RAMP_SCHOOL = [
    "interpolate",
    ["linear"],
    HEAT_SCHOOL_DENSITY,
    0,
    "rgba(34, 211, 238, 0)",
    0.018,
    "rgba(34, 211, 238, 0.088)",
    0.045,
    "rgba(20, 198, 225, 0.229)",
    0.08,
    "rgba(8, 172, 198, 0.334)",
    0.12,
    "rgba(6, 155, 182, 0.422)",
    0.16,
    "rgba(6, 182, 212, 0.484)",
    0.2,
    "rgba(56, 189, 248, 0.528)",
    0.213,
    "rgba(70, 150, 244, 0.525)",
    0.225,
    "rgba(85, 120, 238, 0.533)",
    0.238,
    "rgba(98, 88, 230, 0.473)",
    0.25,
    "rgba(105, 58, 220, 0.476)",
    0.26,
    "rgba(109, 40, 217, 0.48)",
    0.29,
    "rgba(128, 46, 225, 0.495)",
    0.32,
    "rgba(147, 51, 234, 0.51)",
    0.35,
    "rgba(158, 68, 240, 0.525)",
    0.38,
    "rgba(168, 85, 247, 0.54)",
    0.41,
    "rgba(180, 62, 230, 0.555)",
    0.44,
    "rgba(192, 38, 211, 0.57)",
    0.47,
    "rgba(205, 38, 180, 0.585)",
    0.485,
    "rgba(212, 38, 150, 0.593)",
    0.5,
    "rgba(219, 39, 119, 0.8)",
    0.56,
    "rgba(225, 29, 72, 0.83)",
    0.62,
    "rgba(220, 38, 38, 0.86)",
    0.68,
    "rgba(234, 88, 12, 0.88)",
    0.74,
    "rgba(245, 101, 20, 0.9)",
    0.8,
    "rgba(251, 146, 60, 0.92)",
    0.86,
    "rgba(253, 186, 55, 0.94)",
    0.91,
    "rgba(253, 224, 71, 0.96)",
    0.95,
    "rgba(254, 240, 138, 0.98)",
    0.98,
    "rgba(255, 251, 200, 0.99)",
    1,
    "rgba(255, 255, 230, 1)",
  ];
  var HEAT_STUDENT_RAMP_UNIFORM = [
    "interpolate",
    ["linear"],
    /* Reserve the hottest colors for only the very densest student
       concentrations and spread the cooler/mid colors over more of the map: a
       gamma (>1) on heatmap-density pulls mid densities toward the cool end, so
       the warm hues are reached only near peak density. Raise the exponent for a
       stronger effect (more reserved), lower it toward 1 for less. */
    ["^", ["heatmap-density"], 1.7],
    0,
    "rgba(34, 211, 238, 0)",
    0.164,
    "rgba(34, 211, 238, 0.088)",
    0.2477,
    "rgba(20, 198, 225, 0.229)",
    0.3209,
    "rgba(8, 172, 198, 0.334)",
    0.3852,
    "rgba(6, 155, 182, 0.422)",
    0.4384,
    "rgba(6, 182, 212, 0.484)",
    0.4847,
    "rgba(56, 189, 248, 0.528)",
    0.4986,
    "rgba(70, 150, 244, 0.525)",
    0.5111,
    "rgba(85, 120, 238, 0.533)",
    0.5242,
    "rgba(98, 88, 230, 0.473)",
    0.5359,
    "rgba(105, 58, 220, 0.476)",
    0.5454,
    "rgba(109, 40, 217, 0.48)",
    0.5729,
    "rgba(128, 46, 225, 0.495)",
    0.5988,
    "rgba(147, 51, 234, 0.51)",
    0.6235,
    "rgba(158, 68, 240, 0.525)",
    0.647,
    "rgba(168, 85, 247, 0.54)",
    0.6695,
    "rgba(180, 62, 230, 0.555)",
    0.6911,
    "rgba(192, 38, 211, 0.57)",
    0.7119,
    "rgba(205, 38, 180, 0.585)",
    0.7221,
    "rgba(212, 38, 150, 0.593)",
    0.732,
    "rgba(219, 39, 119, 0.8)",
    0.7703,
    "rgba(225, 29, 72, 0.83)",
    0.8064,
    "rgba(220, 38, 38, 0.86)",
    0.8407,
    "rgba(234, 88, 12, 0.88)",
    0.8733,
    "rgba(245, 101, 20, 0.9)",
    0.9045,
    "rgba(251, 146, 60, 0.92)",
    0.9344,
    "rgba(253, 186, 55, 0.94)",
    0.9584,
    "rgba(253, 224, 71, 0.96)",
    0.9772,
    "rgba(254, 240, 138, 0.98)",
    0.9909,
    "rgba(255, 251, 200, 0.99)",
    1,
    "rgba(255, 255, 230, 1)",
  ];
  var HEAT_CHARTER_RAMP_SCHOOL = [
    "interpolate",
    ["linear"],
    HEAT_SCHOOL_DENSITY,
    0,
    "rgba(255, 255, 255, 0)",
    0.04,
    "rgba(252, 197, 231, 0.14)",
    0.1,
    "rgba(252, 185, 227, 0.26)",
    0.18,
    "rgba(252, 171, 222, 0.38)",
    0.27,
    "rgba(253, 156, 216, 0.48)",
    0.37,
    "rgba(253, 142, 211, 0.58)",
    0.48,
    "rgba(254, 128, 206, 0.68)",
    0.6,
    "rgba(254, 112, 200, 0.78)",
    0.72,
    "rgba(254, 112, 200, 0.78)",
    0.88,
    "rgba(255, 92, 192, 0.86)",
    0.95,
    "rgba(255, 81, 218, 0.9)",
    1,
    "rgba(255, 64, 255, 0.94)",
  ];
  var HEAT_CHARTER_RAMP_UNIFORM = [
    "interpolate",
    ["linear"],
    /* Compress the districtwide ramp ~15% (see student ramp note). */
    ["max", 0, ["/", ["-", ["heatmap-density"], 0.15], 0.85]],
    0,
    "rgba(255, 255, 255, 0)",
    0.2349,
    "rgba(252, 197, 231, 0.14)",
    0.3548,
    "rgba(252, 185, 227, 0.26)",
    0.4622,
    "rgba(252, 171, 222, 0.38)",
    0.5548,
    "rgba(253, 156, 216, 0.48)",
    0.6393,
    "rgba(253, 142, 211, 0.58)",
    0.7187,
    "rgba(254, 128, 206, 0.68)",
    0.7946,
    "rgba(254, 112, 200, 0.78)",
    0.8626,
    "rgba(254, 112, 200, 0.78)",
    0.9441,
    "rgba(255, 92, 192, 0.86)",
    0.9772,
    "rgba(255, 81, 218, 0.9)",
    1,
    "rgba(255, 64, 255, 0.94)",
  ];
  /** Same structure as charter ramp; red/orange family for homeschool residential density. */
  var HEAT_HOMESCHOOL_RAMP_SCHOOL = [
    "interpolate",
    ["linear"],
    HEAT_SCHOOL_DENSITY,
    0,
    "rgba(255, 255, 255, 0)",
    0.04,
    "rgba(254, 226, 226, 0.14)",
    0.1,
    "rgba(252, 165, 165, 0.26)",
    0.18,
    "rgba(248, 113, 113, 0.38)",
    0.27,
    "rgba(239, 68, 68, 0.48)",
    0.37,
    "rgba(220, 38, 38, 0.58)",
    0.48,
    "rgba(185, 28, 28, 0.68)",
    0.6,
    "rgba(153, 27, 27, 0.78)",
    0.72,
    "rgba(153, 27, 27, 0.78)",
    0.88,
    "rgba(127, 29, 29, 0.86)",
    0.95,
    "rgba(91, 17, 17, 0.9)",
    1,
    "rgba(69, 10, 10, 0.94)",
  ];
  var HEAT_HOMESCHOOL_RAMP_UNIFORM = [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    0,
    "rgba(255, 255, 255, 0)",
    0.2349,
    "rgba(254, 226, 226, 0.14)",
    0.3548,
    "rgba(252, 165, 165, 0.26)",
    0.4622,
    "rgba(248, 113, 113, 0.38)",
    0.5548,
    "rgba(239, 68, 68, 0.48)",
    0.6393,
    "rgba(220, 38, 38, 0.58)",
    0.7187,
    "rgba(185, 28, 28, 0.68)",
    0.7946,
    "rgba(153, 27, 27, 0.78)",
    0.8626,
    "rgba(153, 27, 27, 0.78)",
    0.9441,
    "rgba(127, 29, 29, 0.86)",
    0.9772,
    "rgba(91, 17, 17, 0.9)",
    1,
    "rgba(69, 10, 10, 0.94)",
  ];

  /** Default zoom–scaled heat for student + charter residence heatmaps; restored when leaving school context. */
  var HEAT_RESIDENCE_INTENSITY = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    0.05,
    10,
    0.07,
    12,
    0.1,
    14,
    0.16,
    16,
    0.24,
    17,
    0.3,
  ];

  /**
   * Softened intensity for the districtwide (no school selected) student +
   * charter residence heatmaps: ~15% lower across z8–z11 so the zoomed-out map
   * isn't dominated by the top color, returning to the normal ramp by z12+.
   */
  var HEAT_RESIDENCE_INTENSITY_SOFT = [
    "interpolate",
    ["linear"],
    ["zoom"],
    8,
    0.0425,
    10,
    0.0595,
    11,
    0.07225,
    12,
    0.1,
    14,
    0.16,
    16,
    0.24,
    17,
    0.3,
  ];

  /**
   * heatmap-intensity must be a top-level interpolate/step on zoom (not nested in "*").
   * @param {number} [scale] multiply each stop value (e.g. 1.4 when a school is selected)
   */
  function residenceHeatIntensityExpr(scale) {
    var s = scale != null && isFinite(scale) ? scale : 1;
    var base = HEAT_RESIDENCE_INTENSITY;
    if (s === 1) {
      return base;
    }
    var out = ["interpolate", ["linear"], ["zoom"]];
    for (var i = 4; i < base.length; i += 2) {
      out.push(base[i], base[i + 1] * s);
    }
    return out;
  }

  /**
   * Hide student / charter residence-density heatmaps (and density hover tooltips) at neighborhood scale
   * and closer. Higher zoom level number = more zoomed in; this threshold is one step further zoomed out than z14.
   * Hex hit-fill layers stay visible for hover tooltips on the map (without density popup when zoomed in).
   */
  var RESIDENCE_HEATMAP_HIDE_ZOOM = 13;

  function residenceDensityHeatmapHiddenAtCurrentZoom() {
    if (!map || typeof map.getZoom !== "function") {
      return false;
    }
    try {
      return map.getZoom() >= RESIDENCE_HEATMAP_HIDE_ZOOM;
    } catch (eZ) {
      return false;
    }
  }

  /**
   * Match heatmap visibility to hit-fill visibility, except heatmaps are hidden when zoomed in past
   * `RESIDENCE_HEATMAP_HIDE_ZOOM`.
   */
  function syncResidenceDensityHeatmapZoomVisibility() {
    if (!map || !map.getLayer) {
      return;
    }
    var hideHeat = residenceDensityHeatmapHiddenAtCurrentZoom();
    var stuHitOk = false;
    var chHitOk = false;
    var hmHitOk = false;
    try {
      if (map.getLayer("student-hex-hit-fill")) {
        stuHitOk = map.getLayoutProperty("student-hex-hit-fill", "visibility") === "visible";
      }
    } catch (e0) {
      /* ignore */
    }
    try {
      if (map.getLayer("charter-student-hex-hit-fill")) {
        chHitOk = map.getLayoutProperty("charter-student-hex-hit-fill", "visibility") === "visible";
      }
    } catch (e1) {
      /* ignore */
    }
    try {
      if (map.getLayer("homeschool-student-hex-hit-fill")) {
        hmHitOk =
          map.getLayoutProperty("homeschool-student-hex-hit-fill", "visibility") === "visible";
      }
    } catch (e1b) {
      /* ignore */
    }
    var stuHm = stuHitOk && !hideHeat ? "visible" : "none";
    var chHm = chHitOk && !hideHeat ? "visible" : "none";
    var hmHm = hmHitOk && !hideHeat ? "visible" : "none";
    try {
      if (map.getLayer("student-hex-heatmap")) {
        map.setLayoutProperty("student-hex-heatmap", "visibility", stuHm);
      }
      if (map.getLayer("charter-student-hex-heatmap")) {
        map.setLayoutProperty("charter-student-hex-heatmap", "visibility", chHm);
      }
      if (map.getLayer("homeschool-student-hex-heatmap")) {
        map.setLayoutProperty("homeschool-student-hex-heatmap", "visibility", hmHm);
      }
    } catch (eL) {
      /* ignore */
    }
    if (hideHeat && typeof dismissStudentHexDensityTooltip === "function") {
      dismissStudentHexDensityTooltip();
    }
    syncMapDensityLegend();
  }

  function applyResidenceHeatmapSymbology() {
    if (!map || !map.getLayer) {
      return;
    }
    var m = getActiveDashboardSchoolMsid();
    var useOriginalRamp = m != null && !isNaN(m);
    var intExpr = residenceHeatIntensityExpr(useOriginalRamp ? 1.4 : 1);
    /* Districtwide student + charter use a softened (≈15% lower) intensity so
       the zoomed-out map isn't washed out by the top color; the per-school view
       keeps the normal intensity. */
    var intExprSoft = useOriginalRamp ? intExpr : HEAT_RESIDENCE_INTENSITY_SOFT;
    try {
      if (map.getLayer("student-hex-heatmap")) {
        map.setPaintProperty(
          "student-hex-heatmap",
          "heatmap-color",
          useOriginalRamp ? HEAT_STUDENT_RAMP_SCHOOL : HEAT_STUDENT_RAMP_UNIFORM
        );
        map.setPaintProperty("student-hex-heatmap", "heatmap-intensity", intExprSoft);
      }
      if (map.getLayer("charter-student-hex-heatmap")) {
        map.setPaintProperty(
          "charter-student-hex-heatmap",
          "heatmap-color",
          useOriginalRamp ? HEAT_CHARTER_RAMP_SCHOOL : HEAT_CHARTER_RAMP_UNIFORM
        );
        map.setPaintProperty("charter-student-hex-heatmap", "heatmap-intensity", intExprSoft);
      }
      if (map.getLayer("homeschool-student-hex-heatmap")) {
        map.setPaintProperty(
          "homeschool-student-hex-heatmap",
          "heatmap-color",
          useOriginalRamp ? HEAT_HOMESCHOOL_RAMP_SCHOOL : HEAT_HOMESCHOOL_RAMP_UNIFORM
        );
        map.setPaintProperty("homeschool-student-hex-heatmap", "heatmap-intensity", intExpr);
      }
    } catch (eHmap) {
      /* ignore */
    }
  }

  /**
   * When `style.load` runs more than once without `setStyle` (can happen during init),
   * sources already exist — update data in place instead of `addSource` (which throws).
   */
  function refreshGeoJsonSourcesAfterStyleReload(results, opts) {
    var fitBounds = !opts || opts.fitBounds !== false;
    /* Index map (see Promise.all in the load handler — travelImpact slot
       removed, so isochrones / employee / private / homeschool shifted down by 1). */
    var es = results[0];
    var ms = results[1];
    var hs = results[2];
    var schools = enrichSchoolsFcWithMasterType(results[3]);
    CHOICE_SCHOOL_MSIDS = buildChoiceSchoolMsidSet(schools);
    var studentHexFc = results[6];
    var schoolParcelsRaw = results[7];
    var schoolBoardFc = results[8];
    var charterFc = prepareCharterSchoolsMapFc(results[9]);
    var municipalFc = results[11];
    var privateFc = preparePrivateSchoolsMapFc(results[15]);
    var homeschoolFc = results[16];
    CHARTER_SCHOOL_MSIDS = buildCharterSchoolMsidSet(schools, charterFc);

    /* Build homeschool fallback geometry first so the filler mesh can treat those
       cells as occupied (prevents overlapping filler hexes on homeschool hexes). */
    HOMESCHOOL_HEX_GEOMETRY_FALLBACK = buildHomeschoolHexGeometryFallback(
      homeschoolFc && homeschoolFc.features ? homeschoolFc : null
    );
    if (studentHexFc && studentHexFc.features && studentHexFc.features.length) {
      STUDENT_HEX_INDEX = buildStudentHexIndex(studentHexFc);
      scenarioPkStudentMsidCache = Object.create(null);
      TRAVEL_SHED_RESIDENCE_INDEX = buildTravelShedResidenceIndex(studentHexFc);
      EMPTY_HEX_GEOMETRY = buildEmptyHexGeometryMesh(
        STUDENT_HEX_INDEX ? STUDENT_HEX_INDEX.geometryByHexKey : null,
        HOMESCHOOL_HEX_GEOMETRY_FALLBACK,
        [].concat(
          es && es.features ? es.features : [],
          ms && ms.features ? ms.features : [],
          hs && hs.features ? hs.features : []
        )
      );
    } else {
      STUDENT_HEX_INDEX = null;
      TRAVEL_SHED_RESIDENCE_INDEX = null;
      EMPTY_HEX_GEOMETRY = null;
    }
    rebuildCharterAttendanceGradesLabelByMsid();
    HOMESCHOOL_HEX_COUNTS = buildHomeschoolHexCounts(
      homeschoolFc && homeschoolFc.features ? homeschoolFc : null
    );
    HOMESCHOOL_DETAILS_BY_HEX_KEY = buildHomeschoolDetailsByHexKey(
      homeschoolFc && homeschoolFc.features ? homeschoolFc : null
    );
    clearHomeschoolInBoundaryCountCache();

    GEO_CACHE.es = es;
    GEO_CACHE.ms = ms;
    GEO_CACHE.hs = hs;
    GEO_CACHE.schools = schools;
    GEO_CACHE.charter = charterFc || null;
    GEO_CACHE.private = privateFc || null;
    resetSandboxHexInCountyCache();

    var schoolParcelsFc = buildFilteredSchoolParcelsFc(schools, schoolParcelsRaw);

    map.getSource("es-boundaries").setData(es);
    map.getSource("ms-boundaries").setData(ms);
    map.getSource("hs-boundaries").setData(hs);
    map.getSource("schools").setData(schools);
    map.getSource("school-board-districts").setData(
      schoolBoardFc || { type: "FeatureCollection", features: [] }
    );
    map.getSource("municipal-boundaries").setData(
      municipalFc || { type: "FeatureCollection", features: [] }
    );
    map.getSource("school-parcels").setData(schoolParcelsFc);
    map.getSource("charter-schools").setData(
      charterFc || { type: "FeatureCollection", features: [] }
    );
    if (map.getSource("private-schools")) {
      map.getSource("private-schools").setData(
        privateFc || { type: "FeatureCollection", features: [] }
      );
    }
    SCHOOL_ISOCHRONES_ENRICHED = buildSchoolIsochronesEnriched(
      results[13] || { type: "FeatureCollection", features: [] }
    );
    if (map.getSource("school-isochrones")) {
      map.getSource("school-isochrones").setData(
        SCHOOL_ISOCHRONES_ENRICHED || {
          type: "FeatureCollection",
          features: [],
        }
      );
    }
    map.getSource("student-hex").setData({
      type: "FeatureCollection",
      features: [],
    });
    if (map.getSource("student-hex-hit")) {
      map.getSource("student-hex-hit").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    if (map.getSource("charter-student-hex")) {
      map.getSource("charter-student-hex").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    if (map.getSource("charter-student-hex-hit")) {
      map.getSource("charter-student-hex-hit").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    if (map.getSource("homeschool-student-hex")) {
      map.getSource("homeschool-student-hex").setData({
        type: "FeatureCollection",
        features: [],
      });
    }
    if (map.getSource("homeschool-student-hex-hit")) {
      map.getSource("homeschool-student-hex-hit").setData({
        type: "FeatureCollection",
        features: [],
      });
    }

    map.resize();
    var combined = null;
    combined = mergeBbox(combined, computeBbox(es));
    combined = mergeBbox(combined, computeBbox(ms));
    combined = mergeBbox(combined, computeBbox(hs));
    combined = mergeBbox(combined, computeBbox(schools));
    combined = mergeBbox(combined, computeBbox(schoolParcelsFc));
    combined = mergeBbox(combined, computeBbox(charterFc));
    combined = mergeBbox(combined, computeBbox(privateFc));
    if (fitBounds && combined) {
      map.fitBounds(combined, { padding: 48, maxZoom: 12, duration: 0 });
    }
    requestAnimationFrame(function () {
      map.resize();
    });

    if (!mapLayersInitialized) {
      mapLayersInitialized = true;
      var schoolByMsid = buildSchoolLookup(schools);
      populateSchoolSelect(schools);
      populateScenarioSchoolSelect(schools);
      populateFeedbackSchoolCommunitiesSelect(schools, charterFc, privateFc);
      setupToggles();
      setupMapInteractions(schoolByMsid);
      setupSchoolSelection(schoolByMsid);
      setupScenarioSchoolSelection(schoolByMsid, schools);
      initDashboardResizer(map);
      initMobileDashboard(map);
      clearSelectedSchoolHighlight();
      syncStudentHexLayer();
      renderEnrollmentChart(null);
      renderDemographicsCharts(null);
    } else {
      populateFeedbackSchoolCommunitiesSelect(schools, charterFc, privateFc);
      syncStudentHexLayer();
      refreshAssignmentBoundaryHighlight();
      if (selectedSchoolMsid != null) {
        try {
          map.setFeatureState(
            { source: "schools", id: selectedSchoolMsid },
            { selected: true }
          );
        } catch (e) {
          /* ignore */
        }
      }
    }
    applyScenarioFeederMapHighlights();
    syncTravelShedLayerFilter();
    rebuildBoundarySandboxHexSourceFromIndex();
    syncBoundarySandboxMapLayers();
    applyResidenceHeatmapSymbology();
  }

  /**
   * @param {string|undefined} name e.g. "2191 : 0 - 47520" → MSID 2191, 47520 ft
   * @returns {{ msid: number, toBreakFt: number }|null}
   */
  function parseSchoolIsochroneName(name) {
    if (name == null || name === "") return null;
    var m = String(name).trim().match(/^(\d+)\s*:\s*0\s*-\s*(\d+)\s*$/i);
    if (!m) return null;
    var msid = parseInt(m[1], 10);
    var toBreakFt = parseInt(m[2], 10);
    if (isNaN(msid) || isNaN(toBreakFt)) return null;
    return { msid: msid, toBreakFt: toBreakFt };
  }

  /**
   * Enriches Esri export: ToBreak in feet, Name encodes same; adds iso_msid, iso_miles (1–10) for filter/paint.
   * Feature order: larger network distance first so smaller (inner) rings draw on top within one fill layer.
   * @param {Object|null} fc
   * @returns {Object}
   */
  function buildSchoolIsochronesEnriched(fc) {
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
      if (miles < 1) {
        miles = 1;
      } else if (miles > 10) {
        miles = 10;
      }
      var pr = Object.assign({}, p, {
        iso_msid: parsed.msid,
        iso_break_ft: toBreak,
        iso_miles: miles,
      });
      out.push({ type: "Feature", geometry: f.geometry, properties: pr });
    }
    out.sort(function (a, b) {
      return (b.properties.iso_break_ft || 0) - (a.properties.iso_break_ft || 0);
    });
    return { type: "FeatureCollection", features: out };
  }

  /** Middle school in scenario panel, else #school-select MSID. */
  function getActiveTravelShedMsid() {
    if (isBoundarySandboxViewActive()) {
      return getSandboxBaseSchoolMsid();
    }
    var panel = document.getElementById("page-scenario");
    if (panel && !panel.hidden) {
      if (scenarioMiddleMsid != null && !isNaN(scenarioMiddleMsid)) {
        return scenarioMiddleMsid;
      }
      return null;
    }
    return selectedSchoolMsid;
  }

  /** Upper bound in miles (1–10) for isochrones shown when Travel sheds is on; controlled by #travel-shed-max-miles. */
  var travelShedMaxMiles = 10;

  function syncTravelShedMaxMilesRowVisibility() {
    var row = document.getElementById("travel-shed-max-miles-row");
    var tgl = document.getElementById("toggle-travel-sheds");
    if (!row) {
      return;
    }
    if (!tgl) {
      row.setAttribute("hidden", "");
      return;
    }
    if (tgl.checked) {
      row.removeAttribute("hidden");
    } else {
      row.setAttribute("hidden", "");
    }
  }

  function formatTravelShedMilesOutput(miles) {
    var m = Math.round(miles);
    if (m === 1) return "1 mi";
    return m + " mi";
  }

  function updateTravelShedMilesFromRangeControl() {
    var range = document.getElementById("travel-shed-max-miles");
    var out = document.getElementById("travel-shed-max-miles-output");
    if (!range) {
      return;
    }
    var v = Number(range.value);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 10) v = 10;
    travelShedMaxMiles = v;
    range.setAttribute("aria-valuenow", String(v));
    if (out) {
      out.textContent = formatTravelShedMilesOutput(v);
      out.value = out.textContent;
    }
    range.setAttribute("aria-valuetext", v === 1 ? "1 mile" : v + " miles");
  }

  function setupTravelShedMaxMilesControl() {
    var range = document.getElementById("travel-shed-max-miles");
    if (!range) {
      return;
    }
    updateTravelShedMilesFromRangeControl();
    range.addEventListener("input", function () {
      updateTravelShedMilesFromRangeControl();
      syncTravelShedLayerFilter();
    });
  }

  function syncTravelShedLayerFilter() {
    if (!map || !map.getSource || !map.getSource("school-isochrones")) {
      return;
    }
    var full = SCHOOL_ISOCHRONES_ENRICHED;
    var outFc = { type: "FeatureCollection", features: [] };
    if (full && full.features && full.features.length) {
      var ms = getActiveTravelShedMsid();
      if (ms != null && !isNaN(ms)) {
        var mNum = Number(ms);
        var maxM = travelShedMaxMiles;
        if (isNaN(maxM) || maxM < 1) maxM = 10;
        if (maxM > 10) maxM = 10;
        var matched = [];
        for (var i = 0; i < full.features.length; i++) {
          var f0 = full.features[i];
          if (!f0 || !f0.properties) continue;
          if (Number(f0.properties.iso_msid) !== mNum) continue;
          var ringMi0 = Number(f0.properties.iso_miles);
          if (isNaN(ringMi0)) continue;
          if (ringMi0 <= maxM) {
            matched.push(f0);
          }
        }
        var maxRing = -1;
        for (var j = 0; j < matched.length; j++) {
          var rj = Number(
            matched[j].properties != null
              ? matched[j].properties.iso_miles
              : NaN
          );
          if (!isNaN(rj) && rj > maxRing) {
            maxRing = rj;
          }
        }
        for (var k = 0; k < matched.length; k++) {
          var fk = matched[k];
          var pk = fk.properties || {};
          var rk = Number(pk.iso_miles);
          var isO =
            !isNaN(rk) && maxRing >= 0 && rk === maxRing;
          outFc.features.push({
            type: "Feature",
            geometry: fk.geometry,
            properties: Object.assign({}, pk, { iso_outer: isO ? "yes" : "no" }),
          });
        }
      }
    }
    try {
      map.getSource("school-isochrones").setData(outFc);
    } catch (e) {
      /* ignore */
    }
    /* Avoid layer filters: Mapbox v3 is unreliable for iso_msid matching on GeoJSON. Show all in source. */
    if (map.getLayer("school-isochrones-fill")) {
      try {
        map.setFilter("school-isochrones-fill", null);
      } catch (e2) {
        /* ignore */
      }
    }
    syncTravelShedLegend();
  }

  function applyGeoJsonLayersFromFetchResults(results, opts) {
    var fitBounds = !opts || opts.fitBounds !== false;
    /* Index map (see Promise.all in the load handler — travelImpact slot
       removed, so isochrones / employee / private / homeschool shifted down by 1). */
    var es = results[0];
    var ms = results[1];
    var hs = results[2];
    var schools = enrichSchoolsFcWithMasterType(results[3]);
    CHOICE_SCHOOL_MSIDS = buildChoiceSchoolMsidSet(schools);
    var studentHexFc = results[6];
    var schoolParcelsRaw = results[7];
    var schoolBoardFc = results[8];
    var charterFc = prepareCharterSchoolsMapFc(results[9]);
    var municipalFc = results[11];
    var privateFc = preparePrivateSchoolsMapFc(results[15]);
    var homeschoolFc = results[16];
    CHARTER_SCHOOL_MSIDS = buildCharterSchoolMsidSet(schools, charterFc);
    SCHOOL_ISOCHRONES_ENRICHED = buildSchoolIsochronesEnriched(
      results[13] || { type: "FeatureCollection", features: [] }
    );

    if (map.getSource("es-boundaries")) {
      refreshGeoJsonSourcesAfterStyleReload(results, {
        fitBounds: fitBounds,
      });
      return;
    }

    var boundarySourceOpts = { type: "geojson", promoteId: "MSID" };

        map.addSource("es-boundaries", Object.assign({ data: es }, boundarySourceOpts));
        map.addSource("ms-boundaries", Object.assign({ data: ms }, boundarySourceOpts));
        map.addSource("hs-boundaries", Object.assign({ data: hs }, boundarySourceOpts));
        map.addSource("schools", {
          type: "geojson",
          data: schools,
          promoteId: "SCHOOLS_ID",
        });
        map.addSource("municipal-boundaries", {
          type: "geojson",
          data: municipalFc || { type: "FeatureCollection", features: [] },
        });

        map.addSource("school-board-districts", {
          type: "geojson",
          data: schoolBoardFc || { type: "FeatureCollection", features: [] },
          promoteId: "OBJECTID",
        });
        map.addLayer({
          id: "school-board-districts-fill",
          type: "fill",
          source: "school-board-districts",
          paint: {
            "fill-color": "#000000",
            "fill-opacity": 0,
          },
          layout: { visibility: "none" },
        });
        map.addLayer({
          id: "school-board-districts-outline",
          type: "line",
          source: "school-board-districts",
          paint: {
            "line-color": "#374151",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              2,
              12,
              2.5,
              16,
              3.5,
            ],
            "line-opacity": 0.95,
          },
          layout: { visibility: "none" },
        });

        map.addLayer({
          id: "municipal-boundaries-fill",
          type: "fill",
          source: "municipal-boundaries",
          paint: {
            "fill-color": "#000000",
            "fill-opacity": 0,
          },
          layout: { visibility: "none" },
        });
        map.addLayer({
          id: "municipal-boundaries-outline",
          type: "line",
          source: "municipal-boundaries",
          paint: {
            "line-color": "#9ca3af",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              1.35,
              12,
              1.75,
              16,
              2.5,
            ],
            "line-opacity": 0.95,
          },
          layout: { visibility: "none" },
        });
        /** Hover stroke only: filter toggled on mousemove. Placed above assignment fills after `moveLayer` below. */
        map.addLayer({
          id: "municipal-boundaries-hover",
          type: "line",
          source: "municipal-boundaries",
          filter: ["==", ["to-string", ["get", "OBJECTID"]], MUN_HOVER_FILTER_OFF],
          paint: {
            "line-color": "#374151",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              2,
              12,
              2.5,
              16,
              3.5,
            ],
            "line-opacity": 1,
          },
          layout: { visibility: "none" },
        });

        map.addLayer({
          id: "hs-fill",
          type: "fill",
          source: "hs-boundaries",
          paint: {
            "fill-color": PALETTE.high.fill,
            "fill-opacity": BOUNDARY_FILL_OPACITY,
          },
        });
        map.addLayer({
          id: "hs-outline",
          type: "line",
          source: "hs-boundaries",
          paint: Object.assign({}, outlinePaintBase, {
            "line-color": PALETTE.high.line,
          }),
        });
        map.addLayer({
          id: "ms-fill",
          type: "fill",
          source: "ms-boundaries",
          paint: {
            "fill-color": PALETTE.middle.fill,
            "fill-opacity": BOUNDARY_FILL_OPACITY,
          },
        });
        map.addLayer({
          id: "ms-outline",
          type: "line",
          source: "ms-boundaries",
          paint: Object.assign({}, outlinePaintBase, {
            "line-color": PALETTE.middle.line,
          }),
        });
        map.addLayer({
          id: "es-fill",
          type: "fill",
          source: "es-boundaries",
          paint: {
            "fill-color": PALETTE.elementary.fill,
            "fill-opacity": BOUNDARY_FILL_OPACITY,
          },
        });
        map.addLayer({
          id: "es-outline",
          type: "line",
          source: "es-boundaries",
          paint: Object.assign({}, outlinePaintBase, {
            "line-color": PALETTE.elementary.line,
          }),
        });

        var schoolParcelsFc = buildFilteredSchoolParcelsFc(
          schools,
          schoolParcelsRaw
        );
        map.addSource("school-parcels", {
          type: "geojson",
          data: schoolParcelsFc,
        });
        var schoolParcelLineLayout = { visibility: "visible" };
        var schoolParcelLinePaintBase = {
          "line-width": 1.5,
          "line-opacity": 0.9,
          "line-dasharray": [4, 3],
        };
        map.addLayer({
          id: "school-parcels-high",
          type: "line",
          source: "school-parcels",
          filter: ["==", ["get", "_parcelLevel"], "high"],
          layout: schoolParcelLineLayout,
          paint: Object.assign({}, schoolParcelLinePaintBase, {
            "line-color": PALETTE.high.line,
          }),
        });
        map.addLayer({
          id: "school-parcels-middle",
          type: "line",
          source: "school-parcels",
          filter: ["==", ["get", "_parcelLevel"], "middle"],
          layout: schoolParcelLineLayout,
          paint: Object.assign({}, schoolParcelLinePaintBase, {
            "line-color": PALETTE.middle.line,
          }),
        });
        map.addLayer({
          id: "school-parcels-jr-sr",
          type: "line",
          source: "school-parcels",
          filter: ["==", ["get", "_parcelLevel"], "jr_sr"],
          layout: schoolParcelLineLayout,
          paint: Object.assign({}, schoolParcelLinePaintBase, {
            "line-color": PALETTE.jrSr.line,
          }),
        });
        map.addLayer({
          id: "school-parcels-elementary",
          type: "line",
          source: "school-parcels",
          filter: ["==", ["get", "_parcelLevel"], "elementary"],
          layout: schoolParcelLineLayout,
          paint: Object.assign({}, schoolParcelLinePaintBase, {
            "line-color": PALETTE.elementary.line,
          }),
        });

        map.addSource("school-isochrones", {
          type: "geojson",
          /* Empty until `syncTravelShedLayerFilter` (Mapbox v3 rejects legacy filter ["==", 1, 0]). */
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "school-isochrones-fill",
          type: "fill",
          source: "school-isochrones",
          paint: {
            "fill-color": [
              "match",
              ["to-number", ["get", "iso_miles"]],
              1,
              "#fffbeb",
              2,
              "#fef3c7",
              3,
              "#fde68a",
              4,
              "#fcd34d",
              5,
              "#fbbf24",
              6,
              "#d97706",
              7,
              "#b45309",
              8,
              "#92400e",
              9,
              "#78350f",
              10,
              "#451a03",
              "rgba(212, 212, 216, 0.35)",
            ],
            "fill-opacity": [
              "match",
              ["to-number", ["get", "iso_miles"]],
              1,
              0.52,
              2,
              0.46,
              3,
              0.4,
              4,
              0.35,
              5,
              0.3,
              6,
              0.25,
              7,
              0.2,
              8,
              0.16,
              9,
              0.12,
              10,
              0.1,
              0.2,
            ],
          },
          layout: { visibility: "none" },
        });
        map.addLayer({
          id: "school-isochrones-outline",
          type: "line",
          source: "school-isochrones",
          filter: ["==", ["get", "iso_outer"], "yes"],
          paint: {
            "line-color": "#5c2e0e",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              9,
              1.75,
              12,
              2.5,
              16,
              3.5,
            ],
            "line-opacity": 0.95,
          },
          layout: { visibility: "none" },
        });

        map.addSource("student-hex", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "student-hex-heatmap",
          type: "heatmap",
          source: "student-hex",
          paint: {
            /**
             * Sqrt of count shrinks the gap between large weights so a few very high–count hexes do not
             * wash the whole district into the high end of `heatmap-density` after Mapbox’s normalization.
             */
            "heatmap-weight": [
              "max",
              0,
              [
                "sqrt",
                [
                  "max",
                  0,
                  ["to-number", ["get", "count"]],
                ],
              ],
            ],
            "heatmap-intensity": HEAT_RESIDENCE_INTENSITY,
            /** Tighter kernel at z16+ = sharper local peaks when zoomed in. */
            "heatmap-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              16,
              11,
              30,
              14,
              42,
              16,
              32,
              17,
              28,
            ],
            "heatmap-opacity": 0.88,
            /* Default: district 0.45 remapped keys; per-school view overrides in applyResidenceHeatmapSymbology. */
            "heatmap-color": HEAT_STUDENT_RAMP_UNIFORM,
          },
          layout: { visibility: "none" },
        });

        map.addSource("student-hex-hit", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "student-hex-hit-fill",
          type: "fill",
          source: "student-hex-hit",
          paint: {
            "fill-opacity": 0,
            "fill-color": "#000000",
          },
          layout: { visibility: "none" },
        });

        map.addSource("charter-student-hex", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "charter-student-hex-heatmap",
          type: "heatmap",
          source: "charter-student-hex",
          paint: {
            "heatmap-weight": [
              "max",
              0,
              [
                "sqrt",
                [
                  "max",
                  0,
                  ["to-number", ["get", "count"]],
                ],
              ],
            ],
            "heatmap-intensity": HEAT_RESIDENCE_INTENSITY,
            "heatmap-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              16,
              11,
              30,
              14,
              42,
              16,
              32,
              17,
              28,
            ],
            "heatmap-opacity": 0.88,
            "heatmap-color": HEAT_CHARTER_RAMP_UNIFORM,
          },
          layout: { visibility: "none" },
        });
        applyResidenceHeatmapSymbology();
        map.addSource("charter-student-hex-hit", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "charter-student-hex-hit-fill",
          type: "fill",
          source: "charter-student-hex-hit",
          paint: {
            "fill-opacity": 0,
            "fill-color": "#000000",
          },
          layout: { visibility: "none" },
        });

        map.addSource("homeschool-student-hex", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "homeschool-student-hex-heatmap",
          type: "heatmap",
          source: "homeschool-student-hex",
          paint: {
            "heatmap-weight": [
              "max",
              0,
              [
                "sqrt",
                [
                  "max",
                  0,
                  ["to-number", ["get", "count"]],
                ],
              ],
            ],
            "heatmap-intensity": HEAT_RESIDENCE_INTENSITY,
            "heatmap-radius": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              16,
              11,
              30,
              14,
              42,
              16,
              32,
              17,
              28,
            ],
            "heatmap-opacity": 0.88,
            "heatmap-color": HEAT_HOMESCHOOL_RAMP_UNIFORM,
          },
          layout: { visibility: "none" },
        });
        map.addSource("homeschool-student-hex-hit", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "homeschool-student-hex-hit-fill",
          type: "fill",
          source: "homeschool-student-hex-hit",
          paint: {
            "fill-opacity": 0,
            "fill-color": "#000000",
          },
          layout: { visibility: "none" },
        });

        map.addSource("boundary-sandbox-lasso-region-fill", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "boundary-sandbox-lasso-region-fill",
          type: "fill",
          source: "boundary-sandbox-lasso-region-fill",
          paint: {
            "fill-color": "#84cc16",
            "fill-opacity": 0.14,
          },
          layout: { visibility: "none" },
        });
        map.addSource("boundary-sandbox-lasso-region-outline", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "boundary-sandbox-lasso-region-outline",
          type: "line",
          source: "boundary-sandbox-lasso-region-outline",
          paint: {
            "line-color": "#65a30d",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              1,
              12,
              1.25,
              16,
              1.5,
            ],
            "line-opacity": 0.88,
          },
          layout: {
            "line-cap": "round",
            "line-join": "round",
            visibility: "none",
          },
        });
        map.addSource("boundary-sandbox-hex", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
          promoteId: "_hexKey",
        });
        map.addLayer({
          id: "boundary-sandbox-hex-fill",
          type: "fill",
          source: "boundary-sandbox-hex",
          paint: {
            "fill-color": [
              "match",
              ["coalesce", ["feature-state", "boundaryId"], ""],
              SANDBOX_BOUNDARY_PALETTE[0].id, SANDBOX_BOUNDARY_PALETTE[0].fill,
              SANDBOX_BOUNDARY_PALETTE[1].id, SANDBOX_BOUNDARY_PALETTE[1].fill,
              SANDBOX_BOUNDARY_PALETTE[2].id, SANDBOX_BOUNDARY_PALETTE[2].fill,
              SANDBOX_BOUNDARY_PALETTE[3].id, SANDBOX_BOUNDARY_PALETTE[3].fill,
              SANDBOX_BOUNDARY_PALETTE[4].id, SANDBOX_BOUNDARY_PALETTE[4].fill,
              "#84cc16",
            ],
            "fill-opacity": [
              "case",
              ["==", ["coalesce", ["feature-state", "boundaryId"], ""], ""], 0,
              0.45,
            ],
          },
          layout: { visibility: "none" },
        });
        map.addSource("boundary-sandbox-selection-outline", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "boundary-sandbox-selection-outline-line",
          type: "line",
          source: "boundary-sandbox-selection-outline",
          paint: {
            "line-color": "#65a30d",
            "line-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              8,
              2,
              12,
              2.75,
              16,
              3.5,
            ],
            "line-opacity": 0.92,
          },
          /* Round caps/joins close the tiny gaps at hex corners: the outline is
             emitted as many separate 2-vertex edge segments (not chained rings),
             so butt caps leave hairline gaps where segments meet at a vertex. */
          layout: {
            "line-cap": "round",
            "line-join": "round",
            visibility: "none",
          },
        });
        map.addSource("boundary-sandbox-lasso-trace", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "boundary-sandbox-lasso-line",
          type: "line",
          source: "boundary-sandbox-lasso-trace",
          paint: {
            "line-color": "#64748b",
            "line-width": 2,
            "line-opacity": 0.9,
          },
          layout: { visibility: "none" },
        });

        var schoolMapHighlightStateAny = [
          "any",
          ["==", ["feature-state", "ring"], true],
          ["==", ["feature-state", "selected"], true],
          ["==", ["feature-state", "scenarioFeeder"], true],
        ];
        var schoolMapCircleBasePaint = {
          "circle-pitch-alignment": "map",
          "circle-radius": SCHOOL_MAP_CIRCLE_RADIUS_ZOOM,
          "circle-stroke-width": [
            "case",
            schoolMapHighlightStateAny,
            5.5,
            1,
          ],
          "circle-stroke-opacity": 1,
          "circle-opacity": 0.92,
        };

        map.addLayer({
          id: "schools-elementary",
          type: "circle",
          source: "schools",
          filter: ["==", ["get", "TYPE"], "ELEMENTARY"],
          paint: Object.assign({}, schoolMapCircleBasePaint, {
            "circle-color": PALETTE.elementary.fill,
            "circle-stroke-color": [
              "case",
              schoolMapHighlightStateAny,
              PALETTE.elementary.highlightStroke,
              schoolMapCircleStrokeColorDefault,
            ],
          }),
        });
        map.addLayer({
          id: "schools-middle",
          type: "circle",
          source: "schools",
          filter: ["==", ["get", "TYPE"], "MIDDLE"],
          paint: Object.assign({}, schoolMapCircleBasePaint, {
            "circle-color": PALETTE.middle.fill,
            "circle-stroke-color": [
              "case",
              schoolMapHighlightStateAny,
              PALETTE.middle.highlightStroke,
              schoolMapCircleStrokeColorDefault,
            ],
          }),
        });
        map.addLayer({
          id: "schools-high",
          type: "circle",
          source: "schools",
          filter: [
            "any",
            ["==", ["get", "TYPE"], "HIGH"],
            ["==", ["get", "TYPE"], "JR SR HIGH"],
          ],
          paint: Object.assign({}, schoolMapCircleBasePaint, {
            "circle-color": [
              "match",
              ["get", "TYPE"],
              "HIGH",
              PALETTE.high.fill,
              "JR SR HIGH",
              PALETTE.jrSr.fill,
              PALETTE.high.fill,
            ],
            "circle-stroke-color": [
              "case",
              schoolMapHighlightStateAny,
              [
                "match",
                ["get", "TYPE"],
                "HIGH",
                PALETTE.high.highlightStroke,
                "JR SR HIGH",
                PALETTE.jrSr.highlightStroke,
                PALETTE.high.highlightStroke,
              ],
              schoolMapCircleStrokeColorDefault,
            ],
          }),
        });
        map.addSource("charter-schools", {
          type: "geojson",
          data: charterFc || { type: "FeatureCollection", features: [] },
          promoteId: "OBJECTID",
        });
        map.addLayer({
          id: "schools-charter",
          type: "circle",
          source: "charter-schools",
          filter: ["==", ["get", "TYPE"], "CHARTER"],
          paint: Object.assign({}, schoolMapCircleBasePaint, {
            "circle-color": PALETTE.charter.fill,
            "circle-stroke-color": [
              "case",
              schoolMapHighlightStateAny,
              PALETTE.charter.highlightStroke,
              schoolMapCircleStrokeColorDefault,
            ],
          }),
        });
        map.addSource("private-schools", {
          type: "geojson",
          data: privateFc || { type: "FeatureCollection", features: [] },
          promoteId: "FID",
        });
        map.addLayer({
          id: "schools-private",
          type: "circle",
          source: "private-schools",
          paint: Object.assign({}, schoolMapCircleBasePaint, {
            "circle-color": PALETTE.privateSchool.fill,
            "circle-stroke-color": [
              "case",
              schoolMapHighlightStateAny,
              PALETTE.privateSchool.highlightStroke,
              schoolMapCircleStrokeColorDefault,
            ],
          }),
        });

        ["schools-elementary", "schools-middle", "schools-high", "schools-charter", "schools-private"].forEach(
          function (lid) {
            if (map.getLayer(lid)) {
              map.moveLayer(lid);
            }
          }
        );

        /* School name labels: only visible once zoomed past the neighborhood-scale
           privacy threshold (same zoom that hides the residence density heatmaps).
           Each label layer is tied to its point-layer toggle (see setupToggles),
           and text is colored to match the school type's swatch. */
        var schoolLabelBaseLayout = {
          visibility: "none",
          "text-field": ["coalesce", ["get", "_mapLabel"], ""],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 11,
          "text-anchor": "top",
          "text-offset": [0, 0.85],
          "text-max-width": 9,
          "text-padding": 2,
          "text-optional": true,
        };
        function addSchoolLabelLayer(id, src, filter, textColor) {
          if (map.getLayer(id)) return;
          var def = {
            id: id,
            type: "symbol",
            source: src,
            /* One full zoom stop further out than the density-hide threshold, so
               labels appear a bit earlier than that privacy zoom level. */
            minzoom: RESIDENCE_HEATMAP_HIDE_ZOOM - 1,
            layout: schoolLabelBaseLayout,
            paint: {
              "text-color": textColor,
              "text-halo-color": "#ffffff",
              "text-halo-width": 1.6,
              "text-halo-blur": 0.3,
              "text-opacity": 0.96,
            },
          };
          if (filter) def.filter = filter;
          map.addLayer(def);
        }
        /* Label collision priority: in Mapbox GL JS, when labels collide the
           LATER-added layer wins. Add lowest priority first so that, on overlap,
           traditional school labels beat charter, and charter beats private:
           private (first) < charter < elementary/middle/high (last). */
        addSchoolLabelLayer(
          "schools-private-label",
          "private-schools",
          null,
          /* Gold midway between the dark text gold (#a16207) and the private
             swatch fill (#eab308) — readable against white, a hair brighter. */
          "#c68b08"
        );
        addSchoolLabelLayer(
          "schools-charter-label",
          "charter-schools",
          ["==", ["get", "TYPE"], "CHARTER"],
          PALETTE.charter.fill
        );
        addSchoolLabelLayer(
          "schools-elementary-label",
          "schools",
          ["==", ["get", "TYPE"], "ELEMENTARY"],
          PALETTE.elementary.fill
        );
        addSchoolLabelLayer(
          "schools-middle-label",
          "schools",
          ["==", ["get", "TYPE"], "MIDDLE"],
          PALETTE.middle.fill
        );
        addSchoolLabelLayer(
          "schools-high-label",
          "schools",
          ["any", ["==", ["get", "TYPE"], "HIGH"], ["==", ["get", "TYPE"], "JR SR HIGH"]],
          [
            "match",
            ["get", "TYPE"],
            "JR SR HIGH",
            PALETTE.jrSr.fill,
            PALETTE.high.fill,
          ]
        );

        /**
         * Default stack draws municipal hover under HS/MS/ES fills — the stroke is invisible. Place it above
         * assignment boundaries (before parcels) so the hover line is actually visible.
         */
        if (map.getLayer("municipal-boundaries-hover") && map.getLayer("school-parcels-high")) {
          try {
            map.moveLayer("municipal-boundaries-hover", "school-parcels-high");
          } catch (errMh) {
            /* ignore */
          }
        }

        var combined = null;
        combined = mergeBbox(combined, computeBbox(es));
        combined = mergeBbox(combined, computeBbox(ms));
        combined = mergeBbox(combined, computeBbox(hs));
        combined = mergeBbox(combined, computeBbox(schools));
        combined = mergeBbox(combined, computeBbox(schoolParcelsFc));
        combined = mergeBbox(combined, computeBbox(charterFc));
        combined = mergeBbox(combined, computeBbox(privateFc));

        map.resize();
        if (fitBounds && combined) {
          map.fitBounds(combined, { padding: 48, maxZoom: 12, duration: 0 });
        }
        requestAnimationFrame(function () {
          map.resize();
        });

        GEO_CACHE.es = es;
        GEO_CACHE.ms = ms;
        GEO_CACHE.hs = hs;
        GEO_CACHE.schools = schools;
        GEO_CACHE.charter = charterFc || null;
        GEO_CACHE.private = privateFc || null;
        resetSandboxHexInCountyCache();

        /* Build homeschool fallback geometry first so the filler mesh can treat those
           cells as occupied (prevents overlapping filler hexes on homeschool hexes). */
        HOMESCHOOL_HEX_GEOMETRY_FALLBACK = buildHomeschoolHexGeometryFallback(
          homeschoolFc && homeschoolFc.features ? homeschoolFc : null
        );
        if (studentHexFc && studentHexFc.features && studentHexFc.features.length) {
          STUDENT_HEX_INDEX = buildStudentHexIndex(studentHexFc);
          scenarioPkStudentMsidCache = Object.create(null);
          TRAVEL_SHED_RESIDENCE_INDEX = buildTravelShedResidenceIndex(studentHexFc);
          EMPTY_HEX_GEOMETRY = buildEmptyHexGeometryMesh(
            STUDENT_HEX_INDEX ? STUDENT_HEX_INDEX.geometryByHexKey : null,
            HOMESCHOOL_HEX_GEOMETRY_FALLBACK,
            [].concat(
              es && es.features ? es.features : [],
              ms && ms.features ? ms.features : [],
              hs && hs.features ? hs.features : []
            )
          );
        } else {
          STUDENT_HEX_INDEX = null;
          TRAVEL_SHED_RESIDENCE_INDEX = null;
          EMPTY_HEX_GEOMETRY = null;
        }
        rebuildCharterAttendanceGradesLabelByMsid();
        HOMESCHOOL_HEX_COUNTS = buildHomeschoolHexCounts(
          homeschoolFc && homeschoolFc.features ? homeschoolFc : null
        );
        HOMESCHOOL_DETAILS_BY_HEX_KEY = buildHomeschoolDetailsByHexKey(
          homeschoolFc && homeschoolFc.features ? homeschoolFc : null
        );
        clearHomeschoolInBoundaryCountCache();

        if (!mapLayersInitialized) {
          mapLayersInitialized = true;
          var schoolByMsid = buildSchoolLookup(schools);
          populateSchoolSelect(schools);
          populateScenarioSchoolSelect(schools);
          populateFeedbackSchoolCommunitiesSelect(schools, charterFc, privateFc);
          setupToggles();
          setupMapInteractions(schoolByMsid);
          setupSchoolSelection(schoolByMsid);
          setupScenarioSchoolSelection(schoolByMsid, schools);
          initDashboardResizer(map);
          initMobileDashboard(map);
          clearSelectedSchoolHighlight();
          syncStudentHexLayer();
          renderEnrollmentChart(null);
          renderDemographicsCharts(null);
        } else {
          populateFeedbackSchoolCommunitiesSelect(schools, charterFc, privateFc);
          syncStudentHexLayer();
          refreshAssignmentBoundaryHighlight();
          if (selectedSchoolMsid != null) {
            try {
              map.setFeatureState(
                { source: "schools", id: selectedSchoolMsid },
                { selected: true }
              );
            } catch (e) {
              /* ignore */
            }
          }
          resyncToolbarLayerToggleVisibility();
        }
        applyScenarioFeederMapHighlights();
        syncTravelShedLayerFilter();
        rebuildBoundarySandboxHexSourceFromIndex();
        syncBoundarySandboxMapLayers();
        /* Initialize multi-boundary sandbox: one starter boundary so users can draw immediately. */
        ensureSandboxHasAtLeastOneBoundary();
        renderSandboxBoundariesPanel();
        renderSandboxSummaryTable();
  }

  map.on("style.load", function () {
    if (!geoJsonDataCache) return;
    applyGeoJsonLayersFromFetchResults(geoJsonDataCache, { fitBounds: false });
  });

  map.on("load", function () {
    if (!MAPBOX_ACCESS_TOKEN) return;
    setupMapDensityLegendViewListeners();
    var basemapRoot = document.getElementById("basemap-toggle");
    if (basemapRoot) {
      basemapRoot.querySelectorAll("[data-basemap]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var mode = btn.getAttribute("data-basemap");
          if (MAPBOX_STYLES[mode]) setMapboxBasemap(mode);
        });
      });
    }

    Promise.all([
      smartFetch(DATA.es).then(function (r) {
        return r.json();
      }),
      smartFetch(DATA.ms).then(function (r) {
        return r.json();
      }),
      smartFetch(DATA.hs).then(function (r) {
        return r.json();
      }),
      smartFetch(DATA.schools).then(function (r) {
        return r.json();
      }),
      loadSchoolMasterByMsid(),
      smartFetch(DATA.sankeyEsMs)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.studentHexagons)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(function (data) {
          if (!data) {
            return null;
          }
          if (data.v === 2) {
            return expandStudentHexBundleToFeatureCollection(data);
          }
          if (data.type === "FeatureCollection") {
            return data;
          }
          return null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.schoolParcels)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.schoolBoardDistricts)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
      smartFetch(DATA.charterSchoolLocations)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
      smartFetch(DATA.meadowlaneCaptureOverride)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.municipalBoundaries)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
      smartFetch(DATA.eseFeederMatrix)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.schoolIsochrones)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
      smartFetch(DATA.bpsEmployeeCount)
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .catch(function () {
          return null;
        }),
      smartFetch(DATA.privateSchoolLocations)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
      smartFetch(DATA.homeschoolStudentHexagons)
        .then(function (r) {
          return r.ok ? r.json() : { type: "FeatureCollection", features: [] };
        })
        .catch(function () {
          return { type: "FeatureCollection", features: [] };
        }),
    ])
      .then(function (results) {
        /* Index map (kept aligned with the Promise.all order above):
             0  es                     6  studentHexagons       12  eseFeederMatrix
             1  ms                     7  schoolParcels         13  schoolIsochrones
             2  hs                     8  schoolBoardDistricts  14  bpsEmployeeCount
             3  schools                9  charterSchoolLocations 15  privateSchoolLocations
             4  masterByMsid (object) 10  meadowlaneCapture…    16  homeschoolStudentHexagons
             5  sankeyEsMs            11  municipalBoundaries
           travelImpact was removed (#4) — its slot is gone, all later indices shift down by 1. */
        MASTER_BY_MSID = results[4] || null;
        SANKEY_CACHE = results[5];
        geoJsonDataCache = results;
        MEADOWLANE_CAPTURE_OVERRIDE = results[10];
        ESE_FEEDER_MATRIX = results[12] || null;
        BPS_EMPLOYEE_COUNT_BY_MSID =
          results[14] && results[14].byMsid ? results[14].byMsid : null;
        MIDDLE_SCHOOL_MSID_SET = buildMiddleSchoolMsidSetFromSchoolsFc(
          enrichSchoolsFcWithMasterType(results[3])
        );
        if (MEADOWLANE_CAPTURE_OVERRIDE && MEADOWLANE_CAPTURE_OVERRIDE.zoning_audit) {
          var za =
            MEADOWLANE_CAPTURE_OVERRIDE.zoning_audit
              .student_count_with_zoned_msid_2031_in_any_column;
          if (za != null && !isNaN(Number(za)) && Number(za) > 0) {
            console.warn(
              "[Meadowlane] zoning_audit: non-zero count of students with zoned MSID 2031 in a zoning column:",
              za
            );
          }
        }
        applyGeoJsonLayersFromFetchResults(results, { fitBounds: true });
        var selAfter = document.getElementById("school-select");
        if (selAfter && selAfter.value) {
          renderEseFeederFlowsTable(Number(selAfter.value));
        } else {
          renderEseFeederFlowsTable(null);
        }
        hideMapLoadingOverlay();
      })
      .catch(function (err) {
        console.error(err);
        hideMapLoadingOverlay();
        alert(
          "Could not load GeoJSON data. Use Live Server (or any local web server) from this project folder so files under /geo can be fetched."
        );
      });
  });

  /** Safety net if map load or data fetch hangs (e.g. missing deploy artifacts). */
  setTimeout(function () {
    var el = document.getElementById("map-loading-overlay");
    if (!el || el.classList.contains("is-hidden")) return;
    showMapLoadingOverlayMessage(
      "Loading is taking longer than expected",
      "If this is the public GitHub Pages site, confirm deployment includes config.local.js and school master JSON shards."
    );
  }, 120000);

  function buildSchoolLookup(schoolsFc) {
    var byMsid = {};
    if (!schoolsFc || !schoolsFc.features) return byMsid;
    schoolsFc.features.forEach(function (ft) {
      var p = ft.properties;
      if (p && p.SCHOOLS_ID != null) byMsid[p.SCHOOLS_ID] = p;
    });
    return byMsid;
  }

  function buildChoiceSchoolMsidSet(schoolsFc) {
    var o = {};
    if (!schoolsFc || !schoolsFc.features) return o;
    for (var i = 0; i < schoolsFc.features.length; i++) {
      var p = schoolsFc.features[i].properties;
      if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") continue;
      if (String(p.SchAB_Type || "").toUpperCase() !== "CHOICE") continue;
      o[String(p.SCHOOLS_ID)] = true;
    }
    return o;
  }

  /** @returns {Object<string, true>} */
  function buildCharterSchoolMsidSet(schoolsFc, charterFc) {
    var o = {};
    function addProps(p) {
      if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") return;
      var t = String(p.TYPE || "").toUpperCase();
      var ab = String(p.SchAB_Type || "").toUpperCase();
      if (t !== "CHARTER" && ab !== "CHARTER") return;
      var id = parseInt(String(p.SCHOOLS_ID).trim(), 10);
      if (isNaN(id)) return;
      o[String(id)] = true;
    }
    if (schoolsFc && schoolsFc.features) {
      for (var i = 0; i < schoolsFc.features.length; i++) {
        addProps(schoolsFc.features[i].properties);
      }
    }
    if (charterFc && charterFc.features) {
      for (var j = 0; j < charterFc.features.length; j++) {
        addProps(charterFc.features[j].properties);
      }
    }
    return o;
  }

  /**
   * Builds `CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID`: for each charter MSID, min–max grade among
   * student-hex detail rows with that attendance MSID (consecutive span for display, e.g. K–5).
   */
  function rebuildCharterAttendanceGradesLabelByMsid() {
    CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID = null;
    if (
      !STUDENT_HEX_INDEX ||
      !STUDENT_HEX_INDEX.detailsByMsid ||
      !CHARTER_SCHOOL_MSIDS
    ) {
      return;
    }
    var detRoot = STUDENT_HEX_INDEX.detailsByMsid;
    var out = Object.create(null);
    for (var sk in CHARTER_SCHOOL_MSIDS) {
      if (!Object.prototype.hasOwnProperty.call(CHARTER_SCHOOL_MSIDS, sk)) continue;
      var perHex = detRoot[sk];
      if (!perHex) continue;
      var ordsObj = Object.create(null);
      for (var hexKey in perHex) {
        if (!Object.prototype.hasOwnProperty.call(perHex, hexKey)) continue;
        var arr = perHex[hexKey];
        for (var i = 0; i < arr.length; i++) {
          var c = canonicalStudentGradeCode(arr[i].Grade);
          var o = charterGradeCanonToOrdinal(c);
          if (o != null && isFinite(o)) ordsObj[o] = true;
        }
      }
      var ords = Object.keys(ordsObj)
        .map(Number)
        .sort(function (a, b) {
          return a - b;
        });
      if (!ords.length) continue;
      var minO = ords[0];
      var maxO = ords[ords.length - 1];
      var a = privateSchoolGradeOrdinalLabel(minO);
      var b = privateSchoolGradeOrdinalLabel(maxO);
      var label = minO === maxO ? a : a + "–" + b;
      out[sk] = label;
      var idNum = parseInt(sk, 10);
      if (!isNaN(idNum)) {
        var padded = String(idNum).padStart(4, "0");
        if (padded !== sk) out[padded] = label;
      }
    }
    CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID = out;
  }

  /** Choice or charter schools have no boundary-based "zoned" cohort for student hex overlay. */
  function selectedSchoolDisallowsZonedStudentHex(msid) {
    if (msid == null || isNaN(msid)) return true;
    var k = String(parseInt(String(msid), 10));
    if (CHOICE_SCHOOL_MSIDS && CHOICE_SCHOOL_MSIDS[k]) return true;
    if (CHARTER_SCHOOL_MSIDS && CHARTER_SCHOOL_MSIDS[k]) return true;
    return false;
  }

  /** @returns {boolean} */
  function schoolIsChoiceFromProps(p) {
    return !!p && String(p.SchAB_Type || "").toUpperCase() === "CHOICE";
  }

  /** @returns {boolean} */
  function schoolIsChoiceMsid(msid) {
    if (msid == null || isNaN(msid)) return false;
    var k = String(Number(msid));
    return !!(CHOICE_SCHOOL_MSIDS && CHOICE_SCHOOL_MSIDS[k]);
  }

  /**
   * Eligible base school for the new consolidated Scenario tab: any school where
   * appears_in_dropdown=yes AND not flagged CHOICE AND has a defined ES/MS/HS boundary polygon.
   * @returns {boolean}
   */
  function isScenarioDestinationSchoolMsid(msid) {
    if (msid == null || isNaN(msid) || schoolIsChoiceMsid(msid)) return false;
    var m = masterRow(msid);
    if (!m) return false;
    if (String(m.appears_in_dropdown || "").trim().toLowerCase() !== "yes") {
      return false;
    }
    var lv = String(m.school_level || "").trim().toLowerCase();
    if (lv !== "elementary" && lv !== "middle" && lv !== "high" && lv !== "jr_sr_high") {
      return false;
    }
    /* Must have a boundary polygon in ES/MS/HS GeoJSON. */
    return !!findBoundarySourceForMsid(Number(msid));
  }

  /**
   * Adjacency rule for a base school's school_level. Returns the set of allowed
   * non-base school_level values for consolidation.
   *  - elementary → ES, MS, jr_sr_high
   *  - middle     → any (ES, MS, HS, jr_sr_high)
   *  - high       → MS, HS, jr_sr_high
   *  - jr_sr_high → any
   */
  function allowedConsolidationLevelsFor(baseLevel) {
    var lv = String(baseLevel || "").toLowerCase();
    if (lv === "elementary") return { elementary: 1, middle: 1, jr_sr_high: 1 };
    if (lv === "middle")     return { elementary: 1, middle: 1, high: 1, jr_sr_high: 1 };
    if (lv === "high")       return { middle: 1, high: 1, jr_sr_high: 1 };
    if (lv === "jr_sr_high") return { elementary: 1, middle: 1, high: 1, jr_sr_high: 1 };
    return {};
  }

  /** Great-circle distance in miles between two lon/lat points. */
  function haversineMilesLngLat(a, b) {
    if (!a || !b) return NaN;
    var R = 3958.7613;
    var toRad = Math.PI / 180;
    var dLat = (b[1] - a[1]) * toRad;
    var dLon = (b[0] - a[0]) * toRad;
    var lat1 = a[1] * toRad;
    var lat2 = b[1] * toRad;
    var s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(lat1) * Math.cos(lat2);
    var c = 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
    return R * c;
  }

  function schoolPointLngLat(p) {
    if (!p) return null;
    if (p.Longitude != null && p.Latitude != null) {
      var lo = Number(p.Longitude);
      var la = Number(p.Latitude);
      if (!isNaN(lo) && !isNaN(la)) return [lo, la];
    }
    return null;
  }

  /** Closest N eligible schools whose level is adjacency-allowed for the base; excludes the base. */
  function compute10ClosestEligibleSchools(baseMsid, schoolsFc, limit) {
    var n = limit && !isNaN(limit) ? Number(limit) : 10;
    if (baseMsid == null || isNaN(baseMsid) || !schoolsFc || !schoolsFc.features) return [];
    var baseM = masterRow(baseMsid);
    if (!baseM) return [];
    var allowed = allowedConsolidationLevelsFor(baseM.school_level);
    if (!Object.keys(allowed).length) return [];
    /* Resolve base lng/lat from the GeoJSON. */
    var baseLL = null;
    for (var i = 0; i < schoolsFc.features.length; i++) {
      var prB = schoolsFc.features[i].properties || {};
      if (prB.SCHOOLS_ID != null && Number(prB.SCHOOLS_ID) === Number(baseMsid)) {
        var g = schoolsFc.features[i].geometry;
        if (g && g.type === "Point" && Array.isArray(g.coordinates)) baseLL = g.coordinates;
        else baseLL = schoolPointLngLat(prB);
        break;
      }
    }
    if (!baseLL) return [];
    var cands = [];
    for (var j = 0; j < schoolsFc.features.length; j++) {
      var pr = schoolsFc.features[j].properties || {};
      var msidJ = pr.SCHOOLS_ID != null ? Number(pr.SCHOOLS_ID) : NaN;
      if (isNaN(msidJ) || msidJ === Number(baseMsid)) continue;
      if (!isScenarioDestinationSchoolMsid(msidJ)) continue;
      var mJ = masterRow(msidJ);
      if (!mJ) continue;
      var lvJ = String(mJ.school_level || "").toLowerCase();
      if (!allowed[lvJ]) continue;
      var gJ = schoolsFc.features[j].geometry;
      var llJ = (gJ && gJ.type === "Point" && Array.isArray(gJ.coordinates))
        ? gJ.coordinates
        : schoolPointLngLat(pr);
      if (!llJ) continue;
      var d = haversineMilesLngLat(baseLL, llJ);
      if (isNaN(d)) continue;
      cands.push({ msid: msidJ, props: pr, miles: d });
    }
    cands.sort(function (a, b) { return a.miles - b.miles; });
    return cands.slice(0, n);
  }

  /** Existing feeder-chain consolidation candidates for `baseMsid` (uses Sankey + msHsFlows). */
  function computeFeederChainConsolidationCandidates(baseMsid, schoolsFc) {
    if (baseMsid == null || isNaN(baseMsid) || !schoolsFc || !schoolsFc.features) return [];
    var bM = masterRow(baseMsid);
    if (!bM) return [];
    var lv = String(bM.school_level || "").toLowerCase();
    var flows = (SANKEY_CACHE && SANKEY_CACHE.flows) ? SANKEY_CACHE.flows : [];
    var msHs = (SANKEY_CACHE && SANKEY_CACHE.msHsFlows) ? SANKEY_CACHE.msHsFlows : [];
    var matches = [];
    function findProps(predicate) {
      for (var i = 0; i < schoolsFc.features.length; i++) {
        var pr = schoolsFc.features[i].properties || {};
        if (predicate(pr)) return pr;
      }
      return null;
    }
    var basePropsP = findProps(function (pr) {
      return pr.SCHOOLS_ID != null && Number(pr.SCHOOLS_ID) === Number(baseMsid);
    });
    /* Helper: derive proportion + msid + props for a given school by name match. */
    function rowForElementary(label, valueOverTotal) {
      var prE = findElementaryPropsBySankeyLabel(label, schoolsFc);
      if (!prE) return null;
      var mEM = prE.SCHOOLS_ID != null ? Number(prE.SCHOOLS_ID) : null;
      return {
        msid: mEM,
        props: prE,
        miles: NaN,
        flowProportion: valueOverTotal,
        sankeyLabel: label,
      };
    }
    if (lv === "middle") {
      /* ES feeders into this MS. */
      var outByEl = elementaryOutgoingTotalsMap(flows);
      var seen = {};
      for (var i = 0; i < flows.length; i++) {
        var f = flows[i];
        if (f.value < 1) continue;
        if (basePropsP && !sankeyMiddleLabelMatchesSchool(f.middle, basePropsP)) continue;
        if (seen[f.elementary]) continue;
        seen[f.elementary] = true;
        var total = outByEl[f.elementary] || 0;
        var row = rowForElementary(f.elementary, total > 0 ? f.value / total : 1);
        if (row && row.msid != null && row.msid !== Number(baseMsid)) {
          matches.push(row);
        }
      }
      /* HS that this MS feeds. */
      for (var k = 0; k < msHs.length; k++) {
        var mh = msHs[k];
        if (mh.value < 1) continue;
        if (basePropsP && !sankeyMiddleLabelMatchesSchool(mh.middle, basePropsP)) continue;
        var hsP = findProps(function (pr) {
          return String(pr.NAME || "").toLowerCase() === String(mh.high || "").toLowerCase()
            || String(pr.CommonName || "").toLowerCase() === String(mh.high || "").toLowerCase();
        });
        if (hsP && hsP.SCHOOLS_ID != null) {
          var msidHs = Number(hsP.SCHOOLS_ID);
          if (msidHs !== Number(baseMsid)) {
            matches.push({
              msid: msidHs, props: hsP, miles: NaN, flowProportion: 1, sankeyLabel: mh.high,
            });
          }
        }
      }
    } else if (lv === "elementary") {
      /* MS that this ES feeds. */
      var elemTotal = 0;
      for (var ai = 0; ai < flows.length; ai++) {
        if (basePropsP && sankeyElementaryLabelMatchesSchool(flows[ai].elementary, basePropsP)) {
          elemTotal += Number(flows[ai].value || 0);
        }
      }
      var seenMs = {};
      for (var bi = 0; bi < flows.length; bi++) {
        var fE = flows[bi];
        if (basePropsP && !sankeyElementaryLabelMatchesSchool(fE.elementary, basePropsP)) continue;
        if (seenMs[fE.middle]) continue;
        seenMs[fE.middle] = true;
        var msP = findProps(function (pr) {
          return String(pr.NAME || "").toLowerCase() === String(fE.middle || "").toLowerCase()
            || String(pr.CommonName || "").toLowerCase() === String(fE.middle || "").toLowerCase();
        });
        if (msP && msP.SCHOOLS_ID != null) {
          var prop = elemTotal > 0 ? fE.value / elemTotal : 1;
          matches.push({
            msid: Number(msP.SCHOOLS_ID), props: msP, miles: NaN,
            flowProportion: prop, sankeyLabel: fE.middle,
          });
        }
      }
    } else if (lv === "high" || lv === "jr_sr_high") {
      /* MS that feed this HS; ES that feed those MS. */
      var feederMsLabels = {};
      for (var ci = 0; ci < msHs.length; ci++) {
        var fH = msHs[ci];
        if (!basePropsP) continue;
        if (String(fH.high || "").toLowerCase() === String(basePropsP.NAME || "").toLowerCase()
          || sankeyHighLabelMatchesSchool(fH.high, basePropsP)) {
          feederMsLabels[fH.middle] = true;
        }
      }
      for (var lab in feederMsLabels) {
        var msPL = findProps(function (pr) {
          return String(pr.NAME || "").toLowerCase() === lab.toLowerCase()
            || String(pr.CommonName || "").toLowerCase() === lab.toLowerCase();
        });
        if (msPL && msPL.SCHOOLS_ID != null && Number(msPL.SCHOOLS_ID) !== Number(baseMsid)) {
          matches.push({
            msid: Number(msPL.SCHOOLS_ID), props: msPL, miles: NaN, flowProportion: 1, sankeyLabel: lab,
          });
        }
      }
      /* ES → these MS. */
      var seenEs = {};
      for (var di = 0; di < flows.length; di++) {
        var fEs = flows[di];
        if (!feederMsLabels[fEs.middle]) continue;
        if (seenEs[fEs.elementary]) continue;
        seenEs[fEs.elementary] = true;
        var esRow = rowForElementary(fEs.elementary, 1);
        if (esRow) matches.push(esRow);
      }
    }
    /* Filter out duplicates and rows whose msid is the base. */
    var seenMsid = {};
    var out = [];
    for (var oi = 0; oi < matches.length; oi++) {
      var r = matches[oi];
      if (!r || r.msid == null || isNaN(r.msid)) continue;
      if (r.msid === Number(baseMsid)) continue;
      if (seenMsid[r.msid]) continue;
      seenMsid[r.msid] = true;
      out.push(r);
    }
    return out;
  }

  /** Active middle or Jr/Sr (legacy helper used by feeder discovery for jr/sr). */
  function isScenarioDestinationLegacyMiddleOrJrSr(msid) {
    if (msid == null || isNaN(msid) || schoolIsChoiceMsid(msid)) return false;
    var m = masterRow(msid);
    if (!m) return false;
    var lv = String(m.school_level || "").trim().toLowerCase();
    return lv === "middle" || lv === "jr_sr_high";
  }

  /** @returns {boolean} */
  function isScenarioDestinationJrSrProps(p) {
    var pm = schoolPropsWithMasterType(p);
    return (pm.TYPE || "").toUpperCase() === "JR SR HIGH";
  }

  /** @returns {"ms-boundaries"|"hs-boundaries"} */
  function scenarioDestinationBoundarySource(p) {
    return isScenarioDestinationJrSrProps(p) ? "hs-boundaries" : "ms-boundaries";
  }

  /** MSIDs currently listed in #school-select (excludes placeholder). */
  function getSchoolDropdownMsidSet() {
    var sel = document.getElementById("school-select");
    var o = {};
    if (!sel || !sel.options) return o;
    for (var i = 0; i < sel.options.length; i++) {
      var v = sel.options[i].value;
      if (v === "" || v == null) continue;
      var n = parseInt(String(v).trim(), 10);
      if (!isNaN(n)) o[String(n)] = true;
    }
    return o;
  }

  function isMsidInSchoolSelectDropdown(msid) {
    if (msid == null || isNaN(msid)) return false;
    var a = getSchoolDropdownMsidSet();
    return !!(a[String(msid)] || a[String(Number(msid))]);
  }

  function isExistingConditionsViewActive() {
    var p = document.getElementById("page-existing");
    return !!(p && !p.hidden);
  }

  /** Active sub-tab id ("scenario" | "sandbox") within the consolidated Scenario Planning page. */
  function scenarioActiveSubtabId() {
    var legacy = document.getElementById("page-sandbox");
    if (legacy && !legacy.hidden) return "sandbox"; /* legacy fallback if old markup present */
    var sb = document.getElementById("scenario-subpanel-sandbox");
    if (sb && !sb.hidden) return "sandbox";
    return "scenario";
  }

  /** True iff the consolidated Scenario Planning page is open AND the Boundary Sandbox sub-tab is active. */
  function isBoundarySandboxViewActive() {
    var legacy = document.getElementById("page-sandbox");
    if (legacy && !legacy.hidden) return true;
    var pageScenario = document.getElementById("page-scenario");
    if (!pageScenario || pageScenario.hidden) return false;
    var sbPanel = document.getElementById("scenario-subpanel-sandbox");
    return !!(sbPanel && !sbPanel.hidden);
  }

  function shallowCopyHexKeyBag(from) {
    var o = Object.create(null);
    if (!from) {
      return o;
    }
    for (var k in from) {
      if (Object.prototype.hasOwnProperty.call(from, k) && from[k]) {
        o[k] = true;
      }
    }
    return o;
  }

  function countSandboxHexKeys(bag) {
    var n = 0;
    if (!bag) {
      return 0;
    }
    for (var kb in bag) {
      if (Object.prototype.hasOwnProperty.call(bag, kb) && bag[kb]) {
        n++;
      }
    }
    return n;
  }

  /**
   * Keys used for sidebar aggregates: live selection when confirmed; otherwise last confirmed snapshot.
   * @returns {Object<string, boolean>|null}
   */
  function getHexKeysForSandboxStatistics() {
    if (BOUNDARY_SANDBOX.selectionConfirmed) {
      return BOUNDARY_SANDBOX.selectedHexKeys;
    }
    if (countSandboxHexKeys(BOUNDARY_SANDBOX.confirmedHexKeysSnapshot) > 0) {
      return BOUNDARY_SANDBOX.confirmedHexKeysSnapshot;
    }
    return null;
  }

  /**
   * Turf v7 `polygonToLine` returns a Feature *or* a FeatureCollection (MultiPolygon → multiple lines).
   * Mapbox sources must receive a proper FeatureCollection of Feature objects, not a nested FC.
   * @param {GeoJSON.Feature<GeoJSON.Polygon|GeoJSON.MultiPolygon>|null} polyFeature
   * @returns {GeoJSON.FeatureCollection|null}
   */
  function turfPolygonToLineAsFeatureCollection(polyFeature) {
    if (!polyFeature || !polyFeature.geometry) {
      return null;
    }
    var gt = polyFeature.geometry.type;
    if (gt !== "Polygon" && gt !== "MultiPolygon") {
      return null;
    }
    if (typeof turf === "undefined" || !turf || typeof turf.polygonToLine !== "function") {
      return null;
    }
    try {
      var r = turf.polygonToLine(polyFeature);
      if (!r) {
        return null;
      }
      if (r.type === "FeatureCollection") {
        return r.features && r.features.length ? r : null;
      }
      if (r.type === "Feature") {
        return { type: "FeatureCollection", features: [r] };
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Turf v7 `union` takes one FeatureCollection of polygons; two-arg `union(a,b)` does not merge correctly.
   * @param {GeoJSON.Feature<GeoJSON.Polygon|GeoJSON.MultiPolygon>} polyA
   * @param {GeoJSON.Feature<GeoJSON.Polygon|GeoJSON.MultiPolygon>} polyB
   * @returns {GeoJSON.Feature<GeoJSON.Polygon|GeoJSON.MultiPolygon>|null}
   */
  function turfUnionPolygonFeatures(polyA, polyB) {
    if (!polyA || !polyB || typeof turf === "undefined" || !turf || typeof turf.union !== "function") {
      return null;
    }
    try {
      var fc =
        typeof turf.featureCollection === "function"
          ? turf.featureCollection([polyA, polyB])
          : { type: "FeatureCollection", features: [polyA, polyB] };
      return turf.union(fc);
    } catch (err) {
      return null;
    }
  }

  /**
   * Turf v7 `difference`: FeatureCollection where result is first polygon minus overlap with the rest.
   * @returns {GeoJSON.Feature<GeoJSON.Polygon|GeoJSON.MultiPolygon>|null}
   */
  function turfDifferencePolygonFeatures(polyA, polyB) {
    if (!polyA || !polyB || !polyA.geometry || !polyB.geometry) {
      return null;
    }
    var ta = polyA.geometry.type;
    var tb = polyB.geometry.type;
    if ((ta !== "Polygon" && ta !== "MultiPolygon") || (tb !== "Polygon" && tb !== "MultiPolygon")) {
      return null;
    }
    if (typeof turf === "undefined" || !turf || typeof turf.difference !== "function") {
      return null;
    }
    try {
      var fc =
        typeof turf.featureCollection === "function"
          ? turf.featureCollection([polyA, polyB])
          : { type: "FeatureCollection", features: [polyA, polyB] };
      return turf.difference(fc);
    } catch (err) {
      return null;
    }
  }

  /**
   * Merge multiple Polygon/MultiPolygon features into one (used for zoned-hex footprint union).
   * @param {GeoJSON.Feature[]} feats
   * @returns {GeoJSON.Feature|null}
   */
  function mergePolygonFeatureArrayToOne(feats) {
    if (!feats || !feats.length) {
      return null;
    }
    if (feats.length === 1) {
      return feats[0];
    }
    if (typeof turf === "undefined" || !turf || typeof turf.union !== "function") {
      return null;
    }
    try {
      if (typeof turf.featureCollection === "function" && feats.length > 2) {
        var bulk = turf.union(turf.featureCollection(feats));
        if (bulk && bulk.geometry) {
          return bulk;
        }
      }
    } catch (eBulk) {
      /* pairwise fallback below */
    }
    var merged = feats[0];
    for (var i = 1; i < feats.length; i++) {
      var unn = turfUnionPolygonFeatures(merged, feats[i]);
      if (unn && unn.geometry) {
        merged = unn;
      }
    }
    return merged && merged.geometry ? merged : null;
  }

  /**
   * Sets `lassoRegionFootprintFeature` to the union of all currently selected hex geometries (light green tint
   * between hexes, including base-school zoned loads). Does not change hex selection state.
   */
  function syncSandboxLassoFootprintFromSelectedHexGeometries() {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) {
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = null;
      syncBoundarySandboxLassoRegionSourcesFromAccumulator();
      return;
    }
    var bag = BOUNDARY_SANDBOX.selectedHexKeys;
    var feats = [];
    for (var sk in bag) {
      if (!Object.prototype.hasOwnProperty.call(bag, sk) || !bag[sk]) {
        continue;
      }
      var g = homeschoolHexGeometry(sk);
      if (!g) {
        continue;
      }
      feats.push({ type: "Feature", properties: {}, geometry: g });
    }
    if (!feats.length) {
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = null;
    } else {
      var merged = mergePolygonFeatureArrayToOne(feats);
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = merged && merged.geometry ? merged : null;
    }
    syncBoundarySandboxLassoRegionSourcesFromAccumulator();
  }

  /**
   * Builds the perimeter outline of a hex selection using **centroid-based
   * adjacency** rather than vertex matching. For each hex, every edge whose
   * "mirror" position (reflected across the edge midpoint from the hex's own
   * centroid) does NOT contain another selected hex is emitted as a perimeter
   * segment. This is fully immune to floating-point drift between real and
   * synthetic filler hex vertices — only centroid spatial lookup is required,
   * with a generous tolerance (~10% of one hex diameter).
   *
   * Each perimeter edge is emitted as its own 2-vertex LineString. We
   * intentionally do NOT chain edges into closed rings because chaining
   * requires vertex quantization that re-introduces the drift problem.
   * Mapbox renders many small LineStrings just as cheaply as one big one.
   *
   * @param {GeoJSON.Feature[]} feats Polygon features, one per selected hex.
   * @returns {GeoJSON.FeatureCollection|null}
   */
  function sandboxConfirmedHexUnionToOutlineLineFeature(feats) {
    if (!feats || !feats.length) return null;
    /* Pass 1: extract centroid + ring for each hex, learn approx hex size. */
    var hexes = []; /* { centroid:[x,y], ring:[[x,y],...] } */
    var sampleSize = null;
    for (var fi = 0; fi < feats.length; fi++) {
      var f = feats[fi];
      if (!f || !f.geometry) continue;
      var rings = null;
      if (f.geometry.type === "Polygon") {
        rings = [f.geometry.coordinates[0]];
      } else if (f.geometry.type === "MultiPolygon") {
        rings = [];
        for (var mpi = 0; mpi < f.geometry.coordinates.length; mpi++) {
          var r0 = f.geometry.coordinates[mpi] && f.geometry.coordinates[mpi][0];
          if (r0) rings.push(r0);
        }
      } else continue;
      for (var ri = 0; ri < rings.length; ri++) {
        var ring = rings[ri];
        if (!ring || ring.length < 4) continue;
        /* Local centroid (average of vertices, closing duplicate excluded). */
        var sx = 0, sy = 0, n = 0;
        for (var vi = 0; vi < ring.length - 1; vi++) {
          sx += ring[vi][0]; sy += ring[vi][1]; n++;
        }
        if (!n) continue;
        var cx = sx / n, cy = sy / n;
        hexes.push({ centroid: [cx, cy], ring: ring });
        if (sampleSize == null) {
          /* Approximate hex "diameter" = 2 × max(centroid→vertex). */
          var maxR2 = 0;
          for (var vj = 0; vj < ring.length - 1; vj++) {
            var dxs = ring[vj][0] - cx;
            var dys = ring[vj][1] - cy;
            var r2v = dxs * dxs + dys * dys;
            if (r2v > maxR2) maxR2 = r2v;
          }
          sampleSize = 2 * Math.sqrt(maxR2);
        }
      }
    }
    if (!hexes.length || !sampleSize) return null;
    /* Pass 2: build a coarse centroid grid for O(1) neighbor lookup. */
    var binSize = sampleSize * 0.6;
    var tol = sampleSize * 0.18; /* ~18% of hex diameter ≈ ~70 m for 400 m hex */
    var tolSq = tol * tol;
    var binMap = Object.create(null);
    for (var hi = 0; hi < hexes.length; hi++) {
      var c = hexes[hi].centroid;
      var bk = Math.floor(c[0] / binSize) + "," + Math.floor(c[1] / binSize);
      if (!binMap[bk]) binMap[bk] = [];
      binMap[bk].push(hi);
    }
    function hasSelectedHexAt(x, y) {
      var bxh = Math.floor(x / binSize);
      var byh = Math.floor(y / binSize);
      for (var dxh = -1; dxh <= 1; dxh++) {
        for (var dyh = -1; dyh <= 1; dyh++) {
          var arr = binMap[(bxh + dxh) + "," + (byh + dyh)];
          if (!arr) continue;
          for (var ai = 0; ai < arr.length; ai++) {
            var oc = hexes[arr[ai]].centroid;
            var ex = oc[0] - x;
            var ey = oc[1] - y;
            if (ex * ex + ey * ey < tolSq) return true;
          }
        }
      }
      return false;
    }
    /* Pass 3: for each hex side, mirror the centroid across the midpoint
       and check for another selected hex there. Sides without a selected
       neighbor are perimeter. */
    var lineFeatures = [];
    for (var hk = 0; hk < hexes.length; hk++) {
      var h = hexes[hk];
      var hr = h.ring;
      var hc = h.centroid;
      for (var vi2 = 0; vi2 < hr.length - 1; vi2++) {
        var va = hr[vi2];
        var vb = hr[vi2 + 1];
        var mx = (va[0] + vb[0]) / 2;
        var my = (va[1] + vb[1]) / 2;
        var nx = 2 * mx - hc[0];
        var ny = 2 * my - hc[1];
        if (hasSelectedHexAt(nx, ny)) continue; /* shared with another selected hex */
        lineFeatures.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: [va, vb] },
        });
      }
    }
    if (!lineFeatures.length) return null;
    return { type: "FeatureCollection", features: lineFeatures };
  }

  /** Defensive cap: skip outline polygon-union for very large selections.
   *  Per-hex green fill still visually conveys the selection; the dark outline is supplemental.
   *  Tuned to keep worst-case union under ~200ms on a typical laptop. */
  var BOUNDARY_SANDBOX_OUTLINE_HEX_CAP = 1500;

  /** Debounce state for outline recompute. Coalesces rapid bursts (paint drag, lasso end,
   *  prefill, base-school switch) into a single union job once the user pauses. */
  var BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE = {
    rafId: null,
    timeoutId: null,
  };

  /** Public entry point: schedule an outline recompute on idle (debounced).
   *  All call sites that used to invoke updateBoundarySandboxSelectionOutline directly
   *  now go through this scheduler to avoid blocking the main thread mid-gesture. */
  function updateBoundarySandboxSelectionOutline() {
    if (BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.rafId != null) {
      try { cancelAnimationFrame(BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.rafId); } catch (e) { /* ignore */ }
      BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.rafId = null;
    }
    if (BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.timeoutId != null) {
      clearTimeout(BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.timeoutId);
      BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.timeoutId = null;
    }
    var raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : function (cb) { return setTimeout(cb, 16); };
    BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.rafId = raf(function () {
      BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.rafId = null;
      BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.timeoutId = setTimeout(function () {
        BOUNDARY_SANDBOX_OUTLINE_DEBOUNCE.timeoutId = null;
        updateBoundarySandboxSelectionOutlineImmediate();
      }, 120);
    });
  }

  /** Actually computes and pushes the outline to its Mapbox source.
   *  Skips work if no hexes are selected or if the selection exceeds the safety cap. */
  function updateBoundarySandboxSelectionOutlineImmediate() {
    if (!map || !map.getSource("boundary-sandbox-selection-outline")) {
      return;
    }
    var empty = { type: "FeatureCollection", features: [] };
    var gk = STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.geometryByHexKey;
    if (!gk || typeof turf === "undefined") {
      try {
        map.getSource("boundary-sandbox-selection-outline").setData(empty);
      } catch (e0) {
        /* ignore */
      }
      return;
    }
    var snap = BOUNDARY_SANDBOX.confirmedHexKeysSnapshot;
    var snapCount = countSandboxHexKeys(snap);
    if (snapCount === 0) {
      try {
        map.getSource("boundary-sandbox-selection-outline").setData(empty);
      } catch (eZero) {
        /* ignore */
      }
      return;
    }
    /* Above the cap, pairwise+union of thousands of hexes can lock up the browser
       (the prior Confirm-only flow masked this because it only ran on demand). Skip the
       outline entirely; the per-hex selection fill still indicates the selected area. */
    if (snapCount > BOUNDARY_SANDBOX_OUTLINE_HEX_CAP) {
      try {
        map.getSource("boundary-sandbox-selection-outline").setData(empty);
      } catch (eCap) {
        /* ignore */
      }
      return;
    }
    var feats = [];
    for (var ks in snap) {
      if (!Object.prototype.hasOwnProperty.call(snap, ks) || !snap[ks]) {
        continue;
      }
      var g = homeschoolHexGeometry(ks);
      if (!g) {
        continue;
      }
      feats.push({ type: "Feature", properties: {}, geometry: g });
    }
    if (!feats.length) {
      try {
        map.getSource("boundary-sandbox-selection-outline").setData(empty);
      } catch (e1) {
        /* ignore */
      }
      return;
    }
    var outlineFcResult = sandboxConfirmedHexUnionToOutlineLineFeature(feats);
    if (!outlineFcResult || !outlineFcResult.features || !outlineFcResult.features.length) {
      try {
        map.getSource("boundary-sandbox-selection-outline").setData(empty);
      } catch (e2) {
        /* ignore */
      }
      return;
    }
    try {
      map.getSource("boundary-sandbox-selection-outline").setData(outlineFcResult);
    } catch (e3) {
      /* ignore */
    }
  }

  /** Legacy helper — now returns the active boundary's base school MSID, or null. */
  function getSandboxBaseSchoolMsid() {
    var b = sandboxActiveBoundary();
    if (!b || b.baseMsid == null || isNaN(b.baseMsid)) return null;
    return Number(b.baseMsid);
  }

  function getBoundarySandboxSelectTool() {
    var g = document.querySelector('input[name="sandbox-hex-tool"]:checked');
    var v = g && g.value ? String(g.value) : "lasso";
    return v === "lasso" ? "lasso" : "brush";
  }

  /** @returns {"select"|"erase"} */
  function getBoundarySandboxHexMode() {
    var m = document.querySelector('input[name="sandbox-hex-mode"]:checked');
    var v = m && m.value ? String(m.value) : "select";
    return v === "erase" ? "erase" : "select";
  }

  /** @returns {string|null} */
  function querySandboxHexKeyAtPoint(pixelPoint) {
    if (!map) {
      return null;
    }
    var hits;
    try {
      hits = map.queryRenderedFeatures(pixelPoint, { layers: ["boundary-sandbox-hex-fill"] });
    } catch (eQ) {
      return null;
    }
    if (!hits || !hits.length) {
      return null;
    }
    var f0 = hits[0];
    var key = f0.properties && f0.properties._hexKey != null ? String(f0.properties._hexKey) : null;
    return key;
  }

  function setBoundarySandboxLassoSource(geojson) {
    if (!map || !map.getSource("boundary-sandbox-lasso-trace")) {
      return;
    }
    try {
      map.getSource("boundary-sandbox-lasso-trace").setData(geojson || { type: "FeatureCollection", features: [] });
    } catch (e0) {
      /* ignore */
    }
  }

  function clearBoundarySandboxLassoLine() {
    BOUNDARY_SANDBOX_LASSO.active = false;
    BOUNDARY_SANDBOX_LASSO.points = null;
    setBoundarySandboxLassoSource({ type: "FeatureCollection", features: [] });
  }

  function boundarySandboxSetHexSelected(key, selected) {
    if (!key || !map) {
      return;
    }
    var active = sandboxActiveBoundary();
    if (!active) return;
    try {
      if (selected) {
        if (active.selectedHexKeys[key]) return; /* already in active */
        /* Reject hexes outside the district's serviced area (ocean / out of
           county). Callers gate explicitly too, so this is defense-in-depth. */
        if (!sandboxHexCentroidIsInsideAnyAssignmentBoundary(key)) {
          return;
        }
        /* Allow overlap unless enabled grades conflict with another owner. */
        if (sandboxHexOverlapWouldConflict(key, active)) {
          return; /* caller may track skipped count via the lasso/brush path */
        }
        active.selectedHexKeys[key] = true;
        map.setFeatureState(
          { source: "boundary-sandbox-hex", id: key },
          { boundaryId: active.id }
        );
      } else {
        delete active.selectedHexKeys[key];
        /* Hex may still belong to another boundary — repaint to that owner's
           color rather than clearing the fill entirely. */
        var remainingOwner = sandboxBoundaryOwningHexExcluding(key, active.id);
        map.setFeatureState(
          { source: "boundary-sandbox-hex", id: key },
          { boundaryId: remainingOwner ? remainingOwner.id : "" }
        );
      }
    } catch (e0) {
      /* ignore */
    }
  }

  /**
   * Clears the `selected` feature-state for every feature in the boundary-sandbox-hex source.
   * Use before any wholesale replacement of BOUNDARY_SANDBOX.selectedHexKeys so that stale
   * lime-green hex fills from a prior base school or selection cannot persist on the map.
   */
  function clearAllBoundarySandboxHexFeatureStates() {
    if (!map || !map.getSource("boundary-sandbox-hex")) {
      return;
    }
    try {
      map.removeFeatureState({ source: "boundary-sandbox-hex" });
      return;
    } catch (eRemoveAll) {
      /* fall through to per-key fallback */
    }
    /* Iterate all boundary's selectedHexKeys + snapshots. */
    for (var bi = 0; bi < BOUNDARY_SANDBOX.boundaries.length; bi++) {
      var b = BOUNDARY_SANDBOX.boundaries[bi];
      for (var k in b.selectedHexKeys) {
        try {
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: k },
            { boundaryId: "" }
          );
        } catch (ePer) { /* ignore */ }
      }
      for (var ks in b.confirmedHexKeysSnapshot) {
        try {
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: ks },
            { boundaryId: "" }
          );
        } catch (eSnap) { /* ignore */ }
      }
    }
  }

  /** Clears the ACTIVE boundary's hex selection only (other boundaries are preserved). */
  function clearBoundarySandboxGeographicSelection() {
    var active = sandboxActiveBoundary();
    if (!active) {
      updateSandboxSelectedHexCountUi();
      return;
    }
    /* Clear feature-state for hexes in the active boundary. When the hex is
       also owned by another boundary, repaint to that owner's color rather
       than blanking the cell. */
    for (var k in active.selectedHexKeys) {
      try {
        if (map) {
          var remainingClear = sandboxBoundaryOwningHexExcluding(k, active.id);
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: k },
            { boundaryId: remainingClear ? remainingClear.id : "" }
          );
        }
      } catch (eClr) { /* ignore */ }
    }
    active.selectedHexKeys = Object.create(null);
    active.confirmedHexKeysSnapshot = Object.create(null);
    active.gradeToggles = sandboxMakeDefaultGradeToggles();
    active.attendanceTypeToggles = sandboxMakeDefaultAttendanceTypeToggles();
    active.schoolListExpanded = { attendance: false, zoned: false };
    active.lassoRegionFootprintFeature = null;
    clearBoundarySandboxLassoLine();
    clearBoundarySandboxLassoRegionFill();
    BOUNDARY_SANDBOX_PAINT = {
      active: false,
      lastKey: null,
      startX: 0,
      startY: 0,
      clickKey: null,
      isDrag: false,
    };
    updateSandboxSelectedHexCountUi();
  }

  /**
   * Point-in-polygon (odd–even) for a ring. Ring may be open or closed.
   * @param {number} lng
   * @param {number} lat
   * @param {number[][]} ring
   */
  function pointInRingLngLat(lng, lat, ring) {
    if (!ring || ring.length < 3) {
      return false;
    }
    var ins = false;
    var n = ring.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = ring[i][0];
      var yi = ring[i][1];
      var xj = ring[j][0];
      var yj = ring[j][1];
      if (Math.abs(yj - yi) < 1e-12) {
        continue;
      }
      if ((yi > lat) !== (yj > lat)) {
        var xInt = (xj - xi) * (lat - yi) / (yj - yi) + xi;
        if (lng < xInt) {
          ins = !ins;
        }
      }
    }
    return ins;
  }

  function closeRingIfNeeded(pts) {
    if (!pts || pts.length < 1) {
      return [];
    }
    var a = pts.slice();
    if (a.length < 2) {
      return a;
    }
    if (a[0][0] !== a[a.length - 1][0] || a[0][1] !== a[a.length - 1][1]) {
      a.push([a[0][0], a[0][1]]);
    }
    return a;
  }

  /**
   * Closed lng/lat ring → GeoJSON Polygon for lasso “footprint” fill (hex gaps with no student data).
   * @param {number[][]} ring
   * @returns {Object|null} Feature or null
   */
  function closedLngLatRingToSandboxPolygonFeature(ring) {
    if (!ring || ring.length < 3) {
      return null;
    }
    var r = closeRingIfNeeded(ring);
    if (r.length < 4) {
      return null;
    }
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "Polygon", coordinates: [r] },
    };
  }

  /**
   * Outer rings of polygon features → LineString features (fallback outline when Turf is unavailable).
   * @param {Object[]} polyFeatures
   * @returns {Object[]}
   */
  function sandboxPolygonFeaturesToOutlineLineFeatures(polyFeatures) {
    var out = [];
    if (!polyFeatures || !polyFeatures.length) {
      return out;
    }
    for (var i = 0; i < polyFeatures.length; i++) {
      var f = polyFeatures[i];
      if (!f || !f.geometry) {
        continue;
      }
      if (f.geometry.type === "Polygon") {
        var rings = f.geometry.coordinates;
        if (!rings || !rings[0] || rings[0].length < 4) {
          continue;
        }
        out.push({
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: rings[0] },
        });
        continue;
      }
      if (f.geometry.type === "MultiPolygon") {
        var mp = f.geometry.coordinates;
        for (var pi = 0; pi < mp.length; pi++) {
          var polyRing = mp[pi] && mp[pi][0];
          if (!polyRing || polyRing.length < 4) {
            continue;
          }
          out.push({
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: polyRing },
          });
        }
      }
    }
    return out;
  }

  function syncBoundarySandboxLassoRegionSourcesFromAccumulator() {
    if (!map) {
      return;
    }
    var footprint = BOUNDARY_SANDBOX.lassoRegionFootprintFeature;
    var emptyFc = { type: "FeatureCollection", features: [] };
    if (!footprint || !footprint.geometry) {
      if (map.getSource("boundary-sandbox-lasso-region-fill")) {
        try {
          map.getSource("boundary-sandbox-lasso-region-fill").setData(emptyFc);
        } catch (eE0) {
          /* ignore */
        }
      }
      if (map.getSource("boundary-sandbox-lasso-region-outline")) {
        try {
          map.getSource("boundary-sandbox-lasso-region-outline").setData(emptyFc);
        } catch (eE1) {
          /* ignore */
        }
      }
      return;
    }
    var gt = footprint.geometry.type;
    if (gt !== "Polygon" && gt !== "MultiPolygon") {
      if (map.getSource("boundary-sandbox-lasso-region-fill")) {
        try {
          map.getSource("boundary-sandbox-lasso-region-fill").setData(emptyFc);
        } catch (eE2) {
          /* ignore */
        }
      }
      if (map.getSource("boundary-sandbox-lasso-region-outline")) {
        try {
          map.getSource("boundary-sandbox-lasso-region-outline").setData(emptyFc);
        } catch (eE3) {
          /* ignore */
        }
      }
      return;
    }
    var fillFc = { type: "FeatureCollection", features: [footprint] };
    /* Compute the lighter footprint outline via edge counting over the
       per-hex geometries (NOT via polygonToLine on the unioned footprint).
       Polygon-union output is unreliable as a stroke source when adjacent
       hex vertices differ by sub-meter float noise — it produces a
       MultiPolygon and you end up drawing each hex's edges. Edge counting
       always yields a clean perimeter. */
    var perHexFeats = [];
    var sb = sandboxActiveBoundary();
    var bag = sb ? sb.selectedHexKeys : BOUNDARY_SANDBOX.selectedHexKeys;
    for (var sk in bag) {
      if (!Object.prototype.hasOwnProperty.call(bag, sk) || !bag[sk]) continue;
      var gSk = homeschoolHexGeometry(sk);
      if (!gSk) continue;
      perHexFeats.push({ type: "Feature", properties: {}, geometry: gSk });
    }
    var outlineFc =
      sandboxConfirmedHexUnionToOutlineLineFeature(perHexFeats) || emptyFc;
    if (map.getSource("boundary-sandbox-lasso-region-fill")) {
      try {
        map.getSource("boundary-sandbox-lasso-region-fill").setData(fillFc);
      } catch (eFill) {
        /* ignore */
      }
    }
    if (map.getSource("boundary-sandbox-lasso-region-outline")) {
      try {
        map.getSource("boundary-sandbox-lasso-region-outline").setData(outlineFc);
      } catch (eOut) {
        /* ignore */
      }
    }
  }

  function clearBoundarySandboxLassoRegionFill() {
    BOUNDARY_SANDBOX.lassoRegionFootprintFeature = null;
    if (!map || !map.getSource("boundary-sandbox-lasso-region-fill")) {
      return;
    }
    try {
      map.getSource("boundary-sandbox-lasso-region-fill").setData({
        type: "FeatureCollection",
        features: [],
      });
    } catch (eClr) {
      /* ignore */
    }
    if (map.getSource("boundary-sandbox-lasso-region-outline")) {
      try {
        map.getSource("boundary-sandbox-lasso-region-outline").setData({
          type: "FeatureCollection",
          features: [],
        });
      } catch (eClr2) {
        /* ignore */
      }
    }
  }

  /**
   * Select-mode lasso: union the new ring into `lassoRegionFootprintFeature`.
   * @param {number[][]|null} closedRing
   */
  function applySelectLassoToLassoRegionFootprint(closedRing) {
    var feat = closedLngLatRingToSandboxPolygonFeature(closedRing || []);
    if (!feat) {
      return;
    }
    var fp = BOUNDARY_SANDBOX.lassoRegionFootprintFeature;
    if (!fp || !fp.geometry) {
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = feat;
    } else {
      var u = turfUnionPolygonFeatures(fp, feat);
      if (u && u.geometry) {
        BOUNDARY_SANDBOX.lassoRegionFootprintFeature = u;
      }
    }
    syncBoundarySandboxLassoRegionSourcesFromAccumulator();
  }

  /**
   * Erase-mode lasso: subtract the ring from the green footprint (turf.difference); clears tint if nothing left.
   * @param {number[][]|null} closedRing
   */
  function applyEraseLassoToLassoRegionFootprint(closedRing) {
    var fp = BOUNDARY_SANDBOX.lassoRegionFootprintFeature;
    if (!fp || !fp.geometry) {
      return;
    }
    var eraseFeat = closedLngLatRingToSandboxPolygonFeature(closedRing || []);
    if (!eraseFeat) {
      return;
    }
    var d = turfDifferencePolygonFeatures(fp, eraseFeat);
    if (d && d.geometry) {
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = d;
    } else {
      BOUNDARY_SANDBOX.lassoRegionFootprintFeature = null;
    }
    syncBoundarySandboxLassoRegionSourcesFromAccumulator();
  }

  function applyLassoToHexSelection(closedRing) {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) return 0;
    if (!map) return 0;
    if (!closedRing || closedRing.length < 4) return 0;
    var active = sandboxActiveBoundary();
    if (!active) return 0;
    var any = 0;
    var blocked = 0;
    var lMode = getBoundarySandboxHexMode();
    /* Iterate the real student-hex grid, the homeschool fallback grid, AND the
       synthetic filler grid. Homeschool-only and filler hexes contribute 0
       traditional students but are still selectable, so the lasso selection has
       no swiss-cheese holes where no traditional-school students live. */
    var hexGeomMaps = [STUDENT_HEX_INDEX.geometryByHexKey];
    if (HOMESCHOOL_HEX_GEOMETRY_FALLBACK) hexGeomMaps.push(HOMESCHOOL_HEX_GEOMETRY_FALLBACK);
    if (EMPTY_HEX_GEOMETRY) hexGeomMaps.push(EMPTY_HEX_GEOMETRY);
    for (var gmi = 0; gmi < hexGeomMaps.length; gmi++) {
      var gk = hexGeomMaps[gmi];
      for (var hk in gk) {
        if (!Object.prototype.hasOwnProperty.call(gk, hk)) continue;
        var geom = gk[hk];
        if (!geom) continue;
        var c = polygonCentroid(geom);
        if (!c) continue;
        if (!pointInRingLngLat(c[0], c[1], closedRing)) continue;
        var inActive = !!active.selectedHexKeys[hk];
        if (lMode === "select" && !inActive) {
          /* Silently skip hexes outside the district's serviced area (ocean
             / out of county) — these are never selectable. */
          if (!sandboxHexCentroidIsInsideAnyAssignmentBoundary(hk)) continue;
          if (sandboxHexOverlapWouldConflict(hk, active)) {
            blocked++;
            continue;
          }
          boundarySandboxSetHexSelected(hk, true);
          any++;
        } else if (lMode === "erase" && inActive) {
          boundarySandboxSetHexSelected(hk, false);
          any++;
        }
      }
    }
    if (blocked > 0) showSandboxOverlapNotice(blocked);
    return any;
  }

  function endBoundarySandboxPaintOrLassoFromWindow() {
    if (!map) {
      return;
    }
    var needUi = false;
    if (BOUNDARY_SANDBOX_PAINT.active) {
      if (!BOUNDARY_SANDBOX_PAINT.isDrag && BOUNDARY_SANDBOX_PAINT.clickKey) {
        clearBoundarySandboxLassoRegionFill();
        var ck = BOUNDARY_SANDBOX_PAINT.clickKey;
        var activeClick = sandboxActiveBoundary();
        var w = !!(activeClick && activeClick.selectedHexKeys[ck]);
        if (!w) {
          /* Reject clicks outside the district's serviced area (ocean / out
             of county) silently — no notice, just no-op. */
          if (!sandboxHexCentroidIsInsideAnyAssignmentBoundary(ck)) {
            /* no-op */
          } else if (
            /* Adding: allow overlap unless enabled grades conflict. */
            activeClick &&
            sandboxHexOverlapWouldConflict(ck, activeClick)
          ) {
            showSandboxOverlapNotice(1);
          } else {
            boundarySandboxSetHexSelected(ck, true);
          }
        } else {
          boundarySandboxSetHexSelected(ck, false);
        }
      }
      BOUNDARY_SANDBOX_PAINT.active = false;
      BOUNDARY_SANDBOX_PAINT.lastKey = null;
      BOUNDARY_SANDBOX_PAINT.clickKey = null;
      BOUNDARY_SANDBOX_PAINT.isDrag = false;
      needUi = true;
      sandboxRestoreDragPan();
    }
    if (BOUNDARY_SANDBOX_LASSO.active) {
      var raw = BOUNDARY_SANDBOX_LASSO.points;
      BOUNDARY_SANDBOX_LASSO.active = false;
      BOUNDARY_SANDBOX_LASSO.points = null;
      setBoundarySandboxLassoSource({ type: "FeatureCollection", features: [] });
      needUi = true;
      sandboxRestoreDragPan();
      if (raw && raw.length >= 3) {
        var closed = closeRingIfNeeded(raw);
        applyLassoToHexSelection(closed);
        if (getBoundarySandboxHexMode() === "select") {
          applySelectLassoToLassoRegionFootprint(closed);
        } else {
          applyEraseLassoToLassoRegionFootprint(closed);
        }
      }
    }
    if (needUi) {
      updateSandboxSelectedHexCountUi();
    }
  }

  /* Apply the correct dragPan state for the current context. In touch "Draw"
     mode (while the Boundary Sandbox is the active view) one-finger panning is
     disabled so drags draw instead; otherwise panning is enabled. */
  function sandboxRestoreDragPan() {
    if (!map || !map.dragPan) return;
    var drawing = BOUNDARY_SANDBOX_TOUCH_DRAW && isBoundarySandboxViewActive();
    try {
      if (drawing) {
        map.dragPan.disable();
      } else {
        map.dragPan.enable();
      }
      map.getCanvas().style.cursor = drawing ? "crosshair" : "";
    } catch (e) {
      /* ignore */
    }
  }

  function setBoundarySandboxTouchDraw(on) {
    BOUNDARY_SANDBOX_TOUCH_DRAW = !!on;
    sandboxRestoreDragPan();
  }

  if (typeof window !== "undefined") {
    window.__setSandboxTouchDraw = setBoundarySandboxTouchDraw;
    window.__getSandboxTouchDraw = function () {
      return BOUNDARY_SANDBOX_TOUCH_DRAW;
    };
    window.__sandboxRestoreDragPan = sandboxRestoreDragPan;
  }

  function tryBrushDragAtPoint(pixelPoint) {
    if (!map) return;
    var active = sandboxActiveBoundary();
    if (!active) return;
    var key = querySandboxHexKeyAtPoint(pixelPoint);
    if (key == null) {
      BOUNDARY_SANDBOX_PAINT.lastKey = null;
      return;
    }
    if (key === BOUNDARY_SANDBOX_PAINT.lastKey) return;
    BOUNDARY_SANDBOX_PAINT.lastKey = key;
    var bMode = getBoundarySandboxHexMode();
    var inActive = !!active.selectedHexKeys[key];
    if (bMode === "select") {
      if (!inActive) {
        /* Silently skip hexes outside the district's serviced area (ocean /
           out of county); the user can keep dragging without interruption. */
        if (!sandboxHexCentroidIsInsideAnyAssignmentBoundary(key)) return;
        if (sandboxHexOverlapWouldConflict(key, active)) {
          showSandboxOverlapNotice(1);
          return;
        }
        boundarySandboxSetHexSelected(key, true);
      }
    } else {
      if (inActive) boundarySandboxSetHexSelected(key, false);
    }
  }

  function pruneBoundarySandboxSelectedKeysToGeometry() {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) {
      for (var bi = 0; bi < BOUNDARY_SANDBOX.boundaries.length; bi++) {
        BOUNDARY_SANDBOX.boundaries[bi].selectedHexKeys = Object.create(null);
      }
      return;
    }
    for (var bi2 = 0; bi2 < BOUNDARY_SANDBOX.boundaries.length; bi2++) {
      var b = BOUNDARY_SANDBOX.boundaries[bi2];
      for (var ks in b.selectedHexKeys) {
        if (!homeschoolHexGeometry(ks)) {
          delete b.selectedHexKeys[ks];
        }
      }
    }
  }

  function applyBoundarySandboxSelectionFeatureStates() {
    if (!map || !map.getSource("boundary-sandbox-hex") || !map.getLayer("boundary-sandbox-hex-fill")) {
      return;
    }
    /* Apply feature-state for every hex in every boundary, tagging with
       boundaryId. The active boundary is written LAST so when multiple
       boundaries share a hex its color wins on the map. */
    var activeId = BOUNDARY_SANDBOX.activeBoundaryId;
    var bList = BOUNDARY_SANDBOX.boundaries;
    var deferActive = null;
    for (var bi = 0; bi < bList.length; bi++) {
      var b = bList[bi];
      if (b.id === activeId) { deferActive = b; continue; }
      for (var sk in b.selectedHexKeys) {
        if (!b.selectedHexKeys[sk]) continue;
        try {
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: sk },
            { boundaryId: b.id }
          );
        } catch (eSet) { /* ignore */ }
      }
    }
    if (deferActive) {
      for (var sk2 in deferActive.selectedHexKeys) {
        if (!deferActive.selectedHexKeys[sk2]) continue;
        try {
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: sk2 },
            { boundaryId: deferActive.id }
          );
        } catch (eSet2) { /* ignore */ }
      }
    }
  }

  function requestApplyBoundarySandboxSelectionOnIdle() {
    if (!map) return;
    if (map.isStyleLoaded && !map.isStyleLoaded()) return;
    map.once("idle", function () {
      applyBoundarySandboxSelectionFeatureStates();
    });
  }

  function syncSandboxConfirmEditButtonStates() {
    var conf = document.getElementById("sandbox-confirm-btn");
    if (!conf) {
      return;
    }
    var n = 0;
    for (var kb in BOUNDARY_SANDBOX.selectedHexKeys) {
      if (Object.prototype.hasOwnProperty.call(BOUNDARY_SANDBOX.selectedHexKeys, kb) && BOUNDARY_SANDBOX.selectedHexKeys[kb]) {
        n++;
      }
    }
    if (n === 0) {
      BOUNDARY_SANDBOX.selectionConfirmed = false;
    }
    var canConfirm = n > 0;
    conf.setAttribute("aria-disabled", canConfirm ? "false" : "true");
    conf.classList.toggle("is-inert", !canConfirm);
    var hasUnconfirmedChanges = canConfirm && !BOUNDARY_SANDBOX.selectionConfirmed;
    conf.classList.toggle("sandbox-confirm-btn--pending", hasUnconfirmedChanges);
  }

  function updateSandboxSelectedHexCountUi() {
    var el = document.getElementById("sandbox-hex-count");
    if (!el) return;
    var n = 0;
    for (var kc in BOUNDARY_SANDBOX.selectedHexKeys) {
      if (Object.prototype.hasOwnProperty.call(BOUNDARY_SANDBOX.selectedHexKeys, kc) && BOUNDARY_SANDBOX.selectedHexKeys[kc]) {
        n++;
      }
    }
    /* Confirm-selection button has been removed: every change to the live selection
       is treated as the confirmed selection so the sidebar stats and outline update
       in real time. Keeping `confirmedHexKeysSnapshot` populated preserves the
       existing outline + stats consumers that read it without further refactoring. */
    if (n === 0) {
      BOUNDARY_SANDBOX.selectionConfirmed = false;
      BOUNDARY_SANDBOX.confirmedHexKeysSnapshot = Object.create(null);
    } else {
      BOUNDARY_SANDBOX.selectionConfirmed = true;
      BOUNDARY_SANDBOX.confirmedHexKeysSnapshot = shallowCopyHexKeyBag(
        BOUNDARY_SANDBOX.selectedHexKeys
      );
    }
    var activeForCount = sandboxActiveBoundary();
    var activeName = activeForCount ? activeForCount.name : "active boundary";
    el.textContent =
      n === 0
        ? "No hexes in " + activeName + " — use a tool and the map"
        : n === 1
          ? "1 hex in " + activeName
          : n + " hexes in " + activeName;
    syncSandboxConfirmEditButtonStates();
    updateSandboxStatsPanelSummary();
    updateBoundarySandboxSelectionOutline();
    renderSandboxBoundariesPanel();
    renderSandboxSummaryTable();
  }

  function resetBoundarySandboxFilterState() {
    BOUNDARY_SANDBOX.gradeToggles = sandboxMakeDefaultGradeToggles();
    BOUNDARY_SANDBOX.attendanceTypeToggles = sandboxMakeDefaultAttendanceTypeToggles();
    BOUNDARY_SANDBOX.schoolListExpanded = { attendance: false, zoned: false };
  }

  function clearSandboxStatsAndDemographicsDisplays() {
    resetBoundarySandboxFilterState();
    var g = document.getElementById("sandbox-card-body-grade");
    var a = document.getElementById("sandbox-card-body-attendance");
    var z = document.getElementById("sandbox-card-body-zoned");
    if (g) g.textContent = "—";
    if (a) a.textContent = "—";
    if (z) z.textContent = "—";
    var attBody = document.getElementById("sandbox-card-body-attendance-type");
    if (attBody) attBody.textContent = "—";
    var ethEl = document.getElementById("sandbox-demographics-ethnicity");
    var lunchEl = document.getElementById("sandbox-demographics-lunch");
    if (ethEl) {
      ethEl.innerHTML = '<p class="demographics-pie-empty">No selection confirmed yet.</p>';
    }
    if (lunchEl) {
      lunchEl.innerHTML = '<p class="demographics-pie-empty">No selection confirmed yet.</p>';
    }
  }

  /**
   * Grade bucket key for boundary sandbox charts/toggles. Homeschool export uses grade code 13 for “no grade”.
   */
  function sandboxGradeCanonicalForDetail(d) {
    if (d && d.__homeschool) {
      var tr = String(d.Grade != null ? d.Grade : "").trim();
      if (tr !== "") {
        var n13 = parseInt(tr.replace(/^0+/, "") || tr, 10);
        if (!isNaN(n13) && n13 === 13) {
          return "__NOGRADE__";
        }
      }
    }
    return canonicalStudentGradeCode(d.Grade) || "__UNK__";
  }

  function detailIncludedBySandboxGradeToggle(d) {
    if (!d) {
      return true;
    }
    var gC = sandboxGradeCanonicalForDetail(d);
    var t = BOUNDARY_SANDBOX.gradeToggles;
    if (t && t[gC] === false) {
      return false;
    }
    return true;
  }

  function detailIncludedBySandboxAttendanceTypeToggle(d) {
    if (!d) {
      return true;
    }
    var cat = sandboxAttendanceCategoryForDetail(d);
    var t2 = BOUNDARY_SANDBOX.attendanceTypeToggles;
    if (t2 && t2[cat] === false) {
      return false;
    }
    return true;
  }

  /**
   * Buckets current enrollment (MSID) for charting: charter / choice, else zoned traditional vs other traditional.
   * Uses `zonedMsidForDetailForAggregate` vs attendance MSID for the public-assignment “zoned” match.
   */
  function sandboxAttendanceCategoryForDetail(d) {
    if (!d) {
      return "otherTraditional";
    }
    if (d.__homeschool) {
      return "homeschool";
    }
    var att = parseInt(String(d.MSID != null ? d.MSID : "").trim(), 10);
    if (isNaN(att) || att <= 0) {
      return "otherTraditional";
    }
    var attK = String(att);
    if (CHARTER_SCHOOL_MSIDS && CHARTER_SCHOOL_MSIDS[attK]) {
      return "charter";
    }
    if (CHOICE_SCHOOL_MSIDS && CHOICE_SCHOOL_MSIDS[attK]) {
      return "choice";
    }
    var zoned = zonedMsidForDetailForAggregate(d);
    if (zoned != null && !isNaN(zoned) && Number(zoned) === att) {
      return "zonedTraditional";
    }
    return "otherTraditional";
  }

  function isSandboxAttendanceTypeKeyIncludedForFilter(atype) {
    var t = BOUNDARY_SANDBOX.attendanceTypeToggles;
    if (t && t[atype] === false) {
      return false;
    }
    return true;
  }

  function syncSandboxAttendanceTypeTogglesFromFull(fullByType) {
    var t = BOUNDARY_SANDBOX.attendanceTypeToggles;
    if (!t) {
      t = Object.create(null);
      BOUNDARY_SANDBOX.attendanceTypeToggles = t;
    }
    var allKeys = [
      "zonedTraditional",
      "otherTraditional",
      "charter",
      "choice",
      "homeschool",
    ];
    for (var i = 0; i < allKeys.length; i++) {
      var gk = allKeys[i];
      if (
        Object.prototype.hasOwnProperty.call(t, gk) &&
        (fullByType[gk] == null || fullByType[gk] === 0)
      ) {
        delete t[gk];
      }
    }
    for (var j = 0; j < allKeys.length; j++) {
      var fk = allKeys[j];
      if ((fullByType[fk] || 0) > 0) {
        if (t[fk] === undefined) {
          t[fk] = sandboxDefaultAttendanceTypeIncluded(fk);
        }
      }
    }
  }

  /**
   * Renders the same control layout as the grade bar chart, with a checkbox per type and colored bars
   * when included (dimmed + `is-excluded` when unchecked, same as grade).
   * @param {Object<string, number>|undefined} byType unfiltered row counts in the full hex set
   * @param {number|undefined} selectionTotalAll students in hex selection (ignores checkboxes); footer total line
   * @param {number|undefined} includedInDetails cohort passing grade + attendance toggles (lists / demographics)
   */
  function formatSandboxAttendanceTypeBarHtml(byType, selectionTotalAll, includedInDetails) {
    var defRows = [
      { key: "zonedTraditional", label: "Zoned Traditional School", mod: "zoned" },
      { key: "otherTraditional", label: "Other Traditional School", mod: "other" },
      { key: "charter", label: "Charter School", mod: "charter" },
      { key: "choice", label: "Choice School", mod: "choice" },
      { key: "homeschool", label: "Homeschool", mod: "homeschool" },
    ];
    var rows = [];
    for (var d = 0; d < defRows.length; d++) {
      var cPre = (byType && byType[defRows[d].key]) || 0;
      if (cPre > 0) {
        rows.push(defRows[d]);
      }
    }
    if (!rows.length) {
      return "<p class=\"sandbox-stat-line\">—</p>";
    }
    var maxC = 0;
    var rowSum = 0;
    for (var t = 0; t < rows.length; t++) {
      var c0 = (byType && byType[rows[t].key]) || 0;
      rowSum += c0;
      if (c0 > maxC) {
        maxC = c0;
      }
    }
    var mapTotal =
      selectionTotalAll != null && !isNaN(Number(selectionTotalAll))
        ? Number(selectionTotalAll)
        : rowSum;
    var includedTotal =
      includedInDetails != null && !isNaN(Number(includedInDetails))
        ? Number(includedInDetails)
        : rowSum;
    if (maxC <= 0) {
      return "<p class=\"sandbox-stat-line\">—</p>";
    }
    var parts = [
      '<div class="sandbox-grade-chart sandbox-grade-chart--attendance" role="group" aria-label="Students by school type in this selection">',
    ];
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      var c = (byType && byType[row.key]) || 0;
      var inc = isSandboxAttendanceTypeKeyIncludedForFilter(row.key);
      var wPct = Math.max(0, Math.min(100, Math.round((c / maxC) * 100)));
      var title = c + " student" + (c === 1 ? "" : "s") + " — " + row.label;
      var aLab = row.label + (inc ? " — include in details below" : " — exclude from details below");
      var chk = inc ? " checked" : "";
      var innerCls = "sandbox-grade-bar-inner sandbox-atype--" + row.mod;
      if (!inc) {
        innerCls += " is-excluded";
      }
      parts.push(
        '<div class="sandbox-grade-row" data-sandbox-atype-row="' +
          escapeHtml(String(row.key)) +
          '">' +
          '<div class="sandbox-grade-check" title="Count these students in the lists and charts below.">' +
          "<input" +
          chk +
          ' type="checkbox" class="sandbox-attendance-type-toggle" data-atype="' +
          escapeHtml(String(row.key)) +
          '" aria-label="' +
          escapeHtml(aLab) +
          '" title="' +
          escapeHtml("Count these students below: " + row.label) +
          '" />' +
          "</div>" +
          '<div class="sandbox-grade-label-col">' +
          escapeHtml(row.label) +
          "</div>" +
          '<div class="sandbox-grade-bar-area"><div class="sandbox-grade-bar-outer" title="' +
          escapeHtml(title) +
          '"><div class="' +
          innerCls +
          '" style="width:' +
          wPct +
          '%"></div></div></div>' +
          '<div class="sandbox-grade-count-col">' +
          c.toLocaleString() +
          "</div></div>"
      );
    }
    if (mapTotal > 0) {
      var totLine = "In selection (all types): " + mapTotal.toLocaleString() + " students";
      if (includedTotal !== mapTotal) {
        totLine +=
          " · included in details below: " + includedTotal.toLocaleString() + " students";
      } else {
        totLine += " (all included in details below)";
      }
      parts.push('<p class="sandbox-grade-total">' + escapeHtml(totLine) + "</p>");
    }
    parts.push("</div>");
    return parts.join("");
  }

  function syncSandboxGradeTogglesFromFullByGrade(fullByGrade) {
    var t = BOUNDARY_SANDBOX.gradeToggles;
    if (!t) {
      t = Object.create(null);
      BOUNDARY_SANDBOX.gradeToggles = t;
    }
    for (var gk in t) {
      if (Object.prototype.hasOwnProperty.call(t, gk)) {
        var cLeft = fullByGrade[gk];
        if (cLeft == null || cLeft === 0) {
          delete t[gk];
        }
      }
    }
    for (var fk in fullByGrade) {
      if (Object.prototype.hasOwnProperty.call(fullByGrade, fk) && (fullByGrade[fk] || 0) > 0) {
        if (t[fk] === undefined) {
          t[fk] = sandboxDefaultGradeIncluded(fk);
        }
      }
    }
  }

  /**
   * @param {Object<string, boolean>|undefined} hexKeyBag Hex keys to aggregate (defaults to current map selection).
   */
  function aggregateBoundarySandboxSelectionFromIndex(hexKeyBag) {
    var out = {
      totalStudents: 0,
      /** All students in the hex selection (ignores grade / attendance checkboxes). */
      selectionTotalAllStudents: 0,
      byGrade: {},
      byAttendance: {},
      byAttendanceTypeFull: {},
      byZoned: {},
      ethnicity: {},
      lunch: {},
    };
    var hasTrad = STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.detailsByMsid;
    var hmByHex = HOMESCHOOL_DETAILS_BY_HEX_KEY;
    var hasHm = !!(hmByHex && Object.keys(hmByHex).length);
    if (!hasTrad && !hasHm) {
      return out;
    }
    var keyBag = hexKeyBag || BOUNDARY_SANDBOX.selectedHexKeys;
    var byDet = hasTrad ? STUDENT_HEX_INDEX.detailsByMsid : null;
    var fullByGrade = {};
    /** Attendance-type histogram with grade toggles applied (symmetric to grade chart using attendance toggles). */
    var fullByAT = Object.create(null);
    /** Grade histogram with attendance-type toggles applied (symmetric to attendance chart using grade toggles). */
    var gradeByAttendanceFilter = {};
    if (hasTrad) {
      for (var attMs0 in byDet) {
        if (!Object.prototype.hasOwnProperty.call(byDet, attMs0)) {
          continue;
        }
        var hexMap0 = byDet[attMs0];
        for (var hk0 in keyBag) {
          if (!keyBag[hk0]) {
            continue;
          }
          var arr0 = hexMap0[hk0];
          if (!arr0 || !arr0.length) {
            continue;
          }
          for (var i0 = 0; i0 < arr0.length; i0++) {
            var d0 = arr0[i0];
            if (!d0) {
              continue;
            }
            var g0 = sandboxGradeCanonicalForDetail(d0);
            fullByGrade[g0] = (fullByGrade[g0] || 0) + 1;
            if (detailIncludedBySandboxAttendanceTypeToggle(d0)) {
              gradeByAttendanceFilter[g0] = (gradeByAttendanceFilter[g0] || 0) + 1;
            }
            if (detailIncludedBySandboxGradeToggle(d0)) {
              var aCat = sandboxAttendanceCategoryForDetail(d0);
              fullByAT[aCat] = (fullByAT[aCat] || 0) + 1;
            }
          }
        }
      }
    }
    if (hmByHex) {
      for (var hkHs in keyBag) {
        if (!keyBag[hkHs]) {
          continue;
        }
        var hmArr0 = hmByHex[hkHs];
        if (!hmArr0 || !hmArr0.length) {
          continue;
        }
        for (var ih0 = 0; ih0 < hmArr0.length; ih0++) {
          var dh0 = hmArr0[ih0];
          if (!dh0) {
            continue;
          }
          var gHs = sandboxGradeCanonicalForDetail(dh0);
          fullByGrade[gHs] = (fullByGrade[gHs] || 0) + 1;
          if (detailIncludedBySandboxAttendanceTypeToggle(dh0)) {
            gradeByAttendanceFilter[gHs] = (gradeByAttendanceFilter[gHs] || 0) + 1;
          }
          if (detailIncludedBySandboxGradeToggle(dh0)) {
            var aCatHs = sandboxAttendanceCategoryForDetail(dh0);
            fullByAT[aCatHs] = (fullByAT[aCatHs] || 0) + 1;
          }
        }
      }
    }
    for (var gFill in fullByGrade) {
      if (Object.prototype.hasOwnProperty.call(fullByGrade, gFill)) {
        if (gradeByAttendanceFilter[gFill] == null) {
          gradeByAttendanceFilter[gFill] = 0;
        }
      }
    }
    var selTot = 0;
    for (var stKey in fullByGrade) {
      if (Object.prototype.hasOwnProperty.call(fullByGrade, stKey)) {
        selTot += fullByGrade[stKey] || 0;
      }
    }
    out.selectionTotalAllStudents = selTot;
    out.byGrade = gradeByAttendanceFilter;
    out.byAttendanceTypeFull = fullByAT;
    syncSandboxGradeTogglesFromFullByGrade(fullByGrade);
    syncSandboxAttendanceTypeTogglesFromFull(fullByAT);

    if (hasTrad) {
      for (var attMs in byDet) {
        if (!Object.prototype.hasOwnProperty.call(byDet, attMs)) {
          continue;
        }
        var hexMap = byDet[attMs];
        for (var hk in keyBag) {
          if (!keyBag[hk]) {
            continue;
          }
          var arr = hexMap[hk];
          if (!arr || !arr.length) {
            continue;
          }
          for (var i = 0; i < arr.length; i++) {
            var d = arr[i];
            if (!d) {
              continue;
            }
            if (!detailIncludedBySandboxGradeToggle(d)) {
              continue;
            }
            if (!detailIncludedBySandboxAttendanceTypeToggle(d)) {
              continue;
            }
            out.totalStudents += 1;
            var am = parseInt(String(d.MSID).trim(), 10);
            if (!isNaN(am)) {
              var aKey = String(am);
              out.byAttendance[aKey] = (out.byAttendance[aKey] || 0) + 1;
            }
            var zm = zonedMsidForDetailForAggregate(d);
            var zKey = zm != null ? String(zm) : "__none__";
            out.byZoned[zKey] = (out.byZoned[zKey] || 0) + 1;
            var eth =
              d.ethnicity != null && String(d.ethnicity).trim() !== ""
                ? String(d.ethnicity).trim()
                : "Unspecified";
            out.ethnicity[eth] = (out.ethnicity[eth] || 0) + 1;
            var lNorm = normalizeSandboxLunchStatForPie(d.lunch_stat);
            out.lunch[lNorm] = (out.lunch[lNorm] || 0) + 1;
          }
        }
      }
    }
    if (hmByHex) {
      for (var hkHm in keyBag) {
        if (!keyBag[hkHm]) {
          continue;
        }
        var hmArr = hmByHex[hkHm];
        if (!hmArr || !hmArr.length) {
          continue;
        }
        for (var jh = 0; jh < hmArr.length; jh++) {
          var dh = hmArr[jh];
          if (!dh) {
            continue;
          }
          if (!detailIncludedBySandboxGradeToggle(dh)) {
            continue;
          }
          if (!detailIncludedBySandboxAttendanceTypeToggle(dh)) {
            continue;
          }
          out.totalStudents += 1;
          var amh = parseInt(String(dh.MSID).trim(), 10);
          if (!isNaN(amh)) {
            var aKeyh = String(amh);
            out.byAttendance[aKeyh] = (out.byAttendance[aKeyh] || 0) + 1;
          }
          var zmH = zonedMsidForDetailForAggregate(dh);
          var zKeyH;
          if (dh.__homeschool && sandboxGradeCanonicalForDetail(dh) === "__NOGRADE__") {
            zKeyH = "__homeschool_not_age_eligible__";
          } else {
            zKeyH = zmH != null ? String(zmH) : "__none__";
          }
          out.byZoned[zKeyH] = (out.byZoned[zKeyH] || 0) + 1;
        }
      }
    }
    if (out.lunch && out.lunch.Unspecified) {
      out.lunch["Not free/reduced"] = (out.lunch["Not free/reduced"] || 0) + out.lunch.Unspecified;
      delete out.lunch.Unspecified;
    }
    return out;
  }

  function findSchoolPropertiesFromGeoCacheByMsid(msid) {
    if (msid == null || isNaN(msid)) {
      return null;
    }
    var target = Number(msid);
    var fc = GEO_CACHE.schools;
    if (!fc || !fc.features) {
      return null;
    }
    for (var i = 0; i < fc.features.length; i++) {
      var p = fc.features[i].properties;
      if (p && Number(p.SCHOOLS_ID) === target) {
        return p;
      }
    }
    return null;
  }

  function sandboxDisplayNameForMsidKey(msidStr) {
    if (msidStr === "__homeschool_not_age_eligible__") {
      return "No Zoned School - Not Age Eligible";
    }
    if (msidStr === "__none__") {
      return "Zoning not set";
    }
    if (String(msidStr) === String(HOMESCHOOL_ATTENDANCE_MSID)) {
      return "Home Education (Homeschool)";
    }
    var n = parseInt(String(msidStr), 10);
    if (isNaN(n)) {
      return String(msidStr);
    }
    var props = findSchoolPropertiesFromGeoCacheByMsid(n);
    if (props) {
      return schoolDisplayNameFromProps(props);
    }
    var m = masterRow(n);
    if (m && m.school_name) {
      return formatSchoolDisplayName(standardCapitalization(expandElemSchoolName(m.school_name)));
    }
    if (m && m.CommonName) {
      return formatSchoolDisplayName(standardCapitalization(expandElemSchoolName(String(m.CommonName))));
    }
    return "Unlisted school (ID " + n + ")";
  }

  function isSandboxGradeKeyIncludedForFilter(gCanon) {
    var t = BOUNDARY_SANDBOX.gradeToggles;
    if (t && t[gCanon] === false) {
      return false;
    }
    return true;
  }

  /** Whether every grade row is included, every row excluded, or mixed (for select-all UI). */
  function sandboxGradeFilterAggregateState(byGrade) {
    var keys = Object.keys(byGrade || {});
    if (!keys.length) {
      return { allOn: false, allOff: false, keysCount: 0 };
    }
    var allOn = true;
    var allOff = true;
    for (var i = 0; i < keys.length; i++) {
      if (isSandboxGradeKeyIncludedForFilter(keys[i])) {
        allOff = false;
      } else {
        allOn = false;
      }
    }
    return { allOn: allOn, allOff: allOff, keysCount: keys.length };
  }

  /**
   * @param {number|undefined} selectionTotalAll students in hex selection (ignores checkboxes)
   * @param {number|undefined} includedInDetails cohort passing grade + attendance toggles
   */
  function formatSandboxGradeBarChartHtml(byGrade, selectionTotalAll, includedInDetails) {
    var keys = Object.keys(byGrade);
    if (!keys.length) {
      return "<p class=\"sandbox-stat-line\">—</p>";
    }
    keys.sort(function (a, b) {
      return travelShedGradeSortKey(a) - travelShedGradeSortKey(b);
    });
    var maxC = 0;
    var rowSum = 0;
    var allGradeFiltersOn = true;
    var allGradeFiltersOff = true;
    for (var t = 0; t < keys.length; t++) {
      var c0 = byGrade[keys[t]] || 0;
      rowSum += c0;
      var incRow = isSandboxGradeKeyIncludedForFilter(keys[t]);
      if (incRow) {
        allGradeFiltersOff = false;
      } else {
        allGradeFiltersOn = false;
      }
      if (c0 > maxC) {
        maxC = c0;
      }
    }
    var mapTotal =
      selectionTotalAll != null && !isNaN(Number(selectionTotalAll))
        ? Number(selectionTotalAll)
        : rowSum;
    var includedTotal =
      includedInDetails != null && !isNaN(Number(includedInDetails))
        ? Number(includedInDetails)
        : rowSum;
    if (maxC <= 0) {
      return "<p class=\"sandbox-stat-line\">—</p>";
    }
    var parts = [
      '<div class="sandbox-grade-chart" role="group" aria-label="Students by grade in this selection">',
    ];
    var selAllChecked = allGradeFiltersOn && keys.length > 0;
    parts.push(
      '<div class="sandbox-grade-row sandbox-grade-row--select-all">' +
        '<div class="sandbox-grade-check">' +
        "<input" +
        (selAllChecked ? " checked" : "") +
        ' type="checkbox" class="sandbox-grade-select-all" ' +
        'aria-label="Select or clear all grades in this list" ' +
        'title="Check or uncheck all grades." />' +
        "</div>" +
        '<div class="sandbox-grade-label-col sandbox-grade-label-col--select-all">All</div>' +
        '<div class="sandbox-grade-bar-area" aria-hidden="true"></div>' +
        '<div class="sandbox-grade-count-col" aria-hidden="true"></div>' +
        "</div>"
    );
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var c = byGrade[key] || 0;
      var inc = isSandboxGradeKeyIncludedForFilter(key);
      var labFull = travelShedGradeDisplayLabel(key);
      var lab = key === "__NOGRADE__" ? "NG" : labFull;
      var wPct = Math.max(0, Math.min(100, Math.round((c / maxC) * 100)));
      var title =
        key === "__NOGRADE__"
          ? c + " student" + (c === 1 ? "" : "s") + " (no grade code)"
          : c + " student" + (c === 1 ? "" : "s") + ", grade " + labFull;
      var aLab =
        key === "__NOGRADE__"
          ? "No grade code" + (inc ? " — include in details below" : " — exclude from details below")
          : (labFull === "Unknown" ? "Unknown or unspecified" : "Grade " + labFull) +
            (inc ? " — include in details below" : " — exclude from details below");
      var chk = inc ? " checked" : "";
      var toggleTitleShort =
        key === "__NOGRADE__"
          ? "Count these students below: no grade listed"
          : "Count these students below: grade " + labFull;
      parts.push(
        '<div class="sandbox-grade-row" data-sandbox-grade-row="' +
          escapeHtml(String(key)) +
          '">' +
          '<div class="sandbox-grade-check" title="Count these students in the totals and charts below.">' +
          "<input" +
          chk +
          ' type="checkbox" class="sandbox-grade-toggle" data-grade-canon="' +
          escapeHtml(String(key)) +
          '" aria-label="' +
          escapeHtml(aLab) +
          '" title="' +
          escapeHtml(toggleTitleShort) +
          '" />' +
          "</div>" +
          '<div class="sandbox-grade-label-col">' +
          escapeHtml(lab) +
          "</div>" +
          '<div class="sandbox-grade-bar-area"><div class="sandbox-grade-bar-outer" title="' +
          escapeHtml(title) +
          '"><div class="sandbox-grade-bar-inner' +
          (inc ? "" : " is-excluded") +
          '" style="width:' +
          wPct +
          '%"></div></div></div>' +
          '<div class="sandbox-grade-count-col">' +
          c.toLocaleString() +
          "</div></div>"
      );
    }
    if (mapTotal > 0) {
      var totLine = "In selection (all grades): " + mapTotal.toLocaleString() + " students";
      if (includedTotal !== mapTotal) {
        totLine +=
          " · included in details below: " + includedTotal.toLocaleString() + " students";
      } else {
        totLine += " (all included in details below)";
      }
      parts.push('<p class="sandbox-grade-total">' + escapeHtml(totLine) + "</p>");
    }
    parts.push("</div>");
    return parts.join("");
  }

  function oneSandboxSchoolLineRow(ms, countByMsid) {
    var nm = sandboxDisplayNameForMsidKey(ms);
    return (
      "<div class=\"sandbox-stat-line\"><span class=\"sandbox-stat-label\">" +
      escapeHtml(nm) +
      "</span> <span class=\"sandbox-stat-val\">" +
      (countByMsid[ms] || 0).toLocaleString() +
      "</span></div>"
    );
  }

  function formatSandboxSchoolListHtml(countByMsid, maxList, panelKey) {
    var key = panelKey != null && panelKey !== "" ? String(panelKey) : "attendance";
    var st = BOUNDARY_SANDBOX.schoolListExpanded;
    if (!st) {
      st = { attendance: false, zoned: false };
      BOUNDARY_SANDBOX.schoolListExpanded = st;
    }
    var keys = Object.keys(countByMsid);
    if (!keys.length) {
      return "<p class=\"sandbox-stat-line\">—</p>";
    }
    keys.sort(function (a, b) {
      return (countByMsid[b] || 0) - (countByMsid[a] || 0);
    });
    var max = maxList != null && maxList > 0 ? maxList : 5;
    var parts = ['<div class="sandbox-school-list">'];
    if (keys.length <= max) {
      for (var k0 = 0; k0 < keys.length; k0++) {
        parts.push(oneSandboxSchoolLineRow(keys[k0], countByMsid));
      }
      parts.push("</div>");
      return parts.join("");
    }
    var restC = 0;
    for (var r0 = max; r0 < keys.length; r0++) {
      restC += countByMsid[keys[r0]] || 0;
    }
    var expanded = !!st[key];
    if (!expanded) {
      for (var t = 0; t < max; t++) {
        parts.push(oneSandboxSchoolLineRow(keys[t], countByMsid));
      }
      var moreLine =
        "+" +
        (keys.length - max) +
        " more (includes " +
        restC.toLocaleString() +
        (restC === 1 ? " more student" : " more students") +
        ") — show all";
      parts.push(
        "<button " +
          'type="button" ' +
          'class="sandbox-school-expand" ' +
          'data-panel="' +
          escapeHtml(key) +
          '" ' +
          'aria-expanded="false" ' +
          ">" +
          escapeHtml(moreLine) +
          "</button>"
      );
    } else {
      parts.push(
        '<div class="sandbox-school-list-scroll" role="list" aria-label="Schools in this list">'
      );
      for (var r = 0; r < keys.length; r++) {
        parts.push(oneSandboxSchoolLineRow(keys[r], countByMsid));
      }
      parts.push(
        '</div><button type="button" class="sandbox-school-expand" data-panel="' +
          escapeHtml(key) +
          '" aria-expanded="true">' +
          escapeHtml("Show less") +
          "</button>"
      );
    }
    parts.push("</div>");
    return parts.join("");
  }

  function renderSandboxHexLayerDemographicPies(ethByLabel, lunchByLabel) {
    var ethEl = document.getElementById("sandbox-demographics-ethnicity");
    var lunchEl = document.getElementById("sandbox-demographics-lunch");
    if (!ethEl || !lunchEl) {
      return;
    }
    var emptyMsg =
      '<p class="demographics-pie-empty">No students with valid ethnicity in this layer for the selection.</p>';
    var emptyLunch = '<p class="demographics-pie-empty">No students with valid lunch in this layer for the selection.</p>';
    var ethRes = buildPieChartHtml(ethByLabel || {}, ethnicitySliceColor);
    var lunchRes = buildPieChartHtml(lunchByLabel || {}, function (label) {
      return lunchSliceColor(label);
    });
    ethEl.innerHTML = ethRes.total > 0 ? ethRes.html : emptyMsg;
    lunchEl.innerHTML = lunchRes.total > 0 ? lunchRes.html : emptyLunch;
  }

  function updateSandboxStatsPanelSummary() {
    var h = document.getElementById("sandbox-stats-heading");
    var lead = document.getElementById("sandbox-stats-lead");
    if (!h || !lead) {
      return;
    }
    var statsKeys = getHexKeysForSandboxStatistics();
    if (!statsKeys || countSandboxHexKeys(statsKeys) === 0) {
      h.textContent = "Students in selection";
      lead.innerHTML =
        "Choose hexes on the map (or a base school) to load grade, attendance, zoned, and demographics from the student hex layer. Summaries update automatically as you change the selection.";
      clearSandboxStatsAndDemographicsDisplays();
      return;
    }
    var nHex = countSandboxHexKeys(statsKeys);
    var agg = aggregateBoundarySandboxSelectionFromIndex(statsKeys);
    var totalInHex =
      agg.selectionTotalAllStudents != null && !isNaN(Number(agg.selectionTotalAllStudents))
        ? Number(agg.selectionTotalAllStudents)
        : 0;
    h.textContent = "Students in selection (" + nHex + (nHex === 1 ? " hex" : " hexes") + ")";
    var inHexStr = totalInHex.toLocaleString();
    var inHexNoun = totalInHex === 1 ? "student" : "students";
    var atB = document.getElementById("sandbox-card-body-attendance-type");
    var gB = document.getElementById("sandbox-card-body-grade");
    var aB = document.getElementById("sandbox-card-body-attendance");
    var zB = document.getElementById("sandbox-card-body-zoned");
    var suppressDetailedStats = totalInHex <= 10;
    var suppressionLead =
      "Detailed statistics are hidden when the filtered selection contains too few students.";
    if (suppressDetailedStats) {
      lead.innerHTML = suppressionLead;
      if (atB) atB.innerHTML = '<p class="sandbox-stat-line">—</p>';
      if (gB) gB.innerHTML = '<p class="sandbox-stat-line">—</p>';
      if (aB) aB.innerHTML = '<p class="sandbox-stat-line">—</p>';
      if (zB) zB.innerHTML = '<p class="sandbox-stat-line">—</p>';
      var ethSup = document.getElementById("sandbox-demographics-ethnicity");
      var lunchSup = document.getElementById("sandbox-demographics-lunch");
      if (ethSup) {
        ethSup.innerHTML = demographicsSuppressedEmptyHtml();
      }
      if (lunchSup) {
        lunchSup.innerHTML = demographicsSuppressedEmptyHtml();
      }
      return;
    }
    lead.textContent =
      inHexStr +
      " " +
      inHexNoun +
      " live in the selected hex cells. Toggle grades or school types to exclude them from statistics below.";
    var detailIncluded =
      agg.totalStudents != null && !isNaN(Number(agg.totalStudents)) ? Number(agg.totalStudents) : 0;
    if (atB) {
      atB.innerHTML = formatSandboxAttendanceTypeBarHtml(
        agg.byAttendanceTypeFull || {},
        totalInHex,
        detailIncluded
      );
    }
    if (gB) {
      gB.innerHTML = formatSandboxGradeBarChartHtml(agg.byGrade, totalInHex, detailIncluded);
      var gSelAll = gB.querySelector(".sandbox-grade-select-all");
      if (gSelAll) {
        var gAgg = sandboxGradeFilterAggregateState(agg.byGrade);
        gSelAll.indeterminate =
          gAgg.keysCount > 0 && !gAgg.allOn && !gAgg.allOff;
      }
    }
    if (aB) aB.innerHTML = formatSandboxSchoolListHtml(agg.byAttendance, 5, "attendance");
    if (zB) zB.innerHTML = formatSandboxSchoolListHtml(agg.byZoned, 5, "zoned");
    /* Demographics: count only students with ethnicity/lunch in hex layer (homeschool excluded). */
    var demographicsCohort = demographicsCohortCountFromAggregates({
      ethnicity: agg.ethnicity,
      lunchStatus: agg.lunch,
    });
    if (shouldSuppressDemographicsCharts(demographicsCohort)) {
      var ethDemo = document.getElementById("sandbox-demographics-ethnicity");
      var lunchDemo = document.getElementById("sandbox-demographics-lunch");
      if (ethDemo) {
        ethDemo.innerHTML = demographicsSuppressedEmptyHtml();
      }
      if (lunchDemo) {
        lunchDemo.innerHTML = demographicsSuppressedEmptyHtml();
      }
    } else {
      renderSandboxHexLayerDemographicPies(agg.ethnicity, agg.lunch);
    }
  }

  /**
   * Pre-fills the ACTIVE boundary with every hex whose centroid lies inside
   * the base school's assignment polygon — including hexes where no
   * grade-eligible students happen to live (swiss-cheese-hole infill). Hexes
   * with at least one zoned student or a homeschool resident are also added
   * (covers cells whose centroid is just outside the polygon but whose
   * residents are zoned by source data).
   *
   * Also restricts the active boundary's enabled grade range to the base
   * school's grades_served so a K-6 ES + 7-8 MS can coexist on shared hexes.
   * Hexes that would create a grade-overlap conflict with another boundary
   * are skipped. Returns { added, skipped }.
   */
  function prefillBoundarySandboxZonedHexesForBaseMsid(baseMsid) {
    var active = sandboxActiveBoundary();
    if (!active) return { added: 0, skipped: 0 };
    /* Clear only the ACTIVE boundary's hexes (preserve other boundaries). When
       the hex was shared with another boundary, repaint to that owner's color
       rather than blanking the cell. */
    for (var prevK in active.selectedHexKeys) {
      try {
        if (map) {
          var remainingPrev = sandboxBoundaryOwningHexExcluding(prevK, active.id);
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: prevK },
            { boundaryId: remainingPrev ? remainingPrev.id : "" }
          );
        }
      } catch (eClr) { /* ignore */ }
    }
    active.selectedHexKeys = Object.create(null);
    active.confirmedHexKeysSnapshot = Object.create(null);
    active.gradeToggles = sandboxMakeDefaultGradeToggles();
    active.attendanceTypeToggles = sandboxMakeDefaultAttendanceTypeToggles();
    active.schoolListExpanded = { attendance: false, zoned: false };
    active.lassoRegionFootprintFeature = null;
    var counts = { added: 0, skipped: 0 };
    if (baseMsid == null || isNaN(baseMsid)) {
      syncSandboxLassoFootprintFromSelectedHexGeometries();
      return counts;
    }
    if (selectedSchoolDisallowsZonedStudentHex(baseMsid)) {
      syncSandboxLassoFootprintFromSelectedHexGeometries();
      return counts;
    }
    var m = masterRow(baseMsid);
    if (!m) {
      syncSandboxLassoFootprintFromSelectedHexGeometries();
      return counts;
    }
    /* Restrict gradeToggles to the base school's grades_served (any K-12 grade
       not in the served list is set to false). This enables non-overlapping
       boundary coexistence (e.g., K-6 ES + 7-8 MS on the same hex). PK and NG
       are not in the chip list so they remain at the default (on). */
    var servedGrades = parseGradesServedToCanonList(m.grades_served);
    if (servedGrades && servedGrades.length > 0) {
      var servedSet = Object.create(null);
      for (var sgi = 0; sgi < servedGrades.length; sgi++) {
        servedSet[servedGrades[sgi]] = true;
      }
      for (var fgi = 0; fgi < SANDBOX_FIXED_GRADE_CHIPS.length; fgi++) {
        var fg = SANDBOX_FIXED_GRADE_CHIPS[fgi];
        if (!servedSet[fg]) active.gradeToggles[fg] = false;
      }
    }
    var zMap = collectZonedDetailsByHex(baseMsid, m, false);
    for (var hk in zMap) {
      if (!Object.prototype.hasOwnProperty.call(zMap, hk)) continue;
      var arr = zMap[hk];
      if (!arr || !arr.length) continue;
      if (sandboxHexOverlapWouldConflict(hk, active)) {
        counts.skipped++;
        continue;
      }
      active.selectedHexKeys[hk] = true;
      counts.added++;
    }
    var hmInPoly = homeschoolHexKeysWithCentroidInAssignmentBoundary(baseMsid);
    for (var hmk in hmInPoly) {
      if (!hmInPoly[hmk]) continue;
      if (active.selectedHexKeys[hmk]) continue;
      if (sandboxHexOverlapWouldConflict(hmk, active)) {
        counts.skipped++;
        continue;
      }
      active.selectedHexKeys[hmk] = true;
      counts.added++;
    }
    /* Geographic superset: every hex (real or filler) whose centroid lies
       inside the assignment polygon. This pulls in empty cells the student
       index doesn't know about and naturally infills swiss-cheese holes. */
    var inPoly = allHexKeysWithCentroidInAssignmentBoundary(baseMsid);
    for (var ipk in inPoly) {
      if (!inPoly[ipk]) continue;
      if (active.selectedHexKeys[ipk]) continue;
      if (sandboxHexOverlapWouldConflict(ipk, active)) {
        counts.skipped++;
        continue;
      }
      active.selectedHexKeys[ipk] = true;
      counts.added++;
    }
    syncSandboxLassoFootprintFromSelectedHexGeometries();
    applyBoundarySandboxSelectionFeatureStates();
    return counts;
  }

  /** Invisible one-hex-per-feature layer; selection shown via feature-state. */
  function rebuildBoundarySandboxHexSourceFromIndex() {
    if (!map || !map.getSource("boundary-sandbox-hex")) return;
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) {
      clearAllBoundarySandboxHexFeatureStates();
      BOUNDARY_SANDBOX.selectedHexKeys = Object.create(null);
      resetBoundarySandboxFilterState();
      try {
        map.getSource("boundary-sandbox-hex").setData({
          type: "FeatureCollection",
          features: [],
        });
      } catch (e0) {
        /* ignore */
      }
      requestApplyBoundarySandboxSelectionOnIdle();
      updateSandboxSelectedHexCountUi();
      return;
    }
    var gk = STUDENT_HEX_INDEX.geometryByHexKey;
    pruneBoundarySandboxSelectedKeysToGeometry();
    var feats = [];
    for (var k in gk) {
      if (!Object.prototype.hasOwnProperty.call(gk, k)) continue;
      var g = gk[k];
      if (!g) continue;
      feats.push({
        type: "Feature",
        properties: { _hexKey: k },
        geometry: g,
      });
    }
    if (HOMESCHOOL_HEX_GEOMETRY_FALLBACK) {
      for (var fk in HOMESCHOOL_HEX_GEOMETRY_FALLBACK) {
        if (!Object.prototype.hasOwnProperty.call(HOMESCHOOL_HEX_GEOMETRY_FALLBACK, fk)) {
          continue;
        }
        if (gk[fk]) {
          continue;
        }
        var gHm = HOMESCHOOL_HEX_GEOMETRY_FALLBACK[fk];
        if (!gHm) {
          continue;
        }
        feats.push({
          type: "Feature",
          properties: { _hexKey: fk },
          geometry: gHm,
        });
      }
    }
    /* Synthetic filler hexes (zero students) so the sandbox map looks like
       a contiguous mesh instead of swiss-cheese-with-holes. */
    if (EMPTY_HEX_GEOMETRY) {
      for (var efk in EMPTY_HEX_GEOMETRY) {
        if (!Object.prototype.hasOwnProperty.call(EMPTY_HEX_GEOMETRY, efk)) continue;
        var gEm = EMPTY_HEX_GEOMETRY[efk];
        if (!gEm) continue;
        feats.push({
          type: "Feature",
          properties: { _hexKey: efk },
          geometry: gEm,
        });
      }
    }
    try {
      map.getSource("boundary-sandbox-hex").setData({
        type: "FeatureCollection",
        features: feats,
      });
    } catch (e1) {
      /* ignore */
    }
    requestApplyBoundarySandboxSelectionOnIdle();
    updateSandboxSelectedHexCountUi();
  }

  function syncBoundarySandboxMapLayers() {
    if (!map || !map.getLayer("boundary-sandbox-hex-fill")) return;
    var vis = isBoundarySandboxViewActive() ? "visible" : "none";
    if (map.getLayer("boundary-sandbox-lasso-region-fill")) {
      try {
        map.setLayoutProperty("boundary-sandbox-lasso-region-fill", "visibility", vis);
      } catch (eLf) {
        /* ignore */
      }
    }
    if (map.getLayer("boundary-sandbox-lasso-region-outline")) {
      try {
        map.setLayoutProperty("boundary-sandbox-lasso-region-outline", "visibility", vis);
      } catch (eLo) {
        /* ignore */
      }
    }
    try {
      map.setLayoutProperty("boundary-sandbox-hex-fill", "visibility", vis);
    } catch (e) {
      /* ignore */
    }
    if (map.getLayer("boundary-sandbox-lasso-line")) {
      try {
        map.setLayoutProperty("boundary-sandbox-lasso-line", "visibility", vis);
      } catch (eL) {
        /* ignore */
      }
    }
    if (map.getLayer("boundary-sandbox-selection-outline-line")) {
      try {
        map.setLayoutProperty("boundary-sandbox-selection-outline-line", "visibility", vis);
      } catch (eO) {
        /* ignore */
      }
    }
    if (vis === "visible") {
      requestApplyBoundarySandboxSelectionOnIdle();
      updateBoundarySandboxSelectionOutline();
    }
  }

  /* ===== Multi-boundary sandbox CRUD, rendering, summary table ===== */

  /** Update the lasso trace / region tint / selection outline colors to match the active boundary. */
  function syncSandboxActiveBoundaryPaints() {
    var active = sandboxActiveBoundary();
    var fill = active ? active.color : "#84cc16";
    var outline = active ? active.outline : "#65a30d";
    if (!map) return;
    try {
      if (map.getLayer("boundary-sandbox-lasso-region-fill")) {
        map.setPaintProperty("boundary-sandbox-lasso-region-fill", "fill-color", fill);
      }
      if (map.getLayer("boundary-sandbox-lasso-region-outline")) {
        map.setPaintProperty("boundary-sandbox-lasso-region-outline", "line-color", outline);
      }
      if (map.getLayer("boundary-sandbox-lasso-line")) {
        map.setPaintProperty("boundary-sandbox-lasso-line", "line-color", outline);
      }
      if (map.getLayer("boundary-sandbox-selection-outline-line")) {
        map.setPaintProperty("boundary-sandbox-selection-outline-line", "line-color", outline);
      }
    } catch (e) { /* ignore */ }
  }

  /** Brief inline notice for sandbox overlap blocks. With an explicit `msg`
   *  the notice shows that exact string; otherwise the legacy "N hexes were
   *  blocked because their grade range overlaps another boundary" message
   *  is used (n is the count of blocked hexes). */
  var sandboxOverlapNoticeTimer = null;
  function showSandboxOverlapNotice(n, msg) {
    var el = document.getElementById("sandbox-overlap-notice");
    if (!el) return;
    if (msg) {
      el.textContent = String(msg);
    } else {
      var noun = n === 1 ? "hex" : "hexes";
      el.textContent =
        n + " " + noun + " were not added — their grade range overlaps another boundary that already owns the hex. Untoggle the conflicting grades in one of the boundaries first.";
    }
    el.hidden = false;
    if (sandboxOverlapNoticeTimer) {
      clearTimeout(sandboxOverlapNoticeTimer);
    }
    sandboxOverlapNoticeTimer = setTimeout(function () {
      if (el) el.hidden = true;
    }, 5500);
  }

  /** Ensure there's at least one boundary so the user can immediately start drawing. */
  function ensureSandboxHasAtLeastOneBoundary() {
    if (BOUNDARY_SANDBOX.boundaries.length === 0) {
      sandboxAddBoundary();
    }
    if (!BOUNDARY_SANDBOX.activeBoundaryId && BOUNDARY_SANDBOX.boundaries.length) {
      BOUNDARY_SANDBOX.activeBoundaryId = BOUNDARY_SANDBOX.boundaries[0].id;
    }
    syncSandboxActiveBoundaryPaints();
  }

  function sandboxAddBoundary() {
    if (BOUNDARY_SANDBOX.boundaries.length >= SANDBOX_MAX_BOUNDARIES) return null;
    /* Find the lowest unused palette slot. */
    var used = {};
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      used[BOUNDARY_SANDBOX.boundaries[i].id] = true;
    }
    var slot = 0;
    for (slot = 0; slot < SANDBOX_BOUNDARY_PALETTE.length; slot++) {
      if (!used[SANDBOX_BOUNDARY_PALETTE[slot].id]) break;
    }
    if (slot >= SANDBOX_BOUNDARY_PALETTE.length) return null;
    var b = sandboxMakeBoundaryRecord(slot);
    BOUNDARY_SANDBOX.boundaries.push(b);
    /* Newly added boundary becomes active. Route through sandboxSetActiveBoundary
       so the lasso-region and selection-outline sources get reset to the new
       (empty) boundary's geometry — otherwise the previous boundary's halo
       would linger on the map but repainted in the new boundary's color
       (visible as the previously selected area suddenly turning the new
       boundary's color before the user has even drawn anything). */
    sandboxSetActiveBoundary(b.id);
    return b;
  }

  function sandboxRemoveBoundary(boundaryId) {
    var idx = -1;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      if (BOUNDARY_SANDBOX.boundaries[i].id === boundaryId) { idx = i; break; }
    }
    if (idx < 0) return;
    var b = BOUNDARY_SANDBOX.boundaries[idx];
    /* Clear feature-state for its hexes — but if any hex is also owned by
       another boundary, repaint to that owner's color instead of blanking it. */
    for (var k in b.selectedHexKeys) {
      try {
        if (map) {
          var remainingRem = sandboxBoundaryOwningHexExcluding(k, boundaryId);
          map.setFeatureState(
            { source: "boundary-sandbox-hex", id: k },
            { boundaryId: remainingRem ? remainingRem.id : "" }
          );
        }
      } catch (eC) { /* ignore */ }
    }
    BOUNDARY_SANDBOX.boundaries.splice(idx, 1);
    if (BOUNDARY_SANDBOX.activeBoundaryId === boundaryId) {
      BOUNDARY_SANDBOX.activeBoundaryId =
        BOUNDARY_SANDBOX.boundaries.length ? BOUNDARY_SANDBOX.boundaries[0].id : null;
    }
    syncSandboxActiveBoundaryPaints();
  }

  function sandboxSetActiveBoundary(boundaryId) {
    var found = false;
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      if (BOUNDARY_SANDBOX.boundaries[i].id === boundaryId) { found = true; break; }
    }
    if (!found) return;
    BOUNDARY_SANDBOX.activeBoundaryId = boundaryId;
    syncSandboxActiveBoundaryPaints();
    /* Refresh hex feature-states so the new active boundary's color paints
       on top of shared (overlapping) hexes. */
    applyBoundarySandboxSelectionFeatureStates();
    /* Refresh the lasso/outline footprints to track the active boundary. */
    syncSandboxLassoFootprintFromSelectedHexGeometries();
    updateBoundarySandboxSelectionOutline();
  }

  /** Convert a #rrggbb hex color to an rgba() string at the given alpha. */
  function sandboxHexToRgba(hex, alpha) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "rgba(29,78,216," + alpha + ")";
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  /** Update only the active-row highlight in the boundaries list (no full
   *  re-render) so activating a boundary by clicking its row never steals
   *  focus from an in-progress rename. */
  function sandboxApplyActiveRowHighlight() {
    var ul = document.getElementById("sandbox-boundaries-list");
    if (!ul) return;
    var rows = ul.querySelectorAll(".sandbox-boundary-row");
    for (var i = 0; i < rows.length; i++) {
      var rid = rows[i].getAttribute("data-boundary-id");
      var on = rid === BOUNDARY_SANDBOX.activeBoundaryId;
      rows[i].classList.toggle("is-active", on);
      var sw = rows[i].querySelector(".sandbox-boundary-row__swatch");
      if (sw) sw.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  /** Activate a boundary from a UI click/keypress and refresh the highlight. */
  function sandboxActivateBoundaryFromUi(boundaryId) {
    if (!boundaryId || boundaryId === BOUNDARY_SANDBOX.activeBoundaryId) return;
    sandboxSetActiveBoundary(boundaryId);
    sandboxApplyActiveRowHighlight();
    updateSandboxSelectedHexCountUi();
  }

  function sandboxResetAll() {
    /* Clear feature-state for every hex in every boundary, then drop boundaries. */
    clearAllBoundarySandboxHexFeatureStates();
    BOUNDARY_SANDBOX.boundaries = [];
    BOUNDARY_SANDBOX.activeBoundaryId = null;
    clearBoundarySandboxLassoLine();
    clearBoundarySandboxLassoRegionFill();
    BOUNDARY_SANDBOX_PAINT = {
      active: false,
      lastKey: null,
      startX: 0,
      startY: 0,
      clickKey: null,
      isDrag: false,
    };
    ensureSandboxHasAtLeastOneBoundary();
    renderSandboxBoundariesPanel();
    updateSandboxSelectedHexCountUi();
    renderSandboxSummaryTable();
  }

  /** Render the per-boundary control rows inside `#sandbox-boundaries-list`. */
  function renderSandboxBoundariesPanel() {
    var ul = document.getElementById("sandbox-boundaries-list");
    var addBtn = document.getElementById("sandbox-add-boundary-btn");
    var count = document.getElementById("sandbox-boundaries-count");
    if (!ul) return;
    ul.innerHTML = "";
    if (addBtn) {
      addBtn.disabled = BOUNDARY_SANDBOX.boundaries.length >= SANDBOX_MAX_BOUNDARIES;
    }
    if (count) {
      count.textContent =
        BOUNDARY_SANDBOX.boundaries.length + " / " + SANDBOX_MAX_BOUNDARIES;
    }
    var activeId = BOUNDARY_SANDBOX.activeBoundaryId;
    /* Build a base-school dropdown reusing options from #school-select for parity with Existing Conditions. */
    var existingSel = document.getElementById("school-select");
    var existingOpts = existingSel ? existingSel.querySelectorAll("option") : [];
    for (var i = 0; i < BOUNDARY_SANDBOX.boundaries.length; i++) {
      var b = BOUNDARY_SANDBOX.boundaries[i];
      var li = document.createElement("li");
      li.className = "sandbox-boundary-row" + (b.id === activeId ? " is-active" : "");
      li.setAttribute("data-boundary-id", b.id);
      /* Color-coordinate the active-row highlight with this boundary's palette
         color (green for boundary 1, teal for boundary 2, etc.). */
      li.style.setProperty("--bnd-accent", b.outline);
      li.style.setProperty("--bnd-tint", sandboxHexToRgba(b.color, 0.14));
      li.style.setProperty("--bnd-glow", sandboxHexToRgba(b.outline, 0.3));
      /* Clicking anywhere in the row makes it the active boundary. */
      li.addEventListener("click", function (ev) {
        var row = ev.currentTarget;
        if (!row) return;
        sandboxActivateBoundaryFromUi(row.getAttribute("data-boundary-id"));
      });
      /* Color swatch doubles as the accessible activation control (keyboard
         users can tab to it and press Enter/Space). */
      var sw = document.createElement("button");
      sw.type = "button";
      sw.className = "sandbox-boundary-row__swatch";
      sw.style.background = b.color;
      sw.style.borderColor = b.outline;
      sw.setAttribute("aria-pressed", b.id === activeId ? "true" : "false");
      sw.setAttribute("aria-label", "Make " + b.name + " the active boundary");
      sw.addEventListener("click", function (ev) {
        var row = ev.target.closest(".sandbox-boundary-row");
        if (!row) return;
        sandboxActivateBoundaryFromUi(row.getAttribute("data-boundary-id"));
      });
      li.appendChild(sw);
      /* Body: name input + base-school select + hex count. */
      var body = document.createElement("div");
      body.className = "sandbox-boundary-row__body";
      var nameInp = document.createElement("input");
      nameInp.type = "text";
      nameInp.className = "sandbox-boundary-row__name";
      nameInp.value = b.name;
      nameInp.setAttribute("aria-label", "Rename boundary");
      nameInp.addEventListener("input", function (ev) {
        var row = ev.target.closest(".sandbox-boundary-row");
        if (!row) return;
        var bid = row.getAttribute("data-boundary-id");
        for (var k = 0; k < BOUNDARY_SANDBOX.boundaries.length; k++) {
          if (BOUNDARY_SANDBOX.boundaries[k].id === bid) {
            BOUNDARY_SANDBOX.boundaries[k].name = ev.target.value || ("Boundary " + (k + 1));
            renderSandboxSummaryTable();
            break;
          }
        }
      });
      body.appendChild(nameInp);
      var meta = document.createElement("div");
      meta.className = "sandbox-boundary-row__meta";
      /* Base school select (only build once we know the existing options). */
      var baseSel = document.createElement("select");
      baseSel.className = "sandbox-boundary-row__base-select";
      baseSel.setAttribute("aria-label", "Base school for " + b.name + " (optional)");
      var noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "Base school (optional)";
      baseSel.appendChild(noneOpt);
      for (var oi = 0; oi < existingOpts.length; oi++) {
        var o = existingOpts[oi];
        if (!o.value) continue;
        var nopt = document.createElement("option");
        nopt.value = o.value;
        nopt.textContent = o.textContent;
        baseSel.appendChild(nopt);
      }
      baseSel.value = b.baseMsid != null ? String(b.baseMsid) : "";
      baseSel.addEventListener("change", function (ev) {
        var row = ev.target.closest(".sandbox-boundary-row");
        if (!row) return;
        var bid = row.getAttribute("data-boundary-id");
        sandboxSetActiveBoundary(bid);
        renderSandboxBoundariesPanel(); /* reflect new active */
        var v = ev.target.value;
        var ms = v ? Number(v) : null;
        var bRec = sandboxActiveBoundary();
        if (bRec) {
          bRec.baseMsid = (ms != null && !isNaN(ms)) ? ms : null;
          /* Auto-name the boundary after the chosen base school (shorthand). */
          if (bRec.baseMsid != null) {
            var baseShort = schoolShortNameForMsid(bRec.baseMsid);
            if (baseShort) bRec.name = baseShort;
          }
        }
        var counts = prefillBoundarySandboxZonedHexesForBaseMsid(bRec ? bRec.baseMsid : null);
        if (counts && counts.skipped > 0) showSandboxOverlapNotice(counts.skipped);
        syncStudentHexLayer();
        updateSandboxSelectedHexCountUi();
        renderSandboxBoundariesPanel(); /* reflect the auto-populated name */
        renderSandboxSummaryTable();
      });
      meta.appendChild(baseSel);
      /* Hex count badge. */
      var nHex = 0;
      for (var hk in b.selectedHexKeys) {
        if (b.selectedHexKeys[hk]) nHex++;
      }
      var hexCt = document.createElement("span");
      hexCt.className = "sandbox-boundary-row__hex-count";
      hexCt.textContent = nHex + " hex" + (nHex === 1 ? "" : "es");
      meta.appendChild(hexCt);
      body.appendChild(meta);
      li.appendChild(body);
      /* Delete button. */
      var del = document.createElement("button");
      del.type = "button";
      del.className = "sandbox-boundary-row__delete";
      del.title = "Delete this boundary.";
      del.setAttribute("aria-label", "Remove " + b.name);
      del.innerHTML = "&times;";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var row = ev.target.closest(".sandbox-boundary-row");
        if (!row) return;
        var bid = row.getAttribute("data-boundary-id");
        sandboxRemoveBoundary(bid);
        ensureSandboxHasAtLeastOneBoundary();
        renderSandboxBoundariesPanel();
        updateSandboxSelectedHexCountUi();
        renderSandboxSummaryTable();
      });
      li.appendChild(del);
      /* Per-boundary grade chips. Always show the PK + K-12 + No-grade chip
         strip so the user can pre-configure grade ranges before drawing — this
         lets non-overlapping boundaries (K-6 ES + 7-8 MS) share hexes without
         tripping the grade-conflict rule. PK and No-grade start unchecked. */
      var gradesWrap = document.createElement("div");
      gradesWrap.className = "sandbox-boundary-row__grades-wrap";
      var chipsRow = document.createElement("div");
      chipsRow.className = "sandbox-boundary-row__grade-chips";
      for (var pgi = 0; pgi < SANDBOX_BOUNDARY_GRADE_CHIPS.length; pgi++) {
        (function (gradeCanon, boundaryIdArg) {
          var on = b.gradeToggles[gradeCanon] !== false; /* PK/NG seeded off */
          var chip = document.createElement("label");
          chip.className = "sandbox-boundary-row__grade-chip" + (on ? "" : " is-off");
          var cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = on;
          cb.addEventListener("change", function (ev2) {
            ev2.stopPropagation();
            sandboxSetActiveBoundary(boundaryIdArg);
            var bRec = sandboxActiveBoundary();
            if (!bRec) return;
            var wantOn = !!cb.checked;
            /* Turning a grade ON may collide with another boundary that
               already has the grade enabled on a shared hex. Block + revert. */
            if (wantOn && sandboxEnablingGradeWouldConflict(bRec, gradeCanon)) {
              cb.checked = false;
              showSandboxOverlapNotice(1, "Grade " + travelShedGradeDisplayLabel(gradeCanon) +
                " is already used by another boundary on a shared hex. Untoggle it there first.");
              return;
            }
            bRec.gradeToggles[gradeCanon] = wantOn;
            renderSandboxBoundariesPanel();
            updateSandboxSelectedHexCountUi();
            renderSandboxSummaryTable();
          });
          chip.appendChild(cb);
          chip.appendChild(
            document.createTextNode(travelShedGradeDisplayLabel(gradeCanon))
          );
          chipsRow.appendChild(chip);
        })(SANDBOX_BOUNDARY_GRADE_CHIPS[pgi], b.id);
      }
      gradesWrap.appendChild(chipsRow);
      var copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "sandbox-boundary-row__copy-grades";
      copyBtn.textContent = "Copy grade toggles to all boundaries";
      copyBtn.title = "Use this boundary's grade choices for all the other boundaries.";
      (function (sourceB) {
        copyBtn.addEventListener("click", function (ev3) {
          ev3.stopPropagation();
          for (var ck = 0; ck < BOUNDARY_SANDBOX.boundaries.length; ck++) {
            var other = BOUNDARY_SANDBOX.boundaries[ck];
            if (other.id === sourceB.id) continue;
            other.gradeToggles = sandboxMakeDefaultGradeToggles();
            for (var gk in sourceB.gradeToggles) {
              other.gradeToggles[gk] = sourceB.gradeToggles[gk];
            }
          }
          renderSandboxBoundariesPanel();
          renderSandboxSummaryTable();
        });
      })(b);
      gradesWrap.appendChild(copyBtn);
      li.appendChild(gradesWrap);
      ul.appendChild(li);
    }
  }

  /** Returns the sorted list of canonical grade codes present in `b`'s selected hexes. */
  function collectSandboxBoundaryGradeCodes(b) {
    var set = Object.create(null);
    if (!b) return [];
    var hasTrad = STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.detailsByMsid;
    var hmByHex = HOMESCHOOL_DETAILS_BY_HEX_KEY;
    if (hasTrad) {
      var byDet = STUDENT_HEX_INDEX.detailsByMsid;
      for (var att in byDet) {
        var hexMap = byDet[att];
        for (var hk in b.selectedHexKeys) {
          if (!b.selectedHexKeys[hk]) continue;
          var arr = hexMap[hk];
          if (!arr) continue;
          for (var di = 0; di < arr.length; di++) {
            set[sandboxGradeCanonicalForDetail(arr[di])] = true;
          }
        }
      }
    }
    if (hmByHex) {
      for (var hk2 in b.selectedHexKeys) {
        if (!b.selectedHexKeys[hk2]) continue;
        var hmArr = hmByHex[hk2];
        if (!hmArr) continue;
        for (var hi = 0; hi < hmArr.length; hi++) {
          set[sandboxGradeCanonicalForDetail(hmArr[hi])] = true;
        }
      }
    }
    var keys = Object.keys(set);
    keys.sort(function (a, c) {
      return travelShedGradeSortKey(a) - travelShedGradeSortKey(c);
    });
    return keys;
  }

  /** True when detail `d` passes boundary `b`'s attendance-type toggles. */
  function sandboxBoundaryAttendanceTypeIncludes(b, d) {
    if (!b || !b.attendanceTypeToggles) return true;
    var cat = sandboxAttendanceCategoryForDetail(d);
    return b.attendanceTypeToggles[cat] !== false;
  }

  /** Aggregate stats for one boundary, honoring its grade AND attendance-type toggles. */
  function aggregateSandboxBoundaryByGrade(b) {
    var byGrade = Object.create(null);
    if (!b) return byGrade;
    var hasTrad = STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.detailsByMsid;
    var hmByHex = HOMESCHOOL_DETAILS_BY_HEX_KEY;
    if (hasTrad) {
      var byDet = STUDENT_HEX_INDEX.detailsByMsid;
      for (var att in byDet) {
        var hexMap = byDet[att];
        for (var hk in b.selectedHexKeys) {
          if (!b.selectedHexKeys[hk]) continue;
          var arr = hexMap[hk];
          if (!arr) continue;
          for (var di = 0; di < arr.length; di++) {
            var d = arr[di];
            var gc = sandboxGradeCanonicalForDetail(d);
            if (b.gradeToggles[gc] === false) continue;
            if (!sandboxBoundaryAttendanceTypeIncludes(b, d)) continue;
            byGrade[gc] = (byGrade[gc] || 0) + 1;
          }
        }
      }
    }
    if (hmByHex) {
      for (var hk2 in b.selectedHexKeys) {
        if (!b.selectedHexKeys[hk2]) continue;
        var hmArr = hmByHex[hk2];
        if (!hmArr) continue;
        for (var hi = 0; hi < hmArr.length; hi++) {
          var dh = hmArr[hi];
          var gc2 = sandboxGradeCanonicalForDetail(dh);
          if (b.gradeToggles[gc2] === false) continue;
          if (!sandboxBoundaryAttendanceTypeIncludes(b, dh)) continue;
          byGrade[gc2] = (byGrade[gc2] || 0) + 1;
        }
      }
    }
    return byGrade;
  }

  /** Render the summary table comparing grade-level enrollment across boundaries. */
  function renderSandboxSummaryTable() {
    var wrap = document.getElementById("sandbox-summary-table-wrap");
    if (!wrap) return;
    if (!BOUNDARY_SANDBOX.boundaries.length) {
      wrap.innerHTML =
        '<p class="sandbox-placeholder">No boundaries yet. Add a boundary above and start drawing on the map.</p>';
      return;
    }
    /* aggregateSandboxBoundaryByGrade already filters by per-boundary grade
       toggles, so cells naturally read 0 when the boundary excludes that
       grade. To make the comparison clear, always include the fixed K-12
       grade rows. PK / NG / unknown rows are appended only if some boundary
       has students in those buckets. */
    var bs = BOUNDARY_SANDBOX.boundaries;
    var perBoundaryByGrade = [];
    var extraGradeSet = Object.create(null);
    for (var i = 0; i < bs.length; i++) {
      var bg = aggregateSandboxBoundaryByGrade(bs[i]);
      perBoundaryByGrade.push(bg);
      for (var k in bg) {
        if (SANDBOX_FIXED_GRADE_CHIPS.indexOf(k) === -1) extraGradeSet[k] = true;
      }
    }
    var gradeKeys = SANDBOX_FIXED_GRADE_CHIPS.slice();
    var extras = Object.keys(extraGradeSet);
    extras.sort(function (a, c) {
      return travelShedGradeSortKey(a) - travelShedGradeSortKey(c);
    });
    gradeKeys = gradeKeys.concat(extras);
    /* Build table HTML. */
    var html = ['<table class="sandbox-summary-table" aria-label="Summary table across boundaries">'];
    html.push("<thead><tr><th scope=\"col\">Metric</th>");
    for (var c0 = 0; c0 < bs.length; c0++) {
      var b0 = bs[c0];
      html.push(
        "<th scope=\"col\"><span class=\"sandbox-summary-swatch\" style=\"background:" +
          b0.color +
          ";border-color:" +
          b0.outline +
          "\"></span>" +
          escapeHtml(b0.name) +
          "</th>"
      );
    }
    html.push("</tr></thead><tbody>");
    /* One row per grade. Always print the numeric value (0 included) so the
       user can see when a grade was toggled off in a boundary. */
    var totals = new Array(bs.length).fill(0);
    for (var gi = 0; gi < gradeKeys.length; gi++) {
      var gk = gradeKeys[gi];
      var labFull = gk === "__NOGRADE__" ? "No grade" : ("Grade " + travelShedGradeDisplayLabel(gk));
      html.push("<tr><th scope=\"row\">" + escapeHtml(labFull) + "</th>");
      for (var ci = 0; ci < bs.length; ci++) {
        var cnt = (perBoundaryByGrade[ci][gk] || 0);
        totals[ci] += cnt;
        html.push("<td>" + cnt.toLocaleString() + "</td>");
      }
      html.push("</tr>");
    }
    /* Totals row. */
    html.push('<tr class="sandbox-summary-row--totals"><th scope="row">Total enrollment</th>');
    for (var ti2 = 0; ti2 < bs.length; ti2++) {
      html.push("<td>" + (totals[ti2] > 0 ? totals[ti2].toLocaleString() : "—") + "</td>");
    }
    html.push("</tr>");
    /* Capacity row. */
    html.push('<tr class="sandbox-summary-row--capacity"><th scope="row">Factored capacity (base school)</th>');
    var capacities = [];
    for (var pi3 = 0; pi3 < bs.length; pi3++) {
      var capN = NaN;
      if (bs[pi3].baseMsid != null && !isNaN(bs[pi3].baseMsid)) {
        var mB = masterRow(bs[pi3].baseMsid);
        if (mB && mB.factored_capacity_2025_26 !== "" && mB.factored_capacity_2025_26 != null) {
          var capV = Number(mB.factored_capacity_2025_26);
          if (!isNaN(capV)) capN = capV;
        }
      }
      capacities.push(capN);
      html.push("<td>" + (isNaN(capN) ? "—" : capN.toLocaleString()) + "</td>");
    }
    html.push("</tr>");
    /* Utilization row. */
    html.push('<tr class="sandbox-summary-row--utilization"><th scope="row">Utilization</th>');
    for (var ui = 0; ui < bs.length; ui++) {
      var enrU = totals[ui];
      var capU = capacities[ui];
      if (isNaN(capU) || capU <= 0 || !enrU) {
        html.push("<td>—</td>");
      } else {
        var pct = Math.round((enrU / capU) * 100);
        html.push("<td>" + pct + "%</td>");
      }
    }
    html.push("</tr>");
    html.push("</tbody></table>");
    wrap.innerHTML = html.join("");
  }

  /** Parcel GeoJSON may use SCHL_CODE with or without leading zeros; MSIDs match numerically. */
  function parcelPropertySchlCode(props) {
    if (!props) return null;
    var v =
      props.SCHL_CODE != null
        ? props.SCHL_CODE
        : props.Schl_Code != null
          ? props.Schl_Code
          : props.schl_code != null
            ? props.schl_code
            : null;
    if (v === null || v === "") return null;
    var n = Number(String(v).trim());
    return isNaN(n) ? null : n;
  }

  function schoolExcludedFromParcelOverlay(sp) {
    if (!sp) return true;
    var nm = String(sp.NAME || sp.CommonName || "").toUpperCase();
    if (nm.indexOf("CHARTER") >= 0) return true;
    return false;
  }

  /** @returns {"elementary"|"middle"|"high"|null} */
  function schoolParcelLevelFromType(sp) {
    if (!sp) return null;
    var t = String(sp.TYPE || "").toUpperCase();
    if (t === "ELEMENTARY") return "elementary";
    if (t === "MIDDLE") return "middle";
    if (t === "HIGH" || t === "JR SR HIGH") return "high";
    return null;
  }

  /**
   * Parcel styling level: Jr/Sr (7–12) is separate from 9–12 high so parcels can use orange.
   * Uses master CSV TYPE when present (same as school dots).
   * @returns {"elementary"|"middle"|"high"|"jr_sr"|null}
   */
  function schoolParcelStripeLevel(sp) {
    if (!sp) return null;
    var spM = schoolPropsWithMasterType(sp);
    var t = String(spM.TYPE || "").toUpperCase();
    if (t === "JR SR HIGH") return "jr_sr";
    if (t === "ELEMENTARY") return "elementary";
    if (t === "MIDDLE") return "middle";
    if (t === "HIGH") return "high";
    return null;
  }

  function buildFilteredSchoolParcelsFc(schoolsFc, parcelsFc) {
    var out = { type: "FeatureCollection", features: [] };
    if (!parcelsFc || !parcelsFc.features || !parcelsFc.features.length) {
      return out;
    }
    var byMsid = buildSchoolLookup(schoolsFc);
    for (var i = 0; i < parcelsFc.features.length; i++) {
      var ft = parcelsFc.features[i];
      var p = ft.properties || {};
      var msid = parcelPropertySchlCode(p);
      if (msid == null) continue;
      var sp = byMsid[msid];
      if (!sp) continue;
      if (schoolExcludedFromParcelOverlay(sp)) continue;
      var lvl = schoolParcelStripeLevel(sp);
      if (!lvl) continue;
      var geom = ft.geometry;
      if (!geom || (geom.type !== "Polygon" && geom.type !== "MultiPolygon")) {
        continue;
      }
      out.features.push({
        type: "Feature",
        geometry: geom,
        properties: { SCHOOLS_ID: msid, _parcelLevel: lvl },
      });
    }
    return out;
  }

  /** Re-apply toolbar layer checkbox visibility after map layers are recreated (e.g. basemap switch). */
  function resyncToolbarLayerToggleVisibility() {
    var panel = document.getElementById("toolbar-panel");
    if (!panel) return;
    panel.querySelectorAll('input[type="checkbox"][id^="toggle-"]').forEach(function (inp) {
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    });
    syncCharterPrivateVaryEnrollmentCirclePaint();
  }

  function appendToggleRow(container, def, onAfterChange) {
    var id = "toggle-" + def.id;
    var label = document.createElement("label");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked =
      def.defaultChecked === undefined ? true : !!def.defaultChecked;
    function applyVisibilityToLayers() {
      var vis = input.checked ? "visible" : "none";
      def.layerIds.forEach(function (lid) {
        if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", vis);
      });
    }
    applyVisibilityToLayers();
    input.addEventListener("change", function () {
      applyVisibilityToLayers();
      if (typeof onAfterChange === "function") onAfterChange();
    });
    label.appendChild(input);
    if (def.gradientStrip) {
      var gs = document.createElement("span");
      gs.className =
        "toggle-gradient-strip" +
        (def.gradientStripClass ? " " + def.gradientStripClass : "");
      gs.setAttribute("aria-hidden", "true");
      label.appendChild(gs);
    } else if (def.swatchVariant === "split-jr-sr") {
      var swSplit = document.createElement("span");
      swSplit.className = "swatch swatch--split-jr-sr";
      swSplit.setAttribute("aria-hidden", "true");
      label.appendChild(swSplit);
    } else if (def.swatchColor) {
      var sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = def.swatchColor;
      sw.setAttribute("aria-hidden", "true");
      label.appendChild(sw);
    }
    if (def.sublabel) {
      var stack = document.createElement("span");
      stack.className = "toggle-label-stack";
      var main = document.createElement("span");
      main.className = "toggle-label-main";
      main.textContent = def.label;
      stack.appendChild(main);
      var sub = document.createElement("span");
      sub.className = "toggle-label-sub";
      sub.textContent = def.sublabel;
      stack.appendChild(sub);
      label.appendChild(stack);
    } else {
      var mainOnly = document.createElement("span");
      mainOnly.className = "toggle-label-main";
      mainOnly.textContent = def.label;
      label.appendChild(mainOnly);
    }
    container.appendChild(label);
  }

  function setupToggles() {
    var boundaryDefs = [
      {
        id: "es",
        label: "Elementary",
        layerIds: ["es-fill", "es-outline"],
        swatchColor: PALETTE.elementary.fill,
        defaultChecked: false,
      },
      {
        id: "ms",
        label: "Middle",
        layerIds: ["ms-fill", "ms-outline"],
        swatchColor: PALETTE.middle.fill,
        defaultChecked: false,
      },
      {
        id: "hs",
        label: "High",
        sublabel: "(incl. Jr/Sr)",
        layerIds: ["hs-fill", "hs-outline"],
        swatchVariant: "split-jr-sr",
        defaultChecked: false,
      },
    ];
    var schoolDefs = [
      {
        id: "sch-es",
        label: "Elementary",
        layerIds: ["schools-elementary", "schools-elementary-label"],
        swatchColor: PALETTE.elementary.fill,
        defaultChecked: true,
      },
      {
        id: "sch-ms",
        label: "Middle",
        layerIds: ["schools-middle", "schools-middle-label"],
        swatchColor: PALETTE.middle.fill,
        defaultChecked: true,
      },
      {
        id: "sch-hs",
        label: "High",
        sublabel: "(incl. Jr/Sr)",
        swatchVariant: "split-jr-sr",
        layerIds: ["schools-high", "schools-high-label"],
        defaultChecked: true,
      },
    ];

    var bEl = document.getElementById("boundary-toggles");
    var sEl = document.getElementById("school-toggles");
    boundaryDefs.forEach(function (def) {
      appendToggleRow(bEl, def, refreshAssignmentBoundaryHighlight);
    });
    schoolDefs.forEach(function (def) {
      appendToggleRow(sEl, def);
    });

    var parcelDefs = [
      {
        id: "parcel-es",
        label: "Elementary",
        layerIds: ["school-parcels-elementary"],
        swatchColor: PALETTE.elementary.fill,
        defaultChecked: false,
      },
      {
        id: "parcel-ms",
        label: "Middle",
        layerIds: ["school-parcels-middle"],
        swatchColor: PALETTE.middle.fill,
        defaultChecked: false,
      },
      {
        id: "parcel-hs",
        label: "High",
        sublabel: "(incl. Jr/Sr)",
        swatchVariant: "split-jr-sr",
        layerIds: ["school-parcels-jr-sr", "school-parcels-high"],
        defaultChecked: false,
      },
    ];
    var pEl = document.getElementById("school-parcel-toggles");
    if (pEl) {
      parcelDefs.forEach(function (def) {
        appendToggleRow(pEl, def);
      });
    }

    var hxEl = document.getElementById("student-hex-toggles");
    if (hxEl) {
      appendToggleRow(
        hxEl,
        {
          id: "student-hex",
          label: "Student residence density",
          layerIds: ["student-hex-heatmap", "student-hex-hit-fill"],
          gradientStrip: true,
          defaultChecked: false,
        },
        function () {
          var inp = document.getElementById("toggle-student-hex");
          if (inp && inp.checked) {
            syncStudentHexLayer();
          }
          syncStudentHexTooltipCheckboxVisibility();
          syncMapDensityLegend();
        }
      );
      var attMode = document.getElementById("toggle-student-hex-attending");
      var zonMode = document.getElementById("toggle-student-hex-zoned");
      if (attMode) {
        attMode.addEventListener("change", function () {
          syncStudentHexLayer();
        });
      }
      if (zonMode) {
        zonMode.addEventListener("change", function () {
          syncStudentHexLayer();
        });
      }
      syncStudentHexResidenceSubToggleAvailability();
    }

    var cHexEl = document.getElementById("charter-student-hex-toggles");
    if (cHexEl) {
      appendToggleRow(
        cHexEl,
        {
          id: "charter-student-hex",
          label: "Charter student residence density",
          layerIds: [
            "charter-student-hex-heatmap",
            "charter-student-hex-hit-fill",
          ],
          gradientStrip: true,
          gradientStripClass: "toggle-gradient-strip--charter-magenta",
          defaultChecked: false,
        },
        function () {
          syncCharterDistrictStudentHexLayer();
          syncStudentHexTooltipCheckboxVisibility();
          syncMapDensityLegend();
        }
      );
    }

    var hsHexEl = document.getElementById("homeschool-student-hex-toggles");
    if (hsHexEl) {
      appendToggleRow(
        hsHexEl,
        {
          id: "homeschool-student-hex",
          label: "Homeschool student residence density",
          layerIds: [
            "homeschool-student-hex-heatmap",
            "homeschool-student-hex-hit-fill",
          ],
          gradientStrip: true,
          gradientStripClass: "toggle-gradient-strip--homeschool-red",
          defaultChecked: false,
        },
        function () {
          syncHomeschoolStudentHexLayer();
          syncStudentHexTooltipCheckboxVisibility();
          syncMapDensityLegend();
        }
      );
    }
    if (document.getElementById("student-hex-tooltip-row") != null) {
      syncStudentHexTooltipCheckboxVisibility();
    }

    var travelShedEl = document.getElementById("travel-shed-toggles");
    if (travelShedEl) {
      appendToggleRow(
        travelShedEl,
        {
          id: "travel-sheds",
          label: "Travel sheds",
          layerIds: ["school-isochrones-fill", "school-isochrones-outline"],
          gradientStrip: true,
          gradientStripClass: "toggle-gradient-strip--travel-sheds",
          defaultChecked: false,
        },
        function () {
          syncTravelShedLayerFilter();
          syncTravelShedMaxMilesRowVisibility();
        }
      );
    }
    setupTravelShedMaxMilesControl();
    syncTravelShedMaxMilesRowVisibility();

    var sbdEl = document.getElementById("school-board-district-toggles");
    if (sbdEl) {
      appendToggleRow(sbdEl, {
        id: "school-board-districts",
        label: "School board districts",
        layerIds: ["school-board-districts-fill", "school-board-districts-outline"],
        swatchColor: "#374151",
        defaultChecked: false,
      });
    }

    var munEl = document.getElementById("municipal-boundary-toggles");
    if (munEl) {
      appendToggleRow(munEl, {
        id: "municipal-boundaries",
        label: "Municipal boundaries",
        layerIds: [
          "municipal-boundaries-fill",
          "municipal-boundaries-outline",
          "municipal-boundaries-hover",
        ],
        swatchColor: "#9ca3af",
        defaultChecked: false,
      });
    }

    var charterEl = document.getElementById("charter-school-toggles");
    if (charterEl) {
      appendToggleRow(charterEl, {
        id: "charter-schools",
        label: "Charter schools",
        layerIds: ["schools-charter", "schools-charter-label"],
        swatchColor: PALETTE.charter.fill,
        defaultChecked: false,
      });
    }
    var varyEnrollmentSizeInput = document.getElementById("toggle-nontraditional-vary-enrollment-size");
    if (varyEnrollmentSizeInput) {
      varyEnrollmentSizeInput.addEventListener("change", function () {
        syncCharterPrivateVaryEnrollmentCirclePaint();
      });
    }
    var privateSchoolTogglesEl = document.getElementById("private-school-toggles");
    if (privateSchoolTogglesEl) {
      appendToggleRow(privateSchoolTogglesEl, {
        id: "private-schools",
        label: "Private schools",
        layerIds: ["schools-private", "schools-private-label"],
        swatchColor: PALETTE.privateSchool.fill,
        defaultChecked: false,
      });
    }
    syncCharterPrivateVaryEnrollmentCirclePaint();
    syncMapDensityLegend();
  }

  var BOUNDARY_FILL_LAYERS = ["es-fill", "ms-fill", "hs-fill"];
  var SCHOOL_LAYER_IDS = [
    "schools-elementary",
    "schools-middle",
    "schools-high",
    "schools-charter",
  ];
  /**
   * Map pick priority (top to bottom in stack) for each category.
   * Used with queryRenderedFeatures: first hit is the topmost visible in that set.
   */
  var SCHOOL_LAYERS_CLICK_TOP_FIRST = [
    "schools-private",
    "schools-charter",
    "schools-elementary",
    "schools-middle",
    "schools-high",
  ];
  var SCHOOL_PARCEL_LAYERS_CLICK_TOP_FIRST = [
    "school-parcels-elementary",
    "school-parcels-jr-sr",
    "school-parcels-middle",
    "school-parcels-high",
  ];
  var ASSIGNMENT_BOUNDARY_LAYERS_CLICK_TOP_FIRST = [
    "es-outline",
    "ms-outline",
    "hs-outline",
    "es-fill",
    "ms-fill",
    "hs-fill",
  ];

  /** Topmost paint order first: used so queryRenderedFeatures returns the visually top feature first. */
  var MAP_OVERLAY_HIT_LAYER_ORDER_TOP_FIRST = [
    "schools-private",
    "schools-charter",
    "schools-elementary",
    "schools-middle",
    "schools-high",
    "boundary-sandbox-hex-fill",
    "boundary-sandbox-lasso-region-outline",
    "boundary-sandbox-lasso-region-fill",
    "charter-student-hex-hit-fill",
    "homeschool-student-hex-hit-fill",
    "student-hex-hit-fill",
    "school-parcels-elementary",
    "school-parcels-jr-sr",
    "school-parcels-middle",
    "school-parcels-high",
    "school-isochrones-outline",
    "school-isochrones-fill",
    "es-outline",
    "ms-outline",
    "hs-outline",
    "es-fill",
    "ms-fill",
    "hs-fill",
    "school-board-districts-outline",
    "school-board-districts-fill",
    "municipal-boundaries-outline",
    "municipal-boundaries-fill",
  ];

  function boundaryLayerIdToSource(layerId) {
    if (layerId === "es-fill" || layerId === "es-outline") return "es-boundaries";
    if (layerId === "ms-fill" || layerId === "ms-outline") return "ms-boundaries";
    if (layerId === "hs-fill" || layerId === "hs-outline") return "hs-boundaries";
    return null;
  }

  /** Title-style capitalization for tooltip text (handles ALL CAPS source data). */
  function standardCapitalization(str) {
    if (str == null || str === "") return "";
    return String(str)
      .trim()
      .split(/\s+/)
      .map(function (word) {
        if (/^\d+$/.test(word)) return word;
        if (/^\d+[a-z]*$/i.test(word)) return word.charAt(0) + word.slice(1).toLowerCase();
        if (word.indexOf("-") !== -1) {
          return word
            .split("-")
            .map(function (part) {
              if (/^\d+$/.test(part)) return part;
              return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
            })
            .join("-");
        }
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  /** GeoJSON sometimes uses "Elem" as shorthand; expand for display before title-casing. */
  function expandElemSchoolName(str) {
    if (str == null || str === "") return "";
    return String(str).replace(/\belem\b/gi, "elementary");
  }

  /**
   * Excel/Sheets often turn grade ranges like 9-12 or 7-8 into serial dates (e.g. 12-Sep, 8-Jul).
   * Normalizes those back to display ranges; pass through everything else.
   */
  function normalizeGradesServedForUi(raw) {
    if (raw == null || raw === "") return "";
    var t = String(raw).trim();
    /* Leading apostrophe = Excel “text” cell; strip before normalizing. */
    if (t.charAt(0) === "'") t = t.slice(1).trim();
    if (/^12-sep$/i.test(t)) return "9-12";
    if (/^12-jul$/i.test(t)) return "7-12";
    if (/^8-jul$/i.test(t)) return "7-8";
    if (/^6-apr$/i.test(t)) return "4-6";
    if (/^6-mar$/i.test(t)) return "3-6";
    return t;
  }

  /** Spell out W. Melbourne in city names (GeoJSON / CSV city lines). */
  function expandWestMelbourneCity(cityPart) {
    return String(cityPart).replace(/^W\.\s*Melbourne\b/i, "West Melbourne");
  }

  /** "CITY, ST 12345" → "City, ST 12345" */
  function formatCityStateZip(str) {
    if (!str) return "";
    var t = String(str).trim();
    var m = t.match(/^(.+),\s*([A-Za-z]{2})\s+(.+)$/);
    if (m) {
      var cityExpanded = expandWestMelbourneCity(m[1].trim());
      return (
        standardCapitalization(cityExpanded) +
        ", " +
        m[2].toUpperCase() +
        " " +
        m[3].trim()
      );
    }
    return standardCapitalization(expandWestMelbourneCity(t));
  }

  /**
   * UI polish for school display names (after standardCapitalization).
   * Covers Jr/Sr high labels, Turner/Creel/Williams/West Melbourne wording from mixed sources.
   */
  function formatSchoolDisplayName(str) {
    if (str == null || str === "") return "";
    var s = String(str);
    s = s.replace(/\bJunior\/Senior\b/gi, "Jr/Sr");
    s = s.replace(/\bJr\.?\s+Sr\.?\b/gi, "Jr/Sr");
    s = s.replace(/\bJR\s+SR\b/g, "Jr/Sr");
    s = s.replace(/\bJr\/sr\b/g, "Jr/Sr");
    s = s.replace(/,\s*Senior\b/gi, "");
    s = s.replace(/\bJohn F\.\s*Turner\s*,\s*Senior\b/gi, "John F. Turner");
    s = s.replace(/\bRalph M\s+Williams\b/gi, "Ralph M. Williams");
    s = s.replace(/\bW\.j\./gi, "W.J.");
    s = s.replace(/\bDr\.\s+W\.j\./gi, "Dr. W.J.");
    s = s.replace(/\bW\.\s*Melbourne\b/gi, "West Melbourne");
    s = s.replace(/\bMcnair\b/gi, "McNair");
    s = s.replace(/\bMcauliffe\b/gi, "McAuliffe");
    /* District CSV uses “… Elementary School For Science”; preferred public name drops the suffix. */
    s = s.replace(/\s+Elementary\s+School\s+For\s+Science$/i, " Elementary School");
    /* District CSV stores this school as "SOUTH LAKE ELEMENTARY" (no "SCHOOL" suffix);
       canonical public name appends the suffix to match every other elementary school. */
    s = s.replace(/^South Lake Elementary$/i, "South Lake Elementary School");
    return s;
  }

  /** Prefer data/school_master.csv over GeoJSON NAME/CommonName (district GIS can have typos). */
  function schoolDisplayNamePreferMaster(p) {
    if (!p || p.SCHOOLS_ID == null || !MASTER_BY_MSID) return null;
    var sid = Number(p.SCHOOLS_ID);
    if (isNaN(sid)) return null;
    var m = masterRow(sid);
    if (!m || !m.school_name) return null;
    return formatSchoolDisplayName(
      standardCapitalization(expandElemSchoolName(m.school_name))
    );
  }

  /**
   * Short-form school name suitable for compact UI labels (legend headings,
   * etc.). Replaces the trailing school-level phrase with its abbreviation:
   *   "Golfview Elementary School"            → "Golfview ES"
   *   "Sherwood Middle School"                → "Sherwood MS"
   *   "Bayside High School"                   → "Bayside HS"
   *   "Stone Junior/Senior High School"       → "Stone Jr/Sr HS"
   *   "Stone Jr/Sr High School"               → "Stone Jr/Sr HS"
   * Falls back to the full display name when no level keyword is matched.
   */
  /** Abbreviates the trailing school-level phrase of an already-formatted
   *  display name ("Golfview Elementary School" → "Golfview ES"). */
  function shortenSchoolDisplayName(full) {
    var s = String(full || "");
    var out = s
      .replace(/\s+Jr\/Sr\s+High\s+School\.?\s*$/i, " Jr/Sr HS")
      .replace(/\s+Junior\/Senior\s+High\s+School\.?\s*$/i, " Jr/Sr HS")
      .replace(/\s+Jr\.?\/Sr\.?\s+High\s+School\.?\s*$/i, " Jr/Sr HS")
      .replace(/\s+Elementary\s+School\.?\s*$/i, " ES")
      .replace(/\s+Middle\s+School\.?\s*$/i, " MS")
      .replace(/\s+High\s+School\.?\s*$/i, " HS")
      .replace(/\s+Elementary\.?\s*$/i, " ES")
      .replace(/\s+Middle\.?\s*$/i, " MS")
      .replace(/\s+High\.?\s*$/i, " HS")
      .trim();
    return out || s;
  }

  /**
   * Manual short-name overrides keyed by MSID (SCHOOLS_ID). Used where the
   * automatic abbreviation in `shortenSchoolDisplayName` produces an awkward or
   * overly long label (magnet/"Senior"/named-person schools). Keys are numeric
   * MSID strings; takes priority over the automatic short name.
   */
  var SCHOOL_SHORT_NAME_OVERRIDES = {
    1041: "Cambridge ES",
    2161: "McAuliffe ES",
    6141: "Creel ES",
    5021: "Freedom 7 ES",
    1071: "Golfview ES",
    1141: "Andersen ES",
    2121: "Turner ES",
    1151: "Williams ES",
    4071: "Stevenson ES",
    6013: "Holland ES",
    5012: "Roosevelt ES",
    2011: "Melbourne HS",
    2021: "Palm Bay Magnet HS",
    1011: "Rockledge HS",
    6011: "Satellite HS",
    141: "Jackson MS",
    6082: "Hoover MS",
    52: "Madison MS",
    1101: "Kennedy MS",
    3031: "Johnson MS",
    1081: "McNair MS",
    2071: "Stone MS",
    4111: "Jefferson MS",
  };

  function schoolShortNameFromProps(p) {
    if (!p) return "";
    if (p.SCHOOLS_ID != null) {
      var sid = Number(p.SCHOOLS_ID);
      if (!isNaN(sid) && SCHOOL_SHORT_NAME_OVERRIDES[sid]) {
        return SCHOOL_SHORT_NAME_OVERRIDES[sid];
      }
    }
    return shortenSchoolDisplayName(schoolDisplayNameFromProps(p) || "");
  }

  /** Short-form school name resolved from an MSID (uses cached schools FC). */
  function schoolShortNameForMsid(msid) {
    if (msid == null || isNaN(msid)) return "";
    var fc =
      (GEO_CACHE && GEO_CACHE.schools) ||
      scenarioCachedSchoolsFc ||
      null;
    if (!fc || !fc.features) return "";
    var n = Number(msid);
    for (var i = 0; i < fc.features.length; i++) {
      var ft = fc.features[i];
      var pr = ft && ft.properties;
      if (pr && Number(pr.SCHOOLS_ID) === n) return schoolShortNameFromProps(pr);
    }
    return "";
  }

  /** Display name for map tooltips, dropdown, and sidebar (master CSV when present). */
  function schoolDisplayNameFromProps(p) {
    return (
      schoolDisplayNamePreferMaster(p) ||
      formatSchoolDisplayName(
        standardCapitalization(
          expandElemSchoolName(p.NAME || p.CommonName || "School")
        )
      )
    );
  }

  /** MSIDs with travel workbooks in travel_impact.json today (Johnson, McNair, Stone). */
  var PRIORITY_SCHOOL_MSIDS = [3031, 1081, 2071];
  /** @type {{ id: string, name: string, group: string, chipLabel: string }[]} */
  var FEEDBACK_SCHOOL_COMMUNITY_CATALOG = [];
  /** @type {Object<string, { id: string, name: string, group: string, chipLabel: string }>} */
  var FEEDBACK_SCHOOL_COMMUNITIES_SELECTED = {};
  var FEEDBACK_SCHOOL_COMMUNITIES_COMBO_INIT = false;

  /**
   * Preferred short names for named middle schools (avoids e.g. "Lyndon B. Johnson", "Ronald McNair" in UI).
   * Used for scenario travel chart titles, student-hex tooltips, ESE abbreviations, and capture KPI.
   */
  var SCENARIO_MIDDLE_SHORT_NAME = {
    3031: "Johnson MS",
    1081: "McNair MS",
    2071: "Stone MS",
  };

  /**
   * Short labels for ESE feeder table only: ES / MS / HS / Jr/Sr HS from school_master school_level + name.
   */
  function eseTableAbbreviatedSchoolName(m) {
    if (!m || !m.school_name) return "";
    if (m.msid != null) {
      var ovNum = parseInt(String(m.msid), 10);
      if (!isNaN(ovNum) && SCHOOL_SHORT_NAME_OVERRIDES[ovNum]) {
        return SCHOOL_SHORT_NAME_OVERRIDES[ovNum];
      }
    }
    var lv0 = String(m.school_level || "").toLowerCase().trim();
    if (lv0 === "middle" && m.msid != null) {
      var midNum = parseInt(String(m.msid), 10);
      if (!isNaN(midNum)) {
        var shortMid = SCENARIO_MIDDLE_SHORT_NAME[midNum];
        if (shortMid) {
          return shortMid;
        }
      }
    }
    var full = formatSchoolDisplayName(
      standardCapitalization(expandElemSchoolName(m.school_name))
    );
    var lv = String(m.school_level || "").toLowerCase().trim();
    if (!lv) return full;

    var base = full;

    if (lv === "elementary") {
      base = full
        .replace(/\s+Elementary\s+School\s+Of\s+International\s+Studies$/i, "")
        .replace(/\s+Elementary\s+Magnet\s+School$/i, "")
        .replace(/\s+Elementary\s+School$/i, "")
        .trim();
      return base ? base + " ES" : full;
    }
    if (lv === "middle") {
      base = full.replace(/\s+Magnet\s+Middle\s+School$/i, "").trim();
      base = base.replace(/\s+Middle\s+School$/i, "").trim();
      return base ? base + " MS" : full;
    }
    if (lv === "high") {
      base = full.replace(/\s+Magnet\s+Senior\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+Senior\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+High\s+School$/i, "").trim();
      return base ? base + " HS" : full;
    }
    if (lv === "jr_sr_high") {
      base = full.replace(/\s+Jr\s*\/\s*Sr\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+Jr\.?\s*\/?\s*Sr\.?\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+Magnet\s+Senior\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+Senior\s+High\s+School$/i, "").trim();
      base = base.replace(/\s+High\s+School$/i, "").trim();
      return base ? base + " Jr/Sr HS" : full;
    }

    return full;
  }

  /**
   * Abbreviated school name for capture KPI row 1 (e.g. SHERWOOD ES), uppercase when a school is selected.
   * When nothing is selected, returns "Selected School" (displayed uppercase via .kpi-capture-card-label).
   */
  function captureRateAssignedSchoolLabelUpper(p) {
    if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") return "Selected School";
    var sid = Number(p.SCHOOLS_ID);
    if (isNaN(sid)) return "Selected School";
    var m = masterRow(sid);
    var s = "";
    if (m && m.school_name) {
      s = eseTableAbbreviatedSchoolName(m);
    }
    if (!s) {
      s = schoolDisplayNameFromProps(p) || "";
    }
    s = String(s).trim();
    return s ? s.toUpperCase() : "Selected School";
  }

  /** Display name from district MSID only (for feeder tables when GeoJSON props are unavailable). */
  function eseSchoolNameFromMsid(msidRaw) {
    var n = Number(msidRaw);
    if (isNaN(n)) return String(msidRaw);
    var m = masterRow(n);
    if (!m || !m.school_name) {
      return "MSID " + String(n);
    }
    return eseTableAbbreviatedSchoolName(m);
  }

  /**
   * Convert feeder MSID lists to sorted display names; drops the selected school's MSID (no self-loops).
   */
  function eseFilteredSortedSchoolNames(msidStrings, excludeMsid) {
    var ex = Number(excludeMsid);
    var seen = {};
    var pairs = [];
    for (var i = 0; i < (msidStrings || []).length; i++) {
      var raw = msidStrings[i];
      var n = Number(raw);
      if (isNaN(n)) continue;
      if (n === ex) continue;
      var idStr = String(n);
      if (seen[idStr]) continue;
      seen[idStr] = true;
      pairs.push({ id: idStr, name: eseSchoolNameFromMsid(raw) });
    }
    pairs.sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return pairs.map(function (p) {
      return p.name;
    });
  }

  /** Pre-K through Grade 12 enrollment columns on private-school GeoJSON features. */
  var PRIVATE_SCHOOL_GRADE_KEYS = [
    { key: "Pre_K", ord: -2 },
    { key: "Kindergart", ord: -1 },
    { key: "Grade_1", ord: 1 },
    { key: "Grade_2", ord: 2 },
    { key: "Grade_3", ord: 3 },
    { key: "Grade_4", ord: 4 },
    { key: "Grade_5", ord: 5 },
    { key: "Grade_6", ord: 6 },
    { key: "Grade_7", ord: 7 },
    { key: "Grade_8", ord: 8 },
    { key: "Grade_9", ord: 9 },
    { key: "Grade_10", ord: 10 },
    { key: "Grade_11", ord: 11 },
    { key: "Grade_12", ord: 12 },
  ];

  function privateSchoolGradeOrdinalLabel(ord) {
    if (ord === -2) return "Pre-K";
    if (ord === -1) return "K";
    return String(ord);
  }

  /**
   * Total enrollment (sum of grade columns) and display span from min–max grade with ≥1 student.
   * @returns {{ total: number, gradesLabel: string }}
   */
  function privateSchoolEnrollmentGradeSpan(props) {
    var total = 0;
    var minO = Infinity;
    var maxO = -Infinity;
    if (!props) {
      return { total: 0, gradesLabel: "" };
    }
    for (var i = 0; i < PRIVATE_SCHOOL_GRADE_KEYS.length; i++) {
      var g = PRIVATE_SCHOOL_GRADE_KEYS[i];
      var n = Number(props[g.key]);
      if (isNaN(n)) n = 0;
      total += n;
      if (n > 0) {
        if (g.ord < minO) minO = g.ord;
        if (g.ord > maxO) maxO = g.ord;
      }
    }
    if (!isFinite(minO)) {
      return { total: total, gradesLabel: "" };
    }
    var a = privateSchoolGradeOrdinalLabel(minO);
    var b = privateSchoolGradeOrdinalLabel(maxO);
    var gradesLabel = minO === maxO ? a : a + "–" + b;
    return { total: total, gradesLabel: gradesLabel };
  }

  /** Drop private-school points with no enrollment in any grade column. */
  function filterZeroEnrollmentPrivateSchoolsFc(fc) {
    if (!fc || fc.type !== "FeatureCollection" || !fc.features) {
      return { type: "FeatureCollection", features: [] };
    }
    var kept = [];
    for (var i = 0; i < fc.features.length; i++) {
      var eg = privateSchoolEnrollmentGradeSpan(fc.features[i].properties);
      if (eg.total > 0) kept.push(fc.features[i]);
    }
    return { type: "FeatureCollection", features: kept };
  }

  /**
   * Equal-count quintiles (0 = lowest ~20%) from total grade enrollment; sets `_pe_quintile` for map sizing.
   * Returns a new feature collection (does not mutate the input).
   */
  function enrichPrivateSchoolFcWithEnrollmentQuintiles(fc) {
    if (!fc || fc.type !== "FeatureCollection" || !fc.features) {
      return { type: "FeatureCollection", features: [] };
    }
    var features = fc.features;
    var n = features.length;
    if (!n) {
      return { type: "FeatureCollection", features: [] };
    }
    var items = [];
    for (var i = 0; i < n; i++) {
      var eg = privateSchoolEnrollmentGradeSpan(features[i].properties);
      items.push({ index: i, total: eg.total });
    }
    items.sort(function (a, b) {
      if (a.total !== b.total) return a.total - b.total;
      return a.index - b.index;
    });
    var quintileByIndex = new Array(n);
    for (var j = 0; j < n; j++) {
      quintileByIndex[items[j].index] = Math.min(4, Math.floor((j * 5) / n));
    }
    var outFeatures = [];
    for (var k = 0; k < n; k++) {
      var f = features[k];
      var props = Object.assign({}, f.properties || {}, {
        _pe_quintile: quintileByIndex[k],
      });
      outFeatures.push({
        type: "Feature",
        geometry: f.geometry,
        properties: props,
      });
    }
    return { type: "FeatureCollection", features: outFeatures };
  }

  function charterEnrollmentTotalForQuintile(msid) {
    var m = masterRow(msid);
    if (!m) return 0;
    function num(key) {
      var raw = m[key];
      if (raw === "" || raw == null) return NaN;
      var v = Number(raw);
      return isNaN(v) ? NaN : v;
    }
    var keys = [
      "sy2526_actual",
      "enrollment_2025",
      "enrollment_2024",
      "enrollment_2023",
      "enrollment_2022",
      "enrollment_2021",
      "enrollment_2020",
      "enrollment_2019",
      "enrollment_2018",
      "enrollment_2017",
    ];
    for (var i = 0; i < keys.length; i++) {
      var v = num(keys[i]);
      if (isFinite(v) && v > 0) return v;
    }
    return 0;
  }

  /**
   * Equal-count quintiles from school_master enrollment (2025-26 actual when present, else latest calendar column).
   */
  function enrichCharterFcWithEnrollmentQuintiles(fc) {
    if (!fc || fc.type !== "FeatureCollection" || !fc.features) {
      return { type: "FeatureCollection", features: [] };
    }
    var features = fc.features;
    var n = features.length;
    if (!n) {
      return { type: "FeatureCollection", features: [] };
    }
    var items = [];
    for (var i = 0; i < n; i++) {
      var p = features[i].properties || {};
      var msid = p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : NaN;
      var total = !isNaN(msid) ? charterEnrollmentTotalForQuintile(msid) : 0;
      items.push({ index: i, total: total });
    }
    items.sort(function (a, b) {
      if (a.total !== b.total) return a.total - b.total;
      return a.index - b.index;
    });
    var quintileByIndex = new Array(n);
    for (var j = 0; j < n; j++) {
      quintileByIndex[items[j].index] = Math.min(4, Math.floor((j * 5) / n));
    }
    var outFeatures = [];
    for (var k = 0; k < n; k++) {
      var f = features[k];
      var props = Object.assign({}, f.properties || {}, {
        _pe_quintile: quintileByIndex[k],
      });
      outFeatures.push({
        type: "Feature",
        geometry: f.geometry,
        properties: props,
      });
    }
    return { type: "FeatureCollection", features: outFeatures };
  }

  /** Adds a `_mapLabel` short-name property to each feature for the map label
   *  symbol layers. `nameFn(props)` returns the school's short display name. */
  function annotateMapLabels(fc, nameFn) {
    if (!fc || !fc.features) return fc;
    fc.features.forEach(function (ft) {
      if (!ft || !ft.properties) return;
      try {
        ft.properties._mapLabel = nameFn(ft.properties) || "";
      } catch (e) {
        ft.properties._mapLabel = "";
      }
    });
    return fc;
  }

  function prepareCharterSchoolsMapFc(rawFc) {
    return annotateMapLabels(
      enrichCharterFcWithEnrollmentQuintiles(
        rawFc || { type: "FeatureCollection", features: [] }
      ),
      function (p) {
        return schoolShortNameFromProps(p);
      }
    );
  }

  function preparePrivateSchoolsMapFc(rawFc) {
    return annotateMapLabels(
      enrichPrivateSchoolFcWithEnrollmentQuintiles(
        filterZeroEnrollmentPrivateSchoolsFc(rawFc)
      ),
      function (p) {
        var rawName = p && p.School_Nam != null ? String(p.School_Nam) : "";
        if (!rawName) return "";
        return shortenSchoolDisplayName(
          formatSchoolDisplayName(
            standardCapitalization(expandElemSchoolName(rawName))
          )
        );
      }
    );
  }

  function formatPrivateSchoolZipFive(zipRaw) {
    if (zipRaw == null) return "";
    var d = String(zipRaw).replace(/\D/g, "");
    return d.length >= 5 ? d.slice(0, 5) : d;
  }

  /** Street, City, FL ZIP (ZIP trimmed to five digits). */
  function privateSchoolAddressLine(props) {
    if (!props) return "";
    var streetRaw = props.Address_1 != null ? String(props.Address_1).trim() : "";
    var cityRaw = props.City != null ? String(props.City).trim() : "";
    var zip5 = formatPrivateSchoolZipFive(props.Zip);
    var street = streetRaw ? standardCapitalization(streetRaw) : "";
    var city = cityRaw ? standardCapitalization(expandWestMelbourneCity(cityRaw)) : "";
    var parts = [];
    if (street) parts.push(street);
    if (city) parts.push(city);
    var head = parts.join(", ");
    if (!head) return zip5 ? "FL " + zip5 : "";
    return head + ", FL" + (zip5 ? " " + zip5 : "");
  }

  function privateSchoolDetailHtml(p) {
    var rawName = p && p.School_Nam != null ? String(p.School_Nam) : "";
    var name = formatSchoolDisplayName(
      standardCapitalization(expandElemSchoolName(rawName))
    );
    var eg = privateSchoolEnrollmentGradeSpan(p);
    var parts = [
      '<strong class="popup-school-name">' + escapeHtml(name) + "</strong>",
      '<div class="popup-detail">Grades Served: ' +
        escapeHtml(eg.gradesLabel || "—") +
        "</div>",
      '<div class="popup-detail">Total Enrollment: ' +
        escapeHtml(String(eg.total.toLocaleString())) +
        "</div>",
    ];
    var addr = privateSchoolAddressLine(p);
    if (addr) {
      parts.push('<div class="popup-detail">' + escapeHtml(addr) + "</div>");
    }
    return parts.join("");
  }

  /** Charter location dots: name + grades (student-hex attendance span) + enrollment + address from master CSV. */
  function charterSchoolDetailHtml(p) {
    var sid = p && p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : NaN;
    var name = schoolDisplayNameFromProps(p) || "Charter school";
    var m = !isNaN(sid) ? masterRow(sid) : null;
    var sk = !isNaN(sid) ? String(sid) : "";
    var skPad = !isNaN(sid) ? String(sid).padStart(4, "0") : "";
    var hexGrades =
      CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID && sk
        ? CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID[sk] ||
          CHARTER_ATTENDANCE_GRADES_LABEL_BY_MSID[skPad]
        : null;
    var gradesRaw = m && m.grades_served != null ? String(m.grades_served).trim() : "";
    var gradesUi = normalizeGradesServedForUi(gradesRaw);
    var gradesLabel = hexGrades || gradesUi || "—";
    var total = !isNaN(sid) ? charterEnrollmentTotalForQuintile(sid) : 0;
    var totalStr = total > 0 ? String(total.toLocaleString()) : "—";
    var parts = [
      '<strong class="popup-school-name">' + escapeHtml(name) + "</strong>",
      '<div class="popup-detail">Grades Served: ' + escapeHtml(gradesLabel) + "</div>",
      '<div class="popup-detail">Total Enrollment: ' + escapeHtml(totalStr) + "</div>",
    ];
    if (m) {
      var streetRaw = m.address != null ? String(m.address).trim() : "";
      var cszRaw = m.city_state_zip != null ? String(m.city_state_zip).trim() : "";
      var addrBits = [];
      if (streetRaw) addrBits.push(standardCapitalization(streetRaw));
      if (cszRaw) addrBits.push(formatCityStateZip(cszRaw));
      var addrCombined = addrBits.join(", ");
      if (addrCombined) {
        parts.push('<div class="popup-detail">' + escapeHtml(addrCombined) + "</div>");
      }
    }
    return parts.join("");
  }

  function schoolDetailHtml(p) {
    var name = schoolDisplayNameFromProps(p);
    var sid = p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : NaN;
    var mRow = !isNaN(sid) ? masterRow(sid) : null;
    var grades = normalizeGradesServedForUi(
      (mRow && mRow.grades_served) || p.Grades || ""
    );
    var addr = p.ADDRESS || "";
    var city = p.CITY_ST_ZI || "";
    var parts = [
      '<strong class="popup-school-name">' + escapeHtml(name) + "</strong>",
    ];
    if (grades) {
      parts.push(
        '<div class="popup-detail">Grades: ' +
          escapeHtml(standardCapitalization(grades)) +
          "</div>"
      );
    }
    if (addr) {
      parts.push(
        '<div class="popup-detail">' +
          escapeHtml(standardCapitalization(addr)) +
          "</div>"
      );
    }
    if (city) {
      parts.push(
        '<div class="popup-detail">' +
          escapeHtml(formatCityStateZip(city)) +
          "</div>"
      );
    }
    return parts.join("");
  }

  function scenarioMiddleShortDisplayName(msid) {
    if (msid == null || isNaN(msid)) return null;
    var sh = SCENARIO_MIDDLE_SHORT_NAME[msid];
    return sh != null ? sh : null;
  }

  function schoolNameForSelect(p) {
    return schoolDisplayNameFromProps(p);
  }

  /** Fills #school-select; option values are SCHOOLS_ID (district MSID). */
  function populateSchoolSelect(schoolsFc) {
    var sel = document.getElementById("school-select");
    if (!sel || !schoolsFc || !schoolsFc.features) return;

    sel.innerHTML = "";

    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a school";
    sel.appendChild(placeholder);

    var schools = schoolsFc.features
      .map(function (ft) {
        return ft.properties;
      })
      .filter(function (p) {
        return p && p.SCHOOLS_ID != null;
      })
      .sort(function (a, b) {
        var na = schoolDisplayNameFromProps(a).toLowerCase();
        var nb = schoolDisplayNameFromProps(b).toLowerCase();
        if (na < nb) return -1;
        if (na > nb) return 1;
        return 0;
      });

    schools.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = String(p.SCHOOLS_ID);
      opt.textContent = schoolNameForSelect(p);
      sel.appendChild(opt);
    });

    sel.value = "";
    sel.disabled = false;

    var sbox = document.getElementById("sandbox-base-school");
    if (sbox) {
      sbox.innerHTML = sel.innerHTML;
      if (sbox.options[0]) {
        sbox.options[0].textContent = "Start from school (optional)…";
      }
      sbox.value = "";
      sbox.disabled = false;
    }
  }

  function findBoundaryFeatureForMsid(msid) {
    var layers = [GEO_CACHE.es, GEO_CACHE.ms, GEO_CACHE.hs];
    for (var i = 0; i < layers.length; i++) {
      var fc = layers[i];
      if (!fc || !fc.features) continue;
      for (var j = 0; j < fc.features.length; j++) {
        var f = fc.features[j];
        var m =
          f.properties && f.properties.MSID != null
            ? Number(f.properties.MSID)
            : null;
        if (m === msid) return f;
      }
    }
    return null;
  }

  /** Map source id (e.g. "es-boundaries") for the assignment polygon containing this MSID, or null. */
  function findBoundarySourceForMsid(msid) {
    var layers = [
      { fc: GEO_CACHE.es, src: "es-boundaries" },
      { fc: GEO_CACHE.ms, src: "ms-boundaries" },
      { fc: GEO_CACHE.hs, src: "hs-boundaries" },
    ];
    for (var i = 0; i < layers.length; i++) {
      var fc = layers[i].fc;
      if (!fc || !fc.features) continue;
      for (var j = 0; j < fc.features.length; j++) {
        var f = fc.features[j];
        var pr = f.properties || {};
        var m =
          pr.MSID != null
            ? Number(pr.MSID)
            : pr.SCHOOLS_ID != null
              ? Number(pr.SCHOOLS_ID)
              : null;
        if (m === msid) return layers[i].src;
      }
    }
    return null;
  }

  /**
   * Assignment MSIDs from elementary / middle / high boundary layers at a residence point
   * (same attendance-area polygons as capture KPIs and `countHomeschoolStudentsInAssignmentBoundary`).
   * @returns {{ elem: number|null, mid: number|null, high: number|null }}
   */
  function attendanceZoningTripletAtLngLat(lng, lat) {
    var out = { elem: null, mid: null, high: null };
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.point !== "function" ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return out;
    }
    var pt;
    try {
      pt = turf.point([lng, lat]);
    } catch (ePt) {
      return out;
    }
    function msidFromBoundaryFc(fc) {
      if (!fc || !fc.features) {
        return null;
      }
      for (var i = 0; i < fc.features.length; i++) {
        var f = fc.features[i];
        if (!f || !f.geometry) {
          continue;
        }
        try {
          var poly = turf.feature(f.geometry);
          if (turf.booleanPointInPolygon(pt, poly)) {
            var m =
              f.properties && f.properties.MSID != null ? Number(f.properties.MSID) : NaN;
            if (!isNaN(m) && m > 0) {
              return Math.round(m);
            }
          }
        } catch (eIn) {
          /* ignore */
        }
      }
      return null;
    }
    out.elem = msidFromBoundaryFc(GEO_CACHE.es);
    out.mid = msidFromBoundaryFc(GEO_CACHE.ms);
    out.high = msidFromBoundaryFc(GEO_CACHE.hs);
    return out;
  }

  /**
   * Zoning triplet for a homeschool hex: centroid of hex geometry vs es/ms/hs assignment layers.
   */
  function homeschoolAttendanceZoningTripletForHex(hexKey, feature) {
    var out = { elem: null, mid: null, high: null };
    var geom =
      feature &&
      feature.geometry &&
      (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon")
        ? feature.geometry
        : homeschoolHexGeometry(hexKey);
    if (!geom) {
      return out;
    }
    var ctr = polygonCentroid(geom);
    if (!ctr || ctr.length < 2) {
      return out;
    }
    return attendanceZoningTripletAtLngLat(ctr[0], ctr[1]);
  }

  function boundaryFillVisibleForSource(src) {
    var fillId =
      src === "es-boundaries"
        ? "es-fill"
        : src === "ms-boundaries"
          ? "ms-fill"
          : src === "hs-boundaries"
            ? "hs-fill"
            : null;
    if (!fillId) return false;
    try {
      return map.getLayoutProperty(fillId, "visibility") !== "none";
    } catch (e) {
      return false;
    }
  }

  function clearSelectedAssignmentBoundary() {
    if (selectedAssignmentBoundary != null) {
      try {
        map.setFeatureState(
          {
            source: selectedAssignmentBoundary.source,
            id: selectedAssignmentBoundary.id,
          },
          { selectedAssignment: false }
        );
      } catch (e) {
        /* ignore */
      }
      selectedAssignmentBoundary = null;
    }
  }

  function applySelectedAssignmentBoundary(msid) {
    clearSelectedAssignmentBoundary();
    if (msid == null || isNaN(msid)) return;
    var src = findBoundarySourceForMsid(msid);
    if (!src) return;
    if (!boundaryFillVisibleForSource(src)) return;
    selectedAssignmentBoundary = { source: src, id: msid };
    try {
      map.setFeatureState({ source: src, id: msid }, { selectedAssignment: true });
    } catch (e) {
      /* ignore */
    }
  }

  function refreshAssignmentBoundaryHighlight() {
    if (selectedSchoolMsid == null) return;
    applySelectedAssignmentBoundary(selectedSchoolMsid);
  }

  function schoolPointLonLatForMsid(msid, schoolByMsid) {
    var p = schoolByMsid[msid];
    var lon;
    var lat;
    if (p && p.Longitude != null && p.Latitude != null) {
      lon = Number(p.Longitude);
      lat = Number(p.Latitude);
    } else if (GEO_CACHE.schools && GEO_CACHE.schools.features) {
      for (var i = 0; i < GEO_CACHE.schools.features.length; i++) {
        var ft = GEO_CACHE.schools.features[i];
        if (
          ft.properties &&
          Number(ft.properties.SCHOOLS_ID) === msid &&
          ft.geometry &&
          ft.geometry.coordinates
        ) {
          lon = ft.geometry.coordinates[0];
          lat = ft.geometry.coordinates[1];
          break;
        }
      }
    }
    if (lon == null || lat == null || isNaN(lon) || isNaN(lat)) {
      return null;
    }
    return [lon, lat];
  }

  /** Pans the map so the school location is centered; zoom level is unchanged. */
  function centerMapOnSchoolPoint(msid, schoolByMsid) {
    if (!map) return;
    var c = schoolPointLonLatForMsid(msid, schoolByMsid);
    if (!c) {
      zoomToSchoolAssignment(msid, schoolByMsid);
      return;
    }
    try {
      map.easeTo({
        center: c,
        duration: 750,
        essential: true,
      });
    } catch (e) {
      /* ignore */
    }
  }

  function zoomToSchoolAssignment(msid, schoolByMsid) {
    var boundaryFt = findBoundaryFeatureForMsid(msid);
    var bbox;
    if (boundaryFt) {
      bbox = computeBbox({
        type: "FeatureCollection",
        features: [boundaryFt],
      });
    } else {
      var c2 = schoolPointLonLatForMsid(msid, schoolByMsid);
      if (!c2) return;
      var lon = c2[0];
      var lat = c2[1];
      var d = 0.03;
      bbox = [lon - d, lat - d, lon + d, lat + d];
    }
    if (bbox) {
      map.fitBounds(bbox, {
        padding: schoolZoomFitPadding(),
        maxZoom: 15,
        duration: 750,
      });
    }
  }

  /**
   * Padding for the school auto-zoom fitBounds. Base padding is 56px all around.
   * When the Map Layers menu is OPEN (not collapsed), reserve extra padding on
   * the right equal to the menu's footprint so the assignment boundary is
   * centered in the visible area between the left edge of the map and the left
   * edge of the menu (instead of being centered under the menu).
   */
  function schoolZoomFitPadding() {
    var pad = { top: 56, bottom: 56, left: 56, right: 56 };
    try {
      var toolbar = document.getElementById("toolbar");
      if (toolbar && !toolbar.classList.contains("toolbar--collapsed")) {
        var rect = toolbar.getBoundingClientRect();
        if (rect && rect.width > 0) {
          /* Menu sits 12px from the map's right edge; add a 12px buffer so the
             boundary doesn't crowd the menu's left edge. */
          pad.right = Math.round(rect.width) + 24;
        }
      }
    } catch (ep) {
      /* ignore — fall back to symmetric padding */
    }
    return pad;
  }

  function clearSelectedSchoolHighlight() {
    clearSelectedAssignmentBoundary();
    if (selectedSchoolMsid != null) {
      try {
        map.setFeatureState(
          { source: "schools", id: selectedSchoolMsid },
          { selected: false }
        );
      } catch (e) {
        /* ignore */
      }
      selectedSchoolMsid = null;
    }
  }

  function applySelectedSchoolHighlight(msid) {
    clearSelectedSchoolHighlight();
    if (msid == null) return;
    selectedSchoolMsid = msid;
    try {
      map.setFeatureState({ source: "schools", id: msid }, { selected: true });
    } catch (e) {
      /* ignore */
    }
    applySelectedAssignmentBoundary(msid);
  }

  /** True iff the consolidated Scenario Planning page is open AND the Scenario sub-tab is active. */
  function isScenarioPlanningViewActive() {
    var panel = document.getElementById("page-scenario");
    if (!panel || panel.hidden) return false;
    var subScenario = document.getElementById("scenario-subpanel-scenario");
    if (!subScenario) return true; /* if sub-tabs not yet wired, treat as active */
    return !subScenario.hidden;
  }

  function clearScenarioBoundaryRelevantFeatureStates() {
    if (!map) return;
    for (var i = 0; i < lastScenarioBoundaryRelevant.length; i++) {
      var b = lastScenarioBoundaryRelevant[i];
      if (!b || b.source == null || b.id == null) continue;
      try {
        map.setFeatureState(
          { source: b.source, id: b.id },
          { scenarioRelevant: false }
        );
      } catch (e) {
        /* ignore */
      }
    }
    lastScenarioBoundaryRelevant = [];
  }

  /**
   * - Scenario: fill for `highlight`, `selectedAssignment`, or `scenarioRelevant` (feeder + middle), else 0.
   * - Existing: fill only for `highlight` (hover) or `selectedAssignment` (dropdown), else 0.
   * - Boundary Sandbox: same as Existing (hover + selected assignment), not full-opacity on all zones.
   */
  function getAssignmentFillOpacityPaintValue() {
    if (isBoundarySandboxViewActive()) {
      return [
        "case",
        ["==", ["feature-state", "highlight"], true],
        BOUNDARY_FILL_OPACITY,
        ["==", ["feature-state", "selectedAssignment"], true],
        BOUNDARY_FILL_OPACITY,
        0,
      ];
    }
    if (isScenarioPlanningViewActive()) {
      return [
        "case",
        ["==", ["feature-state", "highlight"], true],
        BOUNDARY_FILL_OPACITY,
        ["==", ["feature-state", "selectedAssignment"], true],
        BOUNDARY_FILL_OPACITY,
        ["==", ["feature-state", "scenarioRelevant"], true],
        BOUNDARY_FILL_OPACITY,
        0,
      ];
    }
    return [
      "case",
      ["==", ["feature-state", "highlight"], true],
      BOUNDARY_FILL_OPACITY,
      ["==", ["feature-state", "selectedAssignment"], true],
      BOUNDARY_FILL_OPACITY,
      0,
    ];
  }

  function syncAssignmentFillPaintForView() {
    if (!map || !map.getLayer) {
      return;
    }
    var v = getAssignmentFillOpacityPaintValue();
    var lids = ["es-fill", "ms-fill", "hs-fill"];
    for (var l = 0; l < lids.length; l++) {
      if (!map.getLayer(lids[l])) continue;
      try {
        map.setPaintProperty(lids[l], "fill-opacity", v);
      } catch (e) {
        /* ignore */
      }
    }
  }

  /**
   * Marks the selected middle MS zone + checked feeder elementary zones. Other assignment fills stay at 0
   * in Scenario (see `getAssignmentFillOpacityPaintValue`) until hover `highlight` repopulates fill.
   */
  function applyScenarioBoundaryRelevantFeatureStates() {
    clearScenarioBoundaryRelevantFeatureStates();
    if (!map || !isScenarioPlanningViewActive()) {
      return;
    }
    if (
      scenarioMiddleMsid == null ||
      isNaN(scenarioMiddleMsid) ||
      !scenarioSchoolByMsid
    ) {
      return;
    }
    var sch = scenarioSchoolByMsid;
    var pushB = function (source, id) {
      if (id == null || isNaN(id)) return;
      lastScenarioBoundaryRelevant.push({ source: source, id: id });
      try {
        map.setFeatureState({ source: source, id: id }, { scenarioRelevant: true });
      } catch (e) {
        /* ignore */
      }
    };
    var destP = sch[Number(scenarioMiddleMsid)];
    var destSrc = findBoundarySourceForMsid(Number(scenarioMiddleMsid));
    if (destSrc) {
      pushB(destSrc, Number(scenarioMiddleMsid));
    } else if (destP) {
      pushB(scenarioDestinationBoundarySource(destP), Number(scenarioMiddleMsid));
    }
    for (var key in scenarioFeederChecked) {
      if (!Object.prototype.hasOwnProperty.call(scenarioFeederChecked, key)) {
        continue;
      }
      if (scenarioFeederChecked[key] === false) {
        continue;
      }
      var n = Number(key);
      if (isNaN(n) || n === Number(scenarioMiddleMsid)) continue;
      var src = findBoundarySourceForMsid(n);
      if (src) pushB(src, n);
    }
  }

  function applyScenarioFeederMapHighlights() {
    for (var i = 0; i < lastScenarioFeederHighlightMsids.length; i++) {
      try {
        map.setFeatureState(
          { source: "schools", id: lastScenarioFeederHighlightMsids[i] },
          { scenarioFeeder: false }
        );
      } catch (e) {
        /* ignore */
      }
    }
    lastScenarioFeederHighlightMsids = [];
    if (!isScenarioPlanningViewActive()) {
      clearScenarioBoundaryRelevantFeatureStates();
      syncAssignmentFillPaintForView();
      return;
    }
    if (
      scenarioMiddleMsid == null ||
      isNaN(scenarioMiddleMsid) ||
      !scenarioSchoolByMsid
    ) {
      clearScenarioBoundaryRelevantFeatureStates();
      syncAssignmentFillPaintForView();
      return;
    }
    var sch = scenarioSchoolByMsid;
    for (var key in scenarioFeederChecked) {
      if (!Object.prototype.hasOwnProperty.call(scenarioFeederChecked, key)) {
        continue;
      }
      if (scenarioFeederChecked[key] === false) continue;
      var n = Number(key);
      if (isNaN(n) || n === Number(scenarioMiddleMsid)) continue;
      try {
        map.setFeatureState(
          { source: "schools", id: n },
          { scenarioFeeder: true }
        );
        lastScenarioFeederHighlightMsids.push(n);
      } catch (e2) {
        /* ignore */
      }
    }
    applyScenarioBoundaryRelevantFeatureStates();
    syncAssignmentFillPaintForView();
  }

  function escapeXmlText(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Aligns with export_facility_age_from_xls.ps1 Get-NameKey (source has no MSID). */
  function normalizeSchoolNameKey(str) {
    if (!str) return "";
    return String(str)
      .toUpperCase()
      .replace(/\//g, " ")
      .replace(/[.'’]/g, " ")
      .replace(/,/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function schoolPaletteKeyFromType(typeStr) {
    var t = (typeStr || "").toUpperCase();
    if (t.indexOf("ELEMENTARY") >= 0) return "elementary";
    if (t.indexOf("MIDDLE") >= 0) return "middle";
    if (t === "JR SR HIGH" || t.indexOf("HIGH") >= 0) return "high";
    return "middle";
  }

  function schoolTypeIsHigh(typeStr) {
    var t = (typeStr || "").toUpperCase();
    return t === "JR SR HIGH" || t.indexOf("HIGH") >= 0;
  }

  function schoolTypeIsElemOrMiddle(typeStr) {
    var t = (typeStr || "").toUpperCase();
    if (t.indexOf("ELEMENTARY") >= 0) return true;
    if (t.indexOf("MIDDLE") >= 0 && t.indexOf("HIGH") < 0) return true;
    return false;
  }

  /**
   * Match Sankey workbook labels (short names in the helper spreadsheet) to GeoJSON.
   * Uses compact CommonName equality and leading NAME tokens — not naive substring match —
   * so "Cocoa" does not match "Cocoa Beach" (both NAMEs start with COCOA).
   */
  function sankeyWorkbookLabelMatchesSchool(label, p) {
    var L = normalizeSchoolNameKey(label || "");
    if (!L) return false;

    var cn = normalizeSchoolNameKey(p.CommonName || "");
    var nm = normalizeSchoolNameKey(p.NAME || "");

    var Lc = L.replace(/\s+/g, "");
    var cnc = cn.replace(/\s+/g, "");
    if (cnc && Lc === cnc) return true;
    if (cn && L === cn) return true;

    var lTok = L.split(" ").filter(Boolean);
    var nmTok = nm.split(" ").filter(Boolean);
    if (!lTok.length || !nmTok.length || lTok.length > nmTok.length) return false;

    for (var ti = 0; ti < lTok.length; ti++) {
      if (lTok[ti] !== nmTok[ti]) return false;
    }

    if (lTok.length === 1 && nmTok.length >= 2) {
      if (lTok[0] === "COCOA" && nmTok[1] === "BEACH") return false;
    }

    return true;
  }

  /** Match Sankey workbook row/column labels (short names) to GeoJSON NAME/CommonName. */
  function sankeyElementaryLabelMatchesSchool(label, p) {
    var L = normalizeSchoolNameKey(label);
    var cn = normalizeSchoolNameKey(p.CommonName || "");
    var nm = normalizeSchoolNameKey(p.NAME || "");
    if (!L) return false;
    if (cn && L === cn) return true;
    if (nm.indexOf(L) !== -1) return true;
    var parts = nm.split(" ").filter(Boolean);
    if (parts.length && L === parts[0]) return true;
    var LnoElem = L.replace(/\s+ELEM$/, "");
    if (LnoElem.length >= 3 && nm.indexOf(LnoElem) !== -1) return true;
    return false;
  }

  function sankeyMiddleLabelMatchesSchool(label, p) {
    return sankeyWorkbookLabelMatchesSchool(label, p);
  }

  /**
   * @returns {{ elementary: string, middle: string, value: number, emphasis: boolean }[]}
   *   emphasis = flow is a primary focus for the selection (all ES→MS links when ES selected;
   *   ES→selected-MS when middle selected; other MS destinations from same feeders are emphasis:false).
   *   For Jr/Sr (7–12): ES→MS flows that share feeder elementaries with middle schools that feed this high
   *   (grades 6→7 transition); emphasis on links into those feeder middles.
   */
  function filterEsMsFlowsForSchool(flows, p) {
    if (!flows || !flows.length || !p) return [];
    var t = (p.TYPE || "").toUpperCase();
    if (t.indexOf("ELEMENTARY") >= 0) {
      return flows
        .filter(function (f) {
          return sankeyElementaryLabelMatchesSchool(f.elementary, p);
        })
        .map(function (f) {
          return {
            elementary: f.elementary,
            middle: f.middle,
            value: f.value,
            emphasis: true,
          };
        });
    }
    if (t.indexOf("MIDDLE") >= 0 && t.indexOf("HIGH") < 0) {
      var intoSelected = flows.filter(function (f) {
        return sankeyMiddleLabelMatchesSchool(f.middle, p);
      });
      if (!intoSelected.length) return [];
      var feederEs = {};
      intoSelected.forEach(function (f) {
        feederEs[f.elementary] = true;
      });
      return flows
        .filter(function (f) {
          return feederEs[f.elementary];
        })
        .map(function (f) {
          return {
            elementary: f.elementary,
            middle: f.middle,
            value: f.value,
            emphasis: sankeyMiddleLabelMatchesSchool(f.middle, p),
          };
        });
    }
    if (t === "JR SR HIGH" && SANKEY_CACHE && SANKEY_CACHE.msHsFlows) {
      var msHs = SANKEY_CACHE.msHsFlows;
      var intoJrSr = msHs.filter(function (hf) {
        return sankeyHighLabelMatchesSchool(hf.high, p);
      });
      if (!intoJrSr.length) return [];
      var feederMiddles = {};
      intoJrSr.forEach(function (hf) {
        feederMiddles[hf.middle] = true;
      });
      var feederEs = {};
      flows.forEach(function (f) {
        if (feederMiddles[f.middle]) feederEs[f.elementary] = true;
      });
      return flows
        .filter(function (f) {
          return feederEs[f.elementary];
        })
        .map(function (f) {
          return {
            elementary: f.elementary,
            middle: f.middle,
            value: f.value,
            emphasis: !!feederMiddles[f.middle],
          };
        });
    }
    return [];
  }

  function sankeyHighLabelMatchesSchool(label, p) {
    return sankeyWorkbookLabelMatchesSchool(label, p);
  }

  /**
   * @returns {{ middle: string, high: string, value: number, emphasis: boolean }[]}
   */
  function filterMsHsFlowsForSchool(flows, p) {
    if (!flows || !flows.length || !p) return [];
    var t = (p.TYPE || "").toUpperCase();
    if (t.indexOf("ELEMENTARY") >= 0) return [];
    if (t.indexOf("MIDDLE") >= 0 && t.indexOf("HIGH") < 0) {
      return flows
        .filter(function (f) {
          return sankeyMiddleLabelMatchesSchool(f.middle, p);
        })
        .map(function (f) {
          return {
            middle: f.middle,
            high: f.high,
            value: f.value,
            emphasis: true,
          };
        });
    }
    if (t === "JR SR HIGH" || t.indexOf("HIGH") >= 0) {
      return flows
        .filter(function (f) {
          return sankeyHighLabelMatchesSchool(f.high, p);
        })
        .map(function (f) {
          return {
            middle: f.middle,
            high: f.high,
            value: f.value,
            emphasis: true,
          };
        });
    }
    return [];
  }

  function findSchoolPropsForSankeyWorkbookLabel(label, schoolsFc, useMiddleMatcher) {
    if (!label || !schoolsFc || !schoolsFc.features) return null;
    var matchFn = useMiddleMatcher
      ? sankeyMiddleLabelMatchesSchool
      : sankeyHighLabelMatchesSchool;
    for (var i = 0; i < schoolsFc.features.length; i++) {
      var p = schoolsFc.features[i].properties;
      if (matchFn(label, p)) return p;
    }
    return null;
  }

  /** Middle → high Sankey: 7–12 / Jr–Sr nodes use orange; 9–12 high and middle use blue/purple. */
  function msHsSankeyNodeFill(name, isLeft) {
    var fc = GEO_CACHE.schools;
    var p = findSchoolPropsForSankeyWorkbookLabel(name, fc, isLeft);
    p = schoolPropsWithMasterType(p);
    if (p && (p.TYPE || "").toUpperCase() === "JR SR HIGH") {
      return PALETTE.jrSr.fill;
    }
    return isLeft ? PALETTE.middle.fill : PALETTE.high.fill;
  }

  /**
   * @param {{ from: string, to: string, value: number, emphasis: boolean }[]} normFlows
   * @param {{ leftFill: string, rightFill: string, emphStroke: string, ariaLabel: string, secondaryTooltip: string, leftNodeFill?: function(string): string, rightNodeFill?: function(string): string }} cfg
   */
  function renderBipartiteSankey(root, normFlows, cfg) {
    if (!normFlows.length) {
      root.innerHTML =
        '<p class="sankey-empty">No matching matriculation flows for this school selection.</p>';
      return;
    }
    if (typeof d3 === "undefined" || !d3.sankey || !d3.sankeyLinkHorizontal) {
      root.innerHTML =
        '<p class="sankey-empty">Sankey layout library failed to load.</p>';
      return;
    }

    /* Tighter horizontal flow band + side padding keeps viewBox width modest so SVG scales up larger in the sidebar. */
    var padL = 138;
    var padR = 138;
    var padY = 12;
    var cw = root.clientWidth || 400;
    var graphW = Math.max(96, Math.min(268, cw - 4));
    var totalW = padL + graphW + padR;

    var leftSet = {};
    var rightSet = {};
    normFlows.forEach(function (f) {
      leftSet[f.from] = true;
      rightSet[f.to] = true;
    });
    var leftList = Object.keys(leftSet);
    var rightList = Object.keys(rightSet);
    var h = Math.max(
      320,
      Math.min(580, leftList.length * 40 + rightList.length * 48 + 110)
    );
    var nodes = leftList
      .map(function (name) {
        return { name: name };
      })
      .concat(
        rightList.map(function (name) {
          return { name: name };
        })
      );
    var indexByLeft = {};
    var indexByRight = {};
    leftList.forEach(function (n, i) {
      indexByLeft[n] = i;
    });
    rightList.forEach(function (n, i) {
      indexByRight[n] = i + leftList.length;
    });
    var originTotal = {};
    var destTotal = {};
    normFlows.forEach(function (f) {
      originTotal[f.from] = (originTotal[f.from] || 0) + f.value;
      destTotal[f.to] = (destTotal[f.to] || 0) + f.value;
    });

    var emphasisByPair = {};
    normFlows.forEach(function (f) {
      emphasisByPair[f.from + "\u0000" + f.to] = f.emphasis !== false;
    });
    var links = normFlows.map(function (f) {
      return {
        source: indexByLeft[f.from],
        target: indexByRight[f.to],
        value: f.value,
      };
    });

    var sankeyLayout = d3
      .sankey()
      .nodeWidth(10)
      .nodePadding(8)
      .extent([
        [padL + 6, padY],
        [padL + graphW - 6, h - padY],
      ]);

    var graph = sankeyLayout({
      nodes: nodes.map(function (d) {
        return Object.assign({}, d);
      }),
      links: links.map(function (d) {
        return Object.assign({}, d);
      }),
    });

    var linkPath = d3.sankeyLinkHorizontal();
    var svgNs = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("viewBox", "0 0 " + totalW + " " + h);
    svg.setAttribute("width", "100%");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("class", "sankey-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", cfg.ariaLabel);

    var gLinks = document.createElementNS(svgNs, "g");
    gLinks.setAttribute("fill", "none");
    graph.links.forEach(function (d) {
      var path = document.createElementNS(svgNs, "path");
      path.setAttribute("d", linkPath(d));
      var srcN =
        d.source && d.source.name != null
          ? String(d.source.name)
          : "";
      var tgtN =
        d.target && d.target.name != null
          ? String(d.target.name)
          : "";
      var emph =
        emphasisByPair[srcN + "\u0000" + tgtN] !== false;
      path.setAttribute("stroke", emph ? cfg.emphStroke : "#94a3b8");
      path.setAttribute("stroke-opacity", emph ? "0.55" : "0.32");
      path.setAttribute(
        "class",
        "sankey-link" +
          (emph ? " sankey-link--emphasis" : " sankey-link--secondary")
      );
      var sw = d.width != null && !isNaN(Number(d.width)) ? Number(d.width) : 2;
      path.setAttribute("stroke-width", Math.max(1, sw));
      path.setAttribute("pointer-events", "stroke");
      var nv =
        d.value != null && !isNaN(Number(d.value)) ? Number(d.value) : 0;
      var tip = document.createElementNS(svgNs, "title");
      var line =
        srcN +
        " → " +
        tgtN +
        ": " +
        nv.toLocaleString() +
        " students";
      if (!emph && cfg.secondaryTooltip) {
        line += " " + cfg.secondaryTooltip;
      }
      tip.textContent = line;
      path.appendChild(tip);
      gLinks.appendChild(path);
    });
    svg.appendChild(gLinks);

    function truncLabel(s, maxLen) {
      if (!s) return "";
      if (s.length <= maxLen) return s;
      return s.slice(0, maxLen - 1) + "\u2026";
    }

    var gNodes = document.createElementNS(svgNs, "g");
    graph.nodes.forEach(function (d, i) {
      var nm = String(d.name);
      var rect = document.createElementNS(svgNs, "rect");
      rect.setAttribute("x", d.x0);
      rect.setAttribute("y", d.y0);
      rect.setAttribute("width", Math.max(1, d.x1 - d.x0));
      rect.setAttribute("height", Math.max(1, d.y1 - d.y0));
      var isLeft = i < leftList.length;
      var nodeFill;
      if (isLeft) {
        nodeFill =
          typeof cfg.leftNodeFill === "function"
            ? cfg.leftNodeFill(nm)
            : cfg.leftFill;
      } else {
        nodeFill =
          typeof cfg.rightNodeFill === "function"
            ? cfg.rightNodeFill(nm)
            : cfg.rightFill;
      }
      rect.setAttribute("fill", nodeFill);
      rect.setAttribute("rx", "2");
      rect.setAttribute("class", "sankey-node");
      gNodes.appendChild(rect);
      var tot = isLeft ? originTotal[nm] : destTotal[nm];
      var totStr =
        tot != null && !isNaN(Number(tot))
          ? Number(tot).toLocaleString()
          : "";
      var text = document.createElementNS(svgNs, "text");
      var tx = isLeft ? d.x0 - 8 : d.x1 + 8;
      var cy = (d.y0 + d.y1) / 2;
      text.setAttribute("x", tx);
      text.setAttribute("y", cy);
      text.setAttribute("class", "sankey-label");
      text.setAttribute("text-anchor", isLeft ? "end" : "start");
      var nameLine = truncLabel(nm, 22);
      var tName = document.createElementNS(svgNs, "tspan");
      tName.setAttribute("class", "sankey-label-name");
      tName.setAttribute("x", tx);
      tName.setAttribute("dy", "-0.5em");
      tName.textContent = nameLine;
      text.appendChild(tName);
      if (totStr) {
        var tTot = document.createElementNS(svgNs, "tspan");
        tTot.setAttribute("class", "sankey-label-total");
        tTot.setAttribute("x", tx);
        tTot.setAttribute("dy", "1.22em");
        tTot.textContent =
          (isLeft ? "Out: " : "In: ") + totStr;
        text.appendChild(tTot);
      }
      var tipFull = document.createElementNS(svgNs, "title");
      tipFull.textContent =
        nm +
        (totStr
          ? " — " + (isLeft ? "origin total" : "destination total") + ": " + totStr
          : "");
      text.appendChild(tipFull);
      gNodes.appendChild(text);
    });
    svg.appendChild(gNodes);

    root.innerHTML = "";
    root.appendChild(svg);
  }

  function renderEsMsChart(el, p) {
    if (!SANKEY_CACHE || !SANKEY_CACHE.flows) {
      el.innerHTML =
        '<p class="sankey-empty">Feeder flow data is not loaded.</p>';
      return;
    }
    var typeU = (p.TYPE || "").toUpperCase();
    if (!schoolTypeIsElemOrMiddle(p.TYPE) && typeU !== "JR SR HIGH") {
      el.innerHTML =
        '<p class="sankey-empty">No elementary–middle matrix for this school type.</p>';
      return;
    }
    var flows = filterEsMsFlowsForSchool(SANKEY_CACHE.flows, p);
    var norm = flows.map(function (f) {
      return {
        from: f.elementary,
        to: f.middle,
        value: f.value,
        emphasis: f.emphasis !== false,
      };
    });
    var selectedIsElem = typeU.indexOf("ELEMENTARY") >= 0;
    var emphStroke = selectedIsElem
      ? PALETTE.elementary.fill
      : PALETTE.middle.fill;
    renderBipartiteSankey(el, norm, {
      leftFill: PALETTE.elementary.fill,
      rightFill: PALETTE.middle.fill,
      emphStroke: emphStroke,
      ariaLabel:
        "Sankey diagram of student flows from elementary schools to middle schools",
      secondaryTooltip: "(other middle school destination)",
    });
  }

  function renderMsHsChart(el, p) {
    if (!SANKEY_CACHE || !SANKEY_CACHE.msHsFlows) {
      el.innerHTML =
        '<p class="sankey-empty">Middle–high feeder data is not loaded.</p>';
      return;
    }
    var t = (p.TYPE || "").toUpperCase();
    if (t.indexOf("ELEMENTARY") >= 0) {
      return;
    }
    var flows = filterMsHsFlowsForSchool(SANKEY_CACHE.msHsFlows, p);
    var norm = flows.map(function (f) {
      return {
        from: f.middle,
        to: f.high,
        value: f.value,
        emphasis: f.emphasis !== false,
      };
    });
    renderBipartiteSankey(el, norm, {
      leftFill: PALETTE.middle.fill,
      rightFill: PALETTE.high.fill,
      leftNodeFill: function (name) {
        return msHsSankeyNodeFill(name, true);
      },
      rightNodeFill: function (name) {
        return msHsSankeyNodeFill(name, false);
      },
      emphStroke: PALETTE.middle.fill,
      ariaLabel:
        "Sankey diagram of student flows from middle schools to high schools (grades 8 to 9 transition)",
      secondaryTooltip: "",
    });
  }

  function renderSankeyPanel(p) {
    var row = document.getElementById("sankey-row");
    var panel = document.getElementById("sankey-panel");
    var elEs = document.getElementById("sankey-es-ms");
    var elHs = document.getElementById("sankey-ms-hs");
    if (!elEs || !elHs || !row) return;

    function setSankeySplitLayout(isSplit) {
      if (panel) {
        if (isSplit) {
          panel.classList.add("sankey-panel--split");
        } else {
          panel.classList.remove("sankey-panel--split");
        }
      }
    }

    if (!SANKEY_CACHE) {
      var msg = '<p class="sankey-empty">Feeder flow data is not loaded.</p>';
      elEs.innerHTML = msg;
      elHs.innerHTML = msg;
      row.className = "sankey-row";
      setSankeySplitLayout(false);
      return;
    }

    if (!p) {
      elEs.innerHTML =
        '<p class="sankey-empty">Select a school to view feeder flows.</p>';
      elHs.innerHTML =
        '<p class="sankey-empty">Select a school to view feeder flows.</p>';
      row.className = "sankey-row";
      setSankeySplitLayout(false);
      return;
    }

    var t = (p.TYPE || "").toUpperCase();
    var isElem = t.indexOf("ELEMENTARY") >= 0;
    var isMid = t.indexOf("MIDDLE") >= 0 && t.indexOf("HIGH") < 0;
    var isHigh = schoolTypeIsHigh(p.TYPE);
    var isJrSr = t === "JR SR HIGH";

    row.className = "sankey-row";
    if (isMid || (isHigh && isJrSr)) {
      row.classList.add("sankey-row--split");
    } else if (isElem) {
      row.classList.add("sankey-row--es-only");
    } else if (isHigh) {
      row.classList.add("sankey-row--hs-only");
    }

    if (isElem) {
      setSankeySplitLayout(false);
      renderEsMsChart(elEs, p);
      elHs.innerHTML =
        '<p class="sankey-empty sankey-empty--muted">Middle → high transitions are not shown when an elementary school is selected.</p>';
    } else if (isHigh && isJrSr) {
      setSankeySplitLayout(true);
      renderEsMsChart(elEs, p);
      renderMsHsChart(elHs, p);
    } else if (isHigh) {
      setSankeySplitLayout(false);
      elEs.innerHTML =
        '<p class="sankey-empty sankey-empty--muted">Elementary → middle transitions are not shown when a high school is selected.</p>';
      renderMsHsChart(elHs, p);
    } else if (isMid) {
      setSankeySplitLayout(true);
      renderEsMsChart(elEs, p);
      renderMsHsChart(elHs, p);
    } else {
      elEs.innerHTML =
        '<p class="sankey-empty">No feeder matrix for this school type.</p>';
      elHs.innerHTML = "";
      row.className = "sankey-row";
      setSankeySplitLayout(false);
    }
  }

  /** Excel column year Y → school year label Y-(Y+1 mod 100), e.g. 2010→2010-11, 2025→2025-26. */
  function schoolYearLabelFromExcelYear(y) {
    var n = Number(y);
    if (isNaN(n)) return String(y);
    var end = (n + 1) % 100;
    var endStr = end < 10 ? "0" + end : String(end);
    return n + "-" + endStr;
  }

  /** Schools included in district-wide enrollment and demographics sums (matches dashboard scope). */
  function masterRowIncludedInDistrictAggregate(m) {
    if (!m) return false;
    return String(m.appears_in_dropdown || "").trim().toLowerCase() === "yes";
  }

  /** @returns {number[]} unique MSIDs with appears_in_dropdown=yes in school_master.csv */
  function getDistrictAggregateMsids() {
    var out = [];
    var seen = {};
    if (!MASTER_BY_MSID) return out;
    Object.keys(MASTER_BY_MSID).forEach(function (k) {
      var n = parseInt(k, 10);
      if (isNaN(n) || seen[n]) return;
      seen[n] = true;
      var m = MASTER_BY_MSID[k];
      if (!masterRowIncludedInDistrictAggregate(m)) return;
      out.push(n);
    });
    return out;
  }

  /** Sums enrollment calendar + projected series across all district schools (dropdown scope). */
  function buildDistrictEnrollmentSeries() {
    if (!MASTER_BY_MSID) return [];
    var msids = getDistrictAggregateMsids();
    if (!msids.length) return [];
    var merged = {};
    for (var i = 0; i < msids.length; i++) {
      var ser = buildEnrollmentSeries(msids[i]);
      for (var j = 0; j < ser.length; j++) {
        var s = ser[j];
        if (!merged[s.label]) {
          merged[s.label] = {
            label: s.label,
            value: 0,
            segment: s.segment,
          };
        }
        merged[s.label].value += Number(s.value) || 0;
      }
    }
    var labels = Object.keys(merged).sort(function (a, b) {
      return enrollmentLabelSortKey(a) - enrollmentLabelSortKey(b);
    });
    return labels.map(function (lb) {
      var pt = merged[lb];
      return {
        label: pt.label,
        value: Math.round(pt.value),
        segment: pt.segment,
      };
    });
  }

  function buildEnrollmentSeries(msid) {
    if (msid == null || isNaN(msid) || !MASTER_BY_MSID) return [];
    var m = masterRow(msid);
    if (!m) return [];
    var out = [];

    for (var y = 2010; y <= 2025; y++) {
      var col = "enrollment_" + y;
      var v = m[col];
      if (v !== "" && v != null && !isNaN(Number(v))) {
        out.push({
          label: schoolYearLabelFromExcelYear(y),
          value: Number(v),
          segment: "enrollment",
        });
      }
    }

    var labels = MASTER_PROJECTION_LABELS || [];
    for (var j = 0; j < labels.length; j++) {
      var col = projectedColumnForSyLabel(labels[j]);
      var pv = m[col];
      if (pv !== "" && pv != null && !isNaN(Number(pv))) {
        out.push({
          label: labels[j],
          value: Number(pv),
          segment: "projected",
        });
      }
    }
    return out;
  }

  function enrollmentLabelSortKey(label) {
    var proj = MASTER_PROJECTION_LABELS;
    if (proj && proj.indexOf(label) >= 0) {
      return 10000 + proj.indexOf(label);
    }
    var m = String(label).match(/^(\d{4})-/);
    if (m) return parseInt(m[1], 10);
    return 99999;
  }

  /** First school year shown on the scenario enrollment chart (future-focused). */
  var SCENARIO_CHART_FIRST_SY = "2025-26";

  function enrollmentSeriesLabelIsScenarioFuture(label) {
    if (label == null) return false;
    var s = String(label).trim();
    return s >= SCENARIO_CHART_FIRST_SY;
  }

  function filterEnrollmentSeriesScenarioFuture(series) {
    if (!series || !series.length) return [];
    return series.filter(function (pt) {
      return enrollmentSeriesLabelIsScenarioFuture(pt.label);
    });
  }

  var SCENARIO_STACK_MIDDLE_COLOR = "#2563eb";
  /** Dark → light palettes for feeder swatches and stacked-chart segments by school type. */
  var SCENARIO_STACK_ELEM_GREENS = [
    "#14532d",
    "#166534",
    "#15803d",
    "#16a34a",
    "#22c55e",
    "#4ade80",
    "#86efac",
    "#bbf7d0",
    "#d9f99d",
    "#ecfccb",
    "#f7fee7",
    "#ecfdf5",
    "#f0fdf4",
  ];
  /** Shades of blue for middle-school feeders / base middle school. */
  var SCENARIO_STACK_MS_BLUES = [
    "#1e3a8a",
    "#1d4ed8",
    "#2563eb",
    "#3b82f6",
    "#60a5fa",
    "#93c5fd",
    "#bfdbfe",
    "#dbeafe",
    "#eff6ff",
  ];
  /** Shades of purple for high-school feeders / base high school. */
  var SCENARIO_STACK_HS_PURPLES = [
    "#4c1d95",
    "#5b21b6",
    "#6d28d9",
    "#7c3aed",
    "#8b5cf6",
    "#a78bfa",
    "#c4b5fd",
    "#ddd6fe",
    "#ede9fe",
  ];
  /** Shades of orange for Jr/Sr high feeders / base Jr/Sr high school. */
  var SCENARIO_STACK_JRSR_ORANGES = [
    "#7c2d12",
    "#9a3412",
    "#c2410c",
    "#ea580c",
    "#f97316",
    "#fb923c",
    "#fdba74",
    "#fed7aa",
    "#ffedd5",
  ];

  var SCENARIO_TYPE_GROUP_ORDER = ["elementary", "middle", "jr_sr_high", "high"];

  /** Returns "elementary" | "middle" | "high" | "jr_sr_high" for a feeder row or its msid props. */
  function scenarioFeederRowSchoolLevel(r) {
    if (!r) return null;
    if (r.msid != null && !isNaN(r.msid)) {
      var m = masterRow(r.msid);
      if (m && m.school_level) {
        var lv = String(m.school_level).trim().toLowerCase();
        if (
          lv === "elementary" ||
          lv === "middle" ||
          lv === "high" ||
          lv === "jr_sr_high"
        ) {
          return lv;
        }
      }
    }
    if (r.props) {
      var t = String(r.props.TYPE || "").toUpperCase();
      if (t === "JR SR HIGH") return "jr_sr_high";
      if (t.indexOf("ELEMENTARY") >= 0) return "elementary";
      if (t.indexOf("MIDDLE") >= 0) return "middle";
      if (t.indexOf("HIGH") >= 0) return "high";
    }
    return null;
  }

  function scenarioPaletteForLevel(level) {
    if (level === "middle") return SCENARIO_STACK_MS_BLUES;
    if (level === "high") return SCENARIO_STACK_HS_PURPLES;
    if (level === "jr_sr_high") return SCENARIO_STACK_JRSR_ORANGES;
    return SCENARIO_STACK_ELEM_GREENS;
  }

  function scenarioBaseSolidColorForLevel(level) {
    if (level === "middle") return "#1d4ed8";   /* deep blue */
    if (level === "high") return "#6d28d9";     /* deep purple */
    if (level === "jr_sr_high") return "#c2410c"; /* deep orange */
    return "#15803d";                            /* deep green */
  }

  function scenarioLegendCategoryForLevel(level) {
    if (level === "middle") {
      return { key: "middle", label: "Feeder Middle Schools", palette: SCENARIO_STACK_MS_BLUES };
    }
    if (level === "high") {
      return { key: "high", label: "Feeder High Schools", palette: SCENARIO_STACK_HS_PURPLES };
    }
    if (level === "jr_sr_high") {
      return { key: "jr_sr_high", label: "Feeder Jr/Sr High Schools", palette: SCENARIO_STACK_JRSR_ORANGES };
    }
    return { key: "elementary", label: "Feeder Elementary Schools", palette: SCENARIO_STACK_ELEM_GREENS };
  }

  /**
   * Palette index for the i-th of `count` feeders: evenly spaced when count is small
   * (e.g. 3 feeders → darkest, mid, and lighter green — not the three darkest only).
   */
  function scenarioFeederGreenPaletteIndex(i, count, paletteLen) {
    var n = paletteLen;
    if (count <= 0 || n <= 0) return 0;
    if (count === 1) return 0;
    if (count >= n) return i < n ? i : n - 1;
    return Math.min(n - 1, Math.round((i * (n - 1)) / (count + 1)));
  }

  /**
   * Assigns greens in feeder-row order (checkbox list top → bottom).
   * Few feeders pick well-separated palette steps; many feeders walk dark → light sequentially.
   */
  function assignElementaryFeederGreenColors(elemMsids) {
    var order = elemMsids.slice();
    var greenByMsid = {};
    var n = SCENARIO_STACK_ELEM_GREENS.length;
    var k = order.length;
    for (var gi = 0; gi < k; gi++) {
      var idx = scenarioFeederGreenPaletteIndex(gi, k, n);
      greenByMsid[order[gi]] = SCENARIO_STACK_ELEM_GREENS[idx];
    }
    return greenByMsid;
  }

  /**
   * Assign type-specific shade to each non-base feeder row keyed by msid.
   * Returns { byMsid: { [msid]: { color, level } }, byLevel: { [level]: { msids, palette } } }.
   * Order within each type follows feeder-row order so the chart and checklist match.
   */
  function assignScenarioFeederColorsByType(rows, baseMsid) {
    var byMsid = Object.create(null);
    var groups = Object.create(null);
    if (!rows || !rows.length) return { byMsid: byMsid, byLevel: groups };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || r.isScenarioMiddleRow) continue;
      if (r.msid == null || isNaN(r.msid)) continue;
      if (baseMsid != null && Number(r.msid) === Number(baseMsid)) continue;
      var lv = scenarioFeederRowSchoolLevel(r) || "elementary";
      if (!groups[lv]) groups[lv] = { msids: [], palette: scenarioPaletteForLevel(lv) };
      groups[lv].msids.push(Number(r.msid));
    }
    /* The base school is drawn with a fixed solid color for its level. Exclude
       that exact color from the feeder palettes so a same-type feeder never
       reuses the base school's hex code (the base can now be the same school
       type as its feeders). */
    var baseMasterC = baseMsid != null ? masterRow(baseMsid) : null;
    var baseLevelC =
      baseMasterC && baseMasterC.school_level
        ? String(baseMasterC.school_level).trim().toLowerCase()
        : "elementary";
    var baseColorC = String(
      scenarioBaseSolidColorForLevel(baseLevelC) || ""
    ).toLowerCase();
    var lvKeys = Object.keys(groups);
    for (var gi = 0; gi < lvKeys.length; gi++) {
      var lvk = lvKeys[gi];
      var grp = groups[lvk];
      var pal = grp.palette;
      var palUse = [];
      for (var pj = 0; pj < pal.length; pj++) {
        if (String(pal[pj]).toLowerCase() !== baseColorC) palUse.push(pal[pj]);
      }
      if (!palUse.length) palUse = pal;
      var n = palUse.length;
      var k = grp.msids.length;
      for (var mi = 0; mi < k; mi++) {
        var idx = scenarioFeederGreenPaletteIndex(mi, k, n);
        byMsid[grp.msids[mi]] = { color: palUse[idx], level: lvk };
      }
    }
    return { byMsid: byMsid, byLevel: groups };
  }

  /** All unique feeder elementary MSIDs for the scenario (same set used for checkbox swatches). */
  function scenarioFeederElementaryMsidsFromRows(middleMsid, feederRows) {
    var out = [];
    var seen = {};
    if (!feederRows || !feederRows.length) return out;
    for (var i = 0; i < feederRows.length; i++) {
      var m = feederRows[i].msid;
      if (m == null || isNaN(m) || m === middleMsid) continue;
      if (!seen[m]) {
        seen[m] = true;
        out.push(m);
      }
    }
    return out;
  }

  function findSeriesPointForLabel(series, label) {
    if (!series || !label) return null;
    for (var i = 0; i < series.length; i++) {
      if (series[i].label === label) return series[i];
    }
    return null;
  }

  /**
   * @param feederRows Scenario feeder rows (all elementaries for this middle); colors match checkbox swatches.
   * @returns {{ periods: { label: string, total: number, segments: { name: string, value: number, color: string, isMiddle: boolean }[] }[], maxVal: number }}
   */
  function buildScenarioStackedPeriods(
    weightedSpec,
    middleMsid,
    schoolByMsid,
    feederRows
  ) {
    var periods = [];
    var maxVal = 0;
    if (
      !weightedSpec ||
      !weightedSpec.length ||
      middleMsid == null ||
      isNaN(middleMsid) ||
      !schoolByMsid
    ) {
      return { periods: periods, maxVal: 1 };
    }

    var seriesCache = {};
    function getSeriesCached(msid) {
      var k = String(msid);
      if (!seriesCache[k]) {
        seriesCache[k] = buildEnrollmentSeries(msid);
      }
      return seriesCache[k];
    }

    var labelSet = {};
    for (var si = 0; si < weightedSpec.length; si++) {
      var ser = getSeriesCached(weightedSpec[si].msid);
      for (var sj = 0; sj < ser.length; sj++) {
        labelSet[ser[sj].label] = true;
      }
    }
    var labels = Object.keys(labelSet).sort(function (a, b) {
      return enrollmentLabelSortKey(a) - enrollmentLabelSortKey(b);
    });
    labels = labels.filter(enrollmentSeriesLabelIsScenarioFuture);

    /* Type-aware color map: base school uses solid color for its level; non-base feeders use shades. */
    var colorAssignments = assignScenarioFeederColorsByType(feederRows || [], middleMsid);
    var colorByMsid = colorAssignments.byMsid;

    var baseProps = schoolByMsid[middleMsid];
    var baseMaster = masterRow(middleMsid);
    var baseLevel = baseMaster && baseMaster.school_level
      ? String(baseMaster.school_level).trim().toLowerCase()
      : (baseProps ? scenarioFeederRowSchoolLevel({ props: baseProps }) : "elementary");
    var baseColor = scenarioBaseSolidColorForLevel(baseLevel || "elementary");
    var baseName = baseProps ? schoolNameForSelect(baseProps) : "Base school";
    var baseShortName = baseProps ? schoolShortNameFromProps(baseProps) : baseName;

    /* Levels actually present in the weighted spec (excluding the base). Used to dynamically build the legend. */
    var legendLevelOrderPresent = [];
    var seenLevels = Object.create(null);
    var feederMsidsByLevelOrdered = Object.create(null);
    for (var ri = 0; ri < (feederRows || []).length; ri++) {
      var rr = feederRows[ri];
      if (!rr || rr.isScenarioMiddleRow) continue;
      if (rr.msid == null || isNaN(rr.msid) || Number(rr.msid) === Number(middleMsid)) continue;
      var lv = scenarioFeederRowSchoolLevel(rr) || "elementary";
      if (!feederMsidsByLevelOrdered[lv]) feederMsidsByLevelOrdered[lv] = [];
      feederMsidsByLevelOrdered[lv].push(Number(rr.msid));
    }
    for (var olv = 0; olv < SCENARIO_TYPE_GROUP_ORDER.length; olv++) {
      var lvKey = SCENARIO_TYPE_GROUP_ORDER[olv];
      if (feederMsidsByLevelOrdered[lvKey] && feederMsidsByLevelOrdered[lvKey].length) {
        legendLevelOrderPresent.push(lvKey);
        seenLevels[lvKey] = true;
      }
    }

    /* Stable segment order: base first, then feeders grouped by ES → MS → Jr/Sr → HS. */
    var orderedFeederMsids = [];
    for (var oi = 0; oi < legendLevelOrderPresent.length; oi++) {
      var lvk2 = legendLevelOrderPresent[oi];
      orderedFeederMsids = orderedFeederMsids.concat(feederMsidsByLevelOrdered[lvk2]);
    }

    var weightByMsid = {};
    for (var wi = 0; wi < weightedSpec.length; wi++) {
      var wx = weightedSpec[wi];
      if (wx.msid == null || isNaN(wx.msid)) continue;
      weightByMsid[wx.msid] = wx;
    }

    /* Categories whose members appear in the checked-on stacked totals (used to drive the legend). */
    var anyCheckedByLevel = Object.create(null);
    for (var ofi = 0; ofi < orderedFeederMsids.length; ofi++) {
      var fmsid = orderedFeederMsids[ofi];
      if (weightByMsid[fmsid]) {
        var lv2 = scenarioFeederRowSchoolLevel({ msid: fmsid }) || "elementary";
        anyCheckedByLevel[lv2] = true;
      }
    }
    var baseInWeighted = !!weightByMsid[middleMsid];

    for (var li = 0; li < labels.length; li++) {
      var lab = labels[li];
      var segments = [];
      var total = 0;

      if (weightByMsid[middleMsid]) {
        var ptBase = findSeriesPointForLabel(getSeriesCached(middleMsid), lab);
        var baseVal = ptBase != null
          ? Math.round(Number(ptBase.value) * weightByMsid[middleMsid].weight)
          : 0;
        segments.push({
          name: baseName,
          value: baseVal,
          color: baseColor,
          isMiddle: true,
          level: baseLevel || "elementary",
        });
        total += baseVal;
      }

      /* Lightest sits above base (drawn first after base); darkest on top — matches checkbox list top = dark, bottom = light. */
      for (var ei = orderedFeederMsids.length - 1; ei >= 0; ei--) {
        var emsid = orderedFeederMsids[ei];
        var ew = weightByMsid[emsid];
        if (!ew) continue;
        var ept = findSeriesPointForLabel(getSeriesCached(ew.msid), lab);
        var ev = ept != null ? Math.round(Number(ept.value) * ew.weight) : 0;
        var ep = schoolByMsid[ew.msid];
        var ename = ep ? schoolNameForSelect(ep) : String(ew.msid);
        var info = colorByMsid[ew.msid];
        var col = info ? info.color : SCENARIO_STACK_ELEM_GREENS[0];
        var lvRow = info ? info.level : (scenarioFeederRowSchoolLevel({ msid: ew.msid }) || "elementary");
        segments.push({
          name: ename,
          value: ev,
          color: col,
          isMiddle: false,
          level: lvRow,
        });
        total += ev;
      }

      segments.sort(function (a, b) {
        if (a.isMiddle && !b.isMiddle) return -1;
        if (!a.isMiddle && b.isMiddle) return 1;
        return 0;
      });

      periods.push({ label: lab, segments: segments, total: total });
      if (total > maxVal) maxVal = total;
    }

    if (maxVal <= 0) maxVal = 1;
    /* Factored capacity of the base school (drawn as a dashed reference line
       across the chart). Null when the base school has no capacity recorded. */
    var baseCapacity = null;
    if (
      baseMaster &&
      baseMaster.factored_capacity_2025_26 !== "" &&
      baseMaster.factored_capacity_2025_26 != null
    ) {
      var capNum = Number(baseMaster.factored_capacity_2025_26);
      if (!isNaN(capNum) && capNum > 0) baseCapacity = capNum;
    }
    return {
      periods: periods,
      maxVal: maxVal,
      baseCapacity: baseCapacity,
      legend: {
        baseName: baseName,
        baseShortName: baseShortName,
        baseColor: baseColor,
        baseLevel: baseLevel || "elementary",
        baseInWeighted: baseInWeighted,
        feederLevelsPresent: legendLevelOrderPresent.filter(function (lv) {
          return !!anyCheckedByLevel[lv];
        }),
        baseCapacity: baseCapacity,
      },
    };
  }

  function teardownScenarioStackedChart(root) {
    if (root && typeof root._scenarioStackedCleanup === "function") {
      root._scenarioStackedCleanup();
      root._scenarioStackedCleanup = null;
    }
  }

  function renderScenarioStackedEnrollmentChartIntoRoot(root, stacked, options) {
    options = options || {};
    teardownScenarioStackedChart(root);
    if (!root) return;
    var noDataMsg =
      options.noDataMsg ||
      "No merged enrollment data is available from 2025-26 onward for the current selection.";
    if (!stacked.periods || !stacked.periods.length) {
      root.innerHTML =
        '<p class="enrollment-chart-empty">' + noDataMsg + "</p>";
      root.setAttribute(
        "aria-label",
        options.noDataAria || "Merged enrollment data is not available."
      );
      return;
    }

    var periods = stacked.periods;
    var rawMaxVal = stacked.maxVal;
    var baseCapacity =
      stacked.baseCapacity != null && stacked.baseCapacity > 0
        ? Number(stacked.baseCapacity)
        : null;
    /* If the capacity line lies above the tallest bar, expand the chart's
       y-domain so the line is always on-canvas with a bit of headroom. */
    var maxVal = rawMaxVal;
    if (baseCapacity != null && baseCapacity > maxVal) {
      maxVal = Math.ceil(baseCapacity * 1.06);
    }
    var n = periods.length;
    /* Left margin = width of the two-line "[School]\nFactored Capacity: N"
       label plus a small gap. Label is left-justified at x=0; bars/dashed
       line begin at `ml`, so this keeps the dashed reference line directly
       adjacent to its label with no awkward middle gap. When there's no
       capacity to plot, fall back to a tiny axis padding. */
    var ml;
    if (baseCapacity != null) {
      var nameForBudget =
        stacked.legend && stacked.legend.baseName
          ? String(stacked.legend.baseName)
          : "";
      var capValueForBudget =
        "Factored Capacity: " + Math.round(baseCapacity).toLocaleString();
      var longestChars = Math.max(
        nameForBudget.length,
        capValueForBudget.length
      );
      ml = Math.min(
        260,
        Math.max(40, Math.ceil(longestChars * 6.4) + 10)
      );
    } else {
      ml = 36;
    }
    var mb = 54;
    var mt = 42;
    var mr = 10;
    var perBar = 34;
    var w = Math.min(1280, Math.max(480, ml + mr + n * perBar));
    var h = 252;
    var iw = w - ml - mr;
    var ih = h - mt - mb;
    var slot = iw / n;
    var barW = slot * 0.58;
    var gap = (slot - barW) / 2;
    var labelLift = 14;

    var parts = [];
    parts.push('<div class="scenario-enrollment-chart-wrap">');
    parts.push(
      '<div id="scenario-enrollment-tooltip" class="scenario-enrollment-tooltip" hidden></div>'
    );
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" class="scenario-enrollment-svg" preserveAspectRatio="xMinYMin meet" style="min-width:' +
        w +
        'px" viewBox="0 0 ' +
        w +
        " " +
        h +
        '" aria-hidden="true">'
    );
    parts.push(
      '<line x1="' +
        ml +
        '" y1="' +
        (mt + ih) +
        '" x2="' +
        (w - mr) +
        '" y2="' +
        (mt + ih) +
        '" stroke="#e5e7eb" stroke-width="1" />'
    );

    for (var b = 0; b < n; b++) {
      var period = periods[b];
      var x = ml + b * slot + gap;
      var cum = 0;
      for (var s = 0; s < period.segments.length; s++) {
        var seg = period.segments[s];
        var sv = seg.value;
        var sh = maxVal > 0 ? (sv / maxVal) * ih : 0;
        var y = mt + ih - cum - sh;
        cum += sh;
        parts.push(
          '<rect class="scenario-stack-seg" data-bar="' +
            b +
            '" data-seg="' +
            s +
            '" x="' +
            x.toFixed(1) +
            '" y="' +
            y.toFixed(1) +
            '" width="' +
            barW.toFixed(1) +
            '" height="' +
            sh.toFixed(1) +
            '" fill="' +
            seg.color +
            '" rx="0" pointer-events="all" style="cursor:pointer"/>'
        );
      }
      var total = period.total;
      var topY = mt + ih - cum;
      var valY = topY - labelLift;
      parts.push(
        '<text x="' +
          (x + barW / 2) +
          '" y="' +
          valY +
          '" text-anchor="middle" dominant-baseline="alphabetic" font-size="11" font-weight="600" fill="#1f2937" font-family="Libre Franklin, sans-serif" pointer-events="none">' +
          escapeXmlText(total.toLocaleString()) +
          "</text>"
      );
      var lx = x + barW / 2;
      var ly = mt + ih + 12;
      parts.push(
        '<text x="' +
          lx +
          '" y="' +
          ly +
          '" text-anchor="end" transform="rotate(-52 ' +
          lx +
          " " +
          ly +
          ')" font-size="10" fill="#374151" font-family="Libre Franklin, sans-serif" pointer-events="none">' +
          escapeXmlText(period.label) +
          "</text>"
      );
    }
    var legendInfo = stacked.legend || null;
    /* Dashed reference line: base school's factored capacity. Drawn last so
       it sits visually on top of the bars. We tag the line + label with
       data-attrs so a post-render pass can snap the line's left endpoint to
       the label's actual right edge (eliminating the visible gap caused by
       our coarse character-width estimate for `ml`). */
    if (baseCapacity != null) {
      var capY = mt + ih - (baseCapacity / maxVal) * ih;
      parts.push(
        '<line data-scenario-capacity-line="1" x1="' +
          ml +
          '" y1="' +
          capY.toFixed(1) +
          '" x2="' +
          (w - mr) +
          '" y2="' +
          capY.toFixed(1) +
          '" stroke="#dc2626" stroke-width="0.9" stroke-dasharray="5 4" pointer-events="none"/>'
      );
      /* Two-line label sits at the LEFT edge of the chart wrap (left-justified
         to match the leftmost legend item below the chart). Line 1 = base
         school name, line 2 = "Factored Capacity: <value>". */
      var capLabelX = 0;
      var capLabelY = capY;
      var capSchoolName =
        legendInfo && legendInfo.baseName ? String(legendInfo.baseName) : "";
      var capValueText =
        "Factored Capacity: " + Math.round(baseCapacity).toLocaleString();
      parts.push(
        '<text data-scenario-capacity-label="1" x="' +
          capLabelX +
          '" y="' +
          capLabelY.toFixed(1) +
          '" text-anchor="start" font-size="11" font-weight="600" fill="#dc2626" font-family="Libre Franklin, sans-serif" pointer-events="none">' +
          '<tspan x="' +
          capLabelX +
          '" dy="-0.2em">' +
          escapeXmlText(capSchoolName) +
          "</tspan>" +
          '<tspan x="' +
          capLabelX +
          '" dy="1.15em">' +
          escapeXmlText(capValueText) +
          "</tspan>" +
          "</text>"
      );
    }
    parts.push("</svg>");
    var legendItems = [];
    if (legendInfo && legendInfo.baseInWeighted) {
      var legendBaseLabel =
        legendInfo.baseShortName || legendInfo.baseName || "Base school";
      legendItems.push(
        '<span><i style="background:' +
          escapeXmlText(legendInfo.baseColor) +
          '"></i> Base school: ' +
          escapeXmlText(legendBaseLabel) +
          "</span>"
      );
    }
    if (legendInfo && legendInfo.feederLevelsPresent) {
      for (var fli = 0; fli < legendInfo.feederLevelsPresent.length; fli++) {
        var lv = legendInfo.feederLevelsPresent[fli];
        var cat = scenarioLegendCategoryForLevel(lv);
        /* Solid swatch using the darkest end of the palette, with " (shades)" hint. */
        legendItems.push(
          '<span><i style="background:' +
            escapeXmlText(cat.palette[0]) +
            '"></i> ' +
            escapeXmlText(cat.label) +
            " (shades)</span>"
        );
      }
    }
    if (baseCapacity != null) {
      /* Ultra-compact dashed swatch — thin stroke, short footprint, many
         dashes to mirror the chart's dashed reference line at small scale. */
      legendItems.push(
        '<span><svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" style="vertical-align:middle;margin-right:4px;flex-shrink:0"><line x1="0" y1="3" x2="10" y2="3" stroke="#dc2626" stroke-width="0.4" stroke-dasharray="0.6 0.5"/></svg> Factored capacity</span>'
      );
    }
    if (legendItems.length) {
      parts.push(
        '<div class="enrollment-chart-legend" aria-hidden="true">' +
          legendItems.join("") +
          "</div>"
      );
    }
    parts.push("</div>");

    root.innerHTML = parts.join("");
    root.setAttribute(
      "aria-label",
      options.ariaLabel ||
        "Stacked enrollment by school from 2025-26 forward (scenario)."
    );
    root.classList.add("enrollment-chart--stacked");

    var svg = root.querySelector(".scenario-enrollment-svg");
    var tip = document.getElementById("scenario-enrollment-tooltip");
    if (!svg || !tip) return;

    /* Reunite the capacity label and its dashed line: snap the line's left
       endpoint to the label's actual right edge (viewBox units). Our static
       per-character estimate of `ml` over-budgets by a few px, leaving a
       visible gap. getBBox() returns the exact rendered width. */
    try {
      var capLineEl = svg.querySelector("[data-scenario-capacity-line='1']");
      var capLabelEl = svg.querySelector("[data-scenario-capacity-label='1']");
      if (capLineEl && capLabelEl && typeof capLabelEl.getBBox === "function") {
        var bb = capLabelEl.getBBox();
        if (bb && isFinite(bb.x) && isFinite(bb.width) && bb.width > 0) {
          /* 4 px breathing room between the label and the dashed line. */
          var snappedX = bb.x + bb.width + 4;
          capLineEl.setAttribute("x1", snappedX.toFixed(1));
        }
      }
    } catch (eSnap) {
      /* getBBox can throw on detached SVGs; fall back to the static ml. */
    }
    var currentHoverBar = null;

    function rectsForBar(barIndex) {
      return svg.querySelectorAll('.scenario-stack-seg[data-bar="' + barIndex + '"]');
    }

    function setBarClass(barIndex, className, on) {
      if (barIndex == null || isNaN(barIndex)) return;
      var rects = rectsForBar(barIndex);
      for (var ri = 0; ri < rects.length; ri++) {
        rects[ri].classList.toggle(className, !!on);
      }
    }

    function clearBarClass(className) {
      var rects = svg.querySelectorAll(".scenario-stack-seg." + className);
      for (var ri = 0; ri < rects.length; ri++) {
        rects[ri].classList.remove(className);
      }
    }

    function barIndexForPeriodLabel(label) {
      for (var pi = 0; pi < periods.length; pi++) {
        if (periods[pi] && periods[pi].label === label) return pi;
      }
      return null;
    }

    function syncLockedBarHighlight() {
      clearBarClass("is-bar-locked");
      var lockedIdx = scenarioGradeSummaryLockedLabel
        ? barIndexForPeriodLabel(scenarioGradeSummaryLockedLabel)
        : null;
      if (lockedIdx != null) setBarClass(lockedIdx, "is-bar-locked", true);
    }

    function setHoverBar(barIndex) {
      if (currentHoverBar === barIndex) return;
      if (currentHoverBar != null) setBarClass(currentHoverBar, "is-bar-hover", false);
      currentHoverBar = barIndex;
      if (currentHoverBar != null) setBarClass(currentHoverBar, "is-bar-hover", true);
    }

    syncLockedBarHighlight();

    function showTooltipOne(periodLabel, seg, clientX, clientY) {
      if (!seg) {
        hideTooltip();
        return;
      }
      tip.removeAttribute("hidden");
      tip.innerHTML = "";
      var head = document.createElement("div");
      head.className = "scenario-enrollment-tooltip-title";
      head.textContent = periodLabel;
      tip.appendChild(head);
      var row = document.createElement("div");
      row.className = "scenario-enrollment-tooltip-row";
      var sw = document.createElement("span");
      sw.className = "scenario-enrollment-tooltip-swatch";
      sw.style.background = seg.color;
      row.appendChild(sw);
      row.appendChild(
        document.createTextNode(
          seg.name + ": " + Number(seg.value).toLocaleString()
        )
      );
      tip.appendChild(row);
      tip.style.left = Math.min(clientX + 14, window.innerWidth - 280) + "px";
      tip.style.top = Math.min(clientY + 14, window.innerHeight - 200) + "px";
    }

    function hideTooltip() {
      tip.setAttribute("hidden", "hidden");
    }

    function onMove(e) {
      var t = e.target;
      if (
        t &&
        t.classList &&
        t.classList.contains("scenario-stack-seg")
      ) {
        var b = parseInt(t.getAttribute("data-bar"), 10);
        var si = parseInt(t.getAttribute("data-seg"), 10);
        var period = periods[b];
        if (
          !isNaN(b) &&
          !isNaN(si) &&
          period &&
          period.segments &&
          period.segments[si]
        ) {
          showTooltipOne(
            period.label,
            period.segments[si],
            e.clientX,
            e.clientY
          );
          scenarioGradeSummaryHoverLabel = period.label;
          setHoverBar(b);
          if (!scenarioGradeSummaryLockedLabel) {
            renderScenarioGradeSummaryTable();
          }
          return;
        }
      }
      hideTooltip();
      if (scenarioGradeSummaryHoverLabel) {
        scenarioGradeSummaryHoverLabel = null;
        renderScenarioGradeSummaryTable();
      }
      setHoverBar(null);
    }

    function onLeave() {
      hideTooltip();
      scenarioGradeSummaryHoverLabel = null;
      setHoverBar(null);
      if (!scenarioGradeSummaryLockedLabel) {
        renderScenarioGradeSummaryTable();
      }
    }

    function onClick(e) {
      var t = e.target;
      if (
        !t ||
        !t.classList ||
        !t.classList.contains("scenario-stack-seg")
      ) {
        return;
      }
      var b = parseInt(t.getAttribute("data-bar"), 10);
      var period = periods[b];
      if (isNaN(b) || !period || !period.label) return;
      if (scenarioGradeSummaryLockedLabel === period.label) {
        scenarioGradeSummaryLockedLabel = null;
      } else {
        scenarioGradeSummaryLockedLabel = period.label;
      }
      scenarioGradeSummaryHoverLabel = null;
      syncLockedBarHighlight();
      renderScenarioGradeSummaryTable();
    }

    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", onLeave);
    svg.addEventListener("click", onClick);

    root._scenarioStackedCleanup = function () {
      svg.removeEventListener("mousemove", onMove);
      svg.removeEventListener("mouseleave", onLeave);
      svg.removeEventListener("click", onClick);
      root.classList.remove("enrollment-chart--stacked");
    };
  }

  /** Sums calendar + projected series by label; each entry is { msid, weight }. Middle school weight is always 1. */
  function buildMergedEnrollmentSeriesWeighted(weighted) {
    var merged = {};
    for (var i = 0; i < weighted.length; i++) {
      var msid = weighted[i].msid;
      var wt = weighted[i].weight;
      if (msid == null || isNaN(msid) || wt == null || isNaN(wt)) continue;
      var series = buildEnrollmentSeries(msid);
      for (var j = 0; j < series.length; j++) {
        var s = series[j];
        if (!merged[s.label]) {
          merged[s.label] = { label: s.label, value: 0, segment: s.segment };
        }
        merged[s.label].value += s.value * wt;
      }
    }
    var labels = Object.keys(merged).sort(function (a, b) {
      return enrollmentLabelSortKey(a) - enrollmentLabelSortKey(b);
    });
    return labels.map(function (lb) {
      var pt = merged[lb];
      return {
        label: pt.label,
        value: Math.round(pt.value),
        segment: pt.segment,
      };
    });
  }

  /** Shorter labels (e.g. 66.8k) when count > 9999 to reduce overlap; full count stays on rect/title tooltip. */
  function formatEnrollmentBarAxisLabel(val) {
    if (val <= 9999) return val.toLocaleString();
    var k = val / 1000;
    var rounded = Math.round(k * 10) / 10;
    var ir = Math.round(rounded);
    if (Math.abs(rounded - ir) < 0.001) {
      return String(ir) + "k";
    }
    return rounded.toFixed(1) + "k";
  }

  function setMainEnrollmentDemographicsHeadings(isDistrict) {
    var eh = document.getElementById("main-enrollment-chart-heading");
    if (eh) {
      eh.textContent = isDistrict
        ? "Traditional and choice schools: districtwide enrollment over time"
        : "Enrollment over time";
    }
    var eth = document.getElementById("demographics-ethnicity-heading");
    var lunchH = document.getElementById("demographics-lunch-heading");
    if (eth) {
      eth.textContent = isDistrict
        ? "Sum of Non-Charter Schools: Race and Ethnicity"
        : "Race and Ethnicity";
    }
    if (lunchH) {
      lunchH.textContent = isDistrict
        ? "Sum of Non-Charter Schools: Free and Reduced Lunch"
        : "Free and Reduced Lunch";
    }
  }

  function renderEnrollmentChartIntoRoot(root, series, options) {
    options = options || {};
    if (!root) return;
    var noDataMsg =
      options.noDataMsg ||
      "No enrollment data is available for this school.";
    if (!series || !series.length) {
      root.innerHTML =
        '<p class="enrollment-chart-empty">' + noDataMsg + "</p>";
      root.setAttribute(
        "aria-label",
        options.noDataAria || "Enrollment data is not available."
      );
      return;
    }
    var maxVal = 0;
    for (var i = 0; i < series.length; i++) {
      if (series[i].value > maxVal) maxVal = series[i].value;
    }
    if (maxVal <= 0) maxVal = 1;
    var n = series.length;
    var hasLargeBarValues = false;
    for (var li = 0; li < series.length; li++) {
      if (series[li].value > 9999) {
        hasLargeBarValues = true;
        break;
      }
    }
    var ml = 36;
    var mb = 54;
    /** Top margin: room so value labels sit fully above bars (incl. tallest). */
    var mt = 42;
    var mr = 10;
    var perBar = hasLargeBarValues ? 38 : 34;
    var w = Math.min(1280, Math.max(480, ml + mr + n * perBar));
    var h = 252;
    var iw = w - ml - mr;
    var ih = h - mt - mb;
    var slot = iw / n;
    var barW = slot * 0.58;
    var gap = (slot - barW) / 2;
    /** Pixels from bar top to label baseline (labels render upward from baseline). */
    var labelLift = 14;

    var parts = [];
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" style="min-width:' +
        w +
        'px" viewBox="0 0 ' +
        w +
        " " +
        h +
        '" aria-hidden="true">'
    );
    parts.push(
      '<line x1="' +
        ml +
        '" y1="' +
        (mt + ih) +
        '" x2="' +
        (w - mr) +
        '" y2="' +
        (mt + ih) +
        '" stroke="#e5e7eb" stroke-width="1" />'
    );

    for (var b = 0; b < series.length; b++) {
      var s = series[b];
      var val = s.value;
      var bh = (val / maxVal) * ih;
      var x = ml + b * slot + gap;
      var y = mt + ih - bh;
      var fill =
        s.segment === "projected"
          ? ENCHART_COLORS.projected
          : ENCHART_COLORS.calendar;
      parts.push(
        '<rect x="' +
          x.toFixed(1) +
          '" y="' +
          y.toFixed(1) +
          '" width="' +
          barW.toFixed(1) +
          '" height="' +
          bh.toFixed(1) +
          '" fill="' +
          fill +
          '" rx="2"><title>' +
          escapeXmlText(
            s.label + ": " + val.toLocaleString() + " students"
          ) +
          "</title></rect>"
      );
      var cx = x + barW / 2;
      var valY = y - labelLift;
      var axisLabel = formatEnrollmentBarAxisLabel(val);
      parts.push(
        '<text x="' +
          cx +
          '" y="' +
          valY +
          '" text-anchor="middle" dominant-baseline="alphabetic" font-size="11" font-weight="600" fill="#1f2937" font-family="Libre Franklin, sans-serif">' +
          (val > 9999
            ? "<title>" +
              escapeXmlText(
                s.label + ": " + val.toLocaleString() + " students"
              ) +
              "</title>"
            : "") +
          escapeXmlText(axisLabel) +
          "</text>"
      );
      var lx = cx;
      var ly = mt + ih + 12;
      parts.push(
        '<text x="' +
          lx +
          '" y="' +
          ly +
          '" text-anchor="end" transform="rotate(-52 ' +
          lx +
          " " +
          ly +
          ')" font-size="10" fill="#374151" font-family="Libre Franklin, sans-serif">' +
          escapeXmlText(s.label) +
          "</text>"
      );
    }
    parts.push("</svg>");
    parts.push(
      '<div class="enrollment-chart-legend" aria-hidden="true">' +
        '<span><i style="background:' +
        ENCHART_COLORS.calendar +
        '"></i> Enrollment</span>' +
        '<span><i style="background:' +
        ENCHART_COLORS.projected +
        '"></i> Projected Enrollment</span>' +
        "</div>"
    );
    root.innerHTML = parts.join("");
    root.setAttribute(
      "aria-label",
      options.ariaLabel ||
        "Enrollment bar chart with " + n + " periods for the selected school."
    );
  }

  function renderEnrollmentChart(msid) {
    setMainEnrollmentDemographicsHeadings(msid == null || isNaN(msid));
    var root = document.getElementById("enrollment-chart");
    if (!root) return;
    if (msid == null || isNaN(msid)) {
      var distSeries = buildDistrictEnrollmentSeries();
      renderEnrollmentChartIntoRoot(root, distSeries, {
        noDataMsg:
          "No district-wide enrollment data is available.",
        noDataAria:
          "District enrollment data is not available.",
        ariaLabel:
          "District-wide enrollment bar chart: sum of calendar and projected membership across district schools.",
      });
      return;
    }
    var series = buildEnrollmentSeries(msid);
    renderEnrollmentChartIntoRoot(root, series, {
      noDataMsg:
        "No enrollment data is available for this school.",
      noDataAria:
        "Enrollment data is not available for this school.",
      ariaLabel:
        "Enrollment bar chart with periods for the selected school.",
    });
  }

  /** Demographics pies are suppressed when 10 or fewer students have ethnicity/lunch data
   *  (homeschool excluded). 11 means the predicate is `cohortCount < 11`. */
  var DEMOGRAPHICS_MIN_COHORT_COUNT = 11;

  function sumDemographicsCountObject(countsObj) {
    if (!countsObj) {
      return 0;
    }
    var total = 0;
    Object.keys(countsObj).forEach(function (k) {
      var v = Number(countsObj[k]);
      if (!isNaN(v) && v > 0) {
        total += v;
      }
    });
    return total;
  }

  /** Students represented in master CSV ethnicity/lunch columns (excludes homeschool). */
  function demographicsCohortCountFromMaster(m) {
    var objs = demographicsObjectsFromMaster(m);
    if (!objs) {
      return 0;
    }
    return Math.max(
      sumDemographicsCountObject(objs.ethnicity),
      sumDemographicsCountObject(objs.lunchStatus)
    );
  }

  function demographicsCohortCountFromAggregates(agg) {
    if (!agg) {
      return 0;
    }
    return Math.max(
      sumDemographicsCountObject(agg.ethnicity),
      sumDemographicsCountObject(agg.lunchStatus)
    );
  }

  function shouldSuppressDemographicsCharts(cohortCount) {
    return (
      cohortCount == null ||
      isNaN(cohortCount) ||
      cohortCount < DEMOGRAPHICS_MIN_COHORT_COUNT
    );
  }

  function demographicsSuppressedEmptyHtml() {
    return (
      '<p class="demographics-pie-empty">Detailed demographics appear when more students are included.</p>'
    );
  }

  /**
   * Fallback when an ethnicity label is not in the fixed map below (e.g. new export values).
   */
  var DEMOGRAPHICS_PIE_COLORS = [
    "#795548",
    "#e65100",
    "#fb8c00",
    "#f9a825",
    "#c0ca33",
    "#7cb342",
    "#558b2f",
    "#00897b",
    "#039be5",
    "#3949ab",
    "#7b1fa2",
    "#c2185b",
  ];

  function lunchSliceColor(label) {
    var u = String(label).toLowerCase();
    /** Must run before "reduced" — "Not free/reduced" also contains "reduced". */
    if (u.indexOf("not free") >= 0) return "#e53935";
    if (u === "free") return "#689f38";
    if (u.indexOf("reduced") >= 0) return "#fbc02d";
    return "#78909c";
  }

  /** Fixed label → color for race/ethnicity pies (not rank-based). */
  function ethnicitySliceColor(label, idx) {
    var s = String(label).trim().toLowerCase();
    if (s.indexOf("white") >= 0 && s.indexOf("non-hispanic") >= 0) {
      return "#fdd835";
    }
    if (s.indexOf("black") >= 0 && s.indexOf("non-hispanic") >= 0) {
      return "#fb8c00";
    }
    if (s === "hispanic" || (s.indexOf("hispanic") >= 0 && s.indexOf("non-hispanic") < 0)) {
      return "#e65100";
    }
    if (
      s.indexOf("multi-racial") >= 0 ||
      s.indexOf("multiracial") >= 0 ||
      s.indexOf("mixed race") >= 0
    ) {
      return "#93612c";
    }
    if (s === "asian") {
      return "#c0ca33";
    }
    if (
      s.indexOf("amer. indian") >= 0 ||
      s.indexOf("american indian") >= 0 ||
      s.indexOf("alaskan native") >= 0
    ) {
      return "#7cb342";
    }
    if (s.indexOf("hawaiian") >= 0 || s.indexOf("pacific islander") >= 0) {
      return "#00897b";
    }
    return DEMOGRAPHICS_PIE_COLORS[idx % DEMOGRAPHICS_PIE_COLORS.length];
  }

  function buildPieChartHtml(countsObj, colorForIndex) {
    var entries = Object.keys(countsObj).map(function (k) {
      return { label: k, value: Number(countsObj[k]) };
    }).filter(function (e) {
      return e.value > 0 && !isNaN(e.value);
    });
    entries.sort(function (a, b) {
      return b.value - a.value;
    });
    var total = entries.reduce(function (s, e) {
      return s + e.value;
    }, 0);
    if (total <= 0) {
      return {
        html:
          '<p class="demographics-pie-empty">No students in this category for the selected school.</p>',
        total: 0,
      };
    }
    var cx = 100;
    var cy = 100;
    var r = 88;
    var angle = -Math.PI / 2;
    var pathParts = [];
    for (var i = 0; i < entries.length; i++) {
      var slice = entries[i];
      var frac = slice.value / total;
      var a2 = angle + frac * 2 * Math.PI;
      var large = frac > 0.5 ? 1 : 0;
      var x1 = cx + r * Math.cos(angle);
      var y1 = cy + r * Math.sin(angle);
      var x2 = cx + r * Math.cos(a2);
      var y2 = cy + r * Math.sin(a2);
      var d = [
        "M",
        cx,
        cy,
        "L",
        x1.toFixed(3),
        y1.toFixed(3),
        "A",
        r,
        r,
        0,
        large,
        1,
        x2.toFixed(3),
        y2.toFixed(3),
        "Z",
      ].join(" ");
      var fill = colorForIndex(slice.label, i);
      pathParts.push(
        '<path d="' +
          d +
          '" fill="' +
          fill +
          '" stroke="#fff" stroke-width="1.5"><title>' +
          escapeXmlText(
            slice.label +
              ": " +
              slice.value +
              " (" +
              ((slice.value / total) * 100).toFixed(1) +
              "%)"
          ) +
          "</title></path>"
      );
      angle = a2;
    }
    var legendItems = [];
    for (var j = 0; j < entries.length; j++) {
      var e = entries[j];
      var pct = ((e.value / total) * 100).toFixed(1);
      var fillJ = colorForIndex(e.label, j);
      legendItems.push(
        "<li>" +
          '<span class="demographics-legend-swatch" style="background:' +
          fillJ +
          '"></span>' +
          "<span>" +
          escapeXmlText(e.label) +
          " — " +
          e.value.toLocaleString() +
          " (" +
          pct +
          "%)</span></li>"
      );
    }
    return {
      html:
        '<div class="demographics-pie-inner"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" aria-hidden="true">' +
        pathParts.join("") +
        '</svg><ul class="demographics-legend">' +
        legendItems.join("") +
        "</ul></div>",
      total: total,
    };
  }

  function renderDemographicsCharts(msid) {
    setMainEnrollmentDemographicsHeadings(msid == null || isNaN(msid));
    var ethEl = document.getElementById("demographics-ethnicity");
    var lunchEl = document.getElementById("demographics-lunch");
    if (!ethEl || !lunchEl) return;

    if (msid == null || isNaN(msid)) {
      var dms = getDistrictAggregateMsids();
      var weighted = dms.map(function (id) {
        return { msid: id, weight: 1 };
      });
      var agg = aggregateDemographicsMsidsWeighted(weighted);
      renderDemographicsFromAggregates(
        agg,
        ethEl,
        lunchEl,
        '<p class="demographics-pie-empty">No student demographics are available for district schools.</p>'
      );
      return;
    }
    if (!MASTER_BY_MSID) {
      ethEl.innerHTML =
        '<p class="demographics-pie-empty">School master data is not loaded.</p>';
      lunchEl.innerHTML =
        '<p class="demographics-pie-empty">School master data is not loaded.</p>';
      return;
    }
    var mRow = masterRow(msid);
    var objs = demographicsObjectsFromMaster(mRow);
    if (!objs) {
      var msg =
        '<p class="demographics-pie-empty">No student rows for this school in the SY2025-26 export.</p>';
      ethEl.innerHTML = msg;
      lunchEl.innerHTML = msg;
      return;
    }

    if (shouldSuppressDemographicsCharts(demographicsCohortCountFromMaster(mRow))) {
      ethEl.innerHTML = demographicsSuppressedEmptyHtml();
      lunchEl.innerHTML = demographicsSuppressedEmptyHtml();
      return;
    }

    var ethRes = buildPieChartHtml(objs.ethnicity || {}, ethnicitySliceColor);
    ethEl.innerHTML = ethRes.html;

    var lunchRes = buildPieChartHtml(objs.lunchStatus || {}, function (label) {
      return lunchSliceColor(label);
    });
    lunchEl.innerHTML = lunchRes.html;
  }

  function mergeCountObjScaled(dst, src, scale) {
    if (!src || scale == null || isNaN(scale)) return;
    Object.keys(src).forEach(function (k) {
      var v = Number(src[k]);
      if (isNaN(v) || v <= 0) return;
      dst[k] = (dst[k] || 0) + v * scale;
    });
  }

  function aggregateDemographicsMsidsWeighted(weighted) {
    var eth = {};
    var lunch = {};
    if (!MASTER_BY_MSID) {
      return { ethnicity: eth, lunchStatus: lunch };
    }
    for (var i = 0; i < weighted.length; i++) {
      var msid = weighted[i].msid;
      var wt = weighted[i].weight;
      if (msid == null || isNaN(msid) || wt == null || isNaN(wt)) continue;
      var objs = demographicsObjectsFromMaster(masterRow(msid));
      if (!objs) continue;
      mergeCountObjScaled(eth, objs.ethnicity || {}, wt);
      mergeCountObjScaled(lunch, objs.lunchStatus || {}, wt);
    }
    return { ethnicity: eth, lunchStatus: lunch };
  }

  function renderDemographicsFromAggregates(agg, ethEl, lunchEl, emptyMsg) {
    var emptyAgg =
      emptyMsg ||
      '<p class="demographics-pie-empty">No student rows for merged selection in the SY2025-26 export.</p>';
    if (!ethEl || !lunchEl) return;
    if (shouldSuppressDemographicsCharts(demographicsCohortCountFromAggregates(agg))) {
      ethEl.innerHTML = demographicsSuppressedEmptyHtml();
      lunchEl.innerHTML = demographicsSuppressedEmptyHtml();
      return;
    }
    var ethRes = buildPieChartHtml(agg.ethnicity || {}, ethnicitySliceColor);
    var lunchRes = buildPieChartHtml(agg.lunchStatus || {}, function (label) {
      return lunchSliceColor(label);
    });
    ethEl.innerHTML = ethRes.total > 0 ? ethRes.html : emptyAgg;
    lunchEl.innerHTML = lunchRes.total > 0 ? lunchRes.html : emptyAgg;
  }

  function schoolHasEnrollmentWorkbook(msid) {
    if (msid == null || isNaN(msid)) return false;
    return buildEnrollmentSeries(msid).length > 0;
  }

  function findElementaryPropsBySankeyLabel(label, schoolsFc) {
    if (!schoolsFc || !schoolsFc.features) return null;
    for (var i = 0; i < schoolsFc.features.length; i++) {
      var p = schoolsFc.features[i].properties;
      if (!p) continue;
      var t = (p.TYPE || "").toUpperCase();
      if (t.indexOf("ELEMENTARY") < 0) continue;
      if (sankeyElementaryLabelMatchesSchool(label, p)) return p;
    }
    return null;
  }

  /** Sum of flow counts from one elementary to all middle schools (denominator for share to this middle). */
  function elementaryOutgoingTotalsMap(flows) {
    var m = {};
    if (!flows || !flows.length) return m;
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (!f || f.elementary == null) continue;
      var v = Number(f.value);
      if (isNaN(v) || v < 1) continue;
      var key = f.elementary;
      m[key] = (m[key] || 0) + v;
    }
    return m;
  }

  /**
   * Selected middle school row for the scenario feeder list (blue swatch, checkbox controls merged totals).
   */
  function buildScenarioMiddleFeederRow(middleProps, middleMsid) {
    var hasEnrollment = schoolHasEnrollmentWorkbook(middleMsid);
    return {
      sankeyLabel: "",
      msid: middleMsid,
      props: middleProps,
      hasEnrollment: hasEnrollment,
      flowValue: null,
      flowProportion: 1,
      isScenarioMiddleRow: true,
    };
  }

  function getFeederElementaryRowsForMiddle(middleProps, flows, schoolsFc) {
    var rows = [];
    if (!flows || !middleProps) return rows;
    var outgoingByEl = elementaryOutgoingTotalsMap(flows);
    var seen = {};
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (!f || f.value < 1) continue;
      if (!sankeyMiddleLabelMatchesSchool(f.middle, middleProps)) continue;
      var key = f.elementary;
      if (seen[key]) continue;
      seen[key] = true;
      var p = findElementaryPropsBySankeyLabel(f.elementary, schoolsFc);
      var msid =
        p && p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : null;
      var hasEnrollment = schoolHasEnrollmentWorkbook(msid);
      var totalOut = outgoingByEl[f.elementary] || 0;
      var flowProportion = totalOut > 0 ? f.value / totalOut : 1;
      rows.push({
        sankeyLabel: f.elementary,
        msid: msid,
        props: p,
        hasEnrollment: hasEnrollment,
        flowValue: f.value,
        flowProportion: flowProportion,
      });
    }
    rows.sort(function (a, b) {
      return a.sankeyLabel.localeCompare(b.sankeyLabel);
    });
    return rows;
  }

  /**
   * Feeder elementaries for a Jr/Sr high: ES→MS flows into middles that feed this high (MS→HS Sankey).
   */
  function getFeederElementaryRowsForJrSr(jrSrProps, flows, msHsFlows, schoolsFc) {
    var rows = [];
    if (!flows || !jrSrProps || !msHsFlows || !msHsFlows.length) return rows;
    var intoJrSr = msHsFlows.filter(function (hf) {
      return (
        hf &&
        hf.value >= 1 &&
        sankeyHighLabelMatchesSchool(hf.high, jrSrProps)
      );
    });
    if (!intoJrSr.length) return rows;

    var feederMiddles = {};
    for (var hi = 0; hi < intoJrSr.length; hi++) {
      feederMiddles[intoJrSr[hi].middle] = true;
    }

    var outgoingByEl = elementaryOutgoingTotalsMap(flows);
    var aggByEl = {};
    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (!f || f.value < 1) continue;
      if (!feederMiddles[f.middle]) continue;
      var key = f.elementary;
      if (!aggByEl[key]) aggByEl[key] = 0;
      aggByEl[key] += f.value;
    }

    var elKeys = Object.keys(aggByEl).sort();
    for (var ki = 0; ki < elKeys.length; ki++) {
      var elKey = elKeys[ki];
      var flowSum = aggByEl[elKey];
      var totalOut = outgoingByEl[elKey] || 0;
      var flowProportion = totalOut > 0 ? flowSum / totalOut : 1;
      var ep = findElementaryPropsBySankeyLabel(elKey, schoolsFc);
      var emsid = ep && ep.SCHOOLS_ID != null ? Number(ep.SCHOOLS_ID) : null;
      rows.push({
        sankeyLabel: elKey,
        msid: emsid,
        props: ep,
        hasEnrollment: schoolHasEnrollmentWorkbook(emsid),
        flowValue: flowSum,
        flowProportion: flowProportion,
      });
    }
    return rows;
  }

  /**
   * Build "contributing schools" rows for the consolidated Scenario tab.
   *
   *  - When scenarioUseFeederChainOnly is true: rows = existing matriculation feeder chain
   *    around `destMsid`. Each row carries a real `flowProportion` so "Complete merger"
   *    has meaningful semantics.
   *  - Otherwise: rows = the 10 closest eligible adjacent-band schools. Each row has
   *    `flowProportion = 1` (always full 100% absorption).
   *
   * The destination (base) school is appended last, marked `isScenarioMiddleRow: true`,
   * with weight always 1.
   */
  function buildScenarioFeederRowsForDestination(destProps, destMsid, schoolsFc) {
    var rows = [];
    if (scenarioUseFeederChainOnly) {
      var feederChain = computeFeederChainConsolidationCandidates(destMsid, schoolsFc);
      for (var i = 0; i < feederChain.length; i++) {
        var fc = feederChain[i];
        if (!fc) continue;
        rows.push({
          sankeyLabel: fc.sankeyLabel || String(fc.msid),
          msid: fc.msid,
          props: fc.props,
          hasEnrollment: schoolHasEnrollmentWorkbook(fc.msid),
          flowValue: 0,
          flowProportion: fc.flowProportion != null ? fc.flowProportion : 1,
        });
      }
    } else {
      var closest = compute10ClosestEligibleSchools(destMsid, schoolsFc, 10);
      for (var c = 0; c < closest.length; c++) {
        var cc = closest[c];
        rows.push({
          sankeyLabel: schoolDisplayNameFromProps(cc.props),
          msid: cc.msid,
          props: cc.props,
          hasEnrollment: schoolHasEnrollmentWorkbook(cc.msid),
          flowValue: 0,
          flowProportion: 1,
          milesFromBase: cc.miles,
        });
      }
    }
    /* Sort non-base rows by type group (ES → MS → Jr/Sr → HS), then by proximity (when available). */
    rows.sort(function (a, b) {
      var la = scenarioFeederRowSchoolLevel(a) || "elementary";
      var lb = scenarioFeederRowSchoolLevel(b) || "elementary";
      var ia = SCENARIO_TYPE_GROUP_ORDER.indexOf(la);
      var ib = SCENARIO_TYPE_GROUP_ORDER.indexOf(lb);
      if (ia < 0) ia = SCENARIO_TYPE_GROUP_ORDER.length;
      if (ib < 0) ib = SCENARIO_TYPE_GROUP_ORDER.length;
      if (ia !== ib) return ia - ib;
      var ma = a.milesFromBase != null && !isNaN(a.milesFromBase) ? a.milesFromBase : Infinity;
      var mb = b.milesFromBase != null && !isNaN(b.milesFromBase) ? b.milesFromBase : Infinity;
      if (ma !== mb) return ma - mb;
      var na = a.props ? schoolDisplayNameFromProps(a.props) : String(a.sankeyLabel || "");
      var nb = b.props ? schoolDisplayNameFromProps(b.props) : String(b.sankeyLabel || "");
      return na.localeCompare(nb);
    });
    /* User-added schools (only in non-feeder-chain mode) appear AFTER the auto-listed
       rows and BEFORE the base, so the rendered list ends with auto-discovered first,
       then user-added at the bottom of the feeder portion. */
    if (
      !scenarioUseFeederChainOnly &&
      scenarioUserAddedFeederMsids &&
      scenarioUserAddedFeederMsids.length
    ) {
      var seenMsids = Object.create(null);
      for (var s = 0; s < rows.length; s++) {
        if (rows[s].msid != null) seenMsids[Number(rows[s].msid)] = true;
      }
      if (destMsid != null) seenMsids[Number(destMsid)] = true;
      for (var u = 0; u < scenarioUserAddedFeederMsids.length; u++) {
        var um = Number(scenarioUserAddedFeederMsids[u]);
        if (isNaN(um) || seenMsids[um]) continue;
        seenMsids[um] = true;
        var ufeat = scenarioFindSchoolFeatureByMsid(um, schoolsFc);
        var uprops = ufeat ? ufeat.properties : null;
        rows.push({
          sankeyLabel: uprops ? schoolDisplayNameFromProps(uprops) : String(um),
          msid: um,
          props: uprops,
          hasEnrollment: schoolHasEnrollmentWorkbook(um),
          flowValue: 0,
          flowProportion: 1,
          isUserAdded: true,
        });
      }
    }
    rows.push(buildScenarioMiddleFeederRow(destProps, destMsid));
    return rows;
  }

  /** Lookup a school feature by MSID from a passed FeatureCollection or the cached one. */
  function scenarioFindSchoolFeatureByMsid(msid, schoolsFc) {
    var fc = schoolsFc || scenarioCachedSchoolsFc;
    if (!fc || !fc.features) return null;
    var n = Number(msid);
    for (var i = 0; i < fc.features.length; i++) {
      var ft = fc.features[i];
      var pr = ft && ft.properties;
      if (pr && Number(pr.SCHOOLS_ID) === n) return ft;
    }
    return null;
  }

  /** Same 2025 calendar column as main dashboard ’25-26 enrollment KPI. */
  function enrollment202526CalendarForMsid(msid) {
    if (msid == null || isNaN(msid)) return null;
    var m = masterRow(msid);
    if (!m) return null;
    var v = m.enrollment_2025;
    if (v !== "" && v != null && !isNaN(Number(v))) {
      return Number(v);
    }
    return null;
  }

  function buildMiddleSchoolMsidSetFromSchoolsFc(schoolsFc) {
    var o = {};
    if (!schoolsFc || !schoolsFc.features) return o;
    for (var i = 0; i < schoolsFc.features.length; i++) {
      var p = schoolsFc.features[i].properties;
      if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") continue;
      var t = (p.TYPE || "").toUpperCase();
      if (t.indexOf("MIDDLE") >= 0 && t.indexOf("HIGH") < 0) {
        o[String(Number(p.SCHOOLS_ID))] = true;
      }
    }
    return o;
  }

  /**
   * Middle-school attendance rows only count when attendance matches the scenario middle,
   * and when that middle is included via the feeder-list checkbox (same as merged enrollment).
   * Elementary attendance respects feeder checkboxes unless ignoreFeederCheckboxes (axis extent only).
   */
  function attendancePassesScenarioTravelFilter(
    attMsid,
    selectedMiddleMsid,
    feederRows,
    ignoreFeederCheckboxes
  ) {
    var ms = Number(attMsid);
    if (isNaN(ms)) return false;
    var sel = Number(selectedMiddleMsid);
    if (ms === sel) {
      if (ignoreFeederCheckboxes) return true;
      return scenarioFeederChecked[selectedMiddleMsid] !== false;
    }
    var msStr = String(ms);
    var midSet = MIDDLE_SCHOOL_MSID_SET || {};
    if (midSet[msStr]) return false;
    for (var i = 0; i < feederRows.length; i++) {
      var r = feederRows[i];
      if (r.msid != null && !isNaN(r.msid) && r.msid === ms) {
        if (!r.hasEnrollment) return false;
        if (ignoreFeederCheckboxes) return true;
        return scenarioFeederChecked[r.msid] !== false;
      }
    }
    return false;
  }

  /** @returns {number|null} miles, or null if invalid / omit */
  function travelMilesFromFeet(ft) {
    var n = Number(ft);
    if (!isFinite(n) || n <= 0) return null;
    return n / FEET_PER_MILE;
  }

  function medianOfNumbers(vals) {
    if (!vals || !vals.length) return null;
    var s = vals.slice().sort(function (a, b) {
      return a - b;
    });
    var n = s.length;
    var h = Math.floor(n / 2);
    if (n % 2 === 1) return s[h];
    return (s[h - 1] + s[h]) / 2;
  }

  function meanOfNumbers(vals) {
    if (!vals || !vals.length) return null;
    var s = 0;
    var i;
    for (i = 0; i < vals.length; i++) s += vals[i];
    return s / vals.length;
  }

  /** Tukey upper inner fence (Q3 + 3×IQR); null when not applicable. */
  function travelTukeyUpperFenceMiles(miles) {
    if (!miles || miles.length < 4) return null;
    var sorted = miles.slice().sort(function (a, b) {
      return a - b;
    });
    var n = sorted.length;
    var q1 = sorted[Math.floor((n - 1) * 0.25)];
    var q3 = sorted[Math.ceil((n - 1) * 0.75)];
    var iqr = q3 - q1;
    if (!(iqr > 0) || !isFinite(iqr)) return null;
    return q3 + 3 * iqr;
  }

  /** Drops values above the Tukey upper fence; keeps all when fence undefined. */
  function travelMilesExcludingUpperOutliers(miles) {
    if (!miles || !miles.length) return [];
    var fence = travelTukeyUpperFenceMiles(miles);
    if (fence == null || !isFinite(fence)) return miles.slice();
    return miles.filter(function (m) {
      return m <= fence + 1e-9;
    });
  }

  /** X-axis max (mi) from retained distances only; bucket-aligned. Outliers should already be removed. */
  function travelHistogramAxisExtentFromMiles(miles) {
    var bw = TRAVEL_BIN_MI;
    if (!miles || !miles.length) return bw;
    var maxV = Math.max.apply(null, miles);
    return Math.max(bw, Math.ceil(maxV / bw) * bw);
  }

  /** Shared x-axis for existing + scenario pair after each side drops outliers. */
  function travelHistogramPairedAxisHiMiles(milesA, milesB) {
    var bw = TRAVEL_BIN_MI;
    var ha =
      milesA && milesA.length ? travelHistogramAxisExtentFromMiles(milesA) : 0;
    var hb =
      milesB && milesB.length ? travelHistogramAxisExtentFromMiles(milesB) : 0;
    if (ha <= 0 && hb <= 0) return bw;
    return Math.max(bw, ha, hb);
  }

  function binTravelHistogramCounts(miles, axisHi) {
    var bw = TRAVEL_BIN_MI;
    var numBins = Math.max(1, Math.round(axisHi / bw));
    var counts = [];
    var b;
    for (b = 0; b < numBins; b++) counts[b] = 0;
    for (var j = 0; j < miles.length; j++) {
      var m = miles[j];
      var idx;
      if (m >= axisHi - 1e-12) idx = numBins - 1;
      else {
        idx = Math.floor(m / bw);
        if (idx < 0) idx = 0;
        if (idx >= numBins) idx = numBins - 1;
      }
      counts[idx]++;
    }
    return { counts: counts, numBins: numBins, axisHi: axisHi };
  }

  /**
   * @param {'existing'|'scenario'} mode
   * @param {boolean} [ignoreFeederCheckboxes] If true, axis-style extent: include all feeder schools regardless of checkbox.
   * @returns {number[]} distances in miles
   */
  function collectScenarioTravelMiles(
    mode,
    triples,
    selectedMiddleMsid,
    feederRows,
    ignoreFeederCheckboxes
  ) {
    var out = [];
    if (!triples || !triples.length) return out;
    var sel = selectedMiddleMsid;
    var ignFeed =
      ignoreFeederCheckboxes === true;
    for (var i = 0; i < triples.length; i++) {
      var row = triples[i];
      if (!row || row.length < 3) continue;
      var att = Number(row[0]);
      var sce = Number(row[1]);
      var mi = travelMilesFromFeet(row[2]);
      if (mi == null) continue;
      if (
        !attendancePassesScenarioTravelFilter(att, sel, feederRows, ignFeed)
      )
        continue;
      if (mode === "existing") {
        if (att !== sce) continue;
      } else {
        if (sce !== sel) continue;
      }
      out.push(mi);
    }
    return out;
  }

  function renderTravelHistogramIntoRoot(root, chartTitle, miles, options) {
    options = options || {};
    if (!root) return;
    var bw = TRAVEL_BIN_MI;
    if (!miles || !miles.length) {
      root.innerHTML =
        '<p class="travel-hist-empty">No students match the current filters.</p>';
      root.setAttribute(
        "aria-label",
        chartTitle + ": no data for the current filters."
      );
      return;
    }
    var milesUse = travelMilesExcludingUpperOutliers(miles);
    if (!milesUse.length) {
      root.innerHTML =
        '<p class="travel-hist-empty">All distances were excluded as statistical outliers (Tukey upper fence).</p>';
      root.setAttribute(
        "aria-label",
        chartTitle + ": all values excluded as outliers."
      );
      return;
    }
    var axisHi =
      options.axisHiOverride != null &&
      isFinite(options.axisHiOverride) &&
      options.axisHiOverride > 0
        ? options.axisHiOverride
        : travelHistogramAxisExtentFromMiles(milesUse);
    if (!(axisHi > 0) || !isFinite(axisHi)) axisHi = bw;
    var binRes = binTravelHistogramCounts(milesUse, axisHi);
    var counts = binRes.counts;
    var numBins = binRes.numBins;
    var maxCount = 0;
    var c;
    for (c = 0; c < counts.length; c++) {
      if (counts[c] > maxCount) maxCount = counts[c];
    }
    if (maxCount <= 0) maxCount = 1;

    var ml = 44;
    var mr = 118;
    var medTextY = 6;
    var meanTextY = 24;
    var mt = 40;
    var mb = 46;
    var cw = root.clientWidth || 0;
    if (cw < 80 && root.closest) {
      var chartCard = root.closest(".travel-impact-chart-card");
      if (chartCard) {
        cw = Math.max(0, chartCard.getBoundingClientRect().width - 24);
      }
    }
    if (cw < 80) {
      cw =
        typeof window !== "undefined"
          ? Math.min(920, Math.max(320, window.innerWidth - 120))
          : 520;
    }
    var iw = Math.max(220, cw - ml - mr);
    var ih = 156;
    var med = medianOfNumbers(milesUse);
    var avg = meanOfNumbers(milesUse);
    var medLabel =
      med != null && isFinite(med) ? "Median " + med.toFixed(2) + " mi" : "";
    var meanLabel =
      avg != null && isFinite(avg)
        ? "Average " + avg.toFixed(2) + " mi"
        : "";

    var parts = [];
    parts.push(
      '<svg xmlns="http://www.w3.org/2000/svg" class="travel-hist-svg" viewBox="0 0 ' +
        (ml + iw + mr) +
        " " +
        (mt + ih + mb) +
        '" aria-hidden="true">'
    );

    var baselineY = mt + ih;
    parts.push(
      '<line x1="' +
        ml +
        '" y1="' +
        baselineY +
        '" x2="' +
        (ml + iw) +
        '" y2="' +
        baselineY +
        '" stroke="#e5e7eb" stroke-width="1" />'
    );

    function xPix(miCoord) {
      return ml + (miCoord / axisHi) * iw;
    }

    var barGap = 1;
    for (var b = 0; b < numBins; b++) {
      var x0 = ((b * bw) / axisHi) * iw;
      var barW = Math.max(0.5, (bw / axisHi) * iw - barGap);
      var h = maxCount > 0 ? (counts[b] / maxCount) * ih : 0;
      var bx = ml + x0 + barGap / 2;
      var by = baselineY - h;
      var tip =
        counts[b] > 0
          ? "<title>" +
            escapeXmlText(
              (b * bw).toFixed(2) +
                "–" +
                Math.min(axisHi, (b + 1) * bw).toFixed(2) +
                " mi: " +
                counts[b].toLocaleString()
            ) +
            "</title>"
          : "";
      parts.push(
        '<rect class="travel-hist-bar" x="' +
          bx.toFixed(2) +
          '" y="' +
          by.toFixed(2) +
          '" width="' +
          barW.toFixed(2) +
          '" height="' +
          h.toFixed(2) +
          '" fill="#64748b" rx="1">' +
          tip +
          "</rect>"
      );
    }

    if (med != null && isFinite(med)) {
      var mx = xPix(Math.min(med, axisHi));
      parts.push(
        '<line class="travel-hist-median" x1="' +
          mx.toFixed(2) +
          '" y1="' +
          mt +
          '" x2="' +
          mx.toFixed(2) +
          '" y2="' +
          baselineY +
          '" stroke="' +
          TRAVEL_MEDIAN_COLOR +
          '" stroke-width="2" stroke-dasharray="4 3" />'
      );
      if (medLabel) {
        var flagX = mx + 6;
        parts.push(
          '<text class="travel-hist-median-flag" x="' +
            flagX.toFixed(2) +
            '" y="' +
            medTextY +
            '" font-size="13" font-weight="600" fill="' +
            TRAVEL_MEDIAN_COLOR +
            '" font-family="Libre Franklin, sans-serif" text-anchor="start" dominant-baseline="hanging" pointer-events="none">' +
            escapeXmlText(medLabel) +
            "</text>"
        );
      }
    }

    if (avg != null && isFinite(avg)) {
      var ax = xPix(Math.min(avg, axisHi));
      parts.push(
        '<line class="travel-hist-mean" x1="' +
          ax.toFixed(2) +
          '" y1="' +
          mt +
          '" x2="' +
          ax.toFixed(2) +
          '" y2="' +
          baselineY +
          '" stroke="' +
          TRAVEL_MEAN_COLOR +
          '" stroke-width="2" stroke-dasharray="6 4" />'
      );
      if (meanLabel) {
        var meanFlagX = ax + 6;
        parts.push(
          '<text class="travel-hist-mean-flag" x="' +
            meanFlagX.toFixed(2) +
            '" y="' +
            meanTextY +
            '" font-size="13" font-weight="600" fill="' +
            TRAVEL_MEAN_COLOR +
            '" font-family="Libre Franklin, sans-serif" text-anchor="start" dominant-baseline="hanging" pointer-events="none">' +
            escapeXmlText(meanLabel) +
            "</text>"
        );
      }
    }

    var maxIntTick = Math.ceil(axisHi - 1e-9);
    var ki;
    for (ki = 0; ki <= maxIntTick; ki++) {
      if (ki > axisHi + 1e-9) break;
      var tx = xPix(Math.min(ki, axisHi));
      parts.push(
        '<line x1="' +
          tx.toFixed(2) +
          '" y1="' +
          baselineY +
          '" x2="' +
          tx.toFixed(2) +
          '" y2="' +
          (baselineY + 5) +
          '" stroke="#d1d5db" stroke-width="1" />'
      );
      parts.push(
        '<text x="' +
          tx.toFixed(2) +
          '" y="' +
          (baselineY + 18) +
          '" text-anchor="middle" font-size="10" fill="#4b5563" font-family="Libre Franklin, sans-serif">' +
          escapeXmlText(String(ki)) +
          "</text>"
      );
    }

    parts.push(
      '<text x="' +
        (ml + iw / 2) +
        '" y="' +
        (baselineY + mb - 4) +
        '" text-anchor="middle" font-size="10" fill="#6b7280" font-family="Libre Franklin, sans-serif">Network Travel Distance (Miles)</text>'
    );

    parts.push("</svg>");
    root.innerHTML = parts.join("");
    root.setAttribute(
      "aria-label",
      chartTitle + ": histogram by " + bw + " mi buckets."
    );
  }

  function renderScenarioTravelImpactCharts() {
    var elEx = document.getElementById("scenario-travel-existing");
    var elSc = document.getElementById("scenario-travel-scenario");
    if (!elEx || !elSc) return;

    if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) {
      elEx.innerHTML =
        '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
      elSc.innerHTML =
        '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
      return;
    }

    var pack =
      TRAVEL_IMPACT_ALL &&
      TRAVEL_IMPACT_ALL.byMsid &&
      TRAVEL_IMPACT_ALL.byMsid[String(scenarioMiddleMsid)];
    if (!pack || !pack.rows || !pack.rows.length) {
      var miss =
        '<p class="travel-hist-empty">Travel distance data is not yet available for this school.</p>';
      elEx.innerHTML = miss;
      elSc.innerHTML = miss;
      return;
    }

    var feederRows = scenarioLastFeederRows || [];
    var milesEx = collectScenarioTravelMiles(
      "existing",
      pack.rows,
      scenarioMiddleMsid,
      feederRows,
      false
    );
    var milesSc = collectScenarioTravelMiles(
      "scenario",
      pack.rows,
      scenarioMiddleMsid,
      feederRows,
      false
    );

    var milesExAxis = collectScenarioTravelMiles(
      "existing",
      pack.rows,
      scenarioMiddleMsid,
      feederRows,
      true
    );
    var milesScAxis = collectScenarioTravelMiles(
      "scenario",
      pack.rows,
      scenarioMiddleMsid,
      feederRows,
      true
    );

    var scenTitleEl = document.getElementById(
      "scenario-travel-scenario-chart-title"
    );
    var destProps =
      scenarioSchoolByMsid && scenarioSchoolByMsid[scenarioMiddleMsid]
        ? scenarioSchoolByMsid[scenarioMiddleMsid]
        : null;
    var shortMid = scenarioMiddleShortDisplayName(scenarioMiddleMsid);
    var destLabel = shortMid
      ? shortMid
      : destProps
        ? schoolNameForSelect(destProps)
        : null;
    if (scenTitleEl) {
      scenTitleEl.textContent = destLabel
        ? "Scenario Travel Distances to " + destLabel
        : "Scenario Travel Distances to Selected School";
    }

    var scenarioChartTitle =
      scenTitleEl && scenTitleEl.textContent
        ? scenTitleEl.textContent
        : "Scenario Travel Distances to Selected School";

    var useExAxis = travelMilesExcludingUpperOutliers(milesExAxis);
    var useScAxis = travelMilesExcludingUpperOutliers(milesScAxis);
    var pairedAxisHi = travelHistogramPairedAxisHiMiles(useExAxis, useScAxis);
    var histOpts = { axisHiOverride: pairedAxisHi };

    function paintTravelHistograms() {
      renderTravelHistogramIntoRoot(
        elEx,
        "Existing Travel Distances to Attendance School",
        milesEx,
        histOpts
      );
      renderTravelHistogramIntoRoot(
        elSc,
        scenarioChartTitle,
        milesSc,
        histOpts
      );
    }

    paintTravelHistograms();
    if (typeof requestAnimationFrame !== "undefined") {
      requestAnimationFrame(function travelHistLayoutReflow() {
        if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) {
          return;
        }
        paintTravelHistograms();
      });
    }
  }

  function collectScenarioWeightedSpec() {
    var out = [];
    if (!scenarioLastFeederRows.length) {
      if (
        scenarioMiddleMsid != null &&
        !isNaN(scenarioMiddleMsid) &&
        scenarioFeederChecked[scenarioMiddleMsid] !== false
      ) {
        out.push({
          msid: scenarioMiddleMsid,
          weight: scenarioGradeInclusionFactorForRow({
            msid: scenarioMiddleMsid,
            isScenarioMiddleRow: true,
          }),
        });
      }
      return out;
    }
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null) continue;
      if (scenarioFeederChecked[r.msid] === false) continue;
      if (r.isScenarioMiddleRow) {
        out.push({ msid: r.msid, weight: scenarioGradeInclusionFactorForRow(r) });
        continue;
      }
      var gradeFactor = scenarioGradeInclusionFactorForRow(r);
      var w =
        scenarioCompleteMerger
          ? gradeFactor
          : (r.flowProportion != null && !isNaN(r.flowProportion)
              ? r.flowProportion
              : 1) * gradeFactor;
      out.push({ msid: r.msid, weight: w });
    }
    return out;
  }

  /** Look up a school's enrollment for a given period label from its full enrollment series. */
  function enrollmentTotalForMsidAndLabel(msid, periodLabel) {
    if (msid == null || isNaN(msid)) return null;
    var label = periodLabel || SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL;
    var series = buildEnrollmentSeries(msid);
    for (var i = 0; i < series.length; i++) {
      if (series[i].label === label) {
        var v = Number(series[i].value);
        return isNaN(v) ? null : v;
      }
    }
    return null;
  }

  /**
   * Per-grade enrollment contributed by a single feeder row for the given school year.
   * - Uses student-hex grade counts (Grade column) where available to derive the
   *   distribution shape; the same shape is applied to future years since per-grade
   *   projections are not in the data.
   * - Falls back to an even split across the school's `grades_served` list when
   *   student-hex grade data is missing.
   * - Applies the row's flow proportion (feeder-chain mode + partial merger only)
   *   so totals match the bar chart.
   * - Drops grades that are toggled off for this school.
   * @param {Object} r feeder row
   * @param {string} [periodLabel] e.g. "2025-26" (default) or "2030-31"
   * @returns {Object<string, number>} grade canon → student count
   */
  function scenarioByGradeContributionForRow(r, periodLabel) {
    var out = Object.create(null);
    if (!r || r.msid == null || isNaN(r.msid)) return out;
    if (!r.hasEnrollment) return out;
    var isBase = !!r.isScenarioMiddleRow;
    var proportion;
    if (isBase) {
      proportion = 1;
    } else if (scenarioCompleteMerger) {
      proportion = 1;
    } else {
      proportion =
        r.flowProportion != null && !isNaN(r.flowProportion)
          ? r.flowProportion
          : 1;
    }
    var totalEnrollment = enrollmentTotalForMsidAndLabel(r.msid, periodLabel);
    if (totalEnrollment == null || isNaN(totalEnrollment)) return out;

    var hexByGrade = scenarioEnrollmentByGradeForMsid(r.msid);
    var hexKeys = Object.keys(hexByGrade);
    if (hexKeys.length) {
      var hexTotal = 0;
      for (var hi = 0; hi < hexKeys.length; hi++) {
        hexTotal += hexByGrade[hexKeys[hi]] || 0;
      }
      if (hexTotal > 0) {
        for (var hj = 0; hj < hexKeys.length; hj++) {
          var gc = hexKeys[hj];
          if (!scenarioGradeIncludedForMsid(r.msid, gc, isBase)) continue;
          var share = (hexByGrade[gc] || 0) / hexTotal;
          out[gc] = (out[gc] || 0) + totalEnrollment * proportion * share;
        }
        return out;
      }
    }
    /* Fallback: even split across served grades. */
    var served = scenarioGradeCodesForMsid(r.msid);
    if (!served.length) return out;
    var perGrade = totalEnrollment / served.length;
    for (var si = 0; si < served.length; si++) {
      var sg = served[si];
      if (!scenarioGradeIncludedForMsid(r.msid, sg, isBase)) continue;
      out[sg] = (out[sg] || 0) + perGrade * proportion;
    }
    return out;
  }

  /** Aggregate the merged scenario's by-grade enrollment for `periodLabel` across checked rows. */
  function scenarioMergedByGradeForPeriod(periodLabel) {
    var totals = Object.create(null);
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null || isNaN(r.msid)) continue;
      if (scenarioFeederChecked[r.msid] === false) continue;
      var contrib = scenarioByGradeContributionForRow(r, periodLabel);
      for (var gc in contrib) {
        totals[gc] = (totals[gc] || 0) + contrib[gc];
      }
    }
    return totals;
  }

  /** Period label that should drive the by-grade summary table right now:
   *  click-locked > hover > default ("2025-26"). */
  function effectiveScenarioGradeSummaryLabel() {
    if (scenarioGradeSummaryLockedLabel) return scenarioGradeSummaryLockedLabel;
    if (scenarioGradeSummaryHoverLabel) return scenarioGradeSummaryHoverLabel;
    return SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL;
  }

  function setScenarioGradeSummaryHeadingYear(label) {
    var span = document.getElementById("scenario-grade-summary-year");
    if (span) span.textContent = label || SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL;
  }

  function renderScenarioGradeSummaryTable() {
    var wrap = document.getElementById("scenario-grade-summary-table-wrap");
    if (!wrap) return;
    var label = effectiveScenarioGradeSummaryLabel();
    setScenarioGradeSummaryHeadingYear(label);
    if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) {
      wrap.innerHTML =
        '<p class="scenario-grade-summary-empty">Select a school to view enrollment by grade.</p>';
      return;
    }
    var byGrade = scenarioMergedByGradeForPeriod(label);
    var keys = Object.keys(byGrade).sort(function (a, b) {
      var oa = charterGradeCanonToOrdinal(a);
      var ob = charterGradeCanonToOrdinal(b);
      return (oa != null ? oa : 99) - (ob != null ? ob : 99);
    });
    if (!keys.length) {
      wrap.innerHTML =
        '<p class="scenario-grade-summary-empty">No grade-level enrollment available for ' +
        escapeHtml(label) +
        ".</p>";
      return;
    }
    var total = 0;
    var rowsHtml = "";
    for (var i = 0; i < keys.length; i++) {
      var g = keys[i];
      var v = byGrade[g];
      if (v == null || isNaN(v)) v = 0;
      var rounded = Math.round(v);
      total += rounded;
      rowsHtml +=
        "<tr><th scope=\"row\">" +
        escapeHtml(travelShedGradeDisplayLabel(g)) +
        "</th><td>" +
        rounded.toLocaleString() +
        "</td></tr>";
    }
    var html =
      '<table class="scenario-grade-summary-table">' +
      '<thead><tr><th scope="col">Grade</th><th scope="col">Students</th></tr></thead>' +
      "<tbody>" +
      rowsHtml +
      '<tr class="scenario-grade-summary-row--total"><th scope="row">Total</th><td>' +
      total.toLocaleString() +
      "</td></tr>" +
      "</tbody></table>";
    wrap.innerHTML = html;
  }

  function applyScenarioMergedUpdates() {
    var weighted = collectScenarioWeightedSpec();
    var chartRoot = document.getElementById("scenario-enrollment-chart");
    teardownScenarioStackedChart(chartRoot);
    if (chartRoot) chartRoot.classList.remove("enrollment-chart--stacked");

    if (
      SCENARIO_USE_STACKED_ENROLLMENT_CHART &&
      scenarioSchoolByMsid &&
      scenarioMiddleMsid != null &&
      !isNaN(scenarioMiddleMsid)
    ) {
      var stacked = buildScenarioStackedPeriods(
        weighted,
        scenarioMiddleMsid,
        scenarioSchoolByMsid,
        scenarioLastFeederRows
      );
      renderScenarioStackedEnrollmentChartIntoRoot(chartRoot, stacked, {
        noDataMsg:
          "No merged enrollment data is available from 2025-26 onward for the current selection.",
        noDataAria: "Merged enrollment data is not available.",
        ariaLabel:
          "Stacked enrollment by base school and contributing schools from 2025-26 forward.",
      });
    } else {
      var series = buildMergedEnrollmentSeriesWeighted(weighted);
      series = filterEnrollmentSeriesScenarioFuture(series);
      renderEnrollmentChartIntoRoot(chartRoot, series, {
        noDataMsg:
          "No merged enrollment data is available from 2025-26 onward for the current selection.",
        noDataAria: "Merged enrollment data is not available.",
        ariaLabel:
          "Merged enrollment bar chart from 2025-26 forward (scenario projection).",
      });
    }

    var ethEl = document.getElementById("scenario-demographics-ethnicity");
    var lunchEl = document.getElementById("scenario-demographics-lunch");
    if (!scenarioMiddleMsid || isNaN(scenarioMiddleMsid)) {
      if (ethEl) {
        ethEl.innerHTML =
          '<p class="demographics-pie-empty">Select a school to view merged demographics.</p>';
      }
      if (lunchEl) {
        lunchEl.innerHTML =
          '<p class="demographics-pie-empty">Select a school to view merged demographics.</p>';
      }
      var trEx = document.getElementById("scenario-travel-existing");
      var trSc = document.getElementById("scenario-travel-scenario");
      if (trEx) {
        trEx.innerHTML =
          '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
      }
      if (trSc) {
        trSc.innerHTML =
          '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
      }
      renderScenarioGradeSummaryTable();
      applyScenarioFeederMapHighlights();
      syncStudentHexLayer();
      return;
    }
    var agg = aggregateDemographicsMsidsWeighted(weighted);
    renderDemographicsFromAggregates(agg, ethEl, lunchEl);
    renderScenarioTravelImpactCharts();
    updateScenarioMergedKpiSummary();
    renderScenarioGradeSummaryTable();
    applyScenarioFeederMapHighlights();
    syncStudentHexLayer();
  }

  function updateScenarioSummaryText(middleProps) {
    var elP = document.getElementById("scenario-details-primary");
    var elS = document.getElementById("scenario-details-secondary");
    var elKpiPri = document.getElementById("scenario-details-kpi-primary");
    var elKpiCap = document.getElementById("scenario-details-kpi-capture");
    if (!middleProps || !elP) return;
    var pMerged = schoolPropsWithMasterType(middleProps);
    var msid =
      pMerged.SCHOOLS_ID != null && pMerged.SCHOOLS_ID !== ""
        ? Number(pMerged.SCHOOLS_ID)
        : null;
    var m = masterRow(msid);
    fillSchoolDetailsPrimarySecondary(pMerged, elP, elS);
    var hsScenario =
      msid != null && !isNaN(msid)
        ? countHomeschoolStudentsInAssignmentBoundary(msid)
        : 0;
    var kpi = getSchoolKpiDisplayParts(pMerged, m, msid, {
      includeHomeschoolInCaptureDenominator: true,
      homeschoolStudentsInBoundary: hsScenario,
    });
    if (elKpiPri) {
      elKpiPri.textContent =
        "'25-26 Enrollment: " +
        kpi.enrollmentStr +
        " | Factored Capacity: " +
        kpi.capacityStr +
        " | Utilization: " +
        kpi.utilizationStr;
      elKpiPri.classList.remove("school-details-placeholder");
      elKpiPri.title =
        "Key metrics for the selected school.";
    }
    if (elKpiCap) {
      var capScenario =
        "Assignment: " +
        kpi.assignmentStr +
        " | Other district: " +
        kpi.otherDistrictStr +
        " | Choice: " +
        kpi.choiceStr +
        " | Charter: " +
        kpi.charterStr;
      if (!kpi.captureIsChoice) {
        capScenario += " | Homeschool: " + (kpi.homeschoolStr || "—");
      }
      elKpiCap.textContent = capScenario;
      elKpiCap.classList.remove("school-details-placeholder");
      /* Tooltip for the assignment/capture percentages is intentionally
         disabled in the Enrollment Planning view. */
      elKpiCap.removeAttribute("title");
    }
  }

  /**
   * '25-26 enrollment and proportional assignment to the selected MS (rounded),
   * with proportional clamped so it never exceeds enrollment.
   * @returns {{ enr: number|null, propAmt: number|null }}
   */
  function scenarioFeederEnrollmentProportionalPair(r) {
    if (r.msid == null || isNaN(r.msid)) return { enr: null, propAmt: null };
    var enr = enrollment202526CalendarForMsid(r.msid);
    if (enr == null) return { enr: null, propAmt: null };
    var p =
      r.flowProportion != null && !isNaN(r.flowProportion)
        ? r.flowProportion
        : 1;
    var gradeFactor = scenarioGradeInclusionFactorForRow(r);
    var baseAmt = scenarioCompleteMerger
      ? Math.round(enr * gradeFactor)
      : Math.round(enr * p * gradeFactor);
    var propAmt = baseAmt;
    if (propAmt > enr) {
      console.warn(
        "[Scenario] Proportional enrollment exceeds '25-26 enrollment for MSID " +
          r.msid +
          " (" +
          propAmt +
          " > " +
          enr +
          "). Clamping proportional to enrollment."
      );
      propAmt = enr;
    }
    return { enr: enr, propAmt: propAmt };
  }

  /**
   * Remaining ES enrollment text for the feeder row (uses checkbox + merger state).
   * @param {{ enr: number|null, propAmt: number|null }} [pairOpt] from scenarioFeederEnrollmentProportionalPair to avoid duplicate work
   */
  function scenarioRemainingEsEnrollmentText(r, pairOpt) {
    if (r && r.isScenarioMiddleRow) {
      return "--";
    }
    if (!r.props || !r.hasEnrollment || r.msid == null || isNaN(r.msid)) {
      console.warn(
        "[Scenario] Feeder list row has a disabled checkbox (unexpected): " +
          String(r && r.sankeyLabel ? r.sankeyLabel : "")
      );
      return "--";
    }
    if (scenarioFeederChecked[r.msid] === false) return "--";
    var pair = pairOpt || scenarioFeederEnrollmentProportionalPair(r);
    if (pair.enr == null || pair.propAmt == null) return "--";
    var remaining = Math.max(0, pair.enr - pair.propAmt);
    return remaining.toLocaleString();
  }

  /**
   * Feeder scenario column: whole-number percent (CSV decimal e.g. 0.84 → "84%").
   * @param {number} ratioZeroToOne
   * @returns {string|null}
   */
  function scenarioUtilizationPercentStringFromDecimalRatio(ratioZeroToOne) {
    if (ratioZeroToOne == null || isNaN(ratioZeroToOne) || !isFinite(ratioZeroToOne)) {
      return null;
    }
    var utilPctDisp = Math.round(ratioZeroToOne * 100);
    return String(utilPctDisp) + "%";
  }

  /**
   * Feeder scenario: whole-number percent from headcount ÷ factored capacity.
   * @returns {string|null}
   */
  function scenarioUtilizationPercentStringFromCountOverCapacity(count, cap) {
    if (count == null || isNaN(count) || cap == null || isNaN(cap) || cap <= 0) {
      return null;
    }
    var r = count / cap;
    if (!isFinite(r) || r < 0) return null;
    var utilPctDisp = Math.round(r * 100);
    return String(utilPctDisp) + "%";
  }

  /**
   * Current 2025-26 utilization: CSV utilization_2025_26, or enrollment_2025 ÷ factored_capacity_2025_26.
   * @returns {string|null}
   */
  function scenarioFeederEsCurrentUtilizationPercentString(m, msid) {
    if (!m) return null;
    if (m.utilization_2025_26 !== "" && m.utilization_2025_26 != null) {
      var d = Number(m.utilization_2025_26);
      if (!isNaN(d)) {
        return scenarioUtilizationPercentStringFromDecimalRatio(d);
      }
    }
    var enr = enrollment202526CalendarForMsid(msid);
    var cap = m.factored_capacity_2025_26;
    var capN = cap !== "" && cap != null ? Number(cap) : NaN;
    if (enr != null && !isNaN(enr) && !isNaN(capN) && capN > 0) {
      return scenarioUtilizationPercentStringFromCountOverCapacity(enr, capN);
    }
    return null;
  }

  /**
   * e.g. "84% → 37%" (Remaining ES headcount as numerator, factored capacity as denominator for the "new" value).
   * @param {{ enr: number|null, propAmt: number|null }} [pairOpt]
   */
  function scenarioFeederUtilizationChangeText(r, pairOpt) {
    if (r && r.isScenarioMiddleRow) {
      return "--";
    }
    if (!r.props || !r.hasEnrollment || r.msid == null || isNaN(r.msid)) {
      return "--";
    }
    if (scenarioFeederChecked[r.msid] === false) {
      return "--";
    }
    var m = masterRow(r.msid);
    if (!m) {
      return "--";
    }
    var currentStr = scenarioFeederEsCurrentUtilizationPercentString(
      m,
      r.msid
    );
    var pair = pairOpt || scenarioFeederEnrollmentProportionalPair(r);
    if (pair.enr == null || pair.propAmt == null) {
      return "--";
    }
    var remaining = Math.max(0, pair.enr - pair.propAmt);
    var cap = m.factored_capacity_2025_26;
    var capN = cap !== "" && cap != null ? Number(cap) : NaN;
    var newStr = scenarioUtilizationPercentStringFromCountOverCapacity(
      remaining,
      capN
    );
    if (!newStr) {
      return "--";
    }
    if (!currentStr) {
      return "--";
    }
    return currentStr + " → " + newStr;
  }

  function updateScenarioFeederRemainingCells() {
    var ul = document.getElementById("scenario-feeder-list");
    if (!ul || !scenarioLastFeederRows.length) return;
    var items = ul.querySelectorAll(".scenario-feeder-item");
    for (
      var i = 0;
      i < scenarioLastFeederRows.length && i < items.length;
      i++
    ) {
      var row = scenarioLastFeederRows[i];
      var pairP = scenarioFeederEnrollmentProportionalPair(row);
      var rem = items[i].querySelector(".scenario-feeder-remaining");
      if (rem) {
        rem.textContent = scenarioRemainingEsEnrollmentText(row, pairP);
      }
      var util = items[i].querySelector(".scenario-feeder-util-change");
      if (util) {
        util.textContent = scenarioFeederUtilizationChangeText(row, pairP);
      }
      /* Refresh "(enrollment: ...; proportional: ...)" text — proportional reflects
       * current grade toggles and complete-merger state. The enrollment paren is
       * the last `.scenario-feeder-name__paren` element inside the row's label. */
      var parens = items[i].querySelectorAll(
        ".scenario-feeder-label .scenario-feeder-name__paren"
      );
      if (parens.length && !row.isScenarioMiddleRow) {
        var paren = parens[parens.length - 1];
        var enrStr = pairP.enr != null ? pairP.enr.toLocaleString() : "—";
        var propStr = pairP.propAmt != null ? pairP.propAmt.toLocaleString() : "—";
        paren.textContent = scenarioUseFeederChainOnly
          ? "('25-26 enrollment: " + enrStr + "; proportional: " + propStr + ")"
          : "('25-26 enrollment: " + enrStr + ")";
      }
    }
  }

  /** Parse grades_served (e.g. K-6, 7-8, 9-12) into sorted canonical codes. */
  function parseGradesServedToCanonList(raw) {
    var norm = normalizeGradesServedForUi(raw);
    if (!norm) return [];
    var t = String(norm).trim();
    /* Single grade token. */
    if (!/[-–]/.test(t)) {
      var single = canonicalStudentGradeCode(t);
      return single ? [single] : [];
    }
    var parts = t.split(/[-–]/);
    if (parts.length < 2) return [];
    var lo = canonicalStudentGradeCode(parts[0].trim());
    var hi = canonicalStudentGradeCode(parts[parts.length - 1].trim());
    if (!lo || !hi) return [];
    var loOrd = charterGradeCanonToOrdinal(lo);
    var hiOrd = charterGradeCanonToOrdinal(hi);
    if (loOrd == null || hiOrd == null || loOrd > hiOrd) return [];
    var out = [];
    for (var o = loOrd; o <= hiOrd; o++) {
      if (o === -2) out.push("PK");
      else if (o === -1) out.push("K");
      else if (o >= 1 && o <= 9) out.push(o < 10 ? "0" + o : String(o));
      else if (o >= 10 && o <= 12) out.push(String(o));
    }
    return out;
  }

  /** Grades that are off by default in the scenario grade chips. PK is offered as
   *  a toggle for schools that enroll PK students, but stays unchecked until the
   *  user opts in. All other grades default on. */
  function scenarioGradeDefaultChecked(gradeCanon) {
    return gradeCanon !== "PK";
  }

  var scenarioPkStudentMsidCache = Object.create(null);

  /** True when the school (by attendance MSID) enrolls at least one PK student. */
  function scenarioMsidHasPkStudent(msid) {
    if (msid == null || isNaN(msid)) return false;
    var key = String(msid);
    if (Object.prototype.hasOwnProperty.call(scenarioPkStudentMsidCache, key)) {
      return scenarioPkStudentMsidCache[key];
    }
    var byGrade = scenarioEnrollmentByGradeForMsid(msid);
    var has = !!(byGrade && byGrade.PK > 0);
    scenarioPkStudentMsidCache[key] = has;
    return has;
  }

  /** Grade codes served by a school (from master CSV grades_served), plus PK for
   *  any school that enrolls at least one PK student even when grades_served omits it. */
  function scenarioGradeCodesForMsid(msid) {
    var m = masterRow(msid);
    if (!m) return [];
    var codes = parseGradesServedToCanonList(m.grades_served);
    if (codes.indexOf("PK") === -1 && scenarioMsidHasPkStudent(msid)) {
      codes = ["PK"].concat(codes);
    }
    return codes;
  }

  /** Union of grade codes served by all scenario rows (used as the display universe for chips). */
  function scenarioUnionGradeCodesFromCheckedRows() {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null) continue;
      var codes = scenarioGradeCodesForMsid(r.msid);
      for (var c = 0; c < codes.length; c++) {
        if (!seen[codes[c]]) {
          seen[codes[c]] = true;
          out.push(codes[c]);
        }
      }
    }
    out.sort(function (a, b) {
      var oa = charterGradeCanonToOrdinal(a);
      var ob = charterGradeCanonToOrdinal(b);
      return (oa != null ? oa : 99) - (ob != null ? ob : 99);
    });
    return out;
  }

  /** True when a grade from `msid` is included in the merged scenario. Applies
   *  to every school, including the base school (grades default to on, but can
   *  be toggled off). The `isBaseRow` argument is retained for call-site
   *  compatibility and no longer forces inclusion. */
  function scenarioGradeIncludedForMsid(msid, gradeCanon, isBaseRow) {
    if (msid == null || isNaN(msid) || !gradeCanon) return true;
    var byMs = scenarioGradeCheckedByMsid[msid];
    var stored = byMs ? byMs[gradeCanon] : undefined;
    if (stored === true) return true;
    if (stored === false) return false;
    return scenarioGradeDefaultChecked(gradeCanon);
  }

  /** Per-grade student counts for a school's attendance MSID from student hex export. */
  function scenarioEnrollmentByGradeForMsid(msid) {
    var byGrade = Object.create(null);
    if (
      !STUDENT_HEX_INDEX ||
      !STUDENT_HEX_INDEX.detailsByMsid ||
      msid == null ||
      isNaN(msid)
    ) {
      return byGrade;
    }
    var perHex = STUDENT_HEX_INDEX.detailsByMsid[String(msid)];
    if (!perHex) return byGrade;
    for (var hexKey in perHex) {
      if (!Object.prototype.hasOwnProperty.call(perHex, hexKey)) continue;
      var arr = perHex[hexKey];
      for (var i = 0; i < arr.length; i++) {
        var gc = canonicalStudentGradeCode(arr[i].Grade);
        if (!gc) continue;
        byGrade[gc] = (byGrade[gc] || 0) + 1;
      }
    }
    return byGrade;
  }

  /**
   * Fraction of a school's '25-26 enrollment that is included given grade toggles.
   * Uses student-hex grade counts when available; otherwise uniform across grades_served.
   */
  function scenarioGradeInclusionFactorForRow(r) {
    if (!r || r.msid == null || isNaN(r.msid)) return 1;
    var byGrade = scenarioEnrollmentByGradeForMsid(r.msid);
    var gradeKeys = Object.keys(byGrade);
    if (gradeKeys.length) {
      var total = 0;
      var included = 0;
      for (var i = 0; i < gradeKeys.length; i++) {
        var g = gradeKeys[i];
        var c = byGrade[g] || 0;
        total += c;
        if (scenarioGradeIncludedForMsid(r.msid, g, false)) included += c;
      }
      if (total <= 0) return 1;
      return included / total;
    }
    var served = scenarioGradeCodesForMsid(r.msid);
    if (!served.length) return 1;
    var inc = 0;
    for (var s = 0; s < served.length; s++) {
      if (scenarioGradeIncludedForMsid(r.msid, served[s], false)) inc++;
    }
    return inc / served.length;
  }

  /** Build per-school grade toggle chips for the scenario feeder list. */
  function buildScenarioGradeChipsForRow(r, baseMsid) {
    var unionGrades = scenarioUnionGradeCodesFromCheckedRows();
    if (!unionGrades.length) return null;
    var served = scenarioGradeCodesForMsid(r.msid);
    if (!served.length) return null;
    var servedSet = Object.create(null);
    for (var si = 0; si < served.length; si++) servedSet[served[si]] = true;
    var wrap = document.createElement("div");
    wrap.className = "scenario-feeder-grade-chips";
    for (var gi = 0; gi < unionGrades.length; gi++) {
      var gc = unionGrades[gi];
      if (!servedSet[gc]) continue;
      var chip = document.createElement("label");
      chip.className = "scenario-feeder-grade-chip";
      var inp = document.createElement("input");
      inp.type = "checkbox";
      inp.className = "scenario-feeder-grade-chip-input";
      inp.dataset.msid = String(r.msid);
      inp.dataset.gradeCanon = gc;
      var byMs = scenarioGradeCheckedByMsid[r.msid] || Object.create(null);
      var storedChk = byMs[gc];
      inp.checked =
        storedChk == null ? scenarioGradeDefaultChecked(gc) : storedChk !== false;
      inp.addEventListener("change", function (e) {
        var tgt = e.target;
        var ms = Number(tgt && tgt.dataset ? tgt.dataset.msid : NaN);
        var gcx = tgt && tgt.dataset ? tgt.dataset.gradeCanon : null;
        if (isNaN(ms) || !gcx) return;
        if (!scenarioGradeCheckedByMsid[ms]) {
          scenarioGradeCheckedByMsid[ms] = Object.create(null);
        }
        scenarioGradeCheckedByMsid[ms][gcx] = tgt.checked;
        var chipEl = tgt.closest(".scenario-feeder-grade-chip");
        if (chipEl) chipEl.classList.toggle("is-off", !tgt.checked);
        applyScenarioMergedUpdates();
        updateScenarioFeederRemainingCells();
      });
      var span = document.createElement("span");
      span.textContent = travelShedGradeDisplayLabel(gc);
      chip.appendChild(inp);
      chip.appendChild(span);
      if (!inp.checked) chip.classList.add("is-off");
      wrap.appendChild(chip);
    }
    return wrap.childNodes.length ? wrap : null;
  }

  /** Update scenario KPI line with merged enrollment using base school's factored capacity. */
  function updateScenarioMergedKpiSummary() {
    var elKpiPri = document.getElementById("scenario-details-kpi-primary");
    if (!elKpiPri || scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) return;
    var baseM = masterRow(scenarioMiddleMsid);
    if (!baseM) return;
    var mergedEnr = 0;
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null) continue;
      if (scenarioFeederChecked[r.msid] === false) continue;
      var pair = scenarioFeederEnrollmentProportionalPair(r);
      if (pair.propAmt != null) mergedEnr += pair.propAmt;
    }
    var capStr = "—";
    if (
      baseM.factored_capacity_2025_26 !== "" &&
      baseM.factored_capacity_2025_26 != null
    ) {
      var cn = Number(baseM.factored_capacity_2025_26);
      if (!isNaN(cn)) capStr = cn.toLocaleString();
    }
    var utilStr = "—";
    if (
      baseM.factored_capacity_2025_26 !== "" &&
      baseM.factored_capacity_2025_26 != null
    ) {
      var capN = Number(baseM.factored_capacity_2025_26);
      if (!isNaN(capN) && capN > 0) {
        var u = scenarioUtilizationPercentStringFromCountOverCapacity(
          mergedEnr,
          capN
        );
        if (u) utilStr = u;
      }
    }
    elKpiPri.textContent =
      "'25-26 Merged Enrollment: " +
      mergedEnr.toLocaleString() +
      " | Factored Capacity (base): " +
      capStr +
      " | Scenario Utilization: " +
      utilStr;
    elKpiPri.classList.remove("school-details-placeholder");
    elKpiPri.title =
      "Merged enrollment sums checked schools (with grade toggles and merger rules). Utilization uses the base school's factored capacity.";
  }

  function renderScenarioFeederList(middleMsid, rows) {
    var ul = document.getElementById("scenario-feeder-list");
    var alerts = document.getElementById("scenario-data-alerts");
    if (!ul) return;
    ul.innerHTML = "";
    var colorAssignments = assignScenarioFeederColorsByType(rows, middleMsid);
    var colorByMsid = colorAssignments.byMsid;
    var baseM = masterRow(middleMsid);
    var baseLevel = baseM && baseM.school_level
      ? String(baseM.school_level).trim().toLowerCase()
      : "elementary";
    var baseSwatchColor = scenarioBaseSolidColorForLevel(baseLevel);
    var warnings = [];
    var elemRowCount = 0;
    for (var wi = 0; wi < rows.length; wi++) {
      if (!rows[wi].isScenarioMiddleRow) elemRowCount++;
    }
    if (elemRowCount === 0) {
      warnings.push(
        scenarioUseFeederChainOnly
          ? "No existing feeder-chain schools were found for this selection."
          : "No eligible adjacent schools were found within the 10-closest list for this base school."
      );
    }
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.props) {
        console.warn(
          '[Scenario] Feeder elementary "' +
            r.sankeyLabel +
            '" was not matched to a GeoJSON elementary school.'
        );
        warnings.push(
          "No map/school match for feeder label \"" +
            escapeHtml(r.sankeyLabel) +
            "\"."
        );
      }
      if (r.msid != null && !r.hasEnrollment) {
        console.warn(
          '[Scenario] Feeder elementary "' +
            r.sankeyLabel +
            '" (MSID ' +
            r.msid +
            ") has no enrollment row in data/school_master.csv."
        );
        warnings.push(
          "No enrollment data available for \"" +
            escapeHtml(r.sankeyLabel) +
            "\"."
        );
      }
      var li = document.createElement("li");
      li.className = "scenario-feeder-item";
      if (r.isScenarioMiddleRow) li.classList.add("scenario-feeder-item--base");
      var id = "scenario-feeder-" + middleMsid + "-" + i;
      var label = document.createElement("label");
      label.className = "scenario-feeder-label";
      var swatch = document.createElement("span");
      swatch.className = "scenario-feeder-swatch";
      swatch.setAttribute("aria-hidden", "true");
      if (r.isScenarioMiddleRow) {
        swatch.style.background = baseSwatchColor;
      } else if (
        r.msid != null &&
        !isNaN(r.msid) &&
        colorByMsid[r.msid]
      ) {
        swatch.style.background = colorByMsid[r.msid].color;
      } else {
        swatch.style.background = "#e5e7eb";
      }
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      if (r.msid != null && !isNaN(r.msid)) {
        cb.dataset.msid = String(r.msid);
      }
      var displayName = r.props
        ? schoolNameForSelect(r.props)
        : r.sankeyLabel;
      if (!r.props || !r.hasEnrollment || r.msid == null) {
        cb.disabled = true;
        cb.checked = false;
      } else {
        cb.checked = scenarioFeederChecked[r.msid] !== false;
        cb.addEventListener("change", function (e) {
          var tgt = e.target;
          var ms = Number(tgt && tgt.dataset ? tgt.dataset.msid : NaN);
          if (isNaN(ms)) return;
          scenarioFeederChecked[ms] = tgt.checked;
          applyScenarioMergedUpdates();
          updateScenarioFeederRemainingCells();
        });
      }
      label.appendChild(swatch);
      label.appendChild(cb);
      var span = document.createElement("span");
      span.className = "scenario-feeder-name";
      var pairPP = scenarioFeederEnrollmentProportionalPair(r);
      var enr = pairPP.enr;
      var propAmt = pairPP.propAmt;
      var enrStr = enr != null ? enr.toLocaleString() : "—";
      var propStr = propAmt != null ? propAmt.toLocaleString() : "—";
      span.appendChild(document.createTextNode(displayName + " "));
      var parenSpan = document.createElement("span");
      parenSpan.className = "scenario-feeder-name__paren";
      /* "Proportional" only matters in feeder-chain mode (uses historical advancement share).
       * Otherwise we always assume 100% absorption, so we simplify the parenthetical. */
      if (scenarioUseFeederChainOnly && !r.isScenarioMiddleRow) {
        parenSpan.textContent =
          "('25-26 enrollment: " + enrStr + "; proportional: " + propStr + ")";
      } else {
        parenSpan.textContent = "('25-26 enrollment: " + enrStr + ")";
      }
      span.appendChild(parenSpan);
      label.appendChild(span);
      li.appendChild(label);
      var remSpan = document.createElement("span");
      remSpan.className = "scenario-feeder-name scenario-feeder-remaining";
      remSpan.setAttribute(
        "aria-labelledby",
        "scenario-feeder-remaining-heading"
      );
      if (r.isScenarioMiddleRow) {
        remSpan.setAttribute(
          "title",
          "Not applicable — this column is for remaining enrollment at feeder elementary schools."
        );
      }
      remSpan.textContent = scenarioRemainingEsEnrollmentText(r, pairPP);
      var metricsWrap = document.createElement("div");
      metricsWrap.className = "scenario-feeder-item-metrics";

      /* Per-row '25-26 enrollment for the mobile two-column layout's left
         column. Hidden on desktop, where it shows in the name parenthetical. */
      var enrSpan = document.createElement("span");
      enrSpan.className = "scenario-feeder-name scenario-feeder-enroll";
      enrSpan.setAttribute("title", "This school's 2025-26 enrollment.");
      enrSpan.textContent =
        pairPP.enr != null ? pairPP.enr.toLocaleString() : "\u2014";
      metricsWrap.appendChild(enrSpan);

      var gradeSpan = document.createElement("span");
      gradeSpan.className = "scenario-feeder-name scenario-feeder-grade";
      gradeSpan.setAttribute(
        "aria-labelledby",
        "scenario-feeder-grade-heading"
      );
      var feederMaster =
        r.msid != null && !isNaN(r.msid) ? masterRow(r.msid) : null;
      var feederGradeRaw =
        feederMaster && feederMaster.school_grade_2025 != null
          ? String(feederMaster.school_grade_2025).trim()
          : "";
      var feederGradeText =
        feederGradeRaw && feederGradeRaw.toUpperCase() !== "N/A"
          ? feederGradeRaw
          : "N/A";
      gradeSpan.textContent = feederGradeText;
      gradeSpan.setAttribute(
        "title",
        r.isScenarioMiddleRow
          ? "Florida Department of Education 2025 school grade (A-F) based on academic performance."
          : "Florida Department of Education 2025 school grade (A-F) for this feeder elementary, based on academic performance."
      );
      metricsWrap.appendChild(gradeSpan);

      metricsWrap.appendChild(remSpan);
      var utilSpan = document.createElement("span");
      utilSpan.className = "scenario-feeder-util-change";
      utilSpan.setAttribute("aria-labelledby", "scenario-feeder-util-heading");
      utilSpan.setAttribute(
        "title",
        r.isScenarioMiddleRow
          ? "Not applicable — remaining elementary enrollment and utilization change apply to feeder elementary schools only."
          : "2025-26 utilization vs. scenario utilization (Remaining Feeder School Enrollment ÷ factored capacity, 2025-26). Percentages are rounded to whole numbers."
      );
      utilSpan.textContent = scenarioFeederUtilizationChangeText(r, pairPP);
      metricsWrap.appendChild(utilSpan);
      li.appendChild(metricsWrap);
      if (r.hasEnrollment && r.msid != null) {
        var chipsWrap = buildScenarioGradeChipsForRow(r, middleMsid);
        if (chipsWrap) li.appendChild(chipsWrap);
      }
      if (!r.props) {
        var un = document.createElement("span");
        un.className = "scenario-feeder-flag";
        un.textContent = "No school match";
        li.appendChild(un);
      } else if (!r.hasEnrollment || r.msid == null) {
        var fl = document.createElement("span");
        fl.className = "scenario-feeder-flag";
        fl.textContent = "No enrollment row";
        li.appendChild(fl);
      }
      ul.appendChild(li);
    }
    if (!scenarioUseFeederChainOnly) {
      var addLi = buildScenarioFeederAddRowElement(middleMsid, rows);
      if (addLi) ul.appendChild(addLi);
    }
    if (alerts) {
      if (warnings.length) {
        alerts.hidden = false;
        alerts.innerHTML =
          '<strong class="scenario-data-alerts-title">Data checks</strong><ul class="scenario-data-alerts-list"><li>' +
          warnings.join("</li><li>") +
          "</li></ul>";
      } else {
        alerts.hidden = true;
        alerts.innerHTML = "";
      }
    }
  }

  /**
   * Builds the "Add another school" `<li>` element at the bottom of the
   * contributing schools list. Only used when scenarioUseFeederChainOnly is
   * false. Returns null when no other addable schools remain.
   */
  function buildScenarioFeederAddRowElement(middleMsid, currentRows) {
    var fc = scenarioCachedSchoolsFc;
    if (!fc || !fc.features) return null;
    var taken = Object.create(null);
    if (middleMsid != null && !isNaN(middleMsid)) taken[Number(middleMsid)] = true;
    for (var ri = 0; ri < (currentRows || []).length; ri++) {
      var rr = currentRows[ri];
      if (rr && rr.msid != null && !isNaN(rr.msid)) taken[Number(rr.msid)] = true;
    }
    var options = [];
    for (var fi = 0; fi < fc.features.length; fi++) {
      var pr = fc.features[fi].properties;
      if (!pr || pr.SCHOOLS_ID == null) continue;
      var ms = Number(pr.SCHOOLS_ID);
      if (isNaN(ms) || taken[ms]) continue;
      /* Eligible adders: traditional schools with a boundary polygon and an
         enrollment row (same gate as the base-school dropdown). */
      if (!isScenarioDestinationSchoolMsid(ms)) continue;
      if (!schoolHasEnrollmentWorkbook(ms)) continue;
      options.push({ msid: ms, name: schoolNameForSelect(pr) });
    }
    if (!options.length) return null;
    options.sort(function (a, b) {
      return a.name.localeCompare(b.name);
    });

    var li = document.createElement("li");
    li.className = "scenario-feeder-item scenario-feeder-item--add";
    li.setAttribute(
      "title",
      "Search for and add any traditional school with an assignment boundary to your scenario."
    );

    var row = document.createElement("div");
    row.className = "scenario-feeder-add-row";

    var prefix = document.createElement("span");
    prefix.className = "scenario-feeder-add-prefix";
    prefix.textContent = "Add another school:";
    row.appendChild(prefix);

    var listId = "scenario-feeder-add-options-" + (middleMsid || 0);
    var input = document.createElement("input");
    input.type = "text";
    input.id = "scenario-feeder-add-input";
    input.className = "scenario-feeder-add-input";
    input.setAttribute("list", listId);
    input.setAttribute("placeholder", "Type a school name…");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", "Add another contributing school by name");
    row.appendChild(input);

    var datalist = document.createElement("datalist");
    datalist.id = listId;
    var nameToMsid = Object.create(null);
    for (var oi = 0; oi < options.length; oi++) {
      var opt = document.createElement("option");
      opt.value = options[oi].name;
      datalist.appendChild(opt);
      nameToMsid[options[oi].name.toLowerCase()] = options[oi].msid;
    }
    row.appendChild(datalist);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "scenario-feeder-add-btn";
    btn.className = "scenario-feeder-add-btn";
    btn.textContent = "Add";
    btn.disabled = true;
    row.appendChild(btn);

    var msg = document.createElement("p");
    msg.className = "scenario-feeder-add-msg";
    msg.setAttribute("aria-live", "polite");
    msg.hidden = true;

    function resolveMsid() {
      var v = (input.value || "").trim().toLowerCase();
      return v && nameToMsid[v] != null ? nameToMsid[v] : null;
    }
    function syncBtn() {
      var ok = resolveMsid() != null;
      btn.disabled = !ok;
      if (!ok && input.value) {
        msg.hidden = false;
        msg.textContent =
          "No school matches that name. Choose one from the suggestions list.";
      } else {
        msg.hidden = true;
        msg.textContent = "";
      }
    }
    function doAdd() {
      var ms2 = resolveMsid();
      if (ms2 == null) {
        syncBtn();
        return;
      }
      scenarioUserAddedFeederMsids.push(Number(ms2));
      /* User explicitly added the school → default to checked-on. */
      scenarioFeederChecked[Number(ms2)] = true;
      input.value = "";
      msg.hidden = true;
      refreshScenarioContributingSchoolsForToggle();
    }
    input.addEventListener("input", syncBtn);
    input.addEventListener("change", syncBtn);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        doAdd();
      }
    });
    btn.addEventListener("click", doAdd);

    li.appendChild(row);
    li.appendChild(msg);
    return li;
  }

  function resetScenarioPanel() {
    scenarioMiddleMsid = null;
    scenarioLastFeederRows = [];
    scenarioFeederChecked = {};
    scenarioCompleteMerger = false;
    scenarioGradeSummaryHoverLabel = null;
    scenarioGradeSummaryLockedLabel = null;
    scenarioUserAddedFeederMsids = [];
    var mergerCb = document.getElementById("scenario-complete-merger");
    if (mergerCb) mergerCb.checked = false;
    var p1 = document.getElementById("scenario-details-primary");
    if (p1) {
      p1.textContent =
        "Name of School | Grades Served | Address | 2025 School Grade";
      p1.classList.add("school-details-placeholder");
    }
    var p2 = document.getElementById("scenario-details-secondary");
    if (p2) {
      p2.textContent =
        "Year Opened | Age of Site | Year of Last Major Renovation | Size of Site (Acres) | Count of On-Site BPS Employees";
      p2.classList.add("school-details-placeholder");
      p2.removeAttribute("title");
    }
    var p3a = document.getElementById("scenario-details-kpi-primary");
    if (p3a) {
      p3a.textContent = "'25-26 Enrollment: — | Factored Capacity: — | Utilization: —";
      p3a.classList.add("school-details-placeholder");
      p3a.removeAttribute("title");
    }
    var p3b = document.getElementById("scenario-details-kpi-capture");
    if (p3b) {
      p3b.textContent =
        "Assignment: — | Other district: — | Choice: — | Charter: — | Homeschool: —";
      p3b.classList.add("school-details-placeholder");
      p3b.removeAttribute("title");
    }
    var alerts = document.getElementById("scenario-data-alerts");
    if (alerts) {
      alerts.hidden = true;
      alerts.innerHTML = "";
    }
    var ul = document.getElementById("scenario-feeder-list");
    if (ul) ul.innerHTML = "";
    var chartRoot = document.getElementById("scenario-enrollment-chart");
    if (chartRoot) {
      teardownScenarioStackedChart(chartRoot);
      chartRoot.classList.remove("enrollment-chart--stacked");
      chartRoot.innerHTML =
        '<p class="enrollment-chart-empty">Select a school to view merged enrollment trends.</p>';
      chartRoot.removeAttribute("aria-label");
    }
    var ethEl = document.getElementById("scenario-demographics-ethnicity");
    var lunchEl = document.getElementById("scenario-demographics-lunch");
    if (ethEl) {
      ethEl.innerHTML =
        '<p class="demographics-pie-empty">Select a school to view merged demographics.</p>';
    }
    if (lunchEl) {
      lunchEl.innerHTML =
        '<p class="demographics-pie-empty">Select a school to view merged demographics.</p>';
    }
    var trExReset = document.getElementById("scenario-travel-existing");
    var trScReset = document.getElementById("scenario-travel-scenario");
    if (trExReset) {
      trExReset.innerHTML =
        '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
    }
    if (trScReset) {
      trScReset.innerHTML =
        '<p class="travel-hist-empty">Select a school to view travel distances.</p>';
    }
    var scTrTitle = document.getElementById(
      "scenario-travel-scenario-chart-title"
    );
    if (scTrTitle) {
      scTrTitle.textContent =
        "Scenario Travel Distances to Selected School";
    }
    var gradeWrap = document.getElementById("scenario-grade-summary-table-wrap");
    if (gradeWrap) {
      gradeWrap.innerHTML =
        '<p class="scenario-grade-summary-empty">Select a school to view enrollment by grade.</p>';
    }
    setScenarioGradeSummaryHeadingYear(SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL);
    applyScenarioFeederMapHighlights();
    syncStudentHexLayer();
    syncTravelShedLayerFilter();
  }

  function runScenarioForMiddleMsid(msid, schoolByMsid, schoolsFc) {
    scenarioSchoolByMsid = schoolByMsid;
    scenarioMiddleMsid = msid;
    scenarioFeederChecked = {};
    scenarioGradeCheckedByMsid = Object.create(null);
    scenarioGradeSummaryHoverLabel = null;
    scenarioGradeSummaryLockedLabel = null;
    scenarioUserAddedFeederMsids = [];
    scenarioCachedSchoolsFc = schoolsFc || scenarioCachedSchoolsFc;
    var p = schoolByMsid[msid];
    if (!p) return;
    scenarioLastFeederRows = buildScenarioFeederRowsForDestination(
      p,
      msid,
      schoolsFc
    );
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (r.hasEnrollment && r.msid != null) {
        /* Base school is checked-on by default; non-base contributing schools are off by default. */
        scenarioFeederChecked[r.msid] = !!r.isScenarioMiddleRow;
      }
    }
    updateScenarioSummaryText(p);
    syncScenarioMergerControlVisibility();
    renderScenarioFeederList(msid, scenarioLastFeederRows);
    applyScenarioMergedUpdates();
    applySelectedSchoolHighlight(msid);
    zoomToSchoolAssignment(msid, schoolByMsid);
    syncStudentHexLayer();
    syncTravelShedLayerFilter();
  }

  /** The "Complete merger" checkbox is always visible alongside "Limit consolidation",
   *  but it is only selectable when feeder-chain mode is on (since the merger semantics
   *  rely on having a defined historical advancement share). */
  function syncScenarioMergerControlVisibility() {
    var mergerCtrl = document.getElementById("scenario-merger-control");
    if (!mergerCtrl) return;
    mergerCtrl.hidden = false;
    var enabled = !!scenarioUseFeederChainOnly;
    mergerCtrl.classList.toggle("is-disabled", !enabled);
    var mc = document.getElementById("scenario-complete-merger");
    if (mc) {
      mc.disabled = !enabled;
      if (!enabled) {
        scenarioCompleteMerger = false;
        mc.checked = false;
      }
    }
  }

  /** Rebuild contributing-schools list when the feeder-chain toggle changes (preserves base school). */
  function refreshScenarioContributingSchoolsForToggle() {
    if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) return;
    if (!scenarioSchoolByMsid || !scenarioCachedSchoolsFc) return;
    var p = scenarioSchoolByMsid[scenarioMiddleMsid];
    if (!p) return;
    scenarioLastFeederRows = buildScenarioFeederRowsForDestination(
      p, scenarioMiddleMsid, scenarioCachedSchoolsFc
    );
    /* Preserve previously-checked schools when possible. */
    var newChecked = {};
    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null) continue;
      if (r.isScenarioMiddleRow) {
        newChecked[r.msid] = true;
      } else {
        newChecked[r.msid] = scenarioFeederChecked[r.msid] === true;
      }
    }
    scenarioFeederChecked = newChecked;
    syncScenarioMergerControlVisibility();
    renderScenarioFeederList(scenarioMiddleMsid, scenarioLastFeederRows);
    applyScenarioMergedUpdates();
  }

  function populateScenarioSchoolSelect(schoolsFc) {
    var sel = document.getElementById("scenario-school-select");
    if (!sel || !schoolsFc || !schoolsFc.features) return;
    sel.innerHTML = "";
    var placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Select a school";
    sel.appendChild(placeholder);

    var schools = [];
    schoolsFc.features.forEach(function (ft) {
      var pr = ft.properties;
      if (!pr || pr.SCHOOLS_ID == null) return;
      var msid = Number(pr.SCHOOLS_ID);
      if (isNaN(msid)) return;
      if (!isScenarioDestinationSchoolMsid(msid)) return;
      if (schoolIsChoiceFromProps(pr)) return;
      schools.push(pr);
    });
    schools.sort(function (a, b) {
      var na = schoolDisplayNameFromProps(a).toLowerCase();
      var nb = schoolDisplayNameFromProps(b).toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    schools.forEach(function (pr) {
      var opt = document.createElement("option");
      opt.value = String(pr.SCHOOLS_ID);
      opt.textContent = schoolNameForSelect(pr);
      sel.appendChild(opt);
    });
    sel.value = "";
    sel.disabled = false;
  }

  /**
   * @returns {{ id: string, name: string, group: string }[]}
   */
  function buildFeedbackSchoolCommunityEntries(schoolsFc, charterFc, privateFc) {
    var entries = [];
    var seen = {};

    function pushEntry(id, name, group) {
      var nm = name != null ? String(name).trim() : "";
      if (!id || !nm || seen[id]) return;
      seen[id] = true;
      entries.push({ id: id, name: nm, group: group });
    }

    if (schoolsFc && schoolsFc.features) {
      for (var i = 0; i < schoolsFc.features.length; i++) {
        var p = schoolsFc.features[i].properties;
        if (!p || p.SCHOOLS_ID == null || p.SCHOOLS_ID === "") continue;
        var msid = Number(p.SCHOOLS_ID);
        if (isNaN(msid)) continue;
        var ab = String(p.SchAB_Type || "").toUpperCase();
        var group =
          ab === "CHOICE" ? "Choice schools" : "Traditional schools";
        pushEntry(
          "district:" + String(msid),
          schoolDisplayNameFromProps(p),
          group
        );
      }
    }

    if (charterFc && charterFc.features) {
      for (var ci = 0; ci < charterFc.features.length; ci++) {
        var cp = charterFc.features[ci].properties;
        if (!cp || cp.SCHOOLS_ID == null || cp.SCHOOLS_ID === "") continue;
        var cmsid = Number(cp.SCHOOLS_ID);
        if (isNaN(cmsid)) continue;
        pushEntry(
          "charter:" + String(cmsid),
          schoolDisplayNameFromProps(cp) || "Charter school",
          "Charter schools"
        );
      }
    }

    if (privateFc && privateFc.features) {
      for (var pi = 0; pi < privateFc.features.length; pi++) {
        var pp = privateFc.features[pi].properties;
        if (!pp) continue;
        var cod =
          pp.School_Cod != null && String(pp.School_Cod).trim() !== ""
            ? String(pp.School_Cod).trim()
            : "fid-" + String(pp.FID != null ? pp.FID : pi);
        var rawName = pp.School_Nam != null ? String(pp.School_Nam) : "";
        var privName = formatSchoolDisplayName(
          standardCapitalization(expandElemSchoolName(rawName))
        );
        pushEntry("private:" + cod, privName || "Private school", "Private schools");
      }
    }

    return entries;
  }

  function feedbackSchoolCommunityChipLabel(entry) {
    if (!entry) return "";
    var id = entry.id || "";
    if (id.indexOf("district:") === 0 || id.indexOf("charter:") === 0) {
      var msid = parseInt(id.split(":")[1], 10);
      if (!isNaN(msid)) {
        var m = masterRow(msid);
        if (m && m.school_name) {
          var ab = eseTableAbbreviatedSchoolName(m);
          if (ab) return ab;
        }
      }
    }
    if (id.indexOf("private:") === 0) {
      var nm = String(entry.name || "");
      var base = nm
        .replace(/\s+School$/i, "")
        .replace(/\s+Academy$/i, "")
        .trim();
      if (base.length > 28) {
        return base.slice(0, 26).trim() + "…";
      }
      return base || nm;
    }
    return entry.name || "";
  }

  function attachFeedbackSchoolCommunityChipLabels(entries) {
    for (var i = 0; i < entries.length; i++) {
      entries[i].chipLabel = feedbackSchoolCommunityChipLabel(entries[i]);
    }
    return entries;
  }

  function feedbackSchoolCommunityById(id) {
    for (var i = 0; i < FEEDBACK_SCHOOL_COMMUNITY_CATALOG.length; i++) {
      if (FEEDBACK_SCHOOL_COMMUNITY_CATALOG[i].id === id) {
        return FEEDBACK_SCHOOL_COMMUNITY_CATALOG[i];
      }
    }
    return null;
  }

  function setFeedbackSchoolCommunitiesTriggerText(text) {
    var el = document.querySelector(
      "#feedback-school-combobox-trigger .feedback-school-combobox__trigger-text"
    );
    if (el) el.textContent = text;
  }

  function syncFeedbackSchoolCommunitiesHiddenSelect() {
    var sel = document.getElementById("feedback-school-communities");
    if (!sel) return;
    sel.innerHTML = "";
    for (var k in FEEDBACK_SCHOOL_COMMUNITIES_SELECTED) {
      if (
        !Object.prototype.hasOwnProperty.call(
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED,
          k
        )
      ) {
        continue;
      }
      var opt = document.createElement("option");
      opt.value = k;
      opt.selected = true;
      opt.textContent = FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[k].name;
      sel.appendChild(opt);
    }
  }

  function renderFeedbackSchoolCommunityChips() {
    var root = document.getElementById("feedback-school-communities-chips");
    if (!root) return;
    root.innerHTML = "";
    var keys = Object.keys(FEEDBACK_SCHOOL_COMMUNITIES_SELECTED).sort(
      function (a, b) {
        var la =
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[a].chipLabel ||
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[a].name;
        var lb =
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[b].chipLabel ||
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[b].name;
        return la.localeCompare(lb);
      }
    );
    for (var i = 0; i < keys.length; i++) {
      var ent = FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[keys[i]];
      var chip = document.createElement("span");
      chip.className = "feedback-school-chip";
      var lab = document.createElement("span");
      lab.className = "feedback-school-chip__label";
      lab.textContent = ent.chipLabel || ent.name;
      var sep = document.createElement("span");
      sep.className = "feedback-school-chip__sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "|";
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "feedback-school-chip__remove";
      rm.setAttribute("data-school-id", ent.id);
      rm.setAttribute(
        "aria-label",
        "Remove " + (ent.chipLabel || ent.name)
      );
      rm.textContent = "×";
      chip.appendChild(lab);
      chip.appendChild(sep);
      chip.appendChild(rm);
      root.appendChild(chip);
    }
  }

  function renderFeedbackSchoolCommunitiesList() {
    var listEl = document.getElementById("feedback-school-combobox-list");
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!FEEDBACK_SCHOOL_COMMUNITY_CATALOG.length) {
      var empty = document.createElement("div");
      empty.className = "feedback-school-combobox__empty";
      empty.textContent = "No schools loaded";
      listEl.appendChild(empty);
      return;
    }

    var clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "feedback-school-combobox__option feedback-school-combobox__option--meta";
    clearBtn.setAttribute("role", "option");
    clearBtn.setAttribute("data-school-id", "");
    clearBtn.textContent = "Prefer not to answer";
    listEl.appendChild(clearBtn);

    var groupOrder = [
      "Traditional schools",
      "Choice schools",
      "Charter schools",
      "Private schools",
    ];
    var byGroup = {};
    for (var gi = 0; gi < groupOrder.length; gi++) {
      byGroup[groupOrder[gi]] = [];
    }
    for (var ei = 0; ei < FEEDBACK_SCHOOL_COMMUNITY_CATALOG.length; ei++) {
      var ent = FEEDBACK_SCHOOL_COMMUNITY_CATALOG[ei];
      if (!byGroup[ent.group]) byGroup[ent.group] = [];
      byGroup[ent.group].push(ent);
    }

    for (var go = 0; go < groupOrder.length; go++) {
      var gname = groupOrder[go];
      var schools = byGroup[gname];
      if (!schools || !schools.length) continue;
      schools.sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
      var heading = document.createElement("div");
      heading.className = "feedback-school-combobox__group-label";
      heading.textContent = gname;
      listEl.appendChild(heading);
      for (var si = 0; si < schools.length; si++) {
        var s = schools[si];
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "feedback-school-combobox__option";
        if (FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[s.id]) {
          btn.classList.add("is-selected");
          btn.setAttribute("aria-selected", "true");
        }
        btn.setAttribute("role", "option");
        btn.setAttribute("data-school-id", s.id);
        btn.textContent = s.name;
        listEl.appendChild(btn);
      }
    }
  }

  function setFeedbackSchoolCommunitiesListOpen(open) {
    var combo = document.getElementById("feedback-school-combobox");
    var trigger = document.getElementById("feedback-school-combobox-trigger");
    var listEl = document.getElementById("feedback-school-combobox-list");
    if (!combo || !trigger || !listEl) return;
    var isOpen = !!open;
    combo.classList.toggle("is-open", isOpen);
    trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
    listEl.hidden = !isOpen;
  }

  function addFeedbackSchoolCommunitySelection(id) {
    var ent = feedbackSchoolCommunityById(id);
    if (!ent) return;
    FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[id] = ent;
    renderFeedbackSchoolCommunityChips();
    syncFeedbackSchoolCommunitiesHiddenSelect();
    renderFeedbackSchoolCommunitiesList();
    setFeedbackSchoolCommunitiesTriggerText("Prefer not to answer");
  }

  function removeFeedbackSchoolCommunitySelection(id) {
    if (
      !Object.prototype.hasOwnProperty.call(
        FEEDBACK_SCHOOL_COMMUNITIES_SELECTED,
        id
      )
    ) {
      return;
    }
    delete FEEDBACK_SCHOOL_COMMUNITIES_SELECTED[id];
    renderFeedbackSchoolCommunityChips();
    syncFeedbackSchoolCommunitiesHiddenSelect();
    renderFeedbackSchoolCommunitiesList();
    setFeedbackSchoolCommunitiesTriggerText("Prefer not to answer");
  }

  function clearFeedbackSchoolCommunitySelections() {
    FEEDBACK_SCHOOL_COMMUNITIES_SELECTED = {};
    renderFeedbackSchoolCommunityChips();
    syncFeedbackSchoolCommunitiesHiddenSelect();
    renderFeedbackSchoolCommunitiesList();
    setFeedbackSchoolCommunitiesTriggerText("Prefer not to answer");
  }

  function setupFeedbackSchoolCommunitiesCombobox() {
    if (FEEDBACK_SCHOOL_COMMUNITIES_COMBO_INIT) return;
    var combo = document.getElementById("feedback-school-combobox");
    var trigger = document.getElementById("feedback-school-combobox-trigger");
    var listEl = document.getElementById("feedback-school-combobox-list");
    var chipsEl = document.getElementById("feedback-school-communities-chips");
    if (!combo || !trigger || !listEl || !chipsEl) return;
    FEEDBACK_SCHOOL_COMMUNITIES_COMBO_INIT = true;

    trigger.addEventListener("click", function () {
      if (trigger.disabled) return;
      var open = combo.classList.contains("is-open");
      setFeedbackSchoolCommunitiesListOpen(!open);
    });

    listEl.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var opt = t.closest("[data-school-id]");
      if (!opt || !listEl.contains(opt)) return;
      var id = opt.getAttribute("data-school-id");
      if (id === "") {
        clearFeedbackSchoolCommunitySelections();
        setFeedbackSchoolCommunitiesListOpen(false);
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(
          FEEDBACK_SCHOOL_COMMUNITIES_SELECTED,
          id
        )
      ) {
        removeFeedbackSchoolCommunitySelection(id);
      } else {
        addFeedbackSchoolCommunitySelection(id);
      }
    });

    chipsEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".feedback-school-chip__remove");
      if (!btn || !chipsEl.contains(btn)) return;
      var id = btn.getAttribute("data-school-id");
      if (id) removeFeedbackSchoolCommunitySelection(id);
    });

    document.addEventListener("click", function (e) {
      if (!combo.classList.contains("is-open")) return;
      var t = e.target;
      if (combo.contains(t)) return;
      setFeedbackSchoolCommunitiesListOpen(false);
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && combo.classList.contains("is-open")) {
        setFeedbackSchoolCommunitiesListOpen(false);
        trigger.focus();
      }
    });
  }

  function populateFeedbackSchoolCommunitiesSelect(schoolsFc, charterFc, privateFc) {
    var trigger = document.getElementById("feedback-school-combobox-trigger");
    if (!trigger) return;

    FEEDBACK_SCHOOL_COMMUNITY_CATALOG = attachFeedbackSchoolCommunityChipLabels(
      buildFeedbackSchoolCommunityEntries(schoolsFc, charterFc, privateFc)
    );
    FEEDBACK_SCHOOL_COMMUNITIES_SELECTED = {};
    setFeedbackSchoolCommunitiesTriggerText(
      FEEDBACK_SCHOOL_COMMUNITY_CATALOG.length
        ? "Prefer not to answer"
        : "No schools loaded"
    );
    renderFeedbackSchoolCommunitiesList();
    renderFeedbackSchoolCommunityChips();
    syncFeedbackSchoolCommunitiesHiddenSelect();
    setupFeedbackSchoolCommunitiesCombobox();
    trigger.disabled = !FEEDBACK_SCHOOL_COMMUNITY_CATALOG.length;
    setFeedbackSchoolCommunitiesListOpen(false);
  }

  function setupScenarioSchoolSelection(schoolByMsid, schoolsFc) {
    scenarioSchoolByMsid = schoolByMsid;
    var sel = document.getElementById("scenario-school-select");
    if (!sel) return;
    sel.addEventListener("change", function () {
      var v = sel.value;
      if (!v) {
        clearSelectedSchoolHighlight();
        resetScenarioPanel();
        return;
      }
      var msid = Number(v);
      if (isNaN(msid)) return;
      if (!isScenarioDestinationSchoolMsid(msid)) return;
      runScenarioForMiddleMsid(msid, schoolByMsid, schoolsFc);
    });
  }

  function refreshScenarioPanelIfVisible() {
    var panel = document.getElementById("page-scenario");
    if (!panel || panel.hidden) return;
    if (scenarioMiddleMsid != null && !isNaN(scenarioMiddleMsid)) {
      applyScenarioMergedUpdates();
    }
  }

  /**
   * Fills the two school detail lines (name | grades | address; opened | age | renovation | acres) from GeoJSON + master CSV.
   * @param {Object} p school feature properties
   * @param {HTMLElement|null} elP primary line
   * @param {HTMLElement|null} elS secondary line
   */
  function fillSchoolDetailsPrimarySecondary(p, elP, elS) {
    if (!p) return;
    var msid =
      p.SCHOOLS_ID != null && p.SCHOOLS_ID !== ""
        ? Number(p.SCHOOLS_ID)
        : null;
    var m = masterRow(msid);

    if (elP) {
      var name = schoolDisplayNameFromProps(p);
      var grades = m
        ? m.grades_served
          ? standardCapitalization(normalizeGradesServedForUi(m.grades_served))
          : "—"
        : p.Grades
          ? standardCapitalization(normalizeGradesServedForUi(p.Grades))
          : "—";
      var addrLine = "—";
      if (m) {
        var sa = m.address ? standardCapitalization(m.address) : "";
        var sc = m.city_state_zip ? formatCityStateZip(m.city_state_zip) : "";
        if (sa && sc) addrLine = sa + ", " + sc;
        else if (sa) addrLine = sa;
        else if (sc) addrLine = sc;
      } else if (p.ADDRESS) {
        addrLine = standardCapitalization(p.ADDRESS);
      }
      var primaryParts = [name, grades, addrLine];
      var gradeRaw =
        m && m.school_grade_2025 != null
          ? String(m.school_grade_2025).trim()
          : "";
      if (gradeRaw && gradeRaw.toUpperCase() !== "N/A") {
        primaryParts.push("2025 School Grade: " + gradeRaw);
      }
      elP.textContent = primaryParts.join(" | ");
      elP.classList.remove("school-details-placeholder");
    }
    if (elS) {
      var acres =
        m && m.site_acres !== "" && m.site_acres != null
          ? String(m.site_acres)
          : "—";
      var openedYearRaw = "";
      if (m) {
        if (m.opened_year !== "" && m.opened_year != null) {
          openedYearRaw = m.opened_year;
        } else if (m.constructed_year !== "" && m.constructed_year != null) {
          openedYearRaw = m.constructed_year;
        }
      }
      var opened =
        openedYearRaw !== "" && !isNaN(Number(openedYearRaw))
          ? String(openedYearRaw)
          : "—";
      var age =
        m &&
        m.age_of_site_2026 !== "" &&
        m.age_of_site_2026 != null &&
        !isNaN(Number(m.age_of_site_2026))
          ? String(m.age_of_site_2026)
          : "—";
      var renovation = "—";
      if (
        m &&
        m.last_major_renovation_year !== "" &&
        m.last_major_renovation_year != null
      ) {
        renovation = String(m.last_major_renovation_year).trim();
        if (renovation === "No Major Renovation") renovation = "N/A";
      }
      var bpsEmployees = bpsOnSiteEmployeeCountDisplay(msid);
      elS.textContent =
        "Opened: " +
        opened +
        " | Age of Site: " +
        age +
        " | Year of Last Major Renovation: " +
        renovation +
        " | Size of Site (Acres): " +
        acres +
        " | Count of On-Site BPS Employees: " +
        bpsEmployees;
      elS.classList.remove("school-details-placeholder");
      elS.removeAttribute("title");
    }
  }

  function fromToResidentDenominatorForMaster(m) {
    if (!m || m.fromto_resident_denominator === "" || m.fromto_resident_denominator == null) {
      return NaN;
    }
    var d = parseInt(String(m.fromto_resident_denominator).trim(), 10);
    if (isNaN(d) || d <= 0) return NaN;
    return d;
  }

  function fromToStudentCount(m, key) {
    if (!m || m[key] === "" || m[key] == null) return NaN;
    var n = parseInt(String(m[key]).trim(), 10);
    return isNaN(n) ? NaN : n;
  }

  /** Tooltip text for From-To capture: "N of D boundary public-school students", or null if counts missing. */
  function boundaryPublicSchoolStudentsPhrase(m, countKey) {
    var den = fromToResidentDenominatorForMaster(m);
    var num = fromToStudentCount(m, countKey);
    if (!isNaN(den) && !isNaN(num)) {
      return (
        num.toLocaleString() +
        " of " +
        den.toLocaleString() +
        " boundary public-school students"
      );
    }
    return null;
  }

  /**
   * Tooltip line when capture denominators use an adjusted total (e.g. including homeschool residents).
   */
  function boundaryStudentsPhraseAdjusted(m, countKey, denominatorAdjusted, homeschoolStudentCount) {
    var num = fromToStudentCount(m, countKey);
    var den = denominatorAdjusted;
    if (isNaN(den) || den <= 0 || isNaN(num)) {
      return null;
    }
    var s =
      num.toLocaleString() +
      " of " +
      den.toLocaleString() +
      " students residing in the attendance boundary";
    if (homeschoolStudentCount != null && homeschoolStudentCount > 0) {
      s +=
        " (denominator includes " +
        Number(homeschoolStudentCount).toLocaleString() +
        " grade-eligible homeschool students)";
    }
    return s;
  }

  /**
   * Shared display strings for KPI cards and scenario summary line (same rules).
   * From-To capture decimals: assignment_capture_rate, other_district_capture_rate, choice_capture_rate, charter_capture_rate.
   * @param {Object|null} captureOpts optional; when `includeHomeschoolInCaptureDenominator` and `homeschoolStudentsInBoundary` are set, recomputes % from CSV numerators over expanded denominator.
   * @returns {Object}
   */
  function getSchoolKpiDisplayParts(p, m, msid, captureOpts) {
    var enrollmentStr = "—";
    if (m && m.enrollment_2025 !== "" && m.enrollment_2025 != null) {
      var ev = Number(m.enrollment_2025);
      if (!isNaN(ev)) enrollmentStr = ev.toLocaleString();
    }

    var capacityStr = "—";
    if (
      m &&
      m.factored_capacity_2025_26 !== "" &&
      m.factored_capacity_2025_26 != null
    ) {
      var cn = Number(m.factored_capacity_2025_26);
      if (!isNaN(cn)) capacityStr = cn.toLocaleString();
    }

    var utilizationStr = "—";
    if (m && m.utilization_2025_26 !== "" && m.utilization_2025_26 != null) {
      var utilDec = Number(m.utilization_2025_26);
      if (!isNaN(utilDec)) {
        var utilPctDisp = utilDec * 100;
        utilizationStr =
          (utilPctDisp % 1 === 0 ? String(utilPctDisp) : utilPctDisp.toFixed(1)) +
          "%";
      }
    }

    var captureIsChoice = schoolIsChoiceFromProps(p);
    var choiceNaStr = "N/A (Choice School)";
    var choiceNaTitle =
      "Choice schools have no assignment-area residence row in the From-To analysis; these capture rates do not apply.";

    function pctFromCsvDecimal(raw, title) {
      if (raw === "" || raw == null) {
        return { str: "—", title: null };
      }
      var d = Number(raw);
      if (isNaN(d)) {
        return { str: "—", title: null };
      }
      var pctDisp = d * 100;
      var str =
        (pctDisp % 1 === 0 ? String(pctDisp) : pctDisp.toFixed(1)) + "%";
      return { str: str, title: title };
    }

    var assignmentStr = "—";
    var otherDistrictStr = "—";
    var choiceStr = "—";
    var charterStr = "—";
    var assignmentTitle = null;
    var otherDistrictTitle = null;
    var choiceTitle = null;
    var charterTitle = null;
    var captureHoverAssignment = null;
    var captureHoverOtherDistrict = null;
    var captureHoverChoice = null;
    var captureHoverCharter = null;
    var homeschoolStr = "—";
    var homeschoolTitle = null;
    var captureHoverHomeschool = null;
    var scenarioCaptureCountsTitle = null;

    if (captureIsChoice) {
      assignmentStr = choiceNaStr;
      otherDistrictStr = choiceNaStr;
      choiceStr = choiceNaStr;
      charterStr = choiceNaStr;
      assignmentTitle = choiceNaTitle;
      otherDistrictTitle = choiceNaTitle;
      choiceTitle = choiceNaTitle;
      charterTitle = choiceNaTitle;
      captureHoverAssignment = null;
      captureHoverOtherDistrict = null;
      captureHoverChoice = null;
      captureHoverCharter = null;
      scenarioCaptureCountsTitle = null;
    } else if (m) {
      var useHsDen =
        captureOpts &&
        captureOpts.includeHomeschoolInCaptureDenominator === true;
      var Hhs =
        useHsDen && typeof captureOpts.homeschoolStudentsInBoundary === "number"
          ? Math.max(0, Math.floor(Number(captureOpts.homeschoolStudentsInBoundary)))
          : 0;
      var Dbase = fromToResidentDenominatorForMaster(m);

      function pctStrFromCounts(num, den) {
        if (isNaN(num) || isNaN(den) || den <= 0) {
          return "—";
        }
        var pctDisp = (num / den) * 100;
        return (
          (pctDisp % 1 === 0 ? String(pctDisp) : pctDisp.toFixed(1)) + "%"
        );
      }

      if (useHsDen && !isNaN(Dbase) && Dbase > 0) {
        var Dadj = Dbase + Hhs;
        var na = fromToStudentCount(m, "assignment_capture_students");
        var no = fromToStudentCount(m, "other_district_capture_students");
        var nc = fromToStudentCount(m, "choice_capture_students");
        var nv = fromToStudentCount(m, "charter_capture_students");

        assignmentStr = pctStrFromCounts(na, Dadj);
        otherDistrictStr = pctStrFromCounts(no, Dadj);
        choiceStr = pctStrFromCounts(nc, Dadj);
        charterStr = pctStrFromCounts(nv, Dadj);
        homeschoolStr = pctStrFromCounts(Hhs, Dadj);

        captureHoverAssignment = boundaryStudentsPhraseAdjusted(
          m,
          "assignment_capture_students",
          Dadj,
          Hhs
        );
        captureHoverOtherDistrict = boundaryStudentsPhraseAdjusted(
          m,
          "other_district_capture_students",
          Dadj,
          Hhs
        );
        captureHoverChoice = boundaryStudentsPhraseAdjusted(
          m,
          "choice_capture_students",
          Dadj,
          Hhs
        );
        captureHoverCharter = boundaryStudentsPhraseAdjusted(
          m,
          "charter_capture_students",
          Dadj,
          Hhs
        );
        if (!isNaN(Hhs) && !isNaN(Dadj)) {
          captureHoverHomeschool =
            Hhs.toLocaleString() +
            " of " +
            Dadj.toLocaleString() +
            " students residing in the attendance boundary (grade-eligible homeschool students)";
        }

        var countKeysAdj = [
          "assignment_capture_students",
          "other_district_capture_students",
          "choice_capture_students",
          "charter_capture_students",
        ];
        var partsCtAdj = [];
        for (var cj = 0; cj < countKeysAdj.length; cj++) {
          var phA = boundaryStudentsPhraseAdjusted(
            m,
            countKeysAdj[cj],
            Dadj,
            Hhs
          );
          if (phA) {
            partsCtAdj.push(phA);
          }
        }
        if (captureHoverHomeschool) {
          partsCtAdj.push(captureHoverHomeschool);
        }
        if (partsCtAdj.length) {
          scenarioCaptureCountsTitle = partsCtAdj.join(" · ");
        }
      } else {
        var a = pctFromCsvDecimal(m.assignment_capture_rate, null);
        assignmentStr = a.str;
        assignmentTitle = a.title;
        var o = pctFromCsvDecimal(m.other_district_capture_rate, null);
        otherDistrictStr = o.str;
        otherDistrictTitle = o.title;
        var ch = pctFromCsvDecimal(m.choice_capture_rate, null);
        choiceStr = ch.str;
        choiceTitle = ch.title;
        var chrt = pctFromCsvDecimal(m.charter_capture_rate, null);
        charterStr = chrt.str;
        charterTitle = chrt.title;

        captureHoverAssignment = boundaryPublicSchoolStudentsPhrase(
          m,
          "assignment_capture_students"
        );
        captureHoverOtherDistrict = boundaryPublicSchoolStudentsPhrase(
          m,
          "other_district_capture_students"
        );
        captureHoverChoice = boundaryPublicSchoolStudentsPhrase(m, "choice_capture_students");
        captureHoverCharter = boundaryPublicSchoolStudentsPhrase(
          m,
          "charter_capture_students"
        );

        var countKeys = [
          "assignment_capture_students",
          "other_district_capture_students",
          "choice_capture_students",
          "charter_capture_students",
        ];
        var partsCt = [];
        for (var ci = 0; ci < countKeys.length; ci++) {
          var phrase = boundaryPublicSchoolStudentsPhrase(m, countKeys[ci]);
          if (phrase) {
            partsCt.push(phrase);
          }
        }
        if (partsCt.length) {
          scenarioCaptureCountsTitle = partsCt.join(" · ");
        }
      }
    }

    return {
      enrollmentStr: enrollmentStr,
      capacityStr: capacityStr,
      utilizationStr: utilizationStr,
      assignmentStr: assignmentStr,
      otherDistrictStr: otherDistrictStr,
      choiceStr: choiceStr,
      charterStr: charterStr,
      captureIsChoice: captureIsChoice,
      assignmentTitle: assignmentTitle,
      otherDistrictTitle: otherDistrictTitle,
      choiceTitle: choiceTitle,
      charterTitle: charterTitle,
      captureHoverAssignment: captureHoverAssignment,
      captureHoverOtherDistrict: captureHoverOtherDistrict,
      captureHoverChoice: captureHoverChoice,
      captureHoverCharter: captureHoverCharter,
      homeschoolStr: homeschoolStr,
      homeschoolTitle: homeschoolTitle,
      captureHoverHomeschool: captureHoverHomeschool,
      scenarioCaptureCountsTitle: scenarioCaptureCountsTitle,
      /** @deprecated scenario line — use assignmentStr */
      captureStr: assignmentStr,
      /** @deprecated scenario line — use charterStr */
      charterStr: charterStr,
      captureTitle: assignmentTitle,
      charterTitle: charterTitle,
    };
  }

  /**
   * Fills #ese-feeder-tbody from ESE_FEEDER_MATRIX for the selected school MSID.
   * Row labels use short titles; title attribute carries full Excel column header text.
   */
  function renderEseFeederFlowsTable(msid) {
    var tbody = document.getElementById("ese-feeder-tbody");
    if (!tbody) return;

    function rowPlaceholder(msg) {
      tbody.innerHTML = "";
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 3;
      td.className = "ese-feeder-placeholder";
      td.textContent = msg;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    if (!ESE_FEEDER_MATRIX || !ESE_FEEDER_MATRIX.programs || !ESE_FEEDER_MATRIX.programs.length) {
      rowPlaceholder(
        "ESE feeder information is not available."
      );
      return;
    }

    if (msid == null || isNaN(Number(msid))) {
      rowPlaceholder("Select a school to view ESE feeder flows.");
      return;
    }

    var sidStr = String(Number(msid));
    var rowMap = ESE_FEEDER_MATRIX.rows ? ESE_FEEDER_MATRIX.rows[sidStr] : null;
    var accAll =
      ESE_FEEDER_MATRIX.acceptsFrom && ESE_FEEDER_MATRIX.acceptsFrom[sidStr]
        ? ESE_FEEDER_MATRIX.acceptsFrom[sidStr]
        : {};

    tbody.innerHTML = "";
    ESE_FEEDER_MATRIX.programs.forEach(function (prog) {
      var tr = document.createElement("tr");
      var tdLabel = document.createElement("th");
      tdLabel.scope = "row";
      tdLabel.className = "ese-feeder-program-label";
      tdLabel.textContent = prog.shortLabel || prog.key;
      if (prog.headerFull) {
        tdLabel.title = String(prog.headerFull).replace(/\s*\n\s*/g, " ").trim();
      }
      var tdAccept = document.createElement("td");
      var tdSend = document.createElement("td");
      var acc = accAll[prog.key] || [];
      var sends = rowMap && rowMap[prog.key] ? rowMap[prog.key] : [];
      var acceptNames = eseFilteredSortedSchoolNames(acc, msid);
      var sendNames = eseFilteredSortedSchoolNames(sends, msid);
      tdAccept.textContent = acceptNames.length ? acceptNames.join(", ") : "—";
      tdSend.textContent = sendNames.length ? sendNames.join(", ") : "—";
      tr.appendChild(tdLabel);
      tr.appendChild(tdAccept);
      tr.appendChild(tdSend);
      tbody.appendChild(tr);
    });
  }

  function updateLeftPanelFromSchool(p) {
    var elP = document.getElementById("school-details-primary");
    var elS = document.getElementById("school-details-secondary");
    var msid =
      p.SCHOOLS_ID != null && p.SCHOOLS_ID !== ""
        ? Number(p.SCHOOLS_ID)
        : null;
    var m = masterRow(msid);

    fillSchoolDetailsPrimarySecondary(p, elP, elS);

    var hsCapCb = document.getElementById("toggle-include-homeschool-capture");
    var includeHsCapture = !!(hsCapCb && hsCapCb.checked);
    var hsInBoundary =
      includeHsCapture && msid != null && !isNaN(msid)
        ? countHomeschoolStudentsInAssignmentBoundary(msid)
        : 0;
    var parts = getSchoolKpiDisplayParts(p, m, msid, {
      includeHomeschoolInCaptureDenominator: includeHsCapture,
      homeschoolStudentsInBoundary: hsInBoundary,
    });

    var capEl = document.getElementById("kpi-capacity");
    if (capEl) {
      if (parts.capacityStr !== "—") {
        capEl.textContent = parts.capacityStr;
        capEl.classList.remove("kpi-value--placeholder");
        capEl.title = "Includes capacity from portables.";
      } else {
        capEl.textContent = "—";
        capEl.classList.add("kpi-value--placeholder");
        capEl.removeAttribute("title");
      }
    }

    var enrollEl = document.getElementById("kpi-enrollment");
    if (enrollEl) {
      if (parts.enrollmentStr !== "—") {
        enrollEl.textContent = parts.enrollmentStr;
        enrollEl.classList.remove("kpi-value--placeholder");
        enrollEl.title = "2025-26 calendar-year membership.";
      } else {
        enrollEl.textContent = "—";
        enrollEl.classList.add("kpi-value--placeholder");
        enrollEl.removeAttribute("title");
      }
    }

    var utilEl = document.getElementById("kpi-utilization");
    if (utilEl) {
      if (parts.utilizationStr !== "—") {
        utilEl.textContent = parts.utilizationStr;
        utilEl.classList.remove("kpi-value--placeholder");
        utilEl.title = "'25-26 Enrollment by Factored Capacity";
      } else {
        utilEl.textContent = "—";
        utilEl.classList.add("kpi-value--placeholder");
        utilEl.removeAttribute("title");
      }
    }

    renderEnrollmentChart(msid);
    renderDemographicsCharts(msid);
    renderSankeyPanel(schoolPropsWithMasterType(p));
    renderEseFeederFlowsTable(msid);

    var capAssignedLbl = document.getElementById("kpi-capture-assigned-label");
    if (capAssignedLbl) {
      capAssignedLbl.textContent = captureRateAssignedSchoolLabelUpper(p);
    }

    function applyCaptureKpi(el, displayStr, cardHoverTitle, captureIsChoice) {
      if (!el) return;
      var card = el.closest ? el.closest(".kpi-card") : null;
      el.removeAttribute("title");
      el.classList.remove("kpi-value--choice-na");
      if (captureIsChoice) {
        el.textContent = displayStr;
        el.classList.remove("kpi-value--placeholder");
        el.classList.add("kpi-value--choice-na");
        if (card) {
          if (cardHoverTitle) {
            card.setAttribute("title", cardHoverTitle);
          } else {
            card.removeAttribute("title");
          }
        }
        return;
      }
      if (displayStr !== "—") {
        el.textContent = displayStr;
        el.classList.remove("kpi-value--placeholder");
      } else {
        el.textContent = "—";
        el.classList.add("kpi-value--placeholder");
      }
      if (card) {
        if (cardHoverTitle) {
          card.setAttribute("title", cardHoverTitle);
        } else {
          card.removeAttribute("title");
        }
      }
    }

    applyCaptureKpi(
      document.getElementById("kpi-assignment-capture"),
      parts.assignmentStr,
      parts.captureHoverAssignment,
      parts.captureIsChoice
    );
    applyCaptureKpi(
      document.getElementById("kpi-other-district-capture"),
      parts.otherDistrictStr,
      parts.captureHoverOtherDistrict,
      parts.captureIsChoice
    );
    applyCaptureKpi(
      document.getElementById("kpi-choice-capture"),
      parts.choiceStr,
      parts.captureHoverChoice,
      parts.captureIsChoice
    );
    applyCaptureKpi(
      document.getElementById("kpi-charter-capture"),
      parts.charterStr,
      parts.captureHoverCharter,
      parts.captureIsChoice
    );

    var gridCap = document.getElementById("kpi-grid-capture");
    var cardHs = document.getElementById("kpi-card-homeschool-capture");
    var showHsCard = includeHsCapture && !parts.captureIsChoice;
    if (gridCap) {
      gridCap.classList.toggle("kpi-grid--capture--five", !!showHsCard);
    }
    if (cardHs) {
      cardHs.hidden = !showHsCard;
    }
    var elHsCap = document.getElementById("kpi-homeschool-capture");
    if (elHsCap) {
      if (showHsCard && parts.homeschoolStr != null && parts.homeschoolStr !== "—") {
        elHsCap.textContent = parts.homeschoolStr;
        elHsCap.classList.remove("kpi-value--placeholder");
        if (parts.captureHoverHomeschool) {
          elHsCap.removeAttribute("title");
          cardHs.setAttribute("title", parts.captureHoverHomeschool);
        } else {
          cardHs.removeAttribute("title");
        }
      } else if (showHsCard) {
        elHsCap.textContent = parts.homeschoolStr || "—";
        elHsCap.classList.toggle(
          "kpi-value--placeholder",
          !parts.homeschoolStr || parts.homeschoolStr === "—"
        );
        cardHs.removeAttribute("title");
      } else {
        elHsCap.textContent = "—";
        elHsCap.classList.add("kpi-value--placeholder");
        elHsCap.removeAttribute("title");
        if (cardHs) {
          cardHs.removeAttribute("title");
        }
      }
    }
  }

  function resetLeftPanelPlaceholders() {
    var elP = document.getElementById("school-details-primary");
    var elS = document.getElementById("school-details-secondary");
    if (elP) {
      elP.textContent =
        "Name of School | Grades Served | Address | 2025 School Grade";
      elP.classList.add("school-details-placeholder");
    }
    if (elS) {
      elS.textContent =
        "Year Opened | Age of Site | Year of Last Major Renovation | Size of Site (Acres) | Count of On-Site BPS Employees";
      elS.classList.add("school-details-placeholder");
      elS.removeAttribute("title");
    }
    var capAsgLbl = document.getElementById("kpi-capture-assigned-label");
    if (capAsgLbl) {
      capAsgLbl.textContent = "Selected School";
    }
    [
      "kpi-enrollment",
      "kpi-capacity",
      "kpi-utilization",
      "kpi-assignment-capture",
      "kpi-other-district-capture",
      "kpi-choice-capture",
      "kpi-charter-capture",
      "kpi-homeschool-capture",
    ].forEach(function (id) {
      var k = document.getElementById(id);
      if (k) {
        k.textContent = "—";
        k.classList.add("kpi-value--placeholder");
        k.classList.remove("kpi-value--choice-na");
        k.removeAttribute("title");
        var card = k.closest && k.closest(".kpi-card");
        if (card) {
          card.removeAttribute("title");
        }
      }
    });
    var gridCapReset = document.getElementById("kpi-grid-capture");
    if (gridCapReset) {
      gridCapReset.classList.remove("kpi-grid--capture--five");
    }
    var cardHsReset = document.getElementById("kpi-card-homeschool-capture");
    if (cardHsReset) {
      cardHsReset.hidden = true;
    }
    renderEnrollmentChart(null);
    renderDemographicsCharts(null);
    renderSankeyPanel(null);
    renderEseFeederFlowsTable(null);
  }

  /**
   * Applies the current #school-select value: highlight, map frame, left panel, student hex.
   * If `pendingMapSelectFrame` is "centerOnSchool" (set just before a map point/parcel pick), pans to the
   * school with no zoom change. Otherwise (dropdown or map boundary) uses `zoomToSchoolAssignment`.
   */
  function applyExistingSchoolFromSelectValue(schoolByMsid) {
    var sel = document.getElementById("school-select");
    if (!sel) return;
    var v = sel.value;
    if (!v) {
      pendingMapSelectFrame = null;
      clearSelectedSchoolHighlight();
      resetLeftPanelPlaceholders();
      syncStudentHexLayer();
      syncTravelShedLayerFilter();
      return;
    }
    var msid = Number(v);
    if (isNaN(msid)) return;
    var p = schoolByMsid[msid];
    if (!p) return;
    var mapFrame = pendingMapSelectFrame;
    pendingMapSelectFrame = null;
    if (mapFrame !== "centerOnSchool" && mapFrame !== "assignment") {
      mapFrame = "assignment";
    }
    applySelectedSchoolHighlight(msid);
    if (mapFrame === "centerOnSchool") {
      centerMapOnSchoolPoint(msid, schoolByMsid);
    } else {
      zoomToSchoolAssignment(msid, schoolByMsid);
    }
    updateLeftPanelFromSchool(p);
    syncStudentHexLayer();
    syncTravelShedLayerFilter();
  }

  function setupSchoolSelection(schoolByMsid) {
    var sel = document.getElementById("school-select");
    if (!sel) return;

    sel.addEventListener("change", function () {
      applyExistingSchoolFromSelectValue(schoolByMsid);
    });

    var hsCapStorageKey = "brevardK8IncludeHomeschoolCapture";
    var hsCapCb = document.getElementById("toggle-include-homeschool-capture");
    if (hsCapCb) {
      try {
        if (sessionStorage.getItem(hsCapStorageKey) === "1") {
          hsCapCb.checked = true;
        }
      } catch (eSs) {
        /* ignore */
      }
      hsCapCb.addEventListener("change", function () {
        try {
          sessionStorage.setItem(hsCapStorageKey, hsCapCb.checked ? "1" : "0");
        } catch (eS2) {
          /* ignore */
        }
        var v = sel.value;
        if (!v) {
          return;
        }
        var mid = Number(v);
        if (isNaN(mid)) {
          return;
        }
        var sp = schoolByMsid[mid];
        if (sp) {
          updateLeftPanelFromSchool(sp);
        }
      });
    }
  }

  function setupMapInteractions(schoolByMsid) {
    var boundaryHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "260px",
      className: "boundary-hover-popup",
      offset: 12,
    });

    var schoolHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "300px",
      className: "school-hover-popup",
      offset: 10,
    });

    var schoolBoardHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "260px",
      className: "school-board-hover-popup",
      offset: 12,
    });

    var studentHexHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "320px",
      className: "student-hex-hover-popup",
      offset: 10,
    });

    var travelShedHoverPopup = new mapboxgl.Popup({
      closeButton: false,
      closeOnClick: false,
      maxWidth: "430px",
      className: "travel-shed-hover-popup",
      offset: 8,
    });

    var ttDensityCb = document.getElementById("toggle-student-hex-density-tooltip");
    if (ttDensityCb) {
      ttDensityCb.addEventListener("change", function () {
        if (!ttDensityCb.checked) {
          studentHexHoverPopup.remove();
        }
      });
    }

    dismissStudentHexDensityTooltip = function () {
      try {
        studentHexHoverPopup.remove();
      } catch (eRm) {
        /* ignore */
      }
    };
    syncStudentHexTooltipCheckboxVisibility();

    var lastRingMsid = null;
    var lastOutline = { source: null, id: null };

    function clearOutlineHighlight() {
      if (lastOutline.source != null && lastOutline.id != null) {
        try {
          map.setFeatureState(
            { source: lastOutline.source, id: lastOutline.id },
            { highlight: false }
          );
        } catch (e) {
          /* ignore */
        }
      }
      lastOutline.source = null;
      lastOutline.id = null;
    }

    /** Clears hover ring only; dropdown selection uses feature-state "selected". */
    function clearHoverRing() {
      if (lastRingMsid != null) {
        try {
          map.setFeatureState({ source: "schools", id: lastRingMsid }, { ring: false });
        } catch (e) {
          /* ignore */
        }
        lastRingMsid = null;
      }
    }

    function clearMunicipalHoverStroke() {
      try {
        if (map.getLayer("municipal-boundaries-hover")) {
          map.setFilter("municipal-boundaries-hover", [
            "==",
            ["to-string", ["get", "OBJECTID"]],
            MUN_HOVER_FILTER_OFF,
          ]);
        }
      } catch (errM) {
        try {
          if (map.getLayer("municipal-boundaries-hover")) {
            map.setFilter("municipal-boundaries-hover", [
              "==",
              ["to-string", ["get", "OBJECTID"]],
              MUN_HOVER_FILTER_OFF,
            ]);
          }
        } catch (errM2) {
          /* ignore */
        }
      }
    }

    function applyMunicipalHoverStroke(feature) {
      if (!feature) return;
      var props = feature.properties || {};
      var oidRaw =
        props.OBJECTID != null
          ? props.OBJECTID
          : props.objectid != null
            ? props.objectid
            : feature.id;
      if (oidRaw == null) return;
      /** Compare as strings so source + query features match regardless of number vs string. */
      var oidKey = String(oidRaw).trim();
      if (!oidKey) return;
      try {
        map.setFilter("municipal-boundaries-hover", [
          "==",
          ["to-string", ["get", "OBJECTID"]],
          oidKey,
        ]);
      } catch (errA) {
        try {
          map.setFilter("municipal-boundaries-hover", [
            "==",
            ["get", "OBJECTID"],
            oidRaw,
          ]);
        } catch (errB) {
          /* ignore */
        }
      }
    }

    function clearBoundaryHoverUi() {
      clearTravelShedResidenceDebounce();
      clearOutlineHighlight();
      clearHoverRing();
      clearMunicipalHoverStroke();
      boundaryHoverPopup.remove();
      schoolBoardHoverPopup.remove();
      studentHexHoverPopup.remove();
      travelShedHoverPopup.remove();
      map.getCanvas().style.cursor = "";
    }

    function clearSchoolHoverUi() {
      clearTravelShedResidenceDebounce();
      schoolHoverPopup.remove();
      studentHexHoverPopup.remove();
      travelShedHoverPopup.remove();
    }

    /**
     * When hovering a school location, show only that school's assignment outline (hover highlight)
     * if the matching es/ms/hs fill is on. Temporarily clears the dropdown-selected assignment outline
     * so only the hovered assignment is visible; call refreshAssignmentBoundaryHighlight when leaving
     * (invalid msid, no zoned area, or layer off) to restore the selection.
     */
    function setAssignmentHoverHighlightForSchoolMsid(msid) {
      if (msid == null || isNaN(msid)) {
        clearOutlineHighlight();
        clearHoverRing();
        refreshAssignmentBoundaryHighlight();
        return;
      }
      var src = findBoundarySourceForMsid(msid);
      if (!src || !boundaryFillVisibleForSource(src)) {
        clearOutlineHighlight();
        clearHoverRing();
        refreshAssignmentBoundaryHighlight();
        return;
      }
      clearSelectedAssignmentBoundary();
      if (lastOutline.source !== src || lastOutline.id !== msid) {
        clearOutlineHighlight();
        lastOutline.source = src;
        lastOutline.id = msid;
        try {
          map.setFeatureState({ source: src, id: msid }, { highlight: true });
        } catch (eH) {
          /* ignore */
        }
      }
      if (schoolByMsid[msid]) {
        if (lastRingMsid !== msid) {
          clearHoverRing();
          lastRingMsid = msid;
          try {
            map.setFeatureState({ source: "schools", id: msid }, { ring: true });
          } catch (eR) {
            /* ignore */
          }
        }
      } else {
        clearHoverRing();
      }
    }

    function boundaryTitleText(props) {
      var msid = props.MSID != null ? Number(props.MSID) : null;
      var raw;
      if (msid != null && !isNaN(msid) && schoolByMsid[msid]) {
        var sp = schoolByMsid[msid];
        var fromMaster = schoolDisplayNamePreferMaster(sp);
        if (fromMaster) return fromMaster;
        raw = sp.NAME || sp.CommonName || String(msid);
      } else {
        raw =
          props.Elem_Commo ||
          props.Middle_Com ||
          props.High_Commo ||
          "Assignment area";
      }
      return formatSchoolDisplayName(
        standardCapitalization(expandElemSchoolName(raw))
      );
    }

    function schoolBoardDistrictHtml(props) {
      var rawName = props && props.NAME != null ? String(props.NAME) : "";
      var rawMember = props && props.SchBoardMe != null ? String(props.SchBoardMe) : "";
      var name = escapeHtml(standardCapitalization(rawName || "District"));
      var member = rawMember ? escapeHtml(standardCapitalization(rawMember)) : "";
      return (
        '<div class="school-board-hover-inner">' +
        '<div class="school-board-hover-title">' +
        name +
        "</div>" +
        (member ? '<div class="school-board-hover-member">' + member + "</div>" : "") +
        "</div>"
      );
    }

    function municipalBoundaryHtml(props) {
      var rawName = props && props.CITY_NAME != null ? String(props.CITY_NAME) : "";
      var name = escapeHtml(standardCapitalization(rawName || "Municipality"));
      return (
        '<div class="school-board-hover-inner">' +
        '<div class="school-board-hover-title">' +
        name +
        "</div></div>"
      );
    }

    function isStudentHexDensityTooltipEnabled() {
      if (residenceDensityHeatmapHiddenAtCurrentZoom()) {
        return false;
      }
      var el = document.getElementById("toggle-student-hex-density-tooltip");
      return !el || el.checked;
    }

    function visibleOverlayHitLayers() {
      var out = [];
      for (var i = 0; i < MAP_OVERLAY_HIT_LAYER_ORDER_TOP_FIRST.length; i++) {
        var lid = MAP_OVERLAY_HIT_LAYER_ORDER_TOP_FIRST[i];
        if (
          (lid === "student-hex-hit-fill" ||
            lid === "charter-student-hex-hit-fill" ||
            lid === "homeschool-student-hex-hit-fill") &&
          !isStudentHexDensityTooltipEnabled()
        ) {
          continue;
        }
        try {
          if (map.getLayer(lid) && map.getLayoutProperty(lid, "visibility") === "visible") {
            out.push(lid);
          }
        } catch (err) {
          /* ignore */
        }
      }
      return out;
    }

    map.on("mousemove", function (e) {
      var hitLayers = visibleOverlayHitLayers();
      if (!hitLayers.length) {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        refreshAssignmentBoundaryHighlight();
        return;
      }

      var feats = map.queryRenderedFeatures(e.point, { layers: hitLayers });
      if (!feats.length) {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        refreshAssignmentBoundaryHighlight();
        return;
      }

      var top = feats[0];
      var layerId = top.layer.id;

      if (layerId === "schools-private") {
        clearBoundaryHoverUi();
        clearOutlineHighlight();
        clearHoverRing();
        refreshAssignmentBoundaryHighlight();
        map.getCanvas().style.cursor = "pointer";
        schoolHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(privateSchoolDetailHtml(top.properties))
          .addTo(map);
        return;
      }

      if (layerId === "schools-charter") {
        clearBoundaryHoverUi();
        var pCh = top.properties;
        var hMsidCh = pCh.SCHOOLS_ID != null ? Number(pCh.SCHOOLS_ID) : null;
        if (hMsidCh != null && !isNaN(hMsidCh)) {
          setAssignmentHoverHighlightForSchoolMsid(hMsidCh);
        } else {
          clearOutlineHighlight();
          clearHoverRing();
          refreshAssignmentBoundaryHighlight();
        }
        map.getCanvas().style.cursor = "pointer";
        schoolHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(charterSchoolDetailHtml(pCh))
          .addTo(map);
        return;
      }

      if (
        layerId === "schools-elementary" ||
        layerId === "schools-middle" ||
        layerId === "schools-high"
      ) {
        clearBoundaryHoverUi();
        var p = top.properties;
        var hMsid = p.SCHOOLS_ID != null ? Number(p.SCHOOLS_ID) : null;
        if (hMsid != null && !isNaN(hMsid)) {
          setAssignmentHoverHighlightForSchoolMsid(hMsid);
        } else {
          clearOutlineHighlight();
          clearHoverRing();
          refreshAssignmentBoundaryHighlight();
        }
        map.getCanvas().style.cursor = "pointer";
        schoolHoverPopup.setLngLat(e.lngLat).setHTML(schoolDetailHtml(p)).addTo(map);
        return;
      }

      if (
        layerId === "student-hex-hit-fill" ||
        layerId === "charter-student-hex-hit-fill" ||
        layerId === "homeschool-student-hex-hit-fill"
      ) {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        refreshAssignmentBoundaryHighlight();
        map.getCanvas().style.cursor = "default";
        var wantB =
          isStudentResidenceLayerEnabled() &&
          map.getLayer("student-hex-hit-fill") &&
          map.getLayoutProperty("student-hex-hit-fill", "visibility") === "visible";
        var wantC =
          isCharterStudentResidenceLayerEnabled() &&
          map.getLayer("charter-student-hex-hit-fill") &&
          map.getLayoutProperty("charter-student-hex-hit-fill", "visibility") === "visible";
        var wantH =
          isHomeschoolStudentResidenceLayerEnabled() &&
          map.getLayer("homeschool-student-hex-hit-fill") &&
          map.getLayoutProperty("homeschool-student-hex-hit-fill", "visibility") === "visible";
        var qLayers = [];
        if (wantB) {
          qLayers.push("student-hex-hit-fill");
        }
        if (wantC) {
          qLayers.push("charter-student-hex-hit-fill");
        }
        if (wantH) {
          qLayers.push("homeschool-student-hex-hit-fill");
        }
        if (!qLayers.length) {
          studentHexHoverPopup.remove();
        } else {
          var pair = map.queryRenderedFeatures(e.point, { layers: qLayers });
          var propsB = null;
          var propsC = null;
          var propsH = null;
          for (var ip = 0; ip < pair.length; ip++) {
            var lId = pair[ip].layer && pair[ip].layer.id;
            if (lId === "student-hex-hit-fill" && !propsB) {
              propsB = pair[ip].properties;
            } else if (lId === "charter-student-hex-hit-fill" && !propsC) {
              propsC = pair[ip].properties;
            } else if (lId === "homeschool-student-hex-hit-fill" && !propsH) {
              propsH = pair[ip].properties;
            }
          }
          var cohortPhrase = studentResidenceCohortTooltipPhrase();
          studentHexHoverPopup
            .setLngLat(e.lngLat)
            .setHTML(
              combinedResidenceHexHoverHtml(
                propsB,
                propsC,
                propsH,
                wantB,
                wantC,
                wantH,
                cohortPhrase
              )
            )
            .addTo(map);
        }
        return;
      }

      if (layerId === "school-isochrones-fill" || layerId === "school-isochrones-outline") {
        clearTravelShedResidenceDebounce();
        clearOutlineHighlight();
        clearHoverRing();
        clearMunicipalHoverStroke();
        schoolHoverPopup.remove();
        studentHexHoverPopup.remove();
        boundaryHoverPopup.remove();
        schoolBoardHoverPopup.remove();
        refreshAssignmentBoundaryHighlight();
        map.getCanvas().style.cursor = "default";
        var miTravel =
          top.properties && top.properties.iso_miles != null
            ? Math.round(Number(top.properties.iso_miles))
            : NaN;
        var gIso = fullTravelShedIsochroneGeometryForProps(top.properties) || top.geometry;
        var ptLng = e.lngLat.lng;
        var ptLat = e.lngLat.lat;
        var seq = ++travelShedResidenceHoverGen;
        travelShedResidenceDebounceId = setTimeout(function () {
          travelShedResidenceDebounceId = null;
          if (seq !== travelShedResidenceHoverGen) {
            return;
          }
          var mShed = masterRow(getActiveTravelShedMsid());
          var byCanon =
            gIso && (gIso.type === "Polygon" || gIso.type === "MultiPolygon")
              ? travelShedResidenceCountsInIsochrone(gIso)
              : null;
          if (byCanon == null) {
            byCanon = {};
          }
          var htmlR = formatTravelShedResidenceHtml(byCanon, mShed, miTravel);
          try {
            travelShedHoverPopup
              .setLngLat([ptLng, ptLat])
              .setHTML(htmlR)
              .addTo(map);
          } catch (eTs) {
            /* ignore */
          }
        }, 150);
        return;
      }

      if (
        layerId === "school-parcels-high" ||
        layerId === "school-parcels-jr-sr" ||
        layerId === "school-parcels-middle" ||
        layerId === "school-parcels-elementary"
      ) {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        map.getCanvas().style.cursor = "";
        refreshAssignmentBoundaryHighlight();
        return;
      }

      if (layerId === "school-board-districts-fill" || layerId === "school-board-districts-outline") {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        map.getCanvas().style.cursor = "pointer";
        schoolBoardHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(schoolBoardDistrictHtml(top.properties))
          .addTo(map);
        refreshAssignmentBoundaryHighlight();
        return;
      }

      if (layerId === "municipal-boundaries-fill" || layerId === "municipal-boundaries-outline") {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        applyMunicipalHoverStroke(top);
        map.getCanvas().style.cursor = "pointer";
        schoolBoardHoverPopup
          .setLngLat(e.lngLat)
          .setHTML(municipalBoundaryHtml(top.properties))
          .addTo(map);
        refreshAssignmentBoundaryHighlight();
        return;
      }

      if (BOUNDARY_FILL_LAYERS.indexOf(layerId) === -1 && boundaryLayerIdToSource(layerId) == null) {
        clearBoundaryHoverUi();
        clearSchoolHoverUi();
        refreshAssignmentBoundaryHighlight();
        return;
      }

      clearSchoolHoverUi();
      schoolBoardHoverPopup.remove();
      clearMunicipalHoverStroke();

      var f = top;
      var props = f.properties;
      var msid = props.MSID != null ? Number(props.MSID) : null;
      if (msid != null && isNaN(msid)) msid = null;
      var src = boundaryLayerIdToSource(layerId);

      var hoveringDifferentAssignment =
        msid != null &&
        selectedSchoolMsid != null &&
        msid !== selectedSchoolMsid;

      if (msid != null && selectedSchoolMsid != null) {
        if (msid !== selectedSchoolMsid) {
          clearSelectedAssignmentBoundary();
        } else {
          applySelectedAssignmentBoundary(msid);
        }
      }

      if (!hoveringDifferentAssignment) {
        refreshAssignmentBoundaryHighlight();
      }

      map.getCanvas().style.cursor = "pointer";

      boundaryHoverPopup
        .setLngLat(e.lngLat)
        .setHTML(escapeHtml(boundaryTitleText(props)))
        .addTo(map);

      if (src && msid != null) {
        if (lastOutline.source !== src || lastOutline.id !== msid) {
          clearOutlineHighlight();
          lastOutline.source = src;
          lastOutline.id = msid;
          try {
            map.setFeatureState({ source: src, id: msid }, { highlight: true });
          } catch (e2) {
            /* ignore */
          }
        }
      } else {
        clearOutlineHighlight();
      }

      if (msid != null && schoolByMsid[msid]) {
        if (lastRingMsid !== msid) {
          clearHoverRing();
          lastRingMsid = msid;
          try {
            map.setFeatureState({ source: "schools", id: msid }, { ring: true });
          } catch (e3) {
            /* ignore */
          }
        }
      } else {
        clearHoverRing();
      }
    });

    map.on("mouseout", function () {
      clearBoundaryHoverUi();
      clearSchoolHoverUi();
      refreshAssignmentBoundaryHighlight();
    });

    function visibleClickLayers(orderedIds) {
      var out = [];
      for (var i = 0; i < orderedIds.length; i++) {
        var lid = orderedIds[i];
        try {
          if (!map.getLayer(lid)) continue;
          var v = map.getLayoutProperty(lid, "visibility");
          if (v === "none") continue;
          if (v === "visible" || v === undefined) out.push(lid);
        } catch (errC) {
          /* layer missing */
        }
      }
      return out;
    }

    function firstTopFeatureInLayers(e, orderedLayerIds) {
      var vis = visibleClickLayers(orderedLayerIds);
      if (!vis.length) return null;
      var feats = map.queryRenderedFeatures(e.point, { layers: vis });
      return feats && feats.length ? feats[0] : null;
    }

    function msidFromMapPickFeature(f) {
      if (!f || !f.properties) return null;
      var lid = f.layer && f.layer.id ? f.layer.id : "";
      if (SCHOOL_LAYER_IDS.indexOf(lid) >= 0) {
        var s = f.properties.SCHOOLS_ID;
        if (s == null || s === "") return null;
        var m = Number(s);
        return isNaN(m) ? null : m;
      }
      if (SCHOOL_PARCEL_LAYERS_CLICK_TOP_FIRST.indexOf(lid) >= 0) {
        var s2 = f.properties.SCHOOLS_ID;
        if (s2 == null || s2 === "") return null;
        var m2 = Number(s2);
        return isNaN(m2) ? null : m2;
      }
      if (ASSIGNMENT_BOUNDARY_LAYERS_CLICK_TOP_FIRST.indexOf(lid) >= 0) {
        var s3 = f.properties.MSID;
        if (s3 == null || s3 === "") return null;
        var m3 = Number(s3);
        return isNaN(m3) ? null : m3;
      }
      return null;
    }

    map.on("click", function (e) {
      if (!isExistingConditionsViewActive()) return;
      var fSch = firstTopFeatureInLayers(e, SCHOOL_LAYERS_CLICK_TOP_FIRST);
      var fParc = fSch
        ? null
        : firstTopFeatureInLayers(e, SCHOOL_PARCEL_LAYERS_CLICK_TOP_FIRST);
      var fBnd =
        fSch || fParc
          ? null
          : firstTopFeatureInLayers(e, ASSIGNMENT_BOUNDARY_LAYERS_CLICK_TOP_FIRST);
      var f = fSch || fParc || fBnd;
      if (!f) return;
      var msid = msidFromMapPickFeature(f);
      if (msid == null) return;
      if (!isMsidInSchoolSelectDropdown(msid)) return;
      var sel = document.getElementById("school-select");
      if (!sel) return;
      if (fSch || fParc) {
        pendingMapSelectFrame = "centerOnSchool";
      } else {
        pendingMapSelectFrame = "assignment";
      }
      if (String(sel.value) === String(msid)) {
        applyExistingSchoolFromSelectValue(schoolByMsid);
        return;
      }
      sel.value = String(msid);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });

    function boundarySandboxMapMouseMoveForPaintLasso(e) {
      if (!BOUNDARY_SANDBOX_PAINT.active && !BOUNDARY_SANDBOX_LASSO.active) {
        return;
      }
      if (BOUNDARY_SANDBOX_PAINT.active) {
        var dx = e.point.x - BOUNDARY_SANDBOX_PAINT.startX;
        var dy = e.point.y - BOUNDARY_SANDBOX_PAINT.startY;
        if (dx * dx + dy * dy > BOUNDARY_SANDBOX_BRUSH_DRAG_THRESH2) {
          BOUNDARY_SANDBOX_PAINT.isDrag = true;
        }
        if (BOUNDARY_SANDBOX_PAINT.isDrag) {
          tryBrushDragAtPoint(e.point);
        }
      } else if (BOUNDARY_SANDBOX_LASSO.active && BOUNDARY_SANDBOX_LASSO.points) {
        BOUNDARY_SANDBOX_LASSO.points.push([e.lngLat.lng, e.lngLat.lat]);
        setBoundarySandboxLassoSource({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: BOUNDARY_SANDBOX_LASSO.points },
            },
          ],
        });
      }
    }

    function beginBoundarySandboxDrawFromEvent(e) {
      if (!isBoundarySandboxViewActive()) {
        return;
      }
      /* Mouse: only respond to the primary (left) button. Touch events have no
         `button` property, so don't reject them here. */
      if (
        e.originalEvent &&
        typeof e.originalEvent.button === "number" &&
        e.originalEvent.button !== 0
      ) {
        return;
      }
      try {
        if (map.getLayoutProperty("boundary-sandbox-hex-fill", "visibility") !== "visible") {
          return;
        }
      } catch (eV0) {
        return;
      }
      var toolM = getBoundarySandboxSelectTool();
      e.preventDefault();
      if (toolM === "brush") {
        clearBoundarySandboxLassoRegionFill();
        BOUNDARY_SANDBOX_PAINT.active = true;
        BOUNDARY_SANDBOX_PAINT.lastKey = null;
        BOUNDARY_SANDBOX_PAINT.isDrag = false;
        BOUNDARY_SANDBOX_PAINT.startX = e.point.x;
        BOUNDARY_SANDBOX_PAINT.startY = e.point.y;
        BOUNDARY_SANDBOX_PAINT.clickKey = querySandboxHexKeyAtPoint(e.point);
        try {
          map.dragPan.disable();
          map.getCanvas().style.cursor = "crosshair";
        } catch (eB0) {
          /* ignore */
        }
        return;
      }
      if (toolM === "lasso") {
        BOUNDARY_SANDBOX_LASSO.active = true;
        BOUNDARY_SANDBOX_LASSO.points = [[e.lngLat.lng, e.lngLat.lat]];
        try {
          map.dragPan.disable();
          map.getCanvas().style.cursor = "crosshair";
        } catch (eL1) {
          /* ignore */
        }
        setBoundarySandboxLassoSource({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: BOUNDARY_SANDBOX_LASSO.points,
              },
            },
          ],
        });
      }
    }

    map.on("mousedown", beginBoundarySandboxDrawFromEvent);
    map.on("mousemove", boundarySandboxMapMouseMoveForPaintLasso);
    map.on("mouseup", function () {
      endBoundarySandboxPaintOrLassoFromWindow();
    });
    if (typeof window !== "undefined") {
      window.addEventListener("mouseup", endBoundarySandboxPaintOrLassoFromWindow);
    }

    /* Touch drawing (phones). Only active in "Draw" mode while the Boundary
       Sandbox view is open; one finger draws, two-finger gestures still zoom.
       Reuses the same draw logic as the mouse handlers. */
    function sandboxTouchDrawActive() {
      return BOUNDARY_SANDBOX_TOUCH_DRAW && isBoundarySandboxViewActive();
    }
    function touchCount(e) {
      if (e && e.originalEvent && e.originalEvent.touches) {
        return e.originalEvent.touches.length;
      }
      if (e && e.points && e.points.length) {
        return e.points.length;
      }
      return 1;
    }
    map.on("touchstart", function (e) {
      if (!sandboxTouchDrawActive()) return;
      if (touchCount(e) > 1) return;
      try {
        if (map.getLayoutProperty("boundary-sandbox-hex-fill", "visibility") !== "visible") {
          return;
        }
      } catch (eTS) {
        return;
      }
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      beginBoundarySandboxDrawFromEvent(e);
    });
    map.on("touchmove", function (e) {
      if (!BOUNDARY_SANDBOX_PAINT.active && !BOUNDARY_SANDBOX_LASSO.active) return;
      if (touchCount(e) > 1) return;
      if (e && typeof e.preventDefault === "function") e.preventDefault();
      boundarySandboxMapMouseMoveForPaintLasso(e);
    });
    map.on("touchend", function () {
      if (!BOUNDARY_SANDBOX_PAINT.active && !BOUNDARY_SANDBOX_LASSO.active) return;
      endBoundarySandboxPaintOrLassoFromWindow();
    });
    map.on("touchcancel", function () {
      if (!BOUNDARY_SANDBOX_PAINT.active && !BOUNDARY_SANDBOX_LASSO.active) return;
      endBoundarySandboxPaintOrLassoFromWindow();
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ringCentroid(ring) {
    if (!ring || ring.length < 2) return null;
    var n = ring.length;
    var last = ring[n - 1];
    var first = ring[0];
    if (last[0] === first[0] && last[1] === first[1]) {
      n -= 1;
    }
    var sx = 0;
    var sy = 0;
    for (var i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return [sx / n, sy / n];
  }

  /** Approximate interior point for hex polygons (ArcGIS-style centroid). */
  function polygonCentroid(geometry) {
    if (!geometry || !geometry.type) return null;
    if (geometry.type === "Polygon") {
      var ring = geometry.coordinates[0];
      return ringCentroid(ring);
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

  /**
   * Undirected adjacency: two hexes touch on an edge. Built once from all hex geometries.
   * O(candidates) with coarse centroid grid; pair tests use turf.booleanTouches when available.
   * @param {Object<string, *>} geometryByHexKey
   * @returns {Object<string, string[]>|null} hexKey -> adjacent hex keys; null = skip adjacency
   */
  function buildHexNeighborMap(geometryByHexKey) {
    if (!geometryByHexKey) {
      return null;
    }
    var boolTouches = null;
    if (typeof turf !== "undefined" && turf) {
      if (typeof turf.booleanTouches === "function") {
        boolTouches = turf.booleanTouches;
      } else if (typeof turf.booleanTouch === "function") {
        boolTouches = turf.booleanTouch;
      }
    }
    if (boolTouches == null || typeof turf.feature !== "function") {
      return null;
    }
    var keys = Object.keys(geometryByHexKey);
    if (!keys.length) {
      return {};
    }
    var n = keys.length;
    if (n === 1) {
      var o1 = Object.create(null);
      o1[keys[0]] = [];
      return o1;
    }
    var CELL = 0.12;
    var bucket = Object.create(null);
    for (var bi = 0; bi < n; bi++) {
      var kB = keys[bi];
      var cB = polygonCentroid(geometryByHexKey[kB]);
      if (!cB || cB.length < 2) {
        continue;
      }
      var cxb = Math.floor(cB[0] / CELL);
      var cyb = Math.floor(cB[1] / CELL);
      var bid = cxb + "," + cyb;
      if (!bucket[bid]) {
        bucket[bid] = [];
      }
      bucket[bid].push(kB);
    }
    var neighbors = Object.create(null);
    for (var ni = 0; ni < n; ni++) {
      neighbors[keys[ni]] = [];
    }
    for (var i = 0; i < n; i++) {
      var k1 = keys[i];
      var c1 = polygonCentroid(geometryByHexKey[k1]);
      if (!c1 || c1.length < 2) {
        continue;
      }
      var cx1 = Math.floor(c1[0] / CELL);
      var cy1 = Math.floor(c1[1] / CELL);
      for (var ddx = -1; ddx <= 1; ddx++) {
        for (var ddy = -1; ddy <= 1; ddy++) {
          var bList = bucket[cx1 + ddx + "," + (cy1 + ddy)];
          if (!bList) {
            continue;
          }
          for (var t = 0; t < bList.length; t++) {
            var k2 = bList[t];
            if (k2 === k1) {
              continue;
            }
            if (k2 <= k1) {
              continue;
            }
            var g1 = geometryByHexKey[k1];
            var g2 = geometryByHexKey[k2];
            if (!g1 || !g2) {
              continue;
            }
            var touches = false;
            try {
              touches = boolTouches(turf.feature(g1), turf.feature(g2));
            } catch (eAdj) {
              /* ignore */
            }
            if (touches) {
              neighbors[k1].push(k2);
              neighbors[k2].push(k1);
            }
          }
        }
      }
    }
    return neighbors;
  }

  /**
   * @param {Object|null|undefined} p
   * @returns {string|null} e.g. "id:123" when a stable hex id is present, else null
   */
  function studentHexIdKeyFromProperties(p) {
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
    if (id != null && id !== "") {
      return "id:" + String(id);
    }
    return null;
  }

  function studentHexKey(feature) {
    var p = feature.properties || {};
    var fromId = studentHexIdKeyFromProperties(p);
    if (fromId) {
      return fromId;
    }
    return "geom:" + JSON.stringify(feature.geometry);
  }

  /**
   * One increment per homeschool student row; hex id from GRID_ID matches main student hex keys.
   * @param {Object|null} homeschoolFc
   * @returns {Object<string, number>}
   */
  function buildHomeschoolHexCounts(homeschoolFc) {
    var o = Object.create(null);
    if (!homeschoolFc || !homeschoolFc.features) {
      return o;
    }
    for (var i = 0; i < homeschoolFc.features.length; i++) {
      var k = studentHexKey(homeschoolFc.features[i]);
      o[k] = (o[k] || 0) + 1;
    }
    return o;
  }

  /**
   * First polygon/MultiPolygon per hex key from homeschool features — used when that hex is absent from the student bundle.
   * @param {Object|null} homeschoolFc
   * @returns {Object<string, GeoJSON.Geometry>}
   */
  function buildHomeschoolHexGeometryFallback(homeschoolFc) {
    var out = Object.create(null);
    if (!homeschoolFc || !homeschoolFc.features) {
      return out;
    }
    for (var i = 0; i < homeschoolFc.features.length; i++) {
      var f = homeschoolFc.features[i];
      if (!f || !f.geometry) {
        continue;
      }
      var t = f.geometry.type;
      if (t !== "Polygon" && t !== "MultiPolygon") {
        continue;
      }
      var k = studentHexKey(f);
      if (!out[k]) {
        out[k] = f.geometry;
      }
    }
    return out;
  }

  /**
   * Detail row for boundary sandbox: mirrors student hex fields (`ELEM_` / `MID_` / `HIGH_`) from homeschool export zoned columns.
   */
  /**
   * @param {Object|null} zoningTriplet from `attendanceZoningTripletAtLngLat` / per-hex cache (`elem`/`mid`/`high`).
   */
  function homeschoolSandboxDetailFromProperties(props, zoningTriplet) {
    props = props || {};
    var zt = zoningTriplet || {};
    function merged(propVal, inferredNum) {
      if (msidNormForZoning(propVal) != null) {
        return propVal;
      }
      if (inferredNum != null && !isNaN(Number(inferredNum)) && Number(inferredNum) > 0) {
        return Math.round(Number(inferredNum));
      }
      return propVal;
    }
    return {
      Grade: props.Grade,
      MSID: HOMESCHOOL_ATTENDANCE_MSID,
      ELEM_: merged(props.Zoned_Elem, zt.elem),
      MID_: merged(props.Zoned_Midd, zt.mid),
      HIGH_: merged(props.Zoned_High, zt.high),
      INT_: null,
      lunch_stat: null,
      ethnicity: null,
      __homeschool: true,
    };
  }

  /**
   * Homeschool students grouped by `studentHexKey` for sandbox aggregation (same keys as `HOMESCHOOL_HEX_COUNTS`).
   */
  function buildHomeschoolDetailsByHexKey(homeschoolFc) {
    var byHex = Object.create(null);
    if (!homeschoolFc || !homeschoolFc.features) {
      return byHex;
    }
    var zoningByHex = Object.create(null);
    for (var i = 0; i < homeschoolFc.features.length; i++) {
      var f = homeschoolFc.features[i];
      var k = studentHexKey(f);
      if (!Object.prototype.hasOwnProperty.call(zoningByHex, k)) {
        zoningByHex[k] = homeschoolAttendanceZoningTripletForHex(k, f);
      }
      var det = homeschoolSandboxDetailFromProperties(f.properties, zoningByHex[k]);
      if (!byHex[k]) {
        byHex[k] = [];
      }
      byHex[k].push(det);
    }
    return byHex;
  }

  /**
   * Resolver for homeschool map layers and density tooltips: main student hex geometry when present,
   * else homeschool-source hex polygon for GRIDs not in the bundle.
   */
  function homeschoolHexGeometry(hexKey) {
    var k = String(hexKey);
    if (
      STUDENT_HEX_INDEX &&
      STUDENT_HEX_INDEX.geometryByHexKey &&
      STUDENT_HEX_INDEX.geometryByHexKey[k]
    ) {
      return STUDENT_HEX_INDEX.geometryByHexKey[k];
    }
    if (HOMESCHOOL_HEX_GEOMETRY_FALLBACK && HOMESCHOOL_HEX_GEOMETRY_FALLBACK[k]) {
      return HOMESCHOOL_HEX_GEOMETRY_FALLBACK[k];
    }
    /* Synthetic filler hexes (no students) — used so the sandbox map looks
       like a contiguous mesh instead of swiss-cheese with holes. */
    if (EMPTY_HEX_GEOMETRY && EMPTY_HEX_GEOMETRY[k]) {
      return EMPTY_HEX_GEOMETRY[k];
    }
    return null;
  }

  /**
   * Returns every hex key (student-hex layer + homeschool fallback + synthetic
   * "empty" filler mesh) whose centroid lies inside the school's assignment
   * polygon. This is the geographic superset used by the boundary-sandbox
   * pre-fill so that picking a base school populates the boundary with every
   * cell visually inside the boundary polygon — including swiss-cheese holes
   * where no grade-eligible students live.
   *
   * @returns {Object<string, true>}
   */
  function allHexKeysWithCentroidInAssignmentBoundary(msid) {
    var out = Object.create(null);
    if (msid == null || isNaN(Number(msid))) {
      return out;
    }
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.point !== "function" ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return out;
    }
    var bf = findBoundaryFeatureForMsid(Number(msid));
    if (!bf || !bf.geometry) {
      return out;
    }
    var polyFeat;
    try {
      polyFeat = turf.feature(bf.geometry);
    } catch (ePoly) {
      return out;
    }
    function consider(hexKey, geom) {
      if (out[hexKey]) return;
      if (!geom) return;
      var ctr = polygonCentroid(geom);
      if (!ctr || ctr.length < 2) return;
      var inside = false;
      try {
        inside = turf.booleanPointInPolygon(turf.point(ctr), polyFeat);
      } catch (eIn) {
        inside = false;
      }
      if (inside) out[hexKey] = true;
    }
    if (STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.geometryByHexKey) {
      var gk = STUDENT_HEX_INDEX.geometryByHexKey;
      for (var k in gk) {
        if (Object.prototype.hasOwnProperty.call(gk, k)) consider(k, gk[k]);
      }
    }
    if (HOMESCHOOL_HEX_GEOMETRY_FALLBACK) {
      var hf = HOMESCHOOL_HEX_GEOMETRY_FALLBACK;
      for (var hk in hf) {
        if (Object.prototype.hasOwnProperty.call(hf, hk)) consider(hk, hf[hk]);
      }
    }
    if (EMPTY_HEX_GEOMETRY) {
      var em = EMPTY_HEX_GEOMETRY;
      for (var ek in em) {
        if (Object.prototype.hasOwnProperty.call(em, ek)) consider(ek, em[ek]);
      }
    }
    return out;
  }

  /**
   * Hex keys where homeschool students live and the hex centroid lies inside the school’s assignment polygon.
   * Same geographic rule as capture KPIs / density alignment (not “zoned from student index only”).
   * @returns {Object<string, true>}
   */
  function homeschoolHexKeysWithCentroidInAssignmentBoundary(msid) {
    var out = Object.create(null);
    if (msid == null || isNaN(Number(msid))) {
      return out;
    }
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.point !== "function" ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return out;
    }
    if (!HOMESCHOOL_HEX_COUNTS) {
      return out;
    }
    var bf = findBoundaryFeatureForMsid(Number(msid));
    if (!bf || !bf.geometry) {
      return out;
    }
    var polyFeat;
    try {
      polyFeat = turf.feature(bf.geometry);
    } catch (ePoly) {
      return out;
    }
    for (var hexKey in HOMESCHOOL_HEX_COUNTS) {
      if (!Object.prototype.hasOwnProperty.call(HOMESCHOOL_HEX_COUNTS, hexKey)) {
        continue;
      }
      var cnt = Number(HOMESCHOOL_HEX_COUNTS[hexKey]) || 0;
      if (cnt <= 0) {
        continue;
      }
      var gHex = homeschoolHexGeometry(hexKey);
      if (!gHex) {
        continue;
      }
      var ctr = polygonCentroid(gHex);
      if (!ctr || ctr.length < 2) {
        continue;
      }
      var inside = false;
      try {
        inside = turf.booleanPointInPolygon(turf.point(ctr), polyFeat);
      } catch (eIn) {
        inside = false;
      }
      if (inside) {
        out[hexKey] = true;
      }
    }
    return out;
  }

  /**
   * Grade-eligible homeschool students where the hex centroid lies inside the school’s assignment polygon.
   * When per-student homeschool rows exist, counts only grades that match the school’s level band (same as From-To “resident” notion).
   */
  function countHomeschoolStudentsInAssignmentBoundary(msid) {
    if (msid == null || isNaN(Number(msid))) {
      return 0;
    }
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.point !== "function" ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return 0;
    }
    if (!HOMESCHOOL_HEX_COUNTS) {
      return 0;
    }
    var keyCache = String(Number(msid));
    if (Object.prototype.hasOwnProperty.call(homeschoolInBoundaryByMsidCache, keyCache)) {
      return homeschoolInBoundaryByMsidCache[keyCache];
    }
    var keyBag = homeschoolHexKeysWithCentroidInAssignmentBoundary(Number(msid));
    var m = masterRow(Number(msid));
    var total = 0;
    for (var hk in keyBag) {
      if (!keyBag[hk]) {
        continue;
      }
      var cnt = Number(HOMESCHOOL_HEX_COUNTS[hk]) || 0;
      var rows = HOMESCHOOL_DETAILS_BY_HEX_KEY && HOMESCHOOL_DETAILS_BY_HEX_KEY[hk];
      if (m && rows && rows.length) {
        for (var ir = 0; ir < rows.length; ir++) {
          var rd = rows[ir];
          if (rd && studentGradeInSelectedSchoolBand(rd.Grade, m, false)) {
            total += 1;
          }
        }
      } else {
        total += cnt;
      }
    }
    homeschoolInBoundaryByMsidCache[keyCache] = total;
    return total;
  }

  /**
   * Unpacks `v:2` { g: hexId -> geometry, r: property[] } to a standard FeatureCollection.
   * Falls back to a plain FeatureCollection. Used to avoid repeating hex geometry in JSON.
   * @param {*} raw
   * @returns {Object|null}
   */
  function expandStudentHexBundleToFeatureCollection(raw) {
    if (!raw) {
      return null;
    }
    if (raw.v === 2 && raw.g && Array.isArray(raw.r)) {
      var geoms = raw.g;
      var rows = raw.r;
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var pr = rows[i] || {};
        var hk = studentHexIdKeyFromProperties(pr);
        if (!hk) {
          continue;
        }
        var geom = geoms[hk];
        if (!geom) {
          continue;
        }
        out.push({ type: "Feature", properties: pr, geometry: geom });
      }
      return { type: "FeatureCollection", features: out };
    }
    if (raw.type === "FeatureCollection") {
      return raw;
    }
    return null;
  }

  /**
   * One object per student for filters (grade / zoned MSIDs). ArcGIS exports use `Grade`
   * inconsistently; fall back to `grade` or `StudGRD` when `Grade` is empty.
   * @param {Object} p feature.properties
   * @returns {{ Grade: string, MSID: string, ELEM_: *, MID_: *, INT_: *, HIGH_: * }}
   */
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

  /**
   * Attendance MSID in district charter 65xx / 66xx range (residential density layer).
   */
  function attendanceMsidIsCharterDistrictResidentialRange(msid) {
    var n = Number(msid);
    if (!isFinite(n) || isNaN(n)) return false;
    return n >= 6500 && n <= 6699;
  }

  /**
   * Generates a set of synthetic "filler" hex polygons that close the gaps in
   * `geometryByHexKey`, so the boundary-sandbox map appears as a contiguous
   * hex mesh instead of swiss-cheese-with-holes wherever no students live.
   * The filler hexes have no student data, so every aggregation naturally
   * sees zero counts for them.
   *
   * Algorithm (kept intentionally simple and bounded):
   *   1. Sample one real hex to capture its 6 vertex offsets relative to its
   *      centroid, plus its width (east-west) and height (north-south).
   *   2. Derive the 6 neighbor center-to-center offsets for a flat-top hex
   *      grid (the orientation used in the source data — east/west pointy,
   *      north/south flat).
   *   3. Bin every existing centroid into a coarse grid for O(1) "is this
   *      position already a hex?" lookups.
   *   4. BFS outward from existing centroids up to `MAX_DEPTH` rings, adding
   *      synthetic hexes at every previously-empty position. Capped at
   *      `MAX_EMPTY` for safety.
   *
   * @param {Object<string, *>} geometryByHexKey
   * @returns {Object<string, GeoJSON.Polygon>} hexKey -> filler polygon
   */
  /**
   * @param {Object<string,Object>} geometryByHexKey - student-residence hex geometries (define grid + footprint).
   * @param {Object<string,Object>} [extraOccupiedGeometryByKey] - additional real hexes (e.g. homeschool
   *   fallback) whose cells must be treated as occupied so filler hexes are NOT generated on top of them.
   *   Without this, fillers overlap homeschool hexes (double fill-opacity → darker, and the stacked
   *   feature can't be fully erased).
   * @param {Array<Object>} [assignmentBoundaryFeatures] - ES/MS/HS assignment polygon features. When
   *   provided, the mesh fills EVERY grid cell whose centroid lies inside any assignment boundary
   *   (closing interior "swiss-cheese" holes with no students), with no depth limit inside boundaries.
   *   Cells outside all boundaries are limited to a small outward halo (they're non-selectable anyway).
   */
  function buildEmptyHexGeometryMesh(geometryByHexKey, extraOccupiedGeometryByKey, assignmentBoundaryFeatures) {
    var out = Object.create(null);
    if (!geometryByHexKey) return out;
    /* 1. Find a usable sample hex (6 distinct vertices). */
    var sampleKey = null;
    var sampleGeom = null;
    for (var sk in geometryByHexKey) {
      if (!Object.prototype.hasOwnProperty.call(geometryByHexKey, sk)) continue;
      var g0 = geometryByHexKey[sk];
      if (
        g0 &&
        g0.type === "Polygon" &&
        g0.coordinates &&
        g0.coordinates[0] &&
        g0.coordinates[0].length >= 7
      ) {
        sampleKey = sk;
        sampleGeom = g0;
        break;
      }
    }
    if (!sampleGeom) return out;
    var sampleCentroid = polygonCentroid(sampleGeom);
    if (!sampleCentroid) return out;
    /* 2. Capture hex shape offsets and bbox. */
    var ring = sampleGeom.coordinates[0];
    var hexShape = [];
    var hexMaxX = -Infinity, hexMinX = Infinity, hexMaxY = -Infinity, hexMinY = Infinity;
    for (var ri = 0; ri < ring.length - 1; ri++) {
      var ddx = ring[ri][0] - sampleCentroid[0];
      var ddy = ring[ri][1] - sampleCentroid[1];
      hexShape.push([ddx, ddy]);
      if (ddx > hexMaxX) hexMaxX = ddx;
      if (ddx < hexMinX) hexMinX = ddx;
      if (ddy > hexMaxY) hexMaxY = ddy;
      if (ddy < hexMinY) hexMinY = ddy;
    }
    if (hexShape.length !== 6) return out;
    var w = hexMaxX - hexMinX;
    var h = hexMaxY - hexMinY;
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return out;
    /* 3. Neighbor center-to-center offsets for a flat-top hex grid. */
    var neighborOffsets = [
      [0, h], [0, -h],
      [(3 * w) / 4, h / 2], [(-3 * w) / 4, h / 2],
      [(3 * w) / 4, -h / 2], [(-3 * w) / 4, -h / 2],
    ];
    /* 4. Bin-based occupied lookup. binSize comfortably larger than a hex so
       lookups stay within ±1 bin around the query. */
    var binSize = Math.max(w, h) * 1.25;
    var matchTolSq = (w * 0.2) * (w * 0.2); /* "same position" tolerance */
    var occupied = Object.create(null);
    function binKey(x, y) {
      return Math.floor(x / binSize) + "," + Math.floor(y / binSize);
    }
    function addOccupiedAt(x, y) {
      var bid = binKey(x, y);
      if (!occupied[bid]) occupied[bid] = [];
      occupied[bid].push([x, y]);
    }
    function isOccupiedAt(x, y) {
      var bx = Math.floor(x / binSize);
      var by = Math.floor(y / binSize);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var entries = occupied[(bx + dx) + "," + (by + dy)];
          if (!entries) continue;
          for (var i = 0; i < entries.length; i++) {
            var ex = entries[i][0] - x;
            var ey = entries[i][1] - y;
            if (ex * ex + ey * ey < matchTolSq) return true;
          }
        }
      }
      return false;
    }
    /* Seed occupied with every existing hex centroid. Track a list of seeds
       for the BFS frontier. */
    var seeds = [];
    for (var ek in geometryByHexKey) {
      if (!Object.prototype.hasOwnProperty.call(geometryByHexKey, ek)) continue;
      var c = polygonCentroid(geometryByHexKey[ek]);
      if (!c) continue;
      addOccupiedAt(c[0], c[1]);
      seeds.push([c[0], c[1]]);
    }
    /* Also mark non-student real hexes (homeschool fallback) as occupied so we
       never spawn a filler hex on top of them. They join the BFS frontier too,
       so the mesh still grows around the full real footprint. */
    if (extraOccupiedGeometryByKey) {
      for (var xk in extraOccupiedGeometryByKey) {
        if (!Object.prototype.hasOwnProperty.call(extraOccupiedGeometryByKey, xk)) continue;
        var cx = polygonCentroid(extraOccupiedGeometryByKey[xk]);
        if (!cx) continue;
        if (isOccupiedAt(cx[0], cx[1])) continue;
        addOccupiedAt(cx[0], cx[1]);
        seeds.push([cx[0], cx[1]]);
      }
    }
    if (!seeds.length) return out;
    /* 4b. Optional assignment-boundary containment test (with per-polygon bbox
       prefilter for speed). When available, the BFS fills ALL cells inside any
       boundary so interior holes close; outside cells get only a small halo. */
    var boundaryTest = null;
    if (
      assignmentBoundaryFeatures &&
      assignmentBoundaryFeatures.length &&
      typeof turf !== "undefined" &&
      turf &&
      typeof turf.point === "function" &&
      typeof turf.booleanPointInPolygon === "function"
    ) {
      var bpolys = [];
      for (var bi = 0; bi < assignmentBoundaryFeatures.length; bi++) {
        var bft = assignmentBoundaryFeatures[bi];
        if (!bft || !bft.geometry || !bft.geometry.coordinates) continue;
        var bb = [Infinity, Infinity, -Infinity, -Infinity];
        (function scan(a) {
          if (typeof a[0] === "number") {
            if (a[0] < bb[0]) bb[0] = a[0];
            if (a[1] < bb[1]) bb[1] = a[1];
            if (a[0] > bb[2]) bb[2] = a[0];
            if (a[1] > bb[3]) bb[3] = a[1];
            return;
          }
          for (var z = 0; z < a.length; z++) scan(a[z]);
        })(bft.geometry.coordinates);
        if (isFinite(bb[0])) bpolys.push({ ft: bft, bb: bb });
      }
      if (bpolys.length) {
        boundaryTest = function (x, y) {
          for (var i = 0; i < bpolys.length; i++) {
            var b = bpolys[i].bb;
            if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
            try {
              if (turf.booleanPointInPolygon(turf.point([x, y]), bpolys[i].ft)) {
                return true;
              }
            } catch (eBt) {
              /* skip malformed polygon */
            }
          }
          return false;
        };
      }
    }
    /* 5. BFS expansion from the real footprint. Cells inside an assignment
       boundary are always filled (no depth cap → interior holes close). Cells
       outside all boundaries (or when no boundary info is available) are limited
       to a small outward halo for a clean edge — they're non-selectable anyway. */
    var HALO_DEPTH = 3;
    var MAX_DEPTH_SAFETY = 800;
    var MAX_EMPTY = 100000;
    var fillerHexes = []; /* [[x, y], ...] */
    var frontier = seeds;
    for (var depth = 1; depth <= MAX_DEPTH_SAFETY; depth++) {
      var nextFrontier = [];
      for (var fi = 0; fi < frontier.length; fi++) {
        var fx = frontier[fi][0];
        var fy = frontier[fi][1];
        for (var oi = 0; oi < neighborOffsets.length; oi++) {
          var nx = fx + neighborOffsets[oi][0];
          var ny = fy + neighborOffsets[oi][1];
          if (isOccupiedAt(nx, ny)) continue;
          var insideB = boundaryTest ? boundaryTest(nx, ny) : depth <= HALO_DEPTH;
          if (!insideB && depth > HALO_DEPTH) continue;
          addOccupiedAt(nx, ny);
          fillerHexes.push([nx, ny]);
          nextFrontier.push([nx, ny]);
          if (fillerHexes.length >= MAX_EMPTY) break;
        }
        if (fillerHexes.length >= MAX_EMPTY) break;
      }
      if (fillerHexes.length >= MAX_EMPTY) break;
      if (nextFrontier.length === 0) break;
      frontier = nextFrontier;
    }
    /* 6. Materialize polygons for each filler hex. */
    for (var emi = 0; emi < fillerHexes.length; emi++) {
      var c2 = fillerHexes[emi];
      var poly = [];
      for (var hsi = 0; hsi < hexShape.length; hsi++) {
        poly.push([c2[0] + hexShape[hsi][0], c2[1] + hexShape[hsi][1]]);
      }
      poly.push([poly[0][0], poly[0][1]]); /* close ring */
      out["empty:" + emi] = { type: "Polygon", coordinates: [poly] };
    }
    return out;
  }

  function buildStudentHexIndex(fc) {
    var countsByMsid = {};
    var geometryByHexKey = {};
    var detailsByMsid = {};
    var charterDistrictHexCounts = {};
    if (!fc || !fc.features) {
      return {
        countsByMsid: countsByMsid,
        geometryByHexKey: geometryByHexKey,
        detailsByMsid: detailsByMsid,
        charterDistrictHexCounts: charterDistrictHexCounts,
        neighborsByHexKey: Object.create(null),
      };
    }
    for (var i = 0; i < fc.features.length; i++) {
      var f = fc.features[i];
      var p = f.properties || {};
      var msid = Number(
        p.MSID != null ? p.MSID : p.SCHOOLS_ID != null ? p.SCHOOLS_ID : NaN
      );
      if (isNaN(msid)) continue;
      var key = studentHexKey(f);
      if (!geometryByHexKey[key]) {
        geometryByHexKey[key] = f.geometry;
      }
      var sk = String(msid);
      if (!countsByMsid[sk]) countsByMsid[sk] = {};
      var inc = 1;
      if (p.count != null && isFinite(Number(p.count))) {
        inc = Number(p.count);
      }
      countsByMsid[sk][key] = (countsByMsid[sk][key] || 0) + inc;

      if (attendanceMsidIsCharterDistrictResidentialRange(msid)) {
        charterDistrictHexCounts[key] =
          (charterDistrictHexCounts[key] || 0) + inc;
      }

      if (!detailsByMsid[sk]) detailsByMsid[sk] = {};
      if (!detailsByMsid[sk][key]) detailsByMsid[sk][key] = [];
      var det = studentHexDetailFromProps(p);
      if (inc === 1) {
        detailsByMsid[sk][key].push(det);
      } else {
        for (var jd = 0; jd < inc; jd++) {
          detailsByMsid[sk][key].push(Object.assign({}, det));
        }
      }
    }
    var neighborsByHexKey = buildHexNeighborMap(geometryByHexKey);
    if (!neighborsByHexKey) {
      neighborsByHexKey = Object.create(null);
    }
    return {
      countsByMsid: countsByMsid,
      geometryByHexKey: geometryByHexKey,
      detailsByMsid: detailsByMsid,
      charterDistrictHexCounts: charterDistrictHexCounts,
      neighborsByHexKey: neighborsByHexKey,
    };
  }

  /**
   * Every feature in the student hex file (not filtered by attendance MSID);
   * per-hex grade counts and centroids for travel-shed PIP aggregation.
   */
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
      if (!geometryByHexKey[key0]) {
        geometryByHexKey[key0] = f0.geometry;
      }
      var p0 = f0.properties || {};
      var inc0 = 1;
      if (p0.count != null && isFinite(Number(p0.count))) {
        inc0 = Number(p0.count);
      }
      var det0 = studentHexDetailFromProps(p0);
      var gCanon = canonicalStudentGradeCode(det0.Grade);
      if (gCanon == null || gCanon === "") {
        gCanon = "__UNK__";
      }
      if (!gradeCountsByHex[key0]) gradeCountsByHex[key0] = {};
      gradeCountsByHex[key0][gCanon] = (gradeCountsByHex[key0][gCanon] || 0) + inc0;
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

  function travelShedGradeSortKey(canon) {
    if (canon === "PK") return 0;
    if (canon === "K") return 1;
    if (canon === "__NOGRADE__") return 9998;
    if (canon === "__UNK__") return 9999;
    if (/^0[1-9]$/.test(canon)) return 2 + parseInt(canon, 10);
    if (/^1[0-2]$/.test(canon)) return 2 + parseInt(canon, 10);
    return 5000;
  }

  function travelShedGradeDisplayLabel(canon) {
    if (canon === "__NOGRADE__") return "No Grade";
    if (canon === "__UNK__") return "—";
    if (canon === "PK" || canon === "K") return canon;
    if (/^0[1-9]$/.test(canon)) return String(parseInt(canon, 10));
    return String(canon);
  }

  /**
   * Representative string so `studentGradeInSelectedSchoolBand` re-canonicalizes like source Grade.
   */
  function travelShedRawGradeStringForBand(canon) {
    if (canon === "__UNK__") return "";
    if (canon === "PK" || canon === "K") return canon;
    if (/^0[1-9]$/.test(canon)) return String(parseInt(canon, 10));
    if (/^1[0-2]$/.test(canon)) return canon;
    return String(canon);
  }

  function clearTravelShedResidenceDebounce() {
    if (travelShedResidenceDebounceId != null) {
      try {
        clearTimeout(travelShedResidenceDebounceId);
      } catch (e) {
        /* ignore */
      }
      travelShedResidenceDebounceId = null;
    }
  }

  /**
   * Mapbox returns rendered GeoJSON geometries clipped to the current tile / viewport.
   * Use the original in-memory isochrone feature so hover residence totals do not
   * change by zoom level or by which side of the shed the user hovers.
   */
  function fullTravelShedIsochroneGeometryForProps(props) {
    if (
      !props ||
      !SCHOOL_ISOCHRONES_ENRICHED ||
      !SCHOOL_ISOCHRONES_ENRICHED.features
    ) {
      return null;
    }
    var msid = Number(props.iso_msid);
    var miles = Number(props.iso_miles);
    if (isNaN(msid) || isNaN(miles)) {
      return null;
    }
    var feats = SCHOOL_ISOCHRONES_ENRICHED.features;
    for (var i = 0; i < feats.length; i++) {
      var f = feats[i];
      var p = f && f.properties;
      if (!f || !f.geometry || !p) continue;
      if (Number(p.iso_msid) === msid && Number(p.iso_miles) === miles) {
        return f.geometry;
      }
    }
    return null;
  }

  /**
   * Sums all hex-residence grade buckets whose hex **centroid** lies inside the isochrone polygon
   * (or MultiPolygon). Returns map canonical grade key -> count.
   */
  function travelShedResidenceCountsInIsochrone(isoGeometry) {
    if (!TRAVEL_SHED_RESIDENCE_INDEX || !isoGeometry) return null;
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.point !== "function" ||
      typeof turf.feature !== "function" ||
      typeof turf.booleanPointInPolygon !== "function"
    ) {
      return null;
    }
    var idx = TRAVEL_SHED_RESIDENCE_INDEX;
    if (!idx.hexKeyList || !idx.hexKeyList.length) {
      return {};
    }
    var polyFeat;
    try {
      polyFeat = turf.feature(isoGeometry);
    } catch (ePoly) {
      return null;
    }
    var bbox;
    try {
      bbox = turf.bbox(polyFeat);
    } catch (eB) {
      bbox = null;
    }
    var totalByCanon = {};
    var hlist = idx.hexKeyList;
    for (var i1 = 0; i1 < hlist.length; i1++) {
      var hkx = hlist[i1];
      var c1 = idx.centroidsByHex[hkx];
      if (!c1 || c1.length < 2) continue;
      if (bbox && bbox.length === 4) {
        if (
          c1[0] < bbox[0] ||
          c1[0] > bbox[2] ||
          c1[1] < bbox[1] ||
          c1[1] > bbox[3]
        ) {
          continue;
        }
      }
      var ptf;
      try {
        ptf = turf.point(c1);
      } catch (eP) {
        continue;
      }
      var ins;
      try {
        ins = turf.booleanPointInPolygon(ptf, polyFeat);
      } catch (eI) {
        continue;
      }
      if (!ins) continue;
      var gch = idx.gradeCountsByHex[hkx];
      if (!gch) continue;
      for (var gkx in gch) {
        if (!Object.prototype.hasOwnProperty.call(gch, gkx)) continue;
        totalByCanon[gkx] = (totalByCanon[gkx] || 0) + gch[gkx];
      }
    }
    return totalByCanon;
  }

  function formatTravelShedResidenceHtml(totalByCanon, m, milesRounded) {
    var titleSchool = travelShedTitleSchoolNameForMsid(m);
    var miN =
      milesRounded != null && isFinite(milesRounded)
        ? Math.round(milesRounded)
        : 0;
    var titleMain =
      escapeHtml(titleSchool) + ": " + (miN > 0 ? miN : "—") + " Mi Travel Shed";
    var gradesServedDisplay =
      m && m.grades_served
        ? standardCapitalization(normalizeGradesServedForUi(m.grades_served))
        : "";
    var gradesAnnotation = gradesServedDisplay
      ? '<span class="travel-shed-hover-title__grades">Grades Served: <strong>' +
          escapeHtml(gradesServedDisplay) +
          "</strong></span>"
      : "";
    var titleLine =
      '<span class="travel-shed-hover-title__main">' +
      titleMain +
      "</span>" +
      gradesAnnotation;
    if (!totalByCanon || !Object.keys(totalByCanon).length) {
      return (
        '<div class="travel-shed-hover-inner travel-shed-hover-inner--residence">' +
        '<div class="travel-shed-hover-title">' +
        titleLine +
        "</div>" +
        '<p class="travel-shed-residence-empty">No student residence hexes with centroids inside this area (or residence data not loaded yet).</p></div>'
      );
    }
    var keys = Object.keys(totalByCanon);
    keys.sort(function (a, b) {
      return travelShedGradeSortKey(a) - travelShedGradeSortKey(b);
    });
    var headerHtml =
      '<div class="travel-shed-residence-header">' +
      '<span class="travel-shed-residence-h-grade">Grade</span>' +
      '<span class="travel-shed-residence-h-n">Student Residences</span></div>';
    function rowHtml(ckey) {
      var nct = totalByCanon[ckey];
      var gRaw = travelShedRawGradeStringForBand(ckey);
      var isServed =
        m && gRaw !== "" && studentGradeInSelectedSchoolBand(gRaw, m, false);
      var numStr = (nct != null ? Number(nct) : 0).toLocaleString();
      var lab = travelShedGradeDisplayLabel(ckey);
      var h =
        '<div class="travel-shed-residence-row' +
        (isServed ? " travel-shed-residence-row--served" : "") +
        '"><span class="travel-shed-residence-grade">' +
        escapeHtml(lab) +
        '</span><span class="travel-shed-residence-n">';
      if (isServed) {
        h += "<strong>" + escapeHtml(numStr) + "</strong>";
      } else {
        h += escapeHtml(numStr);
      }
      return h + "</span></div>";
    }
    var nK = keys.length;
    var useTwoCols = nK > 5;
    var mid = Math.ceil(nK / 2);
    var kLeft = useTwoCols ? keys.slice(0, mid) : keys;
    var kRight = useTwoCols ? keys.slice(mid) : [];
    var i3;
    var leftRows = [];
    for (i3 = 0; i3 < kLeft.length; i3++) {
      leftRows.push(rowHtml(kLeft[i3]));
    }
    var rightRows = [];
    for (i3 = 0; i3 < kRight.length; i3++) {
      rightRows.push(rowHtml(kRight[i3]));
    }
    var tableBody;
    if (!useTwoCols) {
      tableBody =
        '<div class="travel-shed-residence-grades travel-shed-residence-grades--1col">' +
        headerHtml +
        '<div class="travel-shed-residence-rows">' +
        leftRows.join("") +
        "</div></div>";
    } else {
      tableBody =
        '<div class="travel-shed-residence-grades travel-shed-residence-grades--2col">' +
        '<div class="travel-shed-residence-pane">' +
        headerHtml +
        '<div class="travel-shed-residence-rows">' +
        leftRows.join("") +
        "</div></div>" +
        '<div class="travel-shed-residence-pane">' +
        headerHtml +
        '<div class="travel-shed-residence-rows">' +
        rightRows.join("") +
        "</div></div></div>";
    }
    return (
      '<div class="travel-shed-hover-inner travel-shed-hover-inner--residence">' +
      '<div class="travel-shed-hover-title">' +
      titleLine +
      "</div>" +
      tableBody +
      "</div>"
    );
  }

  function travelShedTitleSchoolNameForMsid(m) {
    if (m && m.school_name) {
      return eseTableAbbreviatedSchoolName(m);
    }
    return "School";
  }

  function getActiveDashboardSchoolMsid() {
    if (isBoundarySandboxViewActive()) {
      return getSandboxBaseSchoolMsid();
    }
    var panelScenario = document.getElementById("page-scenario");
    if (panelScenario && !panelScenario.hidden) {
      if (scenarioMiddleMsid != null && !isNaN(scenarioMiddleMsid)) {
        return scenarioMiddleMsid;
      }
      return null;
    }
    var sel = document.getElementById("school-select");
    if (!sel || !sel.value) return null;
    var v = Number(sel.value);
    return isNaN(v) ? null : v;
  }

  function isStudentResidenceLayerEnabled() {
    var inp = document.getElementById("toggle-student-hex");
    return !inp || inp.checked;
  }

  function isCharterStudentResidenceLayerEnabled() {
    var inp = document.getElementById("toggle-charter-student-hex");
    return !inp || inp.checked;
  }

  function isHomeschoolStudentResidenceLayerEnabled() {
    var inp = document.getElementById("toggle-homeschool-student-hex");
    return !inp || inp.checked;
  }

  /**
   * Scenario: hex rows are keyed by each student's school MSID.
   * Always include students enrolled at the selected middle school, then add
   * checked feeder elementaries (same feeder rules as collectScenarioWeightedSpec).
   */
  function buildMergedScenarioStudentHexCounts() {
    var combined = {};
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.countsByMsid) {
      return combined;
    }
    var byMs = STUDENT_HEX_INDEX.countsByMsid;

    function addPart(msid) {
      if (msid == null || isNaN(msid)) return;
      var part = byMs[String(msid)];
      if (!part) return;
      for (var hexKey in part) {
        if (!Object.prototype.hasOwnProperty.call(part, hexKey)) continue;
        combined[hexKey] = (combined[hexKey] || 0) + part[hexKey];
      }
    }

    for (var i = 0; i < scenarioLastFeederRows.length; i++) {
      var r = scenarioLastFeederRows[i];
      if (!r.hasEnrollment || r.msid == null || isNaN(r.msid)) continue;
      if (scenarioFeederChecked[r.msid] === false) continue;
      addPart(r.msid);
    }
    return combined;
  }

  /**
   * Same MSIDs as buildMergedScenarioStudentHexCounts: concat per-student rows per hex
   * (for grade / zoned-school filters in scenario mode).
   */
  function buildMergedScenarioStudentHexDetailsByHex() {
    var combined = {};
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.detailsByMsid) {
      return combined;
    }
    var byDet = STUDENT_HEX_INDEX.detailsByMsid;

    function appendPart(msid, isBaseRow) {
      if (msid == null || isNaN(msid)) return;
      var part = byDet[String(msid)];
      if (!part) return;
      for (var hexKey in part) {
        if (!Object.prototype.hasOwnProperty.call(part, hexKey)) continue;
        var arr = part[hexKey];
        if (!arr || !arr.length) continue;
        if (!combined[hexKey]) combined[hexKey] = [];
        for (var t = 0; t < arr.length; t++) {
          var det = arr[t];
          var gc = canonicalStudentGradeCode(det.Grade);
          if (
            gc &&
            !scenarioGradeIncludedForMsid(msid, gc, !!isBaseRow)
          ) {
            continue;
          }
          combined[hexKey].push(det);
        }
      }
    }

    for (var j = 0; j < scenarioLastFeederRows.length; j++) {
      var r2 = scenarioLastFeederRows[j];
      if (!r2.hasEnrollment || r2.msid == null || isNaN(r2.msid)) continue;
      if (scenarioFeederChecked[r2.msid] === false) continue;
      appendPart(r2.msid, !!r2.isScenarioMiddleRow);
    }
    return combined;
  }

  /**
   * Per-hex student rows for the active dashboard cohort (selected school or scenario merge).
   * @returns {Object<string, Array<{Grade: string, MSID: string, ELEM_: *, MID_: *, INT_: *, HIGH_: *}>>}
   */
  function getStudentHexCohortDetailsByHex() {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.detailsByMsid) {
      return {};
    }
    var panelScenario = document.getElementById("page-scenario");
    var onScenario = panelScenario && !panelScenario.hidden;
    if (
      onScenario &&
      scenarioMiddleMsid != null &&
      !isNaN(scenarioMiddleMsid)
    ) {
      return buildMergedScenarioStudentHexDetailsByHex();
    }
    var msid = getActiveDashboardSchoolMsid();
    if (msid == null || isNaN(msid)) return {};
    return STUDENT_HEX_INDEX.detailsByMsid[String(msid)] || {};
  }

  /** Meadowlane Primary (2041) K–2; Intermediate (2031) 3–6; other elementaries PK–6. */
  var MEADOWLANE_PRIMARY_MSID = 2041;
  var MEADOWLANE_INTERMEDIATE_MSID = 2031;

  function studentHexDedupeKey(d) {
    if (d && d._oid != null && String(d._oid) !== "") {
      return String(d._oid);
    }
    return (
      "c:" +
      String((d && d.MSID) || "") +
      "|g:" +
      String((d && d.Grade) || "") +
      "|e:" +
      String((d && d.ELEM_) != null ? d.ELEM_ : "") +
      "|m:" +
      String((d && d.MID_) != null ? d.MID_ : "") +
      "|i:" +
      String((d && d.INT_) != null ? d.INT_ : "") +
      "|h:" +
      String((d && d.HIGH_) != null ? d.HIGH_ : "")
    );
  }

  function msidNormForZoning(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }

  /**
   * @param {string} raw from Grade / grade / StudGRD
   * @returns {string|null} PK | K | 01..12
   */
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

  /** Ordinal for min–max span: Pre-K −2, K −1, grade 1–12 as numbers (matches private-school labels). */
  function charterGradeCanonToOrdinal(canon) {
    if (canon == null || canon === "") return null;
    if (canon === "PK") return -2;
    if (canon === "K") return -1;
    var n = parseInt(String(canon), 10);
    if (isNaN(n)) return null;
    return n;
  }

  /** @returns {Object<string, true>} */
  function elementaryGradeAllowedSet(msidNum) {
    var o = {};
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
    for (var g = 1; g <= 6; g++) {
      o[g < 10 ? "0" + g : String(g)] = true;
    }
    return o;
  }

  /**
   * @param {string} gradeRaw
   * @param {Object|null} m master row for selected / scenario middle school
   * @param {boolean} scenarioMiddleZoned grade 07–08 only (MID_ zoning to scenario middle)
   */
  function studentGradeInSelectedSchoolBand(gradeRaw, m, scenarioMiddleZoned) {
    if (!m) return false;
    if (scenarioMiddleZoned) {
      var cm = canonicalStudentGradeCode(gradeRaw);
      return cm === "07" || cm === "08";
    }
    var g = canonicalStudentGradeCode(gradeRaw);
    if (!g) return false;
    var msidNum = parseInt(String(m.msid || "").trim(), 10);
    var lv = String(m.school_level || "").toLowerCase().trim();
    if (lv === "elementary") {
      var setE = elementaryGradeAllowedSet(msidNum);
      return !!setE[g];
    }
    if (lv === "middle") {
      return g === "07" || g === "08";
    }
    if (lv === "high") {
      return g === "09" || g === "10" || g === "11" || g === "12";
    }
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
    var lv = String(schoolLevel || "").toLowerCase().trim();
    if (lv === "elementary") {
      return msidNormForZoning(d.ELEM_) === targetNum;
    }
    if (lv === "middle") {
      return msidNormForZoning(d.MID_) === targetNum;
    }
    if (lv === "high") {
      return msidNormForZoning(d.HIGH_) === targetNum;
    }
    if (lv === "jr_sr_high") {
      return (
        msidNormForZoning(d.MID_) === targetNum ||
        msidNormForZoning(d.INT_) === targetNum ||
        msidNormForZoning(d.HIGH_) === targetNum
      );
    }
    return false;
  }

  /**
   * Zoned assignment MSID for a student for aggregate charts (ELEM_ / MID_ / HIGH_ by grade band).
   * Does not use a “target” school — mirrors typical PK–6, 7–8, 9–12 column use in the layer.
   */
  function zonedMsidForDetailForAggregate(d) {
    if (!d) {
      return null;
    }
    var g = canonicalStudentGradeCode(d.Grade);
    if (!g) {
      return null;
    }
    if (g === "PK" || g === "K" || g === "01" || g === "02" || g === "03" || g === "04" || g === "05" || g === "06") {
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

  /** Aligned with school_master lunch columns: blank / missing → Not free/reduced (same as existing & scenario views). */
  function normalizeSandboxLunchStatForPie(raw) {
    if (raw == null) {
      return "Not free/reduced";
    }
    var t = String(raw).trim();
    if (!t) {
      return "Not free/reduced";
    }
    var u = t.toLowerCase();
    if (u === "f" || u === "free") {
      return "Free";
    }
    if (u === "r" || u === "reduced" || u.indexOf("reduced") >= 0) {
      return "Reduced";
    }
    if (u === "n" || u.indexOf("not free") >= 0) {
      return "Not free/reduced";
    }
    if (u === "unspecified" || u === "unknown" || u === "—" || u === "-") {
      return "Not free/reduced";
    }
    return t;
  }

  /**
   * All students (any attendance MSID) zoned to target school in `m`'s level band,
   * or scenario middle (MID_ === target, grades 07–08).
   */
  function collectZonedDetailsByHex(targetMsid, m, scenarioMiddleZoned) {
    var out = {};
    if (
      !STUDENT_HEX_INDEX ||
      !STUDENT_HEX_INDEX.detailsByMsid ||
      targetMsid == null ||
      isNaN(targetMsid) ||
      !m
    ) {
      return out;
    }
    var tgt = Number(targetMsid);
    var lvl = String(m.school_level || "").toLowerCase().trim();
    if (scenarioMiddleZoned) {
      lvl = "middle";
    }
    var byDet = STUDENT_HEX_INDEX.detailsByMsid;
    for (var attMs in byDet) {
      if (!Object.prototype.hasOwnProperty.call(byDet, attMs)) continue;
      var hexMap = byDet[attMs];
      for (var hk in hexMap) {
        if (!Object.prototype.hasOwnProperty.call(hexMap, hk)) continue;
        var arr = hexMap[hk];
        if (!arr || !arr.length) continue;
        for (var i = 0; i < arr.length; i++) {
          var d = arr[i];
          if (!studentGradeInSelectedSchoolBand(d.Grade, m, scenarioMiddleZoned)) {
            continue;
          }
          if (!detailMatchesZonedTargetMsid(d, tgt, lvl)) continue;
          if (!out[hk]) out[hk] = [];
          out[hk].push(d);
        }
      }
    }
    return out;
  }

  /**
   * Sums per-hex student counts over every school MSID in the index (no selection filter).
   * @returns {Object<string, number>|null}
   */
  function buildAllSchoolsHexDisplayCountsByHex() {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.countsByMsid) {
      return null;
    }
    var byM = STUDENT_HEX_INDEX.countsByMsid;
    var out = Object.create(null);
    for (var msk in byM) {
      if (!Object.prototype.hasOwnProperty.call(byM, msk)) continue;
      var hmap = byM[msk];
      if (!hmap || typeof hmap !== "object") continue;
      for (var hk in hmap) {
        if (!Object.prototype.hasOwnProperty.call(hmap, hk)) continue;
        var c = Number(hmap[hk]) || 0;
        if (c <= 0) continue;
        out[hk] = (out[hk] || 0) + c;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Per-hex counts for map overlay from attending / zoned toggles (union deduped per hex).
   * @returns {Object<string, number>|null} null = no overlay; object may be empty
   */
  function buildStudentHexDisplayCountsByHex() {
    var attEl = document.getElementById("toggle-student-hex-attending");
    var zonEl = document.getElementById("toggle-student-hex-zoned");
    var attOn = !attEl || attEl.checked;
    var zonedOn = !!(zonEl && zonEl.checked && !zonEl.disabled);

    if (!attOn && !zonedOn) {
      return null;
    }
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.countsByMsid) {
      return null;
    }

    var panelScenario = document.getElementById("page-scenario");
    var onScenario = panelScenario && !panelScenario.hidden;
    var targetMsid = getActiveDashboardSchoolMsid();
    if (targetMsid == null || isNaN(targetMsid)) {
      if (zonedOn && !attOn) {
        return null;
      }
      if (attOn) {
        return buildAllSchoolsHexDisplayCountsByHex();
      }
      return null;
    }
    var m = masterRow(targetMsid);

    if (attOn && !zonedOn) {
      if (
        onScenario &&
        scenarioMiddleMsid != null &&
        !isNaN(scenarioMiddleMsid)
      ) {
        return buildMergedScenarioStudentHexCounts();
      }
      var simple = STUDENT_HEX_INDEX.countsByMsid[String(targetMsid)];
      return simple && typeof simple === "object" ? simple : null;
    }

    var perHexKeys = {};
    function touch(hk, dedupeKey) {
      if (!dedupeKey) return;
      if (!perHexKeys[hk]) perHexKeys[hk] = {};
      if (perHexKeys[hk][dedupeKey]) return;
      perHexKeys[hk][dedupeKey] = true;
    }

    if (attOn) {
      var detByHex =
        onScenario &&
        scenarioMiddleMsid != null &&
        !isNaN(scenarioMiddleMsid)
          ? buildMergedScenarioStudentHexDetailsByHex()
          : STUDENT_HEX_INDEX.detailsByMsid[String(targetMsid)] || {};
      for (var hka in detByHex) {
        if (!Object.prototype.hasOwnProperty.call(detByHex, hka)) continue;
        var arrA = detByHex[hka];
        if (!arrA) continue;
        for (var ia = 0; ia < arrA.length; ia++) {
          touch(hka, studentHexDedupeKey(arrA[ia]));
        }
      }
    }

    if (zonedOn && m) {
      var isScenarioZoned =
        !!(
          onScenario &&
          scenarioMiddleMsid != null &&
          !isNaN(scenarioMiddleMsid)
        );
      var scenarioZonedMiddleOnly =
        isScenarioZoned &&
        String(m.school_level || "").toLowerCase().trim() === "middle";
      var zMap = collectZonedDetailsByHex(
        targetMsid,
        m,
        scenarioZonedMiddleOnly
      );
      for (var hkz in zMap) {
        if (!Object.prototype.hasOwnProperty.call(zMap, hkz)) continue;
        var arrZ = zMap[hkz];
        if (!arrZ) continue;
        for (var iz = 0; iz < arrZ.length; iz++) {
          touch(hkz, studentHexDedupeKey(arrZ[iz]));
        }
      }
    }

    var idxOut = {};
    for (var hkf in perHexKeys) {
      if (!Object.prototype.hasOwnProperty.call(perHexKeys, hkf)) continue;
      var bucket = perHexKeys[hkf];
      var n = 0;
      for (var kk in bucket) {
        if (Object.prototype.hasOwnProperty.call(bucket, kk)) n++;
      }
      if (n > 0) idxOut[hkf] = n;
    }
    return idxOut;
  }

  function syncStudentHexResidenceSubToggleAvailability() {
    var panelScenario = document.getElementById("page-scenario");
    var onScenario = panelScenario && !panelScenario.hidden;
    var msid = onScenario ? scenarioMiddleMsid : null;
    if (!onScenario) {
      var sel = document.getElementById("school-select");
      msid =
        sel && sel.value !== ""
          ? Number(sel.value)
          : null;
    }
    var dis =
      msid == null ||
      isNaN(msid) ||
      selectedSchoolDisallowsZonedStudentHex(msid);
    var zcb = document.getElementById("toggle-student-hex-zoned");
    if (zcb) {
      zcb.disabled = !!dis;
      if (dis) {
        zcb.checked = false;
      }
    }
    updateStudentHexLegendLabels(msid);
  }

  /**
   * Keeps the student-residence-density map-legend labels in sync with the
   * currently selected school. The sidebar section heading stays "Student
   * Residence Density"; the heat-map spectrum's title is prefixed with the
   * short-form school name ("Golfview ES Student Residence Density"). The
   * cohort sub-labels also follow the active school ("Attending <Short>" /
   * "Zoned to <Short>"). When no school is selected, all dynamic labels
   * revert to their generic defaults.
   */
  function updateStudentHexLegendLabels(msid) {
    var spectrumTitleEl = document.getElementById(
      "map-density-legend-student-title"
    );
    var attendEl = document.getElementById("student-hex-attending-label");
    var zonedEl = document.getElementById("student-hex-zoned-label");
    var short = "";
    if (msid != null && !isNaN(msid)) {
      short = schoolShortNameForMsid(Number(msid));
    }
    if (spectrumTitleEl) {
      spectrumTitleEl.textContent = short
        ? short + " Student Residence Density"
        : "Student Residence Density";
    }
    if (attendEl) {
      attendEl.textContent = short
        ? "Attending " + short
        : "Attending selected school";
    }
    if (zonedEl) {
      zonedEl.textContent = short
        ? "Zoned to " + short
        : "Zoned to selected school";
    }
  }

  function hexPolygonAreaSqMeters(geom) {
    if (
      typeof turf === "undefined" ||
      !turf ||
      typeof turf.area !== "function" ||
      !geom ||
      (geom.type !== "Polygon" && geom.type !== "MultiPolygon")
    ) {
      return null;
    }
    try {
      var sq = turf.area({ type: "Feature", geometry: geom });
      return sq != null && isFinite(sq) && sq > 0 ? sq : null;
    } catch (errA) {
      return null;
    }
  }

  /** Students per square mile for the student count placed across the hex polygon area. */
  function studentsPerSqMiFromCountAndGeom(count, geom) {
    if (count == null || count <= 0 || !geom) return null;
    var sqM = hexPolygonAreaSqMeters(geom);
    if (sqM == null || sqM <= 0) return null;
    var sqMi = sqM / SQ_METERS_PER_SQ_MI;
    if (!(sqMi > 0)) return null;
    var v = count / sqMi;
    if (!isFinite(v)) return null;
    return Math.round(v);
  }

  function formatStudentsPerSqMiForUi(v) {
    if (v == null || !isFinite(v)) return "—";
    return Math.round(Number(v)).toLocaleString();
  }

  /**
   * Mean of students per sq mi (including zeros) over the hovered hex and its geometric
   * neighbors, using the current school residence cohort counts and hex geometries.
   */
  function neighborhoodAverageSchoolResidenceStudentsPerSqMi(centerHexKey, prebuiltIdx) {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) {
      return null;
    }
    var geomBy = STUDENT_HEX_INDEX.geometryByHexKey;
    var hk0 = String(centerHexKey);
    if (!Object.prototype.hasOwnProperty.call(geomBy, hk0)) {
      return null;
    }
    var nbrs =
      (STUDENT_HEX_INDEX.neighborsByHexKey && STUDENT_HEX_INDEX.neighborsByHexKey[hk0]) || [];
    var idx;
    if (prebuiltIdx !== undefined) {
      idx = prebuiltIdx;
    } else {
      idx = buildStudentHexDisplayCountsByHex();
    }
    if (idx == null) {
      idx = Object.create(null);
    }
    var totalD = 0;
    var nH = 0;
    var keysH = [hk0].concat(nbrs);
    var seenH = Object.create(null);
    for (var i = 0; i < keysH.length; i++) {
      var hk = keysH[i];
      if (seenH[hk]) {
        continue;
      }
      seenH[hk] = true;
      if (!Object.prototype.hasOwnProperty.call(geomBy, hk)) {
        continue;
      }
      nH += 1;
      var g = geomBy[hk];
      var cnt = 0;
      if (Object.prototype.hasOwnProperty.call(idx, hk)) {
        cnt = Number(idx[hk]) || 0;
      }
      if (cnt <= 0) {
        continue;
      }
      var dens = studentsPerSqMiFromCountAndGeom(cnt, g);
      totalD += dens != null && isFinite(dens) ? dens : 0;
    }
    if (nH === 0) {
      return null;
    }
    return Math.round(totalD / nH);
  }

  /**
   * Mean of charter students per sq mi (including zeros) over the hovered hex and
   * geometric neighbors, using `charterDistrictHexCounts`.
   */
  function neighborhoodAverageCharterResidenceStudentsPerSqMi(centerHexKey, prebuiltCh) {
    if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.geometryByHexKey) {
      return null;
    }
    var geomBy = STUDENT_HEX_INDEX.geometryByHexKey;
    var ch;
    if (prebuiltCh !== undefined) {
      ch = prebuiltCh;
    } else {
      ch =
        (STUDENT_HEX_INDEX && STUDENT_HEX_INDEX.charterDistrictHexCounts) || Object.create(null);
    }
    var hk0 = String(centerHexKey);
    if (!Object.prototype.hasOwnProperty.call(geomBy, hk0)) {
      return null;
    }
    var nbrs =
      (STUDENT_HEX_INDEX.neighborsByHexKey && STUDENT_HEX_INDEX.neighborsByHexKey[hk0]) || [];
    var totalC = 0;
    var nC = 0;
    var keysC = [hk0].concat(nbrs);
    var seenC = Object.create(null);
    for (var j = 0; j < keysC.length; j++) {
      var hkc = keysC[j];
      if (seenC[hkc]) {
        continue;
      }
      seenC[hkc] = true;
      if (!Object.prototype.hasOwnProperty.call(geomBy, hkc)) {
        continue;
      }
      nC += 1;
      var gc = geomBy[hkc];
      var cnt2 = 0;
      if (Object.prototype.hasOwnProperty.call(ch, hkc)) {
        cnt2 = Number(ch[hkc]) || 0;
      }
      if (cnt2 <= 0) {
        continue;
      }
      var dens2 = studentsPerSqMiFromCountAndGeom(cnt2, gc);
      totalC += dens2 != null && isFinite(dens2) ? dens2 : 0;
    }
    if (nC === 0) {
      return null;
    }
    return Math.round(totalC / nC);
  }

  /**
   * Mean of homeschool students per sq mi (including zeros) over the hovered hex and
   * geometric neighbors, using aggregated `HOMESCHOOL_HEX_COUNTS`.
   */
  function neighborhoodAverageHomeschoolResidenceStudentsPerSqMi(centerHexKey, prebuiltHm) {
    var hm;
    if (prebuiltHm !== undefined) {
      hm = prebuiltHm;
    } else {
      hm = HOMESCHOOL_HEX_COUNTS || Object.create(null);
    }
    var hk0 = String(centerHexKey);
    if (!homeschoolHexGeometry(hk0)) {
      return null;
    }
    var nbrs =
      (STUDENT_HEX_INDEX &&
        STUDENT_HEX_INDEX.neighborsByHexKey &&
        STUDENT_HEX_INDEX.neighborsByHexKey[hk0]) ||
      [];
    var totalH = 0;
    var nH = 0;
    var keysH = [hk0].concat(nbrs);
    var seenH = Object.create(null);
    for (var j = 0; j < keysH.length; j++) {
      var hkh = keysH[j];
      if (seenH[hkh]) {
        continue;
      }
      seenH[hkh] = true;
      var gh = homeschoolHexGeometry(hkh);
      if (!gh) {
        continue;
      }
      nH += 1;
      var cnt2 = 0;
      if (Object.prototype.hasOwnProperty.call(hm, hkh)) {
        cnt2 = Number(hm[hkh]) || 0;
      }
      if (cnt2 <= 0) {
        continue;
      }
      var dens2 = studentsPerSqMiFromCountAndGeom(cnt2, gh);
      totalH += dens2 != null && isFinite(dens2) ? dens2 : 0;
    }
    if (nH === 0) {
      return null;
    }
    return Math.round(totalH / nH);
  }

  /** Short label (e.g. "McNair MS") for student-hex map tooltips; matches eseTableAbbreviatedSchoolName. */
  function studentResidenceTooltipSchoolLabel() {
    var msid = getActiveDashboardSchoolMsid();
    if (msid == null || isNaN(msid)) {
      return "selected school";
    }
    var m = masterRow(msid);
    if (!m || !m.school_name) {
      return "selected school";
    }
    var s = eseTableAbbreviatedSchoolName(m);
    s = s && String(s).trim() ? String(s).trim() : "";
    return s || "selected school";
  }

  function studentResidenceCohortTooltipPhrase() {
    var name = studentResidenceTooltipSchoolLabel();
    var attEl = document.getElementById("toggle-student-hex-attending");
    var zonEl = document.getElementById("toggle-student-hex-zoned");
    var attOn = !attEl || attEl.checked;
    var zonedOn = !!(zonEl && zonEl.checked && !zonEl.disabled);
    if (attOn && !zonedOn) {
      return "attending " + name;
    }
    if (zonedOn && !attOn) {
      return "zoned to " + name;
    }
    if (attOn && zonedOn) {
      return "attending or zoned to " + name;
    }
    return "selected cohort";
  }

  function studentHexResidenceHoverLinesHtml(props, cohortPhrase) {
    var showD;
    var hk = props && props._hexKey != null ? String(props._hexKey) : null;
    if (hk) {
      var aggB = neighborhoodAverageSchoolResidenceStudentsPerSqMi(hk);
      if (aggB != null && isFinite(aggB)) {
        showD = aggB;
      }
    }
    if (showD == null || !isFinite(showD)) {
      var rawD =
        props && props.students_per_sq_mi != null
          ? Number(props.students_per_sq_mi)
          : NaN;
      showD = rawD;
    }
    var rawC = props && props.count != null ? Number(props.count) : NaN;
    var phrase =
      cohortPhrase != null && String(cohortPhrase).trim() !== ""
        ? String(cohortPhrase).trim()
        : "selected cohort";
    var main =
      '<div class="student-hex-hover-line">' +
      '<span class="student-hex-hover-value">' +
      escapeHtml(formatStudentsPerSqMiForUi(showD)) +
      "</span>" +
      '<span class="student-hex-hover-unit"> grade-eligible students per square mile (' +
      escapeHtml(phrase) +
      ")</span>" +
      "</div>";
    var sub = "";
    if (!isNaN(rawC) && rawC > 5) {
      sub =
        '<div class="student-hex-hover-sub">' +
        escapeHtml(rawC.toLocaleString()) +
        " student residence" +
        (rawC === 1 ? "" : "s") +
        " in this hex</div>";
    }
    return main + sub;
  }

  function charterStudentHexResidenceLinesHtml(props) {
    var showC;
    var hkc1 = props && props._hexKey != null ? String(props._hexKey) : null;
    if (hkc1) {
      var aggC = neighborhoodAverageCharterResidenceStudentsPerSqMi(hkc1);
      if (aggC != null && isFinite(aggC)) {
        showC = aggC;
      }
    }
    if (showC == null || !isFinite(showC)) {
      var rawD0 =
        props && props.students_per_sq_mi != null
          ? Number(props.students_per_sq_mi)
          : NaN;
      showC = rawD0;
    }
    var rawC = props && props.count != null ? Number(props.count) : NaN;
    var mainLine =
      '<div class="student-hex-hover-line">' +
      '<span class="student-hex-hover-value">' +
      escapeHtml(formatStudentsPerSqMiForUi(showC)) +
      "</span>" +
      '<span class="student-hex-hover-unit"> grade-eligible charter students per square mile (districtwide)</span></div>';
    var sub = "";
    if (!isNaN(rawC) && rawC > 5) {
      var resWord;
      if (rawC === 1) {
        resWord = "1 charter student residence in this hex";
      } else {
        resWord =
          escapeHtml(rawC.toLocaleString()) + " charter student residences in this hex";
      }
      sub = '<div class="student-hex-hover-sub">' + resWord + "</div>";
    }
    return mainLine + sub;
  }

  function homeschoolStudentHexResidenceLinesHtml(props) {
    var showH;
    var hkh = props && props._hexKey != null ? String(props._hexKey) : null;
    if (hkh) {
      var aggH = neighborhoodAverageHomeschoolResidenceStudentsPerSqMi(hkh);
      if (aggH != null && isFinite(aggH)) {
        showH = aggH;
      }
    }
    if (showH == null || !isFinite(showH)) {
      var rawHd =
        props && props.students_per_sq_mi != null
          ? Number(props.students_per_sq_mi)
          : NaN;
      showH = rawHd;
    }
    var rawCnt = props && props.count != null ? Number(props.count) : NaN;
    var mainLine =
      '<div class="student-hex-hover-line">' +
      '<span class="student-hex-hover-value">' +
      escapeHtml(formatStudentsPerSqMiForUi(showH)) +
      "</span>" +
      '<span class="student-hex-hover-unit"> grade-eligible homeschool students per square mile (districtwide)</span></div>';
    var sub = "";
    if (!isNaN(rawCnt) && rawCnt > 5) {
      var resWord;
      if (rawCnt === 1) {
        resWord = "1 homeschool student residence in this hex";
      } else {
        resWord =
          escapeHtml(rawCnt.toLocaleString()) + " homeschool student residences in this hex";
      }
      sub = '<div class="student-hex-hover-sub">' + resWord + "</div>";
    }
    return mainLine + sub;
  }

  function studentHexResidenceHoverHtml(props, cohortPhrase) {
    return (
      '<div class="student-hex-hover-inner">' +
      studentHexResidenceHoverLinesHtml(props, cohortPhrase) +
      "</div>"
    );
  }

  function charterStudentHexResidenceHoverHtml(props) {
    return (
      '<div class="student-hex-hover-inner">' +
      charterStudentHexResidenceLinesHtml(props) +
      "</div>"
    );
  }

  function homeschoolStudentHexResidenceHoverHtml(props) {
    return (
      '<div class="student-hex-hover-inner">' +
      homeschoolStudentHexResidenceLinesHtml(props) +
      "</div>"
    );
  }

  function combinedResidenceHexHoverHtml(bProps, cProps, hProps, wantB, wantC, wantH, cohortPhrase) {
    var parts = [];
    var schoolShort = studentResidenceTooltipSchoolLabel();
    if (wantB && bProps) {
      parts.push(
        '<div class="student-hex-hover-section">' +
        '<div class="student-hex-hover-section-title">Selected School: ' +
        escapeHtml(schoolShort) +
        "</div>" +
        '<div class="student-hex-hover-inner">' +
        studentHexResidenceHoverLinesHtml(bProps, cohortPhrase) +
        "</div></div>"
      );
    }
    if (wantC && cProps) {
      parts.push(
        '<div class="student-hex-hover-section">' +
        '<div class="student-hex-hover-section-title">Charter (districtwide)</div>' +
        '<div class="student-hex-hover-inner">' +
        charterStudentHexResidenceLinesHtml(cProps) +
        "</div></div>"
      );
    }
    if (wantH && hProps) {
      parts.push(
        '<div class="student-hex-hover-section">' +
        '<div class="student-hex-hover-section-title">Homeschool (districtwide)</div>' +
        '<div class="student-hex-hover-inner">' +
        homeschoolStudentHexResidenceLinesHtml(hProps) +
        "</div></div>"
      );
    }
    if (parts.length) {
      return '<div class="student-hex-hover-dual">' + parts.join("") + "</div>";
    }
    return (
      '<div class="student-hex-hover-inner">No student residence data for the enabled layers at this location.</div>'
    );
  }

  /** Districtwide charter attendance (MSID 65xx–66xx) residential density; not tied to dropdown selection. */
  function syncCharterDistrictStudentHexLayer() {
    if (!map || !map.getSource || !map.getSource("charter-student-hex")) {
      return;
    }

    function emptyCharterHexAndHide() {
      map.getSource("charter-student-hex").setData({
        type: "FeatureCollection",
        features: [],
      });
      if (map.getSource("charter-student-hex-hit")) {
        map.getSource("charter-student-hex-hit").setData({
          type: "FeatureCollection",
          features: [],
        });
      }
      if (map.getLayer("charter-student-hex-hit-fill")) {
        map.setLayoutProperty("charter-student-hex-hit-fill", "visibility", "none");
      }
      syncResidenceDensityHeatmapZoomVisibility();
    }

    if (
      !STUDENT_HEX_INDEX ||
      !STUDENT_HEX_INDEX.charterDistrictHexCounts ||
      !STUDENT_HEX_INDEX.geometryByHexKey
    ) {
      emptyCharterHexAndHide();
      return;
    }

    var idx = STUDENT_HEX_INDEX.charterDistrictHexCounts;
    var features = [];
    var hitFeatures = [];
    for (var key in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, key)) continue;
      var cnt = idx[key];
      if (cnt <= 0) continue;
      var geom = STUDENT_HEX_INDEX.geometryByHexKey[key];
      if (!geom) continue;
      var pt = polygonCentroid(geom);
      if (!pt) continue;
      var dens = studentsPerSqMiFromCountAndGeom(cnt, geom);
      features.push({
        type: "Feature",
        properties: { _hexKey: key, count: cnt, students_per_sq_mi: dens },
        geometry: { type: "Point", coordinates: pt },
      });
      hitFeatures.push({
        type: "Feature",
        properties: {
          _hexKey: key,
          count: cnt,
          students_per_sq_mi: dens,
        },
        geometry: geom,
      });
    }
    if (features.length === 0) {
      emptyCharterHexAndHide();
      return;
    }
    map.getSource("charter-student-hex").setData({
      type: "FeatureCollection",
      features: features,
    });
    if (map.getSource("charter-student-hex-hit")) {
      map.getSource("charter-student-hex-hit").setData({
        type: "FeatureCollection",
        features: hitFeatures,
      });
    }
    var inp = document.getElementById("toggle-charter-student-hex");
    var vis = inp && inp.checked ? "visible" : "none";
    if (map.getLayer("charter-student-hex-hit-fill")) {
      map.setLayoutProperty("charter-student-hex-hit-fill", "visibility", vis);
    }
    syncResidenceDensityHeatmapZoomVisibility();
  }

  /** Districtwide homeschool residential density; hex geometries from main student hex index. */
  function syncHomeschoolStudentHexLayer() {
    if (!map || !map.getSource || !map.getSource("homeschool-student-hex")) {
      return;
    }

    function emptyHomeschoolHexAndHide() {
      map.getSource("homeschool-student-hex").setData({
        type: "FeatureCollection",
        features: [],
      });
      if (map.getSource("homeschool-student-hex-hit")) {
        map.getSource("homeschool-student-hex-hit").setData({
          type: "FeatureCollection",
          features: [],
        });
      }
      if (map.getLayer("homeschool-student-hex-hit-fill")) {
        map.setLayoutProperty("homeschool-student-hex-hit-fill", "visibility", "none");
      }
      syncResidenceDensityHeatmapZoomVisibility();
    }

    if (!HOMESCHOOL_HEX_COUNTS) {
      emptyHomeschoolHexAndHide();
      return;
    }

    var idx = HOMESCHOOL_HEX_COUNTS;
    var features = [];
    var hitFeatures = [];
    for (var key in idx) {
      if (!Object.prototype.hasOwnProperty.call(idx, key)) continue;
      var cnt = idx[key];
      if (cnt <= 0) continue;
      var geom = homeschoolHexGeometry(key);
      if (!geom) continue;
      var pt = polygonCentroid(geom);
      if (!pt) continue;
      var dens = studentsPerSqMiFromCountAndGeom(cnt, geom);
      features.push({
        type: "Feature",
        properties: { _hexKey: key, count: cnt, students_per_sq_mi: dens },
        geometry: { type: "Point", coordinates: pt },
      });
      hitFeatures.push({
        type: "Feature",
        properties: {
          _hexKey: key,
          count: cnt,
          students_per_sq_mi: dens,
        },
        geometry: geom,
      });
    }
    if (features.length === 0) {
      emptyHomeschoolHexAndHide();
      return;
    }
    map.getSource("homeschool-student-hex").setData({
      type: "FeatureCollection",
      features: features,
    });
    if (map.getSource("homeschool-student-hex-hit")) {
      map.getSource("homeschool-student-hex-hit").setData({
        type: "FeatureCollection",
        features: hitFeatures,
      });
    }
    var inp = document.getElementById("toggle-homeschool-student-hex");
    var vis = inp && inp.checked ? "visible" : "none";
    if (map.getLayer("homeschool-student-hex-hit-fill")) {
      map.setLayoutProperty("homeschool-student-hex-hit-fill", "visibility", vis);
    }
    syncResidenceDensityHeatmapZoomVisibility();
  }

  function syncStudentHexLayer() {
    if (!map || !map.getSource || !map.getSource("student-hex")) return;
    syncStudentHexResidenceSubToggleAvailability();

    try {
      function emptyStudentHexSourcesAndHide() {
        map.getSource("student-hex").setData({
          type: "FeatureCollection",
          features: [],
        });
        if (map.getSource("student-hex-hit")) {
          map.getSource("student-hex-hit").setData({
            type: "FeatureCollection",
            features: [],
          });
        }
        if (map.getLayer("student-hex-hit-fill")) {
          map.setLayoutProperty("student-hex-hit-fill", "visibility", "none");
        }
      }

      if (!STUDENT_HEX_INDEX || !STUDENT_HEX_INDEX.countsByMsid) {
        emptyStudentHexSourcesAndHide();
        return;
      }
      var idx = buildStudentHexDisplayCountsByHex();
      if (idx == null || typeof idx !== "object") {
        emptyStudentHexSourcesAndHide();
        return;
      }
      var features = [];
      var hitFeatures = [];
      for (var key in idx) {
        if (!Object.prototype.hasOwnProperty.call(idx, key)) continue;
        var cnt = idx[key];
        if (cnt <= 0) continue;
        var geom = STUDENT_HEX_INDEX.geometryByHexKey[key];
        if (!geom) continue;
        var pt = polygonCentroid(geom);
        if (!pt) continue;
        var dens = studentsPerSqMiFromCountAndGeom(cnt, geom);
        features.push({
          type: "Feature",
          properties: { _hexKey: key, count: cnt, students_per_sq_mi: dens },
          geometry: { type: "Point", coordinates: pt },
        });
        hitFeatures.push({
          type: "Feature",
          properties: {
            _hexKey: key,
            count: cnt,
            students_per_sq_mi: dens,
          },
          geometry: geom,
        });
      }
      if (features.length === 0) {
        emptyStudentHexSourcesAndHide();
        return;
      }
      map.getSource("student-hex").setData({
        type: "FeatureCollection",
        features: features,
      });
      if (map.getSource("student-hex-hit")) {
        map.getSource("student-hex-hit").setData({
          type: "FeatureCollection",
          features: hitFeatures,
        });
      }
      var showHex = isStudentResidenceLayerEnabled();
      var vis = showHex ? "visible" : "none";
      if (map.getLayer("student-hex-hit-fill")) {
        map.setLayoutProperty("student-hex-hit-fill", "visibility", vis);
      }
    } finally {
      syncCharterDistrictStudentHexLayer();
      syncHomeschoolStudentHexLayer();
    }
    scheduleRefreshMapDensityLegendValueRanges();
    applyResidenceHeatmapSymbology();
  }

  /** Draggable vertical splitter between data panel and map. */
  function initDashboardResizer(map) {
    var dashboard = document.getElementById("dashboard");
    var sidebar = document.getElementById("dashboard-sidebar");
    var resizer = document.getElementById("dashboard-resizer");
    if (!dashboard || !sidebar || !resizer) return;

    var dragging = false;

    function clampSidebarWidth(px) {
      var rect = dashboard.getBoundingClientRect();
      var resizerW = resizer.offsetWidth || 8;
      /* Keep the splitter within the middle third of the screen: the data panel
         and the map are each guaranteed at least one-third of the width. */
      var third = rect.width / 3;
      var minSide = third;
      var minMap = third;
      var max = rect.width - resizerW - minMap;
      return Math.max(minSide, Math.min(max, px));
    }

    function setSidebarWidth(px) {
      px = clampSidebarWidth(px);
      sidebar.style.flex = "0 0 " + px + "px";
      sidebar.style.width = px + "px";
      map.resize();
    }

    resizer.addEventListener("mousedown", function (e) {
      dragging = true;
      e.preventDefault();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var rect = dashboard.getBoundingClientRect();
      setSidebarWidth(e.clientX - rect.left);
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      map.resize();
    });

    resizer.addEventListener("keydown", function (e) {
      var step = 24;
      var current = sidebar.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setSidebarWidth(current - step);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setSidebarWidth(current + step);
      }
    });

    window.addEventListener("resize", function () {
      if (window.innerWidth <= 960) {
        map.resize();
        return;
      }
      var rect = dashboard.getBoundingClientRect();
      var sw = sidebar.getBoundingClientRect().width;
      var resizerW = resizer.offsetWidth || 8;
      if (sw + resizerW > rect.width - 200) {
        setSidebarWidth((rect.width - resizerW) * 0.5);
      } else {
        map.resize();
      }
    });
  }

  /**
   * Phone-only (smartphone + touch) presentation. The map is full-screen. A
   * swipe-up bottom sheet exposes ONLY the Map Layers menu. A floating Map/Data
   * toggle (top-right) switches between the map and a separate full-screen Data
   * view (the desktop left panel) — the Data view is never part of the sheet,
   * and the Map Layers menu is never part of the Data view. CSS
   * (`@media (max-width: 540px) and (pointer: coarse)`) does the layout; this
   * wires up the sheet, drag-to-expand, the toggle, and toolbar relocation.
   * Idempotent — safe to call more than once.
   */
  function initMobileDashboard(map) {
    var dashboard = document.getElementById("dashboard");
    var sidebar = document.getElementById("dashboard-sidebar");
    if (!dashboard || !sidebar) return;
    if (dashboard.querySelector(".mobile-layers-sheet")) return;

    /* Dedicated bottom sheet for Map Layers (separate from the data sidebar). */
    var sheet = document.createElement("div");
    sheet.className = "mobile-layers-sheet";
    sheet.setAttribute("aria-label", "Map layers");

    var header = document.createElement("div");
    header.className = "mobile-drawer-header";

    var handle = document.createElement("button");
    handle.type = "button";
    handle.className = "mobile-drawer-handle";
    handle.setAttribute("aria-label", "Drag, or tap, to open or close the map layers");

    var title = document.createElement("span");
    title.className = "mobile-drawer-title";
    title.textContent = "Map Layers";

    header.appendChild(handle);
    header.appendChild(title);
    sheet.appendChild(header);
    dashboard.appendChild(sheet);

    /* Floating Map/Data toggle, top-right, overlaying everything. */
    var toggle = document.createElement("div");
    toggle.className = "mobile-view-toggle";
    toggle.setAttribute("role", "tablist");
    toggle.setAttribute("aria-label", "Switch between map and data");

    var mapBtn = document.createElement("button");
    mapBtn.type = "button";
    mapBtn.className = "mobile-view-toggle__btn mobile-view-toggle__btn--map";
    mapBtn.setAttribute("role", "tab");
    mapBtn.textContent = "Map";

    var dataBtn = document.createElement("button");
    dataBtn.type = "button";
    dataBtn.className = "mobile-view-toggle__btn mobile-view-toggle__btn--data";
    dataBtn.setAttribute("role", "tab");
    dataBtn.textContent = "Data";

    toggle.appendChild(mapBtn);
    toggle.appendChild(dataBtn);
    dashboard.appendChild(toggle);

    function nudgeMap() {
      if (map && typeof map.resize === "function") {
        requestAnimationFrame(function () {
          map.resize();
        });
      }
    }

    function syncViewToggle(dataView) {
      mapBtn.setAttribute("aria-selected", dataView ? "false" : "true");
      dataBtn.setAttribute("aria-selected", dataView ? "true" : "false");
    }

    function setDataView(on) {
      dashboard.classList.toggle("mobile-data-view", !!on);
      if (on) {
        dashboard.classList.remove("mobile-map-layers-open");
        sidebar.scrollTop = 0;
      }
      syncViewToggle(!!on);
      nudgeMap();
    }

    function setMapLayersOpen(open) {
      dashboard.classList.remove("mobile-data-view");
      dashboard.classList.toggle("mobile-map-layers-open", !!open);
      syncViewToggle(false);
      if (open) sheet.scrollTop = 0;
      nudgeMap();
    }
    setDataView(false);

    mapBtn.addEventListener("click", function () {
      setDataView(false);
      setMapLayersOpen(false);
    });
    dataBtn.addEventListener("click", function () {
      setDataView(true);
    });

    /* Relocate the map-layers toolbar into the sheet on phones, and restore it
       to its map-overlay home otherwise (e.g. desktop device-emulation). */
    var toolbar = document.getElementById("toolbar");
    var toolbarHome = toolbar
      ? { parent: toolbar.parentNode, next: toolbar.nextSibling }
      : null;
    var mq = window.matchMedia("(max-width: 540px) and (pointer: coarse)");

    function applyToolbarPlacement() {
      if (!toolbar || !toolbarHome) return;
      if (mq.matches) {
        if (toolbar.parentNode !== sheet) {
          sheet.appendChild(toolbar);
        }
      } else if (toolbar.parentNode !== toolbarHome.parent) {
        if (toolbarHome.next && toolbarHome.next.parentNode === toolbarHome.parent) {
          toolbarHome.parent.insertBefore(toolbar, toolbarHome.next);
        } else {
          toolbarHome.parent.appendChild(toolbar);
        }
      }
      nudgeMap();
    }

    /* Boundary Sandbox drawing tools: on phones, surface the brush/lasso and
       select/erase controls in a floating bar at the bottom of the map (above
       the Map Layers sheet) so they work in the map view. The controls are
       relocated out of the sandbox data panel on phones and restored on
       desktop. The bar is only shown while the Boundary Sandbox sub-tab is the
       active data view (see CSS .mobile-sandbox-active). */
    var sandboxBar = document.createElement("div");
    sandboxBar.className = "mobile-sandbox-tools";
    sandboxBar.setAttribute("aria-label", "Boundary drawing tools");
    dashboard.appendChild(sandboxBar);

    /* Pan vs. Draw toggle. On touchscreens a one-finger drag normally pans the
       map, so drawing only works once the user explicitly chooses "Draw"
       (which disables one-finger panning; pinch-zoom still works). */
    var panDraw = document.createElement("div");
    panDraw.className = "mobile-pan-draw";
    panDraw.setAttribute("role", "radiogroup");
    panDraw.setAttribute("aria-label", "Touch mode: move the map or draw");

    var panBtn = document.createElement("button");
    panBtn.type = "button";
    panBtn.className = "mobile-pan-draw__btn is-active";
    panBtn.setAttribute("role", "radio");
    panBtn.setAttribute("aria-checked", "true");
    panBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 9V5.5a1.5 1.5 0 0 1 3 0V9m0-1V4.5a1.5 1.5 0 0 1 3 0V9m0-.5V5a1.5 1.5 0 0 1 3 0v4m0-1.5a1.5 1.5 0 0 1 3 0V14a5 5 0 0 1-5 5h-1.5a5 5 0 0 1-4-2l-2.7-3.6a1.5 1.5 0 0 1 2.4-1.8L8 13"/></svg><span>Move map</span>';

    var drawBtn = document.createElement("button");
    drawBtn.type = "button";
    drawBtn.className = "mobile-pan-draw__btn";
    drawBtn.setAttribute("role", "radio");
    drawBtn.setAttribute("aria-checked", "false");
    drawBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M14.5 5.5l4 4M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z"/></svg><span>Draw</span>';

    panDraw.appendChild(panBtn);
    panDraw.appendChild(drawBtn);
    sandboxBar.appendChild(panDraw);

    function setPanDrawMode(draw) {
      panBtn.classList.toggle("is-active", !draw);
      drawBtn.classList.toggle("is-active", draw);
      panBtn.setAttribute("aria-checked", draw ? "false" : "true");
      drawBtn.setAttribute("aria-checked", draw ? "true" : "false");
      if (typeof window.__setSandboxTouchDraw === "function") {
        window.__setSandboxTouchDraw(draw);
      }
    }
    panBtn.addEventListener("click", function () {
      setPanDrawMode(false);
    });
    drawBtn.addEventListener("click", function () {
      setPanDrawMode(true);
    });

    var sandboxControls = document.querySelector(".sandbox-controls");
    var sandboxHome = sandboxControls
      ? { parent: sandboxControls.parentNode, next: sandboxControls.nextSibling }
      : null;

    function applySandboxControlsPlacement() {
      if (!sandboxControls || !sandboxHome) return;
      if (mq.matches) {
        if (sandboxControls.parentNode !== sandboxBar) {
          sandboxBar.appendChild(sandboxControls);
        }
      } else if (sandboxControls.parentNode !== sandboxHome.parent) {
        if (sandboxHome.next && sandboxHome.next.parentNode === sandboxHome.parent) {
          sandboxHome.parent.insertBefore(sandboxControls, sandboxHome.next);
        } else {
          sandboxHome.parent.appendChild(sandboxControls);
        }
      }
    }

    function isSandboxSubtabActive() {
      var pg = document.getElementById("page-scenario");
      var sb = document.getElementById("scenario-subpanel-sandbox");
      return !!(pg && !pg.hidden && sb && !sb.hidden);
    }
    function updateSandboxToolsState() {
      dashboard.classList.toggle(
        "mobile-sandbox-active",
        isSandboxSubtabActive()
      );
    }
    window.__updateMobileSandboxState = updateSandboxToolsState;

    function applyMobilePlacements() {
      applyToolbarPlacement();
      applySandboxControlsPlacement();
      updateSandboxToolsState();
    }
    applyMobilePlacements();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", applyMobilePlacements);
    } else if (typeof mq.addListener === "function") {
      mq.addListener(applyMobilePlacements);
    }

    /* Keep the collapsed peek height matched to the header strip's real height
       so it sits flush with the bottom edge across devices. */
    function syncPeek() {
      if (!header.offsetParent && header.offsetHeight === 0) return;
      var h = header.getBoundingClientRect().height;
      if (h > 0) {
        sheet.style.setProperty("--drawer-peek", Math.round(h) + "px");
        dashboard.style.setProperty("--drawer-peek", Math.round(h) + "px");
      }
    }
    requestAnimationFrame(syncPeek);
    window.addEventListener("resize", syncPeek);
    window.addEventListener("orientationchange", function () {
      requestAnimationFrame(syncPeek);
    });

    /* Drag-to-expand/collapse (Google-Maps-style) on the sheet handle. This only
       opens/closes the Map Layers sheet; the Data view has its own toggle. */
    var dragging = false;
    var moved = false;
    var startY = 0;
    var startTranslate = 0;
    var sheetHeight = 0;
    var peekPx = 56;

    function peekValue() {
      var v = parseFloat(
        getComputedStyle(sheet).getPropertyValue("--drawer-peek")
      );
      return isNaN(v) ? 56 : v;
    }

    function onStart(y) {
      sheetHeight = sheet.getBoundingClientRect().height;
      peekPx = peekValue();
      startY = y;
      moved = false;
      dragging = true;
      startTranslate = dashboard.classList.contains("mobile-map-layers-open")
        ? 0
        : Math.max(0, sheetHeight - peekPx);
      dashboard.classList.add("mobile-drawer-dragging");
    }

    function onMove(y) {
      if (!dragging) return;
      var dy = y - startY;
      if (Math.abs(dy) > 4) moved = true;
      var t = Math.min(
        Math.max(0, sheetHeight - peekPx),
        Math.max(0, startTranslate + dy)
      );
      sheet.style.transform = "translateY(" + t + "px)";
    }

    function onEnd(y) {
      if (!dragging) return;
      dragging = false;
      dashboard.classList.remove("mobile-drawer-dragging");
      sheet.style.transform = "";
      var wasOpen = dashboard.classList.contains("mobile-map-layers-open");
      if (!moved) {
        setMapLayersOpen(!wasOpen);
        return;
      }
      var dy = y - startY;
      if (wasOpen) {
        setMapLayersOpen(dy < sheetHeight * 0.25);
      } else {
        setMapLayersOpen(dy < -40);
      }
    }

    header.addEventListener(
      "touchstart",
      function (e) {
        onStart(e.touches[0].clientY);
      },
      { passive: true }
    );
    header.addEventListener(
      "touchmove",
      function (e) {
        if (!dragging) return;
        e.preventDefault();
        onMove(e.touches[0].clientY);
      },
      { passive: false }
    );
    header.addEventListener("touchend", function (e) {
      onEnd(e.changedTouches[0].clientY);
    });
    header.addEventListener("touchcancel", function () {
      if (!dragging) return;
      dragging = false;
      dashboard.classList.remove("mobile-drawer-dragging");
      sheet.style.transform = "";
    });

    nudgeMap();
  }

  (function initToolbar() {
    var btn = document.getElementById("toolbar-toggle");
    var toolbar = document.getElementById("toolbar");
    if (!btn || !toolbar) return;
    btn.addEventListener("click", function () {
      var collapsed = toolbar.classList.toggle("toolbar--collapsed");
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    });
  })();

  (function setupScenarioMergerControl() {
    var el = document.getElementById("scenario-complete-merger");
    if (!el) return;
    el.checked = false;
    scenarioCompleteMerger = false;
    syncScenarioMergerControlVisibility();
    el.addEventListener("change", function () {
      scenarioCompleteMerger = el.checked;
      applyScenarioMergedUpdates();
      if (
        scenarioMiddleMsid != null &&
        !isNaN(scenarioMiddleMsid) &&
        scenarioLastFeederRows.length
      ) {
        renderScenarioFeederList(
          scenarioMiddleMsid,
          scenarioLastFeederRows
        );
      }
    });
  })();

  (function setupScenarioFeederChainToggle() {
    var el = document.getElementById("scenario-feeder-chain-only");
    if (!el) return;
    el.addEventListener("change", function () {
      scenarioUseFeederChainOnly = el.checked;
      if (scenarioUseFeederChainOnly) {
        /* User-added schools only apply outside feeder-chain mode. */
        scenarioUserAddedFeederMsids = [];
      }
      syncScenarioMergerControlVisibility();
      refreshScenarioContributingSchoolsForToggle();
    });
  })();

  (function setupPageSwitcher() {
    var titleEl = document.getElementById("sidebar-view-title");
    var tabs = [
      {
        id: "existing",
        tab: document.getElementById("page-tab-existing"),
        panel: document.getElementById("page-existing"),
        label: "Existing Conditions",
        step: 1,
      },
      {
        id: "scenario",
        tab: document.getElementById("page-tab-scenario"),
        panel: document.getElementById("page-scenario"),
        label: "Scenario Planning",
        step: 2,
      },
      {
        id: "feedback",
        tab: document.getElementById("page-tab-feedback"),
        panel: document.getElementById("page-feedback"),
        label: "Share your Feedback",
        step: 3,
      },
    ];
    for (var ti = 0; ti < tabs.length; ti++) {
      if (!tabs[ti].tab || !tabs[ti].panel) {
        return;
      }
    }

    var labelById = {};
    for (var lj = 0; lj < tabs.length; lj++) {
      labelById[tabs[lj].id] = tabs[lj].label;
    }

    /* Sub-tab wiring for the consolidated Scenario Planning page. */
    function setScenarioSubtab(which) {
      var which2 = which === "sandbox" ? "sandbox" : "scenario";
      var btnScn = document.getElementById("scenario-subtab-tab-scenario");
      var btnSbx = document.getElementById("scenario-subtab-tab-sandbox");
      var panScn = document.getElementById("scenario-subpanel-scenario");
      var panSbx = document.getElementById("scenario-subpanel-sandbox");
      if (!btnScn || !btnSbx || !panScn || !panSbx) return;
      var onScn = which2 === "scenario";
      btnScn.classList.toggle("is-active", onScn);
      btnSbx.classList.toggle("is-active", !onScn);
      btnScn.setAttribute("aria-selected", onScn ? "true" : "false");
      btnSbx.setAttribute("aria-selected", onScn ? "false" : "true");
      panScn.hidden = !onScn;
      panSbx.hidden = onScn;
      if (which2 === "sandbox") {
        renderSandboxBoundariesPanel();
        updateSandboxSelectedHexCountUi();
        renderSandboxSummaryTable();
      } else {
        refreshScenarioPanelIfVisible();
      }
      applyScenarioFeederMapHighlights();
      syncStudentHexLayer();
      syncTravelShedLayerFilter();
      syncBoundarySandboxMapLayers();
      if (window.__updateMobileSandboxState) window.__updateMobileSandboxState();
      if (window.__sandboxRestoreDragPan) window.__sandboxRestoreDragPan();
      requestAnimationFrame(function () {
        if (map && typeof map.resize === "function") map.resize();
      });
    }
    var btnSubScn = document.getElementById("scenario-subtab-tab-scenario");
    var btnSubSbx = document.getElementById("scenario-subtab-tab-sandbox");
    if (btnSubScn) btnSubScn.addEventListener("click", function () { setScenarioSubtab("scenario"); });
    if (btnSubSbx) btnSubSbx.addEventListener("click", function () { setScenarioSubtab("sandbox"); });

    function setPage(pageId) {
      var active =
        pageId === "scenario"
          ? "scenario"
          : pageId === "feedback"
            ? "feedback"
            : "existing";
      var activeStep = 1;
      for (var si = 0; si < tabs.length; si++) {
        if (tabs[si].id === active) {
          activeStep = tabs[si].step;
          break;
        }
      }
      if (titleEl) {
        titleEl.textContent = labelById[active] || labelById.existing;
      }
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        var isOn = t.id === active;
        t.tab.setAttribute("aria-selected", isOn ? "true" : "false");
        t.tab.classList.toggle("is-active", isOn);
        t.tab.classList.toggle(
          "is-complete",
          !isOn && t.step < activeStep
        );
        t.panel.hidden = !isOn;
      }
      if (active === "scenario") {
        /* Re-sync sub-panels (preserves which sub-tab the user was on). */
        var keepSub = scenarioActiveSubtabId();
        setScenarioSubtab(keepSub);
        if (keepSub === "scenario") {
          refreshScenarioPanelIfVisible();
        }
      }
      applyScenarioFeederMapHighlights();
      syncStudentHexLayer();
      syncTravelShedLayerFilter();
      syncBoundarySandboxMapLayers();
      if (active === "scenario" && scenarioActiveSubtabId() === "sandbox") {
        updateSandboxSelectedHexCountUi();
        renderSandboxSummaryTable();
      }
      if (window.__updateMobileSandboxState) window.__updateMobileSandboxState();
      if (window.__sandboxRestoreDragPan) window.__sandboxRestoreDragPan();
      requestAnimationFrame(function () {
        if (map && typeof map.resize === "function") {
          map.resize();
        }
      });
    }

    for (var bi = 0; bi < tabs.length; bi++) {
      (function (pageKey) {
        tabs[bi].tab.addEventListener("click", function () {
          setPage(pageKey);
        });
      })(tabs[bi].id);
    }

    /* Consume any pending navigation requested from the landing-page "explore"
       links (stored in sessionStorage by the login gate). Lets a link like
       "Boundary Sandbox" open the dashboard straight to that view. */
    window.__applyPendingDashboardNav = function () {
      var raw = null;
      try {
        raw = sessionStorage.getItem("brevardK8PendingNav");
      } catch (e) {
        raw = null;
      }
      if (!raw) return;
      try {
        sessionStorage.removeItem("brevardK8PendingNav");
      } catch (e) {
        /* ignore */
      }
      var nav = null;
      try {
        nav = JSON.parse(raw);
      } catch (e) {
        nav = null;
      }
      if (!nav || !nav.page) return;
      setPage(nav.page);
      if (nav.page === "scenario" && nav.subtab) {
        setScenarioSubtab(nav.subtab);
      }
    };
    try {
      window.__applyPendingDashboardNav();
    } catch (e) {
      /* ignore */
    }
  })();

  var FEEDBACK_K8_FACTORS = [
    { id: "travel_distance", label: "Travel distance impacts" },
    {
      id: "facility_modernization",
      label: "Facility improvements and modernization",
    },
    {
      id: "school_assignments",
      label: "Impact to current school assignments",
    },
    { id: "enrollment_size", label: "Enrollment size by school" },
    { id: "age_mixing", label: "Student age mixing" },
    { id: "academic_outcomes", label: "Academic achievement outcomes" },
    {
      id: "student_continuity",
      label: "Continuity of student experience",
    },
    { id: "community_building", label: "Community-building potential" },
    {
      id: "specialty_programs",
      label:
        "Access to specialty programs (e.g., arts, athletics, language, IB, STEM)",
    },
    {
      id: "operational_cost",
      label: "Operational cost savings per student",
    },
  ];

  var FEEDBACK_K8_FACTOR_RANKED_IDS = [];

  function feedbackK8FactorById(id) {
    for (var i = 0; i < FEEDBACK_K8_FACTORS.length; i++) {
      if (FEEDBACK_K8_FACTORS[i].id === id) {
        return FEEDBACK_K8_FACTORS[i];
      }
    }
    return null;
  }

  function syncFeedbackK8FactorRanksHiddenInput() {
    var hidden = document.getElementById("feedback-k8-factor-ranks");
    if (!hidden) return;
    hidden.value = FEEDBACK_K8_FACTOR_RANKED_IDS.join(",");
  }

  function renderFeedbackK8FactorRanking() {
    var rankedEl = document.getElementById("feedback-k8-factors-ranked");
    var poolEl = document.getElementById("feedback-k8-factors-pool");
    if (!rankedEl || !poolEl) return;

    rankedEl.innerHTML = "";
    for (var ri = 0; ri < FEEDBACK_K8_FACTOR_RANKED_IDS.length; ri++) {
      var rid = FEEDBACK_K8_FACTOR_RANKED_IDS[ri];
      var rf = feedbackK8FactorById(rid);
      if (!rf) continue;

      var row = document.createElement("div");
      row.className = "feedback-k8-factors__ranked-item";
      row.setAttribute("data-factor-id", rid);

      var badge = document.createElement("span");
      badge.className = "feedback-k8-factors__rank-badge";
      badge.textContent = String(ri + 1);

      var lab = document.createElement("span");
      lab.className = "feedback-k8-factors__rank-label";
      lab.textContent = rf.label;

      var actions = document.createElement("div");
      actions.className = "feedback-k8-factors__rank-actions";

      var upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "feedback-k8-factors__rank-btn";
      upBtn.setAttribute("data-action", "up");
      upBtn.setAttribute("data-factor-id", rid);
      upBtn.setAttribute("aria-label", "Move " + rf.label + " up");
      upBtn.textContent = "↑";
      upBtn.disabled = ri === 0;

      var downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "feedback-k8-factors__rank-btn";
      downBtn.setAttribute("data-action", "down");
      downBtn.setAttribute("data-factor-id", rid);
      downBtn.setAttribute("aria-label", "Move " + rf.label + " down");
      downBtn.textContent = "↓";
      downBtn.disabled = ri === FEEDBACK_K8_FACTOR_RANKED_IDS.length - 1;

      var rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.className =
        "feedback-k8-factors__rank-btn feedback-k8-factors__rank-btn--remove";
      rmBtn.setAttribute("data-action", "remove");
      rmBtn.setAttribute("data-factor-id", rid);
      rmBtn.setAttribute("aria-label", "Remove " + rf.label);
      rmBtn.textContent = "×";

      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(rmBtn);
      row.appendChild(badge);
      row.appendChild(lab);
      row.appendChild(actions);
      rankedEl.appendChild(row);
    }

    poolEl.innerHTML = "";
    var atMax = FEEDBACK_K8_FACTOR_RANKED_IDS.length >= 5;
    for (var pi = 0; pi < FEEDBACK_K8_FACTORS.length; pi++) {
      var pf = FEEDBACK_K8_FACTORS[pi];
      var selected =
        FEEDBACK_K8_FACTOR_RANKED_IDS.indexOf(pf.id) !== -1;
      var poolBtn = document.createElement("button");
      poolBtn.type = "button";
      poolBtn.className = "feedback-k8-factors__pool-btn";
      poolBtn.setAttribute("data-factor-id", pf.id);
      poolBtn.textContent = pf.label;
      poolBtn.disabled = selected || atMax;
      if (selected) {
        poolBtn.setAttribute("aria-disabled", "true");
      }
      poolEl.appendChild(poolBtn);
    }

    syncFeedbackK8FactorRanksHiddenInput();
  }

  function moveFeedbackK8FactorRank(id, direction) {
    var idx = FEEDBACK_K8_FACTOR_RANKED_IDS.indexOf(id);
    if (idx === -1) return;
    var next = direction === "up" ? idx - 1 : idx + 1;
    if (next < 0 || next >= FEEDBACK_K8_FACTOR_RANKED_IDS.length) return;
    var tmp = FEEDBACK_K8_FACTOR_RANKED_IDS[idx];
    FEEDBACK_K8_FACTOR_RANKED_IDS[idx] = FEEDBACK_K8_FACTOR_RANKED_IDS[next];
    FEEDBACK_K8_FACTOR_RANKED_IDS[next] = tmp;
    renderFeedbackK8FactorRanking();
  }

  function addFeedbackK8FactorRank(id) {
    if (FEEDBACK_K8_FACTOR_RANKED_IDS.length >= 5) return;
    if (FEEDBACK_K8_FACTOR_RANKED_IDS.indexOf(id) !== -1) return;
    if (!feedbackK8FactorById(id)) return;
    FEEDBACK_K8_FACTOR_RANKED_IDS.push(id);
    renderFeedbackK8FactorRanking();
  }

  function removeFeedbackK8FactorRank(id) {
    var idx = FEEDBACK_K8_FACTOR_RANKED_IDS.indexOf(id);
    if (idx === -1) return;
    FEEDBACK_K8_FACTOR_RANKED_IDS.splice(idx, 1);
    renderFeedbackK8FactorRanking();
  }

  function setupFeedbackK8FactorRanking() {
    var rankedEl = document.getElementById("feedback-k8-factors-ranked");
    var poolEl = document.getElementById("feedback-k8-factors-pool");
    if (!rankedEl || !poolEl) return;

    FEEDBACK_K8_FACTOR_RANKED_IDS = [];
    renderFeedbackK8FactorRanking();

    poolEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".feedback-k8-factors__pool-btn");
      if (!btn || btn.disabled || !poolEl.contains(btn)) return;
      var id = btn.getAttribute("data-factor-id");
      if (id) addFeedbackK8FactorRank(id);
    });

    rankedEl.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var actionBtn = t.closest(".feedback-k8-factors__rank-btn");
      if (!actionBtn || !rankedEl.contains(actionBtn)) return;
      var id = actionBtn.getAttribute("data-factor-id");
      var action = actionBtn.getAttribute("data-action");
      if (!id) return;
      if (action === "up") moveFeedbackK8FactorRank(id, "up");
      else if (action === "down") moveFeedbackK8FactorRank(id, "down");
      else if (action === "remove") removeFeedbackK8FactorRank(id);
    });
  }

  (function setupFeedbackForm() {
    var form = document.getElementById("feedback-form");
    var thanks = document.getElementById("feedback-thanks");
    if (!form || !thanks) return;
    setupFeedbackK8FactorRanking();
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      form.classList.add("is-submitted");
      thanks.hidden = false;
      /* Future: POST survey + map comments to custom API */
    });
  })();

  /**
   * Turns each of the three native school <select>s (Existing Conditions, Scenario Planning,
   * Boundary Sandbox) into a searchable combobox. The original <select> stays in the DOM so
   * existing reads of `.value`, programmatic `.value =` assignments, the loading overlay
   * (`.school-select:disabled + .select-loading-overlay`), and all change listeners continue
   * to work; the combobox only adds a visible trigger + filterable popup that writes back to
   * the select via `select.value = …` + a bubbling "change" event.
   */
  (function setupSearchableSchoolSelects() {
    var SELECT_IDS = [
      "school-select",
      "scenario-school-select",
      "sandbox-base-school",
    ];

    function isPlaceholderOption(value, label) {
      if (value == null || value === "") return true;
      if (!label) return false;
      return /^(Loading|Select a school|Start from school)/i.test(label);
    }

    function setup(sel) {
      var wrap = sel.parentElement;
      if (!wrap || !wrap.classList.contains("school-select-wrap")) return;
      if (wrap.classList.contains("is-searchable")) return;
      wrap.classList.add("is-searchable");

      var trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "searchable-select__trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");

      var triggerText = document.createElement("span");
      triggerText.className = "searchable-select__trigger-text is-placeholder";
      triggerText.textContent = "Select a school";

      var caret = document.createElement("span");
      caret.className = "searchable-select__caret";
      caret.setAttribute("aria-hidden", "true");
      caret.textContent = "\u25BE";

      trigger.appendChild(triggerText);
      trigger.appendChild(caret);

      var popup = document.createElement("div");
      popup.className = "searchable-select__popup";
      popup.hidden = true;

      var searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "searchable-select__search";
      searchInput.setAttribute("placeholder", "Type to search…");
      searchInput.setAttribute("aria-label", "Search schools");
      searchInput.setAttribute("autocomplete", "off");
      searchInput.setAttribute("autocorrect", "off");
      searchInput.setAttribute("autocapitalize", "off");
      searchInput.setAttribute("spellcheck", "false");

      var list = document.createElement("div");
      list.className = "searchable-select__list";
      list.setAttribute("role", "listbox");

      popup.appendChild(searchInput);
      popup.appendChild(list);

      wrap.appendChild(trigger);
      wrap.appendChild(popup);

      var options = [];
      var filtered = [];
      var activeIndex = -1;
      var isOpen = false;
      var placeholderLabel = "Select a school";

      function rebuildOptions() {
        options = [];
        var optEls = sel.querySelectorAll("option");
        for (var i = 0; i < optEls.length; i++) {
          var o = optEls[i];
          var v = o.value != null ? String(o.value) : "";
          var t = (o.textContent || "").trim();
          var isPh = isPlaceholderOption(v, t);
          if (isPh && t) {
            placeholderLabel = t;
          }
          options.push({ value: v, label: t, isPlaceholder: isPh });
        }
        syncTriggerText();
        if (isOpen) applyFilter();
      }

      function syncTriggerText() {
        var current = null;
        for (var i = 0; i < options.length; i++) {
          if (options[i].value === sel.value && !options[i].isPlaceholder) {
            current = options[i];
            break;
          }
        }
        if (current) {
          triggerText.textContent = current.label;
          triggerText.classList.remove("is-placeholder");
        } else {
          triggerText.textContent = placeholderLabel || "Select a school";
          triggerText.classList.add("is-placeholder");
        }
      }

      function applyFilter() {
        var q = String(searchInput.value || "").trim().toLowerCase();
        filtered = [];
        for (var i = 0; i < options.length; i++) {
          var o = options[i];
          if (o.isPlaceholder) continue;
          if (!q || o.label.toLowerCase().indexOf(q) !== -1) {
            filtered.push(o);
          }
        }
        if (activeIndex >= filtered.length) {
          activeIndex = filtered.length > 0 ? 0 : -1;
        }
        renderList();
      }

      function renderList() {
        list.innerHTML = "";
        if (!filtered.length) {
          var empty = document.createElement("div");
          empty.className = "searchable-select__empty";
          empty.textContent = searchInput.value
            ? "No schools match"
            : "No schools available";
          list.appendChild(empty);
          return;
        }
        for (var i = 0; i < filtered.length; i++) {
          var o = filtered[i];
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "searchable-select__option";
          btn.setAttribute("role", "option");
          btn.setAttribute("data-value", o.value);
          btn.textContent = o.label;
          if (o.value === sel.value) {
            btn.classList.add("is-selected");
            btn.setAttribute("aria-selected", "true");
          }
          if (i === activeIndex) {
            btn.classList.add("is-active");
          }
          list.appendChild(btn);
        }
        if (activeIndex >= 0 && activeIndex < list.children.length) {
          var activeBtn = list.children[activeIndex];
          if (activeBtn && activeBtn.scrollIntoView) {
            try {
              activeBtn.scrollIntoView({ block: "nearest" });
            } catch (e) {
              /* ignore */
            }
          }
        }
      }

      function openPopup() {
        if (sel.disabled) return;
        isOpen = true;
        popup.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        searchInput.value = "";
        activeIndex = -1;
        applyFilter();
        for (var i = 0; i < filtered.length; i++) {
          if (filtered[i].value === sel.value) {
            activeIndex = i;
            break;
          }
        }
        renderList();
        setTimeout(function () {
          try { searchInput.focus(); } catch (e) { /* ignore */ }
        }, 0);
      }

      function closePopup() {
        if (!isOpen) return;
        isOpen = false;
        popup.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }

      function chooseValue(v) {
        var prev = sel.value;
        sel.value = v;
        if (sel.value !== prev) {
          try {
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (e) {
            var ev = document.createEvent("Event");
            ev.initEvent("change", true, true);
            sel.dispatchEvent(ev);
          }
        }
        syncTriggerText();
        closePopup();
        try { trigger.focus(); } catch (e) { /* ignore */ }
      }

      trigger.addEventListener("click", function () {
        if (isOpen) closePopup();
        else openPopup();
      });

      trigger.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPopup();
        }
      });

      searchInput.addEventListener("input", function () {
        activeIndex = -1;
        applyFilter();
        if (filtered.length > 0) {
          activeIndex = 0;
          renderList();
        }
      });

      searchInput.addEventListener("keydown", function (e) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          if (filtered.length === 0) return;
          activeIndex = Math.min(activeIndex + 1, filtered.length - 1);
          if (activeIndex < 0) activeIndex = 0;
          renderList();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (filtered.length === 0) return;
          activeIndex = Math.max(activeIndex - 1, 0);
          renderList();
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (activeIndex >= 0 && activeIndex < filtered.length) {
            chooseValue(filtered[activeIndex].value);
          } else if (filtered.length === 1) {
            chooseValue(filtered[0].value);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          closePopup();
          try { trigger.focus(); } catch (eF) { /* ignore */ }
        } else if (e.key === "Tab") {
          closePopup();
        }
      });

      list.addEventListener("mousedown", function (e) {
        e.preventDefault();
      });

      list.addEventListener("click", function (e) {
        var btn = e.target && e.target.closest
          ? e.target.closest(".searchable-select__option")
          : null;
        if (!btn) return;
        var v = btn.getAttribute("data-value");
        if (v != null) chooseValue(v);
      });

      document.addEventListener("click", function (e) {
        if (!isOpen) return;
        if (wrap.contains(e.target)) return;
        closePopup();
      });

      try {
        var moOptions = new MutationObserver(rebuildOptions);
        moOptions.observe(sel, { childList: true, subtree: true });
      } catch (eMo) {
        /* ignore */
      }

      try {
        var moDisabled = new MutationObserver(function () {
          if (sel.disabled && isOpen) closePopup();
          syncTriggerText();
        });
        moDisabled.observe(sel, {
          attributes: true,
          attributeFilter: ["disabled"],
        });
      } catch (eMo2) {
        /* ignore */
      }

      sel.addEventListener("change", syncTriggerText);

      rebuildOptions();
    }

    function init() {
      for (var i = 0; i < SELECT_IDS.length; i++) {
        var sel = document.getElementById(SELECT_IDS[i]);
        if (sel) setup(sel);
      }
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();

  /* Keep each "How to use" summary's parenthetical hint in sync with its
     open/closed state: "(click to collapse)" when open, "(click to expand)" when closed. */
  (function setupHowtoHints() {
    function syncOne(details) {
      var hint = details.querySelector(".panel-howto__hint");
      if (!hint) return;
      hint.textContent = details.open ? "(click to collapse)" : "(click to expand)";
    }
    function init() {
      var all = document.querySelectorAll("details.panel-howto");
      for (var i = 0; i < all.length; i++) {
        (function (d) {
          syncOne(d);
          d.addEventListener("toggle", function () {
            syncOne(d);
          });
        })(all[i]);
      }
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  })();

  /* The standalone #sandbox-base-school dropdown was removed in favor of per-boundary
     base-school selects rendered inside renderSandboxBoundariesPanel(). The per-row
     selects wire their own change handler. */

  (function setupSandboxAddBoundaryButton() {
    var btn = document.getElementById("sandbox-add-boundary-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      sandboxAddBoundary();
      renderSandboxBoundariesPanel();
      updateSandboxSelectedHexCountUi();
      renderSandboxSummaryTable();
    });
  })();

  function resetScenarioSubtabState() {
    var sel = document.getElementById("scenario-school-select");
    if (sel) sel.value = "";
    var fc = document.getElementById("scenario-feeder-chain-only");
    if (fc) fc.checked = false;
    scenarioUseFeederChainOnly = false;
    scenarioCompleteMerger = false;
    syncScenarioMergerControlVisibility();
    scenarioGradeCheckedByMsid = Object.create(null);
    resetScenarioPanel();
    if (sel) sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Single "Reset scenario" button inline with the sub-tab toggle. Confirms before resetting
   *  the currently visible sub-tab's state (Scenario Planning or Boundary Sandbox). */
  (function setupScenarioSubtabResetButton() {
    var btn = document.getElementById("scenario-subtab-reset-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var which = scenarioActiveSubtabId();
      var label = which === "sandbox" ? "Boundary Sandbox" : "Enrollment Planning";
      var detail = which === "sandbox"
        ? "All drawn boundaries, base-school prefills, and grade toggles will be cleared."
        : "Your base school selection, included contributing schools, grade toggles, and merger settings will be cleared.";
      var msg = "Reset " + label + "?\n\n" + detail + "\n\nThis cannot be undone.";
      if (typeof window !== "undefined" && typeof window.confirm === "function") {
        if (!window.confirm(msg)) return;
      }
      if (which === "sandbox") {
        sandboxResetAll();
      } else {
        resetScenarioSubtabState();
      }
    });
  })();

  /* Confirm-selection button removed: selection now auto-syncs via
     updateSandboxSelectedHexCountUi(). The button click handler below is a
     no-op fallback that only runs if a deployment still has the legacy markup. */
  (function setupBoundarySandboxConfirm() {
    var cbtn = document.getElementById("sandbox-confirm-btn");
    if (!cbtn) {
      return;
    }
    cbtn.addEventListener("click", function () {
      updateSandboxSelectedHexCountUi();
    });
  })();

  (function setupBoundarySandboxClearButton() {
    var cl = document.getElementById("sandbox-clear-btn");
    if (!cl) {
      return;
    }
    cl.addEventListener("click", function () {
      clearBoundarySandboxGeographicSelection();
    });
  })();

  (function setupBoundarySandboxGradeAndSchoolListUi() {
    var gB = document.getElementById("sandbox-card-body-grade");
    if (gB) {
      gB.addEventListener("change", function (e) {
        var t = e.target;
        if (!t || !t.classList) {
          return;
        }
        var activeRec = sandboxActiveBoundary();
        if (t.classList.contains("sandbox-grade-select-all")) {
          var wantAll = t.checked;
          if (!activeRec) return;
          activeRec.gradeToggles = activeRec.gradeToggles || Object.create(null);
          var rowInputs = gB.querySelectorAll("input.sandbox-grade-toggle[data-grade-canon]");
          var blockedGradesAll = [];
          for (var si = 0; si < rowInputs.length; si++) {
            var bx = rowInputs[si];
            var gcx = bx.getAttribute("data-grade-canon");
            if (gcx == null) continue;
            if (wantAll && sandboxEnablingGradeWouldConflict(activeRec, gcx)) {
              blockedGradesAll.push(gcx);
              continue;
            }
            activeRec.gradeToggles[gcx] = wantAll;
          }
          if (blockedGradesAll.length) {
            var names = blockedGradesAll.map(function (gx) {
              return travelShedGradeDisplayLabel(gx);
            }).join(", ");
            showSandboxOverlapNotice(
              blockedGradesAll.length,
              "Could not enable grades " + names +
                " — they are already used by another boundary on a shared hex."
            );
          }
          updateSandboxStatsPanelSummary();
          renderSandboxBoundariesPanel();
          renderSandboxSummaryTable();
          return;
        }
        if (!t.classList.contains("sandbox-grade-toggle")) {
          return;
        }
        var gc = t.getAttribute("data-grade-canon");
        if (gc == null || !activeRec) return;
        activeRec.gradeToggles = activeRec.gradeToggles || Object.create(null);
        var wantOn = !!t.checked;
        if (wantOn && sandboxEnablingGradeWouldConflict(activeRec, gc)) {
          /* Block + revert: a shared hex already has this grade enabled in
             another boundary. The user must untoggle there first. */
          t.checked = false;
          showSandboxOverlapNotice(
            1,
            "Grade " + travelShedGradeDisplayLabel(gc) +
              " is already used by another boundary on a shared hex. Untoggle it there first."
          );
          return;
        }
        activeRec.gradeToggles[gc] = wantOn;
        updateSandboxStatsPanelSummary();
        renderSandboxBoundariesPanel();
        renderSandboxSummaryTable();
      });
    }
    var aT = document.getElementById("sandbox-card-body-attendance-type");
    if (aT) {
      aT.addEventListener("change", function (e) {
        var t2 = e.target;
        if (!t2 || !t2.classList || !t2.classList.contains("sandbox-attendance-type-toggle")) {
          return;
        }
        var atp = t2.getAttribute("data-atype");
        if (atp == null) {
          return;
        }
        BOUNDARY_SANDBOX.attendanceTypeToggles =
          BOUNDARY_SANDBOX.attendanceTypeToggles || Object.create(null);
        BOUNDARY_SANDBOX.attendanceTypeToggles[atp] = t2.checked;
        updateSandboxStatsPanelSummary();
        renderSandboxSummaryTable();
      });
    }
    var pSand = document.getElementById("scenario-subpanel-sandbox") ||
      document.getElementById("page-sandbox");
    if (pSand) {
      pSand.addEventListener("click", function (e) {
        var t = e.target;
        if (!t || !t.classList || !t.classList.contains("sandbox-school-expand")) {
          return;
        }
        e.preventDefault();
        var pan = t.getAttribute("data-panel");
        if (!pan) {
          return;
        }
        BOUNDARY_SANDBOX.schoolListExpanded = BOUNDARY_SANDBOX.schoolListExpanded || {
          attendance: false,
          zoned: false,
        };
        BOUNDARY_SANDBOX.schoolListExpanded[pan] = !BOUNDARY_SANDBOX.schoolListExpanded[pan];
        updateSandboxStatsPanelSummary();
      });
    }
  })();

  syncSandboxConfirmEditButtonStates();

  /* =========================================================================
   * Save and Share Scenario
   * -------------------------------------------------------------------------
   * - Single "Save and Share Scenario" button (next to "Reset scenario") opens
   *   a modal that builds a textual summary of the active sub-tab's state,
   *   offers a downloadable PDF, and opens the user's default email client
   *   via `mailto:` with the body pre-filled. A deep-link URL encoding the
   *   scenario state is appended so the recipient can re-open the same setup.
   * - PDF generation lazy-loads jsPDF and html2canvas from CDN on first use.
   * - On app load, if the URL hash contains a `share=...` payload, the state
   *   is decoded and applied to the matching sub-tab.
   * ========================================================================= */

  /* Project team recipients CC'd when "Also share with the Project Team" is checked. */
  var SHARE_PROJECT_TEAM_EMAILS = [
    "attendanceboundarychange@brevardschools.org",
    "k12strategies@perkinseastman.com",
  ];
  /* Comma-joined for the mailto cc field (no space — safest across email clients). */
  var SHARE_PROJECT_TEAM_CC = SHARE_PROJECT_TEAM_EMAILS.join(",");
  var SHARE_HASH_KEY = "share";
  /* Hard cap on the rendered email body so the resulting mailto: URL stays
     under common email-client limits (Outlook for Windows is ~2000 chars). */
  var SHARE_MAILTO_BODY_SOFT_LIMIT = 1800;

  /* -------------------------------------------------------------------------
   * Encoding helpers (base64url over a JSON payload).
   * ------------------------------------------------------------------------- */

  function shareEncodeB64Url(obj) {
    try {
      var s = JSON.stringify(obj);
      var utf = unescape(encodeURIComponent(s));
      var b64 = btoa(utf);
      return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    } catch (e) {
      return "";
    }
  }

  function shareDecodeB64Url(s) {
    try {
      var t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
      while (t.length % 4) t += "=";
      var bin = atob(t);
      var utf = decodeURIComponent(escape(bin));
      return JSON.parse(utf);
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------------------------------------
   * Scenario sub-tab: state -> compact payload, payload -> apply.
   * ------------------------------------------------------------------------- */

  function buildScenarioSharePayload(title) {
    var p = { k: "s", t: title || "" };
    if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) return p;
    p.b = Number(scenarioMiddleMsid);
    p.f = scenarioUseFeederChainOnly ? 1 : 0;
    p.m = scenarioCompleteMerger ? 1 : 0;
    /* User-added contributing schools (only valid outside feeder-chain mode). */
    if (
      !scenarioUseFeederChainOnly &&
      scenarioUserAddedFeederMsids &&
      scenarioUserAddedFeederMsids.length
    ) {
      p.u = scenarioUserAddedFeederMsids.slice();
    }
    /* Only persist the explicit "unchecked" overrides — assume "checked" is
       the default for any candidate row not explicitly unchecked. */
    var c = {};
    for (var msid in scenarioFeederChecked) {
      if (!Object.prototype.hasOwnProperty.call(scenarioFeederChecked, msid)) continue;
      if (scenarioFeederChecked[msid] === false) c[msid] = 0;
    }
    if (Object.keys(c).length) p.c = c;
    /* Persist only grade toggles that deviate from their per-grade default
       (most grades default on; PK defaults off). 0 = turned off, 1 = turned on. */
    var g = {};
    for (var ms in scenarioGradeCheckedByMsid) {
      if (!Object.prototype.hasOwnProperty.call(scenarioGradeCheckedByMsid, ms)) continue;
      var entry = scenarioGradeCheckedByMsid[ms];
      if (!entry) continue;
      var off = {};
      var any = false;
      for (var gc in entry) {
        var val = entry[gc];
        if (val == null) continue;
        var def = scenarioGradeDefaultChecked(gc);
        if (val === false && def) { off[gc] = 0; any = true; }
        else if (val === true && !def) { off[gc] = 1; any = true; }
      }
      if (any) g[ms] = off;
    }
    if (Object.keys(g).length) p.g = g;
    return p;
  }

  function applyScenarioSharePayload(state) {
    if (!state || state.k !== "s") return false;
    /* Switch to the Scenario Planning sub-tab if needed. */
    var subBtn = document.getElementById("scenario-subtab-tab-scenario");
    if (subBtn && !subBtn.classList.contains("is-active")) {
      try { subBtn.click(); } catch (e) { /* ignore */ }
    }
    if (state.b == null || isNaN(Number(state.b))) return false;
    var sel = document.getElementById("scenario-school-select");
    if (!sel) return false;
    /* Re-running the dropdown change handler is the entry point that rebuilds
       feeder lists + chart + tables for the chosen base school. */
    sel.value = String(state.b);
    try {
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) { /* ignore */ }
    /* Apply user-added contributing schools (only meaningful outside
       feeder-chain mode). Do this BEFORE toggling feeder-chain so a fresh
       rebuild picks them up — and so feeder-chain ON properly clears them. */
    if (!state.f && Array.isArray(state.u) && state.u.length) {
      var cleanU = [];
      for (var ui = 0; ui < state.u.length; ui++) {
        var um = Number(state.u[ui]);
        if (!isNaN(um)) {
          cleanU.push(um);
          /* User-added schools default to checked-on (override applied later
             via state.c if the sharer had explicitly unchecked them). */
          scenarioFeederChecked[um] = true;
        }
      }
      scenarioUserAddedFeederMsids = cleanU;
      refreshScenarioContributingSchoolsForToggle();
    }
    /* Apply feeder-chain toggle BEFORE applying per-school checkboxes — its
       change handler rebuilds the candidate list. */
    var fc = document.getElementById("scenario-feeder-chain-only");
    var wantFc = !!state.f;
    if (fc && fc.checked !== wantFc) {
      fc.checked = wantFc;
      try { fc.dispatchEvent(new Event("change", { bubbles: true })); }
      catch (e2) { /* ignore */ }
    }
    /* Apply complete-merger toggle (only meaningful when feeder-chain is on). */
    var cm = document.getElementById("scenario-complete-merger");
    var wantCm = !!state.m;
    if (cm && cm.checked !== wantCm) {
      cm.checked = wantCm;
      try { cm.dispatchEvent(new Event("change", { bubbles: true })); }
      catch (e3) { /* ignore */ }
    }
    /* Apply per-school include overrides. */
    if (state.c && typeof state.c === "object") {
      for (var msid in state.c) {
        if (!Object.prototype.hasOwnProperty.call(state.c, msid)) continue;
        var on = !(state.c[msid] === 0 || state.c[msid] === false);
        scenarioFeederChecked[msid] = on;
        var ul = document.getElementById("scenario-feeder-list");
        if (ul) {
          var cb = ul.querySelector('input[type="checkbox"][data-msid="' + msid + '"]:not(.scenario-feeder-grade-chip-input)');
          if (cb) cb.checked = on;
        }
      }
    }
    /* Apply per-school per-grade overrides. */
    if (state.g && typeof state.g === "object") {
      for (var ms in state.g) {
        if (!Object.prototype.hasOwnProperty.call(state.g, ms)) continue;
        if (!scenarioGradeCheckedByMsid[ms]) {
          scenarioGradeCheckedByMsid[ms] = Object.create(null);
        }
        var gobj = state.g[ms] || {};
        for (var gc in gobj) {
          var gOn = !(gobj[gc] === 0 || gobj[gc] === false);
          scenarioGradeCheckedByMsid[ms][gc] = gOn;
          var ulG = document.getElementById("scenario-feeder-list");
          if (ulG) {
            var sel2 = ulG.querySelector(
              'input.scenario-feeder-grade-chip-input[data-msid="' + ms + '"][data-grade-canon="' + gc + '"]'
            );
            if (sel2) {
              sel2.checked = gOn;
              var chipEl = sel2.closest(".scenario-feeder-grade-chip");
              if (chipEl) chipEl.classList.toggle("is-off", !gOn);
            }
          }
        }
      }
    }
    try { applyScenarioMergedUpdates(); } catch (e4) { /* ignore */ }
    try {
      if (typeof updateScenarioFeederRemainingCells === "function") {
        updateScenarioFeederRemainingCells();
      }
    } catch (e5) { /* ignore */ }
    return true;
  }

  /* -------------------------------------------------------------------------
   * Sandbox sub-tab: state -> compact payload, payload -> apply.
   * ------------------------------------------------------------------------- */

  function buildSandboxSharePayload(title) {
    var p = { k: "b", t: title || "", bs: [] };
    var bs = BOUNDARY_SANDBOX.boundaries || [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var hexKeys = [];
      for (var hk in b.selectedHexKeys) {
        if (b.selectedHexKeys[hk]) hexKeys.push(hk);
      }
      /* Persist only deviations from each bucket's default (most grades/types
         default on; PK, No-grade, charter, choice, homeschool default off).
         0 = turned off, 1 = turned on. */
      var off = {};
      if (b.gradeToggles) {
        for (var gk in b.gradeToggles) {
          var gv = b.gradeToggles[gk];
          if (gv == null) continue;
          var gDef = sandboxDefaultGradeIncluded(gk);
          if (gv === false && gDef) off[gk] = 0;
          else if (gv === true && !gDef) off[gk] = 1;
        }
      }
      var atOff = {};
      if (b.attendanceTypeToggles) {
        for (var ak in b.attendanceTypeToggles) {
          var av = b.attendanceTypeToggles[ak];
          if (av == null) continue;
          var aDef = sandboxDefaultAttendanceTypeIncluded(ak);
          if (av === false && aDef) atOff[ak] = 0;
          else if (av === true && !aDef) atOff[ak] = 1;
        }
      }
      p.bs.push({
        n: b.name || "",
        b: b.baseMsid != null && !isNaN(b.baseMsid) ? Number(b.baseMsid) : null,
        h: hexKeys,
        g: Object.keys(off).length ? off : undefined,
        a: Object.keys(atOff).length ? atOff : undefined,
      });
    }
    return p;
  }

  function applySandboxSharePayload(state) {
    if (!state || state.k !== "b") return false;
    var subBtn = document.getElementById("scenario-subtab-tab-sandbox");
    if (subBtn && !subBtn.classList.contains("is-active")) {
      try { subBtn.click(); } catch (e) { /* ignore */ }
    }
    if (!Array.isArray(state.bs)) return false;
    /* Reset to a single empty boundary, then overwrite it and add more. */
    try { sandboxResetAll(); } catch (e2) { /* ignore */ }
    for (var i = 0; i < state.bs.length && i < SANDBOX_MAX_BOUNDARIES; i++) {
      if (i > 0) {
        try { sandboxAddBoundary(); } catch (eA) { /* ignore */ }
      }
      var dst = BOUNDARY_SANDBOX.boundaries[i];
      if (!dst) continue;
      var src = state.bs[i] || {};
      if (typeof src.n === "string" && src.n.trim()) dst.name = src.n;
      if (src.b != null && !isNaN(Number(src.b))) dst.baseMsid = Number(src.b);
      if (Array.isArray(src.h)) {
        dst.selectedHexKeys = Object.create(null);
        for (var hi = 0; hi < src.h.length; hi++) {
          var hKey = String(src.h[hi]);
          dst.selectedHexKeys[hKey] = true;
          try {
            if (typeof map !== "undefined" && map && map.setFeatureState) {
              map.setFeatureState(
                { source: "boundary-sandbox-hex", id: hKey },
                { boundaryId: dst.id }
              );
            }
          } catch (eF) { /* ignore */ }
        }
        dst.confirmedHexKeysSnapshot = shallowCopyHexKeyBag(dst.selectedHexKeys);
      }
      if (src.g && typeof src.g === "object") {
        dst.gradeToggles = dst.gradeToggles || Object.create(null);
        for (var gk2 in src.g) {
          dst.gradeToggles[gk2] = !(src.g[gk2] === 0 || src.g[gk2] === false);
        }
      }
      if (src.a && typeof src.a === "object") {
        dst.attendanceTypeToggles = dst.attendanceTypeToggles || Object.create(null);
        for (var ak2 in src.a) {
          dst.attendanceTypeToggles[ak2] = !(src.a[ak2] === 0 || src.a[ak2] === false);
        }
      }
    }
    try { renderSandboxBoundariesPanel(); } catch (eP) { /* ignore */ }
    try { updateSandboxSelectedHexCountUi(); } catch (eP2) { /* ignore */ }
    try { renderSandboxSummaryTable(); } catch (eP3) { /* ignore */ }
    try { syncSandboxActiveBoundaryPaints(); } catch (eP4) { /* ignore */ }
    return true;
  }

  /* -------------------------------------------------------------------------
   * Textual summary builders (Scenario + Sandbox).
   * Both return: { defaultTitle: string, lines: string[] }
   * `lines` is the per-line body without comments / deep-link suffix.
   * ------------------------------------------------------------------------- */

  function buildScenarioSummaryText() {
    var lines = [];
    var defaultTitle = "Enrollment Planning summary";
    if (scenarioMiddleMsid == null || isNaN(scenarioMiddleMsid)) {
      lines.push("No base school selected yet.");
      return { defaultTitle: defaultTitle, lines: lines };
    }
    var baseM = masterRow(scenarioMiddleMsid);
    var baseName = baseM && baseM.school_name
      ? String(baseM.school_name).trim()
      : ("School " + scenarioMiddleMsid);
    defaultTitle = "Scenario: " + baseName;
    lines.push("Sub-tab: Enrollment Planning");
    lines.push("Base receiving school: " + baseName + " (MSID " + scenarioMiddleMsid + ")");
    lines.push(
      "Candidate-school mode: " +
        (scenarioUseFeederChainOnly
          ? "Existing feeder chain"
          : "10 closest eligible schools")
    );
    if (scenarioUseFeederChainOnly) {
      lines.push(
        "Merger: " +
          (scenarioCompleteMerger
            ? "Complete (100% of each contributing school's enrollment)"
            : "Proportional (uses historical advancement share)")
      );
    } else {
      lines.push("Merger: Complete (assumed when not restricted to feeder chain)");
    }
    /* KPI line, if rendered. */
    var elKpi = document.getElementById("scenario-details-kpi-primary");
    if (elKpi && elKpi.textContent && !elKpi.classList.contains("school-details-placeholder")) {
      lines.push("");
      lines.push(elKpi.textContent.trim());
    }
    /* Contributing schools list. */
    lines.push("");
    lines.push("Contributing schools (checked = included):");
    var rows = scenarioLastFeederRows || [];
    if (!rows.length) {
      lines.push("  (no candidates)");
    } else {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (r.msid == null || isNaN(r.msid)) continue;
        var rMaster = masterRow(r.msid);
        var rName = rMaster && rMaster.school_name
          ? String(rMaster.school_name).trim()
          : r.sankeyLabel || ("School " + r.msid);
        var isChecked = scenarioFeederChecked[r.msid] !== false;
        var mark = isChecked ? "[X]" : "[ ]";
        var pairPP = scenarioFeederEnrollmentProportionalPair(r);
        var enrStr = pairPP.enr != null ? pairPP.enr.toLocaleString() : "—";
        var baseTag = r.isScenarioMiddleRow ? " (base)" : "";
        var roleHint = "";
        if (scenarioUseFeederChainOnly && !r.isScenarioMiddleRow && pairPP.propAmt != null) {
          roleHint = "; proportional " + pairPP.propAmt.toLocaleString();
        }
        lines.push("  " + mark + " " + rName + baseTag + " — '25-26 enrollment " + enrStr + roleHint);
        /* If any grades are toggled off, surface that. */
        var byMs = scenarioGradeCheckedByMsid[r.msid];
        if (!r.isScenarioMiddleRow && byMs) {
          var offGrades = [];
          for (var gc in byMs) {
            if (byMs[gc] === false) offGrades.push(travelShedGradeDisplayLabel(gc));
          }
          if (offGrades.length) {
            lines.push("        Grades excluded: " + offGrades.join(", "));
          }
        }
      }
    }
    /* Enrollment-by-grade summary for the active period. */
    var label = (typeof effectiveScenarioGradeSummaryLabel === "function")
      ? effectiveScenarioGradeSummaryLabel()
      : SCENARIO_GRADE_SUMMARY_DEFAULT_LABEL;
    var byGrade = (typeof scenarioMergedByGradeForPeriod === "function")
      ? scenarioMergedByGradeForPeriod(label)
      : null;
    if (byGrade) {
      var gKeys = Object.keys(byGrade).sort(function (a, b) {
        var oa = (typeof charterGradeCanonToOrdinal === "function")
          ? charterGradeCanonToOrdinal(a) : 99;
        var ob = (typeof charterGradeCanonToOrdinal === "function")
          ? charterGradeCanonToOrdinal(b) : 99;
        return (oa != null ? oa : 99) - (ob != null ? ob : 99);
      });
      if (gKeys.length) {
        lines.push("");
        lines.push(label + " Enrollment by Grade (merged):");
        var totalG = 0;
        for (var gi = 0; gi < gKeys.length; gi++) {
          var gk = gKeys[gi];
          var v = byGrade[gk];
          if (v == null || isNaN(v)) v = 0;
          var rounded = Math.round(v);
          totalG += rounded;
          lines.push("  Grade " + travelShedGradeDisplayLabel(gk) + ": " + rounded.toLocaleString());
        }
        lines.push("  Total: " + totalG.toLocaleString());
      }
    }
    return { defaultTitle: defaultTitle, lines: lines };
  }

  function buildSandboxSummaryText() {
    var lines = [];
    var defaultTitle = "Boundary Sandbox summary";
    var bs = (BOUNDARY_SANDBOX.boundaries || []);
    lines.push("Sub-tab: Boundary Sandbox");
    lines.push("Boundaries: " + bs.length + " / " + SANDBOX_MAX_BOUNDARIES);
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      lines.push("");
      lines.push("Boundary " + (i + 1) + ": " + (b.name || ("Boundary " + (i + 1))));
      var baseLine = "  Base school: ";
      if (b.baseMsid != null && !isNaN(b.baseMsid)) {
        var bM = masterRow(b.baseMsid);
        baseLine += (bM && bM.school_name)
          ? (String(bM.school_name).trim() + " (MSID " + b.baseMsid + ")")
          : ("MSID " + b.baseMsid);
      } else {
        baseLine += "(none)";
      }
      lines.push(baseLine);
      var nHex = 0;
      for (var hk in b.selectedHexKeys) { if (b.selectedHexKeys[hk]) nHex++; }
      lines.push("  Selected hexes: " + nHex.toLocaleString());
      /* Grade toggles that are explicitly off. */
      if (b.gradeToggles) {
        var offG = [];
        for (var gg in b.gradeToggles) {
          if (b.gradeToggles[gg] === false) offG.push(travelShedGradeDisplayLabel(gg));
        }
        if (offG.length) lines.push("  Grades excluded: " + offG.join(", "));
      }
      if (b.attendanceTypeToggles) {
        var offA = [];
        for (var aa in b.attendanceTypeToggles) {
          if (b.attendanceTypeToggles[aa] === false) offA.push(String(aa));
        }
        if (offA.length) lines.push("  Attendance types excluded: " + offA.join(", "));
      }
    }
    /* Append summary table (read straight from rendered DOM for accuracy). */
    var sumWrap = document.getElementById("sandbox-summary-table-wrap");
    var table = sumWrap ? sumWrap.querySelector("table.sandbox-summary-table") : null;
    if (table) {
      lines.push("");
      lines.push("Summary table:");
      var headerCells = table.querySelectorAll("thead th");
      var headers = [];
      for (var hci = 0; hci < headerCells.length; hci++) {
        headers.push(headerCells[hci].textContent.trim());
      }
      if (headers.length) {
        lines.push("  " + headers.join(" | "));
      }
      var bodyRows = table.querySelectorAll("tbody tr");
      for (var bri = 0; bri < bodyRows.length; bri++) {
        var cells = bodyRows[bri].querySelectorAll("th,td");
        var vals = [];
        for (var ci = 0; ci < cells.length; ci++) {
          vals.push(cells[ci].textContent.trim().replace(/\s+/g, " "));
        }
        lines.push("  " + vals.join(" | "));
      }
    }
    return { defaultTitle: defaultTitle, lines: lines };
  }

  /* -------------------------------------------------------------------------
   * Dialog wiring.
   * ------------------------------------------------------------------------- */

  function buildShareDeepLinkUrl(payload) {
    var enc = shareEncodeB64Url(payload);
    if (!enc) return "";
    var base = window.location.origin + window.location.pathname + window.location.search;
    return base + "#" + SHARE_HASH_KEY + "=" + enc;
  }

  function buildShareBodyText(opts) {
    var which = scenarioActiveSubtabId();
    var summary = which === "sandbox"
      ? buildSandboxSummaryText()
      : buildScenarioSummaryText();
    var title = (opts && opts.title) ? String(opts.title).trim() : "";
    if (!title) title = summary.defaultTitle;
    var comments = (opts && opts.comments) ? String(opts.comments).trim() : "";
    var dt = new Date();
    var dateStr = dt.toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    }) + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

    var body = [];
    body.push("Title: " + title);
    body.push("Generated: " + dateStr);
    body.push("");
    body.push.apply(body, summary.lines);
    if (comments) {
      body.push("");
      body.push("Comments:");
      body.push(comments);
    }
    /* Deep-link suffix. */
    var payload = which === "sandbox"
      ? buildSandboxSharePayload(title)
      : buildScenarioSharePayload(title);
    var url = buildShareDeepLinkUrl(payload);
    if (url) {
      body.push("");
      body.push("Open this scenario in the dashboard:");
      body.push(url);
    }
    body.push("");
    body.push("— Sent from the Brevard District Exploration Dashboard.");
    return body.join("\n");
  }

  function buildShareMailtoUrl(opts) {
    var title = (opts && opts.title) ? String(opts.title).trim() : "";
    if (!title) title = "Scenario Dashboard Summary";
    var to = (opts && opts.to) ? String(opts.to).trim() : "";
    var cc = (opts && opts.cc) ? String(opts.cc).trim() : "";
    var body = (opts && opts.body) ? String(opts.body) : "";
    /* Soft-truncate the body to stay within typical mailto: limits. The deep
       link will be the last line, so trim from the middle of the structured
       portion if necessary, preserving the URL at the end. */
    if (body.length > SHARE_MAILTO_BODY_SOFT_LIMIT) {
      var deepLinkIdx = body.lastIndexOf("Open this scenario in the dashboard:");
      if (deepLinkIdx > 0) {
        var head = body.substring(0, Math.max(0, SHARE_MAILTO_BODY_SOFT_LIMIT - 600));
        var tail = body.substring(deepLinkIdx);
        body = head + "\n\n[Summary truncated for email size — full version is in the attached PDF.]\n\n" + tail;
      } else if (body.length > SHARE_MAILTO_BODY_SOFT_LIMIT) {
        body = body.substring(0, SHARE_MAILTO_BODY_SOFT_LIMIT) +
          "\n\n[Summary truncated for email size — full version is in the attached PDF.]";
      }
    }
    var params = [];
    params.push("subject=" + encodeURIComponent(title));
    params.push("body=" + encodeURIComponent(body));
    if (cc) params.push("cc=" + encodeURIComponent(cc));
    var toEnc = to ? encodeURIComponent(to) : "";
    return "mailto:" + toEnc + "?" + params.join("&");
  }

  function shareIsLikelyEmail(s) {
    if (!s) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
  }

  function shareStatus(text, kind) {
    var el = document.getElementById("share-scenario-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("is-error", "is-success");
    if (kind === "error") el.classList.add("is-error");
    if (kind === "success") el.classList.add("is-success");
  }

  function shareDialogRefreshPreview() {
    var titleEl = document.getElementById("share-scenario-title-input");
    var commentsEl = document.getElementById("share-scenario-comments-input");
    var preEl = document.getElementById("share-scenario-preview-pre");
    if (!preEl) return;
    var body = buildShareBodyText({
      title: titleEl ? titleEl.value : "",
      comments: commentsEl ? commentsEl.value : ""
    });
    preEl.textContent = body;
  }

  function shareDialogPopulateDefaults() {
    var titleEl = document.getElementById("share-scenario-title-input");
    var districtSpan = document.getElementById("share-scenario-district-email");
    var helperEl = document.getElementById("share-scenario-helper");
    var which = scenarioActiveSubtabId();
    var summary = which === "sandbox"
      ? buildSandboxSummaryText()
      : buildScenarioSummaryText();
    if (titleEl && !titleEl.value.trim()) {
      titleEl.value = summary.defaultTitle;
    }
    if (districtSpan) districtSpan.textContent = "(" + SHARE_PROJECT_TEAM_EMAILS.join(", ") + ")";
    if (helperEl) {
      helperEl.textContent = which === "sandbox"
        ? "Email a summary of your current Boundary Sandbox setup. Your default email client will open with the message pre-filled — you click Send. Attach the downloaded PDF for a richer summary."
        : "Email a summary of your current Scenario Planning setup. Your default email client will open with the message pre-filled — you click Send. Attach the downloaded PDF for a richer summary.";
    }
    shareDialogRefreshPreview();
    shareStatus("", null);
  }

  function shareDialogOpen() {
    var overlay = document.getElementById("share-scenario-overlay");
    if (!overlay) return;
    overlay.hidden = false;
    shareDialogPopulateDefaults();
    /* Focus the title field for quick edits. */
    var titleEl = document.getElementById("share-scenario-title-input");
    if (titleEl) {
      try { titleEl.focus(); titleEl.select(); } catch (e) { /* ignore */ }
    }
    document.addEventListener("keydown", shareDialogKeydownHandler);
  }

  function shareDialogClose() {
    var overlay = document.getElementById("share-scenario-overlay");
    if (!overlay) return;
    overlay.hidden = true;
    document.removeEventListener("keydown", shareDialogKeydownHandler);
  }

  function shareDialogKeydownHandler(e) {
    if (e && e.key === "Escape") {
      e.preventDefault();
      shareDialogClose();
    }
  }

  function shareDialogHandleSend() {
    var titleEl = document.getElementById("share-scenario-title-input");
    var recipientEl = document.getElementById("share-scenario-recipient-input");
    var districtEl = document.getElementById("share-scenario-district-input");
    var commentsEl = document.getElementById("share-scenario-comments-input");
    var to = recipientEl ? recipientEl.value.trim() : "";
    var cc = districtEl && districtEl.checked ? SHARE_PROJECT_TEAM_CC : "";
    if (!to && !cc) {
      shareStatus("Add a recipient email, or check 'Also Share with the Project Team', to send.", "error");
      if (recipientEl) recipientEl.focus();
      return;
    }
    if (to && !shareIsLikelyEmail(to)) {
      shareStatus("That doesn't look like a valid email address.", "error");
      if (recipientEl) recipientEl.focus();
      return;
    }
    var body = buildShareBodyText({
      title: titleEl ? titleEl.value : "",
      comments: commentsEl ? commentsEl.value : ""
    });
    var url = buildShareMailtoUrl({
      to: to,
      cc: cc,
      title: titleEl ? titleEl.value : "",
      body: body
    });
    try {
      window.location.href = url;
      shareStatus("Opening your email client…", "success");
    } catch (e) {
      shareStatus("Could not open the email client automatically. Copy the preview text and paste it into a new email.", "error");
    }
  }

  /* -------------------------------------------------------------------------
   * PDF generation (lazy-load jsPDF + html2canvas from CDN).
   * ------------------------------------------------------------------------- */

  /**
   * jsPDF's built-in Helvetica is WinAnsi-encoded (Windows-1252). Any text
   * passed to doc.text() that contains a character outside that encoding
   * corrupts the entire string in the rendered PDF — characters get mangled
   * into sequences like "&C&o&n&t..." This helper transliterates common
   * non-WinAnsi glyphs (arrows, check marks, etc.) and replaces anything
   * else outside Windows-1252 with "?" so PDF output is always readable.
   * Used only for PDF text — UI/email paths still keep the original glyphs.
   */
  function sharePdfSafeText(s) {
    if (s == null) return "";
    return String(s)
      /* Arrows. */
      .replace(/\u2192/g, "->")
      .replace(/\u2190/g, "<-")
      .replace(/\u2191/g, "^")
      .replace(/\u2193/g, "v")
      .replace(/\u21D2/g, "=>")
      .replace(/\u21D0/g, "<=")
      .replace(/\u21C4|\u2194/g, "<->")
      /* Check / cross marks. */
      .replace(/\u2713/g, "[x]")
      .replace(/\u2717/g, "[ ]")
      /* Fallback: replace anything outside WinAnsi-1252 with "?". The
         allow-list keeps the common CP1252 supplemental code points
         (curly quotes, em/en dash, ellipsis, bullet, trademark, euro, etc.)
         while stripping arrows, mathematical symbols, CJK, etc. */
      .replace(
        /[^\x00-\xff\u0152\u0153\u0160\u0161\u017D\u017E\u0178\u0192\u02C6\u02DC\u2013\u2014\u2018-\u201D\u201E\u2020-\u2022\u2026\u2030\u2039\u203A\u20AC\u2122]/g,
        "?"
      );
  }

  /** Apply sharePdfSafeText to each element of an array of lines. */
  function sharePdfSafeLines(arr) {
    if (!Array.isArray(arr)) return [];
    var out = new Array(arr.length);
    for (var i = 0; i < arr.length; i++) out[i] = sharePdfSafeText(arr[i]);
    return out;
  }

  var SHARE_PDF_LIBS_PROMISE = null;
  function shareLoadPdfLibs() {
    if (SHARE_PDF_LIBS_PROMISE) return SHARE_PDF_LIBS_PROMISE;
    SHARE_PDF_LIBS_PROMISE = new Promise(function (resolve, reject) {
      function loadScript(src) {
        return new Promise(function (res, rej) {
          var existing = document.querySelector('script[data-share-lib="' + src + '"]');
          if (existing) { res(); return; }
          var s = document.createElement("script");
          s.src = src;
          s.async = true;
          s.setAttribute("data-share-lib", src);
          s.onload = function () { res(); };
          s.onerror = function () { rej(new Error("Failed to load " + src)); };
          document.head.appendChild(s);
        });
      }
      Promise.all([
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"),
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js")
      ])
        .then(function () {
          var jsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
          var html2canvas = window.html2canvas;
          if (!jsPDF || !html2canvas) {
            reject(new Error("PDF libraries did not initialize"));
            return;
          }
          resolve({ jsPDF: jsPDF, html2canvas: html2canvas });
        })
        .catch(function (err) {
          SHARE_PDF_LIBS_PROMISE = null; /* allow retry on next click */
          reject(err);
        });
    });
    return SHARE_PDF_LIBS_PROMISE;
  }

  /**
   * Captures the Mapbox GL canvas as a PNG dataUrl for the Save & Share PDF.
   * Forces a fresh repaint and waits for the next `render` event (capped by a
   * small timeout) before snapshotting, so the WebGL drawing buffer is
   * guaranteed to be up to date. Requires the map to be initialized with
   * `preserveDrawingBuffer: true`; otherwise the resulting image is blank.
   * Returns null on any failure so the PDF export can continue without it.
   */
  function captureMapCanvasForPdf() {
    return new Promise(function (resolve) {
      if (typeof map === "undefined" || !map || typeof map.getCanvas !== "function") {
        resolve(null);
        return;
      }
      function snapshot() {
        try {
          var cnv = map.getCanvas();
          var dataUrl = cnv.toDataURL("image/png");
          if (!dataUrl || dataUrl.length < 100) {
            resolve(null);
            return;
          }
          resolve({ dataUrl: dataUrl, width: cnv.width, height: cnv.height });
        } catch (e) {
          resolve(null);
        }
      }
      var done = false;
      function once() {
        if (done) return;
        done = true;
        try { map.off("render", once); } catch (eOff) { /* ignore */ }
        try { map.off("idle", once); } catch (eOff2) { /* ignore */ }
        /* Run on the next frame so the freshly-rendered buffer is committed. */
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(snapshot);
        } else {
          setTimeout(snapshot, 16);
        }
      }
      try { map.once("render", once); } catch (eOn) { /* ignore */ }
      try { map.once("idle", once); } catch (eOn2) { /* ignore */ }
      try {
        if (typeof map.triggerRepaint === "function") map.triggerRepaint();
      } catch (eR) { /* ignore */ }
      /* Belt-and-suspenders: if neither event fires within 750ms (rare; e.g.
         map already idle and no style changes pending), force a capture. */
      setTimeout(once, 750);
    });
  }

  /** Capture an element to a canvas, returning { dataUrl, width, height }
   *  in image pixel units. Uses html2canvas under the hood. */
  function shareCaptureElement(el, html2canvas) {
    if (!el) return Promise.resolve(null);
    return html2canvas(el, {
      backgroundColor: "#ffffff",
      scale: window.devicePixelRatio || 1,
      useCORS: true,
      logging: false
    }).then(function (canvas) {
      return {
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height
      };
    }).catch(function () {
      return null;
    });
  }

  function shareSanitizeFileName(s) {
    var t = String(s || "scenario").trim().replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "_");
    if (!t) t = "scenario";
    return t.substring(0, 60);
  }

  function shareGeneratePdf() {
    return shareLoadPdfLibs().then(function (libs) {
      var jsPDF = libs.jsPDF;
      var html2canvas = libs.html2canvas;
      var which = scenarioActiveSubtabId();
      var summary = which === "sandbox"
        ? buildSandboxSummaryText()
        : buildScenarioSummaryText();
      var titleEl = document.getElementById("share-scenario-title-input");
      var commentsEl = document.getElementById("share-scenario-comments-input");
      var title = titleEl && titleEl.value.trim() ? titleEl.value.trim() : summary.defaultTitle;
      var comments = commentsEl ? commentsEl.value.trim() : "";

      var doc = new jsPDF({ unit: "pt", format: "letter" });
      var pageW = doc.internal.pageSize.getWidth();
      var pageH = doc.internal.pageSize.getHeight();
      var margin = 40;
      var maxW = pageW - margin * 2;
      var y = margin;

      /* Header. */
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.text(sharePdfSafeText(title), margin, y);
      y += 22;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(80);
      var dt = new Date();
      var dateStr = dt.toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric"
      }) + " " + dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      doc.text(sharePdfSafeText("Generated " + dateStr +
        " - Brevard K-8 Engagement Scenario Dashboard"), margin, y);
      y += 16;
      doc.setDrawColor(220);
      doc.line(margin, y, pageW - margin, y);
      y += 14;

      /* Text-summary section. */
      doc.setTextColor(20);
      doc.setFontSize(11);
      var safeSummary = sharePdfSafeLines(summary.lines);
      var summaryText = safeSummary.join("\n");
      var summaryLines = doc.splitTextToSize(summaryText, maxW);
      var lineH = 13;
      for (var li = 0; li < summaryLines.length; li++) {
        if (y + lineH > pageH - margin) {
          doc.addPage();
          y = margin;
        }
        doc.text(sharePdfSafeText(summaryLines[li]), margin, y);
        y += lineH;
      }

      if (comments) {
        y += 8;
        if (y + lineH > pageH - margin) { doc.addPage(); y = margin; }
        doc.setFont("helvetica", "bold");
        doc.text("Comments", margin, y);
        y += lineH;
        doc.setFont("helvetica", "normal");
        var cLines = doc.splitTextToSize(sharePdfSafeText(comments), maxW);
        for (var ci = 0; ci < cLines.length; ci++) {
          if (y + lineH > pageH - margin) { doc.addPage(); y = margin; }
          doc.text(sharePdfSafeText(cLines[ci]), margin, y);
          y += lineH;
        }
      }

      /* Capture targets per sub-tab. */
      var captureTargets = [];
      if (which === "sandbox") {
        captureTargets.push({
          el: document.getElementById("sandbox-summary-table-wrap"),
          label: "Sandbox summary table"
        });
        if (typeof map !== "undefined" && map && typeof map.getCanvas === "function") {
          captureTargets.push({ mapCanvas: true, label: "Map view" });
        }
      } else {
        captureTargets.push({
          el: document.querySelector(".scenario-enrollment-row"),
          label: "Merged enrollment over time"
        });
        captureTargets.push({
          el: document.getElementById("scenario-feeder-list"),
          label: "Contributing schools"
        });
        if (typeof map !== "undefined" && map && typeof map.getCanvas === "function") {
          captureTargets.push({ mapCanvas: true, label: "Map view" });
        }
      }

      /* Sequentially capture each target and append to PDF. */
      var chain = Promise.resolve();
      captureTargets.forEach(function (t) {
        chain = chain.then(function () {
          if (t.mapCanvas) {
            return captureMapCanvasForPdf();
          }
          return shareCaptureElement(t.el, html2canvas);
        }).then(function (cap) {
          if (!cap || !cap.dataUrl) return;
          if (y + 22 > pageH - margin) { doc.addPage(); y = margin; }
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.text(sharePdfSafeText(t.label), margin, y);
          y += 14;
          var ratio = cap.width > 0 ? maxW / cap.width : 1;
          var drawW = maxW;
          var drawH = cap.height * ratio;
          var availH = pageH - margin - y;
          if (drawH > availH) {
            /* Either fit on this page if mostly fitting, or move to a new
               page. We prefer the larger image if more than ~half fits. */
            if (availH < 200) {
              doc.addPage();
              y = margin;
              availH = pageH - margin - y;
            }
            if (drawH > availH) {
              ratio = availH / cap.height;
              drawH = availH;
              drawW = cap.width * ratio;
            }
          }
          try {
            doc.addImage(cap.dataUrl, "PNG", margin, y, drawW, drawH);
            y += drawH + 14;
          } catch (eAdd) { /* ignore */ }
        });
      });

      return chain.then(function () {
        var name = shareSanitizeFileName(title) + ".pdf";
        doc.save(name);
        return true;
      });
    });
  }

  function shareDialogHandlePdf() {
    var btn = document.getElementById("share-scenario-pdf-btn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Building PDF…";
    }
    shareStatus("Generating PDF — this can take a few seconds…", null);
    shareGeneratePdf()
      .then(function () {
        shareStatus("PDF downloaded. Attach it to the email after clicking 'Open in Email'.", "success");
      })
      .catch(function (err) {
        shareStatus(
          "Could not build the PDF (" + (err && err.message ? err.message : "unknown error") +
          "). You can still send the text-only summary via the email button.",
          "error"
        );
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Download PDF";
        }
      });
  }

  /* -------------------------------------------------------------------------
   * Wire up button + dialog + URL-hash deep-link reading.
   * ------------------------------------------------------------------------- */

  (function setupShareDialogBindings() {
    var openBtn = document.getElementById("scenario-save-share-btn");
    if (openBtn) {
      openBtn.addEventListener("click", function () {
        shareDialogOpen();
      });
    }
    var closeBtn = document.getElementById("share-scenario-close-btn");
    if (closeBtn) closeBtn.addEventListener("click", shareDialogClose);
    var cancelBtn = document.getElementById("share-scenario-cancel-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", shareDialogClose);
    var overlay = document.getElementById("share-scenario-overlay");
    if (overlay) {
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) shareDialogClose();
      });
    }
    var sendBtn = document.getElementById("share-scenario-send-btn");
    if (sendBtn) sendBtn.addEventListener("click", shareDialogHandleSend);
    var pdfBtn = document.getElementById("share-scenario-pdf-btn");
    if (pdfBtn) pdfBtn.addEventListener("click", shareDialogHandlePdf);
    /* Live preview updates as the user types. */
    ["share-scenario-title-input",
     "share-scenario-comments-input",
     "share-scenario-district-input"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", shareDialogRefreshPreview);
      el.addEventListener("change", shareDialogRefreshPreview);
    });
  })();

  /* Try to apply any `#share=...` payload from the URL once the dashboard
     view is visible. The check is deferred so that the data fetches in the
     main Promise.all have a chance to populate MASTER_BY_MSID and the
     dropdown options. We also re-check on hashchange, in case a recipient
     opens a link after the page is already loaded. */
  function tryApplyShareStateFromUrl() {
    var hash = window.location.hash || "";
    if (!hash) return false;
    var m = hash.match(new RegExp("(?:^#|&)" + SHARE_HASH_KEY + "=([^&]+)"));
    if (!m) return false;
    var payload = shareDecodeB64Url(m[1]);
    if (!payload) return false;
    /* Best-effort: only proceed once the school dropdown is populated. */
    var sel = document.getElementById("scenario-school-select");
    var schoolOptionsReady = sel && sel.options && sel.options.length > 1;
    if (!schoolOptionsReady && (!payload.bs || !payload.bs.length)) {
      /* Sandbox-only payload can apply without master CSV; scenario needs it. */
      if (payload.k === "s") return false;
    }
    /* Navigate to the Scenario Planning top-tab if not already there. */
    var topTab = document.querySelector('.page-journey__btn[data-page="scenario"]') ||
      document.getElementById("page-tab-scenario");
    var pageScenario = document.getElementById("page-scenario");
    if (topTab && typeof topTab.click === "function" && (!pageScenario || pageScenario.hidden)) {
      try { topTab.click(); } catch (eT) { /* ignore */ }
    }
    if (payload.k === "b") return applySandboxSharePayload(payload);
    if (payload.k === "s") return applyScenarioSharePayload(payload);
    return false;
  }

  function scheduleApplyShareStateFromUrl() {
    /* Poll for ~60s after page load to give the password gate, welcome
       tutorial, and Promise.all data fetches time to populate the school
       dropdown. After that we stop trying — a manual hashchange will still
       trigger another attempt. */
    var attempts = 0;
    var maxAttempts = 240; /* 240 * 250ms = 60s */
    function tick() {
      attempts++;
      if (tryApplyShareStateFromUrl()) return;
      if (attempts >= maxAttempts) return;
      setTimeout(tick, 250);
    }
    setTimeout(tick, 600);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scheduleApplyShareStateFromUrl);
  } else {
    scheduleApplyShareStateFromUrl();
  }
  window.addEventListener("hashchange", tryApplyShareStateFromUrl);

})();
