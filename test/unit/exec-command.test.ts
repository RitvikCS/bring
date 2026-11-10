import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	type DetachResult,
	detachScript,
	EXEC_CAPTURE_BYTES,
	type ExecResult,
	execCommand,
	parseDetachOutput,
	startDetached,
	stopMarkedScript,
	TailBuffer,
} from '../../src/application/exec-command.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import {
	detachExtras,
	execExtras,
	exitCodeForExec,
} from '../../src/cli/run-direct.js';
import { exitCodeForProblem } from '../../src/core/errors.js';
import { shellQuote } from '../../src/core/shell-quote.js';
import { formatExecSummary } from '../../src/direct/format-result.js';
import {
	EXEC_LOG_RETENTION,
	latestLogPath,
	logDirFor,
	openExecLog,
} from '../../src/stores/log-store.js';
import {
	makeHarness,
	type OperationHarness,
	RUNNING_PS,
	STOPPED_PS,
} from '../helpers/fake-workspace.js';

function argvLog(harness: { argvFile: string }): string {
	return existsSync(harness.argvFile)
		? readFileSync(harness.argvFile, 'utf8')
		: '';
}

/** Replace the fake devcontainer: log argv, then run `body`. */
function fakeDevcontainer(h: OperationHarness, body: string): void {
	writeFileSync(
		h.ctx.devcontainerExe,
		`#!/bin/sh\nprintf '%s\\n' "devcontainer $*" >> "${h.argvFile}"\n${body}\n`,
		{ mode: 0o755 },
	);
}

