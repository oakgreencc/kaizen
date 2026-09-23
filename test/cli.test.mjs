// @ts-check
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { dayStamp, titleFor } from '../skills/kaizen/scripts/title.mjs'
import { assistant, sandbox, toolResult, toolUse, user } from './helpers.mjs'

/** @type {ReturnType<typeof sandbox>} */
let sb
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

// --- transcript --------------------------------------------------------------

test('transcript prints ROLE: first text block, one line per message, with denials', () => {
  const { path } = sb.session([
    user('first\nline'),
    assistant('ok'),
    toolUse('Bash', { command: 'rm x' }, 'd1'),
    toolResult('d1', "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nkeep x"),
  ])
  const res = sb.run(['transcript', path])
  assert.equal(res.stdout, 'USER: first\\nline\nASSI: ok\nDENY: keep x\n')
})

test('transcript honours --width, --limit and --scripts', () => {
  const { path } = sb.session([
    user('a'.repeat(50)),
    assistant('b'),
    toolUse('Bash', { command: `python3 -c '${'y'.repeat(300)}'`, description: 'count things' }),
  ])
  assert.equal(sb.run(['transcript', path, '--width', '10', '--limit', '1']).stdout, `USER: ${'a'.repeat(9)}…\n`)
  const scripts = sb.run(['transcript', path, '--scripts', '--width', '1000']).stdout.split('\n')
  assert.equal(scripts[0], '#1 Bash inline python — count things')
  assert.equal(scripts[1].trim().length, 300)
})

test('transcript refuses to run without a path', () => {
  assert.equal(sb.run(['transcript']).status, 2)
})

// --- config ---------------------------------------------------------------------

test('paths reads the repo config file, and arguments override it', () => {
  mkdirSync(join(sb.repo, '.claude'), { recursive: true })
  writeFileSync(join(sb.repo, '.claude', 'kaizen.json'), JSON.stringify({ out: 'docs/kaizen', memory: 'propose' }))
  const p = sb.run(['paths']).json()
  assert.equal(p.out, join(sb.repo, 'docs', 'kaizen'))
  assert.equal(p.memory, 'propose')
  assert.equal(sb.run(['paths', 'out', '/abs/x']).json().out, '/abs/x')
})

test('paths resolves the memory dir from the repo root, even from a worktree', () => {
  const wt = join(sb.repo, '.claude', 'worktrees', 'w1')
  mkdirSync(wt, { recursive: true })
  const slug = sb.repo.replace(/[^a-zA-Z0-9]/g, '-')
  assert.equal(sb.run(['paths'], { cwd: wt }).json().memoryDir, join(sb.config, 'projects', slug, 'memory'))
})

test('an autoMemoryDirectory setting wins', () => {
  mkdirSync(join(sb.repo, '.claude'), { recursive: true })
  writeFileSync(join(sb.repo, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '/mem/here' }))
  assert.equal(sb.run(['paths']).json().memoryDir, '/mem/here')
})

test('a bad scope or since is refused', () => {
  assert.equal(sb.run(['paths', 'scope', 'everything']).status, 1)
  assert.equal(sb.run(['paths', 'since', 'last week']).status, 1)
})

// --- memories ---------------------------------------------------------------------

test('memories lists name, type and description from frontmatter', () => {
  const dir = join(sb.root, 'mem')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'terse.md'),
    '---\nname: terse\ndescription: keep answers short\nmetadata:\n  type: feedback\n---\n\nBody',
  )
  writeFileSync(join(dir, 'MEMORY.md'), '- [terse](terse.md)')
  const out = sb.run(['memories', '--dir', dir]).stdout.split('\n')
  assert.equal(out[1], 'terse.md\tterse\tfeedback\tkeep answers short')
  assert.equal(out.length, 3)
})

// --- day and title ------------------------------------------------------------------

test("the day is the human's local one, not UTC's", () => {
  assert.equal(dayStamp('2026-08-23T01:30:00Z', { timeZone: 'America/Los_Angeles' }), '2026-08-22')
  assert.equal(dayStamp('2026-01-05T12:00:00Z', { timeZone: 'UTC' }), '2026-01-05')
  assert.throws(() => dayStamp('not a date'))
})

test('title and day always name the same day', () => {
  const at = '2026-08-23T06:59:00Z'
  const opts = { timeZone: 'America/Los_Angeles' }
  assert.equal(titleFor('Kaizen', at, opts), `Kaizen ${dayStamp(at, opts).replaceAll('-', '')}`)
  assert.throws(() => titleFor('  ', at))
})

test("title writes both files /rename writes, and the last one wins", () => {
  const { id, path } = sb.session([user('x')])
  assert.equal(sb.run(['title', '--session', id]).status, 0)
  assert.equal(sb.run(['title', '--session', id, '--prefix', 'Retro']).status, 0)
  const last = readFileSync(path, 'utf8').trim().split('\n').at(-1) ?? ''
  assert.match(JSON.parse(last).customTitle, /^Retro \d{8}$/)
  const sidecar = JSON.parse(readFileSync(join(path.replace(/\.jsonl$/, ''), 'custom-title.json'), 'utf8'))
  assert.match(sidecar.customTitle, /^Retro \d{8}$/)
})

test('title failure prints a pasteable /rename line and exits non-zero', () => {
  const res = sb.run(['title', '--session', '${CLAUDE_SESSION_ID}'])
  assert.equal(res.status, 1)
  assert.match(res.stdout, /^Kaizen \d{8}\n$/)
  assert.match(res.stderr, /\/rename Kaizen \d{8}/)
})
