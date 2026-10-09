import { expect, test } from "bun:test";
import type { WatcherConfig } from "./config.ts";
import { DEMO_SHELL } from "./demo.ts";
import { T3Poller } from "./poller.ts";
import { WatcherStore } from "./store.ts";

test("descriptor failures preserve thread identity, and auth failures preserve cached threads", async () => {
  let descriptorAvailable = true;
  let shellStatus = 200;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/.well-known/t3/environment") {
        return descriptorAvailable
          ? Response.json({ environmentId: "test-env", label: "Test T3", serverVersion: "1" })
          : new Response("Unavailable", { status: 503 });
      }
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      return shellStatus === 200
        ? Response.json(DEMO_SHELL)
        : new Response("Denied", { status: shellStatus });
    },
  });
  const config: WatcherConfig = {
    t3HttpUrl: server.url.toString().replace(/\/$/, ""),
    bearerToken: "test-token",
    watcherName: null,
    pollMs: 2_000,
    autoSettleAfterDays: null,
    hostname: "127.0.0.1",
    port: 4_173,
    webBaseUrl: null,
    demo: false,
  };
  const store = new WatcherStore("T3 Code");
  const poller = new T3Poller(config, store);
  try {
    await poller.pollOnce();
    expect(store.snapshot.watcher).toBe("live");
    expect(store.snapshot.watcherName).toBe("Test T3");
    expect(store.snapshot.threads).toHaveLength(3);
    const threads = store.snapshot.threads;
    descriptorAvailable = false;
    await poller.pollOnce();
    expect(store.snapshot.watcher).toBe("live");
    expect(store.snapshot.watcherName).toBe("Test T3");
    expect(store.snapshot.threads).toEqual(threads);
    shellStatus = 401;
    await poller.pollOnce();
    expect(store.snapshot.watcher).toBe("stale");
    expect(store.snapshot.error).toContain("pair T3 Pets again");
    expect(store.snapshot.threads).toEqual(threads);
    shellStatus = 403;
    await poller.pollOnce();
    expect(store.snapshot.error).toContain("orchestration:read");
    expect(store.snapshot.threads).toEqual(threads);
  } finally {
    await server.stop(true);
  }
});

test("unsupported future orchestration protocols produce a useful isolated error", async () => {
  let shellRequested = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/.well-known/t3/environment") {
      return Response.json({ environmentId: "future-env", label: "Future T3", serverVersion: "2",
        orchestrationProtocolVersion: 3 });
    }
    shellRequested = true;
    return Response.json(DEMO_SHELL);
  } });
  const store = new WatcherStore("Future T3");
  const poller = new T3Poller({ t3HttpUrl: server.url.toString().replace(/\/$/, ""),
    bearerToken: null, watcherName: null, pollMs: 2_000, autoSettleAfterDays: null,
    hostname: "127.0.0.1", port: 0, webBaseUrl: null, demo: false,
  }, store);
  try {
    await poller.pollOnce();
    expect(store.snapshot.watcher).toBe("error");
    expect(store.snapshot.error).toContain("Unsupported T3 orchestration protocol 3");
    expect(shellRequested).toBe(false);
  } finally {
    await server.stop(true);
  }
});
