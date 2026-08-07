#!/Users/beck/.bun/bin/bun
// <xbar.title>T3 Watcher</xbar.title>
// <xbar.version>v0.1.0</xbar.version>
// <xbar.author>Beck</xbar.author>
// <xbar.desc>Live unsettled T3 thread status from mintbox.</xbar.desc>
// <xbar.dependencies>bun,tailscale</xbar.dependencies>
// <swiftbar.type>streamable</swiftbar.type>
// <swiftbar.runInBash>false</swiftbar.runInBash>
// <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
// <swiftbar.refreshOnOpen>false</swiftbar.refreshOnOpen>
// <swiftbar.environment>[PATH=/Users/beck/.bun/bin:/usr/local/bin:/usr/bin:/bin]</swiftbar.environment>

interface WatchedThread {
  key: string;
  title: string;
  projectTitle: string | null;
  status:
    | "approval"
    | "input"
    | "plan_ready"
    | "failed"
    | "starting"
    | "running"
    | "finished"
    | "ready";
  updatedAt: string;
}

interface WatcherSnapshot {
  watcher: "connecting" | "live" | "stale" | "error";
  watcherName: string;
  lastCheckedAt: string | null;
  error: string | null;
  threads: WatchedThread[];
}

export interface StatusTransition {
  thread: WatchedThread;
  previousStatus: WatchedThread["status"] | null;
}

const DEFAULT_WATCHER_URL = "http://100.70.142.26:4173";
const watcherUrl = (Bun.env.T3_WATCHER_URL || DEFAULT_WATCHER_URL).replace(/\/$/, "");
const noteworthyStatuses = new Set<WatchedThread["status"]>([
  "approval",
  "input",
  "plan_ready",
  "failed",
  "finished",
]);

const statusLabels: Record<WatchedThread["status"], string> = {
  approval: "Approval needed",
  input: "Awaiting input",
  plan_ready: "Plan ready",
  failed: "Failed",
  starting: "Starting",
  running: "Working",
  finished: "Finished",
  ready: "Ready",
};

const statusColors: Record<WatchedThread["status"], string> = {
  approval: "#A86813",
  input: "#6852A8",
  plan_ready: "#7450A8",
  failed: "#AD3E35",
  starting: "#376585",
  running: "#376585",
  finished: "#247052",
  ready: "#71756E",
};

const green = "\u001b[32m";
const resetColor = "\u001b[0m";

const groups: Array<{
  title: string;
  statuses: WatchedThread["status"][];
}> = [
  { title: "Needs you", statuses: ["approval", "input", "plan_ready", "failed"] },
  { title: "Working", statuses: ["starting", "running"] },
  { title: "Finished", statuses: ["finished"] },
  { title: "Ready", statuses: ["ready"] },
];

function safeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replaceAll("|", "¦").replaceAll("---", "—").trim();
}

function relativeTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "recently";
  const seconds = Math.round((timestamp - now) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function menuTitle(snapshot: WatcherSnapshot): string {
  if (snapshot.watcher !== "live") return "?";
  const attention = snapshot.threads.filter((thread) =>
    ["approval", "input", "plan_ready", "failed"].includes(thread.status),
  ).length;
  const running = snapshot.threads.filter((thread) =>
    ["starting", "running"].includes(thread.status),
  ).length;
  const finished = snapshot.threads.filter((thread) => thread.status === "finished").length;
  const parts = [
    attention > 0 ? `!${attention}` : null,
    running > 0 ? `●${running}` : null,
    finished > 0 ? `${green}✓${resetColor}${finished}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(" ");
  if (snapshot.threads.length > 0) return `${snapshot.threads.length}`;
  return "·";
}

export function renderSwiftBar(snapshot: WatcherSnapshot): string {
  const lines = [`${menuTitle(snapshot)} | sfimage=eye ansi=true`, "---", "T3 Watcher"];
  const connectionLabel =
    snapshot.watcher === "live"
      ? `Live · ${safeText(snapshot.watcherName)}`
      : `${snapshot.watcher === "connecting" ? "Connecting" : "Unavailable"} · ${safeText(snapshot.watcherName)}`;
  lines.push(`${connectionLabel} | color=${snapshot.watcher === "live" ? "#247052" : "#A86813"} size=11`);

  if (snapshot.watcher !== "live" && snapshot.error) {
    lines.push(`${safeText(snapshot.error)} | color=#AD3E35 size=11`);
  }

  for (const group of groups) {
    const threads = snapshot.threads.filter((thread) => group.statuses.includes(thread.status));
    if (threads.length === 0) continue;
    lines.push("---", `${group.title.toUpperCase()} · ${threads.length} | color=#71756E size=11`);
    for (const thread of threads) {
      const title = safeText(thread.title) || "Untitled thread";
      const project = safeText(thread.projectTitle || "Unlabeled project");
      lines.push(
        `${statusLabels[thread.status]} · ${title} | color=${statusColors[thread.status]}`,
        `--${project} · ${relativeTime(thread.updatedAt)} | color=#71756E size=11`,
      );
    }
  }

  if (snapshot.threads.length === 0 && snapshot.watcher === "live") {
    lines.push("---", "Nothing unsettled | color=#247052");
  }

  return lines.join("\n");
}

export function findStatusTransitions(
  previous: ReadonlyMap<string, WatchedThread["status"]>,
  snapshot: WatcherSnapshot,
  initialized: boolean,
): StatusTransition[] {
  if (!initialized) return [];
  const transitions: StatusTransition[] = [];
  for (const thread of snapshot.threads) {
    const previousStatus = previous.get(thread.key) ?? null;
    if (previousStatus !== thread.status && noteworthyStatuses.has(thread.status)) {
      transitions.push({ thread, previousStatus });
    }
  }
  return transitions;
}

export function parseSseBlocks(input: string): {
  snapshots: WatcherSnapshot[];
  remainder: string;
} {
  const normalized = input.replaceAll("\r\n", "\n");
  const blocks = normalized.split("\n\n");
  const remainder = blocks.pop() ?? "";
  const snapshots: WatcherSnapshot[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      snapshots.push(JSON.parse(data) as WatcherSnapshot);
    } catch {
      console.error("T3 Watcher: ignored malformed SSE data");
    }
  }
  return { snapshots, remainder };
}

async function sendNotification(transition: StatusTransition): Promise<void> {
  const params = new URLSearchParams({
    name: "t3-watcher",
    title: statusLabels[transition.thread.status],
    subtitle: transition.thread.projectTitle || "T3 Code",
    body: transition.thread.title,
  });
  const process = Bun.spawn(["/usr/bin/open", "-g", `swiftbar://notify?${params}`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await process.exited;
}

function statusMap(snapshot: WatcherSnapshot): Map<string, WatchedThread["status"]> {
  return new Map(snapshot.threads.map((thread) => [thread.key, thread.status]));
}

async function run(): Promise<never> {
  let previous = new Map<string, WatchedThread["status"]>();
  let initialized = false;
  let lastSnapshot: WatcherSnapshot | null = null;
  let lastRendered: string | null = null;
  let emitted = false;
  let reconnectDelayMs = 1_000;

  const emit = (snapshot: WatcherSnapshot) => {
    const rendered = renderSwiftBar(snapshot);
    if (rendered === lastRendered) return;
    process.stdout.write(emitted ? `~~~\n${rendered}\n` : `${rendered}\n`);
    lastRendered = rendered;
    emitted = true;
  };

  emit({
    watcher: "connecting",
    watcherName: "mintbox",
    lastCheckedAt: null,
    error: null,
    threads: [],
  });

  while (true) {
    try {
      const response = await fetch(`${watcherUrl}/api/events`, {
        headers: { accept: "text/event-stream" },
      });
      if (!response.ok || response.body === null) {
        throw new Error(`Watcher returned ${response.status}`);
      }
      reconnectDelayMs = 1_000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error("Watcher stream ended");
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseBlocks(buffer);
        buffer = parsed.remainder;
        for (const snapshot of parsed.snapshots) {
          const transitions = findStatusTransitions(previous, snapshot, initialized);
          for (const transition of transitions) void sendNotification(transition);
          previous = statusMap(snapshot);
          initialized = true;
          lastSnapshot = snapshot;
          emit(snapshot);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not reach watcher";
      const stale: WatcherSnapshot = lastSnapshot
        ? { ...lastSnapshot, watcher: "stale", error: message }
        : {
            watcher: "error",
            watcherName: "mintbox",
            lastCheckedAt: null,
            error: message,
            threads: [],
          };
      emit(stale);
      await Bun.sleep(reconnectDelayMs);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
    }
  }
}

if (import.meta.main) {
  await run();
}
