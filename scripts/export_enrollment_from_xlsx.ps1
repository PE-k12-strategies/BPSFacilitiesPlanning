# Reads Brevard projected enrollment workbook and writes data/processed/enrollment.json
# Requires Excel installed (COM). Example:
#   .\export_enrollment_from_xlsx.ps1 -SourcePath 'C:\path\to\5-A_25-26...xlsx'

param(
  [string] $SourcePath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of the projected enrollment workbook."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\enrollment.json"

function Parse-CellNumber([string] $t) {
  if ([string]::IsNullOrWhiteSpace($t)) { return $null }
  $s = ($t -replace ",", "").Trim()
  if ($s -match "^-?[\d\.]+$") {
    $n = 0.0
    if ([double]::TryParse($s, [ref]$n)) { return [int][Math]::Round($n) }
  }
  return $null
}

# e.g. "82%" or "82" -> 82 (dashboard shows as percent)
function Parse-PercentNumber([string] $t) {
  if ([string]::IsNullOrWhiteSpace($t)) { return $null }
  $s = ($t -replace ",", "").Trim()
  if ($s -match "^([\d\.]+)\s*%$") {
    $n = 0.0
    if ([double]::TryParse($matches[1], [ref]$n)) { return [Math]::Round($n, 2) }
  }
  if ($s -match "^-?[\d\.]+$") {
    $n = 0.0
    if ([double]::TryParse($s, [ref]$n)) { return [Math]::Round($n, 2) }
  }
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

  # --- Sheet: school-year actual + projections ---
  $wsT = $wb.Sheets.Item("25-26to30-31Proj_Type-TotCap")
  $byMsid = @{}
  $lastRow = [int]$wsT.Cells($wsT.Rows.Count, 2).End(-4162).Row  # xlUp
  for ($r = 8; $r -le $lastRow; $r++) {
    $msidRaw = $wsT.Cells.Item($r, 2).Text
    if ([string]::IsNullOrWhiteSpace($msidRaw)) { continue }
    $msid = 0
    if (-not [int]::TryParse($msidRaw.Trim(), [ref]$msid)) { continue }
    if ($msid -le 0) { continue }

    $sy2526 = Parse-CellNumber($wsT.Cells.Item($r, 11).Text)
    # Col J (10): 2025-26 Factored Capacity; Col Q (17): 2025-26 Actual utilization %
    $factoredCap = Parse-CellNumber($wsT.Cells.Item($r, 10).Text)
    $utilPct = Parse-PercentNumber($wsT.Cells.Item($r, 17).Text)
    $p26 = Parse-CellNumber($wsT.Cells.Item($r, 12).Text)
    $p27 = Parse-CellNumber($wsT.Cells.Item($r, 13).Text)
    $p28 = Parse-CellNumber($wsT.Cells.Item($r, 14).Text)
    $p29 = Parse-CellNumber($wsT.Cells.Item($r, 15).Text)
    $p30 = Parse-CellNumber($wsT.Cells.Item($r, 16).Text)

    $byMsid["$msid"] = @{
      sy2526Actual           = $sy2526
      factoredCapacity202526 = $factoredCap
      utilization202526Pct   = $utilPct
      projected              = @($p26, $p27, $p28, $p29, $p30)
    }
  }

  # --- Sheet: membership by calendar year (row 6 headers). Each column year Y aligns with school year Y-(Y+1 mod 100). ---
  $wsH = $wb.Sheets.Item("01. ProjectionsPublish241217")
  $calendarByMsid = @{}
  $lastH = [int]$wsH.Cells($wsH.Rows.Count, 1).End(-4162).Row
  $yearCols = @()
  $cc = 3
  while ($true) {
    $ht = $wsH.Cells.Item(6, $cc).Text.Trim()
    if ($ht -match '^\d{4}$') {
      $yr = [int]$ht
      if ($yr -ge 2010 -and $yr -le 2035) {
        $yearCols += $yr
        $cc++
        continue
      }
    }
    break
  }
  for ($r = 8; $r -le $lastH; $r++) {
    $msidRaw = $wsH.Cells.Item($r, 1).Text
    if ([string]::IsNullOrWhiteSpace($msidRaw)) { continue }
    $msid = 0
    if (-not [int]::TryParse($msidRaw.Trim(), [ref]$msid)) { continue }
    if ($msid -le 0) { continue }

    $cal = @{}
    for ($i = 0; $i -lt $yearCols.Count; $i++) {
      $col = 3 + $i
      $v = Parse-CellNumber($wsH.Cells.Item($r, $col).Text)
      if ($null -ne $v) { $cal["$($yearCols[$i])"] = $v }
    }
    if ($cal.Count -gt 0) {
      $calendarByMsid["$msid"] = $cal
    }
  }

  $payload = [ordered]@{
    sourceFile = $SourcePath
    generated  = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    notes      = @(
      "Dashboard KPI enrollment uses the 2025 calendar column on sheet 01. ProjectionsPublish241217.",
      "Capacity (factored) and utilization (2025-26 actual %) from TotCap sheet cols J and Q.",
      "School-year projections 2026-27 through 2030-31 come from sheet 25-26to30-31Proj_Type-TotCap."
    )
    schoolYearLabels = @("2026-27", "2027-28", "2028-29", "2029-30", "2030-31")
    byMsid             = $byMsid
    calendarByMsid     = $calendarByMsid
  }

  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)

  Write-Host "Wrote $outPath ($($byMsid.Count) schools TotCap, $($calendarByMsid.Count) with calendar history)"
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
