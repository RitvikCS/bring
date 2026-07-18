import { basename } from 'node:path';
import {
	listAllContainers,
	listDevContainerImages,
} from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import {
	COMPOSE_PROJECT_LABEL,
	COMPOSE_SERVICE_LABEL,
	COMPOSE_WORKING_DIR_LABEL,
	DEVCONTAINER_WORKSPACE_LABEL,
	type DevContainerImageResource,
	type DevContainerResource,
	type DockerContainerResource,
	type ImageUsage,
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
	/** Registered roots let orphaned Compose sidecars retain their relationship. */
	knownWorkspacePaths?: readonly string[];
}): Promise<ResourceInventoryResult> {
	const allContainers = await listAllContainers(options.dockerExe, {
		env: options.env,
	});
	if (!allContainers.ok) {
		return failed(
			`Docker could not inspect containers: ${allContainers.message}`,
		);
	}
	const containers = identifyDevContainerResources(
		allContainers.value,
		options.knownWorkspacePaths,
	);
	if (options.includeImages === false) {
		return {
			ok: true,
			inventory: {
				containers,
				// Not an empty image list — images were not inspected at all.
				images: null,
				refreshedAt: (options.now ?? new Date()).toISOString(),
			},
		};
	}
	const listedImages = await listDevContainerImages(
		options.dockerExe,
		containers.map((container) => container.imageId),
		{
			env: options.env,
			lineageImageIds: allContainers.value.map(
				(container) => container.imageId,
			),
		},
	);
	if (!listedImages.ok) {
		return failed(`Docker could not inspect images: ${listedImages.message}`);
	}
	return {
		ok: true,
		inventory: {
			containers,
			images: addImageImpact(
				listedImages.value.images,
				allContainers.value,
				containers,
				listedImages.value.layerIdsByImageId,
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
	knownWorkspacePaths: readonly string[] = [],
): DevContainerResource[] {
	const composeWorkspaces = new Map<string, string>();
	const known = new Set(knownWorkspacePaths);
	// The upstream workspace label is the authority for a project's workspace.
	for (const container of all) {
		const workspace = container.labels[DEVCONTAINER_WORKSPACE_LABEL];
		const project = container.labels[COMPOSE_PROJECT_LABEL];
		if (workspace !== undefined && project !== undefined) {
			composeWorkspaces.set(project, workspace);
		}
	}
	// The registered Compose working directory only fills gaps — projects whose
	// labelled primary is gone. It must never override a label: a compose file
	// can live under a different registered workspace than the one it serves,
	// and misattributing sidecars would point down/remove at the wrong project.
	for (const container of all) {
		const project = container.labels[COMPOSE_PROJECT_LABEL];
		const workingDir = container.labels[COMPOSE_WORKING_DIR_LABEL];
		if (
			project !== undefined &&
			workingDir !== undefined &&
			!composeWorkspaces.has(project) &&
			known.has(workingDir)
		) {
			composeWorkspaces.set(project, workingDir);
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
		| 'containerNames'
		| 'descendantContainerNames'
		| 'workspacePaths'
		| 'workspaceNames'
		| 'usage'
	>[],
	allContainers: readonly DockerContainerResource[],
	devContainers: readonly DevContainerResource[],
	layerIdsByImageId: Readonly<Record<string, readonly string[]>>,
): DevContainerImageResource[] {
	return images
		.map((image) => {
			const directUsers = allContainers.filter(
				(container) => container.imageId === image.id,
			);
			const imageLayers = layerIdsByImageId[image.id] ?? [];
			const descendantUsers = allContainers.filter(
				(container) =>
					container.imageId !== image.id &&
					isLayerAncestor(
						imageLayers,
						layerIdsByImageId[container.imageId] ?? [],
					),
			);
			const devUsers = devContainers.filter(
				(container) =>
					container.imageId === image.id ||
					isLayerAncestor(
						imageLayers,
						layerIdsByImageId[container.imageId] ?? [],
					),
			);
			const workspacePaths = [
				...new Set(devUsers.map((container) => container.workspacePath)),
			];
			const usage: ImageUsage =
				directUsers.length > 0
					? 'attached'
					: descendantUsers.length > 0
						? 'base'
						: 'unused';
			return {
				...image,
				containerNames: directUsers.map((container) => container.name).sort(),
				descendantContainerNames: descendantUsers
					.map((container) => container.name)
					.sort(),
				workspacePaths,
				workspaceNames: workspacePaths.map((path) => basename(path)),
				usage,
			};
		})
		.sort((a, b) => {
			const usageOrder = { attached: 0, base: 1, unused: 2 } as const;
			if (a.usage !== b.usage) {
				return usageOrder[a.usage] - usageOrder[b.usage];
			}
			if (a.dangling !== b.dangling) {
				return a.dangling ? 1 : -1;
			}
			return b.createdAt.localeCompare(a.createdAt);
		});
}

/** A non-empty layer chain is an ancestor when it prefixes the child chain. */
export function isLayerAncestor(
	ancestor: readonly string[],
	descendant: readonly string[],
): boolean {
	return (
		ancestor.length > 0 &&
		ancestor.length <= descendant.length &&
		ancestor.every((layer, index) => descendant[index] === layer)
	);
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
