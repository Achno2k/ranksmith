import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { run, words } from './exec.ts';
import type { SiteProfile } from './profile.ts';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;

export interface Preview {
  url: string;
  stop: () => Promise<void>;
}

export interface PreviewOptions {
  /** Called if the preview dies on its own, so the reviewer is not left with a dead URL. */
  onDied?: (reason: string) => void;
}

/**
 * Builds the Job's Workspace and puts it behind an ephemeral public URL. Deliberately not
 * the shared staging environment: see docs/adr/0003.
 */
export async function startPreview(
  profile: SiteProfile,
  workspace: string,
  options: PreviewOptions = {},
): Promise<Preview> {
  for (const check of profile.commands.checks) {
    const [command, args] = words(check);
    await run(command, args, { cwd: workspace, timeoutMs: BUILD_TIMEOUT_MS });
  }

  const port = await freePort();
  const [command, args] = words(profile.commands.preview);
  const server = spawn(command, [...args, '--', '--port', String(port)], {
    cwd: workspace,
    stdio: 'ignore',
  });

  let stopped = false;
  const stop = async () => {
    stopped = true;
    tunnel?.kill('SIGTERM');
    server.kill('SIGTERM');
  };

  let tunnel: ChildProcess | undefined;

  try {
    await ready(server, `preview server (${command})`);

    tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await ready(tunnel, 'cloudflared');

    const url = await firstMatch(tunnel, TUNNEL_URL, TUNNEL_TIMEOUT_MS);

    const died = (reason: string) => {
      if (!stopped) {
        stopped = true;
        options.onDied?.(reason);
      }
    };
    tunnel.on('close', (code) => died(`cloudflared exited ${code}`));
    server.on('close', (code) => died(`preview server exited ${code}`));

    return { url, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Resolves once a spawned child is known to have started. A missing binary surfaces as an
 * `'error'` event, which is fatal to the whole process if nobody is listening.
 */
function ready(child: ChildProcess, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(new Error(`Could not start ${label}: ${error.message}`));
    child.once('error', onError);
    child.once('spawn', () => {
      child.off('error', onError);
      // Keep the process alive on later errors rather than crashing the engine.
      child.on('error', () => {});
      resolve();
    });
  });
}

function firstMatch(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let seen = '';

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('close', onClose);
      fn();
    };

    const onData = (chunk: Buffer) => {
      seen += chunk.toString();
      const match = seen.match(pattern);
      if (match) settle(() => resolve(match[0]));
    };

    const onClose = (code: number | null) =>
      settle(() => reject(new Error(`cloudflared exited ${code} before printing a URL`)));

    const timer = setTimeout(
      () => settle(() => reject(new Error(`Timed out waiting for a preview URL after ${timeoutMs}ms`))),
      timeoutMs,
    );

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('close', onClose);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('Could not find a free port'))));
    });
  });
}
