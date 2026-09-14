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
}

export interface JsonRequirement {
  path: string;
  kind: 'json';
  /** Top-level keys that must be present and non-empty. */
  fields: string[];
}

export interface CsvRequirement {
  path: string;
  kind: 'csv';
  /** Header columns that must be present. The file must also hold at least one data row. */
  columns: string[];
}

export type ContractResult = { ok: true; gaps?: undefined } | { ok: false; gaps: string[] };

const HEADING = /^#{1,6}\s+(.*)$/gm;

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
      return missingHeadings(contents, requirement.headings).map((heading) => gap(`missing heading "${heading}"`));
    case 'json':
      return missingFields(contents, requirement.fields, gap);
    case 'csv':
      return csvGaps(contents, requirement.columns, gap);
  }
}

/**
 * Header and row count only. Parsing quoted cells properly is not worth it here: the
 * report is what humans review, and the CSV just has to be usable in a spreadsheet.
 */
function csvGaps(contents: string, required: string[], gap: (message: string) => string): string[] {
  const lines = contents.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines[0] ?? '').split(',').map((cell) => cell.trim().replace(/^"|"$/g, '').toLowerCase());
  const gaps = required
    .filter((column) => !header.includes(column.toLowerCase()))
    .map((column) => gap(`missing column "${column}"`));

  if (lines.length < 2) gaps.push(gap('no rows below the header'));
  return gaps;
}

function missingHeadings(contents: string, required: string[]): string[] {
  const present = new Set([...contents.matchAll(HEADING)].map(([, title]) => title!.trim().toLowerCase()));
  return required.filter((heading) => !present.has(heading.toLowerCase()));
}

function missingFields(contents: string, required: string[], gap: (message: string) => string): string[] {
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
  return required.filter((field) => isBlank(record[field])).map((field) => gap(`missing field "${field}"`));
}

const isBlank = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