describe('execCommand', () => {
	it('refuses a workspace that is not running, with an `up` remedy', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await execCommand(h.ctx, h.workspace, ['npm', 'test']);
		expect(result.outcome).toBe('failed');
		expect(result.problem).toMatchObject({
			code: 'DEVCONTAINER_FAILED',
			remedy: 'bring . up',
		});
		expect(result.exitCode).toBeUndefined();
		expect(argvLog(h)).not.toContain('devcontainer exec');
	});

	it('quotes a target with spaces in the remedy', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await execCommand(
			h.ctx,
			{ ...h.workspace, input: 'my app; echo x' },
			['true'],
		);
		expect(result.problem?.remedy).toBe("bring 'my app; echo x' up");
	});

	it('passes the exit code through and keeps stdout and stderr apart', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo hi\necho oops >&2\nexit 3',
		});
		const result = await execCommand(h.ctx, h.workspace, ['npm', 'test']);
		expect(result).toMatchObject({
			outcome: 'success',
			operation: 'exec',
			exitCode: 3,
			stdout: 'hi\n',
			stderr: 'oops\n',
			truncated: { stdout: false, stderr: false },
			command: ['npm', 'test'],
			message: 'npm test exited with code 3',
			containerIds: ['run1'],
		});
		expect(result.problem).toBeUndefined();
	});

	it('hints at a missing command on exit 127, still passing the code through', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'exit 127',
		});
		const result = await execCommand(h.ctx, h.workspace, ['pytest', '-x']);
		expect(result.outcome).toBe('success');
		expect(result.exitCode).toBe(127);
		expect(result.message).toContain('is `pytest` installed in');
	});

	it('marks the command through its environment and runs it as argv with the resolved config', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		fakeDevcontainer(h, 'exit 0');
		await execCommand(h.ctx, h.workspace, ['npm', 'test'], {
			config: h.workspace.configPath,
		});
		const line = argvLog(h).trim().split('\n').at(-1) ?? '';
		expect(line).toContain(
			`exec --workspace-folder ${h.workspace.rootPath} --config ${h.workspace.configPath} sh -c`,
		);
		expect(line).toMatch(
			/export BRING_EXEC_ID=[0-9a-f]{16}; exec "\$@" bring-exec npm test$/,
		);
	});

	it('passes on the exact bytes the command wrote', async () => {
		// 0xFF 0x00 'A' and half of a multi-byte character: not valid UTF-8.
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: "printf '\\377\\000A\\342\\202'",
		});
		const chunks: Buffer[] = [];
		const result = await execCommand(h.ctx, h.workspace, ['cat', 'bin'], {
			onOutput: (stream, chunk) => {
				if (stream === 'stdout') {
					chunks.push(chunk);
				}
			},
		});
		expect([...Buffer.concat(chunks)]).toEqual([0xff, 0x00, 0x41, 0xe2, 0x82]);
		expect([...readFileSync(result.logPath as string)].slice(-80)).toEqual(
			expect.arrayContaining([0xff, 0x00, 0x41, 0xe2, 0x82]),
		);
	});

	it('streams the full output to an exec log and never touches latest.log', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo full-output\nexit 4',
		});
		const latest = latestLogPath(h.stateDir, h.workspace.identity);
		mkdirSync(dirname(latest), { recursive: true });
		writeFileSync(latest, 'the failed build log');
		const result = await execCommand(h.ctx, h.workspace, ['echo', 'x']);
		expect(result.logPath).toContain(
			join('logs', h.workspace.identity, 'exec'),
		);
		const log = readFileSync(result.logPath as string, 'utf8');
		expect(log).toMatch(
			/^# bring exec: \["echo","x"\]\n# started: {2}\S+\n\nfull-output\n\n# ended: {4}\S+\n# exit: {5}4\n$/,
		);
		expect(readFileSync(latest, 'utf8')).toBe('the failed build log');
	});

	it('still returns the result when the exec log cannot be written', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo ran-ok\nexit 2',
		});
		// A file where the log directory should be.
		mkdirSync(join(h.stateDir, 'logs'), { recursive: true });
		writeFileSync(logDirFor(h.stateDir, h.workspace.identity), 'in the way');
		const result = await execCommand(h.ctx, h.workspace, ['x']);
		expect(result).toMatchObject({
			outcome: 'success',
			exitCode: 2,
			stdout: 'ran-ok\n',
		});
		expect(result.logPath).toBeUndefined();
	});

	it('stops the log growing at its cap but keeps the end of the output', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'i=0\nwhile [ $i -lt 500 ]; do echo "line-$i"; i=$((i+1)); done\necho THE-END',
		});
		const result = await execCommand(h.ctx, h.workspace, ['big'], {
			logMaxBytes: 1000,
		});
		const log = readFileSync(result.logPath as string, 'utf8');
		expect(log).toContain('line-0\n');
		// Exactly the cap's worth of output sits between header and notice.
		const body = log.slice(
			log.indexOf('\n\n') + 2,
			log.indexOf('\n\n# log cut'),
		);
		expect(Buffer.byteLength(body)).toBe(1000);
		expect(log).toContain('# log cut after 0 MiB');
		expect(log).toContain('THE-END\n\n# --- stderr (end) ---');
		expect(log).toMatch(/# exit: {5}0\n$/);
	});

	it('keeps only the last 16 KiB per stream and says so', async () => {
		// 3000 lines of 10 bytes = 30000 bytes, using builtins only.
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'i=0\nwhile [ $i -lt 3000 ]; do echo "line-$((i % 10))xxx"; i=$((i+1)); done',
		});
		const result = await execCommand(h.ctx, h.workspace, ['big']);
		expect(result.truncated).toEqual({ stdout: true, stderr: false });
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
			EXEC_CAPTURE_BYTES,
		);
		expect(result.stdout.endsWith('line-9xxx\n')).toBe(true);
		const log = readFileSync(result.logPath as string, 'utf8');
		expect(log.split('\n').filter((l) => l.startsWith('line-')).length).toBe(
			3000,
		);
	});

	/**
	 * Main call: become a long sleep. Stop call (its script scans for the
	 * marker and kills): end that sleep, the way stopping everything in the
	 * container ends the host-side exec.
	 */
	function longRunning(h: OperationHarness): string {
		const pidFile = join(h.binDir, 'main.pid');
		fakeDevcontainer(
			h,
			`case "$*" in
	*"kill -15"*) kill "$(cat "${pidFile}")" 2>/dev/null; exit 0 ;;
	*bring-exec*) echo $$ > "${pidFile}"; echo started; exec /bin/sleep 30 ;;
esac`,
		);
		return pidFile;
	}

	/** The marker id the wrapper used, and the one the stop script looked for. */
	function markerIds(h: OperationHarness): {
		started: string;
		stopped: string;
	} {
		const log = argvLog(h);
		return {
			started: /export BRING_EXEC_ID=([0-9a-f]+);/.exec(log)?.[1] ?? 'none',
			stopped: /grep -q "BRING_EXEC_ID=([0-9a-f]+)"/.exec(log)?.[1] ?? 'no',
		};
	}

	it('stops everything it started on timeout (COMMAND_TIMEOUT)', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		longRunning(h);
		const started = Date.now();
		const result = await execCommand(h.ctx, h.workspace, ['sleep', '30'], {
			timeoutMs: 300,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.outcome).toBe('failed');
		expect(result.problem).toMatchObject({ code: 'COMMAND_TIMEOUT' });
		expect(result.problem?.summary).toContain('did not finish within 0s');
		expect(result.exitCode).toBeUndefined();
		expect(result.containerIds).toEqual(['run1']);
		expect(result.stdout).toBe('started\n');
		const ids = markerIds(h);
		expect(ids.stopped).toBe(ids.started);
		expect(readFileSync(result.logPath as string, 'utf8')).toContain(
			'stopped after timeout',
		);
	});

	it('stops the command inside the container after Ctrl+C', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		fakeDevcontainer(
			h,
			`case "$*" in
	*"kill -15"*) exit 0 ;;
	*bring-exec*) exec /bin/sleep 30 ;;
esac`,
		);
		const pending = execCommand(h.ctx, h.workspace, ['sleep', '30']);
		await new Promise((resolve) => setTimeout(resolve, 300));
		process.emit('SIGINT');
		const result = await pending;
		expect(result.outcome).toBe('interrupted');
		expect(result.problem?.code).toBe('INTERRUPTED');
		const ids = markerIds(h);
		expect(ids.stopped).toBe(ids.started);
	});

	it('stops the command when the caller cancels (closed output pipe)', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		longRunning(h);
		const cancel = new AbortController();
		const pending = execCommand(h.ctx, h.workspace, ['yes'], {
			cancel: cancel.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		cancel.abort();
		const result = await pending;
		expect(result.outcome).toBe('interrupted');
		const ids = markerIds(h);
		expect(ids.stopped).toBe(ids.started);
	});

	it('reports a missing devcontainer CLI as DEPENDENCY_UNREACHABLE', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		h.ctx.devcontainerExe = join(h.binDir, 'nope');
		const result = await execCommand(h.ctx, h.workspace, ['x']);
		expect(result.problem).toMatchObject({ code: 'DEPENDENCY_UNREACHABLE' });
	});
});

