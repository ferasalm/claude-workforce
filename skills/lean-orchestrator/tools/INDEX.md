# Scripts that replace repeated AI work

One line each: name, what it does, how to call it. Add a line when you write a script (step 9 of SKILL.md); delete the line and the script when it keeps needing judgement. Call them with the full path, `node {{SKILLS_DIR}}/lean-orchestrator/tools/<name>`.

| Script | Does | Call |
|---|---|---|
| `tools/worker.mjs` | Hands a brief to a non-Claude worker with router fallback (`run`), asks one model (`ask`), shows the routing (`route`), checks which routes are ready (`doctor`), locks and verifies test files (`lock`, `verify`) | `node tools/worker.mjs doctor` |
| `tools/bench.mjs` | Probes every non-Claude pick of each kind with a tiny known-answer task, grades it, and prints a table plus a suggested pick order (`--dry-run` plans without running) | `node tools/bench.mjs` |
| `tools/usage.mjs` | Reads `~/.claude/usage-snapshot.json`: prints the 5-hour and 7-day usage and the age of the data. `--start` saves a baseline, `--end` prints the difference and the `d5h_pct,d7d_pct` fragment for `METRICS.csv` | `node tools/usage.mjs --start` |
| `tools/check.mjs` | One gate over the skill layer: tests, agent frontmatter against `routing.json`, line limits, no model names in skills. One ok or FAIL line per step | `node tools/check.mjs` |
| `tools/next-chat.mjs` | Opens a new terminal window running Claude Code that reads a handoff file and continues it (`--dry-run` prints the command only) | `node tools/next-chat.mjs --handoff HANDOFF.md` |
