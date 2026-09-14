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

One end-to-end attempt to ship SEO content for a Site Profile, from kickoff to merge
or rejection. A Job owns exactly one branch and one Workspace. Jobs are the unit
humans refer to in Slack.

## Phase

A single unit of agent work within a Job — research, content, revision, audit.
Each Phase is a fresh agent session; nothing is carried between them except
Artifacts. Deliberately *not* called a stage: see [[preview]].

## Gate

A point where a Job stops and waits for a human. Only a human action moves a Job
through a Gate. An agent may never infer that a Gate was passed, and discussion is
not approval.

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

The isolated git worktree a Job's agents work inside, created from `upstream/main`
and destroyed when the Job ends. Never the human's own checkout.

## Preview

The ephemeral URL where a human visually reviews a Job's content before approving.
Built and served from the Job's Workspace, not from shared infrastructure. The term
"stage" is retired: it previously meant a Job state, a Phase, and a deploy
environment at once.

## Agent Backend

The CLI process that executes a Phase — Codex or Claude Code. Which backend runs
which Phase is configuration, not agent choice.
