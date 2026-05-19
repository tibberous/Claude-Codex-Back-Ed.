# Build all seven CBE-Bridge-<Target>.exe binaries.
# - Loads MSVC env from vcvars64.bat
# - Compiles bridge_server.cpp once per target with -DTARGET_NAME / -DDEFAULT_PORT
# - Compiles the per-target .rc into a .res (embeds the icon)
# - Links against ws2_32.lib
# - Output: <repo>\bin\CBE-Bridge-<Target>.exe

param(
    [string]$Target = 'all',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo   = Split-Path -Parent $here
$binDir = Join-Path $repo 'bin'
$objDir = Join-Path $here  'obj'
$log    = Join-Path $repo 'logs\build_bridges.log'

# Port table — matches BRIDGE_PORTS in start.py.
$targets = @(
    @{ name = 'Grok';     port = 8789; rc = 'bridge_grok.rc'     }
    @{ name = 'Gemini';   port = 8791; rc = 'bridge_gemini.rc'   }
    @{ name = 'ChatGPT';  port = 8788; rc = 'bridge_chatgpt.rc'  }
    @{ name = 'Claude';   port = 8792; rc = 'bridge_claude.rc'   }
    @{ name = 'Copilot';  port = 8790; rc = 'bridge_copilot.rc'  }
    @{ name = 'Ollama';   port = 8793; rc = 'bridge_ollama.rc'   }
    @{ name = 'DeepSeek'; port = 8794; rc = 'bridge_deepseek.rc' }
)

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
New-Item -ItemType Directory -Force -Path $objDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
"=== build_bridges.ps1 started $(Get-Date -Format o) ===" | Set-Content $log

if ($Clean) {
    Remove-Item "$objDir\*" -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem $binDir -Filter 'CBE-Bridge-*.exe' -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Add-Content $log 'clean: wiped obj/ and bin\CBE-Bridge-*.exe'
}

# Locate vcvars64.bat via vswhere. NOTE: do NOT use ${env:ProgramFiles(x86)}
# — PowerShell's parser chokes on the parens inside the variable name and
# silently expands it to an empty string, which makes vswhere unresolvable.
# [Environment]::GetEnvironmentVariable() reads the same value robustly.
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

$src = Join-Path $here 'bridge_server.cpp'
if (-not (Test-Path $src)) { throw "missing $src" }

$picked = if ($Target -eq 'all') { $targets } else { $targets | Where-Object { $_.name -ieq $Target } }
if (-not $picked) { throw "unknown target '$Target' (use one of: Grok, Gemini, ChatGPT, Claude, Copilot, Ollama, DeepSeek, all)" }

$ok = @()
$fail = @()
foreach ($t in $picked) {
    $name = $t.name
    $port = $t.port
    $rcFile = Join-Path $here $t.rc
    if (-not (Test-Path $rcFile)) { throw "missing rc $rcFile" }

    $resFile = Join-Path $objDir ("bridge_{0}.res" -f $name.ToLower())
    $exeFile = Join-Path $binDir ("CBE-Bridge-{0}.exe" -f $name)

    Write-Host ("[build] {0}  port={1}  -> {2}" -f $name, $port, $exeFile) -ForegroundColor Cyan
    Add-Content $log ('--- {0} (port {1}) ---' -f $name, $port)

    # 1) Compile resource (icon).
    $rcOut = & $rc /nologo /fo $resFile $rcFile 2>&1
    Add-Content $log ($rcOut | Out-String)
    if ($LASTEXITCODE -ne 0) { $fail += "$name (rc.exe rc=$LASTEXITCODE)"; continue }

    # 2) Generate a per-target header so we don't have to fight PowerShell's
    #    backslash/quote escaping in /D defines.
    $headerFile = Join-Path $objDir ("bridge_target_{0}.h" -f $name.ToLower())
    @"
#pragma once
#define TARGET_NAME "$name"
#define DEFAULT_PORT $port
"@ | Set-Content -Path $headerFile -Encoding ASCII

    # 3) Compile + link. /std:c++17 for std::thread / std::atomic, /MT static
    # CRT so the exe runs on a clean machine, /SUBSYSTEM:WINDOWS so the tray
    # process doesn't pop a console window.
    #
    # NOTE: cl.exe must see paths containing spaces (e.g. "Claude Codex Black")
    # as single arguments. PowerShell's native-arg splatting (@clArgs) silently
    # breaks on `/Fo:<path-with-spaces>` and `/Fe:<path-with-spaces>` because
    # the equals/colon prefix prevents the auto-quoting shim. cmd /c with
    # explicit "..." also fails because cmd strips outer quotes. cl.exe
    # supports response files (@file) which read args verbatim from disk —
    # no shell quoting involved — so we use that.
    # Response file format: cl.exe treats newlines as arg separators, BUT
    # /link MUST be followed by its linker flags on the SAME line — otherwise
    # cl.exe treats the linker flags as compiler flags (D9002 warnings) and
    # the link silently uses default settings (wrong subsystem → bad/empty
    # exe). All compile flags above /link can wrap freely.
    $rspFile = Join-Path $objDir ("bridge_{0}.rsp" -f $name.ToLower())
    @"
/nologo /O2 /EHsc /W3 /MT /std:c++17
/FI"$headerFile"
/Fo:"$objDir\\"
/Fe:"$exeFile"
"$src"
"$resFile"
/link /SUBSYSTEM:WINDOWS ws2_32.lib user32.lib shell32.lib
"@ | Set-Content -Path $rspFile -Encoding ASCII
    $clOut = & $cl ('@' + $rspFile) 2>&1
    Add-Content $log ($clOut | Out-String)
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exeFile)) {
        $fail += "$name (cl rc=$LASTEXITCODE)"
        continue
    }
    $ok += "$name -> $exeFile ($((Get-Item $exeFile).Length) bytes)"
}

Add-Content $log '=== summary ==='
$ok   | ForEach-Object { Add-Content $log "OK   $_" }
$fail | ForEach-Object { Add-Content $log "FAIL $_" }

Write-Host ''
Write-Host '=== Built ===' -ForegroundColor Green
$ok | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
if ($fail) {
    Write-Host '=== Failed ===' -ForegroundColor Red
    $fail | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    exit 1
}
exit 0
