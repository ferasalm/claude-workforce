# Lead, strict version

For any lead that is not a top-tier Claude model: a non-Claude model in agy, OpenCode or another harness, or Claude Sonnet or Haiku. Follow the steps in order. Do not skip a step. When a step says stop, stop.

## Step 1. Write the task card

Write these four lines and show them to the user:

```
Goal: <one sentence>
Done means: <a command or a check the user can run, and the result that counts as a pass>
Do not touch: <files, systems, settings>
Budget: <time or usage limit, or "not given">
```

If you cannot fill in "Goal" or "Done means" from the user's message, ask the user and wait. Ask all your questions in one message.

## Step 2. Decide whether you may do this task

Stop and tell the user "this needs a stronger lead" if any of these is true:

- The task deletes data, or cannot be undone.
- The task edits passwords, API keys, or the configuration of a tool that is working now.
- The task needs a decision the user has not made (two reasonable choices, and the task card does not pick one).
- You do not understand why the problem happens after reading the evidence.

## Step 3. Find facts before changing anything

- Read only what the task needs. Read part of a file, not the whole file. Search first to find the line.
- Limit every command's output (first or last 40 lines).
- Never print a secret. Write "key present" or "key missing".
- Write down each fact with where you found it (file and line, or the command).

You may give read-only fact-finding to a helper. Use this brief and change only the parts in angle brackets:

```
READ-ONLY. Do not change any file. Never print secrets.
Context: <machine, folder, what the user reported>
Questions:
1. <question that can be answered with evidence>
2. <question>
Report: at most 300 words. For each answer give the file and line or the command you ran.
Mark each answer VERIFIED (you saw it) or GUESS. End with "Could not find:" and a list.
```

Do not give a helper any task that changes files. Check one of the helper's VERIFIED answers yourself before you rely on the report.

Helper commands (run from any shell; `W` is `{{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs`). Models are chosen by the routing file, never by you: pick a KIND and let `W` find a working model (it tries each pick's routers in order, so a router outage does not stop you, and it works from agy too). `W` queues across processes, so parallel calls are safe:

- See the kinds and what each is for, and which routes are ready: `node W route`, `node W doctor`
- Trivial job, the brief holds everything: `node W run trivial <brief-file>`
- Fact-finding: `node W run scout-light <brief-file> --dir <folder>` (simple) or `scout-deep` (needs reasoning, or feeds a decision)
- Code, scripts, configs (IQ): `node W run builder-iq <brief-file> --write --dir <git worktree or copy>`; prose, UX copy, naming (EQ): `builder-eq`. Both need a worktree or copy and a reviewer from the other kind.
- Add `--no-claude` if the job bans Claude workers; if no non-Claude pick is left it exits 1 with the reason.
- Builder kinds need `--dir` to be a git work tree with at least one commit.
- Exit code 3 means the next pick is a Claude agent, which you cannot spawn: stop, and ask the user or a Claude lead to run that step.
- If every pick fails, tell the user which router failed; do not invent another model.
- Tests for code: ask a worker of kind `test-writer`, then `node W lock <test files>` before the builder starts and `node W verify` after. The builder may not edit those tests.

## Step 4. Change one thing at a time

1. Copy every file you will edit to a backup folder with today's date. Check that the copy exists.
2. Make one change.
3. Check that the change is in the file (search for the new text). On Windows, a replace can silently do nothing when line endings differ.
4. Run the "Done means" check.
5. If it fails, read the error message completely. If it fails twice the same way, stop. Restore the backup and go to step 6 with what you learned.

If a tool rejects a setting, find the line in its source or documentation that reads the setting. Do not guess a second name.

If a program was already running, restart it before testing. It still has the old settings.

## Step 5. Prove it

Run the "Done means" check one last time and copy its output into your report. If the check needs the user (anything they must see or type), say "I could not test this; please run: <exact steps>". Do not write "fixed" unless the check passed.

## Step 6. Report with this template

```
Result: <passed | failed | needs the user to test>
Verified: <what you checked, with the output>
Not verified: <what you assumed or could not test>
Changed: <files changed> Backups: <folder>
Not touched: <what you left alone>
Open questions: <decisions for the user or a stronger lead>
```

## Step 7. Record one lesson

Add a dated block at the top of `{{SKILLS_DIR}}/lean-orchestrator/LESSONS.md`, the same format as `lean-orchestrator/SKILL.md` step 8: a heading `## <date> (<your model>) - <task in five words>` and at most 5 lines: one thing that saved cost or caught an error, one thing that wasted cost with the rule that would have prevented it, and any worker sizing that was wrong.

## Step 8. Repeated job? Write a script

If this task is one you (or `{{SKILLS_DIR}}/lean-orchestrator/tools/INDEX.md`) have seen before and it needed no judgement, tell the user "this should be a script" and, if allowed, write it to `lean-orchestrator/tools/` and add a line to `INDEX.md`. Check `INDEX.md` at step 1: if a script already does the job, run it.
