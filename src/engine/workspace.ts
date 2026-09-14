import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { run, tryRun, words } from './exec.ts';
import { workspacePath } from './paths.ts';
import { baseRef, type SiteProfile } from './profile.ts';
import { RESULT_PATH } from './phases.ts';

export const branchFor = (profile: SiteProfile, jobId: string, slug: string): string =>
  `${profile.repo.branchPrefix}${slug || jobId.toLowerCase()}`;

/**
 * Cuts a fresh worktree for a Job from the profile's base ref. The human's own checkout
 * is never touched — it is usually dirty and on an unrelated branch.
 */
export async function createWorkspace(
  profile: SiteProfile,
  jobId: string,
  branch: string,
  { install = true }: { install?: boolean } = {},
): Promise<string> {
  const dir = workspacePath(jobId);
  const repo = profile.repo.path;

  // Clears a stale branch of the same name too, or `worktree add -b` would refuse.
  await removeWorkspace(profile, jobId, branch);
  await mkdir(dirname(dir), { recursive: true });

  await run('git', ['fetch', profile.repo.baseRemote, '--prune'], { cwd: repo });
  await run('git', ['worktree', 'add', '-b', branch, dir, baseRef(profile)], { cwd: repo });
  await hideRunnerArtifacts(dir);

  // A revert only needs git, and a full install takes minutes.
  if (install) {
    const [command, args] = words(profile.commands.install);
    await run(command, args, { cwd: dir, timeoutMs: 15 * 60_000 });
  }

  return dir;
}

/**
 * A plain directory for a Job that never touches the site: no worktree, no branch, no
 * install. Lives at the same path as a worktree would, so teardown is the same code.
 */
export async function createScratchWorkspace(jobId: string): Promise<string> {
  const dir = workspacePath(jobId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, RESULT_PATH, '..'), { recursive: true });
  return dir;
}

/**
 * Keeps the runner's own scratch directory out of the website's history. Agents commit
 * with `git add -A`, so without this the result file would ship in the pull request.
 */
async function hideRunnerArtifacts(dir: string): Promise<void> {
  const scratch = join(dir, RESULT_PATH, '..');
  await mkdir(scratch, { recursive: true });
  await writeFile(join(scratch, '.gitignore'), '*\n');
}

/**
 * Removes a Job's worktree and, when known, the local branch that went with it. Safe to
 * call when either is already gone. Removing a worktree does not delete its branch, so
 * without this every finished Job would leave one behind in the human's checkout.
 */
export async function removeWorkspace(
  profile: SiteProfile,
  jobId: string,
  branch?: string | null,
): Promise<void> {
  const dir = workspacePath(jobId);
  await tryRun('git', ['worktree', 'remove', '--force', dir], { cwd: profile.repo.path });
  await rm(dir, { recursive: true, force: true });
  await tryRun('git', ['worktree', 'prune'], { cwd: profile.repo.path });

  if (branch) await tryRun('git', ['branch', '-D', branch], { cwd: profile.repo.path });
}
