import type { PhaseContract } from './contract.ts';
import { isMarketingPhase, type PhaseName } from './profile.ts';

export const RESULT_PATH = '.ranksmith/result.json';

export const researchPath = (date: string): string => `docs/seo-content/${date}-research.md`;

export const marketingPath = (date: string): string => `docs/marketing/${date}-opportunities.md`;

export const marketingCsvPath = (date: string): string => `docs/marketing/${date}-targets.csv`;

const RESEARCH_HEADINGS = ['Decision', 'Why', 'Ahrefs Evidence', 'Ranked Opportunities', 'Publish Brief'];

/**
 * Sections that are only evidence when they hold a table, not prose about one. Ahrefs
 * Evidence is left out on purpose: when the API returns nothing (every run since
 * 2026-08-14 hit "API units limit reached") an honest one-line report must still pass.
 */
const RESEARCH_TABLES = ['Ranked Opportunities'];

const MARKETING_HEADINGS = ['Summary', 'Ranked Opportunities', 'Targets', 'Drafts', 'Handoffs', 'Gaps'];

const MARKETING_TABLES = ['Ranked Opportunities'];

/** A URL slug as the site's router accepts it. Stored as source text: the contract is data. */
export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

/** The site path of the page a reviewer should open, with a leading slash. */
export const PREVIEW_PATH_PATTERN = '^/[A-Za-z0-9._~\\-/]*$';

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
        { path: marketingPath(date), kind: 'markdown', headings: MARKETING_HEADINGS, tables: MARKETING_TABLES },
        { path: marketingCsvPath(date), kind: 'csv', columns: TARGET_COLUMNS, urlColumns: ['source_url'] },
        {
          path: RESULT_PATH,
          kind: 'json',
          fields: ['focus', 'summary', 'opportunity_count', 'top_opportunities'],
          arrays: ['top_opportunities'],
        },
      ],
    };
  }

  const research = {
    path: researchPath(date),
    kind: 'markdown',
    headings: RESEARCH_HEADINGS,
    tables: RESEARCH_TABLES,
  } as const;

  if (phase === 'research' || phase === 'research_revision') {
    return {
      files: [
        research,
        {
          path: RESULT_PATH,
          kind: 'json',
          fields: ['decision', 'slug', 'primary_keyword', 'page_type'],
          arrays: ['why'],
          patterns: { slug: SLUG_PATTERN },
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
        fields: ['slug', 'summary', 'files_changed', 'preview_path'],
        arrays: ['files_changed'],
        patterns: { slug: SLUG_PATTERN, preview_path: PREVIEW_PATH_PATTERN },
      },
    ],
  };
}
