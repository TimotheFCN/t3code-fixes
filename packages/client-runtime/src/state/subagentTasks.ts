/**
 * subagentTasks - derives per-thread subagent task state from the flat
 * activity list.
 *
 * Providers surface subagent lifecycles as `task.started` / `task.progress` /
 * `task.completed` activities. This module folds those into one record per
 * task so clients can render a subagent panel and a "waiting on subagents"
 * indicator without any additional server state.
 *
 * @module subagentTasks
 */
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type SubagentTaskStatus = "running" | "completed" | "failed" | "stopped";

export interface SubagentTaskProgressEntry {
  readonly activityId: string;
  readonly createdAt: string;
  readonly summary?: string;
  readonly lastToolName?: string;
}

export interface SubagentTask {
  readonly taskId: string;
  readonly description: string;
  readonly taskType?: string;
  /** True when the task runs detached from the turn (e.g. Cursor background subagents). */
  readonly background: boolean;
  readonly status: SubagentTaskStatus;
  /** Latest progress or completion summary. */
  readonly latestSummary?: string;
  readonly lastToolName?: string;
  /** Provider-side agent id usable to resume the subagent (known on completion). */
  readonly agentId?: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly progress: ReadonlyArray<SubagentTaskProgressEntry>;
}

interface MutableSubagentTask {
  taskId: string;
  description: string;
  taskType?: string;
  background: boolean;
  status: SubagentTaskStatus;
  latestSummary?: string;
  lastToolName?: string;
  agentId?: string;
  startedAt: string;
  completedAt?: string;
  progress: Array<SubagentTaskProgressEntry>;
}

function toPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
}

function readString(payload: Record<string, unknown> | null, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }
  return left.id.localeCompare(right.id);
}

/**
 * Folds a thread's activities into one entry per subagent task, ordered by
 * when each task first appeared.
 */
export function deriveSubagentTasks(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubagentTask[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const tasks = new Map<string, MutableSubagentTask>();

  const ensureTask = (
    taskId: string,
    activity: OrchestrationThreadActivity,
    payload: Record<string, unknown> | null,
  ): MutableSubagentTask => {
    const existing = tasks.get(taskId);
    if (existing) {
      return existing;
    }
    const created: MutableSubagentTask = {
      taskId,
      description:
        readString(payload, "description") ?? readString(payload, "detail") ?? "Subagent task",
      background: payload?.background === true,
      status: "running",
      startedAt: activity.createdAt,
      progress: [],
    };
    const taskType = readString(payload, "taskType");
    if (taskType !== undefined) {
      created.taskType = taskType;
    }
    tasks.set(taskId, created);
    return created;
  };

  for (const activity of ordered) {
    if (
      activity.kind !== "task.started" &&
      activity.kind !== "task.progress" &&
      activity.kind !== "task.completed"
    ) {
      continue;
    }
    const payload = toPayloadRecord(activity.payload);
    const taskId = readString(payload, "taskId");
    if (taskId === undefined) {
      continue;
    }
    const task = ensureTask(taskId, activity, payload);

    if (activity.kind === "task.started") {
      const taskType = readString(payload, "taskType");
      if (taskType !== undefined) {
        task.taskType = taskType;
      }
      const description = readString(payload, "detail") ?? readString(payload, "description");
      if (description !== undefined) {
        task.description = description;
      }
      if (payload?.background === true) {
        task.background = true;
      }
      continue;
    }

    if (activity.kind === "task.progress") {
      const summary = readString(payload, "summary") ?? readString(payload, "detail");
      const lastToolName = readString(payload, "lastToolName");
      if (summary !== undefined) {
        task.latestSummary = summary;
      }
      if (lastToolName !== undefined) {
        task.lastToolName = lastToolName;
      }
      task.progress.push({
        activityId: activity.id,
        createdAt: activity.createdAt,
        ...(summary !== undefined ? { summary } : {}),
        ...(lastToolName !== undefined ? { lastToolName } : {}),
      });
      continue;
    }

    const status = payload?.status;
    task.status = status === "failed" ? "failed" : status === "stopped" ? "stopped" : "completed";
    task.completedAt = activity.createdAt;
    const summary = readString(payload, "detail") ?? readString(payload, "summary");
    if (summary !== undefined) {
      task.latestSummary = summary;
    }
    const description = readString(payload, "description");
    if (description !== undefined && task.description === "Subagent task") {
      task.description = description;
    }
    const agentId = readString(payload, "agentId");
    if (agentId !== undefined) {
      task.agentId = agentId;
    }
    if (payload?.background === true) {
      task.background = true;
    }
  }

  return Array.from(tasks.values());
}

/**
 * Background tasks that are still running. Non-empty while a thread should
 * show "waiting on subagents" after its own turn has settled.
 */
export function openBackgroundSubagentTasks(
  tasks: ReadonlyArray<SubagentTask>,
): ReadonlyArray<SubagentTask> {
  return tasks.filter((task) => task.background && task.status === "running");
}
