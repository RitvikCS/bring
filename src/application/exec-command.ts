import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { runExec } from '../adapters/devcontainer-cli.js';
import type { RunOutcome } from '../adapters/process-runner.js';
import type { BringProblem } from '../core/errors.js';
import type { OperationResult } from '../core/operation-events.js';
import { shellQuote } from '../core/shell-quote.js';
import type { WorkspaceRef } from '../core/types.js';
import { openExecLog } from '../stores/log-store.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import { resultBuilder } from './results.js';

/** Captured output kept per stream in results; the full output goes to the exec log. */
export const EXEC_CAPTURE_BYTES = 16 * 1024;

export interface ExecResult extends OperationResult {
	command: string[];
	/** The command's own exit code; absent when it never ran to its own end. */
	exitCode?: number;
	stdout: string;
	stderr: string;
	truncated: { stdout: boolean; stderr: boolean };
}

export interface DetachResult extends OperationResult {
	command: string[];
	pid?: number;
	/** Where the command's output goes inside the container; absent when no place was writable. */
	containerLogPath?: string;
	stopCommand?: string;
	tailCommand?: string;
	warnings: string[];
}

export interface ExecOptions {
	config?: string;
	timeoutMs?: number;
	/** Live output, as the exact bytes the command wrote; --json leaves it unset. */
	onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void;
	/** Aborting stops the command inside the container; the result is `interrupted`. */
	cancel?: AbortSignal;
	/** Test seam: how long the stop script waits before SIGKILL (default 5s). */
	killGraceSeconds?: number;
	/** Test seam: where the exec log stops growing (default 32 MiB). */
	logMaxBytes?: number;
}

// Docker Desktop appends a "What's next" hint after every exec.
const quietEnv = (env: NodeJS.ProcessEnv) => ({
	...env,
	DOCKER_CLI_HINTS: 'false',
});

/**
 * Each exec log stops growing here; with 20 kept per workspace, a command
 * that prints gigabytes must not fill the disk. The end of the output is
 * still saved: the captured tails are appended when the log is cut.
 */
export const EXEC_LOG_MAX_BYTES = 32 * 1024 * 1024;

/** The environment variable that marks every process of one `bring exec`. */
export const EXEC_MARKER = 'BRING_EXEC_ID';

/**
 * `bring exec` (P4 §2): run one command in a running workspace.
 *
 * Killing `devcontainer exec` on the host does NOT stop the process inside
 * the container (verified), so the command is started with a unique marker
 * in its environment. Children inherit it — including ones that move to
 * their own process group or session — so a timeout, Ctrl+C, or a closed
 * output pipe can find and stop all of them from inside. Nothing is written
 * in the container, so a read-only /tmp or a non-root user changes nothing.
 *
 * Output is passed on as raw bytes and streamed to the exec log; only the
 * last 16 KiB per stream is kept in memory for the result.
 */
