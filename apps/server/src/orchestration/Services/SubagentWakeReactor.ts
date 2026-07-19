/**
 * SubagentWakeReactor - Background-subagent wake reactor service interface.
 *
 * Watches for background subagent task settlements (`task.completed` runtime
 * events with `background: true`) and re-prompts the owning thread with a
 * server-originated turn when the thread is idle, so the main agent resumes
 * automatically instead of waiting for a human nudge.
 *
 * @module SubagentWakeReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * SubagentWakeReactorShape - Service API for the subagent wake reactor.
 */
export interface SubagentWakeReactorShape {
  /**
   * Start the reactor.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * SubagentWakeReactor - Service tag for the subagent wake reactor.
 */
export class SubagentWakeReactor extends Context.Service<
  SubagentWakeReactor,
  SubagentWakeReactorShape
>()("t3/orchestration/Services/SubagentWakeReactor") {}
