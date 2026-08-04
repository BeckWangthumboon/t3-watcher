# PRD: T3 Code Unsettled Thread Watcher

Status: Draft

## Summary

Build a small macOS companion for T3 Code that keeps track of active, or “unsettled,” tasks while the user is away from the main T3 Code interface.

The companion should answer one question quickly:

> Which T3 Code tasks still need attention, and what is happening with them right now?

The product is intentionally separate from the main development workspace. It may eventually appear as a menu-bar utility, a small floating companion, a Codex-pet-like character, or another SwiftUI surface. The first product decision is not the visual form; it is the reliable status model and notification behavior behind that form.

## Product intention

T3 Code can have multiple tasks running against a remote development environment. The user should not need to keep the full app open or repeatedly check each task to know whether work is still running, has completed, has failed, or is waiting for them.

The watcher should provide ambient awareness with low interruption:

- show the current state of unsettled tasks;
- make meaningful state changes noticeable;
- preserve enough context to identify the task and environment;
- let the user jump back into the existing T3 Code experience when action is required;
- avoid pretending that “completed” means “settled” or that a quiet task is necessarily finished.

This is a monitoring and notification companion, not a second T3 Code client for editing, reviewing, terminal work, or task control.

## Goals

1. Monitor unsettled T3 Code threads in near real time.
2. Correctly distinguish active execution, completion, failure/interruption, and work waiting on the user.
3. Work when the T3 Code backend is remote and reached through T3 Connect.
4. Notify only on useful transitions, with deduplication and user-controlled preferences.
5. Reconnect safely after sleep, network changes, server restarts, or expired credentials.
6. Link each item back to the corresponding task in T3 Code.
7. Keep the implementation independent from the final macOS presentation layer.

## Non-goals

- Reimplement the T3 Code task UI.
- Stream full messages, diffs, terminal output, or files into the companion.
- Start, stop, approve, settle, snooze, or otherwise mutate tasks in the first version.
- Define a new server-side notion of “unsettled.”
- Require a polling service or a new cloud database for the first version.
- Commit to a menu-bar app, floating pet, dock app, or any other final visual treatment yet.

## Users and primary use case

The primary user runs T3 Code locally or remotely, often through T3 Connect, starts several tasks, and then moves to another application. They want a lightweight indication of whether those tasks are still working and a notification when one reaches a meaningful edge.

Example:

1. The user starts three tasks in T3 Code.
2. The watcher shows three unsettled items, two running and one waiting for approval.
3. The user leaves T3 Code.
4. One task completes and another fails.
5. The watcher updates immediately and sends notifications according to the user’s settings.
6. Selecting an item opens the existing T3 Code task for inspection or action.

## Product vocabulary

### Thread

A T3 Code task/conversation. The watcher should use the T3 Code thread ID as its stable identity.

### Turn

A unit of agent work inside a thread. A thread can remain unsettled after its latest turn completes, for example because it has an open review/change request or because the user has explicitly kept it active.

### Unsettled

Whether a thread belongs in the watcher’s monitored set. This is not simply “the latest turn is running.” It is the same effective settlement calculation used by T3 Code’s clients.

### Status

The short human-facing state shown for an unsettled thread. Status is derived from the authoritative shell fields; it is not a new server field.

## Correct information model

### Source of truth

The watcher should consume the T3 Code environment’s authenticated orchestration shell stream:

`orchestration.subscribeShell`

The stream provides an initial snapshot and subsequent `thread-upserted` / `thread-removed` events. Each thread shell contains the compact fields needed for monitoring:

- `id`, `projectId`, and `title`;
- `latestTurn` with turn ID, state, and timestamps;
- `session` with execution status and update timestamp;
- `settledOverride` and `settledAt`;
- `latestUserMessageAt`;
- `hasPendingApprovals`;
- `hasPendingUserInput`;
- `hasActionableProposedPlan`.

