import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { validateContract, type PhaseContract } from './contract.ts';

const RESEARCH_CONTRACT: PhaseContract = {
  files: [
    {
      path: 'docs/seo-content/2026-08-14-research.md',
      kind: 'markdown',
      headings: ['Decision', 'Why', 'Ahrefs Evidence', 'Ranked Opportunities'],
    },
    {
      path: '.ranksmith/result.json',
      kind: 'json',
      fields: ['slug', 'primary_keyword'],
    },
  ],
};

const GOOD_MARKDOWN = [
  '# Research',
  '## Decision',
  '- publish X',
  '## Why',
  '- volume 400, KD 3',
  '## Ahrefs Evidence',
  '| kw | vol |',
  '## Ranked Opportunities',
  '| score | topic |',
].join('\n');

const GOOD_JSON = JSON.stringify({ slug: 'lead-retrieval-app', primary_keyword: 'lead retrieval app' });

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ranksmith-contract-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return dir;
}

const complete = {
  'docs/seo-content/2026-08-14-research.md': GOOD_MARKDOWN,
  '.ranksmith/result.json': GOOD_JSON,
};

describe('validating a phase contract', () => {
  it('passes when the phase produced everything it promised', async () => {
    const result = await validateContract(await workspace(complete), RESEARCH_CONTRACT);

    assert.deepEqual(result, { ok: true });
  });

  it('names a file the phase never wrote', async () => {
    const dir = await workspace({ '.ranksmith/result.json': GOOD_JSON });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.ok, false);
    assert.deepEqual(result.gaps, ['docs/seo-content/2026-08-14-research.md: file not written']);
  });

  it('treats an empty file as not written', async () => {
    const dir = await workspace({ ...complete, '.ranksmith/result.json': '   ' });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.ok, false);
    assert.deepEqual(result.gaps, ['.ranksmith/result.json: file is empty']);
  });

  it('names every heading the artifact is missing', async () => {
    const dir = await workspace({
      ...complete,
      'docs/seo-content/2026-08-14-research.md': '# Research\n## Decision\n- publish X',
    });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.ok, false);
    assert.deepEqual(result.gaps, [
      'docs/seo-content/2026-08-14-research.md: missing heading "Why"',
      'docs/seo-content/2026-08-14-research.md: missing heading "Ahrefs Evidence"',
      'docs/seo-content/2026-08-14-research.md: missing heading "Ranked Opportunities"',
    ]);
  });

  it('names a required field the result omitted', async () => {
    const dir = await workspace({ ...complete, '.ranksmith/result.json': JSON.stringify({ slug: 'x' }) });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.ok, false);
    assert.deepEqual(result.gaps, ['.ranksmith/result.json: missing field "primary_keyword"']);
  });

  it('rejects a result that is not valid json', async () => {
    const dir = await workspace({ ...complete, '.ranksmith/result.json': '{ slug: nope }' });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.ok, false);
    assert.equal(result.gaps?.length, 1);
    assert.match(result.gaps![0]!, /^\.ranksmith\/result\.json: not valid json/);
  });

  it('reports every gap at once so one retry can fix them all', async () => {
    const dir = await workspace({
      'docs/seo-content/2026-08-14-research.md': '# Research\n## Decision\n- x',
      '.ranksmith/result.json': JSON.stringify({}),
    });

    const result = await validateContract(dir, RESEARCH_CONTRACT);

    assert.deepEqual(result.gaps, [
      'docs/seo-content/2026-08-14-research.md: missing heading "Why"',
      'docs/seo-content/2026-08-14-research.md: missing heading "Ahrefs Evidence"',
      'docs/seo-content/2026-08-14-research.md: missing heading "Ranked Opportunities"',
      '.ranksmith/result.json: missing field "slug"',
      '.ranksmith/result.json: missing field "primary_keyword"',
    ]);
  });

  it('does not care what level a heading sits at', async () => {
    const dir = await workspace({
      ...complete,
      'docs/seo-content/2026-08-14-research.md': GOOD_MARKDOWN.replaceAll('## ', '### '),
    });

    assert.deepEqual(await validateContract(dir, RESEARCH_CONTRACT), { ok: true });
  });
});

describe('validating a csv requirement', () => {
  const TARGETS: PhaseContract = {
    files: [{ path: 'docs/marketing/targets.csv', kind: 'csv', columns: ['name', 'source_url', 'next_action'] }],
  };

  it('passes when the header has every column and there is a row', async () => {
    const dir = await workspace({
      'docs/marketing/targets.csv': 'name,org,source_url,next_action\nAda,Acme,https://x.test/ada,email\n',
    });

    assert.deepEqual(await validateContract(dir, TARGETS), { ok: true });
  });

  it('ignores column order, case, and quoting in the header', async () => {
    const dir = await workspace({
      'docs/marketing/targets.csv': '"Next_Action","Source_URL","Name"\nemail,https://x.test,Ada\n',
    });

    assert.deepEqual(await validateContract(dir, TARGETS), { ok: true });
  });

  it('names every missing column', async () => {
    const dir = await workspace({ 'docs/marketing/targets.csv': 'name,org\nAda,Acme\n' });

    const result = await validateContract(dir, TARGETS);

    assert.deepEqual(result.gaps, [
      'docs/marketing/targets.csv: missing column "source_url"',
      'docs/marketing/targets.csv: missing column "next_action"',
    ]);
  });

  it('rejects a header with nothing under it', async () => {
    const dir = await workspace({ 'docs/marketing/targets.csv': 'name,source_url,next_action\n\n' });

    const result = await validateContract(dir, TARGETS);

    assert.deepEqual(result.gaps, ['docs/marketing/targets.csv: no rows below the header']);
  });
});
