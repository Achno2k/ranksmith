import type { PhaseContract } from './contract.ts';
import type { PhaseName } from './profile.ts';

export const RESULT_PATH = '.ranksmith/result.json';

export const researchPath = (date: string): string => `docs/seo-content/${date}-research.md`;

const RESEARCH_HEADINGS = ['Decision', 'Why', 'Ahrefs Evidence', 'Ranked Opportunities', 'Publish Brief'];

/**
 * What each Phase must leave in the Workspace. This is both what the prompt asks for and
 * what the Engine checks afterwards — they are the same list on purpose, so a Phase can
 * never be asked for one thing and judged against another.
 */
export function contractFor(phase: PhaseName, date: string): PhaseContract {
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
