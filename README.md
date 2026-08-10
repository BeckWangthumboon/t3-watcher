# T3 Watcher

T3 Watcher is a read-only macOS menu-bar companion for the T3 Code instance running on `mintbox`.

## Everyday use

Start it from Spotlight by searching for **T3 Watcher**, or run:

```sh
open -a "T3 Watcher"
```

Click the eye in the menu bar to see every unsettled thread and its current state. The menu-bar counts mean:

- `!` — needs attention: approval, input, plan ready, or failure;
- `●` — starting or working;
- green `✓` — finished according to T3's external-awareness state;
- `?` — the Mac app cannot reach the watcher;
- `·` — no unsettled threads.

The experimental pet overlay floats above normal windows, stays in the same position across macOS Spaces, and reacts to the same T3 lifecycle data. Idle and running are its steady animation loops; finishing, failure, plan review, and requests for attention play once when a thread enters that state, then return to the current steady loop. Hovering plays three jump cycles and then idles until the pointer leaves, unless a thread-transition animation takes priority. At rest, its status badge is a short colored pill beneath the pet; hover over the pet to animate it into a count bubble at the lower right. An orange exclamation mark means a thread needs attention, red shows how many threads are working, and green shows finished threads when nothing more urgent is happening. The badge disappears when all counts are zero. Drag the pet to move it; its position is remembered between launches. The **Pet Size** menu has small, medium, and large presets, and remembers your selection. Right-click the pet and choose **Close pet** to hide it; **Show Pet** in the menu bar brings it back. Use **Pet** in the menu to choose a companion. Pets are loaded from `~/.codex/pets`; to make Codex's built-in companion available locally, run:

```sh
./scripts/install-codex-pet-asset.sh
```

Stopped or genuinely interrupted threads appear as **Ready** in the dropdown and do not increase the attention count. The finished check is not T3 Code's client-local unread **Done** marker, so opening a thread in T3 Code does not clear it.

Quit with **Quit T3 Watcher** at the bottom of its menu. To start it automatically after signing in, add **T3 Watcher** under **System Settings → General → Login Items**.

## What starts automatically

The backend is an enabled user-level systemd service on `mintbox`; it returns after reboots and reads the T3 nightly server at `127.0.0.1:3773`. The Mac app connects to it over Tailscale at `http://100.70.142.26:4173`.

Check the backend:

```sh
ssh mintbox 'systemctl --user status t3-watcher.service'
```

Restart it:

```sh
ssh mintbox 'systemctl --user restart t3-watcher.service'
```

If the eye shows `?`, first confirm Tailscale is connected, then restart the backend and relaunch the app.

## Updating the Mac app

From this repository:

```sh
./scripts/build-macos-app.sh
./scripts/install-macos-app.sh
```

The installer replaces `/Applications/T3 Watcher.app` and launches the new version. The app has no Dock icon.

## Development checks

```sh
bun test
bun run typecheck
swift build -c release --product T3WatcherApp
```
