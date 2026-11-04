---
title: "Follow my voice sometimes jumps backward and forward through the script while Lex reads"
type: bug (AFK)
status: needs-triage
assignee:
builder: claude
blocked_by: []
---

## Goal

Reported directly by Lex on 2026-11-01, during the Sunday update rehearsal, after he approved the script's final phrase-by-phrase line separation: while he reads, Follow my voice sometimes jumps backward and forward through his script. This is a user report, not a diagnosed cause.

An earlier report concerned matching a word much later in the script. Check whether this is related, but do not assume it is. No existing issue or ticket matched (the prompter repository has no GitHub Issues and this is its first ticket).

## Expected behaviour

Follow the phrase or sentence being spoken through normal pauses, repeated and common words, and line transitions, without jumping to distant matching text or moving backwards unexpectedly. Deliberate manual navigation (keys, dragging the reading line, section buttons) still works.

## How to reproduce

- Script: `/home/ubulex/Projects/chat/youtube/videos/2026-11-weekly-update-01/talking-head-prompter.md` (default preset; no QL boxes; deliberate phrase breaks; screen links and camera cues). Use a local copy. Do not edit Lex's script to hide the problem: his approved transfer preferences are natural phrase breaks with related words together, no extra empty spacer lines, no QL/main-question boxes, and the face always visible during screen shares.
- Browser, device and exact timestamps are not captured yet. First step: capture them (Chrome or Edge, the speech service in use, what was said at the jump).

## Decided behaviour

- Reproduce and measure before choosing a fix.
- Validation includes this full script and realistic repeated-word and pausing cases (a small fixture of recorded or typed transcripts replayed through the matcher).
- No implementation starts from this ticket until it is triaged and claimed.

## Kit commands and evidence

Agent Kit is required: `scripts/agents/kit doctor`, the relevant specs, `kit review`, `kit pr`; report the RESULT lines, the PR URL and the merge SHA.
