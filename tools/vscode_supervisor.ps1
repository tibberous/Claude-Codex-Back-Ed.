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
    [Parameter(Mandatory=$true)] [string] $CodePath,
    [int] $PollSeconds = 5,
    [string] $LogPath  = (Join-Path $env:TEMP 'cbe_supervisor.log')
)

$ErrorActionPreference = 'Continue'
$script:stopRequested = $false

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
        param($sender, $e)
        $e.Cancel = $true
        $script:stopRequested = $true
        Write-Log 'supervisor:cancel-key-press'
    }
} catch {
    Write-Log "supervisor:cancel-handler-failed $($_.Exception.Message)"
}

Write-Log "supervisor:start code='$CodePath' poll=$PollSeconds pid=$PID"

# Sanity: if Code.exe doesn't exist where we were told, bail with a clear log
# entry instead of silently spinning forever.
if (-not (Test-Path -LiteralPath $CodePath)) {
    Write-Log "supervisor:FATAL Code.exe not found at '$CodePath'"
    exit 2
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
        # Get-Process matches any Code* process; filter to ones whose Path
        # actually resolves to our target Code.exe so we don't false-match
        # other Electron apps that happen to be named "Code".
        $alive = $false
        Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                if ($_.Path -and ([System.IO.Path]::GetFullPath($_.Path) -ieq [System.IO.Path]::GetFullPath($CodePath))) {
                    $alive = $true
                }
            } catch { }
        }
        if (-not $alive) {
            Write-Log "supervisor:relaunch Code.exe is not running — starting"
            $ok = Start-CodeInUserSession -Path $CodePath
            if ($ok) {
                Write-Log "supervisor:relaunch:ok"
            } else {
                Write-Log "supervisor:relaunch:all-methods-failed"
            }
            # Give VSCode time to come up before the next poll so we don't
            # double-fire on a slow boot.
            for ($i=0; $i -lt 8 -and -not $script:stopRequested; $i++) { Start-Sleep -Seconds 1 }
        }
    } catch {
        Write-Log "supervisor:loop-error $($_.Exception.Message)"
    }
    # Sleep in 1s chunks so a stop signal interrupts within ~1s instead of waiting
    # out a full poll interval.
    for ($i=0; $i -lt $PollSeconds -and -not $script:stopRequested; $i++) { Start-Sleep -Seconds 1 }
}

Write-Log "supervisor:stop (clean)"
exit 0
