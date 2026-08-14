import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { killRunningAgents, readResult, runPhase } from './agent.ts';
import {
  closePullRequest,
  commitAll,
  enableAutoMerge,
  hasChanges,
  openPullRequest,
  pullRequestUrl,
  push,
} from './git.ts';
import { buildRun } from './invocation.ts';
import type { Job, JobStore } from './jobs.ts';
import { logPath, reviewDocPath, workspacePath } from './paths.ts';
import { researchPath } from './phases.ts';
import { startPreview, type Preview } from './preview.ts';
import { phaseForState, type PhaseName, type SiteProfile } from './profile.ts';
import { isGate } from './states.ts';
import { RunQueue } from './queue.ts';
import { classifyRun, MAX_ATTEMPTS } from './retry.ts';
import { branchFor, createWorkspace, removeWorkspace } from './workspace.ts';

/** How the Engine reaches the humans. Kept behind an interface so the flow stays testable. */
export interface Notifier {
  jobStarted(job: Job): Promise<string>;
  researchReady(job: Job, result: Record<string, unknown>): Promise<void>;
  contentReady(job: Job, prUrl: string): Promise<void>;
  working(job: Job, note: string): Promise<void>;
  merging(job: Job, prUrl: string): Promise<void>;
  failed(job: Job, reason: string): Promise<void>;
  rejected(job: Job): Promise<void>;
}

export class Engine {
  readonly #jobs: JobStore;
  readonly #profile: SiteProfile;
  readonly #notify: Notifier;
  readonly #queue: RunQueue;
  readonly #previews = new Map<string, Preview>();

  constructor(jobs: JobStore, profile: SiteProfile, notify: Notifier) {
    this.#jobs = jobs;
    this.#profile = profile;
    this.#notify = notify;
    this.#queue = new RunQueue(async (task) => this.#advance(task.jobId));
  }

  get depth(): number {
    return this.#queue.depth;
  }

  /** Resolves when no Phase is running or queued. */
  whenIdle(): Promise<void> {
    return this.#queue.whenIdle();
  }

