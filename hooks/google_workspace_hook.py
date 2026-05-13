"""
Hook File: google_workspace_hook.py

What it does:
Google Workspace Admin SDK wrapper — create/delete/list user accounts,
get DKIM settings for a domain, and trigger DKIM key generation.
Requires a service account with domain-wide delegation OR a super admin OAuth credential.

How to use it:
  python google_workspace_hook.py users list --domain yourdomain.com
  python google_workspace_hook.py users create --email new@yourdomain.com --first John --last Doe --password Temp1234!
  python google_workspace_hook.py users delete user@yourdomain.com
  python google_workspace_hook.py dkim get yourdomain.com
  python google_workspace_hook.py dkim generate yourdomain.com

Setup:
  1. Create a service account in Google Cloud Console
  2. Enable domain-wide delegation for the service account
  3. Grant the service account access in Google Workspace Admin Console:
     Admin Console → Security → API Controls → Domain-wide delegation
     Scopes needed:
       https://www.googleapis.com/auth/admin.directory.user
       https://www.googleapis.com/auth/admin.directory.domain
  4. Download service account JSON key
  5. Set GOOGLE_SERVICE_ACCOUNT_JSON env var to the path of the JSON key
  6. Set GOOGLE_ADMIN_EMAIL env var to a super admin email

Primary entry points:
list_users, create_user, delete_user, get_dkim, generate_dkim, main

Relevant URL(s):
- https://developers.google.com/admin-sdk/directory/v1/reference/users
- https://developers.google.com/admin-sdk/directory/v1/reference/domains.dkimSettings
- Service account setup: https://console.cloud.google.com/iam-admin/serviceaccounts
- Domain-wide delegation: https://admin.google.com/ac/owl/domainwidedelegation
"""

import os
import sys
import json
import argparse

SERVICE_ACCOUNT_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
ADMIN_EMAIL = os.environ.get("GOOGLE_ADMIN_EMAIL", "")
ADMIN_DIRECTORY_BASE = "https://admin.googleapis.com/admin/directory/v1"


def _require_credentials():
    missing = []
    if not SERVICE_ACCOUNT_JSON:
        missing.append("GOOGLE_SERVICE_ACCOUNT_JSON (path to service account key file)")
    if not ADMIN_EMAIL:
        missing.append("GOOGLE_ADMIN_EMAIL (super admin email for impersonation)")
    if missing:
        print(
            "ERROR: Missing Google Workspace credentials:\n  " + "\n  ".join(missing) + "\n"
            "Setup guide:\n"
            "  1. Create service account: https://console.cloud.google.com/iam-admin/serviceaccounts\n"
            "  2. Enable domain-wide delegation in Google Workspace Admin:\n"
            "     https://admin.google.com/ac/owl/domainwidedelegation\n"
            "     Scopes: https://www.googleapis.com/auth/admin.directory.user\n"
            "             https://www.googleapis.com/auth/admin.directory.domain",
            file=sys.stderr,
        )
        sys.exit(1)


def _get_credentials():
    _require_credentials()
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build  # badimport-ok: import name provided by google-api-python-client as _google_workspace_build_probe
        del _google_workspace_build_probe
    except ImportError:
        print(
            "ERROR: google-auth and google-api-python-client are not installed.\n"
            "Install with:\n"
            "  pip install google-auth google-api-python-client",
            file=sys.stderr,
        )
        sys.exit(1)

    scopes = [
        "https://www.googleapis.com/auth/admin.directory.user",
        "https://www.googleapis.com/auth/admin.directory.domain",
    ]
    creds = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_JSON, scopes=scopes
    ).with_subject(ADMIN_EMAIL)
    return creds


def _service():
    from googleapiclient.discovery import build  # badimport-ok: import name provided by google-api-python-client
    creds = _get_credentials()
    return build("admin", "directory_v1", credentials=creds)


