import { describe, expect, test } from "bun:test";
import { findStatusTransitions, parseSseBlocks, renderSwiftBar } from "./t3-watcher.ts";

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
    expect(output).toStartWith("●1 | sfimage=eye\n---");
    expect(output).toContain("WORKING · 1");
    expect(output).toContain("Running · Build permissions UI");
    expect(output).not.toContain("href=");
    expect(output).not.toContain("Open watcher");
  });

  test("renders disconnected state without hiding cached threads", () => {
    const output = renderSwiftBar({ ...snapshot, watcher: "stale", error: "Network unavailable" });
    expect(output).toStartWith("? | sfimage=eye\n---");
    expect(output).toContain("Network unavailable");
    expect(output).toContain("Build permissions UI");
  });

  test("keeps completed count visible beside other states", () => {
    const mixed = {
      ...snapshot,
      threads: [
        snapshot.threads[0]!,
        { ...snapshot.threads[0]!, key: "environment:completed", status: "completed" as const },
        { ...snapshot.threads[0]!, key: "environment:waiting", status: "waiting" as const },
      ],
    };
    expect(renderSwiftBar(mixed)).toStartWith("!1 ●1 ✓1 | sfimage=eye\n---");
  });
});

describe("findStatusTransitions", () => {
  test("suppresses notifications for the initial snapshot", () => {
    expect(findStatusTransitions(new Map(), snapshot, false)).toEqual([]);
  });

  test("reports a running to completed transition", () => {
    const completed = {
      ...snapshot,
      threads: [{ ...snapshot.threads[0]!, status: "completed" as const }],
    };
    expect(
      findStatusTransitions(new Map([["environment:running", "running"]]), completed, true),
    ).toEqual([{ thread: completed.threads[0], previousStatus: "running" }]);
  });
});

test("parseSseBlocks preserves incomplete data", () => {
  const first = parseSseBlocks(`event: snapshot\r\ndata: ${JSON.stringify(snapshot)}\r\n\r\nevent: snap`);
  expect(first.snapshots).toEqual([snapshot]);
  expect(first.remainder).toBe("event: snap");
});
