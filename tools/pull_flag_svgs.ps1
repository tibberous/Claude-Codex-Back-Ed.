# Downloads 39 country-flag SVGs from hampusborgos/country-flags (MIT-licensed,
# the standard public repo of ISO 3166-1 flags). Each locale in our i18n table
# maps to a country code; for multi-country languages we pick the most populous
# speaker country. The result is one .svg per locale in assets/flags/.

$ErrorActionPreference = 'Stop'
$dst = 'C:\Users\moren\Desktop\Claude Codex Black\assets\flags'
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# locale_code -> ISO 3166 country code for the flag
$map = @{
    'en'  = 'us'; 'zh'  = 'cn'; 'hi'  = 'in'; 'es'  = 'es'; 'fr'  = 'fr'
    'ar'  = 'sa'; 'bn'  = 'bd'; 'ru'  = 'ru'; 'pt'  = 'br'; 'ur'  = 'pk'
    'id'  = 'id'; 'de'  = 'de'; 'ja'  = 'jp'; 'sw'  = 'ke'; 'mr'  = 'in'
    'vi'  = 'vn'; 'te'  = 'in'; 'ha'  = 'ng'; 'tr'  = 'tr'; 'pa'  = 'in'
    'tl'  = 'ph'; 'ta'  = 'in'; 'yue' = 'hk'; 'ko'  = 'kr'; 'fa'  = 'ir'
    'it'  = 'it'; 'pl'  = 'pl'; 'uk'  = 'ua'; 'nl'  = 'nl'; 'ro'  = 'ro'
    'th'  = 'th'; 'el'  = 'gr'; 'cs'  = 'cz'; 'hu'  = 'hu'; 'sv'  = 'se'
    'fi'  = 'fi'; 'he'  = 'il'; 'nb'  = 'no'; 'da'  = 'dk'
}

$base = 'https://raw.githubusercontent.com/hampusborgos/country-flags/main/svg'
$ok = 0; $fail = 0
foreach ($locale in $map.Keys) {
    $cc = $map[$locale]
    $url = "$base/$cc.svg"
    $out = Join-Path $dst "$locale.svg"
    try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing -TimeoutSec 30
        Write-Output "OK   $locale -> $cc ($((Get-Item $out).Length) B)"
        $ok++
    } catch {
        Write-Output "FAIL $locale $cc : $($_.Exception.Message)"
        $fail++
    }
}
Write-Output "summary: ok=$ok fail=$fail"

Write-Output ""
Write-Output "Saved $(@(Get-ChildItem $dst -Filter '*.svg').Count) flag SVGs to $dst"
