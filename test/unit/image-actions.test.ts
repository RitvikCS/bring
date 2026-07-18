import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removeImageResources } from '../../src/application/image-actions.js';
import type {
	DevContainerImageResource,
	ImageUsage,
} from '../../src/core/resources.js';
import { makeHarness } from '../helpers/fake-workspace.js';

function image(
	name: string,
	usage: ImageUsage = 'unused',
): DevContainerImageResource {
	return {
		id: `sha256:${name}`,
		references: [`${name}:latest`],
		displayName: `${name}:latest`,
		createdAt: '2026-07-16T12:00:00Z',
		sizeBytes: 1000,
		dangling: false,
		containerNames: usage === 'attached' ? ['running-container'] : [],
		descendantContainerNames: usage === 'base' ? ['derived-container'] : [],
		workspacePaths: usage === 'unused' ? [] : ['/work/project'],
		workspaceNames: usage === 'unused' ? [] : ['project'],
		usage,
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
			image('shared', 'attached'),
		]);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('running-container');
	});

	it('allows an explicitly confirmed cached base without force', async () => {
		const harness = makeHarness({});
		const result = await removeImageResources(harness.ctx, [
			image('base', 'base'),
		]);
		expect(result.ok).toBe(true);
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker image rm --no-prune sha256:base');
		expect(log).not.toContain('--force');
	});
});
