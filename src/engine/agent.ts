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
  invocation: AgentInvocation;
  phase: PhaseName;
  date: string;
  logPath: string;
}

/** Live agent processes, so shutdown can stop them instead of orphaning a 40-minute run. */
const running = new Set<ReturnType<typeof spawn>>();

export function killRunningAgents(): void {
  for (const child of running) child.kill('SIGTERM');
  running.clear();
}

/**
 * Runs one agent Phase to completion and judges it against its Contract. The agent's own
 * account of how it went is not consulted.
 */
export async function runPhase({ invocation, phase, date, logPath }: AgentRun): Promise<RunOutcome> {
  await mkdir(dirname(logPath), { recursive: true });
  const { exitCode, timedOut } = await spawnAgent(invocation, logPath);

  const validation = await validateContract(invocation.cwd, contractFor(phase, date));

  return { exitCode, timedOut, gaps: validation.ok ? [] : validation.gaps };
}

/** Reads the machine-readable result a Phase left behind. */
export async function readResult(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(workspace, RESULT_PATH), 'utf8')) as Record<string, unknown>;
}

function spawnAgent(
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
    running.add(child);

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
    const finish = (settle: () => void) => {
      clearTimeout(kill);
      running.delete(child);
      log.end(settle);
    };

    child.on('error', (error) => finish(() => reject(error)));

    child.on('close', (code) =>
      finish(() => resolve({ exitCode: timedOut ? 124 : (code ?? 1), timedOut })),
    );
  });
}
