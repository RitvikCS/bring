import { basename } from 'node:path';
import type { BringProblem } from '../core/errors.js';
import { summarizeWorkspaceContainers } from '../core/resources.js';
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
	const summary = summarizeWorkspaceContainers(
		listed.inventory.containers.filter(
			(container) => container.workspacePath === workspace.rootPath,
		),
	);
	return {
		ok: true,
		snapshot: {
			workspace,
			name: basename(workspace.rootPath),
			...summary,
		},
	};
}
