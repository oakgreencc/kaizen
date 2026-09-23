// @ts-check
/**
 * Shared plumbing for the kaizen scripts: where Claude Code keeps things, how a
 * transcript is read, and which project a session belongs to.
 *
 * Nothing here knows about any particular repository. Every path is derived
 * from the environment (`CLAUDE_CONFIG_DIR`, the working directory, git) so the
 * same scripts work for anyone who installs the skill.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const HOME = homedir()

/** `~/.claude`, or wherever `CLAUDE_CONFIG_DIR` moved it. */
export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude')
}

export function projectsDir() {
  return join(configDir(), 'projects')
}

/**
 * Claude Code's directory name for a working directory: every character that
 * is not ASCII alphanumeric becomes `-`. Lossy (`/`, `.`, `_` all collide), so
 * it is only ever used to *find* a directory, never to recover a path from one.
 * @param {string} path
 */
export function slugFor(path) {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

/** @param {string} path */
export function toHomeRelative(path) {
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path
}

/** @param {string} path */
export function expandHome(path) {
  return path === '~' || path.startsWith('~/') ? HOME + path.slice(1) : path
}

/** A worktree Claude Code created: `<repo>/.claude/worktrees/<name>`. */
const CLAUDE_WORKTREE_RE = /^(.*?)\/\.claude\/worktrees\/([^/]+)/

/** @type {Map<string, string>} */
const rootCache = new Map()

/**
 * The main checkout a directory belongs to — the key Claude Code files a
 * repository's auto memory under, shared by its worktrees and subdirectories.
 *
 * Asks git first (`--git-common-dir` points at the main checkout's `.git` even
 * from a linked worktree). A directory that no longer exists, or is not a
 * repository, falls back to stripping a `.claude/worktrees/<name>` suffix,
 * which is right for the worktrees Claude Code makes itself.
 * @param {string} cwd
 */
export function repoRoot(cwd) {
  const hit = rootCache.get(cwd)
  if (hit !== undefined) return hit
  let root = cwd
  const wt = CLAUDE_WORKTREE_RE.exec(cwd)
  if (wt) root = wt[1]
  if (existsSync(cwd)) {
    const res = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const common = res.status === 0 ? res.stdout.trim() : ''
    if (common && basename(common) === '.git') root = dirname(common)
  }
  rootCache.set(cwd, root)
  return root
}

/**
 * The auto-memory directory Claude Code loads for sessions in `cwd`.
 *
 * Resolution follows Claude Code's: an `autoMemoryDirectory` setting wins
 * (project local, then project, then user settings), then
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, then the slug of the repository root.
 * A slug past 200 characters is truncated and suffixed with a hash we cannot
 * reproduce, so it is matched by prefix against what exists on disk.
 * @param {string} cwd
 */
export function memoryDirFor(cwd) {
  const root = repoRoot(cwd)
  for (const file of [
    join(root, '.claude', 'settings.local.json'),
    join(root, '.claude', 'settings.json'),
    join(configDir(), 'settings.json'),
  ]) {
    const dir = readJson(file).autoMemoryDirectory
    if (typeof dir === 'string' && dir) return expandHome(dir)
  }
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) {
    return join(projectsDir(), process.env.CLAUDE_CODE_PROJECT_DIR_NAME, 'memory')
  }
  let slug = slugFor(root)
  if (slug.length > 200 && existsSync(projectsDir())) {
    const prefix = slug.slice(0, 200)
    slug = readdirSync(projectsDir()).find((d) => d.startsWith(prefix)) ?? slug
  }
  return join(projectsDir(), slug, 'memory')
}

/**
 * Every transcript line with the byte offset it starts at, so a session that
 * grew after it was analysed can be re-read from where the last run stopped.
 * Torn or non-JSON lines (a session still being written) are skipped.
 * @param {string} path
 * @returns {{ entry: any, offset: number }[]}
 */
export function readJsonl(path) {
  const buf = readFileSync(expandHome(path))
  const out = []
  let start = 0
  while (start < buf.length) {
    let end = buf.indexOf(10, start)
    if (end === -1) end = buf.length
    const line = buf.toString('utf8', start, end).trim()
    if (line) {
      try {
        const entry = JSON.parse(line)
        if (entry && typeof entry === 'object') out.push({ entry, offset: start })
      } catch {
        // torn line
      }
    }
    start = end + 1
  }
  return out
}

