export interface ChatConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

/**
 * Used when the System Prompt preference is left empty. Kept in sync with the
 * `systemPrompt` default in package.json, which is what a fresh install gets.
 */
export const DEFAULT_SYSTEM_PROMPT =
  "You are answering a single question inside Raycast. There is no conversation history and no way for the " +
  "user to reply, so never ask a clarifying question — pick the most reasonable reading and say in one line " +
  "which one you picked if it matters. Answer in the language the question was asked in. Lead with the answer: " +
  "no preamble, no restating the question, no offer of further help. Keep it as short as the question allows; " +
  "a fact deserves a sentence, not an essay. Format as GitHub-flavored Markdown for a narrow column — short " +
  "paragraphs, bullets over tables, fenced code blocks with a language tag, headings only when the answer has " +
  "genuinely separate sections.";

/**
 * Streams one OpenAI-compatible chat completion, pushing deltas out as they arrive
 * and returning everything the caller needs to decide what happens next.
 */
export async function streamChatCompletion(options: {
  messages: ChatMessage[];
  config: ChatConfig;
  signal: AbortSignal;
  tools?: ToolSchema[];
  onContent?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
}): Promise<StreamResult> {
  const { messages, config, signal, tools } = options;
  const baseUrl = (config.baseUrl || "https://api.deepseek.com").replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "deepseek-v4-flash",
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(config.thinking ? { thinking: { type: "enabled" }, reasoning_effort: config.reasoningEffort || "high" } : {}),
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}\n${body.slice(0, 2000)}`.trim());
  }

  const result: StreamResult = { content: "", reasoning: "", toolCalls: [], finishReason: null };
  // Tool calls stream in fragments keyed by index: the first chunk carries id and
  // name, later chunks append raw JSON to arguments one token at a time.
  const partialCalls = new Map<number, ToolCall>();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line; keep the trailing partial event buffered.
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) consumeEvent(event, result, partialCalls, options);
  }
  consumeEvent(buffer, result, partialCalls, options);

  result.toolCalls = [...partialCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  return result;
}

function consumeEvent(
  event: string,
  result: StreamResult,
  partialCalls: Map<number, ToolCall>,
  handlers: { onContent?: (chunk: string) => void; onReasoning?: (chunk: string) => void },
): void {
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;

    let parsed: {
      choices?: {
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          reasoning_content?: string | null;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }[];
        };
      }[];
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue; // A truncated or non-JSON keep-alive line should not kill the stream.
    }

    if (parsed.error?.message) throw new Error(parsed.error.message);

    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) result.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (delta?.reasoning_content) {
      result.reasoning += delta.reasoning_content;
      handlers.onReasoning?.(delta.reasoning_content);
    }
    if (delta?.content) {
      result.content += delta.content;
      handlers.onContent?.(delta.content);
    }

    for (const fragment of delta?.tool_calls ?? []) {
      const call = partialCalls.get(fragment.index) ?? {
        id: "",
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function.name = fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      partialCalls.set(fragment.index, call);
    }
  }
}
