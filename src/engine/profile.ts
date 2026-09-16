import type { JobState } from './states.ts';

/** The Phases that hand work to an agent. Preview and merge are the Engine's own work. */
export const AGENT_PHASES = [
  'research',
  'research_revision',
  'content',
  'content_revision',
  'marketing',
  'marketing_revision',
] as const;

export type PhaseName = (typeof AGENT_PHASES)[number];

/** The Phases that produce a marketing report instead of touching the site. */
export const isMarketingPhase = (phase: PhaseName): boolean =>
  phase === 'marketing' || phase === 'marketing_revision';

export type BackendName = 'codex' | 'claude';

export interface PhaseConfig {
  backend: BackendName;
  model: string;
  timeoutMs: number;
  skill: string;
}

export interface Budgets {
  webSearches: number;
  competitorPages: number;
  ahrefsOperations: number;
  /** A marketing scan covers every lane in one pass, so it gets more than one SEO topic does. */
  marketing: {
    webSearches: number;
    pagesFetched: number;
  };
}

/**
 * Everything specific to one website. The Engine reads a Site Profile; it never
 * hardcodes one.
 */
export interface SiteProfile {
  id: string;
  jobPrefix: string;
  repo: {
    path: string;
    /**
     * What a Job's branch is cut from, kept as two fields rather than one "remote/branch"
     * string: splitting that string guesses wrong for branches containing a slash.
     */
    baseRemote: string;
    baseBranch: string;
    pushRemote: string;
    pullRequestRepo: string;
    branchPrefix: string;
  };
  commands: {
    install: string;
    /** Run in order before a preview deploy; the last one must leave the site in `preview.outputDir`. */
    checks: string[];
  };
  /** Where the built site is uploaded for review: a Cloudflare Pages project and the build's output directory. */
  preview: {
    project: string;
    outputDir: string;
  };
  budgets: Budgets;
  phases: Record<PhaseName, PhaseConfig>;
}

export const baseRef = (profile: SiteProfile): string =>
  `${profile.repo.baseRemote}/${profile.repo.baseBranch}`;

/** Which Phase a Job in this state is running, or null if it is not running one. */
const PHASE_FOR_STATE = {
  researching: 'research',
  research_revising: 'research_revision',
  generating: 'content',
  content_revising: 'content_revision',
  marketing_scanning: 'marketing',
  marketing_revising: 'marketing_revision',
} as const satisfies Partial<Record<JobState, PhaseName>>;

export const phaseForState = (state: JobState): PhaseName | null =>
  (PHASE_FOR_STATE as Partial<Record<JobState, PhaseName>>)[state] ?? null;
