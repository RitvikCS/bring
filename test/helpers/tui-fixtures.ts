import type {
	DevContainerImageResource,
	DevContainerResource,
} from '../../src/core/resources.js';
import type { WorkspaceStatus } from '../../src/core/types.js';
import type { TuiWorkspace } from '../../src/tui/state.js';

/** A TUI workspace fixture — enough shape for reducer and frame tests. */
export function makeWorkspace(
	name: string,
	status: WorkspaceStatus,
	lastUsedAt = '2026-07-01T00:00:00.000Z',
): TuiWorkspace {
	const rootPath = `/home/user/${name}`;
	return {
		ref: {
			input: rootPath,
			rootPath,
			configPath: `${rootPath}/.devcontainer/devcontainer.json`,
			identity: name,
		},
		name,
		status,
		lastUsedAt,
		containerIds: status === 'running' ? ['abc123'] : [],
		imageNames: status === 'running' ? [`${name}:dev`] : [],
		forwardedPorts:
			status === 'running' ? [{ containerPort: 8000, hostPort: 8000 }] : [],
	};
}

export function makeContainer(
	name: string,
	state = 'running',
	workspaceName = 'project',
): DevContainerResource {
	return {
		id: `container-${name}`,
		name,
		state,
		statusText: state === 'running' ? 'Up 2 hours' : 'Exited (0) 3 days ago',
		createdAt: '2026-07-16T12:00:00.000Z',
		imageId: `sha256:${name}`,
		imageName: `${workspaceName}:dev`,
		ports: state === 'running' ? [{ containerPort: 8000, hostPort: 8000 }] : [],
		labels: { 'devcontainer.local_folder': `/home/user/${workspaceName}` },
		workspacePath: `/home/user/${workspaceName}`,
		workspaceName,
		role: 'primary',
	};
}

export function makeImage(
	name: string,
	inUse = false,
): DevContainerImageResource {
	return {
		id: `sha256:${name}`,
		references: [`${name}:latest`],
		displayName: `${name}:latest`,
		createdAt: '2026-07-16T12:00:00.000Z',
		sizeBytes: 1_000_000_000,
		dangling: false,
		containerNames: inUse ? [`${name}-container`] : [],
		workspacePaths: inUse ? [`/home/user/${name}`] : [],
		workspaceNames: inUse ? [name] : [],
		inUse,
	};
}
