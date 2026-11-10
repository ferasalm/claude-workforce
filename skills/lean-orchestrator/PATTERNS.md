# Patterns

Read on demand. `SKILL.md` says when each section applies.

## Review pairing

Every builder result gets a reviewer of the same tier from a different model family. `builder-iq` is reviewed through `builder-eq` and the other way round (`routing.json` lists the pairs under `review`). This is nice to have, not required. The reviewer is read-only, gets the diff and the pass condition, and never the builder's reasoning. An implementer never reviews itself.

## Tests the builder cannot cheat

For any build with a testable pass condition:
1. Run `test-writer`. It is a pair: two writers from different model families write tests from the specification only, never from the code. Merge their tests.
2. Run `node tools/worker.mjs lock <test files>`. This hashes the files and makes them read-only.
3. Tell the builder: the tests are read-only; a failing test means the code is wrong.
4. After the build, `node tools/worker.mjs verify` must print OK before you trust a pass. Then run the tests yourself.

This guards against a builder editing the tests. It does not guard against two writers who are both wrong.

## Kaizen tidy rules

Kaizen means small, steady improvement. After you record a run (step 8):
- A lesson seen three times becomes a rule in `SKILL.md` or in the `lead` skill, and its entries are deleted.
- A rule contradicted by a run, or made obsolete by a tool or model change, is fixed or removed.
- Keep `LESSONS.md` under 60 lines.
- Every tenth `METRICS.csv` row, reread both skill files and remove any rule that no row or lesson still supports.
- Worked examples go in `logs/`, one file per run, and are read only when a lesson points to one.

## Rules for smaller models running this skill

- Do the steps in order. Do not skip step 3 or step 6.
- If a command fails twice the same way, stop repeating it. Read the error, then read the source or docs for that exact message.
- Check line endings before a text replace on Windows files. A replace that matches `\n` silently does nothing on a CRLF file; verify the change landed.
- A long-running background process keeps the settings it started with. After changing config, restart it before testing.
- A sync tool that adds entries may not remove them. Check what it does with entries that are no longer targeted.
- When you are unsure whether an action is reversible, treat it as not reversible: back up, or ask.
