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
  Write-Host 'WARNING: EQuake is still running. Exit it before applying the fix.'
}

$mode = 'fix'
if($args.Count -gt 0){ $mode = $args[0] }

if($mode -eq 'restore'){
  if(Test-Path $bak){
    Copy-Item $bak $f -Force
    Write-Host 'RESTORED original settings from Settings.ini.bak'
    Write-Host 'OK'
  } else {
    Write-Host 'NO BACKUP FILE FOUND - nothing to restore'
  }
  exit 0
}

if(-not (Test-Path $bak)){ Copy-Item $f $bak -Force; Write-Host 'BACKUP CREATED: ' + $bak }

# key = new value. fix = safe rendering + no auto fullscreen report + auto restart on fatal error.
$targets = @{
  'IsD2DEnabled'                   = 'false'   # disable D2D hardware rendering (blank-window cause)
  'IsAggressiveOptimizationEnabled' = 'false'  # disable aggressive frame optimization
  'IsDrawUIAtomically'             = 'false'
  'IsAutoDisplayReport'            = 'false'   # stop the auto fullscreen popup that hides the main window
  'IsAutoRestartOnFatalErrors'     = 'true'    # auto restart when a fatal UI error happens
  'IsIgnoreWarnLogs'               = 'false'
  'IsDebugModeEnabled'             = 'true'
}

$lines = [System.IO.File]::ReadAllLines($f)
$out   = New-Object System.Collections.Generic.List[string]
$curSect = ''
$done = @{}
$changed = 0
$added = 0

foreach($l in $lines){
  if($l -match '^\[(.+)\]$'){ $curSect = $Matches[1]; $out.Add($l); continue }
  $m = [regex]::Match($l, '^\s*([A-Za-z0-9_]+)\s*=(.*)$')
  if($m.Success -and $targets.ContainsKey($m.Groups[1].Value)){
    $k = $m.Groups[1].Value
    $out.Add($k + '=' + $targets[$k])
    $done[$k] = $true
    $changed++
  } else { $out.Add($l) }
}

# append missing keys into the [Settings] section
$tail = $out.Count
for($i = $out.Count - 1; $i -ge 0; $i--){
  if($out[$i] -match '^\[Settings\]$'){ $tail = $i + 1; break }
}
foreach($k in $targets.Keys){
  if(-not $done.ContainsKey($k)){ $out.Insert($tail, $k + '=' + $targets[$k]); $tail++; $added++ }
}

[System.IO.File]::WriteAllLines($f, $out)

foreach($k in $targets.Keys){
  $v = $targets[$k]
  $mark = if($done.ContainsKey($k)){ 'updated' } else { 'appended' }
  Write-Host ('{0}  {1}={2}' -f $mark, $k, $v)
}
Write-Host ('CHANGED={0} APPENDED={1}' -f $changed, $added)
Write-Host 'OK - Settings.ini patched. Restart EQuake now.'