This is preferable to polling thread details or scraping the T3 Code UI. It is the same read model already used by the web and mobile clients, and it contains the information needed for a compact watcher without transferring full conversation contents.

### Determining whether a thread is unsettled

The watcher should mirror the current `effectiveSettled` behavior from T3 Code’s shared client runtime.

A thread is unsettled when any of the following applies:

- it has pending approval or pending user input;
- its session is starting or running;
- it has a newly queued turn start that has not yet been adopted;
- its explicit settlement override is `active`;
- its explicit settlement override is not `settled`, and it has not met the automatic settlement conditions;
- it is associated with an open change request, which blocks inactivity-based settlement.

A thread is settled when the activity blockers are absent and one of the settlement rules applies, including an explicit `settled` override, a merged/closed change request, or the configured inactivity policy.

Important: “unsettled” is a visibility/attention classification, while “completed” is a turn outcome. The watcher must support an unsettled thread whose latest turn is completed.

The watcher should use the same server/configuration inputs that T3 Code uses for `effectiveSettled`, including the automatic-settlement window and change-request state where available. If a required input is unavailable, it should fail toward visibility: keep the thread monitored rather than silently hiding it.

### Determining the displayed status

The first status mapping should be:

| Display status | Derivation | User meaning |
| --- | --- | --- |
| Waiting for you | `hasPendingApprovals` or `hasPendingUserInput` | The task cannot proceed without the user. |
| Running | session is `starting`/`running`, or latest turn state is `running` | Agent work is in progress. |
| Completed | latest turn state is `completed`, with no higher-priority waiting/error state | The latest turn finished; the thread may still be unsettled. |
| Failed | session is `error`, or latest turn state is `error` | The task needs inspection. |
| Interrupted | session is `interrupted`/`stopped`, or latest turn state is `interrupted` | The latest run did not finish normally. |
| Active | unsettled but no current run or exceptional state is present | The thread remains active under T3 Code’s settlement rules. |

The precedence order matters. “Waiting for you” should win over “running,” and failure should not be hidden by a generic active state.

### Completion edge handling

The watcher must retain previous state long enough to detect meaningful transitions. In particular, it must process a transition such as:

`unsettled + running` → `unsettled + completed` → `settled`

as a completion notification opportunity before removing the thread from the monitored set. A completed turn can become settled immediately, so filtering only the newest snapshot for currently unsettled threads could lose the completion event.

Transition identity should use the thread ID plus the latest turn ID and relevant status timestamps. Notifications must be idempotent across reconnects and replayed shell events.

## Connection and remote-backend requirements

The backend is remote from the watcher’s point of view, including the user’s T3 Connect setup. The watcher should connect to the T3 environment through the normal T3 client connection model:

1. Resolve the saved environment and access target.
2. Connect directly to the environment’s HTTP/WebSocket endpoint, including a managed T3 Connect relay endpoint when configured.
3. Obtain a short-lived WebSocket ticket through `POST /api/auth/websocket-ticket` using the appropriate bearer or DPoP credential.
4. Open the WebSocket with the ticket and subscribe to `orchestration.subscribeShell`.
5. Maintain the subscription through the existing connection supervisor/reconnect model.

For T3 Connect, the relay brokers credentials and a managed endpoint; application traffic then flows over the provisioned tunnel endpoint. The watcher does not need to create a separate cloud polling API or replicate orchestration state in its own service.

The watcher should request read-only orchestration access. Monitoring requires the `orchestration:read` scope; mutation scopes are not needed for the first version.

### Connection states exposed to the user

The watcher should distinguish:

- connected and monitoring;
- connecting/reconnecting;
- offline or unreachable;
- authenticated but lacking monitoring permission;
- no environment configured.

Connection failure should never be presented as “all tasks are complete.” The last known task state may remain visible, but it must be marked stale when the connection is unavailable.

### Sleep and wake

After macOS sleep or network changes, the watcher should reconnect and request a fresh shell snapshot or a safe catch-up from the last sequence. It should reconcile against the snapshot rather than replaying notifications for every item that remained unchanged.

