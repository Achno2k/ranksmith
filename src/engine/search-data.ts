import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * First-party evidence for research: what the site already ranks for (Search Console), which
 * organic landing pages convert (PostHog), and GA4 organic landing pages. The Engine fetches it
 * before the agent starts, so research never depends on an MCP being authenticated on the host.
 */
export interface SearchDataConfig {
  /** Search Console property, e.g. `sc-domain:connectmachine.ai` or `https://www.connectmachine.ai/`. */
  gscSite?: string;
  /** GA4 property id, digits only. */
  ga4Property?: string;
  /** The PostHog project the live site reports to, and which of its events count as a conversion. */
  posthog?: PosthogConfig;
}

export interface PosthogConfig {
  host: string;
  projectId: number;
  conversionEvents: string[];
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

/** Below this many organic sessions a conversion rate is noise, not evidence. */
const MIN_SESSIONS = 10;
/** A page this visible in search that never converts is a trap, not an opportunity. */
const TRAP_IMPRESSIONS = 200;

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

export interface ConversionRow {
  /** Site path the organic session landed on. */
  page: string;
  sessions: number;
  converting: number;
  firstSeen: string;
}

/** Where the fetch functions reach Google. Swapped out in tests. */
export interface SearchDataSource {
  gsc(site: string, body: Record<string, unknown>): Promise<GscRow[]>;
  ga4(property: string, start: string, end: string): Promise<Ga4Row[]>;
}

/** Where the fetch functions reach PostHog. Swapped out in tests. */
export interface ConversionSource {
  conversions(config: PosthogConfig, start: string): Promise<ConversionRow[]>;
}

export interface Sources {
  google: SearchDataSource | Error;
  posthog: ConversionSource | Error;
}

type Fetched<T> = { rows: T } | { error: string };

const day = (date: Date, minusDays: number): string =>
  new Date(date.getTime() - minusDays * 86_400_000).toISOString().slice(0, 10);

/**
 * Builds the markdown the research agent reads. Each source fails on its own and says why
 * in its section: missing data is a finding for the report, never a reason to fail the Job.
 */
export async function renderSearchData(
  config: SearchDataConfig | undefined,
  sources: Sources,
  now = new Date(),
): Promise<string> {
  const end = day(now, LAG_DAYS);
  const start = day(now, LAG_DAYS + WINDOW_DAYS - 1);

  const [gsc, conversions, ga4] = await Promise.all([
    fetchGsc(config?.gscSite, sources.google, start, end),
    fetchConversions(config?.posthog, sources.posthog, start),
    fetchGa4(config?.ga4Property, sources.google, start, end),
  ]);

  return [
    '# First-party search data',
    '',
    `Fetched by the Engine on ${now.toISOString().slice(0, 10)}. Search Console window: ${start} to ${end} (${WINDOW_DAYS} days).`,
    'Positions are Search Console averages. Clicks and sessions are totals for the window.',
    '',
    ...moneyPages(config?.posthog, gsc, conversions),
    ...gscSections(gsc),
    ...ga4Section(ga4),
  ].join('\n');
}

async function fetchGsc(
  site: string | undefined,
  source: SearchDataSource | Error,
  start: string,
  end: string,
): Promise<Fetched<{ pairs: GscRow[]; pages: GscRow[] }>> {
  if (!site) return { error: 'no `searchData.gscSite` in the Site Profile.' };
  if (source instanceof Error) return { error: source.message };

  try {
    const [pairs, pages] = await Promise.all([
      source.gsc(site, { startDate: start, endDate: end, dimensions: ['query', 'page'], rowLimit: 1000 }),
      source.gsc(site, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 250 }),
    ]);
    return { rows: { pairs, pages } };
  } catch (error) {
    return { error: message(error) };
  }
}

async function fetchConversions(
  config: PosthogConfig | undefined,
  source: ConversionSource | Error,
  start: string,
): Promise<Fetched<ConversionRow[]>> {
  if (!config) return { error: 'no `searchData.posthog` in the Site Profile.' };
  if (source instanceof Error) return { error: source.message };

  try {
    return { rows: await source.conversions(config, start) };
  } catch (error) {
    return { error: message(error) };
  }
}

async function fetchGa4(
  property: string | undefined,
  source: SearchDataSource | Error,
  start: string,
  end: string,
): Promise<Fetched<Ga4Row[]>> {
  if (!property) return { error: 'no `searchData.ga4Property` in the Site Profile.' };
  if (source instanceof Error) return { error: source.message };

  try {
    return { rows: await source.ga4(property, start, end) };
  } catch (error) {
    return { error: message(error) };
  }
}

/**
 * The page worth the week is one that already converts and already ranks, just too low to be
 * seen. Search Console pages joined with PostHog conversions by path, each given a verdict the
 * agent can argue with but cannot miss.
 */
