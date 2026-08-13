---
status: accepted
---

# Backend is chosen per Phase: Codex researches, Claude writes

Research runs on Codex because the output we judged good came from that path — its
skills, its Ahrefs MCP wiring, and `gpt-5.6-sol` at high reasoning already produce the
ranked-shortlist artifact we want. Content generation, revision and audit run on Claude
Code for multi-file editing and PR hygiene in the Astro codebase. The mapping is
configuration in the Site Profile, never something an agent decides.

## Considered options

Codex everywhere was the cheaper start — the skills exist there and there is one auth
story. It was rejected because the drafting and revision Phases are where the previous
attempt actually hurt, and we would rather find out now whether a different backend
fixes that than after building around a single provider.

## Consequences

- `connectmachine-seo-content` is needed by both backends. Symlinking one canonical copy
  into `~/.codex/skills` and `~/.claude/skills` keeps it from forking into two versions.
- The skill body has to stay backend-portable; Codex-only idioms in it become bugs on the
  Claude side.
- Two auth paths and two failure modes to debug, accepted deliberately.