## Notification behavior

Notifications are a secondary output of the watcher’s state machine, not the source of truth.

### Initial notification candidates

Notify on:

- running → completed;
- running → failed;
- running → interrupted;
- any state → waiting for you;
- an unseen task becoming active after the watcher was already running, if enabled by preference.

Do not notify merely because:

- a shell snapshot was received;
- the WebSocket reconnected;
- a task remains running;
- a task became settled without a meaningful completion/error edge;
- a duplicate or coalesced event was received.

### Notification content

A notification should contain only enough information to identify the event:

- task title;
- project or environment name where available;
- short status phrase;
- optional duration or “waiting for approval/input” hint.

The primary action should open the existing T3 Code task. Deep-link format and whether the target is opened in the desktop app or browser remain implementation decisions.

### User controls

The first version should support at least:

- enable/disable notifications;
- choose which transitions notify;
- mute while the main T3 Code window is focused, if the platform integration can determine this reliably;
- clear or acknowledge a notification without changing the T3 Code thread.

Per-thread notification history should be persisted locally only as a small deduplication record, keyed by thread ID, turn ID, transition, and timestamp/version.

## Functional requirements

### Monitoring

- Subscribe to the shell stream for each configured environment the user elects to monitor.
- Maintain a local normalized record of the latest shell state and the previous state needed for transition detection.
- Show only currently unsettled threads in the primary monitored list.
- Preserve a short-lived “recently completed” or event history so a just-completed task is not lost when it settles.
- Support multiple environments and prevent collisions by keying records by `(environmentId, threadId)`.
- Remove archived/deleted/removed threads from active monitoring while retaining enough history to suppress duplicate notifications.

### Reliability

- Handle the initial snapshot, live events, replay/catch-up, and reconnect reconciliation.
- Treat sequence numbers as ordering/deduplication metadata.
- Handle coalesced thread updates; never assume one event equals one domain transition.
- Detect stale connection state and expose it clearly.
- Keep all timestamps in UTC internally and localize only at presentation time.

### Privacy and security

- Store credentials using the macOS-secure mechanism appropriate to the selected client architecture.
- Never put long-lived bearer or DPoP credentials in a WebSocket URL.
- Use short-lived WebSocket tickets as T3 Code does.
- Request the smallest scope necessary: read-only orchestration access.
- Do not copy full task messages or source-code content into notifications or local logs.
- Make environment selection explicit; do not silently monitor every reachable environment.

## Proposed architecture

The architecture should have four replaceable layers:

```text
T3 environment / T3 Connect
          |
Authenticated WebSocket + orchestration.subscribeShell
          |
Connection adapter
          |
Shell cache + settlement/status evaluator
          |
Transition detector + notification policy
          |
Platform presentation surface
```

### T3 connection adapter

Prefer reusing the existing T3 client-runtime connection and authorization behavior. A standalone native SwiftUI app would otherwise need to reproduce environment discovery, T3 Connect credential exchange, WebSocket ticket acquisition, DPoP signing where applicable, reconnect behavior, and schema decoding.

This makes the main technical decision:

- If the watcher lives inside the existing T3 desktop app, the MVP can reuse most of the current runtime and add a platform presentation layer.
- If it is a separate native macOS app, it should either share a small protocol/runtime package with T3 Code or use a narrow companion bridge rather than reimplementing the full client stack in Swift.

The product should remain presentation-agnostic so this decision can be made after validating the monitoring behavior.

### Shell cache

Store the latest shell per `(environmentId, threadId)` and the last observed sequence per environment. The cache is an operational cache, not an authoritative database.

At startup:

1. load minimal local metadata for deduplication and preferences;
2. connect and receive a fresh snapshot/catch-up;
3. rebuild the active set using the current settlement policy;
4. suppress notifications for unchanged states;
5. resume transition detection only after synchronization is complete.

### State evaluator

Implement the evaluator as a pure, well-tested module with explicit inputs:

- thread shell;
- current time;
- automatic settlement configuration;
- change-request state, if available;
- previous normalized state for transition detection.

The evaluator should be tested against the same edge cases as T3 Code’s `effectiveSettled` logic, especially pending user input, queued turn starts, explicit overrides, open change requests, and inactivity.

### Presentation adapter

The presentation adapter consumes a small view model and has no authority over settlement or connection semantics. It can later drive:

- a menu-bar item and popover;
- a floating SwiftUI panel;
- a small animated companion/pet;
- a notification-only background utility;
- or more than one surface.

No one of these is required by this PRD.

## MVP scope

The MVP is successful if it can:

1. connect to one selected remote T3 environment through the existing authentication path;
2. receive the shell snapshot and live shell events;
3. classify threads using the current settlement logic;
4. show unsettled threads and their derived statuses;
5. detect completion, failure, interruption, and user-input/approval transitions;
6. reconnect after a temporary outage without duplicate notifications;
7. send a native macOS notification for selected transitions;
8. deep-link back to the existing T3 Code task;
9. clearly communicate when monitoring is stale or disconnected.

The visual shell can be a temporary developer surface during MVP validation.

## Future possibilities

- Monitor multiple environments with per-environment grouping.
- Add notification actions after the read-only model is proven.
- Add a compact “recently completed” history.
- Add quiet hours, focus-mode integration, and per-project rules.
- Add a server-supported filtered shell subscription if client-side filtering becomes too expensive at scale.
- Add a small read-only status API if a native Swift client needs a simpler integration boundary.

These should follow evidence from actual usage. A server-side filtered subscription is not required for the first version because `subscribeShell` already provides compact thread shells and the current client settlement logic is available to mirror.

## Validation plan

### Correctness scenarios

Test at minimum:

- a running thread completes and remains unsettled;
- a completed thread settles immediately;
- a thread waits for approval;
- a thread waits for user input;
- a thread fails while the watcher is disconnected and is discovered on reconnect;
- a thread is explicitly unsettled after being settled;
- an open change request prevents inactivity-based settlement;
- a queued turn start is not missed;
- duplicate/coalesced shell events do not duplicate notifications;
- a deleted or archived thread disappears from active monitoring;
- multiple environments have identical thread IDs but remain distinct.

### Observability

For development diagnostics, log only non-sensitive metadata:

- environment ID;
- connection state and reconnect reason;
- shell sequence;
- thread ID;
- previous and next derived status;
- notification decision and deduplication key.

Do not log prompts, assistant text, file contents, credentials, or ticket values.

## Open decisions

1. Is the companion embedded in the existing T3 desktop app or a separate SwiftUI process?
2. Should it continue monitoring when the main T3 Code app is fully quit?
3. Is one environment enough for the first release, or should environment selection be part of MVP?
4. Which transitions deserve notifications by default?
5. Should completed-but-still-unsettled threads remain visible until the user opens them, until they settle, or only for a short recent-history period?
6. What deep-link format should open a specific T3 Code task?
7. Should the companion be read-only initially, or should it eventually support approve/respond actions?
8. What is the preferred visual form: menu bar, floating panel, pet, or a combination?

## Current implementation references

The PRD is based on the current T3 Code codebase after the latest fast-forward update on 2026-08-04.

- [Orchestration shell and stream contracts](/Users/beck/projects/t3code/packages/contracts/src/orchestration.ts)
- [Shared settlement resolution](/Users/beck/projects/t3code/packages/client-runtime/src/state/threadSettled.ts)
- [Remote connection architecture](/Users/beck/projects/t3code/docs/internals/remote.md)
- [Authentication and WebSocket ticket behavior](/Users/beck/projects/t3code/docs/internals/environment-auth.md)
- [Client/server architecture and turn completion semantics](/Users/beck/projects/t3code/docs/internals/overview.md)
- [Server-side RPC authorization map](/Users/beck/projects/t3code/apps/server/src/auth/RpcAuthorization.ts)