describe('startDetached', () => {
	it('returns pid, log and a group stop command', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'echo "bring:log=/tmp/bring-detached-abc.log"\necho "bring:pid=559"',
		});
		const result = await startDetached(h.ctx, h.workspace, [
			'npm',
			'run',
			'dev',
		]);
		expect(result).toMatchObject({
			outcome: 'success',
			pid: 559,
			containerLogPath: '/tmp/bring-detached-abc.log',
			tailCommand: 'bring . exec -- tail -n 100 /tmp/bring-detached-abc.log',
			stopCommand: 'bring . exec -- kill -15 -559',
			warnings: [],
			message: `started npm run dev in ${result.workspaceName} (pid 559)`,
		});
	});

	it('quotes the target in the commands it hands back', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo "bring:log=/tmp/l.log"\necho "bring:pid=7"',
		});
		const result = await startDetached(
			h.ctx,
			{ ...h.workspace, input: 'rb link; echo PWNED' },
			['srv'],
		);
		expect(result.stopCommand).toBe(
			"bring 'rb link; echo PWNED' exec -- kill -15 -7",
		);
		expect(result.tailCommand).toBe(
			"bring 'rb link; echo PWNED' exec -- tail -n 100 /tmp/l.log",
		);
	});

	it('falls back to a plain pid kill without setsid', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'echo "bring:log=/tmp/l.log"\necho bring:no-setsid\necho "bring:pid=42"',
		});
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.stopCommand).toBe('bring . exec -- kill -15 42');
		expect(result.warnings).toEqual(['DETACH_NO_SETSID']);
	});

	it('says so when no log could be created or the command is already gone', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'echo bring:no-log\necho "bring:pid=42"\necho bring:exited',
		});
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.outcome).toBe('success');
		expect(result.warnings).toEqual(['DETACH_NO_LOG', 'DETACH_EXITED']);
		expect(result.containerLogPath).toBeUndefined();
		expect(result.tailCommand).toBeUndefined();
		expect(result.message).toContain('has already exited');
	});

	it('fails fast when the command does not exist in the container', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo bring:missing\nexit 127',
		});
		const result = await startDetached(h.ctx, h.workspace, ['nodemon']);
		expect(result.outcome).toBe('failed');
		expect(result.problem?.summary).toContain('`nodemon` was not found');
	});

	it('surfaces the reason when starting fails', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo "sh: out of memory" >&2\nexit 1',
		});
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.problem?.summary).toContain('(exit 1): sh: out of memory');
	});

	it('refuses a stopped workspace', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.problem?.remedy).toBe('bring . up');
	});
});

