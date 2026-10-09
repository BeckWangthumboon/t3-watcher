export type SessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export type TurnState = "running" | "interrupted" | "completed" | "error";

export interface T3LatestTurn {
  turnId: string;
  state: TurnState;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface T3Session {
  status: SessionStatus;
  updatedAt: string;
}

export interface T3ProjectShell {
  id: string;
  title: string;
}

export interface T3ThreadShell {
  id: string;
  projectId: string;
  title: string;
  interactionMode: "default" | "plan";
  latestTurn: T3LatestTurn | null;
  session: T3Session | null;
  updatedAt: string;
  archivedAt: string | null;
  settledOverride: "settled" | "active" | null;
  settledAt: string | null;
  latestUserMessageAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
  hasActionableProposedPlan: boolean;
  watcherStatus?: WatcherStatus;
  backgroundLiveness?: "working" | "monitoring" | null;
  snoozedUntil?: string | null;
  pinnedAt?: string | null;
  autoSettleDisabledAt?: string | null;
}

export interface T3ShellSnapshot {
  snapshotSequence: number;
  projects: T3ProjectShell[];
  threads: T3ThreadShell[];
  updatedAt: string;
}

export type WatcherStatus =
  | "approval"
  | "input"
  | "plan_ready"
  | "failed"
  | "starting"
  | "running"
  | "finished"
  | "waiting"
  | "limited"
  | "ready";

export type WatcherConnection = "connecting" | "live" | "partial" | "stale" | "error";

export interface WatchedThread {
  key: string;
  environmentId: string;
  threadId: string;
  projectId: string;
  projectTitle: string | null;
  title: string;
  status: WatcherStatus;
  latestTurnId: string | null;
  updatedAt: string;
  href: string | null;
  backendId?: string;
  backendName?: string;
  backendWatcher?: WatcherConnection;
}

export interface BackendStatus {
  id: string;
  name: string;
  t3HttpUrl: string;
  watcher: WatcherConnection;
  transport?: "stream";
  lastCheckedAt: string | null;
  error: string | null;
}

export interface WatcherSnapshot {
  watcher: WatcherConnection;
  transport?: "stream";
  watcherName: string;
  sourceUpdatedAt: string | null;
  lastCheckedAt: string | null;
  error: string | null;
  threads: WatchedThread[];
  backends?: BackendStatus[];
}
