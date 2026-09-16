import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ranksmithHome = (): string => process.env['RANKSMITH_HOME'] ?? join(homedir(), '.ranksmith');

const repoRoot = (): string => fileURLToPath(new URL('../..', import.meta.url));

/**
 * A copy of a Job's report, dropped inside this repo purely so it can be read in an
 * editor without digging into a worktree. Git-ignored, and read-only in practice: the
 * agent's copy in the Workspace is the one that ships. Temporary — when this runs for
 * real, research should be reviewed from the pull request instead.
 */
export const reviewDocPath = (jobId: string, date: string, name = 'research.md'): string =>
  join(repoRoot(), 'research', `${jobId}-${date}-${name}`);

/** This repo's own wrangler, pinned in package.json. The website worktree does not carry one. */
export const wranglerPath = (): string => join(repoRoot(), 'node_modules', '.bin', 'wrangler');

export const databasePath = (): string => join(ranksmithHome(), 'ranksmith.db');

export const workspacePath = (jobId: string): string => join(ranksmithHome(), 'work', jobId);

/** One warm node_modules per lockfile, cloned into each new worktree instead of installed. */
export const nodeModulesCachePath = (lockfileHash: string): string =>
  join(ranksmithHome(), 'cache', `node_modules-${lockfileHash}`);

export const jobDir = (jobId: string): string => join(ranksmithHome(), 'jobs', jobId);

export const logPath = (jobId: string, phase: string, attempt: number): string =>
  join(jobDir(jobId), 'logs', `${phase}-${attempt}.log`);

export const attachmentsDir = (jobId: string): string => join(jobDir(jobId), 'attachments');

export const workspaceAttachmentsDir = (workspace: string): string =>
  join(workspace, '.ranksmith', 'attachments');
