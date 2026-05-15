# uninstall_supergrok_service.ps1 — Stop + remove the CBE SuperGrok bridge
# Windows service installed by install_supergrok_service.ps1.
#
# Usage (run elevated):
#   powershell -ExecutionPolicy Bypass -File uninstall_supergrok_service.ps1
#     -NssmExe 'C:\path\to\extension\tools\nssm.exe'

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]  [string]$NssmExe,
    [Parameter(Mandatory=$false)] [string]$ServiceName = 'CBE-SuperGrok-Bridge'
)

$ErrorActionPreference = 'Stop'

function Fail($msg) {
    Write-Host "[uninstall_supergrok_service] ERROR: $msg" -ForegroundColor Red
    exit 2
}

if (-not (Test-Path $NssmExe)) { Fail "nssm.exe not found at $NssmExe" }

$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail "This script needs to run elevated (Administrator)."
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[uninstall_supergrok_service] no service named $ServiceName — nothing to do"
    exit 0
}

Write-Host "[uninstall_supergrok_service] stopping + removing $ServiceName"
try { & $NssmExe stop $ServiceName confirm 2>$null | Out-Null } catch {}
& $NssmExe remove $ServiceName confirm | Out-Null
Write-Host "[uninstall_supergrok_service] DONE" -ForegroundColor Green
exit 0
