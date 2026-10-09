import { expect, test } from "bun:test";
import { SUPPORTED_T3_VERSION, T3Subscriber } from "./subscriber.ts";
import { WatcherStore } from "./store.ts";
import { v2Shell } from "./test-fixtures.ts";
import { parseT3Shell } from "./t3-shell.ts";
import { normalizeShell } from "./state.ts";

const configFor = (url: URL) => ({ t3HttpUrl: url.toString().replace(/\/$/, ""),
  bearerToken: "test-token", watcherName: null, autoSettleAfterDays: null,
  hostname: "127.0.0.1", port: 0, webBaseUrl: null, demo: false });

test("descriptor and auth failures preserve cached threads without using another data path", async () => {
  let descriptorAvailable = true;
  let shellStatus = 401;
  let shellRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/.well-known/t3/environment") {
      return descriptorAvailable
        ? Response.json({ environmentId: "env", label: "Test T3", serverVersion: SUPPORTED_T3_VERSION,
          orchestrationProtocolVersion: 2 })
        : new Response("Unavailable", { status: 503 });
    }
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    expect(request.headers.get("x-t3-orchestration-protocol")).toBe("2");
    shellRequests++;
    return new Response("Denied", { status: shellStatus });
  } });
  const store = new WatcherStore("Test T3");
  const raw = parseT3Shell(v2Shell(), new Date().toISOString());
  store.set({ watcher: "live", watcherName: "Test T3", transport: "stream",
    sourceUpdatedAt: raw.updatedAt, lastCheckedAt: raw.updatedAt, error: null,
    threads: normalizeShell(raw, { environmentId: "env", autoSettleAfterDays: null }) });
  const cached = store.snapshot.threads;
  const subscriber = new T3Subscriber(configFor(server.url), store);
  try {
    await subscriber.connectOnce();
    expect(store.snapshot.watcher).toBe("stale");
    expect(store.snapshot.error).toContain("pair T3 Pets again");
    expect(store.snapshot.threads).toEqual(cached);
    shellStatus = 403;
    await subscriber.connectOnce();
    expect(store.snapshot.error).toContain("orchestration:read");
    expect(store.snapshot.threads).toEqual(cached);
    descriptorAvailable = false;
    await subscriber.connectOnce();
    expect(store.snapshot.watcher).toBe("stale");
    expect(store.snapshot.threads).toEqual(cached);
    expect(shellRequests).toBe(2);
  } finally { subscriber.stop(); await server.stop(true); }
});

for (const protocol of [undefined, 1, 3]) {
  test(`rejects unsupported orchestration protocol ${protocol} before requesting a shell`, async () => {
    let shellRequested = false;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      if (new URL(request.url).pathname === "/.well-known/t3/environment") {
        return Response.json({ environmentId: "env", label: "T3", serverVersion: "other",
          orchestrationProtocolVersion: protocol });
      }
      shellRequested = true;
      return Response.json(v2Shell());
    } });
    const store = new WatcherStore("T3");
    const subscriber = new T3Subscriber(configFor(server.url), store);
    try {
      await subscriber.connectOnce();
      expect(store.snapshot.watcher).toBe("error");
      expect(store.snapshot.error).toContain(`Unsupported T3 orchestration protocol ${protocol ?? "unadvertised"}`);
      expect(store.snapshot.error).toContain(SUPPORTED_T3_VERSION);
      expect(shellRequested).toBe(false);
    } finally { subscriber.stop(); await server.stop(true); }
  });
}
