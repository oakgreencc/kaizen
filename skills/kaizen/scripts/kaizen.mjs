#!/usr/bin/env node
// @ts-check
/**
 * The deterministic half of /kaizen. The skill does the judgement; this does
 * everything a model gets subtly wrong — paths, dates, filtering, bookkeeping.
 *
 *   kaizen.mjs paths      [args…]            resolved config, memory dir, report path
 *   kaizen.mjs extract    [args…] [--exclude <session-id>]
 *                                            summarise unanalysed sessions → <out>/pending.jsonl
 *   kaizen.mjs chunk      [args…] [--bytes N] split pending.jsonl for parallel analysis
 *   kaizen.mjs transcript <path> [--scripts] [--width N] [--limit N] [--from BYTES]
 *   kaizen.mjs memories   [--dir D | --root R] existing memories: file, name, description
 *   kaizen.mjs mark       [args…] --day YYYY-MM-DD
 *                                            fold pending into status.json, clear pending
 *   kaizen.mjs day                            today, YYYY-MM-DD, local zone
 *   kaizen.mjs title      --session <id> [--prefix Kaizen]
 *                                            best-effort session rename
 *
 * `[args…]` is whatever followed `/kaizen`: `all`, `project`, `since YYYY-MM-DD`,
 * `match <regex>`, `out <dir>`, `dry-run`, `rename`.
 *
 * Zero dependencies; Node 20+.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  expandHome,
  listTranscripts,
  memoryDirFor,
  readJson,
  readJsonl,
  resolveConfig,
  slugFor,
  toHomeRelative,
} from './lib.mjs'
import { isSelfReferential, summarize } from './session.mjs'
import { dayStamp, setSessionTitle, titleFor } from './title.mjs'
import { conversationLines, scriptLines } from './transcript.mjs'

const [, , cmd = 'help', ...rest] = process.argv

/** Pull `--flag value` pairs out of argv, leaving the /kaizen arguments. */
function takeFlags(/** @type {string[]} */ argv, /** @type {string[]} */ names) {
  /** @type {Record<string, string>} */
  const flags = {}
  const left = []
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '')
    if (argv[i].startsWith('--') && names.includes(name)) flags[name] = argv[++i] ?? ''
    else left.push(argv[i])
  }
  return { flags, left }
}

// ---------------------------------------------------------------------------
// status.json

/**
 * @typedef {{ lastRun: string | null, sessions: Record<string, { bytes: number | null, ts: string }> }} Status
 */

/**
 * Read status.json. Also accepts the older `{ analyzed: [{ ts, path }] }`
 * shape; those sessions have no recorded size, so they count as fully read.
 * @param {string} path
 * @returns {Status}
 */
function readStatus(path) {
  const raw = readJson(path)
  /** @type {Status} */
  const status = { lastRun: raw.lastRun ?? null, sessions: { ...(raw.sessions ?? {}) } }
  for (const e of raw.analyzed ?? []) {
    if (typeof e?.path === 'string') status.sessions[e.path] ??= { bytes: null, ts: e.ts ?? '' }
  }
  return status
}

/** @param {string} path @param {Status} status */
function writeStatus(path, status) {
  // Newest first, so the file reads as a log.
  const sorted = Object.entries(status.sessions).sort(([, a], [, b]) => (b.ts ?? '').localeCompare(a.ts ?? ''))
  const body = { version: 2, lastRun: status.lastRun, sessions: Object.fromEntries(sorted) }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameSync(tmp, path)
}

// ---------------------------------------------------------------------------

/** @param {import('./lib.mjs').Config} cfg */
function files(cfg) {
  return {
    status: join(cfg.out, 'status.json'),
    pending: join(cfg.out, 'pending.jsonl'),
    seen: join(cfg.out, 'pending-seen.json'),
  }
}

/** @param {import('./lib.mjs').Config} cfg */
function inScope(cfg) {
  const all = listTranscripts()
  if (cfg.match) {
    const re = new RegExp(cfg.match)
    return { candidates: all.filter((t) => re.test(t.slug)), confirmRoot: null }
  }
  if (cfg.scope === 'all') return { candidates: all, confirmRoot: null }
  // Transcripts are filed by full cwd, so a repo's subdirectories and worktrees
  // each get their own directory — all starting with the repo's slug. The
  // prefix over-includes siblings (`app` vs `app-docs`); the summary's resolved
  // repo root settles it.
  const prefix = slugFor(cfg.root)
  return {
    candidates: all.filter((t) => t.slug === prefix || t.slug.startsWith(`${prefix}-`)),
    confirmRoot: cfg.root,
  }
}

