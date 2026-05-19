"""Sora 2 bridge — async video generation via sora.com.

NOT a chat bridge. The runner detects videoGen mode="async" in the
manifest and uses the custom_submitJob + custom_pollJob hooks instead
of the normal chat round-trip.

Selectors are best-effort 2026-05 — Sora's UI rotates frequently. If
generations fail, run `tools/sign_in_helper.py sora` and verify the
composer at sora.com manually first, then update SELECTORS below.
"""
from __future__ import annotations

import time

SPEC = {
    "name": "sora",
    "kind": "web",
    "capabilities": {"videoGen": True, "fileSend": True, "fileReceive": True},
}

SELECTORS = {
    # The Sora composer — a text field for the prompt
    "composer": [
        'textarea[placeholder*="Describe" i]',
        'textarea[placeholder*="video" i]',
        '[data-testid="prompt-input"]',
        'div[contenteditable="true"]',
    ],
    # Submit / Generate button
    "submit_button": [
        'button[aria-label*="Generate" i]',
        'button[data-testid="generate-button"]',
        'button[type="submit"]',
    ],
    # Indicates user is signed in (the composer is only on the logged-in surface)
    "logged_in_check": 'textarea[placeholder*="Describe" i], [data-testid="prompt-input"]',
    # Optional reference image
    "file_input": 'input[type="file"]',
    # After a job completes, a <video> element appears with the result.
    # The first <video src="..."> in the library/feed is the most recent.
    "result_video": "video[src]",
}

LOGIN_STRATEGY = (
    "Sora reuses OpenAI/ChatGPT credentials. If logged out, click "
    "'Sign in' or 'Log in', then use the same email/password as ChatGPT. "
    "Sora typically auto-detects an existing chatgpt.com session in the "
    "same chrome profile, so if sign_in_helper.py was run for chatgpt, "
    "sora is usually already authed."
)


def custom_submitJob(mini, prompt: str, reference_files: list[str] | None = None) -> dict:
    """Type the prompt, optionally attach a reference image/video, click
    Generate, return {ok, jobId}. jobId is the URL of the in-progress
    job page (sora.com/g/<id>) — we'll poll it via custom_pollJob.
    """
    # Find composer
    js_find = (
        "(function(){"
        "var sels = " + str(SELECTORS["composer"]) + ";"
        "for (var i=0;i<sels.length;i++) {var e=document.querySelector(sels[i]);"
        "if (e && e.getBoundingClientRect().width>2) return sels[i];}"
        "return null;})()"
    )
    composer_sel = mini.eval_js(js_find)
    if not composer_sel:
        return {"ok": False, "error": "sora composer not found — logged out?"}

    mini.eval_js(f"document.querySelector('{composer_sel}').focus();")
    time.sleep(0.3)
    mini.type_text(prompt)
    time.sleep(0.5)

    # Attach reference files if provided
    if reference_files:
        for path in reference_files:
            # uses CDP DOM.setFileInputFiles via bridge_runner helper
            # (caller will run this — left as stub for now)
            pass

    # Click submit
    click_js = (
        "(function(){"
        "var sels = " + str(SELECTORS["submit_button"]) + ";"
        "for (var i=0;i<sels.length;i++) {var b=document.querySelector(sels[i]);"
        "if (b && !b.disabled) {b.click(); return sels[i];}}"
        "return null;})()"
    )
    clicked = mini.eval_js(click_js)
    if not clicked:
        return {"ok": False, "error": "Generate button missing or disabled"}

    # Wait a moment for navigation to the job page
    time.sleep(3)
    return {"ok": True, "jobId": mini.final_url(), "submitted_at": time.time()}


def custom_pollJob(mini, jobId: str) -> dict:
    """Check if the job at `jobId` has produced a video. Returns:
        {done: true,  url: "<mp4 url>"}  when ready
        {done: false}                     while still generating
        {done: true,  error: "..."}      on failure
    """
    # If we're not already on the job page, navigate.
    if mini.final_url() != jobId:
        mini.navigate(jobId)
        time.sleep(2)

    # Check for the result video element
    js = (
        "(function(){"
        "var v = document.querySelector('" + SELECTORS["result_video"] + "');"
        "if (v && v.src && v.src.indexOf('blob:') === -1) return JSON.stringify({done: true, url: v.src});"
        # Check for a generic error banner
        "var err = document.querySelector('[role=\"alert\"], .error-message, [class*=\"error\" i]');"
        "if (err) return JSON.stringify({done: true, error: (err.innerText||'').slice(0,200)});"
        # Otherwise still generating
        "return JSON.stringify({done: false});"
        "})()"
    )
    try:
        import json
        return json.loads(mini.eval_js(js) or '{"done": false}')
    except Exception as e:
        return {"done": False, "error": f"poll-js-eval: {type(e).__name__}: {e}"}
