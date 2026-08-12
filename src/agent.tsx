import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Icon,
  Keyboard,
  LaunchProps,
  getFrontmostApplication,
  getPreferenceValues,
  getSelectedText,
  openExtensionPreferences,
} from "@raycast/api";
import { homedir } from "os";
import path from "path";
import { useEffect, useRef, useState } from "react";
import { ChatConfig } from "./deepseek";
import { TimelineItem, runAgent } from "./harness";
import { createTools } from "./tools";

interface Preferences extends ChatConfig {
  tavilyApiKey?: string;
  agentReasoningEffort?: "low" | "medium" | "high";
  maxSteps: string;
  downloadDir: string;
}

interface Arguments {
  task: string;
}

export default function Agent(props: LaunchProps<{ arguments: Arguments }>) {
  const task = props.arguments.task.trim();
  const preferences = getPreferenceValues<Preferences>();

  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  const [showReasoning, setShowReasoning] = useState(false);

  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    const tools = createTools({
      tavilyApiKey: preferences.tavilyApiKey?.trim() || undefined,
      downloadDir: expandHome(preferences.downloadDir || "~/Downloads"),
      root: homedir(),
      readSelection: () => getSelectedText().catch(() => null),
      readClipboard: async () => (await Clipboard.readText()) ?? null,
      readFrontmostApp: async () => (await getFrontmostApplication()).name,
    });

    runAgent({
      task,
      // A tool loop at high effort spends over a minute per round, so this
      // command carries its own effort setting instead of inheriting.
      config: { ...preferences, reasoningEffort: preferences.agentReasoningEffort || "medium" },
      tools,
      maxSteps: Number(preferences.maxSteps) || 6,
      signal: controller.signal,
      onUpdate: setTimeline,
      onReasoning: (chunk) => setReasoning((current) => current + chunk),
    })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [task]);

  const answer = [...timeline].reverse().find((item) => item.type === "say");

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={task.length > 48 ? `${task.slice(0, 48)}…` : task}
      markdown={render({ task, timeline, reasoning, showReasoning, error, isLoading })}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Answer" content={answer?.type === "say" ? answer.text : ""} />
          <Action.Paste title="Paste Answer" content={answer?.type === "say" ? answer.text : ""} />
          {reasoning.length > 0 && (
            <Action
              title={showReasoning ? "Hide Reasoning" : "Show Reasoning"}
              icon={showReasoning ? Icon.EyeDisabled : Icon.Eye}
              // Common.Refresh is ⌘R — read it here as R for Reasoning.
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => setShowReasoning(!showReasoning)}
            />
          )}
          {isLoading && (
            <Action
              title="Stop"
              icon={Icon.Stop}
              // Common.Pin happens to be ⌘., the conventional "cancel" chord.
              shortcut={Keyboard.Shortcut.Common.Pin}
              onAction={() => {
                abortRef.current?.abort();
                setIsLoading(false);
              }}
            />
          )}
          <Action
            title="Open Extension Preferences"
            icon={Icon.Gear}
            shortcut={{ modifiers: ["cmd", "shift"], key: "," }}
            onAction={openExtensionPreferences}
          />
        </ActionPanel>
      }
    />
  );
}

function render(state: {
  task: string;
  timeline: TimelineItem[];
  reasoning: string;
  showReasoning: boolean;
  error?: string;
  isLoading: boolean;
}): string {
  const blocks: string[] = [quote(state.task)];

  if (state.reasoning.length > 0 && state.showReasoning) {
    blocks.push(`### 💭 Reasoning\n\n${quote(state.reasoning)}`);
  }

  // Everything before the last narration is the investigation; render it as a
  // compact trace so the answer itself stays the thing you read.
  const lastSay = state.timeline.map((item) => item.type === "say").lastIndexOf(true);
  const trace = state.timeline.slice(0, lastSay === -1 ? undefined : lastSay);
  const answer = lastSay === -1 ? undefined : state.timeline[lastSay];

  if (trace.length > 0) blocks.push(trace.map(renderItem).join("\n\n"));

  if (state.error) {
    blocks.push(`### ⚠️ Run failed\n\n\`\`\`\n${state.error}\n\`\`\``);
  } else if (answer?.type === "say" && answer.text.trim()) {
    blocks.push(answer.text);
  } else if (state.isLoading && state.timeline.length === 0) {
    blocks.push("_Thinking…_");
  }

  return blocks.join("\n\n---\n\n");
}

function renderItem(item: TimelineItem): string {
  if (item.type === "say") return item.text;

  const icon = item.status === "running" ? "⏳" : item.status === "ok" ? "✅" : "❌";
  const args = compactArgs(item.args);
  const detail = item.detail ? ` — ${item.detail}` : "";
  return `${icon} \`${item.name}\`${args ? ` ${args}` : ""}${detail}`;
}

/** Tool arguments are for glancing at, so show the values without the JSON scaffolding. */
function compactArgs(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const values = Object.values(parsed)
      .map((value) => String(value))
      .filter(Boolean);
    if (values.length === 0) return "";
    const joined = values.join(" · ");
    return `**${joined.length > 90 ? `${joined.slice(0, 90)}…` : joined}**`;
  } catch {
    return "";
  }
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function expandHome(input: string): string {
  return input.startsWith("~") ? path.join(homedir(), input.slice(1)) : input;
}
