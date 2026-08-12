# RayChat

A deliberately small Raycast extension: ask DeepSeek one question from the Raycast search bar and read the streamed answer. No chat history, no follow-ups — one question, one answer.

![command icon](assets/command-icon.png)

## What it does

Type `Ask Rafa` in Raycast, type your question as the command argument, hit ⏎. The answer streams into a Detail view rendered as Markdown. If the model returns a reasoning trace, it shows while the model is still thinking and collapses away once the answer starts — press ⌘R to bring it back.

| Shortcut | Action |
| --- | --- |
| ⌘C | Copy answer |
| ⌘V | Paste answer into the frontmost app |
| ⌘R | Show / hide reasoning |
| ⇧⌘C | Copy reasoning |
| ⌘. | Stop generating |
| ⇧⌘, | Open extension preferences |

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
