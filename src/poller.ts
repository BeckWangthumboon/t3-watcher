import { normalizeShell } from "./state.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherConfig } from "./config.ts";
import { fetchT3Descriptor, type T3EnvironmentDescriptor } from "./t3-connection.ts";
import { parseT3Shell } from "./t3-shell.ts";

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown upstream error";
}

export class T3Poller {
  #stopped = false;
  #environment: T3EnvironmentDescriptor | null = null;

  constructor(
    private readonly config: WatcherConfig & { environmentId?: string; backendId?: string },
    private readonly store: WatcherStore,
  ) {}

  stop(): void {
    this.#stopped = true;
  }

  async start(): Promise<void> {
    while (!this.#stopped) {
      await this.pollOnce();
      if (!this.#stopped) await Bun.sleep(this.config.pollMs);
    }
  }

  async pollOnce(): Promise<void> {
    const checkedAt = new Date().toISOString();
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
        signal: AbortSignal.timeout(6_000),
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
      const raw = parseT3Shell(await response.json(), checkedAt);
      this.store.set({
        watcher: "live",
        watcherName: this.config.watcherName ?? environment.label,
        sourceUpdatedAt: raw.updatedAt,
        lastCheckedAt: checkedAt,
        error: null,
        threads: normalizeShell(raw, {
          environmentId: environment.environmentId,
          autoSettleAfterDays: this.config.autoSettleAfterDays,
          webBaseUrl: this.config.webBaseUrl,
        }),
      });
    } catch (error) {
      const previous = this.store.snapshot;
      this.store.set({
        ...previous,
        watcher: previous.sourceUpdatedAt === null ? "error" : "stale",
        lastCheckedAt: checkedAt,
        error: safeErrorMessage(error),
      });
    }
  }

  async resolveEnvironment(): Promise<T3EnvironmentDescriptor> {
    try {
      const descriptor = await fetchT3Descriptor(this.config.t3HttpUrl);
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
