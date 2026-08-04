import { describe, expect, test } from "bun:test";
import { deriveStatus, isEffectivelySettled, normalizeShell } from "./state.ts";
import type { T3ShellSnapshot, T3ThreadShell } from "./types.ts";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

function thread(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Test thread",
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-08-04T10:00:00.000Z",
      startedAt: "2026-08-04T10:00:01.000Z",
      completedAt: "2026-08-04T10:10:00.000Z",
    },
    session: { status: "ready", updatedAt: "2026-08-04T10:10:00.000Z" },
    updatedAt: "2026-08-04T10:10:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-04T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("deriveStatus", () => {
  test("prioritizes waiting over a running session", () => {
    const value = thread({
      hasPendingApprovals: true,
      session: { status: "running", updatedAt: "2026-08-04T11:00:00.000Z" },
    });
    expect(deriveStatus(value, NOW)).toBe("waiting");
  });

  test("prioritizes errors over completed turns", () => {
    const value = thread({ session: { status: "error", updatedAt: "2026-08-04T11:00:00.000Z" } });
    expect(deriveStatus(value, NOW)).toBe("failed");
  });

  test("shows actionable plans as waiting", () => {
    expect(deriveStatus(thread({ hasActionableProposedPlan: true }), NOW)).toBe("waiting");
  });
});

describe("isEffectivelySettled", () => {
  test("never settles running or waiting work", () => {
    const running = thread({ session: { status: "running", updatedAt: "2026-08-04T11:00:00.000Z" } });
    const waiting = thread({ hasPendingUserInput: true, settledOverride: "settled" });
    expect(isEffectivelySettled(running, { nowMs: NOW, autoSettleAfterDays: 0 })).toBe(false);
    expect(isEffectivelySettled(waiting, { nowMs: NOW, autoSettleAfterDays: 0 })).toBe(false);
  });

  test("honors explicit lifecycle overrides", () => {
    expect(
      isEffectivelySettled(thread({ settledOverride: "settled" }), {
        nowMs: NOW,
        autoSettleAfterDays: 3,
      }),
    ).toBe(true);
    expect(
      isEffectivelySettled(thread({ settledOverride: "active" }), {
        nowMs: NOW,
        autoSettleAfterDays: 0,
      }),
    ).toBe(false);
  });

  test("auto-settles inactive threads", () => {
    const stale = thread({
      latestUserMessageAt: "2026-07-20T10:00:00.000Z",
      latestTurn: {
        turnId: "turn-old",
        state: "completed",
        requestedAt: "2026-07-20T10:00:00.000Z",
        startedAt: "2026-07-20T10:00:01.000Z",
        completedAt: "2026-07-20T10:10:00.000Z",
      },
    });
    expect(isEffectivelySettled(stale, { nowMs: NOW, autoSettleAfterDays: 3 })).toBe(true);
  });
});

test("normalizeShell filters settled and archived threads", () => {
  const snapshot: T3ShellSnapshot = {
    snapshotSequence: 1,
    updatedAt: "2026-08-04T12:00:00.000Z",
    projects: [{ id: "project-1", title: "Project One" }],
    threads: [
      thread({ id: "visible", settledOverride: "active" }),
      thread({ id: "settled", settledOverride: "settled" }),
      thread({ id: "archived", archivedAt: "2026-08-04T11:00:00.000Z" }),
    ],
  };
  const result = normalizeShell(snapshot, {
    environmentId: "environment-1",
    autoSettleAfterDays: 3,
    nowMs: NOW,
  });
  expect(result.map((item) => item.threadId)).toEqual(["visible"]);
  expect(result[0]?.projectTitle).toBe("Project One");
});
