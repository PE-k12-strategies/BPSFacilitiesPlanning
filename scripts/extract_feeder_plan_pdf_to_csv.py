"""One-off / repeatable: PDF table -> CSV with cell text preserved (multiline retained)."""

from pathlib import Path

import csv
import pdfplumber

PDF_DEFAULT = (
    r"P:\0109260\Planning\WorkingFiles\00_To Be Sorted"
    r"\K-12 Feeder Plan 2026-2027 - Revised 4.7.2026.pdf"
)
ROOT = Path(__file__).resolve().parent.parent
CSV_DEFAULT = ROOT / "data" / "sourcedocs" / "k12_feeder_plan_2026_2027_revised_2026_04_07.csv"

NUM_COLS = 9


def norm_row(row):
    row = list(row or [])
    row = [("" if c is None else str(c)) for c in row]
    while len(row) < NUM_COLS:
        row.append("")
    return row[:NUM_COLS]


def is_title_row(row):
    r = norm_row(row)
    return r[0].strip().startswith("2026-2027 K-12 Feeder Plan") and not any(
        x.strip() for x in r[1:]
    )


def is_header_row(row):
    return norm_row(row)[0].strip() == "School"


def is_continuation_row(row):
    """PDF split one logical row across two lines (orphan fragment row)."""
    r = norm_row(row)
    if r[0].strip():
        return False
    nonempty = sum(1 for x in r if x.strip())
    return 1 <= nonempty <= 4


def merge_continuation(rows):
    out = []
    i = 0
    while i < len(rows):
        cur = norm_row(rows[i])
        if i + 1 < len(rows) and is_continuation_row(rows[i + 1]):
            nxt = norm_row(rows[i + 1])
            for j in range(NUM_COLS):
                if nxt[j].strip():
                    if cur[j].strip():
                        cur[j] = cur[j].rstrip() + "\n" + nxt[j].strip()
                    else:
                        cur[j] = nxt[j].strip()
            out.append(cur)
            i += 2
            continue
        out.append(cur)
        i += 1
    return out


def main():
    import sys

    pdf_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(PDF_DEFAULT)
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else CSV_DEFAULT
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rows_out = []
    header = None

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            tabs = page.extract_tables()
            if not tabs:
                continue
            tab = tabs[0]
            for row in tab:
                if is_title_row(row):
                    continue
                if is_header_row(row):
                    if header is None:
                        header = norm_row(row)
                    continue
                rows_out.append(row)

    rows_out = merge_continuation(rows_out)

    if header is None:
        raise SystemExit("No header row found in PDF")

    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(["document_title"])
        w.writerow(
            ["2026-2027 K-12 Feeder Plan (Revised 4.7.2026) — extracted from district PDF"]
        )
        w.writerow([])
        w.writerow(header)
        for row in rows_out:
            w.writerow(norm_row(row))

    print("Wrote", out_path)
    print("Data rows", len(rows_out))


if __name__ == "__main__":
    main()
