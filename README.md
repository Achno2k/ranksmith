# RankSmith

SEO content automation. Slack gates, agent backends execute, git remembers.

Read [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr](docs/adr) for why the
shape is what it is.

## How a job runs

```
/seo [topic]
  → RESEARCHING        codex, in a fresh worktree
  → RESEARCH_REVIEW    ● gate: Approve / Reject / reply with feedback
  → GENERATING         claude, commits to the job branch
  → PREVIEW_BUILDING   push, open PR, build, tunnel
  → CONTENT_REVIEW     ● gate: Approve / Reject / reply with feedback
  → MERGING            auto-merge queued behind CI
  → DONE
```

Feedback at either gate sends the job back for a revision and returns to the same gate.
Only a human moves a job through a gate.

## Setup

```bash
npm install
./scripts/link-skills.sh connectmachine   # canonical skills -> both CLI skill dirs
cp .env.example .env                      # then fill it in
npm start
```

`link-skills.sh` moves any existing skill directory aside as `<name>.backup-<timestamp>`
before linking. It does not delete anything.

The Slack app needs Socket Mode, an app-level token with `connections:write`, and bot
scopes `chat:write`, `commands`, `channels:history`, `groups:history`. Add a `/seo`
slash command pointing at the app.

## Commands

```bash
npm start        # run the engine
npm test         # node:test across the tested seams
npm run typecheck
```

## What is tested

By agreement, tests cover the four seams where correctness is load-bearing:

- the job state machine and its gates
- phase contract validation and the retry policy
- the run queue's one-agent-at-a-time guarantee
- prompt and argv assembly

The I/O adapters — git, worktrees, preview tunnels, `gh` — are deliberately thin and
untested. Their failures are loud and land in Slack.

## Safety

The engine merges to `main`, which deploys to staging. It never creates a `v*.*.*` tag,
which is the only path to production. That stays human-only.
