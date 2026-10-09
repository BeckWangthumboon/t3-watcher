import { describe, expect, test } from "bun:test";
import { T3ShellProjection, subscribeT3Shell } from "./t3-stream.ts";
import { v2Shell } from "./test-fixtures.ts";
import { parseT3Shell } from "./t3-shell.ts";
import { T3Poller } from "./poller.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherConfig } from "./config.ts";
import { DEMO_SHELL } from "./demo.ts";

const status = (shell: unknown) => parseT3Shell(shell, new Date().toISOString()).threads[0]?.watcherStatus;
const configFor = (url: URL): WatcherConfig => ({ t3HttpUrl: url.toString().replace(/\/$/, ""),
  bearerToken: "test-token", watcherName: null, pollMs: 25, autoSettleAfterDays: null,
  hostname: "127.0.0.1", port: 0, webBaseUrl: null, demo: false });

async function waitUntil(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for stream state");
    await Bun.sleep(5);
  }
}

describe("shell stream projection", () => {
  test("metadata refreshes cannot erase threads or skip an overlapping lifecycle delta", () => {
    const projection = new T3ShellProjection(v2Shell({ status: "running" }));
    projection.apply({ kind: "snapshot", resolvedRepositoryIdentityRoots: ["/project"],
      snapshot: { ...v2Shell(), snapshotSequence: 100, threads: [] } });
    expect(projection.snapshotSequence).toBe(1);
    expect(status(projection.snapshot)).toBe("running");
    projection.apply({ kind: "thread.updated", sequence: 2, location: "active", thread: v2Shell().threads[0] });
    expect(status(projection.snapshot)).toBe("finished");
    expect(projection.apply({ kind: "thread.updated", sequence: 2, location: "active",
      thread: v2Shell({ status: "running" }).threads[0] })).toBe(false);
    expect(status(projection.snapshot)).toBe("finished");
  });

  test("archiving, removal, project changes and authoritative resets apply correctly", () => {
    const projection = new T3ShellProjection(v2Shell());
    projection.apply({ kind: "project.updated", sequence: 2, project: { id: "project-1", title: "Renamed" } });
    expect(parseT3Shell(projection.snapshot, "").projects[0]?.title).toBe("Renamed");
    projection.apply({ kind: "thread.updated", sequence: 3, location: "archive", thread: v2Shell().threads[0] });
    expect(parseT3Shell(projection.snapshot, "").threads).toHaveLength(0);
    projection.apply({ kind: "snapshot", snapshot: v2Shell() });
    expect(projection.snapshotSequence).toBe(1);
    expect(parseT3Shell(projection.snapshot, "").threads).toHaveLength(1);
    projection.apply({ kind: "thread.removed", sequence: 2, location: "active", threadId: "thread-1" });
    projection.apply({ kind: "project.removed", sequence: 3, projectId: "project-1" });
    expect(parseT3Shell(projection.snapshot, "").projects).toHaveLength(0);
    expect(parseT3Shell(projection.snapshot, "").threads).toHaveLength(0);
    expect(() => projection.apply({ kind: "future.change", sequence: 4 })).toThrow("Unsupported");
  });
});

test("read-only ticket, protocol query, catch-up, Ack, batched lifecycle changes and heartbeat", async () => {
  const controller = new AbortController();
  const published: string[] = [];
  let ackCount = 0;
  let pingCount = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/websocket-ticket") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        return Response.json({ ticket: "ephemeral-ticket" });
      }
      expect(url.searchParams.get("wsTicket")).toBe("ephemeral-ticket");
      expect(url.searchParams.get("orchestrationProtocol")).toBe("2");
      expect(url.toString()).not.toContain("test-token");
      if (server.upgrade(request)) return;
      return new Response("Not found", { status: 404 });
    },
    websocket: { message(ws, data) {
      const request = JSON.parse(String(data));
      if (request._tag === "Request") {
        expect(request.tag).toBe("orchestration.subscribeShell");
        expect(request.payload).toEqual({ afterSequence: 1, requestCompletionMarker: true });
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [
          { kind: "thread.updated", sequence: 2, location: "active", thread: v2Shell({ status: "running" }).threads[0] },
        ] }));
      } else if (request._tag === "Ack") {
        ackCount++;
        if (ackCount === 1) {
          // The replay is held until this marker; then each live event is published.
          expect(published).toEqual([]);
          ws.send(JSON.stringify([{ _tag: "Chunk", requestId: request.requestId, values: [
            { kind: "synchronized" },
            { kind: "thread.updated", sequence: 3, location: "active", thread: v2Shell({ pendingRuntimeRequest: { kind: "user_input" } }).threads[0] },
            { kind: "thread.updated", sequence: 4, location: "active", thread: v2Shell().threads[0] },
          ] }]));
        }
      } else if (request._tag === "Ping") {
        pingCount++;
        ws.send(JSON.stringify({ _tag: "Pong" }));
      }
    } },
  });
  const run = subscribeT3Shell({ ...configFor(server.url), snapshot: v2Shell(), signal: controller.signal,
    pingMs: 20, timeoutMs: 1000, onSnapshot: shell => published.push(status(shell)!) });
  try {
    await waitUntil(() => pingCount > 0 && published.length >= 4);
    expect(published.slice(0, 3)).toEqual(["running", "input", "finished"]);
    expect(ackCount).toBe(2);
    controller.abort();
    await run;
  } finally {
    controller.abort();
    await run;
    await server.stop(true);
  }
});

