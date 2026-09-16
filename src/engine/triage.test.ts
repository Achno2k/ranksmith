import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Job } from './jobs.ts';
import { buildTriage, parseTriage } from './triage.ts';

const JOB: Job = {
  id: 'CM-001',
  profile: 'connectmachine',
  kind: 'seo',
  topic: 'camcard alternative',
  state: 'done',
  slackChannel: 'C123',
  date: '2026-09-14',
  slackThreadTs: '100.001',
  slug: 'camcard-alternative',
  branch: null,
  pullRequest: 35,
  previewUrl: null,
  attachments: [],
  revertPullRequest: null,
  followUp: false,
  shippedPullRequest: null,
};

describe('reading the intent of a thread mention', () => {
  it('keeps the answer to a question', () => {
    assert.deepEqual(parseTriage('INTENT: question\nYes. It merged at 09:07 and staging deployed.'), {
      intent: 'question',
      answer: 'Yes. It merged at 09:07 and staging deployed.',
    });
  });

  it('tolerates a preamble, any case, and markdown around the intent line', () => {
    assert.deepEqual(parseTriage('Checking the job.\n`intent: REVERT`'), { intent: 'revert', answer: '' });
  });

  it('drops text after an intent that is not a question', () => {
    assert.deepEqual(parseTriage('INTENT: feedback\nI will change the CTA.'), { intent: 'feedback', answer: '' });
  });

  it('recognises a request for a fresh preview', () => {
    assert.deepEqual(parseTriage('INTENT: preview'), { intent: 'preview', answer: '' });
    assert.deepEqual(parseTriage('INTENT: preview\nRebuilding now.'), { intent: 'preview', answer: '' });
  });

  it('returns null when the format is missing or the intent is unknown', () => {
    assert.equal(parseTriage('Sure, reverting now.'), null);
    assert.equal(parseTriage('INTENT: approve'), null);
  });
});

describe('building a triage run', () => {
  it('runs read-only, so triage can never change the site or the job', () => {
    const { args } = buildTriage({ job: JOB, text: 'is this on staging?', context: [], cwd: '/repo' });
    const allowed = args[args.indexOf('--allowedTools') + 1]?.split(',') ?? [];

    assert.ok(allowed.length > 0);
    assert.ok(!allowed.some((tool) => /^(Edit|Write)$|git (add|commit|push|revert)|gh pr (merge|close)/.test(tool)));
    assert.deepEqual(args[args.indexOf('--disallowedTools') + 1]?.split(','), ['Edit', 'Write', 'NotebookEdit']);
  });

  it('gives the agent the message and what the Engine already knows', () => {
    const { prompt } = buildTriage({
      job: JOB,
      text: 'is this on staging?',
      context: ['Pull request: https://github.com/x/y/pull/35, merged'],
      cwd: '/repo',
    });

    assert.match(prompt, /is this on staging\?/);
    assert.match(prompt, /pull\/35, merged/);
    assert.match(prompt, /INTENT: <intent>/);
  });

  it('offers the preview intent and keeps question as the tie-break', () => {
    const { prompt } = buildTriage({ job: JOB, text: 'link is dead', context: [], cwd: '/repo' });

    assert.match(prompt, /- preview: .*preview link.*down or broken/);
    assert.match(prompt, /If it is unclear, pick question/);
  });
});
