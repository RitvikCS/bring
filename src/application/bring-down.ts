import { basename } from 'node:path';
import { removeContainers, stopContainers } from '../adapters/docker-cli.js';
import type { OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import { acquireOperationLock } from '../stores/op-lock.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import { resultBuilder } from './results.js';

/**
 * `bring down` (P1-20): stop the workspace's containers, keeping them for a
 * fast restart — and `bring remove` (P1-21): stop and delete them. Both act
 * only on containers carrying the workspace's devcontainer label; source
 * files and images are never touched. Already-stopped (or absent) is a
 * success, not an error. Confirmation for remove is the CALLER's job — by
 * the time this runs, the user has said yes.
 */
export async function bringDown(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	options: { remove?: boolean } = {},
): Promise<OperationResult> {
	const operation = options.remove === true ? 'remove' : 'down';
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, operation, workspace, name);
	ctx.emit({ type: 'started', operation, workspaceName: name });
	ctx.emit({
		type: 'stage',
		stage: 'validating',
		message: `Checking ${name}…`,
	});

	const lock = acquireOperationLock(ctx.stateDir, workspace.identity);
	if (!lock.ok) {
		return fail({
			code: 'OPERATION_CONFLICT',
			summary: `Another Bring operation (pid ${lock.holderPid}) is already working on ${name}.`,
		});
	}

	try {
		const before = await getSnapshot(ctx, workspace);
		if (!before.ok) {
			return fail(before.problem);
		}
		const { snapshot } = before;

		if (snapshot.status === 'not-created') {
			return finish({
				outcome: 'success',
				message:
					operation === 'remove'
						? `${name} has nothing to remove`
						: `${name} is already stopped`,
			});
		}

		if (snapshot.status === 'running') {
			ctx.emit({
				type: 'stage',
				stage: 'stopping',
				message: `Stopping ${name}…`,
			});
			const stopped = await stopContainers(
				ctx.dockerExe,
				snapshot.containerIds,
				{ env: ctx.env },
			);
			if (!stopped.ok) {
				return fail({
					code: 'DOCKER_FAILED',
					summary: `Docker could not stop ${name}: ${stopped.message}`,
				});
			}
		}

		if (operation === 'down') {
			return finish({
				outcome: 'success',
				message:
					snapshot.status === 'running'
						? `${name} stopped (containers kept for fast restart)`
						: `${name} is already stopped`,
				containerIds: snapshot.containerIds,
			});
		}

		ctx.emit({
			type: 'stage',
			stage: 'removing',
			message: `Removing ${name}'s containers…`,
		});
		const removed = await removeContainers(
			ctx.dockerExe,
			snapshot.containerIds,
			{ env: ctx.env },
		);
		if (!removed.ok) {
			return fail({
				code: 'DOCKER_FAILED',
				summary: `Docker could not remove ${name}'s containers: ${removed.message}`,
			});
		}
		return finish({
			outcome: 'success',
			message: `${name} removed (${snapshot.containerIds.length} container${
				snapshot.containerIds.length === 1 ? '' : 's'
			} deleted, source files untouched)`,
			containerIds: snapshot.containerIds,
		});
	} finally {
		lock.release();
	}
}
