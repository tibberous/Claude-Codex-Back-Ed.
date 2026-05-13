"""
Hook File: github_hook.py

What it does:
GitHub REST API v3 wrapper — create repos, open issues, read file contents,
list repos, and get repo info.

How to use it:
  python github_hook.py repos
  python github_hook.py create-repo my-project --private
  python github_hook.py issue owner/repo "Bug title" "Bug description"
  python github_hook.py read owner/repo path/to/file.py
  python github_hook.py info owner/repo

Primary entry points:
list_repos, create_repo, create_issue, read_file, get_repo, main

Relevant URL(s):
- https://docs.github.com/en/rest
- Get a token: https://github.com/settings/tokens/new (needs repo scope)
"""

import os
import sys
import json
import base64
import argparse
import requests

API_BASE = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "")


def _require_token():
    if not TOKEN:
        print(
            "ERROR: GITHUB_TOKEN is not set.\n"
            "Set the env var or set TOKEN in this file.\n"
            "Create a token at: https://github.com/settings/tokens/new\n"
            "(needs 'repo' scope for private repos, 'public_repo' for public)",
            file=sys.stderr,
        )
        sys.exit(1)


def _headers():
    _require_token()
    return {
        "Authorization": f"Bearer {TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


def list_repos(per_page: int = 30):
    r = requests.get(f"{API_BASE}/user/repos", headers=_headers(), params={"per_page": per_page, "sort": "updated"}, timeout=30)
    r.raise_for_status()
    repos = r.json()
    result = [{"name": repo["full_name"], "private": repo["private"], "url": repo["html_url"]} for repo in repos]
    print(json.dumps(result, indent=2))
    return result


def create_repo(name: str, description: str = "", private: bool = False, auto_init: bool = True):
    payload = {"name": name, "description": description, "private": private, "auto_init": auto_init}
    r = requests.post(f"{API_BASE}/user/repos", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    result = {"name": data["full_name"], "url": data["html_url"], "clone_url": data["clone_url"]}
    print(json.dumps(result, indent=2))
    return result


def create_issue(owner_repo: str, title: str, body: str = "", labels: list = None):
    owner, repo = owner_repo.split("/", 1)
    payload = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    r = requests.post(f"{API_BASE}/repos/{owner}/{repo}/issues", headers=_headers(), json=payload, timeout=30)
    r.raise_for_status()
    data = r.json()
    result = {"number": data["number"], "title": data["title"], "url": data["html_url"]}
    print(json.dumps(result, indent=2))
    return result


def read_file(owner_repo: str, path: str, ref: str = None):
    owner, repo = owner_repo.split("/", 1)
    params = {}
    if ref:
        params["ref"] = ref
    r = requests.get(f"{API_BASE}/repos/{owner}/{repo}/contents/{path}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    content = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    print(content)
    return content


def get_repo(owner_repo: str):
    owner, repo = owner_repo.split("/", 1)
    r = requests.get(f"{API_BASE}/repos/{owner}/{repo}", headers=_headers(), timeout=30)
    r.raise_for_status()
    data = r.json()
    result = {
        "name": data["full_name"],
        "description": data["description"],
        "stars": data["stargazers_count"],
        "forks": data["forks_count"],
        "open_issues": data["open_issues_count"],
        "default_branch": data["default_branch"],
        "url": data["html_url"],
    }
    print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="GitHub API hook")
    sub = parser.add_subparsers(dest="action", required=True)

    sub.add_parser("repos")

    p_create = sub.add_parser("create-repo")
    p_create.add_argument("name")
    p_create.add_argument("--desc", default="")
    p_create.add_argument("--private", action="store_true")
    p_create.add_argument("--no-init", action="store_true")

    p_issue = sub.add_parser("issue")
    p_issue.add_argument("repo")
    p_issue.add_argument("title")
    p_issue.add_argument("body", nargs="?", default="")
    p_issue.add_argument("--labels", nargs="*")

    p_read = sub.add_parser("read")
    p_read.add_argument("repo")
    p_read.add_argument("path")
    p_read.add_argument("--ref")

    p_info = sub.add_parser("info")
    p_info.add_argument("repo")

    args = parser.parse_args()
    if args.action == "repos":
        list_repos()
    elif args.action == "create-repo":
        create_repo(args.name, args.desc, args.private, not args.no_init)
    elif args.action == "issue":
        create_issue(args.repo, args.title, args.body, args.labels)
    elif args.action == "read":
        read_file(args.repo, args.path, args.ref)
    elif args.action == "info":
        get_repo(args.repo)


if __name__ == "__main__":
    main()
