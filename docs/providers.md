# Providers

claude-workforce reaches workers through routers. A router is a way to reach models: an API (type `http`), a program on your PATH (type `program`), or a command-line program described by data (type `cli`, see the last section). A route is one model reached through one router. All routing lives in `~/.claude/skills/lean-orchestrator/routing.json`. Each router names an env variable (`keyEnv`) and a signup URL. This project never writes a key value anywhere: you set the variable yourself. Everywhere below, `<your key>` is a placeholder.

Check what works on your machine:

```bash
node ~/.claude/skills/lean-orchestrator/tools/worker.mjs doctor
```

It prints one line per router: `READY`, `TOO OLD` (an OpenCode 1 binary), `NO KEY (<ENV>) -> <signup URL>`, or `NOT INSTALLED (<bin>)`, then the first route that can run for each kind.

| Router | Type | Key variable | Base URL or program |
|---|---|---|---|
| `nvidia` | http | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` |
| `openrouter` | http | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `cloudflare` | http | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`) | `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1` |
| `agy` | program | none | the `agy` CLI |
| `opencode` | program | none | OpenCode 2 (`opencode2`, then `opencode`) |
| `codex` | cli | none (sign in once with `codex login`) | the `codex` program (OpenAI Codex CLI) |
| `hermes` | cli | none (sign in once with `hermes model`) | the `hermes` program (Nous Hermes Agent) |
| `claude` | agents | none | your pinned Claude agents |

## NVIDIA NIM

- **What is free:** "1,000 free API credits" on signup, with a rate limit of about 40 requests per minute.
- **Signup:** https://build.nvidia.com ("Get API Key").
- **Env var:** `NVIDIA_API_KEY`.
- **Base URL:** `https://integrate.api.nvidia.com/v1` (OpenAI-compatible: answers `POST <baseUrl>/chat/completions`).
- **Model ids used in routing.json:** `z-ai/glm-5.3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `nvidia/nemotron-3-ultra-550b-a55b`.
- **Set the key:** Windows `setx NVIDIA_API_KEY "<your key>"`, then open a new terminal. macOS/Linux: add `export NVIDIA_API_KEY="<your key>"` to `~/.zshrc` or `~/.bashrc`, then open a new terminal.
- **Cold starts:** NVIDIA NIM often needs 5 to 10 minutes and 4 to 8 reconnects before it sends the first token. That is normal, not a broken key.
- **`patience`:** the `nvidia` router waits instead of failing at once. In `routing.json` it sets `{ "attempts": 8, "firstTokenSec": 300, "idleSec": 120, "backoffSec": [10, 20, 30], "totalSec": 1200 }`. Every field is in seconds except `attempts`:
  - `attempts`: tries per route (default 2).
  - `firstTokenSec`: how long the first stream event may take (default `--timeout`).
  - `idleSec`: longest allowed gap between events after the first (default 120).
  - `backoffSec`: waits between attempts; the last value repeats (default `WORKER_RETRY_DELAY_MS`).
  - `totalSec`: cap for the whole route, all attempts and waits included (default `--timeout`).

## OpenRouter

- **What is free:** `:free` model ids only. Models whose id ends in `:free` share 20 requests a minute and 50 a day; 1,000 a day once the account has bought 10 USD of credits (a one-time purchase). This is the cheapest upgrade in the whole setup. Source: https://openrouter.ai/docs/api-reference/limits. There is no free DeepSeek V4.1 Flash on OpenRouter.
- **Signup:** https://openrouter.ai/keys.
- **Env var:** `OPENROUTER_API_KEY`.
- **Base URL:** `https://openrouter.ai/api/v1`.
- **Model ids used in routing.json:** `nvidia/nemotron-3-ultra-550b-a55b:free`, `z-ai/glm-5.3-flash:free` (about 50 requests a day without credits), `nvidia/nemotron-3.5-super-vl:free` (Nemotron 3.5 Super VL), `cohere/north-mini-code:free` (North Mini Code), plus paid later routes `z-ai/glm-5.3-flash` and `deepseek/deepseek-v4.1-flash-1017`.

## Antigravity CLI (agy)

