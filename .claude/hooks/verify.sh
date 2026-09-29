#!/usr/bin/env bash
# .claude/hooks/verify.sh
set -uo pipefail

[[ "$(jq -r '.stop_hook_active // false')" == "true" ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-}" 2>/dev/null || exit 0

# Nothing changed in src/ (including new files) — skip.
[[ -z "$(git status --porcelain -- src)" ]] && exit 0

# The hook's shell can start on an older default Node than package.json's engines field
# allows, and yarn then refuses to run at all. Prefer the newest nvm-installed Node.
NVM_NODE_DIR="$HOME/.nvm/versions/node"
if [[ -d "$NVM_NODE_DIR" ]]; then
  LATEST_NODE=$(ls "$NVM_NODE_DIR" | sort -V | tail -1)
  [[ -n "$LATEST_NODE" ]] && export PATH="$NVM_NODE_DIR/$LATEST_NODE/bin:$PATH"
fi

yarn lint --fix >/dev/null 2>&1

if ! OUT=$(yarn tsc --noEmit 2>&1); then
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
