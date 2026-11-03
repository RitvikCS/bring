import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	EXEC_CAPTURE_BYTES,
	execCommand,
	parseDetachOutput,
	startDetached,
	stopGroupScript,
	tailBytes,
} from '../../src/application/exec-command.js';
import { formatExecSummary } from '../../src/direct/format-result.js';
import {
	EXEC_LOG_RETENTION,
	latestLogPath,
	logDirFor,
	writeExecLog,
} from '../../src/stores/log-store.js';
import {
	makeHarness,
	RUNNING_PS,
	STOPPED_PS,
} from '../helpers/fake-workspace.js';

function argvLog(harness: { argvFile: string }): string {
	return existsSync(harness.argvFile)
		? readFileSync(harness.argvFile, 'utf8')
		: '';
}

/** A fake devcontainer that logs its argv, then runs `body`. */
function devcontainer(argvFile: string, body: string): string {
	return `printf '%s\\n' "devcontainer $*" >> "${argvFile}"\n${body}`;
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

	it('passes the exit code through and keeps stdout and stderr apart', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: devcontainer(
				'/dev/null',
				'echo hi\necho oops >&2\nexit 3',
			),
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

	it('runs the command under the pgid wrapper with the resolved config', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		h.ctx.devcontainerExe = join(h.binDir, 'devcontainer');
		writeFileSync(
			h.ctx.devcontainerExe,
			`#!/bin/sh\n${devcontainer(h.argvFile, 'exit 0')}\n`,
			{ mode: 0o755 },
		);
		await execCommand(h.ctx, h.workspace, ['npm', 'test'], {
			config: h.workspace.configPath,
		});
		const line = argvLog(h).trim().split('\n').at(-1) ?? '';
		expect(line).toContain(
			`exec --workspace-folder ${h.workspace.rootPath} --config ${h.workspace.configPath} sh -c`,
		);
		expect(line).toMatch(/echo \$\$ > \/tmp\/bring-exec-[0-9a-f]+\.pgid/);
		expect(line).toMatch(/bring-exec npm test$/);
	});

	it('streams output live through onOutput', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo live',
		});
		const chunks: string[] = [];
		await execCommand(h.ctx, h.workspace, ['x'], {
			onOutput: (stream, chunk) => chunks.push(`${stream}:${chunk}`),
		});
		expect(chunks.join('')).toBe('stdout:live\n');
	});

	it('writes the full output to an exec log and never touches latest.log', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo full-output',
		});
		const latest = latestLogPath(h.stateDir, h.workspace.identity);
		mkdirSync(logDirFor(h.stateDir, h.workspace.identity), { recursive: true });
		writeFileSync(latest, 'the failed build log');
		const result = await execCommand(h.ctx, h.workspace, ['echo', 'x']);
		expect(result.logPath).toContain(
			join('logs', h.workspace.identity, 'exec'),
		);
		const log = readFileSync(result.logPath as string, 'utf8');
		expect(log).toContain('# bring exec: ["echo","x"]');
		expect(log).toContain('# exit:     0');
		expect(log).toContain('full-output');
		expect(readFileSync(latest, 'utf8')).toBe('the failed build log');
	});

	it('keeps only the last 16 KiB per stream and says so', async () => {
		// 3000 lines of 10 bytes = 30000 bytes, using builtins only.
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript:
				'i=0\nwhile [ $i -lt 3000 ]; do echo "line-$((i % 10))xxx"; i=$((i+1)); done',
		});
		const result = await execCommand(h.ctx, h.workspace, ['big']);
		expect(result.truncated.stdout).toBe(true);
		expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
			EXEC_CAPTURE_BYTES,
		);
		expect(result.stdout.endsWith('line-9xxx\n')).toBe(true);
		const log = readFileSync(result.logPath as string, 'utf8');
		expect(log.split('\n').filter((l) => l.startsWith('line-')).length).toBe(
			3000,
		);
	});

	it('stops the process group inside the container on timeout (COMMAND_TIMEOUT)', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		const pidFile = join(h.binDir, 'main.pid');
		// Main call: become a long sleep. Stop call (`kill -15 -$g`): kill it,
		// the way the in-container group kill ends the host-side exec.
		writeFileSync(
			h.ctx.devcontainerExe,
			`#!/bin/sh\n${devcontainer(
				h.argvFile,
				`case "$*" in
	*"kill -15"*) kill "$(cat "${pidFile}")"; exit 0 ;;
	*bring-exec*) echo $$ > "${pidFile}"; echo started; exec /bin/sleep 30 ;;
