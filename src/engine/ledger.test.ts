import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from './jobs.ts';
import { renderLedger } from './ledger.ts';

const start = (store: JobStore, topic: string | null, kind: 'seo' | 'marketing' = 'seo') =>
  store.createJob({ profile: 'connectmachine', jobPrefix: 'CM', kind, topic, slackChannel: 'C1', attachments: [] });

/** Runs research to its Gate with what the agent decided. */
const researched = (store: JobStore, topic: string, slug: string, keyword: string, decision: string) => {
  const job = start(store, topic);
  store.update(job.id, { slug, primary_keyword: keyword, decision });
  store.phaseCompleted(job.id);
  return job.id;
};

describe('the decisions ledger research reads', () => {
  it('is empty for the first seo job', async () => {
    const store = new JobStore(':memory:');
    const job = start(store, 'first');

    assert.equal(await renderLedger(store, 'connectmachine', job.id), null);
  });

  it('shows what each earlier job decided, what happened, and why', async () => {
    const store = new JobStore(':memory:');
    const rejected = researched(store, 'hubspot', 'scan-business-cards-to-hubspot', 'business card scanner hubspot', 'Publish HubSpot guide');
    store.reject(rejected, 'U1', 'Zapier covers this already');
    const open = researched(store, 'qr', 'qr-business-card', 'qr business card', 'Refresh QR page');
    start(store, 'SaaStr', 'marketing');
    const current = start(store, null);

    const ledger = (await renderLedger(store, 'connectmachine', current.id)) ?? '';

    assert.match(ledger, new RegExp(`- ${rejected} \\(\\d{4}-\\d{2}-\\d{2}\\) · rejected, not shipped · slug \`scan-business-cards-to-hubspot\` · keyword \`business card scanner hubspot\``));
    assert.match(ledger, /Decided: Publish HubSpot guide/);
    assert.match(ledger, /Human rejected: "Zapier covers this already"/);
    assert.match(ledger, new RegExp(`- ${open} .* still open \\(research_review\\)`));
    assert.doesNotMatch(ledger, /SaaStr/, 'marketing scans are not seo decisions');
    assert.doesNotMatch(ledger, new RegExp(current.id), 'a job is not in its own ledger');
  });

  it('does not call a failed job with a pull request unshipped', async () => {
    const store = new JobStore(':memory:');
    const failed = start(store, 'x');
    store.update(failed.id, { pull_request: 12 });
    store.phaseFailed(failed.id, 'deploy timed out');
    const current = start(store, null);

    assert.match((await renderLedger(store, 'connectmachine', current.id)) ?? '', /failed after opening PR #12; check the site inventory/);
  });

  it('marks a stopped job apart from a rejected one', async () => {
    const store = new JobStore(':memory:');
    const stopped = start(store, 'x');
    store.cancel(stopped.id, 'U1');
    const current = start(store, null);

    assert.match((await renderLedger(store, 'connectmachine', current.id)) ?? '', /stopped by a human, not shipped/);
  });
});
