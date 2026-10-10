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
[[ -z "$(git status --porcelain -- src hub devTools vite.config.ts vitest.config.ts)" ]] && exit 0

# Autofix, then report what's left: --fix exits 1 with the errors it couldn't fix (warnings don't
# block: --quiet), 2 when ESLint itself failed
LINT_OUT=$(yarn -s lint --fix --quiet 2>&1)
LINT_STATUS=$?
if [[ $LINT_STATUS -eq 1 ]]; then
  echo "Lint errors. Fix before finishing:" >&2
  echo "$LINT_OUT" | sed "s|$PWD/||" | head -30 >&2
  exit 2
elif [[ $LINT_STATUS -ne 0 ]]; then
  echo "Lint failed to run:" >&2
  echo "$LINT_OUT" | tail -10 >&2
  exit 2
fi

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

# The unit tests (vitest.config.ts), when what they test changed: not for a Hub-only change
if [[ -n "$(git status --porcelain -- src devTools vitest.config.ts)" ]]; then
  if ! TEST_OUT=$(yarn -s test 2>&1); then
    echo "Unit tests failed. Fix before finishing:" >&2
    echo "$TEST_OUT" | grep -E '(FAIL|×|AssertionError|Error:|❯ .*:[0-9]+:[0-9]+)' | head -30 >&2
    echo "$TEST_OUT" | tail -5 >&2
    exit 2
  fi
fi

# The docs ratchet (p605): no folder of the documented API gets more undocumented exports or
# members than devTools/verify/baselines/docs.json records. TypeDoc converts (about 6 s) only when
# its inputs changed; --docs writes no progress log, so it never empties another run's.
if [[ -n "$(git status --porcelain -- src/_engine src/toolkit)" ]]; then
  DOCS_OUT=$(NO_COLOR=1 yarn -s verify:baselines --docs 2>&1)
  DOCS_STATUS=$?
  if [[ $DOCS_STATUS -eq 1 ]]; then
    echo "Undocumented exports added. Document them before finishing:" >&2
    echo "$DOCS_OUT" | sed -n '/^docs.json:/,$p' | head -40 >&2
    exit 2
  elif [[ $DOCS_STATUS -ne 0 ]]; then
    echo "The docs ratchet failed to run:" >&2
    echo "$DOCS_OUT" | tail -10 >&2
    exit 2
  fi
fi

exit 0
