// Core domain types (spec §8.2). `not-created` extends the spec's status
// union: a workspace whose config exists but which has never been built is
// meaningfully different from one that is stopped (amendment A2).

export type WorkspaceStatus =
	| 'unknown'
	| 'missing-config'
	| 'not-created'
	| 'stopped'
	| 'starting'
	| 'running'
	| 'stopping'
	| 'rebuilding'
	| 'removing'
	| 'failed';

export interface WorkspaceRef {
	/** What the user typed (".", "this", a path). */
	input: string;
	/** Absolute, symlink-resolved workspace root. */
	rootPath: string;
	/** Absolute path of the devcontainer configuration in effect. */
	configPath: string;
	/** Stable identity derived from rootPath; used for log/lock dirs. */
	identity: string;
}

export interface ForwardedPort {
	containerPort: number;
	hostPort?: number;
}

export interface ContainerInfo {
	id: string;
	name: string;
	state: string;
	image: string;
	ports: ForwardedPort[];
}

export interface WorkspaceSnapshot {
	workspace: WorkspaceRef;
	name: string;
	status: WorkspaceStatus;
	containerIds: string[];
	imageNames: string[];
	forwardedPorts: ForwardedPort[];
}
