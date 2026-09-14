export interface RunTask {
  jobId: string;
  phase: string;
  attempt: number;
}

export type RunResult = { ok: true; error?: undefined } | { ok: false; error: unknown };

export type Runner = (task: RunTask) => Promise<void>;

interface Waiting {
  task: RunTask;
  settle: (result: RunResult) => void;
}

/**
 * Serialises agent runs. Any number of Jobs may be alive at once — most are sitting at
 * a Gate waiting for a human — but only one agent process runs at a time, because they
 * share this machine, the git remote, and a third-party research quota.
 */
export class RunQueue {
  readonly #run: Runner;
  readonly #waiting: Waiting[] = [];
  readonly #idleWaiters: Array<() => void> = [];
  #busy = false;

  constructor(run: Runner) {
    this.#run = run;
  }

  /** Tasks queued or running. */
  get depth(): number {
    return this.#waiting.length + (this.#busy ? 1 : 0);
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** Removes work that has not started yet. A running task must stop cooperatively. */
  cancel(jobId: string): number {
    let cancelled = 0;
    for (let index = this.#waiting.length - 1; index >= 0; index -= 1) {
      const waiting = this.#waiting[index];
      if (waiting?.task.jobId !== jobId) continue;
      this.#waiting.splice(index, 1);
      waiting.settle({ ok: true });
      cancelled += 1;
    }
    if (this.depth === 0) this.#releaseIdleWaiters();
    return cancelled;
  }

  /**
   * Resolves once this task has had its turn. Never rejects: a run that throws is
   * reported back as a result, so one failure cannot wedge the queue or surface as an
   * unhandled rejection.
   */
  enqueue(task: RunTask): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      this.#waiting.push({ task, settle: resolve });
      void this.#drain();
    });
  }

  /**
   * Resolves when nothing is queued or running. Used by callers that drive the Engine
   * without a long-lived process — a CLI has to know when it may exit.
   */
  whenIdle(): Promise<void> {
    if (this.depth === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(): Promise<void> {
    if (this.#busy) return;

    const next = this.#waiting.shift();
    if (!next) {
      this.#releaseIdleWaiters();
      return;
    }

    this.#busy = true;
    try {
      await this.#run(next.task);
      next.settle({ ok: true });
    } catch (error) {
      next.settle({ ok: false, error });
    } finally {
      this.#busy = false;
    }

    await this.#drain();
  }

  #releaseIdleWaiters(): void {
    const waiters = this.#idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}
