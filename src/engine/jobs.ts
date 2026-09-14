import { DatabaseSync } from 'node:sqlite';
import {
  afterApproval,
  afterFeedback,
  afterPhase,
  isGate,
  isRunning,
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
}

export interface NewJob {
  profile: string;
  jobPrefix: string;
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
  | 'rejected'
  | 'cancelled'
  | 'retried';

export interface JobEvent {
  type: JobEventType;
  actor: string;
  detail: string | null;
}

interface JobRow {
  id: string;
  profile: string;
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
}

interface EventRow {
  event_type: string;
  actor: string;
  detail: string | null;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  profile: row.profile,
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
});

const today = (): string => new Date().toISOString().slice(0, 10);

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
        attachments TEXT NOT NULL DEFAULT '[]'
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
  }

  close(): void {
    this.#db.close();
  }

  createJob({ profile, jobPrefix, topic, slackChannel, attachments }: NewJob): Job {
    const { next } = this.#db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM jobs WHERE profile = ?')
      .get(profile) as { next: number };
    const id = `${jobPrefix}-${String(next).padStart(3, '0')}`;

    this.#db
      .prepare(
        `INSERT INTO jobs (id, profile, topic, state, slack_channel, seq, date, attachments)
         VALUES (?, ?, ?, 'researching', ?, ?, ?, ?)`,
      )
      .run(id, profile, topic, slackChannel, next, today(), JSON.stringify(attachments));
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
      .prepare("SELECT * FROM jobs WHERE state NOT IN ('done', 'rejected', 'failed') ORDER BY id")
      .all() as unknown as JobRow[];
    return rows.map(toJob);
  }

  update(id: string, fields: Partial<Pick<JobRow, 'slack_thread_ts' | 'slug' | 'branch' | 'pull_request' | 'preview_url'>>): Job {
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
    return this.#setState(id, afterPhase(job.state));
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
    if (job.state === 'done' || job.state === 'rejected' || job.state === 'failed') return null;

    this.#record(id, 'cancelled', actor, null);
    return this.#setState(id, 'rejected');
  }

  /**
   * Sends a failed Job back to the step it died on. Research and content that already
   * passed their Contracts are expensive; a failure in between should not discard them.
   */
  retryFailed(id: string): Job {
    const job = this.#require(id);
    if (job.state !== 'failed') {
      throw new Error(`${id} has not failed; it is at ${job.state}`);
    }

    const target = this.#db.prepare('SELECT failed_from FROM jobs WHERE id = ?').get(id) as {
      failed_from: string | null;
    };
    if (!target.failed_from) throw new Error(`${id} does not record where it failed`);

    this.#record(id, 'retried', 'system', target.failed_from);
    return this.#setState(id, target.failed_from as JobState);
  }

  /** A human approved at a Gate. */
  approve(id: string, actor: string): Job {
    const gate = this.#requireGate(id);
    this.#record(id, 'approved', actor, null);
    return this.#setState(id, afterApproval(gate));
  }

  /** A human rejected at a Gate. */
  reject(id: string, actor: string, feedback: string | null = null): Job {
    this.#requireGate(id);
    this.#record(id, 'rejected', actor, feedback);
    return this.#setState(id, 'rejected');
  }

  /**
   * A human replied in the Job's thread. Only counts as feedback while the Job is
   * waiting at a Gate — chatter at any other moment is left alone.
   */
  recordFeedback(id: string, actor: string, feedback: string, attachments: Attachment[] = []): Job | null {
    const job = this.#require(id);
    if (!isGate(job.state)) return null;

    this.#record(id, 'changes_requested', actor, feedback);
    if (attachments.length > 0) {
      const merged = new Map<string, Attachment>();
      for (const attachment of job.attachments) merged.set(attachment.name, attachment);
      for (const attachment of attachments) merged.set(attachment.name, attachment);
      this.#db
        .prepare('UPDATE jobs SET attachments = ? WHERE id = ?')
        .run(JSON.stringify([...merged.values()]), id);
    }
    return this.#setState(id, afterFeedback(job.state));
  }

  /** Feedback the next Phase must act on, or null if none is outstanding. */
  pendingFeedback(id: string): string | null {
    const row = this.#db
      .prepare(
        `SELECT event_type, detail FROM job_events
         WHERE job_id = ? AND event_type IN ('changes_requested', 'phase_completed')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(id) as EventRow | undefined;

    return row?.event_type === 'changes_requested' ? row.detail : null;
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
