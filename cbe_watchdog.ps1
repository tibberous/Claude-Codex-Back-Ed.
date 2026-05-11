$logFile = "$env:TEMP\cbe_monitor.log"
$cbePath = "C:\Users\moren\Desktop\Claude Codex Black"
"$(Get-Date -Format 'HH:mm:ss') [watchdog] service started" | Add-Content $logFile
while ($true) {
    Start-Sleep -Seconds 8
    $procs = Get-Process "Code" -ErrorAction SilentlyContinue
    if (-not $procs) {
        "$(Get-Date -Format 'HH:mm:ss') [watchdog] Code.exe gone - relaunching" | Add-Content $logFile
        Start-Sleep -Seconds 3
        Start-Process "code"
        Start-Sleep -Seconds 25
        "$(Get-Date -Format 'HH:mm:ss') [watchdog] relaunch done" | Add-Content $logFile
    }
}
