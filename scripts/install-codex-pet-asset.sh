#!/bin/zsh
set -euo pipefail

codex_asar="/Applications/ChatGPT.app/Contents/Resources/app.asar"
pet_dir="${CODEX_HOME:-$HOME/.codex}/pets/codex"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

if [[ ! -f "$codex_asar" ]]; then
  echo "Codex app archive not found: $codex_asar" >&2
  exit 1
fi

asset_path="$(bun x asar list "$codex_asar" | sed -n 's#^/\(webview/assets/codex-spritesheet-[^/]*\.webp\)$#\1#p' | head -1)"
if [[ -z "$asset_path" ]]; then
  echo "Codex spritesheet was not found in the app archive." >&2
  exit 1
fi

(
  cd "$temporary_dir"
  bun x asar extract-file "$codex_asar" "$asset_path"
)

mkdir -p "$pet_dir"
cp "$temporary_dir/${asset_path:t}" "$pet_dir/spritesheet.webp"
printf '%s\n' \
  '{' \
  '  "id": "codex",' \
  '  "displayName": "Codex",' \
  '  "description": "The original Codex companion, driven by T3 Code.",' \
  '  "spritesheetPath": "spritesheet.webp"' \
  '}' > "$pet_dir/pet.json"

echo "$pet_dir"
