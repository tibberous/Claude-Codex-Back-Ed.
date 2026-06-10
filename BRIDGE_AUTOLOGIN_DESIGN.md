# Bridge Auto-Login Design (read-only diagnosis)

Goal: when a browser bridge detects its profile is logged out, **auto-login**
(reuse the persistent profile + existing sign-in flow) and **retry** instead of
emitting `... composer not found — profile logged out? run tools/sign_in_helper.py chatgpt`.
ChatGPT is also CBE's shared "vision brain", so fixing chatgpt auto-login also
clears the misleading logged-out errors on DeepSeek/Copilot (they escalate to the
chatgpt brain tab, which is itself logged out).

This is **design only** — no code edited. All references are `file:line` so the
implementer can drop in the hook.

---

## 1. Architecture recap (how a chat round-trip flows today)

```
C++ tray (CBE-Bridge-<Target>.exe)
   └─ python bridges_cpp/bridge_pilot.py --target <t> --message "..."
        └─ start.driveBridgeChat(canon, prompt)                 start.py:1093
             ├─ plugin = _loadBridgePlugins().get(canon)        start.py:1104
             ├─ web-mode → mini = getMiniComputer(canon)        start.py:1123 / def @ 984
             │      └─ MiniComputer.launch()  (--headless=new)  cdp_minicomputer.py:379/398
             ├─ creds = _gptVisionPilotReadCredentials(canon)   start.py:1128 / def @ 3391
             ├─ plugin.drive_chat(mini, prompt, email, pw)      bridge_runner.py:248
             │      └─ custom_sendChat / send_chat              bridge.py:63 / runner:189
             └─ if not ok  → driveBridgeChatViaVisionPilot()    start.py:1142 / def @ 1164
                    └─ chatgpt FAST PATH (no vision)            start.py:1195
```

Every web target shares ONE per-target offscreen Chromium with a persistent
profile dir `data/minicomputer/<target>-profile` (`_miniComputerProfileDir`,
start.py:978). Cookies persist there, so a one-time visible sign-in via
`tools/sign_in_helper.py` makes every later headless run skip the login wall.
**Auto-login = do that sign-in programmatically, on demand, when a logged-out
state is detected — then retry the same round-trip once.**

---

## 2. Logged-out detection points (the hook sites)

There are **four** distinct places a logged-out profile surfaces. All four should
route into ONE new helper `ensureBridgeLoggedIn(canon)` (see §4). Quoting each:

| # | file:line | Code / message | Notes |
|---|-----------|----------------|-------|
| A | `start.py:1200-1202` | `if not _waitForSelector(mini, CHATGPT_COMPOSER, …): return {... "chatgpt composer not found — profile logged out? run tools/sign_in_helper.py chatgpt" ...}` | **THE error in the bug report.** chatgpt fast-path inside `driveBridgeChatViaVisionPilot`. Primary hook. |
| B | `bridges/_src/chatgpt/bridge.py:95-97` | `if not visible: return {... "chatgpt composer not found — profile logged out? run tools/sign_in_helper.py chatgpt" ...}` | The plugin `custom_sendChat` fast-path. Same message, different layer — both must be guarded or it loops. |
| C | `tools/bridge_runner.py:200-203` | `composer_sel = self._first_visible(...); if not composer_sel: return {... "composer not found — logged out? selectors stale?" ...}` | Generic runner `send_chat` for ALL plugin bridges (deepseek, grok, gemini, copilot). |
| D | `tools/bridge_runner.py:257-264` | `drive_chat`: `if not self.is_logged_in(mini): if not (email and password): return {... "logged out and no creds provided…"}` else `self.login(...)` | The runner already has a *native* login path; it just needs the visible-profile fallback when `login()` fails (CAPTCHA/SSO/magic-link). |

**Best single insertion point** (covers all four with least duplication):
`driveBridgeChat`, **start.py:1128-1131**, *before* the first `plugin.drive_chat`
call. Wrap it as:

```
creds = _gptVisionPilotReadCredentials(canon)           # existing, line 1128
result = plugin.drive_chat(mini, prompt, email=…, pw=…) # existing, line 1129
if _looksLoggedOut(result) and not _autologin_tried:    # NEW guard
    if ensureBridgeLoggedIn(canon):                     # NEW: visible sign-in + re-attach
        mini = getMiniComputer(canon, offscreen=True, autostart=True)  # re-grab fresh session
        result = plugin.drive_chat(mini, prompt, email=…, pw=…)        # ONE retry
```