def list_users(domain: str, max_results: int = 50):
    svc = _service()
    result = svc.users().list(domain=domain, maxResults=max_results, orderBy="email").execute()
    users = result.get("users", [])
    out = [{"email": u["primaryEmail"], "name": u.get("name", {}).get("fullName", ""), "suspended": u.get("suspended", False)} for u in users]
    print(json.dumps(out, indent=2))
    return out


def create_user(email: str, first_name: str, last_name: str, password: str):
    svc = _service()
    body = {
        "primaryEmail": email,
        "name": {"givenName": first_name, "familyName": last_name},
        "password": password,
        "changePasswordAtNextLogin": True,
    }
    result = svc.users().insert(body=body).execute()
    out = {"email": result["primaryEmail"], "id": result["id"]}
    print(json.dumps({"ok": True, "user": out}, indent=2))
    return out


def delete_user(email: str):
    svc = _service()
    svc.users().delete(userKey=email).execute()
    print(json.dumps({"ok": True, "deleted": email}))


def get_dkim(domain: str):
    svc = _service()
    result = svc.domains().dkimSettings().get(customer="my_customer", domainName=domain).execute()
    print(json.dumps(result, indent=2))
    return result


def generate_dkim(domain: str):
    """Triggers DKIM key generation. Returns the DNS TXT record to publish."""
    svc = _service()
    body = {"kind": "admin#directory#dkimSettings", "dkimEnabled": False}
    result = svc.domains().dkimSettings().update(customer="my_customer", domainName=domain, body=body).execute()
    dns_value = result.get("dkimPublicKeyValue", "")
    selector = result.get("dkimSelectorName", "google")
    print(json.dumps({
        "ok": True,
        "domain": domain,
        "dns_record_name": f"{selector}._domainkey.{domain}",
        "dns_record_value": f"v=DKIM1; k=rsa; p={dns_value}",
        "note": "Publish this TXT record in DNS, then call dkim enable to activate signing.",
    }, indent=2))
    return result


def enable_dkim(domain: str):
    svc = _service()
    body = {"kind": "admin#directory#dkimSettings", "dkimEnabled": True}
    result = svc.domains().dkimSettings().update(customer="my_customer", domainName=domain, body=body).execute()
    print(json.dumps({"ok": True, "dkimEnabled": result.get("dkimEnabled")}, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="Google Workspace Admin hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_users = sub.add_parser("users")
    users_sub = p_users.add_subparsers(dest="users_action", required=True)

    p_list = users_sub.add_parser("list")
    p_list.add_argument("--domain", required=True)
    p_list.add_argument("--max", type=int, default=50)

    p_create = users_sub.add_parser("create")
    p_create.add_argument("--email", required=True)
    p_create.add_argument("--first", required=True)
    p_create.add_argument("--last", required=True)
    p_create.add_argument("--password", required=True)

    p_del = users_sub.add_parser("delete")
    p_del.add_argument("email")

    p_dkim = sub.add_parser("dkim")
    dkim_sub = p_dkim.add_subparsers(dest="dkim_action", required=True)

    p_dkim_get = dkim_sub.add_parser("get")
    p_dkim_get.add_argument("domain")

    p_dkim_gen = dkim_sub.add_parser("generate")
    p_dkim_gen.add_argument("domain")

    p_dkim_en = dkim_sub.add_parser("enable")
    p_dkim_en.add_argument("domain")

    args = parser.parse_args()
    if args.action == "users":
        if args.users_action == "list":
            list_users(args.domain, args.max)
        elif args.users_action == "create":
            create_user(args.email, args.first, args.last, args.password)
        elif args.users_action == "delete":
            delete_user(args.email)
    elif args.action == "dkim":
        if args.dkim_action == "get":
            get_dkim(args.domain)
        elif args.dkim_action == "generate":
            generate_dkim(args.domain)
        elif args.dkim_action == "enable":
            enable_dkim(args.domain)


if __name__ == "__main__":
    main()
