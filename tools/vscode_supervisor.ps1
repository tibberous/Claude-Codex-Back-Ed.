# =============================================================================
# CBE VSCode Supervisor — watchdog wrapped as a Windows service via NSSM.
# Keeps Code.exe alive: if VSCode dies (crash, OOM, gpu driver fault), this
# respawns it. NSSM is the actual service host; this script is the worker.
#
# Registered via extension.js -> installSupervisorService() which calls
# tools/nssm.exe install CBEVSCodeSupervisor powershell.exe <args>.
#
# Stop behavior: NSSM sends Ctrl+C (CTRL_C_EVENT) to this process when the
# service is stopped. We register a Console.CancelKeyPress handler so the
# loop exits cleanly. If we ignored it, NSSM would escalate to TerminateProcess
# after AppStopMethodConsole ms (3000 by default in our installer).
#
# Args:
#   -CodePath <full path to Code.exe>   REQUIRED — passed in by the installer
#   -PollSeconds <int>                  default 5
#   -LogPath <file>                     default %TEMP%\cbe_supervisor.log
# =============================================================================
param(
    [string] $CodePath = '',
    [int] $PollSeconds = 3,
    [string] $LogPath  = (Join-Path $env:TEMP 'cbe_supervisor.log')
)

$ErrorActionPreference = 'Continue'
$script:stopRequested = $false

# CodePath resolution. The service runs as LocalSystem, so $env:LOCALAPPDATA
# points at the systemprofile (NOT the user) and cross-session Code.exe .Path
# reads are Access-Denied. The reliable source is a plain text file written
# at install time by the elevated installer, which DOES know the real path.
# Fallback order: explicit -CodePath arg > C:\ProgramData\cbe\code_path.txt >
# any running Code.exe we can read > common install locations.
function Resolve-CodePath {
    param([string] $explicit)
    if ($explicit -and (Test-Path -LiteralPath $explicit)) { return $explicit }
    $txt = 'C:\ProgramData\cbe\code_path.txt'
    if (Test-Path -LiteralPath $txt) {
        try {
            $p = (Get-Content -LiteralPath $txt -Raw -ErrorAction Stop).Trim()
            if ($p -and (Test-Path -LiteralPath $p)) { return $p }
        } catch { }
    }
    try {
        $running = Get-Process -Name Code -ErrorAction SilentlyContinue |
                   Where-Object { $_.Path } | Select-Object -First 1
        if ($running) { return $running.Path }
    } catch { }
    foreach ($c in @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
        (Join-Path ${env:ProgramFiles} 'Microsoft VS Code\Code.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\Code.exe')
    )) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return ''
}
$CodePath = Resolve-CodePath -explicit $CodePath

function Write-Log {
    param([string] $Msg)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    try { "$stamp $Msg" | Out-File -FilePath $LogPath -Append -Encoding UTF8 } catch { }
}

# Catch Ctrl+C / CTRL_BREAK from NSSM stop so the loop exits cleanly. Without
# this, NSSM's "console" stop method (CTRL_C_EVENT) would kill the script mid
# Start-Process and corrupt the relaunch attempt.
try {
    [Console]::TreatControlCAsInput = $false
} catch { }
$null = Register-EngineEvent -SourceIdentifier ConsoleCancelEventHandler -Action {
    $script:stopRequested = $true
    Write-Log 'supervisor:stop-signal-received'
}
# .NET-level Ctrl+C handler. Register-EngineEvent above is best-effort; this
# one is what NSSM's AppStopMethodConsole actually trips.
try {
    [Console]::CancelKeyPress += {
        param($cancelSender, $e)
        $e.Cancel = $true
        $script:stopRequested = $true
        Write-Log 'supervisor:cancel-key-press'
    }
} catch {
    Write-Log "supervisor:cancel-handler-failed $($_.Exception.Message)"
}

Write-Log "supervisor:start code='$CodePath' poll=$PollSeconds pid=$PID"