- **What is free:** "meaningful baseline quota that refreshes weekly alongside a weekly rate limit" ([plans page](https://antigravity.google/docs/plans)).
- **Signup / install:** Windows `irm https://antigravity.google/cli/install.ps1 | iex`. macOS and Linux: see https://antigravity.google.
- **Env var:** none. It is the `agy` program on your PATH.
- **How it is called:** headless, `agy -p "<prompt>"`: runs one prompt, prints the result to stdout, and exits immediately.
- **Model ids used in routing.json:** `gemini-3.8-flash`.
- **Notes:** it has web search and can read files, so it is the file-reading scout. Start-up takes about 20 seconds.

## OpenAI Codex CLI (`codex`)

- **Cost:** no API key. It uses the Codex allowance of your ChatGPT plan. OpenAI does not publish the limits, and which plans include the CLI can change.
- **Install:** `npm i -g @openai/codex`, then `codex login`.
- **Env var:** none. `CODEX_BIN` (optional) points at a specific binary.
- **How it is called:** `codex exec` with the brief on standard input. Scouts run with `-s read-only` and live web search on. Builders run with `-s workspace-write` and `-C` set to the worktree, so writes stay inside it. The operating system enforces the sandbox. On Windows the sandbox setting lives in your Codex config.
- **Model ids used in routing.json:** `gpt-6-luna` (alias `gpt-luna`).
- **Notes:** about 20 to 50 seconds per call. Measured: one of three write runs lost its tool host and wrote nothing; the worker's "no files changed" check turns that into a failed route.

## Nous Hermes Agent (`hermes`)

- **Cost:** the free models of Nous Portal, which rotate. The free tier allows 50 requests a minute.
- **Install:** install Hermes Agent, then run `hermes model` to sign in to Nous Portal.
- **Env var:** none. `HERMES_BIN` (optional) points at a specific binary.
- **How it is called:** `hermes chat --query-file <brief>` with `--oneshot` and `--provider nous`, using one harmless toolset (`todo`). It has no terminal and no file tools, so it is text-only and never writes. Files named with `--files` are packed into the prompt.
- **Model ids used in routing.json:** `meituan/longcat-2.5:free` (alias `longcat-free`). Nous announced it as free for one week from 2026-11-06, so it is a temporary offer. When the id stops answering, the route fails and the ladder moves on.
- **Notes:** measured 17 seconds for a small brief. Nous may keep prompts unless Privacy Mode is on.

## Cloudflare Workers AI

- **What is free:** "10,000 Neurons per day. Resets daily at 00:00 UTC."
- **Signup:** https://dash.cloudflare.com.
- **Env vars:** `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the account id goes into the base URL).
- **Base URL:** `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`.
- **Model ids used in routing.json:** `@cf/deepseek-ai/deepseek-v4.1-flash-1017`, `@cf/zai-org/glm-5.3-flash`. The GLM flash id is marked deprecating on 2026-11-20, so NVIDIA is tried first for GLM.

## OpenCode 2 (recommended)

- **What it is:** an open-source coding CLI (https://github.com/anomalyco/opencode) that runs agents on the providers you connect there. With OpenCode, DeepSeek and GLM read the project, edit files and run tests. Without it, an `http` route answers once from the files packed into the brief and writes only whole files.
- **Install:** `npm i -g @opencode/cli@latest`. This is OpenCode 2 (latest 2.2.7). It installs both `opencode` and `opencode2`; routing tries `opencode2` first, then `opencode`. Windows, macOS and Linux use the same npm package.
- **OpenCode 1 warning:** the package `opencode-ai` is OpenCode 1 (1.19.x). Its `run` has no `--standalone`, so every OpenCode route fails with it. Remove it with `npm rm -g opencode-ai`. `worker.mjs` checks `<bin> --version` and skips an OpenCode 1 binary with `too old (...; needs OpenCode 2: npm i -g @opencode/cli@latest)`; `doctor` prints `TOO OLD`.
- **Connect providers:** `opencode auth login` and pick NVIDIA, Cloudflare Workers AI or OpenRouter. `opencode auth list` shows what is connected. OpenCode stores the credential itself; this project never sees it.
- **Env var:** none. Set `OPENCODE_BIN` only to point at a specific binary, or `AGY_BIN` for agy.
- **OpenCode routes in routing.json:** DeepSeek: `cloudflare-workers-ai/@cf/deepseek-ai/deepseek-v4.1-flash-1017`, then `nvidia/deepseek-ai/deepseek-v4.1-flash`. GLM: `nvidia/z-ai/glm-5.3-flash`, then `cloudflare-workers-ai/@cf/zai-org/glm-5.3-flash`. After those, each model falls back to its direct API routes. Ids are namespaced by provider; `opencode models` lists yours. OpenCode 2.2.2 lists no free `openrouter/z-ai/glm-5.3-flash:free`, so no OpenCode route uses it.
- **Slow models:** a route may set `timeoutSec` (a positive number of seconds). For program routes it replaces `--timeout` for that route only. The OpenCode routes to NVIDIA DeepSeek and GLM use `timeoutSec: 1800` because NIM cold starts are slow.

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

## Command-line harnesses: the `cli` router type

A router with `"type": "cli"` runs a command-line program once per call; its fields are data, so a new program needs no code; `routers.codex` and `routers.hermes` in routing.json are the two real examples, so copy from them.

| Field | Meaning |
|---|---|
| `bin` | the program: one name or path, or a list tried in order. `${NAME}` is filled from the environment |
| `binEnv` | an environment variable that overrides `bin` |
| `args` | the arguments of a read-only run |
| `writeArgs` | the arguments of a run that may write. A router without `writeArgs` is read-only, and builder kinds skip it |
| `stdin` | `true`: the prompt is sent on standard input |
| `defaultEffort` | the default effort |
| `slots` | how many runs at once (default 1) |
| `fileAccess` | `false`: the program cannot see files. `--files` are packed into the prompt and the router never writes |
| `strip` | patterns removed from the answer |

| Placeholder | Filled with |
|---|---|
| `{id}` | the model id |
| `{effort}` | the effort |
| `{dir}` | the working folder |
| `{brief}` | the prompt text |
| `{briefFile}` | a temporary file holding the prompt |
| `{out}` | a temporary file the program writes its final answer to |

On Windows, an npm `.cmd` shim that starts a script with node is followed automatically.
