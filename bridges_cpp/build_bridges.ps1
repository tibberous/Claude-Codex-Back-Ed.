# build_bridges.ps1 — build the unified CBE-Bridge.exe.
#
# Consolidated 2026-05-24 (was per-target builds). One source file
# (bridge_server.cpp), one resource file (bridge_unified.rc with all 7
# icons at distinct ids 101..107 + id 1 as the default File-Explorer icon),
# one output: <repo>\bin\CBE-Bridge.exe. The target is now selected at
# runtime via `--target ChatGPT|Grok|Copilot|Gemini|Ollama|DeepSeek`
# rather than baked in via #define.
#
# Why: Azure Trusted Signing charges per signing operation under the Basic
# SKU, and one signed binary identity is easier to reason about than seven.

param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo   = Split-Path -Parent $here
$binDir = Join-Path $repo 'bin'
$objDir = Join-Path $here  'obj'
$log    = Join-Path $repo 'logs\build_bridges.log'

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $objDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
"=== build_bridges.ps1 started $(Get-Date -Format o) ===" | Set-Content $log

if ($Clean) {
    Remove-Item "$objDir\*" -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $binDir -Filter 'CBE-Bridge*.exe' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Add-Content $log 'clean: wiped obj/ and bin\CBE-Bridge*.exe'
}

# Locate vcvars64.bat via vswhere. NOTE: do NOT use ${env:ProgramFiles(x86)}
# — PowerShell's parser chokes on the parens inside the variable name and
# silently expands it to an empty string.
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
if (-not $pf86) { $pf86 = 'C:\Program Files (x86)' }
$vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere" }
$vsInstall = & $vswhere -latest -property installationPath
$vcvars = Join-Path $vsInstall 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

# Import MSVC env into this PS session.
$envBlock = & cmd /c "`"$vcvars`" >NUL && set"
foreach ($line in $envBlock) {
    if ($line -match '^([^=]+)=(.*)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}
Add-Content $log "msvc env loaded from $vcvars"

$cl = (Get-Command cl.exe -ErrorAction SilentlyContinue).Source
$rc = (Get-Command rc.exe -ErrorAction SilentlyContinue).Source
if (-not $cl) { throw 'cl.exe not on PATH after vcvars activation' }
if (-not $rc) { throw 'rc.exe not on PATH after vcvars activation' }
Add-Content $log "cl: $cl"
Add-Content $log "rc: $rc"

$src    = Join-Path $here 'bridge_server.cpp'
$rcFile = Join-Path $here 'bridge_unified.rc'
if (-not (Test-Path $src))    { throw "missing $src" }
if (-not (Test-Path $rcFile)) { throw "missing $rcFile" }

$resFile = Join-Path $objDir 'bridge_unified.res'
$exeFile = Join-Path $binDir 'CBE-Bridge.exe'

Write-Host ("[build] unified bridge -> {0}" -f $exeFile) -ForegroundColor Cyan

# 1) Compile the multi-icon resource.
$rcOut = & $rc /nologo /fo $resFile $rcFile 2>&1
Add-Content $log ($rcOut | Out-String)
if ($LASTEXITCODE -ne 0) { throw "rc.exe failed (rc=$LASTEXITCODE)" }

# 2) Compile + link. /std:c++17 for std::thread / std::atomic, /MT static
#    CRT so the exe runs on a clean machine, /SUBSYSTEM:WINDOWS so the tray
#    process doesn't pop a console window. Response file used to avoid
#    PowerShell quoting issues around paths with spaces.
$rspFile = Join-Path $objDir 'bridge_unified.rsp'
@"
/nologo /O2 /EHsc /W3 /MT /std:c++17
/Fo:"$objDir\\"
/Fe:"$exeFile"
"$src"
"$resFile"
/link /SUBSYSTEM:WINDOWS ws2_32.lib user32.lib shell32.lib comctl32.lib
"@ | Set-Content -Path $rspFile -Encoding ASCII

$clOut = & $cl ('@' + $rspFile) 2>&1
Add-Content $log ($clOut | Out-String)
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exeFile)) {
    throw "cl.exe failed (rc=$LASTEXITCODE)"
}

$size = (Get-Item $exeFile).Length
Write-Host ("[build] OK: $exeFile ({0:N0} bytes)" -f $size) -ForegroundColor Green
Add-Content $log "built: $exeFile ($size bytes)"
