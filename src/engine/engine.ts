import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { killAgent, killRunningAgents, readResult, runPhase } from './agent.ts';
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
import type { AttachmentInput, Job, JobStore } from './jobs.ts';
import { attachmentsDir, logPath, reviewDocPath, workspaceAttachmentsDir, workspacePath } from './paths.ts';
import { researchPath } from './phases.ts';
import { startPreview, type Preview } from './preview.ts';
import { phaseForState, type PhaseName, type SiteProfile } from './profile.ts';
import { isGate } from './states.ts';
import { RunQueue } from './queue.ts';
import { classifyRun, MAX_ATTEMPTS } from './retry.ts';
import { branchFor, createWorkspace, removeWorkspace } from './workspace.ts';

/** Refreshes the in-place running status without flooding a Slack thread. */
const STATUS_HEARTBEAT_MS = 60_000;

/** How the Engine reaches the humans. Kept behind an interface so the flow stays testable. */
export interface Notifier {
  jobStarted(job: Job): Promise<string>;
  researchReady(job: Job, result: Record<string, unknown>, documentPath: string): Promise<void>;
  contentReady(job: Job, prUrl: string): Promise<void>;
  working(job: Job, note: string): Promise<void>;
  merging(job: Job, prUrl: string): Promise<void>;
  failed(job: Job, reason: string): Promise<void>;
  rejected(job: Job): Promise<void>;
  stopped(job: Job): Promise<void>;
}

export class Engine {
  readonly #jobs: JobStore;
  readonly #profile: SiteProfile;
  readonly #notify: Notifier;
  readonly #queue: RunQueue;
  readonly #previews = new Map<string, Preview>();
  readonly #runs = new Map<string, Promise<void>>();

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

