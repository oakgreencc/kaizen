# kaizen

A session retrospective for [Claude Code](https://code.claude.com). Run `/kaizen` every week or so. It reads the sessions you've had since the last run, finds the places where you had to push back, and writes the lessons that keep coming up as feedback memories, so the next session already knows them.

```
/kaizen                       # this repository's sessions since the last run
/kaizen all                   # every project on this machine
/kaizen since 2026-09-01      # ignore anything older
/kaizen dry-run               # propose memories without writing them
```

## What it finds

- **Corrections:** you told the agent it was wrong, reverted its work, interrupted it to change course, or rejected a tool call and said why.
- **Quality gaps:** you had to supply something the agent should have found itself.
- **Convention misses:** the agent broke a rule from CLAUDE.md or an established pattern.
- **Friction:** effort went into the process instead of the task: permission blocks, re-explaining context, chasing status.
- **Scripts that should be permanent:** the agent improvised the same `python3 -c`, `node -e` or `/tmp/*.py` in several sessions, or kept editing and re-running one. The report proposes where a tested version should live in your repo.
- **Positive patterns:** things you explicitly approved.

When a lesson shows up in two or more sessions, or you stated it as a rule, it becomes a memory file in Claude Code's [auto-memory](https://code.claude.com/docs/en/memory) directory for that repository. If a memory on the same point already exists, the skill updates that one instead. Lessons that apply across several repositories are proposed as `~/.claude/CLAUDE.md` lines, and you decide whether to add them.

## Install

As a plugin:

```
/plugin marketplace add oakgreencc/kaizen
/plugin install kaizen@kaizen
```

The plugin installs the skill as `/kaizen:kaizen`.

As a plain skill, which you invoke as `/kaizen`:

```bash
git clone https://github.com/oakgreencc/kaizen
cp -r kaizen/skills/kaizen ~/.claude/skills/kaizen
```

Requires Node 20 or later. There are no dependencies.

## How it works

The skill has two halves. `scripts/kaizen.mjs` is deterministic. It handles the parts a model tends to get subtly wrong: paths, dates, filtering and bookkeeping. The model handles the judgement.

| Step | Who does it | What happens |
|---|---|---|
| `paths` | script | Resolves the scope, output directory, auto-memory directory and today's date (local time zone, fixed once per run) |
| `extract` | script | Summarises each session that hasn't been analysed yet into `pending.jsonl` |
| analyse | model | Applies [`references/rubric.md`](skills/kaizen/references/rubric.md) to each summary. Large backlogs are split with `chunk` and fanned out to subagents |
| `transcript` | script | Prints a readable version of a flagged session for a closer look |
| memories | model | Checks what's already in the memory directory (`memories`), then writes new memories or updates existing ones |
| report | model | Writes `<out>/<day>.md` |
| `mark` | script | Merges the run into `status.json`. It only runs after the report is written, so a failed run gets redone next time |

What the extractor filters out:

- **Text the harness injected.** Slash-command bodies, skill instructions, CLAUDE.md copies, hook output, compaction summaries and task notifications are all stored as "user" messages. In one real corpus they made up about 80% of the volume and caused false correction hits in 18 of 21 sessions. The extractor uses `origin.kind` and `isMeta` where the transcript has them, and falls back to prefix rules for older transcripts.
- **Its own runs.** A kaizen session contains the kaizen procedure, which is full of correction vocabulary, so it would always rank as the most-corrected session. These sessions are identified by the command that was invoked (typed, namespaced, or called through the Skill tool), not by directory name. Otherwise a normal session that happened to run in a worktree called `kaizen-…` would be dropped too.
- **Subagent transcripts.** Their "user" turns come from another agent, not from you.

What the extractor keeps:

- **Rejected tool calls,** including the reason you typed. This is the most specific correction a transcript contains.
- **Resumed sessions.** `status.json` records each transcript's size in bytes. If a session grows after it has been analysed, only the new part is read on the next run.
- **An even spread of long sessions.** It keeps every flagged message, then fills the remaining space from the start and end of the session. Each message is capped at 1,500 characters and each session at 60 messages. Both caps are reported in the output, so nothing is dropped silently.

## Configuration

Settings are read from `~/.claude/kaizen.json` first, then `<repo>/.claude/kaizen.json`. Arguments to `/kaizen` override both.

```json
{
  "scope": "project",
  "out": "docs/kaizen",
  "memory": "auto",
  "rename": false,
  "since": null,
  "match": null,
  "skipCommands": ["kaizen"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `scope` | `project` | `project` covers this repository, including its subdirectories and worktrees. `all` covers every project |
| `match` | none | A regex matched against project directory names. It overrides `scope`. For example, `-Users-me-work-` |
| `out` | `~/.claude/kaizen/<project>/` | Where reports and `status.json` go. A relative path is resolved from the repository root |
| `memory` | `auto` | `propose` lists the memories it would write but doesn't write them |
| `rename` | `false` | Names the session `Kaizen YYYYMMDD` (see below) |
| `since` | none | Ignores sessions that started before this date |
| `skipCommands` | `["kaizen"]` | Commands whose sessions are skipped because they would analyse themselves. Add any alias you use |

Each scope keeps its own `status.json`. Switching between `project` and `all` never marks a session as analysed in the other scope.

## Privacy

Reports quote your own messages. By default they're written to `~/.claude/kaizen/`, outside your repository. If you set `out` to a path inside the repository, check the reports before you commit them. Nothing is sent anywhere. The only thing that runs is the model you're already using, reading local files.

## Caveats

- Transcripts use an internal Claude Code format and can change between releases. The extractor ignores lines it can't parse rather than failing, and the tests pin the shapes it depends on.
- `rename` writes the same two files that `/rename` writes. That format is internal too, so `rename` is opt-in and best-effort. If it fails, it prints a `/rename …` line for you to paste.
- The correction keywords are only hints. The model decides what actually happened, and the report quotes your words so you can check.

## Development

```bash
npm test                 # node --test, no dependencies
npm run validate         # claude plugin validate .
node skills/kaizen/scripts/kaizen.mjs paths
```

## Origin

Kaizen started as a project-specific command in a private monorepo. Over about a dozen weekly runs it built up most of the filtering above, each piece added after a run went wrong. This is the general-purpose version.

## License

[AGPL-3.0](LICENSE)
