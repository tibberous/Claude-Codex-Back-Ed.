"""
Hook File: ollama_hook.py

What it does:
Simple Ollama wrapper that shells out to the local ollama CLI and logs each run to the database.

How to use it:
Run it against the installed ollama executable when you want a local-model command bridged through a hook.

Primary entry points:
db_connect, log_run, run_cmd, main

Notes:
This comment block documents the current code in this file. Review credentials, paths, and local dependencies before production use.
"""




# === LLM-USAGE: BEGIN ===
#
# Hook        : ollama_hook.py
# Audience    : language-model agent (Claude, GPT, Gemini, etc.)
# Surface     : flat top-level functions; no classes to subclass,
#               no hidden state across process boundaries.
#
# WHAT IT DOES
#   Simple Ollama wrapper that shells out to the local ollama CLI and logs each run to the database.
#
# HOW TO INVOKE
#   Run it against the installed ollama executable when you want a local-model command bridged through a hook.
#
# PRIMARY ENTRY POINTS
#   - db_connect
#   - log_run
#   - run_cmd
#   - main
#
# CREDENTIALS
#   API keys, tokens, and remote endpoints live in config.ini at
#   the repo root. Hooks read them via hooks/_config.py. Do NOT
#   hardcode keys in source. Do NOT push config.ini to the server
#   (it is on the auto-update exclude list in extension.js).
#
# SIDE EFFECTS
#   May make outbound network calls, may write to disk under the
#   repo root (logs/, chats/, reports/), may spawn subprocesses,
#   may touch the journaling DB through trio_hook_orm. Inspect
#   the function before running it on production data.
#
# THINGS THIS HOOK WILL NOT DO
#   - It will not reload the VSCode window. Nothing in this repo
#     reloads the window. See handbook.txt Section 8.
#   - It will not push files to the server. Pushing is gated on
#     config.ini [updates] is_admin=true and is handled by the
#     extension, not by individual hooks. See handbook.txt §17.
#   - It will not silently swallow errors. If it fails it raises
#     or returns a structured error; check the trace channel.
#
# RELATED HANDBOOK SECTIONS
#   §5 Tools   §17 Auto-update / is_admin   §21 Hooks library
#   §22 Trace channel   §24 Troubleshooting
#
# === LLM-USAGE: END ===
import sys
from datetime import datetime

from trio_hook_orm import log_hook

def log_run(action, prompt, model, status, output, exit_code):
    payload = (
        f"time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"action: {action}\n"
        f"model: {model}\n"
        f"status: {status}\n"
        f"exit_code: {exit_code}\n"
        f"prompt_preview: {(prompt or '')[:500]}\n"
        f"output:\n{(output or '')[:20000]}"
    )
    try:
        log_hook("ollama_hook_log", payload, 1 if status != 'ok' else 0)
    except Exception as error:
        print(f"[ollama_hook] log error: {error}", file=sys.stderr)

def run_cmd(args, stdin_text=None):
    from trio_hook_lifecycle import runHookCommand
    proc = runHookCommand(
        args,
        phaseName="ollama-command",
        input=stdin_text,
        text=True,
        capture_output=True,
        shell=False
    )
    return proc.returncode, proc.stdout, proc.stderr


def main():
    if len(sys.argv) < 2:
        print('Usage: python ollama_hook.py <action> [args...]')
        print('Actions: status | list | ps | pull <model> | run <model> <prompt...> | chat <model> <prompt...>')
        sys.exit(1)

    action = sys.argv[1].lower()
    prompt = ''
    model = ''

    if action in ('status', 'list'):
        code, out, err = run_cmd(['ollama', 'list'])
    elif action == 'ps':
        code, out, err = run_cmd(['ollama', 'ps'])
    elif action == 'pull':
        if len(sys.argv) < 3:
            print('Usage: python ollama_hook.py pull <model>')
            sys.exit(1)
        model = sys.argv[2]
        code, out, err = run_cmd(['ollama', 'pull', model])
    elif action in ('run', 'chat'):
        if len(sys.argv) < 4:
            print(f'Usage: python ollama_hook.py {action} <model> <prompt...>')
            sys.exit(1)
        model = sys.argv[2]
        prompt = ' '.join(sys.argv[3:])
        code, out, err = run_cmd(['ollama', 'run', model], stdin_text=prompt)
    else:
        print(f'Unknown action: {action}')
        sys.exit(1)

    combined = (out or '') + (('\n' + err) if err else '')
    status = 'ok' if code == 0 else 'error'
    log_run(action, prompt, model, status, combined, code)
    print(combined.strip())
    sys.exit(code)


if __name__ == '__main__':
    main()