function cmdPaths(/** @type {string[]} */ argv) {
  const cfg = resolveConfig(argv)
  const f = files(cfg)
  const status = readStatus(f.status)
  const day = dayStamp(new Date())
  const out = {
    ...cfg,
    memoryDir: cfg.scope === 'project' && !cfg.match ? memoryDirFor(cfg.cwd) : '(per session: see repoRoot)',
    statusFile: f.status,
    statusExists: existsSync(f.status),
    lastRun: status.lastRun,
    analyzedSessions: Object.keys(status.sessions).length,
    day,
    report: join(cfg.out, `${day}.md`),
  }
  console.log(JSON.stringify(out, null, 2))
}

function cmdExtract(/** @type {string[]} */ argv) {
  const { flags, left } = takeFlags(argv, ['exclude'])
  const cfg = resolveConfig(left)
  const f = files(cfg)
  mkdirSync(cfg.out, { recursive: true })
  const status = readStatus(f.status)
  const { candidates, confirmRoot } = inScope(cfg)
  const sinceMs = cfg.since ? new Date(`${cfg.since}T00:00:00`).getTime() : 0

  const summaries = []
  /** @type {Record<string, { bytes: number, ts: string }>} */
  const seen = {}
  const counts = { selfReferential: 0, noHumanText: 0, outOfScope: 0, beforeSince: 0, resumed: 0, excluded: 0 }

  for (const t of candidates) {
    const key = toHomeRelative(t.path)
    if (flags.exclude && t.path.endsWith(`${flags.exclude}.jsonl`)) {
      counts.excluded += 1
      continue
    }
    const st = statSync(t.path)
    const prior = status.sessions[key]
    if (prior && (prior.bytes === null || st.size <= prior.bytes)) continue
    if (st.mtimeMs < sinceMs) {
      counts.beforeSince += 1
      continue
    }
    const from = prior?.bytes ?? 0
    const s = summarize(t.path, { from })
    const record = { bytes: st.size, ts: s?.started ?? new Date(st.mtimeMs).toISOString() }
    if (s && confirmRoot && s.repoRoot !== confirmRoot) {
      counts.outOfScope += 1
      continue // someone else's project; leave it for their scope
    }
    if (s && sinceMs && s.started && new Date(s.started).getTime() < sinceMs && !from) {
      counts.beforeSince += 1
      continue
    }
    seen[key] = record
    if (!s) counts.noHumanText += 1
    else if (isSelfReferential(s, cfg.skipCommands)) counts.selfReferential += 1
    else {
      if (from) counts.resumed += 1
      summaries.push(s)
    }
  }

  summaries.sort((a, b) => a.started.localeCompare(b.started))
  const body = summaries.map((s) => JSON.stringify(s)).join('\n')
  writeFileSync(f.pending, body ? `${body}\n` : '')
  writeFileSync(f.seen, JSON.stringify(seen))
  const bytes = Buffer.byteLength(body)

  const projects = [...new Set(summaries.map((s) => s.project))].sort()
  console.log(
    JSON.stringify(
      {
        pending: f.pending,
        sessions: summaries.length,
        bytes,
        projects,
        skipped: counts,
        flagged: summaries.filter((s) => s.score > 0).length,
        advice:
          summaries.length === 0
            ? 'no new sessions'
            : bytes > 150_000
              ? 'large: run `chunk` and analyse the chunks in parallel subagents'
              : 'small enough to read directly',
      },
      null,
      2,
    ),
  )
}

function cmdChunk(/** @type {string[]} */ argv) {
  const { flags, left } = takeFlags(argv, ['bytes'])
  const cfg = resolveConfig(left)
  const f = files(cfg)
  const max = Number(flags.bytes ?? 120_000)
  const lines = readFileSync(f.pending, 'utf8').split('\n').filter(Boolean)
  // Keep a project's sessions together where possible: recurrence is easier to
  // see within one chunk than across two.
  lines.sort((a, b) => JSON.parse(a).project.localeCompare(JSON.parse(b).project))
  /** @type {string[][]} */
  const chunks = [[]]
  let size = 0
  for (const line of lines) {
    if (size + line.length > max && chunks.at(-1)?.length) {
      chunks.push([])
      size = 0
    }
    chunks.at(-1)?.push(line)
    size += line.length
  }
  const dir = join(cfg.out, 'chunks')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  chunks.forEach((c, i) => {
    const p = join(dir, `chunk-${String(i + 1).padStart(2, '0')}.jsonl`)
    writeFileSync(p, `${c.join('\n')}\n`)
    console.log(`${p}\t${c.length} sessions`)
  })
}

