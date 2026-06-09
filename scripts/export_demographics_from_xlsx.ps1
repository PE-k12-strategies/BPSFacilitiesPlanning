# Aggregates student SY2025-26 data into data/processed/demographics_by_msid.json
# Column A = Enrolled School ("MSID - Name"), H = Ethnicity, I = lunch_status (empty = not free/reduced).
param(
  [string] $SourcePath = ""
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of the SY2025-26 student workbook."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\demographics_by_msid.json"

function Get-MsidFromEnrolled([string] $s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  if ($s -match '^\s*(\d+)\s*-\s*') {
    return [int]$matches[1]
  }
  return $null
}

function Get-EthnicityLabel([string] $t) {
  $s = $t.Trim()
  if ([string]::IsNullOrWhiteSpace($s)) { return "Unknown" }
  return $s
}

function Get-LunchBucket([string] $t) {
  $s = $t.Trim()
  if ([string]::IsNullOrWhiteSpace($s)) { return "Not free/reduced" }
  $u = $s.ToUpperInvariant()
  if ($u -eq "FREE" -or $u.StartsWith("FREE ")) { return "Free" }
  if ($u -match "REDUC") { return "Reduced" }
  return $s
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
  $ws = $wb.Sheets.Item("Student251010wSA")
  $lastRow = [int]$ws.Cells($ws.Rows.Count, 1).End(-4162).Row
  if ($lastRow -lt 2) { Write-Error "No data rows found." }

  $rng = $ws.Range("A2:I$lastRow")
  $vals = $rng.Value2
  $n = $vals.GetLength(0)

  $byMsid = @{}

  for ($r = 1; $r -le $n; $r++) {
    $enrolled = $vals[$r, 1]
    if ($null -eq $enrolled) { continue }
    $msid = Get-MsidFromEnrolled([string]$enrolled)
    if ($null -eq $msid) { continue }

    $v8 = $vals[$r, 8]; $v9 = $vals[$r, 9]
    $eth = Get-EthnicityLabel($(if ($null -eq $v8) { "" } else { [string]$v8 }))
    $lunch = Get-LunchBucket($(if ($null -eq $v9) { "" } else { [string]$v9 }))

    $key = "$msid"
    if (-not $byMsid.ContainsKey($key)) {
      $byMsid[$key] = @{
        ethnicity   = @{}
        lunchStatus = @{}
      }
    }
    $slot = $byMsid[$key]
    if (-not $slot.ethnicity.ContainsKey($eth)) { $slot.ethnicity[$eth] = 0 }
    $slot.ethnicity[$eth] = [int]$slot.ethnicity[$eth] + 1
    if (-not $slot.lunchStatus.ContainsKey($lunch)) { $slot.lunchStatus[$lunch] = 0 }
    $slot.lunchStatus[$lunch] = [int]$slot.lunchStatus[$lunch] + 1
  }

  function ConvertTo-SerializableHash($h) {
    $o = @{}
    foreach ($k in $h.Keys) { $o[$k] = $h[$k] }
    return $o
  }

  $outByMsid = @{}
  foreach ($k in $byMsid.Keys) {
    $outByMsid[$k] = @{
      ethnicity   = ConvertTo-SerializableHash $byMsid[$k].ethnicity
      lunchStatus = ConvertTo-SerializableHash $byMsid[$k].lunchStatus
    }
  }

  $payload = [ordered]@{
    sourceFile = $SourcePath
    generated  = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    notes      = @(
      "Per MSID from column A (leading digits before ' - '). Ethnicity col H, lunch col I; blank lunch = Not free/reduced.",
      "Sheet: Student251010wSA. Row count: $(($lastRow - 1))"
    )
    byMsid = $outByMsid
  }

  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)

  Write-Host "Wrote $outPath ($($outByMsid.Count) school MSIDs)"
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
