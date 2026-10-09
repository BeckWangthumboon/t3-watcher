import { describe, expect, test } from "bun:test";
import { parseSseBlocks, renderSwiftBar } from "./t3-pets.ts";

const snapshot = {
  watcher: "live" as const,
  watcherName: "mintbox",
  lastCheckedAt: "2026-08-04T12:00:00.000Z",
  error: null,
  threads: [
    {
      key: "environment:running",
      title: "Build permissions UI",
      projectTitle: "kase",
      status: "running" as const,
      updatedAt: "2026-08-04T11:50:00.000Z",
    },
  ],
};

describe("renderSwiftBar", () => {
  test("renders a compact running title and dropdown", () => {
    const output = renderSwiftBar(snapshot);
    expect(output).toStartWith("●1 | sfimage=eye ansi=true\n---");
    expect(output).toContain("WORKING · 1");
    expect(output).toContain("Working · Build permissions UI");
    expect(output).not.toContain("href=");
    expect(output).not.toContain("Open watcher");
  });

  test("renders disconnected state without hiding cached threads", () => {
    const output = renderSwiftBar({ ...snapshot, watcher: "stale", error: "Network unavailable" });
    expect(output).toStartWith("? | sfimage=eye ansi=true\n---");
    expect(output).toContain("Network unavailable");
    expect(output).toContain("Build permissions UI");
  });

  test("keeps finished count visible beside other states", () => {
    const mixed = {
      ...snapshot,
      threads: [
        snapshot.threads[0]!,
        { ...snapshot.threads[0]!, key: "environment:finished", status: "finished" as const },
        { ...snapshot.threads[0]!, key: "environment:approval", status: "approval" as const },
      ],
    };
    expect(renderSwiftBar(mixed)).toStartWith(
      "!1 ●1 \u001b[32m✓\u001b[0m1 | sfimage=eye ansi=true\n---",
    );
  });
});

test("renders partially connected and cached threads", () => {
  const partial = { ...snapshot, watcher: "partial" as const, threads: [
    { ...snapshot.threads[0]!, status: "finished" as const, backendWatcher: "stale" },
  ] };
  expect(renderSwiftBar(partial)).toContain("Partly connected");
  expect(renderSwiftBar(partial)).toContain("Cached · Finished");
});

test("parseSseBlocks preserves incomplete data", () => {
  const first = parseSseBlocks(`event: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r\nevent: snap`);
  expect(first.snapshots).toEqual([snapshot]);
  expect(first.remainder).toBe("event: snap");
});
