// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";

import {
  cursorAgentTranscriptsDir,
  cursorProjectSlug,
  parseCursorTranscript,
  truncateSubagentSummary,
  watchCursorSubagentTask,
  type CursorSubagentProgress,
} from "./CursorSubagentTranscripts.ts";

describe("cursorProjectSlug", () => {
  it("maps a cwd to the Cursor projects directory slug", () => {
    expect(cursorProjectSlug("/tmp/acp-probe/workdir")).toBe("tmp-acp-probe-workdir");
    expect(cursorProjectSlug("/root/Repos/t3code")).toBe("root-Repos-t3code");
    expect(cursorProjectSlug("/root")).toBe("root");
  });
});

describe("parseCursorTranscript", () => {
  const lines = [
    JSON.stringify({
      role: "user",
      message: {
        content: [{ type: "text", text: "<user_query>\nCount the files.\n</user_query>" }],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Counting now." },
          { type: "tool_use", name: "Shell", input: { command: "ls | wc -l" } },
        ],
      },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: "There are 42 files." }] },
    }),
  ];

  it("extracts first user text, latest assistant text, and last tool name", () => {
    const summary = parseCursorTranscript(lines.join("\n"));
    expect(summary.firstUserText).toContain("Count the files.");
    expect(summary.lastAssistantText).toBe("There are 42 files.");
    expect(summary.lastToolName).toBe("Shell");
    expect(summary.ended).toBeUndefined();
  });

  it("maps turn_ended statuses and tolerates partially written trailing lines", () => {
    const success = parseCursorTranscript(
      [...lines, JSON.stringify({ type: "turn_ended", status: "success" }), '{"role":"assis'].join(
        "\n",
      ),
    );
    expect(success.ended).toBe("completed");

    const aborted = parseCursorTranscript(
      JSON.stringify({ type: "turn_ended", status: "aborted" }),
    );
    expect(aborted.ended).toBe("stopped");

    const errored = parseCursorTranscript(JSON.stringify({ type: "turn_ended", status: "error" }));
    expect(errored.ended).toBe("failed");
  });
});

describe("truncateSubagentSummary", () => {
  it("keeps short summaries and truncates long ones", () => {
    expect(truncateSubagentSummary("  done  ")).toBe("done");
    const long = "x".repeat(3000);
    expect(truncateSubagentSummary(long).length).toBeLessThanOrEqual(2001);
  });
});

describe("watchCursorSubagentTask", () => {
  const writeTranscript = (transcriptsDir: string, agentId: string, content: string) =>
    Effect.promise(async () => {
      const dir = NodePath.join(transcriptsDir, agentId);
      await NodeFSP.mkdir(dir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(dir, `${agentId}.jsonl`), content, "utf8");
    });

  const userLine = (text: string) =>
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }] },
    });
  const assistantLine = (text: string) =>
    JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });

  it.live("matches the transcript by prompt, reports progress, and completes", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-subagent-watch-")),
      );
      const transcriptsDir = NodePath.join(home, "agent-transcripts");
      const progress: Array<CursorSubagentProgress> = [];
      const claimed = new Set<string>();

      const watcherFiber = yield* watchCursorSubagentTask({
        transcriptsDir,
        prompt: "Count the files in the repo.",
        launchedAtMillis: yield* Clock.currentTimeMillis,
        claimedAgentIds: claimed,
        pollInterval: "20 millis",
        matchTimeout: "10 seconds",
        onProgress: (entry) => Effect.sync(() => progress.push(entry)),
      }).pipe(Effect.forkChild);

      // An unrelated transcript must never be claimed.
      yield* writeTranscript(
        transcriptsDir,
        "agent-other",
        [userLine("Do something else."), assistantLine("ok")].join("\n"),
      );
      yield* writeTranscript(
        transcriptsDir,
        "agent-match",
        [userLine("Count the files in the repo."), assistantLine("Counting…")].join("\n"),
      );

      while (progress.length === 0) {
        yield* Effect.sleep("10 millis");
      }

      yield* writeTranscript(
        transcriptsDir,
        "agent-match",
        [
          userLine("Count the files in the repo."),
          assistantLine("Counting…"),
          assistantLine("There are 42 files."),
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ type: "turn_ended", status: "success" }),
        ].join("\n"),
      );

      const result = yield* Fiber.join(watcherFiber);
      assert.equal(result._tag, "Completed");
      if (result._tag === "Completed") {
        assert.equal(result.agentId, "agent-match");
        assert.equal(result.status, "completed");
        assert.equal(result.finalText, "There are 42 files.");
      }
      assert.isTrue(claimed.has("agent-match"));
      assert.isFalse(claimed.has("agent-other"));
      assert.isAtLeast(progress.length, 1);
      assert.equal(progress[0]?.summary, "Counting…");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("times out when no transcript ever matches", () =>
    Effect.gen(function* () {
      const home = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cursor-subagent-watch-timeout-")),
      );
      const result = yield* watchCursorSubagentTask({
        transcriptsDir: NodePath.join(home, "agent-transcripts"),
        prompt: "Never matched prompt.",
        launchedAtMillis: yield* Clock.currentTimeMillis,
        claimedAgentIds: new Set(),
        pollInterval: "10 millis",
        matchTimeout: "50 millis",
        onProgress: () => Effect.void,
      });
      assert.equal(result._tag, "MatchTimedOut");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("builds the transcripts dir from home and cwd", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = cursorAgentTranscriptsDir({
        homeDir: "/home/me",
        cwd: "/tmp/acp-probe/workdir",
        path,
      });
      assert.equal(dir, "/home/me/.cursor/projects/tmp-acp-probe-workdir/agent-transcripts");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
