# install_bridge_service.ps1 — Register a per-provider Chrome instance as a
# Windows service so its CDP debug port is up at boot. CBE attaches to that
# port instead of spawning its own Chrome each launch. Cookies persist across
# reboots in the dedicated --user-data-dir.
#
# Usage (invoked from extension.js via Start-Process -Verb RunAs):
#   powershell -ExecutionPolicy Bypass -File install_bridge_service.ps1
#     -Provider grokWeb
#     -Port 9277
#     -ProfileDir 'C:\Users\<u>\AppData\Roaming\Code\User\globalStorage\trentontompkins.codex-black-ed\web-profiles\grokWeb'
#     -ChromeExe 'C:\Program Files\Google\Chrome\Application\chrome.exe'
#     -NssmExe 'C:\path\to\extension\tools\nssm.exe'

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$Provider,
    [Parameter(Mandatory=$true)] [int]$Port,
    [Parameter(Mandatory=$true)] [string]$ProfileDir,
    [Parameter(Mandatory=$true)] [string]$ChromeExe,
    [Parameter(Mandatory=$true)] [string]$NssmExe,
    [Parameter(Mandatory=$false)] [string]$ServicePrefix = 'CBE-Bridge-'
)

$ErrorActionPreference = 'Stop'
$ServiceName = "$ServicePrefix$Provider"

function Fail($msg) {
    Write-Host "[install_bridge_service] ERROR: $msg" -ForegroundColor Red
    exit 2
}

# --- preflight ---
if (-not (Test-Path $ChromeExe)) { Fail "Chrome not found at $ChromeExe" }
if (-not (Test-Path $NssmExe))   { Fail "nssm.exe not found at $NssmExe (ship one with the extension under tools\nssm.exe)" }
if (-not (Test-Path $ProfileDir)) {
    New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
}

# Admin check — installing services requires elevation.
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "This script needs to run elevated (Administrator). Right-click → Run as administrator, or let CBE re-invoke it with -Verb RunAs."
}

Write-Host "[install_bridge_service] provider=$Provider port=$Port service=$ServiceName"
Write-Host "[install_bridge_service] profile=$ProfileDir"
Write-Host "[install_bridge_service] chrome=$ChromeExe"

# If a previous version of this service exists, replace it cleanly.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[install_bridge_service] existing service detected — stopping + removing"
    try { & $NssmExe stop $ServiceName confirm 2>$null | Out-Null } catch {}
    & $NssmExe remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
}

# Chrome args. --headless=new keeps the debug port open without painting any
# window (the user won't see anything; CBE drives the page via CDP). The
# user-data-dir is per-provider so each service keeps its own cookies.
# --remote-debugging-address=127.0.0.1 makes Chrome refuse remote attaches.
# --disable-gpu avoids software-rasterizer warnings under headless on Windows.
$ChromeArgs = @(
    "--headless=new",
    "--remote-debugging-port=$Port",
    "--remote-debugging-address=127.0.0.1",
    "--user-data-dir=`"$ProfileDir`"",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-features=msEdgeNewTabPage,EdgeShoppingAssistant",
    "--password-store=basic",
    "about:blank"
) -join ' '

# nssm install + configure. AppExit=Restart so a Chrome crash is self-healing.
# AppStdout/AppStderr roll into a log so we can debug without attaching.
$LogDir = Join-Path $env:ProgramData 'cbe-bridge-services'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogOut = Join-Path $LogDir "$ServiceName.stdout.log"
$LogErr = Join-Path $LogDir "$ServiceName.stderr.log"

& $NssmExe install   $ServiceName "$ChromeExe" | Out-Null
& $NssmExe set       $ServiceName AppParameters "$ChromeArgs" | Out-Null
& $NssmExe set       $ServiceName AppDirectory "$ProfileDir" | Out-Null
& $NssmExe set       $ServiceName DisplayName "CBE Bridge ($Provider) — Chrome :$Port" | Out-Null
& $NssmExe set       $ServiceName Description "Headless Chrome maintained by Claude Codex Black for the $Provider web-bridge provider. Debug port: 127.0.0.1:$Port. Profile: $ProfileDir" | Out-Null
& $NssmExe set       $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmExe set       $ServiceName AppStdout "$LogOut" | Out-Null
& $NssmExe set       $ServiceName AppStderr "$LogErr" | Out-Null
& $NssmExe set       $ServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set       $ServiceName AppRotateBytes 10485760 | Out-Null
& $NssmExe set       $ServiceName AppExit Default Restart | Out-Null
& $NssmExe set       $ServiceName AppRestartDelay 2000 | Out-Null

# Start the service. Wait briefly for the debug port to come up.
Write-Host "[install_bridge_service] starting service"
& $NssmExe start $ServiceName | Out-Null

$deadline = (Get-Date).AddSeconds(20)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 500
}

if ($ready) {
    Write-Host "[install_bridge_service] OK — service running, CDP listening on 127.0.0.1:$Port"
    Write-Host "[install_bridge_service] DONE"
    exit 0
} else {
    Write-Host "[install_bridge_service] WARN — service installed and started, but CDP didn't answer on 127.0.0.1:$Port within 20s" -ForegroundColor Yellow
    Write-Host "[install_bridge_service] Check $LogErr for Chrome stderr."
    exit 1
}
