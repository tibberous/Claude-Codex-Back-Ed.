"""Veo bridge — Google Veo 2/3 video gen via gemini.google.com.

Veo lives inside Gemini's web app as a special "Video" mode. The bridge
first clicks the Video chip to enter Veo mode, then types the prompt
in the same composer Gemini chat uses, then waits for the rendered
video tile to appear in the conversation.

Reuses the gemini bridge's persistent profile (data/minicomputer/veo-profile
gets a fresh login, OR — preferred — set USE_GEMINI_PROFILE=True to
share with the gemini bridge so one sign-in covers both).
"""
from __future__ import annotations

import json
import time

SPEC = {
    "name": "veo",
    "kind": "web",
    "capabilities": {"videoGen": True, "fileSend": True, "fileReceive": True},
}

SELECTORS = {
    # Gemini composer is a Quill ProseMirror editor
    "composer": [
        'rich-textarea .ql-editor[contenteditable="true"]',
        'rich-textarea div.ql-editor',
        '.ql-editor[contenteditable="true"]',
    ],
    # Submit / Send button in Gemini's UI
    "submit_button": [
        'button[aria-label*="Send" i]',
        'button.send-button',
        'button[mat-icon-button][aria-label*="Send"]',
    ],
    # The "Video" capability chip / pill at the top of the composer
    "video_mode_chip": [
        '[data-mode="video" i]',
        'button[aria-label*="Video" i]',
        'mat-chip[aria-label*="Video" i]',
    ],
    # Logged-in tripwire: Gemini composer only exists on the signed-in surface
    "logged_in_check": 'rich-textarea .ql-editor[contenteditable="true"]',
    # Reference image input
    "file_input": 'input[type="file"]',
    # Veo emits its result as an HTML5 video tile in the conversation
    "result_video": 'model-response video[src], .model-response video[src]',
}

LOGIN_STRATEGY = (
    "Veo lives inside Gemini's UI. Login = Google account. If logged "
    "out, navigate to https://accounts.google.com/signin, type the "
    "email, Next, type the password, Next. Then navigate back to "
    "https://gemini.google.com/app — the session carries over. Once on "
    "the Gemini surface, the Veo Video mode is selected by clicking the "
    "'Video' chip in the input bar before typing your prompt."
)


def _enter_veo_mode(mini):
    """Click the Video pill if it's there and not already active."""
    js = (
        "(function(){"
        "var sels = " + json.dumps(SELECTORS["video_mode_chip"]) + ";"
        "for (var i=0;i<sels.length;i++) {"
        "  var c = document.querySelector(sels[i]);"
        "  if (c) {"
        "    var pressed = c.getAttribute('aria-pressed');"
        "    if (pressed !== 'true' && pressed !== 'True') c.click();"
        "    return sels[i];"
        "  }"
        "}"
        "return null;"
        "})()"
    )
    return mini.eval_js(js)


def custom_submitJob(mini, prompt: str, reference_files=None) -> dict:
    """Enter Veo mode, type prompt, click Send. Job ID is the URL."""
    _enter_veo_mode(mini)
    time.sleep(1.0)

    js_find = (
        "(function(){"
        "var sels = " + json.dumps(SELECTORS["composer"]) + ";"
        "for (var i=0;i<sels.length;i++) {var e=document.querySelector(sels[i]);"
        "if (e && e.getBoundingClientRect().width>2) return sels[i];}"
        "return null;})()"
    )
    composer_sel = mini.eval_js(js_find)
    if not composer_sel:
        return {"ok": False, "error": "gemini composer not found — logged out?"}

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
        return {"ok": False, "error": "Send button missing or disabled"}

    time.sleep(2)
    return {"ok": True, "jobId": mini.final_url(), "submitted_at": time.time()}


def custom_pollJob(mini, jobId: str) -> dict:
    """Veo renders a generation placeholder while running, swaps to a
    real <video> when done. Typical generation 30-120s."""
    if mini.final_url() != jobId:
        mini.navigate(jobId)
        time.sleep(2)
    js = (
        "(function(){"
        "var v = document.querySelector('" + SELECTORS['result_video'].replace("'", "\\'") + "');"
        "if (v && v.src && v.src.indexOf('blob:') === -1) "
        "  return JSON.stringify({done: true, url: v.src});"
        "var err = document.querySelector('[role=\"alert\"], .gmat-banner-error');"
        "if (err) {var t = (err.innerText||'').slice(0,300); "
        "  if (t) return JSON.stringify({done: true, error: t});}"
        "return JSON.stringify({done: false});"
        "})()"
    )
    try:
        return json.loads(mini.eval_js(js) or '{"done": false}')
    except Exception as e:
        return {"done": False, "error": f"poll-js-eval: {type(e).__name__}: {e}"}
