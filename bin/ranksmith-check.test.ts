import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ranksmith-check', import.meta.url));

function check(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr.trim() };
}

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ranksmith-check-'));
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return dir;
}

const REPORT = [
  '## Summary',
  '- x',
  '## Ranked Opportunities',
  '| rank | opportunity |',
  '| 1 | y |',
  '## Targets',
  '## Drafts',
  '## Handoffs',
  '## Gaps',
].join('\n');

const TARGETS = [
  'name,type,org,lane,channel,source_url,why_it_matters,next_action',
  'Ada,person,Acme,events,email,https://x.test/ada,"speaks, twice",email',
].join('\n');

const RESULT = JSON.stringify({
  focus: 'full scan',
  summary: 'y',
  opportunity_count: 1,
  top_opportunities: ['y'],
});

describe('the agent self-check command', () => {
  it('prints "contract ok" and exits 0 when the phase delivered everything', async () => {
    const dir = await workspace({
      'docs/marketing/2026-08-14-opportunities.md': REPORT,
      'docs/marketing/2026-08-14-targets.csv': TARGETS,
      '.ranksmith/result.json': RESULT,
    });

    assert.deepEqual(check(dir, 'marketing', '2026-08-14'), { status: 0, stdout: 'contract ok', stderr: '' });
  });

  it('prints one gap per line and exits 1 otherwise', async () => {
    const dir = await workspace({ '.ranksmith/result.json': RESULT });

    const run = check(dir, 'marketing', '2026-08-14');

    assert.equal(run.status, 1);
    assert.deepEqual(run.stdout.split('\n'), [
      'docs/marketing/2026-08-14-opportunities.md: file not written',
      'docs/marketing/2026-08-14-targets.csv: file not written',
    ]);
  });

  it('refuses an unknown phase or a malformed date', async () => {
    const dir = await workspace({});

    assert.equal(check(dir, 'deploy', '2026-08-14').status, 2);
    assert.equal(check(dir, 'research', 'yesterday').status, 2);
    assert.match(check(dir).stderr, /^usage:/);
  });
});
