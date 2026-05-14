<?php
/*
 * manifest.xml.php — server-side file inventory.
 *
 * Walks its own directory (the deployed CBE root) and emits an XML
 * listing of every distributable file with its MD5 + size. The extension's
 * auto-update function fetches this URL on boot, compares MD5s to local
 * files, and downloads only the ones that changed.
 *
 * Skips:
 *   - node_modules/, .git/, logs/, chats/, dist/, tmp/ trees
 *   - the manifest itself
 *   - per-machine secret files (config.ini, *.log, *.bak, *.tmp)
 *   - host-only binaries we don't want to ship (tools/nssm.exe, tools/rcedit.exe)
 */

header('Content-Type: application/xml; charset=utf-8');
header('Cache-Control: no-cache, no-store, must-revalidate');

$root = __DIR__;

// Patterns matched against the FORWARD-SLASH relative path. Order matters: a
// match short-circuits the file. Directories with trailing slash exclude the
// whole subtree.
$skipPatterns = [
    '#^node_modules/#',
    '#^\.git/#',
    '#^logs/#',
    '#^chats/#',
    '#^dist/#',
    '#^tmp/#',
    '#^\.claude/#',
    '#^tools/nssm\.exe$#',
    '#^tools/rcedit\.exe$#',
    '#^manifest\.xml\.php$#',
    '#^config\.ini$#',
    '#\.log$#',
    '#\.bak$#',
    '#\.tmp$#',
    '#\.swp$#',
    '#^prompt_history\.txt$#',
    '#^domains\.txt$#',
    '#^wake\.txt$#',
];

function shouldSkip($rel, $patterns) {
    foreach ($patterns as $p) {
        if (preg_match($p, $rel)) return true;
    }
    return false;
}

function walkDir($dir, $base, $patterns, &$out) {
    $items = @scandir($dir);
    if ($items === false) return;
    foreach ($items as $item) {
        if ($item === '.' || $item === '..') continue;
        $full = $dir . DIRECTORY_SEPARATOR . $item;
        $rel  = ltrim(substr($full, strlen($base)), DIRECTORY_SEPARATOR);
        $rel  = str_replace(DIRECTORY_SEPARATOR, '/', $rel);
        if (shouldSkip($rel, $patterns)) continue;
        if (is_dir($full)) {
            walkDir($full, $base, $patterns, $out);
        } elseif (is_file($full)) {
            $md5  = @md5_file($full);
            $size = @filesize($full);
            if ($md5 === false || $size === false) continue;
            $out[] = ['path' => $rel, 'md5' => $md5, 'bytes' => $size];
        }
    }
}

$files = [];
walkDir($root, $root, $skipPatterns, $files);
// Stable order so two consecutive fetches with no changes diff cleanly.
usort($files, function ($a, $b) { return strcmp($a['path'], $b['path']); });

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<manifest generated="' . date('c') . '" host="' . htmlspecialchars(gethostname(), ENT_XML1 | ENT_QUOTES, 'UTF-8') . '" count="' . count($files) . '">' . "\n";
foreach ($files as $f) {
    echo '  <file path="' . htmlspecialchars($f['path'], ENT_XML1 | ENT_QUOTES, 'UTF-8')
        . '" md5="' . $f['md5'] . '" bytes="' . $f['bytes'] . '" />' . "\n";
}
echo '</manifest>' . "\n";
