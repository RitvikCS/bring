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
export interface DevContainerImageResource {
	id: string;
	references: string[];
	displayName: string;
	createdAt: string;
	sizeBytes: number;
	dangling: boolean;
	/** Every Docker container using the image, including non-dev containers. */
	containerNames: string[];
	/** Dev Container workspaces currently related through a container. */
	workspacePaths: string[];
	workspaceNames: string[];
	inUse: boolean;
}

export interface ResourceInventory {
	containers: DevContainerResource[];
	images: DevContainerImageResource[];
	refreshedAt: string;
}
