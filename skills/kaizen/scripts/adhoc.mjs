// @ts-check
/**
 * Recognise the ad-hoc programs an agent improvised during a session.
 *
 * An agent that needs a computation the toolchain does not offer writes one on
 * the spot: `python3 -c "…"`, `node -e "…"`, a heredoc piped into an
 * interpreter, or a file under a temp directory that it then runs. Each one
 * dies with the session — not in the repo, not tested, not findable by the next
 * agent with the same need — so the same script gets rewritten, slightly
 * differently, session after session. Kaizen looks for that recurrence.
 *
 * This module is the one place that decides what counts, so the extractor and
 * the transcript reader cannot disagree. It does not decide what *should*
 * become permanent: that needs the task the script performed, which is in the
 * transcript, not the tool call.
 *
 * Deliberately NOT flagged: a `Write` into the project tree (that is either the
 * permanent script this check wants, or an ordinary edit), and pure shell
 * one-liners (`grep`, `jq`, `git log`) — the check is for *programs*, the things
 * that would be a file with a test if they lived in the repo.
 */

/**
 * @typedef {object} ScriptEvent
 * @property {'Bash' | 'Write'} tool
 * @property {'inline' | 'heredoc' | 'file' | 'run'} kind
 *   `inline` — `python3 -c` / `node -e`; `heredoc` — a program fed to an
 *   interpreter through a here-document; `file` — a script written to an
 *   ephemeral path; `run` — an ephemeral script being executed.
 * @property {string} lang  python, node, sh, ruby, …
 * @property {string} description  The tool call's own description, or the
 *   file's basename. This is the task label grouping works from.
 * @property {string} snippet  The program's opening, whitespace-collapsed and capped.
 * @property {string} [path]  For `file` and `run`: the ephemeral path.
 */

/** Directories whose contents die with the session or the machine's next reboot. */
const TMP_PREFIX =
  String.raw`(?:(?:/private)?/tmp/|/private/var/folders/|/var/folders/|\$TMPDIR/?|\$\{TMPDIR\}/?|\$CLAUDE_JOB_DIR/tmp/|/[^\s'"]*/\.claude/jobs/[^/\s]+/tmp/)`
const EPHEMERAL_PATH_RE = new RegExp(`^${TMP_PREFIX}`)

/** A file extension that means "program", not "data". */
const SCRIPT_EXT_RE = /\.(?:py|mjs|cjs|js|ts|sh|zsh|bash|rb|pl)$/

const INTERPRETERS = String.raw`python3?|node|bun|deno|bash|zsh|sh|ruby|perl`

