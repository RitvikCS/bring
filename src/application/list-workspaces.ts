import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { summarizeWorkspaceContainers } from '../core/resources.js';
import type { WorkspaceStatus } from '../core/types.js';
import { loadState } from '../stores/workspace-store.js';
import { listResources } from './list-resources.js';

// `bring ls` (spec amendment A3): the workspaces Bring has successfully
// touched before, with live status. Registry-driven — never scans the disk.

export interface WorkspaceListing {
	path: string;
	name: string;
	status: WorkspaceStatus;
	lastUsedAt: string;
}

export async function listKnownWorkspaces(options: {
	stateFile: string;
	/** null when docker is unavailable — statuses degrade to 'unknown'. */
	dockerExe: string | null;
	env: NodeJS.ProcessEnv;
}): Promise<WorkspaceListing[]> {
	const state = loadState(options.stateFile);
	// One coordinated inventory, the same one the TUI and `bring status` use —
	// so `bring ls` counts Compose sidecars identically instead of seeing only
	// the containers that carry the workspace label themselves.
	const listed =
		options.dockerExe === null
			? null
			: await listResources({
					dockerExe: options.dockerExe,
					env: options.env,
					includeImages: false,
					knownWorkspacePaths: state.workspaces.map(
						(workspace) => workspace.path,
					),
				});
	const listings: WorkspaceListing[] = state.workspaces.map((stored) => {
		let status: WorkspaceStatus = 'unknown';
		if (!existsSync(stored.path)) {
			status = 'missing-config';
		} else if (listed !== null && listed.ok) {
			status = summarizeWorkspaceContainers(
				listed.inventory.containers.filter(
					(container) => container.workspacePath === stored.path,
				),
			).status;
		}
		return {
			path: stored.path,
			name: basename(stored.path),
			status,
			lastUsedAt: stored.lastUsedAt,
		};
	});
	// Most recently used first — the workspace you want is almost always on top.
	return listings.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
