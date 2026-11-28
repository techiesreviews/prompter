---
label: wayfinder:map
title: Prompter, reading along
charted: 2026-11-04
tracker: local markdown (tickets live in tickets/ and build/tickets/ with a blocked_by line in each)
---

## Destination

Follow my voice keeps the line Lex is reading at the reading mark through normal pauses, repeated words and line breaks, and never jumps to distant matching text. Deliberate manual navigation always works.

## Notes

- The matcher lives in `src/follow.mjs`; `AGENTS.md` says it moves "word by word and line by line" and never on a single word or a pair of common words from a later line.
- Lex's approved script-transfer preferences must not be worked around by rewriting his script: natural phrase breaks with related words together, no extra empty spacer lines, no QL or main-question boxes, the face always visible during screen shares.

## Decisions so far

- None yet. The first ticket is a bug report that needs a reproduction.

## Not yet specified

- Browser, device and speech service used when the jumps happen; exact timestamps.
- Whether this is the same cause as the earlier "matches a word much later in the script" report.