/**
 * The text of a message's content, whether it is a bare string or an array of
 * blocks. `first` returns only the first text block.
 * @param {unknown} content
 * @param {{ first?: boolean }} [opts]
 */
export function messageText(content, { first = false } = {}) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && block.text) {
      if (first) return String(block.text)
      parts.push(String(block.text))
    }
  }
  return parts.join('\n')
}

/** @param {unknown} content */
export function toolResultText(content) {
  if (typeof content === 'string') return content
  return messageText(content)
}

/**
 * Every top-level session transcript under the projects dir.
 * Subagent transcripts live one level deeper and are deliberately excluded:
 * their "user" turns are a parent agent's prompts, not a human's.
 * @returns {{ path: string, slug: string }[]}
 */
export function listTranscripts() {
  const root = projectsDir()
  if (!existsSync(root)) return []
  const out = []
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    let files
    try {
      files = readdirSync(join(root, dir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const f of files) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        out.push({ path: join(root, dir.name, f.name), slug: dir.name })
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * @param {string} s
 * @param {number} max
 */
export function clip(s, max) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ---------------------------------------------------------------------------
// Configuration

/**
 * @typedef {object} Config
 * @property {'project' | 'all'} scope  Which sessions to read.
 * @property {string | null} match  Regex over project directory names; overrides scope.
 * @property {string} out  Where reports and status.json live.
 * @property {'auto' | 'propose'} memory  Write feedback memories, or only list them.
 * @property {boolean} rename  Stamp the run's session `Kaizen YYYYMMDD` (best-effort).
 * @property {string | null} since  Ignore sessions that started before this day.
 * @property {string[]} skipCommands  Commands whose sessions are self-referential.
 * @property {string} cwd  The directory the run started in.
 * @property {string} root  Its repository root.
 */

export const DEFAULTS = {
  scope: /** @type {const} */ ('project'),
  match: null,
  out: null,
  memory: /** @type {const} */ ('auto'),
  rename: false,
  since: null,
  skipCommands: ['kaizen'],
}

/** @param {string} path */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Resolve the run's configuration: defaults, then `~/.claude/kaizen.json`, then
 * `<repo>/.claude/kaizen.json`, then command-line arguments. A relative `out`
 * is relative to the repository root.
 *
 * Arguments are what the human typed after `/kaizen`, so they are forgiving:
 * `all`, `project`, `dry-run`, `since 2026-09-01` and their `--flag` spellings
 * all work.
 * @param {string[]} argv
 * @param {string} [cwd]
 * @returns {Config}
 */
export function resolveConfig(argv, cwd = process.cwd()) {
  const root = repoRoot(cwd)
  const cfg = {
    ...DEFAULTS,
    ...readJson(join(configDir(), 'kaizen.json')),
    ...readJson(join(root, '.claude', 'kaizen.json')),
  }
  const args = argv.flatMap((a) => a.split(/\s+/)).filter(Boolean)
  for (let i = 0; i < args.length; i++) {
    const a = args[i].replace(/^--?/, '')
    const [key, inline] = a.includes('=') ? a.split(/=(.*)/s) : [a, undefined]
    const value = () => inline ?? args[++i]
    if (key === 'all' || key === 'project') cfg.scope = key
    else if (key === 'scope') cfg.scope = value()
    else if (key === 'match') cfg.match = value()
    else if (key === 'out') cfg.out = value()
    else if (key === 'since') cfg.since = value()
    else if (key === 'dry-run' || key === 'propose') cfg.memory = 'propose'
    else if (key === 'rename') cfg.rename = true
    else if (key === 'skip-command') cfg.skipCommands = [...cfg.skipCommands, value()]
  }
  if (cfg.scope !== 'project' && cfg.scope !== 'all') {
    throw new Error(`scope must be "project" or "all", got ${cfg.scope}`)
  }
  if (cfg.since && !/^\d{4}-\d{2}-\d{2}$/.test(cfg.since)) {
    throw new Error(`since must be YYYY-MM-DD, got ${cfg.since}`)
  }
  let out = cfg.out ? expandHome(cfg.out) : null
  if (!out) {
    // Each scope keeps its own status.json, so switching scope never marks
    // sessions as analysed that the other scope has not seen.
    const key = cfg.match ? `match-${slugFor(cfg.match)}` : cfg.scope === 'all' ? 'all' : slugFor(root)
    out = join(configDir(), 'kaizen', key)
  } else if (!isAbsolute(out)) {
    out = resolve(root, out)
  }
  return { ...cfg, out, cwd, root }
}