  async startJob(
    topic: string | null,
    channel: string,
    existingThreadTs: string | null = null,
    attachments: AttachmentInput[] = [],
  ): Promise<Job> {
    const attachmentMeta = attachments.map(({ name, mimetype }) => ({ name, mimetype }));
    const created = this.#jobs.createJob({
      profile: this.#profile.id,
      jobPrefix: this.#profile.jobPrefix,
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

  /** Stops a Job from its Slack thread, including an agent process that is in flight. */
  async stop(jobId: string, actor: string): Promise<boolean> {
    const stopped = this.#jobs.cancel(jobId, actor);
    if (!stopped) return false;

    // Mark the Job terminal before touching the process so an exiting phase cannot advance it.
    this.#queue.cancel(jobId);
    const killing = killAgent(jobId);
    await this.#notify.stopped(stopped);
    await killing;
    await this.#runs.get(jobId);

    // A preview or PR may have appeared while a non-agent command was winding down.
    const latest = this.#jobs.getJob(jobId) ?? stopped;
    if (latest.pullRequest !== null) await closePullRequest(this.#profile, latest.pullRequest);
    await this.#teardown(latest);
    return true;
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

  /** Explicit reviewer feedback. Only counts while the Job waits at a Gate. */
  async feedback(jobId: string, actor: string, text: string, attachments: AttachmentInput[] = []): Promise<boolean> {
    const job = this.#jobs.getJob(jobId);
    if (!job || !isGate(job.state)) return false;

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
    this.#enqueue(jobId);
    return true;
  }

  #enqueue(jobId: string): void {
    const job = this.#jobs.getJob(jobId);
    if (!job) return;

    const run = this.#queue
      .enqueue({ jobId, phase: job.state, attempt: 1 })
      .then(async (result) => {
        if (!result.ok && !this.#isStopped(jobId)) await this.#fail(jobId, String(result.error));
      })
      // Reporting a failure can itself fail — a Slack outage is exactly when it would.
      // Log it rather than let an unhandled rejection take the whole Engine down.
      .catch((error: unknown) => console.error(`[${jobId}] could not report failure:`, error));

    this.#runs.set(jobId, run);
    void run.finally(() => {
      if (this.#runs.get(jobId) === run) this.#runs.delete(jobId);
    });
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
    if (this.#isStopped(job.id)) return;
    await this.#mirrorAttachments(job, workspace);
    if (this.#isStopped(job.id)) return;
    const feedback = this.#jobs.pendingFeedback(job.id);
    let gaps: string[] = [];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const currentLog = logPath(job.id, phase, attempt);
      const verb = attempt === 1 ? 'Running' : 'Retrying';
      await this.#notify.working(job, `${verb} ${phase}.\nLive log: \`${currentLog}\``);

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
      });

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

      let outcome;
      try {
        outcome = await runPhase({ jobId: job.id, invocation, phase, date: job.date, logPath: currentLog });
      } finally {
        clearInterval(heartbeat);
      }
      if (this.#isStopped(job.id)) return;
      const decision = classifyRun(outcome, attempt);

      if (decision.action === 'complete') return this.#phaseSucceeded(job, phase, workspace);
      if (decision.action === 'fail') return void (await this.#fail(job.id, decision.reason));
      gaps = decision.gaps;
    }
  }

  async #phaseSucceeded(job: Job, phase: PhaseName, workspace: string): Promise<void> {
    if (this.#isStopped(job.id)) return;
    const result = await readResult(workspace);
    if (this.#isStopped(job.id)) return;

    if (phase === 'research' || phase === 'research_revision') {
      this.#jobs.update(job.id, { slug: String(result['slug'] ?? '') });
      // The skill tells agents to commit their own work, so there is often nothing left.
      if (await hasChanges(workspace)) {
        await commitAll(workspace, `docs(seo): research for ${job.id}`);
      }
      const documentPath = await this.#copyForReview(job, workspace);
      if (this.#isStopped(job.id)) return;
      const advanced = this.#jobs.phaseCompleted(job.id);
      return this.#notify.researchReady(advanced, result, documentPath);
    }

    if (await hasChanges(workspace)) {
      await commitAll(workspace, `feat(seo): ${String(result['summary'] ?? job.id)}`);
    }
    if (this.#isStopped(job.id)) return;
    this.#jobs.phaseCompleted(job.id);
    this.#enqueue(job.id);
  }

  /** Mirrors the research into this repo so it can be read without opening the worktree. */
  async #copyForReview(job: Job, workspace: string): Promise<string> {
    const destination = reviewDocPath(job.id, job.date);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(workspace, researchPath(job.date)), destination);
    return destination;
  }

  async #buildPreview(job: Job): Promise<void> {
    const workspace = workspacePath(job.id);
    const branch = job.branch ?? branchFor(this.#profile, job.id, job.slug ?? '');

    if (this.#isStopped(job.id)) return;
    await this.#notify.working(job, 'Pushing branch and opening a pull request.');
    await push(this.#profile, workspace, branch);
    if (this.#isStopped(job.id)) return;

    const number = await openPullRequest(
      this.#profile,
      workspace,
      branch,
      `feat(seo): ${job.slug ?? job.id}`,
      pullRequestBody(job),
    );
    this.#jobs.update(job.id, { pull_request: number, branch });
    if (this.#isStopped(job.id)) return;

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
    if (this.#isStopped(job.id)) return;

    const advanced = this.#jobs.phaseCompleted(job.id);
    await this.#notify.contentReady(advanced, await pullRequestUrl(this.#profile, number));
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

  async #ensureWorkspace(job: Job): Promise<string> {
    if (job.branch) return workspacePath(job.id);

    await this.#notify.working(job, 'Preparing a fresh worktree and installing dependencies.');
    const branch = branchFor(this.#profile, job.id, job.slug ?? '');
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

  #isStopped(jobId: string): boolean {
    return this.#jobs.getJob(jobId)?.state === 'rejected';
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
    '',
    'Reviewed through Slack. Do not merge manually while the job is open.',
  ].join('\n');
}
