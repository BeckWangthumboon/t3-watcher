#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
source_app="$repo_dir/dist/T3 Watcher.app"
installed_app="/Applications/T3 Watcher.app"

if [[ ! -d "$source_app" ]]; then
  "$repo_dir/scripts/build-macos-app.sh"
fi

osascript -e 'tell application "T3 Watcher" to quit' 2>/dev/null || true
pkill -x "T3 Watcher" 2>/dev/null || true
while pgrep -x "T3 Watcher" >/dev/null; do sleep 0.1; done
ditto "$source_app" "$installed_app"
open -n "$installed_app"

echo "$installed_app"
