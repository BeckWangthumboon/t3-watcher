import { normalizeShell } from "./state.ts";
import { WatcherStore } from "./store.ts";
import type { WatcherConfig } from "./config.ts";
import type { T3ShellSnapshot } from "./types.ts";
import { fetchT3Descriptor } from "./t3-connection.ts";

function isShellSnapshot(value: unknown): value is T3ShellSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<T3ShellSnapshot>;
  return (
    typeof candidate.snapshotSequence === "number" &&
    Array.isArray(candidate.projects) &&
    Array.isArray(candidate.threads) &&
    typeof candidate.updatedAt === "string"
  );
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Unknown upstream error";
}

export class T3Poller {
  #stopped = false;
  #environment: { environmentId: string; label: string } | null = null;

  constructor(
    private readonly config: WatcherConfig,
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
      const headers = new Headers({ accept: "application/json" });
      if (this.config.bearerToken) {
        headers.set("authorization", `Bearer ${this.config.bearerToken}`);
      }
      const response = await fetch(`${this.config.t3HttpUrl}/api/orchestration/shell`, {
        headers,
        signal: AbortSignal.timeout(6_000),
      });
      if (response.status === 401) {
        throw new Error("T3 access expired or was revoked; pair T3 Watcher again.");
      }
      if (response.status === 403) {
        throw new Error("T3 Watcher does not have orchestration:read access.");
      }
      if (!response.ok) {
        throw new Error(`T3 shell request returned ${response.status}`);
      }
      const raw: unknown = await response.json();
      if (!isShellSnapshot(raw)) throw new Error("T3 returned an invalid shell snapshot");
      const environment = await this.resolveEnvironment();
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

  async resolveEnvironment(): Promise<{ environmentId: string; label: string }> {
    try {
      const descriptor = await fetchT3Descriptor(this.config.t3HttpUrl);
      this.#environment = { environmentId: descriptor.environmentId, label: descriptor.label };
      return this.#environment;
    } catch {
      if (this.#environment) return this.#environment;
      const fallback = this.config.watcherName ?? "T3 Code";
      return { environmentId: fallback, label: fallback };
    }
  }
}
