import { expect, test } from "bun:test";
import { WatcherAggregate } from "./aggregate.ts";
import type { T3BackendConfig } from "./config.ts";
import { T3Subscriber } from "./subscriber.ts";
import { v2Shell } from "./test-fixtures.ts";

test("streaming backends isolate credentials and preserve cached threads after individual failures", async () => {
  let offline = false;
  const servers = [1, 2].map((number) => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/.well-known/t3/environment") {
        return Response.json({ environmentId: `env-${number}`, label: `Backend ${number}`,
          serverVersion: "0.0.46-nightly.20261009.2886", orchestrationProtocolVersion: 2 });
      }
      if (path === "/ws" && server.upgrade(request)) return;
      expect(request.headers.get("authorization")).toBe(`Bearer token-${number}`);
      if (path === "/api/auth/websocket-ticket") return Response.json({ ticket: `ticket-${number}` });
      expect(request.headers.get("x-t3-orchestration-protocol")).toBe("2");
      if (number === 2 && offline) return new Response("Denied", { status: 401 });
      return Response.json(v2Shell());
    },
    websocket: { message(ws, data) {
      const request = JSON.parse(String(data));
      if (request._tag === "Request") ws.send(JSON.stringify({ _tag: "Chunk", requestId: request.id,
        values: [{ kind: "synchronized" }] }));
      if (request._tag === "Ping") ws.send(JSON.stringify({ _tag: "Pong" }));
    } },
  }));
  const backends: T3BackendConfig[] = servers.map((server, index) => ({
    id: `backend-${index + 1}`, t3HttpUrl: server.url.toString().replace(/\/$/, ""),
    bearerToken: `token-${index + 1}`, watcherName: null, webBaseUrl: null,
  }));
  const aggregate = new WatcherAggregate(backends);
  const subscribers = backends.map((backend) => new T3Subscriber({ ...backend,
    autoSettleAfterDays: null, hostname: "127.0.0.1", port: 0, demo: false,
  }, aggregate.backendStores.get(backend.id)!));
  const runs = subscribers.map((subscriber) => subscriber.connectOnce());
  async function waitUntil(condition: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for backend state");
      await Bun.sleep(5);
    }
  }
  try {
    await waitUntil(() => aggregate.store.snapshot.watcher === "live");
    expect(aggregate.store.snapshot.threads).toHaveLength(2);
    expect(aggregate.store.snapshot.backends?.map((backend) => backend.name)).toEqual(["Backend 1", "Backend 2"]);
    expect(aggregate.store.snapshot.threads.at(-1)).toMatchObject({ backendName: "Backend 2", status: "finished" });
    subscribers[1]!.stop();
    await runs[1];
    offline = true;
    const reconnect = new T3Subscriber({ ...backends[1]!, autoSettleAfterDays: null,
      hostname: "127.0.0.1", port: 0, demo: false }, aggregate.backendStores.get("backend-2")!);
    await reconnect.connectOnce();
    expect(aggregate.store.snapshot.watcher).toBe("partial");
    expect(aggregate.store.snapshot.threads).toHaveLength(2);
    expect(aggregate.store.snapshot.threads.filter((thread) => thread.backendWatcher === "live")).toHaveLength(1);
    expect(aggregate.store.snapshot.error).toContain("Backend 2");
    offline = false;
    const recovered = reconnect.connectOnce();
    await waitUntil(() => aggregate.store.snapshot.watcher === "live");
    expect(aggregate.store.snapshot.error).toBeNull();
    reconnect.stop();
    await recovered;
  } finally {
    subscribers.forEach((subscriber) => subscriber.stop());
    await Promise.all(runs);
    aggregate.stop();
    await Promise.all(servers.map((server) => server.stop(true)));
  }
});

test("duplicate local aliases of one environment publish each thread once", () => {
  const aggregate = new WatcherAggregate(["one", "two"].map((id) => ({
    id, t3HttpUrl: "http://127.0.0.1:3773", bearerToken: null, watcherName: id, webBaseUrl: null,
  })));
  const snapshot = { watcher: "live" as const, watcherName: "Same environment", sourceUpdatedAt: "2026-10-04T12:00:00Z",
    lastCheckedAt: "2026-10-04T12:00:00Z", error: null, threads: [{
      key: "environment:thread-1", environmentId: "environment", threadId: "thread-1", projectId: "project-1",
      projectTitle: "Project", title: "Thread", status: "running" as const,
      latestTurnId: "run-1", updatedAt: "2026-10-04T12:00:00Z", href: null,
    }] };
  try {
    aggregate.backendStores.get("one")!.set(snapshot);
    aggregate.backendStores.get("two")!.set(snapshot);
    expect(aggregate.store.snapshot.threads).toHaveLength(1);
    aggregate.backendStores.get("one")!.set({ ...snapshot, watcher: "stale", error: "offline" });
    expect(aggregate.store.snapshot.threads[0]?.backendId).toBe("two");
    expect(aggregate.store.snapshot.threads[0]?.backendWatcher).toBe("live");
  } finally {
    aggregate.stop();
  }
});
