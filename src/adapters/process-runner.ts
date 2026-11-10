import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

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
	/** Aborting kills the child (SIGTERM); the run then settles normally. */
	signal?: AbortSignal;
	/** Called with each chunk's exact bytes, before any decoding. */
	onRawOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
	/**
	 * false: do not accumulate output in the result (stdout/stderr/combined
	 * stay empty) — for callers that stream it elsewhere via onRawOutput, so
	 * a long-running command cannot grow Bring's memory without bound.
	 */
	accumulate?: boolean;
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
		const onAbort = () => {
			child.kill('SIGTERM');
		};
		options.signal?.addEventListener('abort', onAbort, { once: true });
		const cleanup = () => {
			options.signal?.removeEventListener('abort', onAbort);
			if (!inherit) {
				process.removeListener('SIGINT', onSigint);
				process.removeListener('SIGTERM', onSigterm);
			}
		};

		const accumulate = options.accumulate !== false;
		// One decoder per stream: a multi-byte character split across two
		// chunks must not turn into replacement characters.
		const decoders = {
			stdout: new StringDecoder('utf8'),
			stderr: new StringDecoder('utf8'),
		};
		const onChunk = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
			options.onRawOutput?.(stream, chunk);
			if (!accumulate && options.onOutput === undefined) {
				return;
			}
			const text = decoders[stream].write(chunk);
			if (accumulate) {
				if (stream === 'stdout') {
					stdout += text;
				} else {
					stderr += text;
				}
				combined += text;
			}
			options.onOutput?.(stream, text);
		};
		child.stdout?.on('data', onChunk('stdout'));
		child.stderr?.on('data', onChunk('stderr'));

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
