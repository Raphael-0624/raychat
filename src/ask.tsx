import {
  Action,
  ActionPanel,
  Detail,
  Icon,
  Keyboard,
  LaunchProps,
  getPreferenceValues,
  openExtensionPreferences,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { ChatConfig, streamChatCompletion } from "./deepseek";

interface Arguments {
  prompt: string;
}

/** One question in, one answer out. No history, no follow-ups. */
export default function Ask(props: LaunchProps<{ arguments: Arguments }>) {
  const prompt = props.arguments.prompt.trim();
  const preferences = getPreferenceValues<ChatConfig>();

  const [answer, setAnswer] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(true);
  // null means "follow the stream": reasoning stays visible until the answer starts.
  const [pinnedReasoning, setPinnedReasoning] = useState<boolean | null>(null);

  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    streamChatCompletion(prompt, preferences, controller.signal, {
      onContent: (chunk) => setAnswer((current) => current + chunk),
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
  }, [prompt]);

  const showReasoning = pinnedReasoning ?? (reasoning.length > 0 && answer.length === 0);

  return (
    <Detail
      isLoading={isLoading}
      navigationTitle={prompt.length > 48 ? `${prompt.slice(0, 48)}…` : prompt}
      markdown={render({ prompt, answer, reasoning, showReasoning, error, isLoading })}
      actions={
        <ActionPanel>
          <Action.CopyToClipboard title="Copy Answer" content={answer} />
          <Action.Paste title="Paste Answer" content={answer} />
          {reasoning.length > 0 && (
            <Action
              title={showReasoning ? "Hide Reasoning" : "Show Reasoning"}
              icon={showReasoning ? Icon.EyeDisabled : Icon.Eye}
              // Common.Refresh is ⌘R — read it here as R for Reasoning.
              shortcut={Keyboard.Shortcut.Common.Refresh}
              onAction={() => setPinnedReasoning(!showReasoning)}
            />
          )}
          {reasoning.length > 0 && (
            <Action.CopyToClipboard
              title="Copy Reasoning"
              content={reasoning}
              shortcut={Keyboard.Shortcut.Common.Copy}
            />
          )}
          {isLoading && (
            <Action
              title="Stop Generating"
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
  prompt: string;
  answer: string;
  reasoning: string;
  showReasoning: boolean;
  error?: string;
  isLoading: boolean;
}): string {
  const blocks: string[] = [quote(state.prompt)];

  if (state.reasoning.length > 0) {
    blocks.push(state.showReasoning ? `### 💭 Reasoning\n\n${quote(state.reasoning)}` : `💭 _Reasoning hidden — ⌘R_`);
  }

  if (state.error) {
    blocks.push(`### ⚠️ Request failed\n\n\`\`\`\n${state.error}\n\`\`\``);
  } else if (state.answer.length > 0) {
    blocks.push(state.answer);
  } else if (state.isLoading && state.reasoning.length === 0) {
    blocks.push("_Thinking…_");
  }

  return blocks.join("\n\n---\n\n");
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
