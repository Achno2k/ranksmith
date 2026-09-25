import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * First-party search evidence for research: what the site already ranks for (Search Console)
 * and which pages bring organic visitors (GA4). The Engine fetches it before the agent starts,
 * so research never depends on an MCP being authenticated on the host.
 */
export interface SearchDataConfig {
  /** Search Console property, e.g. `sc-domain:connectmachine.ai` or `https://www.connectmachine.ai/`. */
  gscSite?: string;
  /** GA4 property id, digits only. */
  ga4Property?: string;
}

export const SEARCH_DATA_PATH = '.ranksmith/search-data.md';

const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

/** Search Console data settles about three days late; a window ending sooner under-reports. */
const LAG_DAYS = 3;
const WINDOW_DAYS = 90;
const TABLE_ROWS = 40;

/** Striking distance: ranking, but below the fold, where a refresh moves traffic most. */
const STRIKING_MIN = 4;
const STRIKING_MAX = 20;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface Ga4Row {
  page: string;
  sessions: number;
  engaged: number;
  keyEvents: number;
}

/** Where the fetch functions reach Google. Swapped out in tests. */
export interface SearchDataSource {
  gsc(site: string, body: Record<string, unknown>): Promise<GscRow[]>;
  ga4(property: string, start: string, end: string): Promise<Ga4Row[]>;
}

const day = (date: Date, minusDays: number): string =>
  new Date(date.getTime() - minusDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Builds the markdown the research agent reads. Each source fails on its own and says why
 * in its section: missing data is a finding for the report, never a reason to fail the Job.
 */
export async function renderSearchData(
  config: SearchDataConfig | undefined,
  source: SearchDataSource | Error,
  now = new Date(),
): Promise<string> {
  const end = day(now, LAG_DAYS);
  const start = day(now, LAG_DAYS + WINDOW_DAYS - 1);
  const lines = [
    '# First-party search data',
    '',
    `Fetched by the Engine on ${now.toISOString().slice(0, 10)}. Window: ${start} to ${end} (${WINDOW_DAYS} days).`,
    'Positions are Search Console averages. Clicks and sessions are totals for the window.',
    '',
  ];

  lines.push(...(await gscSections(config?.gscSite, source, start, end)));
  lines.push(...(await ga4Section(config?.ga4Property, source, start, end)));
  return `${lines.join('\n')}\n`;
}

async function gscSections(
  site: string | undefined,
  source: SearchDataSource | Error,
  start: string,
  end: string,
): Promise<string[]> {
  const unavailable = (why: string) => ['## Search Console', '', `Unavailable: ${why}`, ''];
  if (!site) return unavailable('no `searchData.gscSite` in the Site Profile.');
  if (source instanceof Error) return unavailable(source.message);

  try {
    const [pairs, pages] = await Promise.all([
      source.gsc(site, { startDate: start, endDate: end, dimensions: ['query', 'page'], rowLimit: 1000 }),
      source.gsc(site, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 250 }),
    ]);

    const striking = pairs
      .filter((row) => row.position >= STRIKING_MIN && row.position <= STRIKING_MAX)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, TABLE_ROWS);
    const topQueries = [...pairs].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, TABLE_ROWS);
    const topPages = [...pages].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, TABLE_ROWS);

    const queryHeader = ['| Query | Page | Clicks | Impressions | CTR | Position |', '| --- | --- | ---: | ---: | ---: | ---: |'];
    const queryRow = (row: GscRow) =>
      `| ${cell(row.keys[0])} | ${cell(path(row.keys[1]))} | ${row.clicks} | ${row.impressions} | ${pct(row.ctr)} | ${row.position.toFixed(1)} |`;

    return [
      `## Search Console: striking distance (position ${STRIKING_MIN} to ${STRIKING_MAX})`,
      '',
      'Queries the site already ranks for but below the top results, by impressions. A refresh of',
      'the ranking page usually beats a new page for these.',
      '',
      ...(striking.length ? [...queryHeader, ...striking.map(queryRow)] : ['No rows.']),
      '',
      '## Search Console: top queries',
      '',
      ...(topQueries.length ? [...queryHeader, ...topQueries.map(queryRow)] : ['No rows.']),
      '',
      '## Search Console: top pages',
      '',
      ...(topPages.length
        ? [
            '| Page | Clicks | Impressions | CTR | Position |',
            '| --- | ---: | ---: | ---: | ---: |',
            ...topPages.map(
              (row) =>
                `| ${cell(path(row.keys[0]))} | ${row.clicks} | ${row.impressions} | ${pct(row.ctr)} | ${row.position.toFixed(1)} |`,
            ),
          ]
        : ['No rows.']),
      '',
    ];
  } catch (error) {
    return unavailable(message(error));
  }
}

