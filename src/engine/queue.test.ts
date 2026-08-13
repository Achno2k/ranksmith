import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunQueue, type RunTask } from './queue.ts';

const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const task = (jobId: string): RunTask => ({ jobId, phase: 'research', attempt: 1 });

/** Records what ran, in order, and the most agents ever in flight at once. */
const spyRunner = () => {
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const gates = new Map<string, ReturnType<typeof deferred>>();

  const run = async (t: RunTask) => {
    started.push(t.jobId);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      await gates.get(t.jobId)?.promise;
    } finally {
      inFlight -= 1;
    }
  };

  const hold = (jobId: string) => {
    const gate = deferred();
    gates.set(jobId, gate);
    return gate.release;
  };

  return { run, hold, started, peak: () => peak };
};

describe('the run queue', () => {
  it('runs a task that arrives while it is idle', async () => {
    const runner = spyRunner();
    const queue = new RunQueue(runner.run);

    await queue.enqueue(task('CM-001'));

    assert.deepEqual(runner.started, ['CM-001']);
  });

  it('never lets two agents run at once', async () => {
    const runner = spyRunner();
    const queue = new RunQueue(runner.run);
    const releaseFirst = runner.hold('CM-001');

    const all = Promise.all([queue.enqueue(task('CM-001')), queue.enqueue(task('CM-002'))]);
    releaseFirst();
    await all;

    assert.equal(runner.peak(), 1);
  });

  it('runs tasks in the order they were enqueued', async () => {
    const runner = spyRunner();
    const queue = new RunQueue(runner.run);
    const release = runner.hold('CM-001');

    const all = Promise.all([
      queue.enqueue(task('CM-001')),
      queue.enqueue(task('CM-002')),
      queue.enqueue(task('CM-003')),
    ]);
    release();
    await all;

    assert.deepEqual(runner.started, ['CM-001', 'CM-002', 'CM-003']);
  });

  it('keeps going after a run throws, so one bad job cannot wedge the rest', async () => {
    const started: string[] = [];
    const queue = new RunQueue(async (t) => {
      started.push(t.jobId);
      if (t.jobId === 'CM-001') throw new Error('agent exploded');
    });

    const [first, second] = await Promise.all([queue.enqueue(task('CM-001')), queue.enqueue(task('CM-002'))]);

    assert.equal(first?.ok, false);
    assert.equal(second?.ok, true);
    assert.deepEqual(started, ['CM-001', 'CM-002']);
  });

  it('hands the failure back to the caller instead of rejecting', async () => {
    const queue = new RunQueue(async () => {
      throw new Error('agent exploded');
    });

    const result = await queue.enqueue(task('CM-001'));

    assert.equal(result.ok, false);
    assert.match(String((result as { error: unknown }).error), /agent exploded/);
  });

  it('reports how much work is waiting', async () => {
    const runner = spyRunner();
    const queue = new RunQueue(runner.run);
    const release = runner.hold('CM-001');

    const all = Promise.all([queue.enqueue(task('CM-001')), queue.enqueue(task('CM-002'))]);
    assert.equal(queue.depth, 2);

    release();
    await all;
    assert.equal(queue.depth, 0);
  });
});
