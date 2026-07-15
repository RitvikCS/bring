import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { listWorkspaceContainers } from '../adapters/docker-cli.js';
import type { ContainerInfo, WorkspaceStatus } from '../core/types.js';
import { loadState } from '../stores/workspace-store.js';

// `bring ls` (spec amendment A3): the workspaces Bring has successfully
// touched before, with live status. Registry-driven — never scans the disk.

export interface WorkspaceListing {
	path: string;
	name: string;
	status: WorkspaceStatus;
	lastUsedAt: string;
}

export function statusFromContainers(
	containers: readonly ContainerInfo[],
): WorkspaceStatus {
	if (containers.length === 0) {
		return 'not-created';
	}
	return containers.some((c) => c.state === 'running') ? 'running' : 'stopped';
}

export async function listKnownWorkspaces(options: {
	stateFile: string;
	/** null when docker is unavailable — statuses degrade to 'unknown'. */
	dockerExe: string | null;
	env: NodeJS.ProcessEnv;
}): Promise<WorkspaceListing[]> {
	const state = loadState(options.stateFile);
	const listings: WorkspaceListing[] = [];
	for (const stored of state.workspaces) {
		let status: WorkspaceStatus = 'unknown';
		if (!existsSync(stored.path)) {
			status = 'missing-config';
		} else if (options.dockerExe !== null) {
			const listed = await listWorkspaceContainers(
				options.dockerExe,
				stored.path,
				{ env: options.env },
			);
			if (listed.ok) {
				status = statusFromContainers(listed.value);
			}
		}
		listings.push({
			path: stored.path,
			name: basename(stored.path),
			status,
			lastUsedAt: stored.lastUsedAt,
		});
	}
	// Most recently used first — the workspace you want is almost always on top.
	return listings.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
}
