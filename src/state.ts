import type {
  T3ShellSnapshot,
  T3ThreadShell,
  WatchedThread,
  WatcherSnapshot,
  WatcherStatus,
} from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

const STATUS_ORDER: Record<WatcherStatus, number> = {
  approval: 0,
  input: 1,
  plan_ready: 2,
  failed: 3,
  starting: 4,
  running: 5,
  finished: 6,
  ready: 7,
};

function parsed(value: string | null | undefined): number | null {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function hasQueuedTurnStart(shell: T3ThreadShell, nowMs: number): boolean {
  const messageAt = parsed(shell.latestUserMessageAt);
  if (messageAt == null || shell.session?.status === "error") return false;
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  if (shell.latestTurn === null) return true;
  return [
    shell.latestTurn.requestedAt,
    shell.latestTurn.startedAt,
    shell.latestTurn.completedAt,
  ].every((candidate) => {
    const timestamp = parsed(candidate);
    return timestamp == null || timestamp < messageAt;
  });
}

export function threadLastActivityAt(shell: T3ThreadShell): number | null {
  const timestamps = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ]
    .map(parsed)
    .filter((value): value is number => value !== null);
  return timestamps.length === 0 ? null : Math.max(...timestamps);
}

export function isEffectivelySettled(
  shell: T3ThreadShell,
  options: { nowMs: number; autoSettleAfterDays: number | null },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  if (hasQueuedTurnStart(shell, options.nowMs)) {
    const settledAt = parsed(shell.settledAt);
    const messageAt = parsed(shell.latestUserMessageAt);
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      settledAt !== null &&
      messageAt !== null &&
      settledAt >= messageAt;
    if (!serverAdjudicated) return false;
  }
  if (shell.settledOverride === "settled") return true;
  if (shell.settledOverride === "active") return false;
  if (options.autoSettleAfterDays === null) return false;
  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return false;
  return lastActivityAt < options.nowMs - options.autoSettleAfterDays * DAY_MS;
}

export function deriveStatus(shell: T3ThreadShell, nowMs: number): WatcherStatus {
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "input";
  if (shell.session?.status === "error" || shell.latestTurn?.state === "error") {
    return "failed";
  }
  if (shell.session?.status === "starting") return "starting";
  if (
    shell.session?.status === "running" ||
    shell.latestTurn?.state === "running" ||
    hasQueuedTurnStart(shell, nowMs)
  ) {
    return "running";
  }
  const latestTurnSettled =
    shell.latestTurn?.startedAt != null &&
    shell.latestTurn.completedAt != null;
  if (
    shell.interactionMode === "plan" &&
    shell.hasActionableProposedPlan &&
    latestTurnSettled
  ) {
    return "plan_ready";
  }
  if (shell.latestTurn?.state === "completed") return "finished";
  if (shell.latestTurn?.state === "interrupted" && shell.latestTurn.completedAt !== null) {
    return "finished";
  }
  if (shell.session?.status === "ready" || shell.session?.status === "idle") {
    return "finished";
  }
  return "ready";
}

export function normalizeShell(
  snapshot: T3ShellSnapshot,
  options: {
    environmentId: string;
    autoSettleAfterDays: number | null;
    nowMs?: number;
    webBaseUrl?: string | null;
  },
): WatchedThread[] {
  const nowMs = options.nowMs ?? Date.now();
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const baseUrl = options.webBaseUrl?.replace(/\/$/, "") ?? null;

  return snapshot.threads
    .filter((thread) => thread.archivedAt === null)
    .filter(
      (thread) =>
        !isEffectivelySettled(thread, {
          nowMs,
          autoSettleAfterDays: options.autoSettleAfterDays,
        }),
    )
    .map((thread): WatchedThread => {
      const updatedAt =
        thread.session?.updatedAt ??
        thread.latestTurn?.completedAt ??
        thread.latestTurn?.startedAt ??
        thread.updatedAt;
      return {
        key: `${options.environmentId}:${thread.id}`,
        environmentId: options.environmentId,
        threadId: thread.id,
        projectId: thread.projectId,
        projectTitle: projects.get(thread.projectId)?.title ?? null,
        title: thread.title,
        status: deriveStatus(thread, nowMs),
        latestTurnId: thread.latestTurn?.turnId ?? null,
        updatedAt,
        href: baseUrl
          ? `${baseUrl}/${encodeURIComponent(options.environmentId)}/${encodeURIComponent(thread.id)}`
          : null,
      };
    })
    .sort((left, right) => {
      const statusDifference = STATUS_ORDER[left.status] - STATUS_ORDER[right.status];
      if (statusDifference !== 0) return statusDifference;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
}

export function initialWatcherSnapshot(watcherName: string): WatcherSnapshot {
  return {
    watcher: "connecting",
    watcherName,
    sourceUpdatedAt: null,
    lastCheckedAt: null,
    error: null,
    threads: [],
  };
}
