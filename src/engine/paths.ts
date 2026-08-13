import { homedir } from 'node:os';
import { join } from 'node:path';

export const ranksmithHome = (): string => process.env['RANKSMITH_HOME'] ?? join(homedir(), '.ranksmith');

export const databasePath = (): string => join(ranksmithHome(), 'ranksmith.db');

export const workspacePath = (jobId: string): string => join(ranksmithHome(), 'work', jobId);

export const jobDir = (jobId: string): string => join(ranksmithHome(), 'jobs', jobId);

export const logPath = (jobId: string, phase: string, attempt: number): string =>
  join(jobDir(jobId), 'logs', `${phase}-${attempt}.log`);
