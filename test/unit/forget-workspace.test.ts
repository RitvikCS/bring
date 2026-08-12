import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	type ForgetContext,
	runForget,
} from '../../src/application/forget-workspace.js';
import { workspaceIdentity } from '../../src/core/workspace-resolver.js';
import {
	readLatestLog,
	writeOperationLog,
} from '../../src/stores/log-store.js';
import {
	forgetWorkspace,
	loadState,
	rememberWorkspace,
} from '../../src/stores/workspace-store.js';

function tempContext(): ForgetContext {
	const dir = mkdtempSync(join(tmpdir(), 'bring-forget-'));
	return { stateFile: join(dir, 'state.json'), stateDir: dir, cwd: '/cwd' };
}

function remember(ctx: ForgetContext, path: string): void {
	rememberWorkspace(ctx.stateFile, {
		rootPath: path,
		configPath: join(path, '.devcontainer.json'),
	});
}

describe('forgetWorkspace store operation', () => {
	it('removes only the matching entry and reports it', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/a');
		remember(ctx, '/proj/b');
		const removed = forgetWorkspace(ctx.stateFile, '/proj/a');
		expect(removed?.path).toBe('/proj/a');
		expect(loadState(ctx.stateFile).workspaces.map((w) => w.path)).toEqual([
			'/proj/b',
		]);
	});

	it('returns null for an unknown path without writing', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/a');
		expect(forgetWorkspace(ctx.stateFile, '/proj/zzz')).toBeNull();
		expect(loadState(ctx.stateFile).workspaces).toHaveLength(1);
	});
});

describe('bring forget resolution', () => {
	it('reports an empty registry', () => {
		const ctx = tempContext();
		expect(runForget(ctx, 'anything')).toEqual({ outcome: 'empty-registry' });
	});

	it('forgets by unique name', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/api');
		remember(ctx, '/proj/web');
		const result = runForget(ctx, 'api');
		expect(result.outcome).toBe('forgotten');
		expect(loadState(ctx.stateFile).workspaces.map((w) => w.path)).toEqual([
			'/proj/web',
		]);
	});

	it('forgets by absolute path even when the directory is gone', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/deleted-long-ago');
		const result = runForget(ctx, '/proj/deleted-long-ago');
		expect(result.outcome).toBe('forgotten');
		expect(loadState(ctx.stateFile).workspaces).toHaveLength(0);
	});

	it('resolves relative paths and `this` against cwd', () => {
		const ctx = tempContext();
		remember(ctx, '/cwd');
		remember(ctx, '/cwd/nested');
		expect(runForget(ctx, 'this').outcome).toBe('forgotten');
		expect(runForget(ctx, './nested').outcome).toBe('forgotten');
		expect(loadState(ctx.stateFile).workspaces).toHaveLength(0);
	});

	it('refuses an ambiguous name and lists the candidates', () => {
		const ctx = tempContext();
		remember(ctx, '/work/api');
		remember(ctx, '/personal/api');
		const result = runForget(ctx, 'api');
		expect(result).toEqual({
			outcome: 'ambiguous',
			target: 'api',
			candidates: ['/work/api', '/personal/api'],
		});
		expect(loadState(ctx.stateFile).workspaces).toHaveLength(2);
	});

	it('reports an unknown target', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/api');
		expect(runForget(ctx, 'nope')).toEqual({
			outcome: 'not-found',
			target: 'nope',
		});
	});

	it('clears the workspace operation logs along with the entry', () => {
		const ctx = tempContext();
		remember(ctx, '/proj/api');
		const identity = workspaceIdentity('/proj/api');
		writeOperationLog(ctx.stateDir, identity, 'old build output\n');
		expect(readLatestLog(ctx.stateDir, identity)).not.toBeNull();
		expect(runForget(ctx, 'api').outcome).toBe('forgotten');
		expect(readLatestLog(ctx.stateDir, identity)).toBeNull();
	});
});
