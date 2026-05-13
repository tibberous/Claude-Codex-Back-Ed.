"""
Hook File: github_hook.py

What it does:
    Comprehensive GitHub REST API v3 wrapper. Drives nearly every category
    the API exposes — repos, branches, contents, commits, refs, tags,
    releases, issues, pull requests, reviews, comments, workflows + runs,
    Actions/Codespaces/Dependabot secrets + variables, webhooks, packages,
    deploy keys, collaborators, teams, orgs, labels, milestones, gists,
    notifications, stars/watch, search (code/repos/issues/users/commits),
    code scanning alerts, Dependabot alerts, secret-scanning alerts,
    codespaces, user profile, and rate-limit / API root introspection.

Configuration:
    PAT loaded from <ext-root>/config.ini  [github] token = ...
    (env var GITHUB_TOKEN is used as fallback). NEVER hardcoded.
    See hooks/_config.py for the loader.

How to use it:
    python github_hook.py <category> <action> [args]
    python github_hook.py help                       # list every command
    python github_hook.py repos list
    python github_hook.py repos get owner/repo
    python github_hook.py issues create owner/repo "Title" "Body"
    python github_hook.py workflows dispatch owner/repo ci.yml main
    python github_hook.py search code 'q=addEventListener+language:js'
    python github_hook.py releases create owner/repo v1.0.0 "release notes"
    python github_hook.py raw GET /user                      # arbitrary call
    python github_hook.py raw POST /repos/o/r/issues '{"title":"x"}'

(c) 2026 Trenton Tompkins. MIT.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import Any, Iterable
from urllib import request as _urlreq, parse as _urlparse, error as _urlerr

# _config.py lives next to this file. Adds the parent dir to sys.path so the
# import works whether the hook is invoked as a module or by absolute path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _config import cfg


# ── Configuration ───────────────────────────────────────────────────────────
API_BASE      = cfg("github", "api_base",       default="https://api.github.com").rstrip("/")
TOKEN         = cfg("github", "token",          env="GITHUB_TOKEN")
DEFAULT_OWNER = cfg("github", "default_owner",  env="GITHUB_USER")
API_VERSION   = "2022-11-28"
USER_AGENT    = "claude-codex-black/github_hook.py"


# ── Low-level HTTP ──────────────────────────────────────────────────────────
def _require_token() -> None:
    if not TOKEN:
        print(
            "ERROR: no GitHub PAT.\n"
            "Set [github] token = ghp_... in config.ini, or export GITHUB_TOKEN.\n"
            "Create a token at: https://github.com/settings/tokens/new",
            file=sys.stderr,
        )
        sys.exit(2)


def _headers(extra: dict | None = None) -> dict:
    _require_token()
    h = {
        "Authorization": f"Bearer {TOKEN}",
        "Accept":        "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent":    USER_AGENT,
    }
    if extra:
        h.update(extra)
    return h


def _full_url(path: str, params: dict | None = None) -> str:
    url = path if path.startswith("http") else f"{API_BASE}/{path.lstrip('/')}"
    if params:
        q = _urlparse.urlencode({k: v for k, v in params.items() if v is not None}, doseq=True)
        if q:
            url += ("&" if "?" in url else "?") + q
    return url


def request(method: str, path: str, *, payload: Any = None, params: dict | None = None,
            accept: str | None = None) -> tuple[int, Any, dict]:
    """Single REST call. Returns (status, parsed body or raw bytes, headers).
    Body is JSON-decoded when Content-Type is JSON; bytes otherwise (raw
    file downloads, tarballs, etc.)."""
    url = _full_url(path, params)
    body = None
    headers = _headers({"Accept": accept} if accept else None)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    req = _urlreq.Request(url, data=body, headers=headers, method=method.upper())
    try:
        with _urlreq.urlopen(req, timeout=60) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "")
            parsed: Any
            if "application/json" in ctype and data:
                parsed = json.loads(data.decode("utf-8", errors="replace"))
            elif data:
                # Try JSON anyway (sometimes Content-Type is missing).
                try:    parsed = json.loads(data.decode("utf-8"))
                except Exception: parsed = data
            else:
                parsed = None
            return r.status, parsed, dict(r.headers)
    except _urlerr.HTTPError as e:
        raw = e.read()
        try:    parsed = json.loads(raw.decode("utf-8"))
        except Exception: parsed = raw.decode("utf-8", errors="replace")
        return e.code, parsed, dict(e.headers or {})


def paginate(path: str, params: dict | None = None, *, per_page: int = 100,
             max_pages: int = 100) -> Iterable[dict]:
    """Yield every item across all pages. Honors GitHub's `Link: rel="next"`
    header — many endpoints don't return `last` so we follow `next` until
    it's gone. Cap at max_pages to avoid runaway accidents."""
    page = 1
    url = path
    current_params = dict(params or {})
    current_params.setdefault("per_page", per_page)
    while page <= max_pages:
        status, data, headers = request("GET", url, params=current_params)
        if status != 200:
            print(f"ERROR: paginate {url} got {status}: {data}", file=sys.stderr)
            return
        if isinstance(data, list):
            for item in data:
                yield item
            if len(data) < (current_params.get("per_page") or per_page):
                return
        elif isinstance(data, dict) and "items" in data:
            # Search endpoints — single page response with items[].
            for item in data["items"]:
                yield item
            if len(data["items"]) < (current_params.get("per_page") or per_page):
                return
        else:
            return
        # Parse Link header for next URL.
        link = headers.get("Link") or headers.get("link") or ""
        next_url: str | None = None
        for piece in link.split(","):
            piece = piece.strip()
            if 'rel="next"' in piece:
                lt = piece.find("<"); gt = piece.find(">")
                if 0 <= lt < gt:
                    next_url = piece[lt + 1: gt]
                    break
        if not next_url:
            return
        url = next_url
        current_params = {}  # next URL already has params baked in
        page += 1


