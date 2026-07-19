/**
 * CursorSubagentTranscripts — tracks Cursor CLI background subagents through
 * their on-disk transcripts.
 *
 * ACP gives no signal when a background subagent finishes: `cursor/task`
 * fires once at spawn time (with an agentId that does not match the
 * conversation the subagent actually runs under) and nothing follows when
 * the subagent completes. The only reliable completion signal is the
 * subagent's transcript at
 * `~/.cursor/projects/<slug(cwd)>/agent-transcripts/<agentId>/<agentId>.jsonl`,
 * which ends with a `{"type":"turn_ended","status":...}` line.
 *
 * The watcher polls that directory, matches the task's prompt against the
 * first user message of new transcripts (claiming each transcript at most
 * once), then follows the matched transcript for progress and completion.
 *
 * @module CursorSubagentTranscripts
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

const DEFAULT_POLL_INTERVAL = Duration.seconds(2);
const DEFAULT_MATCH_TIMEOUT = Duration.seconds(90);
/** Transcripts whose file mtime predates the launch by more than this are never matched. */
const MATCH_MTIME_SLACK_MILLIS = 60_000;
const SUMMARY_MAX_LENGTH = 2_000;

/**
 * Maps a session cwd to the Cursor CLI project slug used under
 * `~/.cursor/projects/`, e.g. `/tmp/acp-probe/workdir` → `tmp-acp-probe-workdir`.
 */
export function cursorProjectSlug(cwd: string): string {
  return cwd.replace(/^[/\\]+/, "").replace(/[/\\:]+/g, "-");
}

export function cursorAgentTranscriptsDir(input: {
  readonly homeDir: string;
  readonly cwd: string;
  readonly path: Path.Path;
}): string {
  return input.path.join(
    input.homeDir,
    ".cursor",
    "projects",
    cursorProjectSlug(input.cwd),
    "agent-transcripts",
  );
}

export type CursorSubagentEndStatus = "completed" | "failed" | "stopped";

