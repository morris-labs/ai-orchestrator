# Plan by conversation, execute by code

Status: accepted

A build has two phases. Planning is a conversation between the owner and the
Project manager, the box's main Claude Code session, because planning needs
judgment and the owner's input. Execution runs in the engine with rule-based
routing, like the review pipeline, because it needs repetition and
reproducible decisions. A frozen, versioned build plan is the only handoff
between them.

## Considered options

- **The engine routes everything, including planning.** This option was
  rejected because planning is a dialog, and a state machine can't hold one.
- **A model orchestrates execution.** This option was rejected because runs
  become hard to reproduce, and every routing decision costs tokens.
