import type { KnownBlock } from '@slack/types';
import type { Job } from '../engine/jobs.ts';

const bullets = (values: unknown): string[] =>
  Array.isArray(values) ? values.map((value) => `• ${String(value)}`) : [];

const section = (text: string): KnownBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });

/** Ties a button to the Gate it was posted for, so an old message cannot approve a later Gate. */
export const gateValue = (job: Job): string => `${job.id}:${job.state}`;

/** A posted gate message with its buttons and hint replaced by what happened. */
export const decided = (blocks: KnownBlock[], note: string): KnownBlock[] => [
  ...blocks.filter((block) => block.type !== 'actions' && block.type !== 'context'),
  { type: 'context', elements: [{ type: 'mrkdwn', text: note }] },
];

const gate = (job: Job): KnownBlock => ({
  type: 'actions',
  elements: [
    {
      type: 'button',
      action_id: 'ranksmith_approve',
      style: 'primary',
      text: { type: 'plain_text', text: 'Approve' },
      value: gateValue(job),
    },
    {
      type: 'button',
      action_id: 'ranksmith_reject',
      style: 'danger',
      text: { type: 'plain_text', text: 'Reject' },
      value: gateValue(job),
    },
  ],
});

const hint: KnownBlock = {
  type: 'context',
  elements: [{ type: 'mrkdwn', text: '_Mention @RankSmith in this thread to ask a question or request changes._' }],
};

export function jobStarted(job: Job) {
  const mode =
    job.kind === 'marketing'
      ? job.topic
        ? `Marketing scan. Focus: ${job.topic}`
        : 'Marketing scan. Mode: full scan across every lane.'
      : job.topic
        ? `Topic: ${job.topic}`
        : 'Mode: discovery — surveying the site and market.';
  const lines = [`*${job.id} started*`, '', mode];
  return { text: `${job.id} started`, blocks: [section(lines.join('\n'))] };
}

export function marketingReady(job: Job, result: Record<string, unknown>, filenames: string[]) {
  const lines = [
    `*${job.id} — marketing opportunities ready*`,
    '',
    `*Focus:* ${String(result['focus'] ?? (job.topic ?? 'full scan'))}`,
    `*Summary:* ${String(result['summary'] ?? 'see report')}`,
    `*Opportunities found:* ${String(result['opportunity_count'] ?? '—')}`,
    '',
    '*Top opportunities*',
    ...bullets(result['top_opportunities']),
    ...(Array.isArray(result['seo_handoffs']) && result['seo_handoffs'].length > 0
      ? ['', '*Worth a `/seo` job*', ...bullets(result['seo_handoffs'])]
      : []),
    '',
    filenames.length > 0
      ? `Full report and targets: attached in this thread as ${filenames.map((name) => `\`${name}\``).join(' and ')}.`
      : ':warning: Report attachments failed to upload. Ask the RankSmith operator to check `files:write`.',
    'Approving closes the job. Nothing is sent, posted, or imported.',
  ];

  return { text: `${job.id} marketing opportunities ready`, blocks: [section(lines.join('\n')), gate(job), hint] };
}

export function researchReady(job: Job, result: Record<string, unknown>, filename: string | null) {
  const lines = [
    `*${job.id} — research ready*`,
    '',
    `*Decision:* ${String(result['decision'] ?? 'see document')}`,
    `*Keyword:* \`${String(result['primary_keyword'] ?? '—')}\`  *Type:* ${String(result['page_type'] ?? '—')}`,
    `*Slug:* \`${String(result['slug'] ?? '—')}\``,
    ...bullets(result['why']),
    '',
    filename
      ? `Full research: attached in this thread as \`${filename}\`.`
      : ':warning: Research attachment failed to upload. Ask the RankSmith operator to check `files:write`.',
  ];

  return { text: `${job.id} research ready`, blocks: [section(lines.join('\n')), gate(job), hint] };
}

export function contentReady(job: Job, prUrl: string) {
  const lines = [
    `*${job.id} — content ready*`,
    '',
    `Preview: ${job.previewUrl ?? 'unavailable'}`,
    `Pull request: ${prUrl}`,
  ];

  return { text: `${job.id} content ready`, blocks: [section(lines.join('\n')), gate(job), hint] };
}

export const working = (job: Job, note: string, loader = '⠋') => ({
  text: `${loader} ${job.id}: ${note}`,
  blocks: [section(`${loader} *${job.id} is working*\n${note}`)],
});

/** The Engine's note as short lines Slack can rotate under the thread; log paths stay in the loader message. */
export const statusLines = (note: string): string[] =>
  note
    .split('\n')
    .map((line) => line.replace(/ · process active\.?$/, '').replace(/\.$/, '').trim())
    .filter((line) => line !== '' && !line.startsWith('Live log:'))
    .slice(0, 10);

/** Slack renders the status after the app name: "RankSmith is working on CM-002…". */
export const workingStatus = (job: Job, note: string) => {
  const lines = statusLines(note);
  return { status: `is working on ${job.id}…`, loading_messages: lines.length > 0 ? lines : [`Working on ${job.id}…`] };
};

export const triageStatus = {
  status: 'is reading your message…',
  loading_messages: ['Reading your message…', 'Checking the Job, its pull request, and the repo…'],
};

export const finishedWorking = (job: Job, note: string) => ({
  text: `${job.id}: ${note}`,
  blocks: [section(`:white_check_mark: *${job.id}*\n${note}`)],
});

export const merging = (job: Job, prUrl: string) => ({
  text: `${job.id} approved. Auto-merge queued behind CI: ${prUrl}`,
});

export const rejected = (job: Job) => ({ text: `${job.id} rejected. Worktree removed.` });

export const stopped = (job: Job) => ({ text: `${job.id} stopped. Worktree removed.` });

export const failed = (job: Job, reason: string) => ({
  text: `${job.id} failed.\n\`\`\`${reason}\`\`\`\nWorktree kept for inspection.`,
});

export const notApprover = 'You are not an approver for RankSmith jobs.';

export const mentionUsage =
  'Give RankSmith a topic or request, for example: `@RankSmith research event lead capture`, or `@RankSmith marketing` for a marketing scan.';

export const feedbackNotReady = (job: Job) =>
  `${job.id} is currently \`${job.state}\`. Mention feedback is accepted when the Job is waiting for review.`;

export const stopInJobThread = 'Use `@RankSmith stop` inside the RankSmith Job thread you want to stop.';

export const stopNotActive = (job: Job) => `${job.id} is already \`${job.state}\`; there is nothing to stop.`;

export function revertReady(job: Job, prUrl: string) {
  const lines = [
    `*${job.id} — revert ready*`,
    '',
    `Revert pull request: ${prUrl}`,
    'Approving queues it to merge behind CI, which takes the content off staging.',
  ];

  return { text: `${job.id} revert ready`, blocks: [section(lines.join('\n')), gate(job)] };
}

export const reverted = (job: Job, prUrl: string | null) => ({
  text: prUrl
    ? `${job.id} revert approved. Auto-merge queued behind CI: ${prUrl}`
    : `${job.id} had not merged yet, so its pull request was closed instead.`,
});

export const revertCancelled = (job: Job) => ({
  text: `${job.id} revert cancelled. The revert pull request is closed and the content stays.`,
});

export const revertNotAvailable = (job: Job) =>
  `${job.id} is \`${job.state}\`. Only a finished Job can be reverted; before that, use Reject or \`stop\`.`;

export const triageFailed =
  'I could not work out what you meant. Mention me again with a question, a change request, `stop`, or `revert`.';
