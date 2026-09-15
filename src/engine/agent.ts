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

/** Enough of stderr to recognise why a run died, without holding a whole log in memory. */
const ERROR_TEXT_LIMIT = 8_192;

/** What Claude Code prints when `--resume` names a session it no longer has. */
const SESSION_MISSING = /no conversation found|session .*not found|not found.*session/i;

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

/** The final `result` event of a Claude Code stream-json run, as far as the Engine cares. */
interface StreamResult {
  sessionId?: string;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
  /** The result text when the run reported an error, so a missing session can be recognised. */
  errorText?: string;
}

interface SpawnResult extends StreamResult {
  exitCode: number;
  timedOut: boolean;
  /** The first stretch of stderr, for the same reason as `errorText`. */
  stderrHead: string;
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
  let result = await spawnAgent(jobId, invocation, logPath);

  // A resumed session can be gone (Claude Code pruned it, or it lived on another machine).
  // That is not the agent's fault, so start fresh once rather than fail the Phase.
  if (result.exitCode !== 0 && !result.timedOut && sessionMissing(result, invocation)) {
    result = await spawnAgent(jobId, withoutResume(invocation), logPath);
  }

  const validation = await validateContract(invocation.cwd, contractFor(phase, date));

  const { exitCode, timedOut, sessionId, totalCostUsd, durationMs, numTurns } = result;
  return {
    exitCode,
    timedOut,
    gaps: validation.ok ? [] : validation.gaps,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(totalCostUsd === undefined ? {} : { totalCostUsd }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(numTurns === undefined ? {} : { numTurns }),
  };
}

const sessionMissing = (result: SpawnResult, invocation: AgentInvocation): boolean =>
  invocation.args.includes('--resume') &&
  SESSION_MISSING.test(`${result.stderrHead}\n${result.errorText ?? ''}`);

function withoutResume(invocation: AgentInvocation): AgentInvocation {
  const at = invocation.args.indexOf('--resume');
  return { ...invocation, args: invocation.args.filter((_, index) => index !== at && index !== at + 1) };
}

/**
 * Picks the fields the Engine keeps out of a stream-json `result` event. Any line that is
 * not one is left alone; the raw text is already in the log.
 */
function parseResultLine(line: string): StreamResult | null {
  if (!line.startsWith('{')) return null;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;
  const record = event as Record<string, unknown>;
  if (record['type'] !== 'result') return null;

  const result: StreamResult = {};
  if (typeof record['session_id'] === 'string') result.sessionId = record['session_id'];
  if (typeof record['total_cost_usd'] === 'number') result.totalCostUsd = record['total_cost_usd'];
  if (typeof record['duration_ms'] === 'number') result.durationMs = record['duration_ms'];
  if (typeof record['num_turns'] === 'number') result.numTurns = record['num_turns'];
  if (record['is_error'] === true) {
    // A failed run reports either a result string or an errors array, depending on where it died.
    const errors = Array.isArray(record['errors']) ? record['errors'].filter((e) => typeof e === 'string') : [];
    const text = [typeof record['result'] === 'string' ? record['result'] : '', ...errors].filter(Boolean).join('\n');
    if (text) result.errorText = text;
  }
  return result;
}

/** Reads the machine-readable result a Phase left behind. */
export async function readResult(workspace: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(workspace, RESULT_PATH), 'utf8')) as Record<string, unknown>;
}

function spawnAgent(jobId: string, invocation: AgentInvocation, logPath: string): Promise<SpawnResult> {
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

    // The log keeps every line verbatim; this only reads the final result event off the side.
    let result: StreamResult = {};
    let pending = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) result = parseResultLine(line) ?? result;
    });

    let stderrHead = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrHead.length < ERROR_TEXT_LIMIT) stderrHead += chunk.toString().slice(0, ERROR_TEXT_LIMIT);
    });

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

    child.on('close', (code) => {
      if (pending) result = parseResultLine(pending) ?? result;
      finish(() => resolve({ ...result, exitCode: timedOut ? 124 : (code ?? 1), timedOut, stderrHead }));
    });
  });
}
