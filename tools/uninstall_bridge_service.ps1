# uninstall_bridge_service.ps1 — Remove a per-provider Chrome service that
# install_bridge_service.ps1 created. Idempotent: returns 0 even if the
# service doesn't exist (so CBE can call this unconditionally).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File uninstall_bridge_service.ps1
#     -Provider grokWeb
#     -NssmExe 'C:\path\to\extension\tools\nssm.exe'

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)] [string]$Provider,
    [Parameter(Mandatory=$true)] [string]$NssmExe,
    [Parameter(Mandatory=$false)] [string]$ServicePrefix = 'CBE-Bridge-'
)

$ErrorActionPreference = 'Continue'
$ServiceName = "$ServicePrefix$Provider"

if (-not (Test-Path $NssmExe)) {
    Write-Host "[uninstall_bridge_service] nssm.exe not found at $NssmExe" -ForegroundColor Yellow
    exit 2
}

# Admin check.
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[uninstall_bridge_service] needs elevation (Administrator)" -ForegroundColor Red
    exit 2
}

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "[uninstall_bridge_service] service $ServiceName not present — nothing to do"
    exit 0
}

Write-Host "[uninstall_bridge_service] stopping $ServiceName"
try { & $NssmExe stop $ServiceName confirm 2>$null | Out-Null } catch {}
Start-Sleep -Milliseconds 800

Write-Host "[uninstall_bridge_service] removing $ServiceName"
& $NssmExe remove $ServiceName confirm | Out-Null
Start-Sleep -Milliseconds 500

$check = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($check) {
    Write-Host "[uninstall_bridge_service] WARN — service still registered; you may need to reboot to clear it" -ForegroundColor Yellow
    exit 1
}

Write-Host "[uninstall_bridge_service] DONE"
exit 0
