import { access, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { killAgent, killRunningAgents, readResult, runPhase } from './agent.ts';
import {
  closePullRequest,
  commitAll,
  deployRuns,
  enableAutoMerge,
  hasChanges,
  openPullRequest,
  pullRequestInfo,
  pullRequestUrl,
  push,
  revertCommit,
} from './git.ts';
import { buildRun } from './invocation.ts';
import type { AttachmentInput, Job, JobStore } from './jobs.ts';
import { attachmentsDir, logPath, reviewDocPath, workspaceAttachmentsDir, workspacePath } from './paths.ts';
import { marketingCsvPath, marketingPath, researchPath } from './phases.ts';
import { startPreview, type Preview } from './preview.ts';
import { baseRef, isMarketingPhase, phaseForState, type PhaseName, type SiteProfile } from './profile.ts';
import { afterFeedback, isGate, type JobKind } from './states.ts';
import { RunQueue, StepRunner, type RunResult } from './queue.ts';
import { classifyRun, isTransient, MAX_ATTEMPTS, TRANSIENT_RETRY_DELAY_MS, type RunOutcome } from './retry.ts';
import { runTriage, type Triage } from './triage.ts';
import { branchFor, createScratchWorkspace, createWorkspace, removeWorkspace } from './workspace.ts';

/** Refreshes the in-place running status without flooding a Slack thread. */
const STATUS_HEARTBEAT_MS = 60_000;

/** How the Engine reaches the humans. Kept behind an interface so the flow stays testable. */
export interface Notifier {
  jobStarted(job: Job): Promise<string>;
  researchReady(job: Job, result: Record<string, unknown>, documentPath: string): Promise<void>;
  contentReady(job: Job, prUrl: string): Promise<void>;
  /** A marketing scan is at its Gate: the report and the targets CSV are ready to read. */
  marketingReady(job: Job, result: Record<string, unknown>, reportPath: string, csvPath: string): Promise<void>;
  working(job: Job, note: string): Promise<void>;
  merging(job: Job, prUrl: string): Promise<void>;
  failed(job: Job, reason: string): Promise<void>;
  rejected(job: Job): Promise<void>;
  stopped(job: Job): Promise<void>;
  revertReady(job: Job, prUrl: string): Promise<void>;
  /** `prUrl` is the revert pull request, or null when the original was closed before it merged. */
  reverted(job: Job, prUrl: string | null): Promise<void>;
  revertCancelled(job: Job): Promise<void>;
  /** A preview was rebuilt for a Job already at content review; the Gate message stays as it was. */
  previewReady(job: Job, url: string, prUrl: string): Promise<void>;
}

export class Engine {
  readonly #jobs: JobStore;
  readonly #profile: SiteProfile;
  readonly #notify: Notifier;
  /** Agent processes only, one at a time. */
  readonly #queue = new RunQueue();
  /** Everything else a Job does: worktree, install, preview, merge, revert. Runs beside the queue. */
  readonly #steps = new StepRunner();
  readonly #previews = new Map<string, Preview>();
  readonly #runs = new Map<string, Promise<void>>();
  /** Jobs whose preview the last resume() set out to rebuild, so boot can log them. */
  #previewRebuilds: string[] = [];

  constructor(jobs: JobStore, profile: SiteProfile, notify: Notifier) {
    this.#jobs = jobs;
    this.#profile = profile;
    this.#notify = notify;
  }

  /** Jobs with a step in flight, whether it is building, waiting for the queue, or running an agent. */
  get depth(): number {
    return this.#steps.depth;
  }

  /** Resolves when nothing at all is running or queued, out-of-queue steps included. */
  async whenIdle(): Promise<void> {
    // A failed step can schedule its retry just after the last one settled, so check again.
    do {
      await this.#steps.whenIdle();
      await this.#queue.whenIdle();
    } while (this.#steps.depth > 0 || this.#queue.depth > 0);
  }

  async startJob(
    topic: string | null,
    channel: string,
    existingThreadTs: string | null = null,
    attachments: AttachmentInput[] = [],
    kind: JobKind = 'seo',
  ): Promise<Job> {
    const attachmentMeta = attachments.map(({ name, mimetype }) => ({ name, mimetype }));
    const created = this.#jobs.createJob({
      profile: this.#profile.id,
      jobPrefix: this.#profile.jobPrefix,
      kind,
      topic,
      slackChannel: channel,
      attachments: attachmentMeta,
    });

    await this.#ingestAttachments(created.id, attachments);

    // A mention already has a conversation to live in. Slash commands still create a
    // new root message and use its timestamp as the Job thread.
    const job = existingThreadTs
      ? this.#jobs.update(created.id, { slack_thread_ts: existingThreadTs })
      : created;
    const postedTs = await this.#notify.jobStarted(job);
    if (!existingThreadTs) this.#jobs.update(job.id, { slack_thread_ts: postedTs });
    this.#schedule(job.id);

    return this.#jobs.getJob(job.id)!;
  }

  async approve(jobId: string, actor: string): Promise<void> {
    const job = this.#jobs.approve(jobId, actor);

    // A marketing scan closes on approval: no Phase is left to run, only the scratch
    // directory to remove. The report copies under research/ stay for reading.
    if (job.state === 'done') return this.#teardown(job);

    this.#schedule(jobId);
  }

  async reject(jobId: string, actor: string, feedback: string | null): Promise<void> {
    const before = this.#jobs.getJob(jobId);
    if (before?.state === 'revert_review') return this.#cancelRevert(jobId, actor);

    const job = this.#jobs.reject(jobId, actor, feedback);
    // A rejected follow-up is back at done holding the shipped pull request; only its own closes.
    const open = before?.pullRequest ?? null;
    if (open !== null) await closePullRequest(this.#profile, open);
    await this.#teardown(job);
    await this.#notify.rejected(job);
  }

  /** Stops a Job from its Slack thread, including an agent process that is in flight. */
  async stop(jobId: string, actor: string): Promise<boolean> {
    const stopped = this.#jobs.cancel(jobId, actor);
    if (!stopped) return false;
    // A stopped follow-up is back at done, and the pull request it holds is the merged one.
    const shipped = stopped.state === 'done' ? stopped.pullRequest : null;

    // Mark the Job terminal before touching the process so an exiting phase cannot advance it.
    this.#queue.cancel(jobId);
    const killing = killAgent(jobId);
    await this.#notify.stopped(stopped);
    await killing;
    await this.#runs.get(jobId);

    // A preview or PR may have appeared while a non-agent command was winding down.
    const latest = this.#jobs.getJob(jobId) ?? stopped;
    if (latest.pullRequest !== null && latest.pullRequest !== shipped) {
      await closePullRequest(this.#profile, latest.pullRequest);
    }
    if (shipped !== null && latest.pullRequest !== shipped) this.#jobs.update(jobId, { pull_request: shipped });
    await this.#teardown(latest);
    return true;
  }

  /** Sends a failed Job back to the step it died on and runs it again. False if it has not failed. */
  async retry(jobId: string, actor = 'cli'): Promise<boolean> {
    if (this.#jobs.getJob(jobId)?.state !== 'failed') return false;

    const job = this.#jobs.retryFailed(jobId, actor);
    await this.#notify.working(job, `Retrying from ${job.state}.`);
    this.#schedule(jobId);
    return true;
  }

  /**
   * Picks up Jobs that were mid-Phase when the Engine last stopped. Without this they sit
   * in a running state forever: no human action can move a Job that is not at a Gate.
   */
  resume(): string[] {
    const stranded = this.#jobs
      .liveJobs()
      .filter((job) => job.profile === this.#profile.id && !isGate(job.state));

    for (const job of stranded) this.#schedule(job.id);

    // Previews died with the last process. A Job at content review has nothing else to wait
    // for, so serve its worktree again rather than leave a dead link in the thread.
    this.#previewRebuilds = this.#jobs
      .liveJobs()
      .filter((job) => job.profile === this.#profile.id && job.kind === 'seo' && job.state === 'content_review')
      .map((job) => {
        this.#runStep(job.id, () => this.#rebuildPreview(job.id, 'engine', { quietWhenGone: false }), (result) =>
          this.#previewRebuildFailed(job.id, result),
        );
        return job.id;
      });

    return stranded.map((job) => job.id);
  }

  /** The Jobs the last resume() tried to give a fresh preview. */
  get previewRebuilds(): readonly string[] {
    return this.#previewRebuilds;
  }

  /**
   * Serves a Job's worktree behind a new tunnel from Slack or the CLI. False unless the Job is
   * a seo Job at content review whose worktree is still on disk. The rebuild runs as a step of
   * its own, never as an agent turn, so a build elsewhere does not hold it up.
   */
  async rebuildPreview(jobId: string, actor: string): Promise<boolean> {
    const job = this.#jobs.getJob(jobId);
    if (!job || job.kind !== 'seo' || job.state !== 'content_review') return false;
    if (!(await exists(workspacePath(jobId)))) return false;

    this.#runStep(jobId, () => this.#rebuildPreview(jobId, actor, { quietWhenGone: true }), (result) =>
      this.#previewRebuildFailed(jobId, result),
    );
    return true;
  }

  /**
   * Rejects Jobs that have waited at a Gate longer than maxAgeDays, through the same path
   * a human reject takes: pull request closed, worktree removed, thread told. Returns the
   * ids swept. Deliberately not run at boot; the CLI calls it on request.
   */
  async sweepStale(maxAgeDays: number): Promise<string[]> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const stale = this.#jobs.liveJobs().filter((job) => {
      if (job.profile !== this.#profile.id || !isGate(job.state)) return false;
      const last = this.#jobs.lastEventAt(job.id);
      return last !== null && last < cutoff;
    });

    for (const job of stale) {
      await this.reject(job.id, 'sweeper', `Swept: no activity for ${maxAgeDays} days.`);
    }
    return stale.map((job) => job.id);
  }

  /** Stops everything this Engine started, so nothing is left holding a port or a tunnel. */
  async shutdown(): Promise<void> {
    killRunningAgents();
    await Promise.all([...this.#previews.keys()].map((jobId) => this.#stopPreview(jobId)));
  }

  /** Undoes a finished Job's merged work behind a new pull request and its own Gate. */
  async revert(jobId: string, actor: string, reason: string | null): Promise<boolean> {
    const job = this.#jobs.requestRevert(jobId, actor, reason);
    if (!job) return false;

    await this.#notify.working(job, 'Preparing a revert.');
    this.#schedule(jobId);
    return true;
  }

  /**
   * Works out what a mention in a Job thread wants, and answers it when it is a question.
   * Null when the reply could not be understood.
   */
  async triage(jobId: string, text: string): Promise<Triage | null> {
    const job = this.#jobs.getJob(jobId);
    if (!job) return null;

    // A finished Job has no worktree left; its work lives on the base branch instead.
    const workspace = workspacePath(job.id);
    const cwd = await access(workspace).then(
      () => workspace,
      () => this.#profile.repo.path,
    );

    return runTriage({ job, text, cwd, context: await this.#describeForTriage(job) });
  }

  /**
   * Explicit reviewer feedback. Counts while the Job waits at a Gate, and again once it is
   * done: a finished Job is not closed to change, it starts a follow-up round.
   */
  async feedback(jobId: string, actor: string, text: string, attachments: AttachmentInput[] = []): Promise<boolean> {
    const job = this.#jobs.getJob(jobId);
    if (!job) return false;
    if (job.state === 'done') return this.#reopen(job, actor, text, attachments);
    if (!isGate(job.state) || afterFeedback(job.state) === null) return false;

    await this.#ingestAttachments(jobId, attachments);

    const updated = this.#jobs.recordFeedback(
      jobId,
      actor,
      text,
      attachments.map(({ name, mimetype }) => ({ name, mimetype })),
    );
    if (!updated) return false;

    await this.#stopPreview(jobId);
    await this.#notify.working(job, 'Revising.');
    this.#schedule(jobId);
    return true;
  }

  /** A change asked for after the Job finished. The shipped work stays live while it is revised. */
  async #reopen(job: Job, actor: string, text: string, attachments: AttachmentInput[]): Promise<boolean> {
    // Done means the merge is queued, not landed. A follow-up branch cut from the base
    // branch before then has nothing to revise, so wait for the pull request to merge.
    if (job.kind === 'seo' && job.pullRequest !== null) {
      const shipped = await pullRequestInfo(this.#profile, job.pullRequest).catch(() => null);
      if (shipped?.state === 'OPEN') return false;
    }

    await this.#ingestAttachments(job.id, attachments);
    const reopened = this.#jobs.reopen(
      job.id,
      actor,
      text,
      attachments.map(({ name, mimetype }) => ({ name, mimetype })),
    );
    if (!reopened) return false;

    // The scratch directory went with approval, and a revision needs the report it revises.
    if (job.kind === 'marketing') await this.#restoreReport(job);

    await this.#notify.working(reopened, job.kind === 'marketing' ? 'Revising the report.' : 'Revising the shipped content.');
    this.#schedule(job.id);
    return true;
  }

  /** Seeds a fresh scratch directory with the copies kept under research/ for reading. */
  async #restoreReport(job: Job): Promise<void> {
    const workspace = await createScratchWorkspace(job.id);
    const copies: [string, string][] = [
      ['opportunities.md', marketingPath(job.date)],
      ['targets.csv', marketingCsvPath(job.date)],
    ];
    for (const [name, target] of copies) {
      const destination = join(workspace, target);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(reviewDocPath(job.id, job.date, name), destination).catch((error: unknown) =>
        console.warn(`[${job.id}] no ${name} to restore; the revision starts from scratch (${String(error)}).`),
      );
    }
  }

  /**
   * Runs what the Job's state calls for as a step of its own, after any step the Job already
   * has in flight. Steps do not queue behind other Jobs; only the agent process inside one does.
   */
  #schedule(jobId: string, attempt = 1): void {
    const job = this.#jobs.getJob(jobId);
    if (!job) return;

    this.#runStep(
      jobId,
      async () => {
        // A retry waits inside its own step, so nothing reads the Engine as idle in between.
        if (attempt > 1) await sleep(TRANSIENT_RETRY_DELAY_MS);
        await this.#advance(jobId);
      },
      async (result) => {
        if (result.ok) return;
        if (this.#isStopped(jobId)) return console.error(`[${jobId}] error after the Job was stopped:`, result.error);

        // One more go for a network or GitHub hiccup. Scheduled before anything is awaited, so a
        // CLI waiting for idle sees the retry.
        if (attempt === 1 && isTransient(result.error)) {
          this.#schedule(jobId, 2);
          const seconds = TRANSIENT_RETRY_DELAY_MS / 1000;
          return this.#notify.working(job, `Temporary error in ${job.state}; retrying in ${seconds}s.`);
        }

        await this.#fail(jobId, String(result.error));
      },
    );
  }

  /**
   * One step per Job at a time: the work waits for the step the Job already has in flight,
   * then `report` sees how it went. Steps do not queue behind other Jobs.
   */
  #runStep(jobId: string, work: () => Promise<void>, report: (result: RunResult) => Promise<void> | void): void {
    const previous = this.#runs.get(jobId);
    const run = this.#steps
      .run(async () => {
        // The previous step's promise never rejects.
        await previous;
        await work();
      })
      .then(report)
      // Reporting a failure can itself fail — a Slack outage is exactly when it would.
      // Log it rather than let an unhandled rejection take the whole Engine down.
      .catch((error: unknown) => console.error(`[${jobId}] could not report failure:`, error));

    this.#runs.set(jobId, run);
    void run.finally(() => {
      if (this.#runs.get(jobId) === run) this.#runs.delete(jobId);
    });
  }

  /** Runs whatever the Job's current state calls for, then schedules the next step. */
  async #advance(jobId: string): Promise<void> {
    const job = this.#jobs.getJob(jobId);
    if (!job) return;

    const phase = phaseForState(job.state);
    if (phase) return this.#runAgentPhase(job, phase);
    if (job.state === 'preview_building') return this.#buildPreview(job);
    if (job.state === 'merging') return this.#merge(job);
    if (job.state === 'reverting') return this.#openRevert(job);
    if (job.state === 'revert_merging') return this.#mergeRevert(job);
  }

  async #runAgentPhase(job: Job, phase: PhaseName): Promise<void> {
    const workspace = await this.#ensureWorkspace(job);
    if (this.#isStopped(job.id)) return;
    await this.#mirrorAttachments(job, workspace);
    if (this.#isStopped(job.id)) return;
    const feedback = this.#jobs.pendingFeedback(job.id);
    let gaps: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const currentLog = logPath(job.id, phase, attempt);
      const verb = attempt === 1 ? 'Running' : 'Retrying';
      // Fresh on every attempt and revision: the prompt promises each one its own budget.
      await writeBudget(workspace, phase, this.#profile);

      const invocation = buildRun({
        jobId: job.id,
        phase,
        profile: this.#profile,
        workspace,
        date: job.date,
        topic: job.topic,
        feedback,
        gaps,
        attachments: job.attachments,
        // buildRun only resumes for a revision; a first pass never continues another Phase.
        resumeSessionId: job.sessionId ?? null,
      });

      if (this.#queue.busy) {
        await this.#notify.working(job, `Waiting for another Job's agent to finish before ${phase}.`);
      }

      // Only the agent process takes a queue turn. Everything around it already ran outside.
      let outcome: RunOutcome | undefined;
      const turn = await this.#queue.enqueue({ jobId: job.id, phase, attempt }, async () => {
        await this.#notify.working(job, `${verb} ${phase}.\nLive log: \`${currentLog}\``);

        const startedAt = Date.now();
        let heartbeatInFlight = false;
        const heartbeat = setInterval(() => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = true;
          const elapsed = formatElapsed(Date.now() - startedAt);
          void this.#notify
            .working(job, `${verb} ${phase} · ${elapsed} elapsed · process active.\nLive log: \`${currentLog}\``)
            .catch((error: unknown) => console.error(`[${job.id}] status heartbeat failed:`, error))
            .finally(() => (heartbeatInFlight = false));
        }, STATUS_HEARTBEAT_MS);
        heartbeat.unref();

        try {
          outcome = await runPhase({ jobId: job.id, invocation, phase, date: job.date, logPath: currentLog });
        } finally {
          clearInterval(heartbeat);
        }
      });
      if (!turn.ok) throw turn.error;
      // A cancelled turn never ran: the Job was stopped while it waited.
      if (this.#isStopped(job.id) || outcome === undefined) return;
      const decision = classifyRun(outcome, attempt);

      if (decision.action === 'complete') {
        // Each Phase keeps only its own session, so a revision continues exactly that one.
        this.#jobs.update(job.id, { session_id: outcome.sessionId ?? null });
        if (outcome.totalCostUsd !== undefined) {
          console.log(`[${job.id}] ${phase}: $${outcome.totalCostUsd.toFixed(2)}, ${outcome.numTurns ?? '?'} turns`);
        }
        return this.#phaseSucceeded(job, phase, workspace);
      }
      if (decision.action === 'fail') return void (await this.#fail(job.id, decision.reason));
      gaps = decision.gaps;
    }
  }

  async #phaseSucceeded(job: Job, phase: PhaseName, workspace: string): Promise<void> {
    if (this.#isStopped(job.id)) return;
    const result = await readResult(workspace);
    if (this.#isStopped(job.id)) return;

    if (isMarketingPhase(phase)) {
      // Nothing to commit: a marketing scan leaves a report, not a change to the site.
      const [reportPath, csvPath] = await Promise.all([
        this.#copyForReview(job, workspace, marketingPath(job.date), 'opportunities.md'),
        this.#copyForReview(job, workspace, marketingCsvPath(job.date), 'targets.csv'),
      ]);
      if (this.#isStopped(job.id)) return;
      const advanced = this.#jobs.phaseCompleted(job.id);
      return this.#notify.marketingReady(advanced, result, reportPath, csvPath);
    }

    if (phase === 'research' || phase === 'research_revision') {
      this.#jobs.update(job.id, { slug: String(result['slug'] ?? '') });
      // The skill tells agents to commit their own work, so there is often nothing left.
      if (await hasChanges(workspace)) {
        await commitAll(workspace, `docs(seo): research for ${job.id}`);
      }
      const documentPath = await this.#copyForReview(job, workspace, researchPath(job.date), 'research.md');
      if (this.#isStopped(job.id)) return;
      const advanced = this.#jobs.phaseCompleted(job.id);
      return this.#notify.researchReady(advanced, result, documentPath);
    }

    if (await hasChanges(workspace)) {
      await commitAll(workspace, `feat(seo): ${String(result['summary'] ?? job.id)}`);
    }
    if (this.#isStopped(job.id)) return;
    this.#jobs.phaseCompleted(job.id);
    this.#schedule(job.id);
  }

  /** Mirrors a report into this repo so it can be read without opening the Workspace. */
  async #copyForReview(job: Job, workspace: string, source: string, name: string): Promise<string> {
    const destination = reviewDocPath(job.id, job.date, name);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(workspace, source), destination);
    return destination;
  }

  async #buildPreview(job: Job): Promise<void> {
    const workspace = workspacePath(job.id);
    const round = this.#jobs.followUpRound(job.id);
    const branch = job.branch ?? branchFor(this.#profile, job.id, job.slug ?? '', round);

    if (this.#isStopped(job.id)) return;
    await this.#notify.working(job, 'Pushing branch and opening a pull request.');
    await push(this.#profile, workspace, branch);
    if (this.#isStopped(job.id)) return;

    const number = await openPullRequest(
      this.#profile,
      workspace,
      branch,
      `feat(seo): ${job.slug ?? job.id}${job.followUp ? ` (follow-up ${round})` : ''}`,
      pullRequestBody(job),
    );
    this.#jobs.update(job.id, { pull_request: number, branch });
    if (this.#isStopped(job.id)) return;

    await this.#notify.working(job, 'Building a preview. This takes a few minutes.');
    const preview = await this.#servePreview(job, workspace);
    this.#jobs.update(job.id, { preview_url: preview.url });
    if (this.#isStopped(job.id)) return;

    const advanced = this.#jobs.phaseCompleted(job.id);
    await this.#notify.contentReady(advanced, await pullRequestUrl(this.#profile, number));
  }

  /** Builds and tunnels a worktree, and tells the thread if the tunnel later dies on its own. */
  async #servePreview(job: Job, workspace: string): Promise<Preview> {
    const preview = await startPreview(this.#profile, workspace, {
      onDied: (reason) => {
        if (this.#previews.get(job.id) === preview) this.#previews.delete(job.id);
        void this.#notify
          .working(
            job,
            `Preview went down (${reason}). Mention @RankSmith with \`new preview\` to rebuild it, or approve from the pull request.`,
          )
          .catch(() => {});
      },
    });
    this.#previews.set(job.id, preview);
    return preview;
  }

  /**
   * The step behind rebuildPreview and resume(). Re-reads the Job first: the step may have
   * waited behind another, and an approval or feedback meanwhile means there is nothing to serve.
   */
  async #rebuildPreview(jobId: string, actor: string, { quietWhenGone }: { quietWhenGone: boolean }): Promise<void> {
    const job = this.#jobs.getJob(jobId);
    if (!job || job.state !== 'content_review') return;

    const workspace = workspacePath(jobId);
    if (!(await exists(workspace))) {
      if (!quietWhenGone) {
        await this.#notify.working(job, 'Preview cannot be rebuilt: the worktree is gone. Review from the pull request.');
      }
      return;
    }

    await this.#stopPreview(jobId);
    await this.#notify.working(job, 'Rebuilding the preview. This takes a few minutes.');
    const preview = await this.#servePreview(job, workspace);
    if (this.#jobs.getJob(jobId)?.state !== 'content_review') return this.#stopPreview(jobId);

    const rebuilt = this.#jobs.previewRebuilt(jobId, actor, preview.url);
    const prUrl = rebuilt.pullRequest === null ? 'unavailable' : await pullRequestUrl(this.#profile, rebuilt.pullRequest);
    await this.#notify.previewReady(rebuilt, preview.url, prUrl);
  }

  /** A preview that would not come up leaves the Job at its Gate; the pull request still works. */
  async #previewRebuildFailed(jobId: string, result: RunResult): Promise<void> {
    if (result.ok) return;
    const job = this.#jobs.getJob(jobId);
    if (!job) return;
    await this.#notify.working(job, `Preview could not be rebuilt (${String(result.error)}). Review from the pull request.`);
  }

  async #merge(job: Job): Promise<void> {
    if (this.#isStopped(job.id)) return;
    if (job.pullRequest === null) return void (await this.#fail(job.id, 'Approved for merge with no pull request'));

    await enableAutoMerge(this.#profile, job.pullRequest);
    if (this.#isStopped(job.id)) return;
    const url = await pullRequestUrl(this.#profile, job.pullRequest);

    const done = this.#jobs.phaseCompleted(job.id);
    await this.#teardown(done);
    await this.#notify.merging(done, url);
  }

  async #openRevert(job: Job): Promise<void> {
    if (job.pullRequest === null) {
      return void (await this.#fail(job.id, 'Nothing to revert: the job has no pull request'));
    }

    const original = await pullRequestInfo(this.#profile, job.pullRequest);

    if (original.state === 'OPEN') {
      // Auto-merge was still waiting on CI, so closing the pull request is the whole revert.
      await closePullRequest(this.#profile, job.pullRequest, 'Reverted from Slack before it merged.');
      const reverted = this.#jobs.revertedBeforeMerge(job.id);
      await this.#teardown(reverted);
      return this.#notify.reverted(reverted, null);
    }

    if (original.mergeCommit === null) {
      return void (await this.#fail(job.id, `Cannot revert ${original.url}: it was closed without merging`));
    }

    await this.#notify.working(job, `Reverting ${original.url} on a fresh branch.`);
    const branch = `${this.#profile.repo.branchPrefix}revert-${job.slug || job.id.toLowerCase()}`;
    const workspace = await createWorkspace(this.#profile, job.id, branch, { install: false });
    this.#jobs.update(job.id, { branch });

    await revertCommit(workspace, original.mergeCommit);
    await push(this.#profile, workspace, branch, { force: true });

    const reason =
      this.#jobs
        .history(job.id)
        .filter((event) => event.type === 'revert_requested')
        .at(-1)?.detail ?? null;
    const number = await openPullRequest(
      this.#profile,
      workspace,
      branch,
      `Revert "${original.title}"`,
      revertBody(job, original.url, reason),
    );
    this.#jobs.update(job.id, { revert_pull_request: number });

    const ready = this.#jobs.phaseCompleted(job.id);
    await this.#notify.revertReady(ready, await pullRequestUrl(this.#profile, number));
  }

  async #mergeRevert(job: Job): Promise<void> {
    if (job.revertPullRequest === null) {
      return void (await this.#fail(job.id, 'Approved a revert with no revert pull request'));
    }

    await enableAutoMerge(this.#profile, job.revertPullRequest);
    const url = await pullRequestUrl(this.#profile, job.revertPullRequest);

    const reverted = this.#jobs.phaseCompleted(job.id);
    await this.#teardown(reverted);
    await this.#notify.reverted(reverted, url);
  }

  /** A rejected revert leaves the shipped work alone and returns the Job to done. */
  async #cancelRevert(jobId: string, actor: string): Promise<void> {
    const job = this.#jobs.reject(jobId, actor, null);
    if (job.revertPullRequest !== null) {
      await closePullRequest(this.#profile, job.revertPullRequest, 'Revert cancelled during RankSmith review.');
    }

    const done = this.#jobs.update(jobId, { revert_pull_request: null });
    await this.#teardown(done);
    await this.#notify.revertCancelled(done);
  }

  /** Facts gathered the same way every time, so triage answers from GitHub rather than memory. */
  async #describeForTriage(job: Job): Promise<string[]> {
    const lines =
      job.kind === 'marketing'
        ? [
            `Job: ${job.id}, a marketing scan, state \`${job.state}\``,
            `Focus: ${job.topic ?? 'none (full scan across every lane)'}`,
            `Report: ${marketingPath(job.date)}. Targets: ${marketingCsvPath(job.date)}.`,
            'This Job never ships anything: approving it only closes it, and there is nothing to revert.',
          ]
        : [
            `Job: ${job.id}, state \`${job.state}\``,
            `Topic: ${job.topic ?? 'none (discovery mode)'}`,
            `Slug: ${job.slug ?? 'not chosen yet'}`,
            `Research document: docs/seo-content/${job.date}-research.md`,
            `Preview: ${job.previewUrl ?? 'none'} (previews stop once review ends)`,
            `Base branch: ${baseRef(this.#profile)}. Merging into it deploys to staging; production needs a human-created tag.`,
          ];

    if (job.state === 'done') {
      lines.push('Done is not the end: asking for a change here reopens the Job for a follow-up revision.');
    }
    if (job.followUp) {
      lines.push(`Follow-up round ${this.#jobs.followUpRound(job.id)}: what shipped before stays live until this revision is approved.`);
    }

    const pullRequests = [
      ['Pull request', job.pullRequest],
      ['Shipped pull request', job.shippedPullRequest],
      ['Revert pull request', job.revertPullRequest],
    ] as const;

    for (const [label, number] of pullRequests) {
      if (number === null) continue;

      const pr = await pullRequestInfo(this.#profile, number).catch(() => null);
      if (!pr) {
        lines.push(`${label}: #${number} (could not be read from GitHub)`);
        continue;
      }

      lines.push(`${label}: ${pr.url}, ${pr.state.toLowerCase()}`);
      if (pr.mergeCommit) {
        const runs = await deployRuns(this.#profile, pr.mergeCommit);
        lines.push(`${label} merge commit ${pr.mergeCommit}. Workflow runs on it:`, runs || '(none found)');
      }
    }

    lines.push(
      'History:',
      ...this.#jobs
        .history(job.id)
        .map((event) => `- ${event.type} by ${event.actor}${event.detail ? `: ${event.detail}` : ''}`),
    );
    return lines;
  }

  async #ensureWorkspace(job: Job): Promise<string> {
    if (job.branch) return workspacePath(job.id);

    // A marketing scan has no branch to remember, so an existing directory is its marker:
    // a revision must keep the report the first pass wrote.
    if (job.kind === 'marketing') {
      const existing = workspacePath(job.id);
      return access(existing).then(
        () => existing,
        () => createScratchWorkspace(job.id),
      );
    }

    await this.#notify.working(job, 'Preparing a fresh worktree and installing dependencies.');
    const branch = branchFor(this.#profile, job.id, job.slug ?? '', this.#jobs.followUpRound(job.id));
    const workspace = await createWorkspace(this.#profile, job.id, branch);
    this.#jobs.update(job.id, { branch });

    return workspace;
  }

  async #mirrorAttachments(job: Job, workspace: string): Promise<void> {
    if (job.attachments.length === 0) return;

    const source = attachmentsDir(job.id);
    const destination = workspaceAttachmentsDir(workspace);
    await mkdir(destination, { recursive: true });

    const files = await readdir(source);
    for (const file of files) {
      await copyFile(join(source, file), join(destination, file));
    }
  }

  async #fail(jobId: string, reason: string): Promise<void> {
    if (this.#isStopped(jobId)) return;
    const job = this.#jobs.phaseFailed(jobId, reason);
    await this.#stopPreview(jobId);
    await this.#notify.failed(job, reason);
  }

  /** Rejected, or a follow-up dropped back to done: either way nothing in flight may advance the Job. */
  #isStopped(jobId: string): boolean {
    const state = this.#jobs.getJob(jobId)?.state;
    return state === 'rejected' || state === 'done';
  }

  /** Failed Jobs keep their Workspace for inspection; finished ones do not. */
  async #teardown(job: Job): Promise<void> {
    await this.#stopPreview(job.id);
    await removeWorkspace(this.#profile, job.id, job.branch);
    await this.#removeAttachments(job.id);
  }

  async #removeAttachments(jobId: string): Promise<void> {
    await rm(attachmentsDir(jobId), { recursive: true, force: true });
  }

  async #ingestAttachments(jobId: string, attachments: AttachmentInput[]): Promise<void> {
    if (attachments.length === 0) return;

    const dir = attachmentsDir(jobId);
    await mkdir(dir, { recursive: true });
    for (const attachment of attachments) {
      await copyFile(attachment.sourcePath, join(dir, attachment.name));
    }
  }

  async #stopPreview(jobId: string): Promise<void> {
    const preview = this.#previews.get(jobId);
    if (!preview) return;
    this.#previews.delete(jobId);
    await preview.stop();
  }
}

/**
 * The limits the budget hook (bin/ranksmith-budget) enforces, one file per Workspace. A
 * content Phase gets none, and the file is removed so it does not inherit research's.
 */
async function writeBudget(workspace: string, phase: PhaseName, profile: SiteProfile): Promise<void> {
  const path = join(workspace, '.ranksmith', 'budget.json');
  const { webSearches, competitorPages, marketing } = profile.budgets;

  let limits: Record<string, number> | null = null;
  if (isMarketingPhase(phase)) {
    limits = { WebSearch: marketing.webSearches, WebFetch: marketing.pagesFetched };
  } else if (phase === 'research' || phase === 'research_revision') {
    limits = { WebSearch: webSearches, WebFetch: competitorPages };
  }

  if (limits === null) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ limits, used: {} }, null, 2)}\n`);
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

function formatElapsed(milliseconds: number): string {
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pullRequestBody(job: Job): string {
  return [
    `Generated by RankSmith job \`${job.id}\`.`,
    '',
    `Research: \`docs/seo-content/${job.date}-research.md\``,
    job.topic ? `Requested topic: ${job.topic}` : 'Topic chosen by discovery.',
    ...(job.shippedPullRequest !== null ? [`Follow-up to #${job.shippedPullRequest}, asked for in Slack after it shipped.`] : []),
    '',
    'Reviewed through Slack. Do not merge manually while the job is open.',
  ].join('\n');
}

function revertBody(job: Job, originalUrl: string, reason: string | null): string {
  return [
    `Reverts ${originalUrl} for RankSmith job \`${job.id}\`.`,
    '',
    reason ? `Requested in Slack: ${reason}` : 'Requested in Slack.',
    '',
    'Reviewed through Slack. Do not merge manually while the job is open.',
  ].join('\n');
}
