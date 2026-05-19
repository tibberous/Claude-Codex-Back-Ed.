"""Runway bridge — Gen-3 Alpha / Gen-4 video gen via app.runwayml.com.

NOT logged in by default — needs a one-time sign_in_helper.py runway
to bank session cookies. Runway uses a native email/password OR Google
SSO; native is preferred (Google SSO triggers the Google CAPTCHA path).
"""
from __future__ import annotations

import json
import time

SPEC = {
    "name": "runway",
    "kind": "web",
    "capabilities": {"videoGen": True, "fileSend": True, "fileReceive": True},
}

SELECTORS = {
    "composer": [
        'textarea[placeholder*="prompt" i]',
        'textarea[aria-label*="prompt" i]',
        'div[contenteditable="true"][role="textbox"]',
    ],
    "submit_button": [
        'button[aria-label*="Generate" i]',
        'button[data-testid="generate-button"]',
        'button[type="submit"]',
    ],
    "logged_in_check": 'textarea[placeholder*="prompt" i], [data-testid="generate-button"]',
    "login_email":    'input[name="usernameOrEmail"], input[name="email"], input[type="email"]',
    "login_password": 'input[name="password"], input[type="password"]',
    "login_submit":   'button[type="submit"]',
    "file_input":     'input[type="file"]',
    "result_video":   '.generation-result video[src], [data-testid="result-video"] video[src]',
}

LOGIN_STRATEGY = (
    "Runway has a native email/password login at app.runwayml.com/login. "
    "PREFER native: type email, click Continue, type password, click "
    "Sign in. Do NOT click 'Continue with Google' — that triggers "
    "Google's CAPTCHA path. If you don't have a Runway account, this "
    "bridge cannot proceed."
)


def custom_submitJob(mini, prompt: str, reference_files=None) -> dict:
    js_find = (
        "(function(){"
        "var sels = " + json.dumps(SELECTORS["composer"]) + ";"
        "for (var i=0;i<sels.length;i++) {var e=document.querySelector(sels[i]);"
        "if (e && e.getBoundingClientRect().width>2) return sels[i];}"
        "return null;})()"
    )
    composer_sel = mini.eval_js(js_find)
    if not composer_sel:
        return {"ok": False, "error": "runway composer not found — logged out or wrong page?"}

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
        return {"ok": False, "error": "Generate button missing/disabled (credits depleted?)"}

    time.sleep(3)
    return {"ok": True, "jobId": mini.final_url(), "submitted_at": time.time()}


def custom_pollJob(mini, jobId: str) -> dict:
    """Runway shows a progress UI while generating, then a result tile
    with a downloadable mp4. Typical generation 60-300s for Gen-4."""
    if mini.final_url() != jobId:
        mini.navigate(jobId)
        time.sleep(2)
    js = (
        "(function(){"
        "var v = document.querySelector('" + SELECTORS['result_video'].replace("'", "\\'") + "');"
        "if (v && v.src && v.src.indexOf('blob:') === -1) "
        "  return JSON.stringify({done: true, url: v.src});"
        "var err = document.querySelector('[role=\"alert\"], .error-banner');"
        "if (err) {var t = (err.innerText||'').slice(0,300); "
        "  if (t) return JSON.stringify({done: true, error: t});}"
        "return JSON.stringify({done: false});"
        "})()"
    )
    try:
        return json.loads(mini.eval_js(js) or '{"done": false}')
    except Exception as e:
        return {"done": False, "error": f"poll-js-eval: {type(e).__name__}: {e}"}
