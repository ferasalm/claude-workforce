# Prompting your lead: one page

For the user. The lead points here when a habit below would have saved money or prevented a wrong turn.

## The first prompt

Five lines are enough. Copy this and fill it in:

```
Goal: <what you want, in one sentence>
Done means: <how you will judge it, e.g. "I can type in the terminal without lag">
Do not touch: <what must stay as it is>
Usage now: 5h __%, week __%, lead model __%. Cap for this task: __
Mode: <advise first | act, then report>
```

- **Done means** is the line that saves the most. Without it the lead decides what "finished" is, and you find out later that you meant something else.
- **Usage now** can be left out when a Claude Code window is open: the status line saves your limits to disk and the lead reads them. The **cap** cannot be guessed. Give one, or the lead will propose one.
- Add what you already tried or decided, so it is not tried or debated again.
- Leave out instructions on how to be efficient or careful. The skill carries those. Use your words for what only you know.

## During the chat

- **One topic per message.** A message with fifteen topics forces a long answer, and that answer is re-sent on every later call.
- **Answer open decisions by number** ("1: yes, 2: the second option").
- **Report what you saw, not what you concluded.** "Typing lags in the Windows Terminal tab, about a second per key" is more useful than "the config is broken".
- **Say when you are guessing.** "350k, but I am not sure why" lets the lead correct the reason instead of building on it.
- **A secondary request belongs in its own session** if it is unrelated. If it is small, say "secondary" as you did; the lead will do it second.
- **When a task is finished, start a fresh session** with a short brief. A long session makes every later message more expensive and answers less sharp.

## So you are not misled

Ask these whenever a report sounds too clean:

1. "What is verified, and what is assumed?"
2. "What would change your recommendation?"
3. "What did you not test?"

A good lead answers these before you ask. If the answer to the first is vague, the work is not done.

## When to use which model as lead

- **Opus or better (top tier):** designing how work is organised, decisions with trade-offs, problems where earlier attempts failed. Its weekly limit is your scarcest resource.
- **Sonnet:** tasks with a clear specification. Use `LITE.md` rules; it will ask for a stronger lead when it should.

## How to start it

- **Best:** `claude --model opusplan --effort xhigh --agent lead`. Opus thinks in plan mode (the plan, the slices, decisions); once you approve the plan, Sonnet carries it out as the lean orchestrator. Press Shift+Tab to enter plan mode and again to leave it.
- **Talk to the executor directly:** `claude --model sonnet --effort high --agent lean-orchestrator`.
- **Already inside a session:** type `/lead` or `/lean-orchestrator`.
- **Wide jobs** are cut into slices that do not overlap and run in parallel by cheap pinned helpers (Haiku xhigh by default; say "sonnet" if you want Sonnet slices). The lead never spawns top-tier helpers. If you start a dynamic workflow (`ultracode`) in a lead session, the lead sets each agent's model; do not rely on the default, which is the session's model.
- **Which models do what** is decided in `{{SKILLS_DIR}}/lean-orchestrator/routing.json`. Tell the lead "change X to Y" and it edits that file and adds a changelog line. `node {{SKILLS_DIR}}/lean-orchestrator/tools/worker.mjs route` shows the current picks.
