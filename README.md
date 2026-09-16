# RankSmith

SEO content and marketing research automation. Slack gates, agent backends execute,
git remembers.

Read [CONTEXT.md](CONTEXT.md) for the vocabulary and [docs/adr](docs/adr) for why the
shape is what it is.

## How a job runs

```
/seo [topic]  or  @RankSmith [research prompt]
  → RESEARCHING        claude, in a fresh worktree
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

`done` is not the end of the thread. A change asked for after the Job shipped starts a
follow-up: a fresh worktree off the base branch (the shipped content is already there), the
revision phase with that feedback, a new pull request, the same content gate, merge, `done`
again. Until the shipped pull request has actually merged, RankSmith asks you to wait. Rejecting or stopping a follow-up drops only the revision; what shipped stays as it
was, and a later `revert` still undoes the most recent merge. A follow-up on a marketing
scan revises the report the same way and closes on approval.

A failed Job keeps its worktree. `@RankSmith retry` in its thread runs it again from the step
that failed. The Engine's own steps (push, pull request, preview) also retry once on their
own, 30 seconds later, when the error looks temporary: network, GitHub 5xx, rate limits, or a
tunnel that did not come up. Anything else fails straight away.

Every other mention in a Job thread goes through a quick read-only Claude call
(`claude-sonnet-5`) that decides whether it is a question, feedback, a revert, or a stop.
Questions ("is this on staging?") get an answer in the thread, checked against the pull
request, its workflow runs, and the repo. The Engine still decides what is allowed: feedback
counts at a gate or once the Job is done, and a refusal is a normal thread reply, not an
ephemeral one.

Anyone in the channel can ask a question or request a change in a Job thread. Starting a
Job, the gate buttons, `stop`, `retry`, and `revert` stay with the approvers list.

A `done` Job can be reverted by asking in its thread, e.g. `@RankSmith revert this`:

```
DONE
  → REVERTING          git revert of the merge commit, revert PR opened
  → REVERT_REVIEW      ● gate: Approve / Reject
  → REVERT_MERGING     auto-merge queued behind CI
  → REVERTED
```

Rejecting the revert closes its PR and returns the Job to `done`. If the original PR had not
merged yet, the Engine closes it and the Job goes straight to `reverted`. A revert that
conflicts with later changes fails and lists the conflicting files.

## Marketing scans

A second kind of Job. It never touches the site: the output is a report, not a pull request.

```
/marketing [focus]  or  @RankSmith marketing [focus]
  → MARKETING_SCANNING   claude, in a scratch directory (no worktree, no git)
  → MARKETING_REVIEW     ● gate: Approve (closes the job) / Reject / reply with feedback
  → DONE
```

The focus is free text: an event ("SaaStr Annual 2026"), a lane ("partnerships"), a segment
("recruiters"), or nothing, which scans every lane. The agent works through events,
communities, partnerships and integrations, media and creators, review sites, competitor
gaps, PR and awards, and content tie-ins, then ranks what it found across all of them.

It posts two files into the thread: `docs/marketing/<date>-opportunities.md` (summary,
ranked top 10 with next actions and evidence, drafts, `/seo` handoffs, gaps) and
`docs/marketing/<date>-targets.csv` (one row per person or organisation, each with a source
URL). Nothing is sent, posted, or imported into a CRM. Feedback at the gate sends it back for
a deeper pass. The agent may read the site checkout for product facts but cannot edit it.

## Deploying

RankSmith runs on one EC2 host as the `ranksmith` systemd unit, from a checkout at
`~/projects/ranksmith`. Every push to `main` runs `.github/workflows/ci.yml`: typecheck and
tests, then `scripts/deploy.sh` over SSH, which resets the checkout to `origin/main`, runs
`npm ci`, waits (up to 15 minutes) for any agent phase in flight, and restarts the unit. The
same script works by hand: `ssh` in and run `bash scripts/deploy.sh`.

The workflow needs three repository secrets: `EC2_HOST` (the public DNS name), `EC2_SSH_KEY`
(the private key that reaches it), and optionally `EC2_USER` (defaults to `ubuntu`). It
deploys through a GitHub environment named `production`, so approvals or branch rules can
be added there later.

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
`app_mentions:read`, `reactions:write`, `channels:history`, and `groups:history`. Add the
`/seo` and `/marketing` slash commands and subscribe to the `app_mention` event. Start a Job
with `/seo [topic]` or by writing `@RankSmith [research prompt]` in a channel or thread;
`@RankSmith marketing [focus]` starts a marketing scan instead. Mentioned
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
npm run job -- marketing [focus]       # marketing scan from the terminal
npm run job -- status CM-002           # inspect a Job's persisted state
npm run job -- sweep [days]            # reject Jobs parked at a gate longer than days (default 14)
npm run job -- preview CM-002          # fresh preview URL for a Job waiting at content review
npm test                               # node:test across the tested seams
npm run typecheck
bin/ranksmith-check <phase> <date>      # from a workspace root: the Phase Contract check, one gap per line
```

