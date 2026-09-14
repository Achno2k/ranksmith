---
status: accepted
---

# A second Job Kind is a flag and a short state branch, not a pipeline definition

Marketing scans are the first work RankSmith does that never touches the site. They needed
new states, a new Phase, a new Contract, and a scratch directory instead of a worktree. The
Engine gets a `kind` on each Job and three more states behind it. The SEO pipeline is
untouched.

## Considered options

Making pipelines data on the Site Profile (states, transitions, gates, contracts as JSON)
would have covered both kinds and any third one. It was rejected for now because two
pipelines are not enough evidence for what the schema should be, and the state machine is
the most tested code in the repo. Turning it into an interpreter would move those tests from
"this transition is right" to "this interpreter is right", which is a weaker guarantee for a
larger change.

A separate service for marketing was rejected because the Slack gate, the retry policy, the
Contract check, and the one-agent-at-a-time queue are exactly what a marketing scan needs
too.

## Consequences

- `kind` is fixed at kickoff. A Job never changes kind.
- Every kind-specific decision lives in one of four places: `states.ts` (transitions),
  `phases.ts` (contract), `invocation.ts` (tools and prompt), and the two branches in the
  Engine (workspace creation and what happens after a Phase). A third kind should follow the
  same four seams; if it cannot, that is the moment to revisit pipelines as data.
- Marketing Jobs skip `git`, `npm`, and the Contract's commit step. Their Workspace is a
  plain directory at the same path a worktree would use, so teardown is shared.
- `done` means different things per kind: shipped for seo, reviewed for marketing. Only seo
  Jobs can be reverted.
