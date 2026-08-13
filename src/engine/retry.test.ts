import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRun } from './retry.ts';

const clean = { exitCode: 0, timedOut: false, gaps: [] as string[] };
const missedContract = { ...clean, gaps: ['result.json: missing field "slug"'] };

describe('deciding what happens after a run', () => {
  it('completes a run that exited cleanly and met its contract', () => {
    assert.deepEqual(classifyRun(clean, 1), { action: 'complete' });
  });

  it('gives a contract miss one more attempt, naming the gaps', () => {
    assert.deepEqual(classifyRun(missedContract, 1), {
      action: 'retry',
      gaps: ['result.json: missing field "slug"'],
    });
  });

  it('gives up when the second attempt misses the contract too', () => {
    const decision = classifyRun(missedContract, 2);

    assert.equal(decision.action, 'fail');
    assert.match(decision.reason!, /missing field "slug"/);
  });

  it('does not retry a timeout, because the same wall costs another 25 minutes', () => {
    const decision = classifyRun({ ...clean, timedOut: true }, 1);

    assert.equal(decision.action, 'fail');
    assert.match(decision.reason!, /timed out/i);
  });

  it('does not retry a crash', () => {
    const decision = classifyRun({ ...clean, exitCode: 1 }, 1);

    assert.equal(decision.action, 'fail');
    assert.match(decision.reason!, /exit(ed)? 1/i);
  });

  it('reports the crash rather than the contract when the agent died mid-write', () => {
    const decision = classifyRun({ ...missedContract, exitCode: 137 }, 1);

    assert.equal(decision.action, 'fail');
    assert.match(decision.reason!, /exit(ed)? 137/i);
  });
});
