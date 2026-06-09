# Computes Meadowlane Primary (2041) and Intermediate (2031) capture numerators/denominators
# from row-level SY2025-26 student data, then writes data/processed/meadowlane_capture_override.json
#
# Logic (same as dashboard spec):
#   2041: K-2 attending 2041 / K-2 zoned to 2041 (column V = ELEM_MSID).
#   2031: grades 3-6 attending 2031 / grades 3-6 zoned to Primary 2041 only (ELEM_MSID); denominator never uses 2031.
# PK / Pre-K rows are excluded from K-2 and 3-6 buckets (not counted in either numerator or denominator).
# Grades K (and KG/KN/IN), 1, 2 -> K-2 bucket. Grades 3-6 -> 3-6 bucket.
#
# Columns match export_capture_from_xlsx.ps1: A = enrolled MSID, V(22)=ELEM, W(23)=MID, Y(25)=HIGH, grade auto-detected.
#
# Requires: Excel installed (COM). Example:
#   .\export_meadowlane_capture_from_xlsx.ps1 -SourcePath 'C:\data\SY2025-26_StuData....xlsx'

param(
  [string] $SourcePath = "",
  [int] $GradeColumn = 0,
  [string] $SheetName = "Student251010wSA"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of the SY2025-26 student workbook."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\meadowlane_capture_override.json"

function Get-MsidFromCell([string] $s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $t = [string]$s
  if ($t -match '^\s*(\d+)\s*-\s*') { return [int]$matches[1] }
  if ($t -match '^\s*(\d+)\s*$') { return [int]$matches[1] }
  return $null
}

function Get-GradeLevel([string] $raw) {
  if ($null -eq $raw) { return $null }
  $s = $raw.Trim().ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  if ($s -match '^(PK|PREK|PRE-K|VPK|EE|ELP)$') { return 'elementary' }
  if ($s -match '^(K|KG|KN|IN)$') { return 'elementary' }
  $n = $null
  if ([int]::TryParse($s, [ref]$n)) {
    if ($n -le 6) { return 'elementary' }
    if ($n -le 8) { return 'middle' }
    if ($n -le 12) { return 'high' }
    return $null
  }
  try {
    $d = [double]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture)
    $ni = [int][Math]::Floor($d)
    if ($ni -le 6) { return 'elementary' }
    if ($ni -le 8) { return 'middle' }
    if ($ni -le 12) { return 'high' }
  }
  catch { }
  return $null
}

# K-2 vs 3-6 within elementary; PK etc. -> $null (excluded from Meadowlane grade-band capture).
function Get-MeadowlaneElemSubBand([string] $raw) {
  if ($null -eq $raw) { return $null }
  $s = $raw.Trim().ToUpperInvariant()
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  if ($s -match '^(PK|PREK|PRE-K|VPK|EE|ELP)$') { return $null }
  if ($s -match '^(K|KG|KN|IN)$') { return 'k2' }
  $n = $null
  if ([int]::TryParse($s, [ref]$n)) {
    if ($n -eq 0) { return 'k2' }
    if ($n -eq 1 -or $n -eq 2) { return 'k2' }
    if ($n -ge 3 -and $n -le 6) { return 'g36' }
    return $null
  }
  try {
    $d = [double]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture)
    $ni = [int][Math]::Floor($d)
    if ($ni -eq 0) { return 'k2' }
    if ($ni -eq 1 -or $ni -eq 2) { return 'k2' }
    if ($ni -ge 3 -and $ni -le 6) { return 'g36' }
  }
  catch { }
  return $null
}

if (-not (Test-Path -LiteralPath $SourcePath)) {
  Write-Error "Source file not found: $SourcePath"
}

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $null