function cmdTranscript(/** @type {string[]} */ argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      scripts: { type: 'boolean', default: false },
      width: { type: 'string', default: '500' },
      limit: { type: 'string', default: '0' },
      from: { type: 'string', default: '0' },
    },
  })
  const path = positionals[0]
  if (!path) {
    console.error('usage: kaizen.mjs transcript <session.jsonl> [--scripts] [--width N] [--limit N] [--from BYTES]')
    process.exit(2)
  }
  const width = Number(values.width)
  if (!Number.isFinite(width) || width < 8) {
    console.error(`--width must be a number of at least 8, got ${values.width}`)
    process.exit(2)
  }
  const limit = Number(values.limit) || Number.POSITIVE_INFINITY
  const from = Number(values.from) || 0
  const entries = readJsonl(expandHome(path))
  const lines = values.scripts
    ? scriptLines(entries, { width, limit, from })
    : conversationLines(entries, { width, limit, from })
  for (const line of lines) process.stdout.write(`${line}\n`)
}

function cmdMemories(/** @type {string[]} */ argv) {
  const { flags } = takeFlags(argv, ['dir', 'root'])
  const dir = flags.dir ? expandHome(flags.dir) : memoryDirFor(flags.root ? expandHome(flags.root) : process.cwd())
  console.log(`# ${dir}`)
  if (!existsSync(dir)) {
    console.log('(no memory directory yet)')
    return
  }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue
    const text = readFileSync(join(dir, name), 'utf8')
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
    const field = (/** @type {string} */ k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm)?.[1]?.trim() ?? ''
    const type = /^\s+type:\s*(\S+)/m.exec(fm)?.[1] ?? field('type')
    console.log(`${name}\t${field('name') || '-'}\t${type || '-'}\t${field('description')}`)
  }
}

function cmdMark(/** @type {string[]} */ argv) {
  const { flags, left } = takeFlags(argv, ['day'])
  if (!/^\d{4}-\d{2}-\d{2}$/.test(flags.day ?? '')) {
    console.error('usage: kaizen.mjs mark [args…] --day YYYY-MM-DD   (use the output of `kaizen.mjs day`)')
    process.exit(2)
  }
  const cfg = resolveConfig(left)
  const f = files(cfg)
  if (!existsSync(f.seen)) {
    console.error(`nothing pending in ${cfg.out}; run extract first`)
    process.exit(1)
  }
  const status = readStatus(f.status)
  const seen = readJson(f.seen)
  Object.assign(status.sessions, seen)
  status.lastRun = flags.day
  writeStatus(f.status, status)
  rmSync(f.pending, { force: true })
  rmSync(f.seen, { force: true })
  rmSync(join(cfg.out, 'chunks'), { recursive: true, force: true })
  console.log(`marked ${Object.keys(seen).length} session(s); ${Object.keys(status.sessions).length} total; lastRun ${flags.day}`)
}

function cmdTitle(/** @type {string[]} */ argv) {
  const { flags } = takeFlags(argv, ['session', 'prefix'])
  const title = titleFor(flags.prefix || 'Kaizen', new Date())
  console.log(title)
  try {
    if (!flags.session || flags.session.includes('CLAUDE_SESSION_ID')) throw new Error('no session id')
    setSessionTitle(flags.session, title)
  } catch (/** @type {any} */ err) {
    console.error(`could not rename the session (${err.message}); do it by hand: /rename ${title}`)
    process.exitCode = 1
  }
}

const commands = /** @type {Record<string, (argv: string[]) => void>} */ ({
  paths: cmdPaths,
  extract: cmdExtract,
  chunk: cmdChunk,
  transcript: cmdTranscript,
  memories: cmdMemories,
  mark: cmdMark,
  day: () => console.log(dayStamp(new Date())),
  title: cmdTitle,
})

const run = commands[cmd]
if (!run) {
  console.error(`usage: kaizen.mjs <${Object.keys(commands).join('|')}> …`)
  process.exit(cmd === 'help' ? 0 : 64)
}
try {
  run(rest)
} catch (/** @type {any} */ err) {
  console.error(`kaizen ${cmd}: ${err.message}`)
  process.exit(1)
}
