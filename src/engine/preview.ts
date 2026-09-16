import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { run, tryRun, words, type ExecResult } from './exec.ts';
import { wranglerPath } from './paths.ts';
import type { SiteProfile } from './profile.ts';

const BUILD_TIMEOUT_MS = 15 * 60_000;
const DEPLOY_TIMEOUT_MS = 10 * 60_000;

/** Read from the environment by whoever builds the Engine; never by this module. */
export interface CloudflareCredentials {
  apiToken: string;
  accountId: string;
}

export interface PreviewDeploy {
  /** The deployment's own permanent URL, one per upload; an older one keeps its content. */
  url: string;
}

/**
 * The line wrangler prints once the upload is live. The alias line that follows for a
 * non-production branch names the branch, not the deployment, so it is not matched here.
 */
export const DEPLOYMENT_COMPLETE = /Deployment complete!.*?(https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev)/i;

/** What wrangler says when the Pages project has not been created yet. */
const PROJECT_MISSING = /project.*not found|does not exist/i;

/** Terminal colour codes, which wrangler may wrap around its lines. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Builds the Job's Workspace and uploads the static output to Cloudflare Pages. Every
 * deployment gets its own permanent URL, so nothing has to stay alive to keep a review link
 * working: see docs/adr/0006.
 */
export async function deployPreview(
  profile: SiteProfile,
  workspace: string,
  branch: string,
  cloudflare: CloudflareCredentials,
): Promise<PreviewDeploy> {
  for (const check of profile.commands.checks) {
    const [command, args] = words(check);
    await run(command, args, { cwd: workspace, timeoutMs: BUILD_TIMEOUT_MS });
  }

  const { project, outputDir } = profile.preview;
  const env = { ...process.env, CLOUDFLARE_API_TOKEN: cloudflare.apiToken, CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId };
  const wrangler = (args: string[]) => tryRun(wranglerPath(), args, { cwd: workspace, env, timeoutMs: DEPLOY_TIMEOUT_MS });
  const deploy = ['pages', 'deploy', outputDir, '--project-name', project, '--branch', branch, '--commit-dirty=true'];

  let result = await wrangler(deploy);
  // wrangler splits its complaints between the two streams, so both are read.
  if (result.exitCode !== 0 && PROJECT_MISSING.test(`${result.stdout}\n${result.stderr}`)) {
    // First deploy for this site: the project is created once, then the upload is repeated.
    await createProject(project, profile.repo.baseBranch, cloudflare);
    result = await wrangler(deploy);
  }
  if (result.exitCode !== 0) throw new Error(`wrangler ${deploy.join(' ')} ${describe(result)}\n${result.stderr.trim()}`);

  const url = parseDeployOutput(`${result.stdout}\n${result.stderr}`, project);
  if (url === null) {
    throw new Error(`wrangler ${deploy.join(' ')} printed no deployment URL\n${result.stdout.trim().slice(-2000)}`);
  }
  return { url };
}

/**
 * Creates the Pages project over the REST API rather than `wrangler pages project create`.
 * Since wrangler 4.13x that command "delegates to the latest version of Pages, now part of
 * Workers": it detects the framework, runs `astro add cloudflare` and a build inside the
 * working directory, which rewrote a Job's worktree and failed. The API call creates a
 * classic Pages project and touches nothing on disk. `pages deploy` does not delegate.
 */
async function createProject(project: string, productionBranch: string, cloudflare: CloudflareCredentials): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/pages/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloudflare.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: project, production_branch: productionBranch }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; errors?: { message?: string }[] };
  if (!response.ok || body.success !== true) {
    const why = (body.errors ?? []).map((error) => error.message).filter(Boolean).join('; ') || `HTTP ${response.status}`;
    throw new Error(`Could not create the Pages project "${project}": ${why}`);
  }
}

const describe = (result: ExecResult): string =>
  result.timedOut ? `timed out after ${DEPLOY_TIMEOUT_MS}ms` : `exited ${result.exitCode}`;

/**
 * The deployment URL out of wrangler's output, or null when it never printed one. The
 * project name pins the host, so a URL quoted in an error for another project cannot match.
 */
export function parseDeployOutput(text: string, project: string): string | null {
  const plain = text.replace(ANSI, '');
  const host = new RegExp(`^https://[a-z0-9-]+\\.${escapeRegExp(project)}\\.pages\\.dev$`, 'i');
  const url = DEPLOYMENT_COMPLETE.exec(plain)?.[1];
  return url !== undefined && host.test(url) ? url : null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The link a reviewer opens: the changed page when the build has it, the site root when it
 * does not. Slashes are normalised so `https://x.pages.dev/` and `blog/post` still join cleanly.
 */
export function previewLink(deployUrl: string, path: string | null, exists: boolean): string {
  const root = deployUrl.replace(/\/+$/, '');
  if (path === null || !exists) return root;
  return `${root}/${path.replace(/^\/+/, '')}`;
}

/** Whether the build wrote a page for this site path: `<path>/index.html` or `<path>` as a file. */
export async function builtPageExists(workspace: string, outputDir: string, path: string): Promise<boolean> {
  const built = join(workspace, outputDir, path);
  for (const candidate of [join(built, 'index.html'), built]) {
    const info = await stat(candidate).catch(() => null);
    if (info?.isFile()) return true;
  }
  return false;
}
