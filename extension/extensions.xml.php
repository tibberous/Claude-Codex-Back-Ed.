<?php
/*
 * extensions.xml.php — server-side extension catalog.
 *
 * Lives at /home/trentontompkins.com/cbe/extension/extensions.xml.php on
 * the server. The client (Claude Codex Black VSCode extension) fetches
 * this URL to discover what third-party extensions are available to
 * install on top of the core panel.
 *
 * Layout convention:
 *   /home/trentontompkins.com/cbe/extension/
 *     extensions.xml.php             (this file — the catalog)
 *     extensions/
 *       <ext-id>.ext                 (a ZIP renamed to .ext; inside lives
 *                                     manifest.xml + the actual extension
 *                                     code/assets at the zip root)
 *       <ext-id-2>.ext
 *       ...
 *
 * .ext = ordinary zip archive with this minimum layout inside:
 *   manifest.xml
 *   <files...>                       (the extension itself)
 *
 * manifest.xml schema:
 *   <extension id="my-ext" version="0.1.0">
 *     <name>My Extension</name>
 *     <author>tibberous</author>
 *     <description>What it does.</description>
 *     <created>2026-05-14</created>
 *     <url>https://github.com/.../my-ext</url>
 *     <entry>extension.js</entry>          (optional)
 *     <min_core>1.0.0</min_core>           (optional)
 *     <tag>git</tag>                        (zero or more)
 *     <tag>status</tag>
 *   </extension>
 *
 * Output: <extensions count="N" generated="…">
 *           <extension id="…" version="…" name="…" author="…"
 *                      created="…" file="abc.ext" md5="…" bytes="…">
 *             <description>…</description>
 *             <url>…</url>
 *             <entry>…</entry>
 *             <tag>…</tag>
 *           </extension>
 *           …
 *         </extensions>
 */

header('Content-Type: application/xml; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');

$root   = __DIR__;
$extDir = $root . DIRECTORY_SEPARATOR . 'extensions';

function xmlEscape($s) {
    return htmlspecialchars((string)$s, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function md5OrEmpty($p) {
    $h = @md5_file($p);
    return $h === false ? '' : $h;
}

function sizeOrZero($p) {
    $s = @filesize($p);
    return $s === false ? 0 : (int)$s;
}

function readManifestFromExt($extPath) {
    if (!class_exists('ZipArchive')) return null;
    $zip = new ZipArchive();
    if ($zip->open($extPath) !== true) return null;
    $raw = $zip->getFromName('manifest.xml');
    $zip->close();
    if ($raw === false || $raw === '') return null;
    libxml_use_internal_errors(true);
    $xml = @simplexml_load_string($raw);
    libxml_clear_errors();
    if ($xml === false) return null;
    $tags = [];
    if (isset($xml->tag)) {
        foreach ($xml->tag as $t) { $tags[] = (string)$t; }
    }
    return [
        'id'          => (string)($xml['id'] ?? ''),
        'version'     => (string)($xml['version'] ?? ''),
        'name'        => (string)($xml->name ?? ''),
        'author'      => (string)($xml->author ?? ''),
        'description' => (string)($xml->description ?? ''),
        'created'     => (string)($xml->created ?? ''),
        'url'         => (string)($xml->url ?? ''),
        'entry'       => (string)($xml->entry ?? ''),
        'min_core'    => (string)($xml->min_core ?? ''),
        'tags'        => $tags,
    ];
}

$extensions = [];
$items = is_dir($extDir) ? @scandir($extDir) : [];
if ($items === false) $items = [];
foreach ($items as $item) {
    if ($item === '.' || $item === '..') continue;
    // Only .ext files. Anything else (README, .htaccess) is skipped.
    if (substr(strtolower($item), -4) !== '.ext') continue;
    $full = $extDir . DIRECTORY_SEPARATOR . $item;
    if (!is_file($full)) continue;
    $manifest = readManifestFromExt($full);
    if (!$manifest) continue;
    if ($manifest['id']      === '') $manifest['id']      = pathinfo($item, PATHINFO_FILENAME);
    if ($manifest['name']    === '') $manifest['name']    = $manifest['id'];
    if ($manifest['version'] === '') $manifest['version'] = '0.0.0';
    $manifest['file']  = $item;
    $manifest['md5']   = md5OrEmpty($full);
    $manifest['bytes'] = sizeOrZero($full);
    $extensions[] = $manifest;
}

// Stable order so two consecutive fetches with no changes diff cleanly.
usort($extensions, function ($a, $b) { return strcmp($a['id'], $b['id']); });

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<extensions generated="' . xmlEscape(date('c'))
    . '" host="' . xmlEscape(gethostname())
    . '" count="' . count($extensions) . '">' . "\n";
foreach ($extensions as $e) {
    echo '  <extension'
        . ' id="'       . xmlEscape($e['id'])       . '"'
        . ' version="'  . xmlEscape($e['version'])  . '"'
        . ' name="'     . xmlEscape($e['name'])     . '"'
        . ' author="'   . xmlEscape($e['author'])   . '"'
        . ' created="'  . xmlEscape($e['created'])  . '"'
        . ' file="'     . xmlEscape($e['file'])     . '"'
        . ' md5="'      . xmlEscape($e['md5'])      . '"'
        . ' bytes="'    . (int)$e['bytes']          . '"'
        . ' min_core="' . xmlEscape($e['min_core']) . '">' . "\n";
    if ($e['description'] !== '') {
        echo '    <description>' . xmlEscape($e['description']) . '</description>' . "\n";
    }
    if ($e['url'] !== '') {
        echo '    <url>' . xmlEscape($e['url']) . '</url>' . "\n";
    }
    if ($e['entry'] !== '') {
        echo '    <entry>' . xmlEscape($e['entry']) . '</entry>' . "\n";
    }
    foreach ($e['tags'] as $t) {
        echo '    <tag>' . xmlEscape($t) . '</tag>' . "\n";
    }
    echo '  </extension>' . "\n";
}
echo '</extensions>' . "\n";
