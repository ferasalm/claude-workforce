---
name: lean-orchestrator
description: Run a multi-step debugging, setup or build task at low token cost without lowering quality. Use when the user sets a usage or context budget, asks for efficient or cheap work, asks to delegate to cheaper models, or when a task needs broad fact-finding before a fix. Works in any project and any harness that can spawn helpers; degrades to single-agent rules when it cannot.
---

# Lean orchestrator

The execution protocol. One strong model decides, cheaper workers (helper models) gather facts and build, every change is backed up first and proven by a test afterwards, and each run is recorded so the next one is cheaper. Judgement about whether and how to organise the work lives in the `lead` skill; this file is how the work is then carried out.

Paths in this file are relative to this skill's folder, `{{SKILLS_DIR}}/lean-orchestrator/`. Run tools with the full path, for example `node {{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs route`. A pass condition is the command, or check, and the result that counts as success.

Read `LESSONS.md` before starting, and `tools/INDEX.md` (scripts that already do a repeated job). Both are short. `PATTERNS.md` in this folder is read on demand; the last section says when.

## Why cost behaves the way it does

Every tool call re-sends the whole conversation so far. A call made at 20k tokens of context is cheap; the same call at 150k costs seven times as much. So the two levers are: keep the main context small, and make few calls in it. Helpers have their own context, so their reading does not grow yours. Only their report does.

## Who runs this, and where

| You are | Do this |
|---|---|
| The main session of Claude Code (`claude --agent lean-orchestrator`, or the execution phase of `claude --model opusplan --agent lead`: the top model plans, Sonnet executes) | Follow the loop below. Spawn workers directly. Do not re-decide the plan; if you hit a decision, go back to the lead or the user. |
| A sub-orchestrator subagent (`sub-orchestrator`, a helper agent pinned to Haiku that runs this protocol on one slice; `sub-orchestrator-sonnet` only when the user asked for Sonnet) | You own one slice (one part of a bigger job). **Slice mode:** skip loop steps 1, 7, 8 and 9 (the lead records metrics and lessons from slice reports). Default cap: 80 tool calls. Run `worker.mjs` in the foreground. Do not ask the user anything; report open questions. |
| The lead running several slices | A slice is one part of a big job that one sub-orchestrator can finish alone. Cut slices that do not overlap and leave no gap (MECE: mutually exclusive, collectively exhaustive): each names its own files or questions, its non-goals, and the interface it shares with the others. Check the cut for overlap, then launch the sub-orchestrators in one message. Reports are at most 300 words, in the format their definition fixes; you merge them and settle conflicts. Nesting works: lead, then sub-orchestrator, then workers (default limit three layers). |
| OpenCode, agy or another harness | Read `{{SKILLS_DIR}}/lead/LITE.md`. Workers are reached through `tools/worker.mjs`; Claude agents are not available there, so skip picks marked `claude`. |

**Never spawn an agent without a pinned model.** An unpinned subagent inherits the main session's model, and under the top tier that can use a whole weekly limit in minutes. Spawn only the pinned agents named in `routing.json` (`claude_agents`). Never use `general-purpose`, `Explore` or `Plan` for work you delegate, and never pass `model: opus` or any other top-tier model. In a dynamic workflow (the `Workflow` tool, including `ultracode`), set `agentType` to a pinned agent, or set both `model` and `effort` on every `agent()` call; leaving them out means the expensive model.

**Model names.** Non-Claude model names live only in `routing.json`. Skills, agents and docs refer to kinds. Claude tiers are named only where pinning is the point: agent frontmatter, launch commands and the rule above.

## The worker ladder

A kind is a type of work. A pick is one model (or Claude agent) that can serve a kind; each kind lists its picks in order. The ladder is the list of kinds from cheapest to dearest. `node tools/worker.mjs route` shows the kinds and the picks behind each, in order; `route <kind>` shows the criteria. Pick the lowest kind whose `use_when` covers the task, sized by what the answer feeds, not by how the task looks.

