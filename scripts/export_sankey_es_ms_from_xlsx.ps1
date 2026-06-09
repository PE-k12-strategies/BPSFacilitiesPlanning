# Reads SankeyFlowHelper.xlsx -> data/processed/sankey_es_ms.json
#
# Block 1 (ES-MS): Row 1 = middle school column headers; column A rows 3..54 = elementary sources.
# Block 2 (MS-HS): Row 57 = high school column headers; column A rows 59..73 = middle sources.
# Skips Grand Total rows/columns.
#
param(
  [string] $SourcePath = "",
  [string] $SheetName = "Sheet1",
    [int] $EsMsFirstRow = 3,
    [int] $EsMsLastRow = 54,
    [int] $MsHsHeaderRow = 57,
    [int] $MsHsFirstRow = 59,
    [int] $MsHsLastRow = 73
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of SankeyFlowHelper.xlsx."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\sankey_es_ms.json"

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
  $ur = $ws.UsedRange
  $c1 = [int]$ur.Column
  $cN = [int]$ur.Column + [int]$ur.Columns.Count - 1

  # --- ES -> MS (row 1 headers) ---
  $middleCols = New-Object System.Collections.Generic.List[int]
  $msHeaders = @{}
  for ($c = $c1; $c -le $cN; $c++) {
    $h = [string]$ws.Cells(1, $c).Text
    $ht = $h.Trim()
    if ([string]::IsNullOrWhiteSpace($ht)) { continue }
    if ($ht -eq "Row Labels") { continue }
    if ($ht -eq "Grand Total") { continue }
    [void]$middleCols.Add($c)
    $msHeaders[$c] = $ht
  }

  $flows = New-Object System.Collections.Generic.List[hashtable]
  for ($r = $EsMsFirstRow; $r -le $EsMsLastRow; $r++) {
    $es = [string]$ws.Cells($r, 1).Text
    $es = $es.Trim()
    if ([string]::IsNullOrWhiteSpace($es)) { continue }
    if ($es.Trim().ToUpperInvariant() -eq "GRAND TOTAL") { continue }

    foreach ($c in $middleCols) {
      $raw = $ws.Cells($r, $c).Value2
      if ($null -eq $raw) { continue }
      $n = 0
      if (-not [double]::TryParse([string]$raw, [ref]$n)) { continue }
      $cnt = [int][Math]::Round([double]$raw)
      if ($cnt -le 0) { continue }
      $msName = $msHeaders[$c]
      if ([string]::IsNullOrWhiteSpace($msName)) { continue }
      [void]$flows.Add(@{
          elementary = $es
          middle       = $msName
          value        = $cnt
        })
    }
  }

  # --- MS -> HS (row 57 headers) ---
  $highCols = New-Object System.Collections.Generic.List[int]
  $hsHeaders = @{}
  for ($c = $c1; $c -le $cN; $c++) {
    $h = [string]$ws.Cells($MsHsHeaderRow, $c).Text
    $ht = $h.Trim()
    if ([string]::IsNullOrWhiteSpace($ht)) { continue }
    if ($ht -eq "Row Labels") { continue }
    if ($ht -eq "Grand Total") { continue }
    [void]$highCols.Add($c)
    $hsHeaders[$c] = $ht
  }

  $msHsFlows = New-Object System.Collections.Generic.List[hashtable]
  for ($r = $MsHsFirstRow; $r -le $MsHsLastRow; $r++) {
    $mid = [string]$ws.Cells($r, 1).Text
    $mid = $mid.Trim()
    if ([string]::IsNullOrWhiteSpace($mid)) { continue }
    if ($mid.Trim().ToUpperInvariant() -eq "GRAND TOTAL") { continue }

    foreach ($c in $highCols) {
      $raw = $ws.Cells($r, $c).Value2
      if ($null -eq $raw) { continue }
      $n = 0
      if (-not [double]::TryParse([string]$raw, [ref]$n)) { continue }
      $cnt = [int][Math]::Round([double]$raw)
      if ($cnt -le 0) { continue }
      $hsName = $hsHeaders[$c]
      if ([string]::IsNullOrWhiteSpace($hsName)) { continue }
      [void]$msHsFlows.Add(@{
          middle = $mid
          high   = $hsName
          value  = $cnt
        })
    }
  }

  $payload = [ordered]@{
    sourceFile  = $SourcePath
    generated   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    notes       = @(
      "flows: ES->MS (row 1 = middle schools, col A rows ${EsMsFirstRow}-${EsMsLastRow} = elementaries).",
      "msHsFlows: MS->HS (row $MsHsHeaderRow = high schools, col A rows ${MsHsFirstRow}-${MsHsLastRow} = middles). Counts differ by grade transition.",
      "Sheet: $SheetName"
    )
    flows       = @($flows.ToArray())
    msHsFlows   = @($msHsFlows.ToArray())
  }

  $json = $payload | ConvertTo-Json -Depth 6 -Compress
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)

  Write-Host "Wrote $outPath (ES-MS: $($flows.Count), MS-HS: $($msHsFlows.Count))"
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
