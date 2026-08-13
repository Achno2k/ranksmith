/** What a finished agent process left behind. */
export interface RunOutcome {
  exitCode: number;
  timedOut: boolean;
  /** Contract gaps found in the Workspace afterwards; empty means the Contract held. */
  gaps: string[];
}

export type RunDecision =
  | { action: 'complete'; gaps?: undefined; reason?: undefined }
  | { action: 'retry'; gaps: string[]; reason?: undefined }
  | { action: 'fail'; reason: string; gaps?: undefined };

export const MAX_ATTEMPTS = 2;

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
