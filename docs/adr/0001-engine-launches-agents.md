---
status: accepted
---

# The Engine launches agents; agents never claim work

An earlier attempt (`automation/seo-review` in the ConnectMachine website repo) inverted
this: the service enqueued actions and a Codex session claimed them with
`npm run cli -- next-action`. Nothing ever started that Codex session, so a human was
the scheduler — the workflow was automated on paper and manual in practice. The Engine
now spawns `codex exec` / `claude -p` as subprocesses itself and owns the decision of
when work happens.

## Consequences

- A Phase is a subprocess with a timeout, not a conversation. Nothing is interactive
  mid-run; human input only lands between Phases, at Gates.
- Both CLIs must authenticate headlessly from a long-running local process.
- Research Phases run 10–25 minutes, so the Engine streams and persists logs rather
  than waiting silently.
