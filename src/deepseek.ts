export interface ChatConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  thinking: boolean;
  reasoningEffort: "low" | "medium" | "high";
}

export interface StreamHandlers {
  onContent: (chunk: string) => void;
  onReasoning: (chunk: string) => void;
}

/**
 * Streams a single OpenAI-compatible chat completion, pushing deltas out as they arrive.
 * Deliberately stateless: one prompt in, one answer out, no conversation history.
 */
export async function streamChatCompletion(
  prompt: string,
  config: ChatConfig,
  signal: AbortSignal,
  handlers: StreamHandlers,
): Promise<void> {
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
      messages: [
        { role: "system", content: config.systemPrompt || "You are a helpful assistant." },
        { role: "user", content: prompt },
      ],
      ...(config.thinking ? { thinking: { type: "enabled" }, reasoning_effort: config.reasoningEffort || "high" } : {}),
      stream: true,
    }),
  });

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}\n${body.slice(0, 2000)}`.trim());
  }

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
    for (const event of events) consumeEvent(event, handlers);
  }

  consumeEvent(buffer, handlers);
}

function consumeEvent(event: string, handlers: StreamHandlers): void {
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;

    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;

    let parsed: {
      choices?: { delta?: { content?: string | null; reasoning_content?: string | null } }[];
      error?: { message?: string };
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue; // A truncated or non-JSON keep-alive line should not kill the stream.
    }

    if (parsed.error?.message) throw new Error(parsed.error.message);

    const delta = parsed.choices?.[0]?.delta;
    if (delta?.reasoning_content) handlers.onReasoning(delta.reasoning_content);
    if (delta?.content) handlers.onContent(delta.content);
  }
}
