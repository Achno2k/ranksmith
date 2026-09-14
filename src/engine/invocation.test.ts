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
  budgets: {
    webSearches: 30,
    competitorPages: 10,
    ahrefsOperations: 3,
    marketing: { webSearches: 60, pagesFetched: 25 },
  },
  phases: {
    research: { backend: 'codex', model: 'gpt-5.6-sol', timeoutMs: 1_500_000, skill: 'connectmachine-seo-content' },
    research_revision: {
      backend: 'codex',
      model: 'gpt-5.6-sol',
      timeoutMs: 1_500_000,
      skill: 'connectmachine-seo-content',
    },
    content: {
      backend: 'claude',
      model: 'claude-opus-5',
      timeoutMs: 2_400_000,
      skill: 'connectmachine-seo-content',
    },
    content_revision: {
      backend: 'claude',
      model: 'claude-opus-5',
      timeoutMs: 2_400_000,
      skill: 'connectmachine-seo-content',
    },
    marketing: {
      backend: 'claude',
      model: 'claude-opus-5',
      timeoutMs: 1_800_000,
      skill: 'connectmachine-marketing-opportunities',
    },
    marketing_revision: {
      backend: 'claude',
      model: 'claude-opus-5',
      timeoutMs: 1_800_000,
      skill: 'connectmachine-marketing-opportunities',
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
  attachments: [] as { name: string; mimetype: string }[],
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
    assert.deepEqual(run.args.slice(0, 5), ['-p', '--model', 'claude-opus-5', '--permission-mode', 'acceptEdits']);
    assert.equal(run.args[5], '--allowedTools');
    for (const tool of ['WebSearch', 'WebFetch', 'Bash(git commit *)', 'Bash(npm run build *)']) {
      assert.ok(run.args[6]?.split(',').includes(tool), `missing ${tool}`);
    }
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

  it('lists attached files and tells the agent to read them', () => {
    const prompt = buildRun({
      ...base,
      phase: 'research',
      attachments: [
        { name: 'brief.png', mimetype: 'image/png' },
        { name: 'notes.md', mimetype: 'text/markdown' },
      ],
    }).prompt;

    assert.match(prompt, /# Attachments/);
    assert.match(prompt, /\.ranksmith\/attachments\/brief\.png/);
    assert.match(prompt, /\.ranksmith\/attachments\/notes\.md/);
    assert.match(prompt, /image/);
  });

  it('omits the attachments section when there are none', () => {
    assert.doesNotMatch(buildRun({ ...base, phase: 'research' }).prompt, /# Attachments/);
  });
});

describe('building a marketing scan', () => {
  it('gives the agent the web and the browser but nothing that writes outside its directory', () => {
    const run = buildRun({ ...base, phase: 'marketing' });

    assert.equal(run.command, 'claude');
    const tools = run.args[run.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    for (const tool of ['WebSearch', 'WebFetch', 'mcp__playwright', 'mcp__plugin_playwright_playwright']) {
      assert.ok(tools.includes(tool), `missing ${tool}`);
    }
    assert.ok(!tools.some((tool) => tool.startsWith('Bash(')), 'a scan must not run shell commands');
    assert.equal(run.timeoutMs, 1_800_000);
  });

  it('opens the site checkout read-only for product facts', () => {
    const run = buildRun({ ...base, phase: 'marketing' });
    const tools = run.args[run.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];

    // --add-dir would make the checkout a working directory, which acceptEdits may edit.
    assert.ok(!run.args.includes('--add-dir'));
    assert.ok(tools.includes('Read(//repos/website/**)'));
    assert.ok(!tools.some((tool) => /^(Edit|Write)/.test(tool)));
    assert.match(run.prompt, /\/repos\/website/);
    assert.match(run.prompt, /do not edit it/i);
  });

  it('names the marketing skill, so an agent never runs bare', () => {
    for (const phase of ['marketing', 'marketing_revision'] as const) {
      assert.match(buildRun({ ...base, phase }).prompt, /connectmachine-marketing-opportunities/);
    }
  });

  it('asks for a full scan across every lane when no focus was given', () => {
    const prompt = buildRun({ ...base, phase: 'marketing' }).prompt;

    assert.match(prompt, /every lane/i);
    assert.doesNotMatch(prompt, /around this focus/i);
  });

  it('treats a focus as a lens rather than a fence', () => {
    const prompt = buildRun({ ...base, phase: 'marketing', topic: 'SaaStr Annual 2026' }).prompt;

    assert.match(prompt, /SaaStr Annual 2026/);
    assert.match(prompt, /not a fence/i);
    assert.doesNotMatch(prompt, /every lane in the skill/i);
  });

  it('forbids sending, posting, logging in, and writing to a CRM', () => {
    const prompt = buildRun({ ...base, phase: 'marketing' }).prompt;

    assert.match(prompt, /do not send emails/i);
    assert.match(prompt, /never log in/i);
    assert.match(prompt, /crm/i);
    assert.doesNotMatch(prompt, /do not merge/i);
  });

  it('demands the report, the targets csv, and the result file', () => {
    const prompt = buildRun({ ...base, phase: 'marketing' }).prompt;

    assert.match(prompt, /docs\/marketing\/2026-08-14-opportunities\.md/);
    assert.match(prompt, /docs\/marketing\/2026-08-14-targets\.csv/);
    assert.match(prompt, /source_url/);
    assert.match(prompt, /\.ranksmith\/result\.json/);
    assert.match(prompt, /top_opportunities/);
  });

  it('states its own search and page budget without mentioning Ahrefs', () => {
    const prompt = buildRun({ ...base, phase: 'marketing' }).prompt;

    assert.match(prompt, /60 web searches/);
    assert.match(prompt, /25 fetched pages/);
    assert.doesNotMatch(prompt, /Ahrefs/);
  });

  it('points a revision at the report it already wrote', () => {
    const prompt = buildRun({ ...base, phase: 'marketing_revision', feedback: 'more on partnerships' }).prompt;

    assert.match(prompt, /revise the marketing report/i);
    assert.match(prompt, /docs\/marketing\/2026-08-14-opportunities\.md/);
    assert.match(prompt, /more on partnerships/);
  });
});
