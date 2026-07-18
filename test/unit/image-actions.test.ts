import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removeImageResources } from '../../src/application/image-actions.js';
import type {
	DevContainerImageResource,
	ImageUsage,
} from '../../src/core/resources.js';
import { workspaceIdentity } from '../../src/core/workspace-resolver.js';
import { acquireOperationLock } from '../../src/stores/op-lock.js';
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
	it('removes tagged images by reference without force or parent pruning', async () => {
		const harness = makeHarness({});
		const result = await removeImageResources(harness.ctx, [
			image('one'),
			image('two'),
		]);
		expect(result).toEqual({ ok: true, message: '2 images removed' });
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker image rm --no-prune one:latest two:latest');
		expect(log).not.toContain('--force');
	});

	it('untags every reference of a multi-tagged image instead of forcing', async () => {
		// `docker image rm <id>` refuses a forceless removal when several
		// repositories reference the image; removing each reference succeeds.
		const harness = makeHarness({});
		const multi = {
			...image('multi'),
			references: ['multi:latest', 'multi:dev'],
		};
		const result = await removeImageResources(harness.ctx, [multi]);
		expect(result.ok).toBe(true);
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker image rm --no-prune multi:latest multi:dev');
		expect(log).not.toContain('sha256:multi');
	});

	it('removes an untagged (dangling) image by its exact id', async () => {
		const harness = makeHarness({});
		const dangling = {
			...image('gone'),
			references: [],
			displayName: '<none>:<none>',
			dangling: true,
		};
		const result = await removeImageResources(harness.ctx, [dangling]);
		expect(result.ok).toBe(true);
		expect(readFileSync(harness.argvFile, 'utf8')).toContain(
			'docker image rm --no-prune sha256:gone',
		);
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
		expect(log).toContain('docker image rm --no-prune base:latest');
		expect(log).not.toContain('--force');
	});

	it('refuses to race an operation holding an impacted workspace lock', async () => {
		const harness = makeHarness({});
		const lock = acquireOperationLock(
			harness.ctx.stateDir,
			workspaceIdentity('/work/project'),
		);
		expect(lock.ok).toBe(true);
		try {
			const result = await removeImageResources(harness.ctx, [
				image('base', 'base'),
			]);
			expect(result.ok).toBe(false);
			expect(!result.ok && result.problem.code).toBe('OPERATION_CONFLICT');
			// Docker was never invoked — the fake logs argv on every call, so
			// the log file not existing at all is the strongest possible proof.
			expect(existsSync(harness.argvFile)).toBe(false);
		} finally {
			if (lock.ok) {
				lock.release();
			}
		}
	});
});
