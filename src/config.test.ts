import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatcherConfig } from "./config.ts";
import { exchangeT3PairingUrl, saveT3Connection } from "./t3-connection.ts";

const configModule = new URL("./config.ts", import.meta.url).pathname;

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