async function ga4Section(
  property: string | undefined,
  source: SearchDataSource | Error,
  start: string,
  end: string,
): Promise<string[]> {
  const heading = ['## GA4: organic landing pages', ''];
  if (!property) return [...heading, 'Unavailable: no `searchData.ga4Property` in the Site Profile.', ''];
  if (source instanceof Error) return [...heading, `Unavailable: ${source.message}`, ''];

  try {
    const rows = await source.ga4(property, start, end);
    if (rows.length === 0) return [...heading, 'No rows.', ''];
    return [
      ...heading,
      'Sessions from Organic Search only. Key events are the conversions configured in GA4.',
      '',
      '| Landing page | Sessions | Engaged sessions | Key events |',
      '| --- | ---: | ---: | ---: |',
      ...rows.map((row) => `| ${cell(row.page)} | ${row.sessions} | ${row.engaged} | ${row.keyEvents} |`),
      '',
    ];
  } catch (error) {
    return [...heading, `Unavailable: ${message(error)}`, ''];
  }
}

/**
 * The real source, authenticated as the service account in GOOGLE_APPLICATION_CREDENTIALS.
 * An Error instead of a source when the key is missing or unreadable, so the report can
 * say exactly that.
 */
export async function googleSource(keyPath = process.env['GOOGLE_APPLICATION_CREDENTIALS']): Promise<SearchDataSource | Error> {
  if (!keyPath) return new Error('GOOGLE_APPLICATION_CREDENTIALS is not set on the Engine host.');

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(await readFile(keyPath, 'utf8')) as ServiceAccountKey;
  } catch (error) {
    return new Error(`cannot read the service account key at ${keyPath}: ${message(error)}`);
  }

  let token: Promise<string> | null = null;
  const bearer = () => (token ??= accessToken(key));

  return {
    async gsc(site, body) {
      const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
      const data = (await postJson(url, await bearer(), body)) as { rows?: GscRow[] };
      return data.rows ?? [];
    },
    async ga4(property, startDate, endDate) {
      const url = `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`;
      const data = (await postJson(url, await bearer(), {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'landingPage' }],
        metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
        dimensionFilter: {
          filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } },
        },
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: TABLE_ROWS,
      })) as { rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] };

      return (data.rows ?? []).map((row) => ({
        page: row.dimensionValues[0]?.value ?? '',
        sessions: Number(row.metricValues[0]?.value ?? 0),
        engaged: Number(row.metricValues[1]?.value ?? 0),
        keyEvents: Number(row.metricValues[2]?.value ?? 0),
      }));
    },
  };
}

/** The OAuth JWT-bearer grant, signed locally so no Google SDK is needed. */
async function accessToken(key: ServiceAccountKey): Promise<string> {
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const issued = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: key.client_email,
    scope: SCOPES.join(' '),
    aud: tokenUri,
    iat: issued,
    exp: issued + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = (await response.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(`Google token request failed (${response.status}): ${data.error_description ?? data.error ?? 'no token'}`);
  }
  return data.access_token;
}

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}: ${data.error?.message ?? 'no detail'}`);
  return data;
}

/** A page URL as a site path, which is how the inventory and the research doc name pages. */
const path = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

const cell = (value: string | undefined): string => (value ?? '').replaceAll('|', '\\|');
const pct = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
