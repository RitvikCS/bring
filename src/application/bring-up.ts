import { basename } from 'node:path';
import {
	detectUpFlags,
	parseUpResult,
	runUp,
	type UpFlags,
} from '../adapters/devcontainer-cli.js';
import { classifyDevcontainerFailure } from '../core/errors.js';
import type { OperationResult } from '../core/operation-events.js';
import type { WorkspaceRef } from '../core/types.js';
import { writeOperationLog } from '../stores/log-store.js';
import { acquireOperationLock } from '../stores/op-lock.js';
import { rememberWorkspace } from '../stores/workspace-store.js';
import type { OperationContext } from './context.js';
import { getSnapshot } from './get-status.js';
import { resultBuilder } from './results.js';

export interface UpOptions {
	config?: string;
	/** True for `bring rebuild`: replace the existing container. */
	rebuild?: boolean;
	noCache?: boolean;
}

/**
 * Start (or rebuild) a workspace (P1-19/P1-22, workflow in spec §10.5).
 * Idempotent: an already-running workspace is a fast success, not an error.
 * The raw child output is always persisted for `bring logs`.
 */
export async function bringUp(
	ctx: OperationContext,
	workspace: WorkspaceRef,
	options: UpOptions = {},
): Promise<OperationResult> {
	const operation = options.rebuild === true ? 'rebuild' : 'up';
	const name = basename(workspace.rootPath);
	const { finish, fail } = resultBuilder(ctx.emit, operation, workspace, name);
	ctx.emit({ type: 'started', operation, workspaceName: name });
	ctx.emit({
		type: 'stage',
		stage: 'validating',
		message: `Checking ${name}…`,
	});

	if (options.rebuild === true) {
		const flags = await detectUpFlags(ctx.devcontainerExe, { env: ctx.env });
		const supported =
			flags?.replace === true && (options.noCache !== true || flags.noCache);
		if (!supported) {
			return fail({
				code: 'UNSUPPORTED_CAPABILITY',
				summary:
					'The installed Dev Containers CLI does not support the rebuild flags Bring needs.',
				remedy: 'npm install -g @devcontainers/cli@latest',
			});
		}
	}

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
		if (before.snapshot.status === 'running' && options.rebuild !== true) {
			ctx.emit({ type: 'stage', stage: 'ready', message: `${name} is ready` });
			return finish({
				outcome: 'success',
				message: `${name} is already running`,
				containerIds: before.snapshot.containerIds,
			});
		}

		ctx.emit({
			type: 'stage',
			stage: options.rebuild === true ? 'building' : 'starting',
			message:
				options.rebuild === true ? `Rebuilding ${name}…` : `Starting ${name}…`,
		});

		const upFlags: UpFlags = {
			config: options.config,
			removeExistingContainer: options.rebuild === true,
			buildNoCache: options.noCache === true,
		};
		const run = await runUp(ctx.devcontainerExe, workspace.rootPath, upFlags, {
			env: ctx.env,
			onOutput: (stream, chunk) => ctx.emit({ type: 'output', stream, chunk }),
		});

		if (run.outcome === 'spawn-failed') {
			return fail({
				code: 'DEPENDENCY_UNREACHABLE',
				summary: `Could not start the devcontainer CLI: ${run.message}`,
				remedy: 'bring doctor',
			});
		}

		const logPath = writeOperationLog(
			ctx.stateDir,
			workspace.identity,
			run.result.combined,
		);

		if (run.result.interrupted) {
			return finish({
				outcome: 'interrupted',
				message: `${operation} was interrupted`,
				problem: {
					code: 'INTERRUPTED',
					summary: `${operation} was interrupted.`,
				},
				logPath,
			});
		}
		if (run.result.exitCode !== 0) {
			return fail(
				classifyDevcontainerFailure(run.result.combined, run.result.exitCode),
				logPath,
			);
		}

		const after = await getSnapshot(ctx, workspace);
		const containerIds = after.ok ? after.snapshot.containerIds : [];
		const parsed = parseUpResult(run.result.stdout);
		if (parsed?.containerId !== undefined && containerIds.length === 0) {
			containerIds.push(parsed.containerId);
		}
		rememberWorkspace(ctx.stateFile, workspace);
		ctx.emit({ type: 'stage', stage: 'ready', message: `${name} is ready` });
		return finish({
			outcome: 'success',
			message: `${name} ready`,
			containerIds,
			logPath,
		});
	} finally {
		lock.release();
	}
}
