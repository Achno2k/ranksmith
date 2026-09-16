import type { CloudflareCredentials } from './engine/preview.ts';
import type { SlackConfig } from './slack/app.ts';

export interface Config {
  slack: SlackConfig;
  profileId: string;
  /**
   * Read when a preview is deployed, not at boot: a host without the variables still runs
   * Slack, marketing scans and research, and only the deploy step fails, naming them.
   */
  cloudflare: () => CloudflareCredentials;
}

/** True when both variables are present, so boot can warn once instead of dying. */
export const hasCloudflareCredentials = (): boolean =>
  Boolean(process.env['CLOUDFLARE_API_TOKEN'] && process.env['CLOUDFLARE_ACCOUNT_ID']);

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

/**
 * Read on its own so the CLI can run a marketing scan without them and only fail when a
 * preview deploy is actually attempted.
 */
export function loadCloudflareCredentials(): CloudflareCredentials {
  const apiToken = process.env['CLOUDFLARE_API_TOKEN'];
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
  if (!apiToken || !accountId) {
    throw new Error('A preview deploy needs CLOUDFLARE_API_TOKEN (Pages: Edit) and CLOUDFLARE_ACCOUNT_ID in the environment.');
  }
  return { apiToken, accountId };
}

export function loadConfig(): Config {
  return {
    profileId: process.env['RANKSMITH_PROFILE'] ?? 'connectmachine',
    cloudflare: loadCloudflareCredentials,
    slack: {
      appToken: required('SLACK_APP_TOKEN'),
      botToken: required('SLACK_BOT_TOKEN'),
      approvers: (process.env['SLACK_APPROVER_IDS'] ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    },
  };
}
