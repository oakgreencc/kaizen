# Kaizen analysis rubric

Apply this to every session summary in the file you were given (one JSON object per line). You are looking for **lessons**: moments where the human had to spend effort the agent could have saved them, and work that keeps being redone.

## Reading a summary

- `messages` is what the human typed, in order, harness text already removed. A `[denied <Tool>] …` message is a tool call the human rejected, followed by their reason — the most specific pushback a transcript holds.
- `flags` and `score` are lexical hints for where to look first. The judgement is yours: "don't" inside a task description is an instruction, not a correction; a flagged message can be the human correcting *themselves*.
- `omittedMessages > 0` means the middle of a long session was trimmed; the deep read covers it.
- `denials.classifier` counts tool calls an automatic permission check blocked — friction, not a human correction.
- Label every session by `title`, which is the name the human sees.

## What to find

**Corrections** — the human redirected the agent: said it was wrong, undid or reverted its work, interrupted and re-steered, rejected a tool call, or repeated an instruction already given.

**Quality gaps** — the human supplied something the agent should have found itself: an error it missed, context that was in the repo, a file or command that already existed. Includes an agent writing a script for a task that already has a permanent one — name that script.

**Convention misses** — the human pointed at a rule the agent should have followed: CLAUDE.md, an established pattern, "we always / we never".

**Friction** — effort spent on the process rather than the task: repeated permission blocks, re-explaining context across sessions, waiting on the agent to notice its own background work, asking for status that should have been reported.

**Positive patterns** — something the human explicitly approved or asked to keep doing. These become memories as readily as corrections.

## Scripts that should be permanent

Each summary's `scripts` are the programs the agent improvised (`python3 -c`, `node -e`, heredocs into an interpreter, files in temp dirs); `scriptCount` is the uncapped total. Most are throwaway, correctly. Group them **by the task they perform** across sessions — `description` first, `snippet` to tell two similar tasks apart — and flag a task when it shows:

- **Recurrence** — the same task in 2+ sessions (a CI poller, an API-response reader, a ticket-body writer).
- **Iteration** — one session wrote and re-ran it 3+ times, editing each time: a program being developed without a test.
- **Load-bearing** — its output decided something that was then committed or published (a count in a doc, a list of issues closed, a "no overlap" verdict).

For each flagged task, propose a **home**: the module in `repoRoot` that owns the data it reads, with a script name. Check the home before proposing it — list the directory, read its manifest's scripts (`package.json`, `Makefile`, `pyproject.toml`, `bin/`, `scripts/`). If a permanent script for the task already exists, the finding moves to Quality gaps: the agent did not find it.

## What to return

One entry per finding:

```
category: correction | quality | convention | friction | positive | script
session: <title> (<project>, <path>)
what: <one line — what happened>
quote: "<the human's words>"
lesson: <the general rule, stated positively, or "one-off">
```

For `script` findings replace `quote`/`lesson` with `task`, `languages`, `evidence` (recurrence / iteration / load-bearing), and `home`.

Sessions with nothing to report need no entry. Findings stay specific: a session, a behaviour, the human's words.
