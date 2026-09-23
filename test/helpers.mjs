// @ts-check
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI = fileURLToPath(new URL('../skills/kaizen/scripts/kaizen.mjs', import.meta.url))

let n = 0
/** A fresh fake session UUID. */
export const sid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

/** @param {string} text @param {object} [extra] */
export const user = (text, extra = {}) =>
  ({ type: 'user', timestamp: '2026-09-01T10:00:00.000Z', message: { content: text }, ...extra })
/** @param {string} text */
export const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
/** @param {string} name @param {object} input @param {string} [id] */
export const toolUse = (name, input, id = 'tu1') => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
/** @param {string} id @param {string} text @param {object} [extra] */
export const toolResult = (id, text, extra = {}) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] },
  ...extra,
})
/** @param {string} aiTitle */
export const aiTitle = (aiTitle) => ({ type: 'ai-title', aiTitle })
/** @param {string} customTitle */
export const customTitle = (customTitle) => ({ type: 'custom-title', customTitle })

/**
 * A throwaway CLAUDE_CONFIG_DIR with transcripts laid out as Claude Code does.
 * `repo` is a fake working directory; sessions default to it.
 */
export function sandbox() {
  // realpath: macOS tmpdir is a symlink, and the CLI sees the resolved cwd.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kaizen-test-')))
  const config = join(root, 'config')
  const repo = join(root, 'work', 'app')
  mkdirSync(join(config, 'projects'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  const slug = (/** @type {string} */ p) => p.replace(/[^a-zA-Z0-9]/g, '-')
  return {
    root,
    config,
    repo,
    /**
     * @param {object[]} entries
     * @param {{ cwd?: string, id?: string }} [opts]
     */
    session(entries, { cwd = repo, id = sid() } = {}) {
      const dir = join(config, 'projects', slug(cwd))
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${id}.jsonl`)
      const lines = entries.map((e) => JSON.stringify({ cwd, ...e }))
      writeFileSync(path, `${lines.join('\n')}\n`)
      return { id, path }
    },
    /** @param {string[]} args @param {{ cwd?: string }} [opts] */
    run(args, { cwd = repo } = {}) {
      const res = spawnSync(process.execPath, [CLI, ...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_PROJECT_DIR_NAME: '' },
      })
      return { ...res, json: () => JSON.parse(res.stdout) }
    },
    /** Run extract and return the pending summaries. */
    extract(args = /** @type {string[]} */ ([]), opts = {}) {
      const res = this.run(['extract', ...args], opts)
      if (res.status !== 0) throw new Error(`extract exited ${res.status}: ${res.stderr}`)
      const info = JSON.parse(res.stdout)
      const summaries = readFileSync(info.pending, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      return { info, summaries }
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
