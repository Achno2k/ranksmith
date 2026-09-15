---
status: accepted
---

# A done Job still takes feedback, as a follow-up on the same Job

Reviewers kept asking for changes after a Job was `done`, and RankSmith answered that
feedback only counts at a Gate. Shipping is not the end of a conversation about a piece of
content, so `done` now accepts a change request and runs a follow-up round.

## Considered options

Starting a new Job from the request was rejected. It would need a way to skip research, a
second thread to explain, and a second ID for what humans already call CM-006. Keeping the
same Job keeps the history, the thread, and the revert in one place.

Keeping the worktree and branch alive after `done` so the revision could continue in place
was rejected. Merged branches are gone on GitHub, worktrees are expensive, and a Job may sit
done for weeks. Cutting a fresh worktree from the base branch gets the shipped content for
free.

## Consequences

- `done` + feedback → `content_revising` (seo) or `marketing_revising` (marketing). The
  Job returns through its usual Gate and lands on `done` again.
- A follow-up gets its own branch (`<slug>-followup-<n>`) and pull request. The merged pull
  request is kept aside as `shipped_pull_request` for the duration and restored if the
  follow-up is rejected or stopped, so `revert` always targets what is live.
- Rejecting or stopping a follow-up returns the Job to `done`, never to `rejected`: there is
  shipped work that must not look abandoned.
- A marketing follow-up is seeded from the report copies under `research/`; those copies
  are now load-bearing, not only a convenience.
- Anyone in the channel may ask a question or request a change in a Job thread. Approvers
  alone start Jobs, press gate buttons, stop, retry, and revert.