`_looksLoggedOut(result)` = `not result.get("ok")` AND the error string contains
any of `("composer not found", "logged out", "post-login composer never appeared",
"login wall")`. Keep it a small registered tuple, not an if/elif chain (per house
style). This single guard catches B, C, and D because they all bubble up through
`plugin.drive_chat → driveBridgeChat`. **A** (the chatgpt fast-path inside the
vision pilot) needs the same guard locally because it's reached via the
escalation at start.py:1142, *after* `driveBridgeChat` already returned — see §5.

---

## 3. Credentials per site (what auto-login can use)

From `config.ini` via `_gptVisionPilotReadCredentials` (start.py:3391): per-target
section if present, else fall back to `[chatgpt]`.

| Target | config.ini section | Login type | Auto-login viability |
|--------|--------------------|-----------|----------------------|
| **chatgpt** | `[chatgpt]` email / password (from config.ini, gitignored) | **Native OpenAI email+password** (LOGIN_STRATEGY explicitly says do NOT route through Google) | Good — native form, vision pilot already drives it. |
| **deepseek** | falls back to `[chatgpt]` | **Native email+password** (chat.deepseek.com/sign_in has both fields) | Good — runner `login()` can fill it; vision fallback solid. |
| **grok** | falls back to `[chatgpt]` | Native xAI/X email+password (LOGIN_STRATEGY: do NOT use Google SSO) | Good — native form. `[x]` section also exists for X creds. |
| **copilot** | falls back to `[chatgpt]` | **Microsoft account** (login.live.com). Note `[bing]`/`[bing-video]` use `tibberous@hotmail.com` — copilot may need the Hotmail MS account, NOT the Gmail. | Medium — MS SSO; native-form on login.live.com works but watch account picker. |
| **gemini** | falls back to `[chatgpt]` | **Google SSO** (accounts.google.com) | Hard — Google SSO automation hits "unusual activity"/CAPTCHA. |
| **claude** | falls back to `[chatgpt]` | **Magic-link OR Google SSO**, no native password | Hardest — magic-link needs inbox; flagged below. |

**House-rule constraint (`feedback_no_fragile_credential_injection`):** auto-login
must NOT autofill via fragile JS injection. The design below reuses the
**persistent profile + the existing sign_in_helper/vision flow** — it never does
`document.querySelector(pw).value = …` from JS. The runner's `_set_input_value`
path (bridge_runner.py:169/176) is CDP `Input.insertText` into a focused field,
which is the existing accepted mechanism — acceptable, but the *preferred*
auto-login is the visible-profile sign-in (§4), which types nothing itself.

---

## 4. How to invoke offscreen sign-in programmatically (reuse sign_in_helper)

`tools/sign_in_helper.py` is **CLI-only today** — its login logic lives entirely
inside `main()` (sign_in_helper.py:68) behind two `input()` prompts (lines 92,
116). It cannot be imported and called as-is. Two options:

### Option A (recommended) — add a headless-auto entrypoint, reuse via subprocess OR import

Refactor `sign_in_helper.py` to expose a function (no `input()` in the hot path):

```python
def autoSignIn(target: str, visible: bool = True, timeout_s: int = 180) -> dict:
    """Programmatic sign-in. Reuses the SAME profile dir the pilot attaches to
    (_miniComputerProfileDir). For native-form targets, drives the login via the
    bridge_runner.login() path (CDP, no fragile JS). For SSO/magic-link targets,
    pops VISIBLE chrome and drives it with the gpt_vision_pilot (CAPTCHA-capable),
    falling back to a human wait only if vision FAILs.
    Returns {ok, target, method, error?}."""
```

`driveBridgeChat` then calls a thin wrapper:

```python
def ensureBridgeLoggedIn(canon: str) -> bool:
    # 1. Profile must be unlocked → tear down the cached headless mini first
    _teardownMini(canon)               # close the offscreen chrome holding the lock
    # 2. Reuse existing creds + login strategy
    r = autoSignIn(canon, visible=_needsVisibleLogin(canon))
    return bool(r.get("ok"))
```

`_needsVisibleLogin(canon)` = True for `gemini`/`claude`/`copilot` (SSO /
magic-link), False for `chatgpt`/`deepseek`/`grok` (native form → headless CDP
login via `bridge_runner.login()` is enough and stays invisible).

