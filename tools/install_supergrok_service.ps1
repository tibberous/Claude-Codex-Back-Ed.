# install_supergrok_service.ps1 — Register SuperGrok's resident bridge as a
# Windows service so it's warm + logged-in at boot. CBE then just connects to
# 127.0.0.1:<port> over TCP (SuperGrokBridge.ensureRunning() TCP-probes first
# and returns immediately when the service answers — no per-session spawn).
#
# This replaces the fragile "CBE spawns start.py --serve-bridge each session"
# path, which broke when the bare `python.exe` on PATH was a dead launcher
# shim, and left grok/gemini/claude chats hanging with no feedback.
#
# Usage (run elevated — installing a service needs Administrator):
#   powershell -ExecutionPolicy Bypass -File install_supergrok_service.ps1
#     -Target grok
#     -Port 8767
#     -SuperGrokRoot 'C:\SuperGrok'
#     -PythonExe 'py'
#     -NssmExe 'C:\path\to\extension\tools\nssm.exe'
#
# One service answers ONE target at a time (SuperGrok owns a single browser
# session). Install the service for whichever target you chat with most;
# re-run with a different -Target to switch.

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]  [ValidateSet('grok','chatgpt','gemini','claude')] [string]$Target,
    [Parameter(Mandatory=$false)] [int]$Port = 8767,
    [Parameter(Mandatory=$false)] [string]$SuperGrokRoot = 'C:\SuperGrok',
    [Parameter(Mandatory=$false)] [string]$PythonExe = 'py',
    [Parameter(Mandatory=$true)]  [string]$NssmExe,
    [Parameter(Mandatory=$false)] [string]$ServiceName = 'CBE-SuperGrok-Bridge'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[install_supergrok_service] ERROR: $msg" -ForegroundColor Red
    exit 2
}

# --- preflight ---
$startPy = Join-Path $SuperGrokRoot 'start.py'
if (-not (Test-Path $startPy)) { Fail "SuperGrok start.py not found at $startPy (pass -SuperGrokRoot)" }
if (-not (Test-Path $NssmExe)) { Fail "nssm.exe not found at $NssmExe (ship one with the extension under tools\nssm.exe)" }

# Resolve a python that actually runs — a dead launcher shim must not be
# baked into the service definition or it will crash-loop forever.
$resolvedPython = $null
foreach ($cand in @($PythonExe, 'py', 'python.exe', 'python3.exe', 'python')) {
    if (-not $cand) { continue }
    try {
        $v = & $cand --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$v" -match 'Python\s*3') { $resolvedPython = $cand; break }
    } catch {}
}
if (-not $resolvedPython) { Fail "No working Python 3 found (tried $PythonExe, py, python.exe, python3.exe, python)" }

# Admin check — installing services requires elevation.
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "This script needs to run elevated (Administrator). Right-click -> Run as administrator, or let CBE re-invoke it with -Verb RunAs."
}

Write-Host "[install_supergrok_service] target=$Target port=$Port service=$ServiceName"
Write-Host "[install_supergrok_service] root=$SuperGrokRoot"
Write-Host "[install_supergrok_service] python=$resolvedPython"

# Replace any previous version of this service cleanly.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[install_supergrok_service] existing service detected — stopping + removing"
    try { & $NssmExe stop $ServiceName confirm 2>$null | Out-Null } catch {}
    & $NssmExe remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
}

# start.py args. --offscreen keeps the QWebEngine window invisible;
# --no-stale-process-kill stops SuperGrok from killing its own service
# parent on relaunch. --bridge-port pins the TCP port CBE connects to.
$AppArgs = @(
    "`"$startPy`"",
    "--serve-bridge",
    "--target", $Target,
    "--bridge-port", "$Port",
    "--offscreen",
    "--no-stale-process-kill"
) -join ' '

$LogDir = Join-Path $env:ProgramData 'cbe-bridge-services'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogOut = Join-Path $LogDir "$ServiceName.stdout.log"
$LogErr = Join-Path $LogDir "$ServiceName.stderr.log"

& $NssmExe install $ServiceName "$resolvedPython" | Out-Null
& $NssmExe set     $ServiceName AppParameters "$AppArgs" | Out-Null
& $NssmExe set     $ServiceName AppDirectory "$SuperGrokRoot" | Out-Null
& $NssmExe set     $ServiceName DisplayName "CBE SuperGrok Bridge ($Target) — TCP :$Port" | Out-Null
& $NssmExe set     $ServiceName Description "SuperGrok resident bridge service maintained by Claude Codex Black. Keeps the $Target web session warm + logged in. CBE connects over 127.0.0.1:$Port." | Out-Null
& $NssmExe set     $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmExe set     $ServiceName AppStdout "$LogOut" | Out-Null
& $NssmExe set     $ServiceName AppStderr "$LogErr" | Out-Null
& $NssmExe set     $ServiceName AppRotateFiles 1 | Out-Null
& $NssmExe set     $ServiceName AppRotateBytes 10485760 | Out-Null
& $NssmExe set     $ServiceName AppExit Default Restart | Out-Null
& $NssmExe set     $ServiceName AppRestartDelay 3000 | Out-Null

Write-Host "[install_supergrok_service] starting service"
& $NssmExe start $ServiceName | Out-Null

# Wait for the TCP bridge port to answer — SuperGrok's Qt/WebEngine bootstrap
# is the slow part (can take 15-30s on a cold first run).
$deadline = (Get-Date).AddSeconds(40)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        if ($client.Connected) { $ready = $true; $client.Close(); break }
    } catch {}
    Start-Sleep -Milliseconds 700
}

if ($ready) {
    Write-Host "[install_supergrok_service] OK — service running, bridge listening on 127.0.0.1:$Port" -ForegroundColor Green
    Write-Host "[install_supergrok_service] DONE"
    exit 0
} else {
    Write-Host "[install_supergrok_service] WARN — service installed + started, but TCP :$Port didn't answer within 40s" -ForegroundColor Yellow
    Write-Host "[install_supergrok_service] Check $LogErr and C:\SuperGrok\logs\bridge_service.log"
    exit 1
}
