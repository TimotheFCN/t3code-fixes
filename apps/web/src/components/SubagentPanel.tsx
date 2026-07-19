import { memo, useState } from "react";
import type {
  SubagentTask,
  SubagentTaskProgressEntry,
} from "@t3tools/client-runtime/state/subagent-tasks";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  LoaderIcon,
  XIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { formatTimestamp } from "../timestampFormat";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";

function taskStatusIcon(status: SubagentTask["status"]): React.ReactNode {
  switch (status) {
    case "running":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <LoaderIcon className="size-3 animate-spin" />
        </span>
      );
    case "completed":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
          <CheckIcon className="size-3" />
        </span>
      );
    case "failed":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <XIcon className="size-3" />
        </span>
      );
    case "stopped":
      return (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-muted-foreground/60">
          <CircleSlashIcon className="size-3" />
        </span>
      );
  }
}

function taskStatusLabel(status: SubagentTask["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

function ProgressEntry({
  entry,
  timestampFormat,
}: {
  entry: SubagentTaskProgressEntry;
  timestampFormat: TimestampFormat;
}) {
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="mt-1.75 size-1 shrink-0 rounded-full bg-muted-foreground/30" />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] leading-snug break-words whitespace-pre-wrap text-muted-foreground/80">
          {entry.summary ?? (entry.lastToolName ? `Used ${entry.lastToolName}` : "Working…")}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground/40 tabular-nums">
          {formatTimestamp(entry.createdAt, timestampFormat)}
          {entry.summary && entry.lastToolName ? ` · ${entry.lastToolName}` : null}
        </p>
      </div>
    </div>
  );
}

function SubagentTaskRow({
  task,
  timestampFormat,
}: {
  task: SubagentTask;
  timestampFormat: TimestampFormat;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = task.progress.length > 0 || task.latestSummary !== undefined;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/50 bg-background/50",
        task.status === "running" && "border-primary/20 bg-primary/2",
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
        onClick={() => setExpanded((value) => !value)}
        disabled={!hasDetail}
      >
        {taskStatusIcon(task.status)}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-snug text-foreground/90">{task.description}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/50">
            {taskStatusLabel(task.status)}
            {task.taskType ? ` · ${task.taskType}` : null}
            {task.background ? " · background" : null}
            {" · "}
            <span className="tabular-nums">
              {formatTimestamp(task.completedAt ?? task.startedAt, timestampFormat)}
            </span>
          </p>
        </div>
        {hasDetail ? (
          expanded ? (
            <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground/40" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/40" />
          )
        ) : null}
      </button>
      {expanded ? (
        <div className="border-t border-border/40 px-2.5 py-2">
          {task.progress.length > 0 ? (
            <div className="mb-2">
              <p className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Progress
              </p>
              {task.progress.map((entry) => (
                <ProgressEntry
                  key={entry.activityId}
                  entry={entry}
                  timestampFormat={timestampFormat}
                />
              ))}
            </div>
          ) : null}
          {task.latestSummary !== undefined ? (
            <div>
              <p className="mb-1 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                {task.status === "running" ? "Latest update" : "Result"}
              </p>
              <p className="text-[12px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground/80">
                {task.latestSummary}
              </p>
            </div>
          ) : null}
          {task.agentId ? (
            <p className="mt-2 text-[10px] text-muted-foreground/40">
              Agent ID: <span className="font-mono">{task.agentId}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface SubagentPanelProps {
  tasks: ReadonlyArray<SubagentTask>;
  timestampFormat: TimestampFormat;
  mode?: "sheet" | "sidebar" | "embedded";
}

const SubagentPanel = memo(function SubagentPanel({
  tasks,
  timestampFormat,
  mode = "sidebar",
}: SubagentPanelProps) {
  const running = tasks.filter((task) => task.status === "running");
  const settled = tasks.filter((task) => task.status !== "running");

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-card/50",
        mode === "sidebar"
          ? "h-full w-[340px] shrink-0 border-l border-border/70"
          : "h-full w-full",
      )}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="flex items-center gap-2">
          <Badge
            variant="info"
            size="sm"
            className="rounded-md px-1.5 py-0 font-semibold tracking-wide uppercase"
          >
            Subagents
          </Badge>
          {running.length > 0 ? (
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">
              {running.length} running
            </span>
          ) : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          {running.length > 0 ? (
            <div className="space-y-1.5">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Running
              </p>
              {running.map((task) => (
                <SubagentTaskRow key={task.taskId} task={task} timestampFormat={timestampFormat} />
              ))}
            </div>
          ) : null}

          {settled.length > 0 ? (
            <div className="space-y-1.5">
              <p className="mb-2 text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
                Finished
              </p>
              {settled.map((task) => (
                <SubagentTaskRow key={task.taskId} task={task} timestampFormat={timestampFormat} />
              ))}
            </div>
          ) : null}

          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">No subagent tasks yet.</p>
              <p className="mt-1 text-[11px] text-muted-foreground/30">
                Subagents launched by the agent will appear here.
              </p>
            </div>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
});

export default SubagentPanel;
export type { SubagentPanelProps };
