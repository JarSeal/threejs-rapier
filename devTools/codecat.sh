#!/usr/bin/env bash

# -------------------------
# Codecat installation to path:
#
# Move it to ~/.local/bin:
#   mkdir -p ~/.local/bin
#   cp codecat.sh ~/.local/bin/codecat
#   chmod +x ~/.local/bin/codecat
#
# Ensure it's in PATH:
#   echo $PATH
# If ~/.local/bin is Not there, add it:
#   echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
#   source ~/.bashrc
# Now you can run:
#   codecat "*.ts"
# -------------------------

# -------------------------
# Codecat autocomplete installation (make sure you have also the codecat_autocomplete file):
#
# mkdir -p ~/.bash_completion.d
# cp ./codecat_autocomplete ~/.bash_completion.d/codecat
# 
# echo 'for f in ~/.bash_completion.d/*; do source "$f"; done' >> ~/.bashrc
# source ~/.bashrc
# 
# -------------------------

VERSION="1.0.0"

search_path="."
copy_to_clipboard=false
use_color=true
max_lines=0
include_all=false

# Default excludes
default_excludes=("node_modules" ".git" "dist")
exclude_files=("*.log" "*.lock")
exclude_dirs=("${default_excludes[@]}")

# Colors
RED="\033[0;31m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
NC="\033[0m"

usage() {
  cat <<EOF
codecat v$VERSION

Usage: codecat [options] <filename> [more filenames...]
       codecat [options] --all

Description:
  Recursively finds files matching patterns and prints their contents
  with headers and a summary.

Options:
  -p, --path <path>            Path to search (default: current directory)
  -c, --copy                   Copy output to clipboard
  -h, --help                   Show this help message
  -v, --version                Show version and exit
      --exclude <dirs>         Comma-separated dirs to ignore (adds to defaults)
      --no-default-excludes    Disable default excludes (node_modules, .git, dist)
      --max-lines <n>          Limit lines per file (0 = no limit)
      --no-color, --no-colors  Disable colored output
      --all                    Include all files (no pattern needed)

Examples:
  codecat "*.ts"
  codecat -p ./src "*.ts"
  codecat --exclude build,tmp "*.js"
  codecat --no-default-excludes "*.log"
  codecat --max-lines 50 --color "*.ts"
  codecat -c "*.ts"

Notes:
  - Clipboard output is always plain text (no colors)
  - Default excluded dirs: node_modules, .git, dist
EOF
}

# -------------------------
# Parse args
# -------------------------
patterns=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--path)
      search_path="$2"
      shift 2
      ;;
    -c|--copy)
      copy_to_clipboard=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -v|--version)
      echo "codecat v$VERSION"
      exit 0
      ;;
    --exclude)
      IFS=',' read -r -a new_excludes <<< "$2"
      exclude_dirs+=("${new_excludes[@]}")
      shift 2
      ;;
    --no-default-excludes)
      exclude_dirs=()
      shift
      ;;
    --max-lines)
      max_lines="$2"
      shift 2
      ;;
    --no-color|--no-colors)
      use_color=false
      shift
      ;;
    --all)
      include_all=true
      shift
      ;;
    -*)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      patterns+=("$1")
      shift
      ;;
  esac
done

if [ "$include_all" = true ] && [ "${#patterns[@]}" -gt 0 ]; then
  echo "Warning: --all ignores provided patterns"
fi

# Disable color if not running in a terminal
if [ ! -t 1 ]; then
  use_color=false
fi

# -------------------------
# Validation
# -------------------------
if [ ! -d "$search_path" ]; then
  echo "Error: path '$search_path' does not exist"
  exit 1
fi

if [ "$include_all" = true ]; then
  patterns=("*")
elif [ "${#patterns[@]}" -eq 0 ]; then
  echo "No patterns provided."
  echo
  usage
  exit 0
fi

# -------------------------
# Build prune expression
# -------------------------
prune_args=()

if [ "${#exclude_dirs[@]}" -gt 0 ]; then
  prune_args+=( \( -type d \( )
  for i in "${!exclude_dirs[@]}"; do
    prune_args+=( -name "${exclude_dirs[$i]}" )
    if [ "$i" -lt $((${#exclude_dirs[@]} - 1)) ]; then
      prune_args+=( -o )
    fi
  done
  prune_args+=( \) -prune \) -o )
fi

file_exclude_args=()

for f in "${exclude_files[@]}"; do
  file_exclude_args+=( ! -name "$f" )
done

# -------------------------
# Output buffers
# -------------------------
output_plain=""
output_color=""
declare -a files=()

# -------------------------
# Main loop
# -------------------------
for pattern in "${patterns[@]}"; do
  while IFS= read -r file; do
    # Skip binary files
    if ! grep -Iq . "$file"; then
      continue
    fi

    files+=("$file")

    header="\n\n$file\n-------------------------------\n"

    if [ "$use_color" = true ]; then
      header_color="\n\n${CYAN}$file${NC}\n${YELLOW}-------------------------------${NC}\n"
    else
      header_color="$header"
    fi

    if [ "$max_lines" -gt 0 ]; then
      content=$(head -n "$max_lines" "$file")
    else
      content=$(cat "$file")
    fi

    output_plain+="$header$content"
    output_color+="$header_color$content"

  done < <(
    find "$search_path" \
      "${prune_args[@]}" \
      -type f -name "$pattern" \
      "${file_exclude_args[@]}" \
      -print
  )
done

# -------------------------
# Deduplicate files
# -------------------------
unique_files=($(printf "%s\n" "${files[@]}" | sort -u))

# -------------------------
# Summary
# -------------------------
summary="\n\n========== SUMMARY ==========\n"
summary+="Total files: ${#unique_files[@]}\n\nFiles:\n"

for f in "${unique_files[@]}"; do
  summary+="$f\n"
done

if [ "$use_color" = true ]; then
  summary_color="\n\n${RED}========== SUMMARY ==========${NC}\n"
  summary_color+="Total files: ${#unique_files[@]}\n\nFiles:\n"
  for f in "${unique_files[@]}"; do
    summary_color+="${CYAN}$f${NC}\n"
  done
else
  summary_color="$summary"
fi

output_plain+="$summary"
output_color+="$summary_color"

# -------------------------
# Runtime header (terminal only)
# -------------------------
runtime_header="\nCodecat version $VERSION\n"

if [ "${#exclude_dirs[@]}" -gt 0 ]; then
  runtime_header+="Excluded folders: "
  runtime_header+="$(IFS=,; echo "${exclude_dirs[*]}" | sed 's/,/, /g')"
  runtime_header+="\n"
else
  runtime_header+="Including all folders.\n"
fi

# -------------------------
# Print
# -------------------------
if [ "$use_color" = true ]; then
  printf "%b" "$runtime_header"
  printf "%b\n" "$output_color"
else
  printf "%b" "$runtime_header"
  printf "%b\n" "$output_plain"
fi

# -------------------------
# Clipboard (plain only)
# -------------------------
if [ "$copy_to_clipboard" = true ]; then
  if command -v clip.exe >/dev/null 2>&1; then
    printf "%b" "$output_plain" | clip.exe
    echo "Copied to clipboard (plain text)"
  elif command -v xclip >/dev/null 2>&1; then
    printf "%b" "$output_plain" | xclip -selection clipboard
    echo "Copied to clipboard (plain text)"
  elif command -v wl-copy >/dev/null 2>&1; then
    printf "%b" "$output_plain" | wl-copy
    echo "Copied to clipboard (plain text)"
  else
    echo "No clipboard tool found"
    exit 1
  fi
fi
