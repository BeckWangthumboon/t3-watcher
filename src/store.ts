import { initialWatcherSnapshot } from "./state.ts";
import type { WatcherSnapshot } from "./types.ts";

export class WatcherStore {
  #snapshot: WatcherSnapshot;
  #listeners = new Set<(snapshot: WatcherSnapshot) => void>();

  constructor(watcherName: string) {
    this.#snapshot = initialWatcherSnapshot(watcherName);
  }

  get snapshot(): WatcherSnapshot {
    return this.#snapshot;
  }

  set(snapshot: WatcherSnapshot): void {
    const serializedPrevious = JSON.stringify(this.#snapshot);
    const serializedNext = JSON.stringify(snapshot);
    if (serializedPrevious === serializedNext) return;
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  subscribe(listener: (snapshot: WatcherSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
