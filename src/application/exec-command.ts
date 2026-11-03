import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { runExec } from '../adapters/devcontainer-cli.js';
import type { RunOutcome } from '../adapters/process-runner.js';
import type { BringProblem } from '../core/errors.js';
import type { OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import { writeExecLog } from '../stores/log-store.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import { resultBuilder } from './results.js';

/** Captured output kept per stream in results; the full output goes to the exec log. */
export const EXEC_CAPTURE_BYTES = 16 * 1024;

export interface ExecResult extends OperationResult {
	command: string[];
	/** The command's own exit code; absent when it never ran. */
	exitCode?: number;
	stdout: string;
	stderr: string;
	truncated: { stdout: boolean; stderr: boolean };
}

export interface DetachResult extends OperationResult {
	command: string[];
	pid?: number;
	containerLogPath?: string;
	stopCommand?: string;
	tailCommand?: string;
	warnings: string[];
}

export interface ExecOptions {
	config?: string;
	timeoutMs?: number;
	/** Live output for plain mode; --json leaves it unset. */
	onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void;
	/** Test seam: how long the stop script waits before SIGKILL (default 5s). */
	killGraceSeconds?: number;
}

// Docker Desktop appends a "What's next" hint after every exec.
const quietEnv = (env: NodeJS.ProcessEnv) => ({
	...env,
	DOCKER_CLI_HINTS: 'false',
});

/**
 * `bring exec` (P4 §2): run one command in a running workspace, capturing
 * its output. Killing `devcontainer exec` on the host does NOT stop the
 * process inside the container (verified), so the command runs under a tiny
 * sh wrapper that records its process group; timeouts and Ctrl+C then stop
 * the whole group from inside. The wrapper removes its own pgid file, so a
 * normal run costs no extra exec.
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

	const id = randomBytes(6).toString('hex');
	// Straight in /tmp (world-writable, sticky): a /tmp/bring directory made
	// by another user could not be written to.
	const pgidFile = `/tmp/bring-exec-${id}.pgid`;
	const wrapped = [
		'sh',
		'-c',
		`echo $$ > ${pgidFile} 2>/dev/null; "$@"; rc=$?; rm -f ${pgidFile}; exit $rc`,
		'bring-exec',
		...command,
	];

	const abort = new AbortController();
	const startedAt = new Date();
	let timedOut = false;
	let stopping: Promise<void> | undefined;
	const runPromise: Promise<RunOutcome> = runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		wrapped,
		{
			env: quietEnv(ctx.env),
			onOutput: options.onOutput,
			signal: abort.signal,
		},
		options.config,
	);
	let settled = false;
	void runPromise.then(() => {
		settled = true;
	});

	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					stopping = stopGroup(ctx, workspace, pgidFile, options).then(
						async () => {
							// The group is gone, so the host exec should return on
							// its own; if it doesn't, cut it loose.
							await waitFor(() => settled, 3000);
							if (!settled) {
								abort.abort();
							}
						},
					);
				}, options.timeoutMs);

	const run = await runPromise;
	clearTimeout(timer);
	if (stopping !== undefined) {
		await stopping;
	}

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

	const interrupted = run.result.interrupted && !timedOut;
	if (interrupted) {
		// Ctrl+C reached the host-side exec only; the command is still running
		// in the container until we stop its group there.
		await stopGroup(ctx, workspace, pgidFile, options);
	}

	const label = commandLabel(command);
	const exitCode = run.result.exitCode;
	const logPath = writeExecLog(
		ctx.stateDir,
		workspace.identity,
		execLogContent({
			command,
			startedAt,
			endedAt: new Date(),
			exitCode,
			note: timedOut
				? `stopped after timeout (${options.timeoutMs} ms)`
				: interrupted
					? 'interrupted'
					: undefined,
			combined: run.result.combined,
		}),
	);
	const stdout = tailBytes(run.result.stdout, EXEC_CAPTURE_BYTES);
	const stderr = tailBytes(run.result.stderr, EXEC_CAPTURE_BYTES);
	const captured = {
		...base,
		stdout: stdout.text,
		stderr: stderr.text,
		truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
	};

	if (timedOut) {
		const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
		return {
			...fail(
				{
					code: 'COMMAND_TIMEOUT',
					summary: `\`${label}\` did not finish within ${seconds}s and was stopped.`,
				},
				logPath,
			),
			...captured,
		};
	}
	if (interrupted) {
		return {
			...finish({
				outcome: 'interrupted',
				message: `\`${label}\` was interrupted`,
				logPath,
				containerIds: running.containerIds,
			}),
			...captured,
		};
	}
	return {
		...finish({
			outcome: 'success',
			message: exitCode === 0 ? label : `${label} exited with code ${exitCode}`,
			logPath,
			containerIds: running.containerIds,
		}),
		...captured,
		exitCode,
	};
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
	const logFile = `/tmp/bring-detached-${id}.log`;
	const script = [
		`command -v "$1" >/dev/null 2>&1 || { echo "bring:missing"; exit 127; }`,
		'if command -v setsid >/dev/null 2>&1; then',
		`  setsid "$@" </dev/null >${logFile} 2>&1 &`,
		'else',
		`  "$@" </dev/null >${logFile} 2>&1 &`,
		'  echo "bring:no-setsid"',
		'fi',
		'echo "bring:pid=$!"',
	].join('\n');
	const run = await runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		['sh', '-c', script, 'bring-detach', ...command],
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
		return {
			...fail({
				code: 'DEVCONTAINER_FAILED',
				summary: `Could not start \`${label}\` in ${name} (exit ${run.result.exitCode}).`,
			}),
			...base,
		};
	}
	const target = workspace.input || '.';
	const warnings = parsed.noSetsid ? ['DETACH_NO_SETSID'] : [];
	return {
		...finish({
			outcome: 'success',
			message: `started ${label} in ${name} (pid ${parsed.pid})`,
			containerIds: running.containerIds,
		}),
		...base,
		pid: parsed.pid,
		containerLogPath: logFile,
		// Without setsid the pid is not a group leader: stop the pid alone.
		stopCommand: `bring ${target} exec -- kill -15 ${parsed.noSetsid ? '' : '-'}${parsed.pid}`,
		tailCommand: `bring ${target} exec -- tail -n 100 ${logFile}`,
		warnings,
	};
}

export function parseDetachOutput(stdout: string): {
	pid?: number;
	noSetsid: boolean;
	missing: boolean;
} {
	const lines = stdout.split('\n').map((line) => line.trim());
	const pidLine = lines.find((line) => line.startsWith('bring:pid='));
	const pid =
		pidLine === undefined
			? undefined
			: Number(pidLine.slice('bring:pid='.length));
	return {
		pid:
			pid !== undefined && Number.isInteger(pid) && pid > 0 ? pid : undefined,
		noSetsid: lines.includes('bring:no-setsid'),
		missing: lines.includes('bring:missing'),
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
				remedy: `bring ${workspace.input || '.'} up`,
			},
		};
	}
	return { ok: true, containerIds: snapshot.snapshot.containerIds };
}

/**
 * Stop the wrapped command's process group inside the container: SIGTERM,
 * wait up to the grace period, then SIGKILL. dash only accepts the numeric
 * `kill -15 -<pgid>` form for groups (verified). A missing pgid file means
 * the command already finished.
 */
export function stopGroupScript(
	pgidFile: string,
	graceSeconds: number,
): string {
	const ticks = Math.max(0, Math.round(graceSeconds * 10));
	return [
		`g=$(cat ${pgidFile} 2>/dev/null) || exit 0`,
		'kill -15 -$g 2>/dev/null',
		'i=0',
		`while kill -0 -$g 2>/dev/null && [ $i -lt ${ticks} ]; do sleep 0.1; i=$((i+1)); done`,
		'kill -9 -$g 2>/dev/null',
		`rm -f ${pgidFile}`,
		'exit 0',
	].join('\n');
}

async function stopGroup(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	pgidFile: string,
	options: ExecOptions,
): Promise<void> {
	await runExec(
		ctx.devcontainerExe,
		workspace.rootPath,
		['sh', '-c', stopGroupScript(pgidFile, options.killGraceSeconds ?? 5)],
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
 * The last `maxBytes` of a string, cut on a UTF-8 character boundary so
 * the tail never starts with a broken character.
 */
export function tailBytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text, 'utf8');
	if (buffer.length <= maxBytes) {
		return { text, truncated: false };
	}
	let start = buffer.length - maxBytes;
	// Skip UTF-8 continuation bytes (0b10xxxxxx) at the cut.
	while (start < buffer.length && ((buffer[start] as number) & 0xc0) === 0x80) {
		start++;
	}
	return { text: buffer.subarray(start).toString('utf8'), truncated: true };
}

function execLogContent(entry: {
	command: readonly string[];
	startedAt: Date;
	endedAt: Date;
	exitCode: number;
	note?: string;
	combined: string;
}): string {
	const header = [
		`# bring exec: ${JSON.stringify(entry.command)}`,
		`# started:  ${entry.startedAt.toISOString()}`,
		`# ended:    ${entry.endedAt.toISOString()}`,
		`# exit:     ${entry.exitCode}${entry.note === undefined ? '' : ` (${entry.note})`}`,
		'',
	].join('\n');
	return `${header}\n${entry.combined}`;
}
