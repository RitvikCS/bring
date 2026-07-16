import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removeImageResources } from '../../src/application/image-actions.js';
import type { DevContainerImageResource } from '../../src/core/resources.js';
import { makeHarness } from '../helpers/fake-workspace.js';

function image(name: string, inUse = false): DevContainerImageResource {
	return {
		id: `sha256:${name}`,
		references: [`${name}:latest`],
		displayName: `${name}:latest`,
		createdAt: '2026-07-16T12:00:00Z',
		sizeBytes: 1000,
		dangling: false,
		containerNames: inUse ? ['running-container'] : [],
		workspacePaths: inUse ? ['/work/project'] : [],
		workspaceNames: inUse ? ['project'] : [],
		inUse,
	};
}

describe('removeImageResources', () => {
	it('removes the exact ids without force or implicit parent pruning', async () => {
		const harness = makeHarness({});
		const result = await removeImageResources(harness.ctx, [
			image('one'),
			image('two'),
		]);
		expect(result).toEqual({ ok: true, message: '2 images removed' });
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker image rm --no-prune sha256:one sha256:two');
		expect(log).not.toContain('--force');
	});

	it('blocks an image referenced by any Docker container', async () => {
		const harness = makeHarness({});
		const result = await removeImageResources(harness.ctx, [
			image('shared', true),
		]);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('running-container');
	});
});
