import pkg from '@slack/bolt';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine, Notifier } from '../engine/engine.ts';
import type { AttachmentInput, Job, JobStore } from '../engine/jobs.ts';
import { downloadAttachments, type SlackFile } from './attachments.ts';
import * as messages from './messages.ts';

const { App } = pkg;

export interface SlackConfig {
  appToken: string;
  botToken: string;
  approvers: string[];
}

export function createSlackApp(config: SlackConfig) {
  return new App({ token: config.botToken, appToken: config.appToken, socketMode: true });
}

type SlackApp = ReturnType<typeof createSlackApp>;

/** Removes only RankSmith's own Slack mention while preserving other tagged users. */
export function promptFromMention(text: string, botUserId: string | undefined): string {
  const fallback = text.match(/<@[A-Z0-9]+>/)?.[0];
  const mention = botUserId ? `<@${botUserId}>` : fallback;
  return mention ? text.replaceAll(mention, ' ').replace(/[ \t]+/g, ' ').trim() : text.trim();
}

/** Deliberately exact so a content request containing the word "stop" is not cancelled. */
export const isStopCommand = (prompt: string): boolean => /^stop[.!]?$/i.test(prompt.trim());

export const threadForMention = (event: { ts: string; thread_ts?: string }): string =>
  event.thread_ts ?? event.ts;

const LOADER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const LOADER_FRAME_MS = 5_000;

interface AnimatedStatus {
  timestamp: string;
  note: string;
  frame: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Promise<void> | null;
}

/** Posts everything the Engine wants humans to see into the Job's own thread. */
export function createNotifier(app: SlackApp): Notifier {
  const statusMessages = new Map<string, AnimatedStatus>();

  const post = async (job: Job, message: { text: string; blocks?: unknown[] }) => {
    const response = await app.client.chat.postMessage({
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      ...message,
    } as Parameters<typeof app.client.chat.postMessage>[0]);
    return String(response.ts);
  };

  /** Advances one frame by editing the existing message; no new thread replies are added. */
  const refreshStatus = (job: Job, status: AnimatedStatus): Promise<void> => {
    if (status.inFlight) return status.inFlight;

    let update!: Promise<void>;
    update = app.client.chat
      .update({
        channel: job.slackChannel,
        ts: status.timestamp,
        ...messages.working(job, status.note, LOADER_FRAMES[status.frame] ?? LOADER_FRAMES[0]),
      })
      .then(() => {})
      .catch((error: unknown) => console.error(`[${job.id}] loader update failed:`, error))
      .finally(() => {
        if (status.inFlight === update) status.inFlight = null;
      });
    status.inFlight = update;
    return update;
  };

  /** One animated status per Job communicates liveness without flooding its thread. */
  const setStatus = async (job: Job, note: string): Promise<void> => {
    const existing = statusMessages.get(job.id);
    if (existing) {
      existing.note = note;
      existing.frame = (existing.frame + 1) % LOADER_FRAMES.length;
      await refreshStatus(job, existing);
      return;
    }

    const status: AnimatedStatus = {
      timestamp: await post(job, messages.working(job, note, LOADER_FRAMES[0])),
      note,
      frame: 0,
      timer: null,
      inFlight: null,
    };
    statusMessages.set(job.id, status);

    status.timer = setInterval(() => {
      if (statusMessages.get(job.id) !== status) return;
      status.frame = (status.frame + 1) % LOADER_FRAMES.length;
      void refreshStatus(job, status);
    }, LOADER_FRAME_MS);
    status.timer.unref();
  };

  const finishStatus = async (job: Job, note: string): Promise<void> => {
    const status = statusMessages.get(job.id);
    if (!status) return;

    statusMessages.delete(job.id);
    if (status.timer) clearInterval(status.timer);
    if (status.inFlight) await status.inFlight;

    await app.client.chat.update({
      channel: job.slackChannel,
      ts: status.timestamp,
      ...messages.finishedWorking(job, note),
    });
  };

  return {
    // Mentions keep every update under the message that invoked RankSmith. Slash commands
    // have no source message, so their first post becomes the Job's new thread root.
    jobStarted: async (job) => {
      const response = await app.client.chat.postMessage({
        channel: job.slackChannel,
        ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
        ...messages.jobStarted(job),
      });
      return String(response.ts);
    },
    researchReady: async (job, result, documentPath) => {
      await finishStatus(job, 'Research complete — waiting for review.');
      const filename = `${job.id}-${job.date}-research.md`;
      if (!job.slackThreadTs) throw new Error(`${job.id} has no Slack thread for its research document`);
      let attached = true;
      try {
        await app.client.filesUploadV2({
          channel_id: job.slackChannel,
          thread_ts: job.slackThreadTs,
          file: documentPath,
          filename,
          title: `${job.id} research`,
          initial_comment: `:page_facing_up: *${job.id} full research document*`,
        });
      } catch (error) {
        // File delivery is useful but must never turn completed research into a failed Job.
        attached = false;
        console.error(`[${job.id}] could not upload research to Slack:`, error);
      }
      await post(job, messages.researchReady(job, result, attached ? filename : null));
    },
    contentReady: async (job, prUrl) => {
      await finishStatus(job, 'Content and preview complete — waiting for review.');
      await post(job, messages.contentReady(job, prUrl));
    },
    working: setStatus,
    merging: async (job, prUrl) => {
      await finishStatus(job, 'Pipeline complete.');
      await post(job, messages.merging(job, prUrl));
    },
    failed: async (job, reason) => {
      await finishStatus(job, 'Pipeline stopped.');
      await post(job, messages.failed(job, reason));
    },
    rejected: async (job) => {
      await finishStatus(job, 'Pipeline rejected.');
      await post(job, messages.rejected(job));
    },
    stopped: async (job) => {
      await finishStatus(job, 'Stopped by request.');
      await post(job, messages.stopped(job));
    },
  };
}

