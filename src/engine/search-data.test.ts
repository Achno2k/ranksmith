import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderSearchData, type GscRow, type SearchDataSource } from './search-data.ts';

const NOW = new Date('2026-09-23T10:00:00Z');

const row = (query: string, page: string, clicks: number, impressions: number, position: number): GscRow => ({
  keys: [query, page],
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

const source = (overrides: Partial<SearchDataSource> = {}): SearchDataSource => ({
  gsc: async (_site, body) =>
    (body['dimensions'] as string[]).length === 2
      ? [
          row('digital business card', 'https://www.connectmachine.ai/', 40, 900, 2.1),
          row('business card scanner hubspot', 'https://www.connectmachine.ai/blog/hubspot/', 3, 700, 8.4),
          row('nfc card', 'https://www.connectmachine.ai/nfc/', 0, 50, 35),
        ]
      : [{ keys: ['https://www.connectmachine.ai/'], clicks: 40, impressions: 900, ctr: 0.044, position: 2.1 }],
  ga4: async () => [{ page: '/blog/hubspot/', sessions: 120, engaged: 80, keyEvents: 4 }],
  ...overrides,
});

describe('first-party search data for research', () => {
  it('ends the window three days back, where Search Console data has settled', async () => {
    const seen: Record<string, unknown>[] = [];
    await renderSearchData(
      { gscSite: 'sc-domain:connectmachine.ai' },
      source({ gsc: async (_site, body) => (seen.push(body), []) }),
      NOW,
    );

    assert.equal(seen[0]?.['endDate'], '2026-09-20');
    assert.equal(seen[0]?.['startDate'], '2026-06-23');
  });

  it('lists only positions 4 to 20 as striking distance, as site paths', async () => {
    const markdown = await renderSearchData({ gscSite: 'sc-domain:connectmachine.ai' }, source(), NOW);
    const striking = markdown.split('## Search Console: top queries')[0] ?? '';

    assert.match(striking, /\| business card scanner hubspot \| \/blog\/hubspot\/ \| 3 \| 700 \| 0\.4% \| 8\.4 \|/);
    assert.doesNotMatch(striking, /digital business card|nfc card/);
  });

  it('adds organic GA4 landing pages when a property is configured', async () => {
    const markdown = await renderSearchData({ gscSite: 'x', ga4Property: '123' }, source(), NOW);

    assert.match(markdown, /\| \/blog\/hubspot\/ \| 120 \| 80 \| 4 \|/);
  });

  it('says why a source is missing instead of failing', async () => {
    const noConfig = await renderSearchData(undefined, source(), NOW);
    assert.match(noConfig, /Unavailable: no `searchData.gscSite`/);
    assert.match(noConfig, /Unavailable: no `searchData.ga4Property`/);

    const noKey = await renderSearchData({ gscSite: 'x', ga4Property: '1' }, new Error('GOOGLE_APPLICATION_CREDENTIALS is not set'), NOW);
    assert.equal(noKey.match(/Unavailable: GOOGLE_APPLICATION_CREDENTIALS is not set/g)?.length, 2);

    const denied = await renderSearchData(
      { gscSite: 'x', ga4Property: '1' },
      source({
        gsc: async () => {
          throw new Error('403 from searchconsole.googleapis.com: User does not have sufficient permission');
        },
      }),
      NOW,
    );
    assert.match(denied, /Unavailable: 403 .*sufficient permission/);
    assert.match(denied, /\| \/blog\/hubspot\/ \| 120 \|/, 'GA4 still reports when Search Console fails');
  });
});
