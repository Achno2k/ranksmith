import { run } from './exec.ts';
import type { Job } from './jobs.ts';

export const INTENTS = ['question', 'feedback', 'revert', 'stop'] as const;

export type Intent = (typeof INTENTS)[number];

export interface Triage {
  intent: Intent;
  /** The reply to a question. Empty for every other intent. */
  answer: string;
}

export interface TriageRequest {
  job: Job;
  text: string;
  /** Facts the Engine already knows, one per line, so the agent does not have to dig. */
  context: string[];
  cwd: string;
}

/** A mention needs a reply in seconds, not a Phase's budget. */
export const TRIAGE_MODEL = 'claude-sonnet-5';

const TRIAGE_TIMEOUT_MS = 5 * 60_000;

/**
 * Read-only on purpose. Triage only says what a human meant; the Engine decides whether that
 * is allowed right now, so nothing here may edit the site or move the Job.
 */
export const TRIAGE_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git diff *)',
  'Bash(gh pr view *)',
  'Bash(gh pr diff *)',
  'Bash(gh run list *)',
];

export function buildTriage({ job, text, context, cwd }: TriageRequest) {
  const args = [
    '-p',
    '--model',
    TRIAGE_MODEL,
    '--allowedTools',
    TRIAGE_ALLOWED_TOOLS.join(','),
    '--disallowedTools',
    'Edit,Write,NotebookEdit',
  ];

  const prompt = [
    `You are RankSmith, replying to a message in the Slack thread of job ${job.id}.`,
    `# Message\n\n${text}`,
    `# What is known about the job\n\n${context.join('\n')}`,
    [
      '# Decide the intent',
      '',
      'Pick exactly one:',
      '- question: wants information about the job, its research, content, pull request, preview or deployment.',
      '- feedback: asks for the research or content to change.',
      '- revert: asks to undo, roll back or revert work that already shipped.',
      '- stop: asks to stop or cancel the job while it is still running.',
      'If it is unclear, pick question. A wrong revision costs half an hour; a wrong answer costs one follow-up.',
    ].join('\n'),
    [
      '# Reply format',
      '',
      'The first line must be exactly `INTENT: <intent>`.',
      'For a question, write the answer after that line in Slack mrkdwn, in a few short lines.',
      'Check facts before stating them: use the context above, files in this directory, `git` and `gh`.',
      'Say plainly when you cannot tell. For any other intent, write nothing after the first line.',
    ].join('\n'),
  ].join('\n\n');

  return { command: 'claude', args, prompt, cwd, timeoutMs: TRIAGE_TIMEOUT_MS };
}

const INTENT_LINE = /^[ \t`*]*INTENT:[ \t]*(\w+)[ \t`*]*$/im;

/** Null when the agent ignored the format, so the caller can ask the human to rephrase. */
export function parseTriage(output: string): Triage | null {
  const match = INTENT_LINE.exec(output);
  const intent = match?.[1]?.toLowerCase() ?? '';
  if (!match || !(INTENTS as readonly string[]).includes(intent)) return null;

  return {
    intent: intent as Intent,
    answer: intent === 'question' ? output.slice(match.index + match[0].length).trim() : '',
  };
}

export async function runTriage(request: TriageRequest): Promise<Triage | null> {
  const { command, args, prompt, cwd, timeoutMs } = buildTriage(request);
  const { stdout } = await run(command, args, { cwd, input: prompt, timeoutMs });
  return parseTriage(stdout);
}