| Tier | Kind | Good for | Not for |
|---|---|---|---|
| 0 and 1 | `trivial` | The brief holds all the input, or the answer is one stated fact | Anything that feeds a decision |
| 2 | `scout-light` | Mere fact-finding: where is X, what value does Y hold | Conflicting evidence |
| 2 | `scout-deep` | Answers that need QA or reasoning: logs, complete inventories, sourced lookups | Edits |
| 3a | `test-writer` | Tests that define the pass condition, written before the builder | Writing the code under test |
| 3b | `builder-iq` | Correctness matters most: code, scripts, configs, data transforms | Prose where tone matters |
| 3b | `builder-eq` | The reader matters most: UX copy, docs voice, narrative, naming | Precise logic |
| 4 | the lead | Decisions, ambiguity, the load-bearing check, live-configuration edits | Bulk reading |

**How to call a kind.** Write the brief to a file, then `node tools/worker.mjs run <kind> <brief> [--dir D] [--write] [--no-claude]`. `run <kind>` is the default way. The raw modes (`oc`, `agy`, `text`) are probes for testing one route, not for real work. It walks the picks in order and the routers inside each pick, and prints which one answered.
- If the next pick is a Claude agent it prints `NEXT: spawn Claude agent ...` and exits 3: spawn that pinned agent yourself with the same brief. When the job bans Claude workers, add `--no-claude`: Claude picks are skipped, and if none is left it exits 1 with the reason.
- Builder kinds need `--write --dir <D>`. `D` must be a git work tree with at least one commit (or a disposable copy), never live configuration.
- `worker.mjs` queues across processes (slots), so callers may run it in parallel. From a workflow subagent, run it in the foreground: a background run dies with the subagent.
- Non-Claude workers use no Claude usage; prefer them whenever the result is cheap to check. Never run Haiku at low effort.

**Pairing and locked tests.** Every builder result gets a reviewer from another model family, and code with a testable pass condition gets tests written first and locked. Read `PATTERNS.md` ("Review pairing", "Tests the builder cannot cheat") before the first builder run of a job.

**When a worker's result fails your check:**
1. Ask whether the brief was the cause. If a fact, a path or the pass condition (a command and the result that counts as success) was missing, fix the brief and retry the same kind, once.
2. Otherwise go up exactly one kind (trivial, scout-light, scout-deep, builder, you) and attach what the failed attempt tried and the error it met. Never rerun the same brief on the same kind.
3. After two failures on one task, stop delegating it. Do it yourself or cut the task differently.
4. If a kind has passed the same task type three times with nothing to correct, try the kind below next time and note it in `LESSONS.md`.
5. If a router fails repeatedly (rate limit, outage), say so in the report; the user decides whether to edit `routing.json`.

**Checking work from other model families:**
- Facts must come with a file and line or the command that showed them. Check the one your next step depends on.
- Edits happen only with `--write --dir` on a git work tree or a copy, never on live configuration. Read the diff and run the test yourself.
- Text is a draft. You read it before it goes anywhere.
- Workers never receive secrets. They may be told the name of an environment variable.

## The loop

### 1. Ask once, up front
Before any work, ask only the questions whose answers change what you do: how destructive you may be, what must not be touched, which of two reasonable targets is meant. Offer a recommended option. Do not ask about anything you can look up. When the symptom is interactive, ask how the user launches the thing and name the test they will run at the end. Check `tools/INDEX.md`: if a script already does the job, run it instead of spending AI.

### 2. Scout in parallel
Split fact-finding into independent read-only briefs and launch them in one message. Each brief contains:
- the context the helper lacks (machine, paths, what the user reported)
- numbered questions, each answerable with evidence
- the exact names you will need later ("give the key name the tool reads for X, with the source line"), so the costly guessing happens in the cheap context
- for workers other than the Claude `scout` and `builder` agents: "READ-ONLY. Never print secrets. At most 350 words: facts with paths, then ranked causes with confidence, then what could not be determined. Mark verified versus inferred."

If you cannot spawn helpers, do the same scouting yourself in few, wide commands (step 4).

### 3. Verify the one fact the fix depends on
Helper reports are leads, not truth. Before acting, check the load-bearing claim yourself with one command. Expect helpers to misread scope: a report said "the first request sends 290k tokens", which suggested a bloated startup; the log showed a fresh session starts at 13k and the big number was one old session that never compacted. That changed the fix.

### 4. Make each of your own calls wide
- Put several related checks in one command with labelled sections (`'--- logs'`, `'--- processes'`).
- Cap every output: first or last N lines, truncate long lines, count instead of list, group and sort instead of dumping.
- Filter out the dominant noise line before reading a log, then group the rest by source to see what else is there.
- Mask secrets in the command itself (replace values of keys matching key, token, secret). Compare secrets by equality, never by printing.
- Read a file range, not a file. Find the line with a search first.
- Never read a helper's raw transcript.

