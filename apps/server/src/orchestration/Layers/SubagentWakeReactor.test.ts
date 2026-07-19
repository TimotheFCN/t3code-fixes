import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  EventId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
} from "@t3tools/contracts";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { SubagentWakeReactor } from "../Services/SubagentWakeReactor.ts";
import { composeSubagentWakeMessage, SubagentWakeReactorLive } from "./SubagentWakeReactor.ts";

const threadId = ThreadId.make("wake-thread-1");

interface HarnessState {
  readonly dispatched: Array<OrchestrationCommand>;
  sessionStatus: OrchestrationSessionStatus;
  activeTurnId: string | null;
  threadExists: boolean;
}

const makeHarness = Effect.gen(function* () {
  const state: HarnessState = {
    dispatched: [],
    sessionStatus: "ready",
    activeTurnId: null,
    threadExists: true,
  };
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();

  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        state.dispatched.push(command);
        return { sequence: state.dispatched.length };
      }),
    streamDomainEvents: Stream.fromPubSub(domainEvents),
    readEvents: () => Stream.empty,
  } as unknown as OrchestrationEngineService["Service"];

  const snapshotQuery = {
    getThreadDetailById: () =>
      Effect.sync(() =>
        state.threadExists
          ? Option.some({
              session: {
                threadId,
                status: state.sessionStatus,
                providerName: "cursor",
                runtimeMode: "full-access",
                activeTurnId: state.activeTurnId,
                lastError: null,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            } as unknown as OrchestrationThread)
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"];

  const providerService = {
    get streamEvents() {
      return Stream.fromPubSub(runtimeEvents);
    },
  } as unknown as ProviderService["Service"];

  const layer = SubagentWakeReactorLive.pipe(
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
    Layer.provideMerge(NodeServices.layer),
  );
  const reactor = yield* Effect.service(SubagentWakeReactor).pipe(
    Effect.provide(yield* Layer.build(layer)),
  );
  yield* reactor.start();
  // The stream subscriptions are established asynchronously by the forked
  // fibers in start(); give them a beat so published test events are not
  // dropped before anyone subscribes.
  yield* Effect.sleep("50 millis");

  const publishRuntime = (event: ProviderRuntimeEvent) => PubSub.publish(runtimeEvents, event);
  const publishDomain = (event: OrchestrationEvent) => PubSub.publish(domainEvents, event);

  const waitForDispatchCount = (count: number) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (state.dispatched.length >= count) {
          return;
        }
        yield* Effect.sleep("5 millis");
      }
    });

  const settle = Effect.gen(function* () {
    // Give the pubsub subscribers a beat to enqueue, then drain the worker.
    yield* Effect.sleep("30 millis");
    yield* reactor.drain;
  });

  return { state, publishRuntime, publishDomain, waitForDispatchCount, settle, reactor };
});

let nextEventNumber = 0;

function taskCompletedEvent(overrides?: {
  readonly background?: boolean;
  readonly status?: "completed" | "failed" | "stopped";
  readonly taskId?: string;
}): ProviderRuntimeEvent {
  nextEventNumber += 1;
  return {
    type: "task.completed",
    eventId: EventId.make(`evt-${nextEventNumber}`),
    createdAt: "2026-01-01T00:00:01.000Z",
    provider: ProviderDriverKind.make("cursor"),
    threadId,
    payload: {
      taskId: RuntimeTaskId.make(overrides?.taskId ?? "task-1"),
      status: overrides?.status ?? "completed",
      summary: "There are 42 files.",
      description: "Count files",
      agentId: "agent-123",
      ...(overrides?.background === undefined || overrides.background ? { background: true } : {}),
    },
  } as ProviderRuntimeEvent;
}

function sessionSetEvent(
  status: OrchestrationSessionStatus,
  activeTurnId: string | null,
): OrchestrationEvent {
  nextEventNumber += 1;
  return {
    type: "thread.session-set",
    eventId: EventId.make(`evt-session-${nextEventNumber}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:02.000Z",
    sequence: 1,
    payload: {
      threadId,
      session: {
        threadId,
        status,
        providerName: "cursor",
        runtimeMode: "full-access",
        activeTurnId: activeTurnId === null ? null : TurnId.make(activeTurnId),
        lastError: null,
        updatedAt: "2026-01-01T00:00:02.000Z",
      },
    },
  } as unknown as OrchestrationEvent;
}

describe("composeSubagentWakeMessage", () => {
  it("summarizes settlements and instructs the agent to continue", () => {
    const message = composeSubagentWakeMessage([
      {
        description: "Count files",
        status: "completed",
        summary: "There are 42 files.",
        agentId: "agent-123",
      },
      { description: "Audit deps", status: "failed", summary: undefined, agentId: undefined },
    ]);
    expect(message).toContain('"Count files" — completed (agentId: agent-123)');
    expect(message).toContain("Result: There are 42 files.");
    expect(message).toContain('"Audit deps" — failed');
    expect(message).toContain("continue the work");
  });
});

describe("SubagentWakeReactor", () => {
  it.live("wakes an idle thread when a background subagent completes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.publishRuntime(taskCompletedEvent());
      yield* harness.waitForDispatchCount(1);

      assert.lengthOf(harness.state.dispatched, 1);
      const command = harness.state.dispatched[0]!;
      assert.equal(command.type, "thread.turn.start");
      if (command.type === "thread.turn.start") {
        assert.equal(String(command.threadId), String(threadId));
        assert.match(String(command.commandId), /^server:subagent-wake:/);
        assert.include(command.message.text, "Count files");
        assert.include(command.message.text, "agent-123");
        assert.include(command.message.text, "There are 42 files.");
      }
    }).pipe(Effect.scoped),
  );

  it.live("queues settlements while a turn is running and flushes on session ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      harness.state.sessionStatus = "running";
      harness.state.activeTurnId = "turn-1";

      yield* harness.publishRuntime(taskCompletedEvent({ taskId: "task-a" }));
      yield* harness.publishRuntime(taskCompletedEvent({ taskId: "task-b" }));
      yield* harness.settle;
      assert.lengthOf(harness.state.dispatched, 0);

      harness.state.sessionStatus = "ready";
      harness.state.activeTurnId = null;
      yield* harness.publishDomain(sessionSetEvent("ready", null));
      yield* harness.waitForDispatchCount(1);

      assert.lengthOf(harness.state.dispatched, 1);
      const command = harness.state.dispatched[0]!;
      if (command.type === "thread.turn.start") {
        // Both settlements batch into one wake message.
        assert.include(command.message.text, "tasks have finished");
      }
    }).pipe(Effect.scoped),
  );

  it.live("ignores non-background, stopped, and inactive-session settlements", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;

      yield* harness.publishRuntime(taskCompletedEvent({ background: false }));
      yield* harness.publishRuntime(taskCompletedEvent({ status: "stopped" }));
      yield* harness.settle;
      assert.lengthOf(harness.state.dispatched, 0);

      harness.state.sessionStatus = "stopped";
      yield* harness.publishRuntime(taskCompletedEvent());
      yield* harness.settle;
      assert.lengthOf(harness.state.dispatched, 0);

      // The dropped settlement must not fire once the session becomes ready.
      harness.state.sessionStatus = "ready";
      yield* harness.publishDomain(sessionSetEvent("ready", null));
      yield* harness.settle;
      assert.lengthOf(harness.state.dispatched, 0);
    }).pipe(Effect.scoped),
  );
});
