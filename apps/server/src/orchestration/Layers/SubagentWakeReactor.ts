/**
 * SubagentWakeReactor - wakes idle threads when background subagents settle.
 *
 * Background subagents (today: Cursor `cursor/task` launches) outlive the
 * turn that started them. When such a task completes the main agent has
 * already ended its turn, so nothing would ever feed the result back. This
 * reactor queues background `task.completed` settlements per thread and, as
 * soon as the thread has no active turn, dispatches a server-originated
 * `thread.turn.start` whose message reports the settlements and asks the
 * agent to continue.
 *
 * Settlements that land mid-turn stay queued and flush when the session
 * transitions back to `ready` (observed via `thread.session-set` domain
 * events). Settlements for stopped/errored sessions are dropped.
 *
 * @module SubagentWakeReactor
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type TaskCompletedPayload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubagentWakeReactor,
  type SubagentWakeReactorShape,
} from "../Services/SubagentWakeReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface SubagentSettlement {
  readonly description: string;
  readonly status: "completed" | "failed";
  readonly summary: string | undefined;
  readonly agentId: string | undefined;
}

type ReactorInput =
  | {
      readonly kind: "settlement";
      readonly threadId: ThreadId;
      readonly settlement: SubagentSettlement;
    }
  | {
      readonly kind: "flush";
      readonly threadId: ThreadId;
    };

export function composeSubagentWakeMessage(settlements: ReadonlyArray<SubagentSettlement>): string {
  const lines = settlements.map((settlement) => {
    const heading = `- "${settlement.description}" — ${settlement.status}${
      settlement.agentId ? ` (agentId: ${settlement.agentId})` : ""
    }`;
    return settlement.summary ? `${heading}\n  Result: ${settlement.summary}` : heading;
  });
  const noun = settlements.length === 1 ? "task has" : "tasks have";
  return [
    `The following background subagent ${noun} finished:`,
    ...lines,
    "",
    "Review the results and continue the work. If you need more detail from a subagent, resume it with the Task tool using its agentId.",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;

  const pendingByThread = new Map<ThreadId, Array<SubagentSettlement>>();

  const dispatchWake = Effect.fn("dispatchWake")(function* (
    threadId: ThreadId,
    settlements: ReadonlyArray<SubagentSettlement>,
  ) {
    const createdAt = yield* nowIso;
    const commandUUID = yield* randomUUID;
    const messageUUID = yield* randomUUID;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:subagent-wake:${commandUUID}`),
      threadId,
      message: {
        messageId: MessageId.make(messageUUID),
        role: "user",
        text: composeSubagentWakeMessage(settlements),
        attachments: [],
      },
      // The decider derives the effective modes from the thread read model;
      // these values are schema placeholders only.
      runtimeMode: DEFAULT_RUNTIME_MODE,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    });
  });

  const flushThread = Effect.fn("flushThread")(function* (threadId: ThreadId) {
    const settlements = pendingByThread.get(threadId);
    if (!settlements || settlements.length === 0) {
      return;
    }
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    const session = thread?.session ?? null;
    if (!thread || !session || session.status === "stopped" || session.status === "error") {
      pendingByThread.delete(threadId);
      yield* Effect.logDebug("subagent wake dropped settlements for inactive thread", {
        threadId,
        settlementCount: settlements.length,
      });
      return;
    }
    const idle =
      session.activeTurnId === null && (session.status === "ready" || session.status === "idle");
    if (!idle) {
      // Keep the settlements queued; the next `thread.session-set` with
      // status "ready" retries the flush.
      return;
    }
    pendingByThread.delete(threadId);
    yield* dispatchWake(threadId, settlements);
  });

  const processInput = Effect.fn("processInput")(function* (input: ReactorInput) {
    if (input.kind === "settlement") {
      const pending = pendingByThread.get(input.threadId) ?? [];
      pending.push(input.settlement);
      pendingByThread.set(input.threadId, pending);
    }
    yield* flushThread(input.threadId);
  });

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("subagent wake reactor failed to process input", {
          threadId: input.threadId,
          kind: input.kind,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const settlementFromRuntimeEvent = (
    payload: TaskCompletedPayload,
  ): SubagentSettlement | undefined => {
    if (payload.background !== true) {
      return undefined;
    }
    // "stopped" settlements come from session teardown or aborts; waking the
    // thread for them would restart sessions the user just stopped.
    if (payload.status !== "completed" && payload.status !== "failed") {
      return undefined;
    }
    return {
      description: payload.description ?? "Subagent task",
      status: payload.status,
      summary: payload.summary,
      agentId: payload.agentId,
    };
  };

  const start: SubagentWakeReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event: ProviderRuntimeEvent) => {
        if (event.type !== "task.completed") {
          return Effect.void;
        }
        const settlement = settlementFromRuntimeEvent(event.payload);
        if (!settlement) {
          return Effect.void;
        }
        return worker.enqueue({
          kind: "settlement",
          threadId: ThreadId.make(event.threadId),
          settlement,
        });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
        if (event.type !== "thread.session-set") {
          return Effect.void;
        }
        const session = event.payload.session;
        if (!session || session.status !== "ready" || session.activeTurnId !== null) {
          return Effect.void;
        }
        if (!pendingByThread.has(session.threadId)) {
          return Effect.void;
        }
        return worker.enqueue({ kind: "flush", threadId: session.threadId });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies SubagentWakeReactorShape;
});

export const SubagentWakeReactorLive = Layer.effect(SubagentWakeReactor, make);
