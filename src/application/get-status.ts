import { basename } from 'node:path';
import type { BringProblem } from '../core/errors.js';
import type { WorkspaceRef, WorkspaceSnapshot } from '../core/types.js';
import type { OperationContext } from './context.js';
import { listResources } from './list-resources.js';

export type SnapshotResult =
	| { ok: true; snapshot: WorkspaceSnapshot }
	| { ok: false; problem: BringProblem };

/**
 * Live view of a workspace (P1-18): its labelled primary and related Compose
 * services, reduced to one status. Read-only — safe to call from anywhere.
 */
export async function getSnapshot(
	ctx: OperationContext,
	workspace: WorkspaceRef,
): Promise<SnapshotResult> {
	const listed = await listResources({
		dockerExe: ctx.dockerExe,
		env: ctx.env,
		includeImages: false,
		knownWorkspacePaths: [workspace.rootPath],
	});
	if (!listed.ok) {
		return {
			ok: false,
			problem: {
				code: 'DOCKER_FAILED',
				summary: listed.problem.summary,
				remedy: 'bring doctor',
			},
		};
	}
	const containers = listed.inventory.containers.filter(
		(container) => container.workspacePath === workspace.rootPath,
	);
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
			imageNames: [...new Set(containers.map((c) => c.imageName))],
			forwardedPorts: running.flatMap((c) => c.ports),
			uptimeText:
				primary !== undefined && primary.statusText !== ''
					? primary.statusText
					: undefined,
		},
	};
}
