import { DatabaseSync } from 'node:sqlite';
import {
  afterApproval,
  afterFeedback,
  afterPhase,
  afterReopen,
  initialState,
  isGate,
  isRunning,
  type JobKind,
  type JobState,
} from './states.ts';

export interface Attachment {
  name: string;
  mimetype: string;
}

export interface AttachmentInput extends Attachment {
  sourcePath: string;
}

export interface Job {
  id: string;
  profile: string;
  kind: JobKind;
  /** The research topic of a seo Job, or the focus of a marketing scan. Null means discover. */
  topic: string | null;
  state: JobState;
  slackChannel: string;
  /** Fixed when the Job starts; every artifact this Job writes is stamped with it. */
  date: string;
  slackThreadTs: string | null;
  slug: string | null;
  branch: string | null;
  pullRequest: number | null;
  previewUrl: string | null;
  attachments: Attachment[];
  /** The pull request that undoes this Job's merged work, once one is open. */
  revertPullRequest: number | null;
  /** True while a follow-up revises work that already shipped. Rejecting or stopping it returns to done. */
  followUp: boolean;
  /** During a follow-up, the pull request whose merge is live. Restored if the follow-up is dropped. */
  shippedPullRequest: number | null;
}

export interface NewJob {
  profile: string;
  jobPrefix: string;
  kind?: JobKind;
  topic: string | null;
  slackChannel: string;
  attachments: Attachment[];
}

export type JobEventType =
  | 'job_created'
  | 'phase_completed'
  | 'phase_failed'
  | 'approved'
  | 'changes_requested'
  | 'reopened'
  | 'rejected'
  | 'cancelled'
  | 'retried'
  | 'revert_requested'
  | 'revert_cancelled';

export interface JobEvent {
  type: JobEventType;
  actor: string;
  detail: string | null;
}

interface JobRow {
  id: string;
  profile: string;
  kind: string | null;
  topic: string | null;
  state: string;
  slack_channel: string;
  date: string;
  slack_thread_ts: string | null;
  slug: string | null;
  branch: string | null;
  pull_request: number | null;
  preview_url: string | null;
  attachments: string;
  revert_pull_request: number | null;
  follow_up: number | null;
  shipped_pull_request: number | null;
}

interface EventRow {
  event_type: string;
  actor: string;
  detail: string | null;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  profile: row.profile,
  kind: row.kind === 'marketing' ? 'marketing' : 'seo',
  topic: row.topic,
  state: row.state as JobState,
  slackChannel: row.slack_channel,
  date: row.date,
  slackThreadTs: row.slack_thread_ts,
  slug: row.slug,
  branch: row.branch,
  pullRequest: row.pull_request,
  previewUrl: row.preview_url,
  attachments: parseAttachments(row.attachments),
  revertPullRequest: row.revert_pull_request ?? null,
  followUp: row.follow_up === 1,
  shippedPullRequest: row.shipped_pull_request ?? null,
});

const today = (): string => new Date().toISOString().slice(0, 10);

/** Stopping abandons unshipped work. Finished Jobs and reverts have none to abandon. */
const NOT_STOPPABLE: ReadonlySet<JobState> = new Set<JobState>([
  'done',
  'rejected',
  'failed',
  'reverting',
  'revert_review',
  'revert_merging',
  'reverted',
]);

const parseAttachments = (raw: string | null): Attachment[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as Attachment[]) : [];
  } catch {
    return [];
  }
};

export class JobStore {
  readonly #db: DatabaseSync;

