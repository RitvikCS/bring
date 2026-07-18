import type { ForwardedPort } from './types.js';

/** Docker labels used to identify resources without guessing from names. */
export const DEVCONTAINER_WORKSPACE_LABEL = 'devcontainer.local_folder';
export const DEVCONTAINER_CONFIG_LABEL = 'devcontainer.config_file';
export const DEVCONTAINER_METADATA_LABEL = 'devcontainer.metadata';
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
export const COMPOSE_WORKING_DIR_LABEL =
	'com.docker.compose.project.working_dir';

/** One Docker container as returned by the inventory adapter. */
export interface DockerContainerResource {
	id: string;
	name: string;
	state: string;
	statusText: string;
	createdAt: string;
	imageId: string;
	imageName: string;
	ports: ForwardedPort[];
	labels: Record<string, string>;
}

/** A container positively related to a Dev Container workspace. */
export interface DevContainerResource extends DockerContainerResource {
	workspacePath: string;
	workspaceName: string;
	role: 'primary' | 'service';
	serviceName?: string;
}

/** One image positively identified as Dev Container-related. */
export type ImageUsage = 'attached' | 'base' | 'unused';

export interface DevContainerImageResource {
	id: string;
	references: string[];
	displayName: string;
	createdAt: string;
	sizeBytes: number;
	dangling: boolean;
	/** Every Docker container directly attached to this exact image id. */
	containerNames: string[];
	/** Containers whose image layer chain descends from this image. */
	descendantContainerNames: string[];
	/** Dev Container workspaces attached directly or through a descendant. */
	workspacePaths: string[];
	workspaceNames: string[];
	usage: ImageUsage;
}

/** Exact attachments are Docker's hard safety boundary for image removal. */
export function isImageAttached(image: DevContainerImageResource): boolean {
	return image.usage === 'attached';
}

/** Bulk cleanup is deliberately narrower than manual, confirmed removal. */
export function isImagePruneCandidate(
	image: DevContainerImageResource,
): boolean {
	return image.usage === 'unused' && image.dangling;
}

export interface ResourceInventory {
	containers: DevContainerResource[];
	images: DevContainerImageResource[];
	refreshedAt: string;
}
