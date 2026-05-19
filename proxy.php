<?php
/*
  proxy.php — frame-busting reverse proxy for CBE's NN4 in-panel browser.

  Many real sites (google.com, youtube.com, bing.com, ...) send
  `X-Frame-Options: SAMEORIGIN` or `Content-Security-Policy: frame-ancestors`,
  which makes the browser refuse to load them inside an <iframe>. This proxy
  fetches the target server-side, strips those headers, and returns the body
  so the iframe accepts it.

  Usage: GET /cbe/proxy.php?url=https%3A%2F%2Fwww.google.com%2F
         POST forwarded with body (for form submissions).

  Security:
  * Only http/https schemes are allowed.
  * Private/loopback/link-local IPs are blocked (SSRF guard).
  * Cookies are NOT forwarded in either direction — sessions don't cross.

  HTML responses get a <base href="<origin>/"> injected so relative
  subresources (img/css/js) resolve to the target's origin and bypass the
  proxy. Links and form-actions are rewritten back through the proxy so
  in-iframe navigation continues to dodge X-Frame-Options.
*/

set_time_limit(60);
ignore_user_abort(true);

$PROXY_BASE = '/cbe/proxy.php';   // path that this script lives at, used for rewrites

function bad($msg, $code = 400) {
    http_response_code($code);
    header('Content-Type: text/html; charset=utf-8');
    echo "<!doctype html><meta charset=utf-8><title>Proxy error</title>"
       . "<body style=\"font-family:sans-serif;padding:1em;background:#fff;color:#111\">"
       . "<h2>Proxy error " . (int)$code . "</h2><p>" . htmlspecialchars($msg) . "</p>";
    exit;
}

$target = isset($_GET['url']) ? trim($_GET['url']) : '';
if ($target === '') bad('Missing ?url=<url>');
$parts = @parse_url($target);
if (!$parts || empty($parts['scheme']) || empty($parts['host'])) bad('Malformed url');
$scheme = strtolower($parts['scheme']);
if ($scheme !== 'http' && $scheme !== 'https') bad('Only http/https schemes allowed');

// SSRF guard: refuse private/loopback hosts. resolve once and check.
$host = $parts['host'];
$ip = filter_var($host, FILTER_VALIDATE_IP) ? $host : @gethostbyname($host);
if ($ip && $ip !== $host) {
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
        bad('Blocked: host resolves to private/loopback IP (' . htmlspecialchars($ip) . ')', 403);
    }
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body   = ($method === 'POST' || $method === 'PUT' || $method === 'PATCH') ? file_get_contents('php://input') : null;

$reqHeaders = [
    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language: en-US,en;q=0.9',
    'Cache-Control: no-cache',
];
$ct = $_SERVER['CONTENT_TYPE'] ?? '';
if ($ct) $reqHeaders[] = 'Content-Type: ' . $ct;

$ch = curl_init($target);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER         => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 8,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_ENCODING       => '',                       // accept gzip/deflate, decode for us
    CURLOPT_HTTPHEADER     => $reqHeaders,
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);
if ($body !== null && $body !== '') curl_setopt($ch, CURLOPT_POSTFIELDS, $body);

$raw = curl_exec($ch);
if ($raw === false) bad('Fetch failed: ' . curl_error($ch), 502);

$status     = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
$headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
$finalUrl   = (string) curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
$contentTyp = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
curl_close($ch);

$rawHeaders = substr($raw, 0, $headerSize);
$bodyOut    = substr($raw, $headerSize);

// cURL keeps the redirect chain — only the LAST response block matters.
$blocks = preg_split("/\r\n\r\n/", trim($rawHeaders));
$lastBlock = end($blocks) ?: '';

// Strip the response status line and the headers we don't want.
http_response_code($status ?: 502);
$skip = [
    'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
    'strict-transport-security', 'set-cookie', 'transfer-encoding', 'content-encoding',
    'content-length', 'connection', 'keep-alive',
    'public-key-pins', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
    'cross-origin-resource-policy', 'permissions-policy', 'feature-policy',
];
foreach (preg_split("/\r\n/", $lastBlock) as $line) {
    if (strpos($line, ':') === false) continue;
    [$name, $val] = array_map('trim', explode(':', $line, 2));
    if ($name === '' || in_array(strtolower($name), $skip, true)) continue;
    header($name . ': ' . $val, false);
}

// Rewrite HTML so in-iframe navigation continues to dodge X-Frame-Options.
$finalParts = parse_url($finalUrl);
$origin = $finalParts['scheme'] . '://' . $finalParts['host']
        . (isset($finalParts['port']) ? ':' . $finalParts['port'] : '');
$basePath = isset($finalParts['path']) ? preg_replace('#/[^/]*$#', '/', $finalParts['path']) : '/';
$baseHref = $origin . $basePath;
$selfBase = $PROXY_BASE;   // e.g. /cbe/proxy.php

if (stripos($contentTyp, 'text/html') !== false) {
    // Inject <base> right after <head> so relative URLs resolve to the target.
    $injected = '<base href="' . htmlspecialchars($baseHref, ENT_QUOTES) . '">';
    if (preg_match('#<head[^>]*>#i', $bodyOut)) {
        $bodyOut = preg_replace('#(<head[^>]*>)#i', '$1' . $injected, $bodyOut, 1);
    } else {
        $bodyOut = $injected . $bodyOut;
    }

    // Rewrite navigation URLs (anchors + form actions) through this proxy so
    // clicking a link keeps the proxy in the loop and X-Frame-Options stays
    // bypassed. Subresources (img/script/link/iframe) load direct via <base>.
    $rewriteAttr = function ($html, $tagPattern, $attr) use ($selfBase, $origin) {
        return preg_replace_callback(
            '#(<' . $tagPattern . '\b[^>]*?\s' . $attr . '=)(["\'])([^"\'#][^"\']*)\2#i',
            function ($m) use ($selfBase, $origin) {
                $u = $m[3];
                // Skip data:, javascript:, mailto:, tel:, and already-proxied URLs.
                if (preg_match('#^(data:|javascript:|mailto:|tel:|about:)#i', $u)) return $m[0];
                if (strpos($u, $selfBase . '?url=') !== false)                  return $m[0];
                // Resolve relative → absolute against the target origin.
                if (preg_match('#^//#', $u))            $abs = 'https:' . $u;
                elseif (preg_match('#^/#', $u))         $abs = $origin . $u;
                elseif (preg_match('#^[a-z]+://#i', $u))$abs = $u;
                else                                    $abs = $u;   // leave bare frags alone
                return $m[1] . $m[2] . $selfBase . '?url=' . urlencode($abs) . $m[2];
            },
            $html
        );
    };
    $bodyOut = $rewriteAttr($bodyOut, 'a',      'href');
    $bodyOut = $rewriteAttr($bodyOut, 'form',   'action');
}

echo $bodyOut;
