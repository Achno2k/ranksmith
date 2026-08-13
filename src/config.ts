import type { SlackConfig } from './slack/app.ts';

export interface Config {
  slack: SlackConfig;
  profileId: string;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
};

export function loadConfig(): Config {
  return {
    profileId: process.env['RANKSMITH_PROFILE'] ?? 'connectmachine',
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