**Critical profile-lock rule:** the offscreen chrome and the sign-in chrome
share `data/minicomputer/<target>-profile` and Chrome holds a single-writer lock
on it (`sign_in_helper.py:16` "make sure the per-target tray exe is NOT running").
So `ensureBridgeLoggedIn` MUST:
1. drop the cached MiniComputer (`_MINICOMPUTER_CACHE.pop(canon)` + `mini.terminate()`),
2. ALSO ensure the C++ tray's chrome for that target is not holding the lock —
   the tray spawns its own chrome on `g_port+1000`. The cleanest path is to reuse
   the SAME cdp_port (`MINICOMPUTER_CDP_PORTS[canon]`) and let `_cdpAlive()`
   (cdp_minicomputer.py:383) **attach** to the already-running chrome instead of
   spawning a second one — then just `navigate()` it to the login URL in the same
   tab. This sidesteps the lock entirely and is the LEAST fragile approach.

### Option B (fastest to ship) — subprocess the existing CLI with auto-confirm

If refactoring sign_in_helper is out of scope for the editing agents right now,
the interim is to shell `python tools/sign_in_helper.py <target>` — but it
`input()`-blocks, so this needs an `--auto` flag added that skips the prompts and
uses a fixed timeout. Either way **sign_in_helper.py needs a non-interactive
path** — it has none today. Recommend Option A.

### Reusing the existing login mechanics (do NOT rewrite them)

- Native-form login already exists: `bridge_runner.Bridge.login()` (bridge_runner.py:155-186)
  navigates `login_url`, fills `login_email`/`login_password`, clicks `login_submit`.
- Vision-driven login already exists: `driveBridgeChatViaVisionPilot` builds a full
  login goal incl. CAPTCHA-solving + SSO-in-same-tab instructions (start.py:1248-1337).
  `autoSignIn` for SSO targets should call `gpt_vision_pilot.pilot()` with that same
  goal but `max_steps` capped low and `DONE` = "composer visible" — then return.
- `LOGIN_URLS` (sign_in_helper.py:47) is the canonical per-target login surface — reuse it.

---

## 5. Retry / guard logic (avoid infinite login↔fail loop)

Hard cap: **at most ONE auto-login attempt per chat round-trip.** Pattern:

```python
def driveBridgeChat(target, prompt, max_steps=20):
    canon = normalizeChatTarget(target)
    plugin = ...
    mini = getMiniComputer(canon, ...)
    creds = _gptVisionPilotReadCredentials(canon)

    for attempt in (0, 1):                     # 0 = first try, 1 = post-login retry
        result = plugin.drive_chat(mini, prompt, email=…, pw=…) or {}
        if result.get("ok") or not _looksLoggedOut(result):
            break
        if attempt == 1:                        # already retried once → give up
            result["error"] = f"couldn't auto-login to {canon}: {result.get('error','')}"
            break
        if not ensureBridgeLoggedIn(canon):     # visible/headless sign-in
            result["error"] = f"couldn't auto-login to {canon} (sign-in failed): {result.get('error','')}"
            break
        mini = getMiniComputer(canon, offscreen=True, autostart=True)  # fresh attach post-login
    ...
```

Guards / safeguards:
- **One-attempt counter** (`for attempt in (0,1)`), never a `while`.
- **Detect the SAME failure twice** — if post-login the result is still
  `_looksLoggedOut`, surface the clear `couldn't auto-login to X` error and STOP.
  Don't re-escalate to the vision pilot in an endless cycle.
- **The vision-pilot escalation at start.py:1142** must NOT independently re-trigger
  auto-login — gate it behind the same per-call flag so the chain
  `plugin-fail → autologin → retry-fail → vision-pilot → fast-path(A)-logged-out`
  cannot recurse. The fast-path block A (start.py:1200) should, on logged-out,
  simply return the clear error (auto-login was already attempted upstream).
- **Profile-lock timeout:** if `ensureBridgeLoggedIn` can't unlock the profile (tray
  chrome still holding it), return False fast with a clear error rather than hanging.
- **Loop-breaker on creds-missing:** if `_gptVisionPilotReadCredentials` returns empty
  email/password, skip auto-login entirely and emit
  `"logged out and no creds in config.ini for X — add [X] email/password"`.

---

## 6. Per-site notes summary