esac`,
			)}\n`,
			{ mode: 0o755 },
		);
		const started = Date.now();
		const result = await execCommand(h.ctx, h.workspace, ['sleep', '30'], {
			timeoutMs: 300,
		});
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.outcome).toBe('failed');
		expect(result.problem).toMatchObject({ code: 'COMMAND_TIMEOUT' });
		expect(result.problem?.summary).toContain('did not finish within 0s');
		expect(result.stdout).toBe('started\n');
		expect(argvLog(h)).toContain('kill -15 -$g');
		expect(readFileSync(result.logPath as string, 'utf8')).toContain(
			'stopped after timeout',
		);
	});

	it('stops the group inside the container after Ctrl+C', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		writeFileSync(
			h.ctx.devcontainerExe,
			`#!/bin/sh\n${devcontainer(
				h.argvFile,
				`case "$*" in
	*"kill -15"*) exit 0 ;;
	*bring-exec*) exec /bin/sleep 30 ;;
esac`,
			)}\n`,
			{ mode: 0o755 },
		);
		const pending = execCommand(h.ctx, h.workspace, ['sleep', '30']);
		await new Promise((resolve) => setTimeout(resolve, 300));
		process.emit('SIGINT');
		const result = await pending;
		expect(result.outcome).toBe('interrupted');
		expect(argvLog(h)).toContain('kill -15 -$g');
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
			devcontainerScript: 'echo "bring:pid=559"',
		});
		const result = await startDetached(h.ctx, h.workspace, [
			'npm',
			'run',
			'dev',
		]);
		expect(result).toMatchObject({
			outcome: 'success',
			pid: 559,
			stopCommand: 'bring . exec -- kill -15 -559',
			warnings: [],
			message: `started npm run dev in ${result.workspaceName} (pid 559)`,
		});
		expect(result.containerLogPath).toMatch(
			/^\/tmp\/bring-detached-[0-9a-f]+\.log$/,
		);
		expect(result.tailCommand).toBe(
			`bring . exec -- tail -n 100 ${result.containerLogPath}`,
		);
	});

	it('falls back to a plain pid kill without setsid', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'echo bring:no-setsid\necho "bring:pid=42"',
		});
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.stopCommand).toBe('bring . exec -- kill -15 42');
		expect(result.warnings).toEqual(['DETACH_NO_SETSID']);
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

	it('refuses a stopped workspace', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await startDetached(h.ctx, h.workspace, ['srv']);
		expect(result.problem?.remedy).toBe('bring . up');
	});
});

describe('exec helpers', () => {
	it('parses detach output defensively', () => {
		expect(parseDetachOutput('noise\nbring:pid=12\n')).toEqual({
			pid: 12,
			noSetsid: false,
			missing: false,
		});
		expect(parseDetachOutput('bring:pid=abc')).toMatchObject({
			pid: undefined,
		});
		expect(parseDetachOutput('bring:pid=-3')).toMatchObject({ pid: undefined });
	});

	it('uses the numeric group-kill form dash accepts, then SIGKILL', () => {
		const script = stopGroupScript('/tmp/bring-exec-1.pgid', 5);
		expect(script).toContain('kill -15 -$g');
		expect(script).toContain('[ $i -lt 50 ]');
		expect(script).toContain('kill -9 -$g');
		expect(script).not.toContain('kill -s');
		expect(script).not.toContain('kill -TERM --');
	});

	it('cuts tails on a UTF-8 boundary', () => {
		const text = `${'é'.repeat(10)}end`; // é is 2 bytes
		const tail = tailBytes(text, 6);
		expect(tail.truncated).toBe(true);
		expect(tail.text).toBe('éend'.slice(-4));
		expect(tail.text).not.toContain('�');
		expect(tailBytes('short', 100)).toEqual({
			text: 'short',
			truncated: false,
		});
	});

	it('retains the last 20 exec logs', () => {
		const h = makeHarness({});
		for (let i = 0; i < EXEC_LOG_RETENTION + 3; i++) {
			writeExecLog(
				h.stateDir,
				'ws',
				`log ${i}`,
				new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
			);
		}
		const dir = join(logDirFor(h.stateDir, 'ws'), 'exec');
		const names = readdirSync(dir).sort();
		expect(names).toHaveLength(EXEC_LOG_RETENTION);
		expect(readFileSync(join(dir, names[0] as string), 'utf8')).toBe('log 3');
	});

	it('marks a nonzero exit red and points at the exec log', () => {
		const base = {
			operation: 'exec' as const,
			workspace: '/w',
			workspaceName: 'w',
			durationMs: 4200,
			containerIds: [],
			logPath: '/state/logs/x/exec/a.log',
		};
		expect(
			formatExecSummary({
				...base,
				outcome: 'success',
				message: 'npm test',
				exitCode: 0,
			}),
		).toMatch(/^✓ npm test\s+4\.2s$/);
		const failed = formatExecSummary({
			...base,
			outcome: 'success',
			message: 'npm test exited with code 1',
			exitCode: 1,
		});
		expect(failed).toContain('✗ npm test exited with code 1');
		expect(failed).toContain('Full output: /state/logs/x/exec/a.log');
		expect(failed).not.toContain('bring');
	});
});
