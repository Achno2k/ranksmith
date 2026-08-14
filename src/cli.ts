import { mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Engine, type Notifier } from './engine/engine.ts';
import { JobStore, type Job } from './engine/jobs.ts';
import { loadProfile, verifySkillLinks } from './engine/load-profile.ts';
import { databasePath, jobDir, ranksmithHome, reviewDocPath, workspacePath } from './engine/paths.ts';

const USAGE = `RankSmith without Slack. State is shared with the Slack runner.

  npm run job -- start [topic]     start a job; empty topic means discovery
  npm run job -- approve <id>      approve at the job's current gate
  npm run job -- feedback <id> "…" send the job back for a revision
  npm run job -- retry <id>        re-run a failed job from where it died
  npm run job -- reject <id>       reject and clean up
  npm run job -- status [id]       show live jobs, or one job's history
`;

const stamp = () => new Date().toLocaleTimeString();
const say = (line: string) => console.log(`${stamp()}  ${line}`);

/** The Slack notifier's counterpart. Same Engine, same code path, different audience. */
const consoleNotifier: Notifier = {
  jobStarted: async (job) => {
    say(`${job.id} started — ${job.topic ? `topic: ${job.topic}` : 'discovery mode'}`);
    return 'cli';
  },
  working: async (job, note) => say(`${job.id} ${note}`),
  researchReady: async (job, result) => {
    say(`${job.id} RESEARCH READY`);
    console.log(`
  decision : ${String(result['decision'] ?? '—')}
  keyword  : ${String(result['primary_keyword'] ?? '—')}
  type     : ${String(result['page_type'] ?? '—')}
  slug     : ${String(result['slug'] ?? '—')}
  review   : ${relative(process.cwd(), reviewDocPath(job.id, job.date))}
  in branch: ${join(workspacePath(job.id), 'docs/seo-content', `${job.date}-research.md`)}
  budget   : ${JSON.stringify(result['budget_used'] ?? {})}

  next: npm run job -- approve ${job.id}
        npm run job -- feedback ${job.id} "what to change"
`);
  },
  contentReady: async (job, prUrl) => {
    say(`${job.id} CONTENT READY`);
    console.log(`
  preview : ${job.previewUrl ?? '—'}
  pull req: ${prUrl}

  next: npm run job -- approve ${job.id}
`);
  },
  merging: async (job, prUrl) => say(`${job.id} approved — auto-merge queued behind CI: ${prUrl}`),
  rejected: async (job) => say(`${job.id} rejected; workspace removed`),
  failed: async (job, reason) => {
    say(`${job.id} FAILED`);
    console.log(`\n${reason}\n\n  logs: ${join(jobDir(job.id), 'logs')}\n  workspace kept: ${workspacePath(job.id)}\n`);
  },
};

const describe = (job: Job) =>
  `${job.id}  ${job.state.padEnd(20)} ${job.topic ?? '(discovery)'}${job.pullRequest ? `  PR #${job.pullRequest}` : ''}`;

const [command, ...rest] = process.argv.slice(2);

await mkdir(ranksmithHome(), { recursive: true });
const profile = await loadProfile(process.env['RANKSMITH_PROFILE'] ?? 'connectmachine');
const jobs = new JobStore(databasePath());
const engine = new Engine(jobs, profile, consoleNotifier);

const requireId = (): string => {
  const id = rest[0];
  if (!id) throw new Error('A job id is required.');
  if (!jobs.getJob(id)) throw new Error(`Unknown job ${id}.`);
  return id;
};

try {
  switch (command) {
    case 'start': {
      await verifySkillLinks(profile.id);
      const topic = rest.join(' ').trim();
      await engine.startJob(topic === '' ? null : topic, 'cli');
      await engine.whenIdle();
      break;
    }

    case 'approve': {
      await engine.approve(requireId(), 'cli');
      await engine.whenIdle();
      break;
    }

    case 'feedback': {
      const id = requireId();
      const text = rest.slice(1).join(' ').trim();
      if (text === '') throw new Error('Feedback text is required.');

      const accepted = await engine.feedback(id, 'cli', text);
      if (!accepted) throw new Error(`${id} is not at a gate; it is ${jobs.getJob(id)?.state}.`);
      await engine.whenIdle();
      break;
    }

    case 'retry': {
      await engine.retry(requireId());
      await engine.whenIdle();
      break;
    }

    case 'reject': {
      await engine.reject(requireId(), 'cli', rest.slice(1).join(' ').trim() || null);
      break;
    }

    case 'status': {
      const id = rest[0];
      if (id) {
        const job = jobs.getJob(id);
        if (!job) throw new Error(`Unknown job ${id}.`);
        console.log(describe(job));
        for (const event of jobs.history(job.id)) {
          console.log(`  ${event.type.padEnd(18)} ${event.actor.padEnd(8)} ${event.detail ?? ''}`);
        }
      } else {
        const live = jobs.liveJobs();
        console.log(live.length === 0 ? 'No live jobs.' : live.map(describe).join('\n'));
      }
      break;
    }

    default:
      console.log(USAGE);
  }
} catch (error) {
  console.error(`\n${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  await engine.shutdown();
  jobs.close();
}
