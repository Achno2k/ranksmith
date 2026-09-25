import { readFile } from 'node:fs/promises';
import type { Job, JobEvent } from './jobs.ts';
import { reviewDocPath } from './paths.ts';

/**
 * What every earlier seo Job decided and what the humans did with it. Research reads this so
 * it stops re-deciding the same topic: CM-003, CM-007 and CM-008 each judged HubSpot scanning
 * from scratch, and the first of them had already been rejected.
 */
export interface LedgerSource {
  seoJobs(profile: string): Job[];
  history(id: string): JobEvent[];
}

const MAX_TOPIC = 160;
const MAX_DECISION = 400;
const MAX_HUMAN = 300;

/** Human words that explain an outcome, newest last. Approvals carry none. */
const SAID: ReadonlySet<JobEvent['type']> = new Set<JobEvent['type']>([
  'changes_requested',
  'rejected',
  'reopened',
  'revert_requested',
  'revert_cancelled',
]);

/** Markdown for the research prompt, or null when this is the profile's first seo Job. */
export async function renderLedger(source: LedgerSource, profile: string, currentJobId: string): Promise<string | null> {
  const jobs = source.seoJobs(profile).filter((job) => job.id !== currentJobId);
  if (jobs.length === 0) return null;

  const entries = await Promise.all(jobs.map((job) => entry(job, source.history(job.id))));
  return entries.join('\n');
}

async function entry(job: Job, history: JobEvent[]): Promise<string> {
  const head = [
    `- ${job.id} (${job.date}) · ${outcome(job, history)}`,
    job.slug ? `slug \`${job.slug}\`` : null,
    job.primaryKeyword ? `keyword \`${job.primaryKeyword}\`` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const decision = job.decision ?? (await decisionFromReport(job));
  const said = history
    .filter((event) => SAID.has(event.type) && event.detail)
    .map((event) => `${event.type.replace('_', ' ')}: "${clip(event.detail!, MAX_HUMAN)}"`);

  return [
    head,
    `  - Asked: ${job.topic ? clip(job.topic, MAX_TOPIC) : 'discovery, no topic'}`,
    `  - Decided: ${decision ? clip(decision, MAX_DECISION) : 'not recorded'}`,
    ...said.map((line) => `  - Human ${line}`),
  ].join('\n');
}

function outcome(job: Job, history: JobEvent[]): string {
  switch (job.state) {
    case 'done':
      return job.pullRequest !== null ? `shipped (PR #${job.pullRequest})` : 'approved';
    case 'reverted':
      return 'shipped, then reverted';
    case 'rejected':
      return history.at(-1)?.type === 'cancelled' ? 'stopped by a human, not shipped' : 'rejected, not shipped';
    case 'failed':
      // A pull request may have been merged by hand after the Job failed, as CM-008's was.
      return job.pullRequest !== null
        ? `failed after opening PR #${job.pullRequest}; check the site inventory before assuming it did not ship`
        : 'failed, not shipped';
    default:
      return `still open (${job.state})`;
  }
}

/**
 * Jobs from before the ledger stored decisions: the Decision section of the research copy
 * kept under research/, when this machine has it.
 */
async function decisionFromReport(job: Job): Promise<string | null> {
  const text = await readFile(reviewDocPath(job.id, job.date), 'utf8').catch(() => null);
  const section = text?.match(/^## Decision\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1];
  if (!section) return null;

  return section
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
    .filter(Boolean)
    .join('; ');
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