- **chatgpt** = native OpenAI email+pw (`[chatgpt]`). Headless CDP login viable; do
  NOT route through Google SSO (LOGIN_STRATEGY, start.py:1259). This is the brain
  tab — fixing it clears deepseek/copilot misleading errors.
- **deepseek** = native email+pw, headless login viable.
- **grok** = native xAI/X email+pw, headless viable; do NOT use Google SSO.
- **copilot** = Microsoft account (login.live.com). May need the **Hotmail** account
  (`[bing]` tibberous@hotmail.com), not the Gmail — verify before relying on the
  `[chatgpt]` fallback. Visible-login recommended (account picker).
- **gemini** = Google SSO. **Visible** auto-login + vision pilot; expect
  CAPTCHA/"unusual activity" friction.
- **claude** = magic-link OR Google SSO, **no native password**. Auto-login mostly
  CANNOT complete unattended (needs inbox for the email code). For claude, auto-login
  should attempt Google SSO via vision once, and on failure surface
  `"claude needs a one-time manual sign-in: python tools/sign_in_helper.py claude"`
  rather than looping. Keep the manual helper as the documented escape hatch.

---

## 7. Risks / flags

1. **Fragile credential injection (house rule):** keep auto-login on the
   profile-reuse + CDP-`Input.insertText` path (bridge_runner login) or the visible
   sign-in flow. Do NOT add `el.value = password` JS injection. The vision pilot's
   existing `TYPE` action and the runner's `_set_input_value` are the only accepted
   typing paths.
2. **Google SSO difficulty (gemini/claude):** automated Google login frequently
   trips "unusual activity"/CAPTCHA on a headless-looking residential profile. The
   start.py:1310 guidance (navigate to accounts.google.com in the SAME tab, never
   click the popup SSO button) is correct and must be preserved — but success is not
   guaranteed; both must degrade to a clear manual-signin message, not a loop.
3. **Profile single-writer lock:** the #1 implementation hazard. The C++ tray chrome
   and any sign-in chrome fight over `data/minicomputer/<target>-profile`. Prefer
   **attach-and-navigate** on the existing CDP port (`_cdpAlive()` → attach,
   cdp_minicomputer.py:383) over spawning a second chrome. Spawning a second writer
   on a locked profile silently fails or corrupts cookies.
4. **Azure-only policy vs the vision brain (`feedback_azure_only_save_veo_budget`):**
   the chatgpt "vision brain" fast-path drives chatgpt.com through the *browser
   bridge* (logged-in web UI), which is NOT a billed OpenAI API call — so it does NOT
   violate the Azure-only rule. BUT the vision-pilot fallback (`gpt_vision_pilot.pilot`,
   start.py:1240) screenshots + calls GPT-4o for navigation. Confirm that GPT-4o call
   routes through Azure, not OpenAI-direct, before leaning on the vision path for
   auto-login at scale. If it's OpenAI-direct, prefer the native-form headless login
   for chatgpt/deepseek/grok and reserve vision for SSO targets only.
5. **Two duplicate logged-out messages (A at start.py:1200, B at bridge.py:95):**
   identical strings in two layers. Fixing only one leaves the other able to surface
   the stale "run sign_in_helper" message. Update both call sites (or route both
   through the new guard) — per the house "fix ALL instances" rule.

---

## 8. Exact insertion checklist (for the implementer)

1. **start.py:1128-1131** — wrap `plugin.drive_chat` in the `for attempt in (0,1)`
   loop with `_looksLoggedOut()` + `ensureBridgeLoggedIn()` + re-`getMiniComputer`.
2. **NEW in start.py** — `def _looksLoggedOut(result)`, `def ensureBridgeLoggedIn(canon)`,
   `def _teardownMini(canon)`, `def _needsVisibleLogin(canon)`.
3. **tools/sign_in_helper.py** — extract login body of `main()` into
   `def autoSignIn(target, visible=True, timeout_s=180) -> dict` (no `input()`);
   keep `main()` as the interactive wrapper.
4. **start.py:1200-1202** (chatgpt fast-path A) — on logged-out, return the clear
   `couldn't auto-login` error (don't re-emit the stale sign_in_helper hint; auto-login
   already ran upstream). Gate against re-entrancy.
5. **bridges/_src/chatgpt/bridge.py:95-97** (B) — same: let the upstream guard own
   auto-login; this layer just returns a clean logged-out signal that `_looksLoggedOut`
   recognizes.
6. **Do NOT** add JS credential injection anywhere. Reuse profile + runner login +
   vision flow only.
