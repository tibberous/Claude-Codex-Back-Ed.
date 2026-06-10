# DeepSeek Browser-Bridge Bug — Diagnosis Report

**Date:** 2026-06-04
**Symptom:** Selecting the DeepSeek provider ("DeepSeek (browser bridge) · deepseek-chat") starts the bridge,
status bar shows `CBE: streaming [DeepSeek]` / `bridge → deepseek`, then fails with:

```
[bridge_pilot.py error] HTTP 599: chatgpt.com composer not found — driver tab is logged out or wrong page
```

**TL;DR:** DeepSeek does **NOT** actually drive chatgpt.com. The DeepSeek *target* tab is wired correctly
(right URL `https://chat.deepseek.com/`, right port 9794, right selectors). What fails is the **vision pilot's
"brain"** — the pilot uses a logged-in **chatgpt.com tab as its GPT-4o vision model**, and *that* chatgpt.com
driver tab is logged out / on the wrong page. The error text is about the **brain tab**, not the DeepSeek
target. It only surfaces for DeepSeek because the DeepSeek selector plugin fails first (no login / stale
selectors), which escalates into the vision-pilot path that needs the chatgpt brain.

---

## Root cause (call chain, with file:line)

1. **DeepSeek selector plugin runs first and fails.**
   `start.py:1123` → `getMiniComputer("deepseek")` attaches to the DeepSeek chrome (port 9794, URL
   `https://chat.deepseek.com/` — both correct, `start.py:954` and `start.py:970`).
   `start.py:1129` → `plugin.drive_chat(...)` calls `bridge_runner.py` `send_chat()`.
   If the DeepSeek composer selector doesn't match — because the profile is **logged out** (there are
   **no DeepSeek credentials** in `config.ini`, see below) or the selectors are stale — it returns:
   `bridge_runner.py:202` → `{"ok": False, "error": "composer not found — logged out? selectors stale?"}`.

2. **Failure escalates to the GPT-4o vision pilot.**
   `start.py:1142` →
   ```python
   if not result.get("ok") and plugin.manifest.kind != "api":
       ... -> escalating to GPT-4o vision pilot
       visionResult = driveBridgeChatViaVisionPilot(target, prompt, max_steps=max_steps)
   ```

3. **The vision pilot uses chatgpt.com as its "brain", not api.openai.com.**
   `gpt_vision_pilot.py:402-414` (inside `pilot()`):
   ```python
   if driver_mini is None:
       ...
       if target_canon != "chatgpt":  # don't drive chatgpt with itself (recursion)
           driver_mini = _getMini("chatgpt", offscreen=True, autostart=True)
   ```
   So for the DeepSeek target it auto-attaches a **chatgpt.com** MiniComputer (CDP port 9788) to act as the
   vision model. The pilot screenshots the DeepSeek page and uploads it **into chatgpt.com** to ask "what should
   I click next?". See module docstring `web_vision_driver.py:1-19` ("uses the user's logged-in chatgpt.com Plus
   session ... as the pilot's brain instead of api.openai.com").

4. **The chatgpt.com brain tab is logged out / wrong page → the exact error.**
   `web_vision_driver.py:113-125` (`driveOneTurn`):
   ```python
   if not _waitForSelector(driver_mini, CHATGPT_COMPOSER, timeout_s=15.0):
       return {"ok": False, "error": "chatgpt.com composer not found — driver tab is logged out or wrong page"}
   ```
   where `CHATGPT_COMPOSER = "#prompt-textarea"` (`web_vision_driver.py:37`).

5. **That error is wrapped as HTTP 599 and bubbled up.**
   `gpt_vision_pilot.py:548`:
   ```python
   status, body = 599, {"error": web_result.get("error", "web driver failed"), "_raw": web_result}
   ```
   → `gpt_vision_pilot.py:561-568` formats it as `HTTP 599: <err_detail>` → returned through
   `driveBridgeChatViaVisionPilot` → `driveBridgeChat` → `bridge_pilot.py:110` → printed by the C++ tray as
   `[bridge_pilot.py error] HTTP 599: chatgpt.com composer not found — driver tab is logged out or wrong page`.

**Conclusion:** DeepSeek is correctly targeted. The misleading "chatgpt.com" in the error refers to the
**vision-pilot brain tab**, which is the shared GPT-4o-via-web mechanism used by *every* browser target's
fallback path. The real failure is two-fold: (a) the DeepSeek selector plugin can't log in/find the composer,
forcing the vision fallback; (b) that fallback's chatgpt.com brain tab is itself logged out.

---

## What is wrong / missing (the actual config gaps)

### A. No DeepSeek credentials in `config.ini` (primary trigger)
- `config.ini:19` → `deepseek_api_key =` (empty).
- There is **no `[deepseek]` section** with `email`/`password`, unlike `[chatgpt]` (`config.ini:137-139`),
  `[bing]` (141-143), `[bing-video]` (145-147).
- `_gptVisionPilotReadCredentials("deepseek")` (`start.py:3391-3411`) therefore finds no `[deepseek]` section
  and **falls back to the `[chatgpt]` Gmail creds** (`start.py:3405-3408`). DeepSeek's own login strategy
  explicitly says to use **native email+password and AVOID Google SSO** (`bridges/_src/deepseek/bridge.py:29-35`,
  and `start.py:1255-1258`), so the chatgpt-Gmail fallback can't satisfy DeepSeek's native form.
- Net effect: the DeepSeek tab never logs in → composer selector never matches → plugin fails → vision escalation.