try {
  $wb = $excel.Workbooks.Open($SourcePath)
  $ws = $wb.Sheets.Item($SheetName)
  $lastRow = [int]$ws.Cells($ws.Rows.Count, 1).End(-4162).Row
  if ($lastRow -lt 2) { Write-Error "No data rows found." }

  $gc = $GradeColumn
  if ($gc -lt 1) {
    $gc = 0
    for ($c = 1; $c -le 30; $c++) {
      $h = [string]$ws.Cells(1, $c).Text
      if ([string]::IsNullOrWhiteSpace($h)) { continue }
      $hu = $h.Trim().ToUpperInvariant()
      if ($hu -match 'GRADE|GRD|GR\s*LVL|INSTR\s*GR|CURRENT\s*GR') {
        $gc = $c
        break
      }
    }
    if ($gc -lt 1) {
      Write-Error "Could not find Grade column in row 1. Pass -GradeColumn N."
    }
  }

  $maxCol = [Math]::Max(25, $gc)
  $topLeft = $ws.Cells(2, 1)
  $botRight = $ws.Cells($lastRow, $maxCol)
  $rng = $ws.Range($topLeft, $botRight)
  $vals = $rng.Value2
  $nrows = $vals.GetLength(0)

  $n2041_k2 = 0
  $d2041_k2 = 0
  $n2031_g36 = 0
  $d2041_g36 = 0
  $zoned2031AnyColumn = 0

  for ($r = 1; $r -le $nrows; $r++) {
    $vV = if ($maxCol -ge 22) { $vals[$r, 22] } else { $null }
    $vW = if ($maxCol -ge 23) { $vals[$r, 23] } else { $null }
    $vY = if ($maxCol -ge 25) { $vals[$r, 25] } else { $null }
    $zV = if ($null -ne $vV) { Get-MsidFromCell ([string]$vV) } else { $null }
    $zW = if ($null -ne $vW) { Get-MsidFromCell ([string]$vW) } else { $null }
    $zY = if ($null -ne $vY) { Get-MsidFromCell ([string]$vY) } else { $null }
    if ($zV -eq 2031 -or $zW -eq 2031 -or $zY -eq 2031) {
      $zoned2031AnyColumn++
    }

    $vGrade = $vals[$r, $gc]
    $gStr = if ($null -eq $vGrade) { "" } else { [string]$vGrade }
    $lvl = Get-GradeLevel $gStr
    if ($lvl -ne 'elementary') { continue }

    $sub = Get-MeadowlaneElemSubBand $gStr
    if ($null -eq $sub) { continue }

    $vA = $vals[$r, 1]
    if ($null -eq $vA) { continue }
    $enrolled = Get-MsidFromCell ([string]$vA)
    if ($null -eq $enrolled) { continue }

    $elemZoned = $zV

    if ($sub -eq 'k2') {
      if ($enrolled -eq 2041) { $n2041_k2++ }
      if ($null -ne $elemZoned -and $elemZoned -eq 2041) { $d2041_k2++ }
    }
    if ($sub -eq 'g36') {
      if ($enrolled -eq 2031) { $n2031_g36++ }
      if ($null -ne $elemZoned -and $elemZoned -eq 2041) { $d2041_g36++ }
    }
  }

  $payload = [ordered]@{
    schoolYear = "2025-26"
    notes      = @(
      "Computed by scripts/export_meadowlane_capture_from_xlsx.ps1 from row-level student data.",
      "2041: K-2 attending / K-2 zoned to 2041 (ELEM_MSID). PK excluded from K-2 bucket.",
      "2031: grades 3-6 attending 2031 / grades 3-6 with ELEM_MSID 2041. Denominator does not use 2031.",
      "Source: $SourcePath ; rows scanned: $nrows ; grade column: $gc"
    )
    "2041"     = [ordered]@{
      numerator                     = $n2041_k2
      denominator                   = $d2041_k2
      fallback_capture_rate_decimal = $null
      description                   = "K-2 attending Meadowlane Primary / K-2 zoned to Meadowlane Primary (2041)."
    }
    "2031"     = [ordered]@{
      numerator                     = $n2031_g36
      denominator                   = $d2041_g36
      denominator_zoned_elem_msid   = 2041
      fallback_capture_rate_decimal = $null
      description                   = "Grades 3-6 attending Meadowlane Intermediate / grades 3-6 zoned to Meadowlane Primary (2041)."
    }
    zoning_audit = [ordered]@{
      student_count_with_zoned_msid_2031_in_any_column = $zoned2031AnyColumn
      comment                                          = "Counts all data rows where ELEM (col V), MID (W), or HIGH (Y) parses to MSID 2031. Expect 0."
    }
  }

  $json = $payload | ConvertTo-Json -Depth 6
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)

  Write-Host "Wrote $outPath"
  Write-Host "  2041 K-2: numerator=$n2041_k2 denominator=$d2041_k2"
  Write-Host "  2031 3-6: numerator=$n2031_g36 denominator=$d2041_g36 (zoned ELEM 2041)"
  Write-Host "  Zoning audit (2031 in V/W/Y): $zoned2031AnyColumn"
}
finally {
  if ($null -ne $wb) {
    $wb.Close($false)
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($wb) | Out-Null
  }
  $excel.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
  [GC]::Collect()
}
