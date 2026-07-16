import { basename } from 'node:path';
import { listWorkspaceContainers } from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import type { WorkspaceRef, WorkspaceSnapshot } from '../core/types.js';
import type { OperationContext } from './context.js';

export type SnapshotResult =
	| { ok: true; snapshot: WorkspaceSnapshot }
	| { ok: false; problem: BringProblem };

/**
 * Live view of a workspace (P1-18): its containers found by devcontainer
 * label, reduced to one status. Read-only — safe to call from anywhere.
 */
export async function getSnapshot(
	ctx: OperationContext,
	workspace: WorkspaceRef,
): Promise<SnapshotResult> {
	const listed = await listWorkspaceContainers(
		ctx.dockerExe,
		workspace.rootPath,
		{ env: ctx.env },
	);
	if (!listed.ok) {
		return {
			ok: false,
			problem: {
				code: 'DOCKER_FAILED',
				summary: `Docker could not list containers: ${listed.message}`,
				remedy: 'bring doctor',
			},
		};
	}
	const containers = listed.value;
	const running = containers.filter((c) => c.state === 'running');
	const primary = running[0] ?? containers[0];
	return {
		ok: true,
		snapshot: {
			workspace,
			name: basename(workspace.rootPath),
			status:
				containers.length === 0
					? 'not-created'
					: running.length > 0
						? 'running'
						: 'stopped',
			containerIds: containers.map((c) => c.id),
			imageNames: [...new Set(containers.map((c) => c.image))],
			forwardedPorts: running.flatMap((c) => c.ports),
			uptimeText:
				primary !== undefined && primary.statusText !== ''
					? primary.statusText
					: undefined,
		},
	};
}
