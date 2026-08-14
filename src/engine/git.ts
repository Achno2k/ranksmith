import { run, tryRun } from './exec.ts';
import type { SiteProfile } from './profile.ts';

export async function hasChanges(workspace: string): Promise<boolean> {
  const { stdout } = await run('git', ['status', '--porcelain'], { cwd: workspace });
  return stdout.trim() !== '';
}

export async function commitAll(workspace: string, message: string): Promise<void> {
  await run('git', ['add', '-A'], { cwd: workspace });
  await run('git', ['commit', '-m', message], { cwd: workspace });
}

export async function push(profile: SiteProfile, workspace: string, branch: string): Promise<void> {
  await run('git', ['push', '-u', profile.repo.pushRemote, branch], { cwd: workspace });
}

const PR_NUMBER_IN_URL = /\/pull\/(\d+)/;
const REMOTE_OWNER = /[:/]([^/:]+)\/[^/]+?(?:\.git)?$/;

/**
 * How GitHub must be told to find the branch. Work is pushed to a fork, so an unqualified
 * branch name makes GitHub look for it in the upstream repository, where it does not
 * exist. Cross-repository pull requests need `owner:branch`.
 */
export async function headRef(profile: SiteProfile, workspace: string, branch: string): Promise<string> {
  const { stdout } = await run('git', ['remote', 'get-url', profile.repo.pushRemote], { cwd: workspace });
  const owner = stdout.trim().match(REMOTE_OWNER)?.[1];
  const upstreamOwner = profile.repo.pullRequestRepo.split('/')[0];

  return !owner || owner === upstreamOwner ? branch : `${owner}:${branch}`;
}

/** Opens a PR for this branch, or returns the number of the one already open for it. */
export async function openPullRequest(
  profile: SiteProfile,
  workspace: string,
  branch: string,
  title: string,
  body: string,
): Promise<number> {
  const head = await headRef(profile, workspace, branch);

  const existing = await findPullRequest(profile, head);
  if (existing !== null) return existing;

  const { stdout } = await run(
    'gh',
    [
      'pr',
      'create',
      '--repo',
      profile.repo.pullRequestRepo,
      '--base',
      profile.repo.baseBranch,
      '--head',
      head,
      '--title',
      title,
      '--body',
      body,
    ],
    { cwd: workspace },
  );

  const number = Number(stdout.match(PR_NUMBER_IN_URL)?.[1]);
  if (Number.isInteger(number) && number > 0) return number;

  const created = await findPullRequest(profile, head);
  if (created === null) throw new Error(`Opened a pull request for ${head} but could not read its number back`);
  return created;
}

/**
 * `gh pr view` refuses to work with `--repo` and no explicit selector, so the head ref is
 * always passed explicitly.
 */
export async function findPullRequest(profile: SiteProfile, head: string): Promise<number | null> {
  const { exitCode, stdout } = await tryRun('gh', [
    'pr',
    'list',
    '--repo',
    profile.repo.pullRequestRepo,
    '--head',
    head,
    '--state',
    'open',
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ]);

  if (exitCode !== 0) return null;
  const number = Number(stdout.trim());
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Queues the merge behind CI rather than merging now, so a red build can never land.
 * Merging reaches staging only — production is tag-driven and stays human-only.
 */
export async function enableAutoMerge(profile: SiteProfile, number: number): Promise<void> {
  await run('gh', ['pr', 'merge', String(number), '--repo', profile.repo.pullRequestRepo, '--auto', '--squash']);
}

export async function closePullRequest(profile: SiteProfile, number: number): Promise<void> {
  await tryRun('gh', [
    'pr',
    'close',
    String(number),
    '--repo',
    profile.repo.pullRequestRepo,
    '--delete-branch',
    '--comment',
    'Rejected during RankSmith review.',
  ]);
}

export async function pullRequestUrl(profile: SiteProfile, number: number): Promise<string> {
  const { stdout } = await run('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    profile.repo.pullRequestRepo,
    '--json',
    'url',
    '--jq',
    '.url',
  ]);
  return stdout.trim();
}
