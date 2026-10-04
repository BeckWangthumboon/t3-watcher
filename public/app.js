const groupsElement = document.querySelector("#groups");
const emptyElement = document.querySelector("#empty");
const countElement = document.querySelector("#thread-count");
const nounElement = document.querySelector("#thread-noun");
const connectionElement = document.querySelector("#connection");
const connectionLabelElement = document.querySelector("#connection-label");
const staleBannerElement = document.querySelector("#stale-banner");
const staleDetailElement = document.querySelector("#stale-detail");
const watcherNameElement = document.querySelector("#watcher-name");
const lastUpdatedElement = document.querySelector("#last-updated");
const summaryNoteElement = document.querySelector("#summary-note");

const GROUPS = [
  { key: "needs-you", title: "Needs you", statuses: ["approval", "input", "plan_ready", "failed", "limited"] },
  { key: "working", title: "Working", statuses: ["starting", "running"] },
  { key: "waiting", title: "Waiting on background work", statuses: ["waiting"] },
  { key: "finished", title: "Finished", statuses: ["finished"] },
  { key: "ready", title: "Ready", statuses: ["ready"] },
  { key: "cached", title: "Cached · backend unavailable", statuses: [] },
];

const STATUS_LABELS = {
  approval: "Approval needed",
  input: "Awaiting input",
  plan_ready: "Plan ready",
  starting: "Starting",
  limited: "Usage limit reached",
  waiting: "Background work",
  failed: "Failed",
  running: "Running",
  finished: "Finished",
  ready: "Ready",
};

function isLive(thread, snapshot) {
  return ["live", "partial"].includes(snapshot.watcher) &&
    (!thread.backendWatcher || thread.backendWatcher === "live");
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "recently";
  const seconds = Math.round((timestamp - Date.now()) / 1_000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function makeThreadRow(thread) {
  const row = document.createElement(thread.href ? "a" : "article");
  row.className = "thread-row";
  row.dataset.status = thread.status;
  if (thread.href) {
    row.href = thread.href;
    row.target = "_blank";
    row.rel = "noreferrer";
    row.setAttribute("aria-label", `Open ${thread.title} in T3 Code`);
  }

  const status = document.createElement("div");
  status.className = "thread-status";
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = STATUS_LABELS[thread.status];
  status.append(dot, label);

  const content = document.createElement("div");
  content.className = "thread-content";
  const title = document.createElement("h3");
  title.textContent = thread.title;
  const meta = document.createElement("p");
  meta.textContent = [thread.backendName, thread.projectTitle || "Unlabeled project"].filter(Boolean).join(" · ");
  content.append(title, meta);

  const updated = document.createElement("time");
  updated.className = "thread-updated";
  updated.dateTime = thread.updatedAt;
  updated.textContent = relativeTime(thread.updatedAt);

  row.append(status, content, updated);
  return row;
}

function render(snapshot) {
  watcherNameElement.textContent = snapshot.watcherName;
  countElement.textContent = String(snapshot.threads.length);
  nounElement.textContent = snapshot.threads.length === 1 ? " thread" : " threads";
  connectionElement.dataset.state = snapshot.watcher;
  const connectionLabels = {
    connecting: "Connecting",
    live: "Live",
    partial: "Partly connected",
    stale: "Stale",
    error: "Unavailable",
  };
  connectionLabelElement.textContent = connectionLabels[snapshot.watcher];
  staleBannerElement.hidden = !["partial", "stale", "error"].includes(snapshot.watcher);
  staleDetailElement.textContent = snapshot.error || "The watcher cannot reach T3 right now.";

  if (snapshot.lastCheckedAt) {
    lastUpdatedElement.textContent = `Checked ${relativeTime(snapshot.lastCheckedAt)}`;
  }

  const liveThreads = snapshot.threads.filter((thread) => isLive(thread, snapshot));
  const attention = liveThreads.filter((thread) =>
    ["approval", "input", "plan_ready", "failed", "limited"].includes(thread.status),
  ).length;
  summaryNoteElement.textContent = !["live", "partial"].includes(snapshot.watcher)
    ? "Waiting for live backend data. Cached threads remain visible."
    : attention
    ? `${attention} ${attention === 1 ? "thread needs" : "threads need"} your attention.`
    : liveThreads.some((thread) => ["starting", "running"].includes(thread.status))
      ? "Work is moving. Nothing needs you right now."
      : "No thread needs immediate attention.";

  groupsElement.replaceChildren();
  for (const group of GROUPS) {
    const threads = snapshot.threads.filter((thread) => group.key === "cached"
      ? !isLive(thread, snapshot) : isLive(thread, snapshot) && group.statuses.includes(thread.status));
    if (threads.length === 0) continue;
    const section = document.createElement("section");
    section.className = "thread-group";
    const heading = document.createElement("div");
    heading.className = "group-heading";
    const title = document.createElement("h2");
    title.textContent = group.title;
    const count = document.createElement("span");
    count.textContent = String(threads.length);
    heading.append(title, count);
    const rows = document.createElement("div");
    rows.className = "thread-list";
    rows.append(...threads.map(makeThreadRow));
    section.append(heading, rows);
    groupsElement.append(section);
  }

  const hasNoThreads = snapshot.threads.length === 0 && snapshot.watcher === "live";
  emptyElement.hidden = !hasNoThreads;
  groupsElement.hidden = snapshot.threads.length === 0;
}

const events = new EventSource("/api/events");
events.addEventListener("snapshot", (event) => {
  try {
    render(JSON.parse(event.data));
  } catch {
    connectionElement.dataset.state = "error";
    connectionLabelElement.textContent = "Invalid update";
  }
});
events.onerror = () => {
  connectionElement.dataset.state = "stale";
  connectionLabelElement.textContent = "Reconnecting";
  staleBannerElement.hidden = false;
  staleDetailElement.textContent = "The browser lost contact with the watcher.";
};

setInterval(() => {
  for (const time of document.querySelectorAll(".thread-updated")) {
    time.textContent = relativeTime(time.dateTime);
  }
}, 30_000);
