#!/usr/bin/env bash
# .claude/hooks/tool-lint.sh
set -uo pipefail

FILE=$(jq -r '.tool_input.file_path // empty')
[[ "$FILE" != *.ts && "$FILE" != *.tsx ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-}" 2>/dev/null || exit 0
# ESLint fails on a file outside the project (a scratchpad script)
[[ "$FILE" == /* && "$FILE" != "$PWD"/* ]] && exit 0
# The Node from .nvmrc: on an older default one, yarn refuses to run and this lint did nothing
source .claude/hooks/use-node.sh

# Autofix, then show the edit's remaining errors (exit 1; warnings don't block: --quiet). Exit 2 is
# ESLint itself failing, which the Stop hook reports.
LINT_OUT=$(yarn -s eslint --fix --quiet "$FILE" 2>&1)
if [[ $? -eq 1 ]]; then
  echo "Lint errors in $FILE:" >&2
  echo "$LINT_OUT" | grep -E '^\s+[0-9]+:[0-9]+' | head -20 >&2
  exit 2
fi

exit 0
