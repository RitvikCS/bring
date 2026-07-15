import { spawn } from 'node:child_process';

export interface RunOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Called with each chunk as it arrives; used for --verbose streaming. */
	onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
	/**
	 * 'capture' (default) records output; 'inherit' hands the terminal to the
	 * child — used for interactive shells, where the child owns the TTY.
	 */
	stdio?: 'capture' | 'inherit';
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** stdout+stderr interleaved in arrival order. */
	combined: string;
	/** True when the run ended because Ctrl+C/SIGTERM reached Bring. */
	interrupted: boolean;
}

export type RunOutcome =
	| { outcome: 'ran'; result: RunResult }
	| { outcome: 'spawn-failed'; message: string };

/**
 * The one place Bring starts real work (P1-12, safety rules in spec §9.1):
 * executable and argv are always separate, `shell: false` always, no timeout
 * (builds may legitimately take many minutes — only doctor probes are
 * bounded). SIGINT/SIGTERM received by Bring are forwarded to the child so
 * Ctrl+C stops the actual build, and the run reports `interrupted` so the
 * CLI can exit 130.
 */
export function runCommand(
	executable: string,
	args: readonly string[],
	options: RunOptions = {},
): Promise<RunOutcome> {
	return new Promise((resolvePromise) => {
		const inherit = options.stdio === 'inherit';
		const child = spawn(executable, args, {
			shell: false,
			cwd: options.cwd,
			env: options.env,
			stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
		});

		let stdout = '';
		let stderr = '';
		let combined = '';
		let interrupted = false;
		let settled = false;

		const forward = (signal: NodeJS.Signals) => () => {
			interrupted = true;
			child.kill(signal);
		};
		const onSigint = forward('SIGINT');
		const onSigterm = forward('SIGTERM');
		// With inherited stdio the terminal delivers Ctrl+C to the child
		// directly; Bring must not also race it to a second signal.
		if (!inherit) {
			process.on('SIGINT', onSigint);
			process.on('SIGTERM', onSigterm);
		}
		const cleanup = () => {
			if (!inherit) {
				process.removeListener('SIGINT', onSigint);
				process.removeListener('SIGTERM', onSigterm);
			}
		};

		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			stdout += text;
			combined += text;
			options.onOutput?.('stdout', text);
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			combined += text;
			options.onOutput?.('stderr', text);
		});

		child.on('error', (error) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolvePromise({ outcome: 'spawn-failed', message: error.message });
		});

		child.on('close', (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (signal !== null) {
				interrupted =
					interrupted || signal === 'SIGINT' || signal === 'SIGTERM';
			}
			resolvePromise({
				outcome: 'ran',
				result: {
					exitCode: code ?? 130,
					stdout,
					stderr,
					combined,
					interrupted,
				},
			});
		});
	});
}
