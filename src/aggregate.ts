import type { T3BackendConfig } from "./config.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherConnection, WatcherSnapshot } from "./types.ts";

export class WatcherAggregate {
  readonly store: WatcherStore;
  readonly backendStores = new Map<string, WatcherStore>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly backends: T3BackendConfig[]) {
    if (backends.length === 0) throw new Error("Configure at least one T3 backend.");
    this.store = new WatcherStore("T3 Code");
    for (const backend of backends) {
      if (this.backendStores.has(backend.id)) throw new Error(`Duplicate T3 backend: ${backend.id}`);
      const store = new WatcherStore(backend.watcherName ?? new URL(backend.t3HttpUrl).host);
      this.backendStores.set(backend.id, store);
      this.unsubscribe.push(store.subscribe(() => this.publish()));
    }
    this.publish();
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
  }

  private publish(): void {
    const states = this.backends.map((backend) => ({
      backend,
      snapshot: this.backendStores.get(backend.id)!.snapshot,
    }));
    const live = states.filter(({ snapshot }) => snapshot.watcher === "live").length;
    const allConnecting = states.every(({ snapshot }) => snapshot.watcher === "connecting");
    const watcher: WatcherConnection = live === states.length ? "live" : live > 0 ? "partial"
      : allConnecting ? "connecting"
      : states.some(({ snapshot }) => snapshot.sourceUpdatedAt !== null) ? "stale" : "error";
    const latest = (key: "sourceUpdatedAt" | "lastCheckedAt") => states
      .map(({ snapshot }) => snapshot[key]).filter((value): value is string => value !== null).sort().at(-1) ?? null;
    // If two profiles point at the same environment, prefer live data and
    // publish each thread once. Environment IDs, not local aliases, scope IDs.
    const threads = new Map<string, WatcherSnapshot["threads"][number]>();
    for (const { backend, snapshot } of states) {
      for (const thread of snapshot.threads) {
        if (threads.get(thread.key)?.backendWatcher === "live") continue;
        threads.set(thread.key, { ...thread, backendId: backend.id,
          backendName: snapshot.watcherName, backendWatcher: snapshot.watcher });
      }
    }
    const errors = states.filter(({ snapshot }) => snapshot.watcher !== "live" && snapshot.error)
      .map(({ snapshot }) => `${snapshot.watcherName}: ${snapshot.error}`);
    this.store.set({
      watcher,
      watcherName: states.length === 1 ? states[0]!.snapshot.watcherName : `${states.length} T3 backends`,
      sourceUpdatedAt: latest("sourceUpdatedAt"),
      lastCheckedAt: latest("lastCheckedAt"),
      error: errors.length ? errors.join("; ") : null,
      threads: [...threads.values()],
      backends: states.map(({ backend, snapshot }) => ({
        id: backend.id, name: snapshot.watcherName, t3HttpUrl: backend.t3HttpUrl,
        watcher: snapshot.watcher, transport: snapshot.transport, lastCheckedAt: snapshot.lastCheckedAt, error: snapshot.error,
      })),
    });
  }
}
