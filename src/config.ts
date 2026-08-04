export interface WatcherConfig {
  t3HttpUrl: string;
  bearerToken: string | null;
  watcherName: string;
  pollMs: number;
  autoSettleAfterDays: number | null;
  hostname: string;
  port: number;
  webBaseUrl: string | null;
  demo: boolean;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readToken(): Promise<string | null> {
  const inline = Bun.env.T3_BEARER_TOKEN?.trim();
  if (inline) return inline;
  const path = Bun.env.T3_BEARER_TOKEN_FILE?.trim();
  if (!path) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`T3 bearer token file does not exist: ${path}`);
  }
  const token = (await file.text()).trim();
  if (!token) throw new Error(`T3 bearer token file is empty: ${path}`);
  return token;
}

export async function loadConfig(): Promise<WatcherConfig> {
  const settleValue = Bun.env.WATCHER_AUTO_SETTLE_DAYS?.trim() ?? "3";
  const autoSettleAfterDays = settleValue === "never" ? null : Number(settleValue);
  if (autoSettleAfterDays !== null && (!Number.isFinite(autoSettleAfterDays) || autoSettleAfterDays < 0)) {
    throw new Error("WATCHER_AUTO_SETTLE_DAYS must be a non-negative number or 'never'.");
  }
  return {
    t3HttpUrl: (Bun.env.T3_HTTP_URL ?? "http://127.0.0.1:3773").replace(/\/$/, ""),
    bearerToken: await readToken(),
    watcherName: Bun.env.WATCHER_NAME?.trim() || "mintbox",
    pollMs: positiveInteger(Bun.env.WATCHER_POLL_MS, 2_000),
    autoSettleAfterDays,
    hostname: Bun.env.WATCHER_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(Bun.env.PORT, 4_173),
    webBaseUrl: Bun.env.T3_WEB_URL?.trim() || null,
    demo: Bun.env.WATCHER_DEMO === "1",
  };
}
