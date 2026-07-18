import { runContainerExec } from '../adapters/devcontainer-cli.js';
import { removeContainers, stopContainers } from '../adapters/docker-cli.js';
import type { BringProblem } from '../core/errors.js';
import type { DevContainerResource } from '../core/resources.js';
import { workspaceIdentity } from '../core/workspace-resolver.js';
import { acquireOperationLock } from '../stores/op-lock.js';
import type { OperationContext } from './context.js';

export type ContainerActionResult =
	| { ok: true; message: string; childExitCode?: number }
	| {
			ok: false;
			message: string;
			problem: BringProblem;
			childExitCode?: number;
	  };

/** Stop one resource, or stop then remove it. Confirmation is the caller's job. */
export async function mutateContainer(
	ctx: OperationContext,
	container: DevContainerResource,
	action: 'stop' | 'remove',
): Promise<ContainerActionResult> {
	const lock = acquireOperationLock(
		ctx.stateDir,
		workspaceIdentity(container.workspacePath),
	);
	if (!lock.ok) {
		return failed(
			`Another Bring operation (pid ${lock.holderPid}) is already working on ${container.workspaceName}.`,
			'OPERATION_CONFLICT',
		);
	}
	try {
		// Paused and restarting containers are up as far as Docker is concerned:
		// they must be stopped for real (and a forceless `rm` would refuse them).
		const needsStop =
			container.state === 'running' ||
			container.state === 'paused' ||
			container.state === 'restarting';
		if (needsStop) {
			const stopped = await stopContainers(ctx.dockerExe, [container.id], {
				env: ctx.env,
			});
			if (!stopped.ok) {
				return failed(
					`Docker could not stop ${container.name}: ${stopped.message}`,
				);
			}
		}
		if (action === 'stop') {
			return {
				ok: true,
				message: needsStop
					? `${container.name} stopped`
					: `${container.name} is already stopped`,
			};
		}
		const removed = await removeContainers(ctx.dockerExe, [container.id], {
			env: ctx.env,
		});
		if (!removed.ok) {
			return failed(
				`Docker could not remove ${container.name}: ${removed.message}`,
			);
		}
		return {
			ok: true,
			message: `${container.name} removed (source files untouched)`,
		};
	} finally {
		lock.release();
	}
}

/** Open a shell in the exact selected container with inherited terminal I/O. */
export async function openContainerShell(
	ctx: OperationContext,
	container: DevContainerResource,
	command: readonly string[] = ['bash'],
	options: { fastFailWindowMs?: number } = {},
): Promise<ContainerActionResult> {
	if (container.state !== 'running') {
		return failed(`${container.name} is not running.`, 'DEVCONTAINER_FAILED');
	}
	const startedAt = Date.now();
	const run = await runContainerExec(
		ctx.devcontainerExe,
		container.id,
		command,
		{ env: ctx.env, stdio: 'inherit' },
	);
	if (run.outcome === 'spawn-failed') {
		return failed(
			`Could not start the devcontainer CLI: ${run.message}`,
			'DEPENDENCY_UNREACHABLE',
		);
	}
	const failedFast =
		Date.now() - startedAt < (options.fastFailWindowMs ?? 10_000);
	if (
		failedFast &&
		(run.result.exitCode === 126 || run.result.exitCode === 127)
	) {
		return {
			...failed(
				`\`${command.join(' ')}\` is not available in ${container.name}.`,
				'DEVCONTAINER_FAILED',
			),
			childExitCode: run.result.exitCode,
		};
	}
	return {
		ok: true,
		message: `shell in ${container.name} closed`,
		childExitCode: run.result.exitCode,
	};
}

function failed(
	message: string,
	code: BringProblem['code'] = 'DOCKER_FAILED',
): ContainerActionResult {
	return { ok: false, message, problem: { code, summary: message } };
}
