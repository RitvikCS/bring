import { describe, expect, it } from 'vitest';
import type { OperationResult } from '../../src/core/operation-events.js';
import {
	INITIAL_STATE,
	orderWorkspaces,
	reduce,
	relativeTime,
	selectedWorkspace,
	smartMatch,
	statusSymbol,
	type TuiState,
	type TuiWorkspace,
	visibleContainers,
	visibleImages,
} from '../../src/tui/state.js';
import {
	makeContainer,
	makeImage,
	makeWorkspace,
} from '../helpers/tui-fixtures.js';

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

	it('moves the active resource selection and preserves it across refreshes', () => {
		const containers = [makeContainer('one'), makeContainer('two')];
		const images = [makeImage('first'), makeImage('second')];
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [],
			resources: { containers, images, refreshedAt: '' },
		});
		state = reduce(state, { type: 'move-section', delta: 1 });
		state = reduce(state, { type: 'move-selection', delta: 1 });
		expect(state.selectedContainerId).toBe('container-two');
		state = reduce(state, {
			type: 'refreshed',
			workspaces: [],
			resources: {
				containers: [containers[1] as (typeof containers)[number]],
				images,
				refreshedAt: '',
			},
		});
		expect(state.selectedContainerId).toBe('container-two');

		state = reduce(state, { type: 'move-section', delta: 1 });
		state = reduce(state, { type: 'move-selection', delta: 1 });
		expect(state.selectedImageId).toBe('sha256:second');
	});

	it('supports direct numbered-section state changes', () => {
		const state = reduce(readyState([]), {
			type: 'set-section',
			section: 'images',
		});
		expect(state.section).toBe('images');
		expect(state.focusedPane).toBe('list');
		expect(state.detailOpen).toBe(false);
	});
});

describe('image multi-selection and prune review', () => {
	function imageState() {
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [],
			resources: {
				containers: [],
				images: [
					makeImage('used', 'attached'),
					makeImage('base', 'base'),
					makeImage('free'),
					makeImage('old', 'unused', true),
				],
				refreshedAt: '',
			},
		});
		state = reduce(state, { type: 'move-section', delta: 1 });
		return reduce(state, { type: 'move-section', delta: 1 });
	}

	it('blocks attached images and warns before selecting a cached base', () => {
		let state = imageState();
		state = reduce(state, { type: 'toggle-image-selection' });
		expect(state.selectedImageIds).toEqual([]);
		expect(state.statusMessage).toContain('cannot be selected');
		state = reduce(state, { type: 'move-selection', delta: 1 });
		state = reduce(state, { type: 'toggle-image-selection' });
		expect(state.selectedImageIds).toEqual(['sha256:base']);
		expect(state.statusMessage).toContain('cached base');
		state = reduce(state, { type: 'toggle-image-selection' });
		expect(state.selectedImageIds).toEqual([]);
	});

	it('prune selects only unattached dangling images', () => {
		let state = imageState();
		state = reduce(state, { type: 'select-prunable-images' });
		expect(state.selectedImageIds).toEqual(['sha256:old']);
		expect(state.statusMessage).toContain('1 dangling image');
		state = reduce(state, { type: 'open-confirm-image-remove' });
		expect(state.modal).toEqual({
			kind: 'confirm-image-remove',
			imageIds: ['sha256:old'],
		});
	});

	it('preserves marks for existing removable images across refresh', () => {
		let state = imageState();
		state = reduce(state, { type: 'select-prunable-images' });
		state = reduce(state, {
			type: 'refreshed',
			workspaces: [],
			resources: {
				containers: [],
				images: [makeImage('old', 'unused', true)],
				refreshedAt: '',
			},
		});
		expect(state.selectedImageIds).toEqual(['sha256:old']);
	});
});

describe('resource filtering', () => {
	it('uses smart case', () => {
		expect(smartMatch('Interview-API', 'api')).toBe(true);
		expect(smartMatch('Interview-API', 'API')).toBe(true);
		expect(smartMatch('Interview-api', 'API')).toBe(false);
	});

	it('filters live, moves selection into results, and Esc restores the original', () => {
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [],
			resources: {
				containers: [
					makeContainer('api', 'running', 'backend'),
					makeContainer('web', 'running', 'frontend'),
				],
				images: [makeImage('python'), makeImage('node')],
				refreshedAt: '',
			},
		});
		state = reduce(state, { type: 'move-section', delta: 1 });
		state = reduce(state, { type: 'open-filter' });
		state = reduce(state, { type: 'filter-input', text: 'front' });
		expect(visibleContainers(state).map((container) => container.name)).toEqual(
			['web'],
		);
		expect(state.selectedContainerId).toBe('container-web');
		state = reduce(state, { type: 'cancel-filter' });
		expect(visibleContainers(state)).toHaveLength(2);

		state = reduce(state, { type: 'move-section', delta: 1 });
		state = reduce(state, { type: 'open-filter' });
		state = reduce(state, { type: 'filter-input', text: 'node' });
		expect(visibleImages(state).map((image) => image.displayName)).toEqual([
			'node:latest',
		]);
		state = reduce(state, { type: 'apply-filter' });
		expect(state.filters.images).toBe('node');
		state = reduce(state, { type: 'clear-filter' });
		expect(visibleImages(state)).toHaveLength(2);
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

	it('container removal opens a modal and resource operations report status', () => {
		let state = reduce(INITIAL_STATE, {
			type: 'loaded',
			workspaces: [],
			resources: {
				containers: [makeContainer('dev')],
				images: [],
				refreshedAt: '',
			},
		});
		state = reduce(state, { type: 'move-section', delta: 1 });
		state = reduce(state, { type: 'open-confirm-container-remove' });
		expect(state.modal).toEqual({
			kind: 'confirm-container-remove',
			containerId: 'container-dev',
		});
		state = reduce(state, {
			type: 'resource-operation-started',
			kind: 'remove-container',
			resourceId: 'container-dev',
			resourceName: 'dev',
		});
		expect(state.modal).toBeNull();
		expect(state.resourceOperation?.kind).toBe('remove-container');
		expect(state.statusMessage).toBe('Removing dev…');
		state = reduce(state, {
			type: 'resource-operation-completed',
			ok: true,
			message: 'dev removed',
		});
		expect(state.resourceOperation).toBeNull();
		expect(state.statusMessage).toBe('✓ dev removed');
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
