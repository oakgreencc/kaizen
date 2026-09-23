# Claude Code auto-memory: format and loading

Research for [#2](https://github.com/oakgreencc/kaizen/issues/2) (part of #1). Checked 2026-09-22 against Claude Code **v2.1.280**.

**Sources**

- Docs: [memory](https://code.claude.com/docs/en/memory#auto-memory), [settings-reference](https://code.claude.com/docs/en/settings-reference#automemorydirectory), [claude-directory](https://code.claude.com/docs/en/claude-directory), [env-vars](https://code.claude.com/docs/en/env-vars), [sessions](https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself), [errors](https://code.claude.com/docs/en/errors#memory-index-is-over-its-read-limit), [sub-agents](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory), [hooks](https://code.claude.com/docs/en/hooks#instructionsloaded), [context-window](https://code.claude.com/docs/en/context-window).
- **Local survey:** frontmatter keys only, across 17 memory dirs and 178 topic files on one machine. No body text was read or copied.
- **Experiment:** two `claude -p --settings '{"autoMemoryDirectory":"/tmp/..."}'` runs against a seeded temp memory dir, then a diff of the result.

Labels used below: **[docs]** means the official docs state it. **[observed]** means seen on disk or in the experiment. **[unverified]** means inferred and not confirmed.

## 1. Frontmatter fields

**What the docs say [docs]**

- Claude records the kind of memory "as a `type` field in the memory file's frontmatter". There are four values: `user`, `feedback`, `project` and `reference`. ([memory#auto-memory](https://code.claude.com/docs/en/memory#auto-memory))
- When Claude writes a memory file that begins with YAML frontmatter, "Claude Code records the write time in a `modified` frontmatter field as an ISO 8601 timestamp". It never adds frontmatter to a file that has none. Needs v2.1.214+. ([memory#how-it-works](https://code.claude.com/docs/en/memory#how-it-works))
- The docs give no schema for `name` or `description`, don't say where `type` sits (top level or nested), and don't say whether unknown keys survive an edit.

**On disk [observed]**

All 178 files have frontmatter. There are two shapes:

- **Current shape (165 files):**
  ```yaml
  ---
  name: <slug>
  description: <one line>
  metadata:
    type: feedback|project|reference|user
    node_type: memory            # 154 files, always "memory"
    originSessionId: <uuid>      # 156 files
    modified: 2026-09-01T12:34:56.789Z   # 120 files, ISO 8601 UTC with ms
  ---
  ```
- **Legacy shape (13 files):** `type` and `originSessionId` sit at the top level instead of under `metadata`.

So the documented `modified` field actually lands at **`metadata.modified`** in the current shape. The docs just say "a `modified` frontmatter field".

File names follow `<type>_<topic>.md` (for example `feedback_testing.md`), which matches the docs' example tree.

**Can kaizen add its own fields? [observed, 1 experiment]**

I seeded a memory with `metadata.kaizen_id`, `metadata.kaizen_placed` and a top-level `kaizen_top`, then asked Claude to update that memory twice. It edited `description` and the body both times and **left all three custom keys untouched**. Claude edits memory with its ordinary Read, Edit and Write tools, so the keys survive because Edit does in-place string replacement.

- **[unverified]** A full `Write` rewrite of the file could drop unknown keys. Nothing in the harness protects them, and no doc promises they are kept.
- **[unverified]** In the experiment (custom `autoMemoryDirectory`, `-p` mode), **no** `modified` or `originSessionId` was stamped, even on a newly created file. On-disk memories in the default dir do carry them. Stamping may therefore depend on the default dir, interactive mode, or a code path that `-p` doesn't use. Don't rely on `modified` being present.

## 2. How MEMORY.md and topic files load

**MEMORY.md [docs]**

- It is truncated. "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation. Content beyond that threshold is not loaded." ([memory#how-it-works](https://code.claude.com/docs/en/memory#how-it-works))
- YAML frontmatter and block-level HTML comments are stripped from MEMORY.md before it loads, and they don't count toward the limit. This has applied since v2.1.211. ([errors](https://code.claude.com/docs/en/errors#memory-index-is-over-its-read-limit))
- **[observed]** A `<!-- ... -->` first line in MEMORY.md was not shown to the session, but Claude left it in place when it edited the file.
- Write-time guard: after Claude writes MEMORY.md, Claude Code measures it. Near the limit, it reminds Claude to "keep one line per entry, move detail into topic files, and merge or drop stale entries". Over the limit, the write still succeeds, but Claude gets an error telling it to rewrite the file to under about 140 lines. The error text is: *"Rewrite it to under 140 lines now … merge or drop stale entries"*. Before v2.1.210, an over-limit index was truncated silently.
- It is re-injected from disk after `/compact`. ([context-window](https://code.claude.com/docs/en/context-window))
- The main session's auto memory is **not** loaded into subagents. Forks are the exception. ([memory](https://code.claude.com/docs/en/memory#how-it-works))

**Topic files [docs]**

- They load **on demand**. "Claude Code doesn't load topic files … at startup. Claude reads them on demand using its standard file tools." In practice, the index line (title plus hook) is the only thing Claude sees until it chooses to open the file.

**Index line format [observed]**

176 of 178 index lines match `- [Title](file.md) — hook`. No MEMORY.md had frontmatter. 6 of 17 memory dirs had topic files but no MEMORY.md at all.

## 3. Does Claude Code rewrite, merge or delete memories?

- **No background process is documented [docs].** There is no consolidation or dedup job in the memory, claude-directory or settings docs. Changes come from the model itself during a session, using Read, Edit and Write. The UI shows "Saved N memories" or "Recalled N memories" when this happens.
- **Claude is told to merge and drop entries [docs].** The near-limit and over-limit messages explicitly tell the model to "merge or drop stale entries". A long MEMORY.md is therefore the main trigger for the model to rewrite the index. That rewrite could reorder or remove kaizen's index lines.
- **User edits are allowed [docs].** `/memory` lists memory locations, toggles auto memory and opens the folder in your editor. Files are plain markdown that you can edit or delete at any time.
- **Retention sweep [docs].** The `cleanupPeriodDays` sweep does **not** delete memory files. It removes the `memory/` directory only if it has been empty for the whole retention period. Before v2.1.228, the sweep could delete files in subfolders of the memory dir. ([claude-directory](https://code.claude.com/docs/en/claude-directory))
- **Noticing changes.** No hook fires for memory writes. `InstructionsLoaded` covers only `CLAUDE.md` and `.claude/rules` ([hooks](https://code.claude.com/docs/en/hooks#instructionsloaded)). **[unverified]** A PostToolUse hook on `Write|Edit` filtered on the memory path should catch writes, because memory writes go through those tools. Kaizen can also detect drift itself: keep a content hash or `kaizen_id` per file, then on each run diff the directory against its ledger. `metadata.modified`, where present, is a cheap first check.

## 4. `autoMemoryDirectory`, `CLAUDE_CODE_PROJECT_DIR_NAME`, and user-level memory

**Default path [docs]**

The default is `~/.claude/projects/<project>/memory/`. `<project>` "is derived from the git repository, so all worktrees and subdirectories within the same repo share one auto memory directory". Outside git, the project root is used.

The slug is the path with non-alphanumeric characters replaced by `-`. Past 200 characters it is truncated and a hash is appended. ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored))

- **[observed]** On this machine, transcripts get one slug per worktree, but `memory/` exists only under the main repo-root slug. No worktree slug has a `memory/` directory.
- Kaizen must compute the slug from the **git main worktree root**, not from `cwd`. For example, use `git rev-parse --path-format=absolute --git-common-dir` and take its parent directory.

**`autoMemoryDirectory` [docs]**

- A string that is an absolute path or starts with `~/`. It can be set in any settings scope: user, project, local, policy or `--settings`.
- When set in project or local settings, it is honored only under workspace trust.
- If `permissions.blockReadsOutsideWorkingDirectories` is on and a repo-supplied settings file chose the directory, Claude Code neither loads from nor saves to it.
- It replaces the per-project default outright. ([settings-reference](https://code.claude.com/docs/en/settings-reference#automemorydirectory))

**`CLAUDE_CODE_PROJECT_DIR_NAME` [docs]**

- Only honored together with `CLAUDE_CONFIG_DIR`, and ignored otherwise.
- Must be 1–64 characters: letters, digits, `-` and `_`.
- Read only from the launching shell's environment, never from a settings `env` block.
- It replaces the derived `<project>` slug, so memory lives at `$CLAUDE_CONFIG_DIR/projects/<name>/memory/` whatever the cwd is.
- Needs v2.1.234+. ([env-vars](https://code.claude.com/docs/en/env-vars), [sessions](https://code.claude.com/docs/en/sessions#name-the-project-directory-yourself))

**How the two interact [unverified]**

No doc states the precedence. The likely reading: `CLAUDE_CODE_PROJECT_DIR_NAME` only renames the `<project>` segment of the *default* path, and `autoMemoryDirectory` replaces the whole path. So when `autoMemoryDirectory` is set, it should win. Also note that `CLAUDE_CONFIG_DIR` moves the whole `~/.claude` root.

**Resolution order for kaizen**

1. `autoMemoryDirectory` from the effective settings (policy > `--settings` > local > project > user, subject to trust).
2. Otherwise `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<slug>/memory/`, where `<slug>` is `CLAUDE_CODE_PROJECT_DIR_NAME` if both env vars are set, and otherwise the sanitized git-root path.

**Enable and disable [docs]**

- The `autoMemoryEnabled` setting defaults to `true`. `/memory` toggles it and writes the value to user settings.
- `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` turns auto memory off, and `=0` forces it on. The env var overrides the setting in both directions.
- `--bare`, `CLAUDE_CODE_SIMPLE`, safe mode and `CLAUDE_CODE_DISABLE_CLAUDE_MDS` also disable it.

**User-level memory [docs]**

There is **no user-level auto memory for the main session**. Auto memory is per project, and it is machine-local (not synced across machines or cloud). The cross-project options are:

- `~/.claude/CLAUDE.md`, which is hand-authored instructions and not auto memory.
- **Subagent** memory with `memory: user`, stored at `~/.claude/agent-memory/<agent-name>/` with its own MEMORY.md and the same 200-line / 25KB rule. It is separate from the main session's memory. ([sub-agents](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory))

A common trick is to point `autoMemoryDirectory` in *user* settings at one fixed path. That gives shared memory across all projects, but it replaces per-project memory rather than adding to it. **[unverified: this is inferred from the setting's semantics]**

## Implications for kaizen

- **Match the current shape.** Keep writing `name`, `description` and `metadata.type: feedback`. Optionally add `metadata.node_type: memory` so kaizen's files look the same as native ones. Don't write `modified` or `originSessionId` yourself; Claude Code owns those.
- **Ledger keys.** Put them under `metadata`, for example `metadata.kaizen_id` and `metadata.kaizen_placed`. They survived Claude's Edit-based updates in testing. Still treat them as best-effort: the ledger file in kaizen's own storage should be the source of truth, and the frontmatter key is only a join key. If the key goes missing, re-match by filename and `name`.
- **Index budget.** Only the first 200 lines / 25KB of MEMORY.md load. Keep kaizen's index lines to one each in `- [Title](file.md) — hook` form. Hygiene should flag any index near 140 lines, because at that size Claude Code will push the model to merge or drop lines, and kaizen's lines may be among them.
- **Topic files are read on demand.** The hook text in the index line decides whether a lesson is ever recalled. Rubric-check the hook, not just the body.
- **HTML comments in MEMORY.md are free.** Block-level `<!-- -->` comments are stripped before load and don't count toward the limit. Kaizen could use one as a marker, such as `<!-- kaizen:v1 -->`, without spending context. The model may still delete it on a rewrite, so don't store anything important only there.
- **Detect drift, don't assume ownership.** Nothing in Claude Code notifies anyone of memory changes. Each run, diff the memory dir against the ledger (hash per file) to spot edits, merges and deletes by Claude or the user. Optionally ship a PostToolUse `Write|Edit` hook filtered on the memory path **[unverified]**.
- **Path resolution.** Compute the directory in this order: `autoMemoryDirectory` first, then `CLAUDE_CONFIG_DIR` plus `CLAUDE_CODE_PROJECT_DIR_NAME`, then the git-common-dir root slug. Never use the cwd slug, because worktrees don't get their own memory dir. Honor `autoMemoryEnabled: false` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY` by falling back to propose mode.
- **Handle legacy files and missing indexes.** Hygiene must read legacy files where `type` is at the top level, and must cope with memory dirs that have no MEMORY.md.
- **No user-level target.** Lessons that apply across projects can't go to "user auto memory". Either write them into every project or propose them for `~/.claude/CLAUDE.md`.
