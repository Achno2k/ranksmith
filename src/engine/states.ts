export const JOB_STATES = [
  'researching',
  'research_review',
  'research_revising',
  'generating',
  'preview_building',
  'content_review',
  'content_revising',
  'merging',
  'done',
  'reverting',
  'revert_review',
  'revert_merging',
  'reverted',
  'rejected',
  'failed',
  'marketing_scanning',
  'marketing_review',
  'marketing_revising',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/**
 * What a Job is for. A seo Job ships content through a pull request; a marketing Job
 * ends at a reviewed report and never touches the site.
 */
export const JOB_KINDS = ['seo', 'marketing'] as const;

export type JobKind = (typeof JOB_KINDS)[number];

/** Where a Job of each kind begins. */
const INITIAL_STATE = {
  seo: 'researching',
  marketing: 'marketing_scanning',
} as const satisfies Record<JobKind, JobState>;

export const initialState = (kind: JobKind): JobState => INITIAL_STATE[kind];

/**
 * States where the Job waits for a human. Only a human action moves a Job out of
 * one of these — the Engine never does, and an agent may never infer approval.
 */
export const GATES = ['research_review', 'content_review', 'revert_review', 'marketing_review'] as const;

export type Gate = (typeof GATES)[number];

export const isGate = (state: JobState): state is Gate => (GATES as readonly string[]).includes(state);

/** Where a Job goes when the Phase it is running finishes and passes its Contract. */
const AFTER_PHASE = {
  researching: 'research_review',
  research_revising: 'research_review',
  generating: 'preview_building',
  preview_building: 'content_review',
  content_revising: 'preview_building',
  merging: 'done',
  reverting: 'revert_review',
  revert_merging: 'reverted',
  marketing_scanning: 'marketing_review',
  marketing_revising: 'marketing_review',
} as const satisfies Partial<Record<JobState, JobState>>;

export type RunningState = keyof typeof AFTER_PHASE;

export const isRunning = (state: JobState): state is RunningState => state in AFTER_PHASE;

export const afterPhase = (state: RunningState): JobState => AFTER_PHASE[state];

/** Where a Job goes when a human approves at a Gate. */
const AFTER_APPROVAL = {
  research_review: 'generating',
  content_review: 'merging',
  revert_review: 'revert_merging',
  // A marketing report has nothing to ship, so approval simply closes the Job.
  marketing_review: 'done',
} as const satisfies Record<Gate, JobState>;

export const afterApproval = (gate: Gate): JobState => AFTER_APPROVAL[gate];

/**
 * Where a Job goes when a human replies with feedback at a Gate. A revert has nothing to
 * revise, so its Gate takes only approve or reject.
 */
const AFTER_FEEDBACK: Partial<Record<Gate, JobState>> = {
  research_review: 'research_revising',
  content_review: 'content_revising',
  marketing_review: 'marketing_revising',
};

export const afterFeedback = (gate: Gate): JobState | null => AFTER_FEEDBACK[gate] ?? null;
