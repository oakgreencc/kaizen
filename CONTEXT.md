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
The ordering of placements by strength: a memory (only its index line is always in context), then an instructions file line (CLAUDE.md or AGENTS.md, always in context), then an enforced placement (hook, permission rule, script). A lesson is **promoted** when it moves up. Scope is a separate axis: moving to user level is a lift, not a promotion.
_Avoid_: hierarchy, escalation

**Lift**:
Moving a lesson from one repository's placements to the user level (user CLAUDE.md), because it holds across repositories. Changes who the lesson applies to, not how strongly.
_Avoid_: promote (that is strength), widen (that is fixing a too-narrow wording)

**Memory**:
One placement: a feedback file in Claude Code's auto-memory directory. A memory holds a lesson; it is not the lesson.
_Avoid_: using "memory" to mean the lesson itself

**Relapse**:
A finding where the agent did what a placement says not to do, while that placement was already in force when the session loaded its context (at its start, or at its resume point). Evidence the placement is not working. A finding that only matches an unplaced candidate is a recurrence, not a relapse.
_Avoid_: regression, repeat

**Possible relapse**:
A finding that resembles a placed lesson but can't name the clause it breaks or show the same behaviour. It is reported but not counted.
_Avoid_: soft relapse, near-miss

**Enforcement gap**:
A relapse against an enforced placement (a hook, permission rule or script): the enforcement was bypassed or too narrow, or the agent improvised the script again.
_Avoid_: hook failure

**Diagnosis**:
Why a relapse happened: **unseen** (the placement likely wasn't in context), **ignored** (in context, clear, and disobeyed), **unclear** (the wording let the agent off) or **too narrow** (the agent followed the wording, but the lesson is broader).
_Avoid_: root cause, reason

**Candidate**:
A lesson seen in findings but not yet placed; the ledger keeps only a one-line gist. It expires after 90 observed days with no new finding.
_Avoid_: draft, pending lesson

**Coverage gap**:
A stretch of time no run reviewed in full, because transcripts were deleted before a run read them or only partial-scope runs covered it. Those days are not observed, so they don't count toward expiry.
_Avoid_: blind spot, missing data

**Ledger**:
Kaizen's private record of which placements it made or adopted, when, and which findings back them — plus one-line gists of candidate lessons not yet placed. Holds no lesson content: the lesson lives only in its placement, where other agents look. Out of agents' sight, safe to rebuild from the placements.
_Avoid_: memory, lesson store, checkpoint
