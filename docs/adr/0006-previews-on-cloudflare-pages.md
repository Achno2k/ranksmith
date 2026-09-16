---
status: accepted
---

# Previews are static deployments on Cloudflare Pages, not tunnels

ADR 0003 served each Job's Workspace through a `cloudflared` quick tunnel. Two things kept
breaking it. The tunnel lived exactly as long as the Engine process, and every deploy to the
host restarts that process, so a review link posted in the morning was dead by lunch. And
Cloudflare hands out a random hostname before it serves it; whoever resolved the name in that
window cached "no such name" for thirty minutes, the reviewer included. Rebuilding tunnels
from Slack and at boot papered over the first problem and could not touch the second.

The site builds to a static `dist/`. The Engine now uploads that directory to a Cloudflare
Pages project with `wrangler pages deploy`, one deployment per Job branch, and posts the
deployment's own URL. Nothing has to stay running for the link to work.

## Considered options

Keeping tunnels and adding a supervisor to restart them was rejected: it fixes the process
lifetime and not the DNS caching, and every restart hands reviewers yet another hostname.

Deploying the pull request to shared staging was rejected for the reasons in ADR 0003; they
still hold.

## Consequences

- Preview URLs are permanent and shareable. Each revision gets a new one and the old one
  keeps showing the old content, so a reviewer can compare rounds.
- The link opens on the page the content Phase changed: the Phase names it as `preview_path`
  in its result file, and the Engine checks the page is in the build before linking it.
- The Engine needs a Cloudflare API token with Pages edit rights and the account id. The
  Pages project is created on the first deploy.
- Only static output is previewed. Anything that needs a server at request time will not
  show up at this Gate.
- Deployments accumulate in the Pages project. Nothing prunes them yet.
