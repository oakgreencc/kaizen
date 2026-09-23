// @ts-check
/**
 * One transcript as a readable conversation, for the deep read of a flagged
 * session: one `USER:` / `ASSI:` line per message (its first text block —
 * where the ask and the correction are), plus `DENY:` for a rejected tool call
 * and the reason the human typed. `scriptLines` prints the ad-hoc programs
 * instead, so the retrospective sees what task each performed.
 */
import { scriptsInEntry } from './adhoc.mjs'
import { clip, messageText, toolResultText } from './lib.mjs'

const DENIAL_RE = /The user doesn't want to (?:proceed with this tool use|take this action)/
const REASON_RE = /the user said:\s*([\s\S]+)$/i

/** @param {string} s */
const oneLine = (s) => s.replace(/\n/g, '\\n')

/**
 * @param {{ entry: any, offset: number }[]} entries
 * @param {{ width: number, limit: number, from?: number }} opts
 */
export function conversationLines(entries, { width, limit, from = 0 }) {
  const out = []
  for (const { entry: e, offset } of entries) {
    if (out.length >= limit) break
    if (offset < from || e.isSidechain) continue
    if (e.type !== 'user' && e.type !== 'assistant') continue
    const content = e.message?.content
    if (e.type === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const text = toolResultText(b.content)
        if (!DENIAL_RE.test(text)) continue
        const reason = REASON_RE.exec(text)?.[1]?.trim() ?? '(no reason given)'
        out.push(`DENY: ${clip(oneLine(reason), width)}`)
      }
    }
    const text = messageText(content, { first: true }).trim()
    if (!text) continue
    const role = e.type === 'user' ? (e.isMeta ? 'META' : 'USER') : 'ASSI'
    out.push(`${role}: ${clip(oneLine(text), width)}`)
  }
  return out.slice(0, limit)
}

/**
 * @param {{ entry: any, offset: number }[]} entries
 * @param {{ width: number, limit: number, from?: number }} opts
 */
export function scriptLines(entries, { width, limit, from = 0 }) {
  const out = []
  let n = 0
  for (const { entry, offset } of entries) {
    if (offset < from) continue
    for (const ev of scriptsInEntry(entry, { snippetMax: width })) {
      if (n >= limit) return out
      n += 1
      const where = ev.path ? ` ${ev.path}` : ''
      const label = ev.description ? ` — ${ev.description}` : ''
      out.push(`#${n} ${ev.tool} ${ev.kind} ${ev.lang}${where}${label}`)
      out.push(`    ${ev.snippet}`)
    }
  }
  return out
}
