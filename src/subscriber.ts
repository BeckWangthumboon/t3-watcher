import { normalizeShell } from "./state.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherConfig } from "./config.ts";
import { fetchT3Descriptor, type T3EnvironmentDescriptor } from "./t3-connection.ts";
import { parseT3Shell } from "./t3-shell.ts";
import { subscribeT3Shell } from "./t3-stream.ts";

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown upstream error";
}

// Tested baseline for the single supported upstream API (orchestration protocol 2).
export const SUPPORTED_T3_VERSION = "0.0.46-nightly.20261009.2886";

export class T3Subscriber {
  #stopped = false;
  #abort = new AbortController();

  constructor(
    private readonly config: WatcherConfig,
    private readonly store: WatcherStore,
    private readonly options: { retryMs?: number } = {},
  ) {}

  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
  }

  async start(): Promise<void> {
    while (!this.#stopped) {
      await this.connectOnce();
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.#abort.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, this.options.retryMs ?? 30_000);
        this.#abort.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  /** Bootstrap once, then remain subscribed until disconnection or stop. */
  async connectOnce(): Promise<void> {
    if (this.#stopped) return;
    try {
      const environment = await fetchT3Descriptor(this.config.t3HttpUrl, fetch, this.#abort.signal);
      if (environment.orchestrationProtocolVersion !== 2) {
        throw new Error(`Unsupported T3 orchestration protocol ${environment.orchestrationProtocolVersion ?? "unadvertised"}; T3 Pets requires T3 Code ${SUPPORTED_T3_VERSION} or newer with protocol 2.`);
      }
      const headers = new Headers({ accept: "application/json", "x-t3-orchestration-protocol": "2" });
      if (this.config.bearerToken) headers.set("authorization", `Bearer ${this.config.bearerToken}`);
      const response = await fetch(`${this.config.t3HttpUrl}/api/orchestration/shell`, {
        headers, signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(6_000)]),
      });
      if (response.status === 401) throw new Error("T3 access expired or was revoked; pair T3 Pets again.");
      if (response.status === 403) throw new Error("T3 Pets does not have orchestration:read access.");
      if (!response.ok) throw new Error(`T3 shell request returned ${response.status}`);
      const shell: unknown = await response.json();
      if (this.#stopped) return;
      // The bootstrap is not live until the subscription has caught up.
      await subscribeT3Shell({ ...this.config, snapshot: shell, signal: this.#abort.signal,
        onSnapshot: (snapshot) => {
          if (!this.#stopped) this.publish(snapshot, environment);
        },
      });
    } catch (error) {
      if (!this.#stopped) this.recordError(error);
    }
  }

  private publish(shell: unknown, environment: T3EnvironmentDescriptor) {
    const checkedAt = new Date().toISOString();
    const raw = parseT3Shell(shell, checkedAt);
    this.store.set({
      watcher: "live",
      watcherName: this.config.watcherName ?? environment.label,
      sourceUpdatedAt: raw.updatedAt,
      lastCheckedAt: checkedAt,
      transport: "stream",
      error: null,
      threads: normalizeShell(raw, {
        environmentId: environment.environmentId,
        autoSettleAfterDays: this.config.autoSettleAfterDays,
        webBaseUrl: this.config.webBaseUrl,
      }),
    });
  }

  private recordError(error: unknown) {
    const previous = this.store.snapshot;
    this.store.set({
      ...previous,
      watcher: previous.sourceUpdatedAt === null ? "error" : "stale",
      lastCheckedAt: new Date().toISOString(),
      error: safeErrorMessage(error),
    });
  }
}
