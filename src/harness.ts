import { ChatConfig, ChatMessage, streamChatCompletion } from "./deepseek";
import { Tool, toSchemas } from "./tools";

export type TimelineItem =
  | { type: "say"; text: string }
  | { type: "tool"; name: string; args: string; status: "running" | "ok" | "error"; detail?: string };

export const AGENT_SYSTEM_PROMPT =
  "You are a research assistant running inside Raycast, with tools that reach the live web and this Mac. " +
  "There is no conversation history and no way for the user to reply, so never ask a clarifying question — " +
  "pick the most reasonable reading, use your tools to check it, and say in one line what you assumed.\n\n" +
  "Use the tools rather than your memory for anything that could have changed since training: versions, " +
  "prices, releases, news, documentation, or anything on this machine. When you search, the extracts are " +
  "usually too thin to answer from — open the promising results with read_webpage before concluding. Two or " +
  "three focused tool calls beat one broad one.\n\n" +
  "When you have what you need, stop calling tools and answer. Answer in the language the question was asked " +
  "in. Lead with the answer, keep it as short as the question allows, and cite the URLs you actually read as " +
  "Markdown links. If the tools could not settle it, say what you found and what remains unknown rather than " +
  "filling the gap from memory.";

const OUT_OF_BUDGET =
  "You have used your tool budget for this task — no further tool calls are possible. Answer now with what you " +
  "already found, and say plainly which parts you could not verify.";

/**
 * A model that wants a tool it cannot have sometimes writes the call out as
 * prose instead. That markup is never part of an answer, so it is cut here
 * rather than shown to the user.
 */
export function stripToolMarkup(text: string): string {
  const start = text.search(/<[｜|]{1,2}\s*(DSML|tool_calls|tool▁)/);
  return start === -1 ? text : text.slice(0, start).trimEnd();
}

export interface AgentOptions {
  task: string;
  config: ChatConfig;
  tools: Tool[];
  maxSteps: number;
  signal: AbortSignal;
  /** Called after every mutation so the view can re-render the trace. */
  onUpdate: (timeline: TimelineItem[]) => void;
  onReasoning?: (chunk: string) => void;
}

/**
 * Runs the tool-calling loop until the model answers without asking for a tool,
 * or until maxSteps is reached — at which point it is asked to answer with what
 * it already has rather than being cut off mid-investigation.
 */
export async function runAgent(options: AgentOptions): Promise<void> {
  const { task, config, tools, maxSteps, signal, onUpdate } = options;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  const messages: ChatMessage[] = [
    { role: "system", content: `${AGENT_SYSTEM_PROMPT}\n\nCurrent date and time: ${now()}.` },
    { role: "user", content: task },
  ];

  const timeline: TimelineItem[] = [];
  const flush = () => onUpdate([...timeline]);

  for (let step = 0; step < maxSteps; step++) {
    const isLastStep = step === maxSteps - 1;
    let current: { type: "say"; text: string } | undefined;
    let raw = "";

    // Withholding the tools alone is not enough: the model still tries to call
    // them and, with no schema to put them in, spills the raw call markup into
    // the answer. Saying the budget is spent is what actually redirects it.
    if (isLastStep) messages.push({ role: "user", content: OUT_OF_BUDGET });

    const call = () =>
      streamChatCompletion({
        messages,
        config,
        signal,
        tools: isLastStep ? undefined : toSchemas(tools),
        onReasoning: options.onReasoning,
        onContent: (chunk) => {
          if (!current) {
            current = { type: "say", text: "" };
            timeline.push(current);
            raw = "";
          }
          raw += chunk;
          current.text = stripToolMarkup(raw);
          flush();
        },
      });

    let result;
    try {
      result = await call();
    } catch (error) {
      // A long think can outlive the connection. Retrying is only safe while
      // nothing has been shown yet, otherwise the answer would be duplicated.
      if (signal.aborted || current || !isTransient(error)) throw error;
      result = await call();
    }

    if (result.toolCalls.length === 0) return;

    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });

    // Independent calls, so they run together; the trace keeps the model's order.
    const entries = result.toolCalls.map((call) => {
      const entry: TimelineItem = {
        type: "tool",
        name: call.function.name,
        args: call.function.arguments,
        status: "running",
      };
      timeline.push(entry);
      return { call, entry };
    });
    flush();

    await Promise.all(
      entries.map(async ({ call, entry }) => {
        if (entry.type !== "tool") return;
        const outcome = await invoke(byName.get(call.function.name), call.function.arguments);
        entry.status = outcome.ok ? "ok" : "error";
        entry.detail = outcome.summary;
        messages.push({ role: "tool", tool_call_id: call.id, content: outcome.text });
        flush();
      }),
    );
  }
}

async function invoke(
  tool: Tool | undefined,
  rawArguments: string,
): Promise<{ ok: boolean; text: string; summary: string }> {
  if (!tool) return { ok: false, text: "No such tool.", summary: "unknown tool" };

  let args: Record<string, unknown>;
  try {
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return { ok: false, text: `Arguments were not valid JSON: ${rawArguments}`, summary: "bad arguments" };
  }

  try {
    const result = await tool.run(args);
    return { ok: true, text: result.text, summary: result.summary };
  } catch (error) {
    // The failure goes back to the model as a tool result, so it can adjust and
    // retry instead of the whole run dying on one bad path.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, text: `Tool failed: ${message}`, summary: message.slice(0, 80) };
  }
}

/** Connection-level failures, as opposed to anything the server actually said. */
function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${error.cause ?? ""}` : String(error);
  return /terminated|fetch failed|ECONNRESET|socket hang up|network|EPIPE/i.test(message);
}

function now(): string {
  const date = new Date();
  return `${date.toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })} (${
    Intl.DateTimeFormat().resolvedOptions().timeZone
  })`;
}
