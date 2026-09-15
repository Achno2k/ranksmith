# Context

Ubiquitous language for RankSmith.

## Engine

The site-agnostic orchestrator. Owns job state, decides when work happens, launches
agent backends, and talks to Slack. Contains no knowledge of any particular website.

## Site Profile

Everything specific to one website, gathered in one place: its skills, its repository
location and upstream remote, its build and preview commands, and its budgets. The
Engine reads a Site Profile; it never hardcodes one. ConnectMachine is the first
Site Profile.

## Job

One end-to-end attempt at a piece of work for a Site Profile, from kickoff to its
terminal state. A Job owns exactly one Workspace, and a seo Job also owns one branch.
Jobs are the unit humans refer to in Slack.

## Job Kind

What a Job is for. A `seo` Job ships content through a pull request. A `marketing` Job
ends at a reviewed report and never touches the site. The kind is fixed at kickoff and
decides which states the Job can be in.

## Marketing Scan

A `marketing` Job. The agent acts as the site's head of growth: it works through lanes
(events, communities, partnerships, media, review sites, competitor gaps, PR, content
tie-ins), ranks the opportunities it finds across all of them, and hands back a report,
a CSV of targets, and drafts. It reads the web and the site checkout, and writes only its
own report. Approval closes it; there is nothing to merge or revert.

## Phase

A single unit of agent work within a Job — research, content, revision, audit.
Each Phase is a fresh agent session; nothing is carried between them except
Artifacts. Deliberately *not* called a stage: see [[preview]].

## Gate

A point where a Job stops and waits for a human. Only a human action moves a Job
through a Gate. An agent may never infer that a Gate was passed, and discussion is
not approval.

## Follow-up

Revising a `done` Job because someone asked for a change after it shipped. The shipped work
stays live while the Follow-up runs through the same Phase and Gate the original did. Dropping
a Follow-up (reject or stop) returns the Job to `done` unchanged. The Job keeps its ID: the
thread is the unit humans refer to, and a change to CM-006 belongs in CM-006.

## Revert

Undoing a `done` Job's merged work with a new pull request. It goes through its own
Gate like any shipping change. Rejecting a Revert returns the Job to `done`; the
shipped content stays.

## Triage

Reading what a mention in a Job thread wants: a question, feedback, a Revert, or a
stop. Triage is read-only and only names the intent. The Engine alone decides whether
that intent is allowed in the Job's current state.

## Artifact

A file written by one Phase and read by the next. Artifacts are the only continuity
between Phases — the Engine never replays conversation history. The research
document is the first Artifact.

## Phase Contract

The outputs a Phase must produce for its work to count as done: which files must
exist and what shape they must have. The Engine judges a Phase against its
Contract alone. An agent's own claim that it finished is not evidence, and
failing the Contract is a failure however confident the agent sounded.

## Workspace

The isolated directory a Job's agents work inside, destroyed when the Job ends. For a
seo Job it is a git worktree cut from `upstream/main`; for a Marketing Scan it is a
plain scratch directory. Never the human's own checkout.

## Preview

The ephemeral URL where a human visually reviews a Job's content before approving.
Built and served from the Job's Workspace, not from shared infrastructure. The term
"stage" is retired: it previously meant a Job state, a Phase, and a deploy
environment at once.

## Agent Backend

The CLI process that executes a Phase — Codex or Claude Code. Which backend runs
which Phase is configuration, not agent choice.
