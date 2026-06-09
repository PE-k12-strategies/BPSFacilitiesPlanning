# Normalizes grades_served (Excel date leaks) and prefixes with ' so Excel opens as text.
$ErrorActionPreference = "Stop"
$base = Split-Path -Parent $PSScriptRoot
$csvPath = Join-Path $base "data\school_master.csv"

function Normalize-GradesServed([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { return "" }
  $t = $raw.Trim()
  if ($t.StartsWith("'")) { $t = $t.Substring(1).Trim() }
  $tl = $t.ToLowerInvariant()
  if ($tl -eq "12-sep") { return "9-12" }
  if ($tl -eq "12-jul") { return "7-12" }
  if ($tl -eq "8-jul") { return "7-8" }
  if ($tl -eq "6-apr") { return "4-6" }
  if ($tl -eq "6-mar") { return "3-6" }
  return $t
}

function Add-ExcelTextPrefix([string]$g) {
  if ([string]::IsNullOrWhiteSpace($g)) { return $g }
  if ($g.StartsWith("'")) { return $g }
  return "'" + $g
}

$rows = Import-Csv $csvPath
foreach ($r in $rows) {
  $n = Normalize-GradesServed $r.grades_served
  $r.grades_served = Add-ExcelTextPrefix $n
}

$rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8
Write-Host "Updated grades_served in $csvPath (normalized + Excel text prefix)."
