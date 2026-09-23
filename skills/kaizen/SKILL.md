---
name: kaizen
description: Session retrospective — reads your recent Claude Code transcripts for corrections, friction and rewritten throwaway scripts, saves recurring lessons as feedback memories, and writes a dated report.
argument-hint: "[all | match <regex>] [since YYYY-MM-DD] [dry-run] [rename] [out <dir>]"
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Glob, Grep, Agent, Bash(node ${CLAUDE_SKILL_DIR}/scripts/kaizen.mjs *)
---

# /kaizen — session retrospective

You are the continuous-improvement loop for how this human works with Claude Code. Read what happened in their recent sessions, find the **lessons** — the places they had to push back, and the work that keeps getting redone — and turn the recurring ones into feedback memories so the next session starts already knowing.

Run start to finish without asking questions; the human reads the report.

`K <subcommand> …` below is shorthand for the full command `node ${CLAUDE_SKILL_DIR}/scripts/kaizen.mjs <subcommand> $ARGUMENTS …` — always run the full form, arguments included, so every call resolves the same scope and output directory. The scripts own every path, date and piece of bookkeeping; take those values from their output, verbatim.

## 1. Orient

```bash
K paths
```

Note `out`, `memoryDir`, `memory` (`auto` writes memories, `propose` only lists them), `rename`, `lastRun`, `day` and `report`. **Done when** you hold those values and have read the project's `CLAUDE.md` if one exists — it is the convention baseline that corrections are measured against.

## 2. Extract

```bash
K extract --exclude ${CLAUDE_SESSION_ID}
```

This writes one summary per unanalysed session to `<out>/pending.jsonl` and prints counts. Each summary carries the human's `messages` (harness text already removed; `flags` are lexical hints only), `denials`, a `score`, a `title`, the `repoRoot`, and the `scripts` the agent improvised.

- `sessions: 0` → write `# Kaizen report <day> — no new sessions.` to `report`, run step 8, and stop.
- `advice` says **large** → run `K chunk`, then dispatch one subagent per chunk file, in parallel, each told: *"Read `${CLAUDE_SKILL_DIR}/references/rubric.md`, apply it to every session in `<chunk path>`, return the findings list it specifies."* Merge their findings and continue at step 4.
- Otherwise read `pending.jsonl` yourself and continue.

## 3. Find the lessons

Read [`references/rubric.md`](references/rubric.md) and apply it to **every** session in the pending file. **Done when** each session has either a findings entry or a deliberate "nothing here", and every script task meeting the rubric's permanence bar has a proposed home you have checked exists.

## 4. Deep-read

For each session with a finding, read the conversation around it:

```bash
K transcript <path> --limit 120
K transcript <path> --scripts --width 3000     # for script findings
```

Add `--from <resumedFrom>` for a resumed session to start where the last run stopped. Pin down what was asked, what the agent did, what the human said to correct it, and whether the lesson generalises beyond that one task. **Done when** every finding you keep quotes the human's own words and names the session title.

## 5. Group across sessions

Cluster findings that are the same lesson in different clothes — same behaviour corrected, same friction, same script rewritten. A lesson is **recurring** when it appears in 2+ sessions, or when the human stated it as a general rule ("from now on…", "always…"). Positive patterns the human praised count too.

## 6. Save memories

For each recurring lesson, find its home: `memoryDir` from step 1, or for `all`/`match` scope the memory dir of the session's `repoRoot`. A lesson seen across several repositories goes in the report as a proposed `~/.claude/CLAUDE.md` line instead — user-level instructions are the human's to edit.

```bash
K memories --root <repoRoot>
```

Read any listed memory that might already cover the lesson; **update it in place** when it does. Otherwise, when `memory` is `auto`, write a new file in that directory:

```markdown
---
name: <short-kebab-case-slug>
description: <one line — used to decide relevance at recall time>
metadata:
  type: feedback
---

<the rule, stated positively>

**Why:** <the reason, in the human's words where possible>

**How to apply:** <when this kicks in>
```

and add `- [<Title>](<file>.md) — <hook>` to that directory's `MEMORY.md`. When `memory` is `propose`, write nothing there — list the drafts in the report. **Done when** every recurring lesson is a new memory, an updated memory, or a proposal in the report.

## 7. Write the report

Write `report` (from step 1) using [`references/report.md`](references/report.md). Use `day` from step 1 for every date in it.

## 8. Close the run

```bash
K mark --day <day>
```

This folds the pending sessions into `status.json` so the next run starts after them. Run it only after the report is written — a run that dies before this point is simply redone next time.

If `rename` is true, also run `K title --session ${CLAUDE_SESSION_ID}`; when it fails it prints a `/rename …` line — pass that to the human and carry on.

## Chat output

1. The report path.
2. Memories created, updated or proposed — one bullet each.
3. Scripts that should be permanent — one bullet each, with the proposed home.
4. Counts: sessions analysed, findings per category.

The report holds the detail; the chat is a pointer to it.
