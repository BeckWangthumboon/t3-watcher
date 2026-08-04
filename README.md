# T3 Watcher

A small, read-only companion for seeing which T3 Code threads are still unsettled.

> **Draft:** the current browser interface is a disposable validation surface. It is intentionally not the final menu-bar application or finished product design.

The validation build runs beside T3 Code, polls its compact shell snapshot, keeps state in memory, and serves a minimal live-updating web interface. It does not read T3's database or mutate threads.

## Current deployment

The watcher is running on `mintbox` and is available to devices on the same Tailnet:

<http://100.70.142.26:4173>

It targets the installed T3 server at `127.0.0.1:3773` with a dedicated `orchestration:read` session. The service is a transient user-level systemd unit, so it survives SSH disconnects but does not automatically return after `mintbox` reboots.

Check it with:

```sh
ssh mintbox 'systemctl --user status t3-watcher.service'
```

Restart it after a reboot with:

```sh
ssh mintbox 'cd /home/beckthemaster/Documents/code/projects/t3-watcher && systemd-run --user --unit=t3-watcher --property=WorkingDirectory=$PWD --property=Restart=on-failure --setenv=T3_HTTP_URL=http://127.0.0.1:3773 --setenv=T3_BEARER_TOKEN_FILE=$PWD/.watcher-token --setenv=WATCHER_NAME=mintbox --setenv=WATCHER_HOST=100.70.142.26 --setenv=PORT=4173 /usr/local/bin/bun src/server.ts'
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
- No dedicated native application package yet; SwiftBar is the Mac frontend.

These are validation choices. The normalized snapshot/SSE boundary can remain in place if the frontend later becomes a native macOS menu-bar application.

## SwiftBar draft

The repository includes a streamable SwiftBar plugin at `swiftbar/t3-watcher.ts`. It holds one SSE connection to the watcher, so menu-bar updates arrive as soon as the watcher publishes a new snapshot rather than waiting for a refresh interval.

The plugin:

- shows attention, running, completed, empty, and disconnected states in the menu bar;
- lists unsettled threads in its dropdown;
- keeps cached rows visible when the watcher disconnects;
- reconnects with bounded backoff;
- suppresses notifications for its initial snapshot;
- sends notifications when a thread becomes waiting, failed, interrupted, or completed.

It defaults to the current Tailnet URL and can be pointed elsewhere with `T3_WATCHER_URL`.

The plugin is deliberately view-only. It has no links to the draft browser interface, no acknowledgment state, and no mutation actions. An SF Symbols `eye` replaces the text title while keeping the status counts visible, for example `eye !1 ●2 ✓3`: `!` is attention (waiting, failed, or interrupted), `●` is running, and the green `✓` is completed.
