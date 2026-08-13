import pkg from '@slack/bolt';
import type { Engine, Notifier } from '../engine/engine.ts';
import type { Job } from '../engine/jobs.ts';
import type { JobStore } from '../engine/jobs.ts';
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

/** Posts everything the Engine wants humans to see into the Job's own thread. */
export function createNotifier(app: SlackApp): Notifier {
  const post = async (job: Job, message: { text: string; blocks?: unknown[] }) => {
    const response = await app.client.chat.postMessage({
      channel: job.slackChannel,
      ...(job.slackThreadTs ? { thread_ts: job.slackThreadTs } : {}),
      ...message,
    } as Parameters<typeof app.client.chat.postMessage>[0]);
    return String(response.ts);
  };

  return {
    // Posted to the channel the command came from, which is the same channel every later
    // message and every thread reply uses. Splitting the two strands the job's gates.
    jobStarted: async (job) => {
      const response = await app.client.chat.postMessage({
        channel: job.slackChannel,
        ...messages.jobStarted(job),
      });
      return String(response.ts);
    },
    researchReady: async (job, result) => void (await post(job, messages.researchReady(job, result))),
    contentReady: async (job, prUrl) => void (await post(job, messages.contentReady(job, prUrl))),
    working: async (job, note) => void (await post(job, messages.working(job, note))),
    merging: async (job, prUrl) => void (await post(job, messages.merging(job, prUrl))),
    failed: async (job, reason) => void (await post(job, messages.failed(job, reason))),
    rejected: async (job) => void (await post(job, messages.rejected(job))),
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

    await engine.startJob(topic === '' ? null : topic, command.channel_id);
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

  /**
   * A plain reply in a Job's thread is feedback — no command required. The Engine ignores
   * it unless the Job is actually waiting at a Gate, so ordinary chatter is harmless.
   */
  app.event('message', async ({ event }) => {
    const message = event as {
      subtype?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      channel: string;
      thread_ts?: string;
    };

    if (message.subtype || message.bot_id || !message.thread_ts || !message.user || !message.text) return;
    if (!allowed(message.user)) return;

    const job = jobs.jobForThread(message.channel, message.thread_ts);
    if (!job) return;

    await engine.feedback(job.id, message.user, message.text.trim());
  });
}
