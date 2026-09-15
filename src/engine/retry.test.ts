import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyRun, isTransient } from './retry.ts';

describe('telling a passing Engine error from a real one', () => {
  it('retries network, GitHub outage, rate limit, and tunnel errors', () => {
    for (const message of [
      'git push -u origin feat/seo-cm-006 exited 128\nfatal: unable to access: Could not resolve host: github.com',
      'gh pr create exited 1\nHTTP 502: Bad Gateway (https://api.github.com/graphql)',
      'gh pr view exited 1\nAPI rate limit exceeded for user',
      'Error: read ECONNRESET',
      'Timed out waiting for a preview URL after 60000ms',
    ]) {
      assert.equal(isTransient(new Error(message)), true, message);
    }
  });

  it('fails at once on errors that would repeat', () => {
    for (const message of [
      'gh pr create exited 1\na pull request for branch "aman0singh:feat/seo-cm-006" into branch "main" already exists',
      'npm run build exited 1\nContent schema error in src/content/blog/en/x.json',
      'git revert 0ce18fa did not apply cleanly. Conflicts:\nsrc/content/site/en.json',
    ]) {
      assert.equal(isTransient(new Error(message)), false, message);
    }
  });
});

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
