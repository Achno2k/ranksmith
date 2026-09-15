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

/** `force` is only for branches RankSmith alone writes, where a rerun rebuilds the same commit. */
export async function push(
  profile: SiteProfile,
  workspace: string,
  branch: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  await run('git', ['push', ...(force ? ['--force'] : []), '-u', profile.repo.pushRemote, branch], {
    cwd: workspace,
  });
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
 * `gh pr list --head` matches the bare branch name only. An `owner:branch` ref matches
 * nothing, which sent every content revision to open a second pull request and fail. The
 * owner is checked here instead, so a same-named branch on another fork is never ours.
 */
export async function findPullRequest(profile: SiteProfile, head: string): Promise<number | null> {
  const separator = head.indexOf(':');
  const owner = separator === -1 ? null : head.slice(0, separator);
  const branch = head.slice(separator + 1);

  const { exitCode, stdout } = await tryRun('gh', [
    'pr',
    'list',
    '--repo',
    profile.repo.pullRequestRepo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,headRepositoryOwner',
  ]);
  if (exitCode !== 0) return null;

  const pulls = JSON.parse(stdout) as { number: number; headRepositoryOwner: { login: string } | null }[];
  return pulls.find((pull) => owner === null || pull.headRepositoryOwner?.login === owner)?.number ?? null;
}

/**
 * Queues the merge behind CI rather than merging now, so a red build can never land.
 * Merging reaches staging only — production is tag-driven and stays human-only.
 */
export async function enableAutoMerge(profile: SiteProfile, number: number): Promise<void> {
  await run('gh', ['pr', 'merge', String(number), '--repo', profile.repo.pullRequestRepo, '--auto', '--squash']);
}

export async function closePullRequest(
  profile: SiteProfile,
  number: number,
  comment = 'Rejected during RankSmith review.',
): Promise<void> {
  await tryRun('gh', [
    'pr',
    'close',
    String(number),
    '--repo',
    profile.repo.pullRequestRepo,
    '--delete-branch',
    '--comment',
    comment,
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

export interface PullRequestInfo {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  title: string;
  /** The commit the pull request landed as on the base branch, or null if it never merged. */
  mergeCommit: string | null;
}

export async function pullRequestInfo(profile: SiteProfile, number: number): Promise<PullRequestInfo> {
  const { stdout } = await run('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    profile.repo.pullRequestRepo,
    '--json',
    'state,url,title,mergeCommit',
  ]);
  const raw = JSON.parse(stdout) as Omit<PullRequestInfo, 'mergeCommit'> & { mergeCommit: { oid: string } | null };

  return { state: raw.state, url: raw.url, title: raw.title, mergeCommit: raw.mergeCommit?.oid ?? null };
}

/** One line per workflow run on a commit, which is where staging deploys show up. Empty if gh cannot tell. */
export async function deployRuns(profile: SiteProfile, sha: string): Promise<string> {
  const { exitCode, stdout } = await tryRun('gh', [
    'run',
    'list',
    '--repo',
    profile.repo.pullRequestRepo,
    '--commit',
    sha,
    '--json',
    'name,status,conclusion,createdAt,url',
    '--jq',
    '.[] | "\\(.name): \\(.status) \\(.conclusion) \\(.createdAt) \\(.url)"',
  ]);
  return exitCode === 0 ? stdout.trim() : '';
}

/**
 * Undoes a merged pull request with a new commit. Pull requests land squashed, so the merge
 * commit has one parent and needs no `-m`. A conflict is aborted and reported, never forced.
 */
export async function revertCommit(workspace: string, sha: string): Promise<void> {
  const result = await tryRun('git', ['revert', '--no-edit', sha], { cwd: workspace });
  if (result.exitCode === 0) return;

  const { stdout } = await tryRun('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: workspace });
  await tryRun('git', ['revert', '--abort'], { cwd: workspace });
  throw new Error(`git revert ${sha} did not apply cleanly. Conflicts:\n${stdout.trim() || result.stderr.trim()}`);
}
