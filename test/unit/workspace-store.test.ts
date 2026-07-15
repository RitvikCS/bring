import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	loadState,
	rememberDotfilesRepository,
	rememberWorkspace,
	stateFilePath,
} from '../../src/stores/workspace-store.js';

function tempStateFile(): string {
	return join(mkdtempSync(join(tmpdir(), 'bring-state-')), 'state.json');
}

describe('workspace store', () => {
	it('computes the state file under the bring state dir', () => {
		expect(stateFilePath({ XDG_STATE_HOME: '/xdg' })).toBe(
			'/xdg/bring/state.json',
		);
	});

	it('returns an empty registry when the file is missing', () => {
		expect(loadState(tempStateFile())).toEqual({
			schemaVersion: 1,
			workspaces: [],
		});
	});

	it('recovers from a corrupt state file', () => {
		const file = tempStateFile();
		writeFileSync(file, '{not json at all');
		expect(loadState(file)).toEqual({ schemaVersion: 1, workspaces: [] });
	});

	it('recovers from valid JSON with the wrong shape', () => {
		const file = tempStateFile();
		writeFileSync(file, JSON.stringify({ schemaVersion: 99, stuff: true }));
		expect(loadState(file)).toEqual({ schemaVersion: 1, workspaces: [] });
	});

	it('remembers a workspace and upserts on re-use', () => {
		const file = tempStateFile();
		const first = new Date('2026-07-14T10:00:00Z');
		const second = new Date('2026-07-14T11:00:00Z');

		rememberWorkspace(
			file,
			{ rootPath: '/proj/a', configPath: '/proj/a/.devcontainer.json' },
			first,
		);
		rememberWorkspace(
			file,
			{ rootPath: '/proj/b', configPath: '/proj/b/.devcontainer.json' },
			first,
		);
		const state = rememberWorkspace(
			file,
			{
				rootPath: '/proj/a',
				configPath: '/proj/a/.devcontainer/devcontainer.json',
			},
			second,
		);

		expect(state.workspaces).toHaveLength(2);
		expect(state.workspaces[0]).toEqual({
			path: '/proj/a',
			lastUsedAt: second.toISOString(),
			lastConfigPath: '/proj/a/.devcontainer/devcontainer.json',
		});
		// And it round-trips from disk.
		expect(loadState(file)).toEqual(state);
	});

	it('remembers a dotfiles repository without touching workspaces (A6)', () => {
		const file = tempStateFile();
		rememberWorkspace(
			file,
			{ rootPath: '/proj/a', configPath: '/proj/a/.devcontainer.json' },
			new Date('2026-07-15T10:00:00Z'),
		);
		const state = rememberDotfilesRepository(
			file,
			'https://github.com/user/dotfiles',
		);
		expect(state.dotfilesRepository).toBe('https://github.com/user/dotfiles');
		expect(state.workspaces).toHaveLength(1);
		// Round-trips, and can be overwritten by a later choice.
		expect(loadState(file).dotfilesRepository).toBe(
			'https://github.com/user/dotfiles',
		);
		rememberDotfilesRepository(file, 'https://github.com/user/other');
		expect(loadState(file).dotfilesRepository).toBe(
			'https://github.com/user/other',
		);
	});

	it('writes pretty JSON with a trailing newline', () => {
		const file = tempStateFile();
		rememberWorkspace(file, {
			rootPath: '/proj/a',
			configPath: '/proj/a/.devcontainer.json',
		});
		const raw = readFileSync(file, 'utf8');
		expect(raw.endsWith('\n')).toBe(true);
		expect(raw).toContain('  "schemaVersion": 1');
	});
});
