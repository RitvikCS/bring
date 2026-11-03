import { describe, expect, it } from 'vitest';
import { forgetDocument } from '../../src/cli/report-forget.js';
import {
	containerDocument,
	imageDocument,
	planPrune,
} from '../../src/cli/run-inventory.js';
import type { DevContainerImageResource } from '../../src/core/resources.js';

function image(
	overrides: Partial<DevContainerImageResource>,
): DevContainerImageResource {
	return {
		id: 'sha256:aaa',
		references: [],
		displayName: '<none>',
		createdAt: '2026-11-01T00:00:00Z',
		sizeBytes: 1000,
		dangling: true,
		containerNames: [],
		descendantContainerNames: [],
		workspacePaths: [],
		workspaceNames: [],
		usage: 'unused',
		...overrides,
	};
}

describe('planPrune', () => {
	it('stages exactly the TUI prune set: unused AND dangling', () => {
		const images = [
			image({ id: 'unused-dangling', sizeBytes: 100 }),
			image({ id: 'unused-dangling-2', sizeBytes: 50 }),
			// A pinned base (digest only) is not dangling: never staged.
			image({ id: 'unused-named', dangling: false, displayName: 'app:old' }),
			image({ id: 'cached-base', usage: 'base' }),
			image({ id: 'attached', usage: 'attached', containerNames: ['c'] }),
		];
		const plan = planPrune(images);
		expect(plan.candidates.map((i) => i.id)).toEqual([
			'unused-dangling',
			'unused-dangling-2',
		]);
		expect(plan.upToBytes).toBe(150);
	});

	it('is empty when nothing qualifies', () => {
		expect(planPrune([image({ usage: 'base' })])).toEqual({
			candidates: [],
			upToBytes: 0,
		});
	});
});

describe('inventory documents', () => {
	it('marks prune candidates on images', () => {
		expect(imageDocument(image({})).pruneCandidate).toBe(true);
		expect(imageDocument(image({ usage: 'base' })).pruneCandidate).toBe(false);
	});

	it('leaves raw labels out of container documents', () => {
		const doc = containerDocument({
			id: 'c1',
			name: 'vsc-api',
			state: 'running',
			statusText: 'Up 2 hours',
			createdAt: '2026-11-01T00:00:00Z',
			imageId: 'sha256:x',
			imageName: 'vsc-api',
			ports: [],
			labels: { secret: 'value' },
			workspacePath: '/w/api',
			workspaceName: 'api',
			role: 'primary',
		});
		expect(doc).not.toHaveProperty('labels');
		expect(doc).not.toHaveProperty('serviceName');
		expect(doc).toMatchObject({
			id: 'c1',
			role: 'primary',
			workspaceName: 'api',
		});
	});
});

describe('forgetDocument', () => {
	it('keeps the plain-mode exit codes', () => {
		expect(
			forgetDocument({
				outcome: 'forgotten',
				name: 'api',
				entry: { path: '/w/api' } as never,
			}),
		).toMatchObject({
			doc: { operation: 'forget', outcome: 'success', workspace: '/w/api' },
			exitCode: 0,
		});
		expect(forgetDocument({ outcome: 'not-found', target: 'x' })).toMatchObject(
			{
				doc: { outcome: 'failed', error: { code: 'WORKSPACE_NOT_FOUND' } },
				exitCode: 3,
			},
		);
		expect(
			forgetDocument({
				outcome: 'ambiguous',
				target: 'api',
				candidates: ['/a', '/b'],
			}),
		).toMatchObject({ doc: { candidates: ['/a', '/b'] }, exitCode: 2 });
		expect(forgetDocument({ outcome: 'empty-registry' }).exitCode).toBe(0);
	});
});
