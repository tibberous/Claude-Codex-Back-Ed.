# Claude Codex Black — Launch Script
# Run this instead of manually opening VS Code.
# It patches Claude Code's webview, then opens VS Code with CBE loaded.

$EXT_DIR = "C:\Users\moren\Desktop\Claude Codex Black"
$PATCH   = Join-Path $EXT_DIR "patch-webview.js"

Write-Host "=== Claude Codex Black — Launch ===" -ForegroundColor Cyan

# 1. Run patch-webview.js to bundle all injects into Claude Code's webview
Write-Host "`n[1/2] Patching Claude Code webview..." -ForegroundColor Yellow
$result = node $PATCH 2>&1
Write-Host $result

if ($LASTEXITCODE -ne 0) {
    Write-Host "`n[WARN] patch-webview.js exited with code $LASTEXITCODE — launching anyway." -ForegroundColor Red
} else {
    Write-Host "[OK] Patch complete." -ForegroundColor Green
}

# 2. Open VS Code with CBE as extension development path
Write-Host "`n[2/2] Launching VS Code with Claude Codex Black..." -ForegroundColor Yellow
code --extensionDevelopmentPath=$EXT_DIR

Write-Host "`n[Done] VS Code launched. Open the Claude Code panel to see CBE." -ForegroundColor Green
