#!/usr/bin/env bash
# Skills are edited in .claude/skills/. This copies every skill there (a dir with SKILL.md)
# to .agents/skills/ for Codex. Never edit .agents/skills/ by hand.
#   --write  regenerate the copies (the pre-commit hook runs this)
#   --check  exit 1 if any copy differs from its source
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mode=${1:---check}; rc=0
for src in .claude/skills/*/; do
  [[ -f "$src/SKILL.md" ]] || continue
  name=$(basename "$src"); dst=".agents/skills/$name"
  case "$mode" in
    --write) rm -rf "$dst"; cp -R "$src" "$dst" ;;
    --check) diff -rq "$src" "$dst" >/dev/null 2>&1 || { echo "stale: $dst (run fork/skills-mirror.sh --write)"; rc=1; } ;;
    *) echo "usage: $0 --write|--check" >&2; exit 2 ;;
  esac
done
exit $rc
