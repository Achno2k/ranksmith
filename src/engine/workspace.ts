import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { run, tryRun, words } from './exec.ts';
import { nodeModulesCachePath, workspacePath } from './paths.ts';
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

  await withCheckoutLock(async () => {
    // Clears a stale branch of the same name too, or `worktree add -b` would refuse.
    await removeWorktree(profile, jobId, branch);
    await mkdir(dirname(dir), { recursive: true });

    await run('git', ['fetch', profile.repo.baseRemote, '--prune'], { cwd: repo });
    await run('git', ['worktree', 'add', '-b', branch, dir, baseRef(profile)], { cwd: repo });
  });
  await hideRunnerArtifacts(dir);

  // A revert only needs git, and a full install takes minutes.
  if (install) await installDependencies(profile, jobId, dir);

  return dir;
}

/**
 * Workspace setup no longer waits in the agent queue, so two Jobs can reach the shared
 * checkout at once. git locks refs and the worktree list per command, and the loser of a
 * race fails outright, so the commands that touch the checkout take turns here instead.
 */
let checkoutLock: Promise<unknown> = Promise.resolve();

function withCheckoutLock<T>(work: () => Promise<T>): Promise<T> {
  const turn = checkoutLock.then(work, work);
  checkoutLock = turn.catch(() => {});
  return turn;
}

const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Installs once per lockfile and clones the result into every later worktree. On APFS a
 * clone is instant and shares blocks; a plain copy is the fallback and still beats `npm ci`.
 */
async function installDependencies(profile: SiteProfile, jobId: string, dir: string): Promise<void> {
  const lockfile = await readFile(join(dir, 'package-lock.json')).catch(() => null);
  const cache = lockfile ? nodeModulesCachePath(createHash('sha256').update(lockfile).digest('hex')) : null;
  const target = join(dir, 'node_modules');

  if (cache && (await exists(cache))) {
    await copyTree(cache, target);
    console.log(`[${jobId}] node_modules cloned from ${cache}`);
    return;
  }

  const [command, args] = words(profile.commands.install);
  await run(command, args, { cwd: dir, timeoutMs: INSTALL_TIMEOUT_MS });
  if (!cache) {
    console.log(`[${jobId}] dependencies installed; no package-lock.json, so nothing was cached`);
    return;
  }

  // Filled beside the final name and renamed in, so a Job starting mid-copy never clones half.
  const staging = `${cache}.tmp-${process.pid}`;
  await mkdir(dirname(cache), { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await copyTree(target, staging);
  if (await exists(cache)) {
    await rm(staging, { recursive: true, force: true });
  } else {
    await rename(staging, cache);
  }
  console.log(`[${jobId}] dependencies installed and cached at ${cache}`);
}

/** `cp -c` asks for an APFS clone; on a filesystem without one it fails and a copy will do. */
async function copyTree(source: string, destination: string): Promise<void> {
  const clone = await tryRun('cp', ['-c', '-R', source, destination], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (clone.exitCode === 0) return;
  await rm(destination, { recursive: true, force: true });
  await run('cp', ['-R', source, destination], { timeoutMs: INSTALL_TIMEOUT_MS });
}

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

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
export function removeWorkspace(profile: SiteProfile, jobId: string, branch?: string | null): Promise<void> {
  return withCheckoutLock(() => removeWorktree(profile, jobId, branch));
}

/** The removal itself, for callers that already hold the checkout lock. */
async function removeWorktree(profile: SiteProfile, jobId: string, branch?: string | null): Promise<void> {
  const dir = workspacePath(jobId);
  await tryRun('git', ['worktree', 'remove', '--force', dir], { cwd: profile.repo.path });
  await rm(dir, { recursive: true, force: true });
  await tryRun('git', ['worktree', 'prune'], { cwd: profile.repo.path });

  if (branch) await tryRun('git', ['branch', '-D', branch], { cwd: profile.repo.path });
}
