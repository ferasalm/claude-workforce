# Providers

claude-workforce reaches workers through routers. A router is a way to reach models: an API (type `http`) or a program on your PATH. A route is one model reached through one router. All routing lives in `~/.claude/skills/lean-orchestrator/routing.json`. Each router names an env variable (`keyEnv`) and a signup URL. This project never writes a key value anywhere: you set the variable yourself. Everywhere below, `<your key>` is a placeholder.

Check what works on your machine:

```bash
node ~/.claude/skills/lean-orchestrator/tools/worker.mjs doctor
```

It prints one line per router: `READY`, `NO KEY (<ENV>) -> <signup URL>`, or `NOT INSTALLED (<bin>)`, then the first route that can run for each kind.

| Router | Type | Key variable | Base URL or program |
|---|---|---|---|
| `nvidia` | http | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` |
| `openrouter` | http | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `cloudflare` | http | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` |
| `agy` | program | none | the `agy` CLI |
| `opencode` | program | none | the `opencode` CLI |
| `claude` | agents | none | your pinned Claude agents |

## NVIDIA NIM

- **What is free:** "1,000 free API credits" on signup, with a rate limit of about 40 requests per minute.
- **Signup:** https://build.nvidia.com ("Get API Key").
- **Env var:** `NVIDIA_API_KEY`.
- **Base URL:** `https://integrate.api.nvidia.com/v1` (OpenAI-compatible: answers `POST <baseUrl>/chat/completions`).
- **Model ids used in routing.json:** `z-ai/glm-5.3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`.
- **Set the key:** Windows `setx NVIDIA_API_KEY "<your key>"`, then open a new terminal. macOS/Linux: add `export NVIDIA_API_KEY="<your key>"` to `~/.zshrc` or `~/.bashrc`, then open a new terminal.

## OpenRouter

- **What is free:** `:free` model ids only. 50 requests/day for accounts that bought less than $10 of credits; 1,000/day with $10 or more. There is no free DeepSeek V4.1 Flash on OpenRouter.
- **Signup:** https://openrouter.ai/keys.
- **Env var:** `OPENROUTER_API_KEY`.
- **Base URL:** `https://openrouter.ai/api/v1`.
- **Model ids used in routing.json:** `nvidia/nemotron-3-ultra-550b-a55b:free`, `z-ai/glm-5.3-flash:free` (about 50 requests a day without credits), plus paid later routes `z-ai/glm-5.3-flash` and `deepseek/deepseek-v4.1-flash-1017`.

## Antigravity CLI (agy)

- **What is free:** "meaningful baseline quota that refreshes weekly alongside a weekly rate limit" ([plans page](https://antigravity.google/docs/plans)).
- **Signup / install:** Windows `irm https://antigravity.google/cli/install.ps1 | iex`. macOS and Linux: see https://antigravity.google.
- **Env var:** none. It is the `agy` program on your PATH.
- **How it is called:** headless, `agy -p "<prompt>"`: runs one prompt, prints the result to stdout, and exits immediately.
- **Model ids used in routing.json:** `gemini-3.8-flash`.
- **Notes:** it has web search and can read files, so it is the file-reading scout. Start-up takes about 20 seconds.

## Cloudflare Workers AI

- **What is free:** "10,000 Neurons per day. Resets daily at 00:00 UTC."
- **Signup:** https://dash.cloudflare.com.
- **Env vars:** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account id goes into the base URL).
- **Base URL:** `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`.
- **Model ids used in routing.json:** `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, `@cf/zai-org/glm-5.3-flash`. The GLM flash id is marked deprecating on 2026-11-20, so NVIDIA is tried first for GLM.

## OpenCode (optional)

- **What it is:** an open-source coding CLI (https://github.com/anomalyco/opencode) that runs agents on whatever providers you configure there. Optional in claude-workforce: it adds file-reading agents on API models. Cost: routing.json marks it "uses your OpenCode providers", so it costs what those providers charge.
- **Install:** macOS/Linux `curl -fsSL https://opencode.ai/install | bash`. Windows: `npm i -g @opencode/cli@latest` or `scoop install opencode`.
- **Env var:** none. Providers are configured in `opencode.json` or with `/connect`.
- **Model ids:** whatever your OpenCode providers expose; `routing.json` has no fixed ids for it.

## Add any other OpenAI-compatible provider

You never hand a key to this project. Two ways to add a provider:

**Ask Claude Code.** Say: "add my \<provider\> API key as a worker route". The `workforce-setup` skill adds the router to `routing.json`, tells you the variable name and the signup URL, and stops there.

**Or edit `~/.claude/skills/lean-orchestrator/routing.json` yourself.** Add a router under `routers`:

```json
"myprovider": {
  "type": "http",
  "baseUrl": "https://example.com/v1",
  "keyEnv": "MYPROVIDER_API_KEY",
  "signup": "https://example.com/keys",
  "free": true
}
```

`baseUrl` must be OpenAI-compatible: it answers `POST <baseUrl>/chat/completions`. Then add a model with one or more routes, free ones first:

```json
"my-model": {
  "family": "myprovider",
  "good_at": "what it is good at",
  "weak_at": "what it is weak at",
  "routes": [
    { "router": "myprovider", "id": "<model id from the provider's list>" }
  ]
}
```

and add `{ "model": "my-model" }` to the `picks` of the kinds it can serve.

Set the key yourself: Windows `setx MYPROVIDER_API_KEY "<your key>"`, then open a new terminal. macOS/Linux: add `export MYPROVIDER_API_KEY="<your key>"` to `~/.zshrc` or `~/.bashrc`, then open a new terminal (a running process keeps the environment it started with).

Then run `doctor` again; the router should print `READY`. Smoke test with one cheap call: write a one-line brief to a file and run

```bash
node ~/.claude/skills/lean-orchestrator/tools/worker.mjs ask my-model brief.txt --router myprovider
```

An HTTP 400 or 404 usually means the model id is wrong: look up the exact id in the provider's model list, fix `id` in `routing.json`, and run it again. Add a line to the `changelog` in `routing.json` for your edit.

Never paste a real key into a file, a chat or a screenshot: everything above uses `<your key>` as the placeholder.