def _emit(data: Any) -> None:
    """Print JSON nicely. Bytes? Write to stdout raw."""
    if isinstance(data, (bytes, bytearray)):
        try: sys.stdout.buffer.write(data)
        except Exception: print(data)
        return
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def _split_owner_repo(s: str) -> tuple[str, str]:
    if "/" in s:
        o, r = s.split("/", 1)
        return o, r
    if not DEFAULT_OWNER:
        print(f"ERROR: '{s}' needs OWNER/REPO format (no [github] default_owner set).", file=sys.stderr)
        sys.exit(2)
    return DEFAULT_OWNER, s


# ── User ────────────────────────────────────────────────────────────────────
def user_get(login: str | None = None):
    path = "/user" if not login else f"/users/{login}"
    s, d, _ = request("GET", path); _emit(d); return s

def user_followers(login: str | None = None):
    path = "/user/followers" if not login else f"/users/{login}/followers"
    _emit(list(paginate(path))); return 0

def user_following(login: str | None = None):
    path = "/user/following" if not login else f"/users/{login}/following"
    _emit(list(paginate(path))); return 0

def user_follow(login: str):
    s, d, _ = request("PUT", f"/user/following/{login}"); _emit(d or {"ok": s == 204}); return s

def user_unfollow(login: str):
    s, d, _ = request("DELETE", f"/user/following/{login}"); _emit(d or {"ok": s == 204}); return s


# ── Repos ───────────────────────────────────────────────────────────────────
def repos_list(scope: str = "user"):
    """scope: user (authed user's) | starred | watched | org:NAME | user:LOGIN"""
    if scope == "user":
        _emit(list(paginate("/user/repos", {"affiliation": "owner,collaborator,organization_member", "sort": "updated"})))
    elif scope == "starred":
        _emit(list(paginate("/user/starred")))
    elif scope == "watched":
        _emit(list(paginate("/user/subscriptions")))
    elif scope.startswith("org:"):
        _emit(list(paginate(f"/orgs/{scope[4:]}/repos")))
    elif scope.startswith("user:"):
        _emit(list(paginate(f"/users/{scope[5:]}/repos")))
    else:
        print(f"ERROR: unknown scope '{scope}'", file=sys.stderr); return 2
    return 0

def repos_get(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}"); _emit(d); return s

def repos_create(name: str, *, private: bool = False, description: str = "", auto_init: bool = False, org: str | None = None):
    path = f"/orgs/{org}/repos" if org else "/user/repos"
    s, d, _ = request("POST", path, payload={
        "name": name, "private": private, "description": description, "auto_init": auto_init,
    })
    _emit(d); return 0 if s == 201 else s

def repos_delete(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}"); _emit(d or {"deleted": s == 204}); return s

def repos_update(slug: str, fields: dict):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PATCH", f"/repos/{o}/{r}", payload=fields); _emit(d); return s

def repos_rename(slug: str, new_name: str):
    return repos_update(slug, {"name": new_name})

def repos_archive(slug: str, archived: bool = True):
    return repos_update(slug, {"archived": archived})

