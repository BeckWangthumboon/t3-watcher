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

export class T3Poller {
  #stopped = false;
  #environment: T3EnvironmentDescriptor | null = null;
  #shell: unknown = null;
  #abort = new AbortController();
  #nextStreamAttemptAt = 0;

  constructor(
    private readonly config: WatcherConfig & { environmentId?: string; backendId?: string },
    private readonly store: WatcherStore,
    private readonly options: { streamRetryMs?: number } = {},
  ) {}

  stop(): void {
    this.#stopped = true;
    this.#abort.abort();
  }

  async start(): Promise<void> {
    while (!this.#stopped) {
      await this.pollOnce();
      if (this.#stopped) return;
      if (this.#environment?.orchestrationProtocolVersion === 2 && this.#shell &&
          this.store.snapshot.watcher === "live" && Date.now() >= this.#nextStreamAttemptAt) {
        try {
          await subscribeT3Shell({ ...this.config, snapshot: this.#shell, signal: this.#abort.signal,
            onSnapshot: (snapshot) => {
              if (!this.#stopped) this.publish(snapshot, this.#environment!, "stream");
            },
          });
        } catch (error) {
          if (this.#stopped) return;
          this.recordError(error);
          // Keep HTTP data flowing when streaming is unavailable, and periodically retry.
          this.#nextStreamAttemptAt = Date.now() + (this.options.streamRetryMs ?? 30_000);
        }
      }
      if (this.#stopped) return;
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); this.#abort.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, this.config.pollMs);
        this.#abort.signal.addEventListener("abort", finish, { once: true });
      });
    }
  }

  async pollOnce(): Promise<void> {
    try {
      const environment = await this.resolveEnvironment();
      if (environment.orchestrationProtocolVersion !== undefined &&
          ![1, 2].includes(environment.orchestrationProtocolVersion)) {
        throw new Error(`Unsupported T3 orchestration protocol ${environment.orchestrationProtocolVersion}; update T3 Pets.`);
      }
      // Older servers ignore this header; protocol-2 servers require it.
      const headers = new Headers({ accept: "application/json",
        "x-t3-orchestration-protocol": String(environment.orchestrationProtocolVersion ?? 2) });
      if (this.config.bearerToken) {
        headers.set("authorization", `Bearer ${this.config.bearerToken}`);
      }
      const response = await fetch(`${this.config.t3HttpUrl}/api/orchestration/shell`, {
        headers,
        signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(6_000)]),
      });
      if (response.status === 401) {
        throw new Error("T3 access expired or was revoked; pair T3 Pets again.");
      }
      if (response.status === 403) {
        throw new Error("T3 Pets does not have orchestration:read access.");
      }
      if (!response.ok) {
        throw new Error(`T3 shell request returned ${response.status}`);
      }
      const shell: unknown = await response.json();
      if (this.#stopped) return;
      this.publish(shell, environment, "poll");
    } catch (error) {
      if (!this.#stopped) this.recordError(error);
    }
  }

  private publish(shell: unknown, environment: T3EnvironmentDescriptor, transport: "stream" | "poll") {
    const checkedAt = new Date().toISOString();
    const raw = parseT3Shell(shell, checkedAt);
    this.#shell = shell;
    this.store.set({
      watcher: "live",
      watcherName: this.config.watcherName ?? environment.label,
      sourceUpdatedAt: raw.updatedAt,
      lastCheckedAt: checkedAt,
      transport,
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

  async resolveEnvironment(): Promise<T3EnvironmentDescriptor> {
    try {
      const descriptor = await fetchT3Descriptor(this.config.t3HttpUrl, fetch, this.#abort.signal);
      this.#environment = descriptor;
      return this.#environment;
    } catch {
      if (this.#environment) return this.#environment;
      const fallback = this.config.watcherName ?? "T3 Code";
      return {
        environmentId: this.config.environmentId ?? this.config.backendId ?? this.config.t3HttpUrl,
        label: fallback, serverVersion: "unknown",
      };
    }
  }
}
