# T3 Watcher

A small, read-only companion for seeing which T3 Code threads are still unsettled.

> **Draft:** the native menu-bar interface is intentionally minimal. It validates the workflow before investing in finished product design.

The validation build runs beside T3 Code, polls its compact shell snapshot, keeps state in memory, and serves a minimal live-updating web interface. It does not read T3's database or mutate threads.

## Current deployment

The watcher is running on `mintbox` and is available to devices on the same Tailnet:

<http://100.70.142.26:4173>

It targets the installed T3 server at `127.0.0.1:3773` with a dedicated `orchestration:read` session. It is an enabled user-level systemd service and automatically returns after `mintbox` reboots.

Check it with:

```sh
ssh mintbox 'systemctl --user status t3-watcher.service'
```

Restart it with:

```sh
ssh mintbox 'systemctl --user restart t3-watcher.service'
```

Stop it with:

```sh
ssh mintbox 'systemctl --user stop t3-watcher.service'
```

## Local development

Install dependencies:

```sh
bun install
```

Run with representative demo data:

```sh
WATCHER_DEMO=1 bun run dev
```

Then open <http://127.0.0.1:4173>.

Run against a real environment by copying `.env.example` to `.env` and supplying a bearer token or token file. Bun loads `.env` automatically.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `T3_HTTP_URL` | `http://127.0.0.1:3773` | T3 environment HTTP endpoint. |
| `T3_BEARER_TOKEN` | unset | Inline T3 bearer credential. Prefer the file option. |
| `T3_BEARER_TOKEN_FILE` | unset | File containing a T3 bearer credential. |
| `WATCHER_NAME` | `mintbox` | Source label shown in the UI. |
| `WATCHER_POLL_MS` | `2000` | Shell refresh interval. |
| `WATCHER_AUTO_SETTLE_DAYS` | `3` | Inactivity window, or `never`. |
| `WATCHER_HOST` | `127.0.0.1` | Interface on which the UI listens. |
| `PORT` | `4173` | UI port. |
| `T3_WEB_URL` | unset | Optional T3 web base URL for clickable thread rows. |
| `WATCHER_DEMO` | unset | Set to `1` to use demo data. |

## API

- `GET /api/snapshot` returns the current normalized watcher state.
- `GET /api/events` streams complete snapshots with Server-Sent Events.
- `GET /api/health` reports whether the T3 source is live.

The complete snapshot is intentionally sent on every update. This keeps the frontend stateless and is inexpensive for a personal thread list.

## Verification

```sh
bun test
bun run typecheck
```

## Deliberate shortcuts

- HTTP polling instead of T3's Effect RPC WebSocket stream.
- One configured T3 environment.
- No database or notification history.
- No recovery of transitions while the watcher is stopped.
- No exact change-request-aware settlement calculation.
- Ad-hoc local code signing instead of Developer ID distribution or notarization.

These are validation choices. The normalized snapshot/SSE boundary is shared by the native app and the legacy SwiftBar prototype.

## Native macOS app

Build and package the app:

```sh
./scripts/build-macos-app.sh
```

Install it in `/Applications` and launch it:

```sh
./scripts/install-macos-app.sh
```

After that, start it like any other app—from Spotlight, Finder, or:

```sh
open -a "T3 Watcher"
```

Quit from its menu or run:

```sh
osascript -e 'tell application "T3 Watcher" to quit'
```

To start it automatically when you sign in, add **T3 Watcher** under **System Settings → General → Login Items**. The app has no Dock icon; the eye and its counts are the application UI.

The native app holds one SSE connection to the watcher, displays a green completed check using native attributed text, and sends macOS notifications for noteworthy transitions. It is configured for the current Tailnet URL in `packaging/Info.plist`.

## Legacy SwiftBar prototype

The repository retains the earlier streamable SwiftBar plugin at `swiftbar/t3-watcher.ts` as a prototype, but the installed plugin is disabled now that the native app replaces it.

The plugin:

- shows attention, running, completed, empty, and disconnected states in the menu bar;
- lists unsettled threads in its dropdown;
- keeps cached rows visible when the watcher disconnects;
- reconnects with bounded backoff;
- suppresses notifications for its initial snapshot;
- sends notifications when a thread becomes waiting, failed, interrupted, or completed.

It defaults to the current Tailnet URL and can be pointed elsewhere with `T3_WATCHER_URL`.

The plugin is deliberately view-only. It has no links to the draft browser interface, no acknowledgment state, and no mutation actions. An SF Symbols `eye` replaces the text title while keeping the status counts visible, for example `eye !1 ●2 ✓3`: `!` is attention (waiting, failed, or interrupted), `●` is running, and the green `✓` is completed.
