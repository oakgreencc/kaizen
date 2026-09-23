# How `claude plugin eval` works — and whether it can regression-test kaizen

Research for [#4](https://github.com/oakgreencc/kaizen/issues/4) (part of #1). Researched 2026-09-22 against Claude Code **2.1.280** (local `claude --version`).

**Short answer: yes, with one small kaizen change.** `claude plugin eval` can run `/kaizen:kaizen` in an isolated `claude -p` session against fixture transcripts that a scaffold script writes, and grade the report and memory files kaizen writes. The blocker is that the eval harness gives each run its own throwaway Claude Code config dir, and doesn't pass arbitrary env vars through. So kaizen needs a way to read transcripts from somewhere other than `$CLAUDE_CONFIG_DIR/projects`, for example a `projects` key in `.claude/kaizen.json`.

## Sources

| Tag | Source |
| :-- | :-- |
| [EVALS] | https://code.claude.com/docs/en/plugin-evals (primary, the whole page) |
| [SKILLS] | https://code.claude.com/docs/en/skills (`disable-model-invocation`, `/skill-doctor`, skill-creator evals) |
| [HEADLESS] | https://code.claude.com/docs/en/headless (`claude -p`, `/skill` expansion in `-p`) |
| [REF] | https://code.claude.com/docs/en/plugins-reference (`experimental.evals` manifest key) |
| [ENV] | https://code.claude.com/docs/en/env-vars (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`) |
| [SDK] | https://code.claude.com/docs/en/agent-sdk/plugins, https://code.claude.com/docs/en/agent-sdk/typescript |
| [CLI] | local `claude plugin --help` (2.1.280) |
| [CODE] | this repo: `skills/kaizen/scripts/lib.mjs`, `SKILL.md`, `test/helpers.mjs` |

`claude plugin eval --help` could not be captured: the agent sandbox used for this research refused any command containing the word "eval". The option list below comes from [EVALS] § Command options instead. No eval suite was run, so there are no measured costs.

## 1. Suite format

- A suite lives in `evals/` under the plugin root. You can change the directory with `"experimental": { "evals": "…" }` in `plugin.json` or with `--eval-dir` [EVALS § Use a different eval directory; REF].
- A **case** is a directory that contains `prompt.md`, `case.yaml` or both. Directories that aren't cases can be used to group cases [EVALS § Write and refine cases].
  - The `prompt.md` frontmatter holds the run fields: `max_turns` (default 10, maximum 200), `timeout_seconds` (default 300, maximum 3600), `model`, `allowed_tools`, `runs` (default 3), `tags`, `plugins`, `env` (only `EVAL_*` keys) and `append_system_prompt`. The body is the prompt. An unknown frontmatter key is an error [EVALS § prompt.md frontmatter].
  - `case.yaml` (`schema_version: "1.1"`, `name`) adds fields that point at other files: `context.scaffold_script`, `context.history_file` (a `.jsonl` conversation to resume) and `context.add_dirs` (read-only fixture dirs) [EVALS § case.yaml fields].
  - `graders/<name>.md` holds one grader per file. Its frontmatter sets `type`, `weight` and `arm`, and the body is the rubric or pattern.
- **`claude plugin eval init`** runs an interactive session that interviews you, proposes cases, pilots them and writes them (this costs model calls). `init --bare <name>` writes a blank template and runs nothing [EVALS § Write a case manually]. Its format is **not** the skill-creator plugin's `evals/evals.json` [SKILLS § Evaluate and iterate].

## 2. How a case states its expected result

There's no expected-output field: `expected_outcome` is for humans only. Graders state the expected result. There are six types and **no custom-code graders** [EVALS § Grader types]:

| Type | Model call? | Passes when |
| :-- | :-- | :-- |
| `regex` | no | a JS regex is found in the `target` (`match: not_contains`, `match: "count:N"` and `flags` are supported) |
| `tool_used` | no | the number of calls to `tool` whose JSON input matches `input_match` falls within `min`/`max` |
| `tool_order` | no | the first `before` call comes before the first `after` call |
| `file_exists` | no | a file **created during the run** matches the `path` glob (`exists: false` inverts it) |
| `llm` | yes (judge) | at least 2 of 3 judge votes are PASS on the rubric |
| `baseline` | yes (judge) | the run is at least as good as a reference `.jsonl` transcript |

A grader's `target` (for `regex`) or `focus` (for `llm`) can be `last_message` (the default), `trace` (the session as JSONL, with JSON-escaped quotes), `files` (the list of created paths, not their contents), `{ source: file, path: <p> }` (**the contents of a workspace file after the run**) or `mock_calls` [EVALS § What a grader can look at].

## 3. Scoring

- A run's score is the weighted fraction of its graders that passed. A case's score is the mean over its runs (3 by default). A case passes when its score is at least `--threshold`, which defaults to **1.0** [EVALS § How a case is scored].
- **Two arms by default:** every case also runs with no plugin loaded, and the report shows `WITH`, `W/OUT` and `Δ`. `tool_used: Skill` graders and graders marked `arm: with-only` are left out of the score in both arms. `--ablation none` runs only the with-arm and halves the cost [EVALS § Score against the no-plugin baseline].
- The judge is "a small fast model" by default. `--judge-model sonnet` is recommended for nuanced rubrics. Docs advise using `regex` on long generated files and keeping `llm` graders for short outputs [EVALS § Choose graders that give a stable signal].

## 4. Sandboxing and isolation

From [EVALS § How runs are isolated] and [EVALS § Grant tools]:

- Each run gets a **throwaway home directory, working directory and Claude Code config**, and runs as a `claude -p` child with only the plugin loaded. No user settings, CLAUDE.md, memory, other plugins or MCP servers are loaded.
- **The environment is filtered.** Only an allowlist gets through: `PATH`, locale, proxy settings, provider auth, "most `ANTHROPIC_*` and `CLAUDE_CODE_*`" variables, and `EVAL_*`. `env:` keys in a case must match `EVAL_[A-Z0-9_]*`.
- Each run starts in an **empty workspace**. `@path` mentions in the prompt aren't expanded.
- **Tools:** only read-only tools listed in `allowed_tools` are granted: `Read`, `Glob`, `Grep`, `Skill`, `Agent`, `TodoWrite` and the Task* tools. You grant `Bash`, `Write`, `Edit` and web tools **for the whole run** with `--allow-tools`. A tool that isn't granted is removed from the session, not prompted for. A skill's `allowed-tools` frontmatter **can't** widen the grant.
- If Bash is granted in any form, it runs under the OS sandbox. Writes are confined to the workspace, **your home directory and Claude Code configuration are unreadable**, and the network is limited to granted domains. There is no backend on native Windows. On Linux, the sandbox needs `bubblewrap` and `socat`.
- The run can't read the eval directory, so the agent never sees the graders. The Artifact tool is off.
- Trust: the first run in a directory asks `Trust this plugin directory?`. Non-TTY runs and `--json` runs need `--trust-plugin` [EVALS § Trust the plugin directory].

## 5. Cost and runtime

- Every agent run and judge call is a real model call on your plan or API bill. A suite makes about `cases × runs` agent runs per arm, plus 3 judge calls per `llm` or `baseline` grader per run. `COST` is a list-price estimate [EVALS § Requirements, § How a case is scored].
- Controls: `--runs`, `--ablation none`, `--max-cost-usd` (checked before each run starts; exits 2 with partial results), `-j` concurrency from 1 to 8 (rate limits are shared), and per-case `max_turns`/`timeout_seconds` [EVALS § Command options].
- Docs example: one case, 6 runs, $0.41, 74 s [EVALS quickstart]. **Unverified for kaizen.** A kaizen run takes many turns (paths → extract → read rubric → deep-read → write files → mark), so expect a much higher per-run cost. Measure it with `--runs 1 --ablation none` first.
- Requires Claude Code **≥ v2.1.269** (local 2.1.280 is fine) [EVALS § Requirements].

## 6. CI and the JSON report

- Recommended CI invocation [EVALS § Run evals in CI]: `claude plugin eval . --trust-plugin --json results.json --threshold 0.8 --model <pinned> --judge-model <pinned> --no-publish --max-cost-usd 20`. Put the target **before** `--json`, `--tag` and `--allow-tools`.
- Exit codes: `0` means every case is at or above the threshold. `1` means a case scored below it, or there was a load, trust or option error. `2` means a partial run (cost ceiling or auth). `130` means interrupted and `143` means terminated.
- Each run writes `<evaldir>/results/<ts>/aggregate-result.json` and a self-contained `report.html`, so gitignore `evals/results/`. The report is published as a private artifact on claude.ai accounts unless you pass `--no-publish`.
- JSON fields (`schemaVersion: 1`, camelCase, additive): `partial`, `partialReason`, `aggregates.{overallScore,casesPassed,casesTotal,meanDelta}`, `cases[].aggregates.{score,delta}`, `cases[].arms.with[].{error,aborted,skippedPaidGraders}`, `costUsd`, `durationSeconds` and `claudeVersion` [EVALS § JSON result].
- CI needs credentials such as `ANTHROPIC_API_KEY` in the environment.

## 7. Can a case supply fake `projects/*.jsonl` fixtures for kaizen to read?

**Not through `CLAUDE_CONFIG_DIR` as-is. Yes with a small kaizen change.**

- `lib.mjs` `projectsDir()` is `$CLAUDE_CONFIG_DIR/projects`, falling back to `~/.claude/projects` [CODE]. In a run, the config dir is the harness's throwaway one [EVALS § isolation]. You can't set `CLAUDE_CONFIG_DIR` from a case because `env` only accepts `EVAL_*`, and the passthrough allowlist names `CLAUDE_CODE_*`, not `CLAUDE_CONFIG_DIR`. Under the Bash sandbox, "Claude Code configuration" is unreadable anyway. The throwaway config probably contains only the run's own transcript. (**Unverified:** whether a scaffold script can see or write the throwaway config path.)
- `context.history_file` doesn't help. It resumes one conversation as the agent's own history, and doesn't put files on disk for kaizen to discover.
- What **does** work, per the docs: `context.scaffold_script` (with `--scaffold`) runs a Bash script in the empty workspace before Claude starts [EVALS § Seed the workspace]. The script can write fixture transcripts under `./fixtures/projects/<slug>/<uuid>.jsonl`, using `$PWD` for the `cwd` fields and slug. It can also write `./.claude/kaizen.json`. Kaizen already reads that file for `out` [CODE `resolveConfig`], and it reads `./.claude/settings.json` `autoMemoryDirectory` for the memory dir [CODE `memoryDirFor`]. That pins both output paths inside the workspace with **no code change**.
- **Needed kaizen change:** let `projectsDir()` be overridden, for example with a `projects` key in `kaizen.json` or a `projects <dir>` argument, resolved relative to the repo root like `out`. Otherwise, a `KAIZEN_PROJECTS_DIR` env var would have to be spelled `EVAL_KAIZEN_PROJECTS_DIR` to survive the env filter, which is ugly. The `kaizen.json` key is cleanest, and `test/helpers.mjs` `sandbox()` could use it too.
- `context.add_dirs` (read-only fixture dirs inside the case dir) is an alternative to generating fixtures in the scaffold. **Unverified:** whether node run through the sandboxed Bash can read an `add_dirs` path, and whether a scaffold script can locate sibling files in its case dir. Generating the JSONL inline in the scaffold (a heredoc) avoids both questions.

## 8. Can a case assert on files the skill writes?

**Yes, as long as they're in the workspace.**

- `file_exists` with a glob, for example `kaizen-out/*.md` or `memory/*.md`. It only counts files created during the run.
- `regex` with `target: { source: file, path: … }` checks file contents deterministically, which is the recommended way to grade long reports.
- `llm` with `focus: { source: file, path: … }` checks short files such as a single memory file.
- The report path contains the run day (`<out>/<YYYY-MM-DD>.md`). `file_exists` takes a glob, but **unverified:** whether the `{source: file, path}` target accepts a glob. If it doesn't, have kaizen accept a fixed report name in eval mode, or grade `trace` instead.
- Files outside the workspace, such as the default `$CLAUDE_CONFIG_DIR/kaizen/…` output or `~/.claude/projects/*/memory`, can't be graded, and Bash can't write them under the sandbox. That's why the scaffold must redirect `out` and the memory dir into the workspace (§7).
- Kaizen writes with `Write` and `Edit` and runs `node …/kaizen.mjs` through Bash, so the run needs `--allow-tools Write Edit "Bash(node *)"`. A skill's `allowed-tools` doesn't count [EVALS § Grant tools]. The OS sandbox must be available (fine on macOS).

## 9. Invoking kaizen: `disable-model-invocation: true`

- Kaizen's SKILL.md sets `disable-model-invocation: true`, so Claude can't choose the skill from a natural-language prompt [SKILLS § Control who invokes a skill]. The case prompt must be the slash command, for example `/kaizen:kaizen out kaizen-out`. In `-p`, "user-invoked skills and custom commands work. Include `/skill-name` in the prompt string and Claude Code expands it" [HEADLESS]. Plugin skills are namespaced `/plugin-name:skill-name` [SDK plugins].
- **Unverified:** whether the eval harness passes the prompt body through that expansion. [EVALS] says Claude "receives the body exactly as you wrote it" and the run is a `claude -p` child, which suggests it does. Also unverified: whether a slash-expanded skill shows up as a `Skill` tool call in the trace. The `tool_used: Skill` grader recipe may not fire, so use `tool_used` on `Bash` with `input_match: 'kaizen\\.mjs extract'` as the evidence that the skill ran.
- The no-plugin arm is meaningless here because `/kaizen:kaizen` doesn't exist without the plugin. Run with **`--ablation none`**.

## 10. `/skill-doctor`

`/skill-doctor` reports what each installed skill **costs in context** and **how often it's invoked**, flags skills that have never been invoked, and lists plugins you haven't used recently. It runs in the `/plugin` Stats tab, or as text under `-p`. It needs ≥ v2.1.252 and feature-flag fetching [SKILLS § Find unused skills; ENV]. It's a usage and context-budget report, **not a correctness test**, so it doesn't apply to regression-testing the rubric. It's only marginally relevant: kaizen's `disable-model-invocation` already keeps its description out of the listing. `claude plugin validate` (already `npm run validate`) covers manifest and schema checks.

## 11. Alternatives if plugin eval doesn't fit

- **`node:test` driving `claude -p`.** This fits the existing test style (`test/helpers.mjs` already builds a fake `CLAUDE_CONFIG_DIR`). Spawn `claude -p "/kaizen:kaizen out <tmp>/out" --plugin-dir . --allowedTools "Bash(node *),Read,Write,Edit,Glob,Grep" --output-format json` with `CLAUDE_CONFIG_DIR=<sandbox>/config`, then assert on files with ordinary JS [HEADLESS]. You control the env fully, so **no kaizen change is needed**, and assertions can be arbitrary code.
  - Downsides: no repeat runs, scoring or judge unless you build them. A fresh `CLAUDE_CONFIG_DIR` has no credentials unless `ANTHROPIC_API_KEY` is set. `--bare` skips plugins and OAuth, so use `--plugin-dir` explicitly. No OS sandbox unless you ask for one.
  - `total_cost_usd` is in the JSON output [HEADLESS].
- **Agent SDK (`@anthropic-ai/claude-agent-sdk`) `query()`** with `plugins: [{ type: "local", path: "." }]`, `prompt: "/kaizen:kaizen …"`, `cwd`, `env` (which replaces the subprocess env), `allowedTools`, `maxTurns` and `maxBudgetUsd` [SDK]. It's the same as the option above but typed and streamed, at the cost of a devDependency. Worth it only if we want to inspect the tool-call stream programmatically.
- Both alternatives lose plugin eval's free wins: repeated runs with a mean, a 2-of-3 judge, the HTML report and a JSON result with CI exit codes.

## Minimal example suite sketch for kaizen

This assumes the proposed `projects` key in `.claude/kaizen.json`. Case: two sessions where the human gives the same correction, so the rubric should produce one **recurring** lesson and one memory.

```text
evals/
└── recurring-correction/
    ├── prompt.md
    ├── case.yaml
    ├── fixture.sh
    └── graders/
        ├── ran-extract.md
        ├── report-written.md
        ├── report-quotes-human.md
        ├── memory-written.md
        └── memory-is-rule.md
```

`prompt.md`:

```markdown
---
max_turns: 60
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill]
tags: [rubric]
runs: 3
---

/kaizen:kaizen out kaizen-out
```

`case.yaml`:

```yaml
schema_version: "1.1"
name: recurring-correction
context:
  scaffold_script: fixture.sh
```

`fixture.sh` runs in the empty workspace. It writes transcripts, pins `out`, the memory dir and the projects dir inside it:

```bash
#!/usr/bin/env bash
set -euo pipefail
ws="$PWD"; slug="${ws//[^a-zA-Z0-9]/-}"
mkdir -p .claude memory "fixtures/projects/$slug"
printf '{"projects":"fixtures/projects","out":"kaizen-out"}\n' > .claude/kaizen.json   # "projects" = proposed key
printf '{"autoMemoryDirectory":"%s/memory"}\n' "$ws" > .claude/settings.json
session() {  # $1 = uuid, $2 = the human's correction
  cat > "fixtures/projects/$slug/$1.jsonl" <<EOF
{"type":"user","cwd":"$ws","timestamp":"2026-09-01T10:00:00.000Z","message":{"content":"add a lint script"}}
{"type":"assistant","cwd":"$ws","message":{"content":[{"type":"text","text":"Running npm install eslint"}]}}
{"type":"user","cwd":"$ws","timestamp":"2026-09-01T10:01:00.000Z","message":{"content":"$2"}}
EOF
}
session 00000000-0000-4000-8000-000000000001 "no, this repo uses pnpm, never npm"
session 00000000-0000-4000-8000-000000000002 "again: use pnpm not npm. from now on always pnpm"
```

Graders. Most are free; one short `llm` grader:

```markdown
<!-- graders/ran-extract.md : proves the skill's procedure ran -->
---
type: tool_used
tool: Bash
input_match: 'kaizen\.mjs extract'
---
```

```markdown
<!-- graders/report-written.md -->
---
type: file_exists
path: "kaizen-out/*.md"
---
```

```markdown
<!-- graders/report-quotes-human.md : fixed path needs the day; see §8 caveat -->
---
type: regex
pattern: 'pnpm'
flags: i
target: { source: file, path: "kaizen-out/<day>.md" }
---
```

```markdown
<!-- graders/memory-written.md -->
---
type: file_exists
path: "memory/*.md"
weight: 2
---
```

```markdown
<!-- graders/memory-is-rule.md -->
---
type: llm
focus: trace
---
PASS if a feedback memory file was written whose rule says to use pnpm rather than npm, with a Why line.
FAIL if no memory was written, or the memory is about something other than the pnpm correction.
```

Useful negative case: `one-off-correction`. A single session containing a correction that isn't stated as a general rule should give `file_exists memory/*.md` with `exists: false`. That tests the rubric's "recurring = 2+ sessions or stated as a rule" bar from the other side.

Run it:

```bash
# iterate: one run, no baseline
claude plugin eval . --case recurring-correction --runs 1 --ablation none \
  --scaffold --allow-tools Write Edit "Bash(node *)"
# CI
claude plugin eval . --trust-plugin --scaffold --ablation none \
  --allow-tools Write Edit "Bash(node *)" \
  --json results.json --threshold 0.8 --model <pinned> --judge-model <pinned> \
  --no-publish --max-cost-usd 10
```

## Implications for kaizen

- **Plugin eval is viable** for a v0.2 rubric regression test, and it's the better fit than a hand-rolled harness because repeated runs, scoring, the report and CI exit codes come for free.
- **Required code change:** make the transcripts root overridable. Add a `projects` key to `kaizen.json` (relative to the repo root, like `out`) that `projectsDir()` honours. This can also simplify `test/helpers.mjs`.
- `out` and the memory dir can already be redirected into the workspace through `.claude/kaizen.json` and `.claude/settings.json` `autoMemoryDirectory`. Keep both honoured, because the eval depends on them.
- Always run with `--ablation none` (the skill is `disable-model-invocation`, so the baseline arm is meaningless), `--scaffold` and `--allow-tools Write Edit "Bash(node *)"`.
- Prompts must be `/kaizen:kaizen …`. Grade "skill ran" with `tool_used: Bash` on `kaizen.mjs extract`, not `tool_used: Skill` (unverified whether slash expansion emits a Skill call).
- Consider a stable report filename or an `EVAL_*`-driven fixed day, so a `regex` grader can target the report's contents by exact path.
- Keep fixture suites small (2 or 3 sessions) so `advice` never says **large** and the run doesn't fan out to subagents. Raise `max_turns` to about 60 and `timeout_seconds` to about 900.
- Add `evals/results/` to `.gitignore`. Pin `--model` and `--judge-model` in CI, and set `--max-cost-usd`.
- First step before building out the suite: one `--runs 1` pilot to confirm the unverified points (slash expansion in eval prompts, `{source:file}` glob support, per-run cost).
- `/skill-doctor` isn't a test tool; ignore it for v0.2.
