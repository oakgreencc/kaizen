// @ts-check
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { aiTitle, customTitle, sandbox, toolResult, toolUse, user } from './helpers.mjs'

/** @type {ReturnType<typeof sandbox>} */
let sb
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

const texts = (/** @type {any} */ s) => s.messages.map((/** @type {any} */ m) => m.text)

// --- self-referential sessions ---------------------------------------------

test('a session that invoked /kaizen is skipped', () => {
  sb.session([user('<command-name>/kaizen</command-name>'), user('real words here')])
  const { summaries, info } = sb.extract()
  assert.deepEqual(summaries, [])
  assert.equal(info.skipped.selfReferential, 1)
})

test('a plugin-namespaced invocation is skipped too', () => {
  sb.session([user('<command-name>/kaizen:kaizen</command-name>'), user('real words')])
  assert.deepEqual(sb.extract().summaries, [])
})

test('a skill the model invoked itself counts as an invocation', () => {
  sb.session([user('please reflect'), toolUse('Skill', { skill: 'kaizen:kaizen' })])
  assert.deepEqual(sb.extract().summaries, [])
})

test('a run identified only by the title it stamped on itself is skipped', () => {
  sb.session([user('resumed words'), customTitle('Kaizen 20260901')])
  assert.deepEqual(sb.extract().summaries, [])
})

// The regression that matters most: a kaizen run and a valuable session can
// share a worktree named after kaizen. Filtering on the directory would throw
// the second away with the first.
test('an ordinary session in a kaizen-named worktree is kept', () => {
  sb.session([user('fix the release branch')], { cwd: join(sb.repo, '.claude', 'worktrees', 'kaizen-2026-09-01') })
  const { summaries } = sb.extract()
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].worktree, 'kaizen-2026-09-01')
  assert.equal(summaries[0].project, 'app')
})

test('a title that merely mentions kaizen is kept', () => {
  sb.session([user('what is kaizen anyway'), aiTitle('Explaining the kaizen philosophy')])
  assert.equal(sb.extract().summaries.length, 1)
})

test('extra skip commands come from arguments', () => {
  sb.session([user('<command-name>/retro</command-name>'), user('words')])
  assert.equal(sb.extract().summaries.length, 1)
  sb.session([user('<command-name>/retro</command-name>'), user('words')])
  assert.equal(sb.extract(['skip-command', 'retro']).summaries.length, 0)
})

test('the running session is excluded by id', () => {
  const { id } = sb.session([user('hello')])
  const { summaries, info } = sb.extract(['--exclude', id])
  assert.deepEqual(summaries, [])
  assert.equal(info.skipped.excluded, 1)
})

// --- what counts as the human ------------------------------------------------

test('injected skill, harness and compaction text is dropped', () => {
  sb.session([
    user('Base directory for this skill: /x\n\n# Something'),
    user('# /deploy — ship it\n\nsteps…'),
    user('<system-reminder>be good</system-reminder>'),
    user('This session is being continued from a previous conversation that ran out of context.'),
    user('[Image #1]'),
    user('meta text', { isMeta: true }),
    user('the only real one'),
  ])
  assert.deepEqual(texts(sb.extract().summaries[0]), ['the only real one'])
})

test('origin.kind, when present, decides who typed it', () => {
  sb.session([
    user('typed by a person', { origin: { kind: 'human' } }),
    user('a hook said this', { origin: { kind: 'hook' } }),
  ])
  assert.deepEqual(texts(sb.extract().summaries[0]), ['typed by a person'])
})

test('a session with nothing a human typed is dropped and counted', () => {
  sb.session([user('<system-reminder>x</system-reminder>')])
  const { summaries, info } = sb.extract()
  assert.deepEqual(summaries, [])
  assert.equal(info.skipped.noHumanText, 1)
})

test('command-args keeps the text the human typed, without the tags', () => {
  sb.session([user('<command-name>/deploy</command-name><command-args>to staging only</command-args>')])
  const s = sb.extract().summaries[0]
  assert.deepEqual(texts(s), ['to staging only'])
  assert.deepEqual(s.commands, ['deploy'])
})

