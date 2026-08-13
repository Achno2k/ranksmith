import type { JobState } from './states.ts';

/** The Phases that hand work to an agent. Preview and merge are the Engine's own work. */
export const AGENT_PHASES = ['research', 'research_revision', 'content', 'content_revision'] as const;

export type PhaseName = (typeof AGENT_PHASES)[number];

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
    checks: string[];
    preview: string;
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
} as const satisfies Partial<Record<JobState, PhaseName>>;

export const phaseForState = (state: JobState): PhaseName | null =>
  (PHASE_FOR_STATE as Partial<Record<JobState, PhaseName>>)[state] ?? null;
