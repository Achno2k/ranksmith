import { spawn } from 'node:child_process';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Runs a command and captures its output. Rejects on a non-zero exit so callers do not
 * have to check by hand — the Engine treats a failed git or gh command as a failed step.
 */
export async function run(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await tryRun(command, args, options);
  if (result.exitCode === 0) return result;

  const what = result.timedOut
    ? `timed out after ${options.timeoutMs}ms`
    : `exited ${result.exitCode}`;
  throw new Error(`${command} ${args.join(' ')} ${what}\n${result.stderr.trim()}`);
}

/** As {@link run}, but a non-zero exit is returned rather than thrown. */
export function tryRun(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs).unref();

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

/** Splits a shell-ish command string from a Site Profile into argv. */
export const words = (command: string): [string, string[]] => {
  const [head, ...rest] = command.split(/\s+/).filter(Boolean);
  if (!head) throw new Error(`Empty command: "${command}"`);
  return [head, rest];
};
