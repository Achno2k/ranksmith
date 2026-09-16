import { mkdir } from 'node:fs/promises';
import { hasCloudflareCredentials, loadConfig } from './config.ts';
import { Engine } from './engine/engine.ts';
import { JobStore } from './engine/jobs.ts';
import { loadProfile, verifySkillLinks } from './engine/load-profile.ts';
import { databasePath, ranksmithHome } from './engine/paths.ts';
import { createNotifier, createSlackApp, registerHandlers } from './slack/app.ts';

const config = loadConfig();

await mkdir(ranksmithHome(), { recursive: true });

const profile = await loadProfile(config.profileId);
await verifySkillLinks(config.profileId);

const jobs = new JobStore(databasePath());
const app = createSlackApp(config.slack);
const notifier = createNotifier(app);
const engine = new Engine(jobs, profile, notifier, config.cloudflare);
if (!hasCloudflareCredentials()) {
  console.warn('CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID is not set: seo Jobs will fail at the preview deploy until they are.');
}

registerHandlers(app, engine, jobs, config.slack, notifier);

await app.start();
console.log(`RankSmith is listening. Profile: ${profile.id}. Repo: ${profile.repo.path}`);

const resumed = engine.resume();
if (resumed.length > 0) console.log(`Resumed ${resumed.length} job(s): ${resumed.join(', ')}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;

    void engine
      .shutdown()
      .catch((error: unknown) => console.error('Shutdown was not clean:', error))
      .finally(() => {
        jobs.close();
        process.exit(0);
      });
  });
}
