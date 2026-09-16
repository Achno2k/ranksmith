---
status: superseded
---

> **2026-09-16:** Previews are now static deployments on Cloudflare Pages; see ADR 0006. The
> reasons for staying off shared staging still stand.

# Content is reviewed on a local Preview, not on shared staging

ConnectMachine's `deploy-stage.yml` fires only on push to `main` and guards a single
shared staging environment. Deploying a pull request there would mean changing the
website repo's CI to accept a dispatched ref, letting each Job seize staging from
everyone else, and writing restore-staging-to-main logic for every reject and merge.
Instead the Engine builds the Job's Workspace and serves it through a `cloudflared`
tunnel, posting that URL to Slack. The tunnel rewrites its origin `Host` header to
`localhost`; this lets Vite/Astro retain host validation even though every quick tunnel
gets a different public hostname.

## Consequences

- The website repository needs no changes at all, and Jobs never queue behind each other
  for a shared environment.
- Preview URLs are ephemeral: they die with the Engine process and cannot be shared with
  anyone who needs the link to outlive the review.
- Reviewers see the site as built from the branch, not as deployed by real staging
  infrastructure — deployment-specific breakage will not show up at this Gate.
- If Previews ever need to be durable or shareable, this is the decision to revisit;
  adding `workflow_dispatch` to `deploy-stage.yml` remains the fallback.
