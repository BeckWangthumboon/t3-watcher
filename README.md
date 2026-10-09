# T3 Pets

T3 Pets brings animated desktop pets to [T3 Code](https://github.com/pingdotgg/t3code). Your pet reacts as agents work, finish, or need you, with live status counts beneath it and in the macOS menu bar. Notifications are handled by T3 Code.

This is a personal side project intended for tinkering. It currently expects macOS for the native app and Bun for the T3 Pets service.

Install the latest code from [BeckWangthumboon/t3-pets](https://github.com/BeckWangthumboon/t3-pets).

## How it connects

T3 Pets has two small pieces:

1. The Bun service subscribes to live thread changes from one or more T3 Code environments and exposes a normalized, read-only event stream to the pet app.
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

If T3 Code requires authentication, create a fresh pairing URL and give it to T3 Pets once:

```sh
npx t3 pair
bun run configure -- 'PASTE_THE_PAIRING_URL_HERE'
bun run start
```

The configure command requests only read access and saves its files with owner-only permissions:

```text
~/.t3-pets/
├── connection.json  # backend URL, environment ID and label
└── token            # secret read-only bearer token
```

New installations save configuration under `~/.t3-pets`, or the directory selected with `T3_PETS_CONFIG_DIR`. Existing `~/.t3-watcher` profiles, including named backends and credentials, remain in use when `~/.t3-pets` does not exist. The legacy `WATCHER_*` variables and repository-local `.watcher-connection.json` and `.watcher-token` files remain supported. The renamed macOS app also imports your saved connection, pet, size, and position.

T3 Code access tokens currently expire after 30 days and can also be revoked from its Connections settings. If that happens, create a new pairing URL and run the configure command again.

Build and install the menu-bar app:

```sh
./scripts/build-macos-app.sh
./scripts/install-macos-app.sh
```

The app defaults to `http://127.0.0.1:4173`. Choose **Configure Connection…** from its menu to save a different service URL.

## A remote T3 Code host

Run the Bun service on the same host as T3 Code so that its upstream URL can remain private and loopback-only. On that host:

```sh
npx t3 pair
bun run configure -- 'PASTE_THE_PAIRING_URL_HERE'
T3_PETS_HOST=0.0.0.0 bun run start
```

Then choose **Configure Connection…** in the Mac app and enter the service URL reachable from your Mac, for example `http://your-tailnet-host:4173`.

Binding to `0.0.0.0` makes thread titles and lifecycle state available to anything that can reach port 4173. Use a trusted LAN or private network; do not expose the T3 Pets service directly to the public internet.

The included [`packaging/t3-pets.service`](packaging/t3-pets.service) is an example user-level systemd unit. Adjust its working directory and bind address for the host where you install it.

## Multiple T3 backends

Run one T3 Pets service on a machine that can reach every T3 backend, such as your Mac on Tailscale. Generate a fresh pairing URL for each backend and save it with a local name:

```sh
bun run configure -- --name mintbox 'MINTBOX_PAIRING_URL'
bun run configure -- --name studio 'STUDIO_PAIRING_URL'
bun run start
```

The pairing URLs must advertise backend addresses reachable from the machine running T3 Pets. A remote server's `127.0.0.1` URL is only reachable from that server itself.

Each named backend has its own read-only token:

```text
~/.t3-pets/backends/
├── mintbox/
│   ├── connection.json
│   └── token
└── studio/
    ├── connection.json
    └── token
```

An existing default `~/.t3-pets/connection.json` remains included alongside named backends. If only named backends exist, the service watches those and does not add an implicit localhost backend. Unset `T3_HTTP_URL` and `T3_CONNECTION_FILE` for aggregation: either variable deliberately selects a single backend. Check an older `.env` for an explicit URL before enabling multiple backends.

Restart the service after adding, re-pairing, or removing a backend. Reusing `--name` replaces only that backend's profile. To remove one, delete its directory under `backends` and restart.

Threads show their backend label in the Mac menu and web dashboard. Connection and authentication errors are isolated per backend. A partly connected service keeps live backends updating, marks unavailable backends' threads as cached, and adds a `?` beside the live menu-bar status. Cached threads do not trigger pet transitions.

## T3 version compatibility

Protocol-2 backends use the live `orchestration.subscribeShell` WebSocket subscription. T3 Pets loads one HTTP snapshot, catches up from its sequence, and then reacts to streamed changes. The socket uses a short-lived authentication ticket and the existing `orchestration:read` permission. Heartbeats check connectivity and keep time-based status counts current.

Older backends use HTTP polling. If streaming disconnects, T3 Pets keeps cached data visible, resumes polling, and retries the live subscription every 30 seconds with a fresh snapshot. Initial state and reconnect catch-up do not replay historical pet reactions. Each backend chooses its own transport; `/api/health` reports `transport: "stream"` or `"poll"` for each backend.

T3 Pets supports the legacy shell used by stable T3 `v0.0.45` (protocol 1 when advertised) and the protocol-2 shell introduced in October 2026 nightlies. Protocol-2 requests include `x-t3-orchestration-protocol: 2`; runs, runtime requests, and background work are adapted into pet states. Unsupported future protocols produce an explicit connection error.

Background subagents and monitors show **Waiting on background work**, while a command left running (such as a dev server) allows the completed run to show **Finished**. Usage limits need attention. Subagent child threads, deleted threads, and currently snoozed threads are excluded; pinned threads and threads with automatic settlement disabled remain visible.

Use T3 Code’s **Settings → General → Thread notifications** for alerts and sounds. T3 Pets does not request notification permissions or send notifications; it handles pets and status indicators.

## Configuration

Copy `.env.example` to `.env` or set environment variables in the service manager.

| Variable | Purpose | Default |
| --- | --- | --- |
| `T3_HTTP_URL` | Explicit single-backend URL; disables saved-backend aggregation and discovery | saved profiles, discovered local server, then `http://127.0.0.1:3773` |
| `T3_RUNTIME_STATE_FILE` | Explicit T3 `server-runtime.json` to discover | T3's normal user and dev locations |
| `T3CODE_HOME` | Alternate T3 home used during discovery | `~/.t3` |
| `T3_CONNECTION_FILE` | Explicit single-backend connection profile | default profile plus named profiles |
| `T3_PETS_CONFIG_DIR` | Pet service profile and token directory | `~/.t3-pets` |
| `T3_BEARER_TOKEN` | Inline upstream token | none |
| `T3_BEARER_TOKEN_FILE` | Upstream token file | `~/.t3-pets/token` when present |
| `T3_PETS_NAME` | Display-name override | T3's advertised environment label |
| `T3_PETS_POLL_MS` | Polling interval for legacy backends and streaming fallback | `2000` |
| `T3_PETS_AUTO_SETTLE_DAYS` | Hide inactive finished threads, or `never` | `3` |
| `T3_PETS_HOST` | Service bind address | `127.0.0.1` |
| `PORT` | Service port | `4173` |
| `T3_WEB_URL` | Optional browser base used for thread links | none |

`T3_HTTP_URL` and `T3_BEARER_TOKEN` remain useful for temporary or containerized setups. For a persistent authenticated environment, `bun run configure` is the easier path.

## Everyday use

Click the T3 icon in the menu bar to see every unsettled thread and its state. The counts mean:

- orange `!` with count — needs attention: approval, input, plan ready, failure, or usage limit;
- red `●` with count — starting or working;
- green `✓` — no active or attention-requiring work;
- `?` — the app cannot reach the T3 Pets service, or one or more T3 backends are unavailable.

The pet overlay reacts to the same lifecycle data. Its small bar shows active orange (needs you), red (working), and green (finished) segments together. Hover for separate indicators with each exact count, including zero, and a tiny, quick pulse. Drag it to move it, use **Pet Size** for a preset, and right-click it to hide it. Pets are loaded from `~/.codex/pets`. To copy Codex's built-in companion into that directory, run:

```sh
./scripts/install-codex-pet-asset.sh
```

Stopped or genuinely interrupted threads appear as **Ready** and do not increase the attention count. Finished state follows T3's turn/run lifecycle rather than the client-local unread marker. Initial snapshots and backend reconnections do not replay historical pet transitions.

## Development checks

```sh
bun test
bun run typecheck
swift build -c release --product T3PetsApp
```
