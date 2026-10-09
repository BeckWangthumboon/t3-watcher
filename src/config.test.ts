import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";
import { exchangeT3PairingUrl, saveT3Connection, namedBackendDirectory } from "./t3-connection.ts";

const configModule = new URL("./config.ts", import.meta.url).pathname;
const configureScript = new URL("./configure.ts", import.meta.url).pathname;

async function runBun(directory: string, args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: directory,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(error);
  return output;
}

async function readConfig(directory: string, env: Record<string, string> = {}): Promise<WatcherConfig> {
  return JSON.parse(await runBun(directory, [
    "-e",
    `import { loadConfig } from ${JSON.stringify(configModule)}; console.log(JSON.stringify(await loadConfig()));`,
  ], env));
}

test("an explicit backend overrides an invalid saved profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-config-"));
  try {
    const connectionFile = join(directory, "broken.json");
    await Bun.write(connectionFile, "invalid json");
    const config = await readConfig(directory, {
      T3_HTTP_URL: "http://127.0.0.1:1234/",
      T3_CONNECTION_FILE: connectionFile,
      T3_BEARER_TOKEN: "override-token",
    });
    expect(config.t3HttpUrl).toBe("http://127.0.0.1:1234");
    expect(config.bearerToken).toBe("override-token");
    expect(config.watcherName).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pairing saves a private profile that the service can load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-config-"));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/.well-known/t3/environment") {
        return Response.json({ environmentId: "test-env", label: "Test T3", serverVersion: "1" });
      }
      const body = new URLSearchParams(await request.text());
      expect(body.get("subject_token")).toBe("pairing-token");
      expect(body.get("scope")).toBe("orchestration:read");
      return Response.json({ access_token: "saved-token" });
    },
  });
  try {
    // Existing permissive files must also become private when configured again.
    const profileDir = join(directory, ".t3-watcher");
    await mkdir(profileDir, { mode: 0o755 });
    await Bun.write(join(profileDir, "token"), "old-token");
    const connection = await exchangeT3PairingUrl(`${server.url}pair#token=pairing-token`);
    await saveT3Connection(connection, profileDir);
    const config = await readConfig(directory, {
      T3_CONNECTION_FILE: join(profileDir, "connection.json"),
      T3_BEARER_TOKEN_FILE: join(profileDir, "token"),
    });
    expect(config.t3HttpUrl).toBe(server.url.toString().replace(/\/$/, ""));
    expect(config.bearerToken).toBe("saved-token");
    expect(config.watcherName).toBe("Test T3");
    for (const [path, mode] of [
      [profileDir, 0o700],
      [join(profileDir, "connection.json"), 0o600],
      [join(profileDir, "token"), 0o600],
    ] as const) {
      expect((await stat(path)).mode & 0o777).toBe(mode);
    }
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("named backend profiles keep separate credentials alongside the existing default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-config-"));
  try {
    await saveT3Connection({ t3HttpUrl: "http://127.0.0.1:3773", label: "Local", bearerToken: "local-token" }, directory);
    await saveT3Connection({ t3HttpUrl: "http://mintbox:3773", label: "Mintbox", bearerToken: "mint-token" },
      namedBackendDirectory("mintbox", directory));
    await saveT3Connection({ t3HttpUrl: "http://studio:3773", label: "Studio", bearerToken: "studio-token" },
      namedBackendDirectory("studio", directory));
    const config = await readConfig(directory, { WATCHER_CONFIG_DIR: directory });
    expect(config.backends?.map(({ id, bearerToken }) => ({ id, bearerToken }))).toEqual([
      { id: "default", bearerToken: "local-token" },
      { id: "mintbox", bearerToken: "mint-token" },
      { id: "studio", bearerToken: "studio-token" },
    ]);
    const override = await readConfig(directory, { WATCHER_CONFIG_DIR: directory,
      T3_HTTP_URL: "http://temporary:3773", T3_BEARER_TOKEN: "temporary-token" });
    expect(override.backends).toHaveLength(1);
    expect(override.backends?.[0]?.bearerToken).toBe("temporary-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("named-only setup does not add an unwanted implicit localhost backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-config-"));
  try {
    await saveT3Connection({ t3HttpUrl: "http://mintbox:3773", bearerToken: "mint-token" },
      namedBackendDirectory("mintbox", directory));
    const config = await readConfig(directory, { WATCHER_CONFIG_DIR: directory });
    expect(config.backends).toHaveLength(1);
    expect(config.backends?.[0]?.id).toBe("mintbox");
    expect(() => namedBackendDirectory("../escape", directory)).toThrow("Backend names");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configure --name pairs and replaces only the requested backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-cli-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return Response.json(new URL(request.url).pathname === "/.well-known/t3/environment"
      ? { environmentId: "cli-env", label: "CLI Backend", serverVersion: "1" }
      : { access_token: "new-token" });
  } });
  try {
    await saveT3Connection({ t3HttpUrl: "http://original:3773", bearerToken: "original-token" }, directory);
    await runBun(directory, [configureScript, "--name", "remote", `${server.url}pair#token=pairing-token`],
      { WATCHER_CONFIG_DIR: directory });
    const config = await readConfig(directory, { WATCHER_CONFIG_DIR: directory });
    expect(config.backends?.map((backend) => backend.bearerToken)).toEqual(["original-token", "new-token"]);
  } finally {
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the pets rename preserves legacy profiles and prefers the new directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-pets-migration-"));
  try {
    const legacyDir = join(directory, ".t3-watcher");
    await saveT3Connection({ t3HttpUrl: "http://legacy:3773", label: "Legacy", bearerToken: "legacy-token" }, legacyDir);
    await saveT3Connection({ t3HttpUrl: "http://remote:3773", bearerToken: "remote-token" },
      namedBackendDirectory("remote", legacyDir));
    const legacy = await readConfig(directory, { HOME: directory, WATCHER_HOST: "localhost" });
    expect(legacy.backends?.map(({ id, bearerToken }) => ({ id, bearerToken }))).toEqual([
      { id: "default", bearerToken: "legacy-token" },
      { id: "remote", bearerToken: "remote-token" },
    ]);
    expect(legacy.hostname).toBe("localhost");

    const petsDir = join(directory, ".t3-pets");
    await saveT3Connection({ t3HttpUrl: "http://pets:3773", bearerToken: "pets-token" }, petsDir);
    const current = await readConfig(directory, { HOME: directory,
      T3_PETS_HOST: "127.0.0.2", WATCHER_HOST: "localhost" });
    expect(current.t3HttpUrl).toBe("http://pets:3773");
    expect(current.bearerToken).toBe("pets-token");
    expect(current.backends).toHaveLength(1);
    expect(current.hostname).toBe("127.0.0.2");

    const override = await readConfig(directory, { HOME: directory,
      T3_PETS_CONFIG_DIR: legacyDir, WATCHER_CONFIG_DIR: petsDir });
    expect(override.backends).toHaveLength(2);
    expect(override.bearerToken).toBe("legacy-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