export async function execCommand(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	command: readonly string[],
	options: ExecOptions = {},
): Promise<ExecResult> {
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, 'exec', workspace, name);
	ctx.emit({ type: 'started', operation: 'exec', workspaceName: name });
	const base = {
		command: [...command],
		stdout: '',
		stderr: '',
		truncated: { stdout: false, stderr: false },
	};

	const running = await requireRunning(ctx, workspace, name);
	if (!running.ok) {
		return { ...fail(running.problem), ...base };
	}
	const { containerIds } = running;

	const id = randomBytes(8).toString('hex');
	// `exec` replaces the shell: the command runs as argv (shell builtins do
	// not), and its exit code — 127 when it does not exist — is the result.
	const wrapped = [
		'sh',
		'-c',
		`export ${EXEC_MARKER}=${id}; exec "$@"`,
		'bring-exec',
		...command,
	];

	const startedAt = new Date();
	const log = openExecLog(
		ctx.stateDir,
		workspace.identity,
		`# bring exec: ${JSON.stringify(command)}\n# started:  ${startedAt.toISOString()}\n\n`,
		startedAt,
	);
	const tails = {
		stdout: new TailBuffer(EXEC_CAPTURE_BYTES),
		stderr: new TailBuffer(EXEC_CAPTURE_BYTES),
	};

	let logged = 0;
	let logCut = false;
	const writeLog = (chunk: Buffer) => {
		if (logCut) {
			return;
		}
		const room = (options.logMaxBytes ?? EXEC_LOG_MAX_BYTES) - logged;
		if (chunk.length <= room) {
			log?.write(chunk);
			logged += chunk.length;
			return;
		}
		log?.write(chunk.subarray(0, room));
		logCut = true;
	};

	const abort = new AbortController();
	let stopReason: 'timeout' | 'cancelled' | undefined;
	let stopping: Promise<void> | undefined;
	let settled = false;
	const stop = (reason: 'timeout' | 'cancelled') => {
		if (stopReason !== undefined || settled) {
			return;
		}
		stopReason = reason;
		stopping = stopMarked(ctx, workspace, id, options).then(async () => {
			// Everything marked is gone, so the host-side exec should return
			// by itself; if it does not, cut it loose.
			await waitFor(() => settled, 3000);
			if (!settled) {
				abort.abort();
			}
		});
	};

	const runPromise: Promise<RunOutcome> = runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		wrapped,
		{
			env: quietEnv(ctx.env),
			accumulate: false,
			onRawOutput: (stream, chunk) => {
				writeLog(chunk);
				tails[stream].push(chunk);
				options.onOutput?.(stream, chunk);
			},
			signal: abort.signal,
		},
		options.config,
	);
	void runPromise.then(() => {
		settled = true;
	});

	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => stop('timeout'), options.timeoutMs);
	const onCancel = () => stop('cancelled');
	options.cancel?.addEventListener('abort', onCancel, { once: true });
	if (options.cancel?.aborted === true) {
		onCancel();
	}

	const run = await runPromise;
	clearTimeout(timer);
	options.cancel?.removeEventListener('abort', onCancel);
	if (stopping !== undefined) {
		await stopping;
	}

	if (run.outcome === 'spawn-failed') {
		log?.close(`\n# could not start: ${run.message}\n`);
		return {
			...fail({
				code: 'DEPENDENCY_UNREACHABLE',
				summary: `Could not start the devcontainer CLI: ${run.message}`,
				remedy: 'bring doctor',
			}),
			...base,
		};
	}

	// Ctrl+C reached only the host-side exec; the command is still running
	// in the container until it is stopped there.
	const interrupted =
		stopReason === 'cancelled' ||
		(run.result.interrupted && stopReason === undefined);
	if (run.result.interrupted && stopReason === undefined) {
		await stopMarked(ctx, workspace, id, options);
	}

	const label = commandLabel(command);
	const exitCode = run.result.exitCode;
	const note =
		stopReason === 'timeout'
			? ` (stopped after timeout, ${options.timeoutMs} ms)`
			: interrupted
				? ' (interrupted)'
				: '';
	const stdout = tails.stdout.read();
	const stderr = tails.stderr.read();
	if (logCut) {
		const mib = Math.round(
			(options.logMaxBytes ?? EXEC_LOG_MAX_BYTES) / (1024 * 1024),
		);
		log?.write(
			`\n\n# log cut after ${mib} MiB — the end of each stream follows\n# --- stdout (end) ---\n${stdout.text}\n# --- stderr (end) ---\n${stderr.text}`,
		);
	}
	log?.close(
		`\n# ended:    ${new Date().toISOString()}\n# exit:     ${exitCode}${note}\n`,
	);
	const logPath = log?.path;
	const captured = {
		...base,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
	};

	if (stopReason === 'timeout') {
		const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
		const problem: BringProblem = {
			code: 'COMMAND_TIMEOUT',
			summary: `\`${label}\` did not finish within ${seconds}s and was stopped.`,
		};
		return {
			...finish({
				outcome: 'failed',
				message: problem.summary,
				problem,
				logPath,
				containerIds,
			}),
			...captured,
		};
	}
	if (interrupted) {
		const problem: BringProblem = {
			code: 'INTERRUPTED',
			summary: `\`${label}\` was interrupted.`,
		};
		return {
			...finish({
				outcome: 'interrupted',
				message: `\`${label}\` was interrupted`,
				problem,
				logPath,
				containerIds,
			}),
			...captured,
		};
	}
	return {
		...finish({
			outcome: 'success',
			message: exitMessage(label, command, name, exitCode),
			logPath,
			containerIds,
		}),
		...captured,
		exitCode,
	};
}

/** 126/127 from `exec "$@"` mean the command itself could not be started. */
function exitMessage(
	label: string,
	command: readonly string[],
	workspaceName: string,
	exitCode: number,
): string {
	if (exitCode === 0) {
		return label;
	}
	if (exitCode === 127) {
		return `${label} exited with code 127 — is \`${command[0]}\` installed in ${workspaceName}?`;
	}
	if (exitCode === 126) {
		return `${label} exited with code 126 — \`${command[0]}\` could not be executed (not executable?)`;
	}
	return `${label} exited with code ${exitCode}`;
}

