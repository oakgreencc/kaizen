# kaizen

A Claude Code skill (packaged as a plugin) that runs retrospectives over a person's session transcripts. The deterministic half is `skills/kaizen/scripts/kaizen.mjs` (Node 20+, zero dependencies); the judgement half is `skills/kaizen/SKILL.md` and its `references/`.

- Test: `npm test`. Validate the plugin: `npm run validate`.
- Vocabulary: [`CONTEXT.md`](CONTEXT.md). Use its terms — a *lesson* is not a *memory*.

## Agent skills

- Issue tracker: GitHub Issues on `oakgreencc/kaizen` — see [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md).
- Domain docs: single context — [`CONTEXT.md`](CONTEXT.md) at the root, ADRs in `docs/adr/` when one is warranted.
