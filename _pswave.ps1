$ErrorActionPreference = 'Stop'
$f   = Join-Path $env:APPDATA 'EQuake\config\Settings.ini'
$bak = $f + '.bak'

if(-not (Test-Path $f)){
  Write-Host 'CONFIG NOT FOUND: ' + $f
  Write-Host 'FAILED'
  exit 1
}

$ps = Get-Process -Name *quake* -ErrorAction SilentlyContinue
if($ps.Count -gt 0){
  Write-Host 'WARNING: EQuake is still running. Exit it, then run this again.'
}

$mode = 'wave'
if($args.Count -gt 0){ $mode = $args[0] }

# wave   : hide only the P/S wave fronts of the estimated epicenter
# full   : also disable epicenter estimation + the detection grid (no wave front at all)
# show   : restore the default behavior
$targets = @{}
if($mode -eq 'show'){
  $targets = @{
    'IsHidePSWaveOfEstimatedEpicenter' = 'false'
    'IsDisplayGridOnDetection'         = 'true'
    'IsEpiCenterCalculationEnabled'    = 'true'
  }
} elseif($mode -eq 'full'){
  $targets = @{
    'IsHidePSWaveOfEstimatedEpicenter' = 'true'
    'IsDisplayGridOnDetection'         = 'false'
    'IsEpiCenterCalculationEnabled'    = 'false'
  }
} else {
  $targets = @{
    'IsHidePSWaveOfEstimatedEpicenter' = 'true'
  }
}

if(-not (Test-Path $bak)){ Copy-Item $f $bak -Force; Write-Host 'BACKUP CREATED' }

$lines = [System.IO.File]::ReadAllLines($f)
$out   = New-Object System.Collections.Generic.List[string]
$done  = @{}
$changed = 0

foreach($l in $lines){
  if($l -match '^\[(.+)\]$'){ $out.Add($l); continue }
  $m = [regex]::Match($l, '^\s*([A-Za-z0-9_]+)\s*=(.*)$')
  if($m.Success -and $targets.ContainsKey($m.Groups[1].Value)){
    $k = $m.Groups[1].Value
    $out.Add($k + '=' + $targets[$k])
    $done[$k] = $true
    $changed++
  } else { $out.Add($l) }
}

$tail = $out.Count
for($i = $out.Count - 1; $i -ge 0; $i--){
  if($out[$i] -match '^\[Settings\]$'){ $tail = $i + 1; break }
}
foreach($k in $targets.Keys){
  if(-not $done.ContainsKey($k)){ $out.Insert($tail, $k + '=' + $targets[$k]); $tail++ }
}

[System.IO.File]::WriteAllLines($f, $out)
Write-Host ('MODE=' + $mode)
foreach($k in $targets.Keys){
  Write-Host ('  {0}={1}' -f $k, $targets[$k])
}
Write-Host 'OK - Settings.ini patched. Restart EQuake now.'
