import { loadConfig } from "./config.ts";
import { DEMO_SHELL } from "./demo.ts";
import { T3Poller } from "./poller.ts";
import { normalizeShell } from "./state.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherSnapshot } from "./types.ts";
import { WatcherAggregate } from "./aggregate.ts";

const config = await loadConfig();
const backends = config.backends ?? [{ ...config, id: "default" }];
const aggregate = config.demo ? null : new WatcherAggregate(backends);
const store = aggregate?.store ?? new WatcherStore(config.watcherName ?? "T3 Code");
const pollers: T3Poller[] = [];

if (config.demo) {
  store.set({
    watcher: "live",
    watcherName: config.watcherName ?? "Demo environment",
    sourceUpdatedAt: DEMO_SHELL.updatedAt,
    lastCheckedAt: new Date().toISOString(),
    error: null,
    threads: normalizeShell(DEMO_SHELL, {
      environmentId: "demo-environment",
      autoSettleAfterDays: config.autoSettleAfterDays,
      webBaseUrl: config.webBaseUrl,
    }),
  });
} else {
  for (const backend of backends) {
    const poller = new T3Poller({ ...config, ...backend, backendId: backend.id },
      aggregate!.backendStores.get(backend.id)!);
    pollers.push(poller);
    void poller.start();
  }
}

const encoder = new TextEncoder();
const sseMessage = (snapshot: WatcherSnapshot) =>
  encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

function eventStream(request: Request): Response {
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sseMessage(store.snapshot));
      unsubscribe = store.subscribe((snapshot) => controller.enqueue(sseMessage(snapshot)));
      heartbeat = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 15_000);
      request.signal.addEventListener(
        "abort",
        () => {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            // The browser may have already closed the stream.
          }
        },
        { once: true },
      );
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

const assets = new Map<string, readonly [string, string]>([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["public/app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
] as const);

const server = Bun.serve({
  hostname: config.hostname,
  port: config.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/api/snapshot") return Response.json(store.snapshot);
    if (url.pathname === "/api/events") return eventStream(request);
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: store.snapshot.watcher === "live",
        watcher: store.snapshot.watcher,
        sourceUpdatedAt: store.snapshot.sourceUpdatedAt,
        lastCheckedAt: store.snapshot.lastCheckedAt,
        backends: store.snapshot.backends,
      });
    }
    const asset = assets.get(url.pathname);
    if (!asset) return new Response("Not found", { status: 404 });
    const [path, contentType] = asset;
    return new Response(Bun.file(path), { headers: { "content-type": contentType } });
  },
});

console.log(`T3 Pets listening on ${server.url}`);

function shutdown(): void {
  for (const poller of pollers) poller.stop();
  aggregate?.stop();
  void server.stop(true);
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
