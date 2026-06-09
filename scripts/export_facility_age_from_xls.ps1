# Reads "Age of all Facilities 2026.xls" and writes data/processed/facility_age.json
# Sheet "SchoolAge2024": row 1 title, row 2 headers, data from row 3. No MSID column — keys are normalized NAME.
param(
  [string] $SourcePath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of the facility age workbook (.xls)."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\facility_age.json"

function Get-NameKey([string] $s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return "" }
  $t = $s.ToUpperInvariant() -replace '\.', ' ' -replace '/', ' ' -replace ',', ' ' -replace "'", ' '
  $t = ($t -replace '\s+', ' ').Trim()
  return $t
}

function Parse-IntOrNull([string] $t) {
  if ([string]::IsNullOrWhiteSpace($t)) { return $null }
  $s = ($t -replace ',', '').Trim()
  $n = 0
  if ([int]::TryParse($s, [ref]$n)) { return $n }
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
  $ws = $wb.Sheets.Item("SchoolAge2024")
  $lastRow = [int]$ws.Cells($ws.Rows.Count, 1).End(-4162).Row
  $byNameKey = @{}

  for ($r = 3; $r -le $lastRow; $r++) {
    $rawName = $ws.Cells.Item($r, 1).Text.Trim()
    if ([string]::IsNullOrWhiteSpace($rawName)) { continue }
    $key = Get-NameKey $rawName
    if ($key -eq "") { continue }

    $byNameKey[$key] = @{
      displayName              = $rawName
      yearPropertyPurchased    = Parse-IntOrNull($ws.Cells.Item($r, 3).Text)
      yearSchoolOpened         = Parse-IntOrNull($ws.Cells.Item($r, 4).Text)
      ageAsOf2026              = Parse-IntOrNull($ws.Cells.Item($r, 5).Text)
    }
  }

  $payload = [ordered]@{
    sourceFile = $SourcePath
    generated  = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    notes      = @(
      "Rows keyed by normalized school NAME (no MSID in source file). Match dashboard schools via NAME / CommonName.",
      "Age column is 'Age as of 2026'. 'Constructed' in the UI uses Year School Opened."
    )
    byNameKey = $byNameKey
  }

  $json = $payload | ConvertTo-Json -Depth 6 -Compress
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)
  Write-Host "Wrote $outPath ($($byNameKey.Count) facilities)"
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
