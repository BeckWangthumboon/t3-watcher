# T3 Watcher

T3 Watcher is a read-only macOS menu-bar companion for [T3 Code](https://github.com/pingdotgg/t3code). It keeps unsettled threads visible, sends native notifications when work needs attention or finishes, and can show an optional animated desktop pet.

This is a personal side project intended for tinkering. It currently expects macOS for the native app and Bun for the watcher service.

## How it connects

T3 Watcher has two small pieces:

1. The Bun service reads the orchestration shells from one or more T3 Code environments and exposes a normalized, read-only event stream.
2. The macOS app connects to that service from the same Mac, a LAN address, or a private network such as Tailscale.

The service follows T3 Code's connection model. It verifies `/.well-known/t3/environment`, accepts a normal T3 pairing URL, and exchanges the one-time pairing credential for a bearer token scoped only to `orchestration:read`.

When both programs run on the same machine, the service can also discover T3 Code from its persisted `~/.t3/userdata/server-runtime.json` or `~/.t3/dev/server-runtime.json` state. An explicit backend URL always wins.

## Quick start on one Mac

Requirements:

- macOS 13 or newer;
- Bun;
- Swift 6 toolchain;
- a running T3 Code server.

Install dependencies and start the service:

```sh
bun install
bun run start
```

If T3 Code requires authentication, create a fresh pairing URL and give it to the watcher once:

```sh
npx t3 pair
bun run configure -- 'PASTE_THE_PAIRING_URL_HERE'
bun run start
```

The configure command requests only read access and saves its files with owner-only permissions:

```text
~/.t3-watcher/
├── connection.json  # backend URL, environment ID and label
└── token            # secret read-only bearer token
```

Older repository-local `.watcher-connection.json` and `.watcher-token` files remain readable as a migration fallback. New configuration is written under `~/.t3-watcher`, or the directory selected with `WATCHER_CONFIG_DIR`.

T3 Code access tokens currently expire after 30 days and can also be revoked from its Connections settings. If that happens, create a new pairing URL and run the configure command again.

Build and install the menu-bar app:

```sh
./scripts/build-macos-app.sh
./scripts/install-macos-app.sh
```

The app defaults to `http://127.0.0.1:4173`. Choose **Configure Watcher…** from its menu to save a different service URL.

## A remote T3 Code host

Run the Bun service on the same host as T3 Code so that its upstream URL can remain private and loopback-only. On that host:

```sh
npx t3 pair
bun run configure -- 'PASTE_THE_PAIRING_URL_HERE'
WATCHER_HOST=0.0.0.0 bun run start
```

Then choose **Configure Watcher…** in the Mac app and enter the service URL reachable from your Mac, for example `http://your-tailnet-host:4173`.

Binding to `0.0.0.0` makes thread titles and lifecycle state available to anything that can reach port 4173. Use a trusted LAN or private network; do not expose the watcher service directly to the public internet.

The included [`packaging/t3-watcher.service`](packaging/t3-watcher.service) is an example user-level systemd unit. Adjust its working directory and bind address for the host where you install it.

## Multiple T3 backends

Run one watcher service on a machine that can reach every T3 backend, such as your Mac on Tailscale. Generate a fresh pairing URL for each backend and save it with a local name:

```sh
bun run configure -- --name mintbox 'MINTBOX_PAIRING_URL'
bun run configure -- --name studio 'STUDIO_PAIRING_URL'
bun run start
```

The pairing URLs must advertise backend addresses reachable from the watcher machine. A remote server's `127.0.0.1` URL is only reachable from that server itself.

Each named backend has its own read-only token:

```text
~/.t3-watcher/backends/
├── mintbox/
│   ├── connection.json
│   └── token
└── studio/
    ├── connection.json
    └── token
```

An existing default `~/.t3-watcher/connection.json` remains included alongside named backends. If only named backends exist, the service watches those and does not add an implicit localhost backend. Unset `T3_HTTP_URL` and `T3_CONNECTION_FILE` for aggregation: either variable deliberately selects a single backend. Check an older `.env` for an explicit URL before enabling multiple backends.

Restart the service after adding, re-pairing, or removing a backend. Reusing `--name` replaces only that backend's profile. To remove one, delete its directory under `backends` and restart.

Threads show their backend label in the Mac menu and web dashboard. Polling and authentication errors are isolated per backend. A partly connected service keeps live backends updating, marks unavailable backends' threads as cached, and adds a `?` beside the live menu-bar status. Cached threads do not trigger notifications or pet transitions.

## T3 version compatibility and notifications

The watcher supports the legacy shell used by stable T3 `v0.0.45` (protocol 1 when advertised) and the protocol-2 shell introduced in October 2026 nightlies. Protocol-2 requests include `x-t3-orchestration-protocol: 2`; runs, runtime requests, and background work are adapted into watcher states. Unsupported future protocols produce an explicit connection error.

Background subagents and monitors show **Waiting on background work**, while a command left running (such as a dev server) allows the completed run to show **Finished**. Usage limits need attention. Subagent child threads, deleted threads, and currently snoozed threads are excluded; pinned threads and threads with automatic settlement disabled remain visible.

T3 Code also has built-in alerts under **Settings → General → Thread notifications**, with notifications, sounds, or both. They cover connected environments while the desktop or web client is open. If you prefer those alerts, turn off **Notify on Thread Changes** in the watcher menu; the menu bar and pet continue working. Mobile background push requires T3 Connect and agent activity publishing.

## Configuration

Copy `.env.example` to `.env` or set environment variables in the service manager.

| Variable | Purpose | Default |
| --- | --- | --- |
| `T3_HTTP_URL` | Explicit single-backend URL; disables saved-backend aggregation and discovery | saved profiles, discovered local server, then `http://127.0.0.1:3773` |
| `T3_RUNTIME_STATE_FILE` | Explicit T3 `server-runtime.json` to discover | T3's normal user and dev locations |
| `T3CODE_HOME` | Alternate T3 home used during discovery | `~/.t3` |
| `T3_CONNECTION_FILE` | Explicit single-backend connection profile | default profile plus named profiles |
| `WATCHER_CONFIG_DIR` | Watcher profile and token directory | `~/.t3-watcher` |
| `T3_BEARER_TOKEN` | Inline upstream token | none |
| `T3_BEARER_TOKEN_FILE` | Upstream token file | `~/.t3-watcher/token` when present |
| `WATCHER_NAME` | Display-name override | T3's advertised environment label |
| `WATCHER_POLL_MS` | Upstream polling interval | `2000` |
| `WATCHER_AUTO_SETTLE_DAYS` | Hide inactive finished threads, or `never` | `3` |
| `WATCHER_HOST` | Service bind address | `127.0.0.1` |
| `PORT` | Service port | `4173` |
| `T3_WEB_URL` | Optional browser base used for thread links | none |

`T3_HTTP_URL` and `T3_BEARER_TOKEN` remain useful for temporary or containerized setups. For a persistent authenticated environment, `bun run configure` is the easier path.

## Everyday use

Click the eye in the menu bar to see every unsettled thread and its state. The counts mean:

- orange `!` with count — needs attention: approval, input, plan ready, failure, or usage limit;
- red `●` with count — starting or working;
- green `✓` — no active or attention-requiring work;
- `?` — the app cannot reach the watcher service, or one or more T3 backends are unavailable.

The pet overlay reacts to the same lifecycle data. Its small bar shows active orange (needs you), red (working), and green (finished) segments together. Hover for separate indicators with each exact count, including zero, and a tiny, quick pulse. Drag it to move it, use **Pet Size** for a preset, and right-click it to hide it. Pets are loaded from `~/.codex/pets`. To copy Codex's built-in companion into that directory, run:

```sh
./scripts/install-codex-pet-asset.sh
```

Stopped or genuinely interrupted threads appear as **Ready** and do not increase the attention count. Finished state follows T3's turn/run lifecycle rather than the client-local unread marker. Initial snapshots and backend reconnections do not replay historical notifications.

## Development checks

```sh
bun test
bun run typecheck
swift build -c release --product T3WatcherApp
```
