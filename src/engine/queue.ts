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

  async #drain(): Promise<void> {
    if (this.#busy) return;

    const next = this.#waiting.shift();
    if (!next) return;

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
}
