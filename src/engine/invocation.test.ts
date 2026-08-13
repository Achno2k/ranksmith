import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRun } from './invocation.ts';
import type { SiteProfile } from './profile.ts';

const PROFILE: SiteProfile = {
  id: 'connectmachine',
  jobPrefix: 'CM',
  repo: {
    path: '/repos/website',
    baseRemote: 'upstream',
    baseBranch: 'main',
    pushRemote: 'origin',
    pullRequestRepo: 'connectmachine/website',
    branchPrefix: 'feat/seo-',
  },
  commands: {
    install: 'npm ci',
    checks: ['npm run check', 'npm run build', 'npm run parity'],
    preview: 'npm run preview',
  },
  budgets: { webSearches: 30, competitorPages: 10, ahrefsOperations: 3 },
  phases: {
    research: { backend: 'codex', model: 'gpt-5.6-sol', timeoutMs: 1_500_000, skill: 'connectmachine-seo-content' },
    research_revision: {
      backend: 'codex',
      model: 'gpt-5.6-sol',
      timeoutMs: 1_500_000,
      skill: 'connectmachine-seo-content',
    },
    content: { backend: 'claude', model: 'opus', timeoutMs: 2_400_000, skill: 'connectmachine-seo-content' },
    content_revision: {
      backend: 'claude',
      model: 'opus',
      timeoutMs: 2_400_000,
      skill: 'connectmachine-seo-content',
    },
  },
};

const base = {
  jobId: 'CM-001',
  profile: PROFILE,
  workspace: '/work/CM-001',
  date: '2026-08-14',
  topic: null as string | null,
  feedback: null as string | null,
  gaps: [] as string[],
};

describe('building an agent run', () => {
  it('sends research to Codex in the job workspace', () => {
    const run = buildRun({ ...base, phase: 'research' });

    assert.equal(run.command, 'codex');
    assert.equal(run.cwd, '/work/CM-001');
    assert.deepEqual(run.args, ['exec', '-C', '/work/CM-001', '-m', 'gpt-5.6-sol', '-s', 'workspace-write', '-']);
    assert.equal(run.timeoutMs, 1_500_000);
  });

  it('sends content generation to Claude', () => {
    const run = buildRun({ ...base, phase: 'content' });

    assert.equal(run.command, 'claude');
    assert.equal(run.cwd, '/work/CM-001');
    assert.deepEqual(run.args, ['-p', '--model', 'opus', '--permission-mode', 'acceptEdits']);
    assert.equal(run.timeoutMs, 2_400_000);
  });

  it('always names the skill, so an agent never runs bare', () => {
    for (const phase of ['research', 'research_revision', 'content', 'content_revision'] as const) {
      assert.match(buildRun({ ...base, phase }).prompt, /connectmachine-seo-content/);
    }
  });

  it('tells research to discover a topic when none was given', () => {
    const run = buildRun({ ...base, phase: 'research' });

    assert.match(run.prompt, /rank the opportunities you find/i);
  });

  it('names the topic when one was given', () => {
    const run = buildRun({ ...base, phase: 'research', topic: 'lead retrieval app' });

    assert.match(run.prompt, /lead retrieval app/);
    assert.doesNotMatch(run.prompt, /rank the opportunities you find/i);
  });

  it('states the budgets it wants respected', () => {
    const prompt = buildRun({ ...base, phase: 'research' }).prompt;

    assert.match(prompt, /30 web searches/);
    assert.match(prompt, /10 competitor pages/);
    assert.match(prompt, /3 Ahrefs operations/);
  });

  it('forbids the agent from merging or deploying', () => {
    const prompt = buildRun({ ...base, phase: 'content' }).prompt;

    assert.match(prompt, /do not merge/i);
    assert.match(prompt, /do not deploy/i);
  });

  it('demands the files the contract will be checked against', () => {
    const research = buildRun({ ...base, phase: 'research' }).prompt;

    assert.match(research, /docs\/seo-content\/2026-08-14-research\.md/);
    assert.match(research, /\.ranksmith\/result\.json/);
  });

  it('points content generation at the approved research', () => {
    const prompt = buildRun({ ...base, phase: 'content' }).prompt;

    assert.match(prompt, /docs\/seo-content\/2026-08-14-research\.md/);
  });

  it('passes human feedback through untouched', () => {
    const feedback = 'The competitor analysis is too shallow.\nLook at the top 5.';
    const prompt = buildRun({ ...base, phase: 'research_revision', feedback }).prompt;

    assert.ok(prompt.includes(feedback), 'feedback should appear verbatim');
  });

  it('spells out the gaps when retrying a contract miss', () => {
    const prompt = buildRun({
      ...base,
      phase: 'research',
      gaps: ['.ranksmith/result.json: missing field "slug"'],
    }).prompt;

    assert.match(prompt, /previous attempt/i);
    assert.match(prompt, /missing field "slug"/);
  });

  it('says nothing about a previous attempt on the first try', () => {
    assert.doesNotMatch(buildRun({ ...base, phase: 'research' }).prompt, /previous attempt/i);
  });
});
