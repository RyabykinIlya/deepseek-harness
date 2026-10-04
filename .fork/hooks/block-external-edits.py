"""Deny tool calls that would modify a tree this fork does not own.

Protected trees, and why each is off limits:

- ``vendor/``       pinned source copies of Cordis and its foundation libraries.
                    Edits here are overwritten by the next sync and silently
                    diverge the framework layer from its recorded upstream commit.
- ``patches/``      pnpm patch files against real npm packages. A hand edit here
                    changes what every install applies.
- ``node_modules/`` installed dependencies. Edits vanish on the next install.

Reads one PreToolUse payload on stdin, writes a decision as JSON on stdout.
Anything it cannot read is allowed: a guard that fails closed on malformed input
would wedge the session, and this exists to stop accidents, not attacks.
"""

import datetime
import json
import os
import pathlib
import re
import sys

PROTECTED = ("vendor/", "patches/", "node_modules/")

# Only these trees INSIDE this repository are protected. A path of the same name
# elsewhere on the filesystem is someone else's business: this script lives at
# <repo>/.fork/hooks/, so the root is two directories up.
REPO_ROOT = str(pathlib.Path(__file__).resolve().parent.parent.parent)

REASONS = {
    "vendor/": "vendor/ holds pinned copies of third-party source. Edits are lost at the next sync and diverge the framework from its recorded upstream commit. Update it through the procedure in vendor/README.md.",
    "patches/": "patches/ holds pnpm patch files against real npm packages. A hand edit changes what every install applies. Regenerate the patch instead.",
    "node_modules/": "node_modules/ holds installed dependencies. Edits are lost at the next install. Change the dependency or add a pnpm patch instead.",
}

# Commands that write when handed a path, and the redirections that do the same.
MUTATORS = re.compile(
    r"""(?:^|[;&|(]|\s)(?:
        rm | mv | cp | install | ln | mkdir | rmdir | touch | truncate | dd |
        chmod | chown | chgrp | tee | patch | unzip | tar | shred |
        sed\s+[^|;&]*-[a-zA-Z]*i | perl\s+[^|;&]*-[a-zA-Z]*i |
        git\s+(?:checkout|restore|apply|rm|mv|clean|stash)
    )(?![\w-])""",
    re.VERBOSE,
)
# PowerShell cmdlets that write, for the `pwsh` tool. The POSIX list above names
# none of them, so without this a pwsh session is unguarded.
PS_MUTATORS = re.compile(
    r"""(?:^|[;&|(]|\s)(?:
        Remove-Item | Set-Content | Add-Content | Clear-Content | Out-File |
        Copy-Item | Move-Item | New-Item | Rename-Item | Set-ItemProperty |
        Set-Acl | ri | rm | del | erase | cp | copy | mv | move | ni | sc | ac
    )(?![\w-])""",
    re.VERBOSE | re.IGNORECASE,
)
REDIRECT = re.compile(r">>?\s*\S*(?:" + "|".join(re.escape(p) for p in PROTECTED) + r")")
# A quoted or unquoted heredoc body, so text merely QUOTED in a script is not read
# as a path the command touches. Writing a guard that mentions these trees is not
# the same as writing into them.
HEREDOC_BODY = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?.*?^\s*\1\s*$", re.DOTALL | re.MULTILINE)
# Segment separators: a mutator only counts against a path in its own segment.
SEGMENTS = re.compile(r"(?:\|\||&&|[;|\n])")


def protected_root(text: str) -> str | None:
    """The first protected tree a path falls in, or None.

    One pattern serves both a bare file path and a shell command, where the same
    directory can follow a space, a quote or an ``=``. The lookbehind rejects a
    preceding word character, dot or dash, so ``my-vendor/x``, ``myvendor/x`` and
    ``packages/vendor-utils/`` are left alone while ``vendor/x``, ``./vendor/x``,
    ``-i vendor/x`` and an absolute path into the repository all match.
    """
    for root in PROTECTED:
        name = root.rstrip("/")
        for match in re.finditer(r"(?<![\w.-])" + re.escape(name) + r"/", text):
            # Walk back to the start of the token so an absolute path can be told
            # from a bare one, then keep only paths inside this repository.
            start = match.start()
            while start > 0 and text[start - 1] not in " \t\n\"'=(;&|<>":
                start -= 1
            token = text[start:match.end()]
            if token.startswith("/") and not token.startswith(REPO_ROOT):
                continue
            return root
    return None


def deny(root: str, what: str) -> None:
    trace(what, root)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"Blocked: {what} would modify {root}. {REASONS[root]} If the sync procedure genuinely requires this, create .fork/.allow-external-edit, make the change, then delete it.",
        },
    }))
    sys.exit(0)


def allowed_by_override() -> bool:
    """Whether this call is exempt.

    Two forms, because a PreToolUse hook cannot see an inline ``VAR=1 cmd``
    prefix: the harness spawns the hook with its OWN environment, so the variable
    reaches the hook only when it was exported before the harness started. The
    sentinel file is the form that works mid-session — create it, do the sync,
    delete it. Both are deliberate acts; neither happens by accident.
    """
    if os.environ.get("DSH_ALLOW_VENDOR_EDIT") == "1":
        return True
    return (pathlib.Path(REPO_ROOT) / ".fork" / ".allow-external-edit").exists()


def trace(what: str, root: str) -> None:
    """Append one line per refusal, so what the guard caught is reviewable.

    Only refusals: an entry per call was clobbered within seconds by routine tool
    use, and the question it answered — whether the hook runs at all — is settled.
    Refusals are rare, so appending stays small. A failure to write is ignored:
    diagnostics must not break the guard.
    """
    try:
        with (pathlib.Path(REPO_ROOT) / ".fork" / ".blocked-edits.log").open("a") as log:
            log.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {root} {what}\n")
    except OSError:
        pass


def main() -> None:
    if allowed_by_override():
        return
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return
    tool = payload.get("tool_name", "")
    args = payload.get("tool_input") or {}
    if not isinstance(args, dict):
        return

    if tool in ("Write", "Edit", "NotebookEdit", "write", "edit", "str_replace_editor"):
        # str_replace_editor multiplexes read and write under one name; `view`
        # is the read, and reading these trees is how their content is seen.
        if tool == "str_replace_editor" and str(args.get("command") or "") == "view":
            return
        path = args.get("file_path") or args.get("notebook_path") or args.get("path") or ""
        root = protected_root(str(path))
        if root is not None:
            deny(root, f"{tool} on {path}")
        return

    if tool in ("Bash", "bash", "pwsh"):
        mutators = PS_MUTATORS if tool == "pwsh" else MUTATORS
        command = HEREDOC_BODY.sub("", str(args.get("command") or ""))
        # Correlate per segment: a mutator in one command says nothing about a path
        # named in another. Without this, `chmod x && grep y vendor/` reads as a
        # write into vendor/.
        for segment in SEGMENTS.split(command):
            root = protected_root(segment)
            if root is None:
                continue
            # A path alone is not a write: grep, cat, ls and sed -n over these trees
            # are how their contents get read at all.
            if mutators.search(segment) or REDIRECT.search(segment):
                deny(root, "this command")
        return


if __name__ == "__main__":
    main()
