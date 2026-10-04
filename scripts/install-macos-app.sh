#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
source_app="$repo_dir/dist/T3 Watcher.app"
installed_app="/Applications/T3 Watcher.app"

if [[ ! -d "$source_app" ]]; then
  "$repo_dir/scripts/build-macos-app.sh"
fi

# Preserve the endpoint compiled into older personal builds as a saved user
# preference before replacing the app with the configurable build.
if [[ -d "$installed_app" ]] && ! defaults read com.beck.t3-watcher watcherURL >/dev/null 2>&1; then
  previous_url=$(/usr/libexec/PlistBuddy -c 'Print :T3WatcherURL' "$installed_app/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n "$previous_url" && "$previous_url" != "http://127.0.0.1:4173" ]]; then
    defaults write com.beck.t3-watcher watcherURL "$previous_url"
  fi
fi

osascript -e 'tell application "T3 Watcher" to quit' 2>/dev/null || true
pkill -x "T3 Watcher" 2>/dev/null || true
while pgrep -x "T3 Watcher" >/dev/null; do sleep 0.1; done
ditto "$source_app" "$installed_app"
open -n "$installed_app"

echo "$installed_app"