const INLINE_PY_RE = /\bpython3?\s+(?:-[a-zA-Z]+\s+)*-c\s+(['"])([\s\S]*)/
const INLINE_NODE_RE = /\b(?:node|bun)\s+(?:-[a-zA-Z-]+\s+)*(?:-e|--eval|-p|--print)\s+(['"])([\s\S]*)/
const INLINE_RUBY_PERL_RE = /\b(ruby|perl)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*e\s+(['"])([\s\S]*)/
// `--input-type=module` reads the program from stdin, always with a heredoc.
const NODE_STDIN_RE = /\bnode\s+(?:-[a-zA-Z-]+\s+)*--input-type[=\s]/

const HEREDOC_RE = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/
const INTERPRETER_RE = new RegExp(String.raw`\b(${INTERPRETERS})\b`)

// `node /tmp/x.mjs`, `python3 $CLAUDE_JOB_DIR/tmp/y.py`, `bash /private/tmp/z.sh`
const RUN_EPHEMERAL_RE = new RegExp(String.raw`\b(${INTERPRETERS})\s+(${TMP_PREFIX}[^\s;|&'"]+)`)

const SNIPPET_MAX = 200

/**
 * The program inside a shell-quoted `-c '…'` / `-e "…"` argument, up to the
 * closing quote. A single-quoted string has no escapes; a double-quoted one
 * ends at the first `"` not preceded by a backslash.
 * @param {string} quote
 * @param {string} rest  Text following the opening quote.
 */
function quotedBody(quote, rest) {
  if (quote === "'") {
    const end = rest.indexOf("'")
    return end === -1 ? rest : rest.slice(0, end)
  }
  const m = /^(?:[^"\\]|\\.)*/.exec(rest)
  return m ? m[0] : rest
}

/**
 * @param {string} s
 * @param {number} max
 */
function cut(s, max) {
  const collapsed = s.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/** @param {string} path */
function langFromPath(path) {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const map = /** @type {Record<string, string>} */ ({
    py: 'python',
    mjs: 'node',
    cjs: 'node',
    js: 'node',
    ts: 'node',
    zsh: 'sh',
    bash: 'sh',
    rb: 'ruby',
    pl: 'perl',
  })
  return map[ext] ?? ext
}

/** @param {string} interpreter */
function langFromInterpreter(interpreter) {
  if (interpreter.startsWith('python')) return 'python'
  if (interpreter === 'bash' || interpreter === 'zsh') return 'sh'
  if (interpreter === 'bun' || interpreter === 'deno') return 'node'
  return interpreter
}

/**
 * Classify one `tool_use` block. Returns null for the overwhelming majority of
 * calls, which are not scripts.
 * @param {{ name?: string, input?: Record<string, unknown> }} block
 * @param {{ snippetMax?: number }} [opts]  Characters of program text to keep.
 * @returns {ScriptEvent | null}
 */
export function classifyToolUse(block, { snippetMax: max = SNIPPET_MAX } = {}) {
  const input = block.input ?? {}

  if (block.name === 'Write') {
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    if (!EPHEMERAL_PATH_RE.test(path) || !SCRIPT_EXT_RE.test(path)) return null
    const content = typeof input.content === 'string' ? input.content : ''
    return {
      tool: 'Write',
      kind: 'file',
      lang: langFromPath(path),
      description: path.slice(path.lastIndexOf('/') + 1),
      snippet: cut(content, max),
      path,
    }
  }

  if (block.name !== 'Bash') return null
  const command = typeof input.command === 'string' ? input.command : ''
  const description = typeof input.description === 'string' ? input.description : ''

  let m = INLINE_PY_RE.exec(command)
  if (m) {
    return { tool: 'Bash', kind: 'inline', lang: 'python', description, snippet: cut(quotedBody(m[1], m[2]), max) }
  }
  m = INLINE_NODE_RE.exec(command)
  if (m) {
    return { tool: 'Bash', kind: 'inline', lang: 'node', description, snippet: cut(quotedBody(m[1], m[2]), max) }
  }
  m = INLINE_RUBY_PERL_RE.exec(command)
  if (m) {
    return { tool: 'Bash', kind: 'inline', lang: m[1], description, snippet: cut(quotedBody(m[2], m[3]), max) }
  }

  m = RUN_EPHEMERAL_RE.exec(command)
  if (m && SCRIPT_EXT_RE.test(m[2])) {
    return {
      tool: 'Bash',
      kind: 'run',
      lang: langFromInterpreter(m[1]),
      description,
      snippet: cut(command, max),
      path: m[2],
    }
  }

  if (HEREDOC_RE.test(command)) {
    const interp = NODE_STDIN_RE.test(command) ? 'node' : INTERPRETER_RE.exec(command)?.[1]
    // A heredoc with no interpreter is data (an issue body, a JSON payload).
    if (!interp) return null
    return { tool: 'Bash', kind: 'heredoc', lang: langFromInterpreter(interp), description, snippet: cut(command, max) }
  }

  return null
}

/**
 * Every script event in one transcript entry, in order.
 * @param {unknown} entry  A parsed JSONL line.
 * @param {{ snippetMax?: number }} [opts]
 * @returns {ScriptEvent[]}
 */
export function scriptsInEntry(entry, opts = {}) {
  if (!entry || typeof entry !== 'object') return []
  const e = /** @type {{ type?: string, message?: { content?: unknown } }} */ (entry)
  if (e.type !== 'assistant') return []
  const content = e.message?.content
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_use') continue
    const ev = classifyToolUse(block, opts)
    if (ev) out.push(ev)
  }
  return out
}
