import {
  DEFAULT_TOKEN_FILE,
  LEGACY_TOKEN_FILE,
  discoverLocalT3HttpUrl,
  readSavedT3Connection,
} from "./t3-connection.ts";

export interface WatcherConfig {
  t3HttpUrl: string;
  bearerToken: string | null;
  watcherName: string | null;
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
  const configuredPath = Bun.env.T3_BEARER_TOKEN_FILE?.trim();
  const paths = configuredPath
    ? [configuredPath]
    : [DEFAULT_TOKEN_FILE, LEGACY_TOKEN_FILE];
  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const token = (await file.text()).trim();
    if (!token) throw new Error(`T3 bearer token file is empty: ${path}`);
    return token;
  }
  if (configuredPath) {
    throw new Error(`T3 bearer token file does not exist: ${configuredPath}`);
  }
  return null;
}

export async function loadConfig(): Promise<WatcherConfig> {
  const settleValue = Bun.env.WATCHER_AUTO_SETTLE_DAYS?.trim() ?? "3";
  const autoSettleAfterDays = settleValue === "never" ? null : Number(settleValue);
  if (autoSettleAfterDays !== null && (!Number.isFinite(autoSettleAfterDays) || autoSettleAfterDays < 0)) {
    throw new Error("WATCHER_AUTO_SETTLE_DAYS must be a non-negative number or 'never'.");
  }
  const explicitUrl = Bun.env.T3_HTTP_URL?.trim();
  const connectionFile = Bun.env.T3_CONNECTION_FILE?.trim() || undefined;
  const savedConnection = explicitUrl ? null : await readSavedT3Connection(connectionFile);
  const discoveredUrl =
    explicitUrl || savedConnection?.t3HttpUrl
      ? null
      : await discoverLocalT3HttpUrl({
          runtimeStateFile: Bun.env.T3_RUNTIME_STATE_FILE?.trim() || undefined,
          t3Home: Bun.env.T3CODE_HOME?.trim() || undefined,
        });
  return {
    t3HttpUrl: (
      explicitUrl ||
      savedConnection?.t3HttpUrl ||
      discoveredUrl ||
      "http://127.0.0.1:3773"
    ).replace(/\/$/, ""),
    bearerToken: await readToken(),
    watcherName: Bun.env.WATCHER_NAME?.trim() || savedConnection?.label || null,
    pollMs: positiveInteger(Bun.env.WATCHER_POLL_MS, 2_000),
    autoSettleAfterDays,
    hostname: Bun.env.WATCHER_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(Bun.env.PORT, 4_173),
    webBaseUrl: Bun.env.T3_WEB_URL?.trim() || null,
    demo: Bun.env.WATCHER_DEMO === "1",
  };
}
