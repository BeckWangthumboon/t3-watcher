#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
app_name="T3 Watcher"
bundle_dir="$repo_dir/dist/$app_name.app"
contents_dir="$bundle_dir/Contents"

cd "$repo_dir"
swift build -c release --product T3WatcherApp

rm -rf "$bundle_dir"
mkdir -p "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$repo_dir/.build/release/T3WatcherApp" "$contents_dir/MacOS/$app_name"
cp "$repo_dir/packaging/Info.plist" "$contents_dir/Info.plist"
codesign --force --deep --sign - "$bundle_dir"

echo "$bundle_dir"