function moneyPages(
  config: PosthogConfig | undefined,
  gsc: Fetched<{ pairs: GscRow[]; pages: GscRow[] }>,
  conversions: Fetched<ConversionRow[]>,
): string[] {
  const heading = ['## Money pages: search joined with conversions', ''];
  if ('error' in conversions) return [...heading, `Unavailable: PostHog: ${conversions.error}`, ''];
  if ('error' in gsc) return [...heading, `Unavailable: Search Console: ${gsc.error}`, ''];

  const search = new Map(gsc.rows.pages.map((row) => [path(row.keys[0]), row]));
  const converted = new Map(conversions.rows.map((row) => [row.page, row]));
  const since = conversions.rows.map((row) => row.firstSeen).sort()[0]?.slice(0, 10) ?? 'no data';

  const rows = [...new Set([...search.keys(), ...converted.keys()])].map((page) => {
    const s = search.get(page);
    const c = converted.get(page);
    return { page, s, c, verdict: verdict(s, c) };
  });

  const rank = (verdict: string) => (verdict.startsWith('money') ? 0 : verdict.startsWith('trap') ? 1 : 2);
  const shown = rows
    .filter((row) => row.verdict !== '')
    .sort((a, b) => rank(a.verdict) - rank(b.verdict) || (b.s?.impressions ?? 0) - (a.s?.impressions ?? 0))
    .slice(0, TABLE_ROWS);

  return [
    ...heading,
    `A conversion is an organic session that fired any of: ${config?.conversionEvents.map((event) => `\`${event}\``).join(', ')}.`,
    `PostHog conversion data starts ${since}; judge rates on few sessions with care.`,
    `- money page: converts and ranks at position ${STRIKING_MIN} to ${STRIKING_MAX}. Better ranking here turns into conversions.`,
    `- trap: ${TRAP_IMPRESSIONS}+ impressions and ${MIN_SESSIONS}+ organic sessions, no conversions. More traffic will not pay; fix the page's next step first or leave it.`,
    `- converts, top 3: already ranks well. Leave it unless there is a strong reason.`,
    `- thin data: fewer than ${MIN_SESSIONS} organic sessions. Not evidence either way.`,
    '',
    ...(shown.length
      ? [
          '| Page | Verdict | Impressions | Clicks | Position | Organic sessions | Converting | Rate |',
          '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
          ...shown.map(
            ({ page, s, c, verdict }) =>
              `| ${cell(page)} | ${verdict} | ${s?.impressions ?? '-'} | ${s?.clicks ?? '-'} | ${s ? s.position.toFixed(1) : '-'} | ${c?.sessions ?? 0} | ${c?.converting ?? 0} | ${c?.sessions ? pct(c.converting / c.sessions) : '-'} |`,
          ),
        ]
      : ['No rows.']),
    '',
  ];
}

function verdict(search: GscRow | undefined, conversions: ConversionRow | undefined): string {
  const sessions = conversions?.sessions ?? 0;
  const converting = conversions?.converting ?? 0;
  const position = search?.position;

  if (converting > 0 && position !== undefined && position >= STRIKING_MIN && position <= STRIKING_MAX) {
    return sessions < MIN_SESSIONS ? 'money page (thin data)' : 'money page';
  }
  if (converting === 0 && sessions >= MIN_SESSIONS && (search?.impressions ?? 0) >= TRAP_IMPRESSIONS) return 'trap';
  if (converting > 0 && position !== undefined && position < STRIKING_MIN) return 'converts, top 3';
  if (sessions > 0 && sessions < MIN_SESSIONS) return 'thin data';
  return '';
}

function gscSections(gsc: Fetched<{ pairs: GscRow[]; pages: GscRow[] }>): string[] {
  if ('error' in gsc) return ['## Search Console', '', `Unavailable: ${gsc.error}`, ''];
  const { pairs, pages } = gsc.rows;

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
}

function ga4Section(ga4: Fetched<Ga4Row[]>): string[] {
  const heading = ['## GA4: organic landing pages', ''];
  if ('error' in ga4) return [...heading, `Unavailable: ${ga4.error}`, ''];
  if (ga4.rows.length === 0) return [...heading, 'No rows.', ''];
  return [
    ...heading,
    'Sessions from Organic Search only. Key events are the conversions configured in GA4.',
    '',
    '| Landing page | Sessions | Engaged sessions | Key events |',
    '| --- | ---: | ---: | ---: |',
    ...ga4.rows.map((row) => `| ${cell(row.page)} | ${row.sessions} | ${row.engaged} | ${row.keyEvents} |`),
    '',
  ];
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
  const data = (await response.json().catch(() => ({}))) as { error?: { message?: string }; detail?: string };
  const detail = data.error?.message ?? data.detail ?? 'no detail';
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}: ${detail}`);
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

/** Event names go into HogQL as literals, so only plain identifiers are accepted. */
const EVENT_NAME = /^[\w$.:-]+$/;

/**
 * Organic sessions and converting sessions per landing page, from PostHog's query API with a
 * personal API key (scope: query:read). An Error instead of a source when the key is missing.
 */
export function posthogSource(apiKey = process.env['POSTHOG_PERSONAL_API_KEY']): ConversionSource | Error {
  if (!apiKey) return new Error('POSTHOG_PERSONAL_API_KEY is not set on the Engine host.');

  return {
    async conversions({ host, projectId, conversionEvents }, start) {
      const bad = conversionEvents.filter((event) => !EVENT_NAME.test(event));
      if (bad.length > 0 || conversionEvents.length === 0) {
        throw new Error(`conversion event names must be plain identifiers (got ${JSON.stringify(conversionEvents)})`);
      }
      const events = conversionEvents.map((event) => `'${event}'`).join(', ');
      const query = `
        SELECT session.$entry_pathname AS page,
          uniqIf($session_id, event = '$pageview') AS sessions,
          uniqIf($session_id, event IN (${events})) AS converting,
          min(timestamp) AS first_seen
        FROM events
        WHERE timestamp >= toDateTime('${start} 00:00:00')
          AND session.$channel_type = 'Organic Search'
        GROUP BY page
        ORDER BY sessions DESC
        LIMIT 500`;

      const data = (await postJson(`${host.replace(/\/$/, '')}/api/projects/${projectId}/query/`, apiKey, {
        query: { kind: 'HogQLQuery', query },
      })) as { results?: [string | null, number, number, string][] };

      return (data.results ?? [])
        .filter(([page]) => typeof page === 'string' && page !== '')
        .map(([page, sessions, converting, firstSeen]) => ({ page: page!, sessions, converting, firstSeen }));
    },
  };
}
