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

export const databasePath = (): string => join(ranksmithHome(), 'ranksmith.db');

export const workspacePath = (jobId: string): string => join(ranksmithHome(), 'work', jobId);

export const jobDir = (jobId: string): string => join(ranksmithHome(), 'jobs', jobId);

export const logPath = (jobId: string, phase: string, attempt: number): string =>
  join(jobDir(jobId), 'logs', `${phase}-${attempt}.log`);

export const attachmentsDir = (jobId: string): string => join(jobDir(jobId), 'attachments');

export const workspaceAttachmentsDir = (workspace: string): string =>
  join(workspace, '.ranksmith', 'attachments');
