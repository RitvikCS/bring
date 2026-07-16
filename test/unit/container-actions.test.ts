import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	mutateContainer,
	openContainerShell,
} from '../../src/application/container-actions.js';
import type { DevContainerResource } from '../../src/core/resources.js';
import { writeFakeBin } from '../helpers/fake-bin.js';
import { makeHarness } from '../helpers/fake-workspace.js';

function resource(state = 'running'): DevContainerResource {
	return {
		id: 'container-1',
		name: 'project-dev',
		state,
		statusText: 'Up 2 hours',
		createdAt: '2026-07-16T12:00:00Z',
		imageId: 'sha256:image',
		imageName: 'project:dev',
		ports: [],
		labels: { 'devcontainer.local_folder': '/work/project' },
		workspacePath: '/work/project',
		workspaceName: 'project',
		role: 'primary',
	};
}

describe('container mutations', () => {
	it('stops a running container without removing it', async () => {
		const harness = makeHarness({});
		const result = await mutateContainer(harness.ctx, resource(), 'stop');
		expect(result).toEqual({ ok: true, message: 'project-dev stopped' });
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker stop container-1');
		expect(log).not.toContain('docker rm');
	});

	it('stops then removes, never using force', async () => {
		const harness = makeHarness({});
		const result = await mutateContainer(harness.ctx, resource(), 'remove');
		expect(result.ok).toBe(true);
		const log = readFileSync(harness.argvFile, 'utf8');
		expect(log).toContain('docker stop container-1\ndocker rm container-1');
		expect(log).not.toContain('--force');
	});

	it('does not call Docker for an already-stopped stop', async () => {
		const harness = makeHarness({});
		const result = await mutateContainer(
			harness.ctx,
			resource('exited'),
			'stop',
		);
		expect(result).toEqual({
			ok: true,
			message: 'project-dev is already stopped',
		});
		expect(existsSync(harness.argvFile)).toBe(false);
	});
});

describe('container shell', () => {
	it('uses devcontainer exec with the exact container id', async () => {
		const harness = makeHarness({});
		writeFakeBin(
			harness.binDir,
			'devcontainer',
			`printf '%s\\n' "devcontainer $*" >> "${harness.argvFile}"`,
		);
		const result = await openContainerShell(harness.ctx, resource(), ['bash'], {
			fastFailWindowMs: 0,
		});
		expect(result.ok).toBe(true);
		expect(readFileSync(harness.argvFile, 'utf8')).toContain(
			'devcontainer exec --container-id container-1 bash',
		);
	});

	it('refuses a stopped container without spawning', async () => {
		const harness = makeHarness({});
		const result = await openContainerShell(harness.ctx, resource('exited'));
		expect(result.ok).toBe(false);
		expect(existsSync(harness.argvFile)).toBe(false);
	});
});
