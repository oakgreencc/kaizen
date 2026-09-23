// @ts-check
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyToolUse, scriptsInEntry } from '../skills/kaizen/scripts/adhoc.mjs'

const bash = (/** @type {string} */ command, description = 'do a thing') =>
  classifyToolUse({ name: 'Bash', input: { command, description } })
const write = (/** @type {string} */ file_path, content = 'print(1)') =>
  classifyToolUse({ name: 'Write', input: { file_path, content } })

test('python3 -c is inline python, cut at the closing quote', () => {
  const ev = bash(`python3 -c 'import json; print(1)' | head -1`)
  assert.equal(ev?.kind, 'inline')
  assert.equal(ev?.lang, 'python')
  assert.equal(ev?.snippet, 'import json; print(1)')
  assert.equal(ev?.description, 'do a thing')
})

test('a double-quoted body stops at the first unescaped quote', () => {
  assert.equal(bash(`python -c "print(\\"hi\\")" && echo done`)?.snippet, 'print(\\"hi\\")')
})

test('node -e, --eval, -p and bun -e are node inline', () => {
  for (const c of [`node -e 'x'`, `node --eval "x"`, `node -p '1+1'`, `bun -e 'x'`]) {
    assert.equal(bash(c)?.lang, 'node', c)
  }
})

test('ruby -e and perl -e are inline too', () => {
  assert.equal(bash(`ruby -e 'puts 1'`)?.lang, 'ruby')
  assert.equal(bash(`perl -ne 'print' f`)?.lang, 'perl')
})

test('a long body is collapsed and capped, unless asked for more', () => {
  const long = `python3 -c '${'x = 1\n'.repeat(200)}'`
  assert.equal(bash(long)?.snippet.length, 200)
  const full = classifyToolUse({ name: 'Bash', input: { command: long } }, { snippetMax: 5000 })
  assert.ok((full?.snippet.length ?? 0) > 1000)
})

test('a heredoc fed to an interpreter is a heredoc script', () => {
  const ev = bash(`python3 <<'EOF'\nprint(1)\nEOF`)
  assert.equal(ev?.kind, 'heredoc')
  assert.equal(ev?.lang, 'python')
})

test('node --input-type=module with a heredoc is node, not sh', () => {
  assert.equal(bash(`node --input-type=module <<'EOF'\nconsole.log(1)\nEOF`)?.lang, 'node')
})

test('a heredoc with no interpreter is data', () => {
  assert.equal(bash(`gh issue create --body-file - <<'EOF'\nbody\nEOF`), null)
})

test('scripts under every kind of temp dir count', () => {
  for (const p of [
    '/tmp/a.py',
    '/private/tmp/a.py',
    '/var/folders/xy/T/a.mjs',
    '/Users/me/.claude/jobs/abc/tmp/a.sh',
  ]) {
    assert.equal(write(p)?.kind, 'file', p)
  }
})

test('running an ephemeral script is a run event naming the path', () => {
  const ev = bash('node $CLAUDE_JOB_DIR/tmp/poll.mjs --pr 12')
  assert.equal(ev?.kind, 'run')
  assert.equal(ev?.path, '$CLAUDE_JOB_DIR/tmp/poll.mjs')
  assert.equal(bash('python3 $TMPDIR/x.py')?.kind, 'run')
})

test('a script written into the repo, or a data file in tmp, is not flagged', () => {
  assert.equal(write('/Users/me/app/scripts/poll.mjs'), null)
  assert.equal(write('/tmp/payload.json'), null)
})

test('plain shell and other tools are not programs', () => {
  assert.equal(bash(`git log --format=%H | head -3`), null)
  assert.equal(bash(`jq '.x' f.json`), null)
  assert.equal(classifyToolUse({ name: 'Read', input: { file_path: '/tmp/a.py' } }), null)
})

test('scriptsInEntry reads only assistant tool_use blocks, in order', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'python3 -c "no"' },
        { type: 'tool_use', name: 'Bash', input: { command: `node -e '1'` } },
        { type: 'tool_use', name: 'Bash', input: { command: `python3 -c '2'` } },
      ],
    },
  }
  assert.deepEqual(scriptsInEntry(entry).map((e) => e.lang), ['node', 'python'])
  assert.deepEqual(scriptsInEntry({ ...entry, type: 'user' }), [])
})
