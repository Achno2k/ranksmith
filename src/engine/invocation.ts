import type { Attachment } from './jobs.ts';
import { contractFor, researchPath } from './phases.ts';
import type { PhaseName, SiteProfile } from './profile.ts';

export interface RunRequest {
  jobId: string;
  phase: PhaseName;
  profile: SiteProfile;
  workspace: string;
  /** The date the Job's artifacts are stamped with; fixed for the life of the Job. */
  date: string;
  topic: string | null;
  feedback: string | null;
  /** Contract gaps from the previous attempt, if this is a retry. */
  gaps: string[];
  /** Files the user attached to the original Slack message or feedback. */
  attachments: Attachment[];
}

export interface AgentInvocation {
  command: string;
  args: string[];
  cwd: string;
  /** Delivered on stdin rather than argv, so length is never a problem. */
  prompt: string;
  timeoutMs: number;
}

export function buildRun(request: RunRequest): AgentInvocation {
  const config = request.profile.phases[request.phase];

  const args =
    config.backend === 'codex'
      ? ['exec', '-C', request.workspace, '-m', config.model, '-s', 'workspace-write', '-']
      : ['-p', '--model', config.model, '--permission-mode', 'acceptEdits'];

  return {
    command: config.backend,
    args,
    cwd: request.workspace,
    prompt: buildPrompt(request),
    timeoutMs: config.timeoutMs,
  };
}

function buildPrompt(request: RunRequest): string {
  const { profile, phase, date } = request;
  const skill = profile.phases[phase].skill;

  const sections = [
    `You are running the ${phase} phase of RankSmith job ${request.jobId} for ${profile.id}.`,
    `Use the ${skill} skill and follow it completely.`,
    task(request),
    boundaries(profile),
    budgets(request),
    required(phase, date),
    attachments(request.attachments),
    humanFeedback(request.feedback),
    previousAttempt(request.gaps),
  ];

  return sections.filter((section) => section !== null).join('\n\n');
}

function task(request: RunRequest): string {
  const research = researchPath(request.date);

  switch (request.phase) {
    case 'research':
    case 'research_revision':
      return request.topic
        ? `# Task\n\nResearch this topic and decide whether it is worth publishing: ${request.topic}`
        : '# Task\n\nSurvey the site and the market, then rank the opportunities you find and decide which single piece is worth publishing now.';
    case 'content':
      return `# Task\n\nImplement the approved research in \`${research}\`. Follow the website's existing conventions, typography and content schemas. Add internal links and metadata. Commit your work on the current branch.`;
    case 'content_revision':
      return `# Task\n\nRevise the content you already produced on this branch, guided by the reviewer feedback below. The approved research is in \`${research}\`. Commit your work on the current branch.`;
  }
}

function boundaries(profile: SiteProfile): string {
  return [
    '# Boundaries',
    '',
    '- Do not merge anything.',
    '- Do not deploy anything.',
    '- Do not push to any branch other than the one already checked out.',
    '- Do not create git tags.',
    `- Stay inside this worktree. The shared checkout of ${profile.repo.pullRequestRepo} is not yours to touch.`,
    '- Do not invent metrics, quotes, citations, or product capabilities.',
  ].join('\n');
}

function budgets(request: RunRequest): string | null {
  if (request.phase !== 'research' && request.phase !== 'research_revision') return null;

  const { webSearches, competitorPages, ahrefsOperations } = request.profile.budgets;
  return [
    '# Budget',
    '',
    `Stay within ${webSearches} web searches, ${competitorPages} competitor pages, and ${ahrefsOperations} Ahrefs operations.`,
    'Record what you actually used in the result file. If a budget is not enough, say so rather than quietly exceeding it.',
  ].join('\n');
}

function required(phase: PhaseName, date: string): string {
  const lines = contractFor(phase, date).files.map((file) =>
    file.kind === 'markdown'
      ? `- \`${file.path}\` with sections: ${file.headings.join(', ')}`
      : `- \`${file.path}\` containing the keys: ${file.fields.join(', ')}`,
  );

  return [
    '# Required output',
    '',
    'Your work is judged only on these files. Anything missing is a failed run:',
    ...lines,
  ].join('\n');
}

function humanFeedback(feedback: string | null): string | null {
  return feedback === null ? null : `# Reviewer feedback\n\nAct on this exactly:\n\n${feedback}`;
}

function previousAttempt(gaps: string[]): string | null {
  if (gaps.length === 0) return null;

  return [
    '# Previous attempt',
    '',
    'Your last run did not produce what was required. Fix exactly these gaps:',
    ...gaps.map((gap) => `- ${gap}`),
  ].join('\n');
}

function attachments(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null;

  const lines = attachments.map((attachment) => {
    const kind = attachment.mimetype.startsWith('image/')
      ? 'image'
      : attachment.mimetype;
    return `- \`.ranksmith/attachments/${attachment.name}\` (${kind})`;
  });

  return [
    '# Attachments',
    '',
    'The user attached these files. Read them and consider them as part of the context:',
    ...lines,
  ].join('\n');
}
