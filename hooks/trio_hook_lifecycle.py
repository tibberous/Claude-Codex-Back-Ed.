# Compatibility shim — import from hook_lifecycle instead.
from hook_lifecycle import *  # noqa: F401,F403
from hook_lifecycle import (
    HookCompletedProcess,
    HookPhase,
    runHookCommand,
    startHookProcess,
    killHookPid,
)
