import { describe, expect, test } from "bun:test";
import { DEMO_SHELL } from "./demo.ts";
import { normalizeShell } from "./state.ts";
import { parseT3Shell } from "./t3-shell.ts";
import { v2Shell } from "./test-fixtures.ts";

const checkedAt = "2026-10-04T12:00:00Z";

function normalized(overrides: Record<string, unknown> = {}) {
  return normalizeShell(parseT3Shell(v2Shell(overrides), checkedAt), {
    environmentId: "env-1", autoSettleAfterDays: 3, nowMs: Date.parse(checkedAt),
  });
}

test("rejects the legacy stable shell", () => {
  expect(() => parseT3Shell(DEMO_SHELL, checkedAt)).toThrow("invalid shell");
});

describe("protocol-2 shell", () => {
  test("uses run identity and timestamps without a top-level updatedAt", () => {
    const [thread] = normalized();
    expect(thread).toMatchObject({ key: "env-1:thread-1", latestTurnId: "run-1", status: "finished" });
    expect(parseT3Shell(v2Shell(), checkedAt).updatedAt).toBe("2026-10-04T10:01:00Z");
  });

  test("distinguishes requests, failures, usage limits, and active runs", () => {
    for (const [override, status] of [
      [{ status: "preparing" }, "starting"], [{ status: "queued" }, "starting"],
      [{ status: "running" }, "running"], [{ status: "waiting" }, "running"],
      [{ pendingRuntimeRequest: { kind: "user_input" } }, "input"],
      [{ pendingRuntimeRequest: { kind: "command_approval" } }, "approval"],
      [{ status: "failed", lastErrorClass: "usage_limit" }, "limited"],
      [{ status: "failed", lastErrorClass: "provider_error" }, "failed"],
      [{ status: "cancelled" }, "ready"], [{ status: "interrupted" }, "ready"],
      [{ status: "idle", latestRunId: null }, "ready"],
      [{ interactionMode: "plan", hasActionableProposedPlan: true }, "plan_ready"],
    ] as const) {
      expect(normalized(override)[0]?.status).toBe(status);
    }
  });

  test("background commands allow completion; subagents and monitors hold it", () => {
    expect(normalized({ pendingBackgroundTasks: [{ kind: "command" }] })[0]?.status).toBe("finished");
    for (const kind of ["subagent", "monitor", "background_task"]) {
      expect(normalized({ pendingBackgroundTasks: [{ kind }] })[0]?.status).toBe("waiting");
    }
    expect(normalized({ activityRunStatus: "running" })[0]?.status).toBe("running");
    expect(normalized({ status: "failed", activityRunStatus: "running" })[0]?.status).toBe("running");
  });

  test("filters subagent threads, deleted threads, and snoozed threads", () => {
    expect(normalized({ lineage: { relationshipToParent: "subagent" } })).toEqual([]);
    expect(normalized({ deletedAt: checkedAt })).toEqual([]);
    expect(normalized({ snoozedUntil: "2026-10-05T12:00:00Z" })).toEqual([]);
    expect(normalized({ snoozedUntil: "2026-10-03T12:00:00Z" })).toHaveLength(1);
  });

  test("keeps pinned and auto-settlement-disabled threads visible", () => {
    const stale = { latestUserMessageAt: "2026-09-01T12:00:00Z",
      latestRunRequestedAt: "2026-09-01T12:00:00Z", latestRunStartedAt: "2026-09-01T12:00:01Z",
      latestRunCompletedAt: "2026-09-01T12:01:00Z" };
    expect(normalized(stale)).toEqual([]);
    expect(normalized({ ...stale, pinnedAt: checkedAt })).toHaveLength(1);
    expect(normalized({ ...stale, autoSettleDisabledAt: checkedAt })).toHaveLength(1);
  });

  test("rejects an unknown wire shape instead of displaying misleading state", () => {
    expect(() => parseT3Shell({}, checkedAt)).toThrow("invalid shell");
    expect(() => parseT3Shell(v2Shell({ status: "future-status" }), checkedAt)).toThrow("invalid thread");
  });
});
