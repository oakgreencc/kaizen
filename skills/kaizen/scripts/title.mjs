// @ts-check
/**
 * The run's date, and (optionally) naming the run's session after it.
 *
 * Every date a run writes — the report filename, its heading, `lastRun` — has
 * to be the same day, and a run that crosses midnight is exactly when a model
 * reading the clock several times gets that wrong. So the day comes from here,
 * once, in the human's local zone: their "the 22nd" is local, and slicing a UTC
 * ISO string would file an evening run under tomorrow.
 *
 * Renaming a session is `/rename`, a slash command a model cannot type. This
 * writes what `/rename` writes — a `custom-title` line appended to the
 * transcript and a `custom-title.json` sidecar beside it (the transcript is
 * read through a bounded tail window, so a long session eventually scrolls a
 * title-only-in-the-transcript out of view). That is an internal format and can
 * change under us, so renaming is opt-in and strictly best-effort: on failure
 * it prints a `/rename …` line for the human and the run carries on.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { projectsDir } from './lib.mjs'

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * `YYYY-MM-DD` for an instant, in `timeZone` (the machine's, by default).
 * @param {Date | string | number} instant
 * @param {{ timeZone?: string }} [opts]
 */
export function dayStamp(instant, { timeZone } = {}) {
  const at = instant instanceof Date ? instant : new Date(instant)
  if (Number.isNaN(at.getTime())) throw new Error(`not a timestamp: ${instant}`)
  // en-CA formats as YYYY-MM-DD; building it from getFullYear() would ignore timeZone.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/**
 * `<Prefix> YYYYMMDD`, built from dayStamp so title and filename cannot disagree.
 * @param {string} prefix
 * @param {Date | string | number} instant
 * @param {{ timeZone?: string }} [opts]
 */
export function titleFor(prefix, instant, opts = {}) {
  const name = prefix.trim()
  if (!name) throw new Error('prefix must be non-empty')
  return `${name} ${dayStamp(instant, opts).replaceAll('-', '')}`
}

/**
 * Where Claude Code keeps a session. Found by UUID across every project
 * directory rather than by re-deriving a slug, which is lossy and differs
 * between worktrees.
 * @param {string} sessionId
 */
export function sessionPaths(sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`)
  const projects = projectsDir()
  if (!existsSync(projects)) return null
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const transcript = join(projects, entry.name, `${sessionId}.jsonl`)
    if (existsSync(transcript)) {
      return { transcript, sidecar: join(dirname(transcript), sessionId, 'custom-title.json') }
    }
  }
  return null
}

/**
 * Set a session's title the way `/rename` does. Throws on a bad argument or an
 * unknown session; never creates a transcript.
 * @param {string} sessionId
 * @param {string} title
 */
export function setSessionTitle(sessionId, title) {
  const trimmed = title.trim()
  if (!trimmed) throw new Error('title must be non-empty')
  const paths = sessionPaths(sessionId)
  if (!paths) throw new Error(`no transcript found for session ${sessionId}`)
  // Appended, not rewritten: Claude Code is appending to this file too, and the
  // last custom-title line wins. One short O_APPEND write does not interleave.
  appendFileSync(paths.transcript, `${JSON.stringify({ type: 'custom-title', customTitle: trimmed, sessionId })}\n`)
  mkdirSync(dirname(paths.sidecar), { recursive: true })
  writeFileSync(paths.sidecar, JSON.stringify({ customTitle: trimmed }))
  return paths
}