/**
 * `bring exec --detach` (P4 §2.6): start a command in the background inside
 * the container and return its pid at once. Under `setsid` the pid is also
 * the process group, so the stop command takes down the whole tree (e.g.
 * `npm run dev` and the Vite child it spawns). Nothing is remembered.
 */
export async function startDetached(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	command: readonly string[],
	options: { config?: string } = {},
): Promise<DetachResult> {
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, 'exec', workspace, name);
	ctx.emit({ type: 'started', operation: 'exec', workspaceName: name });
	const base = { command: [...command], warnings: [] as string[] };

	const running = await requireRunning(ctx, workspace, name);
	if (!running.ok) {
		return { ...fail(running.problem), ...base };
	}

	const id = randomBytes(6).toString('hex');
	const run = await runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		['sh', '-c', detachScript(id), 'bring-detach', ...command],
		{ env: quietEnv(ctx.env) },
		options.config,
	);
	if (run.outcome === 'spawn-failed') {
		return {
			...fail({
				code: 'DEPENDENCY_UNREACHABLE',
				summary: `Could not start the devcontainer CLI: ${run.message}`,
				remedy: 'bring doctor',
			}),
			...base,
		};
	}
	const label = commandLabel(command);
	const parsed = parseDetachOutput(run.result.stdout);
	if (parsed.missing) {
		return {
			...fail({
				code: 'DEVCONTAINER_FAILED',
				summary: `\`${command[0]}\` was not found in ${name}.`,
			}),
			...base,
		};
	}
	if (run.result.exitCode !== 0 || parsed.pid === undefined) {
		const detail = run.result.stderr.trim().split('\n')[0];
		return {
			...fail({
				code: 'DEVCONTAINER_FAILED',
				summary: `Could not start \`${label}\` in ${name} (exit ${run.result.exitCode})${
					detail === undefined || detail === '' ? '.' : `: ${detail}`
				}`,
			}),
			...base,
		};
	}
	const target = shellQuote(workspace.input || '.');
	const warnings: string[] = [];
	if (parsed.noSetsid) {
		warnings.push('DETACH_NO_SETSID');
	}
	if (parsed.logPath === undefined) {
		warnings.push('DETACH_NO_LOG');
	}
	if (parsed.exited) {
		warnings.push('DETACH_EXITED');
	}
	return {
		...finish({
			outcome: 'success',
			message: parsed.exited
				? `${label} started in ${name} (pid ${parsed.pid}) but has already exited`
				: `started ${label} in ${name} (pid ${parsed.pid})`,
			containerIds: running.containerIds,
		}),
		...base,
		pid: parsed.pid,
		...(parsed.logPath === undefined
			? {}
			: {
					containerLogPath: parsed.logPath,
					tailCommand: `bring ${target} exec -- tail -n 100 ${parsed.logPath}`,
				}),
		// Without setsid the pid is not a group leader: stop the pid alone.
		stopCommand: `bring ${target} exec -- kill -15 ${parsed.noSetsid ? '' : '-'}${parsed.pid}`,
		warnings,
	};
}

/**
 * The script `--detach` runs inside the container. It reports through
 * `bring:` lines on stdout. The log goes to the first writable of $TMPDIR,
 * /tmp, /dev/shm and $HOME (a non-root user may not be able to write /tmp);
 * with none, output is discarded and `bring:no-log` says so. A command that
 * is gone 0.3s later is reported — it most likely failed to start.
 */
export function detachScript(id: string): string {
	return [
		'command -v "$1" >/dev/null 2>&1 || { echo "bring:missing"; exit 127; }',
		'log=',
		'for d in "$TMPDIR" /tmp /dev/shm "$HOME"; do',
		'  [ -n "$d" ] || continue',
		`  f="$d/bring-detached-${id}.log"`,
		'  if ( : > "$f" ) 2>/dev/null; then log="$f"; break; fi',
		'done',
		'if [ -n "$log" ]; then echo "bring:log=$log"; else log=/dev/null; echo "bring:no-log"; fi',
		'if command -v setsid >/dev/null 2>&1; then',
		'  setsid "$@" </dev/null >"$log" 2>&1 &',
		'else',
		'  "$@" </dev/null >"$log" 2>&1 &',
		'  echo "bring:no-setsid"',
		'fi',
		'pid=$!',
		'echo "bring:pid=$pid"',
		'sleep 0.3',
		'kill -0 "$pid" 2>/dev/null || echo "bring:exited"',
	].join('\n');
}

