import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listKnownWorkspaces } from '../../src/application/list-workspaces.js';
import { rememberWorkspace } from '../../src/stores/workspace-store.js';
import { makeBinDir, writeFakeBin } from '../helpers/fake-bin.js';

const RUNNING_PS =
	'{"ID":"r1","Names":"vsc","State":"running","Image":"img","Ports":""}';

describe('listKnownWorkspaces', () => {
	it('returns live statuses, most recently used first', async () => {
		const stateFile = join(
			mkdtempSync(join(tmpdir(), 'bring-ls-')),
			'state.json',
		);
		const projA = mkdtempSync(join(tmpdir(), 'bring-ls-a-'));
		const projB = mkdtempSync(join(tmpdir(), 'bring-ls-b-'));
		rememberWorkspace(
			stateFile,
			{ rootPath: projA, configPath: join(projA, '.devcontainer.json') },
			new Date('2026-07-10T00:00:00Z'),
		);
		rememberWorkspace(
			stateFile,
			{ rootPath: projB, configPath: join(projB, '.devcontainer.json') },
			new Date('2026-07-14T00:00:00Z'),
		);

		const binDir = makeBinDir();
		// Fake docker serving the coordinated inventory: one container on the
		// host, whose workspace label ties it to projB.
		const inspectOutput = JSON.stringify([
			{
				Id: 'r1',
				Name: '/vsc',
				Created: '2026-07-16T12:00:00Z',
				Image: 'sha256:img',
				Config: {
					Image: 'img',
					Labels: { 'devcontainer.local_folder': projB },
				},
			},
		]);
		const docker = writeFakeBin(
			binDir,
			'docker',
			`case "$1 $2" in
	"ps --all") echo '${RUNNING_PS}' ;;
	"container inspect") echo '${inspectOutput}' ;;
	*) : ;;
esac`,
		);

		const listings = await listKnownWorkspaces({
			stateFile,
			dockerExe: docker,
			env: { PATH: binDir },
		});
		expect(listings.map((l) => [l.path, l.status])).toEqual([
			[projB, 'running'],
			[projA, 'not-created'],
		]);
	});

	it('degrades to unknown status without docker, and flags deleted paths', async () => {
		const stateFile = join(
			mkdtempSync(join(tmpdir(), 'bring-ls-')),
			'state.json',
		);
		const alive = mkdtempSync(join(tmpdir(), 'bring-ls-alive-'));
		rememberWorkspace(stateFile, {
			rootPath: alive,
			configPath: join(alive, '.devcontainer.json'),
		});
		rememberWorkspace(stateFile, {
			rootPath: '/gone/forever',
			configPath: '/gone/forever/.devcontainer.json',
		});

		const listings = await listKnownWorkspaces({
			stateFile,
			dockerExe: null,
			env: {},
		});
		const byPath = new Map(listings.map((l) => [l.path, l.status]));
		expect(byPath.get(alive)).toBe('unknown');
		expect(byPath.get('/gone/forever')).toBe('missing-config');
	});

	it('returns an empty list for a fresh machine', async () => {
		const stateFile = join(
			mkdtempSync(join(tmpdir(), 'bring-ls-')),
			'state.json',
		);
		expect(
			await listKnownWorkspaces({ stateFile, dockerExe: null, env: {} }),
		).toEqual([]);
	});
});
