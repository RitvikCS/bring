import { describe, expect, it } from 'vitest';
import type { OperationResult } from '../../src/core/operation-events.js';
import {
	INITIAL_STATE,
	orderWorkspaces,
	reduce,
	relativeTime,
	selectedWorkspace,
	statusSymbol,
	type TuiState,
	type TuiWorkspace,
} from '../../src/tui/state.js';
import { makeWorkspace } from '../helpers/tui-fixtures.js';

// Reducer transitions (spec §11.5) as pure function tests.

function readyState(workspaces: TuiWorkspace[]): TuiState {
	return reduce(INITIAL_STATE, { type: 'loaded', workspaces });
}

describe('orderWorkspaces (§12.1)', () => {
	it('orders busy, running, failed, stopped-by-MRU, missing', () => {
		const ordered = orderWorkspaces([
			makeWorkspace('missing', 'missing-config'),
			makeWorkspace('stopped-old', 'stopped', '2026-07-01T00:00:00.000Z'),
			makeWorkspace('running', 'running'),
			makeWorkspace('failed', 'failed'),
			makeWorkspace('stopped-new', 'stopped', '2026-07-10T00:00:00.000Z'),
			makeWorkspace('building', 'rebuilding'),
		]);
		expect(ordered.map((w) => w.name)).toEqual([
			'building',
			'running',
			'failed',
			'stopped-new',
			'stopped-old',
			'missing',
		]);
	});
});

describe('loading and refreshing', () => {
	it('loaded selects the first workspace and becomes ready', () => {
		const state = readyState([
			makeWorkspace('a', 'stopped'),
			makeWorkspace('b', 'running'),
		]);
		expect(state.phase).toBe('ready');
		// running outranks stopped, so b is first and selected.
		expect(selectedWorkspace(state)?.name).toBe('b');
	});

	it('refreshed preserves the selection by path across reordering', () => {
		let state = readyState([
			makeWorkspace('a', 'running'),
			makeWorkspace('b', 'stopped'),
		]);
		state = reduce(state, { type: 'move-selection', delta: 1 });
		expect(selectedWorkspace(state)?.name).toBe('b');
		state = reduce(state, {
			type: 'refreshed',
			workspaces: [
				makeWorkspace('a', 'stopped'),
				makeWorkspace('b', 'running'),
			],
		});
		expect(selectedWorkspace(state)?.name).toBe('b');
	});

	it('refreshed keeps a same-session failure the snapshot cannot see', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'operation-started',
			operation: 'up',
			workspace: makeWorkspace('a', 'stopped'),
		});
		state = reduce(state, {
			type: 'operation-completed',
			result: failedResult('a'),
		});
		state = reduce(state, {
			type: 'refreshed',
			workspaces: [makeWorkspace('a', 'stopped')],
		});
		expect(selectedWorkspace(state)?.status).toBe('failed');
		expect(selectedWorkspace(state)?.problem?.summary).toBe('boom');
	});

	it('a workspace that turns up running clears the failure memory', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'operation-started',
			operation: 'up',
			workspace: makeWorkspace('a', 'stopped'),
		});
		state = reduce(state, {
			type: 'operation-completed',
			result: failedResult('a'),
		});
		state = reduce(state, {
			type: 'refreshed',
			workspaces: [makeWorkspace('a', 'running')],
		});
		expect(selectedWorkspace(state)?.status).toBe('running');
	});
});

describe('selection movement', () => {
	it('clamps at both ends', () => {
		let state = readyState([
			makeWorkspace('a', 'stopped', '2026-07-03T00:00:00.000Z'),
			makeWorkspace('b', 'stopped', '2026-07-02T00:00:00.000Z'),
		]);
		state = reduce(state, { type: 'move-selection', delta: -1 });
		expect(selectedWorkspace(state)?.name).toBe('a');
		state = reduce(state, { type: 'move-selection', delta: 1 });
		state = reduce(state, { type: 'move-selection', delta: 1 });
		expect(selectedWorkspace(state)?.name).toBe('b');
	});
});

