import { describe, expect, test } from "bun:test";
import { deriveStatus, isEffectivelySettled, normalizeShell } from "./state.ts";
import type { T3ShellSnapshot, T3ThreadShell } from "./types.ts";

const NOW = Date.parse("2026-08-04T12:00:00.000Z");

function thread(overrides: Partial<T3ThreadShell> = {}): T3ThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Test thread",
    interactionMode: "default",
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
  test("keeps approval and input distinct and prioritizes them over running", () => {
    const value = thread({
      hasPendingApprovals: true,
      hasPendingUserInput: true,
      session: { status: "running", updatedAt: "2026-08-04T11:00:00.000Z" },
    });
    expect(deriveStatus(value, NOW)).toBe("approval");
    expect(deriveStatus(thread({ hasPendingUserInput: true }), NOW)).toBe("input");
  });

  test("prioritizes errors over completed turns", () => {
    const value = thread({ session: { status: "error", updatedAt: "2026-08-04T11:00:00.000Z" } });
    expect(deriveStatus(value, NOW)).toBe("failed");
  });

  test("only shows a settled plan-mode proposal as plan ready", () => {
    expect(
      deriveStatus(
        thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
        NOW,
      ),
    ).toBe("plan_ready");
    expect(deriveStatus(thread({ hasActionableProposedPlan: true }), NOW)).toBe("finished");
  });

  test("recovers completion when teardown leaves the turn interrupted", () => {
    expect(
      deriveStatus(
        thread({
          session: { status: "stopped", updatedAt: "2026-08-04T10:10:00.000Z" },
          latestTurn: { ...thread().latestTurn!, state: "interrupted" },
        }),
        NOW,
      ),
    ).toBe("finished");
  });

  test("treats ready and idle sessions as finished without a materialized turn", () => {
    expect(deriveStatus(thread({ latestTurn: null }), NOW)).toBe("finished");
    expect(
      deriveStatus(
        thread({ latestTurn: null, session: { status: "idle", updatedAt: "2026-08-04T10:10:00.000Z" } }),
        NOW,
      ),
    ).toBe("finished");
  });

  test("maps genuinely interrupted or stopped sessions to ready, not attention", () => {
    for (const status of ["interrupted", "stopped"] as const) {
      expect(
        deriveStatus(
          thread({
            session: { status, updatedAt: "2026-08-04T10:10:00.000Z" },
            latestTurn: { ...thread().latestTurn!, state: "interrupted", completedAt: null },
          }),
          NOW,
        ),
      ).toBe("ready");
    }
  });
});

describe("isEffectivelySettled", () => {
  test("never settles running work or work awaiting input", () => {
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
