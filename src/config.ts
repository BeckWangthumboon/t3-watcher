import {
  resolveConfigDirectory,
  LEGACY_TOKEN_FILE,
  discoverLocalT3HttpUrl,
  readSavedT3Connection,
  readNamedT3Connections,
} from "./t3-connection.ts";
import { join } from "node:path";

export interface T3BackendConfig {
  id: string;
  t3HttpUrl: string;
  bearerToken: string | null;
  watcherName: string | null;
  webBaseUrl: string | null;
  environmentId?: string;
}

export interface WatcherConfig {
  t3HttpUrl: string;
  bearerToken: string | null;
  watcherName: string | null;
  autoSettleAfterDays: number | null;
  hostname: string;
  port: number;
  webBaseUrl: string | null;
  demo: boolean;
  backends?: T3BackendConfig[];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readToken(configDir: string): Promise<string | null> {
  const inline = Bun.env.T3_BEARER_TOKEN?.trim();
  if (inline) return inline;
  const configuredPath = Bun.env.T3_BEARER_TOKEN_FILE?.trim();
  const paths = configuredPath
    ? [configuredPath]
    : [join(configDir, "token"), LEGACY_TOKEN_FILE];
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
  const settleValue = (Bun.env.T3_PETS_AUTO_SETTLE_DAYS ?? Bun.env.WATCHER_AUTO_SETTLE_DAYS)?.trim() ?? "3";
  const autoSettleAfterDays = settleValue === "never" ? null : Number(settleValue);
  if (autoSettleAfterDays !== null && (!Number.isFinite(autoSettleAfterDays) || autoSettleAfterDays < 0)) {
    throw new Error("T3_PETS_AUTO_SETTLE_DAYS must be a non-negative number or 'never'.");
  }
  const explicitUrl = Bun.env.T3_HTTP_URL?.trim();
  const configDir = await resolveConfigDirectory();
  const connectionFile = Bun.env.T3_CONNECTION_FILE?.trim() || undefined;
  const savedConnection = explicitUrl ? null : await readSavedT3Connection(
    connectionFile ?? join(configDir, "connection.json"),
  ) ?? (connectionFile || Bun.env.T3_PETS_CONFIG_DIR?.trim() || Bun.env.WATCHER_CONFIG_DIR?.trim()
    ? null : await readSavedT3Connection());
  const named = explicitUrl || connectionFile ? [] : await readNamedT3Connections(configDir);
  const useDefault = Boolean(explicitUrl || connectionFile || savedConnection || named.length === 0);
  const discoveredUrl =
    explicitUrl || savedConnection?.t3HttpUrl || named.length > 0
      ? null
      : await discoverLocalT3HttpUrl({
          runtimeStateFile: Bun.env.T3_RUNTIME_STATE_FILE?.trim() || undefined,
          t3Home: Bun.env.T3CODE_HOME?.trim() || undefined,
        });
  const primary = {
    t3HttpUrl: (
      explicitUrl ||
      savedConnection?.t3HttpUrl ||
      discoveredUrl ||
      "http://127.0.0.1:3773"
    ).replace(/\/$/, ""),
    bearerToken: useDefault ? await readToken(configDir) : null,
    watcherName: (Bun.env.T3_PETS_NAME ?? Bun.env.WATCHER_NAME)?.trim() || savedConnection?.label || null,
    autoSettleAfterDays,
    hostname: (Bun.env.T3_PETS_HOST ?? Bun.env.WATCHER_HOST)?.trim() || "127.0.0.1",
    port: positiveInteger(Bun.env.PORT, 4_173),
    webBaseUrl: Bun.env.T3_WEB_URL?.trim() || null,
    demo: (Bun.env.T3_PETS_DEMO ?? Bun.env.WATCHER_DEMO) === "1",
  };
  const backends: T3BackendConfig[] = [];
  if (useDefault) {
    backends.push({
      id: "default", t3HttpUrl: primary.t3HttpUrl, bearerToken: primary.bearerToken,
      watcherName: primary.watcherName, webBaseUrl: primary.webBaseUrl,
      environmentId: savedConnection?.environmentId,
    });
  }
  for (const { id, connection, tokenFile } of named) {
    const file = Bun.file(tokenFile);
    // Missing/expired credentials remain an isolated backend error, not a
    // reason to prevent all the other backends from starting.
    const token = await file.exists() ? (await file.text()).trim() || null : null;
    backends.push({ id, t3HttpUrl: connection.t3HttpUrl, bearerToken: token,
      watcherName: connection.label ?? id, webBaseUrl: null, environmentId: connection.environmentId });
  }
  return { ...primary, backends };
}
