import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bringDown } from '../../src/application/bring-down.js';
import { bringUp } from '../../src/application/bring-up.js';
import { getSnapshot } from '../../src/application/get-status.js';
import { openShell } from '../../src/application/open-shell.js';
import { acquireOperationLock } from '../../src/stores/op-lock.js';
import {
	loadState,
	rememberDotfilesRepository,
} from '../../src/stores/workspace-store.js';
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

describe('getSnapshot', () => {
	it.each([
		[RUNNING_PS, 'running'],
		[STOPPED_PS, 'stopped'],
		['', 'not-created'],
	])('maps docker state to workspace status (%#)', async (ps, status) => {
		const h = makeHarness({ psOutput: ps });
		const result = await getSnapshot(h.ctx, h.workspace);
		expect(result).toMatchObject({ ok: true, snapshot: { status } });
	});

	it('reports a docker failure as DOCKER_FAILED', async () => {
		const h = makeHarness({ dockerScript: 'echo "no daemon" >&2\nexit 1' });
		const result = await getSnapshot(h.ctx, h.workspace);
		expect(result).toMatchObject({
			ok: false,
			problem: { code: 'DOCKER_FAILED' },
		});
	});
});

describe('bringUp', () => {
	it('starts a not-yet-created workspace and remembers it', async () => {
		const h = makeHarness({ psOutput: '' });
		const result = await bringUp(h.ctx, h.workspace);

		expect(result.outcome).toBe('success');
		expect(result.containerIds).toEqual(['new123']);
		expect(argvLog(h)).toContain(
			`devcontainer up --workspace-folder ${h.workspace.rootPath}`,
		);
		expect(loadState(h.ctx.stateFile).workspaces).toHaveLength(1);
		expect(result.logPath).toBeDefined();
		const stages = h.events
			.filter((e) => e.type === 'stage')
			.map((e) => (e.type === 'stage' ? e.stage : ''));
		expect(stages).toEqual(['validating', 'starting', 'ready']);
	});

	it('is idempotent: already running is a fast success', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		const result = await bringUp(h.ctx, h.workspace);
		expect(result.outcome).toBe('success');
		expect(result.message).toContain('already running');
		expect(argvLog(h)).not.toContain('devcontainer up');
	});

	it('classifies a failed up and persists the log', async () => {
		const h = makeHarness({
			psOutput: '',
			devcontainerScript:
				'echo "postCreateCommand failed with exit code 127"\nexit 1',
		});
		const result = await bringUp(h.ctx, h.workspace);
		expect(result.outcome).toBe('failed');
		expect(result.problem?.summary).toContain('lifecycle command');
		expect(result.logPath).toBeDefined();
		if (result.logPath !== undefined) {
			expect(readFileSync(result.logPath, 'utf8')).toContain(
				'postCreateCommand failed',
			);
		}
	});

	it('returns OPERATION_CONFLICT while another operation holds the lock', async () => {
		const h = makeHarness({ psOutput: '' });
		const lock = acquireOperationLock(h.stateDir, h.workspace.identity);
		expect(lock.ok).toBe(true);
		const result = await bringUp(h.ctx, h.workspace);
		expect(result).toMatchObject({
			outcome: 'failed',
			problem: { code: 'OPERATION_CONFLICT' },
		});
		if (lock.ok) {
			lock.release();
		}
	});

	it('refuses rebuild when the CLI lacks the flags', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await bringUp(h.ctx, h.workspace, { rebuild: true });
		expect(result).toMatchObject({
			operation: 'rebuild',
			outcome: 'failed',
			problem: { code: 'UNSUPPORTED_CAPABILITY' },
		});
	});

	it('rebuilds with --remove-existing-container when supported', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: `if [ "$1" = "up" ] && [ "$2" = "--help" ]; then
	echo "  --remove-existing-container"
	echo "  --build-no-cache"
	exit 0
fi
printf '%s\\n' "devcontainer $*" >> "$0.argv"
echo '{"outcome":"success","containerId":"rebuilt1"}'`,
		});
		const result = await bringUp(h.ctx, h.workspace, {
			rebuild: true,
			noCache: true,
		});
		expect(result.outcome).toBe('success');
		const recorded = readFileSync(`${h.ctx.devcontainerExe}.argv`, 'utf8');
		expect(recorded).toContain('--remove-existing-container');
		expect(recorded).toContain('--build-no-cache');
	});
});