  async startJob(topic: string | null, channel: string): Promise<Job> {
    const job = this.#jobs.createJob({
      profile: this.#profile.id,
      jobPrefix: this.#profile.jobPrefix,
      topic,
      slackChannel: channel,
    });

    const threadTs = await this.#notify.jobStarted(job);
    this.#jobs.update(job.id, { slack_thread_ts: threadTs });
    this.#enqueue(job.id);

    return this.#jobs.getJob(job.id)!;
  }

  async approve(jobId: string, actor: string): Promise<void> {
    this.#jobs.approve(jobId, actor);
    this.#enqueue(jobId);
  }

  async reject(jobId: string, actor: string, feedback: string | null): Promise<void> {
    const job = this.#jobs.reject(jobId, actor, feedback);
    if (job.pullRequest !== null) await closePullRequest(this.#profile, job.pullRequest);
    await this.#teardown(job);
    await this.#notify.rejected(job);
  }

  /** Sends a failed Job back to the step it died on and runs it again. */
  async retry(jobId: string): Promise<void> {
    const job = this.#jobs.retryFailed(jobId);
    await this.#notify.working(job, `Retrying from ${job.state}.`);
    this.#enqueue(jobId);
  }

  /**
   * Picks up Jobs that were mid-Phase when the Engine last stopped. Without this they sit
   * in a running state forever: no human action can move a Job that is not at a Gate.
   */
  resume(): string[] {
    const stranded = this.#jobs
      .liveJobs()
      .filter((job) => job.profile === this.#profile.id && !isGate(job.state));

    for (const job of stranded) this.#enqueue(job.id);
    return stranded.map((job) => job.id);
  }

  /** Stops everything this Engine started, so nothing is left holding a port or a tunnel. */
  async shutdown(): Promise<void> {
    killRunningAgents();
    await Promise.all([...this.#previews.keys()].map((jobId) => this.#stopPreview(jobId)));
  }

  /** A plain thread reply. Only counts while the Job waits at a Gate. */
  async feedback(jobId: string, actor: string, text: string): Promise<boolean> {
    const job = this.#jobs.recordFeedback(jobId, actor, text);
    if (!job) return false;

    await this.#stopPreview(jobId);
    await this.#notify.working(job, 'Revising.');
    this.#enqueue(jobId);
    return true;
  }

  #enqueue(jobId: string): void {
    const job = this.#jobs.getJob(jobId);
    if (!job) return;

    void this.#queue
      .enqueue({ jobId, phase: job.state, attempt: 1 })
      .then((result) => (result.ok ? undefined : this.#fail(jobId, String(result.error))))
      // Reporting a failure can itself fail — a Slack outage is exactly when it would.
      // Log it rather than let an unhandled rejection take the whole Engine down.
      .catch((error: unknown) => console.error(`[${jobId}] could not report failure:`, error));
  }

  /** Runs whatever the Job's current state calls for, then queues the next step. */
  async #advance(jobId: string): Promise<void> {
    const job = this.#jobs.getJob(jobId);
    if (!job) return;

    const phase = phaseForState(job.state);
    if (phase) return this.#runAgentPhase(job, phase);
    if (job.state === 'preview_building') return this.#buildPreview(job);
    if (job.state === 'merging') return this.#merge(job);
  }

  async #runAgentPhase(job: Job, phase: PhaseName): Promise<void> {
    const workspace = await this.#ensureWorkspace(job);
    const feedback = this.#jobs.pendingFeedback(job.id);
    let gaps: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.#notify.working(job, attempt === 1 ? `Running ${phase}.` : `Retrying ${phase}.`);

      const invocation = buildRun({
        jobId: job.id,
        phase,
        profile: this.#profile,
        workspace,
        date: job.date,
        topic: job.topic,
        feedback,
        gaps,
      });

      const outcome = await runPhase({
        invocation,
        phase,
        date: job.date,
        logPath: logPath(job.id, phase, attempt),
      });
      const decision = classifyRun(outcome, attempt);

      if (decision.action === 'complete') return this.#phaseSucceeded(job, phase, workspace);
      if (decision.action === 'fail') return void (await this.#fail(job.id, decision.reason));
      gaps = decision.gaps;
    }
  }

  async #phaseSucceeded(job: Job, phase: PhaseName, workspace: string): Promise<void> {
    const result = await readResult(workspace);

    if (phase === 'research' || phase === 'research_revision') {
      this.#jobs.update(job.id, { slug: String(result['slug'] ?? '') });
      // The skill tells agents to commit their own work, so there is often nothing left.
      if (await hasChanges(workspace)) {
        await commitAll(workspace, `docs(seo): research for ${job.id}`);
      }
      await this.#copyForReview(job, workspace);
      const advanced = this.#jobs.phaseCompleted(job.id);
      return this.#notify.researchReady(advanced, result);
    }

    if (await hasChanges(workspace)) {
      await commitAll(workspace, `feat(seo): ${String(result['summary'] ?? job.id)}`);
    }
    this.#jobs.phaseCompleted(job.id);
    this.#enqueue(job.id);
  }

  /** Mirrors the research into this repo so it can be read without opening the worktree. */
  async #copyForReview(job: Job, workspace: string): Promise<void> {
    const destination = reviewDocPath(job.id, job.date);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(workspace, researchPath(job.date)), destination);
  }

  async #buildPreview(job: Job): Promise<void> {
    const workspace = workspacePath(job.id);
    const branch = job.branch ?? branchFor(this.#profile, job.id, job.slug ?? '');

    await this.#notify.working(job, 'Pushing branch and opening a pull request.');
    await push(this.#profile, workspace, branch);

    const number = await openPullRequest(
      this.#profile,
      workspace,
      branch,
      `feat(seo): ${job.slug ?? job.id}`,
      pullRequestBody(job),
    );
    this.#jobs.update(job.id, { pull_request: number, branch });

    await this.#notify.working(job, 'Building a preview. This takes a few minutes.');
    const preview = await startPreview(this.#profile, workspace, {
      onDied: (reason) => {
        this.#previews.delete(job.id);
        void this.#notify
          .working(job, `Preview went down (${reason}). Approve from the pull request, or reply to rebuild.`)
          .catch(() => {});
      },
    });
    this.#previews.set(job.id, preview);
    this.#jobs.update(job.id, { preview_url: preview.url });

    const advanced = this.#jobs.phaseCompleted(job.id);
    await this.#notify.contentReady(advanced, await pullRequestUrl(this.#profile, number));
  }

  async #merge(job: Job): Promise<void> {
    if (job.pullRequest === null) return void (await this.#fail(job.id, 'Approved for merge with no pull request'));

    await enableAutoMerge(this.#profile, job.pullRequest);
    const url = await pullRequestUrl(this.#profile, job.pullRequest);

    const done = this.#jobs.phaseCompleted(job.id);
    await this.#teardown(done);
    await this.#notify.merging(done, url);
  }

  async #ensureWorkspace(job: Job): Promise<string> {
    if (job.branch) return workspacePath(job.id);

    await this.#notify.working(job, 'Preparing a fresh worktree and installing dependencies.');
    const branch = branchFor(this.#profile, job.id, job.slug ?? '');
    const workspace = await createWorkspace(this.#profile, job.id, branch);
    this.#jobs.update(job.id, { branch });

    return workspace;
  }

  async #fail(jobId: string, reason: string): Promise<void> {
    const job = this.#jobs.phaseFailed(jobId, reason);
    await this.#stopPreview(jobId);
    await this.#notify.failed(job, reason);
  }

  /** Failed Jobs keep their Workspace for inspection; finished ones do not. */
  async #teardown(job: Job): Promise<void> {
    await this.#stopPreview(job.id);
    await removeWorkspace(this.#profile, job.id, job.branch);
  }

  async #stopPreview(jobId: string): Promise<void> {
    const preview = this.#previews.get(jobId);
    if (!preview) return;
    this.#previews.delete(jobId);
    await preview.stop();
  }
}

function pullRequestBody(job: Job): string {
  return [
    `Generated by RankSmith job \`${job.id}\`.`,
    '',
    `Research: \`docs/seo-content/${job.date}-research.md\``,
    job.topic ? `Requested topic: ${job.topic}` : 'Topic chosen by discovery.',
    '',
    'Reviewed through Slack. Do not merge manually while the job is open.',
  ].join('\n');
}
