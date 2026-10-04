import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_CONNECTION_FILE,
  DEFAULT_TOKEN_FILE,
  discoverLocalT3HttpUrl,
  exchangeT3PairingUrl,
  parseT3PairingUrl,
} from "./t3-connection.ts";

test("stores watcher-owned configuration under the user's home directory", () => {
  expect(DEFAULT_CONFIG_DIR).toBe(join(process.env.HOME!, ".t3-watcher"));
  expect(DEFAULT_CONNECTION_FILE).toBe(join(DEFAULT_CONFIG_DIR, "connection.json"));
  expect(DEFAULT_TOKEN_FILE).toBe(join(DEFAULT_CONFIG_DIR, "token"));
});

describe("parseT3PairingUrl", () => {
  test("reads a direct backend pairing URL", () => {
    expect(parseT3PairingUrl("http://192.168.1.5:3773/pair#token=PAIRCODE")).toEqual({
      t3HttpUrl: "http://192.168.1.5:3773",
      credential: "PAIRCODE",
    });
  });

  test("reads a hosted T3 pairing URL", () => {
    expect(
      parseT3PairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.com%3A8443#token=PAIRCODE",
      ),
    ).toEqual({ t3HttpUrl: "https://t3.example.com:8443", credential: "PAIRCODE" });
  });
});

test("exchangeT3PairingUrl requests only orchestration read access", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    requests.push({ url, init });
    if (url.endsWith("/.well-known/t3/environment")) {
      return Response.json({
        environmentId: "environment-1",
        label: "Studio Mac",
        serverVersion: "1.2.3",
        platform: { os: "darwin", arch: "arm64" },
        capabilities: {},
      });
    }
    return Response.json({ access_token: "read-only-token" });
  }) as typeof fetch;

  const result = await exchangeT3PairingUrl(
    "https://t3.example.com/pair#token=PAIRCODE",
    fetcher,
  );
  expect(result).toMatchObject({
    t3HttpUrl: "https://t3.example.com",
    environmentId: "environment-1",
    label: "Studio Mac",
    bearerToken: "read-only-token",
  });
  const tokenBody = new URLSearchParams(requests[1]?.init?.body?.toString());
  expect(tokenBody.get("scope")).toBe("orchestration:read");
  expect(tokenBody.get("client_label")).toBe("T3 Watcher");
});

test("discoverLocalT3HttpUrl follows T3 Code's runtime state file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "t3-watcher-test-"));
  try {
    const runtimeStateFile = join(directory, "server-runtime.json");
    await Bun.write(
      runtimeStateFile,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        origin: "http://127.0.0.1:4567",
      }),
    );
    const fetcher = (async () =>
      Response.json({
        environmentId: "environment-1",
        label: "Local T3",
        serverVersion: "1.2.3",
      })) as unknown as typeof fetch;

    expect(await discoverLocalT3HttpUrl({ runtimeStateFile, fetcher })).toBe(
      "http://127.0.0.1:4567",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
