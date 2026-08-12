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
| System Prompt | `You are a helpful assistant.` | Sent on every request. |
| Thinking | on | Sends `thinking: { type: "enabled" }`. |
| Reasoning Effort | `high` | `low` / `medium` / `high`, only used when thinking is on. |

Get an API key from the [DeepSeek platform](https://platform.deepseek.com/api_keys).

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