test("a silent connection times out and releases the socket", async () => {
  let closed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("Not found"); },
    websocket: { message(ws, data) {
      const request = JSON.parse(String(data));
      if (request._tag === "Request") ws.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [{ kind: "synchronized" }] }));
    }, close() { closed = true; } },
  });
  try {
    await expect(subscribeT3Shell({ t3HttpUrl: server.url.toString().replace(/\/$/, ""), bearerToken: null,
      snapshot: v2Shell(), signal: new AbortController().signal, onSnapshot() {}, pingMs: 10, timeoutMs: 50 }))
      .rejects.toThrow("stopped responding");
    await waitUntil(() => closed);
  } finally { await server.stop(true); }
});

test("the poller streams without repeated HTTP snapshots, falls back after disconnection, and reconnects", async () => {
  let shellRequests = 0;
  let subscriptions = 0;
  let closedConnections = 0;
  let allowSocket = true;
  let activeSocket: Bun.ServerWebSocket<unknown> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/t3/environment") return Response.json({ environmentId: "env", label: "T3", serverVersion: "nightly", orchestrationProtocolVersion: 2 });
      if (path === "/api/auth/websocket-ticket") return Response.json({ ticket: "ticket" });
      if (path === "/api/orchestration/shell") { shellRequests++; return Response.json(v2Shell()); }
      if (path === "/ws" && allowSocket && server.upgrade(request)) return;
      return new Response("Unavailable", { status: 503 });
    },
    websocket: { message(ws, data) {
      const request = JSON.parse(String(data));
      if (request._tag === "Request") {
        subscriptions++;
        activeSocket = ws;
        ws.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [{ kind: "synchronized" }] }));
      }
      if (request._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
    }, close() { closedConnections++; } },
  });
  const store = new WatcherStore("T3");
  const poller = new T3Poller(configFor(server.url), store, { streamRetryMs: 200 });
  const run = poller.start();
  try {
    await waitUntil(() => store.snapshot.transport === "stream");
    await Bun.sleep(80);
    expect(shellRequests).toBe(1);
    expect(subscriptions).toBe(1);
    allowSocket = false;
    activeSocket!.close();
    await waitUntil(() => store.snapshot.transport === "poll" && shellRequests >= 2);
    await Bun.sleep(60);
    expect(store.snapshot.watcher).toBe("live");
    expect(shellRequests).toBeGreaterThan(2);
    expect(subscriptions).toBe(1);
    allowSocket = true;
    await waitUntil(() => subscriptions === 2 && store.snapshot.transport === "stream");
    expect(store.snapshot.watcher).toBe("live");
  } finally {
    poller.stop();
    await run;
    await waitUntil(() => closedConnections === subscriptions);
    // Bun 1.3.14 can retain its pendingWebSockets counter after server-initiated
    // closes. Actual close callbacks above prove cleanup; stop the listener.
    void server.stop(true);
  }
});

test("legacy protocol stays on polling without attempting WebSocket authentication", async () => {
  let unexpectedRequests = 0;
  let shellRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/t3/environment") return Response.json({ environmentId: "old", label: "Stable", serverVersion: "stable", orchestrationProtocolVersion: 1 });
    if (path === "/api/orchestration/shell") { shellRequests++; return Response.json(DEMO_SHELL); }
    unexpectedRequests++;
    return new Response("Unsupported", { status: 404 });
  } });
  const store = new WatcherStore("Stable");
  const poller = new T3Poller(configFor(server.url), store);
  const run = poller.start();
  try {
    await waitUntil(() => shellRequests >= 3);
    expect(store.snapshot.transport).toBe("poll");
    expect(unexpectedRequests).toBe(0);
  } finally { poller.stop(); await run; await server.stop(true); }
});

test("denied streaming tickets fall back to HTTP without repeated ticket requests", async () => {
  let ticketRequests = 0;
  let shellRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/.well-known/t3/environment") return Response.json({ environmentId: "env", label: "T3", serverVersion: "nightly", orchestrationProtocolVersion: 2 });
    if (path === "/api/orchestration/shell") { shellRequests++; return Response.json(v2Shell()); }
    if (path === "/api/auth/websocket-ticket") { ticketRequests++; return new Response("Denied", { status: 403 }); }
    return new Response("Not found", { status: 404 });
  } });
  const store = new WatcherStore("T3");
  const poller = new T3Poller(configFor(server.url), store);
  const run = poller.start();
  try {
    await waitUntil(() => shellRequests >= 3);
    expect(store.snapshot.watcher).toBe("live");
    expect(store.snapshot.transport).toBe("poll");
    expect(ticketRequests).toBe(1);
  } finally { poller.stop(); await run; await server.stop(true); }
});

test("stopping cancels an in-flight descriptor request without publishing stale state", async () => {
  let requested = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requested = true;
    return new Promise<Response>(() => {});
  } });
  const store = new WatcherStore("T3");
  const poller = new T3Poller(configFor(server.url), store);
  const run = poller.start();
  try {
    await waitUntil(() => requested);
    poller.stop();
    await run;
    expect(store.snapshot.watcher).toBe("connecting");
  } finally { poller.stop(); void server.stop(true); }
});
