# Computes capture rate by MSID from SY2025-26 student data -> data/processed/capture_by_msid.json
#
# Numerator: students who attend the school (column A enrolled MSID), counted only in the grade band
#   matching that level (elementary / middle / high).
# Denominator: students zoned to that school — column V (ELEM_MSID), W (MID_MSID), or Y (HIGH_MSID) —
#   only rows in the matching grade band.
#
# Grade bands (Brevard K-6 elementary): PK–6 -> elementary, 7–8 -> middle, 9–12 -> high.
# Grade column: auto-detected from row 1 (header matches grade / grd / instr gr); override with -GradeColumn 4 for column D.
#
param(
  [string] $SourcePath = "",
  [int] $GradeColumn = 0,
  [string] $SheetName = "Student251010wSA"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SourcePath)) {
  Write-Error "Pass -SourcePath to your local copy of the SY2025-26 student workbook (e.g. ...\StuData....xlsx)."
}
$repoRoot = Split-Path -Parent $PSScriptRoot
$outPath = Join-Path $repoRoot "data\processed\capture_by_msid.json"

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

function Add-Count([hashtable]$h, [string]$key, [int]$delta) {
  if (-not $h.ContainsKey($key)) { $h[$key] = 0 }
  $h[$key] = [int]$h[$key] + $delta
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
      Write-Error "Could not find Grade column in row 1. Pass -GradeColumn N (e.g. 4 for column D)."
    }
  }

  $maxCol = [Math]::Max(25, $gc)
  $topLeft = $ws.Cells(2, 1)
  $botRight = $ws.Cells($lastRow, $maxCol)
  $rng = $ws.Range($topLeft, $botRight)
  $vals = $rng.Value2
  $nrows = $vals.GetLength(0)

  # Keys: "${msid}_elementary" | "_middle" | "_high" for numerators and denominators
  $num = @{}
  $den = @{}

  for ($r = 1; $r -le $nrows; $r++) {
    $vGrade = $vals[$r, $gc]
    $gStr = if ($null -eq $vGrade) { "" } else { [string]$vGrade }
    $lvl = Get-GradeLevel $gStr
    if ($null -eq $lvl) { continue }

    $vA = $vals[$r, 1]
    if ($null -eq $vA) { continue }
    $enrolled = Get-MsidFromCell ([string]$vA)
    if ($null -ne $enrolled) {
      Add-Count $num "${enrolled}_$lvl" 1
    }

    $vV = if ($maxCol -ge 22) { $vals[$r, 22] } else { $null }
    $vW = if ($maxCol -ge 23) { $vals[$r, 23] } else { $null }
    $vY = if ($maxCol -ge 25) { $vals[$r, 25] } else { $null }

    if ($lvl -eq 'elementary' -and $null -ne $vV) {
      $z = Get-MsidFromCell ([string]$vV)
      if ($null -ne $z) { Add-Count $den "${z}_elementary" 1 }
    }
    elseif ($lvl -eq 'middle' -and $null -ne $vW) {
      $z = Get-MsidFromCell ([string]$vW)
      if ($null -ne $z) { Add-Count $den "${z}_middle" 1 }
    }
    elseif ($lvl -eq 'high' -and $null -ne $vY) {
      $z = Get-MsidFromCell ([string]$vY)
      if ($null -ne $z) { Add-Count $den "${z}_high" 1 }
    }
  }

  $allMsids = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($k in $num.Keys) {
    $ms = [int]($k -replace '_.*$', '')
    [void]$allMsids.Add($ms)
  }
  foreach ($k in $den.Keys) {
    $ms = [int]($k -replace '_.*$', '')
    [void]$allMsids.Add($ms)
  }

  function Get-Bucket([int]$msid, [string]$lvl) {
    $nk = "${msid}_${lvl}"
    $numerator = if ($num.ContainsKey($nk)) { [int]$num[$nk] } else { 0 }
    $denominator = if ($den.ContainsKey($nk)) { [int]$den[$nk] } else { 0 }
    $pct = $null
    if ($denominator -gt 0) {
      $pct = [Math]::Round(100.0 * $numerator / $denominator, 2)
    }
    return @{
      numerator     = $numerator
      denominator   = $denominator
      captureRatePct  = $pct
    }
  }

  $outByMsid = @{}
  foreach ($ms in $allMsids) {
    $outByMsid["$ms"] = [ordered]@{
      elementary = Get-Bucket $ms 'elementary'
      middle     = Get-Bucket $ms 'middle'
      high       = Get-Bucket $ms 'high'
    }
  }

  $payload = [ordered]@{
    sourceFile   = $SourcePath
    generated    = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    gradeColumn  = $gc
    gradeBands   = @(
      "elementary: PK through grade 6 (inclusive)",
      "middle: grades 7-8",
      "high: grades 9-12"
    )
    notes        = @(
      "Numerator: count of rows where column A enrolled MSID matches school, by grade band.",
      "Denominator: count where zoned MSID matches: V=ELEM_MSID (elem), W=MID_MSID (mid), Y=HIGH_MSID (high), same grade band.",
      "Sheet: $SheetName. Rows scanned: $($nrows)."
    )
    byMsid       = $outByMsid
  }

  $json = $payload | ConvertTo-Json -Depth 8 -Compress
  $dir = Split-Path -Parent $outPath
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($outPath, $json)

  Write-Host "Wrote $outPath ($($outByMsid.Count) MSIDs, grade column $gc)"
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
