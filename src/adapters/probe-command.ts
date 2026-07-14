import { spawn } from 'node:child_process';

export type ProbeResult =
	| { outcome: 'completed'; exitCode: number; stdout: string; stderr: string }
	| { outcome: 'timed-out'; timeoutMs: number }
	| { outcome: 'spawn-failed'; message: string };

export interface ProbeOptions {
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;

/**
 * Run a diagnostic command with a hard time bound (P1-02).
 *
 * Doctor probes must never wedge the CLI: a hanging child gets SIGTERM at the
 * deadline and SIGKILL shortly after. Only doctor checks are bounded like
 * this — real operations (builds) run without a timeout (spec §9.1).
 * Spawned with an argv array and shell: false, like every child in Bring.
 */
export function probeCommand(
	executable: string,
	args: readonly string[],
	options: ProbeOptions = {},
): Promise<ProbeResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			shell: false,
			env: options.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let timedOut = false;
		let settled = false;

		const deadline = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
			const hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
			hardKill.unref();
		}, timeoutMs);

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(deadline);
			resolve({ outcome: 'spawn-failed', message: error.message });
		});

		child.on('close', (code) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(deadline);
			if (timedOut) {
				resolve({ outcome: 'timed-out', timeoutMs });
				return;
			}
			// A signal death outside our timeout has no exit code; treat it as
			// a generic failure rather than inventing a shell-style number.
			resolve({ outcome: 'completed', exitCode: code ?? 1, stdout, stderr });
		});
	});
}
