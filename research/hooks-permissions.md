# What hooks and permission rules can enforce

Research for [#3](https://github.com/oakgreencc/kaizen/issues/3) (part of #1). Question: which kinds of lesson can a Claude Code hook or permission rule enforce, instead of a memory advising them?

Sources: the official Claude Code docs, read on 2026-09-22 as Markdown (`<page>.md`). Version-specific behaviour is noted where the docs give a version. Anything not stated in those pages is marked **unverified**.

- Hooks reference: https://code.claude.com/docs/en/hooks
- Hooks guide: https://code.claude.com/docs/en/hooks-guide
- Permissions: https://code.claude.com/docs/en/permissions
- Settings: https://code.claude.com/docs/en/settings
- Permission modes (auto mode, protected paths): https://code.claude.com/docs/en/permission-modes
- Auto mode config: https://code.claude.com/docs/en/auto-mode-config
- Plugins reference: https://code.claude.com/docs/en/plugins-reference
- Skills: https://code.claude.com/docs/en/skills

## TL;DR

- Hooks and permission rules only see **events**: a tool call, a prompt, a turn ending, a session starting or ending, a config change. A lesson can be enforced only if breaking it shows up as one of those events and a script or rule can recognise it.
- **Permission rules** (`deny`/`ask`) are the hard layer, but they match only the command text as Claude writes it. `Bash(git push *)` does not catch `git -C . push`. They cannot express conditions like "on branch main".
- **PreToolUse hooks** can inspect the full tool input with any logic, then deny it (Claude gets the reason), force a prompt, or rewrite the input. They are the right tool for lessons like "do X instead of Y".
- **Stop hooks** can refuse to let a turn end ("you left a worktree behind", "tests weren't run"). They cannot change text Claude has already written. That means lessons about response style, such as "yes/no first", can only be nagged after the fact, never prevented.
- **Plugins can ship hooks but not permission rules.** A plugin's `settings.json` supports only `agent` and `subagentStatusLine`. A skill can declare frontmatter hooks, `allowed-tools` and `disallowed-tools`, but these last only for the session or turn, not permanently.
- For kaizen, the safe way to propose an enforcement is to **print a snippet or write it only after the user confirms**. `.claude/` is a protected path, so an unprompted write gets a permission prompt, or goes to the classifier in auto mode.

## 1. Hook events: what each can block, modify or inject

Each hook handler is one of five types: `command`, `http`, `mcp_tool`, `prompt` (a single-turn LLM judgement, Haiku by default) or `agent` (a subagent verifier with tools, experimental). Matching handlers run in parallel. ([hooks § Hook handler fields](https://code.claude.com/docs/en/hooks#hook-handler-fields))

Hooks signal in two ways: exit code 2 with a message on stderr, or JSON on stdout. What exit 2 does depends on the event ([hooks § Exit code 2 behavior per event](https://code.claude.com/docs/en/hooks#exit-code-2-behavior-per-event)). The JSON fields are listed in [hooks § Decision control](https://code.claude.com/docs/en/hooks#decision-control).

| Event | Fires | Block? | Modify | Inject context for Claude |
|---|---|---|---|---|
| `SessionStart` | Session start, resume, fork | No | No (can set `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`) | Yes, `additionalContext` at the start of the conversation |
| `UserPromptSubmit` | Before Claude sees a prompt | Yes, erases the prompt | **Cannot rewrite the prompt** | Yes, alongside the prompt |
| `UserPromptExpansion` | A slash command expands | Yes | No | Yes |
| `PreToolUse` | Before any tool call | **Yes**: `permissionDecision` `allow`/`deny`/`ask`/`defer`. With several hooks, precedence is deny > defer > ask > allow | **Yes**: `updatedInput` replaces the tool input | Yes, next to the tool result |
| `PermissionRequest` | A permission prompt would show | Deny via `decision.behavior` (exit 2 is ignored) | `updatedInput`. Can also apply permission rules so the user isn't asked again | No |
| `PermissionDenied` | Auto mode denied a call | No (already denied) | `retry: true` tells the model it may retry | No |
| `PostToolUse` | Tool succeeded | No (tool already ran). `decision: "block"` feeds the reason to Claude | **Yes**: `updatedToolOutput` replaces the result; `classifierContext` annotates the result for auto mode | Yes |
| `PostToolUseFailure` | Tool failed | No | No | Yes |
| `PostToolBatch` | After a batch of parallel calls | Yes, stops the loop before the next model call | No | Yes |
| `Stop` / `SubagentStop` | Claude (or a subagent) finishes its turn | **Yes**: `decision: "block"` + `reason` makes Claude keep working. Capped at 8 consecutive blocks; input includes `stop_hook_active` and `last_assistant_message` | No | Yes, `additionalContext` ("Stop hook feedback") |
| `TaskCreated` / `TaskCompleted` / `TeammateIdle` | Task list and agent team events | Yes | No | Via the reason |
| `ConfigChange` | A user, project, local or skills settings file changes | Yes, except managed policy. The block is silent | No | No |
| `PreCompact` | Before compaction | Yes | No | No |
| `WorktreeCreate` / `WorktreeRemove` | Claude-managed worktree create or remove | Non-zero exit fails the operation | Create replaces the default git behaviour | No |
| `PreModelSwitch` | Before a requested model switch | Yes | No | No |
| `MessageDisplay` | While assistant text streams | No | `displayContent` changes **only what is displayed on screen**. The transcript and what Claude sees keep the original | No |
| `SessionEnd`, `Notification`, `PostCompact`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `StopFailure`, `Setup` | Side effects only | No | No | No |

(Source: [hooks § Hook lifecycle](https://code.claude.com/docs/en/hooks#hook-lifecycle) plus the per-event sections.)

Points that matter for kaizen:

- **PreToolUse is the main enforcement point.** It runs before the permission prompt for every tool except `EndConversation`. A hook that exits 2 blocks the call *before* permission rules are evaluated, so it overrides an allow rule. A hook's `"allow"` cannot override a deny or ask rule. ([permissions § Extend permissions with hooks](https://code.claude.com/docs/en/permissions#extend-permissions-with-hooks))
- **A hook's `"ask"` forces a prompt even in auto mode.** The classifier can still deny the call, but it can't approve it silently (v2.1.211+). ([hooks § PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control))
- The **`if` field** on a handler filters with permission-rule syntax such as `"Bash(git push *)"`. The docs describe the filter as best-effort: "use the permission system rather than a hook to enforce a hard allow or deny". ([hooks § Common fields](https://code.claude.com/docs/en/hooks#common-fields))
- **Prompt hooks** handle judgement calls. On `Stop`, `ok:false` sends `reason` back to Claude and it keeps working. On `PreToolUse`, `ok:false` denies the call; with `continueOnBlock: true` Claude gets the reason as a tool error and continues. ([hooks-guide § Prompt-based hooks](https://code.claude.com/docs/en/hooks-guide#prompt-based-hooks))
- `additionalContext` text should be written as facts, not imperatives. Text phrased like a system command can trigger prompt-injection defenses. For instructions that never change, the docs recommend CLAUDE.md over a hook. ([hooks § Add context for Claude](https://code.claude.com/docs/en/hooks#add-context-for-claude))

## 2. Permission rules

**Kinds and order.** The three kinds are `allow`, `ask` and `deny`. They are evaluated deny first, then ask, then allow, and the first match wins. A more specific rule gets no priority: a deny on `Bash(aws *)` beats an allow on `Bash(aws s3 ls)`. The docs say: "Permission rules are enforced by Claude Code, not by the model." ([permissions § Manage permissions](https://code.claude.com/docs/en/permissions#manage-permissions))

**Syntax.** Rules are written `Tool` or `Tool(specifier)`.
- Bash: a `*` wildcard can go anywhere. `Bash(ls *)` does not match `lsof`. `:*` is an alias for a trailing wildcard.
- Compound commands are split on `&&`, `||`, `;`, `|` and newlines. Deny and ask rules also match subcommands inside `$()`, subshells and loops.
- A fixed list of wrappers is stripped before matching: `timeout`, `nice`, `nohup`, bare `xargs` and others.
- **A Bash rule does not match other ways of invoking the same program.** `Bash(git push *)` misses `git -C . push`, `git -c … push` and `/usr/bin/git push`. The docs call deny and ask rules "not a security boundary around the program". ([permissions § What a Bash rule doesn't match](https://code.claude.com/docs/en/permissions#bash-rule-limits))
- Read and Edit use gitignore-style paths. WebFetch uses `domain:`.
- MCP: `mcp__server`, `mcp__server__*` or `mcp__server__tool`. Allow globs must begin with a literal `mcp__<server>__`. `mcp__` rules with parentheses are skipped when they come from settings files.
- Agents: `Agent(Name)`.
- Deny and ask rules can also match a scalar input parameter (`Agent(isolation:worktree)`, `Bash(run_in_background:true)`), but not a tool's main content field. ([permissions § Permission rule syntax](https://code.claude.com/docs/en/permissions#permission-rule-syntax))
- A deny rule with a bare tool name removes the tool from Claude's context entirely.

**Where rules live and precedence.** Rules live in managed settings, `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json` and CLI flags, under the normal settings precedence. **A deny at any level cannot be overridden by an allow at any other level.** ([permissions § Settings precedence](https://code.claude.com/docs/en/permissions#settings-precedence))

**Workspace trust.** A project's `.claude/settings.json` `allow` rules apply only after the user accepts the workspace trust dialog. **`deny` and `ask` rules apply immediately, because they only restrict.** ([permissions § Project allow rules and workspace trust](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust))

**Live reload.** Claude Code watches settings files and applies edits to `permissions` and `hooks` without a restart. ([settings § When edits take effect](https://code.claude.com/docs/en/settings#when-edits-take-effect))

### Auto mode: can an allow rule pre-empt the classifier?

**Mostly yes.** Auto mode's decision order is ([permission-modes § How the classifier evaluates actions](https://code.claude.com/docs/en/permission-modes#how-the-classifier-evaluates-actions)):

1. Allow, ask and deny rules resolve first, and the classifier never sees the call. Exceptions: protected-path writes, critical-path `rm`, commands with per-command network domains, and `requiresUserInteraction` MCP tools.
2. Reads and working-directory edits are auto-approved.
3. Everything else goes to the classifier.

Caveats:

- **When auto mode starts, broad allow rules are dropped**: `Bash(*)`, wildcarded interpreters, package-manager run commands, `Agent` allow rules and `Monitor` allow rules. Narrow rules such as `Bash(npm test)` stay. With `autoMode.classifyAllShell: true`, every shell allow rule is suspended. ([auto-mode-config § Route all shell commands through the classifier](https://code.claude.com/docs/en/auto-mode-config#route-all-shell-commands-through-the-classifier))
- **In the other direction,** a deny rule or a hook's `"ask"` beats the classifier. Where a rule could do the job, the docs recommend it over conversational boundaries: boundaries stated in conversation are re-read from the transcript and "can be lost if context compaction removes the message". ([permission-modes § Boundaries you state in conversation](https://code.claude.com/docs/en/permission-modes#boundaries-you-state-in-conversation))
- The classifier has its own prose rules: `autoMode.allow`, `soft_deny`, `hard_deny` and `environment`. **It reads them only from user settings, managed settings or `--settings`, never from project settings.** It does read CLAUDE.md, so a CLAUDE.md line like "never force push" steers both Claude and the classifier. ([auto-mode-config § Where the classifier reads configuration](https://code.claude.com/docs/en/auto-mode-config#where-the-classifier-reads-configuration))
- **Auto mode allows pushes to any branch of the working repo by default, including the default branch** (v2.1.211+). So "never push to main" is *not* covered by the classifier. It needs a deny rule, a hook, or a CLAUDE.md or `soft_deny` boundary. ([permission-modes § What the classifier blocks by default](https://code.claude.com/docs/en/permission-modes#what-the-classifier-blocks-by-default))
- A `PermissionDenied` hook receives the exact `tool_input` of every auto-mode denial. That makes it a clean source of friction data for kaizen's extractor. ([auto-mode-config § Review denials](https://code.claude.com/docs/en/auto-mode-config#review-denials))

## 3. Classification of representative lessons

Legend:
- **Rule**: enforceable by a `permissions.deny`/`ask` entry.
- **Hook**: enforceable by a hook script.
- **Advisory**: memory or CLAUDE.md only.

"Hook (nag)" means the hook can detect the violation after the fact and make Claude fix it before the turn ends, but cannot prevent it.

| Lesson | Class | Mechanism | Limits |
|---|---|---|---|
| Never push to main | **Hook**, with Rule as a cheap partial | `PreToolUse` on `Bash` with `if: "Bash(git push *)"`: parse the refspec and check `git rev-parse --abbrev-ref HEAD`, then deny with a reason. Cheap partial: `deny: ["Bash(git push * main)", "Bash(git push origin HEAD:main)"]` | A rule can't see the current branch, so a bare `git push` while on main slips past, and so do `git -C` forms. Auto mode allows the push by default. Branch protection on the server is the real guarantee |
| Remove your worktree when done | **Hook (nag)** | `Stop` (or `SubagentStop`) command hook: run `git worktree list` and compare against worktrees that existed at `SessionStart` (saved by a SessionStart hook). If any are left, `decision: "block"` with the reason "worktree X still exists". Use `stop_hook_active` to avoid loops | Needs a baseline to tell which worktrees are this session's. Claude-managed worktrees (`--worktree`, `isolation: "worktree"`) already get cleaned up via `WorktreeRemove` |
| Answer a yes/no question with the word first | **Advisory** (Hook nag possible) | A `Stop` prompt hook could judge `last_assistant_message` against the user's question and return `ok:false` so Claude adds a correction | The user has already seen the original text: a hook can't rewrite a reply. `MessageDisplay` changes only what's on screen. Costs an LLM call per turn. Keep it as memory or CLAUDE.md |
| Use the existing CI poller script | **Hook** (Rule partial) | `PreToolUse` on `Bash` matching `gh run watch`, `gh pr checks --watch`, or `sleep N && gh …` loops: deny with reason "use `scripts/ci-poll.sh <run>`". The hook can also rewrite the call with `updatedInput`. Partial rule: `deny: ["Bash(gh run watch *)"]`, but then Claude gets a generic denial and has to guess the alternative | Hand-rolled polling loops take too many forms for rules to match. Heuristics in a hook work better |
| Don't edit generated files (for example `dist/**`) | **Rule** | `deny: ["Edit(dist/**)", "Write(dist/**)"]`. Or a `PreToolUse` hook, so the reason can name the source file to edit instead | A Bash `sed -i` on the file bypasses the Edit rule. Add a `FileChanged` or PostToolUse check if that matters |
| Don't skip commit hooks or signing (`--no-verify`, `--no-gpg-sign`, `-c commit.gpgsign=false`) | **Rule** (Hook for full coverage) | `deny: ["Bash(git commit *--no-verify*)", "Bash(git commit *--no-gpg-sign*)"]`. A hook catches `-c` config forms | `git -c … commit` forms slip past the rule |
| Run tests or typecheck before saying "done" | **Hook** | `Stop` command hook: if files changed this turn and tests weren't run (or fail), block with a reason. Or a `TaskCompleted` hook | Needs a cheap way to detect "files changed", such as `git status` |
| Format or lint after editing | **Hook** | `PostToolUse` on `Edit\|Write` runs the formatter. This is a side effect, so the model doesn't need to remember | None |
| Don't use `sleep` polling or background shells for X | **Rule** | `deny: ["Bash(run_in_background:true)"]` or `ask` rules; `Bash(sleep *)` | Blunt: it blocks legitimate uses too |
| Don't call MCP tool X / use subagent Y | **Rule** | `deny: ["mcp__server__tool"]`, `deny: ["Agent(Explore)"]`. A bare-name deny removes the tool from context entirely | None |
| Don't read or print `.env` secrets | **Rule** | `deny: ["Read(./.env*)"]` plus `Bash(cat .env*)` | Other ways of reading the file (for example `python -c`) need the sandbox or a hook |
| Ask before destructive git (`reset --hard`, `clean -fd`) | **Rule** (`ask`) | `ask: ["Bash(git reset --hard*)", "Bash(git clean *)"]`. Ask rules prompt even in auto mode | None |
| Keep reports concise, write in a particular voice, be less sycophantic | **Advisory** | CLAUDE.md or memory | No event carries the property before the user sees it |
| Read the existing X before designing Y / check CI before claiming green | **Advisory**, or Hook nag via a `Stop` prompt hook | Judgement about process, not a single tool call | A prompt-hook judge is possible but expensive and noisy |

Rules of thumb for kaizen's classifier:
1. **A tool call with a recognisable command prefix, path or tool name → Rule**, if the "don't" is unconditional and the reason is obvious.
2. **A tool call that needs context (current branch, file state, a better alternative to point to) → PreToolUse hook**, which can include the "instead, do X" reason.
3. **"Before finishing, make sure …" → Stop hook** that checks state and blocks with a reason. Nag-grade only.
4. **Anything about the text of Claude's reply, tone, or judgement → Advisory.**

## 4. Plugins and skills: can they ship hooks and rules?

**Plugins:**
- **Hooks: yes.** Ship them in `hooks/hooks.json` at the plugin root, or inline in `plugin.json`. All events and all five handler types are supported, and `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's own scripts. The hooks are active while the plugin is enabled. ([plugins-reference § Hooks](https://code.claude.com/docs/en/plugins-reference#hooks))
- **Permission rules: no.** A plugin's `settings.json` supports only the `agent` and `subagentStatusLine` keys. ([plugins-reference § File locations reference](https://code.claude.com/docs/en/plugins-reference#file-locations-reference))
- **Plugin agents** cannot use `hooks`, `mcpServers` or `permissionMode`. ([plugins-reference § Agents](https://code.claude.com/docs/en/plugins-reference#agents))
- A plugin's `"ask"` prompts are labelled `[plugin:<name>]`. ([hooks § PreToolUse decision control](https://code.claude.com/docs/en/hooks#pretooluse-decision-control))
- Under managed `allowManagedHooksOnly`, plugin hooks are blocked unless the plugin is force-enabled. ([hooks § Hook locations](https://code.claude.com/docs/en/hooks#hook-locations))

**Skills:**
- Frontmatter `hooks` are registered when the skill is invoked and stay for the rest of the session. `once: true` removes a hook after its first successful run. ([hooks § Hooks in skills and agents](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents))
- `allowed-tools` pre-approves tools and `disallowed-tools` removes tools, **only until the user's next message**. ([skills § Frontmatter reference](https://code.claude.com/docs/en/skills#frontmatter-reference))
- None of this is persistent enforcement. It lasts only for the skill's own run or session.
- **Unverified:** whether frontmatter hooks in a *plugin-shipped* skill behave the same as in a project or user skill. The docs describe skill frontmatter hooks in general and don't carve out plugin skills.

**Can a skill propose them safely?**

- **Edit the settings file directly:** it works, and the change applies live. But `.claude/` is a **protected path**. Writes to it prompt in default and acceptEdits modes, go to the classifier in auto mode, and are denied in dontAsk mode. An allow rule such as `Edit(.claude/**)` does not pre-approve them. ([permission-modes § Protected paths](https://code.claude.com/docs/en/permission-modes#protected-paths))
  - `ConfigChange` hooks fire on the edit, and a user may have one that blocks it silently.
  - **Unverified:** whether `~/.claude/settings.json` counts as a protected-path write. The protected-directory list says `.claude` without an anchor, so it probably matches the home directory too.
- **Print a snippet:** always safe, and the user owns the change. This fits kaizen's existing pattern of proposing `~/.claude/CLAUDE.md` lines for the user to accept.
- **Scope matters:**
  - `deny` and `ask` rules in project `.claude/settings.json` take effect without trust and are shared with everyone who clones the repo.
  - Personal lessons belong in `~/.claude/settings.json`, or in `.claude/settings.local.json`, which applies without trust when untracked.
  - Hooks in project settings run even in untrusted `-p` sessions, so a committed hook runs for every collaborator. ([permissions § What runs before you trust a folder](https://code.claude.com/docs/en/permissions#what-runs-before-you-trust-a-folder))
- **Merging is non-trivial.** Hook entries merge across levels. Rules from any level combine, with deny first. A writer must merge into existing JSON arrays, not overwrite them.

## Implications for kaizen

- Add an **enforcement tier to the placement ladder** with three outcomes: `rule` (deny or ask), `hook` (PreToolUse, Stop or PostToolUse) and `advisory`. Classify with the four rules of thumb in §3. Default to advisory unless the violation shows up as a specific tool call or as state a script can check at Stop.
- **Recommend a rule only when the "don't" is unconditional and the reason is obvious.** Otherwise recommend a PreToolUse hook, because it can send Claude the "use X instead" reason; a bare deny leaves Claude guessing. Always note the other invocation forms a Bash rule misses.
- **Never auto-write settings in v0.2.** Emit a ready-to-paste JSON snippet (rule or hook block) plus a one-line target file (`~/.claude/settings.json` for personal lessons, project `.claude/settings.json` for team ones). Writing it after explicit confirmation can come later, and has to cope with protected-path prompts, JSON merging and `ConfigChange` hooks.
- **Hook scripts need a home.** Put generated hook scripts in a file the user can review, such as `~/.claude/hooks/kaizen-<slug>.sh` or the repo's `.claude/hooks/`, and have the snippet reference that path. This follows the existing "scripts that should be permanent" lesson type.
- **Consider one generic plugin hook later.** Because kaizen ships as a plugin, it could ship a single data-driven `PreToolUse` hook that reads a kaizen-managed rules file (for example `~/.claude/kaizen/enforce.json` with a pattern, the "instead" reason, and deny or ask). New lessons would then be data edits, not settings edits. The plugin can't ship permission rules, so this is the only way to bundle enforcement. It needs a separate design ticket.
- **Keep the memory when a lesson gets enforced.** In auto mode the classifier reads CLAUDE.md but not project `autoMode` settings. A CLAUDE.md or memory line explains the *why*, and the rule or hook enforces the *what*.
- **Mine enforcement friction as a new signal.** Add a `PermissionDenied` hook, or parse transcripts for hook-deny and rule-deny messages. A lesson that keeps getting denied means the rule is working but Claude doesn't know the alternative, so the reason text or memory needs strengthening.
- **"Never push to main" should be the flagship example:** CLAUDE.md line + deny rule + PreToolUse branch-check hook. Branch protection on the server is the only complete guarantee. Auto mode will *not* stop this push by default.