describe('operation lifecycle', () => {
	it('started marks the workspace busy and clears any modal', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, { type: 'open-confirm-remove' });
		expect(state.modal?.kind).toBe('confirm-remove');
		state = reduce(state, {
			type: 'operation-started',
			operation: 'remove',
			workspace: makeWorkspace('a', 'stopped'),
		});
		expect(state.modal).toBeNull();
		expect(selectedWorkspace(state)?.status).toBe('removing');
		expect(state.operation?.operation).toBe('remove');
	});

	it('collects stages in arrival order with stable sequence numbers', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'operation-started',
			operation: 'up',
			workspace: makeWorkspace('a', 'stopped'),
		});
		state = reduce(state, {
			type: 'operation-stage',
			stage: 'validating',
			message: 'Checking a…',
		});
		state = reduce(state, {
			type: 'operation-stage',
			stage: 'starting',
			message: 'Starting a…',
		});
		expect(state.operation?.stages.map((s) => s.seq)).toEqual([0, 1]);
	});

	it('keeps the latest safe output line, stripping ANSI noise', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'operation-started',
			operation: 'up',
			workspace: makeWorkspace('a', 'stopped'),
		});
		const esc = String.fromCharCode(27);
		state = reduce(state, {
			type: 'operation-output',
			chunk: `${esc}[32mStep 5/9${esc}[0m : RUN apt-get update\n\n`,
		});
		expect(state.operation?.lastOutput).toBe('Step 5/9 : RUN apt-get update');
	});

	it('a failed completion marks the workspace failed with the problem', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'operation-started',
			operation: 'up',
			workspace: makeWorkspace('a', 'stopped'),
		});
		state = reduce(state, {
			type: 'operation-completed',
			result: failedResult('a'),
		});
		expect(state.operation?.result?.outcome).toBe('failed');
		expect(selectedWorkspace(state)?.status).toBe('failed');
		expect(state.statusMessage).toContain('boom');
	});
});

describe('modals never bypass confirmation', () => {
	it('open-confirm-remove only opens a modal — nothing is mutated', () => {
		const before = readyState([makeWorkspace('a', 'running')]);
		const after = reduce(before, { type: 'open-confirm-remove' });
		expect(after.modal).toEqual({
			kind: 'confirm-remove',
			workspacePath: '/home/user/a',
		});
		expect(after.workspaces).toEqual(before.workspaces);
		expect(after.operation).toBeNull();
	});

	it('open-confirm-rebuild only opens a modal — nothing is mutated', () => {
		const before = readyState([makeWorkspace('a', 'running')]);
		const after = reduce(before, { type: 'open-confirm-rebuild' });
		expect(after.modal).toEqual({
			kind: 'confirm-rebuild',
			workspacePath: '/home/user/a',
		});
		expect(after.workspaces).toEqual(before.workspaces);
		expect(after.operation).toBeNull();
	});
});

describe('relativeTime', () => {
	const now = Date.parse('2026-07-16T12:00:00.000Z');
	it('renders human distances and falls back to a date', () => {
		expect(relativeTime('2026-07-16T11:59:30.000Z', now)).toBe('just now');
		expect(relativeTime('2026-07-16T11:57:00.000Z', now)).toBe('3 minutes ago');
		expect(relativeTime('2026-07-16T07:00:00.000Z', now)).toBe('5 hours ago');
		expect(relativeTime('2026-07-14T12:00:00.000Z', now)).toBe('2 days ago');
		expect(relativeTime('2026-01-01T00:00:00.000Z', now)).toBe('2026-01-01');
		expect(relativeTime('not a date', now)).toBeNull();
	});
});

describe('log view', () => {
	it('sanitizes ANSI codes and tabs out of log lines', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		const esc = String.fromCharCode(27);
		state = reduce(state, {
			type: 'open-logs',
			workspaceName: 'a',
			content: `${esc}[32mok${esc}[0m\tdone\n`,
		});
		expect(state.logView?.lines).toEqual(['ok  done']);
	});

	it('opens with content split into lines and scrolls clamped', () => {
		let state = readyState([makeWorkspace('a', 'stopped')]);
		state = reduce(state, {
			type: 'open-logs',
			workspaceName: 'a',
			content: 'one\ntwo\nthree\n',
		});
		expect(state.logView?.lines).toEqual(['one', 'two', 'three']);
		state = reduce(state, { type: 'scroll-logs', delta: -5 });
		expect(state.logView?.scroll).toBe(0);
		state = reduce(state, { type: 'scroll-logs', delta: 99 });
		expect(state.logView?.scroll).toBe(2);
		state = reduce(state, { type: 'close-logs' });
		expect(state.logView).toBeNull();
	});
});

describe('status symbols (§12.1, no color-only signals)', () => {
	it('assigns the blueprint symbols', () => {
		expect(statusSymbol('running')).toBe('●');
		expect(statusSymbol('stopped')).toBe('○');
		expect(statusSymbol('not-created')).toBe('○');
		expect(statusSymbol('starting')).toBe('◐');
		expect(statusSymbol('stopping')).toBe('◐');
		expect(statusSymbol('rebuilding')).toBe('◆');
		expect(statusSymbol('failed')).toBe('!');
		expect(statusSymbol('missing-config')).toBe('!');
		expect(statusSymbol('unknown')).toBe('?');
	});
});

function failedResult(name: string): OperationResult {
	return {
		operation: 'up',
		outcome: 'failed',
		workspace: `/home/user/${name}`,
		workspaceName: name,
		message: 'boom',
		durationMs: 1200,
		containerIds: [],
		problem: { code: 'DEVCONTAINER_FAILED', summary: 'boom' },
	};
}
