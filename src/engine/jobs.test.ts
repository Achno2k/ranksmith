import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { JobStore } from './jobs.ts';

const openStore = () => new JobStore(':memory:');

const startJob = (store: JobStore, topic: string | null = null) =>
  store.createJob({ profile: 'connectmachine', jobPrefix: 'CM', topic, slackChannel: 'C123', attachments: [] });

describe('starting a job', () => {
  it('begins researching', () => {
    const job = startJob(openStore());

    assert.equal(job.state, 'researching');
  });

  it('numbers jobs per profile so humans can name them in Slack', () => {
    const store = openStore();

    assert.equal(startJob(store).id, 'CM-001');
    assert.equal(startJob(store).id, 'CM-002');
  });

  it('remembers a directed topic, and records its absence for discovery mode', () => {
    const store = openStore();

    assert.equal(startJob(store, 'lead retrieval app').topic, 'lead retrieval app');
    assert.equal(startJob(store).topic, null);
  });

  it('stores attachments from the initial message', () => {
    const store = openStore();
    const job = store.createJob({
      profile: 'connectmachine',
      jobPrefix: 'CM',
      topic: null,
      slackChannel: 'C123',
      attachments: [{ name: 'brief.png', mimetype: 'image/png' }],
    });

    assert.deepEqual(job.attachments, [{ name: 'brief.png', mimetype: 'image/png' }]);
    assert.deepEqual(store.getJob(job.id)?.attachments, [{ name: 'brief.png', mimetype: 'image/png' }]);
  });
});

describe('feedback attachments', () => {
  const atResearchGate = (store: JobStore) => {
    const job = startJob(store);
    store.phaseCompleted(job.id);
    return job.id;
  };

  it('appends feedback attachments to the job', () => {
    const store = openStore();
    const id = atResearchGate(store);

    store.recordFeedback(id, 'U1', 'use the attached brief', [{ name: 'brief.pdf', mimetype: 'application/pdf' }]);

    assert.deepEqual(store.getJob(id)?.attachments, [
      { name: 'brief.pdf', mimetype: 'application/pdf' },
    ]);
  });

  it('keeps earlier attachments when adding feedback attachments', () => {
    const store = openStore();
    const job = store.createJob({
      profile: 'connectmachine',
      jobPrefix: 'CM',
      topic: null,
      slackChannel: 'C123',
      attachments: [{ name: 'brief.png', mimetype: 'image/png' }],
    });
    store.phaseCompleted(job.id);

    store.recordFeedback(job.id, 'U1', 'also see notes', [{ name: 'notes.md', mimetype: 'text/markdown' }]);

    assert.deepEqual(store.getJob(job.id)?.attachments, [
      { name: 'brief.png', mimetype: 'image/png' },
      { name: 'notes.md', mimetype: 'text/markdown' },
    ]);
  });

  it('replaces an earlier attachment when feedback uses the same name', () => {
    const store = openStore();
    const job = store.createJob({
      profile: 'connectmachine',
      jobPrefix: 'CM',
      topic: null,
      slackChannel: 'C123',
      attachments: [{ name: 'brief.png', mimetype: 'image/png' }],
    });
    store.phaseCompleted(job.id);

    store.recordFeedback(job.id, 'U1', 'new version', [{ name: 'brief.png', mimetype: 'image/jpeg' }]);

    assert.deepEqual(store.getJob(job.id)?.attachments, [{ name: 'brief.png', mimetype: 'image/jpeg' }]);
  });
});

describe('completing a phase', () => {
  it('carries research to its gate', () => {
    const store = openStore();
    const job = startJob(store);

    assert.equal(store.phaseCompleted(job.id).state, 'research_review');
  });

  it('walks the whole happy path from approved research to done', () => {
    const store = openStore();
    const job = startJob(store);

    store.phaseCompleted(job.id);
    store.approve(job.id, 'U1');
    assert.equal(store.getJob(job.id)?.state, 'generating');

    assert.equal(store.phaseCompleted(job.id).state, 'preview_building');
    assert.equal(store.phaseCompleted(job.id).state, 'content_review');

    store.approve(job.id, 'U1');
    assert.equal(store.getJob(job.id)?.state, 'merging');
    assert.equal(store.phaseCompleted(job.id).state, 'done');
  });

  it('refuses to advance a job that is waiting on a human', () => {
    const store = openStore();
    const job = startJob(store);
    store.phaseCompleted(job.id);

    assert.throws(() => store.phaseCompleted(job.id), /research_review/);
  });
});