### 5. Change with a backup, one hypothesis at a time
- Copy every file you will edit to a dated backup folder and confirm the copy exists before the first edit. A failed combined command can skip the backup silently. Files under version control need no copy.
- Prove the target works in isolation before changing saved config (for example run the tool once with the new setting passed as a flag).
- Then change the saved config and run the same test through the normal path. If it fails, the difference between the two runs is the bug.
- When the tool rejects your config, read its source for the exact key it reads. Do not guess a second time.
- If the fix will take more than two test runs, hand the loop to a builder kind: the files, the exact edits, the test command, the pass condition, and "stop and report after two identical failures". You pay for one report instead of every run in your large context.
- Leave working systems alone. State which files you did not touch.
- Do not edit a tool while parallel runs are executing it.

### 6. Prove it, then report honestly
Finish with an end-to-end test that exercises what the user complained about, and quote its result. Say separately: what is verified, what is inferred, what you could not test (for example anything interactive), and what trade-off the fix introduced. Do not round "inferred" up to "fixed".

### 7. Budget and handoff
- **Usage.** Run `node tools/usage.mjs --start` at the start and `node tools/usage.mjs --end` at the end. The first saves the baseline; the second prints the difference and the `d5h_pct,d7d_pct` fragment for `METRICS.csv`. The data is `~/.claude/usage-snapshot.json`, written by the optional status line (`node install.mjs --statusline` in the claude-workforce repo) of any open interactive Claude Code session. If the script says there is no snapshot or that it is STALE (older than 30 minutes), ask the user for their numbers. Never invent a percentage. A budget is a difference: without the starting figure the end figure cannot be judged.
- **Handoff.** When context passes about 200k tokens at a task boundary, or the cap is near, stop starting new work and update the project's `HANDOFF.md`. There is one per project, edited in place, at most 60 lines, with the sections Now / Verified / Next steps / Open decisions / Backups. The next session absorbs durable facts into the project's map (its `CLAUDE.md`, `AGENTS.md` or equivalent) and empties the handoff. To continue unattended in a fresh window, run `node tools/next-chat.mjs --handoff HANDOFF.md`.
- Put durable facts in the project's existing docs, not in a new file, unless the user asks for one.

### 8. Learn
At the end of every run:
1. Add one row to `METRICS.csv` (columns are in its first line; `rework` counts every time something reported as done had to be redone, including when the user found it still broken; `scripts_made` counts scripts you wrote in step 9).
2. Add to `LESSONS.md`, newest first, a dated block of at most 5 lines: one thing that saved cost or caught an error, one thing that wasted cost with the rule that would have prevented it, and any worker sizing that was wrong.
3. Compare your row with earlier rows of the same task type. Say in your report whether usage, rework and helper failures went down or up, and why.

Then tidy as `PATTERNS.md` ("Kaizen tidy rules") says. Keep `LESSONS.md` under 60 lines.

### 9. Replace repeated AI work with a script
Spending model compute on the same mechanical job twice is a bug in this system. After each run, look for steps that were the same commands with no judgement: a task type that already has a row in `METRICS.csv`, the same inventory or check run again, a format conversion, a log filter, a health check. For each one:
1. Write `tools/<name>.mjs` (or `.ps1` when it must be PowerShell). Header comment: purpose, usage, what it prints. Read-only by default; anything that writes needs an explicit flag. No secret values inside.
2. Test it once on the case that triggered it, and once on a case where it should fail.
3. Add one line to `tools/INDEX.md`: name, what it does, how to call it.
4. Next time, step 1 finds it and runs it. If a script keeps needing judgement calls, it was not mechanical: delete it.
Do not script something seen only once, or something whose inputs change shape every time.

## Patterns, read on demand

`PATTERNS.md` holds four things that most runs do not need:
- **Review pairing:** read before the first builder run of a job.
- **Tests the builder cannot cheat:** read when the build has a testable pass condition.
- **Kaizen tidy rules:** read at step 8 when `METRICS.csv` has ten or more rows, or `LESSONS.md` nears 60 lines.
- **Rules for smaller models:** read if you are not a top-tier model.
