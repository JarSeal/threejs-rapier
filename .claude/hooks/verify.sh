#!/usr/bin/env bash
# .claude/hooks/verify.sh
set -uo pipefail

[[ "$(jq -r '.stop_hook_active // false')" == "true" ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-}" 2>/dev/null || exit 0

# Nothing changed in src/ (including new files) — skip.
[[ -z "$(git status --porcelain -- src)" ]] && exit 0

yarn lint --fix >/dev/null 2>&1

if ! OUT=$(yarn tsc --noEmit 2>&1); then
  echo "Type errors. Fix before finishing:" >&2
  echo "$OUT" | grep -E 'error TS' | head -30 >&2
  exit 2
fi

exit 0
