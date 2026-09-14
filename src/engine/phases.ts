import type { PhaseContract } from './contract.ts';
import { isMarketingPhase, type PhaseName } from './profile.ts';

export const RESULT_PATH = '.ranksmith/result.json';

export const researchPath = (date: string): string => `docs/seo-content/${date}-research.md`;

export const marketingPath = (date: string): string => `docs/marketing/${date}-opportunities.md`;

export const marketingCsvPath = (date: string): string => `docs/marketing/${date}-targets.csv`;

const RESEARCH_HEADINGS = ['Decision', 'Why', 'Ahrefs Evidence', 'Ranked Opportunities', 'Publish Brief'];

const MARKETING_HEADINGS = ['Summary', 'Ranked Opportunities', 'Targets', 'Drafts', 'Handoffs', 'Gaps'];

/** One row per person or organisation worth acting on, with the evidence beside it. */
export const TARGET_COLUMNS = [
  'name',
  'type',
  'org',
  'lane',
  'channel',
  'source_url',
  'why_it_matters',
  'next_action',
];

/**
 * What each Phase must leave in the Workspace. This is both what the prompt asks for and
 * what the Engine checks afterwards — they are the same list on purpose, so a Phase can
 * never be asked for one thing and judged against another.
 */
export function contractFor(phase: PhaseName, date: string): PhaseContract {
  if (isMarketingPhase(phase)) {
    return {
      files: [
        { path: marketingPath(date), kind: 'markdown', headings: MARKETING_HEADINGS },
        { path: marketingCsvPath(date), kind: 'csv', columns: TARGET_COLUMNS },
        {
          path: RESULT_PATH,
          kind: 'json',
          fields: ['focus', 'summary', 'opportunity_count', 'top_opportunities'],
        },
      ],
    };
  }

  const research = {
    path: researchPath(date),
    kind: 'markdown',
    headings: RESEARCH_HEADINGS,
  } as const;

  if (phase === 'research' || phase === 'research_revision') {
    return {
      files: [
        research,
        {
          path: RESULT_PATH,
          kind: 'json',
          fields: ['decision', 'slug', 'primary_keyword', 'page_type'],
        },
      ],
    };
  }

  return {
    files: [
      research,
      {
        path: RESULT_PATH,
        kind: 'json',
        fields: ['slug', 'summary', 'files_changed'],
      },
    ],
  };
}
