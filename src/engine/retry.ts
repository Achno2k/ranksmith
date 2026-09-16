/** What a finished agent process left behind. */
export interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  /** Contract gaps found in the Workspace afterwards; empty means the Contract held. */
  gaps: string[];
  /** Read from Claude Code's final stream-json event; absent for Codex and for crashes. */
  sessionId?: string;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export type RunDecision =
  | { action: 'complete'; gaps?: undefined; reason?: undefined }
  | { action: 'retry'; gaps: string[]; reason?: undefined }
  | { action: 'fail'; reason: string; gaps?: undefined };

export const MAX_ATTEMPTS = 2;

/** How long an Engine step waits before its one retry after a transient error. */
export const TRANSIENT_RETRY_DELAY_MS = 30_000;

const TRANSIENT_ERROR =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|could not resolve host|connection (reset|refused|timed out)|TLS handshake|HTTP 5\d\d|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|rate limit/i;

/**
 * Whether an Engine step (push, pull request, preview deploy) failed for a reason that may
 * pass on its own: the network, GitHub or Cloudflare having a moment, or a rate limit. A
 * refusal like "a pull request already exists" is not transient; repeating it ends the same.
 */
export const isTransient = (error: unknown): boolean => TRANSIENT_ERROR.test(String(error));

/**
 * A Contract miss is usually a misunderstanding, so it earns one more attempt with the
 * gaps spelled out. A timeout or a crash is not: repeating it costs the same wall-clock
 * and rarely ends differently.
 */
export function classifyRun(outcome: RunOutcome, attempt: number): RunDecision {
  if (outcome.timedOut) {
    return { action: 'fail', reason: 'Agent timed out' };
  }

  if (outcome.exitCode !== 0) {
    return { action: 'fail', reason: `Agent exited ${outcome.exitCode}` };
  }

  if (outcome.gaps.length === 0) {
    return { action: 'complete' };
  }

  if (attempt < MAX_ATTEMPTS) {
    return { action: 'retry', gaps: outcome.gaps };
  }

  return {
    action: 'fail',
    reason: `Contract not met after ${MAX_ATTEMPTS} attempts:\n${outcome.gaps.map((gap) => `- ${gap}`).join('\n')}`,
  };
}
