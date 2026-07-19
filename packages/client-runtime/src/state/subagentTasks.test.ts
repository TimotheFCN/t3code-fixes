import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveSubagentTasks, openBackgroundSubagentTasks } from "./subagentTasks.ts";

function activity(input: {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
  readonly sequence?: number;
}): OrchestrationThreadActivity {
  return {
    id: input.id,
    kind: input.kind,
    tone: "info",
    summary: input.kind,
    payload: input.payload,
    turnId: null,
    createdAt: input.createdAt,
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
  } as OrchestrationThreadActivity;
}

describe("deriveSubagentTasks", () => {
  it("folds started, progress, and completed activities into one task", () => {
    const tasks = deriveSubagentTasks([
      activity({
        id: "a1",
        kind: "task.started",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { taskId: "task-1", detail: "Count files", taskType: "explore", background: true },
      }),
      activity({
        id: "a2",
        kind: "task.progress",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { taskId: "task-1", summary: "Counting…", lastToolName: "Shell" },
      }),
      activity({
        id: "a3",
        kind: "task.completed",
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: {
          taskId: "task-1",
          status: "completed",
          detail: "There are 42 files.",
          agentId: "agent-123",
          background: true,
        },
      }),
    ]);

    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.taskId).toBe("task-1");
    expect(task.description).toBe("Count files");
    expect(task.taskType).toBe("explore");
    expect(task.background).toBe(true);
    expect(task.status).toBe("completed");
    expect(task.latestSummary).toBe("There are 42 files.");
    expect(task.lastToolName).toBe("Shell");
    expect(task.agentId).toBe("agent-123");
    expect(task.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(task.completedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(task.progress).toHaveLength(1);
    expect(task.progress[0]?.summary).toBe("Counting…");
  });

  it("creates a running task from progress alone and sorts by activity order", () => {
    const tasks = deriveSubagentTasks([
      activity({
        id: "b2",
        kind: "task.progress",
        createdAt: "2026-01-01T00:00:05.000Z",
        payload: { taskId: "task-b", summary: "later task" },
        sequence: 2,
      }),
      activity({
        id: "b1",
        kind: "task.progress",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { taskId: "task-a", summary: "earlier task" },
        sequence: 1,
      }),
    ]);

    expect(tasks.map((task) => task.taskId)).toEqual(["task-a", "task-b"]);
    expect(tasks[0]?.status).toBe("running");
    expect(tasks[0]?.background).toBe(false);
  });

  it("maps failed and stopped completion statuses", () => {
    const tasks = deriveSubagentTasks([
      activity({
        id: "c1",
        kind: "task.completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { taskId: "task-f", status: "failed", description: "Broken" },
      }),
      activity({
        id: "c2",
        kind: "task.completed",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { taskId: "task-s", status: "stopped" },
      }),
    ]);
    expect(tasks.find((task) => task.taskId === "task-f")?.status).toBe("failed");
    expect(tasks.find((task) => task.taskId === "task-f")?.description).toBe("Broken");
    expect(tasks.find((task) => task.taskId === "task-s")?.status).toBe("stopped");
  });

  it("ignores activities without a taskId and non-task kinds", () => {
    const tasks = deriveSubagentTasks([
      activity({
        id: "d1",
        kind: "task.progress",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { summary: "no task id" },
      }),
      activity({
        id: "d2",
        kind: "tool.completed",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { taskId: "not-a-task" },
      }),
    ]);
    expect(tasks).toHaveLength(0);
  });
});

describe("openBackgroundSubagentTasks", () => {
  it("returns only running background tasks", () => {
    const tasks = deriveSubagentTasks([
      activity({
        id: "e1",
        kind: "task.started",
        createdAt: "2026-01-01T00:00:00.000Z",
        payload: { taskId: "bg-running", background: true },
      }),
      activity({
        id: "e2",
        kind: "task.started",
        createdAt: "2026-01-01T00:00:01.000Z",
        payload: { taskId: "fg-running" },
      }),
      activity({
        id: "e3",
        kind: "task.started",
        createdAt: "2026-01-01T00:00:02.000Z",
        payload: { taskId: "bg-done", background: true },
      }),
      activity({
        id: "e4",
        kind: "task.completed",
        createdAt: "2026-01-01T00:00:03.000Z",
        payload: { taskId: "bg-done", status: "completed", background: true },
      }),
    ]);

    expect(openBackgroundSubagentTasks(tasks).map((task) => task.taskId)).toEqual(["bg-running"]);
  });
});