# ── HTTP status endpoint on :3434 ────────────────────────────────────────
#   GET /         → 200 OK with a tiny JSON status blob
#   GET /health   → same
# Lets the CBE panel poll service liveness via HTTP instead of `sc query`,
# which (1) doesn't require admin and (2) confirms the script is ACTUALLY
# running, not just that SCM thinks it is. Bound on 127.0.0.1 only so this
# never goes over the network.
$listener = New-Object System.Net.HttpListener
try {
    $listener.Prefixes.Add('http://127.0.0.1:3434/')
    $listener.Start()
    Write-Log 'supervisor:http:listening 127.0.0.1:3434'
} catch {
    Write-Log "supervisor:http:bind-failed $($_.Exception.Message)"
    $listener = $null
}
$script:relaunchCount = 0
$script:lastRelaunchTs = ''
# ONE persistent pending GetContextAsync task held at script scope. The old
# code called GetContextAsync() then abandoned the task on a 50ms timeout —
# every poll tick leaked another pending receive, and when a real request
# finally arrived an *abandoned* task grabbed it with nobody reading .Result,
# so the client just hung. Now: keep exactly one pending task; when it
# completes, answer it AND immediately queue the next one.
$script:pendingCtx = $null
function Serve-HttpRequests {
    if (-not $listener -or -not $listener.IsListening) { return }
    # Drain every request that has completed since the last tick. Loop so a
    # burst of polls all get served within one tick instead of one-per-tick.
    while ($true) {
        if ($null -eq $script:pendingCtx) {
            try { $script:pendingCtx = $listener.GetContextAsync() }
            catch { Write-Log "supervisor:http:getcontext-failed $($_.Exception.Message)"; return }
        }
        # IsCompleted is non-blocking — if no request has arrived, stop draining
        # and leave the task pending for the next tick.
        if (-not $script:pendingCtx.IsCompleted) { return }
        $task = $script:pendingCtx
        $script:pendingCtx = $null    # consume; a fresh one is queued next loop
        try {
            $ctx = $task.Result
            $body = '{"status":"OK","pid":' + $PID + ',"relaunches":' + $script:relaunchCount + ',"lastRelaunch":"' + $script:lastRelaunchTs + '","codePathKnown":' + ($script:codePathKnown.ToString().ToLower()) + '}'
            $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
            $ctx.Response.StatusCode = 200
            $ctx.Response.StatusDescription = 'OK'
            $ctx.Response.ContentType = 'application/json; charset=utf-8'
            $ctx.Response.AddHeader('Cache-Control', 'no-store')
            $ctx.Response.ContentLength64 = $buf.Length
            $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
            $ctx.Response.OutputStream.Close()
        } catch {
            Write-Log "supervisor:http:serve-error $($_.Exception.Message)"
        }
    }
}

# If Code.exe can't be resolved, DON'T exit — the panel's blue status ring
# depends on /status answering 200, and that must stay up regardless. We
# just skip the relaunch behavior and re-attempt path resolution each loop.
$script:codePathKnown = ($CodePath -and (Test-Path -LiteralPath $CodePath))
if (-not $script:codePathKnown) {
    Write-Log "supervisor:WARN Code.exe path unresolved at start - /status stays up, relaunch disabled until path resolves"
}

