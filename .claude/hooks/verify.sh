#!/usr/bin/env bash
# .claude/hooks/verify.sh
set -uo pipefail

[[ "$(jq -r '.stop_hook_active // false')" == "true" ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-}" 2>/dev/null || exit 0

# The Node from .nvmrc: the hook's shell can start on an older default one, and yarn then
# refuses to run at all
source .claude/hooks/use-node.sh

# Version rules (project version = engine version, valid semver). package.json is outside
# src/, so this runs before the src/ skip below, and only when package.json changed. The
# per-part bump check (--against main) is for before a PR, not every stop.
if [[ -n "$(git status --porcelain -- package.json)" ]]; then
  if ! VERSION_OUT=$(yarn -s checkVersions 2>&1); then
    echo "Version rule violations. Fix package.json before finishing:" >&2
    echo "$VERSION_OUT" >&2
    exit 2
  fi
fi

# Nothing changed in the code (src/, the Hub, the dev tools; new files included) — skip.
[[ -z "$(git status --porcelain -- src hub devTools vite.config.ts)" ]] && exit 0

yarn lint --fix >/dev/null 2>&1

# The root project, then the Hub's browser TS (hub/tsconfig.json)
if ! OUT=$(yarn tsc --noEmit 2>&1 && yarn tsc -p hub --noEmit 2>&1); then
  TS_ERRORS=$(echo "$OUT" | grep -E 'error TS' | head -30)
  if [[ -n "$TS_ERRORS" ]]; then
    echo "Type errors. Fix before finishing:" >&2
    echo "$TS_ERRORS" >&2
  else
    # Not a type error (e.g. yarn itself failed) — show what did happen.
    echo "Type-check failed to run:" >&2
    echo "$OUT" | tail -10 >&2
  fi
  exit 2
fi

exit 0
