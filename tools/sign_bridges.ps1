# sign_bridges.ps1 — sign every CBE-Bridge-*.exe + the .vsix with Azure
# Artifact Signing (the new name for Trusted Signing; $9.99/mo, set up
# 2026-05-24 under account "AcquisitionInvest" in resource group
# rg-trenttompkins-3400, eastus).
#
# Prerequisites that ARE installed already:
#   • Windows SDK signtool at C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe
#   • Microsoft.ArtifactSigning.Client 1.0.128 dlib at C:\tools\sign\Microsoft.ArtifactSigning.Client\bin\x64\Azure.CodeSigning.Dlib.dll
#   • .NET 9.0 runtime (`dotnet --version` ⇒ 9.0.314)
#   • Azure CLI on PATH (`/c/Program Files/Microsoft SDKs/Azure/CLI2/wbin`)
#
# Prerequisites that are NOT done yet (the BLOCKER):
#   1. Identity Validation passes (1–3 business days for individuals).
#      Submit at portal.azure.com → Artifact Signing → AcquisitionInvest →
#      Identity Validations → + Create
#   2. After validation succeeds, create a Certificate Profile under the
#      account (Public Trust → Individual). Copy its name.
#   3. Edit tools/sign_metadata.json and replace REPLACE_AFTER_IDENTITY_VALIDATION
#      with the certificate profile name.
#   4. Run: az login   (signtool authenticates as the logged-in CLI user)
#
# Once those are done, this script signs every bin/CBE-Bridge-*.exe + the
# current claude-codex-black-edition-*.vsix in repo root.

param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$SIGNTOOL = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64\signtool.exe"
$DLIB     = "C:\tools\sign\Microsoft.ArtifactSigning.Client\bin\x64\Azure.CodeSigning.Dlib.dll"
$METADATA = Join-Path $PSScriptRoot 'sign_metadata.json'
$REPO     = Split-Path -Parent $PSScriptRoot

# Sanity-check the metadata: refuse to run with the placeholder still in place.
$metaText = Get-Content $METADATA -Raw
if ($metaText -match 'REPLACE_AFTER_IDENTITY_VALIDATION') {
    Write-Error "tools/sign_metadata.json still has the REPLACE_AFTER_IDENTITY_VALIDATION placeholder. Edit it with your certificate profile name after Identity Validation passes."
    exit 1
}

$targets = @()
# Unified bridge exe (consolidated 2026-05-24) — one signed binary covers
# every browser-bridge target via runtime --target arg. The trailing wildcard
# also catches any legacy CBE-Bridge-<Target>.exe still on disk during a
# transition install.
$targets += Get-ChildItem -LiteralPath (Join-Path $REPO 'bin') -Filter 'CBE-Bridge*.exe' -ErrorAction SilentlyContinue
$targets += Get-ChildItem -LiteralPath $REPO -Filter 'claude-codex-black-edition-*.vsix' -ErrorAction SilentlyContinue

if (-not $targets) {
    Write-Warning "no CBE-Bridge*.exe or claude-codex-black-edition-*.vsix found under $REPO"
    exit 0
}

Write-Output "Signing $($targets.Count) file(s) via Azure Artifact Signing (AcquisitionInvest @ eastus):"
$targets | ForEach-Object { Write-Output "  • $($_.FullName)" }

if ($DryRun) {
    Write-Output "DryRun: not invoking signtool."
    exit 0
}

foreach ($t in $targets) {
    & $SIGNTOOL sign /v /debug /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 `
        /dlib $DLIB /dmdf $METADATA $t.FullName
    if ($LASTEXITCODE -ne 0) {
        Write-Error "signtool failed for $($t.FullName) (exit=$LASTEXITCODE)"
        exit $LASTEXITCODE
    }
}

Write-Output "Done. Verify with: signtool verify /v /pa <file>"
