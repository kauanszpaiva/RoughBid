param(
  [string]$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
  [ValidateSet('upload', 'geometry', 'budget', 'automatic', 'photo-planar', 'all')][string]$Scenario = 'upload'
)
$ErrorActionPreference = 'Stop'
$fixtureRepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$fixtureTaskRoot = (Resolve-Path -LiteralPath (Join-Path $fixtureRepoRoot '..')).Path
$fixtureOutput = Join-Path $fixtureTaskRoot 'deliverables\offline-browser'
$fixtureProfile = Join-Path $fixtureTaskRoot ('offline-browser-profile-' + [guid]::NewGuid().ToString('N'))
$fixtureNode = (Get-Command node -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath $ChromePath -PathType Leaf)) { throw 'Chrome is required for this offline browser fixture.' }
foreach ($fixturePort in @(4187, 9317)) {
  if (Get-NetTCPConnection -State Listen -LocalPort $fixturePort -ErrorAction SilentlyContinue) { throw "Local port $fixturePort is occupied. No existing process will be stopped." }
}
New-Item -ItemType Directory -Path $fixtureOutput -Force | Out-Null
$fixtureServerProcess = $null
$fixtureChromeProcess = $null
try {
  $fixtureViteArgs = '"' + (Join-Path $fixtureRepoRoot 'node_modules\vite\bin\vite.js') + '" --config "' + (Join-Path $PSScriptRoot 'offline-browser-fixture.vite.ts') + '"'
  $fixtureServerProcess = Start-Process -FilePath $fixtureNode -ArgumentList $fixtureViteArgs -WorkingDirectory $fixtureRepoRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixtureOutput 'vite.stdout.log') -RedirectStandardError (Join-Path $fixtureOutput 'vite.stderr.log') -PassThru
  $fixtureChromeArgs = '--headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9317 "--user-data-dir=' + $fixtureProfile + '" --disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync --disable-default-apps --disable-extensions --no-first-run --no-default-browser-check "--host-resolver-rules=MAP * ~NOTFOUND,EXCLUDE localhost,EXCLUDE 127.0.0.1" about:blank'
  $fixtureChromeProcess = Start-Process -FilePath $ChromePath -ArgumentList $fixtureChromeArgs -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixtureOutput 'chrome.stdout.log') -RedirectStandardError (Join-Path $fixtureOutput 'chrome.stderr.log') -PassThru
  $fixtureReady = $false
  for ($fixtureAttempt = 0; $fixtureAttempt -lt 150; $fixtureAttempt++) {
    try {
      $null = Invoke-WebRequest -Uri 'http://127.0.0.1:4187/offline-browser-fixture.html' -TimeoutSec 1
      $null = Invoke-WebRequest -Uri 'http://127.0.0.1:9317/json/list' -TimeoutSec 1
      $fixtureReady = $true
      break
    } catch { Start-Sleep -Milliseconds 100 }
  }
  if (!$fixtureReady) { throw 'The isolated local fixture did not become ready.' }
  $fixtureScripts = switch ($Scenario) {
    'upload' { @('offline-browser-fixture.qa.mjs') }
    'geometry' { @('offline-browser-fixture.geometry-qa.mjs', 'offline-browser-fixture.capture.mjs') }
    'budget' { @('offline-browser-fixture.geometry-qa.mjs', 'offline-browser-fixture.budget-qa.mjs', 'offline-browser-fixture.capture.mjs') }
    'automatic' { @('offline-browser-fixture.automatic-qa.mjs', 'offline-browser-fixture.automatic-capture.mjs', 'offline-browser-fixture.photo-planar-qa.mjs', 'offline-browser-fixture.photo-planar-capture.mjs') }
    'photo-planar' { @('offline-browser-fixture.photo-planar-qa.mjs', 'offline-browser-fixture.photo-planar-capture.mjs') }
    'all' { @('offline-browser-fixture.qa.mjs', 'offline-browser-fixture.geometry-qa.mjs', 'offline-browser-fixture.budget-qa.mjs', 'offline-browser-fixture.capture.mjs') }
  }
  foreach ($fixtureScript in $fixtureScripts) {
    & $fixtureNode (Join-Path $PSScriptRoot $fixtureScript)
    if ($LASTEXITCODE -ne 0) { throw "Offline browser fixture failed in $fixtureScript. Read its report in $fixtureOutput." }
  }
} finally {
  # Only the processes started by this script are stopped; never the user's browser.
  foreach ($fixtureProcess in @($fixtureChromeProcess, $fixtureServerProcess)) {
    if ($fixtureProcess) { $fixtureProcess.Refresh(); if (!$fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -ErrorAction SilentlyContinue } }
  }
}
