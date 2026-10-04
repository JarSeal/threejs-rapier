# .claude/hooks/use-node.sh — source it (bash or zsh), don't run it.
# Puts the nvm-installed Node that .nvmrc names first on PATH. A shell can start on an older
# default Node than package.json's engines field allows, and yarn then refuses to run at all, so
# every check (lint, tsc, yarn scripts) would fail or silently do nothing.
# Its status is non-zero when that Node isn't installed, so `source … && yarn …` stops there.
_aek_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_aek_version=$(tr -d ' \t\r\nv' < "$_aek_root/.nvmrc" 2>/dev/null)
_aek_bin="${NVM_DIR:-$HOME/.nvm}/versions/node/v$_aek_version/bin"
if [ -n "$_aek_version" ] && [ -x "$_aek_bin/node" ]; then
  export PATH="$_aek_bin:$PATH"
  _aek_node_ok=1
else
  echo "use-node.sh: Node v$_aek_version from .nvmrc isn't installed (nvm install $_aek_version)" >&2
  _aek_node_ok=0
fi
unset _aek_root _aek_version _aek_bin
[ "$_aek_node_ok" = 1 ]
