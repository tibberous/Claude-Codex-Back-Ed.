"""
push.py — commit-aware push helper for Claude Codex Black.

Reads the GitHub Personal Access Token from config.ini (which is gitignored),
sets the `origin` remote to an HTTPS URL embedding the token, and pushes the
current branch. Never writes the token to disk anywhere git tracks.

Usage:
    python push.py                # push current branch to origin
    python push.py --branch main  # push specified branch
    python push.py --force        # force-push (use with care)

Config (config.ini):
    [api_keys]
    github_token = ghp_xxxxxxxxxxxxxxxxxxxx

    [about]
    repo = https://github.com/<user>/<repo>
"""
import argparse
import configparser
import os
import subprocess
import sys
from urllib.parse import urlparse, urlunparse

REPO_DIR    = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(REPO_DIR, "config.ini")


def loadConfig():
    if not os.path.isfile(CONFIG_PATH):
        sys.exit(f"ERROR: config.ini not found at {CONFIG_PATH}")
    cp = configparser.ConfigParser()
    cp.read(CONFIG_PATH, encoding="utf-8")
    token = cp.get("api_keys", "github_token", fallback="").strip()
    repo  = cp.get("about",    "repo",          fallback="").strip()
    if not token or token.startswith("ghp_REPLACE") or token.startswith("github_pat_REPLACE"):
        sys.exit("ERROR: set [api_keys] github_token in config.ini (PAT with repo scope)")
    if not repo:
        sys.exit("ERROR: set [about] repo in config.ini (e.g. https://github.com/user/repo)")
    return token, repo


def authedUrl(repo, token):
    """Embed token into HTTPS clone URL: https://<token>@github.com/user/repo.git"""
    parsed = urlparse(repo if repo.endswith(".git") else repo + ".git")
    netloc = f"{token}@{parsed.hostname}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def run(*args, check=True, capture=False):
    print(f"$ {' '.join(args)}")
    if capture:
        return subprocess.run(args, cwd=REPO_DIR, check=check,
                              capture_output=True, text=True)
    return subprocess.run(args, cwd=REPO_DIR, check=check)


def currentBranch():
    out = run("git", "rev-parse", "--abbrev-ref", "HEAD", capture=True).stdout.strip()
    return out or "main"


def ensureRemote(url):
    """Set origin to authed URL. If origin exists, update it; otherwise add it."""
    existing = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        cwd=REPO_DIR, capture_output=True, text=True,
    )
    if existing.returncode == 0:
        run("git", "remote", "set-url", "origin", url)
    else:
        run("git", "remote", "add", "origin", url)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", default=None, help="Branch to push (default: current)")
    ap.add_argument("--force",  action="store_true", help="Force push")
    args = ap.parse_args()

    token, repo = loadConfig()
    url = authedUrl(repo, token)
    branch = args.branch or currentBranch()

    ensureRemote(url)

    pushArgs = ["git", "push", "-u", "origin", branch]
    if args.force:
        pushArgs.insert(2, "--force")
    run(*pushArgs)

    # Scrub token from remote URL after push (leaves clean public URL on disk)
    cleanUrl = repo if repo.endswith(".git") else repo + ".git"
    run("git", "remote", "set-url", "origin", cleanUrl)
    print(f"OK: pushed {branch} to {repo}")


if __name__ == "__main__":
    main()
