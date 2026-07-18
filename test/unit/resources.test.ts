import { describe, expect, it } from 'vitest';
import {
	type DevContainerResource,
	summarizeWorkspaceContainers,
} from '../../src/core/resources.js';

// The single containers → status reduction shared by the TUI, `bring
// status`, and `bring ls` — the three views must never disagree.

function resource(
	name: string,
	role: 'primary' | 'service',
	state = 'running',
): DevContainerResource {
	return {
		id: `id-${name}`,
		name,
		state,
		statusText: `Up 2 hours (${name})`,
		createdAt: '2026-07-16T12:00:00Z',
		imageId: `sha256:${name}`,
		imageName: `${name}:latest`,
		ports: [{ containerPort: 80, hostPort: 8080 }],
		labels: {},
		workspacePath: '/work/project',
		workspaceName: 'project',
		role,
	};
}

describe('summarizeWorkspaceContainers', () => {
	it('reduces empty, stopped, and running container sets', () => {
		expect(summarizeWorkspaceContainers([]).status).toBe('not-created');
		expect(
			summarizeWorkspaceContainers([resource('app', 'primary', 'exited')])
				.status,
		).toBe('stopped');
		expect(
			summarizeWorkspaceContainers([resource('app', 'primary')]).status,
		).toBe('running');
	});

	it('prefers the labelled primary for uptime even when a sidecar sorts first', () => {
		// The inventory sorts by name, so a Compose sidecar ("adminer") can
		// precede the primary — uptime must still be the primary's.
		const summary = summarizeWorkspaceContainers([
			resource('adminer', 'service'),
			resource('app', 'primary'),
		]);
		expect(summary.uptimeText).toBe('Up 2 hours (app)');
		expect(summary.status).toBe('running');
		expect(summary.containerIds).toEqual(['id-adminer', 'id-app']);
	});

	it('falls back to any running container when no primary exists', () => {
		const summary = summarizeWorkspaceContainers([
			resource('db', 'service', 'exited'),
			resource('cache', 'service'),
		]);
		expect(summary.uptimeText).toBe('Up 2 hours (cache)');
	});
});