describe('exec scripts', () => {
	it('parses detach output defensively', () => {
		expect(
			parseDetachOutput('noise\nbring:log=/tmp/a.log\nbring:pid=12\n'),
		).toEqual({
			pid: 12,
			logPath: '/tmp/a.log',
			noSetsid: false,
			missing: false,
			exited: false,
		});
		expect(parseDetachOutput('bring:pid=abc')).toMatchObject({
			pid: undefined,
		});
		expect(parseDetachOutput('bring:pid=-3')).toMatchObject({ pid: undefined });
	});

	it('stop: SIGTERM first, SIGKILL only after the grace period', () => {
		const script = stopMarkedScript('abc123', 5);
		const term = script.indexOf('kill -15 $pids');
		const wait = script.indexOf('[ $i -lt 50 ]');
		const kill = script.indexOf('kill -9 $pids');
		expect(term).toBeGreaterThan(-1);
		expect(wait).toBeGreaterThan(term);
		expect(kill).toBeGreaterThan(wait);
		expect(script).toContain('grep -q "BRING_EXEC_ID=abc123"');
		// Nothing is written in the container: no pid files to go stale.
		expect(script).not.toMatch(/>\s*\/tmp/);
	});

	it('detach: checks the log is writable before starting, and reports the pid', () => {
		const script = detachScript('abc');
		expect(script.indexOf('( : > "$f" )')).toBeLessThan(
			script.indexOf('setsid "$@"'),
		);
		expect(script).toContain('"${TMPDIR:-/tmp}" /tmp /dev/shm "$HOME"');
		expect(script).toContain('bring-detached-abc.log');
		expect(script).toContain('echo "bring:pid=$pid"');
	});

	it('really stops marked processes, including ones that left the process group', async () => {
		// The same scripts, run on this machine: Linux /proc is all they need.
		if (process.platform !== 'linux') {
			return;
		}
		const { spawn, spawnSync } = await import('node:child_process');
		const id = `test${Date.now().toString(16)}`;
		const child = spawn(
			'sh',
			[
				'-c',
				`export BRING_EXEC_ID=${id}; exec "$@"`,
				'bring-exec',
				'sh',
				'-c',
				'sleep 300 & setsid sleep 301 & (trap "" TERM; sleep 302) & sleep 303',
			],
			{ stdio: 'ignore' },
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const marked = () =>
			spawnSync('sh', [
				'-c',
				`n=0; for f in /proc/[0-9]*/environ; do grep -q "BRING_EXEC_ID=${id}" "$f" 2>/dev/null && n=$((n+1)); done; echo $n`,
			])
				.stdout.toString()
				.trim();
		expect(Number(marked())).toBeGreaterThanOrEqual(4);
		spawnSync('sh', ['-c', stopMarkedScript(id, 1)]);
		expect(marked()).toBe('0');
		child.kill('SIGKILL');
	});
});

describe('TailBuffer', () => {
	it('cuts on a UTF-8 boundary', () => {
		const tail = new TailBuffer(6);
		tail.push(Buffer.from(`${'é'.repeat(10)}end`)); // é is 2 bytes
		const { text, truncated } = tail.read();
		expect(truncated).toBe(true);
		expect(text).toBe('éend');
	});

	it('joins a character split across chunks', () => {
		const tail = new TailBuffer(100);
		const euro = Buffer.from('€');
		tail.push(euro.subarray(0, 2));
		tail.push(euro.subarray(2));
		expect(tail.read()).toEqual({ text: '€', truncated: false });
	});

	it('holds a bounded amount however much passes through', () => {
		const tail = new TailBuffer(1024);
		const chunk = Buffer.alloc(700, 'x');
		for (let i = 0; i < 10_000; i++) {
			tail.push(chunk);
		}
		const held = (tail as unknown as { held: number }).held;
		expect(held).toBeLessThan(1024 + 2 * 700);
		expect(tail.read().truncated).toBe(true);
		expect(Buffer.byteLength(tail.read().text)).toBe(1024);
	});
});

describe('exec log store', () => {
	it('retains the last 20 exec logs', () => {
		const h = makeHarness({});
		for (let i = 0; i < EXEC_LOG_RETENTION + 3; i++) {
			openExecLog(
				h.stateDir,
				'ws',
				`log ${i}`,
				new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
			)?.close('');
		}
		const dir = join(logDirFor(h.stateDir, 'ws'), 'exec');
		const names = readdirSync(dir).sort();
		expect(names).toHaveLength(EXEC_LOG_RETENTION);
		expect(readFileSync(join(dir, names[0] as string), 'utf8')).toBe('log 3');
	});

	it('returns null instead of throwing when the directory is unusable', () => {
		const h = makeHarness({});
		mkdirSync(join(h.stateDir, 'logs'), { recursive: true });
		writeFileSync(logDirFor(h.stateDir, 'ws'), 'in the way');
		expect(openExecLog(h.stateDir, 'ws', 'header')).toBeNull();
	});
});

describe('exec output and exit codes', () => {
	const base = {
		operation: 'exec' as const,
		workspace: '/w',
		workspaceName: 'w',
		durationMs: 4200,
		containerIds: ['c1'],
		logPath: '/state/logs/x/exec/a.log',
		command: ['npm', 'test'],
		stdout: 'out',
		stderr: 'err',
		truncated: { stdout: false, stderr: true },
	};
	const ran = (exitCode: number): ExecResult => ({
		...base,
		outcome: 'success',
		message:
			exitCode === 0 ? 'npm test' : `npm test exited with code ${exitCode}`,
		exitCode,
	});
	const timedOut: ExecResult = {
		...base,
		outcome: 'failed',
		message: 'timed out',
		problem: { code: 'COMMAND_TIMEOUT', summary: 'timed out' },
	};

	it('exits with the command’s own code when it ran (DD-6)', () => {
		expect(exitCodeForExec(ran(0))).toBe(0);
		expect(exitCodeForExec(ran(3))).toBe(3);
		expect(exitCodeForExec(ran(127))).toBe(127);
	});

	it('exits with Bring’s codes when the command did not run to its end', () => {
		expect(exitCodeForExec(timedOut)).toBe(124);
		expect(EXIT.timeout).toBe(124);
		expect(exitCodeForProblem('COMMAND_TIMEOUT')).toBe(EXIT.timeout);
		expect(
			exitCodeForExec({ ...base, outcome: 'interrupted', message: 'x' }),
		).toBe(130);
		expect(
			exitCodeForExec({
				...base,
				outcome: 'failed',
				message: 'x',
				problem: { code: 'DEVCONTAINER_FAILED', summary: 'not running' },
			}),
		).toBe(1);
	});

	it('--json: exec fields, with exitCode only when the command finished', () => {
		expect(execExtras(ran(1))).toEqual({
			command: ['npm', 'test'],
			exitCode: 1,
			stdout: 'out',
			stderr: 'err',
			truncated: { stdout: false, stderr: true },
		});
		expect(execExtras(timedOut)).not.toHaveProperty('exitCode');
	});

	it('--json: detach fields, omitting what does not exist', () => {
		const detached: DetachResult = {
			operation: 'exec',
			outcome: 'success',
			workspace: '/w',
			workspaceName: 'w',
			message: 'started',
			durationMs: 1,
			containerIds: [],
			command: ['srv'],
			pid: 9,
			stopCommand: 'bring . exec -- kill -15 -9',
			warnings: ['DETACH_NO_LOG'],
		};
		expect(detachExtras(detached)).toEqual({
			command: ['srv'],
			pid: 9,
			stopCommand: 'bring . exec -- kill -15 -9',
			warnings: ['DETACH_NO_LOG'],
		});
	});

	it('summary: green tick on 0, red cross and the exec log otherwise', () => {
		expect(formatExecSummary(ran(0))).toMatch(/^✓ npm test\s+4\.2s$/);
		const failed = formatExecSummary(ran(1));
		expect(failed).toContain('✗ npm test exited with code 1');
		expect(failed).toContain('Full output: /state/logs/x/exec/a.log');
		expect(failed).not.toContain('bring ');
	});
});

describe('shellQuote', () => {
	it.each([
		['.', '.'],
		['../api', '../api'],
		['~/code/my-app', '~/code/my-app'],
		['my app', "'my app'"],
		['x; rm -rf ~', "'x; rm -rf ~'"],
		["it's", "'it'\\''s'"],
		['$(whoami)', "'$(whoami)'"],
		['', "''"],
	])('%j → %s', (input, quoted) => {
		expect(shellQuote(input)).toBe(quoted);
	});
});