test('an interruption survives and is flagged', () => {
  sb.session([user('do x'), user('[Request interrupted by user]'), user('no, do y instead')])
  const s = sb.extract().summaries[0]
  assert.deepEqual(s.messages[1].flags, ['interrupt'])
  assert.ok(s.messages[2].flags.includes('correction'))
  assert.ok(s.score >= 2)
})

// --- denials ------------------------------------------------------------------

test('a rejected tool call with a typed reason becomes a flagged message', () => {
  sb.session([
    user('clean up'),
    toolUse('Bash', { command: 'rm -rf build' }, 'tu9'),
    toolResult(
      'tu9',
      "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nnever delete build, it is checked in",
    ),
  ])
  const s = sb.extract().summaries[0]
  assert.equal(s.denials.user, 1)
  assert.equal(texts(s)[1], '[denied Bash] never delete build, it is checked in')
  assert.ok(s.messages[1].flags.includes('denial'))
})

test('a classifier denial is counted, not quoted as the human', () => {
  sb.session([
    user('go'),
    toolUse('Bash', { command: 'x' }, 'a1'),
    toolResult('a1', 'Permission for this action was denied by the Claude Code auto mode classifier.', {
      toolDenialKind: 'automode-blocked',
    }),
  ])
  const s = sb.extract().summaries[0]
  assert.deepEqual(s.denials, { user: 0, classifier: 1 })
  assert.deepEqual(texts(s), ['go'])
})

// --- titles -------------------------------------------------------------------

test('a custom title outranks the AI one, and the last rename wins', () => {
  sb.session([user('x'), aiTitle('Inferred'), customTitle('First'), customTitle('Second'), customTitle('  ')])
  assert.equal(sb.extract().summaries[0].title, 'Second')
})

// --- caps -----------------------------------------------------------------------

test('long messages are clipped with a count of what was cut', () => {
  sb.session([user('a'.repeat(5000))])
  const [m] = sb.extract().summaries[0].messages
  assert.match(m.text, /… \[\+3500 chars\]$/)
})

test('a very long session keeps every flagged message and reports the rest', () => {
  const entries = Array.from({ length: 200 }, (_, i) => user(i === 100 ? 'that is wrong, revert it' : `note ${i}`))
  sb.session(entries)
  const s = sb.extract().summaries[0]
  assert.equal(s.messages.length, 60)
  assert.equal(s.omittedMessages, 140)
  assert.ok(texts(s).includes('that is wrong, revert it'))
  assert.equal(texts(s)[0], 'note 0')
  assert.equal(texts(s).at(-1), 'note 199')
})

test('the per-session script list is capped but the count is not', () => {
  const calls = Array.from({ length: 45 }, (_, i) => toolUse('Bash', { command: `python3 -c 'print(${i})'` }, `t${i}`))
  sb.session([user('go'), ...calls])
  const s = sb.extract().summaries[0]
  assert.equal(s.scripts.length, 40)
  assert.equal(s.scriptCount, 45)
})

// --- scope ----------------------------------------------------------------------

test('project scope takes subdirectories and worktrees but not a same-prefix sibling', () => {
  // Subdirectories resolve to their repo through git, as they do in real use.
  spawnSync('git', ['init', '-q', sb.repo])
  sb.session([user('root')])
  mkdirSync(join(sb.repo, 'packages', 'api'), { recursive: true })
  sb.session([user('sub')], { cwd: join(sb.repo, 'packages', 'api') })
  sb.session([user('worktree')], { cwd: join(sb.repo, '.claude', 'worktrees', 'fix-1') })
  sb.session([user('sibling')], { cwd: `${sb.repo}-docs` })
  const got = sb.extract().summaries.map((s) => texts(s)[0]).sort()
  assert.deepEqual(got, ['root', 'sub', 'worktree'])
})

