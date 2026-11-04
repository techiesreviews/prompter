# Build: prompter, reading along

prefix: pr

Builds what the [map](../map.md) decided. Tickets are in `tickets/`; each is built with `scripts/agents/kit slice` or by hand, reviewed with `kit review` and landed with `kit pr` into `dev`.

## Rules

- Reproduce and measure before choosing a fix.
- Lex's scripts are test material, never rewritten to hide a bug.
- Anything a person sees: no toasts or explainers; show state on the control itself.

## Gates

`kit doctor`, `kit unit`, the relevant specs, `kit size` for page changes, `kit review`, `kit pr`.

## Waves

1. Ticket 01: Follow my voice jumps (needs Lex's capture of browser, device and a timestamp first).
