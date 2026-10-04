import { homedir } from "node:os";
import { join } from "node:path";
import { chmod, mkdir, writeFile } from "node:fs/promises";

export interface T3EnvironmentDescriptor {
  environmentId: string;
  label: string;
  serverVersion: string;
}

interface ServerRuntimeState {
  version: 1;
  pid: number;
  origin: string;
}

export interface SavedT3Connection {
  t3HttpUrl: string;
  environmentId?: string;
  label?: string;
}

export const DEFAULT_CONFIG_DIR = join(homedir(), ".t3-watcher");
export const DEFAULT_CONNECTION_FILE = join(DEFAULT_CONFIG_DIR, "connection.json");
export const DEFAULT_TOKEN_FILE = join(DEFAULT_CONFIG_DIR, "token");
export const LEGACY_CONNECTION_FILE = ".watcher-connection.json";
export const LEGACY_TOKEN_FILE = ".watcher-token";

export async function saveT3Connection(
  connection: SavedT3Connection & { bearerToken: string },
  directory = DEFAULT_CONFIG_DIR,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const connectionFile = join(directory, "connection.json");
  const tokenFile = join(directory, "token");
  await writeFile(
    connectionFile,
    `${JSON.stringify({
      t3HttpUrl: connection.t3HttpUrl,
      environmentId: connection.environmentId,
      label: connection.label,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(tokenFile, `${connection.bearerToken}\n`, { mode: 0o600 });
  await Promise.all([chmod(connectionFile, 0o600), chmod(tokenFile, 0o600)]);
}

function normalizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("T3 backend URLs must use http or https.");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function parseT3PairingUrl(value: string): { t3HttpUrl: string; credential: string } {
  const url = new URL(value.trim());
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const credential = fragment.get("token") ?? url.searchParams.get("token");
  if (!credential) throw new Error("The pairing URL does not contain a token.");

  const hostedTarget = url.searchParams.get("host");
  const t3HttpUrl = normalizeHttpUrl(hostedTarget ?? url.origin);
  return { t3HttpUrl, credential };
}

export async function fetchT3Descriptor(
  t3HttpUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<T3EnvironmentDescriptor> {
  const response = await fetcher(`${normalizeHttpUrl(t3HttpUrl)}/.well-known/t3/environment`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`T3 environment descriptor returned ${response.status}.`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null) throw new Error("Invalid T3 environment descriptor.");
  const candidate = value as Partial<T3EnvironmentDescriptor>;
  if (
    typeof candidate.environmentId !== "string" ||
    typeof candidate.label !== "string" ||
    typeof candidate.serverVersion !== "string"
  ) {
    throw new Error("Invalid T3 environment descriptor.");
  }
  return candidate as T3EnvironmentDescriptor;
}

export async function exchangeT3PairingUrl(
  pairingUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<SavedT3Connection & { bearerToken: string }> {
  const { t3HttpUrl, credential } = parseT3PairingUrl(pairingUrl);
  const descriptor = await fetchT3Descriptor(t3HttpUrl, fetcher);
  const payload = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read",
    client_label: "T3 Watcher",
    client_device_type: "bot",
  });
  const response = await fetcher(`${t3HttpUrl}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`T3 pairing failed with status ${response.status}.`);
  const value: unknown = await response.json();
  const bearerToken =
    typeof value === "object" && value !== null && typeof (value as { access_token?: unknown }).access_token === "string"
      ? (value as { access_token: string }).access_token
      : null;
  if (!bearerToken) throw new Error("T3 pairing returned an invalid access token.");
  return {
    t3HttpUrl,
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    bearerToken,
  };
}

async function readRuntimeState(path: string): Promise<ServerRuntimeState | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const value: unknown = await file.json();
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<ServerRuntimeState>;
    if (candidate.version !== 1 || typeof candidate.pid !== "number" || typeof candidate.origin !== "string") {
      return null;
    }
    try {
      process.kill(candidate.pid, 0);
    } catch {
      return null;
    }
    return candidate as ServerRuntimeState;
  } catch {
    return null;
  }
}

export async function discoverLocalT3HttpUrl(options: {
  runtimeStateFile?: string;
  t3Home?: string;
  homeDir?: string;
  fetcher?: typeof fetch;
} = {}): Promise<string | null> {
  const candidates = options.runtimeStateFile
    ? [options.runtimeStateFile]
    : ["userdata", "dev"].map((variant) =>
        join(options.t3Home ?? join(options.homeDir ?? homedir(), ".t3"), variant, "server-runtime.json"),
      );
  for (const path of candidates) {
    const state = await readRuntimeState(path);
    if (!state) continue;
    try {
      await fetchT3Descriptor(state.origin, options.fetcher);
      return normalizeHttpUrl(state.origin);
    } catch {
      // A stale runtime file or reused port is not a T3 backend.
    }
  }
  return null;
}

export async function readSavedT3Connection(
  path?: string,
): Promise<SavedT3Connection | null> {
  const candidates = path ? [path] : [DEFAULT_CONNECTION_FILE, LEGACY_CONNECTION_FILE];
  for (const candidatePath of candidates) {
    const file = Bun.file(candidatePath);
    if (!(await file.exists())) continue;
    const value: unknown = await file.json();
    if (typeof value !== "object" || value === null) {
      throw new Error(`Invalid T3 connection file: ${candidatePath}`);
    }
    const candidate = value as Partial<SavedT3Connection>;
    if (typeof candidate.t3HttpUrl !== "string") {
      throw new Error(`Invalid T3 connection file: ${candidatePath}`);
    }
    return {
      ...candidate,
      t3HttpUrl: normalizeHttpUrl(candidate.t3HttpUrl),
    } as SavedT3Connection;
  }
  return null;
}