describe('bringUp dotfiles (A6)', () => {
	const withDotfilesSupport = `if [ "$1" = "up" ] && [ "$2" = "--help" ]; then
	echo "  --remove-existing-container"
	echo "  --build-no-cache"
	echo "  --dotfiles-repository"
	exit 0
fi
printf '%s\\n' "devcontainer $*" >> "$0.argv"
echo '{"outcome":"success","containerId":"new123"}'`;

	it('passes an explicit repo through and remembers it on success', async () => {
		const h = makeHarness({
			psOutput: '',
			devcontainerScript: withDotfilesSupport,
		});
		const result = await bringUp(h.ctx, h.workspace, {
			dotfiles: 'https://github.com/u/dotfiles',
		});
		expect(result.outcome).toBe('success');
		const recorded = readFileSync(`${h.ctx.devcontainerExe}.argv`, 'utf8');
		expect(recorded).toContain(
			'--dotfiles-repository https://github.com/u/dotfiles',
		);
		expect(loadState(h.ctx.stateFile).dotfilesRepository).toBe(
			'https://github.com/u/dotfiles',
		);
	});

	it('applies the remembered default without a capability probe', async () => {
		const h = makeHarness({ psOutput: '' });
		rememberDotfilesRepository(
			h.ctx.stateFile,
			'https://github.com/u/dotfiles',
		);
		const result = await bringUp(h.ctx, h.workspace);
		expect(result.outcome).toBe('success');
		// The default fake logs every call: no `up --help` probe ran.
		expect(argvLog(h)).not.toContain('up --help');
		expect(argvLog(h)).toContain(
			'--dotfiles-repository https://github.com/u/dotfiles',
		);
	});

	it('dotfiles: false skips once and keeps the remembered default', async () => {
		const h = makeHarness({ psOutput: '' });
		rememberDotfilesRepository(
			h.ctx.stateFile,
			'https://github.com/u/dotfiles',
		);
		const result = await bringUp(h.ctx, h.workspace, { dotfiles: false });
		expect(result.outcome).toBe('success');
		expect(argvLog(h)).not.toContain('--dotfiles-repository');
		expect(loadState(h.ctx.stateFile).dotfilesRepository).toBe(
			'https://github.com/u/dotfiles',
		);
	});

	it('refuses an explicit repo when the CLI lacks the flag', async () => {
		const h = makeHarness({ psOutput: '' });
		const result = await bringUp(h.ctx, h.workspace, {
			dotfiles: 'https://github.com/u/dotfiles',
		});
		expect(result).toMatchObject({
			outcome: 'failed',
			problem: { code: 'UNSUPPORTED_CAPABILITY' },
		});
		expect(loadState(h.ctx.stateFile).dotfilesRepository).toBeUndefined();
	});
});

describe('bringDown', () => {
	it('stops a running workspace and keeps its containers', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		const result = await bringDown(h.ctx, h.workspace);
		expect(result.outcome).toBe('success');
		expect(result.message).toContain('stopped');
		expect(result.message).toContain('kept');
		expect(argvLog(h)).toContain('docker stop run1');
		expect(argvLog(h)).not.toContain('docker rm');
	});

	it('treats already-stopped as success without touching docker', async () => {
		const h = makeHarness({ psOutput: '' });
		const result = await bringDown(h.ctx, h.workspace);
		expect(result.outcome).toBe('success');
		expect(result.message).toContain('already stopped');
		expect(argvLog(h)).not.toContain('docker stop');
	});

	it('remove stops then deletes containers', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		const result = await bringDown(h.ctx, h.workspace, { remove: true });
		expect(result.outcome).toBe('success');
		expect(result.message).toContain('source files untouched');
		const log = argvLog(h);
		expect(log).toContain('docker stop run1');
		expect(log).toContain('docker rm run1');
	});

	it('remove of a stopped workspace skips docker stop', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await bringDown(h.ctx, h.workspace, { remove: true });
		expect(result.outcome).toBe('success');
		const log = argvLog(h);
		expect(log).not.toContain('docker stop');
		expect(log).toContain('docker rm stop1');
	});
});

describe('openShell', () => {
	it('refuses when the workspace is not running', async () => {
		const h = makeHarness({ psOutput: STOPPED_PS });
		const result = await openShell(h.ctx, h.workspace);
		expect(result.outcome).toBe('failed');
		expect(result.problem?.remedy).toContain('up');
	});

	it('execs into a running workspace and passes the exit code through', async () => {
		const h = makeHarness({ psOutput: RUNNING_PS });
		const result = await openShell(h.ctx, h.workspace, ['true']);
		expect(result.outcome).toBe('success');
		expect(result.childExitCode).toBe(0);
	});

	it('hints when the shell command is missing (immediate 127)', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'exit 127',
		});
		const result = await openShell(h.ctx, h.workspace, ['zsh']);
		expect(result.outcome).toBe('failed');
		expect(result.problem?.summary).toContain('not available');
		expect(result.childExitCode).toBe(127);
	});

	it('passes a late 127 through as a normal close — `exit` propagates the last in-shell status', async () => {
		const h = makeHarness({
			psOutput: RUNNING_PS,
			devcontainerScript: 'exit 127',
		});
		const result = await openShell(h.ctx, h.workspace, ['bash'], undefined, {
			fastFailWindowMs: 0,
		});
		expect(result.outcome).toBe('success');
		expect(result.childExitCode).toBe(127);
	});
});