export interface CursorTranscriptSummary {
  readonly firstUserText: string | undefined;
  readonly lastAssistantText: string | undefined;
  readonly lastToolName: string | undefined;
  readonly ended: CursorSubagentEndStatus | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractMessageText(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const chunks: Array<string> = [];
  for (const entry of message.content) {
    if (isRecord(entry) && entry.type === "text" && typeof entry.text === "string") {
      const text = entry.text.trim();
      if (text.length > 0) {
        chunks.push(text);
      }
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

function extractLastToolName(message: unknown): string | undefined {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  let toolName: string | undefined;
  for (const entry of message.content) {
    if (
      isRecord(entry) &&
      entry.type === "tool_use" &&
      typeof entry.name === "string" &&
      entry.name.trim().length > 0
    ) {
      toolName = entry.name.trim();
    }
  }
  return toolName;
}

function normalizeEndStatus(status: unknown): CursorSubagentEndStatus {
  switch (status) {
    case "success":
      return "completed";
    case "aborted":
      return "stopped";
    default:
      return "failed";
  }
}

/**
 * Parses a Cursor agent transcript (`<agentId>.jsonl`). Unparsable or
 * partially-written trailing lines are ignored so the parser is safe to run
 * against a file that is still being appended to.
 */
export function parseCursorTranscript(content: string): CursorTranscriptSummary {
  let firstUserText: string | undefined;
  let lastAssistantText: string | undefined;
  let lastToolName: string | undefined;
  let ended: CursorSubagentEndStatus | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(entry)) continue;
    if (entry.type === "turn_ended") {
      ended = normalizeEndStatus(entry.status);
      continue;
    }
    if (entry.role === "user" && firstUserText === undefined) {
      firstUserText = extractMessageText(entry.message);
      continue;
    }
    if (entry.role === "assistant") {
      const text = extractMessageText(entry.message);
      if (text !== undefined) {
        lastAssistantText = text;
      }
      const toolName = extractLastToolName(entry.message);
      if (toolName !== undefined) {
        lastToolName = toolName;
      }
    }
  }

  return { firstUserText, lastAssistantText, lastToolName, ended };
}

export function truncateSubagentSummary(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARY_MAX_LENGTH)}…`;
}

export interface CursorSubagentProgress {
  readonly summary?: string;
  readonly lastToolName?: string;
}

export type CursorSubagentWatchResult =
  | {
      readonly _tag: "Completed";
      readonly agentId: string;
      readonly status: CursorSubagentEndStatus;
      readonly finalText: string | undefined;
    }
  | { readonly _tag: "MatchTimedOut" };

export interface WatchCursorSubagentTaskOptions {
  readonly transcriptsDir: string;
  /** The task prompt from `cursor/task`; matched against the transcript's first user message. */
  readonly prompt: string;
  readonly launchedAtMillis: number;
  /**
   * Transcript agent ids already claimed by other tasks of the same session.
   * The watcher adds the matched id so concurrent tasks with identical
   * prompts never share a transcript.
   */
  readonly claimedAgentIds: Set<string>;
  readonly pollInterval?: Duration.Input;
  readonly matchTimeout?: Duration.Input;
  readonly onProgress: (progress: CursorSubagentProgress) => Effect.Effect<void>;
}

/**
 * Follows one background subagent until its transcript records a turn end.
 * Never fails: filesystem errors are treated as "nothing observed yet".
 */
export const watchCursorSubagentTask = (
  options: WatchCursorSubagentTaskOptions,
): Effect.Effect<CursorSubagentWatchResult, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pollInterval = Duration.fromInputUnsafe(options.pollInterval ?? DEFAULT_POLL_INTERVAL);
    const matchTimeoutMillis = Duration.toMillis(
      Duration.fromInputUnsafe(options.matchTimeout ?? DEFAULT_MATCH_TIMEOUT),
    );
    const prompt = options.prompt.trim();

    const transcriptFile = (agentId: string) =>
      path.join(options.transcriptsDir, agentId, `${agentId}.jsonl`);

    const readTranscript = (agentId: string) =>
      fileSystem
        .readFileString(transcriptFile(agentId))
        .pipe(Effect.map(parseCursorTranscript), Effect.option);

    const findMatch = Effect.gen(function* () {
      const entries = yield* fileSystem
        .readDirectory(options.transcriptsDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const agentId of entries) {
        if (options.claimedAgentIds.has(agentId)) {
          continue;
        }
        const stat = yield* fileSystem.stat(transcriptFile(agentId)).pipe(Effect.option);
        if (Option.isNone(stat)) {
          continue;
        }
        const mtimeMillis = Option.match(stat.value.mtime, {
          onNone: () => undefined,
          onSome: (mtime) => mtime.getTime(),
        });
        if (
          mtimeMillis !== undefined &&
          mtimeMillis < options.launchedAtMillis - MATCH_MTIME_SLACK_MILLIS
        ) {
          continue;
        }
        const summary = yield* readTranscript(agentId);
        if (Option.isNone(summary)) {
          continue;
        }
        if (prompt.length > 0 && summary.value.firstUserText?.includes(prompt)) {
          options.claimedAgentIds.add(agentId);
          return agentId;
        }
      }
      return undefined;
    });

    let matchedAgentId: string | undefined;
    let lastProgressFingerprint = "";

    while (true) {
      if (matchedAgentId === undefined) {
        matchedAgentId = yield* findMatch;
        if (matchedAgentId === undefined) {
          const nowMillis = yield* Clock.currentTimeMillis;
          if (nowMillis - options.launchedAtMillis >= matchTimeoutMillis) {
            return { _tag: "MatchTimedOut" } as const;
          }
          yield* Effect.sleep(pollInterval);
          continue;
        }
      }

      const summary = yield* readTranscript(matchedAgentId);
      if (Option.isSome(summary)) {
        if (summary.value.ended !== undefined) {
          return {
            _tag: "Completed",
            agentId: matchedAgentId,
            status: summary.value.ended,
            finalText: summary.value.lastAssistantText,
          } as const;
        }
        const progress: CursorSubagentProgress = {
          ...(summary.value.lastAssistantText !== undefined
            ? { summary: truncateSubagentSummary(summary.value.lastAssistantText) }
            : {}),
          ...(summary.value.lastToolName !== undefined
            ? { lastToolName: summary.value.lastToolName }
            : {}),
        };
        const fingerprint = `${progress.summary ?? ""}\u0000${progress.lastToolName ?? ""}`;
        if (
          fingerprint !== lastProgressFingerprint &&
          (progress.summary || progress.lastToolName)
        ) {
          lastProgressFingerprint = fingerprint;
          yield* options.onProgress(progress);
        }
      }

      yield* Effect.sleep(pollInterval);
    }
  });
