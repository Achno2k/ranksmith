import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ranksmith-budget', import.meta.url));

/** Runs the hook once, the way Claude Code does: hook JSON on stdin, verdict in the exit code. */
function call(cwd: string, tool: string): { status: number | null; stderr: string } {
  const run = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, cwd, tool_input: {} }),
    encoding: 'utf8',
  });
  return { status: run.status, stderr: run.stderr.trim() };
}

async function workspace(budget?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ranksmith-budget-'));
  if (budget !== undefined) {
    await mkdir(join(dir, '.ranksmith'), { recursive: true });
    await writeFile(join(dir, '.ranksmith', 'budget.json'), JSON.stringify(budget));
  }
  return dir;
}

const used = async (dir: string): Promise<Record<string, number>> =>
  (JSON.parse(await readFile(join(dir, '.ranksmith', 'budget.json'), 'utf8')) as { used: Record<string, number> }).used;

describe('the search budget hook', () => {
  it('allows everything when no budget file was written', async () => {
    const dir = await workspace();

    assert.deepEqual(call(dir, 'WebSearch'), { status: 0, stderr: '' });
  });

  it('counts each call and blocks the first one past the limit', async () => {
    const dir = await workspace({ limits: { WebSearch: 2, WebFetch: 5 } });

    assert.equal(call(dir, 'WebSearch').status, 0);
    assert.equal(call(dir, 'WebSearch').status, 0);
    assert.deepEqual(await used(dir), { WebSearch: 2 });

    const blocked = call(dir, 'WebSearch');

    assert.equal(blocked.status, 2);
    assert.equal(
      blocked.stderr,
      'Budget exhausted: 2 of 2 WebSearch calls used. Stop searching and write the report with what you have.',
    );
    assert.equal(call(dir, 'WebFetch').status, 0, 'one exhausted tool must not block another');
  });

  it('picks up a count the engine or an earlier call already recorded', async () => {
    const dir = await workspace({ limits: { WebFetch: 3 }, used: { WebFetch: 3 } });

    assert.equal(call(dir, 'WebFetch').status, 2);
    assert.deepEqual(await used(dir), { WebFetch: 4 });
  });

  it('counts but never blocks a tool with no limit', async () => {
    const dir = await workspace({ limits: { WebSearch: 1 } });

    assert.equal(call(dir, 'WebFetch').status, 0);
    assert.equal(call(dir, 'WebFetch').status, 0);
    assert.deepEqual(await used(dir), { WebFetch: 2 });
  });

  it('allows the call when the budget file is not json', async () => {
    const dir = await workspace();
    await mkdir(join(dir, '.ranksmith'), { recursive: true });
    await writeFile(join(dir, '.ranksmith', 'budget.json'), '{ nope');

    assert.equal(call(dir, 'WebSearch').status, 0);
  });
});
