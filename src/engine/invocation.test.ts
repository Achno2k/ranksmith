import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRun, CHECK_COMMAND } from './invocation.ts';
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
  },
  preview: { project: 'ranksmith-connectmachine', outputDir: 'dist' },
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

describe('what research is told beyond the task', () => {
  it('points research at the first-party data and hands it the ledger', () => {
    const prompt = buildRun({ ...base, phase: 'research', ledger: '- CM-003 (2026-08-24) · rejected, not shipped' }).prompt;

    assert.match(prompt, /# First-party search data\n\n.*`\.ranksmith\/search-data\.md`/);
    assert.match(prompt, /# Past decisions[\s\S]*- CM-003 \(2026-08-24\) · rejected, not shipped/);
  });

  it('leaves both out of content and marketing, and the ledger out when there is none', () => {
    for (const phase of ['content', 'marketing'] as const) {
      const prompt = buildRun({ ...base, phase, ledger: '- CM-003' }).prompt;
      assert.doesNotMatch(prompt, /# First-party search data|# Past decisions/, phase);
    }
    assert.doesNotMatch(buildRun({ ...base, phase: 'research', ledger: null }).prompt, /# Past decisions/);
  });
});

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
    const tools = run.args[6]?.split(',') ?? [];
    for (const tool of ['WebSearch', 'WebFetch', 'Bash(git commit:*)', 'Bash(npm run check:*)']) {
      assert.ok(tools.includes(tool), `missing ${tool}`);
    }
    assert.equal(run.timeoutMs, 2_400_000);
  });

  it('uses the prefix form for every Bash rule and leaves the build to the preview step', () => {
    const run = buildRun({ ...base, phase: 'content' });
    const tools = run.args[run.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    const bash = tools.filter((tool) => tool.startsWith('Bash('));

    assert.ok(bash.length > 0);
    for (const rule of bash) assert.match(rule, /^Bash\([^)]+:\*\)$/, `${rule} is not prefix form`);
    assert.ok(!tools.some((tool) => /npm run (build|parity)/.test(tool)), 'build and parity run in the preview step');
  });

  it('asks Claude for one JSON event per line so the log keeps tool calls', () => {
    const run = buildRun({ ...base, phase: 'content' });

    assert.deepEqual(run.args.slice(7, 10), ['--output-format', 'stream-json', '--verbose']);
    assert.ok(!buildRun({ ...base, phase: 'research' }).args.includes('--output-format'), 'codex is unchanged');
  });

  it('installs the budget hook and tells the agent how to check its own work', () => {
    const run = buildRun({ ...base, phase: 'content' });
    const settings = JSON.parse(run.args[run.args.indexOf('--settings') + 1] ?? '{}') as {
      hooks: { PreToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] };
    };

    assert.equal(settings.hooks.PreToolUse[0]?.matcher, 'WebSearch|WebFetch');
    assert.match(settings.hooks.PreToolUse[0]?.hooks[0]?.command ?? '', /^node .*\/bin\/ranksmith-budget$/);
    assert.ok(run.prompt.includes(`\`${CHECK_COMMAND} content 2026-08-14\``));
    const tools = run.args[run.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    assert.ok(tools.includes(`Bash(${CHECK_COMMAND}:*)`), 'the self-check must be runnable');
  });

  it('gives research Ahrefs and every phase the skills directory, nothing else new', () => {
    const research = { backend: 'claude', model: 'claude-opus-5', timeoutMs: 1_500_000, skill: 'connectmachine-seo-content' } as const;
    const tools = (phase: 'research' | 'content' | 'marketing') => {
      const run = buildRun({ ...base, phase, profile: { ...PROFILE, phases: { ...PROFILE.phases, research } } });
      return run.args[run.args.indexOf('--allowedTools') + 1]?.split(',') ?? [];
    };

    assert.ok(tools('research').includes('mcp__claude_ai_Ahrefs'));
    assert.ok(!tools('content').includes('mcp__claude_ai_Ahrefs'));
    assert.ok(!tools('marketing').includes('mcp__claude_ai_Ahrefs'));
    for (const phase of ['research', 'content', 'marketing'] as const) {
      assert.ok(tools(phase).some((tool) => /^Read\(\/\/.*\/\.claude\/skills\/\*\*\)$/.test(tool)), `${phase} cannot read skills`);
    }
  });

  it('spells out every contract rule in the prompt', () => {
    const research = buildRun({ ...base, phase: 'research' }).prompt;
    assert.match(research, /must contain a markdown table: Ranked Opportunities/);
    assert.match(research, /non-empty arrays: why/);
    assert.match(research, /slug must match \^/);

    const marketing = buildRun({ ...base, phase: 'marketing' }).prompt;
    assert.match(marketing, /every row must hold a value starting with http:\/\/ or https:\/\/ in: source_url/);
    assert.match(marketing, /non-empty arrays: top_opportunities/);
  });

  it('resumes the same session only for a revision of the same phase', () => {
    const resumed = buildRun({ ...base, phase: 'content_revision', feedback: 'tighten it', resumeSessionId: 'sess-1' });
    assert.deepEqual(resumed.args.slice(-2), ['--resume', 'sess-1']);

    // A first pass never continues another Phase: only Artifacts carry between Phases.
    for (const phase of ['content', 'marketing'] as const) {
      assert.ok(!buildRun({ ...base, phase, resumeSessionId: 'sess-1' }).args.includes('--resume'), phase);
    }
    assert.ok(!buildRun({ ...base, phase: 'content_revision', feedback: 'x' }).args.includes('--resume'));
    assert.ok(!buildRun({ ...base, phase: 'content_revision', feedback: 'x', resumeSessionId: null }).args.includes('--resume'));
  });

  it('keeps the prompt the same whether or not a session is resumed', () => {
    const fresh = buildRun({ ...base, phase: 'content_revision', feedback: 'tighten it' });
    const resumed = buildRun({ ...base, phase: 'content_revision', feedback: 'tighten it', resumeSessionId: 'sess-1' });

    assert.equal(fresh.prompt, resumed.prompt);
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
    const shell = tools.filter((tool) => tool.startsWith('Bash('));
    assert.deepEqual(shell, [`Bash(${CHECK_COMMAND}:*)`], 'a scan may only run the self-check');
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
