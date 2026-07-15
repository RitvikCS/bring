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