`bin/ranksmith-check` is the same check the Engine runs after a Phase, so an agent runs it
before finishing. `bin/ranksmith-budget` is a Claude Code PreToolUse hook that counts
WebSearch and WebFetch calls in `<workspace>/.ranksmith/budget.json` and blocks the call
past the limit.

While the pipeline runs, the Job thread shows Slack's native status ("RankSmith is working on
CM-002…") with the current step and elapsed time rotating under it, re-sent every minute so
Slack's two-minute timeout never drops it. It clears at every gate, failure, and stop. A
mention in the thread shows it while RankSmith reads the message. The status needs only
`chat:write`. If Slack refuses it for a conversation, that Job falls back to one in-thread
loader message edited every five seconds. To stream the full agent output
locally:

```bash
tail -f ~/.ranksmith/jobs/CM-002/logs/research-1.log
```

A preview lives only as long as the Engine process and the machine's network. When the tunnel
dies the Job stays at content review and the thread says so. Mention `@RankSmith new preview`
in the thread, or run `npm run job -- preview CM-002`, to serve the same worktree behind a
fresh URL; the pull request keeps working either way. When the Engine starts it rebuilds the
preview of every seo Job waiting at content review whose worktree is still on disk.

Replace `~/.ranksmith` with `RANKSMITH_HOME` when that variable is configured. A Claude log is
stream-json, one event per line, tool calls included; the final `result` event carries the
session id, cost, and turn count. A Phase may run for 25–40 minutes; a changing heartbeat
means its process is still alive.

Only the agent process waits in the one-at-a-time queue. Worktree setup, `npm ci`, the preview
build, and merges run beside it, so a build never holds up another Job's agent. The first seo
Job on a given `package-lock.json` installs dependencies and keeps them at
`~/.ranksmith/cache/node_modules-<sha256>`; later Jobs clone that directory into their
worktree instead of installing again.

A revision (`research_revision`, `content_revision`, `marketing_revision`) resumes the Claude
session of the Phase it revises with `--resume`, so the agent keeps what it already read. A
first pass never resumes anything: only Artifacts carry between Phases. If the session is gone,
the revision runs once more from scratch.

## What is tested

By agreement, tests cover the four seams where correctness is load-bearing:

- the job state machine and its gates
- phase contract validation and the retry policy (headings, tables, JSON shapes, CSV rows and URLs)
- the agent self-check command and the search budget hook, run as child processes
- the run queue's one-agent-at-a-time guarantee
- prompt and argv assembly

The I/O adapters — git, worktrees, preview tunnels, `gh` — are deliberately thin and
untested. Their failures are loud and land in Slack.

## Safety

The engine merges to `main`, which deploys to staging. It never creates a `v*.*.*` tag,
which is the only path to production. That stays human-only.
