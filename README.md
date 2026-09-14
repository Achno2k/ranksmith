# RankSmith

SEO content automation. Slack gates, agent backends execute, git remembers.

Read [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr](docs/adr) for why the
shape is what it is.

## How a job runs

```
/seo [topic]  or  @RankSmith [research prompt]
  → RESEARCHING        codex, in a fresh worktree
  → RESEARCH_REVIEW    ● gate: Approve / Reject / reply with feedback
  → GENERATING         claude, commits to the job branch
  → PREVIEW_BUILDING   push, open PR, build, tunnel
  → CONTENT_REVIEW     ● gate: Approve / Reject / reply with feedback
  → MERGING            auto-merge queued behind CI
  → DONE
```

Feedback at either gate sends the job back for a revision and returns to the same gate.
Mention `@RankSmith` in the Job thread when giving feedback; unmentioned replies are ignored.
Use `@RankSmith stop` in that thread to stop an active Job. Only a human moves a job
through a gate.

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
scopes `chat:write`, `commands`, `files:write`, `files:read`, `users:read`,
`app_mentions:read`, `reactions:write`, `channels:history`, and `groups:history`. Add a
`/seo` slash command and subscribe to the `app_mention` event. Start a Job with `/seo
[topic]` or by writing `@RankSmith [research prompt]` in a channel or thread. Mentioned
Jobs react with :eyes: and keep all pipeline updates in the thread where RankSmith was
tagged. RankSmith uses `files:write` to attach each completed research document directly
to its Slack review thread.

You can attach files to any kickoff message or feedback reply that mentions `@RankSmith`.
Images, PDFs, and Markdown files are mirrored into the agent's workspace and listed in
its prompt as context. A feedback attachment with the same filename as an earlier one
replaces it.

## Commands

```bash
npm start                              # run the Slack engine
npm run job -- status CM-002           # inspect a Job's persisted state
npm test                               # node:test across the tested seams
npm run typecheck
```

While the pipeline runs, Slack animates one in-thread loader by updating its frame every
five seconds; it also refreshes the elapsed time and log location every minute. No extra
thread replies are created. To stream the full agent output locally:

```bash
tail -f ~/.ranksmith/jobs/CM-002/logs/research-1.log
```

Replace `~/.ranksmith` with `RANKSMITH_HOME` when that variable is configured. A Phase
may run for 25–40 minutes; a changing heartbeat means its process is still alive.

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