describe('human actions at a gate', () => {
  const atResearchGate = (store: JobStore) => {
    const job = startJob(store);
    store.phaseCompleted(job.id);
    return job.id;
  };

  const atContentGate = (store: JobStore) => {
    const id = atResearchGate(store);
    store.approve(id, 'U1');
    store.phaseCompleted(id);
    store.phaseCompleted(id);
    return id;
  };

  it('sends a rejected job to a terminal state', () => {
    const store = openStore();

    assert.equal(store.reject(atResearchGate(store), 'U1', 'wrong angle').state, 'rejected');
  });

  it('sends feedback back to the phase that produced the work', () => {
    const store = openStore();

    assert.equal(
      store.recordFeedback(atResearchGate(store), 'U1', 'competitor analysis too shallow')?.state,
      'research_revising',
    );
    assert.equal(store.recordFeedback(atContentGate(store), 'U1', 'CTA is weak')?.state, 'content_revising');
  });

  it('ignores a reply when the job is not waiting on a human', () => {
    const store = openStore();
    const job = startJob(store);

    assert.equal(store.recordFeedback(job.id, 'U1', 'just thinking out loud'), null);
    assert.equal(store.getJob(job.id)?.state, 'researching');
  });

  it('hands the latest feedback to the revision phase verbatim', () => {
    const store = openStore();
    const id = atResearchGate(store);

    store.recordFeedback(id, 'U1', 'look at the top 5 competitors');

    assert.equal(store.pendingFeedback(id), 'look at the top 5 competitors');
  });

  it('does not replay old feedback into a later phase', () => {
    const store = openStore();
    const id = atResearchGate(store);

    store.recordFeedback(id, 'U1', 'look at the top 5 competitors');
    store.phaseCompleted(id);
    store.approve(id, 'U1');

    assert.equal(store.pendingFeedback(id), null);
  });

  it('will not let a job be approved before it reaches a gate', () => {
    const store = openStore();
    const job = startJob(store);

    assert.throws(() => store.approve(job.id, 'U1'), /researching/);
  });

  it('records who acted and what they said', () => {
    const store = openStore();
    const id = atResearchGate(store);

    store.recordFeedback(id, 'U1', 'too shallow');
    store.phaseCompleted(id);
    store.approve(id, 'U2');

    assert.deepEqual(
      store.history(id).map((event) => [event.type, event.actor, event.detail]),
      [
        ['job_created', 'system', null],
        ['phase_completed', 'system', null],
        ['changes_requested', 'U1', 'too shallow'],
        ['phase_completed', 'system', null],
        ['approved', 'U2', null],
      ],
    );
  });
});

describe('stopping a job', () => {
  it('cancels work while a phase is running', () => {
    const store = openStore();
    const job = startJob(store);

    assert.equal(store.cancel(job.id, 'U1')?.state, 'rejected');
    assert.deepEqual(store.history(job.id).at(-1), {
      type: 'cancelled',
      actor: 'U1',
      detail: null,
    });
  });

  it('cancels work while it is waiting at a gate', () => {
    const store = openStore();
    const job = startJob(store);
    store.phaseCompleted(job.id);

    assert.equal(store.cancel(job.id, 'U1')?.state, 'rejected');
  });

  it('does nothing when the job is already terminal', () => {
    const store = openStore();
    const job = startJob(store);
    store.cancel(job.id, 'U1');

    assert.equal(store.cancel(job.id, 'U1'), null);
  });
});

describe('a failed phase', () => {
  it('parks the job and keeps the reason', () => {
    const store = openStore();
    const job = startJob(store);

    const failed = store.phaseFailed(job.id, 'timed out after 25m');

    assert.equal(failed.state, 'failed');
    assert.equal(store.history(job.id).at(-1)?.detail, 'timed out after 25m');
  });

  it('can be sent back to the step it died on, so finished work is not redone', () => {
    const store = openStore();
    const job = startJob(store);
    store.phaseCompleted(job.id);
    store.approve(job.id, 'U1');
    store.phaseCompleted(job.id);
    assert.equal(store.getJob(job.id)?.state, 'preview_building');

    store.phaseFailed(job.id, 'gh pr create exited 1');

    assert.equal(store.retryFailed(job.id).state, 'preview_building');
  });

  it('refuses to retry a job that has not failed', () => {
    const store = openStore();
    const job = startJob(store);

    assert.throws(() => store.retryFailed(job.id), /researching/);
  });
});

describe('reverting a finished job', () => {
  const finished = (store: JobStore) => {
    const job = startJob(store);
    store.phaseCompleted(job.id);
    store.approve(job.id, 'U1');
    store.phaseCompleted(job.id);
    store.phaseCompleted(job.id);
    store.approve(job.id, 'U1');
    store.phaseCompleted(job.id);
    return job.id;
  };

  it('only reverts a job that is done', () => {
    const store = openStore();
    const job = startJob(store);

    assert.equal(store.requestRevert(job.id, 'U1', 'undo'), null);
    assert.equal(store.getJob(job.id)?.state, 'researching');
  });

  it('opens a revert, waits for a human, then finishes reverted', () => {
    const store = openStore();
    const id = finished(store);

    assert.equal(store.requestRevert(id, 'U1', 'not good enough')?.state, 'reverting');
    assert.equal(store.phaseCompleted(id).state, 'revert_review');
    assert.equal(store.approve(id, 'U2').state, 'revert_merging');
    assert.equal(store.phaseCompleted(id).state, 'reverted');
    assert.deepEqual(store.liveJobs(), []);
  });

  it('returns to done when the revert is rejected', () => {
    const store = openStore();
    const id = finished(store);
    store.requestRevert(id, 'U1', null);
    store.phaseCompleted(id);

    assert.equal(store.reject(id, 'U2').state, 'done');
    assert.equal(store.history(id).at(-1)?.type, 'revert_cancelled');
  });

  it('does not treat a reply at the revert gate as content feedback', () => {
    const store = openStore();
    const id = finished(store);
    store.requestRevert(id, 'U1', null);
    store.phaseCompleted(id);

    assert.equal(store.recordFeedback(id, 'U1', 'change the CTA'), null);
    assert.equal(store.getJob(id)?.state, 'revert_review');
  });

  it('goes straight to reverted when the pull request never merged', () => {
    const store = openStore();
    const id = finished(store);
    store.requestRevert(id, 'U1', null);

    assert.equal(store.revertedBeforeMerge(id).state, 'reverted');
  });

  it('cannot be stopped halfway through a revert', () => {
    const store = openStore();
    const id = finished(store);
    store.requestRevert(id, 'U1', null);

    assert.equal(store.cancel(id, 'U1'), null);
    assert.equal(store.getJob(id)?.state, 'reverting');
  });
});
