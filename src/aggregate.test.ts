import { expect, test } from "bun:test";
import { WatcherAggregate } from "./aggregate.ts";
import type { T3BackendConfig } from "./config.ts";
import { DEMO_SHELL } from "./demo.ts";
import { T3Poller } from "./poller.ts";
import { v2Shell } from "./test-fixtures.ts";

test("mixed old/new backends isolate credentials and survive individual failures", async () => {
  let offline = false;
  const servers = [1, 2].map((number) => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/.well-known/t3/environment") {
        return Response.json({ environmentId: `env-${number}`, label: `Backend ${number}`,
          serverVersion: number === 1 ? "0.0.45" : "0.0.46-nightly", orchestrationProtocolVersion: number });
      }
      expect(request.headers.get("authorization")).toBe(`Bearer token-${number}`);
      expect(request.headers.get("x-t3-orchestration-protocol")).toBe(String(number));
      if (number === 2 && offline) return new Response("Denied", { status: 401 });
      return Response.json(number === 1 ? DEMO_SHELL : v2Shell());
    },
  }));
  const backends: T3BackendConfig[] = servers.map((server, index) => ({
    id: `backend-${index + 1}`, t3HttpUrl: server.url.toString().replace(/\/$/, ""),
    bearerToken: `token-${index + 1}`, watcherName: null, webBaseUrl: null,
  }));
  const aggregate = new WatcherAggregate(backends);
  const pollers = backends.map((backend) => new T3Poller({ ...backend,
    backendId: backend.id, pollMs: 2_000, autoSettleAfterDays: null,
    hostname: "127.0.0.1", port: 0, demo: false,
  }, aggregate.backendStores.get(backend.id)!));
  try {
    expect(aggregate.store.snapshot.watcher).toBe("connecting");
    await Promise.all(pollers.map((poller) => poller.pollOnce()));
    expect(aggregate.store.snapshot.watcher).toBe("live");
    expect(aggregate.store.snapshot.threads).toHaveLength(4);
    expect(aggregate.store.snapshot.backends?.map((backend) => backend.name)).toEqual(["Backend 1", "Backend 2"]);
    expect(aggregate.store.snapshot.threads.at(-1)).toMatchObject({ backendName: "Backend 2", status: "finished" });
    offline = true;
    await Promise.all(pollers.map((poller) => poller.pollOnce()));
    expect(aggregate.store.snapshot.watcher).toBe("partial");
    expect(aggregate.store.snapshot.threads).toHaveLength(4);
    expect(aggregate.store.snapshot.threads.filter((thread) => thread.backendWatcher === "live")).toHaveLength(3);
    expect(aggregate.store.snapshot.error).toContain("Backend 2");
    offline = false;
    await pollers[1]!.pollOnce();
    expect(aggregate.store.snapshot.watcher).toBe("live");
    expect(aggregate.store.snapshot.error).toBeNull();
  } finally {
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
