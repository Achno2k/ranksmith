#!/usr/bin/env bash
# Points both agent CLIs at this repo's canonical skills for a site profile.
#
# The skills live here so the two backends cannot drift apart. Any existing directory
# in a CLI skills folder is moved aside to <name>.backup-<timestamp> rather than deleted.
set -euo pipefail

profile="${1:-connectmachine}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/profiles/$profile/skills"

[ -d "$source_dir" ] || { echo "No skills at $source_dir" >&2; exit 1; }

stamp="$(date +%Y%m%d%H%M%S)"

for target_dir in "$HOME/.codex/skills" "$HOME/.claude/skills"; do
  mkdir -p "$target_dir"

  for skill_path in "$source_dir"/*/; do
    skill="$(basename "$skill_path")"
    link="$target_dir/$skill"

    if [ -L "$link" ]; then
      rm "$link"
    elif [ -e "$link" ]; then
      mv "$link" "$link.backup-$stamp"
      echo "moved existing $link -> $link.backup-$stamp"
    fi

    ln -s "$source_dir/$skill" "$link"
    echo "linked $link"
  done
done

echo
echo "Done. connectmachine-seo-review is deliberately not linked: the runner owns"
echo "orchestration now, so that skill is retired."
