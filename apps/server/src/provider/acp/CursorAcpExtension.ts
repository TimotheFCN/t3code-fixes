/**
 * Public Docs: https://cursor.com/docs/cli/acp#cursor-extension-methods
 * Additional reference provided by the Cursor team: https://anysphere.enterprise.slack.com/files/U068SSJE141/F0APT1HSZRP/cursor-acp-extension-method-schemas.md
 */
import type { UserInputQuestion } from "@t3tools/contracts";
import * as AcpSchema from "effect-acp/schema";
import * as Schema from "effect/Schema";

const CursorAskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const CursorAskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(CursorAskQuestionOption),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(CursorAskQuestion),
});

const CursorTodoStatus = Schema.String;

const CursorTodo = Schema.Struct({
  id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  status: Schema.optional(CursorTodoStatus),
});

const CursorPlanPhase = Schema.Struct({
  name: Schema.String,
  todos: Schema.Array(CursorTodo),
});

export const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  name: Schema.optional(Schema.String),
  overview: Schema.optional(Schema.String),
  plan: Schema.String,
  todos: Schema.Array(CursorTodo),
  isProject: Schema.optional(Schema.Boolean),
  phases: Schema.optional(Schema.Array(CursorPlanPhase)),
});

export const CursorUpdateTodosRequest = Schema.Struct({
  toolCallId: Schema.String,
  todos: Schema.Array(CursorTodo),
  merge: Schema.Boolean,
});

/**
 * `cursor/task` — subagent task notification.
 *
 * Docs describe it as a fire-and-forget notification, but cursor-agent
 * (observed on 2026.07.01) sends it as a JSON-RPC *request* that expects an
 * empty result. It fires when the Task tool call settles: at spawn time for
 * background launches (durationMs is the spawn duration) and at completion
 * for foreground/resumed tasks.
 *
 * `subagentType` is documented as a string or `{ custom: string }` but is
 * observed as nested objects like `{ custom: { unspecified: {} } }`, so it is
 * kept unknown and normalized via {@link cursorSubagentTypeLabel}.
 *
 * `agentId` at background-launch time does NOT match the conversation id the
 * subagent actually runs under (observed empirically); the real id is only
 * discoverable from the on-disk transcript.
 */
export const CursorTaskRequest = Schema.Struct({
  toolCallId: Schema.String,
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  subagentType: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
});

const CursorAvailableModel = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  configOptions: Schema.optional(Schema.Array(AcpSchema.SessionConfigOption)),
});

export const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(CursorAvailableModel),
});

export function extractAskQuestions(
  params: typeof CursorAskQuestionRequest.Type,
): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple === true,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            description: option.label,
          }))
        : [{ label: "OK", description: "Continue" }],
  }));
}

export function extractPlanMarkdown(params: typeof CursorCreatePlanRequest.Type): string {
  return params.plan || "# Plan\n\n(Cursor did not supply plan text.)";
}

/**
 * Normalizes the loosely-typed `subagentType` field of `cursor/task` into a
 * short label, e.g. `"explore"`, `"shell"`, or `undefined` when unspecified.
 */
export function cursorSubagentTypeLabel(subagentType: unknown): string | undefined {
  const label = subagentTypeLabelRecursive(subagentType, 0);
  return label === undefined || label === "unspecified" ? undefined : label;
}

function subagentTypeLabelRecursive(value: unknown, depth: number): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    return undefined;
  }
  const [key, nested] = entries[0]!;
  return subagentTypeLabelRecursive(nested, depth + 1) ?? (key.trim().length > 0 ? key : undefined);
}

export function extractTodosAsPlan(params: typeof CursorUpdateTodosRequest.Type): {
  readonly explanation?: string;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
} {
  const plan = params.todos.flatMap((todo) => {
    const step = todo.content?.trim() ?? todo.title?.trim() ?? "";
    if (step === "") {
      return [];
    }
    const status: "pending" | "inProgress" | "completed" =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress" || todo.status === "inProgress"
          ? "inProgress"
          : "pending";
    return [{ step, status }];
  });
  return { plan };
}
