---
name: workforce-setup
description: Set up and check the worker routes of the claude-workforce skills. Use when the user asks to set up the workforce, check which workers work, add a provider, API key or aggregator (OpenRouter, NVIDIA, Cloudflare, Antigravity, OpenCode), change which model serves a kind of work, or when a worker run failed with "NO KEY" or "NOT INSTALLED". Not needed for normal work.
---

# Workforce setup

The lead gives work to cheaper models called workers. Which model serves which kind of work is decided in one file, `{{SKILLS_DIR}}/lean-orchestrator/routing.json`. A router is a way to reach models (an API such as OpenRouter, or a program such as the `agy` command). A route is one model reached through one router. A kind is a type of work (scout, builder and so on); each kind lists its picks, the models or Claude agents that can serve it, in order. This skill checks the routes and edits that file. Claude workers need no setup; everything below is about the non-Claude ones, many of which are free.

Never write, print or ask for an API key value. Tell the user the name of the environment variable and let them set it themselves.

## 1. Check what works

Run `node {{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs doctor`. It prints one line per router, then one line per kind of work, showing the first route that can run now:
- `READY`: usable.
- `NO KEY (<ENV>) -> <signup URL>`: the router needs an API key in that environment variable. Go to section 2.
- `NOT INSTALLED (<bin>)`: the program is not on the PATH. Say which program and that installing it is optional; the router is skipped until then.

A kind whose only runnable pick is a Claude agent still works (the lead spawns that agent), but it uses Claude usage. Tell the user which kinds those are.

## 2. Add or fix a provider

1. Tell the user to get a key at the signup URL and to set the variable named in the doctor line themselves:
   - Windows: `setx NAME "value"` in a terminal (or System Settings, Environment Variables).
   - macOS or Linux: add `export NAME="value"` to `~/.zshrc` or `~/.bashrc`.
   - Then they must open a new terminal and restart Claude Code, because a running process keeps the environment it started with.
2. For a provider not yet in `routing.json`, add a router under `routers`:
   `"myprovider": { "type": "http", "baseUrl": "https://example.com/v1", "keyEnv": "MYPROVIDER_API_KEY", "signup": "https://example.com/keys", "free": true }`
   `baseUrl` must be an OpenAI-compatible API (it answers `POST <baseUrl>/chat/completions`). Add routes to the models it serves: `{ "router": "myprovider", "id": "<model id from the provider's list>" }`, free routes first.
3. Run `doctor` again. The router should now say `READY`.
4. Smoke test, meaning one cheap call that shows the route works: write a one-line brief to a file, then run `node {{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs ask <model alias> <brief file> --router <name>`. A model id the provider does not know gives an error such as HTTP 400 or 404: look up the exact id in the provider's model list, fix `id` in `routing.json`, and run the test again. Ids marked `"verified": false` in the shipped file are best guesses; set it to `true` once a smoke test passes.
5. Add one line to `changelog` in `routing.json`: date, what changed, why.

## 3. Change which worker serves a kind

- Order of picks for a kind: `kinds.<kind>.picks`, tried first to last. Move a pick up to make it the default; remove it to stop using it. Keep a Claude pick last as the fallback.
- Order of routes inside a model: `models.<alias>.routes`, tried first to last. Put free ones first.
- A job that must not use Claude workers: add `--no-claude` to `worker.mjs run`.
- After any edit run `node {{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs route <kind>` to see the result, and add one `changelog` line. Copy `routing.json` first if it is not in version control. Reinstalling never overwrites it, so your edits survive.
- Model names belong only in `routing.json`. Do not copy one into a skill, an agent file or a brief.

## 4. Report

Finish with: the doctor output (key values never shown), what the user still has to do themselves (get a key, set a variable, restart), and which kinds will fall back to Claude until then.
