# T3 Watcher — Validation Plan

## Objective

Validate that a separate process can observe one running T3 Code environment, derive its unsettled threads, and show them remotely in a clean live-updating interface.

> Implementation note: the validation build uses the authenticated HTTP shell snapshot every two seconds instead of the Effect RPC WebSocket stream. This removes the private-workspace dependency while preserving the same compact source model. WebSocket streaming can replace the polling adapter later without changing the UI API.

This is a personal side-project MVP. It intentionally assumes:

- T3 Code is already running;
- one T3 environment is selected explicitly;
- the watcher runs on the same dev box as that environment;
- `mintbox` and the Mac are on the same Tailnet;
- losing watcher state on restart is acceptable;
- the first UI is a web page, not a native menu-bar application;
- no task mutations are supported.

## Proposed MVP

Run one Bun service on `mintbox`:

```text
T3 Code server (already running)
        |
        | localhost HTTP/WebSocket
        v
T3 Watcher (Bun, in memory)
  - T3 connection adapter
  - shell snapshot/cache
  - unsettled/status evaluator
  - SSE endpoint
  - static HTML UI
        |
        | Portless + Tailscale
        v
Mac browser
```

The watcher connects to exactly one configured T3 endpoint, subscribes to `orchestration.subscribeShell`, keeps the latest shell snapshot in memory, and broadcasts normalized state to connected browsers.

Portless is used only to expose the watcher UI. The watcher-to-T3 connection remains local to `mintbox`, so the frontend does not need T3 authentication, T3 Connect, DPoP, or Effect RPC knowledge.

## Why this is the first version

- It proves the T3 subscription and classification logic.
- It proves remote delivery from `mintbox` to the Mac.
- It gives us a usable interface immediately.
- It avoids committing to SwiftUI, Electron, Tauri, or a menu-bar interaction model.
- The watcher API can later sit behind any native frontend.

## Technology choices

- Runtime: Bun + TypeScript.
- Server: Bun's built-in HTTP server.
- Live browser updates: Server-Sent Events (SSE).
- UI: one static HTML page with a small CSS and TypeScript/JavaScript module; no framework.
- State: in-memory maps only.
- Remote access: Portless `--tailscale`, with direct Tailnet access as a fallback.
- Configuration: environment variables or a local ignored config file.

## Configuration

The MVP should require explicit values rather than attempting discovery:

- `T3_HTTP_URL`
- `T3_WS_URL`
- `T3_BEARER_TOKEN` or a path to a dedicated read-only credential
- `WATCHER_NAME`, defaulting to `mintbox`
- watcher listen host/port as needed by Portless

The T3 credential should have only `orchestration:read` access. It must never be sent to the browser or written to logs.

If the local T3 development server supports an authenticated local-primary connection without a bearer token, the initial spike may use that path. The adapter should still keep authentication behind one interface.

## Minimal normalized model

The browser does not receive raw T3 shells. It receives a small model:

```ts
type WatcherStatus =
  | "waiting"
  | "failed"
  | "interrupted"
  | "running"
  | "completed"
  | "active";

interface WatchedThread {
  key: string; // environmentId:threadId
  environmentId: string;
  threadId: string;
  projectId: string;
  projectTitle: string | null;
  title: string;
  status: WatcherStatus;
  latestTurnId: string | null;
  updatedAt: string;
}

interface WatcherSnapshot {
  watcher: "connecting" | "live" | "stale" | "error";
  sourceUpdatedAt: string | null;
  threads: WatchedThread[];
}
```

Status precedence:

1. waiting;
2. failed;
3. interrupted;
4. running;
5. completed;
6. active.

For the validation build, unknown settlement inputs fail toward visibility. It is acceptable to show an extra thread; silently hiding work is not acceptable.

## HTTP surface

- `GET /` — minimal watcher UI.
- `GET /api/snapshot` — current normalized state.
- `GET /api/events` — SSE stream; sends a full snapshot on connection and whenever normalized state changes.
- `GET /api/health` — watcher process and T3 connection status.

Sending a full normalized snapshot over SSE is intentionally acceptable for the MVP. The monitored set should be small, and this avoids an event protocol and client reducer.

## Minimal UI

The page should contain:

- a small header: `T3 Watcher` and connection state;
- a count of unsettled threads;
- sections for `Needs you`, `Working`, and `Finished / Active`;
- one compact row per thread with status dot, title, project, and relative update time;
- an explicit stale banner when T3 or the watcher loses its upstream connection;
- an empty state that distinguishes `No unsettled threads` from `Disconnected`.