export function registerHandlers(app: SlackApp, engine: Engine, jobs: JobStore, config: SlackConfig): void {
  const allowed = (userId: string) => config.approvers.length === 0 || config.approvers.includes(userId);

  app.command('/seo', async ({ ack, command, respond }) => {
    await ack();
    const topic = command.text.trim();

    if (!allowed(command.user_id)) {
      await respond({ text: messages.notApprover, response_type: 'ephemeral' });
      return;
    }

    const files = (command as { files?: SlackFile[] }).files;
    const { attachments, cleanup } = await collectAttachments(files, config.botToken);
    try {
      await engine.startJob(topic === '' ? null : topic, command.channel_id, null, attachments);
    } finally {
      await cleanup();
    }
  });

  app.event('app_mention', async ({ event, context, client }) => {
    if (!event.user) return;

    if (!allowed(event.user)) {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        text: messages.notApprover,
      });
      return;
    }

    const prompt = promptFromMention(event.text, context.botUserId);
    if (prompt === '') {
      await client.chat.postEphemeral({
        channel: event.channel,
        user: event.user,
        text: messages.mentionUsage,
      });
      return;
    }

    // A reaction immediately confirms that Socket Mode received the request. Failure to
    // decorate the message is cosmetic and must never prevent the Job from starting.
    try {
      await client.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'eyes' });
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      if (code !== 'already_reacted') console.error('Could not acknowledge app mention:', error);
    }

    const threadJob = event.thread_ts
      ? jobs.jobForThread(event.channel, event.thread_ts)
      : null;

    if (isStopCommand(prompt)) {
      if (!threadJob) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          text: messages.stopInJobThread,
        });
      } else if (!(await engine.stop(threadJob.id, event.user))) {
        await client.chat.postEphemeral({
          channel: event.channel,
          user: event.user,
          text: messages.stopNotActive(threadJob),
        });
      }
      return;
    }

    const files = (event as { files?: SlackFile[] }).files;
    const { attachments, cleanup } = await collectAttachments(files, config.botToken);

    try {
      // A mention inside an existing Job thread is review feedback, not a second Job.
      if (threadJob) {
        const accepted = await engine.feedback(threadJob.id, event.user, prompt, attachments);
        if (!accepted) {
          await client.chat.postEphemeral({
            channel: event.channel,
            user: event.user,
            text: messages.feedbackNotReady(threadJob),
          });
        }
        return;
      }

      await engine.startJob(prompt, event.channel, threadForMention(event), attachments);
    } finally {
      await cleanup();
    }
  });

  const gateAction = (actionId: string, act: (jobId: string, userId: string) => Promise<void>) =>
    app.action(actionId, async ({ ack, body, client, action }) => {
      await ack();
      const jobId = 'value' in action ? String(action.value) : '';
      const userId = body.user.id;

      if (!allowed(userId)) {
        const channel = body.channel?.id;
        if (channel) {
          await client.chat.postEphemeral({ channel, user: userId, text: messages.notApprover });
        }
        return;
      }

      await act(jobId, userId);
    });

  gateAction('ranksmith_approve', (jobId, userId) => engine.approve(jobId, userId));
  gateAction('ranksmith_reject', (jobId, userId) => engine.reject(jobId, userId, null));

  // Plain thread replies are intentionally ignored. Feedback and stop commands must
  // explicitly mention RankSmith, preventing ordinary conversation from starting work.
}

async function collectAttachments(
  files: SlackFile[] | undefined,
  botToken: string,
): Promise<{ attachments: AttachmentInput[]; cleanup: () => Promise<void> }> {
  if (!files || files.length === 0) {
    return { attachments: [], cleanup: async () => {} };
  }

  const pendingDir = await mkdtemp(join(tmpdir(), 'ranksmith-attachments-'));
  const attachments = await downloadAttachments(files, pendingDir, botToken);
  return {
    attachments,
    cleanup: async () => rm(pendingDir, { recursive: true, force: true }),
  };
}
