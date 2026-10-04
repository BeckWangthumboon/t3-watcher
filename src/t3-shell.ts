import type { T3ShellSnapshot, T3ThreadShell, WatcherStatus } from "./types.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null;
const timestamp = (value: unknown): string | null => typeof value === "string" ? value : null;
const runStatuses = new Set([
  "idle", "preparing", "queued", "starting", "running", "waiting", "completed",
  "interrupted", "failed", "cancelled", "rolled_back",
]);

function v2Status(thread: RecordValue): WatcherStatus {
  const request = record(thread.pendingRuntimeRequest) ? thread.pendingRuntimeRequest : null;
  if (request?.kind === "user_input") return "input";
  if (request && request.kind !== "auth_refresh") return "approval";
  const background = Array.isArray(thread.pendingBackgroundTasks) ? thread.pendingBackgroundTasks : [];
  if (thread.status !== "failed" && background.some((task) => record(task) && task.kind !== "command")) return "waiting";
  const status = thread.activityRunStatus ?? thread.status;
  if (["preparing", "queued", "starting"].includes(String(status))) return "starting";
  if (["running", "waiting"].includes(String(status))) return "running";
  if (status === "failed") return thread.lastErrorClass === "usage_limit" ? "limited" : "failed";
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) return "plan_ready";
  if (thread.latestRunId && ["completed", "idle"].includes(String(thread.status))) return "finished";
  return "ready";
}

function v2Thread(thread: RecordValue): T3ThreadShell {
  const status = v2Status(thread);
  const runId = timestamp(thread.latestRunId);
  const active = ["starting", "running"].includes(status);
  return {
    id: String(thread.id),
    projectId: String(thread.projectId),
    title: String(thread.title),
    interactionMode: thread.interactionMode === "plan" ? "plan" : "default",
    watcherStatus: status,
    latestTurn: runId ? {
      turnId: runId,
      state: active ? "running" : ["failed", "limited"].includes(status) ? "error"
        : ["finished", "plan_ready", "waiting"].includes(status) ? "completed" : "interrupted",
      requestedAt: timestamp(thread.latestRunRequestedAt) ?? String(thread.updatedAt),
      startedAt: timestamp(thread.latestRunStartedAt),
      completedAt: thread.latestRunCompletedAt === undefined
        ? active ? null : String(thread.updatedAt)
        : timestamp(thread.latestRunCompletedAt),
    } : null,
    session: null,
    updatedAt: String(thread.updatedAt),
    archivedAt: timestamp(thread.archivedAt),
    settledOverride: thread.settledOverride === "settled" || thread.settledOverride === "active"
      ? thread.settledOverride : null,
    settledAt: timestamp(thread.settledAt),
    latestUserMessageAt: timestamp(thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt),
    hasPendingApprovals: status === "approval",
    hasPendingUserInput: status === "input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan === true,
    snoozedUntil: timestamp(thread.snoozedUntil),
    pinnedAt: timestamp(thread.pinnedAt),
    autoSettleDisabledAt: timestamp(thread.autoSettleDisabledAt),
  };
}

/** Adapt the stable v1 and October 2026 protocol-2 HTTP shell formats. */
export function parseT3Shell(value: unknown, checkedAt: string): T3ShellSnapshot {
  if (!record(value) || typeof value.snapshotSequence !== "number" ||
      !Array.isArray(value.projects) || !Array.isArray(value.threads)) {
    throw new Error("T3 returned an invalid shell snapshot.");
  }
  const v2 = typeof value.schemaVersion === "number";
  if (!v2 && typeof value.updatedAt !== "string") throw new Error("T3 returned an invalid shell snapshot.");
  for (const project of value.projects) {
    if (!record(project) || typeof project.id !== "string" || typeof project.title !== "string") {
      throw new Error("T3 returned an invalid project shell.");
    }
  }
  for (const thread of value.threads) {
    if (!record(thread) || typeof thread.id !== "string" || typeof thread.projectId !== "string" ||
        typeof thread.title !== "string" || typeof thread.updatedAt !== "string" ||
        (v2 ? !runStatuses.has(String(thread.status))
          : !("latestTurn" in thread && "session" in thread && "hasPendingApprovals" in thread))) {
      throw new Error("T3 returned an invalid thread shell.");
    }
  }
  const threads = value.threads as RecordValue[];
  const updatedAt = timestamp(value.updatedAt) ?? [...threads, ...value.projects]
    .map((item) => timestamp(item.updatedAt))
    .filter((item): item is string => item !== null)
    .sort().at(-1) ?? checkedAt;
  return {
    snapshotSequence: value.snapshotSequence,
    projects: value.projects as T3ShellSnapshot["projects"],
    threads: v2 ? threads.filter((thread) => thread.deletedAt == null &&
      !(record(thread.lineage) && thread.lineage.relationshipToParent === "subagent")).map(v2Thread)
      : value.threads as T3ThreadShell[],
    updatedAt,
  };
}
