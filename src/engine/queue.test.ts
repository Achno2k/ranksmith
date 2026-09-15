import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunQueue, StepRunner, type RunTask } from './queue.ts';

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

  /** Queues a turn for this Job that runs through the spy. */
  const enqueue = (queue: RunQueue, jobId: string) => {
    const t = task(jobId);
    return queue.enqueue(t, () => run(t));
  };

  return { run, hold, enqueue, started, peak: () => peak };
};

describe('the run queue', () => {
  it('runs a task that arrives while it is idle', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();

    await runner.enqueue(queue, 'CM-001');

    assert.deepEqual(runner.started, ['CM-001']);
  });

  it('never lets two agents run at once', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();
    const releaseFirst = runner.hold('CM-001');

    const all = Promise.all([runner.enqueue(queue, 'CM-001'), runner.enqueue(queue, 'CM-002')]);
    releaseFirst();
    await all;

    assert.equal(runner.peak(), 1);
  });

  it('runs tasks in the order they were enqueued', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();
    const release = runner.hold('CM-001');

    const all = Promise.all([
      runner.enqueue(queue, 'CM-001'),
      runner.enqueue(queue, 'CM-002'),
      runner.enqueue(queue, 'CM-003'),
    ]);
    release();
    await all;

    assert.deepEqual(runner.started, ['CM-001', 'CM-002', 'CM-003']);
  });

  it('removes a queued task before it starts', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();
    const release = runner.hold('CM-001');

    const first = runner.enqueue(queue, 'CM-001');
    const second = runner.enqueue(queue, 'CM-002');
    assert.equal(queue.cancel('CM-002'), 1);

    await second;
    release();
    await first;

    assert.deepEqual(runner.started, ['CM-001']);
  });

  it('keeps going after a run throws, so one bad job cannot wedge the rest', async () => {
    const started: string[] = [];
    const queue = new RunQueue();
    const explode = (jobId: string) =>
      queue.enqueue(task(jobId), async () => {
        started.push(jobId);
        if (jobId === 'CM-001') throw new Error('agent exploded');
      });

    const [first, second] = await Promise.all([explode('CM-001'), explode('CM-002')]);

    assert.equal(first?.ok, false);
    assert.equal(second?.ok, true);
    assert.deepEqual(started, ['CM-001', 'CM-002']);
  });

  it('hands the failure back to the caller instead of rejecting', async () => {
    const queue = new RunQueue();

    const result = await queue.enqueue(task('CM-001'), async () => {
      throw new Error('agent exploded');
    });

    assert.equal(result.ok, false);
    assert.match(String((result as { error: unknown }).error), /agent exploded/);
  });

  it('lets a caller wait until everything has settled', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();
    const release = runner.hold('CM-001');

    void runner.enqueue(queue, 'CM-001');
    void runner.enqueue(queue, 'CM-002');

    let settled = false;
    const idle = queue.whenIdle().then(() => (settled = true));

    assert.equal(settled, false, 'should not settle while work is queued');
    release();
    await idle;

    assert.deepEqual(runner.started, ['CM-001', 'CM-002']);
    assert.equal(queue.depth, 0);
  });

  it('settles immediately when there was never any work', async () => {
    await new RunQueue().whenIdle();
  });

  it('reports how much work is waiting', async () => {
    const runner = spyRunner();
    const queue = new RunQueue();
    const release = runner.hold('CM-001');

    const all = Promise.all([runner.enqueue(queue, 'CM-001'), runner.enqueue(queue, 'CM-002')]);
    assert.equal(queue.depth, 2);

    release();
    await all;
    assert.equal(queue.depth, 0);
  });
});

describe('the step runner', () => {
  it('runs steps as they come, beside each other', async () => {
    const steps = new StepRunner();
    const first = deferred();
    let secondRan = false;

    const one = steps.run(() => first.promise);
    const two = steps.run(async () => {
      secondRan = true;
    });

    await two;
    assert.equal(secondRan, true, 'the second step should not wait for the first');
    assert.equal(steps.depth, 1);
    first.release();
    assert.deepEqual(await one, { ok: true });
  });

  it('hands a throw back as a result, like the queue', async () => {
    const steps = new StepRunner();

    const result = await steps.run(async () => {
      throw new Error('build exploded');
    });

    assert.equal(result.ok, false);
    assert.match(String((result as { error: unknown }).error), /build exploded/);
    assert.equal(steps.depth, 0);
  });

  it('is idle only once every step has settled', async () => {
    const steps = new StepRunner();
    const gate = deferred();
    void steps.run(() => gate.promise);

    let settled = false;
    const idle = steps.whenIdle().then(() => (settled = true));

    assert.equal(settled, false, 'should not settle while a step runs');
    gate.release();
    await idle;
    assert.equal(steps.depth, 0);
    await steps.whenIdle();
  });

  it('counts a step rescheduled from a result before idle waiters wake', async () => {
    const steps = new StepRunner();
    const order: string[] = [];

    const idle = steps.whenIdle();
    void steps
      .run(async () => {
        order.push('first');
      })
      .then(() => {
        void steps.run(async () => {
          order.push('second');
        });
      });

    await idle;
    await steps.whenIdle();
    assert.deepEqual(order, ['first', 'second']);
  });

  it('lets a build in a step run while the queue holds an agent, and vice versa', async () => {
    // The point of the split: a preview build (a step) must not block a queued agent phase.
    const queue = new RunQueue();
    const steps = new StepRunner();
    const build = deferred();
    let agentRan = false;

    const previewStep = steps.run(() => build.promise);
    const agentTurn = queue.enqueue(task('CM-002'), async () => {
      agentRan = true;
    });

    await agentTurn;
    assert.equal(agentRan, true, 'the agent should run while the build is still going');
    build.release();
    await previewStep;
    assert.equal(queue.depth, 0);
    assert.equal(steps.depth, 0);
  });
});