test('all scope takes every project, and keeps its own status file', () => {
  sb.session([user('here')])
  sb.session([user('elsewhere')], { cwd: join(sb.root, 'other') })
  const { summaries, info } = sb.extract(['all'])
  assert.equal(summaries.length, 2)
  assert.match(info.pending, /kaizen\/all\/pending\.jsonl$/)
})

test('match selects project directories by regex', () => {
  sb.session([user('here')])
  sb.session([user('elsewhere')], { cwd: join(sb.root, 'other') })
  const { summaries } = sb.extract(['match', '-other$'])
  assert.deepEqual(summaries.map((s) => texts(s)[0]), ['elsewhere'])
})

// --- status bookkeeping -----------------------------------------------------------

test('mark records what was seen, and the next extract skips it', () => {
  sb.session([user('one')])
  sb.session([user('<system-reminder>x</system-reminder>')])
  assert.equal(sb.extract().summaries.length, 1)
  const res = sb.run(['mark', '--day', '2026-09-22'])
  assert.equal(res.status, 0, res.stderr)
  const status = JSON.parse(readFileSync(join(sb.run(['paths']).json().statusFile), 'utf8'))
  assert.equal(status.lastRun, '2026-09-22')
  // The boilerplate-only session is recorded too, so it is not re-parsed forever.
  assert.equal(Object.keys(status.sessions).length, 2)
  const again = sb.extract()
  assert.equal(again.summaries.length, 0)
  assert.equal(again.info.advice, 'no new sessions')
})

test('a session that grew after it was analysed is re-read from where it stopped', () => {
  const { path } = sb.session([user('first ask')])
  sb.extract()
  sb.run(['mark', '--day', '2026-09-01'])
  appendFileSync(path, `${JSON.stringify({ type: 'user', cwd: sb.repo, message: { content: 'resumed: that was wrong' } })}\n`)
  const s = sb.extract().summaries[0]
  assert.deepEqual(texts(s), ['resumed: that was wrong'])
  assert.ok(s.resumedFrom > 0)
})

test('the older { analyzed: [{ts, path}] } status is read and upgraded', () => {
  const { path } = sb.session([user('old')])
  const { out } = sb.run(['paths']).json()
  mkdirSync(out, { recursive: true })
  const home = process.env.HOME ?? ''
  const key = path.startsWith(home) ? `~${path.slice(home.length)}` : path
  writeFileSync(join(out, 'status.json'), JSON.stringify({ lastRun: '2026-08-01', analyzed: [{ ts: 'x', path: key }] }))
  assert.equal(sb.extract().summaries.length, 0)
})

test('mark refuses a hand-typed or missing day', () => {
  sb.session([user('x')])
  sb.extract()
  assert.equal(sb.run(['mark']).status, 2)
  assert.equal(sb.run(['mark', '--day', 'Sept 22']).status, 2)
})

test('mark with nothing pending fails loudly', () => {
  const res = sb.run(['mark', '--day', '2026-09-22'])
  assert.equal(res.status, 1)
  assert.match(res.stderr, /run extract first/)
})

test('chunk splits pending by size and mark cleans the chunks up', () => {
  for (let i = 0; i < 6; i++) sb.session([user(`${'x'.repeat(900)} ${i}`)])
  sb.extract()
  const res = sb.run(['chunk', '--bytes', '2000'])
  const chunks = res.stdout.trim().split('\n')
  assert.ok(chunks.length >= 3, res.stdout)
  const first = chunks[0].split('\t')[0]
  assert.ok(existsSync(first))
  sb.run(['mark', '--day', '2026-09-22'])
  assert.ok(!existsSync(first))
})

test('a session that enters a worktree after starting is labelled with it', () => {
  sb.session([user('start here'), { type: 'user', cwd: join(sb.repo, '.claude', 'worktrees', 'late'), message: { content: 'now in wt' } }])
  assert.equal(sb.extract().summaries[0].worktree, 'late')
})
