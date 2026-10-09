#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
source_app="$repo_dir/dist/T3 Pets.app"
installed_app="/Applications/T3 Pets.app"
legacy_app="/Applications/T3 Watcher.app"

if [[ ! -d "$source_app" ]]; then
  "$repo_dir/scripts/build-macos-app.sh"
fi

# Preserve the endpoint compiled into older builds. The new app migrates saved
# connection and pet preferences from the legacy bundle on its first launch.
if [[ -d "$legacy_app" ]] && ! defaults read com.beck.t3-watcher watcherURL >/dev/null 2>&1; then
  previous_url=$(/usr/libexec/PlistBuddy -c 'Print :T3WatcherURL' "$legacy_app/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n "$previous_url" && "$previous_url" != "http://127.0.0.1:4173" ]]; then
    defaults write com.beck.t3-watcher watcherURL "$previous_url"
  fi
fi

for app_name in "T3 Watcher" "T3 Pets"; do
  pkill -x "$app_name" 2>/dev/null || true
  while pgrep -x "$app_name" >/dev/null; do sleep 0.1; done
done
ditto "$source_app" "$installed_app"
# Keep the replaced app recoverable without a duplicate in Applications.
if [[ -d "$legacy_app" ]]; then
  legacy_trash="$HOME/.Trash/T3 Watcher-$(date +%Y%m%d-%H%M%S).app"
  mv "$legacy_app" "$legacy_trash"
fi
open -n "$installed_app"

echo "$installed_app"
