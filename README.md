# RayChat

Two Raycast commands over DeepSeek. **Ask Rafa** is a single question with a streamed answer and nothing else. **Rafa Agent** is the same model with tools: it searches the web, reads pages, searches this Mac and downloads files before answering.

![command icon](assets/command-icon.png)

## Ask Rafa

Type `Ask Rafa` in Raycast, type your question as the command argument, hit ⏎. The answer streams into a Detail view rendered as Markdown. If the model returns a reasoning trace, it shows while the model is still thinking and collapses away once the answer starts — press ⌘R to bring it back.

| Shortcut | Action |
| --- | --- |
| ⌘C | Copy answer |
| ⌘V | Paste answer into the frontmost app |
| ⌘R | Show / hide reasoning |
| ⇧⌘C | Copy reasoning |
| ⌘. | Stop generating |
| ⇧⌘, | Open extension preferences |

## Rafa Agent

Same entry point — `Rafa Agent <task>` — but the model is handed a set of tools and loops until it can answer. The view shows the investigation as it happens: each tool call as one line with its arguments and result, and the final answer below the trace.

| Tool | What it does |
| --- | --- |
| `web_search` | Tavily search, returns title + URL + extract. Only registered when a Tavily key is set. |
| `read_webpage` | Fetches a page as Markdown through `r.jina.ai`. |
| `search_files` | Spotlight (`mdfind`) file search, index and cache noise filtered out. |
| `search_in_files` | Content search via ripgrep, falling back to `grep`, returning `file:line` matches. |
| `read_local_file` | Reads a text file. Refuses binaries, oversized files and anything that looks like credentials. |
| `download_file` | Saves a URL to the download folder, 50 MB cap. |
| `get_context` | Selected text, clipboard and frontmost app — for tasks phrased as "this" or "that". |

The current date and time is injected into the system prompt instead of being a tool, which saves a round trip on every time-sensitive question.

### What it may touch

Everything the file tools read is confined to your home directory plus the download folder; paths outside are refused, as are files whose names suggest secrets (`.ssh`, `.aws`, `.env`, keychains, private keys). Every subprocess is invoked with an argument array rather than a shell, so a pattern containing quotes or semicolons stays data. There is no shell tool and nothing writes to disk except `download_file`.

`read_webpage` routes URLs through `r.jina.ai`, so the pages you open pass through a third party. Fine for public pages; do not point it at internal links carrying tokens.

### Notes from building it

- **Reasoning effort matters far more here than in Ask Rafa.** At `high`, a single round of tool use spent over a minute thinking, and long requests got their connection dropped mid-stream. At `medium` the same local-search task finished in 19 seconds. Hence the separate effort setting for this command, defaulting to medium.
- **Turning thinking off is worse than lowering effort.** Without it the model issued empty and repeated queries, and spilled raw tool-call markup into the answer.
- **Withholding tools on the last step is not enough to force an answer** — the model writes the call out as prose instead. It also has to be told the budget is spent. `stripToolMarkup` cuts anything that still leaks.
- Failed tool calls are returned to the model as ordinary results, so it can correct course; in testing it recovered from its own malformed call without the run dying.

## Setup

```bash
npm install
npm run dev
```

`npm run dev` builds the extension and installs it into your local Raycast. On first run Raycast asks for the preferences below.

## Preferences

| Preference | Default | Notes |
| --- | --- | --- |
| API Key | — | Required. Stored by Raycast locally; it is never written to this repository. |
| Model | `deepseek-v4-flash` | Any model id the endpoint accepts. |
| API Base URL | `https://api.deepseek.com` | Any OpenAI-compatible base URL — swap in a proxy or another provider. |
| System Prompt | see below | Sent on every request. |
| Thinking | on | Sends `thinking: { type: "enabled" }`. |
| Reasoning Effort | `high` | `low` / `medium` / `high`, only used when thinking is on. |

Rafa Agent adds four of its own, which override or extend the above for that command only:

| Preference | Default | Notes |
| --- | --- | --- |
| Tavily API Key | — | Enables `web_search`. Free key from [tavily.com](https://www.tavily.com). Without it the tool is not offered to the model at all, and the rest keep working. |
| Reasoning Effort | `medium` | Overrides the extension-wide setting for this command. |
| Max Steps | `6` | Tool-calling rounds before the model must answer with what it has. |
| Download Folder | `~/Downloads` | Where `download_file` saves. |

Get an API key from the [DeepSeek platform](https://platform.deepseek.com/api_keys).

### The default system prompt

A generic "you are a helpful assistant" misbehaves here in two specific ways: the command is single-turn, so a clarifying question from the model is a dead end, and the answer is read in a narrow panel, where an essay costs more than it gives. The default prompt closes both:

> You are answering a single question inside Raycast. There is no conversation history and no way for the user to reply, so never ask a clarifying question — pick the most reasonable reading and say in one line which one you picked if it matters. Answer in the language the question was asked in. Lead with the answer: no preamble, no restating the question, no offer of further help. Keep it as short as the question allows; a fact deserves a sentence, not an essay. Format as GitHub-flavored Markdown for a narrow column — short paragraphs, bullets over tables, fenced code blocks with a language tag, headings only when the answer has genuinely separate sections.

Measured against the generic prompt on the same questions: `tar 解压 tgz 的命令` went from 411 to 211 characters, `为什么 git rebase 会改 commit hash` from 1184 to 254, and a prompt missing its attachment stopped coming back as a question the user cannot answer. Edit the preference if you want a different voice.

## The request it makes

The extension is a thin wrapper over one streaming call:

```bash
curl https://api.deepseek.com/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -d '{
        "model": "deepseek-v4-flash",
        "messages": [
          {"role": "system", "content": "You are a helpful assistant."},
          {"role": "user", "content": "Hello!"}
        ],
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
        "stream": true
      }'
```

Server-sent events are parsed in `src/ask.tsx`; `delta.content` becomes the answer and `delta.reasoning_content` becomes the reasoning block.

## License

MIT