No settings, animations, notification history, task controls, authentication UI, or elaborate responsive system are required.

Rows may initially link to a configured T3 web base URL. If the correct thread URL cannot be constructed reliably, rows can be non-interactive for the first validation.

## Work plan

### Phase 1 — Connectivity spike

Build a CLI script that:

1. targets one explicit running T3 instance on `mintbox`;
2. obtains a WebSocket ticket if required;
3. opens the T3 RPC WebSocket;
4. subscribes to `orchestration.subscribeShell`;
5. prints only project/thread IDs, titles, shell sequence, and derived status;
6. survives one ordinary disconnect/reconnect.

This is the highest-risk phase because T3 uses Effect RPC JSON framing and its reusable packages are private workspace packages. For the personal MVP, linking to the existing T3 checkout on `mintbox` is acceptable. We should not copy the wire protocol by hand unless reuse proves impractical.

Exit criterion: a real running thread changes status in the CLI without polling or reading T3's database.

### Phase 2 — Pure watcher state

Extract and test:

- shell snapshot/event application;
- unsettled classification;
- status derivation;
- archived/removed filtering;
- project-title joining;
- stable sorting;
- stale/live connection state.

Keep previous state only in memory. Do not implement notification deduplication or durable history yet.

Exit criterion: fixture tests cover running, waiting, completed, failed, interrupted, removed, and disconnected states.

### Phase 3 — Web service and UI

Add the four HTTP endpoints and static UI. SSE reconnect should refresh from a complete snapshot, so no cursor persistence is necessary.

Exit criterion: opening the page locally on `mintbox` shows the same unsettled threads as the CLI spike and updates without refreshing.

### Phase 4 — Tailnet exposure

Run the service through a stable Portless name, for example:

```sh
portless t3-watcher --tailscale bun run dev
```

If Portless sharing is awkward, bind the watcher to the Tailscale interface and use `http://100.70.142.26:<port>` temporarily.

Exit criterion: the Mac loads the UI over the Tailnet and sees a live status change from the selected T3 environment.

### Phase 5 — Real-use validation

Use the page during normal work for a few sessions and record only concrete friction:

- statuses that feel wrong;
- threads that should or should not appear;
- whether completed threads disappear too quickly;
- whether a notification would have been useful;
- whether project/environment labels are sufficient;
- whether opening the T3 thread is necessary for the next iteration.

Only after this validation should we choose the native shell.

## Explicit non-goals for this build

- SQLite or another database;
- multiple T3 environments;
- operation while T3 is stopped;
- recovering transitions missed while the watcher itself was stopped;
- native notifications;
- launch-at-login packaging;
- App Store distribution or signing;
- approvals, replies, settling, or any mutation;
- exact change-request-aware settlement parity;
- production-grade authentication for multiple users;
- Cloudflare infrastructure.

## Known shortcuts and risks

### T3 workspace coupling

The quickest adapter will likely import T3 contracts/client-runtime from the T3 checkout on `mintbox`. This is deliberately coupled. Pinning or extracting an adapter can happen only if the prototype earns continued use.

### Change-request settlement

Change-request state is not included in the shell record. The MVP should conservatively retain ambiguous threads rather than fetch every thread's full detail.

### No persistence

Restarting the watcher clears its state. The next T3 snapshot repopulates the current list, but transitions that occurred while it was down are not reconstructed or notified.

### Exposure

The UI reveals task titles and project names. It must be Tailnet-only for the MVP. Do not use a public Portless funnel.

### Selecting the T3 instance

`mintbox` currently has many T3 development server processes from different worktrees. The watcher must use an explicit endpoint and must not guess based on process names or kill/restart any existing process.

## Validation success criteria

The prototype is successful when:

1. one command starts it on `mintbox`;
2. the Mac can open it over Tailscale;
3. it shows the selected environment's unsettled threads;
4. running, waiting, completed, failed, and interrupted states render correctly in ordinary use;
5. updates appear within a few seconds without a page refresh;
6. upstream disconnection is shown as stale rather than as an empty task list;
7. the implementation has no database and does not read T3's SQLite files.

## Likely next iteration

If the watcher proves useful, preserve the Bun watcher/API and replace the browser surface with a small macOS `MenuBarExtra` app. The native app can consume the same snapshot/SSE API and add notifications, Keychain storage for the watcher URL/token, and launch-at-login without learning the T3 protocol.
