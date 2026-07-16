import { describe, expect, it } from 'vitest';
import {
	addImageImpact,
	identifyDevContainerResources,
} from '../../src/application/list-resources.js';
import type {
	DevContainerImageResource,
	DockerContainerResource,
} from '../../src/core/resources.js';

function container(
	name: string,
	labels: Record<string, string>,
	imageId = `sha256:${name}`,
): DockerContainerResource {
	return {
		id: `id-${name}`,
		name,
		state: 'running',
		statusText: 'Up 2 hours',
		createdAt: '2026-07-16T12:00:00Z',
		imageId,
		imageName: `${name}:latest`,
		ports: [],
		labels,
	};
}

describe('identifyDevContainerResources', () => {
	it('includes labelled primaries and Compose sidecars, never unrelated containers', () => {
		const resources = identifyDevContainerResources([
			container('primary', {
				'devcontainer.local_folder': '/work/project',
				'com.docker.compose.project': 'project_devcontainer',
				'com.docker.compose.service': 'app',
			}),
			container('database', {
				'com.docker.compose.project': 'project_devcontainer',
				'com.docker.compose.service': 'db',
			}),
			container('standalone', {
				'devcontainer.local_folder': '/work/other',
			}),
			container('unrelated', {
				'com.docker.compose.project': 'some_other_project',
			}),
		]);

		expect(resources.map((resource) => resource.name).sort()).toEqual([
			'database',
			'primary',
			'standalone',
		]);
		expect(
			resources.find((resource) => resource.name === 'primary'),
		).toMatchObject({
			workspacePath: '/work/project',
			workspaceName: 'project',
			role: 'primary',
			serviceName: 'app',
		});
		expect(
			resources.find((resource) => resource.name === 'database'),
		).toMatchObject({
			workspacePath: '/work/project',
			workspaceName: 'project',
			role: 'service',
			serviceName: 'db',
		});
	});
});

describe('addImageImpact', () => {
	it('counts every container use but only Dev Container workspace impact', () => {
		const primary = container(
			'primary',
			{ 'devcontainer.local_folder': '/work/project' },
			'sha256:shared',
		);
		const unrelated = container('unrelated', {}, 'sha256:shared');
		const devContainers = identifyDevContainerResources([primary, unrelated]);
		const baseImage: Omit<
			DevContainerImageResource,
			'containerNames' | 'workspacePaths' | 'workspaceNames' | 'inUse'
		> = {
			id: 'sha256:shared',
			references: ['base:latest'],
			displayName: 'base:latest',
			createdAt: '2026-07-16T12:00:00Z',
			sizeBytes: 1000,
			dangling: false,
		};

		expect(
			addImageImpact([baseImage], [primary, unrelated], devContainers),
		).toEqual([
			{
				...baseImage,
				containerNames: ['primary', 'unrelated'],
				workspacePaths: ['/work/project'],
				workspaceNames: ['project'],
				inUse: true,
			},
		]);
	});
});