  constructor(filename: string) {
    this.#db = new DatabaseSync(filename);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        topic TEXT,
        state TEXT NOT NULL,
        slack_channel TEXT NOT NULL,
        seq INTEGER NOT NULL,
        date TEXT NOT NULL,
        slack_thread_ts TEXT,
        slug TEXT,
        branch TEXT,
        pull_request INTEGER,
        preview_url TEXT,
        failed_from TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        revert_pull_request INTEGER,
        kind TEXT NOT NULL DEFAULT 'seo',
        follow_up INTEGER NOT NULL DEFAULT 0,
        shipped_pull_request INTEGER
      );
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        detail TEXT,
        created_at TEXT NOT NULL
      );
    `);

    // Databases created before retry existed are missing this column.
    try {
      this.#db.exec('ALTER TABLE jobs ADD COLUMN failed_from TEXT');
    } catch {
      // Already present.
    }

    // Databases created before attachments existed are missing this column.
    try {
      this.#db.exec("ALTER TABLE jobs ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
    } catch {
      // Already present.
    }

    // Databases created before reverts existed are missing this column.
    try {
      this.#db.exec('ALTER TABLE jobs ADD COLUMN revert_pull_request INTEGER');
    } catch {
      // Already present.
    }

    // Databases created before marketing Jobs existed are missing this column.
    try {
      this.#db.exec("ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'seo'");
    } catch {
      // Already present.
    }

    // Databases created before follow-ups existed are missing these columns.
    for (const column of ['follow_up INTEGER NOT NULL DEFAULT 0', 'shipped_pull_request INTEGER']) {
      try {
        this.#db.exec(`ALTER TABLE jobs ADD COLUMN ${column}`);
      } catch {
        // Already present.
      }
    }
  }

  close(): void {
    this.#db.close();
  }

  createJob({ profile, jobPrefix, kind = 'seo', topic, slackChannel, attachments }: NewJob): Job {
    const { next } = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM jobs WHERE profile = ?')
      .get(profile) as { next: number };
    const id = `${jobPrefix}-${String(next).padStart(3, '0')}`;

    this.#db
      .prepare(
        `INSERT INTO jobs (id, profile, kind, topic, state, slack_channel, seq, date, attachments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, profile, kind, topic, initialState(kind), slackChannel, next, today(), JSON.stringify(attachments));
    this.#record(id, 'job_created', 'system', null);

    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /** Finds the Job a Slack thread belongs to, so a plain reply can become feedback. */
  jobForThread(channel: string, threadTs: string): Job | null {
    const row = this.#db
      .prepare('SELECT * FROM jobs WHERE slack_channel = ? AND slack_thread_ts = ?')
      .get(channel, threadTs) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  liveJobs(): Job[] {
    const rows = this.#db
      .prepare("SELECT * FROM jobs WHERE state NOT IN ('done', 'reverted', 'rejected', 'failed') ORDER BY id")
      .all() as unknown as JobRow[];
    return rows.map(toJob);
  }

  update(id: string, fields: Partial<Pick<JobRow, 'slack_thread_ts' | 'slug' | 'branch' | 'pull_request' | 'preview_url' | 'revert_pull_request'>>): Job {
    const entries = Object.entries(fields);
    if (entries.length > 0) {
      const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
      this.#db
        .prepare(`UPDATE jobs SET ${assignments} WHERE id = ?`)
        .run(...entries.map(([, value]) => value as string | number | null), id);
    }
    return this.getJob(id)!;
  }

  /** The Phase this Job was running finished and passed its Contract. */
  phaseCompleted(id: string): Job {
    const job = this.#require(id);
    if (!isRunning(job.state)) {
      throw new Error(`${id} is not running a phase; it is at ${job.state}`);
    }
    this.#record(id, 'phase_completed', 'system', null);
    const next = afterPhase(job.state);
    if (next === 'done') this.#finishFollowUp(id);
    return this.#setState(id, next);
  }

  /** The Phase this Job was running failed for good. */
  phaseFailed(id: string, reason: string): Job {
    const job = this.#require(id);
    this.#record(id, 'phase_failed', 'system', reason);
    this.#db.prepare('UPDATE jobs SET failed_from = ? WHERE id = ?').run(job.state, id);
    return this.#setState(id, 'failed');
  }

  /** Stops a live Job from any phase or gate. The rejected state is the terminal, non-shipping state. */
  cancel(id: string, actor: string): Job | null {
    const job = this.#require(id);
    if (NOT_STOPPABLE.has(job.state)) return null;

    this.#record(id, 'cancelled', actor, null);
    // A stopped follow-up abandons only the revision; what shipped before it stays live.
    if (job.followUp) return this.#dropFollowUp(id);
    return this.#setState(id, 'rejected');
  }

  /**
   * Sends a failed Job back to the step it died on. Research and content that already
   * passed their Contracts are expensive; a failure in between should not discard them.
   */
  retryFailed(id: string, actor = 'system'): Job {
    const job = this.#require(id);
    if (job.state !== 'failed') {
      throw new Error(`${id} has not failed; it is at ${job.state}`);
    }

    const target = this.#db.prepare('SELECT failed_from FROM jobs WHERE id = ?').get(id) as {
      failed_from: string | null;
    };
    if (!target.failed_from) throw new Error(`${id} does not record where it failed`);

    this.#record(id, 'retried', actor, target.failed_from);
    return this.#setState(id, target.failed_from as JobState);
  }

  /**
   * A human asked to undo a finished Job. Only a done Job has shipped work to revert, and
   * a marketing Job never ships anything.
   */
  requestRevert(id: string, actor: string, reason: string | null): Job | null {
    const job = this.#require(id);
    if (job.state !== 'done' || job.kind !== 'seo') return null;

    this.#record(id, 'revert_requested', actor, reason);
    return this.#setState(id, 'reverting');
  }

  /** The pull request had not merged, so closing it undid everything without a revert. */
  revertedBeforeMerge(id: string): Job {
    const job = this.#require(id);
    if (job.state !== 'reverting') {
      throw new Error(`${id} is not reverting; it is at ${job.state}`);
    }

    this.#record(id, 'phase_completed', 'system', 'closed before merge');
    return this.#setState(id, 'reverted');
  }

  /** A human approved at a Gate. */
  approve(id: string, actor: string): Job {
    const gate = this.#requireGate(id);
    this.#record(id, 'approved', actor, null);
    const next = afterApproval(gate);
    if (next === 'done') this.#finishFollowUp(id);
    return this.#setState(id, next);
  }

  /** A human rejected at a Gate. */
  reject(id: string, actor: string, feedback: string | null = null): Job {
    // Rejecting a revert keeps the shipped work, so the Job goes back to done.
    if (this.#requireGate(id) === 'revert_review') {
      this.#record(id, 'revert_cancelled', actor, feedback);
      return this.#setState(id, 'done');
    }

    this.#record(id, 'rejected', actor, feedback);
    // A rejected follow-up abandons only the revision; what shipped before it stays live.
    if (this.#require(id).followUp) return this.#dropFollowUp(id);
    return this.#setState(id, 'rejected');
  }

  /**
   * Someone asked for a change after the Job finished. The shipped work stays live while a
   * follow-up revises it on a fresh branch (seo) or in a fresh scratch directory (marketing)
   * and comes back through the same Gate. Null unless the Job is done.
   */
  reopen(id: string, actor: string, feedback: string, attachments: Attachment[] = []): Job | null {
    const job = this.#require(id);
    if (job.state !== 'done') return null;

    this.#record(id, 'reopened', actor, feedback);
    this.#mergeAttachments(job, attachments);
    this.#db
      .prepare(
        `UPDATE jobs SET follow_up = 1, shipped_pull_request = pull_request,
         pull_request = NULL, branch = NULL, preview_url = NULL WHERE id = ?`,
      )
      .run(id);
    return this.#setState(id, afterReopen(job.kind));
  }

  /** How many times the Job has been reopened, so each follow-up gets a branch of its own. */
  followUpRound(id: string): number {
    const { count } = this.#db
      .prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id = ? AND event_type = 'reopened'")
      .get(id) as { count: number };
    return count;
  }

  /**
   * A human replied in the Job's thread. Only counts as feedback while the Job is
   * waiting at a Gate — chatter at any other moment is left alone.
   */
  recordFeedback(id: string, actor: string, feedback: string, attachments: Attachment[] = []): Job | null {
    const job = this.#require(id);
    const next = isGate(job.state) ? afterFeedback(job.state) : null;
    if (!next) return null;

    this.#record(id, 'changes_requested', actor, feedback);
    this.#mergeAttachments(job, attachments);
    return this.#setState(id, next);
  }

  /** A later attachment with the same name as an earlier one replaces it. */
  #mergeAttachments(job: Job, attachments: Attachment[]): void {
    if (attachments.length === 0) return;

    const merged = new Map<string, Attachment>();
    for (const attachment of job.attachments) merged.set(attachment.name, attachment);
    for (const attachment of attachments) merged.set(attachment.name, attachment);
    this.#db
      .prepare('UPDATE jobs SET attachments = ? WHERE id = ?')
      .run(JSON.stringify([...merged.values()]), job.id);
  }

  /** Feedback the next Phase must act on, or null if none is outstanding. */
  pendingFeedback(id: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT event_type, detail FROM job_events
         WHERE job_id = ? AND event_type IN ('changes_requested', 'reopened', 'phase_completed')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as EventRow | undefined;

    return row && row.event_type !== 'phase_completed' ? row.detail : null;
  }

  history(id: string): JobEvent[] {
    const rows = this.#db
      .prepare('SELECT event_type, actor, detail FROM job_events WHERE job_id = ? ORDER BY id')
      .all(id) as unknown as EventRow[];

    return rows.map((row) => ({
      type: row.event_type as JobEventType,
      actor: row.actor,
      detail: row.detail,
    }));
  }

  #requireGate(id: string) {
    const job = this.#require(id);
    if (!isGate(job.state)) {
      throw new Error(`${id} is not at a gate; it is at ${job.state}`);
    }
    return job.state;
  }

  #record(id: string, type: JobEventType, actor: string, detail: string | null): void {
    this.#db
      .prepare(
        `INSERT INTO job_events (job_id, event_type, actor, detail, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, type, actor, detail, new Date().toISOString());
  }

  /** The follow-up merged or was approved: its pull request is the shipped one now. */
  #finishFollowUp(id: string): void {
    this.#db.prepare('UPDATE jobs SET follow_up = 0, shipped_pull_request = NULL WHERE id = ?').run(id);
  }

  /** The follow-up was rejected or stopped: back to done, holding the pull request that shipped. */
  #dropFollowUp(id: string): Job {
    this.#db
      .prepare(
        `UPDATE jobs SET follow_up = 0, pull_request = shipped_pull_request,
         shipped_pull_request = NULL, preview_url = NULL WHERE id = ?`,
      )
      .run(id);
    return this.#setState(id, 'done');
  }

  #require(id: string): Job {
    const job = this.getJob(id);
    if (!job) throw new Error(`Unknown job ${id}`);
    return job;
  }

  #setState(id: string, state: JobState): Job {
    this.#db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run(state, id);
    return this.getJob(id)!;
  }
}
