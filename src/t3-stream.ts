import { parseT3Shell } from "./t3-shell.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Keep the wire shell intact: normalizing it early loses fields needed by later deltas. */
export class T3ShellProjection {
  #snapshot: RecordValue;

  constructor(snapshot: unknown) {
    parseT3Shell(snapshot, new Date().toISOString());
    if (!record(snapshot) || !sequence(snapshot.schemaVersion) || snapshot.schemaVersion < 1 || !sequence(snapshot.snapshotSequence)) {
      throw new Error("Unsupported T3 streaming shell schema.");
    }
    this.#snapshot = snapshot;
  }

  get snapshot(): RecordValue { return this.#snapshot; }
  get snapshotSequence(): number { return this.#snapshot.snapshotSequence as number; }

  apply(item: unknown): boolean {
    if (!record(item)) throw new Error("Invalid T3 shell stream item.");
    if (item.kind === "synchronized") return false;
    if (item.kind === "snapshot") {
      // Enrichment frames contain projects only, often at a newer sequence.
      // They must neither clear threads nor skip lifecycle deltas at that sequence.
      if (item.resolvedRepositoryIdentityRoots !== undefined) return false;
      this.#snapshot = new T3ShellProjection(item.snapshot).snapshot;
      return true;
    }
    if (!sequence(item.sequence)) throw new Error("Invalid T3 shell stream sequence.");
    if (item.sequence <= this.snapshotSequence) return false;
    const projects = this.#snapshot.projects as RecordValue[];
    const threads = this.#snapshot.threads as RecordValue[];
    const upsert = (items: RecordValue[], value: unknown): RecordValue[] => {
      if (!record(value) || typeof value.id !== "string") throw new Error("Invalid T3 shell stream entity.");
      return [...items.filter((item) => item.id !== value.id), value];
    };
    let next: RecordValue = { ...this.#snapshot, snapshotSequence: item.sequence };
    switch (item.kind) {
      case "project.updated": next.projects = upsert(projects, item.project); break;
      case "project.removed":
        if (typeof item.projectId !== "string") throw new Error("Invalid T3 project removal.");
        next.projects = projects.filter((project) => project.id !== item.projectId);
        break;
      case "thread.updated":
        if (!record(item.thread) || typeof item.thread.id !== "string" ||
            !["active", "archive"].includes(String(item.location))) throw new Error("Invalid T3 thread update.");
        next.threads = item.location === "archive"
          ? threads.filter((thread) => thread.id !== (item.thread as RecordValue).id)
          : upsert(threads, item.thread);
        break;
      case "thread.removed":
        if (typeof item.threadId !== "string") throw new Error("Invalid T3 thread removal.");
        next.threads = threads.filter((thread) => thread.id !== item.threadId);
        break;
      default: throw new Error("Unsupported T3 shell stream item.");
    }
    parseT3Shell(next, new Date().toISOString());
    this.#snapshot = next;
    return true;
  }
}

export interface T3StreamOptions {
  t3HttpUrl: string;
  bearerToken: string | null;
  snapshot: unknown;
  signal: AbortSignal;
  onSnapshot: (snapshot: RecordValue) => void;
  // Shorter intervals allow deterministic transport timeout tests.
  pingMs?: number;
  timeoutMs?: number;
}

/** Minimal Effect RPC JSON stream transport: Request, Chunk/Ack, Exit and Ping/Pong. */
export async function subscribeT3Shell(options: T3StreamOptions): Promise<void> {
  const projection = new T3ShellProjection(options.snapshot);
  const url = new URL(`${options.t3HttpUrl}/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  if (options.bearerToken) {
    const response = await fetch(`${options.t3HttpUrl}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.bearerToken}` },
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(6_000)]),
    });
    if (!response.ok) throw new Error(`T3 WebSocket ticket request returned ${response.status}`);
    const value: unknown = await response.json();
    if (!record(value) || typeof value.ticket !== "string" || !value.ticket) {
      throw new Error("T3 returned an invalid WebSocket ticket.");
    }
    url.searchParams.set("wsTicket", value.ticket);
  }
  options.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const requestId = "pets-shell";
    const timeoutMs = options.timeoutMs ?? 15_000;
    let lastFrameAt = Date.now();
    let synchronized = false;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(synchronizationTimeout);
      options.signal.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    const synchronizationTimeout = setTimeout(() => finish(new Error("T3 shell stream did not synchronize.")), timeoutMs);
    const heartbeat = setInterval(() => {
      if (Date.now() - lastFrameAt >= timeoutMs) {
        finish(new Error("T3 shell stream stopped responding."));
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ _tag: "Ping" }));
      }
    }, options.pingMs ?? 5_000);
    options.signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      if (settled) return;
      socket.send(JSON.stringify({
        _tag: "Request", id: requestId, tag: "orchestration.subscribeShell",
        payload: { afterSequence: projection.snapshotSequence, requestCompletionMarker: true }, headers: [],
      }));
    };
    socket.onmessage = ({ data }) => {
      if (settled) return;
      try {
        const decoded: unknown = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (!record(message)) throw new Error("Invalid T3 RPC stream message.");
          if (message._tag === "Pong") {
            lastFrameAt = Date.now();
            // Re-evaluate time-based snoozes/settlement without another HTTP request.
            if (synchronized) options.onSnapshot(projection.snapshot);
            continue;
          }
          if (message._tag === "Chunk" && message.requestId === requestId && Array.isArray(message.values)) {
            lastFrameAt = Date.now();
            for (const item of message.values) {
              const changed = projection.apply(item);
              if (record(item) && item.kind === "synchronized") {
                synchronized = true;
                clearTimeout(synchronizationTimeout);
                options.onSnapshot(projection.snapshot);
              } else if (changed && synchronized) {
                // Publish each lifecycle change, even if several arrive in one RPC chunk.
                options.onSnapshot(projection.snapshot);
              }
            }
            socket.send(JSON.stringify({ _tag: "Ack", requestId }));
          } else if (message._tag === "Exit" && message.requestId === requestId) {
            throw new Error("T3 shell subscription ended or was rejected.");
          } else {
            throw new Error("Unsupported T3 RPC stream message.");
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid T3 shell stream."));
      }
    };
    // Never include the socket URL: it contains a short-lived credential.
    socket.onerror = () => finish(new Error("Could not connect to the T3 shell stream."));
    socket.onclose = () => finish(new Error("T3 shell stream disconnected."));
  });
}
