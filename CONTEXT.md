# Kaizen

A retrospective loop over a person's Claude Code sessions: it finds where they had to push back, draws lessons from that, and places those lessons where future sessions will follow them.

## Language

**Session**:
One Claude Code conversation, as recorded in its transcript.
_Avoid_: conversation, chat, transcript (the file, not the thing)

**Run**:
One invocation of `/kaizen`, covering the sessions since the previous run in the same scope.
_Avoid_: retrospective, retro, pass

**Checkpoint**:
The point in time the last run covered; the next run reads only sessions after it.
_Avoid_: last run date, watermark

**Finding**:
A single observation about one session — a correction, quality gap, convention miss, friction, positive pattern, or script that should be permanent.
_Avoid_: issue, signal (a signal is only a lexical hint that a finding may exist)

**Lesson**:
A general rule drawn from one or more findings, stated positively.
_Avoid_: memory, rule, learning

**Placement**:
Where a lesson lives so future sessions act on it: a memory, a CLAUDE.md line, a hook or permission rule, or a script or skill.
_Avoid_: home, destination

**Ladder**:
The ordering of placements from advisory (memory) to enforced (hook, script); a lesson is **promoted** when it moves up.
_Avoid_: hierarchy, escalation

**Memory**:
One placement: a feedback file in Claude Code's auto-memory directory. A memory holds a lesson; it is not the lesson.
_Avoid_: using "memory" to mean the lesson itself

**Relapse**:
A finding that matches a lesson which was already placed before the session began — evidence the placement is not working.
_Avoid_: regression, repeat

**Ledger**:
Kaizen's private record of which placements it made or adopted, when, and which findings back them — plus one-line gists of candidate lessons not yet placed. Holds no lesson content: the lesson lives only in its placement, where other agents look. Out of agents' sight, safe to rebuild from the placements.
_Avoid_: memory, lesson store, checkpoint
