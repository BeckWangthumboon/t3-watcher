#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
app_name="T3 Pets"
bundle_dir="$repo_dir/dist/$app_name.app"
contents_dir="$bundle_dir/Contents"
iconset_dir="$repo_dir/dist/T3Pets.iconset"
icon_source="$repo_dir/packaging/T3PetsAppIcon.svg"

cd "$repo_dir"
swift build -c release --product T3PetsApp

rm -rf "$bundle_dir" "$iconset_dir"
mkdir -p "$contents_dir/MacOS" "$contents_dir/Resources"
cp "$repo_dir/.build/release/T3PetsApp" "$contents_dir/MacOS/$app_name"
cp "$repo_dir/packaging/Info.plist" "$contents_dir/Info.plist"

mkdir -p "$iconset_dir"
for icon_size in 16 32 128 256 512; do
  sips -s format png -z "$icon_size" "$icon_size" "$icon_source" --out "$iconset_dir/icon_${icon_size}x${icon_size}.png" >/dev/null
  doubled_size=$((icon_size * 2))
  sips -s format png -z "$doubled_size" "$doubled_size" "$icon_source" --out "$iconset_dir/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset_dir" -o "$contents_dir/Resources/T3Pets.icns"
codesign --force --deep --sign - "$bundle_dir"

echo "$bundle_dir"
