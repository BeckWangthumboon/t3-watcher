# T3 Watcher

T3 Watcher is a read-only macOS menu-bar companion for [T3 Code](https://github.com/pingdotgg/t3code). It keeps unsettled threads visible, sends native notifications when work needs attention or finishes, and can show an optional animated desktop pet.

This is a personal side project intended for tinkering. It currently expects macOS for the native app and Bun for the watcher service.

## How it connects

T3 Watcher has two small pieces:

1. The Bun service reads the orchestration shell from a T3 Code environment and exposes a normalized, read-only event stream.
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

Older repository-local `.watcher-connection.json` and `.watcher-token` files remain readable as a migration fallback, but new configuration is always written under `~/.t3-watcher`.

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

## Configuration

Copy `.env.example` to `.env` or set environment variables in the service manager.

| Variable | Purpose | Default |
| --- | --- | --- |
| `T3_HTTP_URL` | Explicit T3 Code backend URL; disables local discovery | discovered local server, then `http://127.0.0.1:3773` |
| `T3_RUNTIME_STATE_FILE` | Explicit T3 `server-runtime.json` to discover | T3's normal user and dev locations |
| `T3CODE_HOME` | Alternate T3 home used during discovery | `~/.t3` |
| `T3_CONNECTION_FILE` | Saved connection profile | `~/.t3-watcher/connection.json` |
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

- `!` — needs attention: approval, input, plan ready, or failure;
- `●` — starting or working;
- green `✓` — no active or attention-requiring work;
- `?` — the app cannot reach the watcher service.

The pet overlay reacts to the same lifecycle data. Drag it to move it, use **Pet Size** for a preset, and right-click it to hide it. Pets are loaded from `~/.codex/pets`. To copy Codex's built-in companion into that directory, run:

```sh
./scripts/install-codex-pet-asset.sh
```

Stopped or genuinely interrupted threads appear as **Ready** and do not increase the attention count. Finished state follows T3's external-awareness data rather than the client-local unread marker.

## Development checks

```sh
bun test
bun run typecheck
swift build -c release --product T3WatcherApp
```