### B. The chatgpt.com brain tab is logged out (the visible error)
- The vision pilot's brain depends on a **logged-in chatgpt.com profile** at MiniComputer profile
  `data/minicomputer/chatgpt-profile` (CDP 9788). If that profile is logged out, EVERY browser target's
  vision fallback dies with this same message — DeepSeek just happens to be the one that always reaches the
  fallback because of gap (A).
- Fix per the in-code hint: `web_vision_driver.py` / `start.py:1201` →
  `run tools/sign_in_helper.py chatgpt` to re-establish the chatgpt brain session.

### C. (Policy note, not a bug) The vision brain uses chatgpt.com, violating the Azure-only rule
- The whole `web_vision_driver` path routes vision reasoning through chatgpt.com instead of Azure GPT. This is
  the architectural reason the error even mentions chatgpt.com. Out of scope for this bug but worth flagging:
  per the Azure-only policy the vision brain should eventually point at Azure, not a logged-in chatgpt.com tab.

---

## The CORRECT DeepSeek target (already present and correct)

The DeepSeek target wiring is **not** the bug — it is already correct in the repo:

- **URL:** `https://chat.deepseek.com/` — `start.py:954` (`MINICOMPUTER_START_URLS`), `start.py:300`
  (`DEFAULT_DEEPSEEK_URL`).
- **CDP port:** `9794` — `start.py:970` (`MINICOMPUTER_CDP_PORTS`); tray bridge port `8794` — `start.py:386`.
- **Selectors** — `bridges/_src/deepseek/bridge.py:10-27`:
  - composer: `textarea[placeholder*="Message" i]`, `textarea[placeholder*="Send a message" i]`, `form textarea`
  - send_button: `button[aria-label*="Send" i]`, `form button[type="submit"]`, `div[class*="ds-button"][role="button"]`
  - logged_in_check: `textarea[placeholder*="Message" i], form textarea`
  - login_email: `input[type="email"], input[type="text"][placeholder*="mail" i]`
  - login_password: `input[type="password"]`
  - login_submit: `div[class*="ds-button"], button[type="submit"]`

These selectors exist and look reasonable. They are not the failure point — the failure is the **missing login
credentials** (gap A) which prevents the composer from ever appearing, plus the **logged-out chatgpt brain**
(gap B) that the resulting fallback hits.

---

## Exact fix

### Fix 1 (primary) — give DeepSeek real credentials so its own selector plugin logs in
Add a `[deepseek]` section to `config.ini` (mirroring `[chatgpt]` at `config.ini:137-139`) with a **real
DeepSeek account** (native email+password — NOT the Gmail, since DeepSeek's strategy forbids Google SSO):

```ini
[deepseek]
email = <deepseek-account-email>
password = <deepseek-account-password>
```

With this present, `_gptVisionPilotReadCredentials("deepseek")` (`start.py:3401-3404`) picks the `[deepseek]`
section instead of falling back to `[chatgpt]`, and `bridge_runner` `login()` (`bridge_runner.py:161-186`) can
drive DeepSeek's native form. The selector plugin then finds the composer and **never reaches the vision
fallback**, so the chatgpt.com error disappears.

*Alternatively / additionally:* sign into DeepSeek once by hand into the persistent profile so cookies persist:
```
python tools/sign_in_helper.py deepseek
```
(stop the DeepSeek tray exe first so it doesn't lock `data/minicomputer/deepseek-profile`).

### Fix 2 (secondary) — re-establish the chatgpt.com vision brain
So the vision fallback works for DeepSeek *and every other* browser target:
```
python tools/sign_in_helper.py chatgpt
```
This makes the `#prompt-textarea` composer appear in the brain tab, clearing
`web_vision_driver.py:125`.

### Fix 3 (optional hardening) — make the error self-explaining
The message at `web_vision_driver.py:125` is misleading because it appears even when the *target* is DeepSeek.
Suggest disambiguating it so future debugging is instant, e.g.:
```python
return {"ok": False, "error": "vision-pilot BRAIN tab (chatgpt.com) composer not found — "
        "the chatgpt brain is logged out; run tools/sign_in_helper.py chatgpt (this is NOT the target tab)"}
```
And at `start.py:1142`, the escalation log already prints `target=deepseek`; consider surfacing that target
name into the final HTTP-599 message so the user sees "DeepSeek fell back to the chatgpt vision brain" rather
than a bare "chatgpt.com composer not found".

---

## Summary of file:line references
- `start.py:954` / `start.py:300` — DeepSeek target URL (correct).
- `start.py:970` / `start.py:386` — DeepSeek CDP 9794 / bridge 8794 (correct).
- `start.py:1142-1145` — escalation from failed selector plugin to vision pilot.
- `gpt_vision_pilot.py:402-414` — vision pilot auto-attaches **chatgpt.com** as the brain.
- `web_vision_driver.py:37,113-125` — chatgpt brain composer check + the exact error string.
- `gpt_vision_pilot.py:548,561-568` — wraps brain error as `HTTP 599`.
- `bridge_runner.py:200-203` — DeepSeek selector plugin "composer not found" that triggers escalation.
- `start.py:3391-3411` — credential read; **falls back to `[chatgpt]`** when no `[deepseek]` section.
- `config.ini:19` — empty `deepseek_api_key`; **no `[deepseek]` section** (the missing config).
- `bridges/_src/deepseek/bridge.py:10-35` — correct DeepSeek selectors + native-login strategy.
