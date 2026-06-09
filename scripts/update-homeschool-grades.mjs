/**
 * Updates geo/HomeschoolStudentHexagons.geojson:
 * - Sets Grade from Birthdate for 2025-2026 (Sept 1, 2025 cutoff).
 * - Preserves Grade when already set (not NG).
 * - Drops features only when computing grade and age < 5.
 * - Born before Sept 1, 2006 → Grade "13".
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const GEO_PATH = path.join(ROOT, "geo", "HomeschoolStudentHexagons.geojson");

const REF = new Date(2025, 8, 1); // Sept 1, 2025 local
const BEFORE_GRADE_13 = new Date(2006, 8, 1); // Sept 1, 2006 — born strictly before this → grade 13

function ageAsOfSept12025(birthMs) {
  const b = new Date(birthMs);
  let age = REF.getFullYear() - b.getFullYear();
  const m = b.getMonth();
  const d = b.getDate();
  if (m > 8 || (m === 8 && d > 1)) age--;
  return age;
}

function formatGradeFromAge(age) {
  if (age === 5) return "KG";
  const n = Math.min(age - 5, 12);
  if (n <= 0) return null;
  return n < 10 ? `0${n}` : String(n);
}

function needsGradeComputation(grade) {
  if (grade == null) return true;
  const g = String(grade).trim();
  if (g === "") return true;
  return /^ng$/i.test(g);
}

function main() {
  const raw = fs.readFileSync(GEO_PATH, "utf8");
  const gj = JSON.parse(raw);
  const kept = [];
  let preserved = 0;
  let computed = 0;
  let droppedTooYoung = 0;
  let grade13 = 0;

  for (const f of gj.features) {
    const p = { ...f.properties };
    const birth = p.Birthdate;

    if (needsGradeComputation(p.Grade)) {
      if (typeof birth !== "number" || Number.isNaN(birth)) {
        throw new Error("Feature missing numeric Birthdate");
      }
      if (birth < BEFORE_GRADE_13.getTime()) {
        p.Grade = "13";
        grade13++;
      } else {
        const age = ageAsOfSept12025(birth);
        if (age < 5) {
          droppedTooYoung++;
          continue;
        }
        const g = formatGradeFromAge(age);
        if (g == null) {
          droppedTooYoung++;
          continue;
        }
        p.Grade = g;
        computed++;
      }
    } else {
      preserved++;
    }

    kept.push({ ...f, properties: p });
  }

  const out = { ...gj, features: kept };
  fs.writeFileSync(GEO_PATH, JSON.stringify(out), "utf8");

  console.log(JSON.stringify({
    inputFeatures: gj.features.length,
    outputFeatures: kept.length,
    preservedExistingGrade: preserved,
    computedFromBirthdate: computed,
    assignedGrade13: grade13,
    droppedYoungerThan5: droppedTooYoung,
    path: GEO_PATH,
  }, null, 2));
}

main();
