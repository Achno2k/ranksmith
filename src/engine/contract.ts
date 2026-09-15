import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What a Phase must leave behind for its work to count as done. The Engine judges a
 * Phase against this alone — an agent's claim that it finished is not evidence.
 */
export interface PhaseContract {
  files: FileRequirement[];
}

export type FileRequirement = MarkdownRequirement | JsonRequirement | CsvRequirement;

export interface MarkdownRequirement {
  path: string;
  kind: 'markdown';
  /** Section titles the artifact must contain, at any heading level. */
  headings: string[];
  /**
   * Headings whose section must hold at least one table row (a line starting with `|`).
   * A section runs from its heading to the next heading of the same or higher level.
   */
  tables?: string[];
}

export interface JsonRequirement {
  path: string;
  kind: 'json';
  /** Top-level keys that must be present and non-empty. */
  fields: string[];
  /** Top-level keys that must be non-empty arrays. */
  arrays?: string[];
  /**
   * Top-level keys whose string value must match a pattern. Kept as regex source text so
   * the requirement can be serialised; compiled at check time.
   */
  patterns?: Record<string, RegExp | string>;
}

export interface CsvRequirement {
  path: string;
  kind: 'csv';
  /** Header columns that must be present. The file must also hold at least one data row. */
  columns: string[];
  /** Columns every data row must fill with a value starting with `http://` or `https://`. */
  urlColumns?: string[];
}

export type ContractResult = { ok: true; gaps?: undefined } | { ok: false; gaps: string[] };

const HEADING = /^(#{1,6})\s+(.*)$/;

export async function validateContract(dir: string, contract: PhaseContract): Promise<ContractResult> {
  const gaps: string[] = [];

  for (const requirement of contract.files) {
    gaps.push(...(await inspect(dir, requirement)));
  }

  return gaps.length === 0 ? { ok: true } : { ok: false, gaps };
}

async function inspect(dir: string, requirement: FileRequirement): Promise<string[]> {
  const gap = (message: string) => `${requirement.path}: ${message}`;

  let contents: string;
  try {
    contents = await readFile(join(dir, requirement.path), 'utf8');
  } catch {
    return [gap('file not written')];
  }

  if (contents.trim() === '') return [gap('file is empty')];

  switch (requirement.kind) {
    case 'markdown':
      return markdownGaps(contents, requirement, gap);
    case 'json':
      return jsonGaps(contents, requirement, gap);
    case 'csv':
      return csvGaps(contents, requirement, gap);
  }
}

/**
 * Splits one CSV line the RFC 4180 way: commas inside double quotes do not split, and a
 * doubled quote inside a quoted cell is a literal quote. Still line-based on purpose: a
 * quoted cell that spans lines is not worth handling for a file humans open in a sheet.
 */
export function splitCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }

  cells.push(cell);
  return cells;
}

const isUrl = (value: string): boolean => /^https?:\/\//.test(value);

function csvGaps(contents: string, requirement: CsvRequirement, gap: (message: string) => string): string[] {
  // Row numbers are file line numbers, so a gap points at a line the agent can open.
  const lines = contents
    .split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() !== '');
  const [head, ...rows] = lines;
  const header = splitCsvRow(head?.text ?? '').map((cell) => cell.trim().toLowerCase());
  const gaps = requirement.columns
    .filter((column) => !header.includes(column.toLowerCase()))
    .map((column) => gap(`missing column "${column}"`));

  if (rows.length === 0) gaps.push(gap('no rows below the header'));

  for (const column of requirement.urlColumns ?? []) {
    const index = header.indexOf(column.toLowerCase());
    if (index === -1) continue; // already reported as missing, or never required

    for (const row of rows) {
      const value = (splitCsvRow(row.text)[index] ?? '').trim();
      if (!isUrl(value)) {
        gaps.push(gap(`row ${row.line}: "${column}" must start with http:// or https:// (got "${value}")`));
      }
    }
  }

  return gaps;
}

interface Section {
  title: string;
  level: number;
  body: string[];
}

function sections(contents: string): Section[] {
  const found: Section[] = [];
  let open: Section | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const match = HEADING.exec(line);
    if (match) {
      open = { title: match[2]!.trim().toLowerCase(), level: match[1]!.length, body: [] };
      found.push(open);
    } else if (open) {
      open.body.push(line);
    }
  }

  return found;
}

/** The lines under a heading until the next heading of the same or higher level. */
function sectionBody(all: Section[], title: string): string[] | null {
  const start = all.findIndex((section) => section.title === title.toLowerCase());
  if (start === -1) return null;

  const level = all[start]!.level;
  const body = [...all[start]!.body];
  for (const section of all.slice(start + 1)) {
    if (section.level <= level) break;
    body.push(...section.body);
  }
  return body;
}

function markdownGaps(
  contents: string,
  requirement: MarkdownRequirement,
  gap: (message: string) => string,
): string[] {
  const all = sections(contents);
  const present = new Set(all.map((section) => section.title));
  const missing = requirement.headings.filter((heading) => !present.has(heading.toLowerCase()));
  const gaps = missing.map((heading) => gap(`missing heading "${heading}"`));

  for (const heading of requirement.tables ?? []) {
    const body = sectionBody(all, heading);
    if (body === null) {
      if (!missing.includes(heading)) gaps.push(gap(`missing heading "${heading}"`));
    } else if (!body.some((line) => line.trimStart().startsWith('|'))) {
      gaps.push(gap(`section "${heading}" has no table row`));
    }
  }

  return gaps;
}

function jsonGaps(contents: string, requirement: JsonRequirement, gap: (message: string) => string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    return [gap(`not valid json (${(error as Error).message})`)];
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [gap('not valid json (expected an object)')];
  }

  const record = parsed as Record<string, unknown>;
  const gaps: string[] = [];
  const reported = new Set<string>();
  const missing = (field: string) => {
    if (reported.has(field)) return;
    reported.add(field);
    gaps.push(gap(`missing field "${field}"`));
  };

  for (const field of requirement.fields) {
    if (isBlank(record[field])) missing(field);
  }

  for (const field of requirement.arrays ?? []) {
    const value = record[field];
    if (isBlank(value)) missing(field);
    else if (!Array.isArray(value) || value.length === 0) gaps.push(gap(`field "${field}" must be a non-empty array`));
  }

  for (const [field, pattern] of Object.entries(requirement.patterns ?? {})) {
    const value = record[field];
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    if (isBlank(value)) missing(field);
    else if (typeof value !== 'string' || !regex.test(value)) {
      gaps.push(gap(`field "${field}" must match ${regex.source} (got ${JSON.stringify(value)})`));
    }
  }

  return gaps;
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
