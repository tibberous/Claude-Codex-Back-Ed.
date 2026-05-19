"""Bing Video Creator bridge — free Sora-2 via Microsoft.

Reuses the copilot bridge's Microsoft account login. If sign_in_helper.py
was run for copilot, this bridge is already authed.

Daily-rate-limited by Microsoft (typically 5-10 generations per day per
free account; "Boosts" reset every ~24h). The bridge surfaces the
remaining-Boosts count in the result dict so the caller can warn the user.
"""
from __future__ import annotations

import json
import time

SPEC = {
    "name": "bing-video",
    "kind": "web",
    "capabilities": {"videoGen": True, "fileReceive": True},
}

SELECTORS = {
    "composer": [
        'textarea[placeholder*="Describe" i]',
        'textarea[aria-label*="prompt" i]',
        'textarea[name="q"]',
        'input[type="search"]',
    ],
    "submit_button": [
        'button[aria-label*="Create" i]',
        'button[aria-label*="Generate" i]',
        'button[type="submit"]',
        'button.create-btn',
    ],
    "logged_in_check": 'textarea[placeholder*="Describe" i], textarea[name="q"]',
    "result_video": 'video[src]',
    # Bing shows remaining Boosts as a badge
    "boost_counter": '[data-tname*="boost" i], .boost-count, [aria-label*="boost" i]',
}

LOGIN_STRATEGY = (
    "Bing Video Creator uses your Microsoft account — the same one the "
    "Copilot bridge uses. If logged out, navigate to login.live.com, "
    "type the email, Next, type the password, Next. Then go back to "
    "bing.com/videos/create — your session carries over automatically."
)


def custom_submitJob(mini, prompt: str, reference_files=None) -> dict:
    """Type prompt, click Create, return jobId (current url + a timestamp).
    Bing creates a new generation tile in the user's history; we treat
    the URL after submit as the job identity."""
    js_find = (
        "(function(){"
        "var sels = " + json.dumps(SELECTORS["composer"]) + ";"
        "for (var i=0;i<sels.length;i++) {var e=document.querySelector(sels[i]);"
        "if (e && e.getBoundingClientRect().width>2) return sels[i];}"
        "return null;})()"
    )
    composer_sel = mini.eval_js(js_find)
    if not composer_sel:
        return {"ok": False, "error": "bing composer not found — logged out?"}

    mini.eval_js(f"document.querySelector('{composer_sel}').focus();")
    time.sleep(0.3)
    mini.type_text(prompt)
    time.sleep(0.5)

    click_js = (
        "(function(){"
        "var sels = " + json.dumps(SELECTORS["submit_button"]) + ";"
        "for (var i=0;i<sels.length;i++) {var b=document.querySelector(sels[i]);"
        "if (b && !b.disabled) {b.click(); return sels[i];}}"
        "return null;})()"
    )
    if not mini.eval_js(click_js):
        return {"ok": False, "error": "Create button missing or disabled (out of Boosts?)"}

    time.sleep(3)
    return {"ok": True, "jobId": mini.final_url(), "submitted_at": time.time()}


def custom_pollJob(mini, jobId: str) -> dict:
    """Poll the current page for a finished <video> element. Bing renders
    a placeholder + spinner while generating, then swaps in a real
    <video src="...mp4">. Generation typically takes 60-180 seconds."""
    if mini.final_url() != jobId:
        mini.navigate(jobId)
        time.sleep(2)
    js = (
        "(function(){"
        "var v = document.querySelector('video[src]');"
        "if (v && v.src && v.src.indexOf('blob:') === -1 && v.src.indexOf('.mp4') >= 0) "
        "  return JSON.stringify({done: true, url: v.src});"
        "var err = document.querySelector('[role=\"alert\"], .err-text, [class*=\"limit\" i]');"
        "if (err) {var t = (err.innerText||'').slice(0,300); "
        "  if (t.toLowerCase().indexOf('limit') >= 0 || t.toLowerCase().indexOf('boost') >= 0) "
        "    return JSON.stringify({done: true, error: 'daily limit reached: ' + t});"
        "  if (t) return JSON.stringify({done: true, error: t});}"
        "return JSON.stringify({done: false});"
        "})()"
    )
    try:
        return json.loads(mini.eval_js(js) or '{"done": false}')
    except Exception as e:
        return {"done": False, "error": f"poll-js-eval: {type(e).__name__}: {e}"}