export function parseDetachOutput(stdout: string): {
	pid?: number;
	logPath?: string;
	noSetsid: boolean;
	missing: boolean;
	exited: boolean;
} {
	const lines = stdout.split('\n').map((line) => line.trim());
	const value = (prefix: string) =>
		lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
	const pidText = value('bring:pid=');
	const pid = pidText === undefined ? undefined : Number(pidText);
	const logPath = value('bring:log=');
	return {
		pid:
			pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined,
		logPath: logPath === undefined || logPath === '' ? undefined : logPath,
		noSetsid: lines.includes('bring:no-setsid'),
		missing: lines.includes('bring:missing'),
		exited: lines.includes('bring:exited'),
	};
}

async function requireRunning(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	name: string,
): Promise<
	{ ok: true; containerIds: string[] } | { ok: false; problem: BringProblem }
> {
	const snapshot = await getSnapshot(ctx, workspace);
	if (!snapshot.ok) {
		return { ok: false, problem: snapshot.problem };
	}
	if (snapshot.snapshot.status !== 'running') {
		return {
			ok: false,
			problem: {
				code: 'DEVCONTAINER_FAILED',
				summary: `${name} is not running.`,
				remedy: `bring ${shellQuote(workspace.input || '.')} up`,
			},
		};
	}
	return { ok: true, containerIds: snapshot.snapshot.containerIds };
}

/**
 * Stop every process carrying the marker: SIGTERM, wait up to the grace
 * period, then SIGKILL whatever is left. Processes are found through
 * /proc/<pid>/environ, which a process can read for its own user's
 * processes. Finding none at first is retried for a second, in case the
 * stop arrives before the command has started.
 */
export function stopMarkedScript(id: string, graceSeconds: number): string {
	const ticks = Math.max(0, Math.round(graceSeconds * 10));
	return [
		`marked() { p=""; for f in /proc/[0-9]*/environ; do if grep -q "${EXEC_MARKER}=${id}" "$f" 2>/dev/null; then d=\${f%/environ}; p="$p \${d#/proc/}"; fi; done; echo $p; }`,
		'n=0; pids=$(marked)',
		'while [ -z "$pids" ] && [ $n -lt 5 ]; do sleep 0.2; n=$((n+1)); pids=$(marked); done',
		'[ -z "$pids" ] && exit 0',
		'kill -15 $pids 2>/dev/null',
		'i=0',
		`while [ $i -lt ${ticks} ]; do pids=$(marked); [ -z "$pids" ] && exit 0; sleep 0.1; i=$((i+1)); done`,
		'pids=$(marked); [ -n "$pids" ] && kill -9 $pids 2>/dev/null',
		'exit 0',
	].join('\n');
}

async function stopMarked(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	id: string,
	options: ExecOptions,
): Promise<void> {
	await runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		['sh', '-c', stopMarkedScript(id, options.killGraceSeconds ?? 5)],
		{ env: quietEnv(ctx.env) },
		options.config,
	);
}

async function waitFor(done: () => boolean, ms: number): Promise<void> {
	const until = Date.now() + ms;
	while (!done() && Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** Short human label for a command: argv joined, capped at 60 characters. */
export function commandLabel(command: readonly string[]): string {
	const text = command.join(' ');
	return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/**
 * Keeps the last `maxBytes` of a byte stream without holding the rest. The
 * text is cut on a UTF-8 character boundary so it never starts with a
 * broken character.
 */
export class TailBuffer {
	private chunks: Buffer[] = [];
	private held = 0;
	private seen = 0;

	constructor(private readonly maxBytes: number) {}

	push(chunk: Buffer): void {
		this.seen += chunk.length;
		this.chunks.push(chunk);
		this.held += chunk.length;
		// Drop whole chunks from the front while the rest still covers the tail.
		while (
			this.chunks.length > 1 &&
			this.held - (this.chunks[0] as Buffer).length >= this.maxBytes
		) {
			this.held -= (this.chunks.shift() as Buffer).length;
		}
	}

	read(): { text: string; truncated: boolean } {
		const all = Buffer.concat(this.chunks);
		const truncated = this.seen > this.maxBytes;
		let start = Math.max(0, all.length - this.maxBytes);
		if (truncated) {
			// Skip UTF-8 continuation bytes (0b10xxxxxx) at the cut.
			while (start < all.length && ((all[start] as number) & 0xc0) === 0x80) {
				start++;
			}
		}
		return { text: all.subarray(start).toString('utf8'), truncated };
	}
}
