import { basename } from 'node:path';
import {
	listAllContainers,
	listDevContainerImages,
} from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import {
	COMPOSE_PROJECT_LABEL,
	COMPOSE_SERVICE_LABEL,
	DEVCONTAINER_WORKSPACE_LABEL,
	type DevContainerImageResource,
	type DevContainerResource,
	type DockerContainerResource,
	type ResourceInventory,
} from '../core/resources.js';

export type ResourceInventoryResult =
	| { ok: true; inventory: ResourceInventory }
	| { ok: false; problem: BringProblem };

/**
 * Coordinated Phase 2 inventory. Container relationships are resolved first,
 * then their exact image ids are added to the metadata-labelled image query.
 */
export async function listResources(options: {
	dockerExe: string;
	env?: NodeJS.ProcessEnv;
	now?: Date;
	/** Image inspection is intentionally lazy; exact sizes can be expensive. */
	includeImages?: boolean;
}): Promise<ResourceInventoryResult> {
	const allContainers = await listAllContainers(options.dockerExe, {
		env: options.env,
	});
	if (!allContainers.ok) {
		return failed(
			`Docker could not inspect containers: ${allContainers.message}`,
		);
	}
	const containers = identifyDevContainerResources(allContainers.value);
	if (options.includeImages === false) {
		return {
			ok: true,
			inventory: {
				containers,
				images: [],
				refreshedAt: (options.now ?? new Date()).toISOString(),
			},
		};
	}
	const listedImages = await listDevContainerImages(
		options.dockerExe,
		containers.map((container) => container.imageId),
		{ env: options.env },
	);
	if (!listedImages.ok) {
		return failed(`Docker could not inspect images: ${listedImages.message}`);
	}
	return {
		ok: true,
		inventory: {
			containers,
			images: addImageImpact(
				listedImages.value,
				allContainers.value,
				containers,
			),
			refreshedAt: (options.now ?? new Date()).toISOString(),
		},
	};
}

/**
 * Seed from the upstream workspace label. If a seed belongs to a Compose
 * project, every container in that project is an intentional sidecar and is
 * included with the seed's workspace association.
 */
export function identifyDevContainerResources(
	all: readonly DockerContainerResource[],
): DevContainerResource[] {
	const composeWorkspaces = new Map<string, string>();
	for (const container of all) {
		const workspace = container.labels[DEVCONTAINER_WORKSPACE_LABEL];
		const project = container.labels[COMPOSE_PROJECT_LABEL];
		if (workspace !== undefined && project !== undefined) {
			composeWorkspaces.set(project, workspace);
		}
	}
	const resources: DevContainerResource[] = [];
	for (const container of all) {
		const directWorkspace = container.labels[DEVCONTAINER_WORKSPACE_LABEL];
		const composeProject = container.labels[COMPOSE_PROJECT_LABEL];
		const workspacePath =
			directWorkspace ??
			(composeProject === undefined
				? undefined
				: composeWorkspaces.get(composeProject));
		if (workspacePath === undefined) {
			continue;
		}
		const serviceName = container.labels[COMPOSE_SERVICE_LABEL];
		resources.push({
			...container,
			workspacePath,
			workspaceName: basename(workspacePath),
			role: directWorkspace !== undefined ? 'primary' : 'service',
			...(serviceName === undefined ? {} : { serviceName }),
		});
	}
	return resources.sort((a, b) => {
		if (a.state === 'running' && b.state !== 'running') {
			return -1;
		}
		if (a.state !== 'running' && b.state === 'running') {
			return 1;
		}
		return (
			a.workspaceName.localeCompare(b.workspaceName) ||
			a.name.localeCompare(b.name)
		);
	});
}

export function addImageImpact(
	images: readonly Omit<
		DevContainerImageResource,
		'containerNames' | 'workspacePaths' | 'workspaceNames' | 'inUse'
	>[],
	allContainers: readonly DockerContainerResource[],
	devContainers: readonly DevContainerResource[],
): DevContainerImageResource[] {
	return images
		.map((image) => {
			const users = allContainers.filter(
				(container) => container.imageId === image.id,
			);
			const devUsers = devContainers.filter(
				(container) => container.imageId === image.id,
			);
			const workspacePaths = [
				...new Set(devUsers.map((container) => container.workspacePath)),
			];
			return {
				...image,
				containerNames: users.map((container) => container.name).sort(),
				workspacePaths,
				workspaceNames: workspacePaths.map((path) => basename(path)),
				inUse: users.length > 0,
			};
		})
		.sort((a, b) => {
			if (a.inUse !== b.inUse) {
				return a.inUse ? -1 : 1;
			}
			if (a.dangling !== b.dangling) {
				return a.dangling ? 1 : -1;
			}
			return b.createdAt.localeCompare(a.createdAt);
		});
}

function failed(summary: string): ResourceInventoryResult {
	return {
		ok: false,
		problem: {
			code: 'DOCKER_FAILED',
			summary,
			remedy: 'bring doctor',
		},
	};
}
