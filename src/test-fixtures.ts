// Minimal wire fixture based on upstream efecd3cf8b (2026-10-04),
// packages/contracts/src/orchestrationV2.ts. No real thread content.
export function v2Shell(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, snapshotSequence: 1,
    projects: [{ id: "project-1", title: "Project One" }], archivedThreads: [],
    threads: [{
      id: "thread-1", projectId: "project-1", title: "New orchestrator thread",
      lineage: { relationshipToParent: null }, interactionMode: "default",
      status: "completed", latestRunId: "run-1", latestRunRequestedAt: "2026-10-04T10:00:00Z",
      latestRunStartedAt: "2026-10-04T10:00:01Z", latestRunCompletedAt: "2026-10-04T10:01:00Z",
      pendingRuntimeRequest: null, pendingBackgroundTasks: [], hasActionableProposedPlan: false,
      latestUserMessageAt: "2026-10-04T10:00:00Z", updatedAt: "2026-10-04T10:01:00Z",
      archivedAt: null, settledOverride: null, settledAt: null, deletedAt: null,
      ...overrides,
    }],
  };
}
