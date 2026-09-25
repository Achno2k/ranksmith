import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  posthogSource,
  renderSearchData,
  type ConversionRow,
  type ConversionSource,
  type GscRow,
  type SearchDataConfig,
  type SearchDataSource,
} from './search-data.ts';

const NOW = new Date('2026-09-23T10:00:00Z');
const SITE = 'https://www.connectmachine.ai';

const row = (query: string, page: string, clicks: number, impressions: number, position: number): GscRow => ({
  keys: [query, `${SITE}${page}`],
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

const pageRow = (page: string, clicks: number, impressions: number, position: number): GscRow => ({
  keys: [`${SITE}${page}`],
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

const google = (overrides: Partial<SearchDataSource> = {}): SearchDataSource => ({
  gsc: async (_site, body) =>
    (body['dimensions'] as string[]).length === 2
      ? [
          row('digital business card', '/', 40, 900, 2.1),
          row('business card scanner hubspot', '/blog/hubspot/', 3, 700, 8.4),
          row('nfc card', '/nfc/', 0, 50, 35),
        ]
      : [
          pageRow('/', 40, 900, 2.1),
          pageRow('/tools/bulk-business-card-scanner/', 30, 1200, 6.2),
          pageRow('/blog/what-is-a-digital-business-card/', 5, 6000, 7.0),
          pageRow('/blog/hubspot/', 3, 700, 8.4),
        ],
  ga4: async () => [{ page: '/blog/hubspot/', sessions: 120, engaged: 80, keyEvents: 4 }],
  ...overrides,
});

const conversions = (rows: ConversionRow[]): ConversionSource => ({ conversions: async () => rows });

const POSTHOG_ROWS: ConversionRow[] = [
  { page: '/', sessions: 39, converting: 16, firstSeen: '2026-09-20T12:40:00Z' },
  { page: '/tools/bulk-business-card-scanner/', sessions: 44, converting: 3, firstSeen: '2026-09-20T12:41:00Z' },
  { page: '/blog/what-is-a-digital-business-card/', sessions: 30, converting: 0, firstSeen: '2026-09-21T09:00:00Z' },
  { page: '/blog/hubspot/', sessions: 4, converting: 1, firstSeen: '2026-09-22T09:00:00Z' },
];

const CONFIG: SearchDataConfig = {
  gscSite: 'sc-domain:connectmachine.ai',
  posthog: { host: 'https://us.posthog.com', projectId: 1, conversionEvents: ['create_card_click', 'app_store_click'] },
};

const sources = (overrides: { google?: SearchDataSource | Error; posthog?: ConversionSource | Error } = {}) => ({
  google: google(),
  posthog: conversions(POSTHOG_ROWS),
  ...overrides,
});

const section = (markdown: string, heading: string): string =>
  markdown.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';

describe('first-party search data for research', () => {
  it('ends the Search Console window three days back, where its data has settled', async () => {
    const seen: Record<string, unknown>[] = [];
    await renderSearchData(CONFIG, sources({ google: google({ gsc: async (_site, body) => (seen.push(body), []) }) }), NOW);

    assert.equal(seen[0]?.['endDate'], '2026-09-20');
    assert.equal(seen[0]?.['startDate'], '2026-06-23');
  });

  it('lists only positions 4 to 20 as striking distance, as site paths', async () => {
    const striking = section(await renderSearchData(CONFIG, sources(), NOW), 'Search Console: striking');

    assert.match(striking, /\| business card scanner hubspot \| \/blog\/hubspot\/ \| 3 \| 700 \| 0\.4% \| 8\.4 \|/);
    assert.doesNotMatch(striking, /digital business card|nfc card/);
  });

  it('names what counts as a conversion and when the conversion data starts', async () => {
    const money = section(await renderSearchData(CONFIG, sources(), NOW), 'Money pages');

    assert.match(money, /any of: `create_card_click`, `app_store_click`/);
    assert.match(money, /PostHog conversion data starts 2026-09-20/);
  });

  it('puts converting pages at positions 4 to 20 first and flags traffic that never converts', async () => {
    const money = section(await renderSearchData(CONFIG, sources(), NOW), 'Money pages');
    const rows = money.split('\n').filter((line) => line.startsWith('| /'));

    assert.equal(rows[0], '| /tools/bulk-business-card-scanner/ | money page | 1200 | 30 | 6.2 | 44 | 3 | 6.8% |');
    assert.equal(rows[1], '| /blog/hubspot/ | money page (thin data) | 700 | 3 | 8.4 | 4 | 1 | 25.0% |');
    assert.equal(rows[2], '| /blog/what-is-a-digital-business-card/ | trap | 6000 | 5 | 7.0 | 30 | 0 | 0.0% |');
    assert.equal(rows[3], '| / | converts, top 3 | 900 | 40 | 2.1 | 39 | 16 | 41.0% |');
  });

  it('adds organic GA4 landing pages when a property is configured', async () => {
    const markdown = await renderSearchData({ ...CONFIG, ga4Property: '123' }, sources(), NOW);

    assert.match(markdown, /\| \/blog\/hubspot\/ \| 120 \| 80 \| 4 \|/);
  });

  it('says why a source is missing instead of failing', async () => {
    const noConfig = await renderSearchData(undefined, sources(), NOW);
    assert.match(noConfig, /Unavailable: no `searchData.gscSite`/);
    assert.match(noConfig, /Unavailable: PostHog: no `searchData.posthog`/);
    assert.match(noConfig, /Unavailable: no `searchData.ga4Property`/);

    const noKeys = await renderSearchData(
      { ...CONFIG, ga4Property: '1' },
      { google: new Error('GOOGLE_APPLICATION_CREDENTIALS is not set'), posthog: posthogSource('') },
      NOW,
    );
    assert.equal(noKeys.match(/Unavailable: GOOGLE_APPLICATION_CREDENTIALS is not set/g)?.length, 2);
    assert.match(noKeys, /Unavailable: PostHog: POSTHOG_PERSONAL_API_KEY is not set/);

    const denied = await renderSearchData(
      { ...CONFIG, ga4Property: '1' },
      sources({
        google: google({
          gsc: async () => {
            throw new Error('403 from searchconsole.googleapis.com: User does not have sufficient permission');
          },
        }),
      }),
      NOW,
    );
    assert.match(denied, /## Search Console\n\nUnavailable: 403 .*sufficient permission/);
    assert.match(denied, /Unavailable: Search Console: 403/, 'the join says which side is missing');
    assert.match(denied, /\| \/blog\/hubspot\/ \| 120 \|/, 'GA4 still reports when Search Console fails');
  });

  it('refuses conversion event names that could break out of the query', async () => {
    const source = posthogSource('phx_test');
    assert.ok(!(source instanceof Error));
    await assert.rejects(
      source.conversions({ host: 'https://us.posthog.com', projectId: 1, conversionEvents: ["x') OR 1=1 --"] }, '2026-06-23'),
      /plain identifiers/,
    );
  });
});
