#!/usr/bin/env bash
# Refuse a commit that stages a change under a tree this fork does not own.
#
# The harness-independent layer. The PreToolUse hook in .fork/hooks.json stops an
# agent working through Claude Code or dsh; this stops everything else — another
# tool, another agent, a hand edit in an editor. Nothing reaches a branch without
# passing here.
#
# node_modules is absent from the list: it is gitignored, so it cannot be staged.
# pnpm-lock.yaml is absent: pnpm regenerates it and the result belongs in commits.
#
# Escape hatch, for the documented sync procedure:
#   DSH_ALLOW_VENDOR_EDIT=1 git commit ...
set -euo pipefail

if [[ "${DSH_ALLOW_VENDOR_EDIT:-}" == "1" ]]; then
  exit 0
fi

offending=$(git diff --cached --name-only --diff-filter=ACMRT \
  | grep -E '^(vendor|patches)/' || true)

if [[ -n "$offending" ]]; then
  echo 'external tree guard: this commit changes a tree this fork does not own:'
  printf '%s\n' "$offending" | sed 's/^/  /'
  echo
  echo '  vendor   pinned third-party source; follow the sync procedure in its README.'
  echo '  patches  pnpm patch files; regenerate with `pnpm patch` instead of editing.'
  echo
  echo 'If the sync procedure genuinely requires it: DSH_ALLOW_VENDOR_EDIT=1 git commit ...'
  exit 1
fi
