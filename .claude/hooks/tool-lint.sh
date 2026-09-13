#!/usr/bin/env bash
# .claude/hooks/tool-lint.sh
set -uo pipefail

FILE=$(jq -r '.tool_input.file_path // empty')
[[ "$FILE" != *.ts && "$FILE" != *.tsx ]] && exit 0

cd "${CLAUDE_PROJECT_DIR:-}" 2>/dev/null || exit 0
yarn eslint --fix "$FILE" >/dev/null 2>&1

exit 0