# Helper: launch Code.exe in the active interactive user session. The service
# runs as LocalSystem (session 0), but Start-Process from session 0 spawns
# Code.exe in session 0, which has no desktop — VSCode would appear to launch
# but be invisible to the user. We use the WTSEnumerateSessions / CreateProcessAsUser
# pattern, but since that requires P/Invoke gymnastics, we delegate to a
# scheduled task that runs as INTERACTIVE — simplest viable approach for a
# user-space watchdog.
function Start-CodeInUserSession {
    param([string] $Path)
    try {
        # Try the simple approach first: Start-Process. If we're running under
        # NSSM with Type=SERVICE_INTERACTIVE_PROCESS and session 0 isolation
        # tolerates it (rare), this just works.
        Start-Process -FilePath $Path -WindowStyle Normal -ErrorAction Stop
        return $true
    } catch {
        Write-Log "supervisor:relaunch:simple-start-failed $($_.Exception.Message)"
    }
    # Fallback: register a one-shot scheduled task to run Code.exe as the
    # currently logged-in user. Cleans up after itself. Robust against
    # session 0 isolation on modern Windows.
    try {
        $taskName = "CBELaunchCode_" + ([Guid]::NewGuid().ToString('N').Substring(0,8))
        $loggedUser = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
        if (-not $loggedUser) {
            # Fall back to whoever owns explorer.exe.
            $exp = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($exp) {
                $ownerInfo = Invoke-CimMethod -InputObject $exp -MethodName GetOwner -ErrorAction SilentlyContinue
                if ($ownerInfo -and $ownerInfo.Domain -and $ownerInfo.User) {
                    $loggedUser = "$($ownerInfo.Domain)\$($ownerInfo.User)"
                }
            }
        }
        if (-not $loggedUser) { throw 'no logged-in user found' }
        $action  = New-ScheduledTaskAction -Execute $Path
        $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(2)
        $principal = New-ScheduledTaskPrincipal -UserId $loggedUser -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -DeleteExpiredTaskAfter (New-TimeSpan -Seconds 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
        Start-ScheduledTask -TaskName $taskName
        # Let it fire, then delete.
        Start-Sleep -Seconds 4
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
        return $true
    } catch {
        Write-Log "supervisor:relaunch:task-fallback-failed $($_.Exception.Message)"
        return $false
    }
}

while (-not $script:stopRequested) {
    try {
        # Re-attempt CodePath resolution each loop — Code.exe may have come up
        # since start, or code_path.txt may have been written after install.
        if (-not $script:codePathKnown) {
            $CodePath = Resolve-CodePath -explicit $CodePath
            $script:codePathKnown = ($CodePath -and (Test-Path -LiteralPath $CodePath))
            if ($script:codePathKnown) { Write-Log "supervisor:codepath-resolved '$CodePath'" }
        }
        # Get-Process matches any Code* process; filter to ones whose Path
        # actually resolves to our target Code.exe so we don't false-match
        # other Electron apps that happen to be named "Code".
        $alive = $false
        if ($script:codePathKnown) {
            Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object {
                try {
                    if ($_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq [System.IO.Path]::GetFullPath($CodePath))) {
                        $alive = $true
                    }
                } catch { }
            }
        } else {
            # Path unknown — skip relaunch this tick but keep /status alive.
            $alive = $true
        }
        if (-not $alive) {
            Write-Log "supervisor:relaunch Code.exe is not running - starting"
            $ok = Start-CodeInUserSession -Path $CodePath
            if ($ok) {
                $script:relaunchCount++
                $script:lastRelaunchTs = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
                Write-Log "supervisor:relaunch:ok count=$script:relaunchCount"
            } else {
                Write-Log "supervisor:relaunch:all-methods-failed"
            }
            # Give VSCode time to come up before the next poll so we don't
            # double-fire on a slow boot. Serve HTTP between sleeps so the
            # status endpoint stays responsive during the boot window.
            for ($i=0; $i -lt 8 -and -not $script:stopRequested; $i++) {
                Start-Sleep -Seconds 1
                Serve-HttpRequests
            }
        }
    } catch {
        Write-Log "supervisor:loop-error $($_.Exception.Message)"
    }
    # Drain any pending HTTP polls + sleep in 1s chunks so stop signals
    # interrupt within ~1s instead of waiting out a full poll interval.
    for ($i=0; $i -lt $PollSeconds -and -not $script:stopRequested; $i++) {
        Serve-HttpRequests
        Start-Sleep -Seconds 1
    }
}

if ($listener) {
    try { $listener.Stop(); $listener.Close() } catch { }
}
Write-Log "supervisor:stop (clean)"
exit 0
