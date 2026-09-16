import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { run, words } from './exec.ts';
import type { SiteProfile } from './profile.ts';

/**
 * The public hostname of a quick tunnel. `api.trycloudflare.com` is excluded: cloudflared
 * names it in the error it prints when the tunnel request itself fails, and matching that
 * once sent reviewers a URL that answers 405 to everything.
 */
export const TUNNEL_URL = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/;

/** Printed instead of a hostname when Cloudflare refused or dropped the tunnel request. */
export const TUNNEL_FAILED = /failed to request quick Tunnel/i;

/** Printed once cloudflared holds a connection to Cloudflare's edge; traffic can flow after this. */
export const TUNNEL_REGISTERED = /Registered tunnel connection/;
const TUNNEL_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * cloudflared prints the hostname before Cloudflare serves it ("it may take some time to be
 * reachable"). Whoever looks the name up in that window, a reviewer or this Engine, gets
 * "no such name" from their resolver, and trycloudflare.com tells resolvers to keep that
 * answer for 1800 seconds. So nothing here touches the local resolver until Cloudflare's own
 * resolver, asked over HTTPS, has the record; only then is the URL probed and handed out.
 */
const RESOLVE_TIMEOUT_MS = 120_000;
const REACHABLE_TIMEOUT_MS = 60_000;
const REACHABLE_POLL_MS = 3_000;

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

    // Quick tunnels use a random public hostname. Rewrite the origin Host header to
    // localhost so Vite/Astro accepts it without disabling host protection or requiring
    // every generated trycloudflare.com hostname in the website configuration.
    tunnel = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://localhost:${port}`, '--http-host-header', 'localhost'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await ready(tunnel, 'cloudflared');

    const output = tail(tunnel);
    const url = await output.waitFor(TUNNEL_URL, TUNNEL_TIMEOUT_MS, 'a preview URL');
    await output.waitFor(TUNNEL_REGISTERED, TUNNEL_TIMEOUT_MS, 'a preview URL to register with Cloudflare');
    output.release();
    await waitReachable(url);

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

export interface ReachableOptions {
  resolveTimeoutMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  /** Whether Cloudflare's resolver has an address for the hostname. Never the local resolver. */
  resolve?: (host: string) => Promise<boolean>;
  /** The HTTP status a request to the URL gets, or null when it cannot be made at all. */
  probe?: (url: string) => Promise<number | null>;
}

/**
 * Resolves once Cloudflare's DNS has the name and the URL answers with anything below 500
 * (Cloudflare answers 530 while the tunnel is not registered). The local resolver is asked
 * only after the record exists, so it can never cache a miss. Timeout messages are worded
 * so the retry policy treats them as temporary.
 */
export async function waitReachable(
  url: string,
  {
    resolveTimeoutMs = RESOLVE_TIMEOUT_MS,
    timeoutMs = REACHABLE_TIMEOUT_MS,
    pollMs = REACHABLE_POLL_MS,
    resolve = resolvesAtCloudflare,
    probe = probeUrl,
  }: ReachableOptions = {},
): Promise<void> {
  const host = new URL(url).hostname;
  const resolveBy = Date.now() + resolveTimeoutMs;
  while (!(await resolve(host))) {
    if (Date.now() >= resolveBy) {
      throw new Error(`Timed out waiting for a preview URL to resolve (Cloudflare DNS has no record after ${resolveTimeoutMs}ms)`);
    }
    await sleep(pollMs);
  }

  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    const status = await probe(url);
    if (status !== null && status < 500) return;
    last = status === null ? 'no answer' : `HTTP ${status}`;
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for a preview URL to become reachable (${last} after ${timeoutMs}ms)`);
}

/** DNS over HTTPS straight to 1.1.1.1: no hostname to look up, no local cache to poison. */
async function resolvesAtCloudflare(host: string): Promise<boolean> {
  try {
    const response = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { Status?: number; Answer?: { type: number }[] };
    return body.Status === 0 && (body.Answer ?? []).some((record) => record.type === 1);
  } catch {
    return false;
  }
}

async function probeUrl(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    return response.status;
  } catch {
    return null;
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

interface OutputTail {
  /** The first match of `pattern` in everything printed so far or later. `what` names the wait in errors. */
  waitFor(pattern: RegExp, timeoutMs: number, what: string): Promise<string>;
  /** Stops collecting and drains the pipes, so a full one can never stall cloudflared. */
  release(): void;
}

/**
 * Collects a child's output from the moment it is attached, so two consecutive waits cannot
 * miss a line that arrived between them. Every wait fails early on cloudflared's own
 * "failed to request" line or on exit: the messages are what make the retry transient.
 */
function tail(child: ChildProcess): OutputTail {
  let seen = '';
  let exit: number | null | undefined;
  const checks = new Set<() => void>();

  const onData = (chunk: Buffer) => {
    seen += chunk.toString();
    for (const check of checks) check();
  };
  const onClose = (code: number | null) => {
    exit = code ?? 1;
    for (const check of checks) check();
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('close', onClose);

  return {
    waitFor(pattern, timeoutMs, what) {
      return new Promise((resolve, reject) => {
        const done = (fn: () => void) => {
          clearTimeout(timer);
          checks.delete(check);
          fn();
        };
        const check = () => {
          const match = seen.match(pattern);
          if (match) return done(() => resolve(match[0]));
          const failed = seen.match(TUNNEL_FAILED);
          if (failed) return done(() => reject(new Error(`cloudflared exited early: ${seen.slice(failed.index).split('\n')[0]}`)));
          if (exit !== undefined) done(() => reject(new Error(`cloudflared exited ${exit} before printing ${what}`)));
        };
        const timer = setTimeout(() => done(() => reject(new Error(`Timed out waiting for ${what} after ${timeoutMs}ms`))), timeoutMs);
        checks.add(check);
        check();
      });
    },
    release() {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('close', onClose);
      child.stdout?.resume();
      child.stderr?.resume();
    },
  };
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
