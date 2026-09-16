import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { splitCsvRow, validateContract, type PhaseContract } from './contract.ts';
import { contractFor } from './phases.ts';

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

const RESEARCH_MARKDOWN = [
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

const GOOD_MARKDOWN = RESEARCH_MARKDOWN;

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

describe('checking a csv row for urls', () => {
  const TARGETS: PhaseContract = {
    files: [{ path: 'targets.csv', kind: 'csv', columns: ['name', 'source_url'], urlColumns: ['source_url'] }],
  };

  it('passes when every row links to its source', async () => {
    const dir = await workspace({
      'targets.csv': 'name,source_url\nAda,https://x.test/ada\n"Bob, Jr.",http://x.test/bob\n',
    });

    assert.deepEqual(await validateContract(dir, TARGETS), { ok: true });
  });

  it('names the row that has no url, by file line', async () => {
    const dir = await workspace({
      'targets.csv': 'name,source_url\nAda,https://x.test/ada\n\nBob,n/a\nCy,\n',
    });

    const result = await validateContract(dir, TARGETS);

    assert.deepEqual(result.gaps, [
      'targets.csv: row 4: "source_url" must start with http:// or https:// (got "n/a")',
      'targets.csv: row 5: "source_url" must start with http:// or https:// (got "")',
    ]);
  });

  it('finds the url column even when a quoted cell before it holds a comma', async () => {
    const dir = await workspace({ 'targets.csv': 'name,source_url\n"Ada, PhD",https://x.test/ada\n' });

    assert.deepEqual(await validateContract(dir, TARGETS), { ok: true });
  });

  it('does not double-report a url column that is missing from the header', async () => {
    const dir = await workspace({ 'targets.csv': 'name\nAda\n' });

    assert.deepEqual((await validateContract(dir, TARGETS)).gaps, ['targets.csv: missing column "source_url"']);
  });
});

describe('splitting a csv row', () => {
  it('splits on bare commas', () => {
    assert.deepEqual(splitCsvRow('a,b,,d'), ['a', 'b', '', 'd']);
  });

  it('keeps a comma inside quotes', () => {
    assert.deepEqual(splitCsvRow('"Ada, PhD",Acme,"x, y, z"'), ['Ada, PhD', 'Acme', 'x, y, z']);
  });

  it('turns a doubled quote into a literal one', () => {
    assert.deepEqual(splitCsvRow('"say ""hi""",b'), ['say "hi"', 'b']);
  });

  it('keeps trailing and empty cells', () => {
    assert.deepEqual(splitCsvRow('a,'), ['a', '']);
    assert.deepEqual(splitCsvRow(''), ['']);
  });
});

describe('checking a json result for arrays and patterns', () => {
  const SLUG = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
  const RESULT: PhaseContract = {
    files: [{ path: 'r.json', kind: 'json', fields: ['slug'], arrays: ['why', 'files'], patterns: { slug: SLUG } }],
  };

  it('passes a well-formed result', async () => {
    const dir = await workspace({ 'r.json': JSON.stringify({ slug: 'lead-retrieval-app', why: ['a'], files: ['f'] }) });

    assert.deepEqual(await validateContract(dir, RESULT), { ok: true });
  });

  it('rejects an empty array, a non-array, and a slug with the wrong shape', async () => {
    const dir = await workspace({ 'r.json': JSON.stringify({ slug: 'Lead Retrieval', why: [], files: 'f' }) });

    const result = await validateContract(dir, RESULT);

    assert.deepEqual(result.gaps, [
      'r.json: field "why" must be a non-empty array',
      'r.json: field "files" must be a non-empty array',
      'r.json: field "slug" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ (got "Lead Retrieval")',
    ]);
  });

  it('reports an absent field once, whichever rules mention it', async () => {
    const dir = await workspace({ 'r.json': JSON.stringify({ why: ['a'], files: ['f'] }) });

    assert.deepEqual((await validateContract(dir, RESULT)).gaps, ['r.json: missing field "slug"']);
  });

  it('accepts a compiled RegExp as well as its source', async () => {
    const dir = await workspace({ 'r.json': JSON.stringify({ slug: 'ok', why: ['a'], files: ['f'] }) });
    const compiled: PhaseContract = {
      files: [{ path: 'r.json', kind: 'json', fields: ['slug'], patterns: { slug: /^ok$/ } }],
    };

    assert.deepEqual(await validateContract(dir, compiled), { ok: true });
  });
});

describe('checking a markdown section for a table', () => {
  const EVIDENCE: PhaseContract = {
    files: [{ path: 'r.md', kind: 'markdown', headings: ['Ahrefs Evidence'], tables: ['Ahrefs Evidence', 'Ranked'] }],
  };

  it('passes when the section holds a table row', async () => {
    const dir = await workspace({
      'r.md': '## Ahrefs Evidence\n| kw | vol |\n|---|---|\n| a | 1 |\n## Ranked\n  | 1 | a |\n',
    });

    assert.deepEqual(await validateContract(dir, EVIDENCE), { ok: true });
  });

  it('rejects a section that only talks about a table', async () => {
    const dir = await workspace({ 'r.md': '## Ahrefs Evidence\nunavailable today\n## Ranked\n| 1 | a |\n' });

    assert.deepEqual((await validateContract(dir, EVIDENCE)).gaps, [
      'r.md: section "Ahrefs Evidence" has no table row',
    ]);
  });

  it('counts a table under a deeper subheading, but not one under the next sibling', async () => {
    const nested = '## Ahrefs Evidence\n### Keywords\n| a | 1 |\n## Ranked\ntext\n## Later\n| x |\n';
    const dir = await workspace({ 'r.md': nested });

    assert.deepEqual((await validateContract(dir, EVIDENCE)).gaps, ['r.md: section "Ranked" has no table row']);
  });

  it('reports a heading that is missing only once', async () => {
    const dir = await workspace({ 'r.md': '## Ranked\n| 1 |\n' });

    assert.deepEqual((await validateContract(dir, EVIDENCE)).gaps, ['r.md: missing heading "Ahrefs Evidence"']);
  });

  it('names a table heading that is not in the heading list when it is absent', async () => {
    const dir = await workspace({ 'r.md': '## Ahrefs Evidence\n| 1 |\n' });

    assert.deepEqual((await validateContract(dir, EVIDENCE)).gaps, ['r.md: missing heading "Ranked"']);
  });
});

describe('the content contract', () => {
  const research = 'docs/seo-content/2026-08-14-research.md';
  // The real research contract also wants a Publish Brief section.
  const GOOD_MARKDOWN = `${RESEARCH_MARKDOWN}\n## Publish Brief\n- write it`;
  const result = (extra: Record<string, unknown>) =>
    JSON.stringify({ slug: 'crm-mcp-servers-compared', summary: 'Add comparison', files_changed: ['src/x.json'], ...extra });

  it('demands the page the reviewer should open, as a site path with a leading slash', async () => {
    const dir = await workspace({
      [research]: GOOD_MARKDOWN,
      '.ranksmith/result.json': result({ preview_path: '/blog/crm-mcp-servers-compared/' }),
    });

    assert.deepEqual(await validateContract(dir, contractFor('content', '2026-08-14')), { ok: true });
  });

  it('rejects a missing, relative, or URL-shaped preview path', async () => {
    for (const [extra, expected] of [
      [{}, '.ranksmith/result.json: missing field "preview_path"'],
      [{ preview_path: 'blog/post/' }, /field "preview_path" must match .* \(got "blog\/post\/"\)/],
      [{ preview_path: 'https://example.com/blog/post/' }, /field "preview_path" must match/],
    ] as const) {
      const dir = await workspace({ [research]: GOOD_MARKDOWN, '.ranksmith/result.json': result(extra) });
      const check = await validateContract(dir, contractFor('content_revision', '2026-08-14'));
      assert.equal(check.ok, false);
      const gap = check.gaps?.find((line) => line.includes('preview_path')) ?? '';
      if (typeof expected === 'string') assert.equal(gap, expected);
      else assert.match(gap, expected);
    }
  });
});
