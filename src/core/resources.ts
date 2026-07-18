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

/** One workspace's containers reduced to the fields every status view shows. */
export interface WorkspaceContainersSummary {
	status: 'not-created' | 'running' | 'stopped';
	containerIds: string[];
	imageNames: string[];
	forwardedPorts: ForwardedPort[];
	/** Docker's human age line ("Up 2 hours"), preferring the labelled primary. */
	uptimeText?: string;
}

/**
 * The single authority for containers → workspace status. The TUI, `bring
 * status`, and `bring ls` all reduce through here so they can never disagree
 * about what "running" means or whose uptime is shown.
 */
export function summarizeWorkspaceContainers(
	containers: readonly DevContainerResource[],
): WorkspaceContainersSummary {
	const running = containers.filter(
		(container) => container.state === 'running',
	);
	// A Compose sidecar can sort ahead of the primary; the uptime shown must
	// be the labelled primary's whenever one exists.
	const primary =
		running.find((container) => container.role === 'primary') ??
		running[0] ??
		containers.find((container) => container.role === 'primary') ??
		containers[0];
	return {
		status:
			containers.length === 0
				? 'not-created'
				: running.length > 0
					? 'running'
					: 'stopped',
		containerIds: containers.map((container) => container.id),
		imageNames: [
			...new Set(containers.map((container) => container.imageName)),
		],
		forwardedPorts: running.flatMap((container) => container.ports),
		...(primary !== undefined && primary.statusText !== ''
			? { uptimeText: primary.statusText }
			: {}),
	};
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
	/**
	 * null when this pass skipped image inspection (includeImages: false) —
	 * consumers must keep their previous image state, not treat it as empty.
	 */
	images: DevContainerImageResource[] | null;
	refreshedAt: string;
}
