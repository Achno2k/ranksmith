import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateContract } from './contract.ts';
import type { AgentInvocation } from './invocation.ts';
import { contractFor, RESULT_PATH } from './phases.ts';
import type { PhaseName } from './profile.ts';
import type { RunOutcome } from './retry.ts';

/** How long to wait for a killed agent to exit before escalating to SIGKILL. */
const GRACE_MS = 10_000;

export interface AgentRun {
  jobId: string;
  invocation: AgentInvocation;
  phase: PhaseName;
  date: string;
  logPath: string;
}

interface RunningAgent {
  child: ReturnType<typeof spawn>;
  exited: Promise<void>;
}

/** Live agent processes, keyed by Job so Slack can stop one run without killing another. */
const running = new Map<string, RunningAgent>();

export function killRunningAgents(): void {
  for (const { child } of running.values()) child.kill('SIGTERM');
}

/** Requests a graceful stop, escalates if necessary, and resolves after the process exits. */
export async function killAgent(jobId: string): Promise<boolean> {
  const agent = running.get(jobId);
  if (!agent) return false;

  agent.child.kill('SIGTERM');
  const force = setTimeout(() => agent.child.kill('SIGKILL'), GRACE_MS);
  force.unref();
  await agent.exited;
  clearTimeout(force);
  return true;
}

/**
 * Runs one agent Phase to completion and judges it against its Contract. The agent's own
 * account of how it went is not consulted.
 */
export async function runPhase({ jobId, invocation, phase, date, logPath }: AgentRun): Promise<RunOutcome> {
  await mkdir(dirname(logPath), { recursive: true });
  const { exitCode, timedOut } = await spawnAgent(jobId, invocation, logPath);

  const validation = await validateContract(invocation.cwd, contractFor(phase, date));

  return { exitCode, timedOut, gaps: validation.ok ? [] : validation.gaps };
}

/** Reads the machine-readable result a Phase left behind. */
export async function readResult(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(workspace, RESULT_PATH), 'utf8')) as Record<string, unknown>;
}

function spawnAgent(
  jobId: string,
  invocation: AgentInvocation,
  logPath: string,
): Promise<{ exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    // A log we cannot write is not worth crashing the engine for; the run still matters.
    log.on('error', () => {});
    log.write(`$ ${invocation.command} ${invocation.args.join(' ')}\n\n`);

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let markExited!: () => void;
    const exited = new Promise<void>((done) => {
      markExited = done;
    });
    running.set(jobId, { child, exited });

    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.stdin.on('error', () => {});
    child.stdin.end(invocation.prompt);

    let timedOut = false;
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), GRACE_MS).unref();
    }, invocation.timeoutMs);

    /** Flushes the log before settling, so a failure report never points at a truncated file. */
    let finished = false;
    const finish = (settle: () => void) => {
      if (finished) return;
      finished = true;
      clearTimeout(kill);
      if (running.get(jobId)?.child === child) running.delete(jobId);
      markExited();
      log.end(settle);
    };

    child.on('error', (error) => finish(() => reject(error)));

    child.on('close', (code) =>
      finish(() => resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut })),
    );
  });
}
