import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PHASES, type SiteProfile } from './profile.ts';

// fileURLToPath, not URL.pathname: a checkout under a path containing a space would
// otherwise arrive percent-encoded and fail to open.
const profilesRoot = (): string => fileURLToPath(new URL('../../profiles', import.meta.url));

export const skillsDir = (profileId: string): string => join(profilesRoot(), profileId, 'skills');

/** Where each CLI looks for its skills. A Phase running without its skill is a silent failure. */
const CLI_SKILL_DIRS = [join(homedir(), '.codex', 'skills'), join(homedir(), '.claude', 'skills')];

export async function loadProfile(profileId: string): Promise<SiteProfile> {
  const path = join(profilesRoot(), profileId, 'profile.json');
  const profile = JSON.parse(await readFile(path, 'utf8')) as SiteProfile;

  // The checkout lives in a different place on each machine the Engine runs on.
  const repoPath = process.env['RANKSMITH_REPO_PATH'];
  if (repoPath && profile.repo) profile.repo.path = repoPath;

  for (const phase of AGENT_PHASES) {
    if (!profile.phases[phase]) throw new Error(`${path}: missing configuration for phase "${phase}"`);
  }

  for (const field of ['path', 'baseRemote', 'baseBranch', 'pushRemote', 'pullRequestRepo'] as const) {
    if (!profile.repo?.[field]) throw new Error(`${path}: missing repo.${field}`);
  }

  return profile;
}

/**
 * Confirms every skill this profile owns is reachable from both CLIs. Run at boot: an
 * agent that silently starts without its skill produces confident, useless work.
 */
export async function verifySkillLinks(profileId: string): Promise<void> {
  const source = skillsDir(profileId);
  const skills = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const broken: string[] = [];

  for (const skill of skills) {
    const expected = await realpath(join(source, skill));

    for (const dir of CLI_SKILL_DIRS) {
      const target = join(dir, skill);
      const actual = await realpath(target).catch(() => null);
      if (actual !== expected) broken.push(`${target} should link to ${expected} (found ${actual ?? 'nothing'})`);
    }
  }

  if (broken.length > 0) {
    throw new Error(`Skill links are not set up. Run scripts/link-skills.sh.\n${broken.join('\n')}`);
  }
}
