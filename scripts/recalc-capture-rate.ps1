# Legacy script: recalculated legacy capture_rate from student export + capture_by_msid.json.
# The dashboard now uses From-To capture columns from scripts/import_fromto_capture_rates.py.
# If school_master.csv already has assignment_capture_rate, this script exits without changes.

$ErrorActionPreference = "Stop"
# Project root = parent of scripts/
$base = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $base "data\school_master.csv"))) {
  $base = "C:\Users\d.perlo\OneDrive - Perkins Eastman Architects DPC\Brevard\K8 Exploration Dashboard"
}
$csvPath = Join-Path $base "data\school_master.csv"
$capPath = Join-Path $base "data\processed\capture_by_msid.json"

$probe = Import-Csv $csvPath | Select-Object -First 1
if ($probe.PSObject.Properties.Name -contains "assignment_capture_rate") {
  Write-Host "school_master.csv uses From-To capture columns; no action. Use: py -3 scripts/import_fromto_capture_rates.py"
  exit 0
}

$json = Get-Content $capPath -Raw | ConvertFrom-Json
$cap = $json.byMsid

function Get-ZonedDenominator {
  param($entry, [string]$lvl)
  if (-not $entry) { return $null }
  switch ($lvl) {
    "elementary" {
      $d = $entry.elementary.denominator
      if ($null -eq $d -or $d -eq "") { return $null }
      return [int]$d
    }
    "middle" {
      $d = $entry.middle.denominator
      if ($null -eq $d -or $d -eq "") { return $null }
      return [int]$d
    }
    "high" {
      $d = $entry.high.denominator
      if ($null -eq $d -or $d -eq "") { return $null }
      return [int]$d
    }
    "jr_sr_high" {
      $dm = $entry.middle.denominator
      $dh = $entry.high.denominator
      $sm = 0
      $sh = 0
      if ($null -ne $dm -and $dm -ne "") { $sm = [int]$dm }
      if ($null -ne $dh -and $dh -ne "") { $sh = [int]$dh }
      $s = $sm + $sh
      if ($s -le 0) { return $null }
      return $s
    }
    default { return $null }
  }
}

$rows = Import-Csv $csvPath
$updated = 0
$cleared = 0

foreach ($r in $rows) {
  if ($r.msid -eq "2031" -or $r.msid -eq "2041") { continue }
  $lvl = if ($r.school_level) { $r.school_level.Trim().ToLowerInvariant() } else { "" }
  $numStr = $r.sy2526_actual
  if ([string]::IsNullOrWhiteSpace($numStr)) {
    $r.capture_rate = ""
    $cleared++
    continue
  }
  try {
    $num = [double]::Parse($numStr, [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    $r.capture_rate = ""
    $cleared++
    continue
  }

  $entry = $cap.($r.msid)
  $den = Get-ZonedDenominator -entry $entry -lvl $lvl
  if ($null -eq $den -or $den -le 0) {
    $r.capture_rate = ""
    $cleared++
    continue
  }

  $rate = [math]::Round($num / $den, 4)
  $r.capture_rate = $rate.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  $updated++
}

$rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "capture_rate recalculated: $updated rows; cleared or skipped: $cleared"
