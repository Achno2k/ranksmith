import type { KnownBlock } from '@slack/types';
import type { Job } from '../engine/jobs.ts';

const bullets = (values: unknown): string[] =>
  Array.isArray(values) ? values.map((value) => `• ${String(value)}`) : [];

const section = (text: string): KnownBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });

const gate = (jobId: string): KnownBlock => ({
  type: 'actions',
  elements: [
    {
      type: 'button',
      action_id: 'ranksmith_approve',
      style: 'primary',
      text: { type: 'plain_text', text: 'Approve' },
      value: jobId,
    },
    {
      type: 'button',
      action_id: 'ranksmith_reject',
      style: 'danger',
      text: { type: 'plain_text', text: 'Reject' },
      value: jobId,
    },
  ],
});

const hint: KnownBlock = {
  type: 'context',
  elements: [{ type: 'mrkdwn', text: '_Reply in this thread to request changes._' }],
};

export function jobStarted(job: Job) {
  const lines = [
    `*${job.id} started*`,
    '',
    job.topic ? `Topic: ${job.topic}` : 'Mode: discovery — surveying the site and market.',
  ];
  return { text: `${job.id} started`, blocks: [section(lines.join('\n'))] };
}

export function researchReady(job: Job, result: Record<string, unknown>) {
  const lines = [
    `*${job.id} — research ready*`,
    '',
    `*Decision:* ${String(result['decision'] ?? 'see document')}`,
    `*Keyword:* \`${String(result['primary_keyword'] ?? '—')}\`  *Type:* ${String(result['page_type'] ?? '—')}`,
    `*Slug:* \`${String(result['slug'] ?? '—')}\``,
    ...bullets(result['why']),
    '',
    `Full research: \`docs/seo-content/${job.date}-research.md\``,
  ];

  return { text: `${job.id} research ready`, blocks: [section(lines.join('\n')), gate(job.id), hint] };
}

export function contentReady(job: Job, prUrl: string) {
  const lines = [
    `*${job.id} — content ready*`,
    '',
    `Preview: ${job.previewUrl ?? 'unavailable'}`,
    `Pull request: ${prUrl}`,
  ];

  return { text: `${job.id} content ready`, blocks: [section(lines.join('\n')), gate(job.id), hint] };
}

export const working = (job: Job, note: string) => ({ text: `${job.id}: ${note}` });

export const merging = (job: Job, prUrl: string) => ({
  text: `${job.id} approved. Auto-merge queued behind CI: ${prUrl}`,
});

export const rejected = (job: Job) => ({ text: `${job.id} rejected. Worktree removed.` });

export const failed = (job: Job, reason: string) => ({
  text: `${job.id} failed.\n\`\`\`${reason}\`\`\`\nWorktree kept for inspection.`,
});

export const notApprover = 'You are not an approver for RankSmith jobs.';