def repos_transfer(slug: str, new_owner: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/transfer", payload={"new_owner": new_owner}); _emit(d); return s

def repos_fork(slug: str, *, org: str | None = None, name: str | None = None):
    o, r = _split_owner_repo(slug)
    payload: dict = {}
    if org: payload["organization"] = org
    if name: payload["name"] = name
    s, d, _ = request("POST", f"/repos/{o}/{r}/forks", payload=payload or None); _emit(d); return s

def repos_topics_get(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/topics", accept="application/vnd.github.mercy-preview+json")
    _emit(d); return s

def repos_topics_set(slug: str, topics: list[str]):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PUT", f"/repos/{o}/{r}/topics", payload={"names": topics},
                       accept="application/vnd.github.mercy-preview+json")
    _emit(d); return s


# ── Branches + Refs ─────────────────────────────────────────────────────────
def branches_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/branches"))); return 0

def branches_get(slug: str, branch: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/branches/{branch}"); _emit(d); return s

def branches_protect(slug: str, branch: str, payload: dict | None = None):
    o, r = _split_owner_repo(slug)
    # Sensible default: require PR review, dismiss stale reviews.
    body = payload or {
        "required_status_checks": None,
        "enforce_admins": True,
        "required_pull_request_reviews": {"dismiss_stale_reviews": True, "required_approving_review_count": 1},
        "restrictions": None,
    }
    s, d, _ = request("PUT", f"/repos/{o}/{r}/branches/{branch}/protection", payload=body); _emit(d); return s

def branches_unprotect(slug: str, branch: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/branches/{branch}/protection"); _emit(d or {"ok": s == 204}); return s

def refs_list(slug: str, sub: str = "heads"):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/git/refs/{sub}"))); return 0

def refs_create(slug: str, ref: str, sha: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/git/refs", payload={"ref": ref, "sha": sha}); _emit(d); return s

def refs_delete(slug: str, ref: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/git/refs/{ref}"); _emit(d or {"ok": s == 204}); return s


# ── File contents ───────────────────────────────────────────────────────────
def contents_get(slug: str, path: str, ref: str | None = None):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/contents/{_urlparse.quote(path)}",
                       params={"ref": ref} if ref else None)
    _emit(d); return s

def contents_create(slug: str, path: str, content_b64: str, message: str, branch: str | None = None):
    import base64
    o, r = _split_owner_repo(slug)
    # Caller can pass either base64 or raw text — auto-encode if raw.
    try:
        base64.b64decode(content_b64, validate=True)
        encoded = content_b64
    except Exception:
        encoded = base64.b64encode(content_b64.encode("utf-8")).decode("ascii")
    payload = {"message": message, "content": encoded}
    if branch: payload["branch"] = branch
    s, d, _ = request("PUT", f"/repos/{o}/{r}/contents/{_urlparse.quote(path)}", payload=payload)
    _emit(d); return s

def contents_update(slug: str, path: str, content_text: str, message: str, sha: str, branch: str | None = None):
    import base64
    o, r = _split_owner_repo(slug)
    payload = {"message": message,
               "content": base64.b64encode(content_text.encode("utf-8")).decode("ascii"),
               "sha": sha}
    if branch: payload["branch"] = branch
    s, d, _ = request("PUT", f"/repos/{o}/{r}/contents/{_urlparse.quote(path)}", payload=payload)
    _emit(d); return s

def contents_delete(slug: str, path: str, message: str, sha: str, branch: str | None = None):
    o, r = _split_owner_repo(slug)
    payload = {"message": message, "sha": sha}
    if branch: payload["branch"] = branch
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/contents/{_urlparse.quote(path)}", payload=payload)
    _emit(d); return s


# ── Commits ─────────────────────────────────────────────────────────────────
def commits_list(slug: str, *, sha: str | None = None, path: str | None = None, since: str | None = None):
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/commits", {"sha": sha, "path": path, "since": since})))
    return 0

def commits_get(slug: str, sha: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/commits/{sha}"); _emit(d); return s

def commits_compare(slug: str, base: str, head: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/compare/{base}...{head}"); _emit(d); return s


# ── Tags + Releases ─────────────────────────────────────────────────────────
def tags_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/tags"))); return 0

def releases_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/releases"))); return 0

def releases_get(slug: str, tag: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/releases/tags/{tag}"); _emit(d); return s

def releases_create(slug: str, tag: str, *, name: str | None = None, body: str = "",
                     draft: bool = False, prerelease: bool = False, target_commitish: str = "main"):
    o, r = _split_owner_repo(slug)
    payload = {"tag_name": tag, "name": name or tag, "body": body,
               "draft": draft, "prerelease": prerelease, "target_commitish": target_commitish}
    s, d, _ = request("POST", f"/repos/{o}/{r}/releases", payload=payload); _emit(d); return s

def releases_delete(slug: str, release_id: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/releases/{release_id}"); _emit(d or {"ok": s == 204}); return s

def releases_upload_asset(slug: str, release_id: int, file_path: str, *, content_type: str = "application/octet-stream"):
    o, r = _split_owner_repo(slug)
    p = Path(file_path)
    if not p.is_file():
        print(f"ERROR: file not found: {p}", file=sys.stderr); return 2
    # Asset uploads go to uploads.github.com, not api.github.com.
    upload_url = f"https://uploads.github.com/repos/{o}/{r}/releases/{release_id}/assets?name={_urlparse.quote(p.name)}"
    body = p.read_bytes()
    headers = _headers({"Content-Type": content_type})
    req = _urlreq.Request(upload_url, data=body, headers=headers, method="POST")
    try:
        with _urlreq.urlopen(req, timeout=300) as resp:
            print(f"Uploaded {p.name} ({len(body):,} bytes) status={resp.status}")
            try: _emit(json.loads(resp.read()))
            except Exception: pass
    except _urlerr.HTTPError as e:
        print(f"ERROR upload status={e.code}: {e.read().decode('utf-8', errors='replace')}", file=sys.stderr)
        return e.code
    return 0


# ── Issues ──────────────────────────────────────────────────────────────────
def issues_list(slug: str, *, state: str = "open", labels: str | None = None):
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/issues", {"state": state, "labels": labels})))
    return 0

def issues_get(slug: str, number: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/issues/{number}"); _emit(d); return s

def issues_create(slug: str, title: str, body: str = "", *, labels: list[str] | None = None, assignees: list[str] | None = None):
    o, r = _split_owner_repo(slug)
    payload: dict = {"title": title, "body": body}
    if labels: payload["labels"] = labels
    if assignees: payload["assignees"] = assignees
    s, d, _ = request("POST", f"/repos/{o}/{r}/issues", payload=payload); _emit(d); return s

def issues_update(slug: str, number: int, fields: dict):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PATCH", f"/repos/{o}/{r}/issues/{number}", payload=fields); _emit(d); return s

def issues_close(slug: str, number: int):
    return issues_update(slug, number, {"state": "closed"})

def issues_reopen(slug: str, number: int):
    return issues_update(slug, number, {"state": "open"})

def issues_lock(slug: str, number: int, reason: str = "off-topic"):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PUT", f"/repos/{o}/{r}/issues/{number}/lock", payload={"lock_reason": reason})
    _emit(d or {"ok": s == 204}); return s

def issues_unlock(slug: str, number: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/issues/{number}/lock"); _emit(d or {"ok": s == 204}); return s

# Issue comments
def issue_comments_list(slug: str, number: int):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/issues/{number}/comments"))); return 0

def issue_comments_create(slug: str, number: int, body: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/issues/{number}/comments", payload={"body": body}); _emit(d); return s

def issue_comments_update(slug: str, comment_id: int, body: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PATCH", f"/repos/{o}/{r}/issues/comments/{comment_id}", payload={"body": body}); _emit(d); return s

def issue_comments_delete(slug: str, comment_id: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/issues/comments/{comment_id}"); _emit(d or {"ok": s == 204}); return s


# ── Pull Requests ───────────────────────────────────────────────────────────
def prs_list(slug: str, *, state: str = "open"):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/pulls", {"state": state}))); return 0

def prs_get(slug: str, number: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/pulls/{number}"); _emit(d); return s

def prs_create(slug: str, title: str, head: str, base: str, *, body: str = "", draft: bool = False):
    o, r = _split_owner_repo(slug)
    payload = {"title": title, "head": head, "base": base, "body": body, "draft": draft}
    s, d, _ = request("POST", f"/repos/{o}/{r}/pulls", payload=payload); _emit(d); return s

def prs_update(slug: str, number: int, fields: dict):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PATCH", f"/repos/{o}/{r}/pulls/{number}", payload=fields); _emit(d); return s

def prs_merge(slug: str, number: int, *, method: str = "merge", commit_title: str | None = None, commit_message: str | None = None):
    o, r = _split_owner_repo(slug)
    payload = {"merge_method": method}
    if commit_title: payload["commit_title"] = commit_title
    if commit_message: payload["commit_message"] = commit_message
    s, d, _ = request("PUT", f"/repos/{o}/{r}/pulls/{number}/merge", payload=payload); _emit(d); return s

def prs_request_review(slug: str, number: int, reviewers: list[str]):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/pulls/{number}/requested_reviewers", payload={"reviewers": reviewers})
    _emit(d); return s

def prs_reviews_list(slug: str, number: int):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/pulls/{number}/reviews"))); return 0

def prs_review_create(slug: str, number: int, event: str, body: str = ""):
    """event: APPROVE | REQUEST_CHANGES | COMMENT"""
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/pulls/{number}/reviews", payload={"event": event, "body": body})
    _emit(d); return s


# ── Workflows + Actions ─────────────────────────────────────────────────────
def workflows_list(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("GET", f"/repos/{o}/{r}/actions/workflows"); _emit(d); return s

def workflow_runs_list(slug: str, workflow: str | None = None):
    o, r = _split_owner_repo(slug)
    path = f"/repos/{o}/{r}/actions/workflows/{workflow}/runs" if workflow else f"/repos/{o}/{r}/actions/runs"
    _emit(list(paginate(path))); return 0

def workflow_dispatch(slug: str, workflow: str, ref: str = "main", inputs: dict | None = None):
    o, r = _split_owner_repo(slug)
    payload: dict = {"ref": ref}
    if inputs: payload["inputs"] = inputs
    s, d, _ = request("POST", f"/repos/{o}/{r}/actions/workflows/{workflow}/dispatches", payload=payload)
    _emit(d or {"ok": s == 204}); return s

def workflow_run_cancel(slug: str, run_id: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/actions/runs/{run_id}/cancel"); _emit(d or {"ok": s == 202}); return s

def workflow_run_rerun(slug: str, run_id: int, failed_only: bool = False):
    o, r = _split_owner_repo(slug)
    path = f"/repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs" if failed_only else f"/repos/{o}/{r}/actions/runs/{run_id}/rerun"
    s, d, _ = request("POST", path); _emit(d or {"ok": s == 201}); return s

def workflow_run_logs(slug: str, run_id: int, out_path: str = "workflow_logs.zip"):
    o, r = _split_owner_repo(slug)
    s, data, _ = request("GET", f"/repos/{o}/{r}/actions/runs/{run_id}/logs")
    if s == 200 and isinstance(data, (bytes, bytearray)):
        Path(out_path).write_bytes(data); print(f"Wrote {out_path} ({len(data):,} bytes)"); return 0
    print(f"ERROR logs status={s}: {data}", file=sys.stderr); return s


# ── Secrets + Variables (Actions / Codespaces / Dependabot) ─────────────────
def secrets_list(slug: str, scope: str = "actions"):
    """scope: actions | codespaces | dependabot"""
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/{scope}/secrets"))); return 0

def secrets_delete(slug: str, name: str, scope: str = "actions"):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/{scope}/secrets/{name}"); _emit(d or {"ok": s == 204}); return s

def variables_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/actions/variables"))); return 0

def variables_create(slug: str, name: str, value: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/actions/variables", payload={"name": name, "value": value}); _emit(d or {"ok": s == 201}); return s

def variables_update(slug: str, name: str, value: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PATCH", f"/repos/{o}/{r}/actions/variables/{name}", payload={"name": name, "value": value}); _emit(d or {"ok": s == 204}); return s

def variables_delete(slug: str, name: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/actions/variables/{name}"); _emit(d or {"ok": s == 204}); return s


# ── Webhooks ────────────────────────────────────────────────────────────────
def webhooks_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/hooks"))); return 0

def webhooks_create(slug: str, url: str, events: list[str] | None = None, content_type: str = "json", secret: str | None = None):
    o, r = _split_owner_repo(slug)
    cfg: dict = {"url": url, "content_type": content_type}
    if secret: cfg["secret"] = secret
    s, d, _ = request("POST", f"/repos/{o}/{r}/hooks",
                       payload={"name": "web", "active": True, "events": events or ["push"], "config": cfg})
    _emit(d); return s

def webhooks_delete(slug: str, hook_id: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/hooks/{hook_id}"); _emit(d or {"ok": s == 204}); return s


# ── Packages ────────────────────────────────────────────────────────────────
def packages_list(scope: str = "user", package_type: str = "container"):
    """scope: user | org:NAME"""
    if scope == "user":
        path = "/user/packages"
    elif scope.startswith("org:"):
        path = f"/orgs/{scope[4:]}/packages"
    else:
        print(f"ERROR: unknown scope '{scope}'", file=sys.stderr); return 2
    _emit(list(paginate(path, {"package_type": package_type}))); return 0

def package_versions(scope: str, package_type: str, package_name: str):
    if scope == "user":
        path = f"/user/packages/{package_type}/{package_name}/versions"
    elif scope.startswith("org:"):
        path = f"/orgs/{scope[4:]}/packages/{package_type}/{package_name}/versions"
    else:
        print("ERROR: scope must be user or org:NAME", file=sys.stderr); return 2
    _emit(list(paginate(path))); return 0


# ── Deploy keys ─────────────────────────────────────────────────────────────
def deploy_keys_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/keys"))); return 0

def deploy_keys_create(slug: str, title: str, key: str, read_only: bool = True):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/keys",
                       payload={"title": title, "key": key, "read_only": read_only})
    _emit(d); return s

def deploy_keys_delete(slug: str, key_id: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/keys/{key_id}"); _emit(d or {"ok": s == 204}); return s


# ── Collaborators ───────────────────────────────────────────────────────────
def collaborators_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/collaborators"))); return 0

def collaborators_add(slug: str, username: str, permission: str = "push"):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PUT", f"/repos/{o}/{r}/collaborators/{username}", payload={"permission": permission})
    _emit(d or {"ok": s in (201, 204)}); return s

def collaborators_remove(slug: str, username: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/collaborators/{username}"); _emit(d or {"ok": s == 204}); return s


# ── Teams + Orgs ────────────────────────────────────────────────────────────
def orgs_list():
    _emit(list(paginate("/user/orgs"))); return 0

def org_members(org: str):
    _emit(list(paginate(f"/orgs/{org}/members"))); return 0

def teams_list(org: str):
    _emit(list(paginate(f"/orgs/{org}/teams"))); return 0


# ── Labels + Milestones ─────────────────────────────────────────────────────
def labels_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/labels"))); return 0

def labels_create(slug: str, name: str, color: str = "ededed", description: str = ""):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("POST", f"/repos/{o}/{r}/labels",
                       payload={"name": name, "color": color, "description": description})
    _emit(d); return s

def labels_delete(slug: str, name: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/labels/{name}"); _emit(d or {"ok": s == 204}); return s

def milestones_list(slug: str):
    o, r = _split_owner_repo(slug); _emit(list(paginate(f"/repos/{o}/{r}/milestones"))); return 0

def milestones_create(slug: str, title: str, due_on: str | None = None, description: str = ""):
    o, r = _split_owner_repo(slug)
    payload: dict = {"title": title, "description": description}
    if due_on: payload["due_on"] = due_on
    s, d, _ = request("POST", f"/repos/{o}/{r}/milestones", payload=payload); _emit(d); return s

def milestones_delete(slug: str, number: int):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/repos/{o}/{r}/milestones/{number}"); _emit(d or {"ok": s == 204}); return s


# ── Gists ───────────────────────────────────────────────────────────────────
def gists_list(login: str | None = None):
    _emit(list(paginate(f"/users/{login}/gists" if login else "/gists"))); return 0

def gists_get(gid: str):
    s, d, _ = request("GET", f"/gists/{gid}"); _emit(d); return s

def gists_create(filename: str, content: str, description: str = "", public: bool = False):
    payload = {"description": description, "public": public, "files": {filename: {"content": content}}}
    s, d, _ = request("POST", "/gists", payload=payload); _emit(d); return s

def gists_update(gid: str, files: dict, description: str | None = None):
    payload: dict = {"files": files}
    if description is not None: payload["description"] = description
    s, d, _ = request("PATCH", f"/gists/{gid}", payload=payload); _emit(d); return s

def gists_delete(gid: str):
    s, d, _ = request("DELETE", f"/gists/{gid}"); _emit(d or {"ok": s == 204}); return s


# ── Notifications ───────────────────────────────────────────────────────────
def notifications_list(*, all: bool = False, participating: bool = False):
    _emit(list(paginate("/notifications", {"all": str(all).lower(), "participating": str(participating).lower()})))
    return 0

def notifications_mark_read(thread_id: int | None = None):
    if thread_id:
        s, d, _ = request("PATCH", f"/notifications/threads/{thread_id}")
    else:
        s, d, _ = request("PUT", "/notifications")
    _emit(d or {"ok": s in (202, 205)}); return s


# ── Stars / Watching ────────────────────────────────────────────────────────
def stars_check(slug: str):
    o, r = _split_owner_repo(slug)
    s, _, _ = request("GET", f"/user/starred/{o}/{r}"); _emit({"starred": s == 204}); return 0

def stars_add(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("PUT", f"/user/starred/{o}/{r}"); _emit(d or {"ok": s == 204}); return s

def stars_remove(slug: str):
    o, r = _split_owner_repo(slug)
    s, d, _ = request("DELETE", f"/user/starred/{o}/{r}"); _emit(d or {"ok": s == 204}); return s


# ── Search ──────────────────────────────────────────────────────────────────
def search(category: str, query: str):
    """category: code | repos | issues | users | commits | topics | labels"""
    valid = {"code", "repositories", "issues", "users", "commits", "topics", "labels"}
    cat = "repositories" if category == "repos" else category
    if cat not in valid:
        print(f"ERROR: search category must be one of {sorted(valid | {'repos'})}", file=sys.stderr)
        return 2
    # Allow either raw "q=foo" or just "foo"
    if "=" not in query: params = {"q": query}
    else:
        params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
    s, d, _ = request("GET", f"/search/{cat}", params=params); _emit(d); return s


# ── Code scanning / Dependabot / Secret scanning ────────────────────────────
def code_scanning_alerts(slug: str, state: str | None = None):
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/code-scanning/alerts", {"state": state}))); return 0

def dependabot_alerts(slug: str, state: str | None = None):
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/dependabot/alerts", {"state": state}))); return 0

def secret_scanning_alerts(slug: str, state: str | None = None):
    o, r = _split_owner_repo(slug)
    _emit(list(paginate(f"/repos/{o}/{r}/secret-scanning/alerts", {"state": state}))); return 0


# ── Codespaces ──────────────────────────────────────────────────────────────
def codespaces_list():
    _emit(list(paginate("/user/codespaces"))); return 0

def codespaces_create(slug: str, ref: str = "main", machine: str | None = None):
    o, r = _split_owner_repo(slug)
    payload: dict = {"ref": ref}
    if machine: payload["machine"] = machine
    s, d, _ = request("POST", f"/repos/{o}/{r}/codespaces", payload=payload); _emit(d); return s

def codespaces_start(name: str):
    s, d, _ = request("POST", f"/user/codespaces/{name}/start"); _emit(d); return s

def codespaces_stop(name: str):
    s, d, _ = request("POST", f"/user/codespaces/{name}/stop"); _emit(d); return s

def codespaces_delete(name: str):
    s, d, _ = request("DELETE", f"/user/codespaces/{name}"); _emit(d or {"ok": s == 202}); return s


# ── Meta ────────────────────────────────────────────────────────────────────
def rate_limit():
    s, d, _ = request("GET", "/rate_limit"); _emit(d); return s

def api_root():
    s, d, _ = request("GET", "/"); _emit(d); return s

def raw(method: str, path: str, body: str | None = None):
    """Arbitrary REST call. body is a JSON string."""
    payload = json.loads(body) if body else None
    s, d, _ = request(method.upper(), path, payload=payload)
    _emit({"_status": s, **(d if isinstance(d, dict) else {"_body": d})})
    return 0 if 200 <= s < 300 else s


# ── Dispatcher ──────────────────────────────────────────────────────────────
DISPATCH = {
    # category : { action : (fn, "usage hint") }
    "user": {
        "get":       (user_get,       "[LOGIN]"),
        "followers": (user_followers, "[LOGIN]"),
        "following": (user_following, "[LOGIN]"),
        "follow":    (user_follow,    "LOGIN"),
        "unfollow":  (user_unfollow,  "LOGIN"),
    },
    "repos": {
        "list":     (repos_list,     "[user|starred|watched|org:NAME|user:LOGIN]"),
        "get":      (repos_get,      "OWNER/REPO"),
        "create":   (repos_create,   "NAME [--private] [--auto-init] [--description TEXT] [--org ORG]"),
        "delete":   (repos_delete,   "OWNER/REPO"),
        "rename":   (repos_rename,   "OWNER/REPO NEW_NAME"),
        "archive":  (repos_archive,  "OWNER/REPO [true|false]"),
        "transfer": (repos_transfer, "OWNER/REPO NEW_OWNER"),
        "fork":     (repos_fork,     "OWNER/REPO [--org ORG] [--name NAME]"),
        "topics-get": (repos_topics_get, "OWNER/REPO"),
        "topics-set": (repos_topics_set, "OWNER/REPO topic1 [topic2 ...]"),
    },
    "branches": {
        "list":      (branches_list,      "OWNER/REPO"),
        "get":       (branches_get,       "OWNER/REPO BRANCH"),
        "protect":   (branches_protect,   "OWNER/REPO BRANCH"),
        "unprotect": (branches_unprotect, "OWNER/REPO BRANCH"),
    },
    "refs": {
        "list":   (refs_list,   "OWNER/REPO [heads|tags]"),
        "create": (refs_create, "OWNER/REPO REF SHA"),
        "delete": (refs_delete, "OWNER/REPO REF"),
    },
    "contents": {
        "get":    (contents_get,    "OWNER/REPO PATH [REF]"),
        "create": (contents_create, "OWNER/REPO PATH CONTENT MESSAGE [BRANCH]"),
        "update": (contents_update, "OWNER/REPO PATH CONTENT MESSAGE SHA [BRANCH]"),
        "delete": (contents_delete, "OWNER/REPO PATH MESSAGE SHA [BRANCH]"),
    },
    "commits": {
        "list":    (commits_list,    "OWNER/REPO [--sha SHA] [--path PATH] [--since ISO]"),
        "get":     (commits_get,     "OWNER/REPO SHA"),
        "compare": (commits_compare, "OWNER/REPO BASE HEAD"),
    },
    "tags": {
        "list": (tags_list, "OWNER/REPO"),
    },
    "releases": {
        "list":    (releases_list,    "OWNER/REPO"),
        "get":     (releases_get,     "OWNER/REPO TAG"),
        "create":  (releases_create,  "OWNER/REPO TAG [--name NAME] [--body TEXT] [--draft] [--prerelease]"),
        "delete":  (releases_delete,  "OWNER/REPO RELEASE_ID"),
        "upload":  (releases_upload_asset, "OWNER/REPO RELEASE_ID FILE_PATH"),
    },
    "issues": {
        "list":    (issues_list,    "OWNER/REPO [--state open|closed|all]"),
        "get":     (issues_get,     "OWNER/REPO NUMBER"),
        "create":  (issues_create,  "OWNER/REPO TITLE BODY"),
        "update":  (issues_update,  "OWNER/REPO NUMBER JSON_FIELDS"),
        "close":   (issues_close,   "OWNER/REPO NUMBER"),
        "reopen":  (issues_reopen,  "OWNER/REPO NUMBER"),
        "lock":    (issues_lock,    "OWNER/REPO NUMBER [REASON]"),
        "unlock":  (issues_unlock,  "OWNER/REPO NUMBER"),
    },
    "issue-comments": {
        "list":   (issue_comments_list,   "OWNER/REPO ISSUE_NUMBER"),
        "create": (issue_comments_create, "OWNER/REPO ISSUE_NUMBER BODY"),
        "update": (issue_comments_update, "OWNER/REPO COMMENT_ID BODY"),
        "delete": (issue_comments_delete, "OWNER/REPO COMMENT_ID"),
    },
    "prs": {
        "list":           (prs_list,           "OWNER/REPO [--state open|closed|all]"),
        "get":            (prs_get,            "OWNER/REPO NUMBER"),
        "create":         (prs_create,         "OWNER/REPO TITLE HEAD BASE [--body TEXT] [--draft]"),
        "update":         (prs_update,         "OWNER/REPO NUMBER JSON_FIELDS"),
        "merge":          (prs_merge,          "OWNER/REPO NUMBER [--method merge|squash|rebase]"),
        "request-review": (prs_request_review, "OWNER/REPO NUMBER reviewer1 [reviewer2 ...]"),
        "reviews":        (prs_reviews_list,   "OWNER/REPO NUMBER"),
        "review":         (prs_review_create,  "OWNER/REPO NUMBER APPROVE|REQUEST_CHANGES|COMMENT [BODY]"),
    },
    "workflows": {
        "list":     (workflows_list,         "OWNER/REPO"),
        "runs":     (workflow_runs_list,     "OWNER/REPO [WORKFLOW_FILE_OR_ID]"),
        "dispatch": (workflow_dispatch,      "OWNER/REPO WORKFLOW_FILE REF [JSON_INPUTS]"),
        "cancel":   (workflow_run_cancel,    "OWNER/REPO RUN_ID"),
        "rerun":    (workflow_run_rerun,     "OWNER/REPO RUN_ID [--failed-only]"),
        "logs":     (workflow_run_logs,      "OWNER/REPO RUN_ID [OUT_PATH]"),
    },
    "secrets": {
        "list":   (secrets_list,   "OWNER/REPO [actions|codespaces|dependabot]"),
        "delete": (secrets_delete, "OWNER/REPO NAME [actions|codespaces|dependabot]"),
    },
    "variables": {
        "list":   (variables_list,   "OWNER/REPO"),
        "create": (variables_create, "OWNER/REPO NAME VALUE"),
        "update": (variables_update, "OWNER/REPO NAME VALUE"),
        "delete": (variables_delete, "OWNER/REPO NAME"),
    },
    "webhooks": {
        "list":   (webhooks_list,   "OWNER/REPO"),
        "create": (webhooks_create, "OWNER/REPO URL [event1 event2 ...] [--secret SECRET]"),
        "delete": (webhooks_delete, "OWNER/REPO HOOK_ID"),
    },
    "packages": {
        "list":     (packages_list,     "[user|org:NAME] [PACKAGE_TYPE]"),
        "versions": (package_versions,  "[user|org:NAME] PACKAGE_TYPE PACKAGE_NAME"),
    },
    "deploy-keys": {
        "list":   (deploy_keys_list,   "OWNER/REPO"),
        "create": (deploy_keys_create, "OWNER/REPO TITLE KEY [--writable]"),
        "delete": (deploy_keys_delete, "OWNER/REPO KEY_ID"),
    },
    "collaborators": {
        "list":   (collaborators_list,   "OWNER/REPO"),
        "add":    (collaborators_add,    "OWNER/REPO USERNAME [pull|triage|push|maintain|admin]"),
        "remove": (collaborators_remove, "OWNER/REPO USERNAME"),
    },
    "orgs": {
        "list":    (orgs_list,    ""),
        "members": (org_members,  "ORG"),
    },
    "teams": {
        "list": (teams_list, "ORG"),
    },
    "labels": {
        "list":   (labels_list,   "OWNER/REPO"),
        "create": (labels_create, "OWNER/REPO NAME [COLOR_HEX] [DESCRIPTION]"),
        "delete": (labels_delete, "OWNER/REPO NAME"),
    },
    "milestones": {
        "list":   (milestones_list,   "OWNER/REPO"),
        "create": (milestones_create, "OWNER/REPO TITLE [DUE_ON_ISO] [DESCRIPTION]"),
        "delete": (milestones_delete, "OWNER/REPO NUMBER"),
    },
    "gists": {
        "list":   (gists_list,   "[LOGIN]"),
        "get":    (gists_get,    "GIST_ID"),
        "create": (gists_create, "FILENAME CONTENT [DESCRIPTION] [--public]"),
        "update": (gists_update, "GIST_ID JSON_FILES_MAP [--description TEXT]"),
        "delete": (gists_delete, "GIST_ID"),
    },
    "notifications": {
        "list":     (notifications_list,      "[--all] [--participating]"),
        "mark-read":(notifications_mark_read, "[THREAD_ID]"),
    },
    "stars": {
        "check":  (stars_check,  "OWNER/REPO"),
        "add":    (stars_add,    "OWNER/REPO"),
        "remove": (stars_remove, "OWNER/REPO"),
    },
    "search": {
        "code":     (lambda q: search("code", q),    "QUERY"),
        "repos":    (lambda q: search("repos", q),   "QUERY"),
        "issues":   (lambda q: search("issues", q),  "QUERY"),
        "users":    (lambda q: search("users", q),   "QUERY"),
        "commits":  (lambda q: search("commits", q), "QUERY"),
        "topics":   (lambda q: search("topics", q),  "QUERY"),
        "labels":   (lambda q: search("labels", q),  "QUERY"),
    },
    "alerts": {
        "code-scanning":   (code_scanning_alerts,   "OWNER/REPO [STATE]"),
        "dependabot":      (dependabot_alerts,      "OWNER/REPO [STATE]"),
        "secret-scanning": (secret_scanning_alerts, "OWNER/REPO [STATE]"),
    },
    "codespaces": {
        "list":   (codespaces_list,   ""),
        "create": (codespaces_create, "OWNER/REPO [REF] [MACHINE]"),
        "start":  (codespaces_start,  "NAME"),
        "stop":   (codespaces_stop,   "NAME"),
        "delete": (codespaces_delete, "NAME"),
    },
    "meta": {
        "rate-limit": (rate_limit, ""),
        "root":       (api_root,   ""),
    },
    "raw": {
        "_passthrough": (raw, "METHOD PATH [JSON_BODY]"),
    },
}


def _print_help() -> None:
    print(__doc__)
    print("\nAll categories / actions:")
    for cat in sorted(DISPATCH.keys()):
        print(f"\n  {cat}")
        for action, (_, hint) in sorted(DISPATCH[cat].items()):
            print(f"    {action:<18}  {hint}")


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    if not args or args[0] in ("-h", "--help", "help"):
        _print_help(); return 0

    cat = args[0]
    # `raw` accepts METHOD PATH [BODY] directly.
    if cat == "raw":
        if len(args) < 3:
            print("usage: raw METHOD PATH [JSON_BODY]", file=sys.stderr); return 2
        return raw(args[1], args[2], args[3] if len(args) >= 4 else None)

    if cat not in DISPATCH:
        print(f"unknown category: {cat}. Run with 'help' for the full menu.", file=sys.stderr); return 2

    if len(args) < 2:
        print(f"usage: github_hook.py {cat} <action>", file=sys.stderr)
        for action, (_, hint) in sorted(DISPATCH[cat].items()): print(f"  {action:<18}  {hint}")
        return 2

    action = args[1]
    if action not in DISPATCH[cat]:
        print(f"unknown action '{action}' in '{cat}'. Available: {', '.join(DISPATCH[cat].keys())}", file=sys.stderr)
        return 2

    fn, _hint = DISPATCH[cat][action]
    rest = args[2:]

    # Minimal arg coercion — most commands take positional strings. Numeric
    # IDs are converted opportunistically below.
    def _maybe_int(s: str):
        try: return int(s)
        except (TypeError, ValueError): return s
    coerced = [_maybe_int(a) if a.lstrip("-").isdigit() else a for a in rest]

    try:
        rc = fn(*coerced)
    except TypeError as e:
        print(f"ERROR: bad args for {cat} {action}: {e}\n  usage: {_hint}", file=sys.stderr)
        return 2
    return int(rc or 0)


if __name__ == "__main__":
    sys.exit(main())
